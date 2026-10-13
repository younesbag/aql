import "server-only";
import { createClient } from "@/lib/supabase/server";
import { embed, searchWeb } from "@/lib/ai/gemini";
import { claudeJson, type SystemBlock } from "@/lib/ai/anthropic";
import { retrieveContext, queryPerformance } from "@/lib/agents/access";
import { parseJson } from "@/lib/agents/util";
import {
  type IdeaCriteria,
  type DraftOptions,
  type DraftResult,
  PERSONA_AR,
  ANGLE_AR,
  ANGLE_DIRECTIVE,
  LENGTH_AR,
  STYLE_AR,
  PURPOSE_AR,
  isSalesPurpose,
} from "@/lib/newsletter/criteria";
// الوحدة النقية (الملف 26): نصوص البرومبت مصدرها هنا حصراً — يشاركها عامل الـVPS
// بايتاً-بايتاً، فلا تتباعد نسخة الجلسة عن نسخة API.
import {
  loadNewsletterSystem,
  buildToneLine,
  buildIdeasUserContent,
  buildOutlineUserContent,
  buildDraftUserContent,
  buildCritiqueUserContent,
  loadSalesExamples,
  pickSalesExamples,
  buildSalesExamplesBlock,
  type TastePair,
} from "@/lib/newsletter/prompt-builder";

// ════════════════════════════════════════════════════════════
// محرّك النشرة البريدية (العمود الثاني) — الأساس (المرحلة ٠).
// منفصل عن محرّك إكس: صوت + برومبت + أمثلة خاصّة بالإيميل، فوق بدائيّات مشتركة.
// هنا: تحميل تعليمات نظام الكتابة + استرجاع أمثلة من أرشيف إيميلاتك (تعليم الأسلوب).
// مراحل التوليد (الفكرة/الهيكل/المسودة) تُضاف لاحقاً في هذا الملف.
// ════════════════════════════════════════════════════════════

// systemInstruction = برومبت كتابة النشرة (newsletter-writer.md) + مرجع النبرة + سياق المشروع.
// يُبنى مرّة ويُخزَّن (cache) — context.md يُضاف للنسخة المخزّنة، لا قراءة كل نداء.
// كتلة نظام مخزّنة (كاش بادئة) — الأساس الثابت وحده، يُبنى مرّة ويُعاد بايتاً-بايتاً.
// تتشارك أفكار→هيكل→مسودة→نقد نفس البادئة المخزّنة عبر المعالج (قراءة مضمونة ضمن TTL).
async function loadNewsletterSystemBlocks(): Promise<SystemBlock[]> {
  return [{ text: await loadNewsletterSystem(), cache: true }];
}

// مخططات JSON (Structured Outputs) — Claude Sonnet 5 لا يدعم prefill، فهذا مسار
// المخرج المنظّم الرسمي. كل الحقول required (nullable حيث الحقل اختياري منطقياً).
const IDEAS_SCHEMA = {
  type: "object",
  properties: { ideas: { type: "array", items: { type: "string" } } },
  required: ["ideas"],
  additionalProperties: false,
} as const;

const OUTLINE_SCHEMA = {
  type: "object",
  properties: { outline: { type: "string" } },
  required: ["outline"],
  additionalProperties: false,
} as const;

const DRAFT_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, draft: { type: "string" } },
  required: ["subject", "draft"],
  additionalProperties: false,
} as const;

const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    weakest: { type: "array", items: { type: "string" } },
    overall: { type: "number" },
    subject: { type: "string" },
    draft: { type: "string" },
  },
  required: ["weakest", "overall", "subject", "draft"],
  additionalProperties: false,
} as const;

function parseVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? (a as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// أمثلة احتذاء من أرشيف إيميلاتك (source_type='email') — الأقرب موضوعاً لتعليم صوت الإيميل.
// العدد صغير (~18) فنرتّبها بالتشابه في JS. بلا موضوع → أحدث/أوائل العيّنات.
export async function getEmailExamples(topicText: string, limit = 3): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("items")
    .select("raw_text, embedding")
    .eq("source_type", "email")
    .limit(100);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const topic = topicText.trim();
  const fallback = () => rows.slice(0, limit).map((r) => String(r.raw_text));
  if (!topic) return fallback();

  const emb = await embed(topic);
  if (!emb.ok) return fallback();

  return rows
    .map((r) => ({ text: String(r.raw_text), vec: parseVec(r.embedding) }))
    .filter((r): r is { text: string; vec: number[] } => r.vec !== null)
    .map((r) => ({ text: r.text, sim: cosine(emb.data, r.vec) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map((r) => r.text);
}

/**
 * أزواج الذوق البريدية (الملف 27) — قناة 'newsletter' حصراً.
 * أزواج إكس بطول تغريدة (متوسط مقيس ٦٢١ حرفاً) وحقنها هنا يجرّ النشرة نحو
 * التغريدة، فتُستبعد. تبدأ فارغة بصدق وتمتلئ من تحرير المالك لمسودّاته البريدية.
 * الأولوية لحاملات الدرس: زوج بلا درس يشغل خانة حقن دون أن يعلّم شيئاً.
 */
export async function getNewsletterTastePairs(limit = 3): Promise<TastePair[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("taste_pairs")
    .select("idea_text, rejected_draft, preferred_draft, lesson, created_at")
    .eq("active", true)
    .eq("channel", "newsletter")
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  const rows = (data ?? []) as (TastePair & { created_at: string })[];
  return rows
    .sort((a, b) => {
      const la = a.lesson && a.lesson.trim() ? 1 : 0;
      const lb = b.lesson && b.lesson.trim() ? 1 : 0;
      if (la !== lb) return lb - la;
      return b.created_at.localeCompare(a.created_at);
    })
    .slice(0, limit)
    .map(({ idea_text, rejected_draft, preferred_draft, lesson }) => ({
      idea_text, rejected_draft, preferred_draft, lesson,
    }));
}

/** كتلة أمثلة مقتضبة للهيكل (٤٠٠ حرف لكل مثال — الخطّة لا تحتاج النصّ كاملاً). */
export function buildOutlineExamplesBlock(examples: string[]): string {
  return examples.length > 0
    ? "أمثلة من أرشيفك (للأسلوب):\n" + examples.map((e) => e.slice(0, 400)).join("\n---\n")
    : "";
}

/** كتلة أمثلة الأرشيف — يشاركها مسار API ومُجهِّز مهمة الجلسة. */
export function buildExamplesBlock(examples: string[]): string {
  return examples.length > 0
    ? "أمثلة من أرشيف إيميلاتك (احتذِ أسلوبها وإيقاعها — لا تنسخها):\n\n" +
        examples.map((e, i) => `[مثال ${i + 1}]\n${e}`).join("\n\n")
    : "(لا أمثلة أرشيف بعد — استند للأمثلة المرجعية في تعليماتك.)";
}

// ════════════════════════════════════════════════════════════
// المرحلة ١: توليد أفكار نشرات بمعايير المستخدم، مؤصَّلة بذاكرته (retrieveContext)
// + بحث حيّ اختياري (حسب «المصدر»). يُرجع قائمة أفكار يختار منها المالك.
// ════════════════════════════════════════════════════════════
export async function generateIdeas(c: IdeaCriteria): Promise<string[]> {
  const topic = c.topic.trim();
  if (!topic) return [];

  const useMemory = c.source === "memory" || c.source === "both";
  const useRecent = c.source === "recent" || c.source === "both";
  const [mem, recent, topPosts] = await Promise.all([
    useMemory
      ? retrieveContext(topic, { semantic: true, semanticCount: 8 })
      : Promise.resolve(null),
    useRecent
      ? searchWeb(`أحدث ما يخصّ: ${topic} — أدوات أو أحداث أو اتجاهات حديثة فقط، بإيجاز.`)
      : Promise.resolve(null),
    // تلقيح إكس → النشرة (الملف 14 — البند ٣): ما ثبت نجاحه في المحور على إكس
    // يُلهم زوايا النشرة. best-effort — فشله لا يمنع التوليد.
    queryPerformance({ kind: "byTopic", topic, limit: 4 }, topic).catch(() => []),
  ]);
  const memBlock = mem?.block ?? "";
  const recentBlock = recent && recent.ok ? recent.data : "";
  // استبعاد صفري التفاعل: منشور نُشر ولم تُدخَل أرقامه بعد يظهر بتفاعل 0 —
  // تقديمه كـ«ما رنّ على إكس» تضليل صريح لنموذج الأفكار.
  const topPostsBlock = topPosts
    .filter((s) => (s.metrics?.engagement ?? 0) > 0)
    .map((s) => `- (تفاعل ${s.metrics?.engagement ?? 0}) ${s.text}`)
    .join("\n");

  const n = Math.max(1, Math.min(c.count || 4, 6));
  const personaStr = PERSONA_AR[c.persona] ?? "أي شخصية مناسبة من جمهور المالك";
  const angleStr = c.angle !== "auto" ? (ANGLE_AR[c.angle] ?? "الأنسب") : "الأنسب";

  const system = await loadNewsletterSystemBlocks();
  const prompt = buildIdeasUserContent(
    topic, personaStr, angleStr, c.notes, memBlock, recentBlock, topPostsBlock, n,
  );

  const res = await claudeJson(prompt, system, { schema: IDEAS_SCHEMA, effort: "xhigh", maxTokens: 16000 });
  // ارمِ خطأ الاستدعاء الفعلي (رصيد/مهلة/رفض/حدّ طول) بدل ابتلاعه في مصفوفة فارغة —
  // كي يلتقطه الإجراء ويُظهره بالعربية الدقيقة في الواجهة.
  if (!res.ok) throw new Error(res.error);
  const p = parseJson<{ ideas: string[] }>(res.data);
  return Array.isArray(p?.ideas) ? p.ideas.map(String).filter(Boolean).slice(0, n) : [];
}

// ════════════════════════════════════════════════════════════
// المرحلة ٢: توليد مسودة نشرة كاملة من الفكرة — بصوت الإيميل + أمثلة الأرشيف،
// مع تخصيص (طول/أسلوب/زاوية/ملاحظات) وبحث حيّ اختياري. يُرجع العنوان + المسودة.
// ════════════════════════════════════════════════════════════
// الطول بيد المالك من اللوحة (قراره 2026-08-12): يُمرَّر رقماً صريحاً بمداه لا وصفاً،
// و«تلقائي» يُمرَّر أيضاً بمرساته (وسيط نشراته) بدل تركه لاستنتاج النموذج.
const AUTO_LENGTH = "نحو 850 كلمة (المدى المقبول 770–930)";

export function buildDraftDirectives(o: DraftOptions): string {
  const lines = ["توجيهات إلزامية (التزم بها فوق أي استنتاج):"];
  // الغرض أولاً: يحكم البرومبت المضمّن والمصادر وشكل القفلة (الملف 28)
  if (o.purpose !== "auto" && PURPOSE_AR[o.purpose]) {
    lines.push("- غرض النشرة: " + PURPOSE_AR[o.purpose]);
  }
  // «تلقائي» يتبع الغرض: البيعيّ ٢٢٥ كلمة لا ٨٥٠ — قياس رسائل المالك المرسَلة
  // — فلا يعتمد الطول الصحيح على تذكّر المالك ضبطه يدوياً.
  const autoLen = isSalesPurpose(o.purpose) ? LENGTH_AR.sales : AUTO_LENGTH;
  lines.push(
    "- الطول المستهدف: " +
      (o.length === "auto" ? autoLen : (LENGTH_AR[o.length] ?? o.length)) +
      " — عُدَّ الكلمات قبل الإخراج والتزم المدى.",
  );
  // نطاق اللهجة يتبع الغرض أيضاً — قيد حاسم يُذكر مع التوجيهات لا في النظام وحده
  // مرساة محسوبة لا نطاق مجرّد: قياس حيّ أظهر أن ذكر النطاق وحده يُخرج ٤٫٤
  // (تحت المدى) رغم أن الأمثلة المحقونة ٥٫٠ و٦٫٦ — فيُعطى العدد المطلوب صراحةً.
  if (isSalesPurpose(o.purpose)) {
    const target = o.length === "auto" ? 225 : 250;
    lines.push(
      `- كثافة اللهجة المستهدفة: **٥–٦٫٥ لكل ١٠٠ كلمة** — أي نحو **${Math.round((target * 5.7) / 100)} لمسة محكية** في نصّ من ${target} كلمة. ` +
        "عُدّها قبل الإخراج. هذا صوته البيعيّ الحاليّ (قياس رسائله المرسَلة ٥٫٧)، والفصحى المصقولة صوته القديم الذي هجره (١٫٠).",
    );
  } else {
    lines.push("- كثافة اللهجة المستهدفة: ٣–٥ لكل ١٠٠ كلمة (وسيط نشراته ٣٫١).");
  }
  if (o.style !== "auto") lines.push("- الأسلوب: " + (STYLE_AR[o.style] ?? o.style));
  if (o.angle !== "auto") {
    // الاسم + الجملة المنفَّذة: «تفكيك خطأ شائع» وحده لا يُنفَّذ، وتوجيهه يُنفَّذ
    const d = ANGLE_DIRECTIVE[o.angle];
    lines.push("- الزاوية: " + (ANGLE_AR[o.angle] ?? o.angle) + (d ? " — " + d : ""));
  }
  const notes = o.notes?.trim();
  if (notes) lines.push("- ملاحظات: " + notes);
  return lines.length > 1 ? lines.join("\n") : "";
}

export async function generateNewsletterDraft(
  idea: string,
  o: DraftOptions,
  outline?: string,
  rawText = "",
): Promise<DraftResult> {
  const ideaText = idea.trim();
  if (!ideaText) return { subject: "", draft: "", critique: null };

  // الأمثلة تتبع الغرض (الملف 32): التوليدة البيعية تحتذي رسائله البيعية
  // المرسَلة، لا نشراته التعليمية — الجنسان مختلفان طولاً ولهجةً وبنيةً.
  const salesMode = isSalesPurpose(o.purpose);
  const [examples, search, tastePairs, salesAll] = await Promise.all([
    salesMode ? Promise.resolve([] as string[]) : getEmailExamples(ideaText, 3),
    o.search
      ? searchWeb(`أحدث ما يخصّ: ${ideaText} — حقائق أو أرقام أو أمثلة حديثة بإيجاز.`)
      : Promise.resolve(null),
    getNewsletterTastePairs(3).catch(() => [] as TastePair[]),
    salesMode ? loadSalesExamples().catch(() => []) : Promise.resolve([]),
  ]);
  const exBlock = salesMode
    ? buildSalesExamplesBlock(pickSalesExamples(salesAll, ideaText, 2))
    : buildExamplesBlock(examples);
  const searchBlock = search && search.ok && search.data.trim() ? search.data.trim() + "\n" : "";
  // معايرة الأداء البريدي (الملف 36) — نفس الحقن في المسارين، طبقة تتراجع بصمت
  const calib = await import("@/lib/loops/report")
    .then((m) => m.getCampaignCalibrationBlock())
    .catch(() => "");

  const system = await loadNewsletterSystemBlocks();
  const prompt = buildDraftUserContent(
    ideaText,
    buildDraftDirectives(o) + calib,
    outline,
    searchBlock,
    exBlock,
    buildToneLine(o.tone),
    rawText,
    tastePairs,
  );

  const res = await claudeJson(prompt, system, { schema: DRAFT_SCHEMA, effort: "xhigh", maxTokens: 32000 });
  // فشل النداء الأساسي = لا مسودة أصلاً → ارمِ الخطأ الفعلي ليظهر بالعربية الدقيقة.
  // (فشل حلقة النقد لاحقاً يتراجع بلطف ويُبقي المسودة الأولى — لا يُرمى.)
  if (!res.ok) throw new Error(res.error);
  const p = parseJson<{ subject: string; draft: string }>(res.data);
  const first = {
    subject: typeof p?.subject === "string" ? p.subject : "",
    draft: typeof p?.draft === "string" ? p.draft : "",
  };
  if (!first.draft.trim()) return { ...first, critique: null };

  // طبقة الجودة ٤: حلقة نقد ذاتي واحدة (نداء Pro ثانٍ) — تقيّم بالمعايير العشرة وترفع الأضعف.
  const improved = await critiqueAndImprove(first.subject, first.draft, o);
  if (!improved) return { ...first, critique: null };
  return {
    subject: improved.subject,
    draft: improved.draft,
    critique: {
      firstSubject: first.subject,
      firstDraft: first.draft,
      overall: improved.overall,
      weakest: improved.weakest,
    },
  };
}

// حلقة النقد الذاتي (طبقة الجودة ٤): نداء Pro واحد يقيّم المسودة بالمعايير العشرة ويعيد كتابة الأضعف.
// systemInstruction = نظام النشرة (فيه المعايير) + دور محرّر نقديّ صارم. حلقة واحدة فقط (سرعة وتكلفة).
async function critiqueAndImprove(
  subject: string,
  draft: string,
  o: DraftOptions,
): Promise<{ subject: string; draft: string; overall: number | null; weakest: string[] } | null> {
  // كتلة ثانية غير مخزّنة (إضافة دور) تلي الأساس المخزَّن — تشارك بادئة draft المخزّنة.
  const system: SystemBlock[] = [
    ...(await loadNewsletterSystemBlocks()),
    {
      text: "# دورك الآن: محرّر نقديّ صارم\nأنت محرّر نقديّ صارم لا يجامل. تقيّم النشرة على معايير الجودة العشرة أعلاه بصرامة، وترفع أضعف أجزائها إلى المستوى المستهدف دون المساس بما نجح.",
    },
  ];

  // النقد يحاكي طريقة المالك الفعلية: العنوان يُحاكم أولاً ووحده، والجسم يُحسَّن نقطياً
  // («ممتازة و لكن هناك نقطة») لا يُعاد كتابته. والاستعارة خرجت من قائمة ما يُرفع.
  const prompt = buildCritiqueUserContent(subject, draft, buildToneLine(o.tone));

  const res = await claudeJson(prompt, system, { schema: CRITIQUE_SCHEMA, effort: "xhigh", maxTokens: 32000 });
  const p = res.ok
    ? parseJson<{ weakest: string[]; overall: number; subject: string; draft: string }>(res.data)
    : null;
  if (!p || typeof p.draft !== "string" || !p.draft.trim()) return null;
  return {
    subject: typeof p.subject === "string" && p.subject.trim() ? p.subject : subject,
    draft: p.draft,
    overall: typeof p.overall === "number" ? p.overall : null,
    weakest: Array.isArray(p.weakest) ? p.weakest.map(String).filter(Boolean).slice(0, 3) : [],
  };
}

// ── المرحلة ٣ (اختيارية): توليد هيكل النشرة فقط (الخطّة) ليراجعه المالك قبل التوسيع. ──
export async function generateNewsletterOutline(
  idea: string,
  o: DraftOptions,
  rawText = "",
): Promise<string> {
  const topic = idea.trim();
  if (!topic) return "";

  const [examples, search] = await Promise.all([
    getEmailExamples(topic, 2),
    o.search
      ? searchWeb(`أحدث ما يخصّ: ${topic} — حقائق أو أمثلة حديثة بإيجاز.`)
      : Promise.resolve(null),
  ]);
  const exBlock = buildOutlineExamplesBlock(examples);
  const searchBlock =
    search && search.ok && search.data.trim() ? "بحث حيّ:\n" + search.data.trim() + "\n\n" : "";

  const system = await loadNewsletterSystemBlocks();
  const prompt = buildOutlineUserContent(
    topic,
    buildDraftDirectives(o),
    searchBlock,
    exBlock,
    o.tone.depth,
    o.tone.urgency,
    rawText,
  );

  const res = await claudeJson(prompt, system, { schema: OUTLINE_SCHEMA, effort: "xhigh", maxTokens: 16000 });
  if (!res.ok) throw new Error(res.error);
  const p = parseJson<{ outline: string }>(res.data);
  return typeof p?.outline === "string" ? p.outline : "";
}

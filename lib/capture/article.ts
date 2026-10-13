import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { embed, proJson, flashJson } from "@/lib/ai/gemini";
import { parseJson } from "@/lib/agents/util";
import {
  insertTask,
  normalizeSteps,
  truncate,
  TASK_KINDS,
  TASK_PROJECTS,
  PROJECT_MAIN,
  type TaskKind,
  type TaskProject,
} from "@/lib/capture/task";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// مسار المقال (الملف 09) — كشف وتخزين. المقال نصّ طويل يُلصق في تيليجرام.
// الكشف + التخزين هنا، والتحليل (خمسة مخرجات) في النصف الثاني من الملف.
// عميل admin (service_role) كبقية الالتقاط — الـwebhook بلا جلسة.
// ════════════════════════════════════════════════════════════

export const ARTICLE_MIN_WORDS = 500; // نص أطول من هذا يُعامل كمقال تلقائياً
// لصق أطول من هذا (قُرب حدّ رسالة تيليجرام 4096) يُرجَّح أنه انقسم → نرشد لإرساله كملف .txt.
export const LONG_PASTE_THRESHOLD = 4000;
const EMBED_MAX_WORDS = 1000; // حدّ آمن لمُدخل التضمين — نضمّن رأس المقال (يمثّل موضوعه)

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// رابط إكس وحده (بلا نصّ يُذكر) — لا جلب آلي، ننبّه المالك ليلصق النصّ.
export function isBareXLink(text: string): boolean {
  const t = text.trim();
  if (!/https?:\/\/(x\.com|twitter\.com)\//i.test(t)) return false;
  const withoutUrls = t.replace(/https?:\/\/\S+/gi, "").trim();
  return wordCount(withoutUrls) < 15;
}

// يميّز المقال: أمر /article يفرضه، أو نصّ يتجاوز ARTICLE_MIN_WORDS.
// يُرجع النصّ بعد إزالة الأمر (للتخزين النظيف).
export function detectArticle(text: string): { isArticle: boolean; articleText: string } {
  const t = text.trim();
  if (/^\/article\b/i.test(t)) {
    return { isArticle: true, articleText: t.replace(/^\/article\b\s*/i, "").trim() };
  }
  return { isArticle: wordCount(t) > ARTICLE_MIN_WORDS, articleText: t };
}

function truncateWords(text: string, max: number): string {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length <= max ? text.trim() : w.slice(0, max).join(" ");
}

// يخزّن المقال في items (source_type='article') مع تضمين رأسه (للاسترجاع عبر العقل).
// التصنيف الكسول والتحليل الكامل لاحقاً. يُرجع معرّف العنصر (لحفظ التحليل عليه).
export async function storeArticle(text: string, sourceUrl?: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("نص المقال فارغ.");
  const supabase = createAdminClient();
  const emb = await embed(truncateWords(trimmed, EMBED_MAX_WORDS));
  const { data, error } = await supabase
    .from("items")
    .insert({
      raw_text: trimmed,
      source_type: "article",
      source_url: sourceUrl ?? null,
      origin: "manual",
      status: "new",
      embedding: emb.ok ? emb.data : null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error("فشل حفظ المقال: " + (error?.message ?? "غير معروف"));
  }
  return data.id as string;
}

// ════════════════════════════════════════════════════════════
// تحليل المقال (الملف 09 — إعادة تصميم): خمسة مخرجات عملية للمالك والمشروع.
//   ١) تلخيص مكثّف يحفظ ~80% من القيمة والتفاصيل التقنية.
//   ٢) خطة تطبيق مفصّلة على المشروع. ٣) ٣ أفكار ثريدات. ٤) ٣ أفكار إيميلات. ٥) رؤى.
// لا بحث دلالي في الأرشيف هنا (أُلغي بطلب المالك) — التطويع يقوم على حقن سياق المشروع
// المُثرى (context.md) في systemInstruction + تمرير المقال كاملاً.
// مبادئ Gemini 3.1: الدور/القيود في systemInstruction، والبيانات أولاً والقيود الكمية آخراً.
// مرِن: لا يرمي أبداً — يعيد ردّاً احتياطياً عند الفشل (المقال محفوظ على أي حال).
// ════════════════════════════════════════════════════════════
export type ArticleAnalysis = {
  summary: string;
  application_plan: string[];
  thread_ideas: string[];
  email_ideas: string[];
  insights: string[];
};

// المقال يُمرَّر كاملاً حتى هذا الحدّ في نداء واحد (~15 ألف توكن — مريح لـ Pro/نافذة 1M).
// أطول من ذلك → معالجة على مرحلتين (تكثيف ثمّ اشتقاق) بدل اقتطاع أعمى يُفقد التفاصيل.
const ONE_PASS_MAX_CHARS = 60000;
const SAVED_FALLBACK = "📄 حُفظ المقال ✅ — لكن تعذّر تحليله الآن. هو متاح للبحث عبر العقل.";

// سياق المشروع المُثرى (context.md) — يُقرأ مرّة ويُخزَّن، يُحقن في systemInstruction.
let _projectCtx: string | null = null;
async function loadProjectContext(): Promise<string> {
  if (_projectCtx !== null) return _projectCtx;
  try {
    _projectCtx = await readFile(path.join(process.cwd(), "data/context.md"), "utf8");
  } catch {
    _projectCtx = "";
  }
  return _projectCtx;
}

// الدور + معايير العمق الموجبة + سياق المشروع — تأطير ثابت في systemInstruction (مبدأ Gemini 3.1).
async function buildArticleSystem(): Promise<string> {
  const projectCtx = await loadProjectContext();
  return `أنت محلّل مقالات استراتيجيّ ضمن «العقل» — نظام ${OWNER_NAME} الشخصي. مهمتك تحويل مقال طويل إلى أصول عملية ل${OWNER_NAME} ومشروعه.

## سياق المشروع (مرجعك في التطويع)
${projectCtx}

## معايير العمق (موجِّهات موجبة)
- التلخيص: احفظ جوهر المقال وكلّ تفاصيله التقنية بأمانة، بصياغتك المكثّفة وبحجم أقلّ من الأصل. لا تبسّط لدرجة فقدان التقنية أو الأرقام أو الأمثلة المحدّدة.
- التطويع: اربط كلّ توصية بحالة المشروع الفعلية كما يصفها السياق أعلاه (مرحلته، نموذجه، سوقه، فريقه، جمهوره وعروضه وتموضعه). كن ملموساً: خطوات على المشروع أو محتواه أو أنظمته تحديداً.
- اعتمد على المقال وسياق المشروع المقدَّمَين في الاستنتاج؛ وميّز بوضوح أيّ اقتراح يتجاوزهما.

## الأسلوب
عربي واضح. وللمخرجات التي ستصير محتوى (الثريدات والإيميلات): بصوت ${OWNER_NAME} الشخصي العفوي كما يصفه سياقه.`;
}

const OUTPUT_SCHEMA = `{
  "summary": "تلخيص مكثّف يحفظ جوهر المقال وتفاصيله التقنية، أصغر من الأصل",
  "application_plan": ["خطوة تطبيق مفصّلة وملموسة على المشروع — مربوطة بحالته/شخصياته/حزمه", "..."],
  "thread_ideas": ["فكرة ثريد ١", "فكرة ثريد ٢", "فكرة ثريد ٣"],
  "email_ideas": ["فكرة إيميل ١", "فكرة إيميل ٢", "فكرة إيميل ٣"],
  "insights": ["رؤية مربوطة بسياق ${OWNER_NAME} والمشروع الحالي", "..."]
}`;

const FINAL_CONSTRAINTS = `القيود (التزم بها حرفياً): التلخيص يحفظ ~80% من قيمة المقال وتفاصيله التقنية بحجم أقلّ من الأصل. خطة التطبيق مفصّلة وملموسة على المشروع لا عامة. بالضبط ٣ أفكار ثريدات و٣ أفكار إيميلات. JSON فقط بلا نصّ خارجه.`;

// مخططات الإخراج المنظّم (الدستور §٣-١) — تُفعّل فكّ التشفير المقيَّد فتضمن JSON صالحاً.
// حرجة هنا تحديداً: مخرج المقال نصّ عربي طويل مليء بالاقتباسات والأسطر المتعددة —
// وهو بالضبط ما يكسر responseMimeType وحده. الفشل كان يظهر كردّ «تعذّر تحليله» بلا سبب.
const strList = { type: "array", items: { type: "string" } };
const DERIVED_PROPS = {
  application_plan: strList,
  thread_ideas: strList,
  email_ideas: strList,
  insights: strList,
};
const DERIVED_REQUIRED = ["application_plan", "thread_ideas", "email_ideas", "insights"];

const ARTICLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { summary: { type: "string" }, ...DERIVED_PROPS },
  required: ["summary", ...DERIVED_REQUIRED],
};
const CONDENSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};
const DERIVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: DERIVED_PROPS,
  required: DERIVED_REQUIRED,
};

const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);

function normalize(p: Partial<ArticleAnalysis> | null): ArticleAnalysis | null {
  if (!p || typeof p.summary !== "string" || !p.summary.trim()) return null;
  return {
    summary: p.summary,
    application_plan: arr(p.application_plan),
    thread_ideas: arr(p.thread_ideas),
    email_ideas: arr(p.email_ideas),
    insights: arr(p.insights),
  };
}

// نداء واحد: المقال كاملاً (البيانات أولاً) ثمّ التعليمة والقيود الكمية آخراً (مبدأ Gemini 3.1).
async function analyzeOnePass(text: string, system: string): Promise<ArticleAnalysis | null> {
  const prompt = `المقال:
${text}

—
بناءً على المقال أعلاه وسياق المشروع، أنتج JSON بهذه الحقول بالضبط:
${OUTPUT_SCHEMA}

${FINAL_CONSTRAINTS}`;
  const res = await proJson(prompt, system, ARTICLE_SCHEMA);
  if (!res.ok) {
    console.error(`[article:onepass] فشل proJson: ${res.error}`);
    return null;
  }
  const a = normalize(parseJson<ArticleAnalysis>(res.data));
  if (!a) console.error(`[article:onepass] مخرج غير صالح: ${res.data.slice(0, 300)}`);
  return a;
}

// مرحلتان للمقال الضخم: (١) تكثيف أمين للنصّ كاملاً، (٢) اشتقاق الأصول من المُكثَّف.
async function analyzeTwoStage(text: string, system: string): Promise<ArticleAnalysis | null> {
  const condensePrompt = `المقال (طويل):
${text}

—
بناءً على المقال أعلاه، اكتب تكثيفاً أميناً يحفظ جوهره وكلّ تفاصيله التقنية (الأرقام، الأمثلة، الخطوات) بحجم أقلّ من الأصل دون فقدان التقنية.

أخرج JSON فقط: {"summary": "نصّ التكثيف"}`;
  const cond = await proJson(condensePrompt, system, CONDENSE_SCHEMA);
  if (!cond.ok) console.error(`[article:condense] فشل proJson: ${cond.error}`);
  const summary = cond.ok ? parseJson<{ summary: string }>(cond.data)?.summary : "";
  if (!summary || !summary.trim()) {
    if (cond.ok) console.error(`[article:condense] تكثيف فارغ: ${cond.data.slice(0, 300)}`);
    return null;
  }

  const derivePrompt = `ملخّص المقال (مكثّف أمين):
${summary}

—
بناءً على الملخّص أعلاه وسياق المشروع، أنتج JSON بهذه الحقول بالضبط:
{
  "application_plan": ["خطوة تطبيق مفصّلة وملموسة على المشروع", "..."],
  "thread_ideas": ["فكرة ثريد ١", "فكرة ثريد ٢", "فكرة ثريد ٣"],
  "email_ideas": ["فكرة إيميل ١", "فكرة إيميل ٢", "فكرة إيميل ٣"],
  "insights": ["رؤية مربوطة بسياق ${OWNER_NAME} والمشروع الحالي", "..."]
}

القيود (التزم بها حرفياً): خطة التطبيق مفصّلة وملموسة على المشروع لا عامة. بالضبط ٣ أفكار ثريدات و٣ أفكار إيميلات. JSON فقط بلا نصّ خارجه.`;
  const der = await proJson(derivePrompt, system, DERIVE_SCHEMA);
  if (!der.ok) console.error(`[article:derive] فشل proJson: ${der.error}`);
  const d = der.ok ? parseJson<Omit<ArticleAnalysis, "summary">>(der.data) : null;
  if (der.ok && !d) console.error(`[article:derive] تعذّر تفكيك JSON: ${der.data.slice(0, 300)}`);
  // التكثيف نجح — نُرجع الملخّص حتى لو فشل الاشتقاق (أصل واحد خير من لا شيء).
  return normalize({ summary, ...(d ?? {}) });
}

function bullets(a: string[]): string {
  return a.length ? a.map((x) => `• ${x}`).join("\n") : "—";
}

function formatArticleReply(a: ArticleAnalysis): string {
  return [
    `📄 ملخّص المقال\n${a.summary}`,
    `🎯 خطة التطبيق على المشروع\n${bullets(a.application_plan)}`,
    `🧵 أفكار ثريدات\n${bullets(a.thread_ideas)}`,
    `📧 أفكار إيميلات\n${bullets(a.email_ideas)}`,
    `💡 رؤى وربط بسياقك\n${bullets(a.insights)}`,
  ].join("\n\n");
}

// حفظ المخرج على صفّ المقال (items.analysis) — best-effort: لا يكسر الردّ إن غاب العمود/فشل.
async function saveArticleAnalysis(itemId: string, a: ArticleAnalysis): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.from("items").update({ analysis: a }).eq("id", itemId);
  } catch {
    // تجاهل — الحفظ تحسينيّ (المقال محفوظ خاماً على أي حال).
  }
}

// المدخل الرئيسي: يحلّل المقال (نداء واحد أو مرحلتان حسب الطول)، يحفظ المخرج، ويعيد
// الردّ المنسّق + أفكار الثريدات (ليلتقطها الـwebhook تلقائياً كأفكار محتوى)
// + عدد بنود خطة التطبيق (ليعرض الـwebhook زرّ التحويل لمهام — الملف 13، البند ٤).
export async function analyzeArticle(
  text: string,
  itemId?: string,
): Promise<{ reply: string; threadIdeas: string[]; planCount: number }> {
  try {
    const body = text.trim();
    if (!body) return { reply: SAVED_FALLBACK, threadIdeas: [], planCount: 0 };
    const system = await buildArticleSystem();
    const a =
      body.length <= ONE_PASS_MAX_CHARS
        ? await analyzeOnePass(body, system)
        : await analyzeTwoStage(body, system);
    if (!a) return { reply: SAVED_FALLBACK, threadIdeas: [], planCount: 0 };
    if (itemId) await saveArticleAnalysis(itemId, a);
    return {
      reply: formatArticleReply(a),
      threadIdeas: a.thread_ideas,
      planCount: a.application_plan.length,
    };
  } catch {
    return { reply: SAVED_FALLBACK, threadIdeas: [], planCount: 0 };
  }
}

// ════════════════════════════════════════════════════════════
// خطة المقال → مهام (الملف 13 — البند ٤): كانت خطة التطبيق تُقرأ ثم تتبخر.
// زرّ في تيليجرام يحوّل بنودها لمهام مفكّكة بجسر related_item_id للمقال —
// فتمتلئ الجسور ويعمل resolveBridges القائم على بيانات حقيقية.
// ════════════════════════════════════════════════════════════
export type PlanConversion =
  | { status: "created"; titles: string[] }
  | { status: "already" }
  | { status: "empty" }
  | { status: "failed" };

type PlanTaskRow = {
  title: string;
  project: TaskProject;
  kind: TaskKind;
  steps: { text: string; est_minutes: number; done: boolean }[];
};

// نداء flash واحد يحوّل كل البنود دفعةً (لا نداء لكل بند) بعقد التفصيل نفسه.
async function planItemsToTasks(planItems: string[]): Promise<PlanTaskRow[] | null> {
  const prompt = `أنت مساعد التقاط في نظام «عقل ${OWNER_NAME}». التالي بنود «خطة تطبيق» استُخلصت من مقال لصالح مشروع ${OWNER_NAME}. حوّل كل بند إلى مهمة قابلة للتنفيذ.

أعد JSON فقط بهذا الشكل حصراً:
{
  "tasks": [
    {
      "title": "عنوان موجز ٣–٧ كلمات",
      "project": "المشروع" أو "العمل" أو "شخصي",
      "kind": "build" أو "market" أو "content" أو "admin" أو "personal",
      "steps": [ { "text": "خطوة فعل واضحة جاهزة للبدء", "est_minutes": 30 } ]
    }
  ]
}

قواعد:
- بند واحد = مهمة واحدة، بنفس ترتيب البنود.
- فكّك كل مهمة لخطوات صغيرة جاهزة للبدء الفوري؛ الأولى واضحة لدرجة لا تحتاج تفكيراً (١–٤ خطوات).
- kind: build بناء/برمجة · market تسويق/تواصل عملاء · content كتابة محتوى · admin إدارية.

البنود:
${planItems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;

  const res = await flashJson(prompt);
  if (!res.ok) {
    console.error("[plan-to-tasks] فشل flashJson:", res.error);
    return null;
  }
  try {
    const p = JSON.parse(res.data) as { tasks?: unknown };
    if (!Array.isArray(p.tasks)) return null;
    const out: PlanTaskRow[] = [];
    for (const t of p.tasks) {
      const o = (t ?? {}) as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      if (!title) continue;
      out.push({
        title,
        project: TASK_PROJECTS.includes(o.project as TaskProject)
          ? (o.project as TaskProject)
          : PROJECT_MAIN,
        kind: TASK_KINDS.includes(o.kind as TaskKind) ? (o.kind as TaskKind) : "admin",
        steps: normalizeSteps(o.steps),
      });
    }
    return out;
  } catch (e) {
    console.error("[plan-to-tasks] تعذّر تفكيك JSON:", e);
    return null;
  }
}

/** يحوّل خطة تطبيق مقال محفوظ إلى مهام بجسر للمقال. حارس تكرار بالجسر نفسه. */
export async function convertPlanToTasks(itemId: string): Promise<PlanConversion> {
  const supabase = createAdminClient();

  // حارس التكرار: مهام بنفس الجسر موجودة → لا تحويل ثانٍ.
  const { count } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("related_item_id", itemId);
  if ((count ?? 0) > 0) return { status: "already" };

  const { data: item } = await supabase
    .from("items")
    .select("analysis")
    .eq("id", itemId)
    .maybeSingle();
  const analysis = (item?.analysis ?? null) as Partial<ArticleAnalysis> | null;
  const plan = Array.isArray(analysis?.application_plan)
    ? analysis.application_plan.map(String).filter(Boolean)
    : [];
  if (plan.length === 0) return { status: "empty" };

  const rows = await planItemsToTasks(plan);

  // إعادة الفحص بعد نداء flash الطويل — ضغطتان متسارعتان تمرّان معاً من الحارس
  // الأول (TOCTOU)؛ هذا يضيّق النافذة إلى أجزاء الثانية (إصلاح مراجعة).
  const { count: recheck } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("related_item_id", itemId);
  if ((recheck ?? 0) > 0) return { status: "already" };

  // تراجع آمن: فشل التحويل الذكي → مهمة خام لكل بند (لا يضيع بند).
  const fallback: PlanTaskRow[] = plan.map((p) => ({
    title: truncate(p, 80),
    project: PROJECT_MAIN,
    kind: "admin",
    steps: [{ text: truncate(p, 100), est_minutes: 30, done: false }],
  }));
  const toInsert = rows && rows.length > 0 ? rows : fallback;

  const titles: string[] = [];
  for (const r of toInsert) {
    try {
      const inserted = await insertTask(
        { ...r, time_signal: null },
        "telegram",
        itemId,
      );
      titles.push(inserted.title);
    } catch (e) {
      console.error("[plan-to-tasks] فشل إدراج مهمة:", e);
    }
  }
  return titles.length > 0 ? { status: "created", titles } : { status: "failed" };
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { searchWeb } from "@/lib/ai/gemini";
import { retrieveContext, queryPerformance } from "@/lib/agents/access";
import {
  type IdeaCriteria,
  type DraftOptions,
  PERSONA_AR,
  ANGLE_AR,
  isSalesPurpose,
} from "@/lib/newsletter/criteria";
import {
  getEmailExamples,
  buildDraftDirectives,
  buildExamplesBlock,
  buildOutlineExamplesBlock,
  getNewsletterTastePairs,
} from "@/lib/newsletter/generate";
import {
  type NewsletterStage,
  buildToneLine,
  buildIdeasUserContent,
  buildOutlineUserContent,
  buildDraftUserContent,
  buildNewsletterRevisionSuffix,
  loadSalesExamples,
  pickSalesExamples,
  buildSalesExamplesBlock,
} from "@/lib/newsletter/prompt-builder";

// ════════════════════════════════════════════════════════════
// تجهيز مهام النشرة وصفّها للعامل (الملف 26).
//
// التقسيم كما في الملف 16: كل ما يحتاج قاعدة البيانات أو Gemini (الذاكرة، البحث
// الحيّ، أمثلة الأرشيف، تلقيح إكس) يجري **هنا** على Vercel وينتهي إلى نصّ واحد؛
// والعامل لا يعرف Supabase ولا Gemini — يستلم النصّ ويشغّل الجلسة ويعيد JSON.
// ════════════════════════════════════════════════════════════

export type QueueResult = { ok: true; jobId: string } | { ok: false; error: string };

async function insertJob(
  stage: NewsletterStage,
  userContent: string,
  opts: {
    model?: string; effort?: string; critique?: boolean;
    newsletterId?: string; critic?: string;
  },
): Promise<QueueResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      kind: "newsletter",
      newsletter_stage: stage,
      user_content: userContent,
      analysis: {},
      critique_enabled: opts.critique ?? false,
      // 'merge' = دمج متوازٍ (كلود × جيبيتي) · null = نقد داخلي فقط
      critic: opts.critic ?? null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      newsletter_id: opts.newsletterId ?? null,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: "تعذّر صفّ الطلب: " + error.message };
  return { ok: true, jobId: String(data.id) };
}

/** المرحلة ١: أفكار — تُجهَّز بالذاكرة والبحث الحيّ وتلقيح إكس ثم تُصفّ. */
export async function queueIdeasJob(
  c: IdeaCriteria,
  opts: { model?: string; effort?: string } = {},
): Promise<QueueResult> {
  const topic = c.topic.trim();
  if (!topic) return { ok: false, error: "لا محور — اكتب محور النشرة أولاً." };

  const useMemory = c.source === "memory" || c.source === "both";
  const useRecent = c.source === "recent" || c.source === "both";
  const [mem, recent, topPosts] = await Promise.all([
    useMemory ? retrieveContext(topic, { semantic: true, semanticCount: 8 }) : Promise.resolve(null),
    useRecent
      ? searchWeb(`أحدث ما يخصّ: ${topic} — أدوات أو أحداث أو اتجاهات حديثة فقط، بإيجاز.`)
      : Promise.resolve(null),
    queryPerformance({ kind: "byTopic", topic, limit: 4 }, topic).catch(() => []),
  ]);

  // استبعاد صفري التفاعل: منشور بلا أرقام يظهر بتفاعل 0 — تقديمه «كما رنّ» تضليل.
  const topPostsBlock = topPosts
    .filter((s) => (s.metrics?.engagement ?? 0) > 0)
    .map((s) => `- (تفاعل ${s.metrics?.engagement ?? 0}) ${s.text}`)
    .join("\n");

  const n = Math.max(1, Math.min(c.count || 4, 6));
  const content = buildIdeasUserContent(
    topic,
    PERSONA_AR[c.persona] ?? "أي شخصية مناسبة من جمهور المالك",
    c.angle !== "auto" ? (ANGLE_AR[c.angle] ?? "الأنسب") : "الأنسب",
    c.notes,
    mem?.block ?? "",
    recent && recent.ok ? recent.data : "",
    topPostsBlock,
    n,
  );
  return insertJob("ideas", content, opts);
}

/** المرحلة ٢: هيكل. */
export async function queueOutlineJob(
  idea: string,
  o: DraftOptions,
  opts: { model?: string; effort?: string; rawText?: string } = {},
): Promise<QueueResult> {
  const topic = idea.trim();
  if (!topic) return { ok: false, error: "لا فكرة — اختر فكرة أو اكتبها." };

  const [examples, search] = await Promise.all([
    getEmailExamples(topic, 2),
    o.search
      ? searchWeb(`أحدث ما يخصّ: ${topic} — حقائق أو أمثلة حديثة بإيجاز.`)
      : Promise.resolve(null),
  ]);
  const content = buildOutlineUserContent(
    topic,
    buildDraftDirectives(o),
    search && search.ok && search.data.trim() ? "بحث حيّ:\n" + search.data.trim() + "\n\n" : "",
    buildOutlineExamplesBlock(examples),
    o.tone.depth,
    o.tone.urgency,
    opts.rawText ?? "",
  );
  return insertJob("outline", content, opts);
}

/**
 * تجميع مدخل المسودة — يتشاركه التوليد وجولة المراجعة، فلا يتباعد ما يراه
 * النموذج بين الجولتين. يُرجع null إن غابت الفكرة.
 */
async function buildDraftContent(
  idea: string,
  o: DraftOptions,
  outline: string | undefined,
  rawText: string,
): Promise<string | null> {
  const ideaText = idea.trim();
  if (!ideaText) return null;

  // نفس منطق مسار API (الملف 32): الأمثلة تتبع الغرض — التوليدة البيعية تحتذي
  // رسائله البيعية المرسَلة لا نشراته التعليمية.
  const salesMode = isSalesPurpose(o.purpose);
  const [examples, search, tastePairs, salesAll, calib] = await Promise.all([
    salesMode ? Promise.resolve([] as string[]) : getEmailExamples(ideaText, 3),
    o.search
      ? searchWeb(`أحدث ما يخصّ: ${ideaText} — حقائق أو أرقام أو أمثلة حديثة بإيجاز.`)
      : Promise.resolve(null),
    getNewsletterTastePairs(3).catch(() => []),
    salesMode ? loadSalesExamples().catch(() => []) : Promise.resolve([]),
    // معايرة الأداء البريدي (الملف 36): تلتحق بالتوجيهات — طبقة اختيارية تتراجع بصمت
    import("@/lib/loops/report").then((m) => m.getCampaignCalibrationBlock()).catch(() => ""),
  ]);
  return buildDraftUserContent(
    ideaText,
    buildDraftDirectives(o) + calib,
    outline,
    search && search.ok && search.data.trim() ? search.data.trim() + "\n" : "",
    salesMode
      ? buildSalesExamplesBlock(pickSalesExamples(salesAll, ideaText, 2))
      : buildExamplesBlock(examples),
    buildToneLine(o.tone),
    rawText,
    tastePairs,
  );
}

/** المرحلة ٣: المسودة (+ حلقة النقد على العامل إن طُلبت). */
export async function queueDraftJob(
  idea: string,
  o: DraftOptions,
  outline: string | undefined,
  opts: {
    model?: string; effort?: string; critique?: boolean;
    newsletterId?: string; rawText?: string; critic?: string;
  } = {},
): Promise<QueueResult> {
  const content = await buildDraftContent(idea, o, outline, opts.rawText ?? "");
  if (!content) return { ok: false, error: "لا فكرة — اختر فكرة أو اكتبها." };
  return insertJob("draft", content, { ...opts, critique: opts.critique ?? true });
}

/**
 * جولة مراجعة (الملف 33) — **تعمل على ما في الشاشة لا على صفّ مهمة سابق.**
 *
 * كان الاعتماد على معرّف الجولة السابقة يُخفي الزرّ بعد حفظ النشرة وإعادة فتحها
 * (المعرّف حالة جلسة تبدأ فارغة عند التركيب). والبناء من الحالة الراهنة أمتن
 * ولّه ميزة ثانية: يحترم إعدادات المالك **الحالية** إن غيّر الغرض أو الطول أو
 * النبرة بعد التوليد — بينما إعادة استعمال المدخل القديم تُبقي إعدادات بائتة.
 *
 * بلا نقد وبلا دمج عمداً: الملاحظة نفسها هي النقد، ولا نريد صقلاً يعاكسها.
 */
export async function queueNewsletterRevision(
  idea: string,
  o: DraftOptions,
  previous: { subject: string; draft: string },
  note: string,
  opts: {
    model?: string; effort?: string; rawText?: string;
    outline?: string; newsletterId?: string; previousJobId?: string;
  } = {},
): Promise<QueueResult> {
  const feedback = note.trim();
  if (!feedback) return { ok: false, error: "اكتب ملاحظتك أولاً — ما الذي لم يعجبك؟" };
  const prevDraft = previous.draft.trim();
  if (!prevDraft) return { ok: false, error: "لا مسودة لمراجعتها." };

  const base = await buildDraftContent(idea, o, opts.outline, opts.rawText ?? "");
  if (!base) return { ok: false, error: "لا فكرة — اختر فكرة أو اكتبها." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      kind: "newsletter",
      newsletter_stage: "draft",
      newsletter_id: opts.newsletterId ?? null,
      analysis: {},
      critique_enabled: false,
      critic: null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      user_content:
        base + buildNewsletterRevisionSuffix(previous.subject, prevDraft, feedback),
      revision_of: opts.previousJobId ?? null,
      revision_note: feedback,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: "تعذّر صفّ جولة المراجعة: " + error.message };
  return { ok: true, jobId: String(data.id) };
}

// ── متابعة الحالة ──

export type NewsletterJobView =
  | { status: "queued" | "running"; note: string | null }
  | { status: "failed"; error: string }
  | {
      status: "done";
      stage: NewsletterStage;
      ideas: string[];
      outline: string;
      subject: string;
      draft: string;
      critique: {
        overall: number | null; weakest: string[];
        firstSubject: string; firstDraft: string; mergeReport: string;
      } | null;
      // نشرة جيبيتي الخام في وضع الدمج — ليحكم المالك بعينه
      alt: { subject: string; draft: string } | null;
      note: string | null;
    };

export async function getNewsletterJobView(jobId: string): Promise<NewsletterJobView | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("generation_jobs")
    .select("status, result, alt_result, error, worker_note, newsletter_stage")
    .eq("id", jobId)
    .maybeSingle();
  if (!data) return null;

  const status = String(data.status);
  if (status === "failed") {
    return { status: "failed", error: String(data.error ?? "فشل التوليد بلا رسالة.") };
  }
  if (status !== "done") {
    return {
      status: status === "running" ? "running" : "queued",
      note: (data.worker_note as string | null) ?? null,
    };
  }

  const r = (data.result ?? {}) as Record<string, unknown>;
  const crit = r.critique as Record<string, unknown> | null | undefined;
  return {
    status: "done",
    stage: (data.newsletter_stage as NewsletterStage) ?? "draft",
    ideas: Array.isArray(r.ideas) ? r.ideas.map(String) : [],
    outline: typeof r.outline === "string" ? r.outline : "",
    subject: typeof r.subject === "string" ? r.subject : "",
    draft: typeof r.draft === "string" ? r.draft : "",
    critique: crit
      ? {
          overall: typeof crit.overall === "number" ? crit.overall : null,
          weakest: Array.isArray(crit.weakest) ? crit.weakest.map(String) : [],
          firstSubject: typeof crit.firstSubject === "string" ? crit.firstSubject : "",
          firstDraft: typeof crit.firstDraft === "string" ? crit.firstDraft : "",
          mergeReport: typeof crit.mergeReport === "string" ? crit.mergeReport : "",
        }
      : null,
    alt: (() => {
      const a = data.alt_result as Record<string, unknown> | null | undefined;
      if (!a || typeof a.draft !== "string" || !a.draft.trim()) return null;
      return { subject: typeof a.subject === "string" ? a.subject : "", draft: a.draft };
    })(),
    note: (data.worker_note as string | null) ?? null,
  };
}

/** إلغاء طلب لم يبدأ بعد (شرط status='queued' يمنع سباق الالتقاط). */
export async function cancelNewsletterJob(jobId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("generation_jobs")
    .update({ status: "failed", error: "أُلغي بطلب المستخدم.", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { searchWeb } from "@/lib/ai/gemini";
import {
  analyzeForPublishing,
  type PublishingAnalysis,
} from "@/lib/content/analyze";
import {
  getBestPostExamples,
  getRecentNewsletterLines,
  getTastePairs,
} from "@/lib/content/generate";
import { getCalibration, calibrationLine } from "@/lib/content/calibration";
import { getPatternAggregates, provenPatternsLine } from "@/lib/content/patterns";
import {
  buildDirectives,
  buildDirectivesBlock,
  hasDirectives,
  type GenOverrides,
} from "@/lib/content/overrides";
import {
  buildSp2UserContent,
  buildRevisionSuffix,
  type GeneratedDraft,
} from "@/lib/content/prompt-builder";

// ════════════════════════════════════════════════════════════
// طابور توليد الجلسة (الملف 16): Vercel يجهّز كل شيء (تحليل + بحث + أمثلة
// + معايرة + أنماط + نشرات → مدخل SP2 نصاً كاملاً) ويصفّه في generation_jobs،
// وعامل الـVPS ينفّذ بجلسة الاشتراك (Fable) ويكتب النتيجة. العامل ناقل تنفيذ
// غبي عمداً — كل الذكاء التركيبي يبقى هنا بنفس دوال مسار API (مصدر حقيقة واحد).
// ════════════════════════════════════════════════════════════

export type QueueOutcome =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

// نفس برومبت البحث الحيّ في actions (الإضافة ٢) — منسوخ بإحالة: actions ملف
// "use server" لا يُصدِّر غير الإجراءات، والنص صغير ثابت.
async function runSearch(rawText: string): Promise<string | null> {
  const prompt =
    "ابحث في الويب وأعطني بإيجاز (حتى ~120 كلمة) أحدث المعلومات ذات الصلة بهذه الفكرة — " +
    'أدوات أو نماذج أو تقنيات أو أحداث جديدة فقط. إن لم تجد جديداً ذا صلة، قل "لا جديد ذا صلة".\n' +
    "الفكرة: " +
    rawText.slice(0, 500);
  const res = await searchWeb(prompt);
  return res.ok ? res.data : null;
}

/** يجهّز طلب توليد كاملاً ويصفّه — يعيد معرّف الطلب للاستطلاع. */
export async function queueGenerationJob(params: {
  itemId: string | null;
  rawText: string;
  topic: string | null;
  summary: string | null;
  overrides: GenOverrides;
  queryEmbedding: number[] | null;
  // هجرة 0021: تحكّم لكل طلب — null = افتراضيا العامل (WORKER_MODEL/WORKER_EFFORT)
  model: string | null;
  effort: string | null;
  // هجرة 0022: الناقد — null = داخلي (كلود) · "codex" = خارجي (جيبيتي)
  critic: string | null;
}): Promise<QueueOutcome> {
  const { itemId, rawText, topic, summary, overrides: ov, queryEmbedding } = params;

  // نفس مقدمة generateFromRaw حرفياً: تحليل + بحث بالتوازي، ثم فرض التوجيهات.
  const [analysis, searchResults] = await Promise.all([
    analyzeForPublishing({ raw_text: rawText, topic, summary }),
    ov.search ? runSearch(rawText) : Promise.resolve(null),
  ]);
  if (!analysis) return { ok: false, error: "تعذّر تحليل الفكرة للنشر." };

  const directives = buildDirectives(ov);
  if (directives.forced_type === "thread") analysis.content_type = "thread";
  else if (
    directives.forced_type === "long_tweet" ||
    directives.forced_type === "medium_tweet"
  )
    analysis.content_type = "tweet";

  // كتل الإثراء — نفس مصادر مسار API (best-effort حيث كانت كذلك).
  const [examples, calibration, patterns, recentNl, tastePairs] = await Promise.all([
    getBestPostExamples(4, queryEmbedding),
    getCalibration().catch(() => null),
    getPatternAggregates().catch(() => null),
    getRecentNewsletterLines(),
    getTastePairs(),
  ]);

  const dirBlock =
    hasDirectives(directives) ? buildDirectivesBlock(directives) : "";
  const userContent = buildSp2UserContent(
    analysis as unknown as Record<string, unknown>,
    examples,
    dirBlock,
    searchResults,
    calibration ? calibrationLine(calibration) : null,
    patterns ? provenPatternsLine(patterns) : null,
    recentNl,
    rawText,
    tastePairs,
  );

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      item_id: itemId,
      analysis,
      critique_enabled: ov.critique,
      user_content: userContent,
      raw_text: rawText, // الملف 19: يصل الناقد والدامج مرجعاً للحقائق
      model: params.model,
      effort: params.effort,
      critic: params.critic,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: "فشل صفّ الطلب: " + (error?.message ?? "غير معروف") };
  }
  return { ok: true, jobId: data.id as string };
}

/** صفّ مهمة إنفوغرافيك (الملف 21): نص المسودة → صورة عبر الجلسة الوكيلية. */
export async function queueVisualJob(
  draftText: string,
  postId: string | null,
): Promise<QueueOutcome> {
  const text = draftText.trim();
  if (!text) return { ok: false, error: "لا نص لتحويله لإنفوغرافيك." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      kind: "visual",
      analysis: {},
      critique_enabled: false,
      user_content: text,
      post_id: postId,
    })
    .select("id")
    .single();
  if (error || !data)
    return { ok: false, error: "فشل صفّ مهمة الإنفوغرافيك: " + (error?.message ?? "غير معروف") };
  return { ok: true, jobId: data.id as string };
}

/** جولة مراجعة (الملف 24): تعيد استعمال مدخل الجولة السابقة كاملاً وتُلحق به
 *  المسودة والملاحظة. بلا نقد ولا دمج — الملاحظة نفسها هي النقد، والجولة سريعة. */
export async function queueRevisionJob(
  previousJobId: string,
  note: string,
): Promise<QueueOutcome> {
  const feedback = note.trim();
  if (!feedback) return { ok: false, error: "اكتب ملاحظتك أولاً — ما الذي لم يعجبك؟" };
  const supabase = await createClient();
  const { data: prev } = await supabase
    .from("generation_jobs")
    .select("user_content, analysis, raw_text, model, effort, item_id, result, kind")
    .eq("id", previousJobId)
    .maybeSingle();
  if (!prev) return { ok: false, error: "لم أجد الجولة السابقة." };
  const previousDraft = ((prev.result as GeneratedDraft | null)?.draft ?? "").trim();
  if (!previousDraft) return { ok: false, error: "الجولة السابقة بلا مسودة." };

  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      kind: "draft",
      item_id: prev.item_id,
      analysis: prev.analysis,
      raw_text: prev.raw_text,
      model: prev.model,
      effort: prev.effort,
      critique_enabled: false, // الملاحظة هي النقد — ولا نريد صقلاً يعاكسها
      critic: null,
      user_content:
        (prev.user_content as string) + buildRevisionSuffix(previousDraft, feedback),
      revision_of: previousJobId,
      revision_note: feedback,
    })
    .select("id")
    .single();
  if (error || !data)
    return { ok: false, error: "فشل صفّ جولة المراجعة: " + (error?.message ?? "غير معروف") };
  return { ok: true, jobId: data.id as string };
}

/** صفّ مسودة Typefully (الملف 22): النص الجاهز → مسودة للمراجعة هناك. */
export async function queueTypefullyJob(draftText: string): Promise<QueueOutcome> {
  const text = draftText.trim();
  if (!text) return { ok: false, error: "لا نص لإرساله إلى Typefully." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({ kind: "typefully", analysis: {}, critique_enabled: false, user_content: text })
    .select("id")
    .single();
  if (error || !data)
    return { ok: false, error: "فشل صفّ مسودة Typefully: " + (error?.message ?? "غير معروف") };
  return { ok: true, jobId: data.id as string };
}

export type JobView = {
  status: "queued" | "running" | "done" | "failed";
  kind: "draft" | "visual" | "typefully";
  createdAt: string;
  startedAt: string | null;
  analysis: PublishingAnalysis;
  draft: GeneratedDraft | null;
  // الملف 21: نتيجة مهمة الإنفوغرافيك
  imageUrl: string | null;
  visualScore: number | null;
  // الملف 22: رابط مسودة Typefully
  typefullyUrl: string | null;
  // الملف 18: توليدة جيبيتي الخام في وضع الدمج — ليحكم المالك بعينه
  altDraft: GeneratedDraft | null;
  modelUsed: string | null;
  workerNote: string | null;
  error: string | null;
};

/** حالة طلب للاستطلاع من الواجهة. */
export async function getJobView(jobId: string): Promise<JobView | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("generation_jobs")
    .select("status, kind, created_at, started_at, analysis, result, alt_result, model_used, worker_note, error")
    .eq("id", jobId)
    .maybeSingle();
  if (!data) return null;
  const kind = ((data.kind as string) ?? "draft") as JobView["kind"];
  const visual =
    kind === "visual" ? ((data.result as { image_url?: string; score?: number }) ?? null) : null;
  return {
    status: data.status as JobView["status"],
    kind,
    createdAt: data.created_at as string,
    startedAt: (data.started_at as string) ?? null,
    analysis: data.analysis as PublishingAnalysis,
    draft: kind === "draft" ? ((data.result as GeneratedDraft) ?? null) : null,
    imageUrl: visual?.image_url ?? null,
    visualScore: typeof visual?.score === "number" ? visual.score : null,
    typefullyUrl:
      kind === "typefully" ? (((data.result as { url?: string })?.url as string) ?? null) : null,
    altDraft: (data.alt_result as GeneratedDraft) ?? null,
    modelUsed: (data.model_used as string) ?? null,
    workerNote: (data.worker_note as string) ?? null,
    error: (data.error as string) ?? null,
  };
}

/** إلغاء طلب لم يلتقطه العامل بعد (queued فقط) — للتحكم حين يغيب العامل. */
export async function cancelQueuedJob(jobId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .update({ status: "failed", error: "أُلغي يدوياً قبل التنفيذ." })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id");
  return !error && (data ?? []).length > 0;
}

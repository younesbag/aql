"use server";

import { createClient } from "@/lib/supabase/server";
import { embed } from "@/lib/ai/gemini";
import {
  generateIdeas,
  generateNewsletterDraft,
  generateNewsletterOutline,
} from "@/lib/newsletter/generate";
import {
  fetchNewsletters,
  fetchCapturedIdeas,
  fetchPostSeeds,
  type CapturedIdea,
  type PostSeed,
} from "@/lib/newsletter/list";
import {
  queueIdeasJob,
  queueOutlineJob,
  queueDraftJob,
  getNewsletterJobView,
  cancelNewsletterJob,
  queueNewsletterRevision,
  type NewsletterJobView,
} from "@/lib/newsletter/jobs";
import type { NewsletterStage } from "@/lib/newsletter/prompt-builder";
import type {
  IdeaCriteria,
  DraftOptions,
  DraftResult,
  NewsletterRow,
} from "@/lib/newsletter/criteria";

// حصن القناة: محرّك النشرة خلف المصادقة (طبقة ثانية فوق proxy).
async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

// نتائج الإجراءات للواجهة — تُعاد كقيمة (لا تُرمى). في الإنتاج يحذف Next.js رسائل
// الأخطاء المرميّة من إجراءات الخادم ويستبدلها بنصّ إنجليزي عامّ؛ الإعادة كقيمة تُبقي
// الرسالة العربية الدقيقة (رصيد أنثروبيك، مهلة، حدّ طول، رفض...) سليمة حتى تصل الواجهة.
export type IdeasOutcome =
  | { ok: true; ideas: string[] }
  | { ok: false; error: string };
export type OutlineOutcome =
  | { ok: true; outline: string }
  | { ok: false; error: string };
export type NewsletterDraftOutcome =
  | { ok: true; result: DraftResult }
  | { ok: false; error: string };
export type SaveNewsletterOutcome =
  | { ok: true; id: string }
  | { ok: false; error: string };

// ════════════════════════════════════════════════════════════
// مسار الجلسة (الملف 26): يصفّ المرحلة للعامل ثم تستطلع الواجهة النتيجة.
// المسار المباشر (API) يبقى طوارئ ضمن سقف ٣٠٠ث — كما في محرّك إكس تماماً.
// ════════════════════════════════════════════════════════════
export type QueueOutcome = { ok: true; jobId: string } | { ok: false; error: string };

/** يصفّ مرحلة من مراحل النشرة الثلاث. */
export async function queueNewsletterStage(
  stage: NewsletterStage,
  payload: {
    criteria?: IdeaCriteria;
    idea?: string;
    options?: DraftOptions;
    outline?: string;
    critique?: boolean;
    rawText?: string;
  },
  control: { model?: string; effort?: string; critic?: string } = {},
): Promise<QueueOutcome> {
  await requireUser();
  try {
    if (stage === "ideas") {
      if (!payload.criteria) return { ok: false, error: "لا معايير — حدّد المحور أولاً." };
      return await queueIdeasJob(payload.criteria, control);
    }
    if (!payload.options) return { ok: false, error: "لا خيارات توليد." };
    if (stage === "outline") {
      // الدمج للمسودة وحدها — الهيكل خطّة لا نصّ يُركَّب
      return await queueOutlineJob(payload.idea ?? "", payload.options, {
        model: control.model,
        effort: control.effort,
        rawText: payload.rawText,
      });
    }
    return await queueDraftJob(payload.idea ?? "", payload.options, payload.outline, {
      ...control,
      critique: payload.critique ?? true,
      rawText: payload.rawText,
    });
  } catch (e) {
    console.error("[newsletter queue]", e);
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر تجهيز الطلب." };
  }
}

/** استطلاع حالة مهمة نشرة. */
export async function pollNewsletterJob(jobId: string): Promise<NewsletterJobView | null> {
  await requireUser();
  return getNewsletterJobView(jobId);
}

/**
 * جولة مراجعة على مسودة نشرة (الملف 33): تعيد استعمال مدخل الجولة السابقة
 * كاملاً وتُلحق به ملاحظة المالك — فلا يُفقد ما نجح عند كل رفض.
 */
export async function queueNewsletterRevisionAction(
  idea: string,
  options: DraftOptions,
  previous: { subject: string; draft: string },
  note: string,
  extra: {
    model?: string; effort?: string; rawText?: string;
    outline?: string; newsletterId?: string; previousJobId?: string;
  } = {},
): Promise<QueueOutcome> {
  await requireUser();
  try {
    return await queueNewsletterRevision(idea, options, previous, note, extra);
  } catch (e) {
    console.error("[newsletter revision]", e);
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر صفّ جولة المراجعة." };
  }
}

/** إلغاء طلب لم يبدأ بعد. */
export async function cancelNewsletterGeneration(jobId: string): Promise<{ ok: boolean }> {
  await requireUser();
  return { ok: await cancelNewsletterJob(jobId) };
}

/**
 * تسجيل زوج ذوق بريديّ (الملف 27): المولَّد ← ما اعتمده المالك بعد تحريره.
 * قناة 'newsletter' حصراً — أزواج إكس لا تُحقن هنا والعكس، لأن أطوالها وإيقاعها
 * مختلفان. هذا هو المصدر الوحيد لملء القناة: تحريره الفعليّ لا حكم نموذج.
 */
export async function saveNewsletterTastePair(
  ideaText: string,
  rejected: string,
  preferred: string,
  lesson?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireUser();
  if (!rejected.trim() || !preferred.trim()) {
    return { ok: false, error: "الزوج ناقص — يلزم النصّان معاً." };
  }
  if (rejected.trim() === preferred.trim()) {
    return { ok: false, error: "النصّان متطابقان — لا درس في زوج بلا فرق." };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("taste_pairs").insert({
    idea_text: ideaText.trim() || null,
    rejected_draft: rejected.trim(),
    preferred_draft: preferred.trim(),
    lesson: lesson?.trim() || null,
    channel: "newsletter",
  });
  if (error) {
    console.error("[newsletter taste]", error.message);
    return { ok: false, error: "تعذّر حفظ الزوج: " + error.message };
  }
  return { ok: true };
}

// المرحلة ٤: قائمة النشرات المحفوظة (لتحديث الواجهة بعد الحفظ).
export async function listNewsletters(): Promise<{ list: NewsletterRow[] }> {
  await requireUser();
  return { list: await fetchNewsletters() };
}

/** عدد ما يُعرض من كل مصدر — قرار المالك: ٤٠ لكل واحد (الأحدث أولاً). */
const SOURCE_LIMIT = 40;

/**
 * مصادر الأفكار (الملف 30): الالتقاط + منشورات ومسودات إكس، الأحدث أولاً.
 * best-effort لكل مصدر على حدة — فشل أحدهما لا يُفرغ الآخر.
 */
export async function listIdeaSources(): Promise<{
  captured: CapturedIdea[];
  posts: PostSeed[];
}> {
  await requireUser();
  const [captured, posts] = await Promise.all([
    // العدد قرار المالك (2026-08-12): ٤٠ لكل مصدر — كان ١٢ مثبّتاً هنا يتجاوز
    // الافتراضي في الجالب، فبقي العرض صغيراً رغم رفع السقف هناك.
    fetchCapturedIdeas(SOURCE_LIMIT).catch((e) => {
      console.error("[newsletter sources captured]", e);
      return [] as CapturedIdea[];
    }),
    fetchPostSeeds(SOURCE_LIMIT).catch((e) => {
      console.error("[newsletter sources posts]", e);
      return [] as PostSeed[];
    }),
  ]);
  return { captured, posts };
}

// المرحلة ١: توليد أفكار نشرات بمعايير المستخدم (مؤصَّلة بذاكرته + بحث اختياري).
export async function generateNewsletterIdeas(
  criteria: IdeaCriteria,
): Promise<IdeasOutcome> {
  try {
    await requireUser();
    return { ok: true, ideas: await generateIdeas(criteria) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر توليد الأفكار" };
  }
}

// تضمين النشرة (الملف 14 — البند ٣): العمود موجود منذ 0011 وكان فارغاً — تعبئته
// تجعل النشرات مرئية دلالياً (كتلة <recent_newsletters> في SP2 والاسترجاع لاحقاً).
// best-effort: فشل التضمين لا يمنع الحفظ.
async function newsletterEmbedding(text: string): Promise<number[] | null> {
  try {
    const emb = await embed(text.slice(0, 2000));
    return emb.ok ? emb.data : null;
  } catch {
    return null;
  }
}

// حفظ الفكرة المختارة كبداية نشرة (status='idea'). المراحل التالية تبني عليها.
export async function saveNewsletterIdea(
  idea: string,
  criteria: IdeaCriteria,
): Promise<SaveNewsletterOutcome> {
  try {
    await requireUser();
    const t = idea.trim();
    if (!t) throw new Error("الفكرة فارغة.");
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("newsletters")
      .insert({ status: "idea", idea: t, criteria, embedding: await newsletterEmbedding(t) })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error("تعذّر حفظ الفكرة: " + (error?.message ?? "غير معروف"));
    }
    return { ok: true, id: data.id as string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر حفظ الفكرة" };
  }
}

// المرحلة ٣ (اختيارية): توليد هيكل النشرة فقط — المسار المُتحكَّم قبل التوسيع.
export async function generateNewsletterOutlineAction(
  idea: string,
  options: DraftOptions,
  rawText = "",
): Promise<OutlineOutcome> {
  try {
    await requireUser();
    return { ok: true, outline: await generateNewsletterOutline(idea, options, rawText) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر توليد الهيكل" };
  }
}

// المرحلة ٢: توليد مسودة نشرة كاملة (من الفكرة مباشرةً، أو من هيكل مُحرَّر إن مُرِّر).
export async function generateNewsletterDraftAction(
  idea: string,
  options: DraftOptions,
  outline?: string,
  rawText = "",
): Promise<NewsletterDraftOutcome> {
  try {
    await requireUser();
    return { ok: true, result: await generateNewsletterDraft(idea, options, outline, rawText) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر توليد المسودة" };
  }
}

// حفظ المسودة (تحديث صفّ الفكرة إن وُجد، وإلا إنشاء صفّ جديد). status='draft'.
// يحفظ الهيكل أيضاً إن مُرِّر (المسار المُتحكَّم) ليبقى أثر الخطّة مع المسودة.
export async function saveNewsletterDraft(
  id: string | null,
  idea: string,
  criteria: IdeaCriteria,
  subject: string,
  draft: string,
  outline?: string,
  rawText = "",
): Promise<SaveNewsletterOutcome> {
  try {
    await requireUser();
    const d = draft.trim();
    if (!d) throw new Error("المسودة فارغة.");
    const supabase = await createClient();
    // التضمين من العنوان + الفكرة (يمثّلان الموضوع) لا المسودة الكاملة.
    // يُضاف **شرطياً**: فشل عابر لـembed لا يجوز أن يمسح تضميناً صالحاً محفوظاً
    // في مسار التحديث (إعادة حفظ بعد تعديل أثناء عطل Gemini).
    const emb = await newsletterEmbedding(`${subject.trim()}\n${idea.trim()}`);
    const base = {
      status: "draft" as const,
      idea: idea.trim(),
      criteria,
      subject: subject.trim() || null,
      draft: d,
      outline: outline?.trim() || null,
      // النصّ الخام يُحفظ مع النشرة (0032): يُستأنف معها، ويبقى أثر مادّة وقائعها
      raw_text: rawText.trim() || null,
      ...(emb ? { embedding: emb } : {}),
    };
    if (id) {
      const { error } = await supabase
        .from("newsletters")
        .update({ ...base, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (!error) return { ok: true, id };
      // فشل التحديث (مثلاً المعرّف غير موجود) → أنشئ جديداً.
    }
    const { data, error } = await supabase.from("newsletters").insert(base).select("id").single();
    if (error || !data) {
      throw new Error("تعذّر حفظ المسودة: " + (error?.message ?? "غير معروف"));
    }
    return { ok: true, id: data.id as string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر حفظ المسودة" };
  }
}

// ════════════════════════════════════════════════════════════
// النشر الكامل إلى لوبس (الملف 35): مسودة الشاشة → حملة في لوبس عبر العامل.
// لا إرسال فوري أبداً — مسودة في لوبس أو جدولة بتوقيت يحدده المالك صراحةً.
// ════════════════════════════════════════════════════════════
export async function queueLoopsPublishAction(
  req: import("@/lib/loops/publish").LoopsPublishRequest,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  await requireUser();
  const { queueLoopsPublishJob } = await import("@/lib/loops/publish");
  return queueLoopsPublishJob(req);
}

export async function pollLoopsPublishAction(
  jobId: string,
): Promise<import("@/lib/loops/publish").LoopsPublishView | null> {
  await requireUser();
  const { getLoopsPublishView } = await import("@/lib/loops/publish");
  return getLoopsPublishView(jobId);
}

/** خيارات الجمهور للواجهة — تُقرأ من LOOPS_AUDIENCES عبر lib/loops/publish (لا نداء لوبس من هنا). */
export async function listLoopsAudiences(): Promise<
  { key: string; label: string; type: string }[]
> {
  await requireUser();
  const { getLoopsAudiences } = await import("@/lib/loops/publish");
  return getLoopsAudiences().map((a) => ({ key: a.key, label: a.label, type: a.type }));
}

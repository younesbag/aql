"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  analyzeForPublishing,
  type PublishingAnalysis,
} from "@/lib/content/analyze";
import {
  generateDraft,
  critiqueAndImprove,
  type GeneratedDraft,
} from "@/lib/content/generate";
import { extractAttributes } from "@/lib/content/extract";
import { isPillarKey } from "@/lib/config/profile";
import { embed, searchWeb } from "@/lib/ai/gemini";
import {
  buildDirectives,
  DEFAULT_OVERRIDES,
  type GenOverrides,
} from "@/lib/content/overrides";
import {
  queueGenerationJob,
  queueVisualJob,
  queueTypefullyJob,
  queueRevisionJob,
  getJobView,
  cancelQueuedJob,
  type JobView,
} from "@/lib/content/jobs";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

// متجه pgvector يعود من Supabase كنصّ "[...]" — حوّله لمصفوفة أرقام (null عند الفشل/الغياب).
function parseEmbedding(v: unknown): number[] | null {
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

type GenerationResult = {
  analysis: PublishingAnalysis;
  draft: GeneratedDraft;
};

// نتائج الإجراءات للواجهة — تُعاد كقيمة (لا تُرمى). السبب: في الإنتاج يحذف Next.js
// رسائل الأخطاء المرميّة من إجراءات الخادم (redaction أمني) ويستبدلها بنصّ عامّ
// إنجليزي. الإعادة كقيمة تُبقي الرسالة العربية الدقيقة سليمة حتى تصل الواجهة.
export type GenerationOutcome =
  | { ok: true; result: GenerationResult }
  | { ok: false; error: string };

export type SaveOutcome = { ok: true } | { ok: false; error: string };

// النواة المشتركة: من نصّ خام (فكرة) → تحليل نشر → مسودة احترافية (+ نقد اختياري).
// تخدم فكرة محفوظة (مع متجهها) وفكرة حرّة (بلا متجه → أمثلة أداء عالمية، تراجع آمن).
async function generateFromRaw(
  rawText: string,
  meta: { topic: string | null; summary: string | null },
  ov: GenOverrides,
  queryEmbedding: number[] | null,
): Promise<GenerationResult> {
  // البحث الحيّ (الإضافة ٢) يجري بالتوازي مع التحليل — صفر تأخير إضافي تقريباً.
  const [analysis, searchResults] = await Promise.all([
    analyzeForPublishing({ raw_text: rawText, topic: meta.topic, summary: meta.summary }),
    ov.search ? runSearch(rawText) : Promise.resolve(null),
  ]);
  if (!analysis) throw new Error("تعذّر تحليل الفكرة للنشر.");

  // طبّق التوجيهات الإلزامية: وحّد content_type مع النوع المفروض، ثم مرّر التوجيهات للمحرّك.
  const directives = buildDirectives(ov);
  if (directives.forced_type === "thread") analysis.content_type = "thread";
  else if (
    directives.forced_type === "long_tweet" ||
    directives.forced_type === "medium_tweet"
  )
    analysis.content_type = "tweet";

  // الملف 19: النص الخام يمر للكاتب والناقد — مصدر الحقائق الأول.
  const gen = await generateDraft(analysis, directives, searchResults, queryEmbedding, rawText);
  if (!gen.ok) throw new Error(gen.error);

  // حلقة النقد والتحسين (الإضافة ٣): تحسين مستقل قبل العرض — قابل للإيقاف بمفتاح.
  const improved = ov.critique
    ? await critiqueAndImprove(gen.data, analysis, rawText)
    : gen.data;
  return { analysis, draft: improved };
}

// يحلّل فكرة محفوظة (مرحلة تحليل النشر → المدخل الغني) ثم يولّد مسودة احترافية (SP2).
// overrides (اختياري): تحكّم المستخدم بالنوع/الحجم/CTA — يتجاوز استنتاج التحليل (الإضافة ١).
export async function generateForItem(
  itemId: string,
  overrides?: GenOverrides,
): Promise<GenerationOutcome> {
  try {
    await requireUser();
    const supabase = await createClient();
    const { data: item, error } = await supabase
      .from("items")
      .select("raw_text, summary, topic, embedding")
      .eq("id", itemId)
      .single();
    if (error || !item) throw new Error("لم أجد الفكرة.");
    const result = await generateFromRaw(
      item.raw_text as string,
      { topic: item.topic as string | null, summary: item.summary as string | null },
      overrides ?? DEFAULT_OVERRIDES,
      parseEmbedding(item.embedding),
    );
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر التوليد" };
  }
}

// يولّد من فكرة حرّة يكتبها المالك مباشرةً — دون الحاجة لفكرة مسجّلة.
// لا متجه (null) → أمثلة الاحتذاء تتراجع لأفضل المنشورات أداءً عالمياً (السلوك الآمن).
export async function generateForText(
  text: string,
  overrides?: GenOverrides,
): Promise<GenerationOutcome> {
  try {
    await requireUser();
    const t = text.trim();
    if (!t) throw new Error("الفكرة فارغة.");
    const result = await generateFromRaw(
      t,
      { topic: null, summary: null },
      overrides ?? DEFAULT_OVERRIDES,
      null,
    );
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر التوليد" };
  }
}

// ── توليد الجلسة (الملف 16): الصفّ في الطابور بدل النداء المباشر ─────────
// المسار الافتراضي الجديد: Vercel يجهّز المدخل كاملاً ويصفّه، وعامل الـVPS
// ينفّذ بجلسة الاشتراك (Fable). الإجراءان القديمان أعلاه باقيان حرفياً —
// مسار الطوارئ المباشر (API، محدود بـ300 ثانية).

export type QueueGenerationOutcome =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

// تحكّم لكل طلب (هجرة 0021): تعقيم دفاعي — effort من قائمة مغلقة تطابق قيد CHECK،
// والنموذج معرّف تقني قصير (spawn بمصفوفة وسائط، لا صدفة — التعقيم للنظافة لا للحقن).
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
function sanitizeEngineOpts(engine?: {
  model?: string | null;
  effort?: string | null;
  critic?: string | null;
}) {
  const m = (engine?.model ?? "").trim().slice(0, 64);
  const model = /^[a-z0-9.-]+$/i.test(m) ? m : null;
  const effort = (EFFORT_LEVELS as readonly string[]).includes(engine?.effort ?? "")
    ? (engine!.effort as string)
    : null;
  // قائمة مغلقة تطابق قيد CHECK (هجرتا 0022 و0023)
  const critic =
    engine?.critic === "codex" || engine?.critic === "merge" ? engine.critic : null;
  return { model, effort, critic };
}

export async function queueGeneration(
  itemId: string | null,
  freeText: string | null,
  overrides?: GenOverrides,
  engine?: { model?: string | null; effort?: string | null; critic?: string | null },
): Promise<QueueGenerationOutcome> {
  try {
    await requireUser();
    const ov = overrides ?? DEFAULT_OVERRIDES;
    const { model, effort, critic } = sanitizeEngineOpts(engine);

    if (itemId) {
      const supabase = await createClient();
      const { data: item, error } = await supabase
        .from("items")
        .select("raw_text, summary, topic, embedding")
        .eq("id", itemId)
        .single();
      if (error || !item) throw new Error("لم أجد الفكرة.");
      return await queueGenerationJob({
        itemId,
        rawText: item.raw_text as string,
        topic: item.topic as string | null,
        summary: item.summary as string | null,
        overrides: ov,
        queryEmbedding: parseEmbedding(item.embedding),
        model,
        effort,
        critic,
      });
    }

    const t = (freeText ?? "").trim();
    if (!t) throw new Error("الفكرة فارغة.");
    return await queueGenerationJob({
      itemId: null,
      rawText: t,
      topic: null,
      summary: null,
      overrides: ov,
      queryEmbedding: null,
      model,
      effort,
      critic,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر صفّ الطلب" };
  }
}

// جولة مراجعة (الملف 24): «لم تعجبني، والسبب…» → نسخة تصلح المذكور وتحفظ الباقي
export async function queueRevision(
  previousJobId: string,
  note: string,
): Promise<QueueGenerationOutcome> {
  try {
    await requireUser();
    return await queueRevisionJob(previousJobId, note);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر صفّ جولة المراجعة" };
  }
}

// إنفوغرافيك (الملف 21): نص المسودة → صورة عبر الجلسة الوكيلية على الخادم
export async function queueVisual(
  draftText: string,
  postId: string | null,
): Promise<QueueGenerationOutcome> {
  try {
    await requireUser();
    return await queueVisualJob(draftText, postId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر صفّ الإنفوغرافيك" };
  }
}

// مسودة Typefully (الملف 22): النص الجاهز → مسودة للمراجعة هناك (العامل حامل المفتاح)
export async function queueTypefully(draftText: string): Promise<QueueGenerationOutcome> {
  try {
    await requireUser();
    return await queueTypefullyJob(draftText);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر صفّ مسودة Typefully" };
  }
}

export type TastePairOutcome = { ok: true } | { ok: false; error: string };

// زوج ذوق (الملف 19): توليدة النظام كما خرجت ↔ النسخة بعد تعديل المالك اليدوي.
// يُحقن في التوليدات القادمة كأعلى سلطة أسلوبية — ذاكرة ذوق حية تتراكم.
export async function saveTastePair(
  itemId: string | null,
  freeText: string | null,
  rejectedDraft: string,
  preferredDraft: string,
  lesson?: string | null, // درس التعديل — أثمن ما في الزوج (يعمّم الفرق بدل تركه للاستنتاج)
): Promise<TastePairOutcome> {
  try {
    await requireUser();
    const rejected = rejectedDraft.trim();
    const preferred = preferredDraft.trim();
    if (!rejected || !preferred) throw new Error("الزوج ناقص — لا نسخة أصلية أو معدّلة.");
    if (rejected === preferred)
      throw new Error("النسختان متطابقتان — عدّل المسودة أولاً ليتكوّن زوج ذوق.");
    const supabase = await createClient();
    let ideaText: string | null = (freeText ?? "").trim() || null;
    if (itemId) {
      const { data } = await supabase
        .from("items")
        .select("raw_text")
        .eq("id", itemId)
        .maybeSingle();
      ideaText = (((data?.raw_text as string) ?? "").trim() || ideaText) as string | null;
    }
    const { error } = await supabase.from("taste_pairs").insert({
      idea_text: ideaText,
      rejected_draft: rejected,
      preferred_draft: preferred,
      lesson: (lesson ?? "").trim() || null,
    });
    if (error) throw new Error("فشل حفظ زوج الذوق: " + error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر حفظ زوج الذوق" };
  }
}

export type JobPollOutcome =
  | { ok: true; job: JobView }
  | { ok: false; error: string };

export async function pollGenerationJob(jobId: string): Promise<JobPollOutcome> {
  try {
    await requireUser();
    const job = await getJobView(jobId);
    if (!job) throw new Error("لم أجد الطلب.");
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الاستطلاع" };
  }
}

export async function cancelGeneration(jobId: string): Promise<SaveOutcome> {
  try {
    await requireUser();
    const done = await cancelQueuedJob(jobId);
    if (!done) return { ok: false, error: "تعذّر الإلغاء — قد يكون العامل التقطه بالفعل." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الإلغاء" };
  }
}

// بحث حيّ موجز عن الفكرة — يُحقن في مدخل التوليد (الإضافة ٢). null عند الفشل أو لا نتائج.
async function runSearch(rawText: string): Promise<string | null> {
  const prompt =
    "ابحث في الويب وأعطني بإيجاز (حتى ~120 كلمة) أحدث المعلومات ذات الصلة بهذه الفكرة — " +
    'أدوات أو نماذج أو تقنيات أو أحداث جديدة فقط. إن لم تجد جديداً ذا صلة، قل "لا جديد ذا صلة".\n' +
    "الفكرة: " +
    rawText.slice(0, 500);
  const res = await searchWeb(prompt);
  return res.ok ? res.data : null;
}

type SaveDraftPayload = {
  text: string;
  content_type: string;
  hook_text: string;
  quality_score: number | null;
  // [0018] محور المحتوى من تحليل النشر — لتوزيع المحاور في المختبر (الملف 14).
  content_pillar: string | null;
};

function mapFormat(contentType: string): string {
  return contentType.toUpperCase() === "THREAD" ? "thread" : "single";
}

// مفاتيح الركائز من data/profile.json (قيد posts_content_pillar_chk في الهجرة 0002 يفرض الصيغة فقط) —
// ما عداها يُحفظ null (لا كسر إدراج).

// يحفظ المسودة (بعد التحرير) في posts مع quality_score و hook_text + embedding.
// itemId قد يكون null (فكرة حرّة لم تُسجَّل) — item_id يقبل null (ON DELETE SET NULL).
export async function saveDraft(
  itemId: string | null,
  payload: SaveDraftPayload,
): Promise<SaveOutcome> {
  try {
    await requireUser();
    const t = payload.text.trim();
    if (!t) throw new Error("المسودة فارغة.");

    const supabase = await createClient();
    const emb = await embed(t);
    const { error } = await supabase.from("posts").insert({
      item_id: itemId,
      format: mapFormat(payload.content_type),
      draft_text: t,
      hook_text: payload.hook_text || null,
      quality_score: payload.quality_score,
      content_pillar:
        isPillarKey(payload.content_pillar)
          ? payload.content_pillar
          : null,
      status: "draft",
      embedding: emb.ok ? emb.data : null,
    });
    if (error) throw new Error("فشل الحفظ: " + error.message);

    // دورة حياة الفكرة (الملف 14 — البند ١): الفكرة المصدر تصير «مسوَّدة» فيميّزها
    // المنتقي عن الجديد. من 'new' فقط — لا تنزيل لفكرة سبق نشر مسودتها. best-effort
    // مع رصد صريح (§٣-٦): فشل صامت هنا = دورة حياة لا تتحدّث أبداً بلا أثر.
    if (itemId) {
      const { error: itemErr } = await supabase
        .from("items")
        .update({ status: "drafted" })
        .eq("id", itemId)
        .eq("status", "new");
      if (itemErr) console.error(`[saveDraft] تعذّر تحديث حالة الفكرة: ${itemErr.message}`);
    }
    revalidatePath("/content");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر الحفظ" };
  }
}

// يحذف مسودة محفوظة نهائياً من جدول posts.
export async function deleteDraft(postId: string): Promise<void> {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase.from("posts").delete().eq("id", postId);
  if (error) throw new Error("فشل الحذف: " + error.message);
  revalidatePath("/content");
}

// يعلّم مسودة بأنها نُشرت (دون أرقام بعد) — تخرج من قائمة المسودات وتبقى
// متاحة لاحقاً في إدخال الأداء.
export async function markDraftPublished(postId: string): Promise<void> {
  await requireUser();
  const supabase = await createClient();
  const { data: post, error } = await supabase
    .from("posts")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", postId)
    .select("item_id")
    .maybeSingle();
  if (error) throw new Error("فشل التحديث: " + error.message);

  // دورة حياة الفكرة (الملف 14 — البند ١): الفكرة المصدر «نُشرت» — فيتمايز المنتقي
  // وتخرج الإشارة من دَين الإشارات في تقرير الأنماط. best-effort مع رصد (§٣-٦).
  const itemId = post?.item_id as string | null;
  if (itemId) {
    const { error: itemErr } = await supabase
      .from("items")
      .update({ status: "published" })
      .eq("id", itemId);
    if (itemErr) console.error(`[markDraftPublished] تعذّر تحديث حالة الفكرة: ${itemErr.message}`);
  }
  revalidatePath("/content");
}

type PostMetrics = {
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  bookmarks: number;
};

// يحفظ أرقام أداء منشور، يستخرج سماته للمختبر، ويعلّمه «منشوراً».
export async function savePerformance(
  postId: string,
  metrics: PostMetrics,
): Promise<void> {
  await requireUser();
  const supabase = await createClient();

  const { data: post, error: e1 } = await supabase
    .from("posts")
    .select("draft_text, final_text, published_at, item_id")
    .eq("id", postId)
    .single();
  if (e1 || !post) throw new Error("لم أجد المنشور.");

  const text = (post.final_text || post.draft_text) as string;
  const attrs = await extractAttributes(text);

  const update: Record<string, unknown> = {
    impressions: metrics.impressions,
    likes: metrics.likes,
    replies: metrics.replies,
    reposts: metrics.reposts,
    bookmarks: metrics.bookmarks,
    status: "published",
    // العلم مشترك مع مطالبة الطقس (0016): الإدخال من الويب يطفئه أيضاً، وإلا
    // ظلّت رسائل تيليجرام التالية تُختطف إجاباتٍ لسؤال أُجيب هنا.
    awaiting_metrics: false,
  };
  // لا تكتب السمات إلا عند نجاح الاستخراج (لئلا تُمحى سمات سابقة بـ null عند الفشل).
  if (attrs) {
    update.hook_type = attrs.hook_type;
    update.structure = attrs.structure;
    update.emotion = attrs.emotion;
  }
  // لا تدهس تاريخ النشر الأصلي (المستورد من الأرشيف) — اضبطه فقط إن كان فارغاً.
  if (!post.published_at) {
    update.published_at = new Date().toISOString();
  }

  const { error } = await supabase.from("posts").update(update).eq("id", postId);
  if (error) throw new Error("فشل حفظ الأداء: " + error.message);

  // دورة حياة الفكرة (الملف 14 — البند ١): هذا المسار ينشر المنشور ضمناً
  // (status='published') فيلزمه تعليم الفكرة كما يفعل markDraftPublished — وإلا
  // بقيت الفكرة على «سبق توليدها» أبداً حين يتخطّى المالك زرّ «نُشرت».
  const perfItemId = post.item_id as string | null;
  if (perfItemId) {
    const { error: itemErr } = await supabase
      .from("items")
      .update({ status: "published" })
      .eq("id", perfItemId);
    if (itemErr) console.error(`[savePerformance] تعذّر تحديث حالة الفكرة: ${itemErr.message}`);
  }

  revalidatePath("/content");
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractAttributes } from "@/lib/content/extract";

// ════════════════════════════════════════════════════════════
// مطالبة أرقام الأداء من الطقس المسائي (الملف 13 — البند ٣).
// المشكلة: إدخال الأداء يدوي بلا أي مطالبة، فحلقة التعلّم كلها (أمثلة الاحتذاء،
// المعايرة، مختبر الأنماط) تجوع. الحلّ: منشور نُشر قبل ١–٣ أيام بلا مقاييس →
// سؤال واحد في الطقس، والإجابة خمسة أرقام بصيغة صارمة — صفر ذكاء في التفكيك.
// ════════════════════════════════════════════════════════════

// نافذة المطالبة: بعد يوم من النشر (الأرقام نضجت) وحتى ٣ أيام (لا نقّ لا نهائي).
const ASK_MIN_DAYS = 1;
const ASK_MAX_DAYS = 3;

export type PostNeedingMetrics = { id: string; excerpt: string };

const excerpt = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).trim() + "…";
};

/** منشور واحد في نافذة المطالبة بلا أي مقياس — مرشّح سؤال الليلة. */
export async function getPostNeedingMetrics(): Promise<PostNeedingMetrics | null> {
  const supabase = createAdminClient();
  const now = Date.now();
  const from = new Date(now - ASK_MAX_DAYS * 86_400_000).toISOString();
  const to = new Date(now - ASK_MIN_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("posts")
    .select("id, hook_text, draft_text")
    .eq("status", "published")
    .gte("published_at", from)
    .lte("published_at", to)
    .is("likes", null)
    .is("impressions", null)
    .order("published_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const text = (data.hook_text as string | null) || (data.draft_text as string);
  return { id: data.id as string, excerpt: excerpt(text) };
}

/** يضع المنشور في انتظار أرقامه (الرسالة التالية تُفكَّك خمسة أرقام).
 *  ثابت النظام: منتظِر واحد كحدّ أقصى — الإضاءة تطفئ كل علم سابق أولاً، وإلا
 *  عاد الجلب صفاً اعتباطياً فكُتبت أرقام منشورٍ على منشورٍ آخر (إصلاح مراجعة). */
export async function setPostAwaitingMetrics(id: string, awaiting = true): Promise<void> {
  const supabase = createAdminClient();
  if (awaiting) {
    await supabase
      .from("posts")
      .update({ awaiting_metrics: false })
      .eq("awaiting_metrics", true);
  }
  await supabase.from("posts").update({ awaiting_metrics: awaiting }).eq("id", id);
}

// صلاحية الانتظار: السؤال يُطرح ليلاً والإجابة تُتوقّع فوراً. علم معلّق بعد خروج
// المنشور من نافذة السؤال بيومين يبتلع رسائل لاحقة — فينتهي كسولاً.
const METRICS_AWAIT_MAX_DAYS = ASK_MAX_DAYS + 2;

/** المنشور المنتظِر أرقامه (إن وُجد) — للإجابات المعلّقة في تيليجرام. */
export async function getPostAwaitingMetrics(): Promise<PostNeedingMetrics | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("posts")
    .select("id, hook_text, draft_text, published_at")
    .eq("awaiting_metrics", true)
    .order("published_at", { ascending: false, nullsFirst: false }) // حتمي — دفاع فوق ثابت «منتظِر واحد»
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const publishedAt = data.published_at
    ? new Date(data.published_at as string).getTime()
    : 0;
  if (Date.now() - publishedAt > METRICS_AWAIT_MAX_DAYS * 86_400_000) {
    await setPostAwaitingMetrics(data.id as string, false); // انتهت الصلاحية — أغلق بصمت
    return null;
  }
  const text = (data.hook_text as string | null) || (data.draft_text as string);
  return { id: data.id as string, excerpt: excerpt(text) };
}

// تطبيع الأرقام العربية-الهندية (٠-٩) إلى لاتينية — المالك قد يكتب بأيّهما.
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/** يفكّك خمسة أرقام بالترتيب الثابت (مشاهدات إعجابات ردود إعادات حفظ) أو null.
 *  صارم عمداً: الرسالة أرقام وفواصل **فقط** — فكرة عادية تصادف احتواءها خمسة
 *  أرقام كانت تُسجَّل مقاييس زوراً (إصلاح مراجعة). */
export function parseMetricsText(text: string): {
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  bookmarks: number;
} | null {
  const normalized = normalizeDigits(text.trim());
  if (!/^[\d\s.,·]+$/.test(normalized)) return null;
  const nums = (normalized.match(/\d+/g) ?? []).map(Number);
  if (nums.length !== 5) return null;
  const [impressions, likes, replies, reposts, bookmarks] = nums;
  return { impressions, likes, replies, reposts, bookmarks };
}

/**
 * يحفظ الأرقام ويستخرج السمات (flash — نفس مسار الويب savePerformance تماماً)
 * ويُطفئ الانتظار. يُرجع مجموع التفاعل للردّ.
 */
export async function savePostMetrics(
  id: string,
  m: NonNullable<ReturnType<typeof parseMetricsText>>,
): Promise<number> {
  const supabase = createAdminClient();
  const { data: post } = await supabase
    .from("posts")
    .select("draft_text, final_text")
    .eq("id", id)
    .maybeSingle();

  const updates: Record<string, unknown> = { ...m, awaiting_metrics: false };
  // السمات لمختبر الأنماط — لا تُكتب إلا عند نجاح الاستخراج (كما في مسار الويب).
  const text = (post?.final_text as string | null) || (post?.draft_text as string | null);
  if (text) {
    const attrs = await extractAttributes(text);
    if (attrs) {
      updates.hook_type = attrs.hook_type;
      updates.structure = attrs.structure;
      updates.emotion = attrs.emotion;
    }
  }
  await supabase.from("posts").update(updates).eq("id", id);
  return m.likes + m.replies + m.reposts + m.bookmarks;
}

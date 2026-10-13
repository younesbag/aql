import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { NewsletterRow } from "@/lib/newsletter/criteria";

// جلب النشرات المحفوظة (الأحدث أولاً) — للقائمة والاستئناف (المرحلة ٤).
// عميل الجلسة يحترم RLS «المالك فقط»، فلا يرى المالك إلا نشراته.
export async function fetchNewsletters(): Promise<NewsletterRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("newsletters")
    .select("id, status, subject, idea, outline, draft, criteria, raw_text, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  return (data ?? []) as NewsletterRow[];
}

// ════════════════════════════════════════════════════════════
// مصادر الأفكار (الملف 30): النشرة لم تكن ترى ما التقطه المالك ولا ما نجح على إكس،
// فكان عليه إعادة كتابة فكرته يدوياً في كل مرة. هنا تُعرض جاهزةً للاختيار:
//   • الالتقاط: summary فكرةً و raw_text مادّةَ وقائعها (فيدخلان معاً)
//   • منشورات إكس: ما رنّ فعلاً مرشَّح للتعميق — والنشرة تعمّق لا تكرّر
// ════════════════════════════════════════════════════════════

export type CapturedIdea = {
  id: string;
  idea: string;      // summary أو أول سطر من الخام
  rawText: string;   // النصّ الكامل — يملأ «نصّك الخام» تلقائياً
  kind: string;
  date: string;
};

export type PostSeed = {
  id: string;
  idea: string;      // صدر المنشور
  rawText: string;   // المنشور كاملاً
  engagement: number;
  impressions: number;
  date: string;
  status: string;    // 'draft' | 'published' — المسودات المحفوظة بذرة كالمنشور
};

// سقف أمان لا سقف عرض: المالك يريد الكل، والرقم يمنع جلباً غير محدود لو تضخّم الأرشيف.
const MAX_SOURCES = 500;

const KIND_AR: Record<string, string> = {
  insight: "بصيرة",
  story: "قصة",
  comparison: "مقارنة",
  question: "سؤال",
  observation: "ملاحظة",
};

/** أفكار من محرّك الالتقاط — الأحدث أولاً، وكلّها (الفلترة في الواجهة بالبحث). */
export async function fetchCapturedIdeas(limit = MAX_SOURCES): Promise<CapturedIdea[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("items")
    .select("id, raw_text, summary, item_kind, source_type, created_at")
    .eq("origin", "manual")
    .in("status", ["new", "drafted"])
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const raw = String(r.raw_text ?? "");
    const summary = typeof r.summary === "string" ? r.summary.trim() : "";
    return {
      id: String(r.id),
      // الملخّص إن صُنّف، وإلا فصدر النصّ الخام (الاستيراد التاريخي يدخل بلا تصنيف)
      idea: summary || raw.replace(/\s+/g, " ").slice(0, 120),
      rawText: raw,
      kind: KIND_AR[String(r.item_kind ?? "")] ?? String(r.source_type ?? ""),
      date: String(r.created_at ?? "").slice(0, 10),
    };
  });
}

/**
 * منشورات إكس بذرةً للتعميق — **المسودات المحفوظة والمنشورة معاً**، الأحدث أولاً.
 * المسودة المحفوظة فكرةٌ اكتملت صياغتها ولم تُنشر، وهي بذرة نشرة كالمنشور تماماً.
 * الترتيب زمنيّ لا بالأداء: المالك يبحث عمّا كتبه مؤخراً لا عمّا رنّ قديماً
 * (والأداء معروض في السطر ليحكم به عند الحاجة).
 */
export async function fetchPostSeeds(limit = MAX_SOURCES): Promise<PostSeed[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("posts")
    .select(
      "id, draft_text, final_text, status, likes, replies, reposts, bookmarks, impressions, published_at, created_at",
    )
    .in("status", ["draft", "published"])
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const text = String(r.final_text || r.draft_text || "");
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      id: String(r.id),
      idea: text.replace(/\s+/g, " ").slice(0, 120),
      rawText: text,
      engagement: n(r.likes) + n(r.replies) + n(r.reposts) + n(r.bookmarks),
      impressions: n(r.impressions),
      // تاريخ النشر إن نُشر، وإلا فتاريخ الإنشاء (المسودة لا published_at لها)
      date: String(r.published_at || r.created_at || "").slice(0, 10),
      status: String(r.status ?? ""),
    };
  });
}

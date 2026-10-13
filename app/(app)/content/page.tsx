import { createClient } from "@/lib/supabase/server";
import { Generator } from "./Generator";
import { PerformanceForm } from "./PerformanceForm";
import { SavedDrafts, type DraftPost } from "./SavedDrafts";
import { PatternLab } from "./PatternLab";

// خطة Vercel الحالية (Hobby) تحدّ maxDuration بـ300 ثانية كحدّ أقصى — هذا هو السقف الفعلي، لا رفع حقيقياً هنا.
// لا يحلّ هذا مهلة xhigh + حلقة النقد (قد تتجاوز 300 ثانية فعلياً) — يتطلّب ترقية الخطة أو تعديل معماري.
export const maxDuration = 300;

type Idea = {
  id: string;
  raw_text: string;
  summary: string | null;
  topic: string | null;
  status: string;
};

const FORMAT_AR: Record<string, string> = {
  thread: "ثريد",
  single: "تغريدة",
  email: "بريد",
};

export default async function ContentPage() {
  const supabase = await createClient();

  const { data: ideasData } = await supabase
    .from("items")
    .select("id, raw_text, summary, topic, status")
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(30);
  // دورة حياة الفكرة (الملف 14 — البند ١): غير المستهلَك يتصدّر المنتقي،
  // والمسوَّد/المنشور يتأخر بوسمه (يبقى قابلاً لإعادة التوليد).
  const rank = (s: string) => (s === "new" ? 0 : s === "drafted" ? 1 : 2);
  const ideas = ((ideasData ?? []) as Idea[]).sort(
    (a, b) => rank(a.status) - rank(b.status),
  );

  // المسودات المحفوظة (status = draft) لعرضها في الواجهة
  const { data: draftData } = await supabase
    .from("posts")
    .select("id, format, draft_text, hook_text, quality_score, created_at")
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(30);
  const drafts = (draftData ?? []) as DraftPost[];

  // كل المنشورات (لقائمة إدخال الأداء)
  const { data: allPosts } = await supabase
    .from("posts")
    .select("id, format, draft_text")
    .order("created_at", { ascending: false })
    .limit(50);
  const postOptions = (allPosts ?? []).map((p) => ({
    id: p.id as string,
    label: `[${FORMAT_AR[p.format as string] ?? p.format}] ${String(p.draft_text).slice(0, 45)}`,
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">المحتوى</h1>
      <p className="mt-1 text-sm text-foreground/60">
        حوّل فكرة إلى ٣ مسودات بصوتك، ثم حرّر واحفظ.
      </p>

      {/* مواجهة فلتر الكمالية */}
      <div className="mt-4 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3 text-sm text-foreground/70">
        لا تنتظر الكمال — انشر بمستوى 7/10 ودع السوق يحكم. (مبرّر النشر المبني على
        أرقام أدائك يظهر هنا حين تتراكم بيانات كافية.)
      </div>

      {/* المولّد */}
      <div className="mt-6">
        <Generator ideas={ideas} />
      </div>

      {/* المسودات المحفوظة */}
      <div className="mt-10 border-t border-foreground/10 pt-6">
        <h2 className="text-lg font-bold">المسودات المحفوظة</h2>
        <p className="mb-3 mt-1 text-sm text-foreground/60">
          كل مسودة حفظتها — اضغط على البطاقة لعرض النص كاملاً، ثم انسخها أو
          علّمها «نُشرت» أو احذفها.
        </p>
        <SavedDrafts drafts={drafts} />
      </div>

      {/* إدخال الأداء */}
      <div className="mt-10 border-t border-foreground/10 pt-6">
        <h2 className="text-lg font-bold">إدخال الأداء</h2>
        <p className="mb-3 mt-1 text-sm text-foreground/60">
          بعد نشر مسودة على إكس، أدخل أرقامها — يتعلّم منها مختبر الأنماط.
        </p>
        <PerformanceForm posts={postOptions} />
      </div>

      {/* مختبر الأنماط */}
      <div className="mt-10 border-t border-foreground/10 pt-6">
        <PatternLab />
      </div>
    </div>
  );
}

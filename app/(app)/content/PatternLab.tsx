import { createClient } from "@/lib/supabase/server";
import { getCalibration, CALIBRATION_MIN_POSTS } from "@/lib/content/calibration";
import { getPatternAggregates } from "@/lib/content/patterns";

// تعريب المحاور (القاعدة ٥) — مطابقة لقيم analyze.ts.
const PILLAR_AR: Record<string, string> = {
  prompt_engineering: "هندسة الأوامر",
  ai_strategy: "استراتيجية الذكاء الاصطناعي",
  ai_tools: "أدوات الذكاء الاصطناعي",
  ai_learning: "التعلّم بالذكاء الاصطناعي",
};

type LabPost = {
  id: string;
  draft_text: string;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
  hook_type: string | null;
  structure: string | null;
  emotion: string | null;
};

// مختبر الأنماط — مكوّن مشترك يُعاد استخدامه في /content و /insights (لا تكرار منطق).
// يجلب بياناته بنفسه: المنشورات المنشورة (status='published') — يشمل المستورد من الأرشيف.
// السمات (الخطاف/البنية/العاطفة) تُستخرج كسولاً لاحقاً، فتظهر «—» حتى ذلك الحين.
export async function PatternLab() {
  const supabase = await createClient();
  const [{ data }, calibration, aggregates] = await Promise.all([
    supabase
      .from("posts")
      .select(
        "id, draft_text, likes, replies, reposts, bookmarks, hook_type, structure, emotion",
      )
      .eq("status", "published")
      .order("likes", { ascending: false })
      .limit(100),
    // معايرة توقّع المحرّك (الملف 13 — البند ٣): null قبل بوابة النضج.
    getCalibration().catch(() => null),
    // تجميع الأنماط (الملف 14 — البند ٤): null قبل بوابة النضج (مجموعات ≥ ٣).
    getPatternAggregates().catch(() => null),
  ]);
  const posts = (data ?? []) as LabPost[];
  const top = posts
    .map((p) => ({
      ...p,
      eng: (p.likes ?? 0) + (p.reposts ?? 0) + (p.replies ?? 0) + (p.bookmarks ?? 0),
    }))
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 20);

  return (
    <div>
      <h2 className="text-lg font-bold">مختبر الأنماط</h2>
      {calibration ? (
        <div className="mt-3 rounded-lg border border-foreground/10 p-3">
          <h3 className="text-sm font-bold">دقة توقّع المحرّك</h3>
          <p className="mt-1 text-xs text-foreground/55">
            التقييم الذاتي للمسودات مقابل تفاعلها الفعلي بعد النشر ({calibration.total}{" "}
            منشوراً مقيساً) — هذا ما يُحقن في المحرّك ليقيّم على الواقع.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {calibration.buckets.map((b) => (
              <li key={b.label} className="flex items-baseline justify-between gap-2">
                <span>{b.label}</span>
                <span className="text-foreground/70">
                  متوسط تفاعل {b.avgEngagement} ({b.count} منشوراً)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-xs text-foreground/45">
          دقة توقّع المحرّك تظهر عند {CALIBRATION_MIN_POSTS} منشورات تحمل تقييماً
          ذاتياً وأرقام أداء معاً — أدخل الأرقام بعد كل نشر (أو من مطالبة الطقس المسائي).
        </p>
      )}
      {aggregates &&
        (aggregates.hooks.length > 0 ||
          aggregates.structures.length > 0 ||
          aggregates.pillars.length > 0) && (
        <div className="mt-3 rounded-lg border border-foreground/10 p-3">
          <h3 className="text-sm font-bold">الأنماط المجمّعة</h3>
          {aggregates.hooks.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-foreground/55">الخطافات بمتوسط التفاعل:</p>
              <ul className="mt-1 space-y-1 text-sm">
                {aggregates.hooks.map((h) => (
                  <li key={h.value} className="flex items-baseline justify-between gap-2">
                    <span>{h.value}</span>
                    <span className="text-foreground/70">
                      متوسط {h.avgEngagement} ({h.count} منشوراً)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {aggregates.structures.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-foreground/55">البنى بمتوسط التفاعل:</p>
              <ul className="mt-1 space-y-1 text-sm">
                {aggregates.structures.map((s) => (
                  <li key={s.value} className="flex items-baseline justify-between gap-2">
                    <span>{s.value}</span>
                    <span className="text-foreground/70">
                      متوسط {s.avgEngagement} ({s.count} منشوراً)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {aggregates.pillars.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-foreground/55">
                توزيع المحاور (الاستراتيجية: هندسة الأوامر والأنظمة ~75٪):
              </p>
              <ul className="mt-1 space-y-1 text-sm">
                {aggregates.pillars.map((p) => (
                  <li key={p.pillar} className="flex items-baseline justify-between gap-2">
                    <span>{PILLAR_AR[p.pillar] ?? p.pillar}</span>
                    <span className="text-foreground/70">
                      {p.share}٪ ({p.count})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11px] text-foreground/45">
            أعلى نمطين يُحقنان تلقائياً في محرّك التوليد.
          </p>
        </div>
      )}
      {posts.length < 10 ? (
        <p className="mt-2 text-sm text-foreground/55">
          البيانات تتراكم — التحليل يصبح أدق مع كل منشور بأداء (لديك {posts.length}{" "}
          حتى الآن؛ يُفعّل جدول الأنماط عند 10).
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="text-xs text-foreground/50">
              <tr>
                <th className="p-2 font-medium">المنشور</th>
                <th className="p-2 font-medium">تفاعل</th>
                <th className="p-2 font-medium">الخطاف</th>
                <th className="p-2 font-medium">البنية</th>
                <th className="p-2 font-medium">العاطفة</th>
              </tr>
            </thead>
            <tbody>
              {top.map((p) => (
                <tr key={p.id} className="border-t border-foreground/10">
                  <td className="max-w-[14rem] p-2">
                    <span className="line-clamp-1">{p.draft_text}</span>
                  </td>
                  <td className="p-2">{p.eng}</td>
                  <td className="p-2">{p.hook_type ?? "—"}</td>
                  <td className="p-2">{p.structure ?? "—"}</td>
                  <td className="p-2">{p.emotion ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

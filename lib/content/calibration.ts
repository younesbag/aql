import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ════════════════════════════════════════════════════════════
// معايرة توقّع المحرّك (الملف 13 — البند ٣): مصالحة quality_score الذاتي
// مع التفاعل الفعلي. أول حلقة تعلّم حقيقية: المحرّك كان يقيّم نفسه في فراغ.
// بوابة نضج: لا شيء يُعرض أو يُحقن قبل ١٠ منشورات تحمل التقييم والأرقام معاً.
// ════════════════════════════════════════════════════════════

export const CALIBRATION_MIN_POSTS = 10;

export type CalibrationBucket = { label: string; count: number; avgEngagement: number };
export type Calibration = { total: number; buckets: CalibrationBucket[] };

type Row = {
  quality_score: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
};

/**
 * يحسب المعايرة من المنشورات المنشورة الحاملة تقييماً ذاتياً وأرقاماً فعلية معاً.
 * يُرجع null دون العتبة — فلا عرض ولا حقن (بوابة نضج، لا وعود مبكرة).
 */
export async function getCalibration(useAdmin = false): Promise<Calibration | null> {
  const supabase = useAdmin ? createAdminClient() : await createClient();
  const { data } = await supabase
    .from("posts")
    .select("quality_score, likes, replies, reposts, bookmarks")
    .eq("status", "published")
    .not("quality_score", "is", null);

  const rows = ((data ?? []) as Row[]).filter(
    (r) =>
      r.likes !== null || r.replies !== null || r.reposts !== null || r.bookmarks !== null,
  );
  if (rows.length < CALIBRATION_MIN_POSTS) return null;

  const eng = (r: Row) =>
    (r.likes ?? 0) + (r.replies ?? 0) + (r.reposts ?? 0) + (r.bookmarks ?? 0);

  const defs: { label: string; test: (q: number) => boolean }[] = [
    { label: "تقييم ذاتي 9+", test: (q) => q >= 9 },
    { label: "تقييم ذاتي 8–9", test: (q) => q >= 8 && q < 9 },
    { label: "تقييم ذاتي أقل من 8", test: (q) => q < 8 },
  ];

  const buckets: CalibrationBucket[] = [];
  for (const d of defs) {
    const group = rows.filter((r) => d.test(r.quality_score as number));
    if (group.length === 0) continue;
    const avg = group.reduce((s, r) => s + eng(r), 0) / group.length;
    buckets.push({ label: d.label, count: group.length, avgEngagement: Math.round(avg) });
  }
  return { total: rows.length, buckets };
}

/** سطر المعايرة الذي يُحقن في مدخل SP2 — واقع مقيس لا تقدير ذاتي. */
export function calibrationLine(c: Calibration): string {
  const parts = c.buckets.map(
    (b) => `${b.label}: متوسط تفاعل فعلي ${b.avgEngagement} (${b.count} منشوراً)`,
  );
  return `معايرة واقعية من ${c.total} منشوراً منشوراً بأرقامه: ${parts.join(" · ")}. اجعل تقييمك الذاتي متسقاً مع هذا الواقع لا متفائلاً عنه.`;
}

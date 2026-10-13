import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ════════════════════════════════════════════════════════════
// تجميع أنماط المحتوى (الملف 14 — البند ٤): السمات المستخرجة (hook_type/
// structure/emotion منذ الملف 03) كانت تُعرض جدولاً خاماً ولا تعود للتوليد أبداً.
// هنا تُجمَّع: «هوك المفارقة: متوسط تفاعل 210 عبر 12 منشوراً» — تُعرض في المختبر
// وأعلى نمطين يُحقنان سطراً في مدخل SP2. صفر ذكاء — تجميع محض.
// بوابة نضج: مجموعة لا تُحتسب دون MIN_GROUP منشورات.
// ════════════════════════════════════════════════════════════

const MIN_GROUP = 3;

export type PatternGroup = { value: string; count: number; avgEngagement: number };
export type PillarShare = { pillar: string; count: number; share: number };
export type PatternAggregates = {
  hooks: PatternGroup[];
  structures: PatternGroup[];
  pillars: PillarShare[]; // يتراكم مع 0018 — فارغ حتى تُحفظ مسودات بمحاورها
};

type Row = {
  hook_type: string | null;
  structure: string | null;
  content_pillar: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
};

const eng = (r: Row) =>
  (r.likes ?? 0) + (r.replies ?? 0) + (r.reposts ?? 0) + (r.bookmarks ?? 0);

function groupBy(rows: Row[], key: "hook_type" | "structure"): PatternGroup[] {
  const map = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const v = (r[key] ?? "").trim();
    if (!v) continue;
    const g = map.get(v) ?? { count: 0, total: 0 };
    g.count++;
    g.total += eng(r);
    map.set(v, g);
  }
  return [...map.entries()]
    .filter(([, g]) => g.count >= MIN_GROUP)
    .map(([value, g]) => ({
      value,
      count: g.count,
      avgEngagement: Math.round(g.total / g.count),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 5);
}

/** يجمّع أنماط المنشورات المنشورة ذات السمات. null = لا مجموعة بلغت البوابة. */
export async function getPatternAggregates(
  useAdmin = false,
): Promise<PatternAggregates | null> {
  const supabase = useAdmin ? createAdminClient() : await createClient();
  const { data } = await supabase
    .from("posts")
    .select("hook_type, structure, content_pillar, likes, replies, reposts, bookmarks")
    .eq("status", "published")
    .not("hook_type", "is", null);

  const rows = (data ?? []) as Row[];
  const hooks = groupBy(rows, "hook_type");
  const structures = groupBy(rows, "structure");

  // توزيع المحاور (0018): من كل المنشورات الحاملة محوراً — لا يشترط سمات.
  const { data: pillarData } = await supabase
    .from("posts")
    .select("content_pillar")
    .eq("status", "published")
    .not("content_pillar", "is", null);
  const counts = new Map<string, number>();
  for (const p of (pillarData ?? []) as { content_pillar: string }[]) {
    counts.set(p.content_pillar, (counts.get(p.content_pillar) ?? 0) + 1);
  }
  const totalPillars = [...counts.values()].reduce((a, b) => a + b, 0);
  const pillars: PillarShare[] = [...counts.entries()]
    .map(([pillar, count]) => ({
      pillar,
      count,
      share: Math.round((100 * count) / (totalPillars || 1)),
    }))
    .sort((a, b) => b.count - a.count);

  if (hooks.length === 0 && structures.length === 0 && pillars.length === 0) return null;
  return { hooks, structures, pillars };
}

/** سطر «الأنماط المثبتة» الذي يُحقن في مدخل SP2 — أعلى نمطين، واقع مقيس. */
export function provenPatternsLine(a: PatternAggregates): string | null {
  const top = a.hooks.slice(0, 2);
  if (top.length === 0) return null;
  const parts = top.map(
    (h) => `هوك «${h.value}»: متوسط تفاعل ${h.avgEngagement} عبر ${h.count} منشوراً`,
  );
  return `أنماط مثبتة من أرشيفك المقيس: ${parts.join(" · ")}. استحضرها حين تناسب الفكرة — لا تفرضها قسراً.`;
}

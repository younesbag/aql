import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ════════════════════════════════════════════════════════════
// حالة «العقل» الراهنة — وعيٌ بما يعرفه الآن (لا بتصميمه فقط).
// يعدّ بياناته ويشتقّ الحدود الصادقة (مثل: التناقض ضعيف حتى ٣٠ قراراً).
// server-only (يحترم RLS — يعدّ بيانات المالك وحده).
// ════════════════════════════════════════════════════════════

export type StatusCounts = {
  items: number;
  itemsByType: Record<string, number>;
  postsPublished: number;
  postsDraft: number;
  decisions: number;
  journal: number;
  conversations: number;
};

export type SystemStatus = { summary: string; counts: StatusCounts };

const TYPE_AR: Record<string, string> = {
  tweet: "تغريدة",
  email: "بريد",
  idea: "فكرة",
  voice: "صوتي",
  signal: "إشارة",
  message: "رسالة",
  note: "ملاحظة",
  document: "مستند",
  article: "مقال",
};
const TYPES = Object.keys(TYPE_AR);
const DECISIONS_THRESHOLD = 30;

// useAdmin: للسياقات بلا جلسة (العقل من تيليجرام) — عميل الجلسة هناك بلا كوكيز
// فتحجب RLS كل الصفوف ويعدّ أصفاراً كاذبة.
export async function getSystemStatus(useAdmin = false): Promise<SystemStatus> {
  const supabase = useAdmin ? createAdminClient() : await createClient();
  const headCount = async (
    table: string,
    filters: Record<string, string> = {},
  ): Promise<number> => {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { count } = await q;
    return count ?? 0;
  };

  // عدّ دقيق بالـcount (لا جلب صفوف — يتفادى حدّ الصفوف الافتراضي).
  const [items, postsPublished, postsDraft, decisions, journal, conversations, ...typeCounts] =
    await Promise.all([
      headCount("items"),
      headCount("posts", { status: "published" }),
      headCount("posts", { status: "draft" }),
      headCount("decisions"),
      headCount("journal_entries"),
      headCount("conversations"),
      ...TYPES.map((t) => headCount("items", { source_type: t })),
    ]);

  const itemsByType: Record<string, number> = {};
  TYPES.forEach((t, i) => {
    if (typeCounts[i] > 0) itemsByType[t] = typeCounts[i];
  });

  const counts: StatusCounts = {
    items,
    itemsByType,
    postsPublished,
    postsDraft,
    decisions,
    journal,
    conversations,
  };

  const typeStr =
    Object.entries(itemsByType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} ${TYPE_AR[t] ?? t}`)
      .join(" · ") || "—";

  // الحدود الصادقة المُشتقّة من الحالة.
  const notes: string[] = [];
  if (decisions < DECISIONS_THRESHOLD)
    notes.push(
      `القرارات ${decisions}/${DECISIONS_THRESHOLD} — كشف التناقض وتحليل القرارات محدود حتى تتراكم ${DECISIONS_THRESHOLD} قراراً موثّقاً.`,
    );
  if ((itemsByType.note ?? 0) + (itemsByType.document ?? 0) === 0)
    notes.push("الملاحظات ومستندات المشاريع لم تُستورَد بعد.");

  const summary = [
    `الذاكرة: ${items} عنصراً (${typeStr}).`,
    `المنشورات: ${postsPublished} منشوراً (مرجع الأداء) + ${postsDraft} مسودة.`,
    `القرارات: ${decisions} · المذكرة: ${journal} · المحادثات المحفوظة: ${conversations}.`,
    notes.length ? "حدود الحالة: " + notes.join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { summary, counts };
}

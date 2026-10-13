import { createClient } from "@/lib/supabase/server";
import { CaptureBox } from "./CaptureBox";

type RecentItem = {
  id: string;
  raw_text: string;
  summary: string | null;
  topic: string | null;
  source_type: string;
  source_url: string | null;
  item_kind: string | null;
  created_at: string;
};

export default async function CapturePage() {
  const supabase = await createClient();
  // تعرض صفحة الالتقاط ما التقطه المالك فقط (origin='manual') — لا المعرفة المستوردة
  // (تغريدات/إيميلات/مستندات origin='import') كي لا تطمرها وتخفي الأفكار الخام.
  // المعرفة المستوردة تبقى في الذاكرة للاسترجاع عبر العقل، لا في قائمة الالتقاط.
  const { data } = await supabase
    .from("items")
    .select(
      "id, raw_text, summary, topic, source_type, source_url, item_kind, created_at",
    )
    .eq("origin", "manual")
    .order("created_at", { ascending: false })
    .limit(50);
  const items = (data ?? []) as RecentItem[];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">الالتقاط</h1>
      <p className="mt-1 text-sm text-foreground/60">
        اكتب فكرة أو احفظ إشارة — تُصنّف وتُفهرَس تلقائياً.
      </p>

      <div className="mt-6">
        <CaptureBox />
      </div>

      <div className="mt-10">
        <h2 className="text-sm font-semibold text-foreground/70">آخر ما التقطت</h2>
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-lg border border-foreground/10"
            >
              <details className="group">
                <summary className="cursor-pointer p-3 marker:text-foreground/40">
                  <span className="line-clamp-2 text-sm">
                    {it.summary || it.raw_text}
                  </span>
                  <span className="mt-1 block text-xs text-foreground/50">
                    {[it.topic, it.source_type, it.item_kind]
                      .filter(Boolean)
                      .join(" · ")}
                    <span className="text-foreground/35 group-open:hidden">
                      {"  · اضغط للنص الكامل"}
                    </span>
                  </span>
                </summary>
                <div className="border-t border-foreground/10 p-3">
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {it.raw_text}
                  </p>
                  {it.source_url && (
                    <a
                      href={it.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="ltr"
                      className="mt-2 block truncate text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {it.source_url}
                    </a>
                  )}
                </div>
              </details>
            </li>
          ))}
          {items.length === 0 && (
            <li className="text-sm text-foreground/50">
              لا عناصر بعد — التقط أول فكرة.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

import { retrieveRelevant, type RetrievedItem } from "@/lib/memory/retrieve";
import { Oracle } from "./Oracle";
import { sourceAr } from "@/lib/memory/sourceLabels";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let results: RetrievedItem[] = [];
  let searchError = "";
  if (query) {
    const r = await retrieveRelevant(query, 15);
    if (r.ok) results = r.data;
    else searchError = r.error;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">الذاكرة</h1>
      <p className="mt-1 text-sm text-foreground/60">
        ابحث دلالياً في كل ما التقطته، أو استجوب ذاكرتك بالأسفل.
      </p>

      {/* البحث الدلالي */}
      <form method="get" className="mt-6 flex gap-2">
        <input
          name="q"
          defaultValue={query}
          placeholder="ابحث في أفكارك…"
          aria-label="بحث دلالي في أفكارك"
          className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
        >
          بحث
        </button>
      </form>

      {query && (
        <div className="mt-4">
          {searchError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              تعذّر البحث: {searchError}
            </p>
          )}
          {!searchError && results.length === 0 && (
            <p className="text-sm text-foreground/50">لا نتائج مطابقة.</p>
          )}
          <ul className="space-y-2">
            {results.map((it) => (
              <li key={it.id} className="rounded-lg border border-foreground/10">
                <details>
                  <summary className="cursor-pointer p-3">
                    <span className="line-clamp-2 text-sm">
                      {it.summary || it.raw_text}
                    </span>
                    <span className="mt-1 block text-xs text-foreground/50">
                      {[
                        it.topic,
                        sourceAr(it.source_type),
                        new Date(it.created_at).toLocaleDateString("ar"),
                        Math.round(it.similarity * 100) + "% تطابق",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </summary>
                  <div className="border-t border-foreground/10 p-3">
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {it.raw_text}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* المُستجوِب */}
      <div className="mt-10 border-t border-foreground/10 pt-6">
        <Oracle />
      </div>
    </div>
  );
}

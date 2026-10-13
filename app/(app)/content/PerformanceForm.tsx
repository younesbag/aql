"use client";

import { useState, useTransition } from "react";
import { savePerformance } from "./actions";

type PostOpt = { id: string; label: string };

const FIELDS: [keyof Metrics, string][] = [
  ["impressions", "مشاهدات"],
  ["likes", "إعجابات"],
  ["replies", "ردود"],
  ["reposts", "إعادات نشر"],
  ["bookmarks", "حفظ"],
];
type Metrics = {
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  bookmarks: number;
};

export function PerformanceForm({ posts }: { posts: PostOpt[] }) {
  const [postId, setPostId] = useState(posts[0]?.id ?? "");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (posts.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        احفظ مسودة أولاً من المولّد أعلاه، ثم أدخل أداءها بعد نشرها.
      </p>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!postId) return;
    setError("");
    setMsg("");
    startTransition(async () => {
      try {
        await savePerformance(postId, {
          impressions: Number(vals.impressions) || 0,
          likes: Number(vals.likes) || 0,
          replies: Number(vals.replies) || 0,
          reposts: Number(vals.reposts) || 0,
          bookmarks: Number(vals.bookmarks) || 0,
        });
        setMsg("حُفظ الأداء ✅ واستُخرجت سماته للمختبر.");
        setVals({});
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر الحفظ");
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <select
        value={postId}
        onChange={(e) => setPostId(e.target.value)}
        aria-label="اختر المنشور"
        className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
      >
        {posts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="text-xs text-foreground/60">
            {label}
            <input
              type="number"
              min="0"
              value={vals[key] ?? ""}
              onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
              className="mt-1 w-full rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-foreground/40"
            />
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "يحفظ…" : "احفظ الأداء"}
      </button>
    </form>
  );
}

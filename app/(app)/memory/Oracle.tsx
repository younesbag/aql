"use client";

import { useState, useTransition } from "react";
import { askOracle, type OracleSource } from "./actions";
import { sourceAr } from "@/lib/memory/sourceLabels";

type Turn = { question: string; answer: string; sources: OracleSource[] };

export function Oracle() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setError("");
    startTransition(async () => {
      try {
        const res = await askOracle(q);
        setTurns((prev) => [
          { question: q, answer: res.answer, sources: res.sources },
          ...prev,
        ]);
        setQuestion("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "خطأ غير متوقّع");
      }
    });
  }

  return (
    <div>
      <h2 className="text-lg font-bold">المُستجوِب</h2>
      <p className="mt-1 text-sm text-foreground/60">
        اسأل ذاكرتك — يجيب من عناصرك مع الاستشهاد بمصادرها، ولا يخترع.
      </p>

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="وش قلت سابقاً عن…؟"
          aria-label="اسأل ذاكرتك"
          className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "يفكّر…" : "اسأل"}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="mt-6 space-y-6">
        {turns.map((t, idx) => (
          <div key={idx} className="space-y-2">
            <p className="font-medium">{t.question}</p>
            <p className="whitespace-pre-wrap text-sm text-foreground/80">
              {t.answer}
            </p>
            {t.sources.length > 0 && (
              <details className="text-xs text-foreground/55">
                <summary className="cursor-pointer">
                  المصادر ({t.sources.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {t.sources.map((s) => (
                    <li key={s.n}>
                      <span className="font-medium">[{s.n}]</span> {s.date} ·{" "}
                      {sourceAr(s.source_type)} — {s.snippet}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

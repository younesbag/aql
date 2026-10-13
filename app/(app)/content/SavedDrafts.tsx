"use client";

import { useState, useTransition } from "react";
import { deleteDraft, markDraftPublished } from "./actions";

export type DraftPost = {
  id: string;
  format: string;
  draft_text: string;
  hook_text: string | null;
  quality_score: number | null;
  created_at: string;
};

const FORMAT_AR: Record<string, string> = {
  thread: "ثريد",
  single: "تغريدة",
  email: "بريد",
};

function DraftCard({ draft }: { draft: DraftPost }) {
  const [copied, setCopied] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(draft.draft_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("تعذّر النسخ — انسخ النص يدوياً.");
    }
  }

  function publish() {
    setError("");
    startTransition(async () => {
      try {
        await markDraftPublished(draft.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر التحديث");
      }
    });
  }

  function remove() {
    setError("");
    startTransition(async () => {
      try {
        await deleteDraft(draft.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر الحذف");
      }
    });
  }

  return (
    <details className="rounded-lg border border-foreground/10 p-3">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
          <span className="rounded-md bg-foreground/10 px-2 py-0.5 font-medium text-foreground/80">
            {FORMAT_AR[draft.format] ?? draft.format}
          </span>
          {draft.quality_score != null && (
            <span className="rounded-md bg-foreground/10 px-2 py-0.5">
              الجودة {draft.quality_score}/10
            </span>
          )}
          <span>{draft.created_at.slice(0, 10)}</span>
        </div>
        <p className="mt-1.5 line-clamp-1 text-sm text-foreground/80">
          {draft.hook_text || draft.draft_text}
        </p>
      </summary>

      <div className="mt-3 space-y-2 border-t border-foreground/10 pt-3">
        {draft.hook_text && (
          <p className="text-sm">
            <span className="font-medium">الخطاف:</span> {draft.hook_text}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {draft.draft_text}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5"
        >
          {copied ? "نُسخت ✅" : "نسخ"}
        </button>
        <button
          onClick={publish}
          disabled={pending}
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {pending ? "…" : "نُشرت"}
        </button>
        {!confirmDel ? (
          <button
            onClick={() => setConfirmDel(true)}
            className="rounded-lg border border-red-600/30 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-600/10 dark:text-red-400"
          >
            حذف
          </button>
        ) : (
          <>
            <button
              onClick={remove}
              disabled={pending}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {pending ? "يحذف…" : "تأكيد الحذف"}
            </button>
            <button
              onClick={() => setConfirmDel(false)}
              className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5"
            >
              إلغاء
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </details>
  );
}

export function SavedDrafts({ drafts }: { drafts: DraftPost[] }) {
  if (drafts.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        لا مسودات محفوظة بعد — ولّد مسودة من الأعلى ثم احفظها.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} />
      ))}
    </div>
  );
}

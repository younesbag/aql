"use client";

import { useState, useTransition } from "react";
import { saveJournalEntry, draftWeeklyJournal } from "./actions";

type Entry = {
  id: string;
  week_of: string;
  learned: string | null;
  failed: string | null;
  succeeded: string | null;
  changed: string | null;
};

export function Journal({
  entries,
  needsReview,
  weeklyStats,
}: {
  entries: Entry[];
  needsReview: boolean;
  weeklyStats?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [learned, setLearned] = useState("");
  const [failed, setFailed] = useState("");
  const [succeeded, setSucceeded] = useState("");
  const [changed, setChanged] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [pending, startTransition] = useTransition();

  // مسودة آلية من وقائع الأسبوع (الملف 14 — البند ٥): تملأ الحقول ويحرّرها المالك.
  function autoDraft() {
    setError("");
    setMsg("");
    setDrafting(true);
    startTransition(async () => {
      try {
        const r = await draftWeeklyJournal();
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setLearned(r.draft.learned);
        setFailed(r.draft.failed);
        setSucceeded(r.draft.succeeded);
        setChanged(r.draft.changed);
        setMsg("مسودة من أسبوعك — عدّلها ثم احفظ.");
      } catch {
        setError("تعذّر توليد المسودة — تحقّق من الاتصال وحاول مجدداً.");
      } finally {
        setDrafting(false);
      }
    });
  }

  const fields = [
    { label: "ما الذي تعلمته؟", value: learned, set: setLearned },
    { label: "ما الذي فشل؟", value: failed, set: setFailed },
    { label: "ما الذي نجح؟", value: succeeded, set: setSucceeded },
    { label: "ما الذي تغيّر في رأيي؟", value: changed, set: setChanged },
  ];

  function save() {
    setError("");
    setMsg("");
    startTransition(async () => {
      try {
        await saveJournalEntry({ learned, failed, succeeded, changed });
        setLearned("");
        setFailed("");
        setSucceeded("");
        setChanged("");
        setOpen(false);
        setMsg("حُفظت المراجعة ✅");
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر الحفظ");
      }
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">مذكرة المؤسس</h2>
        {needsReview && (
          <span className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            مرّ أسبوع بلا مراجعة
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-foreground/60">
        مراجعة أسبوعية صادقة — تتراكم لتكشف نموّك، وتصبح جزءاً من ذاكرتك.
      </p>

      {/* جسر المهام (الملف 11 — المرحلة ٣): إحصاء أسبوعك في المهام أمام المراجعة. */}
      <div className="mt-3 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3">
        <p className="text-xs font-bold text-foreground/70">📊 أسبوعك في المهام</p>
        {weeklyStats ? (
          <p className="mt-1 text-sm text-foreground/80">{weeklyStats}</p>
        ) : (
          <p className="mt-1 text-sm text-foreground/50">
            لا نشاط مهام هذا الأسبوع بعد — تتراكم البيانات مع الاستخدام.
          </p>
        )}
      </div>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
        >
          مراجعة هذا الأسبوع
        </button>
      ) : (
        <div className="mt-3 space-y-3 rounded-lg border border-foreground/10 p-4">
          <button
            onClick={autoDraft}
            disabled={pending}
            className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs transition hover:bg-foreground/5 disabled:opacity-50"
          >
            {drafting ? "يولّد من وقائع أسبوعك…" : "✨ ولّد مسودة من أسبوعك"}
          </button>
          {fields.map((f, i) => (
            <div key={i}>
              <label className="mb-1 block text-sm font-medium">{f.label}</label>
              <textarea
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
              />
            </div>
          ))}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={
                pending ||
                !(
                  learned.trim() ||
                  failed.trim() ||
                  succeeded.trim() ||
                  changed.trim()
                )
              }
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {pending && !drafting ? "يحفظ…" : "احفظ المراجعة"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg border border-foreground/20 px-4 py-2 text-sm transition hover:bg-foreground/5"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {msg && (
        <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>
      )}

      <div className="mt-6 space-y-2">
        {entries.length === 0 ? (
          <p className="text-sm text-foreground/50">لا مراجعات بعد.</p>
        ) : (
          entries.map((e) => (
            <details key={e.id} className="rounded-lg border border-foreground/10 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                أسبوع {e.week_of}
              </summary>
              <div className="mt-2 space-y-1 text-sm text-foreground/80">
                {e.learned && (
                  <p>
                    <span className="font-medium">تعلّمت:</span> {e.learned}
                  </p>
                )}
                {e.failed && (
                  <p>
                    <span className="font-medium">فشل:</span> {e.failed}
                  </p>
                )}
                {e.succeeded && (
                  <p>
                    <span className="font-medium">نجح:</span> {e.succeeded}
                  </p>
                )}
                {e.changed && (
                  <p>
                    <span className="font-medium">تغيّر رأيي:</span> {e.changed}
                  </p>
                )}
              </div>
            </details>
          ))
        )}
      </div>
    </div>
  );
}

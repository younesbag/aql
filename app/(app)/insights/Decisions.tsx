"use client";

import { useState, useTransition } from "react";
import { saveDecision, addDecisionOutcome, analyzeDecisions } from "./actions";

type Decision = {
  id: string;
  situation: string;
  decision: string;
  reasoning: string;
  hypothesis: string | null;
  outcome: string | null;
  was_correct: string | null;
};

const CORRECT_AR: Record<string, string> = {
  yes: "صحيح",
  no: "خاطئ",
  partial: "جزئي",
  unknown: "غير معروف",
};

function OutcomeForm({ id }: { id: string }) {
  const [outcome, setOutcome] = useState("");
  const [was, setWas] = useState("yes");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function save() {
    setError("");
    startTransition(async () => {
      try {
        await addDecisionOutcome(id, { outcome, was_correct: was });
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر الحفظ");
      }
    });
  }

  return (
    <div className="mt-2 space-y-2 border-t border-foreground/10 pt-2">
      <textarea
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        rows={2}
        placeholder="ما الذي حدث فعلاً؟ (أضف النتيجة لاحقاً)"
        className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={was}
          onChange={(e) => setWas(e.target.value)}
          aria-label="صحة القرار"
          className="rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 text-sm outline-none"
        >
          <option value="yes">صحيح</option>
          <option value="no">خاطئ</option>
          <option value="partial">جزئي</option>
          <option value="unknown">غير معروف</option>
        </select>
        <button
          onClick={save}
          disabled={pending || !outcome.trim()}
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {pending ? "يحفظ…" : "احفظ النتيجة"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function Decisions({
  decisions,
  count,
}: {
  decisions: Decision[];
  count: number;
}) {
  const [situation, setSituation] = useState("");
  const [decision, setDecision] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  const [analysis, setAnalysis] = useState("");
  const [analyzeErr, setAnalyzeErr] = useState("");
  const [analyzing, startAnalyze] = useTransition();

  const fields = [
    {
      label: "الموقف *",
      value: situation,
      set: setSituation,
      ph: "السياق: ما الذي استدعى قراراً؟",
    },
    { label: "القرار *", value: decision, set: setDecision, ph: "ما الذي قررته؟" },
    {
      label: "السبب *",
      value: reasoning,
      set: setReasoning,
      ph: "لماذا هذا القرار تحديداً؟",
    },
    {
      label: "الفرضية",
      value: hypothesis,
      set: setHypothesis,
      ph: "ما الذي تتوقّع أن يحدث؟ (اختياري)",
    },
  ];

  function save() {
    setError("");
    setMsg("");
    startTransition(async () => {
      try {
        await saveDecision({ situation, decision, reasoning, hypothesis });
        setSituation("");
        setDecision("");
        setReasoning("");
        setHypothesis("");
        setMsg("سُجّل القرار ✅");
      } catch (e) {
        setError(e instanceof Error ? e.message : "تعذّر الحفظ");
      }
    });
  }

  function runAnalysis() {
    setAnalyzeErr("");
    setAnalysis("");
    startAnalyze(async () => {
      try {
        setAnalysis(await analyzeDecisions());
      } catch (e) {
        setAnalyzeErr(e instanceof Error ? e.message : "تعذّر التحليل");
      }
    });
  }

  return (
    <div>
      <h2 className="text-lg font-bold">سجلّ القرارات</h2>
      <p className="mt-1 text-sm text-foreground/60">
        موقف ← قرار ← سبب ← فرضية. هذه البنية وحدها تحوّل الأرشيف إلى ذكاء بعد سنة.
      </p>

      {/* النموذج */}
      <div className="mt-3 space-y-3 rounded-lg border border-foreground/10 p-4">
        {fields.map((f, i) => (
          <div key={i}>
            <label className="mb-1 block text-sm font-medium">{f.label}</label>
            <textarea
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              rows={2}
              placeholder={f.ph}
              className="w-full rounded-lg border border-foreground/15 bg-transparent p-2 text-sm outline-none focus:border-foreground/40"
            />
          </div>
        ))}
        <button
          onClick={save}
          disabled={
            pending ||
            !situation.trim() ||
            !decision.trim() ||
            !reasoning.trim()
          }
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "يسجّل…" : "سجّل القرار"}
        </button>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {msg && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>
        )}
      </div>

      {/* لوحة التحليل — معطّلة بحدّ البيانات (مبدأ النضج) */}
      <div className="mt-6 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
        <h3 className="text-sm font-bold">تحليل القرارات</h3>
        {count < 30 ? (
          <p className="mt-1 text-sm text-foreground/55">
            البيانات تتراكم — التحليل يُفعّل عند ٣٠ قراراً موثّقاً (لديك {count}{" "}
            الآن).
          </p>
        ) : (
          <div className="mt-2">
            <button
              onClick={runAnalysis}
              disabled={analyzing}
              className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
            >
              {analyzing ? "يحلّل…" : "حلّل أنماط قراراتي"}
            </button>
            {analyzeErr && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {analyzeErr}
              </p>
            )}
            {analysis && (
              <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/80">
                {analysis}
              </p>
            )}
          </div>
        )}
      </div>

      {/* القائمة */}
      <div className="mt-6 space-y-2">
        <h3 className="text-sm font-bold">القرارات ({count})</h3>
        {decisions.length === 0 ? (
          <p className="text-sm text-foreground/50">لا قرارات بعد.</p>
        ) : (
          decisions.map((d) => (
            <details key={d.id} className="rounded-lg border border-foreground/10 p-3">
              <summary className="flex cursor-pointer items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
                <span className="flex-1 text-sm font-medium">{d.decision}</span>
                {d.was_correct ? (
                  <span className="shrink-0 rounded-md bg-foreground/10 px-2 py-0.5 text-xs">
                    {CORRECT_AR[d.was_correct] ?? d.was_correct}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                    بانتظار النتيجة
                  </span>
                )}
              </summary>
              <div className="mt-2 space-y-1 text-sm text-foreground/80">
                <p>
                  <span className="font-medium">الموقف:</span> {d.situation}
                </p>
                <p>
                  <span className="font-medium">السبب:</span> {d.reasoning}
                </p>
                {d.hypothesis && (
                  <p>
                    <span className="font-medium">الفرضية:</span> {d.hypothesis}
                  </p>
                )}
                {d.outcome ? (
                  <p>
                    <span className="font-medium">النتيجة:</span> {d.outcome} (
                    {CORRECT_AR[d.was_correct ?? "unknown"]})
                  </p>
                ) : (
                  <OutcomeForm id={d.id} />
                )}
              </div>
            </details>
          ))
        )}
      </div>
    </div>
  );
}

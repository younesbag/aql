"use client";

import { useState, useTransition } from "react";
import { NewsletterWizard } from "./NewsletterWizard";
import { listNewsletters } from "./actions";
import { STATUS_AR, type NewsletterRow } from "@/lib/newsletter/criteria";

// تاريخ مختصر يوم/شهر (أرقام غربية كبقية الواجهة) — بلا اعتماد على لغة المتصفح.
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function NewsletterWorkspace({ initialList }: { initialList: NewsletterRow[] }) {
  const [list, setList] = useState<NewsletterRow[]>(initialList);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resume, setResume] = useState<NewsletterRow | null>(null);
  const [mountKey, setMountKey] = useState(0); // يتغيّر فقط عند فتح/جديد → إعادة تركيب المعالج
  const [, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      try {
        const r = await listNewsletters();
        setList(r.list);
      } catch {
        /* تحديث القائمة تحسينيّ — تجاهل الفشل */
      }
    });
  }

  // فتح نشرة محفوظة للاستئناف: يُعاد تركيب المعالج مُهيّأً منها (mountKey يتبدّل).
  function open(row: NewsletterRow) {
    setResume(row);
    setActiveId(row.id);
    setMountKey((k) => k + 1);
  }

  // نشرة جديدة فارغة.
  function newOne() {
    setResume(null);
    setActiveId(null);
    setMountKey((k) => k + 1);
  }

  // بعد الحفظ: أبرِز الصفّ وحدّث القائمة — دون إعادة تركيب (mountKey ثابت) كي لا يضيع عمل المالك.
  function handleSaved(id: string) {
    setActiveId(id);
    refresh();
  }

  return (
    <div>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground/70">نشراتك المحفوظة</h2>
          <button
            onClick={newOne}
            className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5"
          >
            + نشرة جديدة
          </button>
        </div>

        {list.length === 0 ? (
          <p className="mt-2 text-xs text-foreground/40">لا نشرات محفوظة بعد — ابدأ بفكرة أدناه.</p>
        ) : (
          <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-foreground/10 p-2">
            {list.map((row) => (
              <button
                key={row.id}
                onClick={() => open(row)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-right text-xs transition ${
                  activeId === row.id ? "bg-foreground/10" : "hover:bg-foreground/5"
                }`}
              >
                <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/60">
                  {STATUS_AR[row.status]}
                </span>
                <span className="grow truncate text-foreground/80">
                  {row.subject || row.idea || "—"}
                </span>
                <span className="shrink-0 text-[10px] text-foreground/40">
                  {shortDate(row.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2">
        <NewsletterWizard key={mountKey} resume={resume} onSaved={handleSaved} />
      </div>
    </div>
  );
}

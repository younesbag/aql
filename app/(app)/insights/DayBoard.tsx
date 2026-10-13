// تبويب «خطة اليوم» (الملف 11 — المرحلة ٤): خطة اليوم وحالتها + أرشيف الأيام.
// عرض فقط (لا تفاعل) — التفاعل في الطقس المسائي عبر تيليجرام.

type DayTask = { title: string; status: string };
type ArchiveDay = {
  display: string;
  count: number;
  done: number;
  exception: string | null;
};

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "done":
      return { label: "تمت ✓", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
    case "inbox":
      return { label: "رُحّلت ↩", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };
    case "dropped":
      return { label: "أُسقطت ✗", cls: "bg-red-500/15 text-red-700 dark:text-red-400" };
    default:
      return { label: "بانتظار", cls: "bg-foreground/10 text-foreground/60" };
  }
}

export function DayBoard({
  displayDate,
  exception,
  why,
  tasks,
  archive,
}: {
  displayDate: string;
  exception: string | null;
  why: string | null;
  tasks: DayTask[];
  archive: ArchiveDay[];
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">خطة اليوم</h2>
        <span className="text-sm text-foreground/55">{displayDate}</span>
        {exception && (
          <span className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            استثناء: {exception}
          </span>
        )}
      </div>

      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-foreground/55">
          لا خطة لليوم — أجرِ الطقس المسائي بكتابة <span className="font-mono">/مساء</span>{" "}
          في تيليجرام، وستصلك خطة الغد مثبّتة.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {tasks.map((t, i) => {
            const b = statusBadge(t.status);
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 p-3"
              >
                <span className="text-sm">
                  {i === 0 ? "🎯 " : `${i + 1}. `}
                  {t.title}
                </span>
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${b.cls}`}>
                  {b.label}
                </span>
              </div>
            );
          })}
          {why && (
            <p className="pt-1 text-sm text-foreground/70">
              <span className="font-medium">💡 لماذا:</span> {why}
            </p>
          )}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-bold text-foreground/70">أيام سابقة</h3>
        {archive.length === 0 ? (
          <p className="mt-2 text-sm text-foreground/50">لا أيام سابقة بعد.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {archive.map((d, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-2 border-t border-foreground/10 py-2 text-sm"
              >
                <span className="text-foreground/80">{d.display}</span>
                <span className="text-foreground/55">
                  أُنجز {d.done}/{d.count}
                  {d.exception ? ` · ${d.exception}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

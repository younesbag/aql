import { createClient } from "@/lib/supabase/server";
import { computeWeeklyTaskStats, formatWeeklyStats } from "@/lib/dayplan/reports";
import { ownerDateString, ownerDisplayDate } from "@/lib/dayplan/queries";
import { InsightsTabs } from "./InsightsTabs";
import { Journal } from "./Journal";
import { DayBoard } from "./DayBoard";
import { Decisions } from "./Decisions";
import { PatternLab } from "../content/PatternLab";
import { Oracle } from "../memory/Oracle";

type JournalEntry = {
  id: string;
  week_of: string;
  learned: string | null;
  failed: string | null;
  succeeded: string | null;
  changed: string | null;
};

type DecisionRow = {
  id: string;
  situation: string;
  decision: string;
  reasoning: string;
  hypothesis: string | null;
  outcome: string | null;
  was_correct: string | null;
};

// بداية الأسبوع (الإثنين) — لمطابقة ما يخزّنه إجراء المذكرة.
function currentMonday(): string {
  const now = new Date();
  const diff = (now.getUTCDay() + 6) % 7;
  const m = new Date(now);
  m.setUTCDate(now.getUTCDate() - diff);
  return m.toISOString().slice(0, 10);
}

export default async function InsightsPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // إحصاءات لوحة اليوم
  const [ideasWeek, draftsPending, published] = await Promise.all([
    supabase
      .from("items")
      .select("id", { count: "exact", head: true })
      .neq("status", "archived")
      .gte("created_at", since),
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("status", "draft"),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("status", "published"),
  ]);

  // اقتراح «انشر اليوم»: أعلى مسودة جودةً، وإلا أحدث فكرة.
  const { data: topDraft } = await supabase
    .from("posts")
    .select("draft_text")
    .eq("status", "draft")
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(1);
  let suggestion: string | undefined = topDraft?.[0]?.draft_text as string | undefined;
  let suggestionKind = "مسودة";
  if (!suggestion) {
    const { data: idea } = await supabase
      .from("items")
      .select("summary, raw_text")
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(1);
    const i = idea?.[0];
    if (i) {
      suggestion = (i.summary as string | null) || (i.raw_text as string);
      suggestionKind = "فكرة";
    }
  }

  // المذكرة
  const { data: jData } = await supabase
    .from("journal_entries")
    .select("id, week_of, learned, failed, succeeded, changed")
    .order("week_of", { ascending: false })
    .limit(20);
  const journalEntries = (jData ?? []) as JournalEntry[];
  const needsReview = !journalEntries.some((e) => e.week_of === currentMonday());

  // جسر المراجعة الأسبوعية (الملف 11 — المرحلة ٣): إحصاء أسبوع المهام في المذكرة.
  const weekly = await computeWeeklyTaskStats(supabase);
  const weeklyStats =
    weekly.planned || weekly.done || weekly.deferred ? formatWeeklyStats(weekly) : null;

  // تبويب «خطة اليوم» (الملف 11 — المرحلة ٤): خطة اليوم + أرشيف الأيام.
  const todayStr = ownerDateString(0);
  const [{ data: todayPlan }, { data: recentPlans }] = await Promise.all([
    supabase.from("day_plans").select("*").eq("plan_date", todayStr).maybeSingle(),
    supabase
      .from("day_plans")
      .select("plan_date, exception, why, task_ids, status")
      .order("plan_date", { ascending: false })
      .limit(14),
  ]);
  const planList = (recentPlans ?? []) as {
    plan_date: string;
    exception: string | null;
    why: string | null;
    task_ids: string[] | null;
    status: string;
  }[];
  // اجمع كل معرّفات المهام (اليوم + الأرشيف) لجلب حالاتها دفعة واحدة.
  const todayIds: string[] = Array.isArray(todayPlan?.task_ids)
    ? (todayPlan.task_ids as string[])
    : [];
  const allTaskIds = new Set<string>(todayIds);
  for (const p of planList) for (const id of p.task_ids ?? []) allTaskIds.add(id);
  const { data: taskRows } = allTaskIds.size
    ? await supabase.from("tasks").select("id, title, status").in("id", [...allTaskIds])
    : { data: [] as { id: string; title: string; status: string }[] };
  const taskMap = new Map(
    ((taskRows ?? []) as { id: string; title: string; status: string }[]).map((t) => [t.id, t]),
  );
  const dayTasks = todayIds
    .map((id) => taskMap.get(id))
    .filter((t): t is { id: string; title: string; status: string } => !!t)
    .map((t) => ({ title: t.title, status: t.status }));
  const dayArchive = planList
    .filter((p) => p.plan_date !== todayStr)
    .map((p) => {
      const ids = Array.isArray(p.task_ids) ? p.task_ids : [];
      const done = ids.filter((id) => taskMap.get(id)?.status === "done").length;
      return {
        display: ownerDisplayDate(p.plan_date),
        count: ids.length,
        done,
        exception: p.exception,
      };
    });

  // القرارات
  const { data: dData } = await supabase
    .from("decisions")
    .select("id, situation, decision, reasoning, hypothesis, outcome, was_correct")
    .order("created_at", { ascending: false });
  const decisions = (dData ?? []) as DecisionRow[];

  // خريطة المعرفة — تجميع بالموضوع
  const { data: kItems } = await supabase.from("items").select("topic, created_at");
  const tmap = new Map<string, { count: number; last: string }>();
  for (const it of kItems ?? []) {
    const topic = ((it.topic as string | null) || "").trim() || "غير مصنّف بعد";
    const cur = tmap.get(topic) ?? { count: 0, last: "" };
    cur.count += 1;
    const c = it.created_at as string;
    if (!cur.last || c > cur.last) cur.last = c;
    tmap.set(topic, cur);
  }
  const nowMs = Date.now();
  const topics = [...tmap.entries()]
    .map(([topic, v]) => ({
      topic,
      count: v.count,
      last: v.last,
      neglected: v.last ? nowMs - new Date(v.last).getTime() > 30 * 24 * 3600 * 1000 : true,
    }))
    .sort((a, b) => b.count - a.count);

  const stat = (n: number | null) => (n ?? 0).toString();

  const tabs = [
    {
      key: "today",
      label: "لوحة اليوم",
      content: (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "أفكار هذا الأسبوع", v: stat(ideasWeek.count) },
              { label: "مسودات منتظرة", v: stat(draftsPending.count) },
              { label: "منشورات", v: stat(published.count) },
            ].map((s, i) => (
              <div
                key={i}
                className="rounded-lg border border-foreground/10 p-4 text-center"
              >
                <p className="text-2xl font-bold">{s.v}</p>
                <p className="mt-1 text-xs text-foreground/60">{s.label}</p>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-4">
            <h3 className="text-sm font-bold">انشر اليوم</h3>
            {suggestion ? (
              <p className="mt-2 text-sm text-foreground/80">
                <span className="rounded-md bg-foreground/10 px-2 py-0.5 text-xs">
                  {suggestionKind}
                </span>{" "}
                {suggestion.slice(0, 240)}
              </p>
            ) : (
              <p className="mt-2 text-sm text-foreground/55">
                لا اقتراح بعد — التقط فكرة أو ولّد مسودة.
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "dayplan",
      label: "خطة اليوم",
      content: (
        <DayBoard
          displayDate={ownerDisplayDate(todayStr)}
          exception={(todayPlan?.exception as string | null) ?? null}
          why={(todayPlan?.why as string | null) ?? null}
          tasks={dayTasks}
          archive={dayArchive}
        />
      ),
    },
    { key: "lab", label: "مختبر المحتوى", content: <PatternLab /> },
    {
      key: "map",
      label: "خريطة المعرفة",
      content: (
        <div>
          <h2 className="text-lg font-bold">خريطة المعرفة</h2>
          <p className="mt-1 text-sm text-foreground/60">
            مواضيعك وعدد عناصرها وآخر نشاط — لكشف الفجوات لا لرسم شبكة.
          </p>
          {topics.length === 0 ? (
            <p className="mt-3 text-sm text-foreground/50">لا عناصر بعد.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="text-xs text-foreground/50">
                  <tr>
                    <th className="p-2 font-medium">الموضوع</th>
                    <th className="p-2 font-medium">العدد</th>
                    <th className="p-2 font-medium">آخر نشاط</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((t) => (
                    <tr key={t.topic} className="border-t border-foreground/10">
                      <td className="p-2">
                        {t.topic}
                        {t.neglected && (
                          <span className="ms-2 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                            مهمَل
                          </span>
                        )}
                      </td>
                      <td className="p-2">{t.count}</td>
                      <td className="p-2 text-foreground/60">
                        {t.last ? t.last.slice(0, 10) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ),
    },
    { key: "oracle", label: "المُستجوِب", content: <Oracle /> },
    {
      key: "journal",
      label: "المذكرة",
      content: (
        <Journal
          entries={journalEntries}
          needsReview={needsReview}
          weeklyStats={weeklyStats}
        />
      ),
    },
    {
      key: "decisions",
      label: "القرارات",
      content: <Decisions decisions={decisions} count={decisions.length} />,
    },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">الرؤى</h1>
      <p className="mb-6 mt-1 text-sm text-foreground/60">
        لوحة قيادتك — اليوم، الأنماط، المعرفة، الذاكرة، المذكرة، والقرارات.
      </p>
      <InsightsTabs tabs={tabs} />
    </div>
  );
}

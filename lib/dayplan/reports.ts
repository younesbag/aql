import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ownerDateString,
  getOpenTasks,
  getPlan,
  getReviewTasks,
  type OpenTask,
} from "@/lib/dayplan/queries";
import { PROJECT_MAIN, PROJECT_SECOND, PROJECT_PERSONAL } from "@/lib/capture/task";
import { OWNER_NAME, OWNER_TZ } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// تقارير التعلّم (الملف 11 — المرحلة ٣).
// • patternReport: نسبة الإنجاز حسب النوع + توازن المشاريع (عند الطلب /أنماط).
// • computeWeeklyTaskStats: إحصاء الأسبوع للمذكرة (جسر المراجعة الأسبوعية).
// ملاحظة: ثمار هذه الطبقة تتأخر ~أسبوعين حتى تتراكم بيانات كافية.
// ════════════════════════════════════════════════════════════

const KIND_LABELS: Record<string, string> = {
  build: "بناء",
  market: "تسويق",
  content: "محتوى",
  admin: "إداري",
  personal: "شخصي",
};

type TaskRow = {
  kind: string;
  status: string;
  done_at?: string | null;
  projects: { name: string } | { name: string }[] | null;
};

function projName(p: TaskRow["projects"]): string {
  if (!p) return "شخصي";
  return (Array.isArray(p) ? p[0]?.name : p.name) ?? "شخصي";
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((100 * part) / whole) : 0;
}

// دَين الإشارات (الملف 14 — البند ٦): روابط حُفظت بنيّة «أرجع لها» ولم تُلمس —
// كانت ثقباً أسود لا يذكّر به شيء. أقدم من ٣ أيام = دَين يستحق سطراً في التقرير.
async function signalDebtLine(supabase: SupabaseClient): Promise<string> {
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data, count } = await supabase
    .from("items")
    .select("created_at", { count: "exact" })
    .eq("source_type", "signal")
    .eq("status", "new")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!count || count === 0) return "";
  const oldest = data?.[0]?.created_at
    ? new Intl.DateTimeFormat("ar", {
        timeZone: OWNER_TZ,
        day: "numeric",
        month: "long",
      }).format(new Date(data[0].created_at as string))
    : "";
  // التوصية تذكر المسار القائم فعلاً: توليد مسودة من الإشارة يخرجها من الدَّين
  // (يصير status='drafted'). لا مسار «إسقاط» في التطبيق — فلا نوصي بما لا وجود له.
  return `\n\n🔗 إشارات حفظتها ولم تلمسها: ${count}${oldest ? ` (أقدمها منذ ${oldest})` : ""} — ولّد منها في «المحتوى» أو استجوبها في «العقل».`;
}

/** تقرير نمط المماطلة (آخر ٣٠ يوماً): نسبة الإنجاز حسب النوع + توازن المشاريع. */
export async function patternReport(): Promise<string> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("tasks")
    .select("kind, status, projects(name)")
    .gte("created_at", since);

  const rows = (data ?? []) as TaskRow[];
  if (rows.length < 5) {
    const debt = await signalDebtLine(supabase);
    return `📊 نمط آخر ٣٠ يوماً\n\nالبيانات تتراكم — التقرير يصير أدقّ بعد أسبوعين من الاستخدام.${debt}`;
  }

  // الإنجاز حسب النوع: done / إجمالي النوع
  const totalByKind: Record<string, number> = {};
  const doneByKind: Record<string, number> = {};
  const doneByProject: Record<string, number> = {};
  for (const r of rows) {
    totalByKind[r.kind] = (totalByKind[r.kind] ?? 0) + 1;
    if (r.status === "done") {
      doneByKind[r.kind] = (doneByKind[r.kind] ?? 0) + 1;
      const p = projName(r.projects);
      doneByProject[p] = (doneByProject[p] ?? 0) + 1;
    }
  }

  const kindLines = Object.keys(totalByKind)
    .sort((a, b) => totalByKind[b] - totalByKind[a])
    .map((k) => {
      const done = doneByKind[k] ?? 0;
      const total = totalByKind[k];
      return `• ${KIND_LABELS[k] ?? k}: ${pct(done, total)}% (${done}/${total})`;
    });

  const totalDone = Object.values(doneByProject).reduce((a, b) => a + b, 0);
  const balanceLine =
    totalDone > 0
      ? `${PROJECT_MAIN} ${pct(doneByProject[PROJECT_MAIN] ?? 0, totalDone)}% · ${PROJECT_SECOND} ${pct(
          doneByProject[PROJECT_SECOND] ?? 0,
          totalDone,
        )}% · شخصي ${pct(doneByProject[PROJECT_PERSONAL] ?? 0, totalDone)}%`
      : "لا إنجاز موثّق بعد";

  // تنبيه الاحتكاك: تنجز البناء أكثر مما تنجز التسويق/المحتوى؟
  const buildRate = pct(doneByKind["build"] ?? 0, totalByKind["build"] ?? 0);
  const fricTotal = (totalByKind["market"] ?? 0) + (totalByKind["content"] ?? 0);
  const fricDone = (doneByKind["market"] ?? 0) + (doneByKind["content"] ?? 0);
  const fricRate = pct(fricDone, fricTotal);
  let nudge = "";
  if (fricTotal > 0 && (totalByKind["build"] ?? 0) > 0 && buildRate - fricRate >= 25) {
    nudge = `\n\n⚠️ تنجز البناء (${buildRate}%) أكثر من الاحتكاك (${fricRate}%) — والاحتكاك (التسويق/المحتوى) هو غالباً ما يحتاجه المشروع الآن.`;
  }

  const debt = await signalDebtLine(supabase);
  return `📊 نمط آخر ٣٠ يوماً\n\nالإنجاز حسب النوع:\n${kindLines.join(
    "\n",
  )}\n\n⚖️ توازن المنجز: ${balanceLine}${nudge}${debt}`;
}

export type WeeklyTaskStats = {
  planned: number;
  done: number;
  deferred: number;
  doneByKind: Record<string, number>;
  doneByProject: Record<string, number>;
};

function mondayUTC(): { date: string; iso: string } {
  const now = new Date();
  const diff = (now.getUTCDay() + 6) % 7; // 0=الإثنين
  const m = new Date(now);
  m.setUTCDate(now.getUTCDate() - diff);
  m.setUTCHours(0, 0, 0, 0);
  return { date: m.toISOString().slice(0, 10), iso: m.toISOString() };
}

/** إحصاء أسبوع المهام (من إثنين هذا الأسبوع): خُطّط/أُنجز/رُحّل، حسب النوع والمشروع.
 *  يقبل عميل Supabase (البانل يمرّر عميل الجلسة المحترِم لـ RLS). */
export async function computeWeeklyTaskStats(
  supabase: SupabaseClient,
): Promise<WeeklyTaskStats> {
  const { date: monday, iso: mondayIso } = mondayUTC();

  const [{ data: plans }, { data: done }, { data: deferredRows }] = await Promise.all([
    supabase.from("day_plans").select("task_ids").gte("plan_date", monday),
    supabase
      .from("tasks")
      .select("kind, status, done_at, projects(name)")
      .eq("status", "done")
      .gte("done_at", mondayIso),
    supabase.from("tasks").select("deferrals"),
  ]);

  let planned = 0;
  for (const p of (plans ?? []) as { task_ids: unknown[] }[]) {
    planned += Array.isArray(p.task_ids) ? p.task_ids.length : 0;
  }

  const doneByKind: Record<string, number> = {};
  const doneByProject: Record<string, number> = {};
  for (const r of (done ?? []) as TaskRow[]) {
    doneByKind[r.kind] = (doneByKind[r.kind] ?? 0) + 1;
    const p = projName(r.projects);
    doneByProject[p] = (doneByProject[p] ?? 0) + 1;
  }

  let deferred = 0;
  for (const t of (deferredRows ?? []) as { deferrals: unknown[] }[]) {
    if (!Array.isArray(t.deferrals)) continue;
    for (const d of t.deferrals) {
      if (typeof d === "string" && d >= monday) deferred += 1;
    }
  }

  return {
    planned,
    done: ((done ?? []) as unknown[]).length,
    deferred,
    doneByKind,
    doneByProject,
  };
}

// ── أداة استعلام المهام للعقل الموحّد (المرحلة ٤) ──────────
function statusAr(status: string): string {
  switch (status) {
    case "done":
      return "تمت";
    case "inbox":
      return "مُرحَّلة";
    case "dropped":
      return "أُسقطت";
    default:
      return "بانتظار";
  }
}

// يحلّ جسور الربط (related_item_id/related_decision_id) إلى ملاحظة قصيرة لكل مهمة.
async function resolveBridges(tasks: OpenTask[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const itemIds = [...new Set(tasks.map((t) => t.relatedItemId).filter(Boolean))] as string[];
  const decIds = [...new Set(tasks.map((t) => t.relatedDecisionId).filter(Boolean))] as string[];
  if (itemIds.length === 0 && decIds.length === 0) return out;

  const supabase = createAdminClient();
  const [items, decs] = await Promise.all([
    itemIds.length
      ? supabase.from("items").select("id, summary, raw_text").in("id", itemIds)
      : Promise.resolve({ data: [] as { id: string; summary: string | null; raw_text: string }[] }),
    decIds.length
      ? supabase.from("decisions").select("id, situation, decision").in("id", decIds)
      : Promise.resolve({ data: [] as { id: string; situation: string; decision: string }[] }),
  ]);
  const itemMap = new Map(
    (items.data ?? []).map((i) => [i.id, (i.summary || i.raw_text || "").slice(0, 80)]),
  );
  const decMap = new Map(
    (decs.data ?? []).map((d) => [d.id, (d.decision || d.situation || "").slice(0, 80)]),
  );
  for (const t of tasks) {
    if (t.relatedItemId && itemMap.has(t.relatedItemId)) {
      out.set(t.id, `من فكرة: ${itemMap.get(t.relatedItemId)}`);
    } else if (t.relatedDecisionId && decMap.has(t.relatedDecisionId)) {
      out.set(t.id, `من قرار: ${decMap.get(t.relatedDecisionId)}`);
    }
  }
  return out;
}

/** كتلة نصّية عن المهام للعقل الموحّد: مفتوحة | منجَز الأسبوع | خطة اليوم. */
export async function summarizeTasksForMind(
  kind: "open" | "completed_week" | "today_plan",
  project?: string,
): Promise<string> {
  if (kind === "today_plan") {
    const today = ownerDateString(0);
    const plan = await getPlan(today);
    if (!plan || plan.taskIds.length === 0) {
      return `لا خطة مهام لليوم. يُجري ${OWNER_NAME} الطقس المسائي (/مساء) لبناء خطة الغد.`;
    }
    const tasks = await getReviewTasks(plan.taskIds);
    const lines = tasks.map((t, i) => `${i + 1}. ${t.title} — ${statusAr(t.status)}`);
    const extra = [
      plan.exception ? `استثناء: ${plan.exception}` : "",
      plan.why ? `لماذا: ${plan.why}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `خطة اليوم (${today}):\n${lines.join("\n")}${extra ? "\n" + extra : ""}`;
  }

  if (kind === "completed_week") {
    const s = await computeWeeklyTaskStats(createAdminClient());
    return `إنجاز هذا الأسبوع — ${formatWeeklyStats(s)}`;
  }

  // المهام المفتوحة (اختياري التصفية بالمشروع)
  let tasks = await getOpenTasks();
  if (project) tasks = tasks.filter((t) => (t.projectName ?? "شخصي") === project);
  if (tasks.length === 0) {
    return project ? `لا مهام مفتوحة لـ«${project}».` : "لا مهام مفتوحة.";
  }
  const bridges = await resolveBridges(tasks);
  const lines = tasks.map((t) => {
    const b = bridges.get(t.id);
    return (
      `• ${t.title} — ${t.projectName ?? "شخصي"} — ${KIND_LABELS[t.kind] ?? t.kind}` +
      (t.deferralCount > 0 ? ` — رُحّلت ${t.deferralCount}` : "") +
      (b ? ` (${b})` : "")
    );
  });
  return `المهام المفتوحة${project ? ` لـ«${project}»` : ""} (${tasks.length}):\n${lines.join("\n")}`;
}

/** يصوغ سطراً موجزاً لإحصاء الأسبوع (للعرض في المذكرة). */
export function formatWeeklyStats(s: WeeklyTaskStats): string {
  const kinds = Object.entries(s.doneByKind)
    .map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n}`)
    .join("، ");
  const projects = Object.entries(s.doneByProject)
    .map(([k, n]) => `${k} ${n}`)
    .join("، ");
  return [
    `خُطّط ${s.planned} · أُنجز ${s.done} · رُحّل ${s.deferred}`,
    kinds ? `حسب النوع: ${kinds}` : "",
    projects ? `حسب المشروع: ${projects}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskStep, TaskKind } from "@/lib/capture/task";
import { OWNER_TZ, ownerTzOffset } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// استعلامات مدير اليوم (الملف 11 — المرحلة ٢) + توقيت المالك.
// طبقة قاعدة البيانات للطقس والمحرك: المهام المفتوحة، الخطط، تحديث الحالات،
// إحصاء الإنجاز وموازنة المشاريع. كلها عبر service_role (cron/تيليجرام بلا جلسة).
// ════════════════════════════════════════════════════════════

/** تاريخ يوم المالك (منطقته الزمنية) بصيغة YYYY-MM-DD، مع إزاحة أيام اختيارية (الغد = 1). */
export function ownerDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** عرض عربي لتاريخ (السبت 11 يونيو) من YYYY-MM-DD. */
export function ownerDisplayDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00${ownerTzOffset(new Date(`${dateStr}T12:00:00Z`))}`); // ظهر توقيت المالك — يتجنّب حافة المنطقة
  return new Intl.DateTimeFormat("ar", {
    timeZone: OWNER_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

export type OpenTask = {
  id: string;
  title: string;
  steps: TaskStep[];
  kind: TaskKind;
  projectName: string | null;
  deferralCount: number;
  createdAt: string;
  relatedItemId: string | null;
  relatedDecisionId: string | null;
};

export type DayPlanRow = {
  id: string;
  planDate: string;
  status: "draft" | "active";
  exception: string | null;
  awaitingException: boolean;
  why: string | null;
  taskIds: string[];
  builtVia: "evening" | "morning_fallback";
};

type RawTask = {
  id: string;
  title: string;
  steps: TaskStep[] | null;
  kind: TaskKind;
  deferrals: unknown[] | null;
  created_at: string;
  related_item_id?: string | null;
  related_decision_id?: string | null;
  projects: { name: string } | { name: string }[] | null;
};

function projectName(p: RawTask["projects"]): string | null {
  if (!p) return null;
  return Array.isArray(p) ? (p[0]?.name ?? null) : p.name;
}

/** المهام المفتوحة (inbox أو planned) — مرشّحات محرك خطة الغد. */
export async function getOpenTasks(): Promise<OpenTask[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select(
      "id, title, steps, kind, deferrals, created_at, related_item_id, related_decision_id, projects(name)",
    )
    .in("status", ["inbox", "planned"])
    .order("created_at", { ascending: true });

  return ((data ?? []) as RawTask[]).map((t) => ({
    id: t.id,
    title: t.title,
    steps: Array.isArray(t.steps) ? t.steps : [],
    kind: t.kind,
    projectName: projectName(t.projects),
    deferralCount: Array.isArray(t.deferrals) ? t.deferrals.length : 0,
    createdAt: t.created_at,
    relatedItemId: t.related_item_id ?? null,
    relatedDecisionId: t.related_decision_id ?? null,
  }));
}

export type ReviewTask = { id: string; title: string; status: string };

/** مهام الخطة لمراجعة الطقس (عنوان + حالة حيّة)، بترتيب المعرّفات. */
export async function getReviewTasks(ids: string[]): Promise<ReviewTask[]> {
  if (ids.length === 0) return [];
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status")
    .in("id", ids);
  const byId = new Map<string, ReviewTask>();
  for (const t of (data ?? []) as ReviewTask[]) {
    byId.set(t.id, { id: t.id, title: t.title, status: t.status });
  }
  return ids.map((id) => byId.get(id)).filter((t): t is ReviewTask => !!t);
}

function mapPlan(row: Record<string, unknown> | null): DayPlanRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    planDate: row.plan_date as string,
    status: row.status as "draft" | "active",
    exception: (row.exception as string) ?? null,
    awaitingException: row.awaiting_exception === true,
    why: (row.why as string) ?? null,
    taskIds: Array.isArray(row.task_ids) ? (row.task_ids as string[]) : [],
    builtVia: row.built_via as "evening" | "morning_fallback",
  };
}

/** خطة يوم بتاريخه (أو null). */
export async function getPlan(planDate: string): Promise<DayPlanRow | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("day_plans")
    .select("*")
    .eq("plan_date", planDate)
    .maybeSingle();
  return mapPlan(data as Record<string, unknown> | null);
}

/** يثبّت/يحدّث خطة يوم فعّالة (upsert على plan_date الفريد). */
export async function upsertActivePlan(p: {
  planDate: string;
  exception: string | null;
  why: string | null;
  taskIds: string[];
  builtVia: "evening" | "morning_fallback";
}): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("day_plans").upsert(
    {
      plan_date: p.planDate,
      status: "active",
      exception: p.exception,
      awaiting_exception: false,
      why: p.why,
      task_ids: p.taskIds,
      built_via: p.builtVia,
    },
    { onConflict: "plan_date" },
  );
}

/** ينشئ/يحدّث مسوّدة بانتظار نص حرّ لاستثناء يوم (طقس قيد التنفيذ). */
export async function setAwaitingException(planDate: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("day_plans").upsert(
    {
      plan_date: planDate,
      status: "draft",
      awaiting_exception: true,
    },
    { onConflict: "plan_date" },
  );
}

/** يعيد مسوّدة الغد المنتظِرة لاستثناء حرّ إن وُجدت. */
export async function getAwaitingDraft(): Promise<DayPlanRow | null> {
  const tomorrow = ownerDateString(1);
  const plan = await getPlan(tomorrow);
  return plan && plan.status === "draft" && plan.awaitingException ? plan : null;
}

// ── تحديث حالات المهام (مراجعة الطقس) ──────────────────────
export async function markTaskDone(id: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("tasks")
    .update({ status: "done", done_at: new Date().toISOString() })
    .eq("id", id);
}

export async function dropTask(id: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("tasks").update({ status: "dropped" }).eq("id", id);
}

/** يرحّل مهمة: يضيف تاريخ اليوم بتوقيت المالك لمصفوفة الترحيل ويعيدها inbox. يُرجع العدّ الجديد. */
export async function deferTask(id: string): Promise<number> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select("deferrals")
    .eq("id", id)
    .maybeSingle();
  const current = Array.isArray(data?.deferrals) ? (data!.deferrals as unknown[]) : [];
  const next = [...current, ownerDateString(0)];
  await supabase
    .from("tasks")
    .update({ status: "inbox", deferrals: next })
    .eq("id", id);
  return next.length;
}

// ── المواجهة عند الترحيل المتكرّر (المرحلة ٣) ──────────────
/** يخزّن العائق الذي كشفه المالك ويُطفئ علم الانتظار. */
export async function setTaskBlocker(id: string, blocker: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("tasks")
    .update({ blocker: blocker.trim(), awaiting_blocker: false })
    .eq("id", id);
}

/** يضع المهمة في انتظار نصّ العائق (الرسالة التالية تُعامَل كعائق). */
export async function setAwaitingBlocker(id: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("tasks").update({ awaiting_blocker: true }).eq("id", id);
}

/** يعيد المهمة المنتظِرة لنصّ عائق (إن وُجدت) — عنوانها ومعرّفها. */
export async function getTaskAwaitingBlocker(): Promise<{ id: string; title: string } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("awaiting_blocker", true)
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id as string, title: data.title as string } : null;
}

/** يستبدل خطوات مهمة (لإعادة التفكيك أصغر بعد المواجهة). */
export async function updateTaskSteps(id: string, steps: TaskStep[]): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("tasks").update({ steps }).eq("id", id);
}

/** يضع مهام الخطة المختارة في حالة planned. */
export async function setTasksPlanned(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const supabase = createAdminClient();
  await supabase.from("tasks").update({ status: "planned" }).in("id", ids);
}

// ── حالة خط المحتوى (الملف 13 — البند ٥) ───────────────────
// عينا محرّك الخطة على خط النشر: بدونها مبدأ «موازنة المماطلة» يعمل بلا ذخيرة —
// يقترح «مهمة محتوى» مجرّدة بينما توجد مسودة جاهزة تنتظر النشر.
export type ContentPipelineStats = {
  draftCount: number;
  topDraft: { excerpt: string; quality: number | null } | null;
  daysSinceLastPublish: number | null; // null = لا منشورات بعد
};

export async function getContentPipelineStats(): Promise<ContentPipelineStats> {
  const supabase = createAdminClient();

  const [{ count: draftCount }, { data: top }, { data: last }] = await Promise.all([
    supabase.from("posts").select("*", { count: "exact", head: true }).eq("status", "draft"),
    supabase
      .from("posts")
      .select("hook_text, draft_text, quality_score")
      .eq("status", "draft")
      .order("quality_score", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("posts")
      .select("published_at")
      .eq("status", "published")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let topDraft: ContentPipelineStats["topDraft"] = null;
  if (top) {
    const raw = (top.hook_text as string | null) || (top.draft_text as string) || "";
    const t = raw.replace(/\s+/g, " ").trim();
    topDraft = {
      excerpt: t.length <= 60 ? t : t.slice(0, 60).trim() + "…",
      quality: typeof top.quality_score === "number" ? top.quality_score : null,
    };
  }

  let daysSinceLastPublish: number | null = null;
  if (last?.published_at) {
    const ms = Date.now() - new Date(last.published_at as string).getTime();
    daysSinceLastPublish = Math.max(0, Math.floor(ms / 86_400_000));
  }

  return { draftCount: draftCount ?? 0, topDraft, daysSinceLastPublish };
}

// ── إحصاء الإنجاز وموازنة المشاريع (آخر ١٤ يوماً) ──────────
export type RecentStats = {
  doneCount: number;
  plannedCount: number;
  doneByKind: Record<string, number>;
  doneByProject: Record<string, number>;
};

export async function recentStats(): Promise<RecentStats> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const { data: done } = await supabase
    .from("tasks")
    .select("kind, projects(name)")
    .eq("status", "done")
    .gte("done_at", since);

  const doneByKind: Record<string, number> = {};
  const doneByProject: Record<string, number> = {};
  for (const t of (done ?? []) as RawTask[]) {
    doneByKind[t.kind] = (doneByKind[t.kind] ?? 0) + 1;
    const proj = projectName(t.projects) ?? "شخصي";
    doneByProject[proj] = (doneByProject[proj] ?? 0) + 1;
  }

  const sinceDate = ownerDateString(-14);
  const { data: plans } = await supabase
    .from("day_plans")
    .select("task_ids")
    .gte("plan_date", sinceDate);
  let plannedCount = 0;
  for (const p of (plans ?? []) as { task_ids: unknown[] }[]) {
    plannedCount += Array.isArray(p.task_ids) ? p.task_ids.length : 0;
  }

  const doneCount = ((done ?? []) as unknown[]).length;
  return { doneCount, plannedCount, doneByKind, doneByProject };
}

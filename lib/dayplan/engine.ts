import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { proJson } from "@/lib/ai/gemini";
import {
  ownerDisplayDate,
  getOpenTasks,
  upsertActivePlan,
  setTasksPlanned,
  recentStats,
  getContentPipelineStats,
  type OpenTask,
  type ContentPipelineStats,
} from "@/lib/dayplan/queries";
import type { TaskStep } from "@/lib/capture/task";
import { PROJECT_MAIN, PROJECT_SECOND, PROJECT_PERSONAL } from "@/lib/capture/task";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// محرك الأولوية المركّب (الملف 11 — المرحلة ٢): قلب الذكاء.
// نداء Pro واحد يستلم المهام المفتوحة + سياق حياة المالك + حالة المشروع + الإحصاء،
// ويختار ٣ مهام واقعية (واحدة عميقة في نافذة التركيز + خفيفتان) بسطر «لماذا». لا يخترع مهاماً.
// ════════════════════════════════════════════════════════════

// قراءة ملفات السياق بمسارات حرفية (لتُتعقّب وتُحزَم في نشر Vercel — كما في classify.ts).
let _lifeCtx: string | null = null;
async function loadLifeContext(): Promise<string> {
  if (_lifeCtx !== null) return _lifeCtx;
  try {
    _lifeCtx = await readFile(
      path.join(process.cwd(), "data", "life-context.md"),
      "utf8",
    );
  } catch {
    _lifeCtx = "";
  }
  return _lifeCtx;
}

let _projCtx: string | null = null;
async function loadProjectContext(): Promise<string> {
  if (_projCtx !== null) return _projCtx;
  try {
    _projCtx = await readFile(
      path.join(process.cwd(), "data", "context.md"),
      "utf8",
    );
  } catch {
    _projCtx = "";
  }
  return _projCtx;
}

// يوم استثنائي بلا عمق (سفر/ترفيه) — حدّ صلب فوق حكم النموذج.
function isLightDay(exception: string | null): boolean {
  return exception === "سفر" || exception === "ترفيه";
}

const SYSTEM = `أنت «مخطّط يوم ${OWNER_NAME}» في نظام «عقل ${OWNER_NAME}». مهمتك بناء خطة يوم واقعية من مهامه المفتوحة فقط.

مبادئ حاكمة (التزم بها حرفياً):
- القاعدة الذهبية: المهام مفكّكة مسبقاً لخطوات — أنت تختار وترتّب، لا تعيد التفكيك.
- الواقعية فوق الطموح: التزم بحدود طاقته اليومية الواردة في «سياق حياته» أدناه وبمعدّل إنجازه الفعلي. يوم عادي = ٣ مهام: واحدة عميقة + اثنتان أخفّ. لا تزد.
- النافذة الذهبية للمهمة العميقة وساعات العمل المسموحة كما يحدّدها «سياق حياته» أدناه؛ إن لم يذكرها فاعتمد ١١ صباحاً–٣ مساءً للعمق ولا تجدول عملاً مهماً قبل ١٠ص أو بعد ٧م.
- يوم استثنائي (سفر/ترفيه): ٠ أو مهمة واحدة خفيفة جداً (من الجوال)، بلا مهمة عميقة.
- موازنة المماطلة: كثيرون يفضّلون البناء ويؤجّلون التسويق/التواصل/المحتوى — وهي غالباً ما يحتاجه المشروع. راجع إحصاء الإنجاز حسب النوع؛ إن كانت أيامه الأخيرة بناءً (build) غالباً، صعّد مهمة «احتكاك» (market/content) ولو بخطوة أولى مخفّفة.
- خط المحتوى: يصلك سطر حالته (مسودات جاهزة + أيام منذ آخر نشر). حين توجد مسودة جاهزة عالية الجودة ومرّت أيام بلا نشر ومهمة محتوى مرشّحة — رجّحها؛ فنشر الجاهز أخفّ خطوة احتكاك وأعلاها أثراً.
- موازنة ٥٠/٥٠ بين مشروعيه (${PROJECT_MAIN} و${PROJECT_SECOND}) عبر الأسبوع — صحّح الانحراف حين يظهر في الإحصاء.

اختر من المهام المفتوحة المعطاة حصراً (لا تخترع مهاماً، استخدم task_id كما هو). أعد JSON فقط بهذا الشكل:
{
  "selected": [
    { "task_id": "<من القائمة>", "deep": true, "window": "11:00–15:00", "reason_tag": "كلمة-كلمتان" }
  ],
  "why": "سطر واحد موجز يبرّر تركيبة اليوم"
}
قواعد المخرج: مهمة عميقة واحدة كحدّ أقصى (deep=true) ولها window في ١١-٣؛ البقية deep=false وwindow="" (نصّ فارغ). رتّب العميقة أولاً. يوم استثنائي → ٠-١ مهمة، كلها deep=false. أعد JSON فقط بلا أي نص إضافي.`;

// مخطط الإخراج المنظّم (الدستور §٣-١) — يضمن JSON صالحاً رغم عناوين المهام العربية
// التي قد تحوي اقتباسات. window نصّ لا null: المخطط المقيَّد لا يحتمل حقلاً اتحادياً هنا،
// والنصّ الفارغ يُترجَم إلى null في parseSelection أصلاً (لذا «window=""» في البرومبت أعلاه).
const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    selected: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          deep: { type: "boolean" },
          window: { type: "string" },
          reason_tag: { type: "string" },
        },
        required: ["task_id", "deep", "window", "reason_tag"],
      },
    },
    why: { type: "string" },
  },
  required: ["selected", "why"],
};

// سطر حالة خط المحتوى — يُحقن في الحمولة ويُلحق برسالة الخطة (الملف 13، البند ٥).
function contentStateLines(c: ContentPipelineStats): string {
  const drafts =
    c.draftCount > 0
      ? `- مسودات جاهزة للنشر: ${c.draftCount}` +
        (c.topDraft
          ? ` — أعلاها: «${c.topDraft.excerpt}»${c.topDraft.quality != null ? ` (جودة ${c.topDraft.quality})` : ""}`
          : "")
      : "- لا مسودات جاهزة للنشر.";
  const lastPub =
    c.daysSinceLastPublish === null
      ? "- لا منشورات منشورة بعد."
      : `- آخر نشر: قبل ${c.daysSinceLastPublish} يوم/أيام.`;
  return `${drafts}\n${lastPub}`;
}

function buildUserPayload(
  planDate: string,
  exception: string | null,
  openTasks: OpenTask[],
  stats: Awaited<ReturnType<typeof recentStats>>,
  content: ContentPipelineStats,
  targetCount: number,
  lifeCtx: string,
  projCtx: string,
): string {
  const taskLines = openTasks
    .map(
      (t) =>
        `- [${t.id}] «${t.title}» | مشروع: ${t.projectName ?? PROJECT_PERSONAL} | نوع: ${t.kind} | رُحّلت: ${t.deferralCount} مرّة | خطوات: ${t.steps.length}`,
    )
    .join("\n");

  const byKind = Object.entries(stats.doneByKind)
    .map(([k, n]) => `${k}: ${n}`)
    .join("، ") || "لا بيانات";
  const byProject = Object.entries(stats.doneByProject)
    .map(([k, n]) => `${k}: ${n}`)
    .join("، ") || "لا بيانات";

  return `## تاريخ الخطة: ${planDate} (${ownerDisplayDate(planDate)})
## استثناء الغد: ${exception ?? "لا شيء (يوم عادي)"}
## عدد المهام المطلوب اليوم: ${targetCount} كحدّ أقصى (مبنيّ على معدل إنجاز ${OWNER_NAME} الفعلي — لا تتجاوزه)

## المهام المفتوحة (اختر منها):
${taskLines || "(لا مهام مفتوحة)"}

## إحصاء آخر ١٤ يوماً:
- أُنجز: ${stats.doneCount} من ${stats.plannedCount} مخطّطة
- الإنجاز حسب النوع: ${byKind}
- الإنجاز حسب المشروع (لموازنة ٥٠/٥٠): ${byProject}

## حالة خط المحتوى:
${contentStateLines(content)}

## سياق حياة ${OWNER_NAME} (حدوده اليومية — التزم بها):
${lifeCtx}

## حالة المشروع ومشاريعه (للترجيح):
${projCtx}`;
}

type Selected = { task_id: string; deep: boolean; window: string | null };

function parseSelection(
  raw: string,
  openTasks: OpenTask[],
  exception: string | null,
  targetCount: number,
): { selected: Selected[]; why: string | null } {
  const byId = new Map(openTasks.map((t) => [t.id, t]));
  try {
    const root = JSON.parse(raw) as unknown;
    // فكّ تغليف المصفوفة دفاعياً (Gemini قد يُرجع [{...}]) — الدستور §٤ الفخّ ٤.
    const p = (Array.isArray(root) ? (root[0] ?? {}) : root) as {
      selected?: unknown;
      why?: unknown;
    };
    const arr = Array.isArray(p.selected) ? p.selected : [];
    let selected: Selected[] = [];
    for (const s of arr) {
      const o = (s ?? {}) as Record<string, unknown>;
      const id = String(o.task_id ?? "");
      if (!byId.has(id)) continue; // تجاهل أي معرّف مخترع
      if (selected.some((x) => x.task_id === id)) continue; // بلا تكرار
      selected.push({
        task_id: id,
        deep: o.deep === true,
        window:
          typeof o.window === "string" && o.window.trim() ? o.window.trim() : null,
      });
    }

    // حدود صلبة: يوم خفيف → بلا عمق؛ غير ذلك → حتى targetCount بحدّ عميقة واحدة.
    if (isLightDay(exception)) {
      selected = selected.slice(0, targetCount).map((s) => ({ ...s, deep: false, window: null }));
    } else {
      selected = selected.slice(0, targetCount);
      let deepSeen = false;
      selected = selected.map((s) => {
        if (s.deep && !deepSeen) {
          deepSeen = true;
          return { ...s, window: s.window ?? "11:00–15:00" };
        }
        return { ...s, deep: false, window: null };
      });
    }

    // العميقة أولاً
    selected.sort((a, b) => Number(b.deep) - Number(a.deep));

    const why = typeof p.why === "string" && p.why.trim() ? p.why.trim() : null;
    return { selected, why };
  } catch {
    return { selected: [], why: null };
  }
}

function stepLine(s: TaskStep): string {
  return `${s.text} (${s.est_minutes} د)`;
}

function renderTask(task: OpenTask, sel: Selected, index: number): string {
  const head = sel.deep
    ? `${index}. 🎯 ${task.title}   ⏰ ${sel.window}`
    : `${index}. ${task.title}`;
  const lines = [head];
  const steps = task.steps;
  if (steps.length > 0) {
    lines.push(`   ▶️ ابدأ: ${stepLine(steps[0])}`);
    for (const s of steps.slice(1)) lines.push(`   • ${stepLine(s)}`);
  }
  return lines.join("\n");
}

export type DayPlanOutput = { message: string; pin: boolean };

/**
 * يبني خطة يوم ويحفظها (active) ويضع مهامها planned. يُرجع رسالة جاهزة للإرسال.
 * pin=true حين توجد خطة فعلية تستحق التثبيت أعلى المحادثة.
 */
export async function buildDayPlan(
  planDate: string,
  exception: string | null,
  builtVia: "evening" | "morning_fallback",
): Promise<DayPlanOutput> {
  const display = ownerDisplayDate(planDate);
  const openTasks = await getOpenTasks();

  if (openTasks.length === 0) {
    await upsertActivePlan({ planDate, exception, why: null, taskIds: [], builtVia });
    return {
      message: `📅 خطة اليوم — ${display}\n\nما فيه مهام مفتوحة لتخطيطها. أرسل مهامك عبر تيليجرام وسأبني خطتك.`,
      pin: false,
    };
  }

  const [stats, content, lifeCtx, projCtx] = await Promise.all([
    recentStats(),
    getContentPipelineStats(),
    loadLifeContext(),
    loadProjectContext(),
  ]);

  // معدل الإنجاز المتعلَّم (المرحلة ٣): يعاير عدد مهام اليوم على الواقع لا الطموح.
  // يُفعَّل فقط مع بيانات كافية (~أسبوعان) — قبلها 3 افتراضاً.
  const lightDay = isLightDay(exception);
  const enoughData = stats.plannedCount >= 12;
  const rate = stats.plannedCount > 0 ? stats.doneCount / stats.plannedCount : null;
  const targetCount = lightDay ? 1 : enoughData && rate !== null && rate < 0.7 ? 2 : 3;
  const adjustedDown = !lightDay && targetCount < 3;

  const res = await proJson(
    buildUserPayload(
      planDate,
      exception,
      openTasks,
      stats,
      content,
      targetCount,
      lifeCtx,
      projCtx,
    ),
    SYSTEM,
    PLAN_SCHEMA,
  );
  if (!res.ok) console.error(`[dayplan] فشل proJson: ${res.error}`);

  // فشل النداء → خطة بديلة بسيطة (أحدث المهام) كي لا يبقى المالك بلا خطة.
  let selected: Selected[];
  let why: string | null;
  if (!res.ok) {
    selected = openTasks.slice(0, targetCount).map((t, i) => ({
      task_id: t.id,
      deep: !lightDay && i === 0,
      window: !lightDay && i === 0 ? "11:00–15:00" : null,
    }));
    why = "خطة احتياطية (تعذّر بناء الخطة الذكية) — راجعها وعدّلها.";
  } else {
    const parsed = parseSelection(res.data, openTasks, exception, targetCount);
    selected = parsed.selected;
    why = parsed.why;
  }

  if (selected.length === 0) {
    await upsertActivePlan({ planDate, exception, why, taskIds: [], builtVia });
    const note = isLightDay(exception)
      ? `يوم ${exception} — استرح. صفر عمل جدّي اليوم.`
      : "ما اخترت مهام اليوم — راجع مهامك المفتوحة.";
    return { message: `📅 خطة اليوم — ${display}\n\n${note}`, pin: false };
  }

  const taskById = new Map(openTasks.map((t) => [t.id, t]));
  const orderedIds = selected.map((s) => s.task_id);

  await upsertActivePlan({ planDate, exception, why, taskIds: orderedIds, builtVia });
  await setTasksPlanned(orderedIds);

  const header = exception
    ? `📅 خطة اليوم — ${display}\n⚠️ استثناء: ${exception} — يوم خفيف`
    : `📅 خطة اليوم — ${display}`;

  const body = selected
    .map((s, i) => renderTask(taskById.get(s.task_id)!, s, i + 1))
    .join("\n\n");

  const whyLine = why ? `\n\n💡 لماذا: ${why}` : "";
  // مصارحة معدل الإنجاز (المرحلة ٣): حين نخطّط أقلّ من ٣ بناءً على أدائه الفعلي.
  const rateLine = adjustedDown
    ? `\n📉 خطّطت ${targetCount} مهام لا ٣ — أخطط على معدلك الفعلي (${stats.doneCount}/${stats.plannedCount} آخر أسبوعين).`
    : "";
  // اقتراح النشر (الملف 13 — البند ٥): الرسالة المثبتة مركز قيادة اليوم،
  // فسطر «جاهز للنشر» فيها يغني عن فتح تبويب الرؤى. لا يظهر في يوم خفيف.
  const publishLine =
    !lightDay && content.topDraft
      ? `\n📮 جاهز للنشر: «${content.topDraft.excerpt}»${content.topDraft.quality != null ? ` (جودة ${content.topDraft.quality})` : ""} — في «المحتوى».`
      : "";

  return { message: `${header}\n\n${body}${whyLine}${rateLine}${publishLine}`, pin: true };
}

import "server-only";
import { flashJson } from "@/lib/ai/gemini";
import { processIncomingItem, type SourceType } from "@/lib/capture/process";
import {
  insertTask,
  normalizeSteps,
  truncate,
  TASK_KINDS,
  TASK_PROJECTS,
  PROJECT_PERSONAL,
  type TaskFields,
  type TaskKind,
  type TaskProject,
} from "@/lib/capture/task";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// تفصيل الالتقاط (الملف 11 — المرحلة ١).
// الرسالة الواحدة (خصوصاً المُفرّغة من صوت) قد تحمل عدة عناصر مختلطة:
// مهمتان، أو مهمة + فكرة… نداء flash واحد يفصلها ويصنّف كلاً (task/item)،
// ثم نوجّه: المهام → جدول tasks (مُستخرجة)، والأفكار → العقل المشترك
// processIncomingItem (يصنّف ويحسب embedding — فلا ازدواج تصنيف).
// ════════════════════════════════════════════════════════════

export type CapturedTask = {
  title: string;
  projectName: string | null;
  stepCount: number;
};
// id/text يحتاجهما اقتراح توثيق القرار (الملف 13 — البند ٢): الفحص على نصّ
// العنصر الفعلي بعد التفصيل، والتأكيد يعيد الاستخراج من صفّه بالمعرّف.
export type CapturedItem = { topic?: string; id?: string; text?: string };
export type CaptureOutcome = { tasks: CapturedTask[]; items: CapturedItem[] };

type RawSegment =
  | ({ type: "task" } & TaskFields)
  | { type: "item"; text: string };

type SegmentOptions = {
  isVoice: boolean;
  sourceUrl?: string;
  forced: boolean;
};

function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/i)?.[0];
}

// نوع المصدر لعنصر فكرة (مطابق لمنطق الـwebhook الأصلي).
function itemSourceType(text: string, opts: SegmentOptions): {
  sourceType: SourceType;
  sourceUrl?: string;
} {
  if (opts.isVoice) return { sourceType: "voice" };
  const url = firstUrl(text) ?? opts.sourceUrl;
  return url ? { sourceType: "signal", sourceUrl: url } : { sourceType: "idea" };
}

function buildSegmentPrompt(text: string, forced: boolean): string {
  const forcedLine = forced
    ? `- وسم ${OWNER_NAME} هذه الرسالة كمهمة صراحةً (/مهمة) — رجّح تصنيف عناصرها كمهام ما لم تكن فكرة واضحة.\n`
    : "";
  return `أنت مساعد التقاط في نظام «عقل ${OWNER_NAME}». تستلم رسالة من ${OWNER_NAME} (قد تكون مُفرّغة من تسجيل صوتي)، وقد تحتوي عنصراً واحداً أو عدة عناصر مختلطة (مهام وأفكار معاً).

افصل الرسالة إلى عناصر مستقلة. لكل عنصر قرّر نوعه:
- "task" — التزام أو عمل يريد ${OWNER_NAME} تنفيذه (فعل + نيّة: «لازم أراسل»، «بكرة أجهّز»).
- "item" — فكرة أو ملاحظة أو رؤية أو إشارة، بلا التزام تنفيذي.

أعد JSON فقط (بلا أي نص أو markdown) بهذا الشكل حصراً:
{
  "segments": [
    {
      "type": "task",
      "title": "عنوان موجز ٣–٧ كلمات",
      "project": "المشروع" أو "العمل" أو "شخصي",
      "kind": "build" أو "market" أو "content" أو "admin" أو "personal",
      "time_signal": "إشارة زمنية كما وردت أو null",
      "steps": [ { "text": "خطوة فعل واضحة جاهزة للبدء", "est_minutes": 30 } ]
    },
    {
      "type": "item",
      "text": "نصّ الفكرة كما قالها ${OWNER_NAME}"
    }
  ]
}

قواعد:
- project: «المشروع» مشروع المالك الرئيسي كما يصفه سياقه · «العمل» عمله أو التزاماته الأخرى · «شخصي» إن لم يتّضح أو كانت شخصية.
- kind: build بناء/برمجة · market تسويق/نشر/تواصل عملاء · content كتابة محتوى · admin إدارية · personal شخصية.
- فكّك كل مهمة لخطوات صغيرة جداً جاهزة للبدء الفوري؛ الخطوة الأولى واضحة لدرجة لا تحتاج تفكيراً. مهمة صغيرة = خطوة أو خطوتان؛ كبيرة = ٣–٦. لا تترك steps فارغة.
- للأفكار: احفظ نصّ ${OWNER_NAME} كما هو (نظّفه من حشو الكلام الصوتي فقط مثل «يعني/اها»، واحفظ المعنى والصياغة) — لا تختصره لعنوان، فسيُفهرس دلالياً.
- لا تخلط عنصرين في واحد، ولا تشطر عنصراً واحداً متماسكاً. إن كانت الرسالة عنصراً واحداً فأعد مصفوفة من عنصر واحد.
${forcedLine}
النص:
"""
${text}
"""`;
}

/** يفصل الرسالة لعناصر مصنّفة عبر نداء flash واحد. يُرجع null عند أي فشل (يفعّل التراجع). */
async function segment(text: string, forced: boolean): Promise<RawSegment[] | null> {
  const res = await flashJson(buildSegmentPrompt(text, forced));
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.data) as { segments?: unknown };
    if (!Array.isArray(parsed.segments)) return null;

    const out: RawSegment[] = [];
    for (const s of parsed.segments) {
      const o = (s ?? {}) as Record<string, unknown>;
      if (o.type === "task") {
        const title = typeof o.title === "string" ? o.title.trim() : "";
        const steps = normalizeSteps(o.steps);
        if (!title && steps.length === 0) continue; // مهمة فارغة تماماً → تجاهل
        out.push({
          type: "task",
          title,
          project: TASK_PROJECTS.includes(o.project as TaskProject)
            ? (o.project as TaskProject)
            : PROJECT_PERSONAL,
          kind: TASK_KINDS.includes(o.kind as TaskKind)
            ? (o.kind as TaskKind)
            : "admin",
          time_signal:
            typeof o.time_signal === "string" && o.time_signal.trim()
              ? o.time_signal.trim()
              : null,
          steps,
        });
      } else {
        const t = String(o.text ?? "").trim();
        if (t) out.push({ type: "item", text: t });
      }
    }
    return out;
  } catch {
    return null;
  }
}

// تراجع آمن إن فشل التفصيل: عنصر واحد لا يُفقد.
// مفروضة (/مهمة) → مهمة خام بخطوة واحدة؛ غير ذلك → فكرة عبر العقل المشترك.
async function fallbackSingle(
  text: string,
  opts: SegmentOptions,
): Promise<CaptureOutcome> {
  if (opts.forced) {
    const r = await insertTask(
      {
        title: truncate(text, 80),
        project: PROJECT_PERSONAL,
        kind: "admin",
        time_signal: null,
        steps: [{ text: truncate(text, 100), est_minutes: 30, done: false }],
      },
      "telegram",
    );
    return {
      tasks: [{ title: r.title, projectName: r.projectName, stepCount: r.stepCount }],
      items: [],
    };
  }
  const { sourceType, sourceUrl } = itemSourceType(text, opts);
  const r = await processIncomingItem(text, sourceType, sourceUrl);
  return { tasks: [], items: [{ topic: r.topic, id: r.id, text }] };
}

/**
 * يفصل الرسالة ويعالج كل عنصر إلى جدوله. الأفكار تمرّ على العقل المشترك
 * (تصنيف + embedding)، والمهام تُدرَج مباشرة. يُرجع حصيلة منظّمة للردّ.
 */
export async function segmentAndProcess(
  text: string,
  opts: SegmentOptions,
): Promise<CaptureOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { tasks: [], items: [] };

  const segs = await segment(trimmed, opts.forced);
  if (!segs || segs.length === 0) return fallbackSingle(trimmed, opts);

  // مستقلّة → تُعالَج بالتوازي (مستخدم واحد، عدد عناصر صغير — لا طوابير).
  const processed = await Promise.all(
    segs.map(async (s) => {
      if (s.type === "task") {
        const r = await insertTask(s, "telegram");
        return {
          kind: "task" as const,
          task: { title: r.title, projectName: r.projectName, stepCount: r.stepCount },
        };
      }
      const { sourceType, sourceUrl } = itemSourceType(s.text, opts);
      const r = await processIncomingItem(s.text, sourceType, sourceUrl);
      return { kind: "item" as const, item: { topic: r.topic, id: r.id, text: s.text } };
    }),
  );

  const tasks: CapturedTask[] = [];
  const items: CapturedItem[] = [];
  for (const p of processed) {
    if (p.kind === "task") tasks.push(p.task);
    else items.push(p.item);
  }
  return { tasks, items };
}

// صياغة عربية لعدد (مفرد/مثنى/جمع) — للعدّ في رأس الردّ.
function arabicCount(n: number, one: string, two: string, plural: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${plural}`;
}

function stepsLabel(n: number): string {
  if (n === 1) return "خطوة واحدة";
  if (n === 2) return "خطوتين";
  return `${n} خطوات`;
}

/** يبني ردّ تأكيد يعدّد ما التُقط: «مهمتان ✓ + فكرة ✓» + تفصيل سطر لكلٍّ. */
export function buildCaptureReply(o: CaptureOutcome): string {
  const t = o.tasks.length;
  const i = o.items.length;
  if (t === 0 && i === 0) {
    return "لم ألتقط شيئاً واضحاً — أعد الصياغة من فضلك.";
  }

  const head: string[] = [];
  if (t > 0) head.push(`${arabicCount(t, "مهمة", "مهمتان", "مهام")} ✓`);
  if (i > 0) head.push(`${arabicCount(i, "فكرة", "فكرتان", "أفكار")} ✓`);

  const lines = [head.join(" + ")];
  for (const task of o.tasks) {
    const proj = task.projectName ?? PROJECT_PERSONAL;
    lines.push(`• مهمة: ${task.title} — ${proj} — ${stepsLabel(task.stepCount)}`);
  }
  for (const item of o.items) {
    lines.push(`• فكرة: ${item.topic ?? "حُفظت خاماً"}`);
  }
  return lines.join("\n");
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { flashJson } from "@/lib/ai/gemini";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// التقاط المهام (الملف 11 — المرحلة ١) — لبِنات مشتركة.
// المهمة تُخزّن في جدول tasks لا items، مفكّكة لخطوات صغيرة (القاعدة الذهبية).
// هذا الملف: الأنواع + كشف نيّة المهمة + تطبيع الخطوات + الإدراج.
// منطق التفصيل والتوجيه (نداء flash واحد لعدة عناصر) في segment.ts.
// ════════════════════════════════════════════════════════════

// أنواع المهمة الخمسة (مطابقة لقيد tasks_kind_chk في 0013).
export const TASK_KINDS = [
  "build",
  "market",
  "content",
  "admin",
  "personal",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// المشروع كما يستخرجه المصنّف — يُربط لاحقاً بـ project_id (شخصي = null).
// الأسماء مطابقة لصفّي seed جدول projects (المشروع الرئيسي + العمل الثاني)؛ «شخصي» = بلا مشروع.
export const PROJECT_MAIN = "المشروع";
export const PROJECT_SECOND = "العمل";
export const PROJECT_PERSONAL = "شخصي";
export const TASK_PROJECTS = [PROJECT_MAIN, PROJECT_SECOND, PROJECT_PERSONAL] as const;
export type TaskProject = (typeof TASK_PROJECTS)[number];

// خطوة تنفيذية مفكّكة (مطابقة لشكل عمود steps في 0013).
export type TaskStep = { text: string; est_minutes: number; done: boolean };

// حقول المهمة المستخرجة الجاهزة للإدراج.
export type TaskFields = {
  title: string;
  project: TaskProject;
  kind: TaskKind;
  time_signal: string | null;
  steps: TaskStep[];
};

export type InsertedTask = {
  id: string;
  title: string;
  projectName: string | null; // null = شخصي
  stepCount: number;
};

// ───────────────────────────────────────────────
// كشف نيّة المهمة (بلا نداء ذكاء — حارس رخيص قبل flash).
// /مهمة → فرض صريح. غير ذلك: إشارات التزام/فعل تفتح بوابة التفصيل.
// ───────────────────────────────────────────────
const TASK_COMMAND = /^\/(?:مهمة|task)(?:\s|$)/i;

// إشارات التزام تنفيذي (لا «مهمة» وحدها — ملتبسة مع «نقطة مهمّة»). الكشف الخاطئ
// يُصحّح لاحقاً عبر التفصيل (يوجّه العنصر لجدول items).
const TASK_HINTS = [
  "لازم",
  "يجب",
  "بكرة",
  "بكره",
  "ذكرني",
  "ذكّرني",
  "لا تنسى",
  "لا أنسى",
  "محتاج",
  "أبي ",
  "أبغى",
  "ودي ",
  "اتصل",
  "راسل",
  "تواصل",
  "جهز",
  "جهّز",
  "أنجز",
  "todo",
];

/** هل بدأت الرسالة بأمر /مهمة الصريح؟ يعيد العلم والنص المجرّد من الأمر. */
export function detectTaskCommand(text: string): { forced: boolean; body: string } {
  if (TASK_COMMAND.test(text)) {
    return { forced: true, body: text.replace(TASK_COMMAND, "").trim() };
  }
  return { forced: false, body: text };
}

/** كشف تلقائي خفيف: هل تحمل الرسالة إشارة التزام تنفيذي؟ */
export function looksLikeTask(text: string): boolean {
  const t = text.toLowerCase();
  return TASK_HINTS.some((h) => t.includes(h.toLowerCase()));
}

/** يقصّ نصاً طويلاً مع «…» (لعناوين/خطوات احتياطية). */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max).trim() + "…";
}

/** يعيد تفكيك مهمة إلى خطوات أصغر (للمواجهة عند الترحيل المتكرّر — المرحلة ٣).
 *  نداء flash واحد يُرجع خطوات أدقّ من العنوان؛ يُرجع [] عند الفشل. */
export async function decomposeSteps(title: string): Promise<TaskStep[]> {
  const prompt = `فكّك المهمة التالية إلى خطوات تنفيذية أصغر وأدقّ مما سبق (${OWNER_NAME} رحّلها مراراً لأنها كبيرة/غامضة). كل خطوة صغيرة جداً، والأولى واضحة لدرجة لا تحتاج تفكيراً قبل البدء.

أعد JSON فقط: { "steps": [ { "text": "خطوة فعل واضحة", "est_minutes": 20 } ] }
اجعلها ٣–٦ خطوات صغيرة. لا تترك steps فارغة.

المهمة: «${title}»`;
  const res = await flashJson(prompt);
  if (!res.ok) return [];
  try {
    const p = JSON.parse(res.data) as { steps?: unknown };
    return normalizeSteps(p.steps);
  } catch {
    return [];
  }
}

/** يطبّع مصفوفة خطوات خام من JSON النموذج إلى TaskStep[] صالحة (done=false دائماً). */
export function normalizeSteps(raw: unknown): TaskStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const minutes = Number(o.est_minutes);
      return {
        text: String(o.text ?? "").trim(),
        est_minutes: Number.isFinite(minutes) ? Math.max(5, Math.round(minutes)) : 30,
        done: false,
      };
    })
    .filter((s) => s.text.length > 0);
}

// خريطة أسماء المشاريع → معرّفاتها (تُجلب مرّة وتُخزّن — المشروع/العمل ثابتان).
let _projectIds: Record<string, string> | null = null;
async function resolveProjectId(name: TaskProject): Promise<string | null> {
  if (name === PROJECT_PERSONAL) return null;
  if (!_projectIds) {
    const supabase = createAdminClient();
    const { data } = await supabase.from("projects").select("id, name");
    _projectIds = {};
    for (const r of data ?? []) {
      _projectIds[r.name as string] = r.id as string;
    }
  }
  return _projectIds[name] ?? null;
}

/**
 * يدرج مهمة مستخرجة في جدول tasks (status='inbox'). تراجع آمن:
 * عنوان فارغ → عنوان بديل، وخطوات فارغة → خطوة واحدة من العنوان (لا تُخزَّن مهمة بلا خطوة).
 * relatedItemId (اختياري): جسر لفكرة/مقال المصدر — يظهر «(من فكرة: …)» في الخطة والعقل.
 */
export async function insertTask(
  c: TaskFields,
  captureSource = "telegram",
  relatedItemId?: string,
): Promise<InsertedTask> {
  const title = c.title.trim() || "(مهمة بلا عنوان)";
  const steps = c.steps.length > 0
    ? c.steps
    : [{ text: title, est_minutes: 30, done: false }];
  const projectId = await resolveProjectId(c.project);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      title,
      steps,
      project_id: projectId,
      kind: c.kind,
      status: "inbox",
      time_signal: c.time_signal,
      capture_source: captureSource,
      related_item_id: relatedItemId ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("فشل حفظ المهمة: " + (error?.message ?? "غير معروف"));
  }

  return {
    id: data.id as string,
    title,
    projectName: c.project === PROJECT_PERSONAL ? null : c.project,
    stepCount: steps.length,
  };
}

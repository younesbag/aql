import "server-only";
import { flashJson } from "@/lib/ai/gemini";

export type Attributes = {
  hook_type: string;
  structure: string;
  emotion: string;
};

// ── مفردات مغلقة (الملف 25) ──────────────────────────────────
// كانت السمات نصّاً حرّاً، فتشظّت: قياس حيّ على ١٤ منشوراً أعطى أربع صيغ لنمط
// واحد («مشكلة ثم حل» · «المشكلة ثم الحل» · «طرح مشكلة وحلها» · «مشكلة وحل
// وتوجيه»). وgetPatternAggregates يجمّع بالنصّ الحرفي بعتبة ٣ منشورات — فما
// كانت مجموعة لتبلغها أبداً مهما صنّفنا. المفردات المغلقة تجعل التجميع ممكناً،
// والمخطط يفرضها فرضاً (فكّ تشفير مقيَّد) لا رجاءً في البرومبت.
export const HOOK_TYPES = [
  "سؤال مباشر",
  "إحصائية أو رقم",
  "اعتراف شخصي",
  "رأي مخالف",
  "خطأ شائع",
  "قصة أو موقف",
  "إعلان أو خبر",
  "وعد بنتيجة",
] as const;

export const STRUCTURES = [
  "مشكلة ثم حل",
  "قائمة خطوات",
  "مقارنة",
  "سرد زمني",
  "تفكيك مفهوم",
  "درس من تجربة",
] as const;

export const EMOTIONS = [
  "فضول",
  "إلحاح",
  "حماس",
  "تحدٍّ",
  "طمأنينة",
  "إحباط",
] as const;

const ATTR_SCHEMA = {
  type: "object",
  properties: {
    hook_type: { type: "string", enum: [...HOOK_TYPES] },
    structure: { type: "string", enum: [...STRUCTURES] },
    emotion: { type: "string", enum: [...EMOTIONS] },
  },
  required: ["hook_type", "structure", "emotion"],
} as const;

// يستخرج سمات منشور (نوع الخطاف، البنية، الشحنة العاطفية) عبر نداء Gemini واحد.
// يُستدعى عند إدخال الأداء — لا عند التوليد (توفير نداءات، كما يفرض الدستور).
export async function extractAttributes(
  text: string,
): Promise<Attributes | null> {
  const prompt = `حلّل المنشور التالي واستخرج سماته. اختر من القوائم المعطاة حصراً،
وإن لم ينطبق خيار انطباقاً تامّاً فاختر أقربها — التصنيف للتجميع الإحصائي لا للوصف الدقيق.

المنشور:
"""
${text}
"""`;

  const res = await flashJson(prompt, ATTR_SCHEMA as unknown as Record<string, unknown>);
  if (!res.ok) return null;
  try {
    const p = JSON.parse(res.data) as Partial<Attributes>;
    if (
      typeof p.hook_type !== "string" ||
      typeof p.structure !== "string" ||
      typeof p.emotion !== "string"
    ) {
      return null;
    }
    return {
      hook_type: p.hook_type,
      structure: p.structure,
      emotion: p.emotion,
    };
  } catch {
    return null;
  }
}

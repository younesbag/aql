import {
  GoogleGenAI,
  createUserContent,
  createPartFromBase64,
  type Content,
  type Tool,
  type FunctionCall,
} from "@google/genai";

// ───────────────────────────────────────────────
// طبقة Gemini الأساسية — كل نداءات الذكاء تمرّ من هنا.
// الدوال: embed (تضمين) | flash (نص) | flashJson (JSON منظّم) | pro (توليد).
// كلها تُرجع نوعاً واضحاً AIResult مع معالجة أخطاء كاملة.
// ───────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;

/** النماذج — ثوابت قابلة للتبديل بسهولة.
 *  قرار المالك (2026-08-22): الترقية إلى gemini-3.7-flash للدورين معاً
 *  (سبقه توحيد الدورين على 3.6-flash بقراره 2026-08-04). المفتاحان يبقيان
 *  منفصلين عمداً — إعادة فصل الدورين لاحقاً تعديل سطر واحد. */
export const MODELS = {
  flash: "gemini-3.7-flash", // التصنيف + استخراج السمات + التفريغ + توجيه الأدوات
  pro: "gemini-3.7-flash", // التوليد والتحليل المعمّق (تحليل النشر/العقل/الخطة/المقالات)
  embed: "gemini-embedding-001", // ثابت — تغييره يفرض إعادة تضمين كل العناصر (مرفوض الآن)
} as const;

/** أبعاد التضمين — يجب أن يطابق VECTOR(768) في schema.sql. */
export const EMBED_DIM = 768;

/** نوع إرجاع موحّد: إمّا نجاح بالبيانات أو فشل برسالة خطأ بالعربية. */
export type AIResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY غير مضبوط في ملف .env.local");
  }
  if (!_ai) _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

/** تطبيع L2 — مطلوب حين تكون أبعاد المخرج < 3072 (كما في حالتنا 768). */
function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

/** يحسب متجه تضمين (768 بُعد، مطبَّع) لنصٍّ ما. */
export async function embed(text: string): Promise<AIResult<number[]>> {
  try {
    const ai = getAI();
    const res = await ai.models.embedContent({
      model: MODELS.embed,
      contents: text,
      config: { outputDimensionality: EMBED_DIM },
    });
    const values = res.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      return { ok: false, error: "لم تُرجع واجهة التضمين أي متجه" };
    }
    // النموذج يُرجع 3072 بُعداً افتراضياً؛ نطلب 768. لو تجاهل الطلب (انجراف SDK)
    // فالمتجه لا يطابق VECTOR(768) ويكسر الإدراج/البحث صامتاً — نرفضه صراحةً.
    if (values.length !== EMBED_DIM) {
      return {
        ok: false,
        error: `بُعد التضمين غير متوقّع: ${values.length} (المطلوب ${EMBED_DIM})`,
      };
    }
    return { ok: true, data: l2normalize(values) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** نداء سريع للتصنيف/التفريغ (Gemini Flash). */
export async function flash(prompt: string): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.flash,
      contents: prompt,
    });
    const text = res.text;
    if (!text) return { ok: false, error: "لم يُرجع النموذج أي نص" };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** نداء Flash يُجبر المخرج JSON نظيفاً (للتصنيف المنظّم). يُرجع نصّ JSON خاماً.
 *  responseJsonSchema (اختياري) — نفس آلية proJson: فكّ تشفير مقيَّد يضمن الشكل
 *  والهروب. النداءات الجديدة تمرّره؛ القائمة (تصنيف/تفصيل) بحرّاسها كما هي. */
export async function flashJson(
  prompt: string,
  responseJsonSchema?: Record<string, unknown>,
): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.flash,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        ...(responseJsonSchema ? { responseJsonSchema } : {}),
      },
    });
    const text = res.text;
    if (!text) return { ok: false, error: "لم يُرجع النموذج أي JSON" };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** بحث حيّ على الويب (Gemini Flash + أداة googleSearch). يُرجع نصّاً مؤرَّضاً بالويب.
 *  ملاحظة: أداة البحث لا تتوافق مع وضع JSON (خطأ 400) — لذا نداء منفصل («ابحث ثم ولّد»). */
export async function searchWeb(query: string): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.flash,
      contents: query,
      config: { tools: [{ googleSearch: {} }] },
    });
    const text = res.text;
    if (!text) return { ok: false, error: "لا نتائج بحث" };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** نداء معمّق للتوليد/التحليل (Gemini Pro). */
export async function pro(prompt: string): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.pro,
      contents: prompt,
    });
    const text = res.text;
    if (!text) return { ok: false, error: "لم يُرجع النموذج أي نص" };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** نداء Pro يُجبر المخرج JSON نظيفاً. يدعم systemInstruction منفصلاً عن رسالة المستخدم.
 *  prompt = رسالة المستخدم (contents). systemInstruction (اختياري) = تعليمات النظام.
 *  responseJsonSchema (اختياري) = مخطط JSON يُفعّل فكّ التشفير المقيَّد (constrained decoding):
 *  يضمن مخرجاً صالحاً بنيوياً ومطابقاً للشكل — يُلغي هشاشة responseMimeType وحده (الذي
 *  قد يُرجع JSON مكسوراً: علامة اقتباس غير مهرَّبة داخل قيمة، أو تغليفاً بمصفوفة). */
export async function proJson(
  prompt: string,
  systemInstruction?: string,
  responseJsonSchema?: Record<string, unknown>,
): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.pro,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(responseJsonSchema ? { responseJsonSchema } : {}),
      },
    });
    const text = res.text;
    if (!text) return { ok: false, error: "لم يُرجع النموذج أي JSON" };
    return { ok: true, data: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** يفرّغ مقطعاً صوتياً (base64 + نوع MIME) نصاً عبر Gemini (multimodal).
 *  يُستخدم للرسائل الصوتية في تيليجرام (OGG مدعومة أصلاً). */
export async function transcribeAudio(
  base64: string,
  mimeType: string,
): Promise<AIResult<string>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model: MODELS.flash,
      contents: createUserContent([
        createPartFromBase64(base64, mimeType),
        "فرّغ هذا المقطع الصوتي نصاً حرفياً بالعربية. أعد النص فقط بلا أي تعليق أو إضافة.",
      ]),
    });
    const text = res.text;
    if (!text) return { ok: false, error: "تعذّر تفريغ الصوت" };
    return { ok: true, data: text.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** نتيجة نداء بأدوات: نصّ الجواب و/أو استدعاءات الدوال التي طلبها النموذج. */
export type ToolCallResult = {
  text: string | undefined;
  functionCalls: FunctionCall[] | undefined;
  // محتوى دور النموذج كما أرجعه — يحمل thought_signature المطلوب لإعادة إرساله في Gemini 3.x.
  modelContent: Content | undefined;
};

/** نداء Pro مع أدوات (function calling) — بدائيّة المنسّق (الملف 08).
 *  يُرجع نصّاً نهائياً أو استدعاءات دوال؛ يدير المنسّق الحلقة (تنفيذ ثم إعادة نداء).
 *  ملاحظة: الأدوات لا تتوافق مع وضع JSON (لذا لا responseMimeType هنا). */
export async function generateWithTools(
  contents: Content[],
  tools: Tool[],
  systemInstruction?: string,
  model: string = MODELS.pro,
): Promise<AIResult<ToolCallResult>> {
  try {
    const ai = getAI();
    const res = await ai.models.generateContent({
      model,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools.length ? { tools } : {}),
      },
    });
    return {
      ok: true,
      data: {
        text: res.text,
        functionCalls: res.functionCalls,
        modelContent: res.candidates?.[0]?.content,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

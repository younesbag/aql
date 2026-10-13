import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AIResult } from "@/lib/ai/gemini";

// ───────────────────────────────────────────────
// طبقة أنثروبيك — توليد المحتوى الكتابيّ فقط (منشورات إكس + النشرة + أفكارها).
// كل ما عداها (تضمين/تصنيف/بحث/تفريغ/تحليل/العقل/المقالات) يبقى على طبقة Gemini.
// claudeJson تُرجع نفس AIResult<string> (نصّ JSON) ليبقى المستدعون على
// parseJson/JSON.parse دون أي تغيير — استبدال نداء بنداء.
// ───────────────────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY;

/** نموذج الكتابة — قرار المالك: Claude Sonnet 5 (جودة كتابة أعلى). */
export const WRITER_MODEL = "claude-sonnet-5";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY غير مضبوط في ملف .env.local");
  }
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

/** كتلة نظام: النصّ + هل تُخزَّن في كاش البادئة.
 *  cache=true للأساس الثابت فقط (يُبنى مرة ويُعاد بايتاً-بايتاً)؛ إضافات الدور
 *  المتغيّرة (كمحرّر النقد) كتلة تالية غير مخزّنة — فتشارك النداءات بادئة واحدة. */
export type SystemBlock = { text: string; cache?: boolean };

export type ClaudeJsonOptions = {
  /** مخطط JSON (Structured Outputs) — يضمن مخرجاً صالحاً مطابقاً بنيوياً.
   *  ملاحظة: prefill غير مدعوم على Sonnet 5؛ هذا هو المسار الرسمي للمخرج المنظّم. */
  schema: Record<string, unknown>;
  /** عمق التفكير — xhigh لكل نداءات الكتابة حالياً (أعلى استدلال، الموصى به على
   *  Sonnet 5/Opus 4.7+ للمهام الوكاليّة/الكتابية الصعبة). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** سقف المخرج (التفكير التكيّفي يُحتسب منه) — افتراضي 16000 (حدّ اللا-بثّ الآمن). */
  maxTokens?: number;
};

/** نداء كتابة يُرجع نصّ JSON مطابقاً للمخطط. لا معاملات أخذ عينات (تُرفض على Sonnet 5)؛
 *  التفكير التكيّفي يعمل افتراضاً. الأخطاء برسائل عربية بنمط gemini.ts.
 *  بثّ داخلي دائماً (توصية الحزمة الرسمية لـmax_tokens الكبير/التفكير العميق) — يتفادى
 *  مهلة HTTP اللا-بثّية؛ .finalMessage() يُرجع نفس شكل استجابة .create() فتُقرأ كالمعتاد.
 *  ملاحظة مكتشَفة حيّاً: عند xhigh قد يستهلك التفكير التكيّفي جزءاً كبيراً ومتفاوتاً من
 *  max_tokens (رُصد تفاوت ٨٢٪→١٠٠٪ لنفس نداء SP2 بين تشغيلين) — راجع حدود الاستدعاءات
 *  عالية effort بعناية، ولا تعتمد على هامش ضيّق. */
export async function claudeJson(
  prompt: string,
  system: SystemBlock[],
  opts: ClaudeJsonOptions,
): Promise<AIResult<string>> {
  try {
    const client = getClient();
    const stream = client.messages.stream({
      model: WRITER_MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      system: system.map((b) => ({
        type: "text" as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      })),
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: { type: "json_schema" as const, schema: opts.schema },
        ...(opts.effort ? { effort: opts.effort } : {}),
      },
    });
    const res = await stream.finalMessage();

    // سجلّ الكاش (تحقّق): قراءة > 0 في النداء الثاني = البادئة المخزّنة تعمل.
    console.log(
      `[claude] cache_read=${res.usage.cache_read_input_tokens} cache_write=${res.usage.cache_creation_input_tokens} in=${res.usage.input_tokens} out=${res.usage.output_tokens}`,
    );

    // حارس stop_reason: صحة الـJSON مضمونة فقط عند اكتمال نظيف.
    if (res.stop_reason === "max_tokens") {
      return {
        ok: false,
        error: "بلغ المخرج حدّ الطول الأقصى — أعد المحاولة أو قلّص المطلوب",
      };
    }
    if (res.stop_reason === "refusal") {
      return { ok: false, error: "رفض النموذج معالجة هذا الطلب" };
    }

    const text = res.content.find((b) => b.type === "text")?.text;
    if (!text) return { ok: false, error: "لم يُرجع النموذج أي JSON" };
    return { ok: true, data: text };
  } catch (e) {
    // سلسلة الأخطاء المصنّفة — الأخصّ أولاً (APIConnectionError subclass لـ APIError).
    if (e instanceof Anthropic.RateLimitError) {
      return { ok: false, error: "تجاوُز حدّ الطلبات — انتظر قليلاً ثم أعد المحاولة" };
    }
    if (e instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: "مفتاح ANTHROPIC_API_KEY غير صالح" };
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return { ok: false, error: "تعذّر الاتصال بواجهة أنثروبيك — تحقّق من الشبكة" };
    }
    if (e instanceof Anthropic.APIError) {
      return { ok: false, error: `خطأ من واجهة أنثروبيك (${e.status}): ${e.message}` };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

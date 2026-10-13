import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { proJson } from "@/lib/ai/gemini";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// مرحلة تحليل النشر — منفصلة تماماً عن التصنيف (classify.ts) والالتقاط.
// تُستدعى فقط لحظة طلب توليد المحتوى من فكرة (لا عند الالتقاط).
// تُنتج «المدخل الغني» الذي يتوقّعه محرّك الكتابة (data/prompts/draft-writer.md).
// ════════════════════════════════════════════════════════════

export type ContentType = "thread" | "tweet";
export type ContentPillar =
  | "prompt_engineering"
  | "ai_strategy"
  | "ai_tools"
  | "ai_learning";
export type TargetPersona =
  | "fahd"
  | "noura"
  | "khaled"
  | "aisha"
  | "omar"
  | "general";
export type EngagementDriver = "bookmark" | "repost" | "reply" | "dwell_time";
export type HookStrength = "strong" | "medium" | "weak";

// المدخل الغني — بالحقول التي يتوقّعها البرومبت بالضبط.
export type PublishingAnalysis = {
  core_idea: string;
  unique_angle: string;
  suggested_hook: string;
  key_elements: string[];
  content_type: ContentType;
  content_pillar: ContentPillar;
  target_persona: TargetPersona;
  engagement_driver: EngagementDriver;
  hook_strength: HookStrength;
  has_prompt: boolean;
  notes: string;
};

export type AnalyzeInput = {
  raw_text: string;
  topic?: string | null;
  summary?: string | null;
};

const PILLARS = [
  "prompt_engineering",
  "ai_strategy",
  "ai_tools",
  "ai_learning",
] as const;
const PERSONAS = ["fahd", "noura", "khaled", "aisha", "omar", "general"] as const;
const DRIVERS = ["bookmark", "repost", "reply", "dwell_time"] as const;
const STRENGTHS = ["strong", "medium", "weak"] as const;
const TYPES = ["thread", "tweet"] as const;

// مخطط الإخراج المنظّم — يُفعّل فكّ التشفير المقيَّد في Gemini فيضمن JSON صالحاً بنيوياً
// ومطابقاً للشكل (يُلغي عطلَي: التغليف بمصفوفة، وعلامة الاقتباس غير المهرَّبة داخل قيمة عربية).
// مبنيّ من ثوابت الـenum أعلاه ليبقيا متزامنَين.
const ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    core_idea: { type: "string" },
    unique_angle: { type: "string" },
    suggested_hook: { type: "string" },
    key_elements: { type: "array", items: { type: "string" } },
    content_type: { type: "string", enum: [...TYPES] },
    content_pillar: { type: "string", enum: [...PILLARS] },
    target_persona: { type: "string", enum: [...PERSONAS] },
    engagement_driver: { type: "string", enum: [...DRIVERS] },
    hook_strength: { type: "string", enum: [...STRENGTHS] },
    has_prompt: { type: "boolean" },
    notes: { type: "string" },
  },
  required: [
    "core_idea",
    "unique_angle",
    "suggested_hook",
    "key_elements",
    "content_type",
    "content_pillar",
    "target_persona",
    "engagement_driver",
    "hook_strength",
    "has_prompt",
    "notes",
  ],
};

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// يُقرأ data/context.md لتوحيد الكيانات وتحديد الشخصية. مستقل عن classify.ts.
let _ctxCache: string | null = null;
async function loadContext(): Promise<string> {
  if (_ctxCache !== null) return _ctxCache;
  try {
    _ctxCache = await readFile(
      path.join(process.cwd(), "data", "context.md"),
      "utf8",
    );
  } catch {
    _ctxCache = "";
  }
  return _ctxCache;
}

export async function analyzeForPublishing(
  input: AnalyzeInput,
): Promise<PublishingAnalysis | null> {
  const raw = input.raw_text.trim();
  if (!raw) return null;

  const context = await loadContext();

  const prompt = `أنت محلل نشر استراتيجي لنظام «العقل الثاني» الشخصي لصاحبه ${OWNER_NAME} (مجال محتواه وجمهوره في مرجع السياق أدناه).
مهمتك: تحليل فكرة خام التقطها ${OWNER_NAME}، وتحويلها إلى «مدخل نشر غني» يُغذّي محرّك كتابة المحتوى.

استعن بمرجع السياق التالي لتوحيد الكيانات وتحديد الشخصية المستهدفة:
---
${context}
---

الفكرة الخام:
- النص: """${raw}"""
- الموضوع: ${input.topic ?? "—"}
- الملخص: ${input.summary ?? "—"}

حلّل الفكرة وأعد JSON فقط بهذه الحقول حصراً (القيم النصية بالعربية الطبيعية، وقيم التصنيف بالرموز الإنجليزية المحددة تماماً):
{
  "core_idea": "الفكرة الجوهرية القابلة للنشر في جملة",
  "unique_angle": "الزاوية الفريدة لـ${OWNER_NAME} ومشروعه على هذا الموضوع",
  "suggested_hook": "اقتراح أولي لهوك قوي بصوت ${OWNER_NAME}",
  "key_elements": ["عنصر إلزامي 1", "عنصر 2"],
  "content_type": "thread أو tweet",
  "content_pillar": "واحد من: prompt_engineering | ai_strategy | ai_tools | ai_learning",
  "target_persona": "واحد من: fahd | noura | khaled | aisha | omar | general",
  "engagement_driver": "واحد من: bookmark | repost | reply | dwell_time",
  "hook_strength": "واحد من: strong | medium | weak",
  "has_prompt": true أو false,
  "notes": "ملاحظات إضافية للكاتب"
}

إرشادات: content_type = "thread" للمواضيع المعمّقة متعددة العناصر، و"tweet" للفكرة المفردة الحادة. target_persona من الشخصيات الخمس في مرجع السياق (فهد/نورة/خالد/عائشة/عمر) أو general عند عدم الوضوح. has_prompt = true إن كانت الفكرة تتضمّن أو تستلزم برومبتاً جاهزاً للمشاركة.`;

  // يعمل على pro (لا flash): التحليل الاستراتيجي يغذّي محرّك التوليد، فجودته تؤثّر مباشرة على الدراف.
  // المخطط المنظّم يضمن JSON صالحاً — علاج جذري لعطل «تعذّر تحليل الفكرة للنشر» المتكرّر.
  const res = await proJson(prompt, undefined, ANALYSIS_SCHEMA);
  if (!res.ok) {
    console.error(`[analyze] فشل proJson: ${res.error}`);
    return null;
  }

  try {
    const parsed = JSON.parse(res.data) as unknown;
    // Gemini يُرجع أحياناً الكائن ضمن مصفوفة من عنصر واحد رغم الطلب الصريح بكائن مفرد — يُفكّ هنا دفاعياً.
    const p = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
    if (typeof p.core_idea !== "string" || !p.core_idea.trim()) {
      console.error(`[analyze] JSON بلا core_idea صالح: ${res.data.slice(0, 300)}`);
      return null;
    }
    return {
      core_idea: String(p.core_idea),
      unique_angle: typeof p.unique_angle === "string" ? p.unique_angle : "",
      suggested_hook:
        typeof p.suggested_hook === "string" ? p.suggested_hook : "",
      key_elements: Array.isArray(p.key_elements)
        ? p.key_elements.map((e) => String(e))
        : [],
      content_type: oneOf(p.content_type, TYPES, "tweet"),
      content_pillar: oneOf(p.content_pillar, PILLARS, "ai_strategy"),
      target_persona: oneOf(p.target_persona, PERSONAS, "general"),
      engagement_driver: oneOf(p.engagement_driver, DRIVERS, "bookmark"),
      hook_strength: oneOf(p.hook_strength, STRENGTHS, "medium"),
      has_prompt: typeof p.has_prompt === "boolean" ? p.has_prompt : false,
      notes: typeof p.notes === "string" ? p.notes : "",
    };
  } catch (e) {
    console.error(`[analyze] فشل تفكيك JSON: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

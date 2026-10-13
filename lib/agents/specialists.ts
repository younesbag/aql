import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { proJson } from "@/lib/ai/gemini";
import { retrieveContext, queryPerformance, type ContextSource } from "@/lib/agents/access";
import { parseJson, dedupeSources } from "@/lib/agents/util";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// الوكلاء المتخصصون — العقل الموحّد (الملف 08، المرحلة ٣).
// كل وكيل دالة واحدة: يجلب سياقه عبر طبقة الوصول، ثم نداء Gemini Pro واحد (proJson)
// يُرجع تحليلاً منظّماً + مصادره (للاستشهاد). لا إطار وكلاء — دوال مباشرة (الدستور).
// ════════════════════════════════════════════════════════════

// سياق المشروع (مرجع ثابت يُحقن في الربط والتحليل) — يُقرأ مرّة ويُخزَّن.
let _projectCtx: string | null = null;
async function loadProjectContext(): Promise<string> {
  if (_projectCtx !== null) return _projectCtx;
  try {
    _projectCtx = await readFile(path.join(process.cwd(), "data/context.md"), "utf8");
  } catch {
    _projectCtx = "";
  }
  return _projectCtx;
}

const perfLine = (s: ContextSource) => `- (تفاعل ${s.metrics?.engagement ?? 0}) ${s.text}`;

// ────────────────────────────────────────────────────────────
// مخططات الإخراج المنظّم — تُفعّل فكّ التشفير المقيَّد في Gemini.
// إلزامية لكل مخرج يُفكَّك لاحقاً (الدستور §٣-١): responseMimeType وحده لا يضمن
// JSON صالحاً — اقتباس غير مهرَّب داخل قيمة عربية يكسر التفكيك (حادثة 3cdbed8).
// بدونها كان الفشل صامتاً: parseJson يُرجع null فيظهر «تعذّر التحليل» بلا سبب.
// ────────────────────────────────────────────────────────────
const strList = { type: "array", items: { type: "string" } };

const PATTERN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { findings: { type: "string" }, signals: strList },
  required: ["findings", "signals"],
};

const MEASURE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    expectedTier: { type: "string", enum: ["strong", "medium", "weak"] },
    evidence: strList,
  },
  required: ["verdict", "expectedTier", "evidence"],
};

const PROJECT_LINK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    personas: strList,
    serves_goal: { type: "string" },
    suggested_angle: { type: "string" },
    package_hook: { type: "string" },
  },
  required: ["personas", "serves_goal", "suggested_angle", "package_hook"],
};

const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          situation: { type: "string" },
          decision: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["situation", "decision", "reasoning"],
      },
    },
    note: { type: "string" },
  },
  required: ["decisions", "note"],
};

// ────────────────────────────────────────────────────────────
// ١) تحليل الأنماط — ثلاث مهامّ بمدخلات مختلفة (نجاح/فجوات/تناقض).
// ────────────────────────────────────────────────────────────
export type PatternMode = "success" | "gaps" | "contradiction";
export type PatternResult = {
  mode: PatternMode;
  findings: string; // التحليل النصّي
  signals: string[]; // أبرز ٢-٤ إشارات
  sources: ContextSource[];
};

export async function analyzePatterns(
  mode: PatternMode,
  input = "",
  useAdmin = false,
): Promise<PatternResult> {
  const sources: ContextSource[] = [];
  let contextBlock = "";
  let task = "";

  if (mode === "success") {
    const [top, bottom] = await Promise.all([
      queryPerformance({ kind: "top", limit: 12 }, "", useAdmin),
      queryPerformance({ kind: "bottom", limit: 6 }, "", useAdmin),
    ]);
    sources.push(...top, ...bottom);
    contextBlock =
      "منشورات عالية الأداء:\n" +
      top.map(perfLine).join("\n") +
      "\n\nمنشورات منخفضة الأداء:\n" +
      bottom.map(perfLine).join("\n");
    task =
      "حلّل ما يميّز المنشورات عالية الأداء عن المنخفضة: نمط الخطاف، البنية، الموضوع، الشحنة العاطفية. استخرج أنماط النجاح القابلة للتكرار.";
  } else if (mode === "gaps") {
    const [projectCtx, top] = await Promise.all([
      loadProjectContext(),
      queryPerformance({ kind: "top", limit: 15 }, "", useAdmin),
    ]);
    sources.push(...top);
    contextBlock =
      "سياق المشروع وشخصياته:\n" +
      projectCtx +
      `\n\nعيّنة ممّا يكتب عنه ${OWNER_NAME} فعلاً (أعلى منشوراته):\n` +
      top.map((s) => `- ${s.text}`).join("\n");
    task =
      `قارن ما يكتب عنه ${OWNER_NAME} بما يخدم المشروع وشخصياته (جمهوره) كما يصفها سياقه. حدّد الفجوات: المواضيع المهملة التي تخدم المشروع ولا يكتب عنها (مثل قصة التأسيس، تحقّق السوق، عروض المشروع). ركّز على ما يستحق الكتابة ولا يُكتب.`;
  } else {
    // contradiction — input = قرار/رأي جديد يُقارَن بالسابق.
    const ctx = await retrieveContext(input, { semantic: true, semanticCount: 8 }, useAdmin);
    sources.push(...ctx.sources);
    contextBlock =
      "الرأي/القرار الجديد:\n" +
      input +
      `\n\nمن ذاكرة ${OWNER_NAME} السابقة (قرارات/أفكار/مراجعات ذات صلة):\n` +
      (ctx.block || "(لا شيء ذو صلة)");
    task =
      `هل يتعارض الرأي/القرار الجديد مع قرار أو موقف سابق ل${OWNER_NAME}؟ إن وُجد تعارض، حدّده بدقّة: ماذا قال سابقاً ومتى (إن توفّر) وأين التناقض. إن لم يوجد، قل ذلك صراحةً.`;
  }

  const prompt = `${task}

السياق:
${contextBlock}

أخرج JSON فقط:
{"findings": "تحليلك النصّي بالعربية", "signals": ["إشارة موجزة", "..."]}`;

  const res = await proJson(prompt, undefined, PATTERN_SCHEMA);
  if (!res.ok) console.error(`[patterns:${mode}] فشل proJson: ${res.error}`);
  const p = res.ok ? parseJson<{ findings: string; signals: string[] }>(res.data) : null;
  if (res.ok && !p) console.error(`[patterns:${mode}] تعذّر تفكيك JSON: ${res.data.slice(0, 300)}`);
  return {
    mode,
    findings: p?.findings ?? "تعذّر التحليل.",
    signals: Array.isArray(p?.signals) ? p.signals.map(String) : [],
    sources,
  };
}

// ────────────────────────────────────────────────────────────
// ٢) القياس مقابل النجاح — التوقّع (قبل النشر) ومواجهة فلتر التردّد.
// ────────────────────────────────────────────────────────────
export type MeasureMode = "predict" | "confront";
export type MeasureResult = {
  mode: MeasureMode;
  verdict: string;
  expectedTier: "strong" | "medium" | "weak" | null;
  evidence: string[];
  sources: ContextSource[];
};

export async function measureAgainstSuccess(
  input: string,
  mode: MeasureMode,
  useAdmin = false,
): Promise<MeasureResult> {
  const [related, top] = await Promise.all([
    queryPerformance({ kind: "byTopic", topic: input.slice(0, 1200), limit: 8 }, input, useAdmin),
    queryPerformance({ kind: "top", limit: 6 }, "", useAdmin),
  ]);
  const sources = dedupeSources([...related, ...top]);

  const contextBlock =
    `منشورات ${OWNER_NAME} الأقرب لهذا الموضوع (وأداؤها):\n` +
    related.map(perfLine).join("\n") +
    "\n\nأعلى منشوراته أداءً (مرجع النجاح):\n" +
    top.map(perfLine).join("\n");

  const task =
    mode === "predict"
      ? `قِس هذه المسودة مقابل أنماط نجاح ${OWNER_NAME}: ما أداؤها المتوقّع (قوي/متوسط/ضعيف)؟ كيف يقارن خطافها وبنيتها بأعلى منشوراته وبالأقرب موضوعاً؟ كن صريحاً ومحدّداً.`
      : `${OWNER_NAME} متردّد في نشر هذه الفكرة. واجِه ترددّه بالدليل: هل تشبه ما حقّق تفاعلاً عالياً لديه؟ إن كانت قوية فقُل له إن رفضه كمالية لا حكم. وإن كانت ضعيفة فعلاً فقُل ذلك بصدق.`;

  const prompt = `${task}

المدخل (${mode === "predict" ? "مسودة" : "فكرة متردّد فيها"}):
${input}

السياق:
${contextBlock}

أخرج JSON فقط:
{"verdict": "حكمك بالعربية", "expectedTier": "strong|medium|weak", "evidence": ["دليل مقارنة", "..."]}`;

  const res = await proJson(prompt, undefined, MEASURE_SCHEMA);
  if (!res.ok) console.error(`[measure:${mode}] فشل proJson: ${res.error}`);
  const p = res.ok
    ? parseJson<{ verdict: string; expectedTier: string; evidence: string[] }>(res.data)
    : null;
  if (res.ok && !p) console.error(`[measure:${mode}] تعذّر تفكيك JSON: ${res.data.slice(0, 300)}`);
  const tier = p?.expectedTier;
  return {
    mode,
    verdict: p?.verdict ?? "تعذّر القياس.",
    expectedTier: tier === "strong" || tier === "medium" || tier === "weak" ? tier : null,
    evidence: Array.isArray(p?.evidence) ? p.evidence.map(String) : [],
    sources,
  };
}

// ────────────────────────────────────────────────────────────
// ٣) ربط المشروع — يربط فكرة/محتوى بأهداف المشروع وشخصياته وعروضه.
// ────────────────────────────────────────────────────────────
export type ProjectLink = {
  personas: string[];
  serves_goal: string;
  suggested_angle: string;
  package_hook: string;
  sources: ContextSource[];
};

export async function linkToProject(content: string, useAdmin = false): Promise<ProjectLink> {
  const [projectCtx, ctx] = await Promise.all([
    loadProjectContext(),
    retrieveContext(content, { semantic: true, semanticCount: 5 }, useAdmin),
  ]);

  const prompt = `أنت محلّل نموّ المشروع. اربط المحتوى/الفكرة التالية بأهداف المشروع وشخصياته (جمهوره) وعروضه كما يصفها سياقه — حوّل الفكرة من محتوى إلى محرّك نموّ للمشروع.

سياق المشروع:
${projectCtx}

من ذاكرة ${OWNER_NAME} ذات الصلة:
${ctx.block || "(لا شيء ذو صلة)"}

المحتوى/الفكرة:
${content}

أخرج JSON فقط:
{"personas": ["الشخصيات المخدومة بالاسم"], "serves_goal": "كيف يخدم هدف المشروع", "suggested_angle": "الزاوية المقترحة للمشروع", "package_hook": "ربط بعرض/منتج المشروع إن أمكن (أو فارغ)"}`;

  const res = await proJson(prompt, undefined, PROJECT_LINK_SCHEMA);
  if (!res.ok) console.error(`[project-link] فشل proJson: ${res.error}`);
  const p = res.ok
    ? parseJson<{
        personas: string[];
        serves_goal: string;
        suggested_angle: string;
        package_hook: string;
      }>(res.data)
    : null;
  if (res.ok && !p) console.error(`[project-link] تعذّر تفكيك JSON: ${res.data.slice(0, 300)}`);
  return {
    personas: Array.isArray(p?.personas) ? p.personas.map(String) : [],
    serves_goal: p?.serves_goal ?? "",
    suggested_angle: p?.suggested_angle ?? "",
    package_hook: p?.package_hook ?? "",
    sources: ctx.sources,
  };
}

// ────────────────────────────────────────────────────────────
// ٤) استخراج القرارات — يكتشف القرارات الاستراتيجية في نصّ ملتقط ويهيّئها للتوثيق.
// ────────────────────────────────────────────────────────────
export type ExtractedDecision = { situation: string; decision: string; reasoning: string };
export type ExtractResult = { decisions: ExtractedDecision[]; note: string };

export async function extractDecisions(text: string): Promise<ExtractResult> {
  const prompt = `اقرأ النصّ التالي (فكرة/ملاحظة ملتقطة من ${OWNER_NAME}). اكتشف ما يبدو **قراراً استراتيجياً** يستحق التوثيق في سجلّ القرارات. لكل قرار استخرج بنيته الصارمة: الموقف، القرار، السبب. إن لم يوجد قرار واضح، أعِد قائمة فارغة (لا تخترع).

النصّ:
${text}

أخرج JSON فقط:
{"decisions": [{"situation": "الموقف/السياق", "decision": "ما قرّره", "reasoning": "لماذا"}], "note": "ملاحظة موجزة أو سبب عدم وجود قرار"}`;

  const res = await proJson(prompt, undefined, EXTRACT_SCHEMA);
  if (!res.ok) console.error(`[extract] فشل proJson: ${res.error}`);
  const p = res.ok ? parseJson<{ decisions: ExtractedDecision[]; note: string }>(res.data) : null;
  if (res.ok && !p) console.error(`[extract] تعذّر تفكيك JSON: ${res.data.slice(0, 300)}`);
  const decisions = Array.isArray(p?.decisions)
    ? p.decisions.filter((d) => d && d.situation && d.decision && d.reasoning)
    : [];
  return { decisions, note: p?.note ?? "" };
}

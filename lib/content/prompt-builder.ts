// ════════════════════════════════════════════════════════════
// مركِّب برومبتات التوليد — وحدة نقية (الملف 16).
// لماذا وحدة مستقلة: مصدر حقيقة واحد لنصوص النظام والمدخل وبرومبت النقد،
// يستوردها مساران: بوابة API (lib/content/generate — مسار الطوارئ المباشر)
// وعامل الجلسة على الـVPS (worker/) الذي لا يحتمل تبعيات Next/server-only.
// لذلك: لا "server-only" هنا، لا Supabase، لا Next — node صرف.
// النصوص المنقولة من generate.ts نُقلت حرفياً — أي تعديل صياغة هنا يغيّر
// سلوك المسارين معاً فيخضع لبوابة §5-ج.
// ════════════════════════════════════════════════════════════
import { readFile } from "node:fs/promises";
import path from "node:path";
// امتداد .ts صريح: العامل (node بتجريد الأنواع) لا يفهم أسماء المسار @/ — وهذه الوحدة نقية عمداً.
import { OWNER_NAME } from "../config/owner.ts";

export type QualityScore = {
  hook_power: number;
  linguistic_authenticity: number;
  simplified_depth: number;
  practical_value: number;
  flow: number;
  empowerment: number;
  uniqueness: number;
  overall: number;
};

// مخرج محرّك SP2 (الحقول الأساسية التي نستخدمها؛ الباقي يُحتفظ به مرناً).
export type GeneratedDraft = {
  draft: string;
  hook_text: string;
  content_type: string; // THREAD | LONG_TWEET | MEDIUM_TWEET
  cta_type: string; // premium | short | none
  quality_score: QualityScore | null;
  hook_tests_passed: Record<string, boolean> | null;
  improvement_notes: string;
  critique?: {
    before_overall: number;
    weakest: string[];
    changes: string;
    critic?: string; // "codex" حين حكم الناقد الخارجي (الملف 17) — غيابه = النقد الداخلي
  } | null;
};

// شكل التحليل كما يستهلكه التركيب (بنية PublishingAnalysis دون استيرادها —
// الاستيراد النوعي الحقيقي يبقى في generate.ts؛ هنا يكفي العقد البنيوي).
export type AnalysisLike = Record<string, unknown>;

export type PostExample = { draft_text: string; eng: number };

// زوج ذوق (الملف 19): توليدة رفضها المالك ↔ النسخة التي فضّلها — أعلى سلطة أسلوبية.
export type TastePair = {
  idea_text: string | null;
  rejected_draft: string;
  preferred_draft: string;
  lesson: string | null;
};

// systemInstruction = برومبت المحرّك (draft-writer.md) + مرجع النبرة (voice-and-tone.md)
// + السياق المكثّف (context-brief.md — بأمر المالك 2026-08-11 بعد تصحيحه: مقطَّر في
// ~1000 حرف بدل 10 آلاف، بعقد صريح «سياق خلفي لا مادة ترويج» في رأسه).
// rootDir لمرونة العامل (افتراضياً جذر المشروع).
let _systemCache: string | null = null;
export async function loadWriterSystem(rootDir = process.cwd()): Promise<string> {
  if (_systemCache !== null) return _systemCache;
  const read = async (rel: string) => {
    try {
      return await readFile(path.join(rootDir, rel), "utf8");
    } catch {
      return "";
    }
  };
  const [engine, voice, brief] = await Promise.all([
    read("data/prompts/draft-writer.md"),
    read("data/voice-and-tone.md"),
    read("data/context-brief.md"),
  ]);
  _systemCache =
    `${engine}\n\n---\n\n# مرجع النبرة والصوت (voice-and-tone)\n\n${voice}` +
    (brief.trim() ? `\n\n---\n\n${brief}` : "");
  return _systemCache;
}

// إزالة التشكيل: النصوص المشكَّلة تخالف القاعدة الأولى في بروتوكول الكتابة
// البشرية وتجرّ المحرّك إلى سجلّ فصيح متكلَّف.
function stripTashkeel(text: string): string {
  return text.replace(/[ً-ْٰـ]/g, "");
}

// كتلة أزواج الذوق (الملف 19) — كل زوج: مرفوض → مفضل → الدرس المستخلص.
function buildTasteBlock(pairs: TastePair[]): string {
  return pairs
    .map((p, i) => {
      const idea = p.idea_text ? `[الفكرة الخام]\n${p.idea_text}\n` : "";
      const lesson = p.lesson ? `[الدرس]: ${p.lesson}` : "";
      return `── زوج ${i + 1} ──\n${idea}[توليدة رفضها ${OWNER_NAME}]\n${p.rejected_draft}\n[النسخة التي فضّلها ${OWNER_NAME}]\n${p.preferred_draft}\n${lesson}`;
    })
    .join("\n\n");
}

// مدخل SP2 الكامل — الأساس منقول حرفياً من generate.ts، ثم الملف 19 أضاف:
// النص الخام أولاً (مصدر الحقائق الأول) + أزواج معايرة الذوق.
export function buildSp2UserContent(
  analysis: AnalysisLike,
  examples: PostExample[],
  directivesBlock: string,
  searchResults?: string | null,
  calibration?: string | null,
  provenPatterns?: string | null,
  recentNewsletters?: string[],
  rawText?: string | null,
  tastePairs?: TastePair[],
): string {
  const input = JSON.stringify(analysis, null, 2);
  const examplesBlock =
    examples.length > 0
      ? examples.map((e, i) => `[مثال ${i + 1} — تفاعل ${e.eng}]\n${e.draft_text}`).join("\n\n")
      : "(لا منشورات سابقة بأداء كافٍ بعد — استند للأمثلة المرجعية في تعليمات النظام.)";
  const dirBlock = directivesBlock;
  const searchBlock = searchResults && searchResults.trim() ? searchResults.trim() : "";
  const calBlock = calibration && calibration.trim() ? calibration.trim() : "";
  const patBlock = provenPatterns && provenPatterns.trim() ? provenPatterns.trim() : "";
  const nlBlock =
    recentNewsletters && recentNewsletters.length > 0
      ? recentNewsletters.map((s) => `- ${s}`).join("\n")
      : "";
  const rawBlock = rawText && rawText.trim() ? stripTashkeel(rawText.trim()) : "";
  // النص الخام بقلم المالك نفسه: مصدر أول للوقائع **والعبارات**.
  const rawLead = `النص الخام كما كتبه ${OWNER_NAME} — المصدر الأول: الحقائق والأرقام والتفاصيل والوقائع منه حصراً، وعباراته الحية مادة للاقتباس:`;
  const tasteBlock = tastePairs && tastePairs.length > 0 ? buildTasteBlock(tastePairs) : "";

  return `${dirBlock ? `<directives>\n${dirBlock}\n</directives>\n\n` : ""}${rawBlock ? `<original_text>${rawLead}\n${rawBlock}\n</original_text>\n\n` : ""}<input>
${input}
</input>

${tasteBlock ? `<taste_calibration>أزواج معايرة الذوق — أعلى سلطة أسلوبية في هذا المدخل: استخرج الفروق بين المرفوض والمفضل وطبّقها على كتابتك:\n${tasteBlock}\n</taste_calibration>\n\n` : ""}${searchBlock ? `<live_search>استخدمها بانتقاء — انظر تعليمات النظام:\n${searchBlock}\n</live_search>\n\n` : ""}${calBlock ? `<calibration>\n${calBlock}\n</calibration>\n\n` : ""}${patBlock ? `<proven_patterns>\n${patBlock}\n</proven_patterns>\n\n` : ""}${nlBlock ? `<recent_newsletters>نشرات بريدية حديثة غطّت ما يلي — لا تكرّر زاويتها حرفياً في المنشور:\n${nlBlock}\n</recent_newsletters>\n\n` : ""}<performance_examples>احتذِ إيقاعها وأسلوبها — لا تنسخها:
${examplesBlock}
</performance_examples>

<voice_anchor>تذكير أخير قبل الكتابة (يعلو على أي صياغة وردت في المدخل): اكتب بصوت ${OWNER_NAME} المحكي — فصحى مبسّطة بنكهة خليجية معتدلة، بلا تشكيل إطلاقاً، بإيقاع متباين، وبقطعية حين تكون القناعة حاسمة. أي عبارة في المدخل بصياغة فصيحة متكلّفة هي مادة موضوع لا نموذج أسلوب.</voice_anchor>`;
}

// كتلة النص الخام لمراحل النقد/الدمج (الملف 19) — مرجع الوقائع لكشف أي اختراع.
function rawBlockOf(rawText?: string | null): string {
  return rawText && rawText.trim()
    ? `<original_text>نص ${OWNER_NAME} الخام — مرجع الحقائق والأرقام (أي واقعة في المسودة لا سند لها هنا = اختراع يُصحَّح):\n${rawText.trim()}\n</original_text>\n`
    : "";
}

// برومبت النقد — منقول حرفياً من generate.ts (buildCritiquePrompt) بتوقيع نقي
// (نصّ المسودة بدل الكائن الكامل — العامل لا يملك إلا النص).
export function buildCritiquePromptText(
  draftText: string,
  analysis: AnalysisLike,
  rawText?: string | null,
): string {
  return `مهمتك الآن ناقد ومحرّر صارم — لا مولّد. أمامك مسودة وُلّدت من المدخل أدناه.

نفّذ بدقّة:
1. قيّم المسودة مقابل «مصفوفة الجودة» السبعة في تعليماتك، بعين ناقد خارجي صارم لا متساهل.
2. حدّد أضعف معيارين تحديداً.
3. أعد كتابة الأجزاء الضعيفة فقط واحتفظ بالأجزاء القوية كما هي. لا تعِد كتابة مسودة جديدة كلياً.
   **والهوك أصل محمي:** لا تمسّه إلا إذا كان هو أحد أضعف معيارين صراحةً — وحتى حينها احتفظ بادعائه ورقمه وغيّر صياغته فقط (قاعدة المالك: «مع الحفاظ على الهوك»).
4. احترم نفس النوع وعدد التغريدات وCTA في المسودة الأصلية (أي توجيهات إلزامية وردت تبقى سارية).
5. أخرج النسخة المحسّنة بنفس حقول المخرج، بالدرجات النهائية الصارمة بعد التحسين.
6. املأ حقل critique: weakest (أضعف معيارين) وchanges (وصف موجز لما غيّرته ولماذا).

${rawBlockOf(rawText)}<original_input>
${JSON.stringify(analysis, null, 2)}
</original_input>
<draft_v1>
${draftText}
</draft_v1>`;
}

// جولة مراجعة (الملف 24): تُلحَق بمدخل التوليد الأصلي كاملاً فتحتفظ الجولة
// بكل سياقها (النص الخام، أزواج الذوق)، وتُضاف المسودة السابقة
// وملاحظة المالك **آخر المدخل** لأنها أخصّ تعليمة وأحدثها.
export function buildRevisionSuffix(previousDraft: string, note: string): string {
  return `

<previous_draft>المسودة التي وُلّدت في الجولة السابقة — لا تعِد كتابتها من الصفر:
${previousDraft.trim()}
</previous_draft>

<revision_request>ملاحظة ${OWNER_NAME} على المسودة أعلاه — وهي **أخصّ تعليمة في هذا المدخل كله**:
«${note.trim()}»

نفّذ جولة مراجعة موجَّهة:
1. **عالج ما ذكره تحديداً** — وهو سبب الرفض الوحيد المعلن.
2. **احتفظ بما لم يذكره كما هو** — كل جزء لم يشتكِ منه يُنقل بلا مساس (الهوك يبقى ما لم تكن الملاحظة عنه، وكذلك الأرقام والوقائع والبنية). إعادة الكتابة الشاملة نقضٌ لهذه الجولة.
3. لا تُدخل تشبيهاً جديداً ولا صقلاً إضافياً بحجة التحسين — قواعد تعليمات النظام كلها سارية، وقاعدة العفوية أولاها.
4. في improvement_notes: اذكر بإيجاز ما غيّرته وما أبقيته ولماذا.
</revision_request>`;
}

// ── خصوصيات مسار الجلسة (العامل) — لا تمسّ مسار API ────────────
// مسار API يضمن الشكل بمخطط Structured Outputs؛ الجلسة لا تملك ذلك،
// فتُلحق تعليمة إخراج صارمة ويُفكَّك الناتج بتسامح ثم يُتحقَّق منه.

export const SESSION_JSON_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق — بحقول المخرج المعرّفة في تعليمات النظام حرفياً (draft, hook_text, content_type, original_content_type, cta_type, lead_magnet, cta_keyword, hashtags, tweet_count, quality_score, hook_tests_passed, anti_repetition, freshness_flag, freshness_note, improvement_notes, error, suggestion). حالة الرفض: draft=null مع error وsuggestion.`;

export const SESSION_CRITIQUE_JSON_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص حوله — بنفس حقول المخرج أعلاه **مضافاً إليها** حقل critique: {"weakest": ["…","…"], "changes": "…"}.`;

// يلتقط أول كائن JSON من نصّ قد يحيط به كلام أو أسوار (تسامح مسار الجلسة).
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

// ── الناقد الخارجي (الملف 17): جيبيتي عبر codex exec — يحكم ويوجّه ولا يكتب ──

export type ExternalCritique = {
  weakest: string[];
  directives: string;
  scores: Record<string, number> | null;
};

// مصفوفة الجودة السبعة مكثّفة للناقد الخارجي — لا يرى نظام كلود فتُضمَّن له
// (إعادة صياغة موجزة بأسماء المعايير القانونية من QualityScore، لا نقل حرفي).
const RUBRIC_BRIEF = `المعايير السبعة (لكلٍّ درجة من 10):
- hook_power: قوة الهوك — أول سطر يوقف التمرير: ملموسية ورقم/مفارقة في الكلمات الأولى، بلا عبارات جسر.
- linguistic_authenticity: أصالة اللغة — فصحى طبيعية بنكهة خليجية معتدلة، صوت إنسان لا قالب ذكاء اصطناعي.
- simplified_depth: عمق مبسّط — فكرة غير سطحية شُرحت ببساطة دون ابتذال.
- practical_value: قيمة عملية — خطوة أو مثال ينفذه القارئ اليوم، لا حكمة إنشائية.
- flow: التدفق — انتقالات سلسة وإيقاع جمل متنوع حتى النهاية.
- empowerment: التمكين — يخرج القارئ أقدر على الفعل، لا مبهوراً فقط.
- uniqueness: التفرد — زاوية لا تُقرأ في كل مكان.`;

export function buildCodexCriticPrompt(
  draftText: string,
  analysis: AnalysisLike,
  rawText?: string | null,
): string {
  return `أنت ناقد تحرير صارم ومستقل لمنشورات إكس العربية. مهمتك الحكم فقط — لا تعد كتابة النص ولا تقترح صياغة بديلة كاملة.

${RUBRIC_BRIEF}

قواعد الحكم:
- احكم وفق هذه المصفوفة حصراً، لا وفق ذوقك العام.
- النص بصوت صاحبه (فصحى + خليجي معتدل) — لا تقترح تغيير الشخصية أو اللهجة أو النبرة.
- كن قاسياً كناقد خارجي لا مجاملاً: 9 فأعلى لا تُمنح إلا لسطر استثنائي فعلاً.

أخرج كائن JSON واحداً فقط بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"scores": {"hook_power": 0, "linguistic_authenticity": 0, "simplified_depth": 0, "practical_value": 0, "flow": 0, "empowerment": 0, "uniqueness": 0}, "weakest": ["اسم_المعيار_الأضعف", "اسم_المعيار_الثاني"], "directives": "توجيهات إصلاح محددة قابلة للتنفيذ للمعيارين الأضعفين — ماذا يتغير ولماذا، دون كتابة الصياغة البديلة"}

${rawBlockOf(rawText)}<original_input>
${JSON.stringify(analysis, null, 2)}
</original_input>
<draft>
${draftText}
</draft>`;
}

export type CodexCriticResult =
  | { ok: true; critique: ExternalCritique }
  | { ok: false; error: string };

// تفكيك حكم الناقد الخارجي — نفس فلسفة التسامح والحرّاس.
export function parseCodexCritic(text: string): CodexCriticResult {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { ok: false, error: "لا JSON في ناتج الناقد الخارجي." };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      error: "JSON مكسور من الناقد الخارجي: " + (e instanceof Error ? e.message : "غير معروف"),
    };
  }
  const weakest = Array.isArray(p.weakest) ? p.weakest.map(String).slice(0, 3) : [];
  const directives = typeof p.directives === "string" ? p.directives.trim() : "";
  if (weakest.length === 0 || !directives)
    return { ok: false, error: "ناتج الناقد الخارجي ناقص (weakest أو directives)." };
  const scores =
    p.scores && typeof p.scores === "object" && !Array.isArray(p.scores)
      ? (p.scores as Record<string, number>)
      : null;
  return { ok: true, critique: { weakest, directives, scores } };
}

// الكتابة النهائية بعد نقد خارجي — كلود ينفّذ التوجيهات وله سيادة الصوت:
// يجوز له تجاوز توجيه يكسر الصوت مع توثيق السبب في critique.changes.
export function buildExternalRewritePrompt(
  draftText: string,
  analysis: AnalysisLike,
  critique: ExternalCritique,
  rawText?: string | null,
): string {
  return `مهمتك الآن محرّر منفّذ. أمامك مسودة وُلّدت من المدخل أدناه، وقد قيّمها ناقد تحريري خارجي مستقل.

حكم الناقد الخارجي:
- أضعف معيارين: ${critique.weakest.join("، ")}
- توجيهاته: ${critique.directives}

نفّذ بدقة:
1. أعد كتابة الأجزاء الضعيفة فقط وفق توجيهات الناقد، واحتفظ بالأجزاء القوية كما هي.
2. سيادة الصوت لك: إن كسر توجيهٌ ما صوت الكاتب أو قاعدة من تعليماتك، تجاوزه واذكر السبب في critique.changes.
   **والهوك أصل محمي** ما لم يكن هو أحد أضعف معيارين — وحينها يُحتفظ بادعائه ورقمه وتُغيَّر صياغته فقط.
3. احترم نفس النوع وعدد التغريدات وCTA في المسودة الأصلية (أي توجيهات إلزامية وردت تبقى سارية).
4. أخرج النسخة المحسّنة بنفس حقول المخرج، بالدرجات النهائية الصارمة بعد التحسين.
5. في حقل critique: ضع weakest كما حددها الناقد، وchanges وصفاً لما نفّذته من توجيهاته وما تجاوزته ولماذا.

${rawBlockOf(rawText)}<original_input>
${JSON.stringify(analysis, null, 2)}
</original_input>
<draft_v1>
${draftText}
</draft_v1>`;
}

// ── الدمج المتوازي (الملف 18): توليدتان بنفس التعليمات ثم تركيب الأفضل ──
// قرار المالك الصريح (2026-08-10، بعد تجربته لجيبيتي): يجوز تبنّي جمل جيبيتي
// حرفياً حين تكون الأقوى — لا قيد «أفكار لا جُمل».
export function buildMergePrompt(
  draftClaude: string,
  draftGpt: string,
  analysis: AnalysisLike,
  rawText?: string | null,
): string {
  return `مهمتك الآن محرّر تركيب. أمامك توليدتان مستقلتان لنفس المدخل، كُتبتا بنفس التعليمات ونفس الصوت المطلوب: الأولى منك (كلود) والثانية من نموذج آخر (جيبيتي).

نفّذ بدقة:
1. حدّد الأقوى في كل عنصر على حدة: الهوك، الزاوية، البنية، الأمثلة، الخاتمة والدعوة.
2. ركّب النسخة النهائية من أفضل ما في التوليدتين — ويجوز تبنّي جمل حرفياً من أيٍّ منهما حين تكون الأقوى (قرار صريح من صاحب الحساب). لا تفاضل بولاء لتوليدتك: احكم على الجملة لا على كاتبها.
3. النتيجة نص واحد متماسك بصوت واحد — أزل أي تنافر إيقاع أو نبرة بين المقاطع المدموجة. ولا تُدخل تشبيهاً لم يرد في أيّ من التوليدتين (قاعدة التشبيه في تعليماتك سارية على الدمج).
4. احترم نفس النوع وعدد التغريدات والدعوة المطلوبة في المدخل (أي توجيهات إلزامية تبقى سارية).
5. أخرج بنفس حقول المخرج بالدرجات النهائية الصارمة للنص المدموج، وفي حقل critique: اجعل weakest مصفوفة فارغة، وchanges تقريرَ الدمج (ماذا أخذت من توليدة كلود وماذا من توليدة جيبيتي ولماذا — بإيجاز محدد).

${rawBlockOf(rawText)}<original_input>
${JSON.stringify(analysis, null, 2)}
</original_input>
<draft_claude>
${draftClaude}
</draft_claude>
<draft_gpt>
${draftGpt}
</draft_gpt>`;
}

export type Sp2ParseResult =
  | { ok: true; draft: GeneratedDraft }
  | { ok: false; error: string };

// تفكيك ناتج الجلسة إلى GeneratedDraft — نفس حرّاس مسار API (typeof + قيم آمنة)
// مع التقاط حالة الرفض ({draft:null, error, suggestion}).
export function parseSp2Session(text: string): Sp2ParseResult {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { ok: false, error: "لم يُعثر على JSON في ناتج الجلسة." };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      error: "JSON مكسور من الجلسة: " + (e instanceof Error ? e.message : "غير معروف"),
    };
  }
  if (typeof p.draft !== "string" || !p.draft.trim()) {
    const err = typeof p.error === "string" && p.error ? p.error : "رفض المحرّك توليد مسودة.";
    const sug = typeof p.suggestion === "string" && p.suggestion ? ` — اقتراح: ${p.suggestion}` : "";
    return { ok: false, error: err + sug };
  }
  const qs = p.quality_score as Record<string, unknown> | undefined;
  const crit = p.critique as Record<string, unknown> | undefined;
  return {
    ok: true,
    draft: {
      draft: p.draft,
      hook_text: typeof p.hook_text === "string" ? p.hook_text : "",
      content_type: typeof p.content_type === "string" ? p.content_type : "THREAD",
      cta_type: typeof p.cta_type === "string" ? p.cta_type : "none",
      quality_score:
        qs && typeof qs.overall === "number" ? (qs as unknown as QualityScore) : null,
      hook_tests_passed:
        p.hook_tests_passed && typeof p.hook_tests_passed === "object"
          ? (p.hook_tests_passed as Record<string, boolean>)
          : null,
      improvement_notes:
        typeof p.improvement_notes === "string" ? p.improvement_notes : "",
      critique:
        crit && (Array.isArray(crit.weakest) || typeof crit.changes === "string")
          ? {
              before_overall: 0, // يملؤه العامل من درجة v1
              weakest: Array.isArray(crit.weakest) ? crit.weakest.map(String) : [],
              changes: typeof crit.changes === "string" ? crit.changes : "",
            }
          : null,
    },
  };
}

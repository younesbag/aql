import { readFile } from "node:fs/promises";
import path from "node:path";
// امتداد .ts صريح: العامل (node بتجريد الأنواع) لا يفهم أسماء المسار @/ — وهذه الوحدة نقية عمداً.
import { OWNER_NAME } from "../config/owner.ts";

// ════════════════════════════════════════════════════════════
// وحدة نقية لبناء برومبتات النشرة (الملف 26) — على نمط lib/content/prompt-builder.
// بلا "server-only" وبلا Supabase وبلا SDK: يستوردها مسار API على Vercel **و**عامل
// الـVPS معاً، فيبقى نصّ البرومبت مصدرَ حقيقة واحداً لا نسختين تتباعدان.
//
// لماذا نُقلت النشرة للجلسة (قرار المالك 2026-08-12، رفعاً للتأجيل المسجّل في الدستور):
//   ١) أربعة نداءات xhigh على سقف Hobby الصلب ٣٠٠ث — انقطاع بنيويّ.
//   ٢) نفاد رصيد أنثروبيك عطّل النشرة **كلياً** بينما ظلّ إكس يعمل على الجلسة.
// ════════════════════════════════════════════════════════════

let _systemCache: string | null = null;

/** نظام النشرة = محرّكها + مرجع النبرة + سياق المشروع. يُبنى مرّة ويُعاد بايتاً-بايتاً. */
export async function loadNewsletterSystem(rootDir = process.cwd()): Promise<string> {
  if (_systemCache !== null) return _systemCache;
  const read = async (rel: string) => {
    try {
      return await readFile(path.join(rootDir, rel), "utf8");
    } catch {
      return "";
    }
  };
  const [engine, voice, projectContext] = await Promise.all([
    read("data/prompts/newsletter-writer.md"),
    read("data/voice-and-tone.md"),
    read("data/context.md"),
  ]);
  _systemCache =
    `${engine}\n\n---\n\n# مرجع النبرة والصوت (voice-and-tone)\n\n${voice}` +
    `\n\n---\n\n# سياق المشروع\n\n${projectContext}`;
  return _systemCache;
}

// ── مراحل المهمة على الطابور ──
export type NewsletterStage = "ideas" | "outline" | "draft";

// ════════════ أمثلة بيعية من رسائل المالك المرسَلة (الملف 32) ════════════
// الفجوة التي تُسدّ هنا: getEmailExamples يجلب من items حيث source_type='email'
// — وهي النشرات **التعليمية** المبتورة. فكانت التوليدة البيعية تتعلّم جنساً
// خاطئاً: مثال طويل ولهجته خافتة لنصّ مطلوب قصير ولهجته أكثف.
// المصدر هنا data/sales-emails-archive.md (اختياري — غيابه يعني لا أمثلة بيعية):
// رسائل بيعية مرسَلة فعلاً، كل مدخل منها "## N. اسم الحملة — التاريخ".

export type SalesExample = {
  campaign: string;
  subject: string;
  words: number;
  body: string;
  dialect: number; // كثافة اللهجة المقيسة — تُعرض للنموذج مرساةً رقمية
};

// معجم اللهجة الخليجية — قائمة قياس كثافة اللهجة في النص
const DIALECT_MARKERS = [
  "بس","خلني","هذي","كذا","الحين","ايش","وش","ليش","شوف","مو","عشان","زين","تبي",
  "قعدت","وحدة","شوي","سويت","تسوي","خلاص","الجاي","تقدر","سوى","صاير",
];

/** كثافة اللهجة لكل ١٠٠ كلمة — نفس مقياس البصمة حرفياً. */
export function dialectDensity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  let n = DIALECT_MARKERS.reduce(
    (s, m) => s + (text.match(new RegExp(`(^|[\\s"«(])${m}([\\s"»)،.,؟!:]|$)`, "g")) ?? []).length,
    0,
  );
  n += (text.match(/\bهال[ء-ي]{2,}/g) ?? []).length;
  n += (text.match(/(^|\s)شي(\s|[،.,؟!]|$)/g) ?? []).length;
  return +((n / words) * 100).toFixed(1);
}

let _salesCache: SalesExample[] | null = null;

/** يفكّك أرشيف الرسائل المرسَلة إلى مداخل مصنّفة. يُقرأ مرّة ويُخزَّن. */
export async function loadSalesExamples(rootDir = process.cwd()): Promise<SalesExample[]> {
  if (_salesCache) return _salesCache;
  let raw = "";
  try {
    raw = await readFile(path.join(rootDir, "data/sales-emails-archive.md"), "utf8");
  } catch {
    return (_salesCache = []);
  }
  const out: SalesExample[] = [];
  // كل مدخل: "## N. اسم الحملة — التاريخ" ثم حقول ثم المتن حتى الفاصل
  for (const block of raw.split(/^## \d+\. /m).slice(1)) {
    const head = block.split("\n")[0] ?? "";
    const campaign = head.split("—")[0]?.trim() ?? "";
    const subject = /\*\*العنوان:\*\*\s*(.+)/.exec(block)?.[1]?.trim() ?? "";
    const words = Number(/\*\*الطول:\*\*\s*(\d+)/.exec(block)?.[1] ?? 0);
    const body = block.split(/\*\*الطول:\*\*.*\n/)[1]?.split(/^---$/m)[0]?.trim() ?? "";
    if (!body || words < 100) continue; // نستبعد رسائل الشكر القصيرة جداً
    out.push({ campaign, subject, words, body, dialect: dialectDensity(body) });
  }
  // إزالة النسخ المعادة: نفس العنوان ونفس الطول = نفس الرسالة لقائمة أخرى
  const seen = new Set<string>();
  return (_salesCache = out.filter((e) => {
    const k = e.subject + "|" + e.words;
    return seen.has(k) ? false : (seen.add(k), true);
  }));
}

/**
 * ينتقي أمثلة بيعية للحقن: الأقرب معجمياً للفكرة.
 * بلا تضمين — الوحدة نقية بلا قاعدة بيانات.
 */
export function pickSalesExamples(
  all: SalesExample[],
  ideaText: string,
  limit = 2,
): SalesExample[] {
  const words = new Set(
    ideaText.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3),
  );
  const score = (e: SalesExample) => {
    let hits = 0;
    for (const w of words) if (e.body.includes(w) || e.subject.includes(w)) hits++;
    return hits;
  };
  return [...all].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

export function buildSalesExamplesBlock(picked: SalesExample[]): string {
  if (picked.length === 0) {
    return "(لا أمثلة بيعية متاحة — استند لقواعد الحلقات البيعية في تعليماتك.)";
  }
  // قيد النسخ (قياس حيّ): المثال البيعيّ بطول المخرج تقريباً، وعند نسبة ١:١
  // يذوب الفرق بين الاحتذاء والنسخ — فخرج مقطع ٤٩ حرفاً منسوخاً حرفياً. التحذير من «نسخ الوقائع» لا يكفي: النسخ وقع في **الصياغة**.
  return (
    `رسائل بيعية أرسلها ${OWNER_NAME} فعلاً — **احتذِ طولها وإيقاعها وكثافة لهجتها**:\n\n` +
    picked
      .map(
        (e, i) =>
          `[مثال ${i + 1} · ${e.words} كلمة · لهجته ${e.dialect}/100]\n` +
          `العنوان: ${e.subject}\n${e.body}`,
      )
      .join("\n\n") +
    "\n\n**قيد النسخ (إلزاميّ):** هذه الرسائل مرجع **إيقاع ونبرة وكثافة لهجة** لا مصدر جُمَل. " +
    "ممنوع أن يرد في مخرجك **أي مقطع من ست كلمات متتالية فأكثر** منها — لا في العنوان ولا في وصف العرض ولا في الدعوة. " +
    "صِغ كل جملة من جديد بمفرداتك أنت. وإن وجدت نفسك تعيد صياغة عرضٍ ورد في مثال، فغيّر زاويته لا كلماته فحسب. " +
    "وقائعها (أرقامها وأسماؤها ومواعيدها) تخصّ رسائلها هي — لا تنقلها إطلاقاً."
  );
}

// ════════════ بناء المدخلات ════════════

/** سطر معايرة النبرة — قيد حاسم يُحقن قرب نهاية المدخل. */
export function buildToneLine(t: {
  warmth: number; urgency: number; depth: number; candor: number;
}): string {
  return `عاير النصّ بدقّة على مقاييس النبرة (كلٌّ من ١٠): دفء شخصي ${t.warmth}/10 · إلحاح بيعي ${t.urgency}/10 · عمق تعليمي ${t.depth}/10 · نقد وصراحة ${t.candor}/10.`;
}

export function buildIdeasUserContent(
  topic: string,
  personaStr: string,
  angleStr: string,
  notes: string,
  memBlock: string,
  recentBlock: string,
  topPostsBlock: string,
  count: number,
): string {
  return `اقترح أفكار نشرات بريدية متمايزة حول المحور أدناه. لا تكتب النشرة — فقط الفكرة وزاويتها في سطر-سطرين لكل واحدة. كل فكرة: عنوان جذّاب + جملة تشرح زاويتها الفريدة. متمايزة لا متكرّرة، عملية لجمهور المالك المحدّد في سياق المشروع، وعلى صوت ${OWNER_NAME}.

<topic>${topic}</topic>
<persona>${personaStr}</persona>
<angle>${angleStr}</angle>
${notes.trim() ? `<notes>${notes.trim()}</notes>\n` : ""}${memBlock ? `<memory>\n${memBlock}\n</memory>\n` : ""}${recentBlock ? `<recent_web>\n${recentBlock}\n</recent_web>\n` : ""}${topPostsBlock ? `<top_posts>منشوراتك الأعلى تفاعلاً على إكس في هذا المحور — ما رنّ هناك مرشَّح للتعميق هنا (النشرة تعمّق لا تكرّر):\n${topPostsBlock}\n</top_posts>\n` : ""}
القيد الكمي (التزم به حرفياً): بالضبط ${count} أفكار.`;
}

export function buildOutlineUserContent(
  idea: string,
  directives: string,
  searchBlock: string,
  examplesBlock: string,
  depth: number,
  urgency: number,
  rawText = "",
): string {
  return `ضع هيكل نشرة بريدية من الفكرة أدناه — لا تكتب النشرة كاملةً، فقط الخطّة/العظم بنقاط مختصرة ليراجعها ${OWNER_NAME} قبل التوسيع. الهيكل يشمل: العنوان المقترح (٥–٩ كلمات يجتاز اختبار الإلحاح) · نوع الافتتاحية ومشهدها (قصة بأرقام أو ملاحظة أو اعتراف — لا مفهوم ولا إحصائية) · نقاط المتن بالترتيب · موضع البرومبت إن لزم · جملة الدفع والدعوة الواحدة.

<idea>${idea}</idea>
${buildRawTextBlock(rawText)}${directives ? `<directives>\n${directives}\n</directives>\n` : ""}${searchBlock ? `<live_search>\n${searchBlock}</live_search>\n` : ""}${examplesBlock ? `<archive_examples>\n${examplesBlock}\n</archive_examples>\n` : ""}
<tone_metrics>وجّه العمق والإلحاح دون إثقال: عمق تعليمي ${depth}/10 · إلحاح بيعي ${urgency}/10</tone_metrics>`;
}

/**
 * كتلة النص الخام (الملف 27) — عقد بريديّ، لا منقول عن إكس.
 *
 * الفرق الجوهري: في التغريدة النصّ الخام قد يكون المنشور نفسه تقريباً، وجُمَله
 * مادة اقتباس مباشرة. في النشرة هو **العمود الواقعيّ** لنصّ يتجاوزه بأضعاف:
 * منه القصة والأرقام والتجربة، وحوله يُبنى الشرح. وقاعدة المالك «كل قصة وأرقامها
 * حقيقية» كانت قيداً بلا مادة — الفكرة السطرية لا تحمل تجربته، فإمّا اختلق
 * المحرّك أو عمّم. هذه الكتلة تعطيه المادة فيصير القيد قابلاً للتنفيذ.
 */
export function buildRawTextBlock(rawText: string): string {
  const t = rawText.trim();
  if (!t) return "";
  return `<original_text>هذا كلام ${OWNER_NAME} الخام عن الموضوع — وهو **مصدر الوقائع في هذه النشرة**:
${t}
</original_text>
<raw_text_contract>عقد التعامل معه:
- كل رقم وتاريخ وواقعة واسم أداة هنا **يُستعمل كما هو**. لا تستبدله ولا تقرّبه ولا تخترع بديلاً عنه.
- إن احتاجت النشرة واقعة ليست هنا، فاكتبها عامّة أو اتركها — ولا تختلق تفصيلاً شخصياً.
- صياغته هنا مادة خام لا نصّ نهائي: خذ منها المشهد والأرقام والزاوية، واكتب بإيقاع النشرة لا بإيقاع الملاحظة.
- افتتاحية النشرة تُبنى من مشهد **هنا** إن وُجد فيه مشهد — فهو تجربته الحقيقية لا مثالاً مصنوعاً.
- النشرة تتجاوز هذا النصّ بأضعاف طولاً: وسّع وفصّل واشرح حوله، دون أن تناقضه أو تزحزح وقائعه.
</raw_text_contract>
`;
}

export function buildDraftUserContent(
  ideaText: string,
  directives: string,
  outline: string | undefined,
  searchBlock: string,
  examplesBlock: string,
  toneLine: string,
  rawText = "",
  tastePairs: TastePair[] = [],
): string {
  // مصدر المحتوى: هيكل (المسار المُتحكَّم) أو الفكرة مباشرةً (المسار السريع).
  const base =
    outline && outline.trim()
      ? `<outline>\nاتّبع هذا الهيكل بدقّة — وسّع كل نقطة إلى فقرة كاملة بصوت الإيميل، دون إضافة محاور خارجه:\n\n${outline.trim()}\n</outline>\n<idea_context>${ideaText}</idea_context>`
      : `<idea>${ideaText}</idea>`;

  return `اكتب مسودة نشرة بريدية كاملة بصوت ${OWNER_NAME} البريديّ.

ابدأ بهندسة العنوان واختبره بسؤاله: هل يخلق إلحاحاً لا يقاوَم للفتح، أم يستطيع القارئ تجاهله وإكمال يومه؟ ثم اكتب الجسم على البنية المقرّرة في تعليماتك.

${directives ? `<directives>\n${directives}\n</directives>\n` : ""}${buildRawTextBlock(rawText)}${base}

${searchBlock ? `<live_search>استخدمها بانتقاء:\n${searchBlock}</live_search>\n` : ""}<archive_examples>احتذِ أسلوبها وإيقاعها — لا تنسخها:
${examplesBlock}
</archive_examples>
${buildTasteBlock(tastePairs)}
<tone_metrics>${toneLine}</tone_metrics>`;
}

// ── معايرة الذوق البريدية (الملف 27) ──
// قناة منفصلة عن إكس عمداً: أزواج إكس بطول تغريدة، وحقنها هنا يجرّ النشرة نحو
// التغريدة. تبدأ فارغة بصدق وتمتلئ من تحرير المالك لمسودّاته البريدية.
export type TastePair = {
  idea_text: string | null;
  rejected_draft: string;
  preferred_draft: string;
  lesson: string | null;
};

export function buildTasteBlock(pairs: TastePair[]): string {
  if (pairs.length === 0) return "";
  const body = pairs
    .map((p, i) => {
      const lesson = p.lesson?.trim() ? `\nالدرس: ${p.lesson.trim()}` : "";
      return `[زوج ${i + 1}]${p.idea_text ? `\nالفكرة: ${p.idea_text}` : ""}
ما رفضه ${OWNER_NAME}:
${p.rejected_draft}
ما اعتمده بدلاً منه:
${p.preferred_draft}${lesson}`;
    })
    .join("\n\n");
  return `
<taste_calibration>أزواج من تحرير ${OWNER_NAME} الفعليّ لنشراته: ما رفضه مقابل ما اعتمده. **هذه أعلى سلطة أسلوبية في هذا المدخل** — حين تتعارض مع أي قاعدة عامة، اتبعها هي.
${body}
</taste_calibration>
`;
}

export function buildCritiqueUserContent(
  subject: string,
  draft: string,
  toneLine: string,
): string {
  return `قيّم المسودة أدناه على معايير الجودة العشرة في تعليماتك، كلٌّ من ١٠.

ابدأ بالعنوان وحده: هل يخلق إلحاحاً لا يقاوَم للفتح أم يستطيع القارئ تجاهله وإكمال يومه؟ وهل يعمل وحده دون أن يتّكئ على تذكّر نشرة سابقة؟ إن سقط في أيّهما فأعد هندسته — وإن كان قوياً فلا تستبدله بحثاً عن الأفضل.

ثمّ حدّد أضعف معيارين في الجسم وأصلحهما **نقطياً**: الجزء الضعيف وحده (الافتتاحية إن لم تكن مشهداً معاشاً، أو العمق، أو الإغلاق) — مع الإبقاء التامّ على ما نجح، وعلى صوت ${OWNER_NAME} وبنيته.

<subject>${subject}</subject>
<draft>
${draft}
</draft>

<tone_metrics>${toneLine}</tone_metrics>`;
}

// ════════════ جولة المراجعة (الملف 33) ════════════
// منقولة عن الملف 24 بعقدٍ بريديّ: نمط المالك ٢–٣ جولات رفض قبل الاعتماد،
// وكان المحرّك يعيد التوليد من الصفر عند كل رفض فيفقد ما نجح. والفرق البريديّ
// أن **العنوان أصل محمي** — لأنه نقطة رفضه الأولى، فإن لم تكن الملاحظة عنه
// فتغييره نقضٌ للجولة (data/newsletter-fingerprint.md).

export function buildNewsletterRevisionSuffix(
  previousSubject: string,
  previousDraft: string,
  note: string,
): string {
  return `

<previous_draft>النشرة التي وُلّدت في الجولة السابقة — لا تعِد كتابتها من الصفر:
[العنوان] ${previousSubject.trim()}

${previousDraft.trim()}
</previous_draft>

<revision_request>ملاحظة ${OWNER_NAME} على النشرة أعلاه — وهي **أخصّ تعليمة في هذا المدخل كله**:
«${note.trim()}»

نفّذ جولة مراجعة موجَّهة:
1. **عالج ما ذكره تحديداً** — وهو سبب الرفض الوحيد المعلن.
2. **احتفظ بما لم يذكره كما هو.** كل جزء لم يشتكِ منه يُنقل بلا مساس: الافتتاحية ومشهدها، والأرقام والوقائع، والبنية، وجملة الدفع. إعادة الكتابة الشاملة نقضٌ لهذه الجولة.
3. **العنوان أصل محمي** — أبقِه حرفياً ما لم تكن الملاحظة عنه. وإن كانت عنه، فأعد هندسته باختبار الإلحاح مع الإبقاء على وعده وأثره.
4. القيود كلها سارية: الطول ضمن مداه، وكثافة اللهجة داخل نطاقها، وصفر إيموجي، ولا رقم لم يصلك في المدخل.
5. لا تُدخل تشبيهاً جديداً ولا صقلاً إضافياً بحجة التحسين — قاعدة العفوية أولى القواعد.
</revision_request>`;
}

// ════════════ الدمج المتوازي (الملف 29) ════════════
// منقول عن الملف 18 بقرارَي المالك الصريحين: جيبيتي يستلم **كامل** التعليمات
// (النظام + تعليمة الإخراج + المدخل) فلا يصير صوته مشكلة · ويجوز تبنّي جمله
// **حرفياً** في الدمج حين تكون الأقوى. الفرق البريديّ: العنوان يُحاكَم مستقلاً
// عن الجسم — لأنه نقطة الرفض الأولى عند المالك (data/newsletter-fingerprint.md).

export function buildNewsletterMergePrompt(
  claudeSubject: string,
  claudeDraft: string,
  gptSubject: string,
  gptDraft: string,
  toneLine: string,
): string {
  return `مهمتك الآن محرّر تركيب. أمامك نشرتان مستقلتان لنفس المدخل، كُتبتا بنفس التعليمات ونفس الصوت المطلوب: الأولى منك (كلود) والثانية من نموذج آخر (جيبيتي).

نفّذ بدقة:
1. **العنوان يُحسم أولاً ووحده.** قارن العنوانين بسؤال الإلحاح: أيّهما لا يستطيع القارئ تجاهله وإكمال يومه؟ وأيّهما يعمل وحده بلا ذاكرة سلسلة؟ اختر الأقوى كما هو، أو ركّب منهما إن كان لكلٍّ نصفٌ أقوى.
2. ثمّ حدّد الأقوى في كل عنصر من الجسم على حدة: الافتتاحية ومشهدها · تشريح المشكلة · الحل وتفصيله · البرومبت المضمّن إن وُجد · جملة الدفع والدعوة والخاتمة.
3. ركّب النسخة النهائية من أفضل ما في النشرتين — **ويجوز تبنّي جمل حرفياً من أيٍّ منهما** حين تكون الأقوى (قرار صريح من صاحب الحساب). لا تفاضل بولاء لنشرتك: احكم على الجملة لا على كاتبها.
4. النتيجة نصّ واحد متماسك بصوت واحد — أزل أي تنافر إيقاع أو نبرة بين المقاطع المدموجة، واضبط كثافة اللهجة في النثر داخل نطاقها.
5. القيود الإلزامية تبقى سارية على النصّ المدموج: صفر إيموجي · دعوة واحدة · لا تشبيه لم يرد في أيٍّ من النشرتين · ولا واقعة ولا رقم لم يرد في إحداهما.
6. **الطول: عُدَّ كلمات النصّ المدموج قبل الإخراج.** التركيب يُراكم بطبعه — أخذُ الأقوى من الجانبين يضخّم النصّ فوق مداه. فإن تجاوزتَ المدى المطلوب، احذف بالتشذيب لا بالبتر: أزل التكرار بين المقطعين المدموجين، واختصر الجمل الشارحة الزائدة، واحتفظ بالمشهد والأرقام والقفلة كاملةً. **نصّ خارج مداه دمجٌ فاشل مهما جادت مقاطعه.**

<draft_claude>
[العنوان] ${claudeSubject}
${claudeDraft}
</draft_claude>
<draft_gpt>
[العنوان] ${gptSubject}
${gptDraft}
</draft_gpt>

<tone_metrics>${toneLine}</tone_metrics>`;
}

export const SESSION_MERGE_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"subject": "العنوان المختار أو المركّب", "draft": "النشرة المدموجة كاملةً", "merge_report": "ماذا أخذتَ من نشرة كلود وماذا من نشرة جيبيتي ولماذا — بإيجاز محدّد"}`;

export type MergeParse = { subject: string; draft: string; report: string };

export function parseMergeSession(text: string): MergeParse | null {
  const o = parseLoose(text);
  if (!o) return null;
  const draft = typeof o.draft === "string" ? o.draft : "";
  if (!draft.trim()) return null;
  return {
    subject: typeof o.subject === "string" ? o.subject : "",
    draft,
    report: typeof o.merge_report === "string" ? o.merge_report : "",
  };
}

// ════════════ تعليمات إخراج الجلسة ════════════
// مسار API يقيّد المخرج بمخطط؛ الجلسة لا تملك ذلك فتُقيَّد بتعليمة صريحة + تفكيك متسامح.

export const SESSION_IDEAS_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"ideas": ["الفكرة الأولى", "الفكرة الثانية"]}`;

export const SESSION_OUTLINE_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"outline": "الهيكل كاملاً كنصّ واحد بأسطر جديدة"}`;

export const SESSION_DRAFT_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"subject": "العنوان", "draft": "النشرة كاملةً بأسطرها"}`;

export const SESSION_CRITIQUE_INSTRUCTION = `

---
تعليمة الإخراج (إلزامية في هذا الوضع): أخرج **كائن JSON واحداً فقط** بلا أي نص قبله أو بعده وبلا أسوار تنسيق، بهذا الشكل حرفياً:
{"weakest": ["المعيار الأضعف", "الثاني"], "overall": 8.5, "subject": "العنوان بعد التحسين", "draft": "النشرة بعد التحسين"}`;

// ════════════ التفكيك المتسامح ════════════

/** يقتطع أول كائن JSON متوازن الأقواس من نصّ قد يحيط به كلام. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLoose(text: string): Record<string, unknown> | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    // Gemini/كلود قد يغلّف الكائن بمصفوفة — فكّ دفاعيّ (حادثة الدستور رقم ٤)
    const obj = Array.isArray(p) ? p[0] : p;
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseIdeasSession(text: string): string[] {
  const o = parseLoose(text);
  const arr = o?.ideas;
  return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
}

export function parseOutlineSession(text: string): string {
  const o = parseLoose(text);
  return typeof o?.outline === "string" ? o.outline : "";
}

export type DraftParse = { subject: string; draft: string };

export function parseDraftSession(text: string): DraftParse | null {
  const o = parseLoose(text);
  if (!o) return null;
  const subject = typeof o.subject === "string" ? o.subject : "";
  const draft = typeof o.draft === "string" ? o.draft : "";
  return draft.trim() ? { subject, draft } : null;
}

export type CritiqueParse = {
  subject: string;
  draft: string;
  overall: number | null;
  weakest: string[];
};

export function parseCritiqueSession(text: string): CritiqueParse | null {
  const o = parseLoose(text);
  if (!o) return null;
  const draft = typeof o.draft === "string" ? o.draft : "";
  if (!draft.trim()) return null;
  return {
    subject: typeof o.subject === "string" ? o.subject : "",
    draft,
    overall: typeof o.overall === "number" ? o.overall : null,
    weakest: Array.isArray(o.weakest) ? o.weakest.map(String).filter(Boolean) : [],
  };
}

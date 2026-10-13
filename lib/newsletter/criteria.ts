import { PERSONAS } from "../config/profile.ts";

// معايير توليد فكرة النشرة — وحدة مشتركة (lib، غير server-only).
// يستوردها العميل (نموذج المعايير) والخادم (حقن في البرومبت) — كنمط overrides.

export type NewsletterSource = "memory" | "recent" | "both";

export type IdeaCriteria = {
  topic: string; // المحور أو موضوع حرّ (مطلوب)
  persona: string; // "" = أي شخصية
  angle: string; // "auto" | news | opinion | comparison | story | howto | contrarian
  source: NewsletterSource; // مصدر التأصيل: ذاكرتي / أحداث حديثة / مزيج
  count: number; // عدد الأفكار المقترحة (3-6)
  notes: string; // توجيه حرّ إضافي
};

export const DEFAULT_CRITERIA: IdeaCriteria = {
  topic: "",
  persona: "",
  angle: "auto",
  source: "both",
  count: 4,
  notes: "",
};

// خيارات الواجهة (dropdowns).
// شرائح الجمهور تأتي من data/profile.json (ولا تُعرض «عام» هنا: الفراغ يعني أي شريحة).
export const PERSONA_OPTIONS = [
  { value: "", label: "أي شخصية" },
  ...PERSONAS.map((p) => ({ value: p.key, label: p.label })),
];

export const ANGLE_OPTIONS = [
  { value: "auto", label: "تلقائي" },
  { value: "news", label: "خبر" },
  { value: "opinion", label: "رأي صريح" },
  { value: "contrarian", label: "زاوية مخالفة" },
  { value: "comparison", label: "مقارنة" },
  { value: "story", label: "قصة أو تجربة" },
  { value: "howto", label: "دليل عملي" },
  { value: "myth", label: "تفكيك خطأ شائع" },
  { value: "framework", label: "إطار ذهني" },
  { value: "casestudy", label: "دراسة حالة بأرقامك" },
  { value: "confession", label: "اعتراف أو درس من فشل" },
  { value: "teardown", label: "تشريح مثال حقيقي" },
  { value: "behindscenes", label: "خلف الكواليس" },
  { value: "diagnostic", label: "سؤال تشخيصي" },
  { value: "forecast", label: "استشراف مسنود" },
];

export const SOURCE_OPTIONS = [
  { value: "memory", label: "من ذاكرتي" },
  { value: "recent", label: "أحداث حديثة (بحث)" },
  { value: "both", label: "مزيج" },
];

// خرائط عربية للحقن في البرومبت (الخادم).
// نص يصل النموذج: التسمية + المفتاح + وصف الشريحة من data/profile.json.
export const PERSONA_AR: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, `${p.label} (المعرّف ${p.key}): ${p.description}`]),
);
// ── الزوايا (وُسّعت 2026-08-12 بأمر المالك) ──────────────────
// الست الأصلية كانت تُغطّي أشكاله الشائعة وتُهمل أشيعها: تفكيك الفخّ، وإطار
// التقييم الذاتي، ودراسة الحالة بأرقامه — وهي حاضرة بقوة في أرشيفه وتصنيف
// خطافاته (الملف 25). كل زاوية هنا شكل بلاغيّ متمايز لا مرادف لغيره.
export const ANGLE_AR: Record<string, string> = {
  news: "خبر — الحدث أولاً",
  opinion: "رأي صريح",
  contrarian: "زاوية مخالفة",
  comparison: "مقارنة",
  story: "قصة أو تجربة",
  howto: "دليل عملي",
  myth: "تفكيك خطأ شائع",
  framework: "إطار أو نموذج ذهني",
  casestudy: "دراسة حالة بأرقامك",
  confession: "اعتراف أو درس من فشل",
  teardown: "تشريح مثال حقيقي",
  behindscenes: "خلف الكواليس",
  diagnostic: "سؤال تشخيصي",
  forecast: "استشراف مسنود",
};

/**
 * توجيه الزاوية المُصاغ — يُحقن في `<directives>` بدل الاسم المجرّد.
 * الاسم وحده («تفكيك خطأ شائع») لا يُنفَّذ؛ الجملة تُنفَّذ.
 */
export const ANGLE_DIRECTIVE: Record<string, string> = {
  news: "ابدأ بالحدث الجديد وحقائقه، ثم ماذا يعني عملياً للقارئ.",
  opinion: "موقف صريح بضمير المتكلّم، وحجّة مسنودة بتجربتك لا بالانطباع.",
  contrarian: "تحدَّ افتراضاً شائعاً يعتنقه القارئ نفسه، ثم قدّم البديل بدليل.",
  comparison: "طرفان واضحان بمعايير محدّدة، ثم حكم صريح لا تعليق محايد.",
  story: "سرد بمشهد بداية ثم تحوّل ثم درس — والقصة حقيقية بأرقامها.",
  howto: "خطوات مرقّمة ملموسة قابلة للتطبيق اليوم، لا مبادئ عامة.",
  myth: "سمِّ الممارسة التي يفعلها الناس، اشرح لماذا تبدو صحيحة، ثم أين تنكسر فعلاً، ثم البديل.",
  framework: "نموذج بمحاور أو مستويات مسمّاة يقيس به القارئ نفسه ويعرف أين يقف.",
  casestudy: "الوضع قبل بأرقامه، ما غُيّر بالضبط، النتيجة بعد بأرقامها — من تجربتك أنت.",
  confession: "ما فعلتَه وأخفق، الثمن الذي دفعتَه، وما تغيّر بعده. الصدق قبل الدرس وبلا جلد ذات.",
  teardown: "خذ أداةً أو عملاً أو ممارسة قائمة، فكّكها إلى ما نجح وما فشل ولماذا، ثم استخرج القاعدة.",
  behindscenes: "ما تبنيه الآن فعلاً، القرار الذي واجهك، ما اخترتَه ولماذا — بناءٌ علنيّ لا إعلان منجز.",
  diagnostic: "سؤال يجعل القارئ يفحص وضعه هو، ثم مؤشرات تفصل السليم عن المعطوب، ثم الخطوة الأولى.",
  forecast: "إلى أين يتّجه هذا، مسنوداً بما يحدث الآن لا بالتخمين، وماذا يعني لقرار القارئ اليوم.",
};

// ── مقاييس النبرة (طبقة الجودة ٣): يعاير بها المالك النصّ، كلٌّ من ١٠. newsletter-writer.md يفسّرها. ──
export type ToneMetrics = {
  warmth: number; // الدفء الشخصي
  urgency: number; // الإلحاح البيعي
  depth: number; // العمق التعليمي
  candor: number; // النقد والصراحة
};

export const DEFAULT_TONE: ToneMetrics = { warmth: 8, urgency: 2, depth: 7, candor: 5 };

export const TONE_FIELDS: { key: keyof ToneMetrics; label: string }[] = [
  { key: "warmth", label: "الدفء الشخصي" },
  { key: "urgency", label: "الإلحاح البيعي" },
  { key: "depth", label: "العمق التعليمي" },
  { key: "candor", label: "النقد والصراحة" },
];

// ── خيارات توليد المسودة (المرحلة ٢) ──
export type DraftOptions = {
  // غرض النشرة (الملف 28): المتغيّر الغائب — ANGLE عن زاوية الموضوع لا عن غرض الرسالة
  purpose:
    | "auto" | "teaching" | "mindset" | "analysis" | "personal"
    // حلقات البيع الأربع (الملف 31) — لكلٍّ عملة طلب ومقياس مختلفان
    | "revive" | "proof" | "close" | "recovery";
  length: "auto" | "sales" | "short" | "medium" | "long" | "extended";
  style: "auto" | "educational" | "narrative" | "analytical" | "personal" | "conversational";
  angle: string; // يعيد استخدام قيم ANGLE
  notes: string;
  search: boolean;
  tone: ToneMetrics; // مقاييس النبرة الأربعة (تُمرَّر للمسودة، وأخفّ للهيكل)
};

export const DEFAULT_DRAFT_OPTIONS: DraftOptions = {
  purpose: "auto",
  length: "auto",
  style: "auto",
  angle: "auto",
  notes: "",
  search: true,
  tone: DEFAULT_TONE,
};

// ── غرض النشرة (الملف 28) ──────────────────────────────────
// فئات مستخلصة من أرشيف نشرات المالك، وكل واحدة تحمل سلوكاً مختلفاً لا اسماً:
// النظام التعليمي يتضمّن برومبتاً جاهزاً · التحوّل الذهني بلا برومبت · والاستشهاد
// بالمصادر المسمّاة في تحليل الاتجاهات وحده.
// الطول لا يُشتقّ من الغرض عمداً: والطول بيد المالك من اللوحة أصلاً.
export const PURPOSE_OPTIONS = [
  { value: "auto", label: "تلقائي (يقرّره المحرّك)" },
  { value: "teaching", label: "نظام تعليمي" },
  { value: "mindset", label: "تحوّل ذهني" },
  { value: "analysis", label: "تحليل اتجاهات" },
  { value: "personal", label: "شخصي / إنساني" },
  { value: "revive", label: "بيع ١ · اعتراف وإحياء" },
  { value: "proof", label: "بيع ٢ · برهان" },
  { value: "close", label: "بيع ٣ · إغلاق" },
  { value: "recovery", label: "بيع ٤ · استرجاع غير الفاتحين" },
];

export const PURPOSE_AR: Record<string, string> = {
  teaching:
    "نظام تعليمي — القارئ يخرج بنظام يطبّقه اليوم. **برومبت مضمّن كامل بين ═══ إلزاميّ هنا** (قاعدة النشرات التعليمية) وخطة تطبيق بخطوات. التقابل «مستخدم الأدوات/مهندس الأنظمة» يناسبها أكثر من غيرها.",
  mindset:
    "تحوّل ذهني — تغيير زاوية نظر لا تلقين أداة. **بلا برومبت مضمّن إطلاقاً** (قاعدة النشرات الذهنية — وهذا عمديّ لا سهو). سرد وتفكيك مفهوم، وأقصر نفَساً، والقفلة تترك أثراً لا مهمة.",
  analysis:
    "تحليل اتجاهات — قراءة حدث أو رقم يشغل الناس. **المصادر مسمّاة صراحةً هنا** (جهات التقارير والأبحاث التي تستند إليها — فهذه الفئة وحدها تستشهد بالمصادر). أعطِ إطار تقييم يقيس به القارئ نفسه، لا رأياً مجرّداً.",
  personal:
    "شخصي/إنساني — رسالة قصيرة صادقة: اعتراف أو موقف أو تحيّة بمناسبة. أقصر النشرات وأكثرها لهجةً وحميمية. بلا نظام ولا خطة — قرب فقط.",

  // ── حلقات البيع الأربع (الملف 31) ──────────────────────────
  // مصدرها بصمة المالك البيعية المستخلصة من تصحيحاته على نصوص حيّة.
  // درس تشغيلي: سلاسل الحلقات تفشل غالباً بسبب **الإيقاع** (تباعد الحلقات حتى
  // يموت الزخم) لا بسبب النصوص — ومن هنا قاعدة الجدولة المسبقة للسلسلة كاملةً.
  //
  // القاعدة الحاكمة لكل الحلقات: **كلها تطلب، والذي يتغيّر عملة الطلب** —
  // نقرة مجانية أولاً، ثم مال في الإغلاق. فلا حلقة بلا مقياس.
  // والأرقام (مقاعد/سعر/موعد) تأتي من ملاحظات المالك لا من ذاكرة النموذج.
  revive:
    "بيع ١ · اعتراف وإحياء — رسالة شخص لا نشرة: معتذر بلا اعتذار. رتّب: إطار علاقة (سطر) ← برهان سلوكي على التزامك (سطر–سطران) ← إعادة تأطير ← الطلب. **الطلب هنا نقرة مجانية لا شراء**، ومقياس نجاحها الدخول لا التحويل. اكشف الاسم والتحوّل، وازرع بذرة العرض في سطر واحد **بلا رقم ولا سعر** (تلميح أن القصة الكاملة في الرسالة القادمة لا اليوم). صفر برومبت مضمّن وصفر خطة أسبوعية.",
  proof:
    "بيع ٢ · برهان — رسالة برهان لا بيع: وظيفتها إثبات أن وعدك حقيقة تشغيلية لا شعاراً. أرِ كيف يعمل عملياً (يوم من حياة مشترك)، بنبرة استعراضية-تشغيلية. **دعوة واحدة** لنقرة مجانية، ومقياسها النقرة. لا سعر ولا مقاعد هنا.",
  close:
    "بيع ٣ · إغلاق — **لا تفتح بالطلب**، لكن لا تنفق أكثر من ٤٠ كلمة قبله: القيمة هنا **برهان سلوكي واحد** على وفائك بما وعدت (تسليم وصل في موعده مثلاً) لا تعليم جديد. السعر يُذكر **مرة واحدة وهنا حصراً** بإطار ثبات السعر لا الخصم (السعر الحالي مقابل سعر لاحق أعلى) — واعرض المعطيات ودع القارئ يضرب الفرق بنفسه. **لا تبنِ الإلحاح على فرق السعر** بل على تكلفة الوقت الضائع. عالج الاعتراض الأشيع («جرّبت قبل وما استفدت») بصيغته وبعكس مخاطرة صريح. الدعوات ثلاث: صلبة (شراء) + ناعمة مجانية تلتقط غير الناضج **مسبوقة بإذن بعدم الشراء** («لا تشتري وأنت متردد») + دعوة ردّ في P.S.",
  recovery:
    "بيع ٤ · استرجاع غير الفاتحين — نفس مضمون البرهان بعنوان بديل تماماً، يُرسل بعد ٧٢ ساعة. مقياسه الفتح وحده. لا تُضف مادة جديدة ولا تُشعر القارئ أنها إعادة إرسال.",
};

// الطول بيد المالك من اللوحة (قراره 2026-08-12). الأرقام صريحة لا أوصاف مبهمة —
// «طويلة (~1000 أو أكثر)» كانت لا تغطّي أسبوعياته التي تجاوزت 1300 كلمة.
// المرساة: وسيط نشراته الفعلية ~850 كلمة، وهو ما يعنيه «تلقائي».
export const LENGTH_OPTIONS = [
  { value: "auto", label: "تلقائي (~850)" },
  { value: "sales", label: "بيعية (~225)" },
  { value: "short", label: "قصيرة (~500)" },
  { value: "medium", label: "متوسطة (~850)" },
  { value: "long", label: "طويلة (~1200)" },
  { value: "extended", label: "مطوّلة (~1600)" },
];
export const STYLE_OPTIONS = [
  { value: "auto", label: "تلقائي" },
  { value: "educational", label: "تعليمي" },
  { value: "narrative", label: "سرديّ" },
  { value: "analytical", label: "تحليلي" },
  { value: "personal", label: "شخصي" },
  { value: "conversational", label: "محادثاتي" },
];
// هدف رقمي بهامش ±١٠٪ — الوصف المبهم لا يُنفَّذ، والرقم يُنفَّذ ويُقاس.
/** أغراض البيع الأربعة — تُستعمل للتفريع في الطول والأمثلة واللهجة. */
export const SALES_PURPOSES = ["revive", "proof", "close", "recovery"] as const;
export function isSalesPurpose(p: string): boolean {
  return (SALES_PURPOSES as readonly string[]).includes(p);
}

export const LENGTH_AR: Record<string, string> = {
  // الإيميل البيعي عند المالك ١٥٠–٣٠٠ كلمة — أقصر بكثير من أقصر نشرة تعليمية
  sales: "نحو 225 كلمة (المدى المقبول 150–300)",
  short: "نحو 500 كلمة (المدى المقبول 450–550)",
  medium: "نحو 850 كلمة (المدى المقبول 770–930)",
  long: "نحو 1200 كلمة (المدى المقبول 1080–1320)",
  extended: "نحو 1600 كلمة (المدى المقبول 1440–1760)",
};
export const STYLE_AR: Record<string, string> = {
  educational: "تعليمي (شرح وخطوات)",
  narrative: "سرديّ (قصة بمشهد وتحوّل)",
  analytical: "تحليلي (تفكيك وحجج)",
  personal: "شخصي حميمي (ضمير المتكلّم)",
  conversational: "محادثاتي (كأنك تكلّم صديقاً)",
};

// ── نتيجة المسودة + حلقة النقد الذاتي (طبقة الجودة ٤) ──
export type CritiqueInfo = {
  firstSubject: string; // العنوان قبل التحسين
  firstDraft: string; // المسودة قبل التحسين
  overall: number | null; // التقييم الإجمالي بعد التحسين
  weakest: string[]; // أضعف معيارين قُوّيا
};

export type DraftResult = {
  subject: string; // النهائي (بعد التحسين إن جرى)
  draft: string;
  critique: CritiqueInfo | null; // حاضر حين تعمل الحلقة
};

// ── صفّ نشرة محفوظ (المرحلة ٤: القائمة + الاستئناف) ──
export type NewsletterStatus = "idea" | "outline" | "draft" | "final";

export type NewsletterRow = {
  id: string;
  status: NewsletterStatus;
  subject: string | null;
  idea: string | null;
  outline: string | null;
  draft: string | null;
  criteria: IdeaCriteria | null;
  // الملف 27 (0032): كلام المالك الخام — مادّة الوقائع والأرقام التي يبني عليها المحرّك
  raw_text?: string | null;
  updated_at: string;
};

export const STATUS_AR: Record<NewsletterStatus, string> = {
  idea: "فكرة",
  outline: "هيكل",
  draft: "مسودة",
  final: "نهائية",
};

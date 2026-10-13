// تحكّم المستخدم بمخرجات التوليد (الإضافة ١) — وحدة منطق مشتركة (lib).
// تستخدمها الواجهة (Generator) والخادم (actions/generate). تُحوّل اختيارات المستخدم
// إلى «توجيهات إلزامية» تُحقن في مدخل المحرّك وتتجاوز استنتاج تحليل النشر.

// الصيغ البلاغية (وُسّعت 2026-08-12 بأمر المالك): الست الأصلية كانت تُهمل أشكالاً
// حاضرة بقوة في تصنيف خطافاته المقيس (الملف 25) — تفكيك الخطأ الشائع ١١ منشوراً،
// والاعتراف الشخصي ١٠ بأعلى تفاعل مقيس (٢٨٥٩)، والإحصائية ٧.
export type ContentForm =
  | "auto"
  | "news"
  | "opinion"
  | "contrarian"
  | "comparison"
  | "story"
  | "howto"
  | "myth"
  | "framework"
  | "casestudy"
  | "confession"
  | "teardown"
  | "behindscenes"
  | "diagnostic"
  | "forecast";

export type GenOverrides = {
  format: "auto" | "thread" | "long" | "medium";
  threadCount: number | null; // عدد تغريدات الثريد (يُستخدم فقط حين format=thread)
  cta: "auto" | "premium" | "short" | "none";
  search: boolean; // بحث حيّ على الويب يُحقن في مدخل التوليد (الإضافة ٢)
  critique: boolean; // حلقة النقد والتحسين بعد التوليد (الإضافة ٣)
  form: ContentForm; // الصيغة البلاغية المطلوبة (الإضافة ٤) — خبر/رأي/مقارنة…
  notes: string; // ملاحظات وتعليمات حرّة تُحقن كتوجيه إلزامي (الإضافة ٤)
};

export const DEFAULT_OVERRIDES: GenOverrides = {
  format: "auto",
  threadCount: null,
  cta: "auto",
  search: true,
  critique: true,
  form: "auto",
  notes: "",
};

// التوجيهات المُشتقّة المُلزِمة للمحرّك (فارغة إن كان كل شيء «تلقائي»).
export type Directives = {
  forced_type?: "thread" | "long_tweet" | "medium_tweet";
  thread_count?: number;
  forced_cta?: "premium" | "short" | "none";
  form_directive?: string; // توجيه الصيغة البلاغية المُصاغ
  notes?: string; // ملاحظات المستخدم الحرّة
};

// خريطة الصيغ البلاغية → توجيه مُصاغ يُحقن في البرومبت (مع الإبقاء على صوت المالك).
const FORM_DIRECTIVES: Record<Exclude<ContentForm, "auto">, string> = {
  news: "صُغ المحتوى على شكل خبر: ابدأ بالحدث/الجديد، الحقائق أولاً، نبرة موجزة موضوعية.",
  opinion: "صُغه على شكل رأي شخصي صريح: موقف واضح، ضمير المتكلّم، وحجّة مدعومة بتجربتك.",
  contrarian: "صُغه على شكل زاوية مخالفة: تحدَّ افتراضاً شائعاً، ثم قدّم البديل بدليل.",
  comparison: "صُغه على شكل مقارنة: طرفان واضحان، معايير محدّدة، ثم حكم أو توصية.",
  story: "صُغه على شكل قصة: سرد شخصي بمشهد بداية، ثم تحوّل، ثم درس مستخلَص.",
  howto: "صُغه على شكل دليل عملي: خطوات مرقّمة ملموسة قابلة للتطبيق فوراً.",
  myth: "صُغه على شكل تفكيك خطأ شائع: سمِّ الممارسة التي يفعلها الناس، اشرح لماذا تبدو صحيحة، ثم أين تنكسر فعلاً، ثم البديل.",
  framework:
    "صُغه على شكل إطار ذهني: نموذج بمحاور أو مستويات مسمّاة يقيس به القارئ نفسه ويعرف أين يقف — لا نصيحة عامة.",
  casestudy:
    "صُغه على شكل دراسة حالة بأرقامك أنت: الوضع قبل بأرقامه، ما غُيّر بالضبط، النتيجة بعد بأرقامها. لا رقم بلا مصدر من تجربتك.",
  confession:
    "صُغه على شكل اعتراف أو درس من فشل: ما فعلتَه وأخفق، الثمن الذي دفعتَه، وما تغيّر بعده. الصدق قبل الدرس، وبلا جلد ذات.",
  teardown:
    "صُغه على شكل تشريح مثال حقيقي: خذ أداةً أو عملاً أو ممارسة قائمة، فكّكها إلى ما نجح وما فشل ولماذا، ثم استخرج القاعدة.",
  behindscenes:
    "صُغه على شكل خلف الكواليس: ما تبنيه الآن فعلاً، القرار الذي واجهك، ما اخترته ولماذا — بناءٌ علنيّ لا إعلان منجز.",
  diagnostic:
    "صُغه على شكل سؤال تشخيصي: سؤال يجعل القارئ يفحص وضعه هو، ثم مؤشرات تفصل الحالة السليمة عن المعطوبة، ثم الخطوة الأولى.",
  forecast:
    "صُغه على شكل استشراف مسنود: إلى أين يتّجه هذا، مسنوداً بما يحدث الآن لا بالتخمين، وماذا يعني ذلك عملياً لقرار القارئ اليوم.",
};

export function buildDirectives(o: GenOverrides): Directives {
  const d: Directives = {};
  if (o.format === "thread") d.forced_type = "thread";
  else if (o.format === "long") d.forced_type = "long_tweet";
  else if (o.format === "medium") d.forced_type = "medium_tweet";
  if (o.format === "thread" && o.threadCount && o.threadCount > 0)
    d.thread_count = o.threadCount;
  if (o.cta !== "auto") d.forced_cta = o.cta;
  if (o.form !== "auto") d.form_directive = FORM_DIRECTIVES[o.form];
  const notes = o.notes?.trim();
  if (notes) d.notes = notes;
  return d;
}

export function hasDirectives(d: Directives): boolean {
  return Object.keys(d).length > 0;
}

const TYPE_AR: Record<string, string> = {
  thread: "ثريد",
  long_tweet: "تغريدة طويلة",
  medium_tweet: "تغريدة متوسطة",
};

// كتلة نصّية تُحقن في مدخل المحرّك — يقرؤها draft-writer.md كتوجيهات مُلزِمة.
export function buildDirectivesBlock(d: Directives): string {
  const lines = ["توجيهات إلزامية من المستخدم (تتجاوز استنتاج التحليل):"];
  if (d.forced_type) lines.push("- النوع المطلوب: " + TYPE_AR[d.forced_type]);
  if (d.thread_count) lines.push("- عدد التغريدات المطلوب: ~" + d.thread_count);
  if (d.forced_cta) lines.push("- نوع CTA المطلوب: " + d.forced_cta);
  if (d.form_directive) lines.push("- " + d.form_directive);
  if (d.notes) lines.push("- ملاحظات وتعليمات إضافية (التزم بها): " + d.notes);
  return lines.join("\n");
}

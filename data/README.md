# مجلد `data/` — ملفات السياق والبرومبتات

هذا المجلد هو **هوية النظام**: الكود عام ومشترك، وكل ما يجعل المخرجات «بصوتك أنت» موجود هنا. **قبل أول استخدام يجب أن تملأ القوالب الأربعة المعلَّمة «مطلوب»** (كل ما بين `[...]` فيها يُستبدل بمعلومتك الحقيقية). الملفات تُقرأ من نظام الملفات وتُخزَّن في ذاكرة العملية: بعد أي تعديل أعد تشغيل الخادم محلياً، وعلى Vercel أعد النشر.

> **تنبيه خصوصية:** محتوى هذه الملفات يُرسل إلى مزوّدي النماذج (Gemini وClaude) ضمن البرومبتات. لا تكتب فيها كلمات مرور أو مفاتيح أو بيانات تخصّ غيرك. وإن نشرت نسختك علناً فلا تلتزم (commit) بملفاتك المعبّأة — ضعها في `.gitignore` أو احتفظ بها في مستودع خاص.

## جدول الملفات

| الملف | الحالة | من يقرؤه | ماذا تكتب فيه |
|---|---|---|---|
| `context.md` | **مطلوب (قالب)** | التصنيف (`lib/ai/classify.ts`) · تحليل النشر (`lib/content/analyze.ts`) · تحليل المقالات (`lib/capture/article.ts`) · الوكلاء المتخصصون (`lib/agents/specialists.ts`) · مدير اليوم (`lib/dayplan/engine.ts`) · نظام النشرة (`lib/newsletter/prompt-builder.ts`) | من أنت ومشروعك وحالته الراهنة وشخصيات جمهورك وقيودك. أهم ملف: كل ما يخص «حالتك الصادقة» يمنع النظام من الكتابة بنبرة لا تشبه واقعك. |
| `voice-and-tone.md` | **مطلوب (قالب)** | محرّك إكس (`lib/content/prompt-builder.ts`) · محرّك النشرة (`lib/newsletter/prompt-builder.ts`) | صوتك: صفاتك، لهجتك، أنماط افتتاحك وإغلاقك، أمثلة «قبل/بعد» بقلمك، مفرداتك المفضلة والممنوعة. |
| `life-context.md` | **مطلوب (قالب)** | مدير اليوم (`lib/dayplan/engine.ts`) | إيقاع يومك: النوم، ذروة التركيز، ما تماطل فيه، التزاماتك. يبني خطة يومية واقعية. |
| `context-brief.md` | **مطلوب (قالب)** | محرّك إكس (`lib/content/prompt-builder.ts`) | ملخّص ~١٠٠٠ حرف من `context.md` للمحرّك الكتابي (سياق خلفي لا مادة ترويج). |
| `sales-emails-archive.md` | اختياري (قالب) | أمثلة النشرة البيعية (`lib/newsletter/prompt-builder.ts` ← `loadSalesExamples`) | رسائلك البيعية المرسَلة فعلاً بصيغة ثابتة موضّحة داخل الملف. إن غاب فالنظام يعمل بلا أمثلة بيعية. |
| `prompts/draft-writer.md` | جاهز (مُنقّى) | محرّك إكس (يُحقن كاملاً في تعليمات النظام) | **لا يحتاج تعبئة.** منهج كتابة المنشورات: الهوك، الاختبارات الخمسة، الهياكل، مصفوفة الجودة، عقد المخرج JSON. |
| `prompts/newsletter-writer.md` | جاهز (مُنقّى) | محرّك النشرة | **لا يحتاج تعبئة.** منهج النشرة البريدية: هندسة العنوان، الافتتاحية، الحلقات البيعية، الصوت، بروتوكول الجودة. |
| `craft/craft-single.md` · `craft/craft-thread.md` | جاهز (مُنقّى) | مستشار البنية (`lib/content/lab-bridge.ts`) | **لا يحتاج تعبئة.** حركات البنية للمنشور المفرد والثريد، تُحقن عند التوليد من اقتراحات مختبر الأسلوب. |

## ما الذي يجب عدم تغييره في البرومبتات

البرومبتات الأربعة (`prompts/*.md` و`craft/*.md`) مكتوبة بحيث تعمل **كما هي** دون تعبئة: تشير إلى «صاحب الحساب» أو «الكاتب» وتأخذ اسمك ومشروعك من `context.md`. إن عدّلتها فاحفظ حرفياً:

- **وسوم المدخل** التي يحقنها الكود: `<original_text>` · `<proposed_idea>` · `<input>` · `<directives>` · `<taste_calibration>` · `<voice_anchor>` وما شابهها، ومعها `{first_name}` في النشرة.
- **حقول المخرج JSON** ومسار الرفض (`draft` فارغ + `error` + `suggestion`) في `draft-writer.md`، فالكود يفكّكها بمخطط صارم.
- **معرّفات الشخصيات** `fahd · noura · khaled · aisha · omar · general` (تتشارك بين `analyze.ts` وملف السياق).

## ملاحظات على المعايرة

- اللهجة الافتراضية في البرومبتات **خليجية خفيفة**، وكذلك أمثلتها وقوائم الألفاظ ونطاقات الكثافة الرقمية (٣–٥ للنشرة التعليمية، ٥–٦٫٥ للبيعية لكل ١٠٠ كلمة) — هي افتراضات تُعاير على كتابتك. لتغيير اللهجة: عدّل `voice-and-tone.md` وقسم «الصوت» في `newsletter-writer.md`.
- الأمثلة الواردة في البرومبتات (عناوين، افتتاحيات، مفارقات) **مخترعة** للتوضيح، لا منقولة من أي حساب حقيقي.
- ملفات بصمة اختيارية قد يشير إليها الكود في تعليقاته (`newsletter-fingerprint.md` · `sales-fingerprint.md`) غير مطلوبة لتشغيل أي ميزة.

---

## English summary

`data/` holds everything that makes the output sound like **you**; the application code is generic.

**Before first use, fill in these four templates** (replace every `[...]` placeholder, then delete the "إرشاد/guidance" lines):

1. `context.md` — who you are, your project, its honest current state, your five audience personas (keep the persona IDs `fahd/noura/khaled/aisha/omar`, only change their descriptions). Read by classification, post analysis, article analysis, the agent specialists, the day planner and the newsletter engine.
2. `voice-and-tone.md` — your writing voice with before/after examples. Injected into both writing engines (X posts and newsletter).
3. `life-context.md` — your daily rhythm for the day planner (note: the planner hard-codes an 11:00–15:00 deep-work window in `lib/dayplan/engine.ts`).
4. `context-brief.md` — a ~1000-character distillation of `context.md` for the X writing engine.

Optional: `sales-emails-archive.md` (real sent sales emails in a strict format, used as tone examples; the system works without it).

The prompts (`prompts/draft-writer.md`, `prompts/newsletter-writer.md`, `craft/*.md`) are published in full and already sanitized; they work as-is and refer generically to "the account owner" / "the writer". The default dialect is light Gulf Arabic, and the numeric ranges are defaults to calibrate on your own writing. If you edit the prompts, keep the injected XML tags, the JSON output fields and the persona IDs byte-identical. File contents are sent to the model providers, so never put secrets in them, and do not commit your filled-in versions to a public repository.

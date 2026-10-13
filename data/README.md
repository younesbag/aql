# مجلد `data/` — ملفات السياق والبرومبتات

هذا المجلد هو **هوية النظام**: الكود عام ومشترك، وكل ما يجعل المخرجات «بصوتك أنت» موجود هنا. **قبل أول استخدام يجب أن تملأ القوالب الأربعة المعلَّمة «مطلوب» وتراجع `profile.json`** (كل ما بين `[...]` في القوالب يُستبدل بمعلومتك الحقيقية). الملفات تُقرأ من نظام الملفات وتُخزَّن في ذاكرة العملية: بعد أي تعديل أعد تشغيل الخادم محلياً، وعلى Vercel أعد النشر.

> **تنبيه خصوصية:** محتوى هذه الملفات يُرسل إلى مزوّدي النماذج (Gemini وClaude) ضمن البرومبتات. لا تكتب فيها كلمات مرور أو مفاتيح أو بيانات تخصّ غيرك. وإن نشرت نسختك علناً فلا تلتزم (commit) بملفاتك المعبّأة — ضعها في `.gitignore` أو احتفظ بها في مستودع خاص.

## جدول الملفات

| الملف | الحالة | من يقرؤه | ماذا تكتب فيه |
|---|---|---|---|
| `profile.json` | **مطلوب (له قيم افتراضية محايدة)** | ركائز المحتوى وشرائح الجمهور (تحليل النشر · `lib/content/analyze.ts`) · الواجهة (`Generator` و`PatternLab` ومعالج النشرة) · تعليمات النظام للمحرّكين (`lib/content/prompt-builder.ts` و`lib/newsletter/prompt-builder.ts`) · الطقس المسائي (`lib/dayplan/ritual.ts`) — عبر `lib/config/profile.ts` | ركائز المحتوى (`pillars`) وشرائح الجمهور (`personas`) واللهجة (`dialect`) ويوم المراجعة الأسبوعية (`weeklyReviewDay`). الشرح في القسم التالي. |
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
- **معرّف الشريحة العامة** `general`: يضيفه الكود تلقائياً إلى شرائح `profile.json` ولا يُعرَّف فيه.
- البرومبتات لا تذكر ركيزة ولا شريحة ولا لهجة بعينها: تُحيل إلى قسم «إعداد المالك» الذي يحقنه الكود في ذيل تعليمات النظام من `profile.json`. فلا تكتب فيها مفاتيحك.

## الإعداد الشخصي `profile.json`

الملف الوحيد الذي تعدّله لتخصيص أربع سمات. الكود يتحقق منه عند التحميل، وأي خطأ يوقف البناء أو التشغيل برسالة عربية تسمّي الحقل المعيب. تعديله يتطلب إعادة تشغيل الخادم محلياً، وإعادة نشر على Vercel، وإعادة تشغيل عامل الـVPS.

| الحقل | الشكل | ملاحظات |
|---|---|---|
| `pillars` | قائمة `{key, label}` من 2 إلى 8 | `key`: حروف لاتينية صغيرة وأرقام وشرطة سفلية (يبدأ بحرف، 2–40 خانة)؛ `label`: التسمية العربية الظاهرة. **الأولى هي الاحتياطية** حين يعيد النموذج ركيزة غير معروفة. تُخزَّن المفاتيح في `posts.content_pillar` (الهجرة `0002_configurable_pillars.sql` تفرض الصيغة فقط، فلا تحتاج هجرة عند إعادة التسمية). |
| `personas` | قائمة `{key, label, description}` من 1 إلى 7 | `description` يُحقن في برومبتات التحليل والنشرة ليحدّد مستوى التبسيط والأمثلة. `general` محجوز ويُضاف تلقائياً. |
| `dialect` | `{name, markers, density}` | `name`: عبارة عربية تصف اللغة المطلوبة وتُحقن في البرومبتات حرفياً. `markers`: معجم الكلمات التي تُعدّ لمسة لهجية. `density`: `null` أو `{default: [أدنى, أقصى], sales: [أدنى, أقصى]}` لكل ١٠٠ كلمة. **القياس الرقمي يعمل فقط حين يوجد معجم ونطاق معاً**؛ وإلا لا يرى النموذج أي أرقام ويكتفي بالاسم. |
| `weeklyReviewDay` | `"Sun"` `"Mon"` `"Tue"` `"Wed"` `"Thu"` `"Fri"` `"Sat"` | ليلة السؤال الأسبوعي عن نتيجة قرار متقادم في الطقس المسائي (بتوقيت `OWNER_TIMEZONE`). الافتراضي `"Thu"`. |

### مثال: لهجة خليجية بقياس رقمي

الافتراضي `{ "name": "فصحى مبسّطة", "markers": [], "density": null }` بلا أي قياس. هذا مثال لإعداد خليجي معتدل (هو الإعداد الذي بُني عليه النظام أصلاً؛ المعجم نُقل من الكود حرفياً، مع «شي» التي كانت تُعدّ بقاعدة منفصلة. أما قاعدة «هال…» الأصلية فكانت تستعمل حدّ الكلمة في التعبير النمطي (word boundary) الذي لا تطابق الحروف العربية فلم تُحسب أي كلمة قط، لذلك لم تُنقل):

```json
"dialect": {
  "name": "فصحى مبسّطة بنكهة خليجية معتدلة",
  "markers": [
    "بس", "خلني", "هذي", "كذا", "الحين", "ايش", "وش", "ليش", "شوف", "مو", "عشان", "زين", "تبي",
    "قعدت", "وحدة", "شوي", "سويت", "تسوي", "خلاص", "الجاي", "تقدر", "سوى", "صاير", "شي"
  ],
  "density": { "default": [3, 5], "sales": [5, 6.5] }
}
```

يُقاس بعدّ ورود كلمة كاملة من `markers` (بحدود كلمة، لا جزء كلمة) لكل ١٠٠ كلمة من النثر. عاير النطاقين على قياس نشراتك أنت: تحت أدنى النطاق يصير النصّ مصقولاً لا يشبه الصوت المحكي، وفوق أقصاه يصير تغريدة طويلة. أمثلة النشرة داخل `newsletter-writer.md` (عبارات مثل «خلني أكون صريحاً») مخترعة وبلهجة المؤلف الأصلي — استبدل بها أمثلة من لهجتك إن اختلفت.

## ملاحظات على المعايرة

- اللهجة المعتمدة في البرومبتات هي ما في `profile.json` (حقل `dialect`). بعض الأمثلة المضمّنة داخل `newsletter-writer.md` و`draft-writer.md` بلهجة المؤلف الأصلي وتُقرأ كأمثلة شكل لا كقواعد لهجة؛ أما وصف صوتك الفعلي فمكانه `voice-and-tone.md`.
- الأمثلة الواردة في البرومبتات (عناوين، افتتاحيات، مفارقات) **مخترعة** للتوضيح، لا منقولة من أي حساب حقيقي.
- ملفات بصمة اختيارية قد يشير إليها الكود في تعليقاته (`newsletter-fingerprint.md` · `sales-fingerprint.md`) غير مطلوبة لتشغيل أي ميزة.

---

## English summary

`data/` holds everything that makes the output sound like **you**; the application code is generic.

**Before first use, fill in these four templates** (replace every `[...]` placeholder, then delete the "إرشاد/guidance" lines):

1. `context.md` — who you are, your project, its honest current state, and deeper notes on your audience segments (the official segments are defined in `profile.json`). Read by classification, post analysis, article analysis, the agent specialists, the day planner and the newsletter engine.
2. `voice-and-tone.md` — your writing voice with before/after examples. Injected into both writing engines (X posts and newsletter).
3. `life-context.md` — your daily rhythm for the day planner (note: the planner hard-codes an 11:00–15:00 deep-work window in `lib/dayplan/engine.ts`).
4. `context-brief.md` — a ~1000-character distillation of `context.md` for the X writing engine.

**Also review `profile.json`** (neutral defaults ship with the repo): content pillars (2–8, snake_case keys + Arabic labels), audience personas (1–7; `general` is always added by code), dialect (`name`, `markers`, `density` — numeric density measurement is on only when both markers and density ranges are set; otherwise the model only sees the dialect name) and `weeklyReviewDay` (`"Sun"`..`"Sat"`, default `"Thu"`). It is validated at load with an Arabic error naming the bad field; changes need a rebuild/redeploy and a worker restart. A Gulf-dialect example with a marker list and density ranges is in the Arabic section above.

Optional: `sales-emails-archive.md` (real sent sales emails in a strict format, used as tone examples; the system works without it).

The prompts (`prompts/draft-writer.md`, `prompts/newsletter-writer.md`, `craft/*.md`) are published in full and already sanitized; they work as-is and refer generically to "the account owner" / "the writer". The dialect, pillars and personas come from `profile.json` (the prompts no longer hard-code them). If you edit the prompts, keep the injected XML tags and the JSON output fields byte-identical. File contents are sent to the model providers, so never put secrets in them, and do not commit your filled-in versions to a public repository.

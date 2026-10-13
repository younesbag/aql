---
name: smoke-ai
description: فحص دخاني حيّ لنداءات الذكاء في العقل الثاني — إلزامي قبل تسليم أي تعديل يمسّ lib/ai أو data/prompts أو مخطط JSON أو effort/maxTokens أو معرّف نموذج. يولّد سكربت فحص مؤقتاً، يشغّله على النموذج الحقيقي بمدخل طبيعي وشرير، يقيس الاستهلاك مقابل السقف، ثم ينظّف. Use before shipping any AI-call change (schema, prompt, effort, maxTokens, model) in this repo.
---

# الفحص الدخاني لنداءات الذكاء (smoke-ai)

المخرج المنظّم يضمن **الشكل**، لا الجودة ولا كفاية السقف ولا سلامة الهروب في كل الحالات. التاريخ هنا: مخطط نجح ٩٤٪ من سقفه في تشغيل ثم فشل ١٠٠٪/١٠٠٪ في التالي بنفس المدخل. الفحص الحيّ غير قابل للتفاوض.

> هذا الفحص يستهلك رصيدك الفعلي من واجهات النماذج (Anthropic وGemini). استخدم مفاتيحك أنت من `.env.local`، وتذكّر أن نداءات xhigh الطويلة ليست مجانية. شغّله عن قصد لا على سبيل العادة.

## متى إلزامي

أي تغيير في: `lib/ai/*.ts` · `data/prompts/*.md` · `data/craft/*.md` · أي مخطط JSON · `effort`/`maxTokens` · معرّف نموذج. (تغيير لا يمسّ مسار نداء — واجهة صرفة مثلاً — معفى.)

## خريطة النداءات الحالية (حدّثها إن غيّرتها)

| # | الموقع | النموذج | effort | السقف |
|---|--------|---------|--------|-------|
| ١ | `lib/content/generate.ts` — مسودة إكس | `WRITER_MODEL` (Claude) | xhigh | 32000 |
| ٢ | `lib/content/generate.ts` — نقد إكس | `WRITER_MODEL` | xhigh | 32000 |
| ٣ | `lib/newsletter/generate.ts` — أفكار | `WRITER_MODEL` | xhigh | 16000 |
| ٤ | `lib/newsletter/generate.ts` — هيكل | `WRITER_MODEL` | xhigh | 16000 |
| ٥ | `lib/newsletter/generate.ts` — مسودة | `WRITER_MODEL` | xhigh | 32000 |
| ٦ | `lib/newsletter/generate.ts` — نقد | `WRITER_MODEL` | xhigh | 32000 |
| ٧ | `lib/content/analyze.ts` — تحليل النشر | Gemini (`MODELS.pro`) | — | مخطط `ANALYSIS_SCHEMA` |
| ٨–١١ | `lib/agents/specialists.ts` — الوكلاء المتخصصون | Gemini (`MODELS.pro`) | — | `PATTERN_SCHEMA` · `MEASURE_SCHEMA` · `PROJECT_LINK_SCHEMA` · `EXTRACT_SCHEMA` |
| ١٢ | `lib/agents/proactive.ts` — الاستباقي | Gemini | — | `INSIGHTS_SCHEMA` |
| ١٣–١٥ | `lib/capture/article.ts` — المقالات | Gemini | — | `ARTICLE_SCHEMA` · `CONDENSE_SCHEMA` · `DERIVE_SCHEMA` |
| ١٦ | `lib/dayplan/engine.ts` — خطة اليوم | Gemini | — | `PLAN_SCHEMA` |

معرّفات النماذج الحيّة: `MODELS` في `lib/ai/gemini.ts` و`WRITER_MODEL` في `lib/ai/anthropic.ts` — انسخها من هناك لا من هذا الجدول. نداءات Gemini (٧–١٦) بلا `maxTokens` صريح، فمعيار «≤٨٠٪ من السقف» لا ينطبق عليها — افحص بدلاً منه صلاحية JSON وثبات القيم المقيّدة تحت المدخل الشرير.

## ١. اكتب السكربت المؤقت

`_smoke-<نطاق>.mjs` في جذر المستودع (تُحذف قبل الكومِت — `.gitignore` لا يحميك منها). **انسخ المخطط والبرومبت وإعدادات النداء من الكود الفعلي حرفياً** — فحص نسخة مبسطة لا يفحص شيئاً.

قالب كلود (البثّ إلزامي — يطابق `claudeJson` الفعلي):

```js
// _smoke-<نطاق>.mjs — يُحذف بعد التشغيل
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8");
const key = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("لا مفتاح في .env.local");
const client = new Anthropic({ apiKey: key });

const SCHEMA = { /* انسخه من الكود الفعلي */ };
const SYSTEM = "..."; // انسخ تجميعة النظام الفعلية
const PROMPT = "..."; // المدخل (انظر §٢)
const MAX = 32000, EFFORT = "xhigh"; // القيم الفعلية
const MODEL = "..."; // قيمة WRITER_MODEL من lib/ai/anthropic.ts

const t0 = Date.now();
const stream = client.messages.stream({
  model: MODEL,
  max_tokens: MAX,
  system: [{ type: "text", text: SYSTEM }],
  messages: [{ role: "user", content: PROMPT }],
  output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: EFFORT },
});
const res = await stream.finalMessage();
const out = res.usage.output_tokens, pct = Math.round((out / MAX) * 100);
console.log(`زمن ${Math.round((Date.now()-t0)/1000)}ث · stop=${res.stop_reason} · ${out}/${MAX} (${pct}%)`);
const text = res.content.find(b => b.type === "text")?.text ?? "";
try {
  const p = JSON.parse(text);
  console.log(`✅ JSON صالح · الجذر ${Array.isArray(p) ? "مصفوفة ⚠️" : "كائن"} · المفاتيح: ${Object.keys(Array.isArray(p)?p[0]:p).join(", ")}`);
} catch (e) { console.log(`❌ JSON مكسور: ${e.message}`); process.exit(1); }
```

قالب Gemini (لنداءات التحليل): نفس البنية بـ`@google/genai` — `ai.models.generateContent({model: <MODELS.pro من lib/ai/gemini.ts>, contents, config:{responseMimeType:"application/json", responseJsonSchema: SCHEMA}})` بمفتاح `GEMINI_API_KEY`.

## ٢. مدخلات الفحص الثلاثة

1. **طبيعي:** فكرة عربية حقيقية بحجم واقعي.
2. **شرير (إلزامي):** مدخل يستفزّ الهروب — اطلب في البرومبت اقتباساً مباشراً داخل علامتَي اقتباس مزدوجتين `"هكذا"` وقيمة طويلة فيها اقتباسات مفردة ومزدوجة وأسطر. هذا بالضبط ما كسر الإنتاج سابقاً.
3. **حالة الرفض** (لمخططات لها مسار رفض كمسودة إكس): مدخل فارغ القيمة/خارج النطاق، وتحقق أن `draft` فارغ و`error/suggestion` مملوءان كما يتوقع البرومبت.

## ٣. التشغيل والحكم

- نداءات xhigh تستغرق دقائق (٧–٨+ مرصودة): شغّل في الخلفية. للتحقق أن العملية حيّة لا معلّقة: افحص `Get-Process node` (ويندوز) أو `ps` (لينكس/ماك) — CPU شبه ثابت = انتظار شبكة **طبيعي**. لا تحكم بالتعليق قبل ~١٠ دقائق للنداء الواحد.
- **عتبات النجاح (كلها معاً):**
  - [ ] `stop_reason = "end_turn"` — أي `max_tokens` = فشل فوري.
  - [ ] `JSON.parse` ينجح والجذر كائن (لا مصفوفة) والحقول المقيّدة ضمن قيمها.
  - [ ] الاستهلاك ≤ ~٨٠٪ من السقف. فوقها؟ ارفع السقف وأعد الفحص.
  - [ ] **لنداءات xhigh: تشغيلان** للنداء الأضيق هامشاً — التفاوت المقيس ٧٪→١٠٠٪ بين تشغيلين متطابقين يجعل التشغيل الواحد بلا قيمة إحصائية.
  - [ ] عيّنة الجودة: اقرأ المخرج فعلاً — الصوت المعرَّف في `data/voice-and-tone.md` حاضر، لا هلوسة بنيوية.

## ٤. حدود مرجعية سريعة (لا تعِد اكتشافها بالخطأ)

- ≤ ١٦ حقل union/nullable لكل مخطط كلود (400 فوقها) — nullable للضرورة الدلالية فقط والباقي قيم افتراضية آمنة.
- لا prefill ولا temperature/top_p على Sonnet 5 (400).
- الكاش لا يعبر المخططات: نفس نص النظام + مخطط مختلف = كاش ضائع. `cache_read>0` يظهر فقط عند تكرار نفس (النظام + المخطط) خلال ~٥ دقائق.
- Gemini بلا `responseJsonSchema` قد يكسر الهروب أو يغلّف بمصفوفة — المدخل الشرير يكشف الأولى.

## ٥. التنظيف والتوثيق

- احذف كل `_smoke-*.mjs` قبل الكومِت: `rm -f _smoke-*.mjs`.
- سجّل الأرقام في «تحقّق حيّ:» برسالة الكومِت (ووصف الـPR): النسب لكل نداء مفحوص، الأزمنة، ونتيجة المدخل الشرير — ثم سلّم عبر `/ship`.

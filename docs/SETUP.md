# دليل التركيب — Setup Guide

[العربية](#العربية) · [English](#english)

> **تنبيه معروف / Known limitation:** هجرة التهيئة `supabase/migrations/0001_init.sql` جُمّعت من 41 هجرة تاريخية وراجعناها يدوياً، لكنها لم تُختبر بعد على مشروع Supabase نظيف من أول مستخدم خارجي. نفّذها على مشروع جديد فارغ وتحقّق من نتيجتها (الخطوة 3). إن فشلت فافتح issue وألصق رسالة الخطأ كاملة مع رقم السطر.
> The init migration was assembled from 41 historical migrations and reviewed, but it has not yet been smoke-tested on a fresh project by an outside user. Run it on an empty project and verify the result (step 3). If it fails, please open an issue with the full error message and line number.

---

## العربية

كل خطوة أدناه مرفقة بـ**تحقّق** قابل للتنفيذ. لا تنتقل للتالية قبل نجاح التحقق.

### 0. المتطلبات

| المطلوب | ملاحظة |
|---------|--------|
| Node.js 20.9 أو أحدث | يُنصح بـ Node 24 LTS (العامل يحتاج 23.6+ لتجريد الأنواع الأصلي) |
| حساب Supabase | الخطة المجانية تكفي |
| مفتاح Gemini API | من Google AI Studio — إلزامي (التضمين والتصنيف والتحليل) |
| حساب Vercel | خطة Hobby تكفي |
| بوت تيليجرام | من BotFather — قناة الالتقاط الأساسية |
| اختياري | مفتاح Anthropic API (مسار الكتابة الطارئ) · VPS + اشتراك Claude (العامل) · Loops · Typefully |

### 1. استنساخ المشروع

```bash
git clone <رابط-نسختك> second-brain
cd second-brain
```

### 2. إنشاء مشروع Supabase

1. أنشئ مشروعاً جديداً من لوحة Supabase، واحفظ كلمة مرور قاعدة البيانات.
2. من **Project Settings → API** انسخ ثلاث قيم: `Project URL` و`anon public key` و`service_role key`. (الأخير سرّي — لا يُرفع إلى git ولا يظهر في المتصفح.)
3. من **Database → Extensions** فعّل الإضافة `vector` (أو اترك الهجرة تفعّلها بسطر `CREATE EXTENSION IF NOT EXISTS vector`).

### 3. تنفيذ الهجرة

افتح **SQL Editor** في Supabase، الصق محتوى `supabase/migrations/0001_init.sql` كاملاً ونفّذه مرة واحدة، ثم نفّذ بعده `supabase/migrations/0002_configurable_pillars.sql` (يستبدل قيد ركائز المحتوى بفحص صيغة فقط لأن الركائز تُعرَّف في `data/profile.json`).

**تحقّق** (في SQL Editor):

```sql
-- الإضافة مفعّلة؟
SELECT extname FROM pg_extension WHERE extname = 'vector';

-- الجداول أُنشئت (يُتوقع عدد كبير، أبرزها items و app_owner و generation_jobs)؟
SELECT count(*) AS tables FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- RLS مفعّل على كل جدول؟ (النتيجة المتوقعة: صفر صفوف)
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND NOT rowsecurity;
```

### 4. إنشاء مستخدمك الوحيد وتسجيله مالكاً (خطوة إلزامية)

بدون هذه الخطوة تحجب RLS كل شيء عن الواجهة (لا مالك = لا وصول).

1. **Authentication → Users → Add user → Create new user**: أدخل بريدك وكلمة مرور (لن تستخدمها، الدخول برابط سحري)، وفعّل «Auto Confirm User».
2. انسخ قيمة **UID** من صف المستخدم.
3. في SQL Editor:

```sql
INSERT INTO app_owner (user_id) VALUES ('<UID-الذي-نسخته>');
```

4. **Authentication → Sign In / Providers**: عطّل «Allow new users to sign up» (دفاعاً بالعمق؛ صفحة الدخول تستخدم `signInWithOtp` الذي ينشئ مستخدمين جدداً افتراضياً، والأمان الفعلي أن غير المالك لا يصل لشيء بسبب RLS).
5. **Authentication → URL Configuration**: أضف `http://localhost:3000/auth/callback` الآن، وعنوان Vercel النهائي لاحقاً (`https://<نطاقك>/auth/callback`)، واضبط **Site URL** على عنوانك النهائي.

**تحقّق:**

```sql
SELECT user_id FROM app_owner;   -- صف واحد بـ UID الصحيح
```

### 5. قوالب السياق `data/*.md`

املأ القوالب الأربعة المعلَّمة «مطلوب» واستبدل كل ما بين `[...]` بمعلوماتك: `context.md` · `voice-and-tone.md` · `life-context.md` · `context-brief.md`. ثم راجع `data/profile.json` — ملف الإعداد الشخصي: ركائز المحتوى (2–8) وشرائح الجمهور (1–7) واللهجة (الاسم ومعجم القياس ونطاقات الكثافة، أو بلا قياس) ويوم المراجعة الأسبوعية. قيمه الافتراضية محايدة وتعمل كما هي، لكن اكتب في `personas` وصف شرائحك الفعلية. التفاصيل ومثال لهجة بقياس رقمي في [`data/README.md`](../data/README.md).

> محتوى هذه الملفات يُرسل إلى مزوّدي النماذج ضمن البرومبتات. لا تضع فيها أسراراً. وإن نشرت نسختك علناً فلا ترفع ملفاتك المعبّأة.

**تحقّق:** ابحث في الملفات الأربعة عن `[` — لا يجب أن يبقى فيها أي قوس قالب لم يُستبدل. وفي `profile.json` ابحث عن `[املأ` — لا يجب أن يبقى وصف شريحة لم تكتبه. أي خطأ في بنية `profile.json` يوقف `npm run build` برسالة عربية تسمّي الحقل.

### 6. متغيّرات البيئة

```bash
cp .env.example .env.local
```

| المتغيّر | الحالة | أين يُضبط | الوصف |
|----------|--------|-----------|-------|
| `OWNER_NAME` | موصى به | Vercel + العامل | اسمك كما يظهر في البرومبتات ورسائل البوت (الافتراضي «المالك») |
| `OWNER_TIMEZONE` | موصى به | Vercel + العامل | منطقة IANA لحساب «اليوم» (الافتراضي `Asia/Riyadh`) |
| `NEXT_PUBLIC_SUPABASE_URL` | **إلزامي** | Vercel | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **إلزامي** | Vercel | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **إلزامي** | Vercel + العامل | service_role key (سرّي) |
| `GEMINI_API_KEY` | **إلزامي** | Vercel | التضمين (768 بُعداً) والتصنيف والتحليل والمحادثة |
| `TELEGRAM_BOT_TOKEN` | إلزامي لقناة تيليجرام | Vercel + العامل | من BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | إلزامي لقناة تيليجرام | Vercel + العامل | معرّف محادثتك وحدك؛ البوت يتجاهل غيره |
| `TELEGRAM_WEBHOOK_SECRET` | إلزامي لقناة تيليجرام | Vercel | سرّ عشوائي طويل |
| `CRON_SECRET` | إلزامي للطقوس | Vercel | سرّ عشوائي طويل؛ Vercel يرسله تلقائياً ترويسة `Authorization: Bearer` |
| `ANTHROPIC_API_KEY` | اختياري | Vercel | مسار الكتابة «المباشر» الطارئ (بدون العامل، سقفه 300 ثانية) |
| `LOOPS_API_KEY` | اختياري | العامل | نشر النشرة عبر Loops |
| `LOOPS_WEBHOOK_SECRET` | اختياري | Vercel | سرّ توقيع webhook لوبس (يبدأ بـ `whsec_`) |
| `LOOPS_FROM_NAME` · `LOOPS_FROM_EMAIL` · `LOOPS_REPLY_TO` | اختياري | العامل | هوية المرسل؛ `LOOPS_FROM_EMAIL` هو الجزء قبل `@` فقط على نطاق مرسِل موثَّق في لوبس |
| `LOOPS_AUDIENCES` | اختياري | Vercel | الجماهير القابلة للنشر — صيغتها في القسم 12 (ليست في `.env.example`) |
| `WARMTH_INTERVAL_DAYS` | اختياري | العامل | فاصل تحديث دفء الجمهور (يقبل كسراً) |
| `TYPEFULLY_API_KEY` · `TYPEFULLY_SOCIAL_SET_ID` | اختياري | العامل | مسودات Typefully |
| `X_PROVIDER_API_KEY` · `X_ACCOUNT_HANDLE` | اختياري | العامل | حصاد أرقام إكس الأسبوعي (الحساب بدون `@`) |
| `WORKER_MODEL` · `WORKER_EFFORT` · `WORKER_POLL_MS` · `WORKER_TIMEOUT_MS` · `WORKER_LIMIT_BACKOFF_MS` · `WORKER_MAX_ATTEMPTS` · `WORKER_STALE_MINUTES` | اختياري | العامل | ضبط العامل — راجع `worker/.env.worker.example` |
| `CODEX_MODEL` · `CODEX_EFFORT` · `CODEX_BIN` | اختياري | العامل | ناقد خارجي عبر Codex CLI |

توليد سرّ عشوائي:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

معرّف محادثتك في تيليجرام (`TELEGRAM_ALLOWED_CHAT_ID`): بعد إنشاء البوت أرسل له أي رسالة، ثم افتح `https://api.telegram.org/bot<TOKEN>/getUpdates` وخذ `message.chat.id`. (قبل تسجيل الـwebhook فقط؛ بعدها لا يعمل `getUpdates`.)

### 7. تشغيل محلي

```bash
npm install
npm run dev
```

افتح `http://localhost:3000` ← يحوّلك إلى `/login`. أدخل بريدك الذي أنشأت به المستخدم، واضغط الرابط الذي يصلك. يجب أن تهبط على `/capture`.

**تحقّق:**
- التقط فكرة قصيرة من `/capture` — يجب أن تظهر في `/memory`.
- في Supabase: `SELECT count(*) FROM items;` يعيد 1 على الأقل.
- `npm run build` ينجح (حتى بلا مفاتيح بيئة).

### 8. النشر على Vercel

**أسرع طريق:** زر النشر بنقرة في [README](../README.md#النشر-بنقرة-على-vercel) — ينسخ المستودع ويطلب المتغيّرات الإلزامية مباشرة. أو يدوياً:

1. استورد المستودع في Vercel (Framework: Next.js، بلا تعديل أوامر البناء).
2. أضف متغيّرات البيئة من الجدول أعلاه (بيئة Production على الأقل).
3. انشر. بعد بلوغ النشر حالة **Ready** حدّث **Site URL** و**Redirect URLs** في Supabase بعنوان النشر.

> **خطة Hobby:** السقف الصلب لـ `maxDuration` هو **300 ثانية**؛ تجاوزه يُفشل النشر كلياً (`invalid_max_duration`). الصفحات الطويلة (المحتوى والنشرة) والـwebhook مضبوطة على 300 أصلاً — لا ترفعها. التوليد الأطول من ذلك مكانه العامل (القسم 11). وكرونات Hobby محدودة باثنين يومياً، وقد يتأخر التنفيذ داخل الساعة المحددة.

**تحقّق:** افتح عنوان النشر ← `/login` ← ادخل ← `/capture`.

### 9. مواعيد الكرون في `vercel.json`

التعبير بتوقيت **UTC**. الافتراضي مضبوط لـ `Asia/Riyadh` (UTC+3): الصباح 07:00 والمساء 22:00 بتوقيتك.

```json
{
  "crons": [
    { "path": "/api/cron/evening", "schedule": "0 19 * * *" },
    { "path": "/api/cron/morning", "schedule": "0 4 * * *" }
  ]
}
```

المعادلة: `ساعة الكرون (UTC) = الساعة المحلية المطلوبة − فرق منطقتك عن UTC (بالساعات)`.

| منطقتك | فرق UTC | مساء 22:00 | صباح 07:00 |
|--------|---------|------------|------------|
| `Asia/Riyadh` / `Asia/Kuwait` | +3 | `0 19 * * *` | `0 4 * * *` |
| `Asia/Dubai` | +4 | `0 18 * * *` | `0 3 * * *` |
| `Africa/Cairo` | +2 أو +3 صيفاً | `0 20 * * *` (أو 19) | `0 5 * * *` (أو 4) |
| `Europe/London` | 0 أو +1 صيفاً | `0 22 * * *` (أو 21) | `0 7 * * *` (أو 6) |

ثم اضبط `OWNER_TIMEZONE` على المنطقة نفسها في Vercel والعامل. (الكرون بلا توقيت صيفي تلقائي؛ عدّله يدوياً إن كانت منطقتك تغيّره.)

**تحقّق:** من لوحة Vercel → Project → Settings → Cron Jobs يظهر المساران؛ ويمكن تشغيل أحدهما يدوياً:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<نطاقك>/api/cron/morning
```

### 10. بوت تيليجرام

1. في تيليجرام افتح `@BotFather` ← `/newbot` ← احفظ الـtoken في `TELEGRAM_BOT_TOKEN`.
2. اضبط `TELEGRAM_ALLOWED_CHAT_ID` و`TELEGRAM_WEBHOOK_SECRET` (القسم 6) في `.env.local` وفي Vercel، وأعد النشر.
3. سجّل الـwebhook (مرة واحدة، وعند تغيّر النطاق أو السرّ). السكربت يقرأ المتغيّرات من `.env.local` عبر `--env-file`:

```bash
node --env-file=.env.local scripts/register-telegram-webhook.mjs https://<نطاقك>
```

4. سجّل قائمة الأوامر (تظهر عند كتابة «/»):

```bash
node --env-file=.env.local scripts/set-telegram-commands.mjs
```

**تحقّق:**
- مخرج السكربت الأول يطبع `getWebhookInfo` بحقل `url` صحيح و**بلا** `last_error_message`.
- أرسل للبوت `/مساعدة` فيردّ بقائمة الأوامر. أرسل جملة عادية فتُلتقط وتظهر في `/memory`.

### 11. العامل على VPS (اختياري)

يحتاج: خادماً (Node 24 LTS) واشتراك Claude. الخلاصة، والتفصيل في [`worker/README.md`](../worker/README.md):

```bash
npm install -g @anthropic-ai/claude-code && claude login
git clone <رابط-نسختك> /opt/mind && cd /opt/mind && npm ci
cp worker/.env.worker.example worker/.env.worker   # املأ SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY و OWNER_NAME
npm run worker:once                                # اختبار: طلب واحد ثم خروج
sudo cp worker/mind-worker.service /etc/systemd/system/ && sudo systemctl enable --now mind-worker
```

**تحقّق:** ولّد مسودة من `/content` بمحرّك «عبر الجلسة»، ثم راقب `journalctl -u mind-worker -f` وستظهر المسودة في الواجهة.

### 12. Loops وTypefully (اختياري)

**Loops (نشر النشرة):**
1. أنشئ مفتاح API من لوحة لوبس وضعه في `LOOPS_API_KEY` **على العامل**، مع `LOOPS_FROM_NAME` و`LOOPS_FROM_EMAIL` (الجزء قبل `@` على نطاق مرسِل موثَّق).
2. لتتبّع الأداء: في لوبس أضف webhook يشير إلى `https://<نطاقك>/api/loops/webhook` واحفظ سرّ التوقيع (`whsec_...`) في `LOOPS_WEBHOOK_SECRET` على Vercel. الطلبات تُتحقَّق بتوقيع HMAC (مواصفة Standard Webhooks) وتُرفض إن خرج الطابع الزمني عن 5 دقائق.
3. `LOOPS_AUDIENCES` (على Vercel) مصفوفة JSON اختيارية لشرائح وقوائم حسابك في لوبس. «كامل الجمهور» متاح دائماً دون إعداد. الصيغة:

```json
[
  { "key": "active", "type": "segment", "id": "<معرّف-الشريحة>", "label": "النشطون" },
  { "key": "list-1", "type": "list", "id": "<معرّف-القائمة>", "label": "قائمة الإحياء" }
]
```

`type` إما `segment` أو `list`، والحقول الأربعة كلها نصوص غير فارغة، و`key` يجب ألا يكون `all`. عنصر غير صالح يُتجاهل، والمصفوفة المكسورة كاملةً تُتجاهل مع سطر في السجل.

لا يوجد إرسال فوري: النشر إمّا يُترك مسودة في لوبس أو يُجدول لوقت محدد.

**Typefully (جدولة إكس):** ضع `TYPEFULLY_API_KEY` (واختيارياً `TYPEFULLY_SOCIAL_SET_ID`) على العامل؛ تُرسل المسودات إلى Typefully للمراجعة هناك.

### 13. استيراد بياناتك القديمة (اختياري)

سكربتان يدويان (يقرآن `.env.local`، ويدعمان `--dry-run` تجريبياً بلا كتابة). الاستيراد يضمّن فقط، والتصنيف كسول لاحقاً:

```bash
# أرشيف إكس (ملف tweets.js من تصدير حسابك)
node scripts/import-x-archive.mjs "<مسار/tweets.js>" --dry-run
node scripts/import-x-archive.mjs "<مسار/tweets.js>"

# قاعدة معرفة: مجلد فيه emails/ و notes/ و docs/<مشروع>/
node scripts/import-knowledge.mjs "<مسار/knowledge>" --dry-run
node scripts/import-knowledge.mjs "<مسار/knowledge>" --docs-reviewed
```

الخيار `--docs-reviewed` تأكيد أنك راجعت المستندات من الأسرار. شغّل `--dry-run` أولاً دائماً.

### استكشاف الأخطاء

| العرض | السبب المحتمل | العلاج |
|-------|---------------|--------|
| بعد الدخول لا تظهر بيانات أو تُحجب كلها | لم يُسجَّل UID في `app_owner` | نفّذ الخطوة 4 |
| رابط الدخول يعيدك إلى `/login?error=auth` | عنوان `/auth/callback` غير مضاف في Supabase | أضفه في URL Configuration |
| البوت لا يردّ | الـwebhook غير مسجَّل أو `TELEGRAM_ALLOWED_CHAT_ID` خاطئ أو السرّ مختلف | أعد تشغيل `register-telegram-webhook.mjs` وافحص `getWebhookInfo` |
| فشل النشر بـ `invalid_max_duration` | `maxDuration` فوق 300 على Hobby | أعده ≤ 300 |
| الكرون لا يعمل | `CRON_SECRET` غير مضبوط أو لم يُعد النشر بعد إضافته | اضبطه وأعد النشر |
| فشل الهجرة | قد تكون ثغرة في الهجرة المجمّعة | افتح issue بالخطأ كاملاً |

---

## English

Every step has a **verify** check you can run. Do not move on until it passes.

### 0. Prerequisites

| Needed | Notes |
|--------|-------|
| Node.js 20.9+ | Node 24 LTS recommended (the worker needs 23.6+ for native type stripping) |
| Supabase account | Free tier is enough |
| Gemini API key | From Google AI Studio — required (embeddings, classification, analysis) |
| Vercel account | Hobby plan is enough |
| Telegram bot | From BotFather — the primary capture channel |
| Optional | Anthropic API key (emergency writing path) · a VPS + Claude subscription (worker) · Loops · Typefully |

### 1. Clone

```bash
git clone <your-fork-url> second-brain
cd second-brain
```

### 2. Create the Supabase project

1. Create a new project and save the database password.
2. **Project Settings → API**: copy the `Project URL`, the `anon public key` and the `service_role key`. The service-role key is secret — never commit it, never expose it to the browser.
3. **Database → Extensions**: enable `vector` (or let the migration do it via `CREATE EXTENSION IF NOT EXISTS vector`).

### 3. Run the migration

Open the Supabase **SQL Editor**, paste the entire `supabase/migrations/0001_init.sql`, run it once, then run `supabase/migrations/0002_configurable_pillars.sql` (it replaces the content-pillar CHECK with a format-only check, because pillars are defined in `data/profile.json`).

**Verify** (SQL Editor):

```sql
SELECT extname FROM pg_extension WHERE extname = 'vector';

SELECT count(*) AS tables FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- Expect zero rows: RLS must be enabled on every public table
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND NOT rowsecurity;
```

### 4. Create your single user and register it as owner (mandatory)

Without this step RLS blocks everything from the UI (no owner = no access).

1. **Authentication → Users → Add user → Create new user**: enter your email and any password (you will not use it — login is by magic link) and enable "Auto Confirm User".
2. Copy the **UID** from the user's row.
3. In the SQL Editor:

```sql
INSERT INTO app_owner (user_id) VALUES ('<the-UID-you-copied>');
```

4. **Authentication → Sign In / Providers**: disable "Allow new users to sign up" (defence in depth: the login page uses `signInWithOtp`, which creates new users by default; the real protection is that a non-owner can read nothing because of RLS).
5. **Authentication → URL Configuration**: add `http://localhost:3000/auth/callback` now and `https://<your-domain>/auth/callback` later; set **Site URL** to your final address.

**Verify:**

```sql
SELECT user_id FROM app_owner;   -- exactly one row with your UID
```

### 5. Context templates in `data/*.md`

Fill the four templates marked "required" and replace every `[...]` placeholder: `context.md`, `voice-and-tone.md`, `life-context.md`, `context-brief.md`. Then review `data/profile.json`, your personal config file: content pillars (2–8), audience personas (1–7), dialect (name, marker list and density ranges, or no measurement) and the weekly review day. The shipped defaults are neutral and work as-is, but write your real segments into `personas`. A structural error in `profile.json` fails `npm run build` with an Arabic message naming the field. Details and a Gulf-dialect example in [`data/README.md`](../data/README.md).

> These files are sent to the model providers inside prompts. Never put secrets in them. If you publish your fork, do not commit your filled-in versions.

### 6. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Status | Set where | Description |
|----------|--------|-----------|-------------|
| `OWNER_NAME` | recommended | Vercel + worker | Your name as shown in prompts and bot messages (default: a generic Arabic word for "owner") |
| `OWNER_TIMEZONE` | recommended | Vercel + worker | IANA zone used to compute "today" (default `Asia/Riyadh`) |
| `NEXT_PUBLIC_SUPABASE_URL` | **required** | Vercel | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **required** | Vercel | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **required** | Vercel + worker | service_role key (secret) |
| `GEMINI_API_KEY` | **required** | Vercel | Embeddings (768 dims), classification, analysis, chat |
| `TELEGRAM_BOT_TOKEN` | required for Telegram | Vercel + worker | From BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | required for Telegram | Vercel + worker | Your own chat id; the bot ignores everyone else |
| `TELEGRAM_WEBHOOK_SECRET` | required for Telegram | Vercel | Long random secret |
| `CRON_SECRET` | required for rituals | Vercel | Long random secret; Vercel sends it automatically as `Authorization: Bearer` |
| `ANTHROPIC_API_KEY` | optional | Vercel | Emergency "direct" writing path (no worker, 300 s ceiling) |
| `LOOPS_API_KEY` | optional | worker | Newsletter publishing via Loops |
| `LOOPS_WEBHOOK_SECRET` | optional | Vercel | Loops webhook signing secret (starts with `whsec_`) |
| `LOOPS_FROM_NAME` · `LOOPS_FROM_EMAIL` · `LOOPS_REPLY_TO` | optional | worker | Sender identity; `LOOPS_FROM_EMAIL` is only the part before `@`, on a sending domain verified in Loops |
| `LOOPS_AUDIENCES` | optional | Vercel | Publishable audiences — format in section 12 (not in `.env.example`) |
| `WARMTH_INTERVAL_DAYS` | optional | worker | Audience "warmth" refresh interval (accepts fractions) |
| `TYPEFULLY_API_KEY` · `TYPEFULLY_SOCIAL_SET_ID` | optional | worker | Typefully drafts |
| `X_PROVIDER_API_KEY` · `X_ACCOUNT_HANDLE` | optional | worker | Weekly X metrics harvest (handle without `@`) |
| `WORKER_MODEL` · `WORKER_EFFORT` · `WORKER_POLL_MS` · `WORKER_TIMEOUT_MS` · `WORKER_LIMIT_BACKOFF_MS` · `WORKER_MAX_ATTEMPTS` · `WORKER_STALE_MINUTES` | optional | worker | Worker tuning — see `worker/.env.worker.example` |
| `CODEX_MODEL` · `CODEX_EFFORT` · `CODEX_BIN` | optional | worker | External critic via Codex CLI |

Generate a random secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Your Telegram chat id (`TELEGRAM_ALLOWED_CHAT_ID`): after creating the bot, send it any message, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`. (Only works before the webhook is registered.)

### 7. Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` — you are redirected to `/login`. Enter the email of the user you created and click the link you receive. You should land on `/capture`.

**Verify:**
- Capture a short idea on `/capture` — it should appear in `/memory`.
- In Supabase: `SELECT count(*) FROM items;` returns at least 1.
- `npm run build` succeeds (even with no environment variables).

### 8. Deploy to Vercel

**Fastest path:** the one-click button in the [README](../README.md#one-click-deploy-to-vercel) clones the repo and asks for the required variables. Or manually:

1. Import the repository in Vercel (Framework: Next.js, default build settings).
2. Add the environment variables from the table above (Production at minimum).
3. Deploy. Once the deployment is **Ready**, update **Site URL** and **Redirect URLs** in Supabase with the deployment URL.

> **Hobby plan:** `maxDuration` has a hard ceiling of **300 seconds**; exceeding it fails the deployment entirely (`invalid_max_duration`). The long pages (content, newsletter) and the Telegram webhook are already set to 300 — do not raise them. Anything longer belongs on the worker (section 11). Hobby also allows only two daily cron jobs, and execution may be delayed within the scheduled hour.

**Verify:** open the deployment URL, go to `/login`, sign in, land on `/capture`.

### 9. Cron times in `vercel.json`

Expressions are in **UTC**. The defaults are tuned for `Asia/Riyadh` (UTC+3): morning at 07:00 and evening at 22:00 local time.

```json
{
  "crons": [
    { "path": "/api/cron/evening", "schedule": "0 19 * * *" },
    { "path": "/api/cron/morning", "schedule": "0 4 * * *" }
  ]
}
```

Rule: `cron hour (UTC) = desired local hour − your UTC offset (hours)`.

| Your zone | UTC offset | Evening 22:00 | Morning 07:00 |
|-----------|-----------|---------------|---------------|
| `Asia/Riyadh` / `Asia/Kuwait` | +3 | `0 19 * * *` | `0 4 * * *` |
| `Asia/Dubai` | +4 | `0 18 * * *` | `0 3 * * *` |
| `Africa/Cairo` | +2 (+3 in summer) | `0 20 * * *` (or 19) | `0 5 * * *` (or 4) |
| `Europe/London` | 0 (+1 in summer) | `0 22 * * *` (or 21) | `0 7 * * *` (or 6) |

Then set `OWNER_TIMEZONE` to the same zone on Vercel and the worker. Cron does not follow daylight saving automatically; adjust by hand if your zone shifts.

**Verify:** Vercel → Project → Settings → Cron Jobs lists both paths, and you can trigger one manually:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-domain>/api/cron/morning
```

### 10. Telegram bot

1. In Telegram open `@BotFather` → `/newbot` → store the token in `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_ALLOWED_CHAT_ID` and `TELEGRAM_WEBHOOK_SECRET` (section 6) in `.env.local` and in Vercel, then redeploy.
3. Register the webhook (once, and again if the domain or secret changes). The script reads variables from `.env.local` via `--env-file`:

```bash
node --env-file=.env.local scripts/register-telegram-webhook.mjs https://<your-domain>
```

4. Register the command menu (shown when you type "/"):

```bash
node --env-file=.env.local scripts/set-telegram-commands.mjs
```

**Verify:**
- The first script prints `getWebhookInfo` with the right `url` and **no** `last_error_message`.
- Send `/مساعدة` to the bot — it replies with the command list. Send a plain sentence — it is captured and shows up in `/memory`.

### 11. VPS worker (optional)

Needs a server (Node 24 LTS) and a Claude subscription. Summary; details in [`worker/README.md`](../worker/README.md):

```bash
npm install -g @anthropic-ai/claude-code && claude login
git clone <your-fork-url> /opt/mind && cd /opt/mind && npm ci
cp worker/.env.worker.example worker/.env.worker   # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_NAME
npm run worker:once                                # test: process one job, then exit
sudo cp worker/mind-worker.service /etc/systemd/system/ && sudo systemctl enable --now mind-worker
```

**Verify:** generate a draft from `/content` with the "via session" engine, watch `journalctl -u mind-worker -f`, and the draft appears in the UI.

### 12. Loops and Typefully (optional)

**Loops (newsletter publishing):**
1. Create an API key in Loops and set `LOOPS_API_KEY` **on the worker**, together with `LOOPS_FROM_NAME` and `LOOPS_FROM_EMAIL` (the part before `@`, on a verified sending domain).
2. For performance tracking: add a Loops webhook pointing to `https://<your-domain>/api/loops/webhook` and store its signing secret (`whsec_...`) in `LOOPS_WEBHOOK_SECRET` on Vercel. Requests are verified with an HMAC signature (Standard Webhooks) and rejected if the timestamp is more than 5 minutes off.
3. `LOOPS_AUDIENCES` (on Vercel) is an optional JSON array of your Loops segments and lists. "Entire audience" is always available with no setup. Format:

```json
[
  { "key": "active", "type": "segment", "id": "<segment-id>", "label": "Active readers" },
  { "key": "list-1", "type": "list", "id": "<list-id>", "label": "Re-engagement list" }
]
```

`type` is `segment` or `list`; all four fields are non-empty strings; `key` must not be `all`. An invalid item is skipped, and a malformed array is ignored entirely with a log line.

There is no instant send: a publish either stays a draft in Loops or is scheduled for a specific time.

**Typefully (X scheduling):** set `TYPEFULLY_API_KEY` (and optionally `TYPEFULLY_SOCIAL_SET_ID`) on the worker; drafts are pushed to Typefully for review there.

### 13. Import your existing data (optional)

Two manual scripts (they read `.env.local` and support `--dry-run` for a no-write trial). Imports embed only; classification happens lazily later:

```bash
# X archive (tweets.js from your account export)
node scripts/import-x-archive.mjs "<path/to/tweets.js>" --dry-run
node scripts/import-x-archive.mjs "<path/to/tweets.js>"

# Knowledge base: a folder with emails/, notes/ and docs/<project>/
node scripts/import-knowledge.mjs "<path/to/knowledge>" --dry-run
node scripts/import-knowledge.mjs "<path/to/knowledge>" --docs-reviewed
```

`--docs-reviewed` confirms you checked the documents for secrets. Always run `--dry-run` first.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Signed in but no data / everything blocked | UID not registered in `app_owner` | Do step 4 |
| Magic link sends you to `/login?error=auth` | `/auth/callback` URL missing in Supabase | Add it under URL Configuration |
| Bot does not reply | Webhook not registered, wrong `TELEGRAM_ALLOWED_CHAT_ID`, or secret mismatch | Re-run `register-telegram-webhook.mjs` and check `getWebhookInfo` |
| Deploy fails with `invalid_max_duration` | `maxDuration` above 300 on Hobby | Set it to 300 or below |
| Cron never fires | `CRON_SECRET` missing, or no redeploy after adding it | Set it and redeploy |
| Migration fails | Possibly a gap in the assembled migration | Open an issue with the full error |

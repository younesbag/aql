-- ═══════════════════════════════════════════════════════════
-- المخطط المرجعي: الحالة التراكمية لهجرات `supabase/migrations/` (حتى 0002) — للقراءة
-- والمراجعة فقط. بعد هذا الترويس نسخة 0001_init.sql، مع تطبيق ما غيّرته الهجرات اللاحقة
-- (0002: قيد posts_content_pillar_chk صار فحص صيغة فقط، موسوماً في موضعه أدناه).
-- مصدر الحقيقة هو ملفات الهجرة؛ لا تُطبَّق التغييرات من هنا. أي تعديل جديد =
-- ملف هجرة مرقّم جديد، ثم يُحدَّث هذا الملف ليطابق.
-- ═══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════
-- العقل الثاني — مخطط قاعدة البيانات الكامل (Supabase / PostgreSQL)
-- ───────────────────────────────────────────────────────────
-- هجرة التهيئة الوحيدة: الحالة النهائية المجمّعة لكل الجداول والفهارس والدوال
-- وسياسات RLS. تُنفَّذ مرة واحدة على مشروع Supabase جديد (SQL Editor أو
-- `supabase db push`). أي تعديل لاحق = ملف هجرة مرقّم جديد (0002_*.sql …)،
-- ثم يُحدَّث `schema.sql` في جذر المستودع ليطابق.
--
-- • VECTOR(768) مقدّس — تغيير البُعد يكسر كل المتجهات المخزّنة.
-- • RLS بالمالك على كل جدول: الوصول لمستخدم واحد مسجَّل في جدول app_owner.
-- • الأتمتة (تيليجرام/cron/العامل/السكربتات) تعمل بمفتاح service_role الذي
--   يتجاوز RLS، فلا تحتاج سياسات.
--
-- خطوة ما بعد التنفيذ (إلزامية، مرة واحدة): سجّل المالك. أنشئ حسابك من
-- Supabase → Authentication → Users، انسخ الـUID، ثم نفّذ:
--
--   INSERT INTO app_owner (user_id) VALUES ('<UID-المالك>');
--
-- ثم عطّل التسجيل العام من Authentication → Sign In / Providers (دفاعاً بالعمق).
-- بدون هذا السطر تحجب RLS كل شيء عن الواجهة (الأمان الافتراضي: لا مالك = لا وصول).
-- لتغيير المالك لاحقاً: UPDATE app_owner SET user_id = '<UID-الجديد>';
-- ═══════════════════════════════════════════════════════════

-- تفعيل البحث الدلالي
CREATE EXTENSION IF NOT EXISTS vector;

-- ───────────────────────────────────────────────
-- المالك: صفّ واحد حصراً (id ثابت = true). جدول بلا سياسات → لا يصله إلا
-- service_role ومحرّر SQL، ويُقرأ من is_owner() (SECURITY DEFINER) فقط.
-- ───────────────────────────────────────────────
CREATE TABLE app_owner (
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_owner ENABLE ROW LEVEL SECURITY;

-- هل المستخدم الحالي (auth.uid()) هو المالك؟ تستخدمها كل سياسات RLS أدناه.
-- SECURITY DEFINER لأن الجدول أعلاه محجوب عن دور authenticated؛ search_path مثبّت
-- ضد اختطاف المسار. STABLE كي يخزّنها المخطِّط مرة لكل استعلام لا لكل صف.
CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_owner WHERE user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_owner() TO authenticated, service_role;

-- ───────────────────────────────────────────────
-- الجدول الأساسي: العناصر (كل ما يدخل النظام)
-- فكرة، إشارة محفوظة، ملاحظة صوتية، تغريدة مستوردة، إيميل، مقال... كلها "عنصر"
-- ───────────────────────────────────────────────
CREATE TABLE items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- المحتوى الخام
  raw_text        TEXT NOT NULL,              -- النص (مكتوب أو مُفرّغ من صوت)
  source_type     TEXT NOT NULL,              -- ٩ قيم — انظر قيد items_source_type_chk أدناه
  source_url      TEXT,                       -- رابط الإشارة المحفوظة إن وُجد
  origin          TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'import'

  -- نتائج التصنيف (استدعاء Gemini Flash واحد)
  topic           TEXT,                       -- الموضوع الرئيسي
  item_kind       TEXT,                       -- 'insight' | 'story' | 'comparison' | 'question' | 'observation'
  summary         TEXT,                       -- الفكرة الجوهرية بجملة واحدة
  entities        TEXT[],                     -- الكيانات المذكورة

  -- الحالة في خط أنابيب المحتوى
  status          TEXT NOT NULL DEFAULT 'new', -- 'new' | 'drafted' | 'published' | 'archived'

  -- البحث الدلالي
  embedding       VECTOR(768),                -- gemini-embedding-001 بـ outputDimensionality=768

  -- استيراد قاعدة المعرفة
  source_ref      TEXT,                       -- أثر المصدر ومفتاح منع التكرار (المشروع/الملف#المقطع)
  project         TEXT,                       -- اسم المشروع للمستندات (فارغ للإيميلات/الملاحظات/الأفكار)

  -- تحليل المقال المنظّم (تلخيص + خطة تطبيق + أفكار ثريدات/إيميلات + رؤى)
  analysis        JSONB,

  CONSTRAINT items_status_chk
    CHECK (status IN ('new','drafted','published','archived')),
  CONSTRAINT items_source_type_chk
    CHECK (source_type IN (
      'idea','signal','voice','tweet','email','message','note','document','article'
    )),
  CONSTRAINT items_origin_chk
    CHECK (origin IN ('manual','import'))
);

CREATE INDEX idx_items_created   ON items (created_at DESC);
CREATE INDEX idx_items_status    ON items (status);
CREATE INDEX idx_items_topic     ON items (topic);
CREATE INDEX idx_items_source    ON items (source_type);
CREATE INDEX idx_items_project   ON items (project);
-- فهرس البحث الدلالي (HNSW أسرع من IVFFlat للأحجام الصغيرة-المتوسطة)
CREATE INDEX idx_items_embedding ON items USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────────────────────────────
-- المنشورات المُولّدة (مخرجات حلقة التوليد)
-- ───────────────────────────────────────────────
CREATE TABLE posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  item_id         UUID REFERENCES items(id) ON DELETE SET NULL, -- الفكرة المصدر

  format          TEXT NOT NULL,               -- 'thread' | 'single' | 'email'
  draft_text      TEXT NOT NULL,               -- المسودة المولّدة
  final_text      TEXT,                        -- النسخة المنشورة (بعد تحريرك)
  status          TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published'
  published_at    TIMESTAMPTZ,

  -- التغذية الراجعة (تُملأ يدوياً أو بالحصاد الآلي بعد النشر)
  impressions     INTEGER,
  likes           INTEGER,
  replies         INTEGER,
  reposts         INTEGER,
  bookmarks       INTEGER,

  -- سمات مُستخرجة للتحليل (مختبر المحتوى)
  hook_type       TEXT,                        -- نوع الخطاف
  structure       TEXT,                        -- البنية
  emotion         TEXT,                        -- الشحنة العاطفية

  embedding       VECTOR(768),

  -- مخرجات محرّك المحتوى
  quality_score   NUMERIC,                     -- التقييم الإجمالي الذاتي للمسودة (0–10)
  hook_text       TEXT,                        -- نص الهوك منفصلاً (لمختبر الأنماط)

  -- مطالبة الطقس بأرقام منشور حديث — الرسالة التالية تُفكَّك خمسة أرقام
  awaiting_metrics BOOLEAN NOT NULL DEFAULT false,

  -- محور المحتوى من تحليل النشر — لتوزيع المحاور في المختبر (null = أرشيف)
  content_pillar  TEXT,

  -- إنفوغرافيك المسودة المحفوظة
  image_url       TEXT,

  -- حصاد الأداء الآلي: معرّف التغريدة جسرُ ربطٍ دائم مع أرقامها
  external_post_id   TEXT,
  posted_url         TEXT,
  metrics_updated_at TIMESTAMPTZ,

  CONSTRAINT posts_status_chk
    CHECK (status IN ('draft','published')),
  CONSTRAINT posts_format_chk
    CHECK (format IN ('thread','single','email')),
  -- (0002) الركائز تُعرَّف في data/profile.json؛ القيد يفرض الصيغة فقط
  CONSTRAINT posts_content_pillar_chk
    CHECK (content_pillar IS NULL OR content_pillar ~ '^[a-z][a-z0-9_]{1,39}$')
);

CREATE INDEX idx_posts_status    ON posts (status);
CREATE INDEX idx_posts_published ON posts (published_at DESC);
CREATE INDEX idx_posts_embedding ON posts USING hnsw (embedding vector_cosine_ops);
-- فريد جزئياً: منشور واحد لكل تغريدة، والمسودات غير المنشورة معفاة (NULL)
CREATE UNIQUE INDEX idx_posts_external_id
  ON posts (external_post_id) WHERE external_post_id IS NOT NULL;

-- ───────────────────────────────────────────────
-- سجلّ القرارات (الوظيفة ٥ — البذرة الأهم لـ"العقل الثاني")
-- البنية الصارمة: موقف ← قرار ← سبب ← نتيجة
-- ───────────────────────────────────────────────
CREATE TABLE decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  situation       TEXT NOT NULL,               -- الموقف/السياق
  decision        TEXT NOT NULL,               -- ما قررته
  reasoning       TEXT NOT NULL,               -- لماذا
  hypothesis      TEXT,                        -- الفرضية التي بنيت عليها
  -- النتيجة تُملأ لاحقاً (قد تكون بعد أسابيع)
  outcome         TEXT,
  outcome_date    TIMESTAMPTZ,
  was_correct     TEXT,                        -- 'yes' | 'no' | 'partial' | 'unknown'

  topic           TEXT,
  entities        TEXT[],
  embedding       VECTOR(768),

  -- بعد ضغط زرّ نتيجة القرار في الطقس — الرسالة التالية تُخزَّن نصَّ النتيجة
  awaiting_outcome BOOLEAN NOT NULL DEFAULT false,

  -- العنصر الملتقط الذي استُخرج منه القرار (زرّ «وثّقه») — حارس تكرار وجسر
  related_item_id  UUID REFERENCES items(id) ON DELETE SET NULL,

  CONSTRAINT decisions_was_correct_chk
    CHECK (was_correct IS NULL OR was_correct IN ('yes','no','partial','unknown'))
);

CREATE INDEX idx_decisions_created      ON decisions (created_at DESC);
CREATE INDEX idx_decisions_topic        ON decisions (topic);
CREATE INDEX idx_decisions_related_item ON decisions (related_item_id);
CREATE INDEX idx_decisions_embedding    ON decisions USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────────────────────────────
-- مذكرة المؤسس الأسبوعية (Founder Journal)
-- ───────────────────────────────────────────────
CREATE TABLE journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  week_of         DATE NOT NULL,               -- بداية الأسبوع

  learned         TEXT,                        -- ما الذي تعلمته؟
  failed          TEXT,                        -- ما الذي فشل؟
  succeeded       TEXT,                        -- ما الذي نجح؟
  changed         TEXT,                        -- ما الذي تغيّر في رأيي؟

  embedding       VECTOR(768)
);

CREATE INDEX idx_journal_week      ON journal_entries (week_of DESC);
CREATE INDEX idx_journal_embedding ON journal_entries USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────────────────────────────
-- محادثات «العقل» — صفّ لكل محادثة، والتقليم لأحدث ٥ في طبقة الإجراءات
-- ───────────────────────────────────────────────
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  title       TEXT,
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb  -- [{ role, text, sources }]
);

CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);

-- ───────────────────────────────────────────────
-- النشرة البريدية — مستقلّة عن posts (فصل تامّ عن محرّك إكس)
-- ───────────────────────────────────────────────
CREATE TABLE newsletters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL DEFAULT 'idea'
              CHECK (status IN ('idea','outline','draft','final')),
  subject     TEXT,
  idea        TEXT,
  outline     TEXT,
  draft       TEXT,
  criteria    JSONB NOT NULL DEFAULT '{}'::jsonb, -- معايير التوليد (محور/شخصية/زاوية/طول…)
  embedding   VECTOR(768),                        -- للاسترجاع لاحقاً (بلا فهرس — غير مستعلَم بعد)

  -- النص الخام: مادّة القصة والأرقام الحقيقية التي يبني عليها المحرّك
  raw_text    TEXT,

  -- معرّف الحملة المنشورة في لوبس (انظر loops_campaigns)
  loops_campaign_id TEXT
);

CREATE INDEX idx_newsletters_updated ON newsletters (updated_at DESC);

-- ───────────────────────────────────────────────
-- مدير اليوم — المشاريع (وعاء الموازنة ٥٠/٥٠ بين المشروع والعمل)
-- ───────────────────────────────────────────────
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  name            TEXT NOT NULL UNIQUE,            -- اسم المشروع (فريد — مرجع الربط والـseed)
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'planned' | 'frozen'
  relative_weight INTEGER NOT NULL DEFAULT 50,     -- الوزن النسبي للموازنة التراكمية
  notes           TEXT,

  CONSTRAINT projects_status_chk
    CHECK (status IN ('active','planned','frozen'))
);

-- الصفّان المبدئيان الوحيدان (بيانات تشغيلية لازمة): الكود يحلّ معرّفات المشاريع
-- بهذين الاسمين (PROJECT_MAIN / PROJECT_SECOND في lib/capture/task.ts)
INSERT INTO projects (name, status, relative_weight)
VALUES ('المشروع', 'active', 50),
       ('العمل', 'active', 50)
ON CONFLICT (name) DO NOTHING;

-- ───────────────────────────────────────────────
-- المهام — بخطوات مفكّكة وجسور اختيارية للأفكار والقرارات
-- ───────────────────────────────────────────────
CREATE TABLE tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  title               TEXT NOT NULL,                       -- عنوان المهمة (موجز)
  -- الخطوات المفكّكة: مصفوفة [{ text, est_minutes, done }] — القاعدة الذهبية
  steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_id          UUID REFERENCES projects(id) ON DELETE SET NULL, -- null = شخصي
  kind                TEXT NOT NULL DEFAULT 'admin',       -- build|market|content|admin|personal — لكشف نمط المماطلة
  status              TEXT NOT NULL DEFAULT 'inbox',       -- inbox|planned|done|dropped
  time_signal         TEXT,                                -- إشارة زمنية مُستخرجة («بكرة»، «نهاية الأسبوع») أو null

  -- مصفوفة تواريخ الترحيل — لعدّ مرّات الترحيل (المواجهة عند الثالثة)
  deferrals           JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_item_id     UUID REFERENCES items(id) ON DELETE SET NULL,      -- جسر اختياري لفكرة
  related_decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,  -- جسر اختياري لقرار
  capture_source      TEXT NOT NULL DEFAULT 'telegram',    -- مصدر الالتقاط (telegram | system | …)

  -- وقت الإنجاز (لقياس الموازنة ومعدل الإنجاز المتعلَّم)
  done_at             TIMESTAMPTZ,

  -- طبقة التعلّم والمواجهة
  blocker             TEXT,                                -- العائق المكشوف عند الترحيل الثالث
  awaiting_blocker    BOOLEAN NOT NULL DEFAULT false,      -- الرسالة التالية تُعامَل كعائق لا كالتقاط

  CONSTRAINT tasks_kind_chk
    CHECK (kind IN ('build','market','content','admin','personal')),
  CONSTRAINT tasks_status_chk
    CHECK (status IN ('inbox','planned','done','dropped'))
);

CREATE INDEX idx_tasks_status  ON tasks (status);
CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_kind    ON tasks (kind);
CREATE INDEX idx_tasks_created ON tasks (created_at DESC);

-- ───────────────────────────────────────────────
-- خطط اليوم — خطة واحدة لكل يوم (بالمنطقة الزمنية للمالك)
-- ───────────────────────────────────────────────
CREATE TABLE day_plans (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  plan_date          DATE NOT NULL UNIQUE,            -- اليوم الذي تخصّه الخطة
  status             TEXT NOT NULL DEFAULT 'active',  -- 'draft' (أثناء الطقس) | 'active' (أُرسلت)
  exception          TEXT,                            -- سفر/ترفيه/موعد/نص حر — أو null = عادي
  awaiting_exception BOOLEAN NOT NULL DEFAULT false,  -- بانتظار نص حرّ للاستثناء
  why                TEXT,                            -- سطر «لماذا» لاختيار اليوم
  task_ids           JSONB NOT NULL DEFAULT '[]'::jsonb, -- معرّفات المهام المختارة بالترتيب
  built_via          TEXT NOT NULL DEFAULT 'evening', -- 'evening' | 'morning_fallback'

  CONSTRAINT day_plans_status_chk
    CHECK (status IN ('draft','active')),
  CONSTRAINT day_plans_built_via_chk
    CHECK (built_via IN ('evening','morning_fallback'))
);

CREATE INDEX idx_day_plans_date ON day_plans (plan_date DESC);

-- ───────────────────────────────────────────────
-- طابور المهام الخلفية (عامل الخادم الخاص VPS)
-- الواجهة تجهّز المدخل كاملاً وتصفّه؛ العامل ينفّذ بجلسة الاشتراك ويكتب النتيجة،
-- والواجهة تستطلع. عامل واحد. العامل يعمل بمفتاح service_role (يتجاوز RLS).
-- ───────────────────────────────────────────────
CREATE TABLE generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | running | done | failed
  attempts INT NOT NULL DEFAULT 0,                -- محاولات العامل (تُرفع عند كل قفل)
  locked_at TIMESTAMPTZ,                          -- وقت قفل العامل (لاسترداد اليتيم)
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  item_id UUID REFERENCES items(id) ON DELETE SET NULL,  -- الفكرة المصدر (null = حرّة)
  analysis JSONB NOT NULL,                        -- PublishingAnalysis (لبرومبت النقد وللعرض)
  critique_enabled BOOLEAN NOT NULL DEFAULT true,
  user_content TEXT NOT NULL,                     -- مدخل المحرّك مركّباً كاملاً على الواجهة
  result JSONB,                                   -- GeneratedDraft عند النجاح
  model_used TEXT,                                -- ما نفّذ فعلاً (شفافية المقارنة)
  worker_note TEXT,                               -- ملاحظات العامل (حصة الاشتراك، محاولات…)
  error TEXT,                                     -- سبب الفشل بالعربية

  -- تحكّم لكل طلب: نموذج وعمق تفكير اختياريان (NULL = افتراضيا العامل)
  model TEXT,
  effort TEXT,

  -- ناقد المسودة لكل طلب: NULL = النقد الداخلي · codex = ناقد خارجي يحكم
  -- · merge = توليدتان متوازيتان تُركَّب أفضلهما
  critic TEXT,
  alt_result JSONB,                               -- التوليدة الثانية الخام في نهج merge

  raw_text TEXT,                                  -- النص الخام يصل الكاتب والناقد والدامج

  -- نوع المهمة على الطابور
  kind TEXT NOT NULL DEFAULT 'draft',
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,

  -- جولات المراجعة: جولة تحمل المسودة السابقة وملاحظة الرفض
  revision_of UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
  revision_note TEXT,

  -- النشرة: مرحلة واحدة تحمل الثلاث، وربط اختياري بصفّ النشرة
  newsletter_stage TEXT,
  newsletter_id UUID REFERENCES newsletters(id) ON DELETE SET NULL,

  CONSTRAINT generation_jobs_status_chk
    CHECK (status IN ('queued','running','done','failed')),
  CONSTRAINT generation_jobs_effort_chk
    CHECK (effort IS NULL OR effort IN ('low','medium','high','xhigh')),
  CONSTRAINT generation_jobs_critic_chk
    CHECK (critic IS NULL OR critic IN ('codex','merge')),
  CONSTRAINT generation_jobs_kind_chk
    CHECK (kind IN (
      'draft','visual','typefully','harvest','newsletter','warmth','loops_publish'
    )),
  CONSTRAINT generation_jobs_nl_stage_chk
    CHECK (newsletter_stage IS NULL OR newsletter_stage IN ('ideas','outline','draft'))
);

CREATE INDEX idx_genjobs_status ON generation_jobs (status, created_at);

-- مخزن الصور: عام عمداً (المحتوى يُنشر علناً أصلاً) — الكتابة بمفتاح الخدمة فقط
INSERT INTO storage.buckets (id, name, public) VALUES ('visuals', 'visuals', true)
ON CONFLICT (id) DO NOTHING;

-- ───────────────────────────────────────────────
-- معايرة الذوق: أزواج (توليدة مرفوضة ↔ نسخة فضّلها المالك + درس) تُحقن في مدخل
-- التوليد كأعلى سلطة أسلوبية — ذاكرة ذوق حية تتراكم. القناة تفصل إكس عن النشرة.
-- ───────────────────────────────────────────────
CREATE TABLE taste_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idea_text TEXT,                 -- الفكرة الخام (اختياري)
  rejected_draft TEXT NOT NULL,   -- توليدة النظام التي رفضها
  preferred_draft TEXT NOT NULL,  -- النسخة التي فضّلها
  lesson TEXT,                    -- خلاصة الفرق (اختياري)
  active BOOLEAN NOT NULL DEFAULT true,
  channel TEXT NOT NULL DEFAULT 'x',

  CONSTRAINT taste_pairs_channel_chk CHECK (channel IN ('x','newsletter'))
);

CREATE INDEX idx_taste_pairs_channel ON taste_pairs (channel, active);

-- ───────────────────────────────────────────────
-- حلقة الأداء البريدية: أحداث webhook لوبس خاماً (لا عدّادات مجمّعة — الخام يحفظ
-- القصة كاملة، والتجميع منظور محسوب لا حالة قابلة للانجراف)
-- ───────────────────────────────────────────────
CREATE TABLE email_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Webhook-Id من الترويسة: ثابت عبر إعادات الإرسال — مفتاح منع التكرار
  event_id        TEXT NOT NULL UNIQUE,
  event_name      TEXT NOT NULL,               -- email.opened | email.clicked | …
  occurred_at     TIMESTAMPTZ,                 -- eventTime من الحمولة

  -- مصدر الحدث: حملة أو تدفّق أو معاملاتي (أحدها يُملأ حسب sourceType)
  source_type     TEXT,
  campaign_id     TEXT,
  loop_id         TEXT,
  transactional_id TEXT,

  email_message_id TEXT,                       -- يربط بنصّ الرسالة في /v1/email-messages
  subject         TEXT,
  contact_email   TEXT,                        -- قائمة المالك الخاصة — نظام مالك واحد خلف RLS

  payload         JSONB NOT NULL,              -- الحمولة كاملة: لا يضيع حقل لم يفكَّك

  CHECK (event_name <> '' AND char_length(event_name) <= 100),
  CHECK (char_length(event_id) <= 200)
);

CREATE INDEX idx_email_events_campaign ON email_events (campaign_id, event_name)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_email_events_loop ON email_events (loop_id, event_name)
  WHERE loop_id IS NOT NULL;
CREATE INDEX idx_email_events_received ON email_events (received_at DESC);

-- منظور التجميع: security_invoker كي لا يتجاوز المنظورُ سياساتِ الجدول
CREATE OR REPLACE VIEW campaign_email_stats WITH (security_invoker = true) AS
SELECT
  campaign_id,
  count(*) FILTER (WHERE event_name = 'campaign.email.sent')                       AS sent,
  count(*) FILTER (WHERE event_name = 'email.delivered')                           AS delivered,
  count(DISTINCT contact_email) FILTER (WHERE event_name = 'email.opened')         AS unique_opens,
  count(*) FILTER (WHERE event_name = 'email.opened')                              AS total_opens,
  count(DISTINCT contact_email) FILTER (WHERE event_name = 'email.clicked')        AS unique_clicks,
  count(*) FILTER (WHERE event_name = 'email.clicked')                             AS total_clicks,
  count(*) FILTER (WHERE event_name IN ('email.hardBounced','email.softBounced'))  AS bounces,
  count(*) FILTER (WHERE event_name = 'email.unsubscribed')                        AS unsubscribes,
  min(received_at)                                                                 AS first_event_at,
  max(received_at)                                                                 AS last_event_at
FROM email_events
WHERE campaign_id IS NOT NULL
GROUP BY campaign_id;

-- ───────────────────────────────────────────────
-- نظام الدفء الحي: أساس تاريخي ثابت (يُزرع مرة واحدة إن وُجد) + أحداث email_events
-- بعد خط الأساس. التصنيف يُحسب أسبوعياً على العامل ويُكتب للوبس عند التغيّر فقط.
-- ───────────────────────────────────────────────
CREATE TABLE email_warmth (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,          -- lowercase دائماً
  -- الأساس التاريخي (لا يتغيّر بعد الزرع)
  base_sends       INT NOT NULL DEFAULT 0,
  base_opens       INT NOT NULL DEFAULT 0,        -- حملات مفتوحة (فريدة)
  base_clicked     INT NOT NULL DEFAULT 0,        -- حملات منقورة (فريدة)
  base_sales_clicks INT NOT NULL DEFAULT 0,
  base_last_activity_at TIMESTAMPTZ,              -- آخر نشاط حتى لقطة الأساس
  baseline_at      TIMESTAMPTZ NOT NULL DEFAULT now(), -- لحظة خط الأساس: أحداث بعدها تُحتسب حيّة
  -- الحالة الحية (آخر ما حُسب وكُتب للوبس)
  warmth           TEXT NOT NULL,
  score            INT NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ,                   -- آخر كتابة ناجحة للوبس
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- العدّاد البيعي الحي = أساس + نقرات الحملات الموسومة بيعياً في loops_campaigns
  sales_clicks     INT NOT NULL DEFAULT 0,

  -- الردود والتحويل: الرد حدث اصطناعي email.replied من أمر تيليجرام /رد
  replied          INT NOT NULL DEFAULT 0,        -- ردود مسجّلة (يعادل الرد نقرتين)
  converted_at     TIMESTAMPTZ,
  conversion_stage TEXT,                          -- من خصائص منصة المنتج (status/userGroup) عبر لوبس

  CHECK (warmth IN ('vhot','warm','lukewarm','cold','new')),
  CHECK (score >= 0 AND score <= 100),
  CHECK (email = lower(email) AND char_length(email) <= 320),
  CONSTRAINT email_warmth_conv_stage_chk
    CHECK (conversion_stage IS NULL OR char_length(conversion_stage) <= 40)
);

CREATE INDEX idx_email_warmth_warmth ON email_warmth (warmth);

-- ───────────────────────────────────────────────
-- سجلّ الحملات المنشورة من النظام (أو المكتشفة): الغرض والجمهور وقت النشر —
-- وقود العدّ البيعي الحي والتحليل الموسوم، ولقطة الحكم المجمّدة بعد ٤٨ ساعة
-- ───────────────────────────────────────────────
CREATE TABLE loops_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     TEXT NOT NULL UNIQUE,          -- معرّف الحملة في لوبس
  email_message_id TEXT,
  subject         TEXT NOT NULL,
  purpose         TEXT,                          -- غرض النشرة وقت النشر (teaching/revive/…)
  audience_label  TEXT,                          -- وصف الجمهور المستهدف
  newsletter_id   UUID REFERENCES newsletters(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ,                   -- null = تُركت مسودة في لوبس
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  source          TEXT NOT NULL DEFAULT 'system', -- system | discovered (مرسلة يدوياً واكتُشفت من أحداثها)
  report          JSONB,                          -- لقطة الـ٤٨ ساعة المجمّدة
  report_sent_at  TIMESTAMPTZ,

  CHECK (char_length(campaign_id) <= 100),
  CHECK (subject <> '' AND char_length(subject) <= 500),
  CONSTRAINT loops_campaigns_source_chk
    CHECK (source IN ('system','discovered'))
);

-- ═══════════════════════════════════════════════════════════
-- دوال البحث الدلالي الأربع
-- كلها SECURITY INVOKER (الافتراضي) → سياسات RLS بالمالك تُطبَّق داخلها، فلا تسرّب.
-- ═══════════════════════════════════════════════════════════

-- دالة البحث الدلالي الموحّد (تُستخدم من المُستجوِب والاسترجاع) — العناصر
CREATE OR REPLACE FUNCTION match_items (
  query_embedding VECTOR(768),
  match_count     INT DEFAULT 10,
  filter_status   TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID, raw_text TEXT, summary TEXT, topic TEXT,
  source_type TEXT, created_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.raw_text, i.summary, i.topic,
         i.source_type, i.created_at,
         1 - (i.embedding <=> query_embedding) AS similarity
  FROM items i
  WHERE i.embedding IS NOT NULL
    AND (filter_status IS NULL OR i.status = filter_status)
  ORDER BY i.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- القرارات — توسعة المُستجوِب من الأفكار إلى كل الذاكرة
CREATE OR REPLACE FUNCTION match_decisions (
  query_embedding VECTOR(768),
  match_count     INT DEFAULT 6
)
RETURNS TABLE (
  id UUID, situation TEXT, decision TEXT, reasoning TEXT,
  outcome TEXT, was_correct TEXT, created_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT d.id, d.situation, d.decision, d.reasoning, d.outcome, d.was_correct, d.created_at,
         1 - (d.embedding <=> query_embedding) AS similarity
  FROM decisions d
  WHERE d.embedding IS NOT NULL
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- المذكرة الأسبوعية
CREATE OR REPLACE FUNCTION match_journal (
  query_embedding VECTOR(768),
  match_count     INT DEFAULT 6
)
RETURNS TABLE (
  id UUID, week_of DATE, learned TEXT, failed TEXT, succeeded TEXT, changed TEXT,
  created_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT j.id, j.week_of, j.learned, j.failed, j.succeeded, j.changed, j.created_at,
         1 - (j.embedding <=> query_embedding) AS similarity
  FROM journal_entries j
  WHERE j.embedding IS NOT NULL
  ORDER BY j.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- المنشورات المنشورة — أمثلة الاحتذاء القريبة دلالياً لمحرّك المحتوى
CREATE OR REPLACE FUNCTION match_posts (
  query_embedding VECTOR(768),
  match_count     INT DEFAULT 12
)
RETURNS TABLE (
  id UUID, draft_text TEXT, likes INT, replies INT, reposts INT, bookmarks INT,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.draft_text, p.likes, p.replies, p.reposts, p.bookmarks,
         1 - (p.embedding <=> query_embedding) AS similarity
  FROM posts p
  WHERE p.embedding IS NOT NULL
    AND p.status = 'published'
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ═══════════════════════════════════════════════════════════
-- RLS بالمالك على كل جداول التطبيق (١٤ جدولاً)
-- ───────────────────────────────────────────────────────────
-- لو بقيت سياسة «أي مستخدم مصادَق» لرأى كل من يسجّل في Supabase (التسجيل مفتوح
-- افتراضياً) كل بياناتك. لذا كل سياسة تشترط is_owner() — أي auth.uid() المسجَّل في
-- app_owner وحده. الأتمتة بـservice_role تتجاوز RLS فتبقى تعمل.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletters      ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE taste_pairs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_warmth     ENABLE ROW LEVEL SECURITY;
ALTER TABLE loops_campaigns  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_only_items" ON items
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_posts" ON posts
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_decisions" ON decisions
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_journal" ON journal_entries
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_conversations" ON conversations
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_newsletters" ON newsletters
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_projects" ON projects
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_tasks" ON tasks
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_day_plans" ON day_plans
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_generation_jobs" ON generation_jobs
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_taste_pairs" ON taste_pairs
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_email_events" ON email_events
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_email_warmth" ON email_warmth
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

CREATE POLICY "owner_only_loops_campaigns" ON loops_campaigns
  FOR ALL TO authenticated
  USING ((SELECT public.is_owner()))
  WITH CHECK ((SELECT public.is_owner()));

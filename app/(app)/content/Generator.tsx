"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  generateForItem,
  generateForText,
  saveDraft,
  saveTastePair,
  queueGeneration,
  queueVisual,
  queueTypefully,
  queueRevision,
  pollGenerationJob,
  cancelGeneration,
} from "./actions";
import { DEFAULT_OVERRIDES, type GenOverrides } from "@/lib/content/overrides";
import { PERSONAS_WITH_GENERAL, PILLARS } from "@/lib/config/profile";

type Idea = {
  id: string;
  raw_text: string;
  summary: string | null;
  topic: string | null;
  status: string;
};

// وسم دورة الحياة في المنتقي (الملف 14 — البند ١): المستهلَك يبقى قابلاً لإعادة
// التوليد لكنه مميَّز عن الجديد.
const STATUS_MARK: Record<string, string> = {
  drafted: " — سبق توليدها",
  published: " — نُشرت",
};

// حمولة النجاح فقط (الإجراء يُعيد اتحاداً مميّزاً {ok, ...}) — لحالة النتيجة في الواجهة.
type GenSuccess = Extract<
  Awaited<ReturnType<typeof generateForItem>>,
  { ok: true }
>["result"];

// خرائط عربية لقيم التصنيف (القاعدة ٥: لا رموز إنجليزية في الواجهة).
const TYPE_AR: Record<string, string> = {
  thread: "ثريد",
  tweet: "تغريدة",
  single: "تغريدة",
  THREAD: "ثريد",
  LONG_TWEET: "تغريدة طويلة",
  MEDIUM_TWEET: "تغريدة",
};
// الركائز والشرائح من data/profile.json (مفاتيح → تسميات عربية).
const PILLAR_AR: Record<string, string> = Object.fromEntries(PILLARS.map((p) => [p.key, p.label]));
const PERSONA_AR: Record<string, string> = Object.fromEntries(
  PERSONAS_WITH_GENERAL.map((p) => [p.key, p.label]),
);
const DRIVER_AR: Record<string, string> = {
  bookmark: "الحفظ",
  repost: "إعادة النشر",
  reply: "التعليق",
  dwell_time: "وقت القراءة",
};
const HOOK_AR: Record<string, string> = {
  strong: "قوي",
  medium: "متوسط",
  weak: "ضعيف",
};
const CTA_AR: Record<string, string> = {
  premium: "دعوة مميّزة",
  short: "دعوة قصيرة",
  none: "بلا",
};
const ar = (m: Record<string, string>, v: string) => m[v] ?? v;

const inputCls =
  "w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40";

export function Generator({ ideas }: { ideas: Idea[] }) {
  const [selectedId, setSelectedId] = useState(ideas[0]?.id ?? "");
  const [mode, setMode] = useState<"saved" | "new">(ideas.length > 0 ? "saved" : "new");
  const [freeText, setFreeText] = useState("");
  const [genItemId, setGenItemId] = useState<string | null>(null); // مصدر النتيجة الحالية (null = فكرة حرّة)
  const [ov, setOv] = useState<GenOverrides>(DEFAULT_OVERRIDES);
  const [result, setResult] = useState<GenSuccess | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();
  // محرّك التنفيذ (الملف 16): «الجلسة» = طابور + عامل الـVPS (Fable، بلا سقف زمني)
  // وهو الافتراضي بقرار المالك؛ «المباشر» = مسار API القديم حرفياً (طوارئ، ≤300ث).
  const [engine, setEngine] = useState<"session" | "direct">("session");
  // تحكّم لكل طلب (هجرتا 0021 و0022): "" = الافتراضي (العامل / النقد الداخلي)
  const [jobModel, setJobModel] = useState("");
  const [jobEffort, setJobEffort] = useState("");
  const [jobCritic, setJobCritic] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobNote, setJobNote] = useState("");
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  // الملف 18: توليدة جيبيتي الخام في وضع الدمج — تُعرض ليحكم المستخدم بعينه
  const [altDraft, setAltDraft] = useState<string | null>(null);
  // الملف 21: مهمة الإنفوغرافيك الجارية ونتيجتها
  const [visualJobId, setVisualJobId] = useState<string | null>(null);
  const [visualNote, setVisualNote] = useState("");
  const [visualUrl, setVisualUrl] = useState<string | null>(null);
  const [visualScore, setVisualScore] = useState<number | null>(null);
  // درس زوج الذوق (اختياري) — يُحقن مع الزوج فيعمّم الفرق بدل تركه للاستنتاج
  const [tasteLesson, setTasteLesson] = useState("");
  // جولة المراجعة (الملف 24): معرّف الجولة الحالية + الملاحظة + المسودة السابقة.
  // المسودة السابقة تبقى محفوظة لأنها الطرف «المرفوض» في زوج الذوق التلقائي.
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [revNote, setRevNote] = useState("");
  const [revBase, setRevBase] = useState<string | null>(null);
  // الملف 22: مسودة Typefully
  const [tfJobId, setTfJobId] = useState<string | null>(null);
  const [tfNote, setTfNote] = useState("");
  const [tfUrl, setTfUrl] = useState<string | null>(null);
  const jobStartRef = useRef<number>(0);

  // ── استئناف الطلب الجاري بعد مغادرة الشاشة (عطل إنتاج 2026-08-12) ──
  // jobId كان يعيش في حالة React وحدها، فمغادرةُ الشاشة تُفكّك المكوّن ويضيع
  // المعرّف وتتوقف حلقة الاستطلاع — بينما المهمة تكمل على العامل بلا أحد
  // يسألها. حادثة مثبتة: جولة مراجعة اكتملت في ١٤٧ث ونتيجتها سليمة في القاعدة،
  // ولم تصل الشاشة لأن المالك غادر ليحذف الفكرة من الالتقاط.
  const JOB_KEY = "second-brain:content-job";
  useEffect(() => {
    const saved = localStorage.getItem(JOB_KEY);
    if (!saved) return;
    try {
      const { id, at } = JSON.parse(saved) as { id: string; at: number };
      // نتجاهل ما مضى عليه أكثر من ساعة — طلب بائت لا يُستأنف
      if (!id || Date.now() - at > 3_600_000) {
        localStorage.removeItem(JOB_KEY);
        return;
      }
      jobStartRef.current = at;
      setJobNote("يستأنف طلباً كان جارياً…");
      setJobId(id);
    } catch {
      localStorage.removeItem(JOB_KEY);
    }
  }, []);

  // كل تغيّر لـjobId يُحفظ فوراً — فالمعرّف ينجو من إغلاق الصفحة والتنقّل
  useEffect(() => {
    if (jobId) {
      localStorage.setItem(JOB_KEY, JSON.stringify({ id: jobId, at: jobStartRef.current || Date.now() }));
    } else {
      localStorage.removeItem(JOB_KEY);
    }
  }, [jobId]);

  // استطلاع طلب الجلسة كل ٥ ثوانٍ حتى الاكتمال/الفشل — مع تنظيف عند الخروج.
  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      try {
        const r = await pollGenerationJob(jobId);
        if (!r.ok) {
          setError(r.error);
          setJobId(null);
          return;
        }
        const elapsed = Math.round((Date.now() - jobStartRef.current) / 1000);
        if (r.job.status === "queued") {
          setJobNote(
            `في الطابور منذ ${elapsed} ثانية…` +
              (r.job.workerNote ? ` (${r.job.workerNote})` : ""),
          );
        } else if (r.job.status === "running") {
          setJobNote(`يولّد على المحرّك منذ ${elapsed} ثانية…`);
        } else if (r.job.status === "done" && r.job.draft) {
          setResult({ analysis: r.job.analysis, draft: r.job.draft });
          setEditedDraft(r.job.draft.draft);
          setSessionModel(r.job.modelUsed);
          setAltDraft(r.job.altDraft?.draft ?? null);
          setCurrentJobId(jobId);
          setJobNote("");
          setJobId(null);
        } else if (r.job.status === "failed") {
          setError(r.job.error || "فشل التوليد على المحرّك.");
          setJobNote("");
          setJobId(null);
        }
      } catch {
        // فشل استطلاع عابر — الدورة التالية تعوّضه.
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [jobId]);

  // استطلاع مهمة الإنفوغرافيك (الملف 21) — دورة الجلسة الوكيلية دقائق
  useEffect(() => {
    if (!visualJobId) return;
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const r = await pollGenerationJob(visualJobId);
        if (!r.ok) {
          setError(r.error);
          setVisualJobId(null);
          return;
        }
        const s = Math.round((Date.now() - start) / 1000);
        if (r.job.status === "queued") setVisualNote(`في الطابور منذ ${s} ثانية…`);
        else if (r.job.status === "running")
          setVisualNote(`يصمم ويفحص على المحرّك منذ ${s} ثانية… (الدورة دقائق)`);
        else if (r.job.status === "done" && r.job.imageUrl) {
          setVisualUrl(r.job.imageUrl);
          setVisualScore(r.job.visualScore);
          setVisualNote("");
          setVisualJobId(null);
        } else if (r.job.status === "failed") {
          setError(r.job.error || "فشل توليد الإنفوغرافيك.");
          setVisualNote("");
          setVisualJobId(null);
        }
      } catch {
        // استطلاع عابر — الدورة التالية تعوّض
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [visualJobId]);

  // استطلاع مسودة Typefully (الملف 22) — نداء سريع عبر العامل
  useEffect(() => {
    if (!tfJobId) return;
    const timer = setInterval(async () => {
      try {
        const r = await pollGenerationJob(tfJobId);
        if (!r.ok) {
          setError(r.error);
          setTfJobId(null);
          return;
        }
        if (r.job.status === "done" && r.job.typefullyUrl) {
          setTfUrl(r.job.typefullyUrl);
          setTfNote("");
          setTfJobId(null);
        } else if (r.job.status === "failed") {
          setError(r.job.error || "فشل إنشاء مسودة Typefully.");
          setTfNote("");
          setTfJobId(null);
        } else {
          setTfNote("ينشئ المسودة في Typefully…");
        }
      } catch {
        // استطلاع عابر
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [tfJobId]);

  function sendToTypefully() {
    if (!editedDraft.trim()) return;
    setError("");
    setMsg("");
    setTfUrl(null);
    startTransition(async () => {
      const r = await queueTypefully(editedDraft);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTfJobId(r.jobId);
      setTfNote("أُرسلت للعامل…");
    });
  }

  function generateVisual() {
    if (!editedDraft.trim()) return;
    setError("");
    setMsg("");
    setVisualUrl(null);
    setVisualScore(null);
    startTransition(async () => {
      const r = await queueVisual(editedDraft, null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setVisualJobId(r.jobId);
      setVisualNote("أُرسلت للمحرّك…");
    });
  }

  function generate() {
    const useNew = mode === "new";
    const text = freeText.trim();
    if (useNew ? !text : !selectedId) return;
    setError("");
    setMsg("");
    setResult(null);
    setSessionModel(null);
    setAltDraft(null);
    setCurrentJobId(null);
    setRevBase(null);
    setRevNote("");
    setTasteLesson("");

    if (engine === "session") {
      startTransition(async () => {
        try {
          const r = await queueGeneration(
            useNew ? null : selectedId,
            useNew ? text : null,
            ov,
            {
              model: jobModel || null,
              effort: jobEffort || null,
              critic: jobCritic || null,
            },
          );
          if (!r.ok) {
            setError(r.error);
            return;
          }
          jobStartRef.current = Date.now();
          setJobNote("أُرسل الطلب للمحرّك — التحليل جاهز والتوليد في الطابور…");
          setGenItemId(useNew ? null : selectedId);
          setJobId(r.jobId);
        } catch {
          setError("تعذّر إرسال الطلب — تحقّق من الاتصال وحاول مجدداً.");
        }
      });
      return;
    }

    startTransition(async () => {
      try {
        const r = useNew
          ? await generateForText(text, ov)
          : await generateForItem(selectedId, ov);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setResult(r.result);
        setEditedDraft(r.result.draft.draft);
        setGenItemId(useNew ? null : selectedId);
      } catch {
        // وصول هنا = فشل شبكيّ أو قتل الدالّة عند تجاوز مهلة الخادم (٣٠٠ ثانية) — لا قيمة تُعاد.
        setError(
          "تعذّر إكمال التوليد — قد تكون المعالجة تجاوزت الوقت المسموح (٣٠٠ ثانية) أو انقطع الاتصال. حاول مرة أخرى.",
        );
      }
    });
  }

  function cancelJob() {
    if (!jobId) return;
    const id = jobId;
    startTransition(async () => {
      const r = await cancelGeneration(id);
      if (r.ok) {
        setJobId(null);
        setJobNote("");
        setMsg("أُلغي الطلب.");
      } else {
        setError(r.error);
      }
    });
  }

  // زوج ذوق (الملف 19): توليدة النظام كما خرجت ↔ نسختك بعد التعديل اليدوي —
  // يُحقن في كل توليدة قادمة درساً أسلوبياً. الدرس (اختياري) أثمن ما فيه.
  // جولة أخرى بملاحظتك: تُصلح ما ذكرتَه وتحفظ الباقي — والمسودة السابقة تُحفظ
  // لتصير الطرف المرفوض في زوج ذوق تلقائي، وملاحظتك درسه.
  function reviseWithNote() {
    if (!result || !currentJobId || !revNote.trim()) return;
    setError("");
    setMsg("");
    startTransition(async () => {
      const r = await queueRevision(currentJobId, revNote);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRevBase(result.draft.draft); // الطرف المرفوض
      setTasteLesson(revNote); // الملاحظة = درس الزوج
      jobStartRef.current = Date.now();
      setJobNote("جولة مراجعة — يصلح ما ذكرتَه ويحفظ الباقي…");
      setJobId(r.jobId);
      setRevNote("");
    });
  }

  function saveTaste() {
    if (!result) return;
    setError("");
    setMsg("");
    startTransition(async () => {
      const r = await saveTastePair(
        genItemId,
        genItemId ? null : freeText,
        // بعد جولة مراجعة: الطرف المرفوض هو مسودة الجولة السابقة لا الحالية
        revBase ?? result.draft.draft,
        editedDraft,
        tasteLesson,
      );
      if (r.ok) {
        setMsg("سُجّل زوج الذوق ✅ — سيوجّه التوليدات القادمة");
        setTasteLesson("");
        setRevBase(null);
      } else setError(r.error);
    });
  }

  function save() {
    if (!result) return;
    setError("");
    setMsg("");
    setSaving(true);
    startTransition(async () => {
      try {
        const r = await saveDraft(genItemId, {
          text: editedDraft,
          content_type: result.draft.content_type,
          hook_text: result.draft.hook_text,
          quality_score: result.draft.quality_score?.overall ?? null,
          content_pillar: result.analysis.content_pillar ?? null,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setMsg("حُفظت المسودة ✅");
      } catch {
        setError("تعذّر حفظ المسودة — تحقّق من الاتصال وحاول مجدداً.");
      } finally {
        setSaving(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* مصدر الفكرة: محفوظة من ذاكرتك أو فكرة جديدة حرّة (دون التزام بفكرة مسجّلة) */}
      <div className="space-y-2">
        <div className="inline-flex gap-1 rounded-lg border border-foreground/10 p-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("saved")}
            className={`rounded-md px-3 py-1.5 font-medium transition ${mode === "saved" ? "bg-foreground text-background" : "hover:bg-foreground/5"}`}
          >
            فكرة محفوظة
          </button>
          <button
            type="button"
            onClick={() => setMode("new")}
            className={`rounded-md px-3 py-1.5 font-medium transition ${mode === "new" ? "bg-foreground text-background" : "hover:bg-foreground/5"}`}
          >
            فكرة جديدة
          </button>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          {mode === "saved" ? (
            ideas.length > 0 ? (
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                aria-label="اختر الفكرة"
                className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
              >
                {ideas.map((it) => (
                  <option key={it.id} value={it.id}>
                    {(it.summary || it.raw_text).slice(0, 70)}
                    {STATUS_MARK[it.status] ?? ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="flex-1 py-2 text-sm text-foreground/50">
                لا أفكار محفوظة بعد — استخدم «فكرة جديدة» أو التقط فكرة من صفحة الالتقاط.
              </p>
            )
          ) : (
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={3}
              placeholder="اكتب فكرتك مباشرة — موضوع، زاوية، أو ملاحظة خام تريد تحويلها لمنشور"
              aria-label="فكرة جديدة"
              className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
            />
          )}
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as "session" | "direct")}
            aria-label="محرّك التوليد"
            className="h-fit shrink-0 rounded-lg border border-foreground/15 bg-transparent px-2 py-2 text-sm outline-none focus:border-foreground/40"
          >
            <option value="session">عبر الجلسة (فابل)</option>
            <option value="direct">مباشر (محدود ٣٠٠ث)</option>
          </select>
          <button
            onClick={generate}
            disabled={
              pending || jobId !== null || (mode === "new" ? !freeText.trim() : !selectedId)
            }
            className="h-fit shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {jobId
              ? "يولّد عبر الجلسة…"
              : pending && !saving
                ? engine === "session"
                  ? "يجهّز ويرسل…"
                  : "يحلّل ويولّد…"
                : "ولّد مسودة"}
          </button>
        </div>

        {/* تحكّم محرّك الجلسة لكل طلب: نموذج وعمق تفكير (فراغهما = افتراضيا العامل) */}
        {engine === "session" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="job-model" className="text-foreground/60">
              النموذج
            </label>
            <select
              id="job-model"
              value={jobModel}
              onChange={(e) => setJobModel(e.target.value)}
              aria-label="نموذج التوليد على الجلسة"
              className="rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 outline-none focus:border-foreground/40"
            >
              <option value="">افتراضي العامل (فابل 5)</option>
              <option value="claude-fable-5">فابل 5</option>
              <option value="claude-opus-5">أوبس 5</option>
              <option value="claude-sonnet-5">سونيت 5</option>
            </select>
            <label htmlFor="job-effort" className="text-foreground/60">
              عمق التفكير
            </label>
            <select
              id="job-effort"
              value={jobEffort}
              onChange={(e) => setJobEffort(e.target.value)}
              aria-label="عمق التفكير على الجلسة"
              className="rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 outline-none focus:border-foreground/40"
            >
              <option value="">افتراضي النموذج</option>
              <option value="low">منخفض</option>
              <option value="medium">متوسط</option>
              <option value="high">عالٍ</option>
              <option value="xhigh">أقصى</option>
            </select>
            <label htmlFor="job-critic" className="text-foreground/60">
              نهج التحسين
            </label>
            <select
              id="job-critic"
              value={jobCritic}
              onChange={(e) => setJobCritic(e.target.value)}
              aria-label="نهج تحسين المسودة"
              title="ناقد داخلي أو خارجي (حين حلقة النقد مفعّلة) — أو توليد متوازٍ على كلود وجيبيتي معاً ثم دمج الأفضل"
              className="rounded-lg border border-foreground/15 bg-transparent px-2 py-1.5 outline-none focus:border-foreground/40"
            >
              <option value="">ناقد داخلي (كلود)</option>
              <option value="codex">ناقد خارجي (جيبيتي)</option>
              <option value="merge">دمج توليدتين (كلود × جيبيتي)</option>
            </select>
          </div>
        )}

        {/* حالة طلب الجلسة الحيّة + الإلغاء (متاح ما دام في الطابور) */}
        {jobId && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-foreground/60" />
            <span className="text-foreground/70">{jobNote || "ينتظر المحرّك…"}</span>
            <button
              type="button"
              onClick={cancelJob}
              className="rounded-md border border-foreground/20 px-2 py-1 text-xs transition hover:bg-foreground/10"
            >
              إلغاء
            </button>
          </div>
        )}
      </div>

      {/* تحكّم بالمخرجات (الإضافة ١) — اختياري، يتجاوز استنتاج التحليل */}
      <details className="rounded-lg border border-foreground/10 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          تحكّم بالمخرجات (اختياري)
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-foreground/60">النوع</label>
            <select
              value={ov.format}
              onChange={(e) =>
                setOv({ ...ov, format: e.target.value as GenOverrides["format"] })
              }
              aria-label="نوع المنشور"
              className={inputCls}
            >
              <option value="auto">تلقائي</option>
              <option value="thread">ثريد</option>
              <option value="long">تغريدة طويلة</option>
              <option value="medium">تغريدة متوسطة</option>
            </select>
          </div>
          {ov.format === "thread" && (
            <div>
              <label className="mb-1 block text-xs text-foreground/60">
                عدد التغريدات
              </label>
              <input
                type="number"
                min={3}
                max={20}
                value={ov.threadCount ?? ""}
                onChange={(e) =>
                  setOv({
                    ...ov,
                    threadCount: e.target.value
                      ? parseInt(e.target.value, 10)
                      : null,
                  })
                }
                placeholder="تلقائي"
                aria-label="عدد التغريدات"
                className={inputCls}
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs text-foreground/60">
              الدعوة (CTA)
            </label>
            <select
              value={ov.cta}
              onChange={(e) =>
                setOv({ ...ov, cta: e.target.value as GenOverrides["cta"] })
              }
              aria-label="نوع الدعوة"
              className={inputCls}
            >
              <option value="auto">تلقائي</option>
              <option value="premium">مميّزة</option>
              <option value="short">قصيرة</option>
              <option value="none">بدون</option>
            </select>
          </div>
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-xs text-foreground/60">الصيغة</label>
          <select
            value={ov.form}
            onChange={(e) => setOv({ ...ov, form: e.target.value as GenOverrides["form"] })}
            aria-label="صيغة المحتوى"
            className={inputCls}
          >
            <option value="auto">تلقائي</option>
            <option value="news">خبر</option>
            <option value="opinion">رأي صريح</option>
            <option value="contrarian">زاوية مخالفة</option>
            <option value="comparison">مقارنة</option>
            <option value="story">قصة أو تجربة</option>
            <option value="howto">دليل عملي</option>
            <option value="myth">تفكيك خطأ شائع</option>
            <option value="framework">إطار ذهني</option>
            <option value="casestudy">دراسة حالة بأرقامك</option>
            <option value="confession">اعتراف أو درس من فشل</option>
            <option value="teardown">تشريح مثال حقيقي</option>
            <option value="behindscenes">خلف الكواليس</option>
            <option value="diagnostic">سؤال تشخيصي</option>
            <option value="forecast">استشراف مسنود</option>
          </select>
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-xs text-foreground/60">
            ملاحظات وتعليمات (اختياري)
          </label>
          <textarea
            value={ov.notes}
            onChange={(e) => setOv({ ...ov, notes: e.target.value })}
            rows={2}
            placeholder="مثلاً: اجعلها ساخرة · ابدأ بسؤال صادم · ركّز على زاوية المستثمر · اربطها بحدث اليوم"
            aria-label="ملاحظات وتعليمات إضافية"
            className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
        </div>
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ov.search}
              onChange={(e) => setOv({ ...ov, search: e.target.checked })}
              className="h-4 w-4 accent-foreground"
            />
            بحث حيّ على الويب (للأفكار عن أدوات/أحداث جديدة)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ov.critique}
              onChange={(e) => setOv({ ...ov, critique: e.target.checked })}
              className="h-4 w-4 accent-foreground"
            />
            حلقة النقد والتحسين (أبطأ، جودة أعلى)
          </label>
        </div>
      </details>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {msg && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>
      )}

      {result && (
        <div className="space-y-4">
          {/* المدخل الغني (مرحلة التحليل) */}
          <details className="rounded-lg border border-foreground/10 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              المدخل الغني (تحليل النشر)
            </summary>
            <div className="mt-2 space-y-1 text-xs text-foreground/70">
              <p>
                <span className="font-medium">الزاوية:</span>{" "}
                {result.analysis.unique_angle}
              </p>
              <p>
                <span className="font-medium">الهوك المقترح:</span>{" "}
                {result.analysis.suggested_hook}
              </p>
              <p>
                <span className="font-medium">العناصر:</span>{" "}
                {result.analysis.key_elements.join(" · ")}
              </p>
              <p>
                {ar(TYPE_AR, result.analysis.content_type)} ·{" "}
                {ar(PERSONA_AR, result.analysis.target_persona)} ·{" "}
                {ar(PILLAR_AR, result.analysis.content_pillar)} · محرّك التفاعل:{" "}
                {ar(DRIVER_AR, result.analysis.engagement_driver)} · هوك{" "}
                {ar(HOOK_AR, result.analysis.hook_strength)}
              </p>
            </div>
          </details>

          {/* بطاقة الجودة والهوك */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {result.draft.quality_score && (
              <span className="rounded-md bg-foreground/10 px-2 py-1 font-medium">
                الجودة: {result.draft.quality_score.overall}/10
              </span>
            )}
            {result.draft.critique && (
              <span className="rounded-md bg-emerald-500/15 px-2 py-1 text-emerald-700 dark:text-emerald-400">
                {result.draft.critique.critic === "merge"
                  ? "دُمجت من توليدتين ✓"
                  : result.draft.critique.critic === "codex"
                    ? "نُقّحت بناقد خارجي ✓"
                    : "نُقّحت ✓"}
              </span>
            )}
            <span className="rounded-md bg-foreground/10 px-2 py-1">
              {ar(TYPE_AR, result.draft.content_type)}
            </span>
            {sessionModel && (
              <span className="rounded-md bg-sky-500/15 px-2 py-1 text-sky-700 dark:text-sky-400">
                عبر الجلسة · {sessionModel}
              </span>
            )}
            {result.draft.cta_type && result.draft.cta_type !== "none" && (
              <span className="rounded-md bg-foreground/10 px-2 py-1">
                دعوة لإجراء: {ar(CTA_AR, result.draft.cta_type)}
              </span>
            )}
          </div>
          {result.draft.hook_text && (
            <p className="text-sm">
              <span className="font-medium">الهوك:</span>{" "}
              {result.draft.hook_text}
            </p>
          )}

          {/* جولة أخرى بملاحظتك (الملف 24) — نمط الرفض المتتالي مواطن أول لا استثناء */}
          {currentJobId && (
            <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3">
              <label htmlFor="rev-note" className="mb-1 block text-sm font-medium">
                ما الذي لم يعجبك؟
              </label>
              <div className="flex flex-wrap items-start gap-2">
                <input
                  id="rev-note"
                  value={revNote}
                  onChange={(e) => setRevNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") reviseWithNote();
                  }}
                  placeholder="مثلاً: البداية ثقيلة · الهوك مو مغناطيسي · مصقولة زيادة · شيل التشبيه"
                  aria-label="ملاحظتك على المسودة"
                  className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
                <button
                  onClick={reviseWithNote}
                  disabled={pending || jobId !== null || !revNote.trim()}
                  title="يصلح ما ذكرتَه ويحفظ ما لم تذكره — لا يعيد الكتابة من الصفر"
                  className="h-fit shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                >
                  جولة أخرى
                </button>
              </div>
              {revBase && (
                <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
                  هذه نسخة مُراجَعة — «سجّل ذوقاً» سيحفظ (السابقة ← هذه) وملاحظتك درساً.
                </p>
              )}
            </div>
          )}

          {/* المسودة القابلة للتحرير */}
          <div>
            <label htmlFor="draft-area" className="mb-1 block text-sm font-medium">
              المسودة
            </label>
            <textarea
              id="draft-area"
              value={editedDraft}
              onChange={(e) => setEditedDraft(e.target.value)}
              rows={14}
              className="w-full rounded-lg border border-foreground/15 bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
            />
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                onClick={save}
                disabled={pending}
                className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
              >
                {saving ? "يحفظ…" : "احفظ المسودة"}
              </button>
              <button
                onClick={saveTaste}
                disabled={
                  pending ||
                  editedDraft.trim() === (revBase ?? result.draft.draft).trim()
                }
                title="يحفظ (توليدة النظام ↔ نسختك المعدّلة) درساً دائماً يوجّه التوليدات القادمة — عدّل المسودة أولاً"
                className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
              >
                سجّل ذوقاً من تعديلي
              </button>
              {editedDraft.trim() !== result.draft.draft.trim() && (
                <input
                  value={tasteLesson}
                  onChange={(e) => setTasteLesson(e.target.value)}
                  placeholder="درس هذا التعديل (اختياري): ما الفرق الجوهري؟"
                  aria-label="درس زوج الذوق"
                  className="min-w-0 flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-foreground/40"
                />
              )}
              <button
                onClick={generateVisual}
                disabled={pending || visualJobId !== null || !editedDraft.trim()}
                title="جلسة وكيلية على الخادم تحوّل النص لإنفوغرافيك RTL مفحوص بعتبة 90/100"
                className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
              >
                {visualJobId ? "يصمم…" : "ولّد إنفوغرافيك"}
              </button>
              <button
                onClick={sendToTypefully}
                disabled={pending || tfJobId !== null || !editedDraft.trim()}
                title="ينشئ مسودة جاهزة للمراجعة في Typefully (الثريد يُقسَّم تلقائياً) — الصورة تُرفق هناك يدوياً"
                className="rounded-lg border border-foreground/20 px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
              >
                {tfJobId ? "يرسل…" : "أرسل إلى Typefully"}
              </button>
            </div>

            {/* حالة Typefully ورابطها (الملف 22) */}
            {tfJobId && tfNote && (
              <p className="mt-2 flex items-center gap-2 text-xs text-foreground/60">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-foreground/60" />
                {tfNote}
              </p>
            )}
            {tfUrl && (
              <p className="mt-2 text-sm">
                📮{" "}
                <a
                  href={tfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-emerald-700 underline dark:text-emerald-400"
                >
                  مسودة Typefully جاهزة للمراجعة — افتحها
                </a>
                {visualUrl && (
                  <span className="text-xs text-foreground/50"> · اسحب الإنفوغرافيك إليها من الأعلى</span>
                )}
              </p>
            )}

            {/* حالة الإنفوغرافيك ونتيجته (الملف 21) */}
            {visualJobId && visualNote && (
              <p className="mt-2 flex items-center gap-2 text-xs text-foreground/60">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-foreground/60" />
                {visualNote}
              </p>
            )}
            {visualUrl && (
              <div className="mt-3 rounded-lg border border-foreground/10 p-2">
                <p className="mb-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  الإنفوغرافيك جاهز{visualScore ? ` — ${visualScore}/100` : ""} · وصلك أيضاً على تيليجرام
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={visualUrl} alt="إنفوغرافيك المسودة" className="w-full rounded-md" />
                <a
                  href={visualUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block rounded-md border border-foreground/20 px-3 py-1 text-xs transition hover:bg-foreground/5"
                >
                  افتح بالحجم الكامل
                </a>
              </div>
            )}
          </div>

          {result.draft.improvement_notes && (
            <p className="text-xs text-foreground/50">
              ملاحظة المحرّك: {result.draft.improvement_notes}
            </p>
          )}
          {result.draft.critique && result.draft.critique.changes && (
            <p className="text-xs text-foreground/50">
              {result.draft.critique.critic === "merge" ? (
                <>تقرير الدمج: {result.draft.critique.changes}</>
              ) : (
                <>
                  حلقة النقد — حُسّن:{" "}
                  {result.draft.critique.weakest.join("، ") || "—"} ·{" "}
                  {result.draft.critique.changes}
                </>
              )}
            </p>
          )}

          {/* توليدة جيبيتي الخام (وضع الدمج) — ليحكم المستخدم بعينه على الفرق */}
          {altDraft && (
            <details className="rounded-lg border border-foreground/10 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                توليدة جيبيتي الخام (قبل الدمج)
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/80">{altDraft}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

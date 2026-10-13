"use client";

import { useEffect, useState, useTransition } from "react";
import {
  generateNewsletterIdeas,
  generateNewsletterOutlineAction,
  generateNewsletterDraftAction,
  saveNewsletterIdea,
  saveNewsletterDraft,
  queueNewsletterStage,
  pollNewsletterJob,
  cancelNewsletterGeneration,
  saveNewsletterTastePair,
  queueNewsletterRevisionAction,
  listIdeaSources,
  queueLoopsPublishAction,
  pollLoopsPublishAction,
  listLoopsAudiences,
} from "./actions";
import type { CapturedIdea, PostSeed } from "@/lib/newsletter/list";
import {
  ANGLE_OPTIONS,
  DEFAULT_CRITERIA,
  DEFAULT_DRAFT_OPTIONS,
  LENGTH_OPTIONS,
  PERSONA_OPTIONS,
  PURPOSE_OPTIONS,
  SOURCE_OPTIONS,
  STYLE_OPTIONS,
  TONE_FIELDS,
  type CritiqueInfo,
  type DraftOptions,
  type IdeaCriteria,
  type NewsletterRow,
} from "@/lib/newsletter/criteria";

const inputCls =
  "w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40";

// ── مسار التنفيذ (الملف 26) — نفس منتقي محرّك إكس ──
const ENGINE_OPTIONS = [
  { value: "session", label: "جلسة الاشتراك (بلا سقف)" },
  { value: "direct", label: "مباشر (محدود ٣٠٠ث)" },
];
const MODEL_OPTIONS = [
  { value: "", label: "افتراضي العامل" },
  { value: "claude-opus-5", label: "أوبس ٥" },
  { value: "claude-fable-5", label: "فابل ٥" },
  { value: "claude-sonnet-5", label: "سونيت ٥" },
];
const EFFORT_OPTIONS = [
  { value: "", label: "افتراضي" },
  { value: "low", label: "منخفض" },
  { value: "medium", label: "متوسط" },
  { value: "high", label: "عالٍ" },
  { value: "xhigh", label: "أقصى" },
];
// نهج التحسين (الملف 29) — الدمج للمسودة وحدها، لا للأفكار ولا للهيكل
const CRITIC_OPTIONS = [
  { value: "", label: "نقد داخلي (كلود)" },
  { value: "merge", label: "دمج متوازٍ (كلود × جيبيتي)" },
];

// نتيجة نشر لوبس المكتملة — تُشتقّ من توقيع الإجراء نفسه (lib/loops/publish خادميّ
// بحت، فلا يُستورد نوعه هنا مباشرةً) — نفس نمط اشتقاق نتيجة pollNewsletterJob.
type LoopsPublishDone = Extract<
  NonNullable<Awaited<ReturnType<typeof pollLoopsPublishAction>>>,
  { status: "done" }
>;

// resume: صفّ نشرة لاستئنافه (يُهيّئ الحالة منه). يُمرَّر معه key مختلف فيُعاد التركيب نظيفاً.
// onSaved: إخطار المُنسّق بمعرّف الصفّ المحفوظ (لتحديث القائمة وإبرازه) — دون إعادة تركيب.
export function NewsletterWizard({
  resume = null,
  onSaved,
}: {
  resume?: NewsletterRow | null;
  onSaved?: (id: string) => void;
}) {
  const [c, setC] = useState<IdeaCriteria>(resume?.criteria ?? DEFAULT_CRITERIA);
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [selected, setSelected] = useState("");
  const [manual, setManual] = useState(resume?.idea ?? "");

  const [opts, setOpts] = useState<DraftOptions>(DEFAULT_DRAFT_OPTIONS);
  const [outline, setOutline] = useState<string | null>(resume?.outline ?? null); // المسار المُتحكَّم (اختياري)
  const [draft, setDraft] = useState<{ subject: string; draft: string } | null>(
    resume?.draft?.trim() ? { subject: resume.subject ?? "", draft: resume.draft } : null,
  );
  const [critique, setCritique] = useState<CritiqueInfo | null>(null); // قبل/بعد حلقة النقد
  const [subject, setSubject] = useState(resume?.subject ?? "");
  const [body, setBody] = useState(resume?.draft ?? "");
  const [newsletterId, setNewsletterId] = useState<string | null>(resume?.id ?? null);
  const [saved, setSaved] = useState("");

  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  // مسار الجلسة (الملف 26): المحرّك والنموذج وعمق التفكير + حالة الانتظار الحيّة
  const [engine, setEngine] = useState("session");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [critic, setCritic] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [waitNote, setWaitNote] = useState("");
  // نشرة جيبيتي الخام + تقرير الدمج (وضع الدمج المتوازي)
  const [altDraft, setAltDraft] = useState<{ subject: string; draft: string } | null>(null);
  const [mergeReport, setMergeReport] = useState("");

  // المرحلة (ب): النصّ الخام مادّةَ الوقائع + تسجيل زوج ذوق بريديّ من تحريره
  const [rawText, setRawText] = useState(resume?.raw_text ?? "");
  const [tasteLesson, setTasteLesson] = useState("");
  const [tasteSaved, setTasteSaved] = useState("");
  // جولة المراجعة (الملف 33): معرّف الجولة الحالية + الملاحظة + المسودة السابقة.
  // المسودة السابقة تُحفظ لأنها الطرف «المرفوض» في زوج الذوق بعد الجولة.
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [revNote, setRevNote] = useState("");
  const [revBase, setRevBase] = useState<string | null>(null);

  // مصادر الأفكار (الملف 30): الالتقاط + منشورات ومسودات إكس — كلّها بترتيب زمنيّ
  const [sources, setSources] = useState<{ captured: CapturedIdea[]; posts: PostSeed[] } | null>(null);
  const [sourceTab, setSourceTab] = useState<"captured" | "posts">("captured");
  const [sourceQuery, setSourceQuery] = useState("");

  // ── النشر في لوبس (الملف 35): حالة القسم وحدها، معزولة عن حالة التوليد ──
  const [audiences, setAudiences] = useState<{ key: string; label: string; type: string }[] | null>(
    null,
  );
  const [audienceKey, setAudienceKey] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewTo, setPreviewTo] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState("");
  const [publishError, setPublishError] = useState("");
  const [publishDone, setPublishDone] = useState<LoopsPublishDone | null>(null);

  const chosen = (manual.trim() || selected).trim();
  const busy = pending || jobId !== null;
  const canPublish = body.trim().length > 0; // نفس شرط ظهور جولة المراجعة

  // الجماهير تُجلب مرّة واحدة عند أول ظهور للقسم — قائمة ثابتة في الخادم، لا نداء
  // خارجيّاً، فلا داعي لإعادة الجلب مع كل تحرير للمسودة.
  useEffect(() => {
    if (!canPublish || audiences) return;
    void (async () => {
      const list = await listLoopsAudiences();
      setAudiences(list);
      if (list.length > 0) setAudienceKey((k) => k || list[0].key);
    })();
  }, [canPublish, audiences]);

  /** يصفّ حملة لوبس من حالة الشاشة الحالية ويستطلعها كل ٤ث حتى تكتمل (سقف ٣ دقائق). */
  async function publishToLoops() {
    if (!subject.trim() || publishing) return;
    setPublishError("");
    setPublishDone(null);
    setPublishing(true);
    setPublishNote("ينشئ الحملة في لوبس…");
    try {
      // حقل التوقيت المحلّي بلا منطقة زمنية؛ التحويل إلى ISO يثبّت اللحظة التي قصدها
      // المالك فعلاً قبل أن تصل العامل. فارغاً = مسودة في لوبس بلا جدولة.
      const iso = scheduleAt ? new Date(scheduleAt).toISOString() : null;
      const q = await queueLoopsPublishAction({
        subject: subject.trim(),
        previewText: previewText.trim() || null,
        body,
        audienceKey: audienceKey || (audiences?.[0]?.key ?? ""),
        scheduleAt: iso,
        previewTo: previewTo.trim() || null,
        purpose: opts.purpose || null,
        newsletterId,
      });
      if (!q.ok) {
        setPublishError(q.error);
        return;
      }
      const started = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 4000));
        const v = await pollLoopsPublishAction(q.jobId);
        if (v?.status === "failed") {
          setPublishError(v.error);
          return;
        }
        if (v?.status === "done") {
          setPublishDone(v);
          return;
        }
        const secs = Math.round((Date.now() - started) / 1000);
        setPublishNote(
          `ينشئ الحملة في لوبس… ${v?.status === "running" ? "يعمل على الخادم" : "في الطابور"} — ${secs}ث`,
        );
        // سقف ٣ دقائق: بعده لا نُبقي الشاشة معلّقة — الحملة قد تكون أُنشئت فعلاً في لوبس
        if (Date.now() - started > 180_000) {
          setPublishError(
            "تأخّر النشر أكثر من ثلاث دقائق — راجع لوحة لوبس قبل إعادة المحاولة كي لا تتكرّر الحملة.",
          );
          return;
        }
      }
    } catch (e) {
      setPublishError(
        e instanceof Error ? e.message : "تعذّر إنشاء الحملة في لوبس — تحقّق من الاتصال وحاول مجدداً.",
      );
    } finally {
      setPublishing(false);
      setPublishNote("");
    }
  }

  /** يفتح لوحة المصادر ويجلبها مرّة واحدة. */
  function toggleSources() {
    if (sources) {
      setSources(null);
      return;
    }
    startTransition(async () => {
      const r = await listIdeaSources();
      setSources(r);
    });
  }

  /** اختيار مصدر: فكرته تصير الفكرة، ونصّه الكامل يملأ «نصّك الخام». */
  function pickSource(idea: string, raw: string) {
    setManual(idea);
    setSelected("");
    setRawText(raw);
    setOutline(null);
    setDraft(null);
    setSaved("");
    setSources(null);
    setSourceQuery("");
  }

  // بحث نصّيّ في المصادر — العرض كامل، والبحث هو ما يجعل المئات قابلة للتصفّح
  const q = sourceQuery.trim();
  const shownCaptured = (sources?.captured ?? []).filter(
    (it) => !q || it.idea.includes(q) || it.rawText.includes(q),
  );
  const shownPosts = (sources?.posts ?? []).filter(
    (p) => !q || p.idea.includes(q) || p.rawText.includes(q),
  );

  const sourcesPanel = sources ? (
    <div className="mt-2 rounded-lg border border-foreground/10 p-3">
      <div className="mb-2 flex flex-wrap gap-2">
        {([
          ["captured", `الالتقاط (${shownCaptured.length}/${sources.captured.length})`],
          ["posts", `إكس (${shownPosts.length}/${sources.posts.length})`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSourceTab(k)}
            className={`rounded-lg px-3 py-1 text-xs transition ${
              sourceTab === k ? "bg-foreground text-background" : "border border-foreground/15 hover:bg-foreground/5"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        value={sourceQuery}
        onChange={(e) => setSourceQuery(e.target.value)}
        placeholder="ابحث في نصوصك…"
        aria-label="بحث في المصادر"
        className="mb-2 w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-xs outline-none focus:border-foreground/40"
      />

      <div className="max-h-96 space-y-2 overflow-y-auto">
        {sourceTab === "captured" &&
          (shownCaptured.length === 0 ? (
            <p className="text-xs text-foreground/50">
              {sources.captured.length === 0 ? "لا أفكار ملتقطة بعد." : "لا نتيجة لهذا البحث."}
            </p>
          ) : (
            shownCaptured.map((it) => (
              <button
                key={it.id}
                onClick={() => pickSource(it.idea, it.rawText)}
                className="block w-full rounded-lg border border-foreground/10 p-2 text-right text-xs transition hover:bg-foreground/5"
              >
                <span className="text-foreground/80">{it.idea}</span>
                <span className="mt-1 block text-foreground/40">
                  {it.kind} · {it.date} · {it.rawText.split(/\s+/).length} كلمة
                </span>
              </button>
            ))
          ))}

        {sourceTab === "posts" &&
          (shownPosts.length === 0 ? (
            <p className="text-xs text-foreground/50">
              {sources.posts.length === 0 ? "لا منشورات ولا مسودات بعد." : "لا نتيجة لهذا البحث."}
            </p>
          ) : (
            shownPosts.map((p) => (
              <button
                key={p.id}
                onClick={() => pickSource(p.idea, p.rawText)}
                className="block w-full rounded-lg border border-foreground/10 p-2 text-right text-xs transition hover:bg-foreground/5"
              >
                <span className="text-foreground/80">{p.idea}</span>
                <span className="mt-1 block text-foreground/40">
                  {p.status === "draft" ? "مسودة محفوظة" : "منشور"}
                  {p.date ? ` · ${p.date}` : ""}
                  {p.engagement > 0 ? ` · تفاعل ${p.engagement.toLocaleString("en-US")}` : ""}
                  {p.impressions > 0 ? ` · ${p.impressions.toLocaleString("en-US")} مشاهدة` : ""}
                </span>
              </button>
            ))
          ))}
      </div>
      <p className="mt-2 text-xs text-foreground/40">
        اختيارك يملأ الفكرة و«نصّك الخام» معاً — فتبني النشرة على وقائعك لا على تخمين.
      </p>
    </div>
  ) : null;

  /** يطبّق ناتج مرحلة مكتملة على الحالة — يشاركه المسار الحيّ والاستئناف. */
  function applyDone(
    stage: "ideas" | "outline" | "draft",
    v: Extract<Awaited<ReturnType<typeof pollNewsletterJob>>, { status: "done" }>,
  ) {
    if (stage === "ideas") setIdeas(v.ideas);
    else if (stage === "outline") setOutline(v.outline);
    else {
      setDraft({ subject: v.subject, draft: v.draft });
      setSubject(v.subject);
      setBody(v.draft);
      setCritique(v.critique);
      setAltDraft(v.alt);
      setMergeReport(v.critique?.mergeReport ?? "");
    }
  }

  /** يصفّ جولة مراجعة بملاحظة المالك — تعيد استعمال مدخل الجولة السابقة كاملاً. */
  function askRevision() {
    // الشرط وجود مسودة على الشاشة لا وجود جلسة — فتعمل بعد الحفظ وإعادة الفتح
    if (!body.trim() || !revNote.trim() || busy) return;
    setError("");
    setSaved("");
    startTransition(async () => {
      const r = await queueNewsletterRevisionAction(
        chosen,
        opts,
        { subject, draft: body },
        revNote,
        {
          model: model || undefined,
          effort: effort || undefined,
          rawText,
          outline: outline ?? undefined,
          newsletterId: newsletterId ?? undefined,
          previousJobId: currentJobId ?? undefined,
        },
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRevBase(body);            // الطرف المرفوض لزوج الذوق = ما كان على الشاشة
      setTasteLesson(revNote);     // الملاحظة = درس الزوج
      setRevNote("");
      void pollUntilDone(r.jobId, "draft", Date.now(), "جولة مراجعة — يصلح ما ذكرتَه ويحفظ الباقي…");
    });
  }

  // ── استئناف طلب جارٍ بعد مغادرة الشاشة (عطل إنتاج 2026-08-12) ──
  // نفس عيب محرّك إكس: المعرّف يعيش في حالة React وحدها، فمغادرة الشاشة تُفكّك
  // المكوّن وتوقف الاستطلاع — والمهمة تكمل على العامل بلا أحد يسألها.
  const NL_JOB_KEY = "second-brain:newsletter-job";
  useEffect(() => {
    const saved = localStorage.getItem(NL_JOB_KEY);
    if (!saved) return;
    let parsed: { id: string; at: number; stage: "ideas" | "outline" | "draft" } | null = null;
    try {
      parsed = JSON.parse(saved);
    } catch {
      localStorage.removeItem(NL_JOB_KEY);
      return;
    }
    if (!parsed?.id || Date.now() - parsed.at > 3_600_000) {
      localStorage.removeItem(NL_JOB_KEY);
      return;
    }
    void pollUntilDone(parsed.id, parsed.stage, parsed.at, "يستأنف طلباً كان جارياً…");
  }, []);

  /** حلقة الاستطلاع — مشتركة بين التشغيل الجديد والاستئناف. */
  async function pollUntilDone(
    id: string,
    stage: "ideas" | "outline" | "draft",
    started: number,
    firstNote: string,
  ) {
    setJobId(id);
    setWaitNote(firstNote);
    localStorage.setItem(NL_JOB_KEY, JSON.stringify({ id, at: started, stage }));
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const v = await pollNewsletterJob(id);
      if (!v) continue;
      if (v.status === "failed") {
        setJobId(null);
        setWaitNote("");
        setError(v.error);
        localStorage.removeItem(NL_JOB_KEY);
        return;
      }
      if (v.status === "done") {
        setJobId(null);
        setWaitNote("");
        localStorage.removeItem(NL_JOB_KEY);
        if (stage === "draft") setCurrentJobId(id);
        applyDone(stage, v);
        return;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      setWaitNote(
        (v.status === "running" ? "يعمل على الخادم" : "في الطابور") +
          ` — ${secs}ث${v.note ? " · " + v.note : ""}`,
      );
    }
  }

  /**
   * يصفّ مرحلة على الطابور ويستطلعها حتى تكتمل. الاستطلاع كل ٥ث بلا سقف زمني —
   * المهمة على الـVPS خارج قيود Vercel، وإغلاق الصفحة لا يُفقدها: المعرّف محفوظ
   * في localStorage ويُستأنف عند العودة.
   */
  async function runOnSession(
    stage: "ideas" | "outline" | "draft",
    payload: Parameters<typeof queueNewsletterStage>[1],
    onDone: (v: Extract<Awaited<ReturnType<typeof pollNewsletterJob>>, { status: "done" }>) => void,
  ) {
    setError("");
    setWaitNote("يُجهَّز الطلب…");
    const q = await queueNewsletterStage(stage, payload, {
      model: model || undefined,
      effort: effort || undefined,
      critic: critic || undefined,
    });
    if (!q.ok) {
      setWaitNote("");
      setError(q.error);
      return;
    }
    void onDone; // النتيجة تُطبَّق عبر applyDone الموحَّد (يشاركه الاستئناف)
    await pollUntilDone(q.jobId, stage, Date.now(), "في الطابور…");
    return;
  }

  /** يسجّل (المولَّد ← ما اعتمده المالك) زوجَ ذوق بريديّاً — الفرق نفسه هو الدرس. */
  function saveTaste() {
    if (!draft || busy) return;
    setError("");
    setTasteSaved("");
    startTransition(async () => {
      // بعد جولة مراجعة: الطرف المرفوض هو مسودة الجولة السابقة لا الحالية
      const r = await saveNewsletterTastePair(chosen, revBase ?? draft.draft, body, tasteLesson);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTasteLesson("");
      setRevBase(null);
      setTasteSaved("✅ سُجّل الزوج — سيُحقن في نشراتك القادمة");
    });
  }

  async function cancelWait() {
    if (!jobId) return;
    const r = await cancelNewsletterGeneration(jobId);
    if (r.ok) {
      setJobId(null);
      setWaitNote("");
      setError("أُلغي الطلب قبل أن يبدأ.");
    } else {
      setWaitNote((n) => n + " · بدأ التنفيذ فعلاً — لا يمكن الإلغاء");
    }
  }

  function genIdeas() {
    if (!c.topic.trim() || busy) return;
    setError("");
    setIdeas(null);
    setSelected("");
    setOutline(null);
    setDraft(null);
    setSaved("");
    if (engine === "session") {
      void runOnSession("ideas", { criteria: c }, (v) => setIdeas(v.ideas));
      return;
    }
    startTransition(async () => {
      try {
        const r = await generateNewsletterIdeas(c);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setIdeas(r.ideas);
      } catch {
        setError(
          "تعذّر إكمال توليد الأفكار — قد تكون المعالجة تجاوزت الوقت المسموح (٣٠٠ ثانية) أو انقطع الاتصال. حاول مجدداً.",
        );
      }
    });
  }

  function saveIdeaOnly() {
    if (!chosen || pending) return;
    setError("");
    startTransition(async () => {
      try {
        const r = await saveNewsletterIdea(chosen, c);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setNewsletterId(r.id);
        setSaved("✅ حُفظت الفكرة لوقت لاحق");
        onSaved?.(r.id);
      } catch {
        setError("تعذّر حفظ الفكرة — تحقّق من الاتصال وحاول مجدداً.");
      }
    });
  }

  // المسار المُتحكَّم: ولّد الهيكل أولاً (خطّة قابلة للتحرير قبل التوسيع).
  function genOutline() {
    if (!chosen || busy) return;
    setError("");
    setSaved("");
    setDraft(null);
    if (engine === "session") {
      void runOnSession("outline", { idea: chosen, options: opts, rawText }, (v) =>
        setOutline(v.outline),
      );
      return;
    }
    startTransition(async () => {
      try {
        const r = await generateNewsletterOutlineAction(chosen, opts, rawText);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setOutline(r.outline);
      } catch {
        setError(
          "تعذّر إكمال توليد الهيكل — قد تكون المعالجة تجاوزت الوقت المسموح (٣٠٠ ثانية) أو انقطع الاتصال. حاول مجدداً.",
        );
      }
    });
  }

  // توليد المسودة: من الهيكل المُحرَّر (useOutline) أو من الفكرة مباشرةً.
  function genDraft(useOutline: boolean) {
    if (!chosen || busy) return;
    const ol = useOutline && outline && outline.trim() ? outline : undefined;
    setError("");
    setSaved("");
    if (!useOutline) setOutline(null); // المسار السريع يتجاوز الهيكل
    if (engine === "session") {
      void runOnSession("draft", { idea: chosen, options: opts, outline: ol, critique: true, rawText }, (v) => {
        setDraft({ subject: v.subject, draft: v.draft });
        setSubject(v.subject);
        setBody(v.draft);
        setCritique(v.critique);
        setAltDraft(v.alt);
        setMergeReport(v.critique?.mergeReport ?? "");
      });
      return;
    }
    startTransition(async () => {
      try {
        const r = await generateNewsletterDraftAction(chosen, opts, ol, rawText);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const d = r.result;
        setDraft({ subject: d.subject, draft: d.draft });
        setSubject(d.subject);
        setBody(d.draft);
        setCritique(d.critique);
      } catch {
        setError(
          "تعذّر إكمال توليد المسودة — قد تكون المعالجة تجاوزت الوقت المسموح (٣٠٠ ثانية) أو انقطع الاتصال. حاول مجدداً.",
        );
      }
    });
  }

  function saveDraft() {
    if (!body.trim() || pending) return;
    setError("");
    startTransition(async () => {
      try {
        const r = await saveNewsletterDraft(
          newsletterId,
          chosen,
          c,
          subject,
          body,
          outline ?? undefined,
          rawText,
        );
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setNewsletterId(r.id);
        setSaved("✅ حُفظت المسودة");
        onSaved?.(r.id);
      } catch {
        setError("تعذّر حفظ المسودة — تحقّق من الاتصال وحاول مجدداً.");
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <h1 className="text-xl font-bold">النشرة البريدية</h1>
      <p className="mt-1 text-sm text-foreground/60">
        العمود الثاني من محتواك. صُغ فكرة (يدويّاً أو بمعاييرك)، ثم ولّد المسودة مباشرةً أو عبر هيكل
        تتحكّم فيه.
      </p>

      {/* ── المرحلة ١: الفكرة — ثلاثة مسارات في قسم واحد (الملف 30) ──
          كان الحقلان («المحور» و«فكرتك مباشرة») يبدوان قسمين متنافسين، والثاني
          يطفو خارج الصندوق بلا عنوان. الآن مسار واحد معنون لكلٍّ. */}
      <div className="mt-4 space-y-4 rounded-lg border border-foreground/10 p-3">
        <p className="text-xs font-medium text-foreground/50">١ · الفكرة — اختر مساراً واحداً</p>

        {/* المسار (أ): من مصادره — يملأ الفكرة والنصّ الخام معاً */}
        <div className="space-y-2 rounded-lg border border-foreground/10 p-3">
          <p className="text-xs font-medium text-foreground/70">أ · من مصادرك</p>
          <button
            onClick={toggleSources}
            disabled={pending}
            aria-label="اختر فكرة من مصادرك"
            className="rounded-lg border border-foreground/20 px-3 py-2 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
          >
            {sources ? "أغلق المصادر" : "أفكارك الملتقطة · منشورات ومسودات إكس"}
          </button>
          {sourcesPanel}
        </div>

        {/* المسار (ب): يكتبها بنفسه */}
        <div className="space-y-2 rounded-lg border border-foreground/10 p-3">
          <p className="text-xs font-medium text-foreground/70">ب · اكتبها بنفسك</p>
          <textarea
            value={manual}
            onChange={(e) => {
              setManual(e.target.value);
              setSelected("");
              setOutline(null);
            }}
            rows={2}
            placeholder="اكتب فكرة نشرتك الجاهزة هنا"
            aria-label="فكرة يدوية"
            className="w-full rounded-lg border border-foreground/15 bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
          />
        </div>

        {/* المسار (ج): يولّدها المحرّك من محور */}
        <div className="space-y-3 rounded-lg border border-foreground/10 p-3">
          <p className="text-xs font-medium text-foreground/70">ج · ولّدها من محور</p>
        <div>
          <label className="mb-1 block text-xs text-foreground/60">المحور / الموضوع</label>
          <input
            value={c.topic}
            onChange={(e) => setC({ ...c, topic: e.target.value })}
            placeholder="مثلاً: البناء العلني للمؤسس المنفرد · هندسة الأوامر للمبتدئين"
            aria-label="محور النشرة"
            className={inputCls}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select label="الشخصية" value={c.persona} onChange={(v) => setC({ ...c, persona: v })} options={PERSONA_OPTIONS} />
          <Select label="الزاوية" value={c.angle} onChange={(v) => setC({ ...c, angle: v })} options={ANGLE_OPTIONS} />
          <Select label="المصدر" value={c.source} onChange={(v) => setC({ ...c, source: v as IdeaCriteria["source"] })} options={SOURCE_OPTIONS} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-foreground/60">ملاحظات (اختياري)</label>
          <input value={c.notes} onChange={(e) => setC({ ...c, notes: e.target.value })} placeholder="أي توجيه إضافي" aria-label="ملاحظات الفكرة" className={inputCls} />
        </div>
        <button
          onClick={genIdeas}
          disabled={busy || !c.topic.trim()}
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          ولّد أفكاراً
        </button>
        </div>
      </div>

      {ideas && ideas.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium">اختر فكرة:</p>
          {ideas.map((idea, i) => (
            <button
              key={i}
              onClick={() => {
                setSelected(idea);
                setManual("");
                setOutline(null);
                setDraft(null);
                setSaved("");
              }}
              className={`block w-full rounded-lg border p-3 text-right text-sm transition ${
                selected === idea ? "border-foreground/40 bg-foreground/5" : "border-foreground/10 hover:bg-foreground/5"
              }`}
            >
              {idea}
            </button>
          ))}
        </div>
      )}

      {/* ── المرحلة ٢: التخصيص + اختيار المسار ──
          كل التحكم ظاهر من فتح الشاشة (الملف 30): كان محجوباً خلف اختيار الفكرة،
          فلم يكن المالك يرى ضوابطه أصلاً. الأزرار وحدها تنتظر الفكرة. */}
      <div className="mt-6 space-y-3 rounded-lg border border-foreground/10 p-3">
          <p className="text-xs font-medium text-foreground/50">٢ · إعدادات المسودة</p>
          {chosen ? (
            <p className="text-sm">
              <span className="font-medium">الفكرة المختارة:</span> {chosen}
            </p>
          ) : (
            <p className="text-sm text-foreground/50">
              اضبط ما تشاء الآن — الأزرار تعمل فور اختيار فكرة أو كتابتها أعلاه.
            </p>
          )}
          {/* النصّ الخام (الملف 27): مادّة القصة والأرقام الحقيقية — قاعدة «كل قصة
              وأرقامها حقيقية» كانت قيداً بلا مادة، والفكرة السطرية لا تحمل تجربته. */}
          <div>
            <label className="mb-1 block text-xs text-foreground/60">
              نصّك الخام (اختياري — تجربتك وأرقامك الحقيقية بكلامك أنت)
            </label>
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={4}
              placeholder="اكتب أو الصق ما حصل معك فعلاً: المشهد، الأرقام، الأدوات، ما جرّبته وما فشل. المحرّك يبني النشرة على هذه الوقائع ولا يخترع بديلاً عنها."
              aria-label="النصّ الخام"
              className="w-full rounded-lg border border-foreground/15 bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
            />
            {rawText.trim() && (
              <p className="mt-1 text-xs text-foreground/50">
                {rawText.trim().split(/\s+/).length} كلمة — ستُعامل وقائعها كما هي بلا استبدال
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="غرض النشرة" value={opts.purpose} onChange={(v) => setOpts({ ...opts, purpose: v as DraftOptions["purpose"] })} options={PURPOSE_OPTIONS} />
            <Select label="الطول" value={opts.length} onChange={(v) => setOpts({ ...opts, length: v as DraftOptions["length"] })} options={LENGTH_OPTIONS} />
            <Select label="الأسلوب" value={opts.style} onChange={(v) => setOpts({ ...opts, style: v as DraftOptions["style"] })} options={STYLE_OPTIONS} />
            <Select label="الزاوية" value={opts.angle} onChange={(v) => setOpts({ ...opts, angle: v })} options={ANGLE_OPTIONS} />
          </div>
          {/* مسار التنفيذ (الملف 26): الجلسة بلا سقف زمني، والمباشر طوارئ ضمن ٣٠٠ث */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="مسار التنفيذ" value={engine} onChange={setEngine} options={ENGINE_OPTIONS} />
            <Select label="نهج التحسين" value={critic} onChange={setCritic} options={CRITIC_OPTIONS} />
            <Select label="النموذج" value={model} onChange={setModel} options={MODEL_OPTIONS} />
            <Select label="عمق التفكير" value={effort} onChange={setEffort} options={EFFORT_OPTIONS} />
          </div>
          {critic === "merge" && engine === "session" && (
            <p className="text-xs text-foreground/50">
              كلود وجيبيتي يكتبان النشرة بالتوازي بنفس التعليمات، ثم يركّب كلود أفضل ما فيهما — ونشرة
              جيبيتي الخام تُحفظ لتحكم بعينك. يستغرق أطول من النقد الداخلي.
            </p>
          )}
          <div>
            <label className="mb-1 block text-xs text-foreground/60">ملاحظات للمسودة (اختياري)</label>
            <input value={opts.notes} onChange={(e) => setOpts({ ...opts, notes: e.target.value })} placeholder="أي توجيه على الصياغة" aria-label="ملاحظات المسودة" className={inputCls} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={opts.search} onChange={(e) => setOpts({ ...opts, search: e.target.checked })} className="h-4 w-4 accent-foreground" />
            بحث حيّ (حقائق/أمثلة حديثة)
          </label>
          <div className="space-y-2 border-t border-foreground/10 pt-3">
            <p className="text-xs font-medium text-foreground/50">مقاييس النبرة (اختياري — افتراضات معقولة)</p>
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {TONE_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="mb-1 flex items-center justify-between text-xs text-foreground/60">
                    <span>{f.label}</span>
                    <span className="tabular-nums text-foreground/80">{opts.tone[f.key]}</span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={opts.tone[f.key]}
                    onChange={(e) =>
                      setOpts({ ...opts, tone: { ...opts.tone, [f.key]: Number(e.target.value) } })
                    }
                    aria-label={f.label}
                    className="w-full accent-foreground"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => genDraft(false)}
              disabled={busy || !chosen}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              ولّد المسودة مباشرة
            </button>
            <button
              onClick={genOutline}
              disabled={busy || !chosen}
              className="rounded-lg border border-foreground/20 px-4 py-2 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
            >
              ولّد الهيكل أولاً
            </button>
            <button
              onClick={saveIdeaOnly}
              disabled={busy || !chosen}
              className="rounded-lg border border-foreground/20 px-3 py-2 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
            >
              احفظ الفكرة فقط
            </button>
          </div>
          <p className="text-xs text-foreground/40">
            «مباشرة» مسار سريع. «الهيكل أولاً» يمنحك خطّة قابلة للتحرير قبل التوسيع.
          </p>
        </div>

      {/* ── المرحلة ٣ (اختيارية): الهيكل القابل للتحرير ── */}
      {outline !== null && (
        <div className="mt-4 space-y-3 rounded-lg border border-foreground/10 p-3">
          <p className="text-xs font-medium text-foreground/50">هيكل النشرة — حرّره ثم ولّد المسودة منه</p>
          <textarea
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
            rows={10}
            aria-label="هيكل النشرة"
            className="w-full rounded-lg border border-foreground/15 bg-transparent p-3 text-sm leading-relaxed outline-none focus:border-foreground/40"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => genDraft(true)}
              disabled={busy || !outline.trim()}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              ولّد المسودة من الهيكل
            </button>
            <button
              onClick={genOutline}
              disabled={busy || !chosen}
              className="rounded-lg border border-foreground/20 px-3 py-2 text-xs font-medium transition hover:bg-foreground/5 disabled:opacity-50"
            >
              أعد توليد الهيكل
            </button>
          </div>
        </div>
      )}

      {draft && (
        <div className="mt-4 space-y-3">
          {critique && (
            <div className="rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-xs">
              <p className="font-medium text-foreground/70">
                ✨ مرّت بحلقة نقد ذاتي{critique.overall != null ? ` · التقييم ${critique.overall}/10` : ""}
              </p>
              {critique.weakest.length > 0 && (
                <p className="mt-1 text-foreground/60">قُوّي: {critique.weakest.join(" · ")}</p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-foreground/50">عرض المسودة قبل التحسين</summary>
                <p className="mt-2 font-medium text-foreground/70">{critique.firstSubject}</p>
                <p className="mt-1 whitespace-pre-wrap leading-relaxed text-foreground/60">
                  {critique.firstDraft}
                </p>
              </details>
            </div>
          )}
          {/* الدمج المتوازي: تقرير التركيب + نشرة جيبيتي الخام ليحكم المالك بعينه */}
          {mergeReport && (
            <div className="rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-xs">
              <p className="font-medium text-foreground/70">تقرير الدمج (كلود × جيبيتي)</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed text-foreground/60">{mergeReport}</p>
            </div>
          )}
          {altDraft && (
            <details className="rounded-lg border border-foreground/10 p-3 text-xs">
              <summary className="cursor-pointer text-foreground/60">
                نشرة جيبيتي الخام — «{altDraft.subject || "بلا عنوان"}»
              </summary>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed text-foreground/60">
                {altDraft.draft}
              </p>
            </details>
          )}
          <div>
            <label htmlFor="nl-subject" className="mb-1 block text-xs text-foreground/60">العنوان</label>
            <input id="nl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="عنوان النشرة" className={inputCls} />
          </div>
          <div>
            <label htmlFor="nl-body" className="mb-1 block text-xs text-foreground/60">المسودة</label>
            <textarea
              id="nl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={18}
              className="w-full rounded-lg border border-foreground/15 bg-transparent p-3 text-sm leading-relaxed outline-none focus:border-foreground/40"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={saveDraft}
              disabled={busy || !body.trim()}
              className="rounded-lg border border-foreground/20 px-4 py-2 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-50"
            >
              احفظ المسودة
            </button>
            {/* زوج الذوق البريديّ (الملف 27): يظهر فقط حين يختلف المحرَّر عن المولَّد —
                فالفرق نفسه هو الدرس. قناة النشرة منفصلة عن أزواج إكس عمداً. */}
            {draft && body.trim() && body.trim() !== draft.draft.trim() && (
              <>
                <input
                  value={tasteLesson}
                  onChange={(e) => setTasteLesson(e.target.value)}
                  placeholder="الدرس من تعديلك (اختياري)"
                  aria-label="درس زوج الذوق"
                  className="min-w-[14rem] flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
                <button
                  onClick={saveTaste}
                  disabled={busy}
                  aria-label="سجّل زوج ذوق بريديّ"
                  className="rounded-lg border border-foreground/20 px-4 py-2 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
                >
                  سجّل ذوقاً
                </button>
              </>
            )}
          </div>
          {tasteSaved && <p className="text-sm text-foreground/60">{tasteSaved}</p>}

          {/* جولة أخرى بملاحظتك (الملف 33): تعيد استعمال مدخل الجولة السابقة كاملاً
              وتُصلح ما ذكرتَه وتحفظ الباقي — بدل إعادة توليد تُسقط ما نجح. */}
          {body.trim() && (
            <div className="space-y-2 border-t border-foreground/10 pt-3">
              <label className="block text-xs text-foreground/60">
                ما الذي لم يعجبك؟ (جولة أخرى تصلح المذكور وتحفظ الباقي)
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={revNote}
                  onChange={(e) => setRevNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") askRevision();
                  }}
                  placeholder="مثلاً: العنوان حلو خلّه، بس الافتتاحية باردة وأبغاها مشهداً حقيقياً"
                  aria-label="ملاحظة جولة المراجعة"
                  className="min-w-[16rem] flex-1 rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
                <button
                  onClick={askRevision}
                  disabled={busy || !revNote.trim()}
                  aria-label="ولّد جولة مراجعة"
                  className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                >
                  جولة أخرى
                </button>
              </div>
              <p className="text-xs text-foreground/40">
                بلا نقد وبلا دمج — ملاحظتك هي النقد. والعنوان يبقى كما هو ما لم تكن ملاحظتك عنه.
              </p>
            </div>
          )}

          {/* ── النشر في لوبس (الملف 35): المسودة المعتمدة → حملة في لوبس عبر العامل.
              لا إرسال فوري أبداً — إمّا مسودة تُرسلها من اللوحة، أو جدولة بتوقيت تحدّده. */}
          {canPublish && (
            <div className="space-y-3 border-t border-foreground/10 pt-3">
              <p className="text-xs font-medium text-foreground/50">النشر في لوبس 📮</p>

              {audiences === null ? (
                <p className="text-xs text-foreground/50">يحمّل الجماهير…</p>
              ) : (
                <Select
                  label="الجمهور"
                  value={audienceKey}
                  onChange={setAudienceKey}
                  options={audiences.map((a) => ({ value: a.key, label: a.label }))}
                />
              )}

              <div>
                <label htmlFor="nl-preview-text" className="mb-1 block text-xs text-foreground/60">
                  نصّ المعاينة (اختياري — السطر الذي يظهر تحت العنوان في صندوق الوارد)
                </label>
                <input
                  id="nl-preview-text"
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  aria-label="نصّ المعاينة"
                  className={inputCls}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="nl-preview-to" className="mb-1 block text-xs text-foreground/60">
                    معاينة إلى بريد (اختياري)
                  </label>
                  <input
                    id="nl-preview-to"
                    type="email"
                    value={previewTo}
                    onChange={(e) => setPreviewTo(e.target.value)}
                    aria-label="بريد المعاينة"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="nl-schedule-at" className="mb-1 block text-xs text-foreground/60">
                    جدولة الإرسال (اختياري)
                  </label>
                  <input
                    id="nl-schedule-at"
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    aria-label="توقيت جدولة الإرسال"
                    className={inputCls}
                  />
                </div>
              </div>
              <p className="text-xs text-foreground/40">
                اتركه فارغاً لتُنشأ مسودة في لوبس ترسلها أنت من اللوحة
              </p>

              <button
                onClick={publishToLoops}
                disabled={publishing || !subject.trim()}
                aria-label="أنشئ الحملة في لوبس"
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              >
                أنشئ الحملة في لوبس
              </button>

              {publishing && publishNote && (
                <p className="text-sm text-foreground/60">⏳ {publishNote}</p>
              )}
              {publishError && (
                <p className="text-sm text-red-600 dark:text-red-400">{publishError}</p>
              )}

              {publishDone && (
                <div className="space-y-2 rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-sm">
                  <p className="font-medium text-foreground/80">
                    {publishDone.scheduled ? "مجدولة ✓" : "مسودة في لوبس — أرسلها من اللوحة"}
                  </p>
                  {publishDone.url && (
                    <a
                      href={publishDone.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block underline underline-offset-4 hover:opacity-80"
                    >
                      افتح الحملة في لوبس
                    </a>
                  )}
                  {publishDone.previewSent && (
                    <p className="text-emerald-600 dark:text-emerald-400">معاينة أُرسلت ✓</p>
                  )}
                  {publishDone.guardianErrors.length > 0 && (
                    <div className="text-xs text-red-600 dark:text-red-400">
                      <p className="font-medium">أخطاء الفحص:</p>
                      <ul className="mt-1 space-y-1">
                        {publishDone.guardianErrors.map((m, i) => (
                          <li key={i}>• {m}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {publishDone.guardianWarnings.length > 0 && (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      <p className="font-medium">تنبيهات الفحص:</p>
                      <ul className="mt-1 space-y-1">
                        {publishDone.guardianWarnings.map((m, i) => (
                          <li key={i}>• {m}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {pending && <p className="mt-3 text-sm text-foreground/50">يعمل…</p>}
      {/* حالة الانتظار على مسار الجلسة — المهمة محفوظة في الجدول ولا تضيع بإغلاق الصفحة */}
      {waitNote && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-foreground/10 bg-foreground/5 p-3 text-sm">
          <span className="text-foreground/70">⏳ {waitNote}</span>
          {jobId && (
            <button
              onClick={cancelWait}
              aria-label="إلغاء الطلب"
              className="rounded-lg border border-foreground/15 px-3 py-1 text-xs hover:bg-foreground/10"
            >
              إلغاء
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {saved && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{saved}</p>}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-foreground/60">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

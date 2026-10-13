import "server-only";
import {
  sendMessage,
  sendLongMessage,
  editMessageText,
  answerCallbackQuery,
  pinChatMessage,
  type InlineKeyboard,
} from "@/lib/telegram/api";
import {
  ownerDateString,
  ownerDisplayDate,
  getPlan,
  getOpenTasks,
  getReviewTasks,
  markTaskDone,
  deferTask,
  dropTask,
  setAwaitingException,
  getAwaitingDraft,
  setAwaitingBlocker,
  setTaskBlocker,
  getTaskAwaitingBlocker,
  updateTaskSteps,
  type ReviewTask,
} from "@/lib/dayplan/queries";
import { decomposeSteps } from "@/lib/capture/task";
import { buildDayPlan } from "@/lib/dayplan/engine";
import {
  getPostNeedingMetrics,
  setPostAwaitingMetrics,
  getPostAwaitingMetrics,
  parseMetricsText,
  savePostMetrics,
} from "@/lib/content/metrics";
import {
  getStaleDecision,
  recordOutcomeVerdict,
  getDecisionAwaitingOutcome,
  setDecisionOutcomeText,
} from "@/lib/capture/decision";
import { OWNER_TZ } from "@/lib/config/owner";
import { WEEKLY_REVIEW_DAY } from "@/lib/config/profile";

// ════════════════════════════════════════════════════════════
// الطقس المسائي (الملف 11 — المرحلة ٢): مراجعة اليوم → استثناء الغد → بناء الخطة.
// تفاعل بالأزرار (callback_query) عبر تيليجرام. الحالة محمولة في callback_data
// (بلا جلسة)، عدا «نص حرّ» للاستثناء (مسوّدة منتظِرة في day_plans).
// ════════════════════════════════════════════════════════════

type ChatId = number | string;

// ── تصيير مراجعة اليوم (الخطوة ١) ──────────────────────────
function statusMark(status: string): string {
  switch (status) {
    case "done":
      return "✓ تمت";
    case "inbox":
      return "↩ رُحّلت";
    case "dropped":
      return "✗ أُسقطت";
    default:
      return "⌛ بانتظار";
  }
}

function renderReview(tasks: ReviewTask[]): { text: string; keyboard: InlineKeyboard } {
  const lines = ["🌙 طقس المساء — ماذا أنجزت اليوم؟", ""];
  tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title} — ${statusMark(t.status)}`);
  });
  lines.push("", "اضغط لتحديث كل مهمة، ثم «التالي».");

  const keyboard: InlineKeyboard = tasks.map((t, i) => [
    { text: `${i + 1} ✓`, callback_data: `rv:done:${t.id}` },
    { text: `${i + 1} ↩`, callback_data: `rv:defer:${t.id}` },
    { text: `${i + 1} ✗`, callback_data: `rv:drop:${t.id}` },
  ]);
  keyboard.push([{ text: "التالي ⏭", callback_data: "rv:next" }]);

  return { text: lines.join("\n"), keyboard };
}

// ── استثناء الغد (الخطوة ٢) ────────────────────────────────
function exceptionKeyboard(): InlineKeyboard {
  return [
    [{ text: "لا شيء (عادي)", callback_data: "ex:none" }],
    [
      { text: "سفر", callback_data: "ex:travel" },
      { text: "ترفيه", callback_data: "ex:fun" },
    ],
    [
      { text: "موعد", callback_data: "ex:appt" },
      { text: "نص حرّ", callback_data: "ex:free" },
    ],
  ];
}

async function sendExceptionPrompt(chatId: ChatId): Promise<void> {
  await sendMessage(chatId, "هل من أمر استثنائي غداً؟ (يعاير خطة الغد)", exceptionKeyboard());
}

// ── المواجهة عند الترحيل المتكرّر (المرحلة ٣) ──────────────
async function sendConfrontation(chatId: ChatId, taskId: string): Promise<void> {
  const [task] = await getReviewTasks([taskId]);
  const title = task?.title ?? "هذه المهمة";
  await sendMessage(
    chatId,
    `⚠️ «${title}» ترحّلت ٣ مرّات.\nما القرار؟\n• ليست مهمة فعلاً → أسقطها\n• فيها عائق → ما هو؟\n• أكبر من مهمة → أفكّكها أصغر`,
    [
      [{ text: "أسقطها ✗", callback_data: `cf:drop:${taskId}` }],
      [
        { text: "فيها عائق 🚧", callback_data: `cf:blocker:${taskId}` },
        { text: "أفكّكها أصغر 🔧", callback_data: `cf:split:${taskId}` },
      ],
    ],
  );
}

// ── بناء الخطة وإرسالها وتثبيتها (الخطوة ٣) ─────────────────
async function buildAndSend(
  chatId: ChatId,
  planDate: string,
  exception: string | null,
  builtVia: "evening" | "morning_fallback",
  prefix = "",
): Promise<void> {
  const out = await buildDayPlan(planDate, exception, builtVia);
  // تقسيم آمن (الملف 15): خطة بمهام كثيرة الخطوات قد تتجاوز 4096 فتسقط بصمت
  // مع sendMessage الخام. يُثبَّت رأس السلسلة (فيه الترويسة والمهمة العميقة).
  const msgId = await sendLongMessage(chatId, prefix + out.message);
  if (out.pin && msgId !== undefined) await pinChatMessage(chatId, msgId);
}

// ── أسئلة ما بعد الخطة (الملف 13 — البندان ٢ و٣) ────────────
// سؤال معلّق واحد لكل ليلة (لا استجواب): أرقام منشور حديث أولاً (نافذته ١–٣
// أيام فتضيع)، وإلا نتيجة قرار متقادم — في يوم المراجعة الأسبوعية فقط (إيقاع أسبوعي).
// اليوم من data/profile.json (weeklyReviewDay) ويُقارَن بالاسم المختصر الإنجليزي لأن
// Intl بلغة en-US يعيده ثابتاً مهما كانت لغة النظام.
function isWeeklyReviewDay(): boolean {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: OWNER_TZ,
      weekday: "short",
    }).format(new Date()) === WEEKLY_REVIEW_DAY
  );
}

async function sendEveningAsks(chatId: ChatId): Promise<void> {
  try {
    // انتظار قائم من الطقس نفسه (عائق مهمة من المواجهة)؟ لا تفتح انتظاراً ثانياً —
    // أول نص سيستهلكه فرع العائق، فتُسجَّل الأرقام عائقاً مزيفاً (إصلاح مراجعة).
    if (await getTaskAwaitingBlocker()) return;
    const post = await getPostNeedingMetrics();
    if (post) {
      await setPostAwaitingMetrics(post.id);
      await sendMessage(
        chatId,
        `📊 منشورك «${post.excerpt}» — كيف أداؤه؟\nأرسل خمسة أرقام بالترتيب: مشاهدات إعجابات ردود إعادات حفظ\n(مثال: 1200 45 8 12 30)`,
        [[{ text: "تخطَّ", callback_data: `pm:skip:${post.id}` }]],
      );
      return;
    }
    if (isWeeklyReviewDay()) {
      const dec = await getStaleDecision();
      if (dec) {
        const date = new Intl.DateTimeFormat("ar", {
          timeZone: OWNER_TZ,
          day: "numeric",
          month: "long",
        }).format(new Date(dec.createdAt));
        await sendMessage(
          chatId,
          `🧭 قرارك من ${date}: «${dec.decision}»\nما النتيجة؟`,
          [
            [
              { text: "نجح ✓", callback_data: `do:yes:${dec.id}` },
              { text: "فشل ✗", callback_data: `do:no:${dec.id}` },
            ],
            [
              { text: "جزئياً", callback_data: `do:part:${dec.id}` },
              { text: "مبكر — اسأل لاحقاً", callback_data: `do:later:${dec.id}` },
            ],
          ],
        );
      }
    }
  } catch (e) {
    console.error("[ritual asks]", e); // الأسئلة إثراء — فشلها لا يكسر الطقس
  }
}

// كلمات التخطي للإجابات المعلّقة النصية.
const SKIP_RE = /^(?:تخط|تخطَّ|تخطى|تخطي|تجاهل)\s*$/;

/** يبدأ الطقس المسائي: مراجعة مهام اليوم (إن وُجدت خطة) ثم سؤال استثناء الغد. */
export async function startEveningRitual(chatId: ChatId): Promise<void> {
  const today = ownerDateString(0);
  const plan = await getPlan(today);

  if (plan && plan.taskIds.length > 0) {
    const tasks = await getReviewTasks(plan.taskIds);
    const { text, keyboard } = renderReview(tasks);
    await sendMessage(chatId, text, keyboard);
    return; // الخطوة ٢ تأتي عند ضغط «التالي»
  }

  // لا خطة لليوم (أول طقس أو يوم بلا خطة) → مباشرة لاستثناء الغد.
  await sendMessage(chatId, "🌙 طقس المساء — ما فيه خطة لمراجعتها اليوم.");
  await sendExceptionPrompt(chatId);
}

/** يكمل الطقس حين يرسل المالك نصّ استثناء حرّ (بعد اختيار «نص حرّ»). */
export async function completeExceptionFromText(
  chatId: ChatId,
  text: string,
): Promise<void> {
  const tomorrow = ownerDateString(1);
  await buildAndSend(chatId, tomorrow, text.trim(), "evening");
  await sendEveningAsks(chatId);
}

/**
 * يعالج النصّ كإجابة على سؤال معلّق من الطقس (عائق مهمة أو استثناء الغد) إن وُجد.
 * يُرجع true إن استُهلك النصّ (فلا يُلتقَط كعنصر)، و false إن لم يكن هناك سؤال معلّق.
 */
export async function tryHandlePending(chatId: ChatId, text: string): Promise<boolean> {
  // 1) عائق مهمة مُرحَّلة (المرحلة ٣)
  const blockerTask = await getTaskAwaitingBlocker();
  if (blockerTask) {
    await setTaskBlocker(blockerTask.id, text);
    await sendMessage(
      chatId,
      `🚧 سجّلت عائق «${blockerTask.title}». بنأخذه بالحسبان — وإن حبيت أفكّكها أصغر، رحّلها مرّة ثانية واختر «أفكّكها».`,
    );
    return true;
  }
  // 2) استثناء الغد الحرّ (المرحلة ٢)
  const draft = await getAwaitingDraft();
  if (draft) {
    await completeExceptionFromText(chatId, text);
    return true;
  }
  // 3) أرقام منشور منتظِر (الملف 13 — البند ٣): خمسة أرقام بصيغة صارمة، بلا ذكاء.
  //    نصّ لا يشبه الأرقام = تخطٍّ ضمني: يُطفأ العلم ويسقط النصّ لمسار الالتقاط
  //    الطبيعي (return false). كان الفرع يستهلك كل رسالة «إرشاداً» فيبتلع التقاطات
  //    الصباح كلها أياماً — فقدان بيانات في نظام يقدّس الالتقاط (إصلاح مراجعة).
  //    السؤال يعود تلقائياً في الطقس التالي ما دام المنشور في نافذته.
  const post = await getPostAwaitingMetrics();
  if (post) {
    if (SKIP_RE.test(text.trim())) {
      await setPostAwaitingMetrics(post.id, false);
      await sendMessage(chatId, "تمام — نسأل عنه الليلة القادمة إن بقي في النافذة.");
      return true;
    }
    const m = parseMetricsText(text);
    if (!m) {
      await setPostAwaitingMetrics(post.id, false);
      await sendMessage(
        chatId,
        "📊 ما فهمتها أرقاماً — ألتقطها عادي، ونسأل عن أداء المنشور الليلة القادمة.",
      );
      return false; // النصّ يكمل لمسار الالتقاط — لا يُفقد شيء
    }
    const eng = await savePostMetrics(post.id, m);
    await sendMessage(
      chatId,
      `📊 سجّلت أداء «${post.excerpt}» — التفاعل: ${eng} ✓\nكل رقم يغذّي أمثلة الاحتذاء والمعايرة.`,
    );
    return true;
  }
  // 4) نصّ نتيجة قرار (الملف 13 — البند ٢): الحكم سُجّل بالزرّ، وهذا التفصيل.
  const dec = await getDecisionAwaitingOutcome();
  if (dec) {
    const skip = SKIP_RE.test(text.trim());
    await setDecisionOutcomeText(dec.id, skip ? null : text.trim());
    await sendMessage(
      chatId,
      skip ? "تمام — سُجّل الحكم بلا تفاصيل." : `🧭 سُجّلت نتيجة «${dec.decision}» ✓`,
    );
    return true;
  }
  return false;
}

/** احتياط الصباح: إن لم تُبنَ خطة اليوم مساءً، تُبنى الآن بآخر حالة معروفة. */
export async function runMorningFallback(chatId: ChatId): Promise<boolean> {
  const today = ownerDateString(0);
  const plan = await getPlan(today);
  if (plan && plan.status === "active") return false; // بُنيت مساءً — لا شيء

  await buildAndSend(
    chatId,
    today,
    plan?.exception ?? null,
    "morning_fallback",
    "🌅 (خُطّطت تلقائياً بلا طقس مساء)\n\n",
  );
  return true;
}

// ── عرض الخطة عند الطلب + «تم» خارج الطقس (الملف 15) ───────
// كانت مراجعة الحالة حبيسة لحظتين: الرسالة المثبتة (تعرض ولا تُحدَّث) وطقس
// المساء (يُحدِّث ولا يتاح نهاراً). /خطة تعرض الحالة الحيّة، و/تم تعلّم إنجازاً
// لحظة حدوثه — فلا يضيع إنجاز الصباح إن فات طقس الليل.

/** الأمر /خطة: يعرض خطة اليوم الحالية بحالات حيّة — عرض فقط، بلا إعادة بناء. */
export async function showTodayPlan(chatId: ChatId): Promise<void> {
  const today = ownerDateString(0);
  const plan = await getPlan(today);
  if (!plan || plan.taskIds.length === 0) {
    const exc = plan?.exception ? ` (استثناء: ${plan.exception})` : "";
    await sendMessage(chatId, `ما فيه خطة لليوم${exc} — الطقس المسائي يبنيها، أو /مساء الآن.`);
    return;
  }
  const tasks = await getReviewTasks(plan.taskIds);
  const lines = [`📅 خطة اليوم — ${ownerDisplayDate(today)}`];
  if (plan.exception) lines.push(`⚠️ استثناء: ${plan.exception}`);
  lines.push("");
  tasks.forEach((t, i) => lines.push(`${i + 1}. ${t.title} — ${statusMark(t.status)}`));
  if (plan.why) lines.push("", `💡 لماذا: ${plan.why}`);
  lines.push("", "علّم إنجازك: /تم");
  await sendMessage(chatId, lines.join("\n"));
}

// مرشّحو «تم»: مهام خطة اليوم غير المنتهية أولاً، وإلا أحدث المفتوحة (inbox/planned).
async function buildDonePicker(): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const today = ownerDateString(0);
  const plan = await getPlan(today);
  let candidates: { id: string; title: string }[] = [];
  if (plan && plan.taskIds.length > 0) {
    const tasks = await getReviewTasks(plan.taskIds);
    candidates = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
  }
  if (candidates.length === 0) {
    // getOpenTasks مرتّبة من الأقدم — نقلبها فالأحدث أولاً (الأرجح أنه ما أنجزه للتو).
    const open = await getOpenTasks();
    candidates = open.reverse().map((t) => ({ id: t.id, title: t.title }));
  }
  if (candidates.length === 0) return null;
  const keyboard: InlineKeyboard = candidates.slice(0, 6).map((t) => [
    {
      text: t.title.length <= 40 ? t.title : t.title.slice(0, 40).trim() + "…",
      callback_data: `td:${t.id}`,
    },
  ]);
  return { text: "✅ ماذا أنجزت؟ اضغط المهمة:", keyboard };
}

/** الأمر /تم: لوحة اختيار المهمة المنجَزة (خطة اليوم أولاً ثم المفتوحة). */
export async function handleDoneCommand(chatId: ChatId): Promise<void> {
  const picker = await buildDonePicker();
  if (!picker) {
    await sendMessage(chatId, "ما فيه مهام مفتوحة تُعلَّم 🎉");
    return;
  }
  await sendMessage(chatId, picker.text, picker.keyboard);
}

/** ضغطة td:<id> — إنجاز فوري ثم إعادة تصيير المرشّحين في نفس الرسالة. */
export async function handleTaskDoneCallback(cbq: CallbackQuery): Promise<void> {
  const chatId = cbq.message?.chat?.id;
  const messageId = cbq.message?.message_id;
  const id = (cbq.data ?? "").slice("td:".length);
  if (chatId === undefined || messageId === undefined || !id) {
    await answerCallbackQuery(cbq.id);
    return;
  }
  await markTaskDone(id);
  await answerCallbackQuery(cbq.id, "أُنجزت ✓");
  const picker = await buildDonePicker();
  if (picker) {
    await editMessageText(chatId, messageId, picker.text, picker.keyboard);
  } else {
    await editMessageText(chatId, messageId, "✅ أُنجزت — وما بقي شيء مفتوح. نظيف.");
  }
}

// ── معالجة ضغطات الأزرار ───────────────────────────────────
const EXCEPTION_LABELS: Record<string, string | null> = {
  none: null,
  travel: "سفر",
  fun: "ترفيه",
  appt: "موعد",
};

type CallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
};

/** يعالج ضغطة زرّ من الطقس. يُجيب الاستعلام دائماً (يوقف مؤشّر التحميل). */
export async function handleCallback(cbq: CallbackQuery): Promise<void> {
  const data = cbq.data ?? "";
  const chatId = cbq.message?.chat?.id;
  const messageId = cbq.message?.message_id;
  if (chatId === undefined || messageId === undefined) {
    await answerCallbackQuery(cbq.id);
    return;
  }

  const [ns, action, ...rest] = data.split(":");
  const id = rest.join(":");

  // الخطوة ١: مراجعة المهام
  if (ns === "rv") {
    if (action === "next") {
      await answerCallbackQuery(cbq.id, "تمام");
      const today = ownerDateString(0);
      const plan = await getPlan(today);
      const tasks = plan ? await getReviewTasks(plan.taskIds) : [];
      const summary = tasks.length
        ? tasks
            .map((t, i) => `${i + 1}. ${t.title} — ${statusMark(t.status)}`)
            .join("\n")
        : "";
      await editMessageText(
        chatId,
        messageId,
        `🌙 طقس المساء — مراجعة اليوم ✓\n\n${summary}`,
      );
      await sendExceptionPrompt(chatId);
      return;
    }

    // done / defer / drop على مهمة
    let deferCount = 0;
    if (action === "done") await markTaskDone(id);
    else if (action === "defer") deferCount = await deferTask(id);
    else if (action === "drop") await dropTask(id);
    await answerCallbackQuery(cbq.id, "حُدّثت");

    // أعِد تصيير المراجعة بالحالات المحدّثة
    const today = ownerDateString(0);
    const plan = await getPlan(today);
    if (plan) {
      const tasks = await getReviewTasks(plan.taskIds);
      const { text, keyboard } = renderReview(tasks);
      await editMessageText(chatId, messageId, text, keyboard);
    }

    // المواجهة عند الترحيل الثالث بالضبط (المرحلة ٣) — رسالة منفصلة بأزرار.
    if (action === "defer" && deferCount === 3) {
      await sendConfrontation(chatId, id);
    }
    return;
  }

  // المواجهة: قرار المهمة المُرحَّلة كثيراً
  if (ns === "cf") {
    if (action === "drop") {
      await dropTask(id);
      await answerCallbackQuery(cbq.id, "أُسقطت");
      await editMessageText(chatId, messageId, "✗ أُسقطت المهمة — قرار صائب أحياناً.");
      return;
    }
    if (action === "blocker") {
      await setAwaitingBlocker(id);
      await answerCallbackQuery(cbq.id);
      await editMessageText(chatId, messageId, "🚧 ما العائق؟ اكتبه بسطر واحد.");
      return;
    }
    if (action === "split") {
      await answerCallbackQuery(cbq.id, "أفكّكها…");
      const [task] = await getReviewTasks([id]);
      const steps = task ? await decomposeSteps(task.title) : [];
      if (steps.length > 0) {
        await updateTaskSteps(id, steps);
        await editMessageText(
          chatId,
          messageId,
          `🔧 فُكّكت «${task.title}» إلى ${steps.length} خطوة أصغر. ستظهر في الخطة القادمة.`,
        );
      } else {
        await editMessageText(chatId, messageId, "تعذّر التفكيك الآن — حاول لاحقاً.");
      }
      return;
    }
    await answerCallbackQuery(cbq.id);
    return;
  }

  // الخطوة ٢: استثناء الغد
  if (ns === "ex") {
    if (action === "free") {
      await answerCallbackQuery(cbq.id);
      await setAwaitingException(ownerDateString(1));
      await editMessageText(chatId, messageId, "هل من أمر استثنائي غداً؟ ✍️ نص حرّ");
      await sendMessage(chatId, "اكتب استثناء الغد بسطر واحد (مثلاً: نصف يوم سفر بعد الظهر).");
      return;
    }
    const exception = EXCEPTION_LABELS[action] ?? null;
    await answerCallbackQuery(cbq.id, "أبني خطة الغد…");
    await editMessageText(
      chatId,
      messageId,
      `هل من أمر استثنائي غداً؟ ${exception ?? "لا شيء (عادي)"} ✓`,
    );
    await buildAndSend(chatId, ownerDateString(1), exception, "evening");
    await sendEveningAsks(chatId);
    return;
  }

  // أرقام منشور: زرّ التخطي (الملف 13 — البند ٣)
  if (ns === "pm") {
    if (action === "skip") {
      await setPostAwaitingMetrics(id, false);
      await answerCallbackQuery(cbq.id, "تمام");
      await editMessageText(chatId, messageId, "📊 تخطّينا أرقام هذا المنشور الليلة.");
    } else {
      await answerCallbackQuery(cbq.id);
    }
    return;
  }

  // نتيجة قرار متقادم (الملف 13 — البند ٢)
  if (ns === "do") {
    if (action === "later") {
      await answerCallbackQuery(cbq.id, "تمام");
      await editMessageText(chatId, messageId, "🧭 مبكر — نسأل عنه خميساً قادماً.");
      return;
    }
    const verdict = action === "yes" ? "yes" : action === "no" ? "no" : action === "part" ? "partial" : null;
    if (verdict) {
      await recordOutcomeVerdict(id, verdict);
      await answerCallbackQuery(cbq.id, "سُجّل");
      const label = verdict === "yes" ? "نجح ✓" : verdict === "no" ? "فشل ✗" : "جزئياً";
      await editMessageText(
        chatId,
        messageId,
        `🧭 ${label} — اكتب النتيجة بسطر واحد (ماذا حدث فعلاً؟) أو أرسل «تخطَّ».`,
      );
      return;
    }
    await answerCallbackQuery(cbq.id);
    return;
  }

  // غير معروف
  await answerCallbackQuery(cbq.id);
}

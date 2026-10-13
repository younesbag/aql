import { NextResponse, after } from "next/server";
import { processIncomingItem, type SourceType } from "@/lib/capture/process";
import { detectTaskCommand, looksLikeTask } from "@/lib/capture/task";
import { segmentAndProcess, buildCaptureReply } from "@/lib/capture/segment";
import {
  analyzeArticle,
  detectArticle,
  isBareXLink,
  LONG_PASTE_THRESHOLD,
  storeArticle,
  convertPlanToTasks,
} from "@/lib/capture/article";
import {
  sendMessage,
  sendLongMessage,
  downloadFileBase64,
  answerCallbackQuery,
  editMessageText,
} from "@/lib/telegram/api";
import { transcribeAudio } from "@/lib/ai/gemini";
import {
  handleCallback,
  startEveningRitual,
  tryHandlePending,
  showTodayPlan,
  handleDoneCommand,
  handleTaskDoneCallback,
} from "@/lib/dayplan/ritual";
import { patternReport } from "@/lib/dayplan/reports";
import { handleDraftsCommand, handleDraftsCallback } from "@/lib/content/drafts";
import { handleJournalCommand, handleJournalCallback } from "@/lib/insights/journal";
import {
  detectMindQuestion,
  detectVoiceMindQuestion,
  answerMindQuestion,
} from "@/lib/agents/telegram-ask";
import {
  looksLikeDecision,
  suggestDecisionCapture,
  confirmDecisionCapture,
} from "@/lib/capture/decision";
import { OWNER_NAME } from "@/lib/config/owner";

// يحتاج Node.js runtime (Buffer + Gemini + Supabase).
export const runtime = "nodejs";
// سقف Hobby الصلب (§٧) موثَّقاً صراحة: أطول أعمال الويبهوك (تحليل مقال Pro،
// /اسأل بجولاته) تجري ضمنه — وتجاوزه يقتل after() بصمت. التوليد الكتابي (xhigh)
// خارج نطاق البوت عمداً حتى يُحسم القرار المؤجل.
export const maxDuration = 300;

const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

type TgFile = { file_id: string; mime_type?: string };
type TgDocument = TgFile & { file_name?: string; file_size?: number };
type TgCallbackQuery = {
  id: string;
  data?: string;
  from?: { id?: number };
  // text ضروري لأزرار المذكرة: مسودة المذكرة محمولة في نصّ رسالتها (الملف 15).
  message?: { message_id?: number; chat?: { id?: number }; text?: string };
};
type TgUpdate = {
  message?: {
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
    voice?: TgFile;
    audio?: TgFile;
    document?: TgDocument;
  };
  callback_query?: TgCallbackQuery;
};

// دليل الأوامر (الملف 15) — قائمة «/» في تيليجرام تقبل أسماء لاتينية فقط (قيد
// المنصة)، فتُسجَّل مرادفات لاتينية بوصف عربي (scripts/set-telegram-commands.mjs)
// وتبقى الأوامر العربية هي الأصل هنا.
const HELP_TEXT = [
  `🧠 عقل ${OWNER_NAME} — الأوامر:`,
  "",
  "/اسأل سؤالك — العقل الموحّد بذاكرتك كاملة (أو ابدأ بـ«؟»)",
  "/مسودات — مسودات إكس: نصّ للنسخ · وسم النشر · حذف",
  "/خطة — عرض خطة اليوم بحالاتها الحيّة",
  "/تم — علّم مهمة أُنجزت الآن",
  "/مساء — طقس المساء عند الطلب",
  "/مذكرة — مسودة مذكرة الأسبوع وحفظها",
  "/رد بريد@فلان — سجّل ردّ مشترك على بريدك (أقوى إشارة شراء)",
  "/أنماط — تقرير أنماط الإنجاز والمماطلة",
  "/مهمة نصّها — التقاط مهمة صريحة",
  "/article نص المقال — تحليل مقال (أو أرسل ملف .txt)",
  "",
  "وأي نصّ أو صوت آخر يُلتقط فكرةً تلقائياً.",
  "قائمة «/» تعرض مرادفات لاتينية (قيد من تيليجرام) — والعربية تعمل دائماً.",
].join("\n");

// أول رابط في النص (لتحديد source_type='signal').
function firstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/\S+/i);
  return m?.[0];
}

// مسار المقال المشترك (لصق قصير أو ملف .txt): إشعار فوري ← والعمل الثقيل كله
// (تخزين + تحليل Pro قد يستغرق دقائق + الردود) داخل after() — تيليجرام يعيد إرسال
// التحديث إن تأخّر ردّ الـwebhook، فكان المقال يُخزَّن ويُحلَّل مكرّراً (إصلاح مراجعة).
async function handleArticleText(
  chatId: number,
  articleText: string,
  sourceUrl?: string,
): Promise<void> {
  await sendMessage(chatId, "📄 جارٍ تحليل المقال…");
  after(async () => {
    try {
      const itemId = await storeArticle(articleText, sourceUrl);
      const { reply, threadIdeas, planCount } = await analyzeArticle(articleText, itemId);
      const note =
        threadIdeas.length > 0
          ? "\n\n💡 أضفت أفكار الثريدات لأفكارك في «الالتقاط» — ولّد منها في «المحتوى» مباشرة."
          : "";
      await sendLongMessage(chatId, reply + note);

      // زرّ تحويل خطة التطبيق لمهام (الملف 13 — البند ٤): كانت الخطة تُقرأ ثم تتبخر.
      if (planCount > 0) {
        await sendMessage(
          chatId,
          "🎯 أحوّل خطة التطبيق أعلاه لمهام مفكّكة (بجسر للمقال)؟",
          [[{ text: "حوّلها لمهام 🔧", callback_data: `ap:run:${itemId}` }]],
        );
      }

      // التقط أفكار الثريدات تلقائياً كأفكار محتوى — نفس مسار الالتقاط (تصنيف + embedding).
      for (const idea of threadIdeas) {
        try {
          await processIncomingItem(idea, "idea", sourceUrl);
        } catch (e) {
          console.error("[capture thread idea]", e);
        }
      }
    } catch (e) {
      console.error("[article]", e);
      try {
        await sendMessage(
          chatId,
          "تعذّرت معالجة المقال: " + (e instanceof Error ? e.message : "غير معروف"),
        );
      } catch {
        // تجاهل فشل رسالة الخطأ
      }
    }
  });
}

// أزرار الحلقات الجديدة (الملف 13): dc (توثيق قرار) و ap (خطة مقال → مهام).
// تُعالَج هنا قبل تمرير الباقي (rv/cf/ex/do/pm) إلى الطقس.
async function handleLoopCallback(
  cbq: TgCallbackQuery,
  chatId: number,
): Promise<boolean> {
  const data = cbq.data ?? "";
  const messageId = cbq.message?.message_id;
  const [ns, action, ...rest] = data.split(":");
  const id = rest.join(":");
  if (messageId === undefined) return false;

  // نمط إلزامي للزرّين (إصلاح مراجعة): تحرير الرسالة فوراً **بلا لوحة أزرار**
  // (يقتل الضغطة الثانية) ثم العمل الثقيل داخل after() فيعود 200 فوراً (يقتل
  // إعادة إرسال تيليجرام للتحديث). كان نداء pro المتزامن يكرّر القرارات.
  if (ns === "dc") {
    if (action === "ok") {
      await answerCallbackQuery(cbq.id, "يوثّق…");
      await editMessageText(chatId, messageId, "🧭 يوثّق…");
      after(async () => {
        try {
          const r = await confirmDecisionCapture(id);
          const msg =
            r.status === "created"
              ? `🧭 وُثّق ${r.count === 1 ? "القرار" : `${r.count} قرارات`} في سجلّ القرارات ✓ — النتيجة تُسأل لاحقاً حين تنضج.`
              : r.status === "already"
                ? "🧭 سبق توثيقه ✓"
                : "تعذّر التوثيق الآن — وثّقه يدوياً من «الرؤى» إن شئت.";
          await editMessageText(chatId, messageId, msg);
        } catch (e) {
          console.error("[dc:ok]", e);
          await editMessageText(chatId, messageId, "تعذّر التوثيق الآن — حاول لاحقاً.");
        }
      });
      return true;
    }
    if (action === "no") {
      await answerCallbackQuery(cbq.id, "تمام");
      await editMessageText(chatId, messageId, "🧭 تجاهلنا — لم يُوثَّق شيء.");
      return true;
    }
  }

  if (ns === "ap" && action === "run") {
    await answerCallbackQuery(cbq.id, "يحوّل…");
    await editMessageText(chatId, messageId, "🔧 يحوّل الخطة لمهام…");
    after(async () => {
      try {
        const r = await convertPlanToTasks(id);
        const msg =
          r.status === "created"
            ? `🔧 حُوّلت الخطة إلى ${r.titles.length === 1 ? "مهمة واحدة" : `${r.titles.length} مهام`}:\n${r.titles.map((t) => `• ${t}`).join("\n")}\nستدخل ترشيحات خطة اليوم القادمة.`
            : r.status === "already"
              ? "سبق تحويل خطة هذا المقال لمهام ✓"
              : r.status === "empty"
                ? "لا خطة تطبيق محفوظة لهذا المقال."
                : "تعذّر التحويل الآن — حاول لاحقاً.";
        await editMessageText(chatId, messageId, msg);
      } catch (e) {
        console.error("[ap:run]", e);
        await editMessageText(chatId, messageId, "تعذّر التحويل الآن — حاول لاحقاً.");
      }
    });
    return true;
  }

  return false;
}

export async function POST(request: Request) {
  // 1) تحقّق أمني من رأس السرّ — أي طلب بسرّ خاطئ يُرفض.
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // 2) ضغطات الأزرار (callback_query) — قبل مسار الرسائل. حلقات الملف 13 أولاً
  //    (dc/ap)، ثم شاشات الملف 15 (df/jr/td)، ثم أزرار الطقس (rv/cf/ex/do/pm).
  const cbq = update.callback_query;
  if (cbq) {
    const cbChatId = cbq.message?.chat?.id;
    const cbFromId = cbq.from?.id;
    if (
      cbChatId !== undefined &&
      String(cbChatId) === String(ALLOWED_CHAT_ID) &&
      // حصن الهوية (الملف 15): في الخاص from.id = chat.id، والفحص يسدّ سيناريو
      // مجموعةٍ معرفها مسموح نظرياً — لا يضغط أزرار المالك غير المالك.
      (cbFromId === undefined || String(cbFromId) === String(ALLOWED_CHAT_ID))
    ) {
      try {
        const data = cbq.data ?? "";
        const handled = await handleLoopCallback(cbq, cbChatId);
        if (!handled) {
          if (data.startsWith("df:")) await handleDraftsCallback(cbq, cbChatId);
          else if (data.startsWith("jr:")) await handleJournalCallback(cbq, cbChatId);
          else if (data.startsWith("td:")) await handleTaskDoneCallback(cbq);
          else await handleCallback(cbq);
        }
      } catch (e) {
        console.error("[telegram callback]", e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  const chatId = message?.chat?.id;

  // 3) قيد المرسل (حصن): فقط محادثة المالك — أي مرسل آخر يُتجاهَل بصمت (200).
  if (
    !message ||
    chatId === undefined ||
    String(chatId) !== String(ALLOWED_CHAT_ID)
  ) {
    return NextResponse.json({ ok: true });
  }
  // حصن الهوية (الملف 15): نفس منطق فحص الأزرار أعلاه — للرسائل.
  const senderId = message.from?.id;
  if (senderId !== undefined && String(senderId) !== String(ALLOWED_CHAT_ID)) {
    return NextResponse.json({ ok: true });
  }

  try {
    let text: string | undefined;
    let sourceType: SourceType = "idea";
    let sourceUrl: string | undefined;

    // ملف نصّي (.txt/.md) → مقال كامل (لا يقسّمه تيليجرام كاللصق الطويل). الملف 09.
    const doc = message.document;
    if (doc) {
      const name = (doc.file_name ?? "").toLowerCase();
      const isText =
        (doc.mime_type ?? "").startsWith("text/") ||
        name.endsWith(".txt") ||
        name.endsWith(".md");
      if (!isText) {
        await sendMessage(chatId, "أرسل ملفاً نصّياً (.txt) أو الصق النص — لا أدعم هذا النوع.");
        return NextResponse.json({ ok: true });
      }
      if ((doc.file_size ?? 0) > 2_000_000) {
        await sendMessage(chatId, "الملف كبير جداً (الحدّ ~2MB).");
        return NextResponse.json({ ok: true });
      }
      const base64 = await downloadFileBase64(doc.file_id);
      const fileText = Buffer.from(base64, "base64").toString("utf8").trim();
      if (!fileText) {
        await sendMessage(chatId, "الملف فارغ — لا نصّ لتحليله.");
        return NextResponse.json({ ok: true });
      }
      await handleArticleText(chatId, fileText);
      return NextResponse.json({ ok: true });
    }

    const media = message.voice ?? message.audio;
    if (media) {
      // 3) رسالة صوتية → نزّل من تيليجرام ثم فرّغ عبر Gemini.
      const base64 = await downloadFileBase64(media.file_id);
      const tr = await transcribeAudio(base64, media.mime_type ?? "audio/ogg");
      if (!tr.ok) {
        await sendMessage(chatId, "تعذّر تفريغ الرسالة الصوتية: " + tr.error);
        return NextResponse.json({ ok: true });
      }
      text = tr.data;
      sourceType = "voice";
      // سؤال صوتي للعقل (الملف 13 — البند ١): التفريغ يبدأ بـ«اسأل/سؤال».
      const vq = detectVoiceMindQuestion(text);
      if (vq.isQuestion && vq.question) {
        await sendMessage(chatId, "🧠 يفكّر…");
        after(() => answerMindQuestion(chatId, vq.question));
        return NextResponse.json({ ok: true });
      }
    } else if (typeof message.text === "string") {
      text = message.text;
      // تنبيه رابط إكس وحده — لا جلب آلي (الملف 09).
      if (isBareXLink(text)) {
        await sendMessage(
          chatId,
          "الصق نص المقال، لا الرابط — مقالات إكس محجوبة للجلب الآلي.",
        );
        return NextResponse.json({ ok: true });
      }
      // لصق طويل (قد يكون تيليجرام قسّمه إلى رسائل) → أرشد لإرساله كملف .txt للتحليل الكامل.
      if (text.length >= LONG_PASTE_THRESHOLD) {
        await sendMessage(
          chatId,
          "📄 المقال طويل وقد يكون انقسم إلى رسائل. أرسله كملف نصّي (.txt) لأحلّله كاملاً دفعةً واحدة.",
        );
        return NextResponse.json({ ok: true });
      }
      // كشف المقال (الملف 09): /article يفرضه، أو نص > 500 كلمة → مسار المقال.
      const { isArticle, articleText } = detectArticle(text);
      if (isArticle) {
        if (!articleText) {
          await sendMessage(chatId, "أرسل نص المقال بعد الأمر /article.");
          return NextResponse.json({ ok: true });
        }
        await handleArticleText(chatId, articleText, firstUrl(articleText));
        return NextResponse.json({ ok: true });
      }
      const url = firstUrl(text);
      if (url) {
        sourceType = "signal";
        sourceUrl = url;
      }
    }

    if (!text || !text.trim()) {
      await sendMessage(
        chatId,
        "لم أتعرّف على محتوى لالتقاطه. أرسل نصاً أو رابطاً أو رسالة صوتية.",
      );
      return NextResponse.json({ ok: true });
    }

    // 3.4) سؤال للعقل (الملف 13 — البند ١): /اسأل أو /سؤال أو بادئة «؟».
    //     قبل الإجابات المعلّقة عمداً: سؤال عابر أثناء طقسٍ معلّق يُجاب ولا يُبتلع.
    //     النمط الإلزامي: «يفكّر…» فوراً + الجواب في after() — تيليجرام يعيد
    //     إرسال التحديث إن تأخّر ردّ الـwebhook، وهذا يقيه.
    const mq = detectMindQuestion(text);
    if (mq.isQuestion) {
      if (!mq.question) {
        await sendMessage(chatId, "اكتب سؤالك بعد /اسأل — مثلاً: /اسأل وش قراراتي عن التسعير؟");
        return NextResponse.json({ ok: true });
      }
      await sendMessage(chatId, "🧠 يفكّر…");
      const q = mq.question;
      after(() => answerMindQuestion(chatId, q));
      return NextResponse.json({ ok: true });
    }

    // 3.5) أوامر الطقس والتقارير والشاشات (الملفان 11 و15) + الإجابات المعلّقة.
    //      لكل أمر عربي مرادفه اللاتيني من قائمة «/» (قيد تيليجرام — أسماء لاتينية فقط).
    if (/^\/(?:مساء|طقس|evening)(?:\s|$)/.test(text)) {
      await startEveningRitual(chatId);
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:أنماط|تقرير|patterns)(?:\s|$)/.test(text)) {
      // تقسيم آمن (الملف 15): التقرير ينمو مع البيانات وكان يسقط بصمت فوق 4096.
      await sendLongMessage(chatId, await patternReport());
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:مساعدة|help|start)(?:\s|$)/.test(text)) {
      await sendMessage(chatId, HELP_TEXT);
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:مسودات|drafts)(?:\s|$)/.test(text)) {
      await handleDraftsCommand(chatId);
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:خطة|plan)(?:\s|$)/.test(text)) {
      await showTodayPlan(chatId);
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:تم|done)(?:\s|$)/.test(text)) {
      await handleDoneCommand(chatId);
      return NextResponse.json({ ok: true });
    }
    if (/^\/(?:مذكرة|journal)(?:\s|$)/.test(text)) {
      await handleJournalCommand(chatId);
      return NextResponse.json({ ok: true });
    }
    // الملف 37: /رد بريد@فلان [ملاحظة] — أقوى إشارة شراء تدخل نهر الأحداث يدوياً
    // (webhook لوبس لا يبثّ الردود — قيد منصة موثّق)
    if (/^\/(?:رد|reply)(?:\s|$)/.test(text)) {
      const args = text.replace(/^\/(?:رد|reply)\s*/, "").trim();
      const [replyEmail, ...noteParts] = args.split(/\s+/);
      if (!replyEmail) {
        await sendMessage(chatId, "الصيغة: /رد بريد@مثال.كوم ملاحظة اختيارية");
        return NextResponse.json({ ok: true });
      }
      const { recordReply } = await import("@/lib/loops/reply");
      const r = await recordReply(replyEmail, noteParts.join(" "));
      const WARMTH_AR: Record<string, string> = {
        vhot: "دافئ جداً 🔥", warm: "دافئ", lukewarm: "فاتر", cold: "بارد", new: "جديد",
      };
      await sendMessage(
        chatId,
        r.ok
          ? (r.alreadyToday
              ? `ردّ «${r.email}» مسجَّل من قبل اليوم — لا تضخيم.`
              : `🗣 سُجّل ردّ «${r.email}» (${WARMTH_AR[r.warmth] ?? r.warmth} · ${r.score}) — أقوى إشارة، تدخل تحديث الدفء القادم وترفعه لشريحة «الرادّون».`)
          : r.error,
      );
      return NextResponse.json({ ok: true });
    }
    // أمر مائل غير معروف — مع قائمة الأوامر صار الخطأ المطبعي أرجح من فكرةٍ تبدأ
    // بمائل، فلا يُلتقط ضجيجاً في الذاكرة. /مهمة و/task يُعالَجان في توجيه الالتقاط
    // لاحقاً فيُستثنيان (والصوت لا يبدأ بمائل أصلاً).
    if (/^\//.test(text.trim()) && !/^\/(?:مهمة|task)(?:\s|$)/.test(text.trim())) {
      await sendMessage(chatId, "أمر غير معروف — /مساعدة تعرض كل الأوامر.");
      return NextResponse.json({ ok: true });
    }
    // إجابة معلّقة من الطقس (عائق مهمة أو استثناء الغد) → تُستهلك ولا تُلتقَط.
    if (await tryHandlePending(chatId, text)) {
      return NextResponse.json({ ok: true });
    }

    // 4) توجيه الالتقاط (الملف 11 — المرحلة ١).
    //    الصوت دائماً، و/مهمة، وإشارة الالتزام → مسار التفصيل: نداء flash واحد
    //    يفصل الرسالة لعناصر مختلطة (مهام + أفكار) ويوجّه كلاً لجدوله.
    const isVoice = sourceType === "voice";
    const { forced, body } = detectTaskCommand(text);
    if (forced && !body) {
      await sendMessage(chatId, "اكتب المهمة بعد الأمر /مهمة.");
      return NextResponse.json({ ok: true });
    }
    if (isVoice || forced || looksLikeTask(text)) {
      const outcome = await segmentAndProcess(body, { isVoice, sourceUrl, forced });
      await sendMessage(chatId, buildCaptureReply(outcome));
      // اقتراح توثيق قرار (الملف 13 — البند ٢): فحص رخيص على نصّ كل عنصر ملتقط،
      // والاستخراج (pro) بعد الردّ في after() — أول عنصر بإشارة قرار فقط.
      const decItem = outcome.items.find(
        (i) => i.id && i.text && looksLikeDecision(i.text),
      );
      if (decItem?.id && decItem.text) {
        const { id: dId, text: dText } = decItem;
        after(() => suggestDecisionCapture(chatId, dText, dId));
      }
      return NextResponse.json({ ok: true });
    }

    // 5) المسار الرخيص: فكرة مفردة مكتوبة بلا إشارة مهمة → العقل المشترك مباشرة.
    const result = await processIncomingItem(body, sourceType, sourceUrl);
    // صدى الذاكرة (الملف 13 — البند ٦): «تشبه فكرة من…» حين يوجد توأم سابق.
    const similarLine = result.similar
      ? `\n💭 تشبه فكرة من ${result.similar.date}: «${result.similar.snippet}» — تبني عليها؟`
      : "";
    const reply =
      result.classified && result.topic
        ? `تم الحفظ ✅\nالموضوع: ${result.topic}${similarLine}`
        : `تم الحفظ ✅ (حُفظت خاماً بلا تصنيف)${similarLine}`;
    await sendMessage(chatId, reply);
    // اقتراح توثيق قرار على المسار الرخيص أيضاً (بعد الردّ).
    if (looksLikeDecision(body)) {
      const capturedId = result.id;
      after(() => suggestDecisionCapture(chatId, body, capturedId));
    }
  } catch (e) {
    console.error("[telegram webhook]", e); // يظهر في سجلات Vercel للتصحيح
    try {
      await sendMessage(
        chatId,
        "حدث خطأ أثناء المعالجة: " +
          (e instanceof Error ? e.message : "غير معروف"),
      );
    } catch {
      // تجاهل فشل إرسال رسالة الخطأ
    }
  }

  return NextResponse.json({ ok: true });
}

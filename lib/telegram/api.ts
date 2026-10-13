import "server-only";

// نداءات HTTP مباشرة لـ Telegram Bot API — بلا مكتبات بوت ثقيلة (روح الدستور).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = "https://api.telegram.org";

function botBase(): string {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN غير مضبوط");
  return `${API}/bot${TOKEN}`;
}

// زرّ inline واحد (نص ظاهر + حمولة callback ≤ 64 بايت).
export type InlineButton = { text: string; callback_data: string };
// لوحة أزرار inline: مصفوفة صفوف، كل صفّ مصفوفة أزرار.
export type InlineKeyboard = InlineButton[][];

/** يرسل رسالة نصية (مع لوحة أزرار اختيارية) ويُرجع message_id عند النجاح (للتثبيت/التحرير). */
export async function sendMessage(
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<number | undefined> {
  const res = await fetch(`${botBase()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("فشل إرسال رسالة تيليجرام: " + res.status + " " + detail);
    return undefined;
  }
  const data = (await res.json().catch(() => null)) as
    | { result?: { message_id?: number } }
    | null;
  return data?.result?.message_id;
}

/** يحرّر نصّ رسالة قائمة (ولوحتها) — لتحديث مراجعة الطقس بنقرة دون رسائل جديدة. */
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const res = await fetch(`${botBase()}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("فشل تحرير رسالة تيليجرام: " + res.status + " " + detail);
  }
}

/** يجيب استعلام الزرّ (يوقف مؤشّر التحميل) مع تلميح اختياري سريع. */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await fetch(`${botBase()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }),
  }).catch(() => {
    // إجابة الاستعلام غير حرجة — تجاهل فشلها
  });
}

/** يثبّت رسالة في المحادثة (خطة الصباح تبقى أعلى المحادثة ليجدها صباحاً). */
export async function pinChatMessage(
  chatId: number | string,
  messageId: number,
): Promise<void> {
  await fetch(`${botBase()}/pinChatMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    }),
  }).catch(() => {
    // التثبيت غير حرج — تجاهل فشله
  });
}

// يقسّم نصّاً على حدّ تيليجرام (4096) مفضّلاً الكسر عند فقرة ثمّ سطر ثمّ مسافة، وإلا قصّ صلب.
function splitForTelegram(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit; // لا فاصل مناسب → قصّ صلب
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** يرسل نصاً قد يتجاوز حدّ تيليجرام (4096) مقسّماً إلى رسائل متتابعة. للردود الطويلة
 *  كتحليل المقال. يُرجع message_id للرسالة الأولى (رأس السلسلة — هي ما يُثبَّت). */
export async function sendLongMessage(
  chatId: number | string,
  text: string,
): Promise<number | undefined> {
  const chunks = splitForTelegram(text, 3900); // هامش آمن تحت 4096
  let firstId: number | undefined;
  for (const chunk of chunks) {
    const id = await sendMessage(chatId, chunk);
    if (firstId === undefined) firstId = id;
  }
  return firstId;
}

/** ينزّل ملفاً من تيليجرام (getFile ثم التنزيل) ويُرجعه base64. */
export async function downloadFileBase64(fileId: string): Promise<string> {
  const gfRes = await fetch(
    `${botBase()}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const gf = (await gfRes.json()) as { result?: { file_path?: string } };
  const filePath = gf.result?.file_path;
  if (!filePath) throw new Error("تعذّر الحصول على مسار الملف من تيليجرام");

  const dl = await fetch(`${API}/file/bot${TOKEN}/${filePath}`);
  if (!dl.ok) throw new Error("تعذّر تنزيل الملف من تيليجرام");
  const buf = Buffer.from(await dl.arrayBuffer());
  return buf.toString("base64");
}

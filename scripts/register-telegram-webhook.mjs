// تسجيل webhook تيليجرام — يُشغَّل مرة واحدة بعد النشر (وعند تغيّر النطاق أو السرّ).
// التشغيل (يقرأ المتغيّرات من .env.local عبر Node 20.6+):
//   node --env-file=.env.local scripts/register-telegram-webhook.mjs https://your-app.vercel.app
// يطبع نتيجة setWebhook ثم getWebhookInfo للتحقّق.

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const domain = process.argv[2] || process.env.PUBLIC_BASE_URL;

if (!token || !secret || !domain) {
  console.error(
    "مطلوب: TELEGRAM_BOT_TOKEN و TELEGRAM_WEBHOOK_SECRET (من البيئة) + النطاق كوسيط أول.\n" +
      "مثال: node --env-file=.env.local scripts/register-telegram-webhook.mjs https://your-app.vercel.app",
  );
  process.exit(1);
}

const webhookUrl = `${domain.replace(/\/+$/, "")}/api/telegram/webhook`;

const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    // message: الالتقاط · callback_query: أزرار الطقس المسائي (الملف 11 — المرحلة ٢)
    allowed_updates: ["message", "callback_query"],
  }),
});
console.log("setWebhook:", JSON.stringify(await setRes.json(), null, 2));

const infoRes = await fetch(
  `https://api.telegram.org/bot${token}/getWebhookInfo`,
);
console.log("getWebhookInfo:", JSON.stringify(await infoRes.json(), null, 2));

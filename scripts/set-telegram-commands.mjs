// تسجيل قائمة أوامر البوت (تظهر عند كتابة «/» في تيليجرام) — يُشغَّل مرة واحدة
// وعند كل تغيير في الأوامر (الملف 15).
// قيد منصة تيليجرام: اسم الأمر لاتيني صغير فقط [a-z0-9_] (لا عربية) — لذلك الأسماء
// هنا مرادفات لاتينية والوصف عربي، والأوامر العربية تبقى تعمل نصياً كما هي.
// التشغيل (يقرأ المتغيّرات من .env.local عبر Node 20.6+):
//   node --env-file=.env.local scripts/set-telegram-commands.mjs

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(
    "مطلوب TELEGRAM_BOT_TOKEN في البيئة.\n" +
      "مثال: node --env-file=.env.local scripts/set-telegram-commands.mjs",
  );
  process.exit(1);
}

// الترتيب = ترتيب الظهور في القائمة: الأكثر استخداماً أولاً.
const commands = [
  { command: "ask", description: "اسأل عقلك الثاني — يعادل /اسأل" },
  { command: "drafts", description: "المسودات: نصّ للنسخ · وسم النشر · حذف — /مسودات" },
  { command: "plan", description: "عرض خطة اليوم — /خطة" },
  { command: "done", description: "علّم مهمة أُنجزت — /تم" },
  { command: "evening", description: "طقس المساء الآن — /مساء" },
  { command: "journal", description: "مسودة مذكرة الأسبوع — /مذكرة" },
  { command: "patterns", description: "تقرير أنماط الإنجاز — /أنماط" },
  { command: "reply", description: "سجّل ردّ مشترك على بريدك (أقوى إشارة شراء) — /رد" },
  { command: "task", description: "التقاط مهمة صريحة — /مهمة" },
  { command: "article", description: "تحليل مقال — أو أرسل ملف .txt" },
  { command: "help", description: "كل الأوامر بالعربية — /مساعدة" },
];

const setRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands }),
});
console.log("setMyCommands:", JSON.stringify(await setRes.json(), null, 2));

const check = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`);
console.log("getMyCommands:", JSON.stringify(await check.json(), null, 2));

// ════════════════════════════════════════════════════════════
// هوية المالك وتوقيته — مصدر حقيقة واحد لكل نصّ يذكر صاحب العقل.
// النظام لمستخدم واحد؛ اسمه ومنطقته الزمنية يأتيان من البيئة لا من الكود،
// كي يركّب أي شخص نسخته دون تعديل البرومبتات أو منطق التواريخ.
// متاح للخادم والعامل معاً (لا "server-only") لأن العامل يستورده أيضاً.
// ════════════════════════════════════════════════════════════

/** اسم المالك كما يظهر في البرومبتات ورسائل البوت. */
export const OWNER_NAME = process.env.OWNER_NAME?.trim() || "المالك";

/** المنطقة الزمنية IANA لحساب «اليوم» في الطقوس والخطط (مثال: Asia/Riyadh). */
export const OWNER_TZ = process.env.OWNER_TIMEZONE?.trim() || "Asia/Riyadh";

/** إزاحة المنطقة الحالية بصيغة ±HH:MM — لبناء طوابع ISO عند منتصف يوم محلي. */
export function ownerTzOffset(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "+00:00";
}

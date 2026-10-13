import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

// Next.js 16: ملف الـ middleware أُعيد تسميته إلى proxy.ts.
// الدالة تُصدَّر باسم proxy، والإعداد باسم config (وفق توثيق Next 16.2.6 المثبَّت).
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // كل المسارات عدا: webhooks (تيليجرام بسرّ، لوبس بتوقيع HMAC) و cron (بسرّ)
    // و embed (بسرّ الكرون — خدمة تضمين لعامل الـVPS المحجوب جغرافياً عن Gemini)،
    // وملفات Next الثابتة والصور
    "/((?!api/telegram|api/cron|api/loops|api/embed|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

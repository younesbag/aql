import { NextResponse } from "next/server";
import { startEveningRitual } from "@/lib/dayplan/ritual";

// طقس المساء المجدول (الملف 11 — المرحلة ٢). Vercel Cron يستدعيه GET بترويسة
// Authorization: Bearer ${CRON_SECRET}. التوقيت في vercel.json (~٢٢:٠٠ بتوقيت المالك).
export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;
const CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID;

function authorized(req: Request): boolean {
  return !!CRON_SECRET && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (!CHAT_ID) {
    return NextResponse.json({ ok: false, error: "TELEGRAM_ALLOWED_CHAT_ID غير مضبوط" });
  }
  try {
    await startEveningRitual(CHAT_ID);
  } catch (e) {
    console.error("[cron evening]", e);
    return NextResponse.json({ ok: false });
  }
  return NextResponse.json({ ok: true });
}

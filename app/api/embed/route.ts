import { NextResponse } from "next/server";
import { embed } from "@/lib/ai/gemini";

// خدمة تضمين لعامل الـVPS (الملف 39 — الترقية ج): خادم العامل محجوب جغرافياً
// عن Gemini API («User location is not supported» — مقيس 2026-08-16)، بينما
// منطقة Vercel مدعومة. المسار محمي بسرّ الكرون نفسه، ويمرّر عبر embed()
// النظام (gemini-embedding-001، 768 بُعداً مطبَّعة) فلا انحراف نموذج أبداً.
export const runtime = "nodejs";
export const maxDuration = 30;

// السر المشترك: مفتاح خدمة Supabase. المقارنة النصية لا تكفي — بيئة Vercel
// وبيئة العامل قد تحملان صيغتين مختلفتين صالحتين لنفس المشروع (مقيس 2026-08-16:
// مفتاح محلي 219 حرفاً صالح للإدارة رُفض نصياً). فالتحقق وظيفي: المفتاح
// المقدَّم يُختبر ضد مسار admin في Supabase — لا يفتحه إلا مفتاح خدمة حقيقي
// (anon يُرفض 401/403). المطابقة النصية تبقى مساراً سريعاً يوفّر النداء.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

async function isServiceKey(presented: string): Promise<boolean> {
  if (!SUPABASE_URL || presented.length < 30) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: presented, authorization: `Bearer ${presented}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const fastPath = [SERVICE_KEY, CRON_SECRET].filter(Boolean).some((s) => presented === s);
  if (!fastPath && !(presented && (await isServiceKey(presented)))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  let text = "";
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    /* يسقط للحارس التالي */
  }
  if (!text || text.length > 4000) {
    return NextResponse.json({ ok: false, error: "نص التضمين مفقود أو أطول من 4000 حرف" }, { status: 400 });
  }
  const r = await embed(text);
  if (!r.ok) {
    console.error("[embed api]", r.error);
    return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, values: r.data });
}

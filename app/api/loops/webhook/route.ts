import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyLoopsSignature, parseLoopsEvent } from "@/lib/loops/webhook";

// حلقة الأداء البريدية (الملف 33): لوبس يبثّ email.opened/clicked/delivered…
// بمعرّف الحملة وهوية المستلم — وهذا ما لا يتيحه API القراءة (404 مقيس).
// النقطة تتحقق من التوقيع (Standard Webhooks) وتخزّن الحدث خاماً بمنع تكرار.
// خارج مطابق proxy (تحمي نفسها بالتوقيع كما يحمي webhook تيليجرام نفسه بالسرّ).
export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.LOOPS_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // فشل إعداد لا فشل طلب: نرفض بصوت عالٍ كي لا تُقبل أحداث بلا تحقق أبداً
    console.error("[loops-webhook] LOOPS_WEBHOOK_SECRET غير مضبوط — رفض كل الأحداث");
    return NextResponse.json({ ok: false, error: "webhook غير مهيأ" }, { status: 503 });
  }

  // الجسم الخام أولاً: التوقيع محسوب على البايتات كما وصلت، قبل أي تفكيك
  const rawBody = await request.text();
  const webhookId = request.headers.get("webhook-id") ?? "";
  const webhookTimestamp = request.headers.get("webhook-timestamp") ?? "";
  const signature = request.headers.get("webhook-signature") ?? "";

  const v = verifyLoopsSignature(secret, webhookId, webhookTimestamp, rawBody, signature);
  if (!v.ok) {
    console.error(`[loops-webhook] توقيع مرفوض: ${v.reason}`);
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    console.error("[loops-webhook] جسم ليس JSON صالحاً");
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ev = parseLoopsEvent(payload);
  if (!ev) {
    // حدث بلا eventName — نقبله بصمت (200) كي لا يعيد لوبس إرساله للأبد،
    // لكن نرصده: قد يكون شكل حمولة جديداً يستحق تحديث المفكّك.
    console.error("[loops-webhook] حمولة بلا eventName:", rawBody.slice(0, 200));
    return NextResponse.json({ ok: true, skipped: true });
  }

  // مفتاح منع التكرار: Webhook-Id ثابت عبر إعادات الإرسال — واحتياطه تجزئة الجسم
  const eventId = webhookId || createHash("sha256").update(rawBody).digest("hex");

  const supabase = createAdminClient();
  const { error } = await supabase.from("email_events").upsert(
    {
      event_id: eventId,
      event_name: ev.eventName,
      occurred_at: ev.occurredAt,
      source_type: ev.sourceType,
      campaign_id: ev.campaignId,
      loop_id: ev.loopId,
      transactional_id: ev.transactionalId,
      email_message_id: ev.emailMessageId,
      subject: ev.subject,
      contact_email: ev.contactEmail,
      payload,
    },
    { onConflict: "event_id", ignoreDuplicates: true },
  );
  if (error) {
    // فشل تخزين = 500 كي يعيد لوبس المحاولة (الحدث لم يُحفظ فلا نبتلعه)
    console.error("[loops-webhook] فشل التخزين:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// أي فعل آخر مرفوض صراحةً
export function GET() {
  return NextResponse.json({ ok: false }, { status: 405 });
}

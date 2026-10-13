import { createHmac, timingSafeEqual } from "node:crypto";

// ════════════════════════════════════════════════════════════
// تحقق وتفكيك webhook لوبس (الملف 33) — وحدة نقية بلا Supabase ولا Next،
// كي تُفحص دوالها مباشرة بعيداً عن الخادم (نفس نمط prompt-builder).
//
// المواصفة: Standard Webhooks — ترويسات webhook-id/-timestamp/-signature،
// والتوقيع HMAC-SHA256 على `${id}.${timestamp}.${الجسم الخام}` بالسرّ بعد فكّ
// base64 (يصل بصيغة whsec_<base64>). الترويسة قد تحمل توقيعات عدّة مفصولة
// بمسافات («v1,سعة v1,أخرى») — يكفي تطابق واحد.
// ════════════════════════════════════════════════════════════

/** سماحية الطابع الزمني: يردّ إعادةَ البثّ (replay) دون رفض إعادات الإرسال المشروعة. */
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyLoopsSignature(
  secret: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: string,
  signatureHeader: string,
  nowMs = Date.now(),
): VerifyResult {
  if (!secret.trim()) return { ok: false, reason: "السرّ فارغ" };
  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return { ok: false, reason: "ترويسات التوقيع ناقصة" };
  }

  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "طابع زمني غير صالح" };
  if (Math.abs(nowMs / 1000 - ts) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, reason: "طابع زمني خارج السماحية (إعادة بثّ محتملة)" };
  }

  // السرّ: whsec_<base64> — وقبول الصيغة الخام احتياطاً لو سلّمته اللوحة بلا بادئة
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "base64");
  if (key.length === 0) return { ok: false, reason: "تعذّر فكّ السرّ" };

  const expected = createHmac("sha256", key)
    .update(`${webhookId}.${webhookTimestamp}.${rawBody}`)
    .digest();

  // الترويسة قائمة "v1,<base64>" مفصولة بمسافات — مقارنة ثابتة الزمن لكل مرشّح
  for (const part of signatureHeader.split(/\s+/)) {
    const sig = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "التوقيع لا يطابق" };
}

// ── تفكيك الحمولة (الشكل الموثّق: eventName/eventTime/sourceType/campaignId/
//    loopId/email{emailMessageId,subject}/contactIdentity{email}) ──
export type LoopsEvent = {
  eventName: string;
  occurredAt: string | null; // ISO من eventTime (ثوانٍ منذ الحقبة)
  sourceType: string | null;
  campaignId: string | null;
  loopId: string | null;
  transactionalId: string | null;
  emailMessageId: string | null;
  subject: string | null;
  contactEmail: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/** تفكيك متسامح: الحقول المفقودة تصير null — والحمولة الكاملة تُخزَّن خاماً على كل حال. */
export function parseLoopsEvent(payload: Record<string, unknown>): LoopsEvent | null {
  const eventName = str(payload.eventName);
  if (!eventName) return null;

  const email = (payload.email ?? {}) as Record<string, unknown>;
  const contact = (payload.contactIdentity ?? {}) as Record<string, unknown>;

  const t = payload.eventTime;
  const occurredAt =
    typeof t === "number" && Number.isFinite(t) && t > 0
      ? new Date(t * 1000).toISOString()
      : null;

  return {
    eventName,
    occurredAt,
    sourceType: str(payload.sourceType),
    campaignId: str(payload.campaignId),
    loopId: str(payload.loopId),
    transactionalId: str(payload.transactionalId),
    emailMessageId: str(email.emailMessageId) ?? str(email.id),
    subject: str(email.subject),
    contactEmail: str(contact.email),
  };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// ════════════════════════════════════════════════════════════
// التقاط الردود (الملف 37 — بأمر المالك 2026-08-16).
//
// الرد أقوى إشارة شراء في النظام كله، وwebhook لوبس لا يبثه (قيد منصة).
// المدخل: أمر تيليجرام «/رد بريد@فلان [ملاحظة]» لحظة قراءة المالك بريده —
// يُسجَّل حدثاً اصطناعياً email.replied في نفس نهر email_events، فيلتقطه
// تحديث الدفء الأسبوعي كأي حدث: الرد يعادل نقرتين في عامل التفاعل ويحدّث
// آخر نشاط، ويرفع خاصيتي replies/replier في لوبس (شريحة «الرادّون 🗣»).
// ════════════════════════════════════════════════════════════

export type RecordReplyResult =
  | {
      ok: true;
      email: string;
      warmth: string;
      score: number;
      totalReplies: number;
      alreadyToday: boolean;
    }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** يسجّل ردّ مشترك — بمنع تكرار يومي (نفس البريد في نفس اليوم = حدث واحد). */
export async function recordReply(rawEmail: string, note: string): Promise<RecordReplyResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "بريد غير صالح — الصيغة: /رد بريد@مثال.كوم ملاحظة اختيارية" };
  }

  const admin = createAdminClient();
  // الجهة يجب أن تكون معروفة في نظام الدفء — حارس ضد أخطاء النسخ
  const { data: contact } = await admin
    .from("email_warmth")
    .select("warmth, score, replied")
    .eq("email", email)
    .maybeSingle();
  if (!contact) {
    return {
      ok: false,
      error: `«${email}» غير موجود في نظام الدفء — تأكد من البريد (الحروف الصغيرة لا تفرق).`,
    };
  }

  // منع التكرار اليومي عبر event_id الفريد — إعادة الأمر في نفس اليوم لا تضخّم
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await admin.from("email_events").insert({
    event_id: `reply-${email}-${day}`,
    event_name: "email.replied",
    occurred_at: new Date().toISOString(),
    source_type: "manual",
    contact_email: email,
    payload: { source: "telegram:/رد", note: note.trim() || null },
  });
  const alreadyToday = Boolean(error && /duplicate|unique/i.test(error.message));
  if (error && !alreadyToday) {
    return { ok: false, error: "تعذّر تسجيل الرد: " + error.message };
  }

  return {
    ok: true,
    email,
    warmth: String(contact.warmth),
    score: Number(contact.score),
    totalReplies: Number(contact.replied) + (alreadyToday ? 0 : 1),
    alreadyToday,
  };
}

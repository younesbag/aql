import type { SupabaseClient } from "@supabase/supabase-js";
import { OWNER_NAME } from "../lib/config/owner.ts";

// ════════════════════════════════════════════════════════════
// النشر الكامل إلى لوبس (الملف 35) — يجري على عامل الـVPS (المفتاح في بيئته).
//
// المسار (مواصفة حية مستخرجة من API لوبس — scratchpad/lmx-spec.md):
//   ١) إنشاء حملة (name + جمهور) ← campaignId + emailMessageId + revisionId
//   ٢) تحويل النص العربي الخام إلى LMX (فقرات align="right" + <Br/> داخلية)
//   ٣) حقن المحتوى (subject/preview/lmx + expectedRevisionId — تجاهله = 409)
//   ٤) فحص Guardian — أخطاؤه تمنع الجدولة ولا تمنع بقاء الحملة مسودةً
//   ٥) معاينة اختيارية لبريد المالك
//   ٦) جدولة اختيارية: {method:"schedule", timestamp:"<ISO>"} نصاً مباشراً
//      (مقيس من ٣٣ حملة حية — لا غلاف data ولا epoch)
// قاعدة أمان: لا method:"now" أبداً — مسودة أو جدولة صريحة فقط.
// ════════════════════════════════════════════════════════════

const LOOPS_BASE = "https://app.loops.so/api/v1";

// قالب <Style/> القالب الافتراضي لمحرّر لوبس — ثابت
const STYLE_TAG =
  '<Style backgroundColor="" backgroundXPadding="0" backgroundYPadding="0" bodyColor="" bodyXPadding="0" bodyYPadding="0" bodyFontFamily="Default" bodyFontCategory="sans-serif" borderColor="" borderWidth="0" borderRadius="4" buttonBodyColor="" buttonBodyXPadding="16" buttonBodyYPadding="12" buttonBorderColor="" buttonBorderWidth="0" buttonBorderRadius="4" buttonTextColor="" buttonTextFormat="0" buttonTextFontSize="16" dividerColor="" dividerBorderWidth="1" textBaseColor="" textBaseFontSize="14" textBaseLineHeight="150" textBaseLetterSpacing="0" textLinkColor="" heading1Color="" heading1FontSize="28" heading1LineHeight="125" heading1LetterSpacing="0" heading2Color="" heading2FontSize="24" heading2LineHeight="125" heading2LetterSpacing="0" heading3Color="" heading3FontSize="20" heading3LineHeight="125" heading3LetterSpacing="0" />';

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** نص عربي خام (فقرات بسطر فارغ، وأسطر داخلية بسطر واحد) → LMX صالح. */
export function arabicTextToLmx(body: string): string {
  const paragraphs = body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const parts: string[] = [STYLE_TAG];
  paragraphs.forEach((p, i) => {
    // أسطر داخل الفقرة الواحدة (كتوقيع من سطرين: الاسم / الجهة) → <Br /> لا فقرتين
    const inner = p.split("\n").map((l) => escapeXml(l.trim())).join("<Br /> ");
    parts.push(`<Paragraph fontSize="17" align="right">${inner}</Paragraph>`);
    if (i < paragraphs.length - 1)
      parts.push('<Paragraph fontSize="17" align="right"></Paragraph>');
  });
  return parts.join("\n");
}

type PublishPayload = {
  subject: string;
  preview_text: string | null;
  body: string;
  audience: { type: "all" | "segment" | "list"; id: string | null; label: string };
  schedule_at: string | null;
  preview_to: string | null;
  purpose: string | null;
  newsletter_id: string | null;
};

export type PublishResult = {
  campaignId: string;
  emailMessageId: string;
  url: string;
  scheduled: boolean;
  previewSent: boolean;
  guardianErrors: string[];
  guardianWarnings: string[];
};

async function loopsCall(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${LOOPS_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

export async function runLoopsPublish(
  db: SupabaseClient,
  opts: { loopsKey: string; payload: PublishPayload; log: (m: string) => void },
): Promise<PublishResult> {
  const { loopsKey: key, payload: p, log } = opts;

  // هوية المرسل من بيئة العامل حصراً — لا قيم افتراضية شخصية. نتحقق قبل إنشاء
  // الحملة كي لا تُترك حملة يتيمة في لوبس إن غابت القيم.
  const fromEmail = (process.env.LOOPS_FROM_EMAIL ?? "").trim();
  const fromName = (process.env.LOOPS_FROM_NAME ?? "").trim();
  const replyToEmail = (process.env.LOOPS_REPLY_TO ?? "").trim();
  if (!fromEmail || !fromName) {
    throw new Error(
      "هوية المرسل غير مضبوطة في بيئة العامل: عيّن LOOPS_FROM_EMAIL (الجزء قبل @ فقط) وLOOPS_FROM_NAME في worker/.env.worker، وLOOPS_REPLY_TO اختيارياً.",
    );
  }

  // ── ١) إنشاء الحملة بجمهورها ──
  const createBody: Record<string, unknown> = { name: p.subject };
  if (p.audience.type === "segment" && p.audience.id) createBody.audienceSegmentId = p.audience.id;
  if (p.audience.type === "list" && p.audience.id) createBody.mailingListId = p.audience.id;
  // النوع "all": لا حقل جمهور — لوبس يستهدف كامل الجمهور المشترك (يُثبَّت بالفحص الحي)
  const created = await loopsCall(key, "POST", "/campaigns", createBody);
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`إنشاء الحملة رُفض (${created.status}): ${JSON.stringify(created.json).slice(0, 200)}`);
  }
  const campaignId = String(created.json.id ?? "");
  const emailMessageId = String(created.json.emailMessageId ?? "");
  let revisionId = String(created.json.emailMessageContentRevisionId ?? "");
  if (!campaignId || !emailMessageId) {
    throw new Error("استجابة الإنشاء بلا معرّفات: " + JSON.stringify(created.json).slice(0, 200));
  }
  log(`أُنشئت الحملة ${campaignId} — يحقن المحتوى…`);

  // ── ٢+٣) المحتوى: LMX + عنوان + معاينة + مرسل (هوية المرسل من بيئة العامل) ──
  const lmx = arabicTextToLmx(p.body);
  const updateBody: Record<string, unknown> = {
    subject: p.subject,
    lmx,
    fromEmail,
    fromName,
    ...(replyToEmail ? { replyToEmail } : {}),
    expectedRevisionId: revisionId,
  };
  if (p.preview_text) updateBody.previewText = p.preview_text;
  const updated = await loopsCall(key, "POST", `/email-messages/${emailMessageId}`, updateBody);
  if (updated.status !== 200) {
    throw new Error(`حقن المحتوى رُفض (${updated.status}): ${JSON.stringify(updated.json).slice(0, 300)}`);
  }
  revisionId = String(updated.json.contentRevisionId ?? revisionId);

  // ── ٤) Guardian: الأخطاء تمنع الجدولة (الحملة تبقى مسودة تُصلَح من اللوحة) ──
  const guard = await loopsCall(key, "GET", `/email-messages/${emailMessageId}/guardian`);
  const gErr = Array.isArray(guard.json.errors)
    ? (guard.json.errors as Record<string, unknown>[]).map((e) => String(e.title ?? e.rule ?? "خطأ"))
    : [];
  const gWarn = Array.isArray(guard.json.warnings)
    ? (guard.json.warnings as Record<string, unknown>[]).map((e) => String(e.title ?? e.rule ?? "تحذير"))
    : [];

  // ── ٥) معاينة اختيارية لبريد المالك قبل أي جدولة ──
  let previewSent = false;
  if (p.preview_to) {
    const prev = await loopsCall(key, "POST", `/email-messages/${emailMessageId}/preview`, {
      emails: [p.preview_to],
      contactProperties: { firstName: OWNER_NAME },
    });
    previewSent = prev.status === 200;
    if (!previewSent) log(`تعذّرت المعاينة (${prev.status}) — لا يوقف النشر`);
  }

  // ── ٦) الجدولة — فقط إن طلبها المالك صراحةً وGuardian نظيف ──
  // قيد مقيس (2026-08-16): API لوبس العام يكتب حقل scheduling لكنه لا «يسلّح» الحملة —
  // حالتها تبقى Draft ولا يوجد مسار تسليح في الـAPI؛ التسليح زر «Schedule send» في اللوحة
  // حصراً. لذا الحكم بالحالة الحقيقية (Scheduled) بعد الكتابة، لا برمز 200 وحده.
  let scheduled = false;
  if (p.schedule_at && gErr.length === 0) {
    const sched = await loopsCall(key, "POST", `/campaigns/${campaignId}`, {
      scheduling: { method: "schedule", timestamp: new Date(p.schedule_at).toISOString() },
    });
    if (sched.status !== 200) {
      log(`الجدولة رُفضت (${sched.status}): ${JSON.stringify(sched.json).slice(0, 200)}`);
      gWarn.push("الحملة أُنشئت مسودةً لكن الجدولة رُفضت — جدولها من لوحة لوبس");
    } else {
      const after = await loopsCall(key, "GET", `/campaigns/${campaignId}`);
      scheduled = String(after.json.status ?? "") === "Scheduled";
      if (!scheduled) {
        log(`وقت الجدولة كُتب لكن الحالة بقيت ${String(after.json.status ?? "؟")} — التسليح من اللوحة`);
        gWarn.push(
          "وقت الإرسال كُتب لكن الحملة غير مسلّحة (Draft) — افتح الحملة في لوحة لوبس واضغط «Schedule send» لتفعيل الإرسال",
        );
      }
    }
  } else if (p.schedule_at && gErr.length > 0) {
    gWarn.push("أُلغيت الجدولة لوجود أخطاء Guardian — أصلحها في لوحة لوبس ثم جدول يدوياً");
  }

  // ── ٧) السجلّ المحلي: غرض الحملة وجمهورها — وقود العدّ البيعي الحي والتحليل الموسوم ──
  await db.from("loops_campaigns").insert({
    campaign_id: campaignId,
    email_message_id: emailMessageId,
    subject: p.subject,
    purpose: p.purpose,
    audience_label: p.audience.label,
    newsletter_id: p.newsletter_id,
    scheduled_at: scheduled ? p.schedule_at : null,
  });
  if (p.newsletter_id) {
    await db
      .from("newsletters")
      .update({ loops_campaign_id: campaignId, updated_at: new Date().toISOString() })
      .eq("id", p.newsletter_id);
  }

  return {
    campaignId,
    emailMessageId,
    url: `https://app.loops.so/campaigns/${campaignId}/compose`,
    scheduled,
    previewSent,
    guardianErrors: gErr,
    guardianWarnings: gWarn,
  };
}

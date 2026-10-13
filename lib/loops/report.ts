import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessage } from "@/lib/telegram/api";
import { PURPOSE_AR } from "@/lib/newsletter/criteria";

// ════════════════════════════════════════════════════════════
// حلقة الحكم (الملف 36 — بأمر المالك 2026-08-16).
//
// كل حملة تُحاكم بأرقامها الفعلية بعد ٤٨ ساعة من أول حدث لها:
//   أحداث webhook (الملف 33) ← منظور campaign_email_stats ← تقرير تيليجرام
//   + لقطة مجمّدة في loops_campaigns.report (لقطة الـ٤٨ ساعة لا تُعاد لاحقاً —
//   الفتح يتراكم بعدها، والتجميد شرط المقارنة العادلة بين الحملات).
//
// والحملات المرسلة يدوياً من لوحة لوبس تدخل الحلقة أيضاً: تُكتشف من أحداثها
// وتُسجَّل source='discovered' — فالحلقة تغطي كل ما يُرسَل لا ما نشره النظام فقط.
// البوابة تركب على كرون الصباح اليومي (نمط الحصاد والدفء — لا كرون جديد).
// ════════════════════════════════════════════════════════════

const REPORT_AFTER_HOURS = 40; // أول كرون صباح بعد يومين من الإرسال (~48 ساعة فعلياً)
const MAX_REPORTS_PER_RUN = 3;

type Admin = ReturnType<typeof createAdminClient>;

type StatsRow = {
  campaign_id: string;
  sent: number;
  delivered: number;
  unique_opens: number;
  total_opens: number;
  unique_clicks: number;
  total_clicks: number;
  bounces: number;
  unsubscribes: number;
  first_event_at: string;
  last_event_at: string;
};

export type CampaignReport = {
  delivered: number;
  uniqueOpens: number;
  openRate: number; // نسبة مئوية بمنزلة واحدة
  uniqueClicks: number;
  clickRate: number;
  unsubscribes: number;
  bounces: number;
  hoursSinceFirstEvent: number;
  measuredAt: string;
};

/** الحملات المرسلة خارج النظام (يدوياً من لوحة لوبس) تُكتشف من أحداثها وتُسجَّل. */
export async function discoverExternalCampaigns(admin: Admin): Promise<number> {
  const { data: stats } = await admin.from("campaign_email_stats").select("campaign_id");
  const { data: known } = await admin.from("loops_campaigns").select("campaign_id");
  const knownSet = new Set((known ?? []).map((k) => String(k.campaign_id)));
  let inserted = 0;
  for (const s of stats ?? []) {
    const cid = String(s.campaign_id);
    if (knownSet.has(cid)) continue;
    // العنوان من أحدث حدث يحمله — الحملة اليدوية لا صفّ لها عندنا سوى أحداثها
    const { data: ev } = await admin
      .from("email_events")
      .select("subject")
      .eq("campaign_id", cid)
      .not("subject", "is", null)
      .order("received_at", { ascending: false })
      .limit(1);
    const subject = (ev?.[0]?.subject as string | null)?.trim() || "(حملة بلا عنوان مرصود)";
    const { error } = await admin.from("loops_campaigns").insert({
      campaign_id: cid,
      subject,
      source: "discovered",
      audience_label: "أُرسلت من لوحة لوبس",
    });
    if (!error) inserted++;
    else console.error("[report discover]", error.message);
  }
  return inserted;
}

const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

function buildReport(s: StatsRow, now: number): CampaignReport {
  // القاعدة المستلمة: delivered إن وُجد وإلا sent — بعض الحملات تبثّ أحدهما فقط
  const delivered = s.delivered > 0 ? s.delivered : s.sent;
  return {
    delivered,
    uniqueOpens: s.unique_opens,
    openRate: pct(s.unique_opens, delivered),
    uniqueClicks: s.unique_clicks,
    clickRate: pct(s.unique_clicks, delivered),
    unsubscribes: s.unsubscribes,
    bounces: s.bounces,
    hoursSinceFirstEvent: Math.round((now - new Date(s.first_event_at).getTime()) / 3_600_000),
    measuredAt: new Date(now).toISOString(),
  };
}

/** وسيط أعداد — لمقارنة الحملة بوسيط سوابقها لا بمتوسط تشوّهه القيم الشاذة. */
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function reportMessage(
  subject: string,
  purpose: string | null,
  audienceLabel: string | null,
  r: CampaignReport,
  priorOpenRates: number[],
): string {
  const lines = [
    `📊 تقرير الـ48 ساعة — «${subject}»`,
    `${audienceLabel ? `الجمهور: ${audienceLabel}` : ""}${purpose && PURPOSE_AR[purpose] ? ` · الغرض: ${PURPOSE_AR[purpose].split("—")[0].trim()}` : ""}`.trim(),
    ``,
    `• التسليم: ${r.delivered}`,
    `• فتح فريد: ${r.uniqueOpens} (${r.openRate}%)`,
    `• نقر فريد: ${r.uniqueClicks} (${r.clickRate}%)`,
    ...(r.unsubscribes ? [`• إلغاء اشتراك: ${r.unsubscribes}`] : []),
    ...(r.bounces ? [`• ارتداد: ${r.bounces}`] : []),
  ];
  // محاكمة قاعدة العنوان (البصمة: العنوان نقطة الرفض الأولى) بوسيط السوابق
  const med = median(priorOpenRates);
  if (med !== null) {
    const diff = Math.round((r.openRate - med) * 10) / 10;
    lines.push(
      ``,
      diff >= 0
        ? `⚖️ العنوان أدّى: فتح أعلى من وسيط حملاتك المقيسة (${med}%) بـ${diff} نقطة.`
        : `⚖️ العنوان دون المعتاد: أدنى من وسيط حملاتك المقيسة (${med}%) بـ${Math.abs(diff)} نقطة — راجع صياغته بقاعدة «يقدر يتجاهله ويكمل يومه؟».`,
    );
  } else {
    lines.push(``, `⚖️ أول حملة مقيسة — تصير خطّ الأساس لمحاكمة ما بعدها.`);
  }
  return lines.filter((l, i) => l !== "" || i > 0).join("\n");
}

/**
 * يرسل تقارير الحملات التي بلغت نافذة الحكم ولم تُقرَّر بعد.
 * اللقطة تُجمَّد في report ولا تُحدَّث — والأحداث الخام تبقى مرجع أي تحليل أعمق.
 */
export async function sendDueCampaignReports(
  admin: Admin,
  opts: { minHours?: number; dryRun?: boolean } = {},
): Promise<{ sent: number; skipped: number; closedPartial: number }> {
  const minHours = opts.minHours ?? REPORT_AFTER_HOURS;
  const now = Date.now();
  const chatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (!chatId) {
    console.error("[report] TELEGRAM_ALLOWED_CHAT_ID غير مضبوط — لا تقارير");
    return { sent: 0, skipped: 0, closedPartial: 0 };
  }

  const [{ data: stats }, { data: pending }, { data: judged }] = await Promise.all([
    admin.from("campaign_email_stats").select("*"),
    admin
      .from("loops_campaigns")
      .select("id, campaign_id, subject, purpose, audience_label")
      .is("report_sent_at", null),
    admin.from("loops_campaigns").select("report").not("report", "is", null),
  ]);
  const statsBy = new Map((stats ?? []).map((s) => [String(s.campaign_id), s as StatsRow]));
  const priorOpenRates = (judged ?? [])
    .filter((j) => (j.report as Record<string, unknown> | null)?.partial !== true)
    .map((j) => Number((j.report as Record<string, unknown> | null)?.openRate))
    .filter((n) => Number.isFinite(n) && n > 0);

  let sent = 0;
  let skipped = 0;
  let closedPartial = 0;
  for (const c of pending ?? []) {
    if (sent >= MAX_REPORTS_PER_RUN) break;
    const s = statsBy.get(String(c.campaign_id));
    if (!s) { skipped++; continue; } // لا أحداث بعد — لم تُرسَل أو الويبهوك لم يلتقطها
    const ageHours = (now - new Date(s.first_event_at).getTime()) / 3_600_000;
    if (ageHours < minHours) { skipped++; continue; }

    // حملة بلا تسليم مرصود = أرسلت قبل تفعيل الويبهوك والتقطنا ذيل فتحاتها فقط
    // (كشفها الفحص الدخاني الأول: ٦ حملات قديمة بتسليم صفر). لا قاسم عادلاً
    // لنسبها — تُغلَق بصمت «التقاطاً جزئياً» ولا تدخل الوسيط ولا المعايرة.
    if (s.delivered === 0 && s.sent === 0) {
      if (!opts.dryRun) {
        await admin
          .from("loops_campaigns")
          .update({
            report: { ...buildReport(s, now), partial: true },
            report_sent_at: new Date(now).toISOString(),
          })
          .eq("id", c.id);
      }
      closedPartial++;
      continue;
    }

    const r = buildReport(s, now);
    const msg = reportMessage(
      String(c.subject),
      c.purpose as string | null,
      c.audience_label as string | null,
      r,
      priorOpenRates,
    );
    if (opts.dryRun) { console.log("[report dry]", msg); sent++; continue; }
    await sendMessage(chatId, msg);
    const { error } = await admin
      .from("loops_campaigns")
      .update({ report: r, report_sent_at: new Date(now).toISOString() })
      .eq("id", c.id);
    if (error) console.error("[report persist]", error.message);
    else {
      sent++;
      priorOpenRates.push(r.openRate); // الحملة المحكومة تدخل وسيط ما يليها في نفس الدفعة
    }
  }
  return { sent, skipped, closedPartial };
}

/**
 * كتلة معايرة محرّك النشرة بالأداء الفعلي — نظير معايرة إكس.
 * بوابة نضج: لا تُحقن قبل ٣ حملات مقيسة (رقم واحد لا يصنع نمطاً).
 */
export async function getCampaignCalibrationBlock(): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("loops_campaigns")
    .select("subject, audience_label, report, report_sent_at")
    .not("report", "is", null)
    .order("report_sent_at", { ascending: false })
    .limit(5);
  // اللقطات الجزئية (حملات ما قبل الويبهوك) ليست قياساً — لا تدخل المعايرة
  const rows = (data ?? []).filter(
    (r) => r.report && (r.report as Record<string, unknown>).partial !== true,
  );
  if (rows.length < 3) return "";
  const lines = rows.map((r) => {
    const rep = r.report as Record<string, unknown>;
    return `- «${r.subject}» (${r.audience_label ?? "غير محدد"}): فتح ${rep.openRate}% · نقر ${rep.clickRate}%`;
  });
  return (
    "\n- معايرة الأداء البريدي (حملاتك المقيسة الأخيرة عند ٤٨ ساعة — استلهم ما رنّ عنواناً وتجنّب نمط ما خفت):\n" +
    lines.join("\n")
  );
}

import { NextResponse } from "next/server";
import { runMorningFallback } from "@/lib/dayplan/ritual";
import { getProactiveInsights } from "@/lib/agents/proactive";
import { sendLongMessage } from "@/lib/telegram/api";

// احتياط الصباح (الملف 11 — المرحلة ٢): إن فات طقس المساء، تُبنى خطة اليوم الآن.
// + دفعة رؤى الصباح (الملف 15): التحليل الاستباقي كان مبنياً ولا يصل الهاتف أبداً.
// Vercel Cron يستدعيه GET بترويسة Authorization: Bearer ${CRON_SECRET} (~٠٧:٠٠ بتوقيت المالك).
export const runtime = "nodejs";
// سقف Hobby موثَّقاً (§٧): الخطة الاحتياطية (Pro) + الرؤى (٣ نداءات Pro) ضمنه.
export const maxDuration = 300;

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
    const built = await runMorningFallback(CHAT_ID);

    // دفعة رؤى الصباح (الملف 15): ١-٣ ملاحظات حادّة مؤرَّضة بتحليلَي النجاح والفجوات
    // + أرقام «ما تغيّر». إثراء best-effort: فشلها لا يمسّ خطة اليوم (النواة)،
    // وuseAdmin لأن الكرون بلا جلسة (RLS يحجب كل شيء بدونه).
    let insightsSent = false;
    try {
      const r = await getProactiveInsights(3, false, true);
      if (r.insights.length > 0) {
        const lines = ["🔭 رؤى الصباح:", ""];
        r.insights.forEach((ins, i) => {
          lines.push(`${i + 1}. ${ins.insight}${ins.basis ? ` (${ins.basis})` : ""}`);
          if (ins.recommendation) lines.push(`   ↳ ${ins.recommendation}`);
        });
        await sendLongMessage(CHAT_ID, lines.join("\n"));
        insightsSent = true;
      }
    } catch (e) {
      console.error("[cron morning insights]", e);
    }

    // حصاد الأداء (الملف 25): كرونا Hobby مشغولان (سقف اثنين)، فالبوابة الأسبوعية
    // تركب على كرون الصباح اليومي: يصفّ مهمة للعامل عند حلول الموعد فقط، ثم يثري
    // دفعة صغيرة مما حُصد سابقاً. best-effort كسابقتيها: لا تمسّ خطة اليوم.
    let harvestQueued = false;
    let enriched = { classified: 0, embedded: 0 };
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { isHarvestDue, enqueueHarvestJob, enrichHarvestedPosts } = await import(
        "@/lib/content/harvest"
      );
      const admin = createAdminClient();
      if (await isHarvestDue(admin)) harvestQueued = await enqueueHarvestJob(admin);
      enriched = await enrichHarvestedPosts(admin, 8);
    } catch (e) {
      console.error("[cron morning harvest]", e);
    }

    // تحديث الدفء البريدي (الملف 34): نفس نمط الحصاد — بوابة أسبوعية تصفّ
    // مهمة `warmth` للعامل. best-effort: فشلها لا يمسّ خطة اليوم.
    let warmthQueued = false;
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { isWarmthDue, enqueueWarmthJob } = await import("@/lib/loops/warmth");
      const admin = createAdminClient();
      if (await isWarmthDue(admin)) warmthQueued = await enqueueWarmthJob(admin);
    } catch (e) {
      console.error("[cron morning warmth]", e);
    }

    // حلقة الحكم (الملف 36): اكتشاف الحملات اليدوية من أحداثها + تقرير الـ48
    // ساعة لكل حملة بلغت النافذة. best-effort — لا يمسّ خطة اليوم.
    let campaignReports = { discovered: 0, sent: 0 };
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { discoverExternalCampaigns, sendDueCampaignReports } = await import(
        "@/lib/loops/report"
      );
      const admin = createAdminClient();
      const discovered = await discoverExternalCampaigns(admin);
      const rep = await sendDueCampaignReports(admin);
      campaignReports = { discovered, sent: rep.sent };
    } catch (e) {
      console.error("[cron morning campaign-reports]", e);
    }

    return NextResponse.json({ ok: true, built, insightsSent, harvestQueued, enriched, warmthQueued, campaignReports });
  } catch (e) {
    console.error("[cron morning]", e);
    return NextResponse.json({ ok: false });
  }
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// ════════════════════════════════════════════════════════════
// جدولة تحديث الدفء البريدي (الملف 34 — بأمر المالك 2026-08-15).
//
// التصنيف الأولي (2026-08-15) لقطة ثابتة؛ بدون تحديث دوري يتجمّد كما تجمّدت
// أرقام إكس قبل الملف 25. التنفيذ نفسه على عامل الـVPS (شبكة طويلة + مفتاح
// لوبس في بيئته)، وهنا البوابة الزمنية فقط: كرونا Hobby مشغولان، فكرون الصباح
// اليومي يصفّ مهمة `warmth` عند حلول الموعد — نفس نمط حصاد إكس حرفياً.
// ════════════════════════════════════════════════════════════

// الفاصل بالأيام بين تحديثين: أسبوعي افتراضياً، ويمكن تقصيره مؤقتاً (مثلاً أثناء
// سلسلة إطلاق مكثّفة كي يرتقي المتفاعل قبل رسالة السلسلة التالية) عبر
// WARMTH_INTERVAL_DAYS — يقبل كسراً (0.83 ≈ 20 ساعة).
// لماذا لا يقلّ عن ~20 ساعة عملياً: الكرون ينطلق في الدقيقة نفسها يومياً، فشرط
// «يوم كامل» يسقط بفارق ثوانٍ ويجعل التحديث يوماً بعد يوم فعلياً.
function warmthIntervalDays(): number {
  const v = Number(process.env.WARMTH_INTERVAL_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 7;
}

/** هل حان موعد تحديث الدفء؟ سجلّ الطابور نفسه هو السجلّ — لا جدول حالة. */
export async function isWarmthDue(
  admin: ReturnType<typeof createAdminClient>,
): Promise<boolean> {
  const { data } = await admin
    .from("generation_jobs")
    .select("created_at, status")
    .eq("kind", "warmth")
    .in("status", ["queued", "running", "done"])
    .order("created_at", { ascending: false })
    .limit(1);
  const last = data?.[0];
  if (!last) return true; // لم يجرِ تحديث قط
  if (last.status !== "done") return false; // منتظر أو يعمل — لا تصفّ ثانياً
  const ageDays = (Date.now() - new Date(last.created_at as string).getTime()) / 86_400_000;
  return ageDays >= warmthIntervalDays();
}

/** يصفّ مهمة تحديث دفء للعامل. user_content مطلوب في المخطط ولا معنى له هنا. */
export async function enqueueWarmthJob(
  admin: ReturnType<typeof createAdminClient>,
): Promise<boolean> {
  const { error } = await admin.from("generation_jobs").insert({
    kind: "warmth",
    user_content: "تحديث الدفء البريدي الأسبوعي",
    analysis: {},
    critique_enabled: false,
  });
  if (error) {
    console.error("[warmth enqueue]", error.message);
    return false;
  }
  return true;
}

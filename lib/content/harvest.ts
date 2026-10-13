import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractAttributes } from "@/lib/content/extract";
import { embed } from "@/lib/ai/gemini";

// ════════════════════════════════════════════════════════════
// جدولة حصاد الأداء وإثراؤه (الملف 25 — بأمر المالك 2026-08-12).
//
// المشكلة: حلقة الأداء كانت ميتة — ٣٢٦ منشوراً بصفر مشاهدة وصفر سمة، فالمعايرة
// والأنماط واختيار الأمثلة كلها تعمل على فراغ. الحصاد نفسه على عامل الـVPS
// (شبكة طويلة)، وهنا الطرفان اللذان يخصّان Vercel:
//   ١) البوابة الزمنية والصفّ — كرونا Hobby مشغولان، فكرون الصباح يصفّ عند الموعد.
//   ٢) الإثراء المحدود — تصنيف السمات وتضمين الوارد الجديد، دفعةً صغيرة يومياً
//      بالأولوية للأعلى تفاعلاً: الأنماط تريد الفائزين لا الأرشيف كله.
// ════════════════════════════════════════════════════════════

const HARVEST_INTERVAL_DAYS = 7;

/** هل حان موعد الحصاد؟ سجلّ الطابور نفسه هو السجلّ — لا جدول حالة إضافي. */
export async function isHarvestDue(
  admin: ReturnType<typeof createAdminClient>,
): Promise<boolean> {
  const { data } = await admin
    .from("generation_jobs")
    .select("created_at, status")
    .eq("kind", "harvest")
    .in("status", ["queued", "running", "done"])
    .order("created_at", { ascending: false })
    .limit(1);
  const last = data?.[0];
  if (!last) return true; // لم يجرِ حصاد قط
  // منتظر أو يعمل الآن → لا تصفّ ثانياً مهما طال
  if (last.status !== "done") return false;
  const ageDays = (Date.now() - new Date(last.created_at as string).getTime()) / 86_400_000;
  return ageDays >= HARVEST_INTERVAL_DAYS;
}

/** يصفّ مهمة حصاد للعامل. user_content مطلوب في المخطط ولا معنى له هنا. */
export async function enqueueHarvestJob(
  admin: ReturnType<typeof createAdminClient>,
): Promise<boolean> {
  const { error } = await admin.from("generation_jobs").insert({
    kind: "harvest",
    user_content: "حصاد الأداء الأسبوعي",
    analysis: {},
    critique_enabled: false,
  });
  if (error) {
    console.error("[harvest enqueue]", error.message);
    return false;
  }
  return true;
}

export type EnrichResult = { classified: number; embedded: number };

/**
 * إثراء محدود لما حصده العامل: سمات للأعلى تفاعلاً (تفتح مختبر الأنماط)
 * ومتجهات للوارد الجديد (يدخل اختيار الأمثلة الدلالي). طبقة اختيارية بالكامل —
 * فشل أي منشور يُسجَّل ويُتجاوز، والحصاد نفسه محفوظ في القاعدة قبلها.
 */
export async function enrichHarvestedPosts(
  admin: ReturnType<typeof createAdminClient>,
  limit = 8,
): Promise<EnrichResult> {
  const out: EnrichResult = { classified: 0, embedded: 0 };

  // ── السمات: الأعلى تفاعلاً أولاً — الأنماط تُبنى على الفائزين ──
  const { data: unclassified } = await admin
    .from("posts")
    .select("id, draft_text, final_text, likes")
    .eq("status", "published")
    .is("hook_type", null)
    .not("likes", "is", null)
    .order("likes", { ascending: false })
    .limit(limit);

  for (const p of unclassified ?? []) {
    const text = (p.final_text as string | null) || (p.draft_text as string | null);
    if (!text) continue;
    try {
      const attrs = await extractAttributes(text);
      if (!attrs) continue;
      await admin
        .from("posts")
        .update({ hook_type: attrs.hook_type, structure: attrs.structure, emotion: attrs.emotion })
        .eq("id", p.id);
      out.classified++;
    } catch (e) {
      console.error("[harvest enrich attrs]", p.id, e);
    }
  }

  // ── المتجهات: ما أدرجه الحصاد يبقى خارج البحث الدلالي حتى يُضمَّن ──
  const { data: unembedded } = await admin
    .from("posts")
    .select("id, draft_text, final_text")
    .eq("status", "published")
    .is("embedding", null)
    .not("external_post_id", "is", null)
    .limit(limit);

  for (const p of unembedded ?? []) {
    const text = (p.final_text as string | null) || (p.draft_text as string | null);
    if (!text) continue;
    try {
      const r = await embed(text);
      if (!r.ok) {
        console.error("[harvest enrich embed]", p.id, r.error);
        continue;
      }
      await admin.from("posts").update({ embedding: r.data }).eq("id", p.id);
      out.embedded++;
    } catch (e) {
      console.error("[harvest enrich embed]", p.id, e);
    }
  }

  return out;
}

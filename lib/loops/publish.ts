import "server-only";
import { createClient } from "@/lib/supabase/server";

// ════════════════════════════════════════════════════════════
// النشر الكامل إلى لوبس (الملف 35 — بأمر المالك 2026-08-15).
//
// المسودة المعتمدة → حملة لوبس: إنشاء + محتوى LMX + جمهور + Guardian +
// معاينة اختيارية + جدولة اختيارية. التنفيذ على العامل (`kind='loops_publish'`،
// المفتاح في بيئته حصراً — نمط Typefully حرفياً)، وهنا الصفّ والاستطلاع فقط.
//
// قاعدة أمان معلنة: لا «إرسال فوري» أبداً من النظام — إمّا مسودة في لوبس
// (يرسلها المالك من اللوحة) أو جدولة بتوقيت يحدده هو صراحةً في الواجهة.
// ════════════════════════════════════════════════════════════

export type LoopsAudience = {
  key: string;
  type: "all" | "segment" | "list";
  id: string | null;
  label: string;
};

/** كامل الجمهور — الخيار الوحيد المضمون دون إعداد (لا معرّف: لوبس يستهدف المشتركين كلهم). */
const ALL_AUDIENCE: LoopsAudience = { key: "all", type: "all", id: null, label: "كامل الجمهور" };

/**
 * الجماهير المتاحة للنشر. الشرائح والقوائم معرّفاتها من حساب لوبس الخاص بك،
 * فتُعرَّف في متغير البيئة LOOPS_AUDIENCES كمصفوفة JSON، مثال:
 *   [{"key":"active","type":"segment","id":"<معرّف الشريحة>","label":"النشطون"},
 *    {"key":"list-1","type":"list","id":"<معرّف القائمة>","label":"قائمة الإحياء"}]
 * لا جلب حيّ من الواجهة (قيد معلن: مفتاح لوبس في بيئة العامل حصراً). المُعرَّفة
 * تتصدّر القائمة فتكون الافتراضية؛ «كامل الجمهور» دائماً آخرها.
 */
export function getLoopsAudiences(): LoopsAudience[] {
  const raw = process.env.LOOPS_AUDIENCES?.trim();
  const configured: LoopsAudience[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("ليست مصفوفة");
      for (const item of parsed) {
        const o = item as Record<string, unknown>;
        if (
          o &&
          typeof o.key === "string" &&
          o.key &&
          o.key !== ALL_AUDIENCE.key &&
          (o.type === "segment" || o.type === "list") &&
          typeof o.id === "string" &&
          o.id &&
          typeof o.label === "string" &&
          o.label
        ) {
          configured.push({ key: o.key, type: o.type, id: o.id, label: o.label });
        }
      }
    } catch (e) {
      console.error("[loops] LOOPS_AUDIENCES غير صالح — يُتجاهل:", e instanceof Error ? e.message : e);
    }
  }
  return [...configured, ALL_AUDIENCE];
}

export type LoopsPublishRequest = {
  subject: string;
  previewText: string | null;
  body: string; // النص العربي الخام بفقرات — العامل يحوّله LMX
  audienceKey: string;
  scheduleAt: string | null; // ISO؛ null = تُترك مسودة في لوبس
  previewTo: string | null; // بريد لإرسال معاينة قبل أي شيء
  purpose: string | null; // غرض النشرة — يُسجَّل في loops_campaigns (وقود العدّ البيعي الحي)
  newsletterId: string | null;
};

export type QueuePublishResult = { ok: true; jobId: string } | { ok: false; error: string };

export async function queueLoopsPublishJob(req: LoopsPublishRequest): Promise<QueuePublishResult> {
  const subject = req.subject.trim();
  const body = req.body.trim();
  if (!subject) return { ok: false, error: "لا عنوان — العنوان أول ما يُحاكم في البريد." };
  if (!body) return { ok: false, error: "لا نصّ للمسودة." };
  const audience = getLoopsAudiences().find((a) => a.key === req.audienceKey);
  if (!audience) return { ok: false, error: "جمهور غير معروف — اختر من القائمة." };
  if (req.scheduleAt) {
    const t = new Date(req.scheduleAt).getTime();
    if (!Number.isFinite(t)) return { ok: false, error: "توقيت الجدولة غير صالح." };
    if (t < Date.now() + 5 * 60_000)
      return { ok: false, error: "توقيت الجدولة يجب أن يكون بعد خمس دقائق على الأقل." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      kind: "loops_publish",
      user_content: subject, // للعرض الآدمي في الطابور — الحمولة الكاملة في analysis
      analysis: {
        subject,
        preview_text: req.previewText?.trim() || null,
        body,
        audience: { type: audience.type, id: audience.id, label: audience.label },
        schedule_at: req.scheduleAt,
        preview_to: req.previewTo?.trim() || null,
        purpose: req.purpose,
        newsletter_id: req.newsletterId,
      },
      critique_enabled: false,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: "تعذّر صفّ النشر: " + error.message };
  return { ok: true, jobId: String(data.id) };
}

export type LoopsPublishView =
  | { status: "queued" | "running" }
  | {
      status: "done";
      campaignId: string;
      url: string;
      scheduled: boolean;
      previewSent: boolean;
      guardianErrors: string[];
      guardianWarnings: string[];
    }
  | { status: "failed"; error: string };

export async function getLoopsPublishView(jobId: string): Promise<LoopsPublishView | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("generation_jobs")
    .select("status, result, error")
    .eq("id", jobId)
    .eq("kind", "loops_publish")
    .single();
  if (!data) return null;
  if (data.status === "queued" || data.status === "running")
    return { status: data.status as "queued" | "running" };
  if (data.status === "done") {
    const r = (data.result ?? {}) as Record<string, unknown>;
    return {
      status: "done",
      campaignId: String(r.campaignId ?? ""),
      url: String(r.url ?? ""),
      scheduled: Boolean(r.scheduled),
      previewSent: Boolean(r.previewSent),
      guardianErrors: Array.isArray(r.guardianErrors) ? r.guardianErrors.map(String) : [],
      guardianWarnings: Array.isArray(r.guardianWarnings) ? r.guardianWarnings.map(String) : [],
    };
  }
  return { status: "failed", error: String(data.error ?? "فشل غير مفسَّر") };
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { proJson } from "@/lib/ai/gemini";
import { analyzePatterns } from "@/lib/agents/specialists";
import type { ContextSource } from "@/lib/agents/access";
import { parseJson, dedupeSources } from "@/lib/agents/util";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// التحليل الاستباقي — العقل الموحّد (الملف 08، المرحلة ٤).
// لا ينتظر سؤالاً: يفحص بيانات المالك عبر وكيل تحليل الأنماط (نجاح + فجوات)،
// ثم يركّب أهمّ ١-٣ ملاحظات استباقية حادّة قابلة للتطبيق تُعرَض عند فتح الشات.
// كاش داخل الذاكرة بمهلة (يتجنّب إعادة الحساب عند كل فتح — لا cron ولا جدولة).
// server-only (يحترم RLS عبر طبقة الوصول). مؤرَّض بالتحليل فقط — لا اختراع أرقام.
// ════════════════════════════════════════════════════════════

export type ProactiveInsight = {
  insight: string; // الملاحظة (حادّة، مفاجئة، قابلة للتطبيق)
  recommendation: string; // توصية عملية موجزة
  basis: string; // أساسها (نجاح/فجوة/مزيج) — للشفافية
};

export type ProactiveResult = {
  insights: ProactiveInsight[];
  sources: ContextSource[];
};

const TTL_MS = 2 * 60 * 60 * 1000; // ساعتان — «تحليل حديث» يكفيه ذلك
let _cache: { at: number; result: ProactiveResult } | null = null;

// دلتا «ما تغيّر» (الملف 14 — البند ٢): استعلامات عدّ رخيصة — صفر ذكاء، وكل رقم
// فيها حقيقي فيجوز للنموذج ذكره. best-effort: فشلها لا يعطّل. useAdmin لمسار
// كرون الصباح (الملف 15): لا جلسة هناك فيحجب RLS كل الأرقام.
async function buildDeltaBlock(useAdmin = false): Promise<string> {
  try {
    const supabase = useAdmin ? createAdminClient() : await createClient();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const signalCutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();

    const [captured, capturedCount, pendingDecisions, drafts, lastPub, staleSignals] =
      await Promise.all([
      // العيّنة للمواضيع فقط (٢٠ تكفي لاستخلاص ثلاثة)، والعدّ الدقيق مستقلّ عنها
      // كي لا يُبخس الرقم إن تجاوز الالتقاط حدّ العيّنة.
      supabase
        .from("items")
        .select("topic")
        .eq("origin", "manual")
        .gte("created_at", dayAgo)
        .limit(20),
      supabase
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("origin", "manual")
        .gte("created_at", dayAgo),
      supabase
        .from("decisions")
        .select("*", { count: "exact", head: true })
        .is("outcome", null),
      supabase
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("status", "draft"),
      supabase
        .from("posts")
        .select("published_at")
        .eq("status", "published")
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("source_type", "signal")
        .eq("status", "new")
        .lt("created_at", signalCutoff),
    ]);

    const capturedRows = (captured.data ?? []) as { topic: string | null }[];
    const topics = [
      ...new Set(capturedRows.map((r) => r.topic).filter((t): t is string => !!t)),
    ].slice(0, 3);
    const daysSincePub = lastPub.data?.published_at
      ? Math.floor(
          (Date.now() - new Date(lastPub.data.published_at as string).getTime()) /
            86_400_000,
        )
      : null;

    const lines = [
      `- التُقط خلال ٢٤ ساعة: ${capturedCount.count ?? capturedRows.length} عنصراً${topics.length ? ` (مواضيع: ${topics.join("، ")})` : ""}.`,
      `- قرارات بلا نتيجة موثّقة: ${pendingDecisions.count ?? 0}.`,
      `- مسودات جاهزة للنشر: ${drafts.count ?? 0}${daysSincePub !== null ? ` — وآخر نشر قبل ${daysSincePub} يوم/أيام` : ""}.`,
      (staleSignals.count ?? 0) > 0
        ? `- إشارات محفوظة لم تُلمس منذ أكثر من ٣ أيام: ${staleSignals.count}.`
        : "",
    ].filter(Boolean);
    return lines.join("\n");
  } catch (e) {
    console.error("[proactive] فشل بناء الدلتا:", e);
    return "";
  }
}

// مخطط الإخراج المنظّم (الدستور §٣-١) — يضمن JSON صالحاً رغم الاقتباسات داخل القيم العربية.
// basis مقيَّد بالقيم الثلاث التي تعرفها خريطة الألوان في الواجهة (BASIS_STYLE) — أي قيمة
// أخرى كانت تسقط إلى وسم رمادي بلا دلالة.
const INSIGHTS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insight: { type: "string" },
          recommendation: { type: "string" },
          basis: { type: "string", enum: ["نجاح", "فجوة", "مزيج"] },
        },
        required: ["insight", "recommendation", "basis"],
      },
    },
  },
  required: ["insights"],
};

// يفحص البيانات استباقياً ويُرجع أهمّ ١-٣ ملاحظات. force=true يتجاوز الكاش (لزرّ تحديث).
// useAdmin=true لمسار بلا جلسة (دفعة رؤى الصباح من الكرون — الملف 15).
export async function getProactiveInsights(
  limit = 3,
  force = false,
  useAdmin = false,
): Promise<ProactiveResult> {
  const n = Math.max(1, Math.min(limit, 5));
  if (!force && _cache && Date.now() - _cache.at < TTL_MS) {
    return { insights: _cache.result.insights.slice(0, n), sources: _cache.result.sources };
  }

  // المصدر: وكيل تحليل الأنماط + دلتا «ما تغيّر» الرخيصة (الملف 14 — البند ٢):
  // بدونها كانت الملاحظات عامّة متكررة كل ساعتين؛ معها تصير «لاحظتُ منذ أمس…».
  const [success, gaps, delta] = await Promise.all([
    analyzePatterns("success", "", useAdmin),
    analyzePatterns("gaps", "", useAdmin),
    buildDeltaBlock(useAdmin),
  ]);
  const sources = dedupeSources([...success.sources, ...gaps.sources]);

  const prompt = `أنت «العقل» الاستباقي ل${OWNER_NAME}. أمامك تحليلان حديثان لبياناته + سطر حالته الراهنة. استخلص أهمّ ${n} ملاحظات **استباقية** — حادّة، مفاجئة، قابلة للتطبيق — لم يسألها ${OWNER_NAME} لكنها تستحق انتباهه (نموذج النبرة: «تغريداتك عن المبادئ تتفوّق على تغريدات الأدوات، لكنك تكتب عن الأدوات أكثر»). قدّم ما تغيّر حديثاً على العامّ المتكرر.

تحليل أنماط النجاح:
${success.findings}
إشاراته: ${success.signals.join(" · ") || "—"}

تحليل الفجوات (مقابل أهداف المشروع وشخصياته):
${gaps.findings}
إشاراته: ${gaps.signals.join(" · ") || "—"}

${delta ? `ما تغيّر مؤخراً (أرقام حقيقية من قاعدة بياناته):\n${delta}\n` : ""}
قواعد إلزامية:
- اعتمد **فقط** على التحليلين وسطور «ما تغيّر» أعلاه. لا تخترع رقماً ولا نسبة غير واردة فيها.
- كل ملاحظة: رؤية حادّة + توصية عملية موجزة.
- رتّبها بالأهمية والقابلية للتطبيق. ${n} على الأكثر.

أخرج JSON فقط:
{"insights": [{"insight": "الملاحظة بالعربية", "recommendation": "التوصية العملية", "basis": "نجاح|فجوة|مزيج"}]}`;

  const res = await proJson(prompt, undefined, INSIGHTS_SCHEMA);
  if (!res.ok) console.error(`[proactive] فشل proJson: ${res.error}`);
  const p = res.ok ? parseJson<{ insights: ProactiveInsight[] }>(res.data) : null;
  if (res.ok && !p) console.error(`[proactive] تعذّر تفكيك JSON: ${res.data.slice(0, 300)}`);
  const insights = Array.isArray(p?.insights)
    ? p.insights
        .filter((i) => i && i.insight)
        .map((i) => ({
          insight: String(i.insight),
          recommendation: String(i.recommendation ?? ""),
          basis: String(i.basis ?? ""),
        }))
    : [];

  const result: ProactiveResult = { insights, sources };
  if (insights.length > 0) _cache = { at: Date.now(), result }; // لا تُخزّن نتيجة فارغة
  return { insights: insights.slice(0, n), sources };
}

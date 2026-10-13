import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { embed } from "@/lib/ai/gemini";
import { extractDecisions, type ExtractedDecision } from "@/lib/agents/specialists";
import { sendMessage } from "@/lib/telegram/api";
import { OWNER_TZ } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// حلقة القرارات (الملف 13 — البند ٢): تغذية سجلّ القرارات من الالتقاط الحيّ
// ومطالبة النتائج من الطقس. الجدول يملك بنية صارمة وعتبة ٣٠ للتحليل —
// وكان يتضوّر جوعاً (قراران) لأن لا شيء يغذّيه.
// ════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────
// كشف نيّة القرار (بلا نداء ذكاء — نمط TASK_HINTS حرفياً).
// القائمة ضيّقة عمداً: الإيجابيات الكاذبة يصفّيها extractDecisions
// («إن لم يوجد قرار واضح، أعِد قائمة فارغة»)، فلا رسالة تُرسل أصلاً.
// ───────────────────────────────────────────────
const DECISION_HINTS = [
  "قررت",
  "قرّرت",
  "قررنا",
  "حسمت",
  "حسمنا",
  "اعتمدت",
  "بنعتمد",
  "نعتمد ",
  "اخترت",
  "استقريت",
  "عدلت عن",
  "عدلنا عن",
  "بطّلت",
  "تراجعت عن",
  "بنوقف",
  "نوقف ",
  "ألغيت",
  "نلغي ",
  "خلاص بنمشي",
  "بنمشي مع",
];

/** هل تحمل الرسالة إشارة قرار استراتيجي؟ حارس رخيص قبل نداء الاستخراج. */
export function looksLikeDecision(text: string): boolean {
  return DECISION_HINTS.some((h) => text.includes(h));
}

// صياغة القرارات المستخرجة لرسالة الاقتراح.
function formatDecisions(decisions: ExtractedDecision[]): string {
  return decisions
    .map(
      (d, i) =>
        `${decisions.length > 1 ? `قرار ${i + 1}:\n` : ""}الموقف: ${d.situation}\nالقرار: ${d.decision}\nالسبب: ${d.reasoning}`,
    )
    .join("\n\n");
}

/**
 * يفحص نصاً ملتقطاً بحث قرار: استخراج (pro) ثم رسالة اقتراح بزرّي توثيق/تجاهل.
 * يُستدعى داخل after() بعد ردّ الالتقاط — لا يؤخّر التأكيد ولا يخاطر بالمهلة.
 * callback_data يحمل معرّف العنصر فقط (حدّ 64 بايت)؛ التأكيد يعيد الاستخراج.
 */
export async function suggestDecisionCapture(
  chatId: number | string,
  itemText: string,
  itemId: string,
): Promise<void> {
  try {
    const r = await extractDecisions(itemText);
    if (r.decisions.length === 0) return; // لا قرار واضح — صمت (لا إزعاج)
    await sendMessage(
      chatId,
      `🧭 يبدو أنك اتخذت قراراً — أوثّقه في سجلّ القرارات؟\n\n${formatDecisions(r.decisions)}`,
      [
        [
          { text: "وثّقه قراراً ✓", callback_data: `dc:ok:${itemId}` },
          { text: "تجاهل", callback_data: `dc:no:${itemId}` },
        ],
      ],
    );
  } catch (e) {
    console.error("[decision] فشل اقتراح التوثيق:", e);
  }
}

export type DecisionConfirmation =
  | { status: "created"; count: number }
  | { status: "already" }
  | { status: "failed" };

// حارس التكرار بجسر المصدر (0017) — نمط convertPlanToTasks حرفياً.
async function decisionsExistForItem(
  supabase: ReturnType<typeof createAdminClient>,
  itemId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("decisions")
    .select("*", { count: "exact", head: true })
    .eq("related_item_id", itemId);
  return (count ?? 0) > 0;
}

/**
 * يؤكّد التوثيق: يعيد الاستخراج من نصّ العنصر (نداء pro — نادر، عند الضغط فقط)
 * ويدرج كل قرار بتضمين نصّه المركّب (نمط saveDecision) وجسر related_item_id.
 * حارس تكرار مزدوج: قبل الاستخراج (يوفّر نداء pro) وبعده مباشرةً قبل الإدراج
 * (يضيّق نافذة سباق الضغطة المزدوجة/إعادة الإرسال إلى أجزاء الثانية).
 */
export async function confirmDecisionCapture(itemId: string): Promise<DecisionConfirmation> {
  const supabase = createAdminClient();
  if (await decisionsExistForItem(supabase, itemId)) return { status: "already" };

  const { data: item } = await supabase
    .from("items")
    .select("raw_text")
    .eq("id", itemId)
    .maybeSingle();
  const rawText = item?.raw_text as string | undefined;
  if (!rawText) return { status: "failed" };

  const r = await extractDecisions(rawText);
  if (r.decisions.length === 0) return { status: "failed" };

  // إعادة الفحص بعد نداء pro الطويل — الطرف الثاني في السباق قد سبق وأدرج.
  if (await decisionsExistForItem(supabase, itemId)) return { status: "already" };

  let inserted = 0;
  for (const d of r.decisions) {
    const text = `الموقف: ${d.situation}\nالقرار: ${d.decision}\nالسبب: ${d.reasoning}`;
    const emb = await embed(text);
    const { error } = await supabase.from("decisions").insert({
      situation: d.situation,
      decision: d.decision,
      reasoning: d.reasoning,
      embedding: emb.ok ? emb.data : null,
      related_item_id: itemId,
    });
    if (!error) inserted++;
    else console.error("[decision] فشل إدراج قرار:", error.message);
  }
  return inserted > 0 ? { status: "created", count: inserted } : { status: "failed" };
}

// ───────────────────────────────────────────────
// مطالبة النتيجة (من الطقس المسائي — ليلة الخميس، سؤال واحد).
// ───────────────────────────────────────────────
const OUTCOME_STALE_DAYS = 21;

export type StaleDecision = { id: string; decision: string; createdAt: string };

/** أقدم قرار بلا نتيجة وعمره > ٢١ يوماً — مرشّح سؤال الخميس. */
export async function getStaleDecision(): Promise<StaleDecision | null> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - OUTCOME_STALE_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("decisions")
    .select("id, decision, created_at")
    .is("outcome", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    decision: data.decision as string,
    createdAt: data.created_at as string,
  };
}

/** يسجّل حكم النتيجة (زرّ نجح/فشل/جزئي) ويفتح انتظار نصّها التفصيلي. */
export async function recordOutcomeVerdict(
  id: string,
  wasCorrect: "yes" | "no" | "partial",
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("decisions")
    .update({
      was_correct: wasCorrect,
      outcome_date: new Date().toISOString(),
      awaiting_outcome: true,
    })
    .eq("id", id);
}

// صلاحية انتظار النصّ: الحكم يُضغط في طقس المساء (~22:00 بتوقيت المالك) والنصّ يُتوقّع
// في نفس الجلسة. الانتظار يموت مع تغيّر يوم المالك — علم يعيش للصباح كان يبتلع
// أول فكرة يلتقطها المالك كأنها نصّ النتيجة (فقدان التقاط + تلويث outcome معاً).
function ownerDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OWNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** القرار المنتظِر نصَّ نتيجته (إن وُجد) — للإجابات المعلّقة في تيليجرام. */
export async function getDecisionAwaitingOutcome(): Promise<{
  id: string;
  decision: string;
} | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("decisions")
    .select("id, decision, outcome_date")
    .eq("awaiting_outcome", true)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const pressedDay = data.outcome_date ? ownerDay(new Date(data.outcome_date as string)) : "";
  if (pressedDay !== ownerDay(new Date())) {
    await setDecisionOutcomeText(data.id as string, null); // يوم جديد — أغلق بالحكم وحده
    return null;
  }
  return { id: data.id as string, decision: data.decision as string };
}

/** يخزّن نصّ النتيجة (أو يكتفي بالحكم عند التخطي) ويُطفئ الانتظار. */
export async function setDecisionOutcomeText(
  id: string,
  outcome: string | null,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("decisions")
    .update({
      // الحكم (was_correct) سُجّل عند الزرّ؛ النصّ إثراء اختياري. عند التخطي
      // نضع سطراً محايداً كي لا يبقى القرار «بلا نتيجة» فيُسأل عنه مجدداً.
      outcome: outcome ?? "(سُجّل الحكم بلا تفاصيل)",
      awaiting_outcome: false,
    })
    .eq("id", id);
}

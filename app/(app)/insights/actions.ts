"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { embed, pro } from "@/lib/ai/gemini";
import { OWNER_NAME } from "@/lib/config/owner";
import {
  weekOf,
  generateJournalDraft,
  type JournalDraftOutcome,
} from "@/lib/insights/journal";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

type JournalInput = {
  learned: string;
  failed: string;
  succeeded: string;
  changed: string;
};

// يحفظ مراجعة أسبوعية مع embedding (تصبح قابلة للاستجواب لاحقاً).
export async function saveJournalEntry(input: JournalInput): Promise<void> {
  await requireUser();
  const parts = [input.learned, input.failed, input.succeeded, input.changed]
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("اكتب شيئاً في حقل واحد على الأقل.");

  const supabase = await createClient();
  const emb = await embed(parts.join("\n"));
  const { error } = await supabase.from("journal_entries").insert({
    week_of: weekOf(),
    learned: input.learned.trim() || null,
    failed: input.failed.trim() || null,
    succeeded: input.succeeded.trim() || null,
    changed: input.changed.trim() || null,
    embedding: emb.ok ? emb.data : null,
  });
  if (error) throw new Error("فشل حفظ المراجعة: " + error.message);
  revalidatePath("/insights");
}

type DecisionInput = {
  situation: string;
  decision: string;
  reasoning: string;
  hypothesis: string;
};

// يحفظ قراراً بالبنية الصارمة (موقف→قرار→سبب→فرضية) مع embedding. النتيجة لاحقاً.
export async function saveDecision(input: DecisionInput): Promise<void> {
  await requireUser();
  const situation = input.situation.trim();
  const decision = input.decision.trim();
  const reasoning = input.reasoning.trim();
  if (!situation || !decision || !reasoning)
    throw new Error("الموقف والقرار والسبب حقول مطلوبة.");

  const supabase = await createClient();
  const text =
    `الموقف: ${situation}\nالقرار: ${decision}\nالسبب: ${reasoning}` +
    (input.hypothesis.trim() ? `\nالفرضية: ${input.hypothesis.trim()}` : "");
  const emb = await embed(text);
  const { error } = await supabase.from("decisions").insert({
    situation,
    decision,
    reasoning,
    hypothesis: input.hypothesis.trim() || null,
    embedding: emb.ok ? emb.data : null,
  });
  if (error) throw new Error("فشل حفظ القرار: " + error.message);
  revalidatePath("/insights");
}

type OutcomeInput = { outcome: string; was_correct: string };

// يضيف نتيجة قرار سابق (تُملأ بعد أسابيع غالباً).
export async function addDecisionOutcome(
  id: string,
  input: OutcomeInput,
): Promise<void> {
  await requireUser();
  if (!input.outcome.trim()) throw new Error("اكتب النتيجة.");
  const allowed = ["yes", "no", "partial", "unknown"];
  const was_correct = allowed.includes(input.was_correct)
    ? input.was_correct
    : "unknown";
  const supabase = await createClient();
  const { error } = await supabase
    .from("decisions")
    .update({
      outcome: input.outcome.trim(),
      was_correct,
      outcome_date: new Date().toISOString(),
      // العلم مشترك مع مطالبة الطقس (0016): الإدخال من الويب يطفئه أيضاً، وإلا
      // ابتُلعت أول رسالة تيليجرام لاحقة نصَّ نتيجةٍ فوق ما كُتب هنا.
      awaiting_outcome: false,
    })
    .eq("id", id);
  if (error) throw new Error("فشل حفظ النتيجة: " + error.message);
  revalidatePath("/insights");
}

// ════════════════════════════════════════════════════════════
// مسودة المذكرة الأسبوعية آلياً (الملف 14 — البند ٥): أضعف عادة في النظام
// (مذكرة واحدة منذ مايو). النواة (وقائع الأسبوع → flash بمخطط مقيّد) انتقلت إلى
// lib/insights/journal (الملف 15) لتتشاركها الويب وتيليجرام — هنا غلاف الجلسة فقط.
// ════════════════════════════════════════════════════════════
export async function draftWeeklyJournal(): Promise<JournalDraftOutcome> {
  try {
    await requireUser();
    const supabase = await createClient(); // عميل الجلسة — يحترم RLS كما كان
    return await generateJournalDraft(supabase);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "تعذّر توليد مسودة المذكرة",
    };
  }
}

// لوحة تحليل القرارات — مفعّلة فقط عند ≥ ٣٠ قراراً موثّقاً (مبدأ النضج).
export async function analyzeDecisions(): Promise<string> {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("decisions")
    .select("situation, decision, reasoning, outcome, was_correct")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length < 30)
    throw new Error("التحليل يُفعّل عند ٣٠ قراراً موثّقاً — لديك " + rows.length + ".");

  const corpus = rows
    .map(
      (d, i) =>
        `#${i + 1}\nالموقف: ${d.situation}\nالقرار: ${d.decision}\nالسبب: ${d.reasoning}\nالنتيجة: ${d.outcome || "—"} (${d.was_correct || "غير معروف"})`,
    )
    .join("\n\n");
  const prompt =
    `أنت محلّل قرارات للمؤسس ${OWNER_NAME}. حلّل سجلّ القرارات التالي بصدق وإيجاز. ` +
    "أجب بالعربية في ٣–٥ نقاط عملية تغطّي: ما القرارات التي أثبتت البيانات صحّتها/خطأها؟ " +
    "ما الأنماط المتكررة في الأخطاء؟ ما التحيّز أو العادة التي يُنصح بتغييرها؟ " +
    "استند للبيانات فقط ولا تجامل.\n\n" +
    corpus;
  const res = await pro(prompt);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

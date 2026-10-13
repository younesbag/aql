import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { orchestrate, type ChatTurn } from "@/lib/agents/orchestrator";
import { sendMessage, sendLongMessage } from "@/lib/telegram/api";

// ════════════════════════════════════════════════════════════
// العقل في تيليجرام (الملف 13 — البند ١): /اسأل يوصل المُستجوِب الموحّد للجيب.
// الاستدعاء داخل after() حصراً — تيليجرام يعيد إرسال التحديث إن تأخر الردّ،
// فالـwebhook يرسل «يفكّر…» فوراً ويعود 200، والجواب يلحق.
// عميل admin (بلا جلسة) + useAdmin عبر المنسّق كاملاً — عميل الجلسة هنا بلا
// كوكيز فتحجب RLS كل شيء ويجيب العقل من فراغ.
// ════════════════════════════════════════════════════════════

// عنوان محادثة تيليجرام الواحدة في conversations — تظهر مستأنفةً في /chat الويب.
const TG_CONVERSATION_TITLE = "تيليجرام 🧠";
// نفس نافذة المنسّق (MAX_HISTORY_TURNS) — التخزين فوقها هدر بلا أثر في السياق.
const MAX_STORED_MESSAGES = 40;

// شكل رسالة conversations نفسه الذي يكتبه الويب (chat/actions) — كي يُستأنف هناك.
type StoredMessage = {
  role: "user" | "model";
  text: string;
  sources?: { kind: string; label: string; text: string; ref: string }[];
};

/** يكشف سؤالاً نصياً للعقل: /اسأل أو /سؤال أو /ask (مرادف قائمة الأوامر اللاتينية —
 *  الملف 15) أو بادئة «؟». يعيد العلم والسؤال المجرّد. */
export function detectMindQuestion(text: string): { isQuestion: boolean; question: string } {
  const t = text.trim();
  const cmd = t.match(/^\/(?:اسأل|سؤال|ask)(?:\s+([\s\S]*))?$/);
  if (cmd) return { isQuestion: true, question: (cmd[1] ?? "").trim() };
  if (t.startsWith("؟")) return { isQuestion: true, question: t.slice(1).trim() };
  return { isQuestion: false, question: t };
}

/** يكشف سؤالاً صوتياً: التفريغ يبدأ بـ«اسأل» أو «سؤال» (إشارة نطق طبيعية). */
export function detectVoiceMindQuestion(transcript: string): {
  isQuestion: boolean;
  question: string;
} {
  const t = transcript.trim();
  const m = t.match(/^(?:اسأل|إسأل|سؤال)[:،\s]+([\s\S]+)$/);
  if (m) return { isQuestion: true, question: m[1].trim() };
  return { isQuestion: false, question: t };
}

// يجلب محادثة تيليجرام (أحدث صفّ بعنوانها) — أو null.
async function loadTgConversation(): Promise<{ id: string; messages: StoredMessage[] } | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, messages")
    .eq("title", TG_CONVERSATION_TITLE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    messages: Array.isArray(data.messages) ? (data.messages as StoredMessage[]) : [],
  };
}

// يحفظ المحادثة (تحديث أو إنشاء) — best-effort: فشل التخزين لا يمنع الجواب.
async function persistTgConversation(
  id: string | null,
  messages: StoredMessage[],
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const trimmed = messages.slice(-MAX_STORED_MESSAGES);
    if (id) {
      // .select يكشف تحديث صفر صفوف (الصفّ حُذف أثناء orchestrate الطويل):
      // update على معرّف غائب يعيد نجاحاً فارغاً فكان الدوران يضيعان بصمت.
      const { data: updated, error } = await supabase
        .from("conversations")
        .update({ messages: trimmed, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (!error && (updated ?? []).length > 0) return;
    }
    await supabase
      .from("conversations")
      .insert({ title: TG_CONVERSATION_TITLE, messages: trimmed });
  } catch (e) {
    console.error("[tg-ask] فشل حفظ المحادثة:", e);
  }
}

// سطر مصادر موجز للردّ (تيليجرام نصّ خام — لا <details> كالويب).
function sourcesLine(sources: { label: string }[]): string {
  if (sources.length === 0) return "";
  const counts = new Map<string, number>();
  for (const s of sources) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  const parts = [...counts.entries()].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
  return `\n\n🔎 المصادر: ${parts.join(" · ")}`;
}

/**
 * يجيب سؤالاً للعقل من تيليجرام: يستأنف محادثة «تيليجرام 🧠»، ينسّق بالأدوات
 * (useAdmin)، يرسل الجواب مقسّماً عند الطول، ويحفظ الدورين.
 * يُستدعى داخل after() — رسالة «يفكّر…» مسؤولية الـwebhook قبله.
 */
export async function answerMindQuestion(
  chatId: number | string,
  question: string,
): Promise<void> {
  try {
    const conv = await loadTgConversation();
    const history: ChatTurn[] = (conv?.messages ?? []).map((m) => ({
      role: m.role,
      text: m.text,
    }));

    const r = await orchestrate(question, history, { useAdmin: true });
    await sendLongMessage(chatId, r.answer + sourcesLine(r.sources));

    const full: StoredMessage[] = [
      ...(conv?.messages ?? []),
      { role: "user", text: question },
      {
        role: "model",
        text: r.answer,
        sources: r.sources.map((s) => ({
          kind: s.kind,
          label: s.label,
          text: s.text,
          ref: s.ref,
        })),
      },
    ];
    await persistTgConversation(conv?.id ?? null, full);
  } catch (e) {
    console.error("[tg-ask] فشل تكوين الجواب:", e);
    await sendMessage(
      chatId,
      "تعذّر تكوين الجواب: " + (e instanceof Error ? e.message : "خطأ غير معروف"),
    );
  }
}

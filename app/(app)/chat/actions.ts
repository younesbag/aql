"use server";

import { createClient } from "@/lib/supabase/server";
import { orchestrate, type ChatTurn } from "@/lib/agents/orchestrator";
import { getProactiveInsights } from "@/lib/agents/proactive";

// حصن القناة: العقل خلف المصادقة (طبقة ثانية فوق proxy).
async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

// مصدر مبسّط للعرض (لا نُسرّب أنواع طبقة الوصول server-only للعميل).
export type ChatSource = { kind: string; label: string; text: string; ref: string };
// رسالة محادثة: تُمرَّر للسياق وتُخزَّن للاستئناف. المصادر للعرض/التخزين لا للتفكير.
export type ChatMessage = { role: "user" | "model"; text: string; sources?: ChatSource[] };
export type ChatResult = { answer: string; sources: ChatSource[]; conversationId: string | null };
export type ConversationMeta = { id: string; title: string; updatedAt: string };

const MAX_CONVERSATIONS = 5;
type SB = Awaited<ReturnType<typeof createClient>>;

// عنوان المحادثة = أول رسالة مستخدم (مقتطعة) — صفر تكلفة.
function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const t = (first?.text ?? "").replace(/\s+/g, " ").trim();
  return t.slice(0, 60) || "محادثة";
}

// محادثة تيليجرام الواحدة (lib/agents/telegram-ask) — تُعرَّف بعنوانها الحرفي.
const TG_TITLE = "تيليجرام 🧠";

// يُبقي أحدث MAX_CONVERSATIONS محادثة فقط (best-effort).
// محادثة تيليجرام مستثناة من الحذف: هي ذاكرة العقل الجيبي المتصلة، وحذفها
// بخمس محادثات ويب أحدث كان يصفّر سياقها بصمت (إصلاح مراجعة).
async function pruneOld(supabase: SB): Promise<void> {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .neq("title", TG_TITLE)
    .order("updated_at", { ascending: false });
  const extra = (data ?? []).slice(MAX_CONVERSATIONS).map((r) => r.id as string);
  if (extra.length) await supabase.from("conversations").delete().in("id", extra);
}

// يحفظ/يحدّث المحادثة ويقلّم القديم. best-effort: لا يكسر الشات عند فشل التخزين.
async function persistConversation(
  id: string | null,
  messages: ChatMessage[],
): Promise<string | null> {
  try {
    const supabase = await createClient();
    if (id) {
      // العنوان يُشتق عند الإنشاء فقط ولا يُستبدل عند التحديث: أول رسالة مستخدم
      // لا تتغيّر أصلاً (فالسلوك محفوظ)، واستبداله كان يمحو عنوان «تيليجرام 🧠»
      // المميِّز عند استئنافها من الويب فتنشطر لخيطين (إصلاح مراجعة).
      const { data: updated, error } = await supabase
        .from("conversations")
        .update({ messages, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (!error && (updated ?? []).length > 0) {
        await pruneOld(supabase);
        return id;
      }
      // تحديث فشل أو المعرّف لم يعد موجوداً (صفر صفوف) → أنشئ جديداً.
    }
    const { data, error } = await supabase
      .from("conversations")
      .insert({ messages, title: deriveTitle(messages) })
      .select("id")
      .single();
    if (error || !data) return id;
    await pruneOld(supabase);
    return data.id as string;
  } catch {
    return id;
  }
}

// محادثة متصلة عبر «العقل»: المنسّق يوجّه (flash) ويركّب (pro) جواباً مؤرَّضاً، ثم تُحفظ.
export async function chat(
  message: string,
  history: ChatMessage[] = [],
  conversationId: string | null = null,
): Promise<ChatResult> {
  await requireUser();
  // التاريخ للمنسّق نصّ فقط (المصادر للعرض/التخزين لا للتفكير).
  const brainHistory: ChatTurn[] = history.map((m) => ({ role: m.role, text: m.text }));
  const r = await orchestrate(message, brainHistory);
  const sources: ChatSource[] = r.sources.map((s) => ({
    kind: s.kind,
    label: s.label,
    text: s.text,
    ref: s.ref,
  }));

  // خزّن المحادثة الكاملة (مع المصادر) للاستئناف، وقلّم لأحدث ٥.
  const full: ChatMessage[] = [
    ...history,
    { role: "user", text: message },
    { role: "model", text: r.answer, sources },
  ];
  const cid = await persistConversation(conversationId, full);

  return { answer: r.answer, sources, conversationId: cid };
}

// قائمة آخر المحادثات (للمبدّل).
export async function listConversations(): Promise<ConversationMeta[]> {
  await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(MAX_CONVERSATIONS);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    title: (r.title as string) || "محادثة",
    updatedAt: r.updated_at as string,
  }));
}

// تحميل رسائل محادثة للاستئناف.
export async function loadConversation(id: string): Promise<{ messages: ChatMessage[] }> {
  await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("messages")
    .eq("id", id)
    .single();
  const messages = Array.isArray(data?.messages) ? (data.messages as ChatMessage[]) : [];
  return { messages };
}

export type ProactiveInsightView = { insight: string; recommendation: string; basis: string };
export type ProactiveView = { insights: ProactiveInsightView[] };

// ملاحظات استباقية تُعرَض عند فتح الشات (كاش داخلي بمهلة؛ force للتحديث اليدوي).
export async function proactiveInsights(force = false): Promise<ProactiveView> {
  await requireUser();
  const r = await getProactiveInsights(3, force);
  return {
    insights: r.insights.map((i) => ({
      insight: i.insight,
      recommendation: i.recommendation,
      basis: i.basis,
    })),
  };
}

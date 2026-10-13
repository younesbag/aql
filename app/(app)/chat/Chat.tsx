"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  chat,
  listConversations,
  loadConversation,
  proactiveInsights,
  type ChatSource,
  type ConversationMeta,
  type ProactiveInsightView,
} from "./actions";

type Msg = { role: "user" | "model"; text: string; sources?: ChatSource[] };

const BASIS_STYLE: Record<string, string> = {
  نجاح: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  فجوة: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  مزيج: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

export function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [insights, setInsights] = useState<ProactiveInsightView[] | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  // التحليل الاستباقي عند الفتح — غير معطِّل (الشات يعمل فوراً بينما يُحمَّل).
  useEffect(() => {
    let active = true;
    proactiveInsights()
      .then((r) => active && setInsights(r.insights))
      .catch(() => active && setInsights([]))
      .finally(() => active && setInsightsLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // قائمة المحادثات السابقة عند الفتح.
  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  function refreshConversations() {
    listConversations()
      .then(setConversations)
      .catch(() => {});
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || pending) return;
    setError("");
    const history = messages; // كامل (مع المصادر) — الإجراء يجرّدها للمنسّق ويخزّنها كاملةً
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    startTransition(async () => {
      try {
        const res = await chat(q, history, conversationId);
        setMessages((prev) => [...prev, { role: "model", text: res.answer, sources: res.sources }]);
        if (res.conversationId) setConversationId(res.conversationId);
        refreshConversations();
      } catch (err) {
        setError(err instanceof Error ? err.message : "تعذّر تكوين الجواب");
      }
    });
  }

  function selectConversation(id: string) {
    if (id === conversationId || pending) return;
    setError("");
    startTransition(async () => {
      try {
        const { messages: msgs } = await loadConversation(id);
        setMessages(msgs);
        setConversationId(id);
      } catch {
        setError("تعذّر تحميل المحادثة");
      }
    });
  }

  function newConversation() {
    if (pending) return;
    setMessages([]);
    setConversationId(null);
    setError("");
  }

  function refreshInsights() {
    setInsightsLoading(true);
    setInsights(null);
    proactiveInsights(true)
      .then((r) => setInsights(r.insights))
      .catch(() => setInsights([]))
      .finally(() => setInsightsLoading(false));
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
      <div>
        <h1 className="text-xl font-bold">العقل</h1>
        <p className="mt-1 text-sm text-foreground/60">
          اسأل عن أي شيء في عالمك — أفكارك، أداؤك، قراراتك، مشروعك. يجيب من بياناتك ويستشهد، ولا يخترع.
        </p>
      </div>

      {/* مبدّل المحادثات (آخر ٥) */}
      {conversations.length > 0 && (
        <ConversationBar
          conversations={conversations}
          activeId={conversationId}
          onSelect={selectConversation}
          onNew={newConversation}
        />
      )}

      {/* لوحة التحليل الاستباقي */}
      <ProactivePanel
        insights={insights}
        loading={insightsLoading}
        onRefresh={refreshInsights}
        onDiscuss={(ins) => setInput(`أخبرني أكثر عن هذه الملاحظة وكيف أطبّقها: ${ins}`)}
      />

      {/* المحادثة */}
      <div className="mt-6 flex-1 space-y-5">
        {messages.length === 0 && !insightsLoading && (
          <p className="text-sm text-foreground/45">
            ابدأ بسؤال — أو ناقش ملاحظة من الأعلى. مثال: «ما أنماط نجاح محتواي؟» أو «هل هذه المسودة
            تستحق النشر؟».
          </p>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} />
        ))}
        {pending && <p className="text-sm text-foreground/50">يفكّر…</p>}
        <div ref={endRef} />
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <form
        onSubmit={send}
        className="sticky bottom-0 mt-4 flex gap-2 border-t border-foreground/10 bg-background py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="اسأل «العقل»…"
          aria-label="اسأل العقل"
          className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "…" : "أرسل"}
        </button>
      </form>
    </div>
  );
}

function ConversationBar({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <button
        onClick={onNew}
        className={`rounded-md px-2 py-1 text-xs transition ${
          activeId
            ? "border border-foreground/15 hover:bg-foreground/5"
            : "border border-foreground/30 bg-foreground/10 font-medium"
        }`}
      >
        + جديدة
      </button>
      {conversations.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          title={c.title}
          className={`max-w-[11rem] truncate rounded-md px-2 py-1 text-xs transition ${
            c.id === activeId
              ? "bg-foreground/10 font-medium"
              : "border border-foreground/10 hover:bg-foreground/5"
          }`}
        >
          {c.title}
        </button>
      ))}
    </div>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  if (msg.role === "user") {
    return <p className="rounded-lg bg-foreground/5 px-3 py-2 font-medium">{msg.text}</p>;
  }
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{msg.text}</p>
      {msg.sources && msg.sources.length > 0 && (
        <details className="text-xs text-foreground/55">
          <summary className="cursor-pointer">المصادر ({msg.sources.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {msg.sources.map((s, i) => (
              <li key={s.ref + i}>
                <span className="font-medium">[{s.label}]</span> {s.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ProactivePanel({
  insights,
  loading,
  onRefresh,
  onDiscuss,
}: {
  insights: ProactiveInsightView[] | null;
  loading: boolean;
  onRefresh: () => void;
  onDiscuss: (insight: string) => void;
}) {
  if (loading) {
    return (
      <div className="mt-4 rounded-lg border border-foreground/10 p-3 text-sm text-foreground/50">
        يحلّل بياناتك بحثاً عن ملاحظات استباقية…
      </div>
    );
  }
  if (!insights || insights.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4" /> لاحظتُ
        </p>
        <button
          onClick={onRefresh}
          className="text-xs text-foreground/50 transition hover:text-foreground/80"
        >
          تحديث
        </button>
      </div>
      {insights.map((ins, i) => (
        <div key={i} className="rounded-lg border border-foreground/10 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm">{ins.insight}</p>
            {ins.basis && (
              <span
                className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] ${BASIS_STYLE[ins.basis] ?? "bg-foreground/10"}`}
              >
                {ins.basis}
              </span>
            )}
          </div>
          {ins.recommendation && (
            <p className="mt-1.5 text-xs text-foreground/60">↩ {ins.recommendation}</p>
          )}
          <button
            onClick={() => onDiscuss(ins.insight)}
            className="mt-2 text-xs text-foreground/50 transition hover:text-foreground/80"
          >
            ناقشها ←
          </button>
        </div>
      ))}
    </div>
  );
}

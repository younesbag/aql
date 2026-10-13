import "server-only";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embed } from "@/lib/ai/gemini";
import { classifyItem } from "@/lib/ai/classify";

export type RetrievedItem = {
  id: string;
  raw_text: string;
  summary: string | null;
  topic: string | null;
  source_type: string; // idea|signal|voice|tweet|email|message | decision | journal
  created_at: string;
  similarity: number;
};

export type RetrieveResult =
  | { ok: true; data: RetrievedItem[] }
  | { ok: false; error: string };

// ════════════════════════════════════════════════════════════
// الاسترجاع الدلالي الموحّد عبر كل ذاكرة المالك:
//   items (أفكار/أرشيف) + decisions (قرارات) + journal_entries (مراجعات).
// يستدعي الدوال الثلاث بالتوازي، يوحّد شكلها، يدمج، يرتّب بالتشابه، ويقصّ.
// تراجع آمن: إن لم تُشغَّل هجرة 0006 بعد، تُتجاهل القرارات/المذكرة ويبقى البحث
// على الأفكار وحدها — دون كسر.
// يستخدم عميل الجلسة (authenticated) فيحترم RLS؛ المستخدم يرى عناصره فقط.
// ════════════════════════════════════════════════════════════
type ItemRow = {
  id: string;
  raw_text: string;
  summary: string | null;
  topic: string | null;
  source_type: string;
  created_at: string;
  similarity: number;
};
type DecisionRow = {
  id: string;
  situation: string;
  decision: string;
  reasoning: string;
  outcome: string | null;
  was_correct: string | null;
  created_at: string;
  similarity: number;
};
type JournalRow = {
  id: string;
  week_of: string;
  learned: string | null;
  failed: string | null;
  succeeded: string | null;
  changed: string | null;
  created_at: string;
  similarity: number;
};

function mapItem(r: ItemRow): RetrievedItem {
  return {
    id: r.id,
    raw_text: r.raw_text,
    summary: r.summary,
    topic: r.topic,
    source_type: r.source_type,
    created_at: r.created_at,
    similarity: r.similarity,
  };
}

function mapDecision(r: DecisionRow): RetrievedItem {
  const text =
    `موقف: ${r.situation}\nقرار: ${r.decision}\nسبب: ${r.reasoning}` +
    (r.outcome ? `\nنتيجة: ${r.outcome}` : "");
  return {
    id: r.id,
    raw_text: text,
    summary: r.decision,
    topic: null,
    source_type: "decision",
    created_at: r.created_at,
    similarity: r.similarity,
  };
}

function mapJournal(r: JournalRow): RetrievedItem {
  const text = [
    r.learned && `تعلّمت: ${r.learned}`,
    r.failed && `فشل: ${r.failed}`,
    r.succeeded && `نجح: ${r.succeeded}`,
    r.changed && `تغيّر رأيي: ${r.changed}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: r.id,
    raw_text: text,
    summary: `مراجعة أسبوع ${r.week_of}`,
    topic: null,
    source_type: "journal",
    created_at: r.created_at,
    similarity: r.similarity,
  };
}

export async function retrieveRelevant(
  query: string,
  matchCount = 12,
  useAdmin = false,
): Promise<RetrieveResult> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: true, data: [] };

  const emb = await embed(trimmed);
  if (!emb.ok) {
    return { ok: false, error: "تعذّر حساب تضمين الاستعلام: " + emb.error };
  }

  // useAdmin: للسياقات بلا جلسة (webhook تيليجرام) — عميل الإدارة يتجاوز RLS.
  const supabase = useAdmin ? createAdminClient() : await createClient();
  const params = { query_embedding: emb.data, match_count: matchCount };
  const [itemsRes, decRes, jrnRes] = await Promise.all([
    supabase.rpc("match_items", params),
    supabase.rpc("match_decisions", params),
    supabase.rpc("match_journal", params),
  ]);
  if (itemsRes.error) return { ok: false, error: itemsRes.error.message };

  const items = (itemsRes.data ?? []) as ItemRow[];
  // تراجع آمن: لو غابت الدالّتان (هجرة 0006 لم تُشغَّل) نتجاهل القرارات/المذكرة.
  const decisions = decRes.error ? [] : ((decRes.data ?? []) as DecisionRow[]);
  const journal = jrnRes.error ? [] : ((jrnRes.data ?? []) as JournalRow[]);

  const merged: RetrievedItem[] = [
    ...items.map(mapItem),
    ...decisions.map(mapDecision),
    ...journal.map(mapJournal),
  ]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, matchCount);

  // إثراء كسول غير معطِّل (للأفكار فقط — القرارات/المذكرة مُصنّفة بِبنيتها).
  scheduleLazyClassification(merged, supabase);
  return { ok: true, data: merged };
}

// ════════════════════════════════════════════════════════════
// التصنيف الكسول (Lazy Classification): عناصر الأرشيف المستوردة (الملف 05)
// تُخزَّن بـ embedding فقط دون تصنيف. حين يسترجعها البحث وحقولها التصنيفية فارغة،
// تُصنَّف وتُحفظ — لكن **بعد إرسال الاستجابة** (after) وبشكل best-effort:
//  • لا تضيف زمناً إلى استجابة المُستجوِب. • أي فشل يُتجاهل ولا يكسر البحث.
//  • القرارات/المذكرة لها summary دائماً، فلا تمرّ من المرشّح أصلاً.
// ════════════════════════════════════════════════════════════
type ServerClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createAdminClient>;

function scheduleLazyClassification(
  items: RetrievedItem[],
  supabase: ServerClient,
): void {
  const pending = items.filter(
    (i) => i.source_type !== "decision" && i.source_type !== "journal" && !i.topic && !i.summary,
  );
  if (pending.length === 0) return;

  try {
    after(async () => {
      await Promise.all(
        pending.map(async (it) => {
          try {
            const c = await classifyItem(it.raw_text);
            if (!c) return;
            await supabase
              .from("items")
              .update({
                topic: c.topic,
                item_kind: c.item_kind,
                summary: c.summary,
                entities: c.entities,
              })
              .eq("id", it.id);
          } catch {
            // إثراء best-effort — تجاهل أي فشل (لا يؤثّر على نتيجة البحث).
          }
        }),
      );
    });
  } catch {
    // خارج سياق طلب (after غير متاح) — تخطٍّ آمن دون تعطيل البحث.
  }
}

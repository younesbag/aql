import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embed, searchWeb } from "@/lib/ai/gemini";
import { retrieveRelevant } from "@/lib/memory/retrieve";
import { sourceAr } from "@/lib/memory/sourceLabels";

// ════════════════════════════════════════════════════════════
// طبقة الوصول المشتركة — العقل الموحّد (الملف 08، المرحلة ١).
// واجهة واحدة `retrieveContext` تجمع ثلاث قدرات يستخدمها كل وكلاء «العقل»،
// فلا يكرّر أيّ وكيل منطق الوصول:
//   ١) بحث دلالي في كل الذاكرة — يعيد استخدام retrieveRelevant
//      (items + decisions + journal + تصنيف كسول + تراجع آمن).
//   ٢) استعلام أداء مُهيكل على posts عبر أدوات ثابتة بمعاملات —
//      **ممنوع SQL حرّ** (أمان حاسم، قاعدة الملف 08).
//   ٣) بحث حيّ على الويب — يعيد استخدام searchWeb.
// تُرجع سياقاً موحّداً مع مصادره (للاستشهاد — كل جواب يذكر مصدره).
// server-only: يستخدم عميل الجلسة فيحترم RLS (المالك يرى بياناته فقط).
// ════════════════════════════════════════════════════════════

export type SourceKind = "memory" | "performance" | "web";

export type PostMetrics = {
  likes: number;
  reposts: number;
  replies: number;
  bookmarks: number;
  engagement: number; // المجموع
};

// مصدر موحّد قابل للاستشهاد — مهما كانت القدرة التي أنتجته.
export type ContextSource = {
  kind: SourceKind;
  sourceType: string; // memory: idea|tweet|email|decision|journal… · غيرها: performance|web
  label: string; // وسم عربي للعرض/الاستشهاد
  text: string; // النص (مقتطف للحقن أو العرض)
  ref: string; // مُعرّف الاستشهاد (item:<id> / post:<id> / web)
  similarity?: number; // للدلالي
  metrics?: PostMetrics; // للأداء
};

// استعلام أداء مُهيكل — أدوات محدّدة مسبقاً فقط (لا SQL حرّ).
export type PerformanceQuery =
  | { kind: "top"; limit?: number; sinceDays?: number } // الأعلى تفاعلاً
  | { kind: "bottom"; limit?: number; sinceDays?: number } // الأدنى تفاعلاً
  | { kind: "byTopic"; topic?: string; limit?: number }; // الأقرب لموضوع (دلالي ثم أداءً)

export type RetrieveContextOptions = {
  semantic?: boolean; // بحث دلالي في الذاكرة (افتراضي true)
  semanticCount?: number; // عدد نتائج الدلالي (افتراضي 10)
  performance?: PerformanceQuery | null; // استعلام أداء (افتراضي لا شيء)
  web?: boolean; // بحث حيّ (افتراضي false)
};

export type UnifiedContext = {
  sources: ContextSource[];
  block: string; // كتلة نصّية موسومة جاهزة للحقن في برومبت وكيل
};

const DEFAULT_SEMANTIC_COUNT = 10;
const MAX_SEMANTIC_COUNT = 25; // حدّ أقصى — يحمي من إدخال نموذج شاذّ (جلب ثقيل + تصنيف كسول مضخّم)
const DEFAULT_PERF_LIMIT = 6;
const MAX_PERF_LIMIT = 20;

const snippet = (s: string, n = 280): string => s.replace(/\s+/g, " ").trim().slice(0, n);

// ────────────────────────────────────────────────────────────
// القدرة ١: بحث دلالي في الذاكرة (إعادة استخدام retrieveRelevant)
// ────────────────────────────────────────────────────────────
async function queryMemory(
  query: string,
  count: number,
  useAdmin = false,
): Promise<ContextSource[]> {
  const c = Math.max(1, Math.min(count, MAX_SEMANTIC_COUNT));
  const res = await retrieveRelevant(query, c, useAdmin);
  if (!res.ok) return [];
  return res.data.map((r) => ({
    kind: "memory" as const,
    sourceType: r.source_type,
    label: sourceAr(r.source_type),
    text: snippet(r.summary || r.raw_text),
    ref: `item:${r.id}`,
    similarity: r.similarity,
  }));
}

// ────────────────────────────────────────────────────────────
// القدرة ٢: استعلام أداء مُهيكل على posts (أدوات ثابتة بمعاملات — لا SQL حرّ)
// ────────────────────────────────────────────────────────────
type RawPost = {
  id: string;
  draft_text: string;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
};

function toMetrics(p: RawPost): PostMetrics {
  const likes = p.likes ?? 0;
  const reposts = p.reposts ?? 0;
  const replies = p.replies ?? 0;
  const bookmarks = p.bookmarks ?? 0;
  return { likes, reposts, replies, bookmarks, engagement: likes + reposts + replies + bookmarks };
}

export async function queryPerformance(
  q: PerformanceQuery,
  query: string,
  useAdmin = false,
): Promise<ContextSource[]> {
  const supabase = useAdmin ? createAdminClient() : await createClient();
  const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_PERF_LIMIT, MAX_PERF_LIMIT));
  let rows: RawPost[] = [];

  if (q.kind === "byTopic") {
    // الأداء حسب الموضوع = أقرب المنشورات دلالياً (match_posts) ثم الأفضل أداءً بينها.
    const topic = (q.topic ?? query).trim();
    if (topic) {
      const emb = await embed(topic);
      if (emb.ok) {
        const { data } = await supabase.rpc("match_posts", {
          query_embedding: emb.data,
          match_count: Math.max(limit, 12),
        });
        rows = (data ?? []) as RawPost[];
      }
    }
  } else {
    // أعلى/أدنى تفاعلاً: ترتيب أوّلي بالإعجابات (وكيل تقريبي رخيص) ثم فرز نهائي بالمجموع.
    const asc = q.kind === "bottom";
    let sel = supabase
      .from("posts")
      .select("id, draft_text, likes, replies, reposts, bookmarks")
      .eq("status", "published")
      .order("likes", { ascending: asc })
      .limit(100);
    if (q.sinceDays && q.sinceDays > 0) {
      const since = new Date(Date.now() - q.sinceDays * 86_400_000).toISOString();
      sel = sel.gte("published_at", since);
    }
    const { data } = await sel;
    rows = (data ?? []) as RawPost[];
  }

  const desc = q.kind !== "bottom";
  const ranked = rows
    .map((p) => ({ p, m: toMetrics(p) }))
    .sort((a, b) => (desc ? b.m.engagement - a.m.engagement : a.m.engagement - b.m.engagement))
    .slice(0, limit);

  const kindLabel =
    q.kind === "top" ? "الأعلى تفاعلاً" : q.kind === "bottom" ? "الأدنى تفاعلاً" : "الأقرب موضوعاً";

  return ranked.map(({ p, m }) => ({
    kind: "performance" as const,
    sourceType: "performance",
    label: `منشور — ${kindLabel}`,
    text: snippet(p.draft_text),
    ref: `post:${p.id}`,
    metrics: m,
  }));
}

// ────────────────────────────────────────────────────────────
// القدرة ٣: بحث حيّ على الويب (إعادة استخدام searchWeb)
// ────────────────────────────────────────────────────────────
async function queryWeb(query: string): Promise<ContextSource[]> {
  const res = await searchWeb(query);
  if (!res.ok || !res.data.trim()) return [];
  return [
    {
      kind: "web" as const,
      sourceType: "web",
      label: "بحث ويب",
      text: snippet(res.data, 600),
      ref: "web",
    },
  ];
}

// ────────────────────────────────────────────────────────────
// الواجهة الموحّدة: تُشغّل القدرات المطلوبة بالتوازي وتوحّد مصادرها.
// ────────────────────────────────────────────────────────────
export async function retrieveContext(
  query: string,
  options: RetrieveContextOptions = {},
  useAdmin = false,
): Promise<UnifiedContext> {
  const tasks: Promise<ContextSource[]>[] = [];

  if (options.semantic !== false) {
    tasks.push(queryMemory(query, options.semanticCount ?? DEFAULT_SEMANTIC_COUNT, useAdmin));
  }
  if (options.performance) {
    tasks.push(queryPerformance(options.performance, query, useAdmin));
  }
  if (options.web) {
    tasks.push(queryWeb(query));
  }

  const sources = (await Promise.all(tasks)).flat();

  const block = sources
    .map((s) => {
      const sim = s.similarity != null ? ` · تشابه ${s.similarity.toFixed(2)}` : "";
      const eng = s.metrics ? ` · تفاعل ${s.metrics.engagement}` : "";
      return `[${s.label}${sim}${eng}] ${s.text}`;
    })
    .join("\n\n");

  return { sources, block };
}

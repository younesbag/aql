import "server-only";
import { EMBED_DIM } from "@/lib/ai/gemini";
import { claudeJson, type SystemBlock } from "@/lib/ai/anthropic";
import { createClient } from "@/lib/supabase/server";
import type { PublishingAnalysis } from "@/lib/content/analyze";
import {
  buildDirectivesBlock,
  hasDirectives,
  type Directives,
} from "@/lib/content/overrides";
import { getCalibration, calibrationLine } from "@/lib/content/calibration";
import { getPatternAggregates, provenPatternsLine } from "@/lib/content/patterns";
// تركيب البرومبتات انتقل لوحدة نقية مشتركة مع عامل الجلسة (الملف 16) —
// مصدر حقيقة واحد للنصوص؛ هذا الملف يبقى بوابة مسار API (الطوارئ المباشر).
import {
  loadWriterSystem,
  buildSp2UserContent,
  buildCritiquePromptText,
  type PostExample,
  type QualityScore,
  type GeneratedDraft,
  type TastePair,
} from "@/lib/content/prompt-builder";

export type { QualityScore, GeneratedDraft };

export type GenerateResult =
  | { ok: true; data: GeneratedDraft }
  | { ok: false; error: string };

// كتلة نظام مخزّنة (كاش بادئة) — الأساس الثابت وحده. ملاحظة: توليد المسودة وحلقة
// النقد يستخدمان مخططَي Structured Outputs مختلفين (SP2 مقابل SP2+critique)،
// ومخطط الإخراج يُصاغ قبل system في ترتيب البادئة — فلا يتشارك النداءان كاشاً
// فعلياً رغم تطابق هذا النصّ حرفياً (مؤكَّد بتشخيص حيّ). يبقى cache_control مفيداً
// عند إعادة تشغيل نفس الدالة (نفس المخطط) — كإعادة توليد مسودة بنفس المدخل.
async function loadSystemBlocks(): Promise<SystemBlock[]> {
  return [{ text: await loadWriterSystem(), cache: true }];
}

// مخططات JSON (Structured Outputs) — Claude Sonnet 5 لا يدعم prefill، فهذا مسار
// المخرج المنظّم الرسمي. كل الحقول required (nullable حيث لا قيمة طبيعية دائماً —
// خاصة حالة الرفض: draft:null + error/suggestion، وبقية الحقول null دون قراءتها).
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});

const QUALITY_SCORE_SCHEMA = {
  type: "object",
  properties: {
    hook_power: { type: "number" },
    linguistic_authenticity: { type: "number" },
    simplified_depth: { type: "number" },
    practical_value: { type: "number" },
    flow: { type: "number" },
    empowerment: { type: "number" },
    uniqueness: { type: "number" },
    overall: { type: "number" },
  },
  required: [
    "hook_power",
    "linguistic_authenticity",
    "simplified_depth",
    "practical_value",
    "flow",
    "empowerment",
    "uniqueness",
    "overall",
  ],
  additionalProperties: false,
} as const;

const HOOK_TESTS_SCHEMA = {
  type: "object",
  properties: {
    seven_words: { type: "boolean" },
    screenshot: { type: "boolean" },
    debate: { type: "boolean" },
    specificity: { type: "boolean" },
    human: { type: "boolean" },
  },
  required: ["seven_words", "screenshot", "debate", "specificity", "human"],
  additionalProperties: false,
} as const;

const ANTI_REPETITION_SCHEMA = {
  type: "object",
  properties: {
    hook_pattern: { type: "string" },
    hook_tier: { type: "string", enum: ["S", "A", "B"] },
    opening_type: {
      type: "string",
      enum: ["question", "bold_claim", "story", "statistic", "command", "paradox", "challenge"],
    },
    first_five_words: { type: "string" },
  },
  required: ["hook_pattern", "hook_tier", "opening_type", "first_five_words"],
  additionalProperties: false,
} as const;

// ملاحظة: حدّ أنثروبيك ١٦ حقلاً nullable/union كحدّ أقصى لكل مخطط (كلفة ترجمة أُسّية
// فوقه). nullable فقط للحاجة الدلالية الحقيقية: إشارة الرفض (draft/error/suggestion)،
// الاختيارية الأصلية في عقد SP2 (lead_magnet/cta_keyword/freshness_note)، والكائنات
// المركّبة غير المعنية عند الرفض (quality_score/hook_tests_passed/anti_repetition) —
// ٩ حقول. البقية غير nullable بقيم افتراضية آمنة (الكود لا يقرؤها أصلاً حين draft=null).
const SP2_PROPERTIES = {
  draft: nullable({ type: "string" }),
  hook_text: { type: "string" },
  content_type: { type: "string", enum: ["THREAD", "LONG_TWEET", "MEDIUM_TWEET"] },
  original_content_type: { type: "string", enum: ["thread", "tweet"] },
  cta_type: { type: "string", enum: ["premium", "short", "none"] },
  lead_magnet: nullable({ type: "string" }),
  cta_keyword: nullable({ type: "string" }),
  hashtags: { type: "string" },
  tweet_count: { type: "integer" },
  quality_score: nullable(QUALITY_SCORE_SCHEMA),
  hook_tests_passed: nullable(HOOK_TESTS_SCHEMA),
  anti_repetition: nullable(ANTI_REPETITION_SCHEMA),
  freshness_flag: { type: "boolean" },
  freshness_note: nullable({ type: "string" }),
  improvement_notes: { type: "string" },
  error: nullable({ type: "string" }),
  suggestion: nullable({ type: "string" }),
} as const;

const SP2_SCHEMA = {
  type: "object",
  properties: SP2_PROPERTIES,
  required: Object.keys(SP2_PROPERTIES),
  additionalProperties: false,
} as const;

const SP2_CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    ...SP2_PROPERTIES,
    critique: {
      type: "object",
      properties: {
        weakest: { type: "array", items: { type: "string" } },
        changes: { type: "string" },
      },
      required: ["weakest", "changes"],
      additionalProperties: false,
    },
  },
  required: [...Object.keys(SP2_PROPERTIES), "critique"],
  additionalProperties: false,
} as const;

const SEMANTIC_POOL = 12; // عدد الأقرب دلالياً قبل إعادة ترتيبهم بالأداء

type PostRow = {
  draft_text: unknown;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
};

function rankByEngagement(rows: PostRow[], limit: number): PostExample[] {
  return rows
    .map((p) => ({
      draft_text: String(p.draft_text),
      eng:
        (p.likes ?? 0) + (p.reposts ?? 0) + (p.replies ?? 0) + (p.bookmarks ?? 0),
    }))
    .sort((a, b) => b.eng - a.eng)
    .slice(0, limit);
}

// أمثلة احتذاء أداءً (لا أفكار خام). الترقية (match_posts): تختار الأقرب دلالياً
// للفكرة الحالية ثم الأفضل أداءً بينها — بدل «الأفضل عالمياً» (نفسها لكل فكرة).
// المصدر status='published' (أرشيف بإعجابات/ريتويت + مُدخَل يدويّاً بأرقامه). مع غياب
// متجه الفكرة أو قبل تشغيل هجرة 0008 → تراجع آمن للأفضل أداءً عالمياً (السلوك القديم).
export async function getBestPostExamples(
  limit = 4,
  queryEmbedding?: number[] | null,
): Promise<PostExample[]> {
  const supabase = await createClient();

  // المسار الدلالي (الترقية): أقرب SEMANTIC_POOL دلالياً ثم الأفضل أداءً بينها.
  if (queryEmbedding && queryEmbedding.length === EMBED_DIM) {
    const { data, error } = await supabase.rpc("match_posts", {
      query_embedding: queryEmbedding,
      match_count: SEMANTIC_POOL,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      return rankByEngagement(data as PostRow[], limit);
    }
    // خطأ (0008 لم تُشغّل بعد) أو لا نتائج → تابع للمسار الاحتياطي.
  }

  // المسار الاحتياطي: الأفضل أداءً عالمياً.
  const { data } = await supabase
    .from("posts")
    .select("draft_text, likes, replies, reposts, bookmarks")
    .eq("status", "published")
    .order("likes", { ascending: false })
    .limit(100);
  return rankByEngagement((data ?? []) as PostRow[], limit);
}

// آخر النشرات البريدية (الملف 14 — البند ٣): كي لا يكرّر ثريدٌ زاويةَ نشرةٍ حديثة
// حرفياً. عناوين/أفكار فقط — العدد صغير فلا حاجة لبحث دلالي.
export async function getRecentNewsletterLines(limit = 3): Promise<string[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("newsletters")
      .select("subject, idea")
      .in("status", ["draft", "final"])
      .order("updated_at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as { subject: string | null; idea: string | null }[])
      .map((n) => (n.subject || n.idea || "").replace(/\s+/g, " ").trim().slice(0, 90))
      .filter(Boolean);
  } catch {
    return []; // إثراء اختياري — فشله لا يمسّ التوليد
  }
}

// أزواج معايرة الذوق (الملف 19): أعلى سلطة أسلوبية تُحقن في المدخل.
// السقف 4 (رُفع من 2 بقرار المالك 2026-08-11 بعد أن دفع زوجٌ جديد زوجاً ذهبياً
// خارج النافذة): كلفته ~6 آلاف حرف على مدخل 13 ألفاً — هامش آمن جداً ضمن
// نافذة النموذج، وعائده أعلى إشارة أسلوبية في المدخل كله.
// best-effort: فشل الجلب لا يمنع التوليد.
export async function getTastePairs(limit = 6): Promise<TastePair[]> {
  try {
    const supabase = await createClient();
    // نجلب أكثر من السقف ثم نرتّب بأولوية الدرس: زوج بلا درس يترك النموذج
    // يستنتج الفرق بنفسه، فلا يزاحم زوجاً يحمل خلاصته منصوصة (اكتُشف 2026-08-12:
    // زوج بلا درس كان يحتل مقعداً ويُخرج زوجاً ذهبياً بدرسه).
    const { data } = await supabase
      .from("taste_pairs")
      .select("idea_text, rejected_draft, preferred_draft, lesson, created_at")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 3, 12));
    const rows = (data ?? []) as (TastePair & { created_at: string })[];
    return rows
      .sort((a, b) => {
        const la = a.lesson && a.lesson.trim() ? 1 : 0;
        const lb = b.lesson && b.lesson.trim() ? 1 : 0;
        if (la !== lb) return lb - la; // ذوات الدرس أولاً
        return b.created_at.localeCompare(a.created_at); // ثم الأحدث
      })
      .slice(0, limit)
      .map(({ idea_text, rejected_draft, preferred_draft, lesson }) => ({
        idea_text,
        rejected_draft,
        preferred_draft,
        lesson,
      }));
  } catch {
    return [];
  }
}

// التركيب النصّي نفسه في الوحدة النقية (prompt-builder) — هنا فقط تحويل
// كائن التوجيهات إلى كتلته النصية قبل التمرير (الإضافة ١ تتصدّر المدخل).
function buildUserContent(
  analysis: PublishingAnalysis,
  examples: PostExample[],
  directives?: Directives,
  searchResults?: string | null,
  calibration?: string | null,
  provenPatterns?: string | null,
  recentNewsletters?: string[],
  rawText?: string | null,
  tastePairs?: TastePair[],
): string {
  const dirBlock =
    directives && hasDirectives(directives) ? buildDirectivesBlock(directives) : "";
  return buildSp2UserContent(
    analysis as unknown as Record<string, unknown>,
    examples,
    dirBlock,
    searchResults,
    calibration,
    provenPatterns,
    recentNewsletters,
    rawText,
    tastePairs,
  );
}

// يولّد مسودة واحدة احترافية من المدخل الغني عبر محرّك SP2 (systemInstruction).
// directives (اختياري): توجيهات المستخدم الإلزامية (النوع/الحجم/CTA) — الإضافة ١.
export async function generateDraft(
  analysis: PublishingAnalysis,
  directives?: Directives,
  searchResults?: string | null,
  queryEmbedding?: number[] | null,
  rawText?: string | null,
): Promise<GenerateResult> {
  const [system, examples, calibration, patterns, recentNl, tastePairs] = await Promise.all([
    loadSystemBlocks(),
    getBestPostExamples(4, queryEmbedding),
    // الكتل best-effort: فشل أيّها لا يمنع التوليد (null/[] = لا كتلة).
    getCalibration().catch(() => null),
    getPatternAggregates().catch(() => null),
    getRecentNewsletterLines(),
    getTastePairs(),
  ]);

  const res = await claudeJson(
    buildUserContent(
      analysis,
      examples,
      directives,
      searchResults,
      calibration ? calibrationLine(calibration) : null,
      patterns ? provenPatternsLine(patterns) : null,
      recentNl,
      rawText,
      tastePairs,
    ),
    system,
    { schema: SP2_SCHEMA, effort: "xhigh", maxTokens: 32000 },
  );
  if (!res.ok) return { ok: false, error: res.error };

  try {
    const p = JSON.parse(res.data) as Record<string, unknown>;
    // حالة الرفض من المحرّك: { draft: null, error, suggestion }
    if (typeof p.draft !== "string" || !p.draft.trim()) {
      const err =
        typeof p.error === "string" ? p.error : "رفض المحرّك توليد مسودة.";
      return { ok: false, error: err };
    }
    const qs = p.quality_score as Record<string, unknown> | undefined;
    return {
      ok: true,
      data: {
        draft: p.draft,
        hook_text: typeof p.hook_text === "string" ? p.hook_text : "",
        content_type:
          typeof p.content_type === "string" ? p.content_type : "THREAD",
        cta_type: typeof p.cta_type === "string" ? p.cta_type : "none",
        quality_score:
          qs && typeof qs.overall === "number"
            ? (qs as unknown as QualityScore)
            : null,
        hook_tests_passed:
          p.hook_tests_passed && typeof p.hook_tests_passed === "object"
            ? (p.hook_tests_passed as Record<string, boolean>)
            : null,
        improvement_notes:
          typeof p.improvement_notes === "string" ? p.improvement_notes : "",
      },
    };
  } catch {
    return { ok: false, error: "تعذّر قراءة مخرج المحرّك." };
  }
}

// ════════════════════════════════════════════════════════════
// حلقة النقد والتحسين (الإضافة ٣): نداء Pro ثانٍ بدور ناقد صارم مستقل.
// يقيّم المسودة مقابل مصفوفة الجودة، يحدّد أضعف معيارين، يعيد كتابة الضعيف فقط،
// ويُخرج النسخة المحسّنة + الدرجة النهائية. حلقة واحدة. مع الفشل تُرجع الأصل.
// ════════════════════════════════════════════════════════════
function buildCritiquePrompt(
  draft: GeneratedDraft,
  analysis: PublishingAnalysis,
  rawText?: string | null,
): string {
  // النص نفسه في الوحدة النقية — مشترك مع عامل الجلسة.
  return buildCritiquePromptText(
    draft.draft,
    analysis as unknown as Record<string, unknown>,
    rawText,
  );
}

export async function critiqueAndImprove(
  draft: GeneratedDraft,
  analysis: PublishingAnalysis,
  rawText?: string | null,
): Promise<GeneratedDraft> {
  const system = await loadSystemBlocks();
  const res = await claudeJson(buildCritiquePrompt(draft, analysis, rawText), system, {
    schema: SP2_CRITIQUE_SCHEMA,
    effort: "xhigh",
    maxTokens: 32000,
  });
  if (!res.ok) return draft; // فشل النقد → أعد الأصل دون كسر

  try {
    const p = JSON.parse(res.data) as Record<string, unknown>;
    if (typeof p.draft !== "string" || !p.draft.trim()) return draft;
    const qs = p.quality_score as Record<string, unknown> | undefined;
    const crit = p.critique as Record<string, unknown> | undefined;
    return {
      draft: p.draft,
      hook_text: typeof p.hook_text === "string" ? p.hook_text : draft.hook_text,
      content_type:
        typeof p.content_type === "string" ? p.content_type : draft.content_type,
      cta_type: typeof p.cta_type === "string" ? p.cta_type : draft.cta_type,
      quality_score:
        qs && typeof qs.overall === "number"
          ? (qs as unknown as QualityScore)
          : draft.quality_score,
      hook_tests_passed:
        p.hook_tests_passed && typeof p.hook_tests_passed === "object"
          ? (p.hook_tests_passed as Record<string, boolean>)
          : draft.hook_tests_passed,
      improvement_notes:
        typeof p.improvement_notes === "string"
          ? p.improvement_notes
          : draft.improvement_notes,
      critique: {
        before_overall: draft.quality_score?.overall ?? 0,
        weakest:
          crit && Array.isArray(crit.weakest) ? crit.weakest.map(String) : [],
        changes: crit && typeof crit.changes === "string" ? crit.changes : "",
      },
    };
  } catch {
    return draft;
  }
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyItem } from "@/lib/ai/classify";
import { embed } from "@/lib/ai/gemini";
import { OWNER_TZ } from "@/lib/config/owner";

// أنواع المصدر المسموح بها (مطابقة لـ schema.sql: source_type).
export type SourceType =
  | "idea"
  | "voice"
  | "signal"
  | "tweet"
  | "email"
  | "message";

export type ProcessedItem = {
  id: string;
  classified: boolean;
  embedded: boolean;
  topic?: string;
  summary?: string;
  // أقرب فكرة سابقة مشابهة (الملف 13 — البند ٦): الذاكرة تردّ لحظة الالتقاط.
  similar?: { snippet: string; date: string; similarity: number };
};

// عتبة «تشبه فكرة سابقة» — أعلى من عتبة الاسترجاع العادي عمداً: نريد التوأم
// الحقيقي لا مجرّد قرابة موضوع، وإلا صار السطر ضجيجاً مع كل التقاط.
const SIMILAR_THRESHOLD = 0.85;

type SimilarRow = { id: string; raw_text: string; summary: string | null; created_at: string; similarity: number };

// يبحث عن أقرب فكرة سابقة للتضمين المحسوب لتوّه — نداء RPC واحد، صفر ذكاء.
// best-effort: أي فشل يُتجاهل (السطر إثراء للردّ لا شرط له).
async function findSimilarItem(
  supabase: ReturnType<typeof createAdminClient>,
  embedding: number[],
  selfId: string,
): Promise<ProcessedItem["similar"]> {
  try {
    const { data } = await supabase.rpc("match_items", {
      query_embedding: embedding,
      match_count: 3, // الذات + مرشّحان — يكفي لأول مطابق غير الذات
    });
    const rows = (data ?? []) as SimilarRow[];
    const hit = rows.find((r) => r.id !== selfId && r.similarity >= SIMILAR_THRESHOLD);
    if (!hit) return undefined;
    const raw = (hit.summary || hit.raw_text || "").replace(/\s+/g, " ").trim();
    return {
      snippet: raw.length <= 80 ? raw : raw.slice(0, 80).trim() + "…",
      date: new Intl.DateTimeFormat("ar", {
        timeZone: OWNER_TZ,
        day: "numeric",
        month: "long",
      }).format(new Date(hit.created_at)),
      similarity: hit.similarity,
    };
  } catch (e) {
    console.error("[capture] فشل بحث التشابه:", e);
    return undefined;
  }
}

// ════════════════════════════════════════════════════════════
// العقل المشترك للالتقاط — يُكتب مرة واحدة، وتستخدمه كل القنوات.
// محايد للقناة عمداً: يستخدم عميل الإدارة (service_role) لا جلسة المتصفح،
// كي يعمل من واجهة النظام (جلسة مستخدم) ومن webhook تيليجرام (بلا جلسة) سواءً.
// كل قناة تتحقّق عند بابها، ثم تستدعي هذه الدالة فقط — لا تكرار للمنطق.
// ════════════════════════════════════════════════════════════
export async function processIncomingItem(
  text: string,
  sourceType: SourceType,
  sourceUrl?: string,
): Promise<ProcessedItem> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("النص فارغ — لا شيء لالتقاطه.");

  const supabase = createAdminClient();

  // 1) احفظ الخام فوراً (status='new') قبل أي نداء ذكاء — حتى لا تُفقد الفكرة.
  const { data: inserted, error: insertErr } = await supabase
    .from("items")
    .insert({
      raw_text: trimmed,
      source_type: sourceType,
      source_url: sourceUrl ?? null,
      origin: "manual",
      status: "new",
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    throw new Error(
      "فشل حفظ العنصر الخام: " + (insertErr?.message ?? "غير معروف"),
    );
  }
  const id = inserted.id as string;

  // 2+3) صنّف واحسب embedding بالتوازي (مباشر، بلا طوابير).
  const [classification, embedding] = await Promise.all([
    classifyItem(trimmed),
    embed(trimmed),
  ]);

  // 4) حدّث بما نجح فقط. إن فشل الاثنان يبقى العنصر خاماً (status='new').
  const updates: Record<string, unknown> = {};
  if (classification) {
    updates.topic = classification.topic;
    updates.item_kind = classification.item_kind;
    updates.summary = classification.summary;
    updates.entities = classification.entities;
  }
  if (embedding.ok) {
    updates.embedding = embedding.data;
  }
  if (Object.keys(updates).length > 0) {
    await supabase.from("items").update(updates).eq("id", id);
  }

  // صدى الذاكرة (الملف 13 — البند ٦): التضمين محسوب لتوّه — نداء مطابقة واحد
  // يكشف التوأم السابق فيصير الردّ «تشبه فكرة من ١٢ مايو…» بدل صمت صندوق البريد.
  const similar = embedding.ok
    ? await findSimilarItem(supabase, embedding.data, id)
    : undefined;

  return {
    id,
    classified: classification !== null,
    embedded: embedding.ok,
    topic: classification?.topic,
    summary: classification?.summary,
    similar,
  };
}

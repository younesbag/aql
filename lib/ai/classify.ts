import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { flashJson } from "@/lib/ai/gemini";
import { OWNER_NAME } from "@/lib/config/owner";

// أنواع العنصر الخمسة (مطابقة لـ schema.sql: item_kind).
export const ITEM_KINDS = [
  "insight",
  "story",
  "comparison",
  "question",
  "observation",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type Classification = {
  topic: string;
  item_kind: ItemKind;
  summary: string;
  entities: string[];
};

// يُحقن data/context.md في البرومبت لتوحيد أسماء الكيانات. يُقرأ مرة ويُخزّن.
let _contextCache: string | null = null;
async function loadContext(): Promise<string> {
  if (_contextCache !== null) return _contextCache;
  try {
    _contextCache = await readFile(
      path.join(process.cwd(), "data", "context.md"),
      "utf8",
    );
  } catch {
    _contextCache = ""; // إن تعذّرت القراءة لا نُسقط التصنيف، نكمل بلا حقن.
  }
  return _contextCache;
}

function buildPrompt(text: string, context: string): string {
  return `أنت مُصنّف محتوى لنظام «عقل ${OWNER_NAME}». مهمتك تصنيف عنصر خام (فكرة/إشارة/ملاحظة) أدخله ${OWNER_NAME}.

استعن بمرجع الكيانات التالي لتوحيد التسميات (مثلاً «Claude» و«كلود» = «كلود»):
---
${context}
---

صنّف النص التالي وأعد JSON فقط بهذه الحقول حصراً:
- "topic": الموضوع الرئيسي بالعربية (كلمتان إلى أربع كلمات).
- "item_kind": واحدة فقط من: insight | story | comparison | question | observation.
- "summary": الفكرة الجوهرية في جملة عربية واحدة.
- "entities": مصفوفة بأسماء الكيانات المذكورة موحّدة حسب المرجع، أو مصفوفة فارغة.

النص:
"""
${text}
"""`;
}

// يصنّف نصاً عبر نداء Gemini Flash واحد. يُرجع التصنيف أو null عند أي فشل.
export async function classifyItem(text: string): Promise<Classification | null> {
  const context = await loadContext();
  const res = await flashJson(buildPrompt(text, context));
  if (!res.ok) return null;
  try {
    const p = JSON.parse(res.data) as Partial<Classification>;
    if (
      typeof p.topic !== "string" ||
      typeof p.summary !== "string" ||
      typeof p.item_kind !== "string" ||
      !ITEM_KINDS.includes(p.item_kind as ItemKind) ||
      !Array.isArray(p.entities)
    ) {
      return null; // شكل غير صالح → نعتبره فشل تصنيف
    }
    return {
      topic: p.topic,
      item_kind: p.item_kind as ItemKind,
      summary: p.summary,
      entities: p.entities.map((e) => String(e)),
    };
  } catch {
    return null;
  }
}

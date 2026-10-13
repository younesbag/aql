// أدوات مشتركة لوكلاء العقل الموحّد (الملف 08) — تُزيل التكرار بين الوحدات.
// دوال نقية (بلا تبعية خادم)؛ تستوردها specialists / proactive / orchestrator.
import type { ContextSource } from "@/lib/agents/access";

/** تفكيك JSON بأمان (مخرجات proJson) — يُرجع null عند الفشل.
 *  يفكّ تغليف المصفوفة دفاعياً: Gemini قد يُرجع [{...}] رغم طلب كائن مفرد.
 *  كل مستدعي هذه الدالة يتوقّع جذراً كائناً، فالفكّ آمن ولا يخسر بيانات. */
export function parseJson<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return (parsed[0] ?? null) as T | null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** إزالة تكرار المصادر بمُعرّف الاستشهاد (ref) مع حفظ الترتيب. */
export function dedupeSources(sources: ContextSource[]): ContextSource[] {
  const seen = new Set<string>();
  const out: ContextSource[] = [];
  for (const s of sources) {
    if (seen.has(s.ref)) continue;
    seen.add(s.ref);
    out.push(s);
  }
  return out;
}

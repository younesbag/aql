// ════════════════════════════════════════════════════════════
// ملف الإعداد الشخصي data/profile.json — مصدر الحقيقة الوحيد لأربع سمات تخصّ المالك:
// ركائز المحتوى · شرائح الجمهور · اللهجة · يوم المراجعة الأسبوعية.
// شقيق lib/config/owner.ts (الهوية والتوقيت من البيئة)؛ هذا الملف لما يخصّ المحتوى.
//
// لماذا استيراد JSON لا fs: هذه الوحدة تعمل في ثلاثة أماكن — خادم Next وعميله (الواجهة
// تعرض تسميات الركائز والشرائح) وعامل الـVPS (node بتجريد الأنواع). `fs` محظور على العميل،
// واستيراد JSON بسمة `with { type: "json" }` يضمّنه بنّاء Next في الحزمة ويقرؤه node مباشرة.
// المسار نسبي صريح (لا @/) والامتداد صريح لأن العامل لا يفهم أسماء المسار.
// الثمن: تعديل الملف يتطلب إعادة بناء/نشر (تماماً كأي ملف في data/) — وهو مقبول لقرار نادر التغيّر.
//
// التحقق عند التحميل وبصوت عالٍ: ملف غير صالح يرمي خطأً عربياً يسمّي الحقل المعيب — إعداد جوهري
// لا يُتجاوز بصمت (القاعدة نفسها: النداء الجوهري يفشل بصوت عالٍ).
// وحدة نقية: بلا server-only وبلا fs وبلا Next.
// ════════════════════════════════════════════════════════════
import rawProfile from "../../data/profile.json" with { type: "json" };

export type Pillar = { key: string; label: string };
export type Persona = { key: string; label: string; description: string };
export type DensityRange = readonly [number, number];
export type Dialect = {
  name: string;
  markers: string[];
  density: { default: DensityRange; sales: DensityRange } | null;
};
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Profile = {
  pillars: Pillar[];
  personas: Persona[];
  dialect: Dialect;
  weeklyReviewDay: Weekday;
};

/** معرّف الشريحة العامة — يُضاف دائماً من الكود ولا يُعرَّف في الملف. */
export const GENERAL_PERSONA_KEY = "general";
const GENERAL_PERSONA: Persona = {
  key: GENERAL_PERSONA_KEY,
  label: "عام",
  description: "أمثلة عامة حين لا تتضح الشريحة المستهدفة",
};

// نفس صيغة قيد CHECK في الهجرة 0002 (posts_content_pillar_chk) — يجب أن يبقيا متطابقين.
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

function bad(field: string, why: string): never {
  throw new Error(`ملف الإعداد data/profile.json غير صالح — الحقل «${field}»: ${why}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqText(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) bad(field, "نصّ مطلوب غير فارغ.");
  return v.trim();
}

function reqKey(v: unknown, field: string): string {
  const key = reqText(v, field);
  if (!KEY_RE.test(key)) {
    bad(field, `«${key}» غير صالح — حروف لاتينية صغيرة وأرقام وشرطة سفلية فقط، يبدأ بحرف، من 2 إلى 40 خانة.`);
  }
  return key;
}

function parseRange(v: unknown, field: string): DensityRange {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    typeof v[0] !== "number" ||
    typeof v[1] !== "number" ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1]) ||
    v[0] < 0 ||
    v[0] > v[1]
  ) {
    bad(field, "يجب أن يكون نطاقاً [أدنى, أقصى] برقمين غير سالبين وأدناه ≤ أقصاه، مثل [3, 5].");
  }
  return [v[0], v[1]];
}

/** يتحقق من الملف الخام ويعيد الإعداد منقّحاً. يرمي خطأً عربياً يسمّي الحقل المعيب. */
export function parseProfile(raw: unknown): Profile {
  if (!isObj(raw)) bad("(الجذر)", "يجب أن يكون كائناً.");

  // ── الركائز ──
  const rp = raw.pillars;
  if (!Array.isArray(rp)) bad("pillars", "يجب أن تكون قائمة.");
  if (rp.length < 2 || rp.length > 8) bad("pillars", `عدد الركائز بين 2 و8 (الحالي ${rp.length}).`);
  const pillarKeys = new Set<string>();
  const pillars: Pillar[] = rp.map((p, i) => {
    if (!isObj(p)) bad(`pillars[${i}]`, "يجب أن يكون كائناً {key, label}.");
    const key = reqKey(p.key, `pillars[${i}].key`);
    if (pillarKeys.has(key)) bad(`pillars[${i}].key`, `«${key}» مكرّر.`);
    pillarKeys.add(key);
    return { key, label: reqText(p.label, `pillars[${i}].label`) };
  });

  // ── الشرائح ──
  const rs = raw.personas;
  if (!Array.isArray(rs)) bad("personas", "يجب أن تكون قائمة.");
  if (rs.length < 1 || rs.length > 7) bad("personas", `عدد الشرائح بين 1 و7 (الحالي ${rs.length}).`);
  const personaKeys = new Set<string>();
  const personas: Persona[] = rs.map((p, i) => {
    if (!isObj(p)) bad(`personas[${i}]`, "يجب أن يكون كائناً {key, label, description}.");
    const key = reqKey(p.key, `personas[${i}].key`);
    if (key === GENERAL_PERSONA_KEY) {
      bad(`personas[${i}].key`, "«general» محجوز — يضيفه النظام تلقائياً.");
    }
    if (personaKeys.has(key)) bad(`personas[${i}].key`, `«${key}» مكرّر.`);
    personaKeys.add(key);
    return {
      key,
      label: reqText(p.label, `personas[${i}].label`),
      description: reqText(p.description, `personas[${i}].description`),
    };
  });

  // ── اللهجة ──
  const rd = raw.dialect;
  if (!isObj(rd)) bad("dialect", "يجب أن يكون كائناً {name, markers, density}.");
  const name = reqText(rd.name, "dialect.name");
  if (!Array.isArray(rd.markers)) {
    bad("dialect.markers", "يجب أن تكون قائمة نصوص (فارغة إن لم يُرد القياس).");
  }
  const markers = rd.markers.map((m, i) => reqText(m, `dialect.markers[${i}]`));
  let density: Dialect["density"] = null;
  if (rd.density !== null && rd.density !== undefined) {
    if (!isObj(rd.density)) {
      bad("dialect.density", "يجب أن تكون null أو كائناً {default: [أدنى, أقصى], sales: [أدنى, أقصى]}.");
    }
    density = {
      default: parseRange(rd.density.default, "dialect.density.default"),
      sales: parseRange(rd.density.sales, "dialect.density.sales"),
    };
  }

  // ── يوم المراجعة ──
  const day = raw.weeklyReviewDay;
  if (typeof day !== "string" || !(WEEKDAYS as readonly string[]).includes(day)) {
    bad("weeklyReviewDay", `يجب أن يكون واحداً من: ${WEEKDAYS.join(" · ")}.`);
  }

  return { pillars, personas, dialect: { name, markers, density }, weeklyReviewDay: day as Weekday };
}

// يُحمَّل ويُتحقَّق عند أول استيراد — فشله يوقف البناء/التشغيل برسالة تسمّي الحقل.
export const PROFILE: Profile = parseProfile(rawProfile as unknown);

// ───────────── الركائز ─────────────
export const PILLARS: readonly Pillar[] = PROFILE.pillars;
export const PILLAR_KEYS: readonly string[] = PILLARS.map((p) => p.key);
/** الركيزة الاحتياطية حين يعيد النموذج قيمة خارج القائمة = الأولى في الملف. */
export const FALLBACK_PILLAR: string = PILLARS[0].key;
export function isPillarKey(v: unknown): v is string {
  return typeof v === "string" && PILLAR_KEYS.includes(v);
}
/** تسمية عربية للركيزة؛ مفتاح قديم لم يعد في الملف يُعرض كما هو بدل أن يختفي. */
export function pillarLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return PILLARS.find((p) => p.key === key)?.label ?? key;
}

// ───────────── الشرائح ─────────────
/** الشرائح المعرّفة في الملف (بلا general). */
export const PERSONAS: readonly Persona[] = PROFILE.personas;
/** الشرائح + general في الآخر — لمخططات الإخراج وقوائم التحقق. */
export const PERSONAS_WITH_GENERAL: readonly Persona[] = [...PERSONAS, GENERAL_PERSONA];
export const PERSONA_KEYS: readonly string[] = PERSONAS_WITH_GENERAL.map((p) => p.key);
export function personaLabel(key: string | null | undefined): string {
  if (!key) return "—";
  return PERSONAS_WITH_GENERAL.find((p) => p.key === key)?.label ?? key;
}

// ───────────── اللهجة ─────────────
export const DIALECT: Dialect = PROFILE.dialect;
/** القياس الرقمي يعمل فقط حين يوجد معجم **و**نطاق معاً؛ غير ذلك لا تُعرض أرقام للنموذج أبداً. */
export const DIALECT_MEASURED: boolean = DIALECT.markers.length > 0 && DIALECT.density !== null;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
function arNum(n: number): string {
  return String(n).replace(".", "٫").replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
}
/** نطاق بالأرقام الهندية كما تكتبه البرومبتات، مثل «٣–٥» أو «٥–٦٫٥». */
export function formatRange(r: DensityRange): string {
  return `${arNum(r[0])}–${arNum(r[1])}`;
}
/** منتصف النطاق — لتحويله إلى عدد لمسات مطلوب في نصّ بطول معلوم. */
export function rangeMid(r: DensityRange): number {
  return (r[0] + r[1]) / 2;
}

// ───────────── يوم المراجعة الأسبوعية ─────────────
export const WEEKLY_REVIEW_DAY: Weekday = PROFILE.weeklyReviewDay;

// ───────────── كتلة الإعداد المحقونة في تعليمات النظام ─────────────
/**
 * قسم «إعداد المالك» الذي يُلحق بتعليمات النظام (إكس والنشرة). برومبتات data/prompts/ لا تذكر
 * ركيزة ولا شريحة ولا لهجة بعينها — تحيل إلى هذا القسم، فيتغيّر السلوك بتعديل profile.json وحده.
 * `scope`: النشرة وحدها تتلقى المعجم ونطاقات الكثافة (القياس الرقمي خاص بها).
 */
export function buildProfileSystemBlock(scope: "x" | "newsletter"): string {
  const pillarLines = PILLARS.map((p) => `- ${p.key} — ${p.label}`).join("\n");
  const personaLines = PERSONAS_WITH_GENERAL.map(
    (p) => `- ${p.key} — ${p.label}: ${p.description}`,
  ).join("\n");

  let dialect = `الاسم: «${DIALECT.name}». اكتب بهذه اللهجة وحدها؛ لا تنحرف إلى لهجة أخرى.`;
  if (scope === "newsletter") {
    if (DIALECT_MEASURED && DIALECT.density) {
      dialect +=
        `\nنطاق كثافة اللهجة (لمسات لهجية لكل ١٠٠ كلمة من النثر): النشرة التعليمية ${formatRange(DIALECT.density.default)}` +
        `، والأغراض البيعية ${formatRange(DIALECT.density.sales)}. ويصلك النطاق المقرّر لغرضك صراحةً في \`<directives>\`.` +
        `\nمعجم القياس (كل ورود لإحدى هذه الكلمات لمسة): ${DIALECT.markers.join(" · ")}`;
    } else {
      dialect += "\nلا قياس رقمي للهجة في هذا الإعداد: اكتب بها طبيعياً بلا عدّ ولا نطاقات.";
    }
  }

  return (
    `# إعداد المالك (من data/profile.json)\n\n` +
    `## ركائز المحتوى (المفتاح — التسمية)\n${pillarLines}\n\n` +
    `## شرائح الجمهور (المفتاح — التسمية: الوصف)\n${personaLines}\n\n` +
    `## اللهجة المحددة في الإعداد\n${dialect}`
  );
}

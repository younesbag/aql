// scripts/import-knowledge.mjs
// ─────────────────────────────────────────────────────────────
// استيراد قاعدة المعرفة (الملف 07): إيميلات + ملاحظات + مستندات مشاريع.
// نفس محرّك الملف 05: فلترة → embedding بالدفعات → تخزين، صفر تصنيف،
// ensureClassified كسول عند الاسترجاع. للذاكرة فقط (لا تغذية مختبر الأنماط).
//
// البنية المتوقّعة للمجلد:
//   <knowledge>/
//     emails/  *.csv (أعمدة body/subject/date) أو *.txt|*.md (ملف = إيميل)   [عامة]
//     notes/   *.txt|*.md (ملاحظات مفصولة بسطر فارغ)                          [عامة]
//     docs/<اسم-المشروع>/**  *.md|*.txt|*.docx  → تُقطّع، project = اسم المجلد  [منفصلة]
//
// الاستخدام (من جذر المشروع):
//   node scripts/import-knowledge.mjs "<knowledge>" --dry-run
//   node scripts/import-knowledge.mjs "<knowledge>" --docs-reviewed
// (المستندات لا تُكتب إلا مع --docs-reviewed، بعد مراجعتك للأسرار.)
// ─────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import mammoth from "mammoth";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DOCS_REVIEWED = args.includes("--docs-reviewed");
const rootArg = args.find((a) => !a.startsWith("--"));

// ── إعدادات ──
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // يطابق lib/ai/gemini.ts و VECTOR(768)
const IMPORT_BATCH = 5;
const BATCH_DELAY_MS = 1500;
const EMBED_TRIES = 6;
const CHUNK_WORDS = 400; // حجم مقطع المستند (كلمات)
const CHUNK_OVERLAP = 60; // تداخل بين المقاطع (كلمات)
const MAX_EMBED_WORDS = 1000; // أي عنصر أطول يُقطّع (حدّ مُدخل نموذج التضمين ~2048 رمزاً)
const LONG_CHUNK_WORDS = 800; // حجم مقطع العنصر الطويل (إيميل/ملاحظة) — أكبر ليحفظ سياق الصوت
const LONG_CHUNK_OVERLAP = 80;
const DOC_EXT = new Set([".md", ".txt", ".docx"]);
const DEFER_EXT = new Set([".pdf", ".xlsx", ".pptx", ".doc", ".ppt", ".xls"]);

// ── أدوات نقية ──
function loadEnv() {
  const p = path.join(process.cwd(), ".env.local");
  const env = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const l2 = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wc = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// تقطيع نص لمقاطع بحجم كلمات ثابت مع تداخل.
function chunkText(text, size, overlap) {
  const w = text.trim().split(/\s+/).filter(Boolean);
  if (w.length <= size) return w.length ? [w.join(" ")] : [];
  const chunks = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < w.length; i += step) {
    chunks.push(w.slice(i, i + size).join(" "));
    if (i + size >= w.length) break;
  }
  return chunks;
}

// أمان حدّ التضمين: يقطّع أي عنصر أطول من MAX_EMBED_WORDS (إيميل/ملاحظة طويلة)
// لمقاطع قابلة للتضمين كاملةً — وإلا بُتر النص عند حدّ النموذج.
function splitLong(records) {
  const out = [];
  for (const r of records) {
    if (wc(r.raw_text) <= MAX_EMBED_WORDS) {
      out.push(r);
      continue;
    }
    chunkText(r.raw_text, LONG_CHUNK_WORDS, LONG_CHUNK_OVERLAP).forEach((ch, ci) =>
      out.push({ ...r, raw_text: ch, source_ref: `${r.source_ref}#p${ci}` }),
    );
  }
  return out;
}

// محلّل CSV بسيط يدعم الحقول المقتبسة (فواصل/أسطر داخل الاقتباس).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const fp = path.join(dir, e);
    if (statSync(fp).isDirectory()) out.push(...walk(fp));
    else out.push(fp);
  }
  return out;
}

// ── قراءة المصادر ──
function readEmails(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (!statSync(fp).isFile()) continue;
    const ext = path.extname(f).toLowerCase();
    if (ext === ".csv") {
      const rows = parseCSV(readFileSync(fp, "utf8"));
      if (rows.length < 2) continue;
      const h = rows[0].map((x) => x.trim().toLowerCase());
      const bi = h.findIndex((x) => /body|content|text|message|html/.test(x));
      const si = h.findIndex((x) => /subject|title/.test(x));
      const di = h.findIndex((x) => /date|sent|created|time/.test(x));
      if (bi < 0) {
        console.log(`  تخطّي ${f}: لا عمود نص (body/content/text).`);
        continue;
      }
      for (let r = 1; r < rows.length; r++) {
        const body = (rows[r][bi] || "").trim();
        if (wc(body) < 3) continue;
        out.push(
          mkEmail(
            body,
            si >= 0 ? (rows[r][si] || "").trim() : "",
            di >= 0 ? (rows[r][di] || "").trim() : "",
            `${f}#${r}`,
          ),
        );
      }
    } else if (ext === ".txt" || ext === ".md") {
      // ملف = إيميل كامل (العنوان أول سطر داخل الملف) — لا تُضِف اسم الملف.
      const body = readFileSync(fp, "utf8").trim();
      if (wc(body) >= 3) out.push(mkEmail(body, "", "", f));
    }
  }
  return out;
}
function mkEmail(body, subject, dateRaw, ref) {
  const d = dateRaw ? new Date(dateRaw) : null;
  return {
    raw_text: subject ? `${subject}\n${body}` : body,
    source_type: "email",
    source_ref: `email:${ref}`,
    project: null,
    created_at: d && !isNaN(d.getTime()) ? d.toISOString() : null,
  };
}

function readNotes(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (!statSync(fp).isFile()) continue;
    const ext = path.extname(f).toLowerCase();
    if (ext !== ".txt" && ext !== ".md") continue;
    const blocks = readFileSync(fp, "utf8")
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => wc(b) >= 2);
    blocks.forEach((block, bi) =>
      out.push({
        raw_text: block,
        source_type: "note",
        source_ref: `note:${f}#${bi}`,
        project: null,
        created_at: null,
      }),
    );
  }
  return out;
}

// يُرجع قائمة الملفات الصالحة (مع مشروعها) + قائمة المؤجّلة.
function listDocs(dir) {
  const files = [];
  const deferred = [];
  if (!existsSync(dir)) return { files, deferred };
  for (const entry of readdirSync(dir)) {
    const ep = path.join(dir, entry);
    const isDir = statSync(ep).isDirectory();
    const project = isDir ? entry : "عام";
    for (const fp of isDir ? walk(ep) : [ep]) {
      const ext = path.extname(fp).toLowerCase();
      const rel = path.relative(dir, fp).replace(/\\/g, "/");
      if (DOC_EXT.has(ext)) files.push({ fp, ext, rel, project });
      else if (DEFER_EXT.has(ext)) deferred.push(rel);
    }
  }
  return { files, deferred };
}

async function extractDocText(fp, ext) {
  if (ext === ".docx") {
    const res = await mammoth.extractRawText({ path: fp });
    return res.value || "";
  }
  return readFileSync(fp, "utf8");
}

async function main() {
  if (!rootArg) {
    console.error(
      'الاستخدام: node scripts/import-knowledge.mjs "<knowledge>" [--dry-run] [--docs-reviewed]',
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(rootArg)) {
    console.error("المجلد غير موجود: " + rootArg);
    process.exitCode = 1;
    return;
  }
  const env = loadEnv();
  const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = env.GEMINI_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !GEMINI_KEY) {
    console.error("مفاتيح ناقصة في .env.local.");
    process.exitCode = 1;
    return;
  }

  console.log("⚠️  تنبيه أمني: ملفات المشاريع قد تحوي أسراراً (مفاتيح، بيانات عملاء،");
  console.log("    شؤون الشركة). راجِعها واستبعد الحساس. المستندات لا تُكتب إلا مع --docs-reviewed.");
  console.log("🔒 تذكير: RLS بسياسات المالك يجب أن يكون مُفعّلاً (هجرة 0004).\n");

  // المصادر العامة
  const records = [];
  records.push(...readEmails(path.join(rootArg, "emails")));
  records.push(...readNotes(path.join(rootArg, "notes")));

  // المستندات (منفصلة بمشاريعها)
  const { files: docFiles, deferred } = listDocs(path.join(rootArg, "docs"));
  const processDocs = DRY || DOCS_REVIEWED;
  if (docFiles.length && !processDocs) {
    console.log(
      `⚠️  ${docFiles.length} ملف مستند مُتخطّى — أعد التشغيل بـ --docs-reviewed بعد مراجعتك للأسرار.\n`,
    );
  } else {
    for (const { fp, ext, rel, project } of docFiles) {
      let text;
      try {
        text = await extractDocText(fp, ext);
      } catch (e) {
        console.log(`  تعذّر استخراج ${rel}: ${e?.message || e}`);
        continue;
      }
      chunkText(text, CHUNK_WORDS, CHUNK_OVERLAP).forEach((ch, ci) =>
        records.push({
          raw_text: `[مشروع: ${project}] ${ch}`,
          source_type: "document",
          source_ref: `${rel}#${ci}`,
          project,
          created_at: null,
        }),
      );
    }
  }

  // أمان حدّ التضمين: قطّع أي عنصر طويل (إيميل/ملاحظة) لمقاطع قابلة للتضمين كاملةً.
  const items = splitLong(records);

  // تقرير
  const byProject = {};
  for (const r of items.filter((r) => r.source_type === "document"))
    byProject[r.project] = (byProject[r.project] || 0) + 1;
  const nEmail = items.filter((r) => r.source_type === "email").length;
  const nNote = items.filter((r) => r.source_type === "note").length;
  const nDoc = items.filter((r) => r.source_type === "document").length;

  console.log("══════════ تقرير قاعدة المعرفة ══════════");
  console.log("إيميلات (مقاطع):         " + nEmail);
  console.log("ملاحظات (مقاطع):         " + nNote);
  console.log("مقاطع مستندات:           " + nDoc + " من " + Object.keys(byProject).length + " مشروع");
  for (const [p, n] of Object.entries(byProject)) console.log("   • " + p + ": " + n + " مقطع");
  if (deferred.length) {
    console.log("صيغ غير مدعومة (مؤجّلة):  " + deferred.length);
    deferred.slice(0, 10).forEach((d) => console.log("   ✗ " + d));
  }

  if (items.length === 0) {
    console.log("\nلا شيء لاستيراده. تأكّد من بنية المجلد (emails/ notes/ docs/).");
    return;
  }

  // منع التكرار مقابل ما استُورد سابقاً (بالـ source_ref) — متسامح إن غاب العمود (قبل 0007).
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("items")
      .select("source_ref")
      .eq("origin", "import")
      .not("source_ref", "is", null)
      .range(from, from + 999);
    if (error) {
      console.log("⚠️  تخطّي منع التكرار: " + error.message + " (شغّل هجرة 0007؟)");
      break;
    }
    (data || []).forEach((r) => r.source_ref && existing.add(r.source_ref));
    if (!data || data.length < 1000) break;
  }
  const toImport = items.filter((r) => !existing.has(r.source_ref));
  console.log("مستورد سابقاً (سيُتخطّى): " + (items.length - toImport.length));
  console.log("سيُستورد الآن:            " + toImport.length);
  console.log("═══════════════════════════════════");

  if (DRY) {
    console.log("\n[تجريبي] لم تُكتب أي بيانات.");
    return;
  }
  if (toImport.length === 0) {
    console.log("\nلا جديد لاستيراده.");
    return;
  }

  // تضمين بالدفعات + إدراج فوري (قابل للاستئناف)
  const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
  async function embedBatch(texts) {
    for (let a = 1; ; a++) {
      try {
        const res = await ai.models.embedContent({
          model: EMBED_MODEL,
          contents: texts,
          config: { outputDimensionality: EMBED_DIM },
        });
        const embs = res.embeddings;
        if (!embs || embs.length !== texts.length)
          throw new Error("عدد المتجهات لا يطابق النصوص");
        return embs.map((e) => {
          const v = e.values;
          if (!v || v.length !== EMBED_DIM)
            throw new Error("بُعد متجه غير متوقّع: " + (v?.length ?? 0));
          return l2(v);
        });
      } catch (e) {
        const msg = String(e?.message || e);
        const is429 = /429|RESOURCE_EXHAUSTED|exhausted|quota/i.test(msg);
        if (a >= EMBED_TRIES) throw e;
        const waitMs = is429 ? 15000 * a : 2000 * a;
        console.log("    …تراجع " + Math.round(waitMs / 1000) + "s (" + (is429 ? "429" : "خطأ") + ")");
        await sleep(waitMs);
      }
    }
  }

  console.log("\nبدء الاستيراد بدفعات من " + IMPORT_BATCH + "…");
  let inserted = 0;
  for (let b = 0; b < toImport.length; b += IMPORT_BATCH) {
    const group = toImport.slice(b, b + IMPORT_BATCH);
    const vecs = await embedBatch(group.map((r) => r.raw_text));
    const rows = group.map((r, j) => ({
      raw_text: r.raw_text,
      source_type: r.source_type,
      source_ref: r.source_ref,
      project: r.project,
      origin: "import",
      status: "archived",
      ...(r.created_at ? { created_at: r.created_at } : {}),
      embedding: vecs[j],
    }));
    const { error } = await sb.from("items").insert(rows);
    if (error) {
      console.error("فشل إدراج items عند " + inserted + ": " + error.message);
      process.exitCode = 1;
      return;
    }
    inserted += rows.length;
    console.log("  " + inserted + "/" + toImport.length);
    if (b + IMPORT_BATCH < toImport.length) await sleep(BATCH_DELAY_MS);
  }

  console.log("\n══════════ اكتمل استيراد المعرفة ══════════");
  console.log("عناصر مضافة: " + inserted);
  console.log("التصنيف: صفر الآن — كسول لاحقاً عند الاسترجاع.");
  console.log("═══════════════════════════════════");
}

main()
  .catch((e) => {
    console.error("خطأ غير متوقّع: " + (e?.message || e));
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 2500).unref();
  });

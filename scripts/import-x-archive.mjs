// scripts/import-x-archive.mjs
// ─────────────────────────────────────────────────────────────
// استيراد أرشيف X إلى «عقل المالك» — المسار الذكي للملف 05:
//   فلترة الضجيج → embedding بدفعات صغيرة (لا تصنيف) → تخزين فوري في items
//   التغريدات ذات الأداء → posts (مختبر الأنماط). التصنيف كسول لاحقاً عند الاسترجاع.
// التخزين تدريجي لكل دفعة → قابل للاستئناف (إعادة التشغيل تتخطّى ما أُدرج عبر منع التكرار).
// سكربت مستقل (لا يستورد كود Next) — يقرأ .env.local مباشرة.
//
// الاستخدام (من جذر المشروع):
//   node scripts/import-x-archive.mjs "<مسار tweets.js>" --dry-run   (تجريبي: صفر كتابة)
//   node scripts/import-x-archive.mjs "<مسار tweets.js>"             (استيراد فعلي)
// ─────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const fileArg = args.find((a) => !a.startsWith("--"));

// ── إعدادات ──
const MIN_WORDS = 15; // أصلية أقصر من هذا وبلا تفاعل → تُستبعد
const PERF_MIN_ENG = 1; // أصلية بهذا التفاعل أو أكثر → posts (مختبر الأنماط)
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768; // يجب أن يطابق EMBED_DIM في lib/ai/gemini.ts و VECTOR(768)
const IMPORT_BATCH = 5; // نصوص لكل نداء تضمين + إدراج (صغير = لطيف على حدّ المعدل)
const BATCH_DELAY_MS = 1500; // مهلة بين الدفعات
const EMBED_TRIES = 6;

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
const wc = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const isRT = (t) => /^RT @/.test(t.full_text || "");
const isReply = (t) =>
  !!(t.in_reply_to_status_id_str || t.in_reply_to_user_id_str) || /^@/.test(t.full_text || "");
const l2 = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fileArg) {
    console.error('الاستخدام: node scripts/import-x-archive.mjs "<tweets.js>" [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const env = loadEnv();
  const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = env.GEMINI_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !GEMINI_KEY) {
    console.error(
      "مفاتيح ناقصة في .env.local: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY",
    );
    process.exitCode = 1;
    return;
  }

  // ── تحليل tweets.js (نزع البادئة window.YTD... ثم JSON) ──
  const rawjs = readFileSync(fileArg, "utf8");
  const start = rawjs.indexOf("[");
  if (start < 0) {
    console.error("لم أجد مصفوفة JSON في الملف.");
    process.exitCode = 1;
    return;
  }
  let body = rawjs.slice(start).trim();
  if (body.endsWith(";")) body = body.slice(0, -1);
  const parsed = JSON.parse(body);
  const tweets = parsed.map((o) => o.tweet).filter(Boolean);

  // ── الفلترة ──
  let nReplies = 0;
  let nRT = 0;
  let nShort = 0;
  const kept = [];
  for (const t of tweets) {
    const text = t.full_text || "";
    if (isRT(t)) {
      nRT++;
      continue;
    }
    if (isReply(t)) {
      nReplies++;
      continue;
    }
    const fav = parseInt(t.favorite_count || "0", 10) || 0;
    const rt = parseInt(t.retweet_count || "0", 10) || 0;
    const eng = fav + rt;
    if (wc(text) < MIN_WORDS && eng === 0) {
      nShort++;
      continue;
    }
    const d = new Date(t.created_at);
    kept.push({
      id: t.id_str,
      text,
      url: `https://x.com/i/web/status/${t.id_str}`,
      created_at: isNaN(d.getTime()) ? null : d.toISOString(),
      fav,
      rt,
      eng,
    });
  }

  // إزالة التكرار الداخلي (بالـ id)
  const seen = new Set();
  const unique = kept.filter((k) => (seen.has(k.id) ? false : (seen.add(k.id), true)));

  console.log("══════════ تقرير الفلترة ══════════");
  console.log("إجمالي التغريدات:            " + tweets.length);
  console.log("ردود مستبعدة:                " + nReplies);
  console.log("ريتويت مستبعدة:              " + nRT);
  console.log("قصيرة (<" + MIN_WORDS + " كلمة) بلا تفاعل: " + nShort);
  console.log("أصلية مقبولة:                " + kept.length);
  console.log("بعد إزالة التكرار الداخلي:   " + unique.length);

  // ── عميل الإدارة + منع التكرار مقابل ما استُورد سابقاً (يتيح الاستئناف) ──
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("items")
      .select("source_url")
      .eq("origin", "import")
      .range(from, from + 999);
    if (error) {
      console.error("فشل قراءة العناصر الموجودة: " + error.message);
      process.exitCode = 1;
      return;
    }
    (data || []).forEach((r) => r.source_url && existing.add(r.source_url));
    if (!data || data.length < 1000) break;
  }
  const toImport = unique.filter((k) => !existing.has(k.url));
  const perfCount = toImport.filter((k) => k.eng >= PERF_MIN_ENG).length;

  console.log("مستورد سابقاً (سيُتخطّى):    " + (unique.length - toImport.length));
  console.log("سيُستورد الآن:               " + toImport.length);
  console.log("منها بأداء → posts:          " + perfCount);
  console.log("═══════════════════════════════════");
  console.log("\nعيّنة (أعلى 5 تفاعلاً مما سيُستورد):");
  [...toImport]
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 5)
    .forEach((k, i) =>
      console.log(
        "  " +
          (i + 1) +
          ". (إعجابات " +
          k.fav +
          " · ريتويت " +
          k.rt +
          ") " +
          k.text.slice(0, 80).replace(/\s+/g, " "),
      ),
    );

  if (DRY) {
    console.log("\n[تجريبي] لم تُكتب أي بيانات. أزل --dry-run للاستيراد الفعلي.");
    return;
  }
  if (toImport.length === 0) {
    console.log("\nلا جديد لاستيراده. انتهى.");
    return;
  }

  // ── تضمين بدفعات صغيرة مع تراجع ذكي عند 429 ──
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
          throw new Error("عدد المتجهات لا يطابق النصوص (" + (embs?.length ?? 0) + ")");
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
        console.log(
          "    …تراجع " + Math.round(waitMs / 1000) + "s (" + (is429 ? "429" : "خطأ") + ")",
        );
        await sleep(waitMs);
      }
    }
  }

  // ── الحلقة الرئيسية: تضمين + إدراج فوري لكل دفعة (قابل للاستئناف) ──
  console.log("\nبدء الاستيراد بدفعات من " + IMPORT_BATCH + " (تضمين + إدراج لكل دفعة)…");
  let itemsInserted = 0;
  let postsInserted = 0;
  for (let b = 0; b < toImport.length; b += IMPORT_BATCH) {
    const group = toImport.slice(b, b + IMPORT_BATCH);
    const vecs = await embedBatch(group.map((k) => k.text));

    const itemRows = group.map((k, j) => ({
      raw_text: k.text,
      source_type: "tweet",
      source_url: k.url,
      origin: "import",
      status: "archived",
      ...(k.created_at ? { created_at: k.created_at } : {}),
      embedding: vecs[j],
    }));
    const { data, error } = await sb.from("items").insert(itemRows).select("id, source_url");
    if (error) {
      console.error("فشل إدراج items عند " + itemsInserted + ": " + error.message);
      process.exitCode = 1;
      return;
    }
    itemsInserted += itemRows.length;
    const idByUrl = new Map((data || []).map((r) => [r.source_url, r.id]));

    const postRows = group
      .map((k, j) => ({ k, vec: vecs[j] }))
      .filter(({ k }) => k.eng >= PERF_MIN_ENG)
      .map(({ k, vec }) => ({
        item_id: idByUrl.get(k.url) || null,
        format: "single",
        draft_text: k.text,
        status: "published",
        ...(k.created_at ? { published_at: k.created_at } : {}),
        likes: k.fav,
        reposts: k.rt,
        embedding: vec, // متجه المنشور (= متجه العنصر، نفس النص) — يغذّي match_posts
      }));
    if (postRows.length) {
      const { error: pe } = await sb.from("posts").insert(postRows);
      if (pe) {
        console.error("فشل إدراج posts عند " + postsInserted + ": " + pe.message);
        process.exitCode = 1;
        return;
      }
      postsInserted += postRows.length;
    }

    console.log(
      "  " + itemsInserted + "/" + toImport.length + " عنصراً (posts: " + postsInserted + ")",
    );
    if (b + IMPORT_BATCH < toImport.length) await sleep(BATCH_DELAY_MS);
  }

  console.log("\n══════════ اكتمل الاستيراد ══════════");
  console.log("عناصر مضافة (items):  " + itemsInserted);
  console.log("منشورات أداء (posts): " + postsInserted);
  console.log("التصنيف: صفر الآن — كسول لاحقاً عند الاسترجاع (ensureClassified).");
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

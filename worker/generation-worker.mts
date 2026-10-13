// ════════════════════════════════════════════════════════════
// عامل توليد الجلسة (الملف 16) — يعمل على الـVPS، خارج Vercel كلياً.
// الدور: ناقل تنفيذ «غبي» عمداً — يلتقط طلباً من generation_jobs (جهّزه
// Vercel كاملاً: التحليل + مدخل SP2 نصاً)، ينفّذه عبر جلسة اشتراك كلود
// (أمر claude -p — لا API ولا مفاتيح أنثروبيك)، يفكّك الناتج بنفس حرّاس
// المشروع، ويكتب النتيجة ليستطلعها المتصفح. كل الذكاء التركيبي يبقى في
// lib/content — هذا الملف لا يركّب برومبتات، يستوردها من prompt-builder.
//
// التشغيل: node worker/generation-worker.mts   (يتطلب Node ≥ 23.6 لتجريد
// الأنواع أصلياً؛ بديل لأي إصدار: npx tsx worker/generation-worker.mts)
// وضع الاختبار: --once (طلب واحد ثم خروج).
// ════════════════════════════════════════════════════════════
// يجب أن يكون أول استيراد: يحمّل worker/.env.worker متزامناً قبل تقييم وحدات lib
// التي تقرأ OWNER_NAME وقت الاستيراد (مواصفة ESM: تُقيَّم الوحدات بترتيب الاستيراد).
import "./env-bootstrap.mts";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  loadWriterSystem,
  buildCritiquePromptText,
  buildCodexCriticPrompt,
  buildExternalRewritePrompt,
  buildMergePrompt,
  extractJsonObject,
  parseCodexCritic,
  parseSp2Session,
  SESSION_JSON_INSTRUCTION,
  SESSION_CRITIQUE_JSON_INSTRUCTION,
  type GeneratedDraft,
} from "../lib/content/prompt-builder.ts";
import { runHarvest } from "./harvest.mts";
import { runWarmthRefresh } from "./warmth.mts";
import { runLoopsPublish } from "./loops-publish.mts";
// الملف 26 — النشرة على الجلسة: نفس وحدة البرومبت التي يستوردها مسار API
import {
  type NewsletterStage,
  loadNewsletterSystem,
  buildCritiqueUserContent,
  parseIdeasSession,
  parseOutlineSession,
  parseDraftSession,
  parseCritiqueSession,
  SESSION_IDEAS_INSTRUCTION,
  SESSION_OUTLINE_INSTRUCTION,
  SESSION_DRAFT_INSTRUCTION,
  SESSION_CRITIQUE_INSTRUCTION,
  SESSION_MERGE_INSTRUCTION,
  buildNewsletterMergePrompt,
  parseMergeSession,
} from "../lib/newsletter/prompt-builder.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── تحميل worker/.env.worker (بلا تبعية dotenv — سطور KEY=VALUE بسيطة) ──
async function loadEnvFile(): Promise<void> {
  try {
    const raw = await readFile(path.join(ROOT, "worker", ".env.worker"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // لا ملف env — نعتمد على متغيرات البيئة المضبوطة خارجياً (systemd مثلاً)
  }
}

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${ts()}] ${m}`);
const logErr = (m: string) => console.error(`[${ts()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── صفّ الطلب كما في جدول generation_jobs (هجرتا 0020 و0021) ──
type JobRow = {
  id: string;
  attempts: number;
  analysis: Record<string, unknown>;
  critique_enabled: boolean;
  user_content: string;
  // تحكّم لكل طلب (0021): null = افتراضيا العامل
  model: string | null;
  effort: string | null;
  // الناقد (0022): null = داخلي (كلود) · "codex" = خارجي (جيبيتي)
  critic: string | null;
  // النص الخام (0024): مرجع الحقائق لمراحل النقد/الدمج
  raw_text: string | null;
  // الملف 21 (0027): نوع المهمة — draft (توليد نصي) أو visual (إنفوغرافيك)
  kind: string;
  post_id: string | null;
  // الملف 26 (0031): مرحلة النشرة — ideas | outline | draft (null لغير النشرة)
  newsletter_stage: string | null;
  // وقت صفّ المهمة — يثبّت يوم نشر الدفعة مهما تأخر التقاطها أو أعيدت
  created_at: string;
};

type RunResult =
  | { ok: true; text: string }
  | { ok: false; error: string; usageLimited: boolean };

// حد استخدام الاشتراك يصل نصاً لا برمز — نلتقطه لنُرجئ بدل أن نُفشل.
const USAGE_LIMIT_RE = /usage limit|rate.?limit|overloaded|quota|limit reached|credit/i;
// خطأ التفكيك القابل للإعادة (JSON مكسور) مقابل الرفض النهائي — يطابق نصوص parseSp2Session حرفياً.
const RETRIABLE_PARSE_RE = /^(لم يُعثر على JSON|JSON مكسور)/;

async function main(): Promise<void> {
  await loadEnvFile();

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    logErr(
      "إعداد ناقص: يلزم SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في worker/.env.worker — انظر worker/README.md",
    );
    process.exit(1);
  }

  const cfg = {
    model: process.env.WORKER_MODEL || "claude-fable-5",
    // اختيارية وغير مضمونة عبر إصدارات CLI — لا تضبطها قبل تجربتها بـ--once
    effortArgs: process.env.WORKER_EFFORT ? ["--effort", process.env.WORKER_EFFORT] : [],
    // الناقد الخارجي (الملف 17): codex exec.
    // قرار المالك 2026-08-10: الناقد = SOL 5.6 بأقصى عمق — يُضبط في env الخادم:
    // CODEX_MODEL=gpt-5.6-sol و CODEX_EFFORT=xhigh (تحقّق حي: الترويسة تقبلهما).
    codexBin: process.env.CODEX_BIN || "codex",
    codexModelArgs: [
      ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []),
      ...(process.env.CODEX_EFFORT
        ? ["-c", `model_reasoning_effort="${process.env.CODEX_EFFORT}"`]
        : []),
    ],
    pollMs: intEnv("WORKER_POLL_MS", 5000),
    timeoutMs: intEnv("WORKER_TIMEOUT_MS", 30 * 60_000), // xhigh قد يبلغ 8+ دقائق للنداء
    limitBackoffMs: intEnv("WORKER_LIMIT_BACKOFF_MS", 20 * 60_000),
    maxAttempts: intEnv("WORKER_MAX_ATTEMPTS", 3),
    staleMinutes: intEnv("WORKER_STALE_MINUTES", 30),
    tgToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    tgChat: process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "",
  };

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // إشعار تيليجرام — طبقة اختيارية تتراجع بلطف (النتيجة محفوظة في الجدول دائماً)
  async function notify(text: string): Promise<void> {
    if (!cfg.tgToken || !cfg.tgChat) return;
    try {
      await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.tgChat, text }),
      });
    } catch (e) {
      logErr("[worker] فشل إشعار تيليجرام: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── استرداد اليتيم: طلب «يعمل» بقفل أقدم من المهلة = عامل مات أثناءه ──
  async function requeueStale(): Promise<void> {
    const cutoff = new Date(Date.now() - cfg.staleMinutes * 60_000).toISOString();
    const { data } = await db
      .from("generation_jobs")
      .select("id, attempts")
      .eq("status", "running")
      .lt("locked_at", cutoff);
    for (const j of data ?? []) {
      if ((j.attempts as number) >= cfg.maxAttempts) {
        await db
          .from("generation_jobs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error: "تعطّل التنفيذ المتكرر (قفل بائت بعد استنفاد المحاولات).",
          })
          .eq("id", j.id)
          .eq("status", "running");
        log(`أُفشل طلب بائت ${j.id} (محاولات مستنفدة)`);
      } else {
        await db
          .from("generation_jobs")
          .update({ status: "queued", locked_at: null, worker_note: "أُعيد للطابور بعد قفل بائت." })
          .eq("id", j.id)
          .eq("status", "running");
        log(`أُعيد للطابور طلب بائت ${j.id}`);
      }
    }
  }

  // ── القفل التفاؤلي: أقدم queued، والشرط المزدوج (id + status) يحسم أي سباق ──
  async function claimNext(): Promise<JobRow | null> {
    // نجلب عدّة مرشّحين لا واحداً: الأقدم قد يكون على نموذج مهدَّأ، فنتخطّاه
    // إلى التالي بدل تجميد الطابور كلّه (عطل إنتاج 2026-08-12).
    const { data: cands } = await db
      .from("generation_jobs")
      .select("id, attempts, model")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(10);
    const cand = (cands ?? []).find(
      (c) => !isPaused((c.model as string | null) || cfg.model),
    );
    if (!cand) return null;
    const now = new Date().toISOString();
    const { data: claimed } = await db
      .from("generation_jobs")
      .update({
        status: "running",
        started_at: now,
        locked_at: now,
        attempts: (cand.attempts as number) + 1,
      })
      .eq("id", cand.id)
      .eq("status", "queued")
      .select(
        "id, attempts, analysis, critique_enabled, user_content, model, effort, critic, raw_text, kind, post_id, newsletter_stage, created_at",
      )
      .maybeSingle();
    return (claimed as JobRow | null) ?? null;
  }

  // ── نداء الجلسة: claude -p (البرومبت من stdin، النظام في argv — ~32ك.ب آمنة) ──
  // opts (الملف 21): cwd لمجلد عمل مخصص، وextraArgs لأعلام إضافية (أدوات الجلسة الوكيلية).
  function runClaude(
    systemPrompt: string,
    userContent: string,
    model: string,
    effortArgs: string[],
    opts?: { cwd?: string; extraArgs?: string[] },
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        ...effortArgs,
        ...(opts?.extraArgs ?? []),
        "--append-system-prompt",
        systemPrompt,
      ];
      // بلا خيار stdio: الافتراضي pipe، وأنواع stdin/stdout غير قابلة لـnull.
      // cwd محايد (خارج المستودع): claude يحقن CLAUDE.md وإعدادات مجلد العمل في
      // سياق الجلسة — قياس حي: ~52 ألف توكن تلوثاً حين نُودي من جذر المشروع.
      const child = spawn("claude", args, { cwd: opts?.cwd ?? os.tmpdir() });
      let out = "";
      let err = "";
      let settled = false;
      const finish = (r: RunResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          error: `تجاوز التنفيذ المهلة (${Math.round(cfg.timeoutMs / 60_000)} دقيقة).`,
          usageLimited: false,
        });
      }, cfg.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(killer);
        const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
        finish({
          ok: false,
          error: enoent
            ? "أمر claude غير موجود في PATH — ثبّت Claude Code على الخادم وسجّل الدخول باشتراكك."
            : "تعذّر تشغيل claude: " + e.message,
          usageLimited: false,
        });
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (settled) return;
        const combined = out + "\n" + err;
        if (code !== 0) {
          finish({
            ok: false,
            error: `فشل نداء الجلسة (رمز ${code}): ` + (err || out).slice(0, 400),
            usageLimited: USAGE_LIMIT_RE.test(combined),
          });
          return;
        }
        try {
          const obj = JSON.parse(out) as Record<string, unknown>;
          const text = typeof obj.result === "string" ? obj.result : "";
          if (obj.is_error || !text) {
            finish({
              ok: false,
              error: "أعادت الجلسة خطأً: " + (text || JSON.stringify(obj).slice(0, 300)),
              usageLimited: USAGE_LIMIT_RE.test(text || combined),
            });
            return;
          }
          finish({ ok: true, text });
        } catch {
          finish({
            ok: false,
            error: "ناتج claude ليس JSON صالحاً: " + out.slice(0, 300),
            usageLimited: USAGE_LIMIT_RE.test(combined),
          });
        }
      });
      child.stdin.write(userContent);
      child.stdin.end();
    });
  }

  // ── نداء الناقد الخارجي: codex exec (جيبيتي بجلسة ChatGPT) ──
  // الناتج النهائي يُكتب لملف عبر -o (stdout عند codex يحمل ضجيج أحداث الوكيل)،
  // وcwd محايد كي لا يُحقن AGENTS.md من أي مجلد. --skip-git-repo-check لأننا خارج مستودع.
  function runCodex(prompt: string, outPath: string): Promise<RunResult> {
    return new Promise((resolve) => {
      const args = [
        "exec",
        "--skip-git-repo-check",
        "-o",
        outPath,
        ...cfg.codexModelArgs,
        prompt,
      ];
      const child = spawn(cfg.codexBin, args, { cwd: os.tmpdir() });
      let out = "";
      let err = "";
      let settled = false;
      const finish = (r: RunResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          ok: false,
          error: `تجاوز الناقد الخارجي المهلة (${Math.round(cfg.timeoutMs / 60_000)} دقيقة).`,
          usageLimited: false,
        });
      }, cfg.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(killer);
        const enoent = (e as NodeJS.ErrnoException).code === "ENOENT";
        finish({
          ok: false,
          error: enoent
            ? "أمر codex غير موجود في PATH — ثبّت Codex CLI على الخادم وسجّل دخول ChatGPT."
            : "تعذّر تشغيل codex: " + e.message,
          usageLimited: false,
        });
      });
      child.on("close", async (code) => {
        clearTimeout(killer);
        if (settled) return;
        const combined = out + "\n" + err;
        if (code !== 0) {
          finish({
            ok: false,
            error: `فشل نداء الناقد الخارجي (رمز ${code}): ` + (err || out).slice(0, 400),
            usageLimited: USAGE_LIMIT_RE.test(combined),
          });
          return;
        }
        try {
          const text = await readFile(outPath, "utf8");
          await unlink(outPath).catch(() => {});
          if (!text.trim()) {
            finish({ ok: false, error: "الناقد الخارجي أعاد ناتجاً فارغاً.", usageLimited: false });
            return;
          }
          finish({ ok: true, text });
        } catch {
          finish({
            ok: false,
            error: "لم يكتب codex ملف الناتج — راجع دخول ChatGPT على الخادم.",
            usageLimited: USAGE_LIMIT_RE.test(combined),
          });
        }
      });
      child.stdin.end();
    });
  }

  async function markFailed(job: JobRow, error: string): Promise<void> {
    await db
      .from("generation_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error })
      .eq("id", job.id);
    logErr(`فشل الطلب ${job.id}: ${error}`);
    await notify(`⚠️ تعذّر توليد المسودة: ${error.slice(0, 200)}`);
  }

  async function requeue(job: JobRow, note: string, refundAttempt: boolean): Promise<void> {
    await db
      .from("generation_jobs")
      .update({
        status: "queued",
        locked_at: null,
        worker_note: note,
        // حدّ الاستخدام ليس فشلاً للطلب — لا يُحتسب محاولة
        ...(refundAttempt ? { attempts: Math.max(0, job.attempts - 1) } : {}),
      })
      .eq("id", job.id);
    log(`أُعيد الطلب ${job.id} للطابور: ${note}`);
  }

  // تهدئة حدّ الاستخدام — **لكل نموذج على حدة** (عطل إنتاج 2026-08-12).
  // كانت عامّة، فبلوغُ فابل حدَّه جمّد الطابور كلّه ٢٠ دقيقة وحجب مهمةً طلبها
  // المالك صراحةً على أوبس وهو متاح. الحدّ يخصّ النموذج لا الجلسة كلها.
  const pausedModels = new Map<string, number>();
  const pauseModel = (mdl: string) => pausedModels.set(mdl, Date.now() + cfg.limitBackoffMs);
  const isPaused = (mdl: string) => (pausedModels.get(mdl) ?? 0) > Date.now();

  // ── الملف 21: مهمة الإنفوغرافيك — جلسة وكيلية بمهارة x-visual-designer ──
  // المسودة نصاً ← تحليل/نسخة مقفلة/HTML RTL ← PNG ← فحص ≥90 ← رفع للمخزن.
  // العامل لا يثق بإعلان الجلسة: يتحقق بنفسه من qa-auto.json ووجود الصورة.
  const VISUAL_SKILL_DIR = path.join(ROOT, "worker", "visual");
  const VISUAL_TOOLS = "Read Write Edit Glob Grep Bash(node:*)";

  async function executeVisual(job: JobRow): Promise<void> {
    const t0 = Date.now();
    const ws = path.join(os.tmpdir(), `visual-${job.id}`);
    log(`ينفّذ إنفوغرافيك ${job.id} (محاولة ${job.attempts}/${cfg.maxAttempts})…`);
    try {
      await mkdir(ws, { recursive: true });
      await writeFile(path.join(ws, "source-post.md"), job.user_content, "utf8");
      const sys = (await readFile(path.join(VISUAL_SKILL_DIR, "instructions.md"), "utf8"))
        .replaceAll("{{SKILL_DIR}}", VISUAL_SKILL_DIR)
        .replaceAll("{{WORKSPACE}}", ws);

      const model = job.model || cfg.model;
      const r = await runClaude(
        sys,
        "ابدأ التنفيذ الآن وفق تعليمات النظام — المنشور المصدر جاهز في مجلد العمل.",
        model,
        job.effort ? ["--effort", job.effort] : cfg.effortArgs,
        { cwd: ws, extraArgs: ["--allowedTools", VISUAL_TOOLS] },
      );
      if (!r.ok) {
        if (r.usageLimited) {
          pauseModel(model);
          await requeue(job, "بلغت الجلسة حدّ الاستخدام أثناء الإنفوغرافيك — سيعاود العامل.", true);
        } else if (job.attempts >= cfg.maxAttempts) {
          await markFailed(job, r.error);
        } else {
          await requeue(job, "فشل عابر في جلسة الإنفوغرافيك: " + r.error.slice(0, 200), false);
        }
        return;
      }

      // تحقق مستقل: الفحص الآلي والصورة — لا اكتفاء بإعلان الجلسة
      let qa: { score?: number; fatalErrors?: unknown[] } = {};
      try {
        qa = JSON.parse(await readFile(path.join(ws, "qa-auto.json"), "utf8"));
      } catch {
        /* غيابه يفشل الشرط أدناه */
      }
      const png = await readFile(path.join(ws, "final.png")).catch(() => null);
      const score = typeof qa.score === "number" ? qa.score : 0;
      const fatals = Array.isArray(qa.fatalErrors) ? qa.fatalErrors.length : 99;
      if (!png || png.length === 0 || score < 90 || fatals > 0) {
        const reason = `لم تجتز الصورة الفحص (score=${score}، أخطاء قاتلة=${fatals}، png=${png ? png.length : 0} بايت).`;
        if (job.attempts >= cfg.maxAttempts) await markFailed(job, reason);
        else await requeue(job, reason, false);
        return;
      }

      // الرفع للمخزن العام visuals (الصورة + مصدر HTML القابل للتحرير)
      const html = await readFile(path.join(ws, "design.html"), "utf8").catch(() => null);
      const up1 = await db.storage
        .from("visuals")
        .upload(`${job.id}.png`, png, { contentType: "image/png", upsert: true });
      if (up1.error) {
        await markFailed(job, "فشل رفع الصورة للمخزن: " + up1.error.message);
        return;
      }
      if (html)
        await db.storage
          .from("visuals")
          .upload(`${job.id}.html`, Buffer.from(html, "utf8"), {
            contentType: "text/html; charset=utf-8",
            upsert: true,
          });
      const imageUrl = db.storage.from("visuals").getPublicUrl(`${job.id}.png`).data.publicUrl;
      const htmlUrl = html
        ? db.storage.from("visuals").getPublicUrl(`${job.id}.html`).data.publicUrl
        : null;

      const totalSec = Math.round((Date.now() - t0) / 1000);
      const sessionOut = extractJsonObject(r.text);
      let summary = "";
      try {
        const s = sessionOut ? (JSON.parse(sessionOut) as Record<string, unknown>) : null;
        if (s && typeof s.summary === "string") summary = s.summary;
      } catch {
        /* الملخص تحسيني */
      }
      await db
        .from("generation_jobs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          result: { image_url: imageUrl, html_url: htmlUrl, score, summary },
          model_used: model,
          worker_note: `إنفوغرافيك ${score}/100 في ${totalSec}ث`,
        })
        .eq("id", job.id);
      if (job.post_id)
        await db.from("posts").update({ image_url: imageUrl }).eq("id", job.post_id);

      log(`اكتمل إنفوغرافيك ${job.id} — ${score}/100 في ${totalSec}ث`);
      // صورة تيليجرام مباشرة (الرابط عام — تيليجرام يجلبه بنفسه)
      if (cfg.tgToken && cfg.tgChat) {
        try {
          await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendPhoto`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: cfg.tgChat,
              photo: imageUrl,
              caption: `🖼️ إنفوغرافيك جاهز — ${score}/100${summary ? "\n" + summary : ""}`,
            }),
          });
        } catch (e) {
          logErr("[worker] فشل إرسال صورة تيليجرام: " + (e instanceof Error ? e.message : String(e)));
        }
      }
    } finally {
      await rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── الملف 22: مسودة Typefully — الحلقة الأخيرة (نص جاهز ← مسودة للمراجعة) ──
  // المفتاح في بيئة العامل حصراً. عقد **API v2** (v1 عُطّل — اكتُشف بفحص حي 2026-08-11
  // واستُخرج المخطط من أخطاء التحقق نفسها): Authorization Bearer، والمسار يتطلب
  // social_set_id (يُجلب مرة ويُخزَّن)، والجسم platforms.x.enabled + posts[{text}]
  // — الثريد مصفوفة posts (فاصل SP2 "\n-\n" يقسمها).
  let typefullySetId: string | null = process.env.TYPEFULLY_SOCIAL_SET_ID || null;

  async function resolveTypefullySet(key: string): Promise<string | null> {
    if (typefullySetId) return typefullySetId;
    try {
      const res = await fetch("https://api.typefully.com/v2/social-sets", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { results?: { id?: number | string }[] };
      const id = j.results?.[0]?.id;
      typefullySetId = id != null ? String(id) : null;
      return typefullySetId;
    } catch {
      return null;
    }
  }

  // الملف 26 — النشرة على الجلسة: مراحلها الثلاث على نفس الطابور والجلسة نفسها.
  // نصّ النظام والمدخل مصدرهما lib/newsletter/prompt-builder — نفس الوحدة التي
  // يستوردها مسار API على Vercel، فلا تتباعد نسخة عن نسخة.
  async function executeNewsletter(job: JobRow): Promise<void> {
    const t0 = Date.now();
    const stage = (job.newsletter_stage ?? "draft") as NewsletterStage;
    const model = job.model || cfg.model;
    const effortArgs = job.effort ? ["--effort", job.effort] : cfg.effortArgs;
    const sys = await loadNewsletterSystem(ROOT);
    log(`ينفّذ نشرة ${job.id} (${stage}، النموذج ${model}${job.effort ? "، تفكير " + job.effort : ""})…`);

    const instruction =
      stage === "ideas"
        ? SESSION_IDEAS_INSTRUCTION
        : stage === "outline"
          ? SESSION_OUTLINE_INSTRUCTION
          : SESSION_DRAFT_INSTRUCTION;

    // الدمج المتوازي: جيبيتي ينطلق **قبل** نداء كلود ليجريا معاً، وبكامل التعليمات
    // (النظام + تعليمة الإخراج + المدخل) في برومبت واحد — قرار المالك في الملف 18.
    const gptPromise =
      stage === "draft" && job.critic === "merge"
        ? runCodex(
            sys + SESSION_DRAFT_INSTRUCTION + "\n\n---\n\n" + job.user_content,
            path.join(os.tmpdir(), `codex-nl-${job.id}.txt`),
          )
        : null;

    const r1 = await runClaude(sys + instruction, job.user_content, model, effortArgs);
    if (!r1.ok) {
      // حدّ الاستعمال ليس عطلاً: تهدئة وإعادة بلا خصم محاولة (نفس نمط مسار إكس)
      if (r1.usageLimited) {
        pauseModel(model);
        await requeue(
          job,
          `بلغت الجلسة حدّ الاستخدام — سيعاود العامل بعد ~${Math.round(cfg.limitBackoffMs / 60_000)} دقيقة.`,
          true,
        );
      } else if (job.attempts >= cfg.maxAttempts) {
        await markFailed(job, r1.error);
      } else {
        await requeue(job, r1.error, false);
      }
      return;
    }

    // ── الأفكار والهيكل: مرحلة واحدة بلا نقد ──
    if (stage === "ideas" || stage === "outline") {
      const result =
        stage === "ideas"
          ? { ideas: parseIdeasSession(r1.text) }
          : { outline: parseOutlineSession(r1.text) };
      const empty = stage === "ideas" ? result.ideas!.length === 0 : !result.outline!.trim();
      if (empty) {
        const msg = "لم يُعد النموذج JSON صالحاً لهذه المرحلة.";
        if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
        else await requeue(job, msg, false);
        return;
      }
      await finishJob(job, result, `${stage} في ${Math.round((Date.now() - t0) / 1000)}ث`);
      return;
    }

    // ── المسودة ──
    const first = parseDraftSession(r1.text);
    if (!first) {
      const msg = "لم يُعد النموذج مسودة صالحة.";
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
      else await requeue(job, msg, false);
      return;
    }

    const toneLine = /<tone_metrics>([\s\S]*?)<\/tone_metrics>/.exec(job.user_content)?.[1]?.trim() ?? "";
    let out: Record<string, unknown> = { subject: first.subject, draft: first.draft, critique: null };
    let altDraft: Record<string, unknown> | null = null;
    let mergeNote = "";

    // ── وضع الدمج (الملف 29، منقول عن 18): تركيب أفضل ما في نشرتَي كلود وجيبيتي ──
    // توليدة جيبيتي الخام تُحفظ في alt_result دائماً ليحكم المالك بعينه، وأي فشل في
    // السلسلة يُبقي نشرة كلود كاملةً ويهبط للنقد المعتاد أدناه.
    if (job.critic === "merge" && gptPromise) {
      const rg = await gptPromise;
      if (!rg.ok) {
        logErr(`[نشرة ${job.id}] فشل نداء جيبيتي — بقيت نشرة كلود: ${rg.error.slice(0, 160)}`);
      } else {
        const gpt = parseDraftSession(rg.text);
        if (!gpt) {
          logErr(`[نشرة ${job.id}] تعذّر تفكيك نشرة جيبيتي — بقيت نشرة كلود.`);
        } else {
          altDraft = { subject: gpt.subject, draft: gpt.draft };
          const rm = await runClaude(
            sys + SESSION_MERGE_INSTRUCTION,
            buildNewsletterMergePrompt(first.subject, first.draft, gpt.subject, gpt.draft, toneLine),
            model,
            effortArgs,
          );
          const merged = rm.ok ? parseMergeSession(rm.text) : null;
          if (merged) {
            out = {
              subject: merged.subject.trim() || first.subject,
              draft: merged.draft,
              critique: {
                firstSubject: first.subject,
                firstDraft: first.draft,
                overall: null,
                weakest: [],
                mergeReport: merged.report,
              },
            };
            mergeNote = " · دمج متوازٍ";
          } else {
            logErr(
              `[نشرة ${job.id}] فشل الدمج — بقيت نشرة كلود: ` + (rm.ok ? "ناتج غير مفكّك" : rm.error.slice(0, 160)),
            );
          }
        }
      }
    }

    // حلقة النقد: طبقة اختيارية تتراجع بلطف — فشلها يُبقي المسودة الأولى كاملةً.
    // تُتخطّى بعد دمج ناجح: الدمج نفسه مرحلة تحسين، وإعادة النقد فوقه تعاكس تركيبه.
    if (job.critique_enabled && !mergeNote) {
      const critSys =
        sys +
        "\n\n# دورك الآن: محرّر نقديّ صارم\nأنت محرّر نقديّ صارم لا يجامل. تقيّم النشرة على معايير الجودة العشرة أعلاه بصرامة، وترفع أضعف أجزائها إلى المستوى المستهدف دون المساس بما نجح." +
        SESSION_CRITIQUE_INSTRUCTION;
      const r2 = await runClaude(
        critSys,
        buildCritiqueUserContent(first.subject, first.draft, toneLine.trim()),
        model,
        effortArgs,
      );
      const improved = r2.ok ? parseCritiqueSession(r2.text) : null;
      if (improved) {
        out = {
          subject: improved.subject.trim() || first.subject,
          draft: improved.draft,
          critique: {
            firstSubject: first.subject,
            firstDraft: first.draft,
            overall: improved.overall,
            weakest: improved.weakest,
          },
        };
      } else if (!r2.ok) {
        logErr(`[نشرة ${job.id}] فشل النقد (المسودة الأولى محفوظة): ${r2.error.slice(0, 160)}`);
      }
    }
    await finishJob(
      job,
      out,
      `مسودة نشرة في ${Math.round((Date.now() - t0) / 1000)}ث${mergeNote}`,
      altDraft,
    );
  }

  /** إنهاء ناجح موحّد لمهام النشرة. */
  async function finishJob(
    job: JobRow,
    result: Record<string, unknown>,
    note: string,
    alt?: Record<string, unknown> | null,
  ): Promise<void> {
    await db
      .from("generation_jobs")
      .update({
        status: "done",
        finished_at: new Date().toISOString(),
        result,
        worker_note: note,
        // نشرة جيبيتي الخام تُحفظ دائماً في وضع الدمج — ليحكم المالك بعينه
        ...(alt ? { alt_result: alt } : {}),
      })
      .eq("id", job.id);
    log(`اكتمل ${job.id}: ${note}`);
    await notify(`📧 ${note} — راجعها في شاشة النشرة.`);
  }

  // الملف 25 — الحصاد الأسبوعي: يسحب أرقام حسابه من المزود ويغذّي posts.
  // مهمة طويلة الشبكة (٧ دفعات + صفحات) — مكانها هنا لا في كرون Vercel.
  async function executeHarvest(job: JobRow): Promise<void> {
    const key = process.env.X_PROVIDER_API_KEY ?? "";
    const handle = (process.env.X_ACCOUNT_HANDLE ?? "").trim().replace(/^@/, "");
    if (!key) {
      await markFailed(job, "X_PROVIDER_API_KEY غير مضبوط في بيئة العامل.");
      return;
    }
    if (!handle) {
      await markFailed(job, "X_ACCOUNT_HANDLE غير مضبوط في بيئة العامل — ضع معرّف حسابك على إكس (بدون @).");
      return;
    }
    const t0 = Date.now();
    log(`يحصد أرقام @${handle}…`);
    try {
      const s = await runHarvest(db, { apiKey: key, handle, maxPages: 5, log });
      const secs = Math.round((Date.now() - t0) / 1000);
      const line =
        `حُدّث ${s.refreshed} · رُبط ${s.linked} · أُضيف ${s.inserted} · ` +
        `مشاهدات جديدة ${s.impressionsGained.toLocaleString("en-US")}`;
      await db
        .from("generation_jobs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          result: s,
          worker_note: `حصاد في ${secs}ث — ${line}`,
        })
        .eq("id", job.id);
      log(`اكتمل الحصاد ${job.id}: ${line}`);
      // أخطاء الدفعات الجزئية تُبلَّغ ولا تُفشل الحصاد — البقية كُتبت فعلاً
      const tail = s.errors.length ? `\n⚠️ ${s.errors.length} تعثّراً جزئياً: ${s.errors[0]}` : "";
      await notify(
        `📊 حصاد الأداء الأسبوعي:\n` +
          `• حُدّثت أرقام ${s.refreshed} منشوراً\n` +
          `• رُبط ${s.linked} منشوراً مولَّداً بتغريدته\n` +
          `• أُضيف ${s.inserted} منشوراً من خارج النظام\n` +
          `• دخلت ${s.impressionsGained.toLocaleString("en-US")} مشاهدة جديدة${tail}`,
      );
    } catch (e) {
      const msg = "تعذّر الحصاد: " + (e instanceof Error ? e.message : String(e));
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
      else await requeue(job, msg, false);
    }
  }

  async function executeTypefully(job: JobRow): Promise<void> {
    const key = process.env.TYPEFULLY_API_KEY ?? "";
    if (!key) {
      await markFailed(job, "TYPEFULLY_API_KEY غير مضبوط في بيئة العامل.");
      return;
    }
    const t0 = Date.now();
    log(`يرسل إلى Typefully ${job.id}…`);
    const setId = await resolveTypefullySet(key);
    if (!setId) {
      const reason = "تعذّر جلب social set من Typefully — تحقق من صلاحية المفتاح.";
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, reason);
      else await requeue(job, reason, false);
      return;
    }
    // ثريدات SP2 تفصل تغريداتها بـ"\n-\n" — كل جزء عنصر في posts
    const posts = (
      job.user_content.includes("\n-\n")
        ? job.user_content.split("\n-\n").map((s) => s.trim())
        : [job.user_content.trim()]
    )
      .filter(Boolean)
      .map((text) => ({ text }));
    try {
      const res = await fetch(`https://api.typefully.com/v2/social-sets/${setId}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          draft_title: "من العقل الثاني: " + posts[0]!.text.replace(/\s+/g, " ").slice(0, 44),
          platforms: { x: { enabled: true, posts } },
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        const reason = `رفض Typefully (${res.status}): ` + body.slice(0, 200);
        // 401/403 = مفتاح — لا جدوى من الإعادة
        if (res.status === 401 || res.status === 403 || job.attempts >= cfg.maxAttempts)
          await markFailed(job, reason);
        else await requeue(job, reason, false);
        return;
      }
      let id: string | null = null;
      let privateUrl: string | null = null;
      try {
        const j = JSON.parse(body) as Record<string, unknown>;
        id = j.id != null ? String(j.id) : null;
        privateUrl = typeof j.private_url === "string" ? j.private_url : null;
      } catch {
        /* الرابط الافتراضي يكفي */
      }
      const url =
        privateUrl ?? (id ? `https://typefully.com/?d=${id}&a=${setId}` : "https://typefully.com/");
      await db
        .from("generation_jobs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          result: { typefully_id: id, url },
          worker_note: `مسودة Typefully في ${Math.round((Date.now() - t0) / 1000)}ث`,
        })
        .eq("id", job.id);
      log(`أُنشئت مسودة Typefully للطلب ${job.id}`);
      await notify(`📮 مسودة Typefully جاهزة للمراجعة:\n${url}`);
    } catch (e) {
      const msg = "تعذّر الوصول إلى Typefully: " + (e instanceof Error ? e.message : String(e));
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
      else await requeue(job, msg, false);
    }
  }

  // الملف 34 — تحديث الدفء الأسبوعي: أساس email_warmth + أحداث webhook لوبس
  // ← درجات وطبقات جديدة ← كتابة للوبس عند التغيّر فقط. مكانه هنا لا في Vercel:
  // شبكة طويلة (مئات نداءات لوبس المتتابعة) والمفتاح في بيئة العامل أصلاً.
  async function executeWarmth(job: JobRow): Promise<void> {
    const loopsKey = process.env.LOOPS_API_KEY ?? "";
    if (!loopsKey) {
      await markFailed(job, "LOOPS_API_KEY غير مضبوط في بيئة العامل.");
      return;
    }
    const t0 = Date.now();
    log("يحدّث طبقات الدفء البريدية…");
    try {
      const s = await runWarmthRefresh(db, { loopsKey, log });
      const secs = Math.round((Date.now() - t0) / 1000);
      const tiers = Object.entries(s.tiers)
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      const line =
        `${s.contacts} مشتركاً · ${s.eventsRead} حدثاً · ${s.changed} تغيّراً · ` +
        `كُتب ${s.written}${s.writeFailed ? ` (تعثّر ${s.writeFailed})` : ""}`;
      await db
        .from("generation_jobs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          result: s,
          worker_note: `تحديث الدفء في ${secs}ث — ${line}`,
        })
        .eq("id", job.id);
      log(`اكتمل تحديث الدفء ${job.id}: ${line}`);
      await notify(
        `🌡️ تحديث الدفء الأسبوعي:\n` +
          `• ${s.eventsRead} حدثاً بريدياً جديداً منذ آخر أساس\n` +
          `• ${s.changed} مشتركاً تغيّرت طبقته أو درجته (كُتب ${s.written} في لوبس)\n` +
          `• ${s.newContacts} مشتركاً جديداً دخل النظام\n` +
          (s.replies ? `• 🗣 ردود مسجّلة: ${s.replies}\n` : "") +
          (s.conversions ? `• 🎯 جهات بمرحلة تحويل مرصودة: ${s.conversions}\n` : "") +
          `• التوزيع الآن: ${tiers}`,
      );
    } catch (e) {
      const msg = "تعذّر تحديث الدفء: " + (e instanceof Error ? e.message : String(e));
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
      else await requeue(job, msg, false);
    }
  }

  // الملف 35 — النشر الكامل إلى لوبس: مسودة معتمدة → حملة (محتوى LMX + جمهور +
  // Guardian + معاينة + جدولة اختيارية). المفتاح في بيئة العامل — نمط Typefully.
  async function executeLoopsPublish(job: JobRow): Promise<void> {
    const loopsKey = process.env.LOOPS_API_KEY ?? "";
    if (!loopsKey) {
      await markFailed(job, "LOOPS_API_KEY غير مضبوط في بيئة العامل.");
      return;
    }
    const p = job.analysis as Parameters<typeof runLoopsPublish>[1]["payload"];
    if (!p || typeof p.subject !== "string" || typeof p.body !== "string" || !p.audience) {
      await markFailed(job, "حمولة النشر ناقصة — أعد الصفّ من الواجهة.");
      return;
    }
    const t0 = Date.now();
    log(`ينشر حملة إلى لوبس: «${p.subject.slice(0, 50)}»…`);
    try {
      const r = await runLoopsPublish(db, { loopsKey, payload: p, log });
      const secs = Math.round((Date.now() - t0) / 1000);
      const stateLine = r.scheduled
        ? "مجدولة ✓"
        : r.guardianErrors.length
          ? `مسودة — أخطاء Guardian: ${r.guardianErrors.join(" · ")}`
          : "مسودة في لوبس (أرسلها من اللوحة)";
      await db
        .from("generation_jobs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          result: r,
          worker_note: `نشر لوبس في ${secs}ث — ${stateLine}`,
        })
        .eq("id", job.id);
      log(`اكتمل نشر لوبس ${job.id}: ${r.campaignId} (${stateLine})`);
      await notify(
        `📮 حملة لوبس جاهزة:\n` +
          `• «${p.subject}» → ${p.audience.label}\n` +
          `• الحالة: ${stateLine}\n` +
          (r.previewSent ? `• معاينة أُرسلت إلى ${p.preview_to}\n` : "") +
          (r.guardianWarnings.length ? `• تنبيهات: ${r.guardianWarnings.join(" · ")}\n` : "") +
          `${r.url}`,
      );
    } catch (e) {
      const msg = "تعذّر النشر إلى لوبس: " + (e instanceof Error ? e.message : String(e));
      if (job.attempts >= cfg.maxAttempts) await markFailed(job, msg);
      else await requeue(job, msg, false);
    }
  }

  async function execute(job: JobRow): Promise<void> {
    // الملف 21: فرع الإنفوغرافيك — مسار مستقل كلياً عن التوليد النصي
    if (job.kind === "visual") {
      await executeVisual(job);
      return;
    }
    // الملف 22: فرع Typefully
    if (job.kind === "typefully") {
      await executeTypefully(job);
      return;
    }
    // الملف 25: فرع حصاد الأداء
    if (job.kind === "harvest") {
      await executeHarvest(job);
      return;
    }
    // الملف 34: فرع تحديث الدفء البريدي
    if (job.kind === "warmth") {
      await executeWarmth(job);
      return;
    }
    // الملف 35: فرع النشر إلى لوبس
    if (job.kind === "loops_publish") {
      await executeLoopsPublish(job);
      return;
    }
    // الملف 26: فرع النشرة (مراحلها الثلاث)
    if (job.kind === "newsletter") {
      await executeNewsletter(job);
      return;
    }
    const t0 = Date.now();
    const sys = await loadWriterSystem(ROOT);
    // تحكّم الطلب يتقدّم على افتراضيات العامل (هجرة 0021)
    const model = job.model || cfg.model;
    const effortArgs = job.effort ? ["--effort", job.effort] : cfg.effortArgs;
    log(
      `ينفّذ الطلب ${job.id} (محاولة ${job.attempts}/${cfg.maxAttempts}، النموذج ${model}${job.effort ? "، تفكير " + job.effort : ""}${job.critic === "merge" ? "، دمج متوازٍ" : ""})…`,
    );

    // الملف 18 — وضع الدمج: توليدة جيبيتي تنطلق هنا بالتوازي مع توليدة كلود،
    // بكامل التعليمات (النظام + تعليمة JSON + المدخل) في برومبت واحد — قرار المالك.
    // إن فشل مسار كلود وأُعيد الطلب، تُهدر نتيجتها — مقايضة مقبولة لبساطة مسار الفشل.
    const gptPromise =
      job.critic === "merge"
        ? runCodex(
            sys + SESSION_JSON_INSTRUCTION + "\n\n---\n\n" + job.user_content,
            path.join(os.tmpdir(), `codex-draft-${job.id}.txt`),
          )
        : null;

    const r1 = await runClaude(sys + SESSION_JSON_INSTRUCTION, job.user_content, model, effortArgs);
    if (!r1.ok) {
      if (r1.usageLimited) {
        pauseModel(model);
        await requeue(
          job,
          `بلغت الجلسة حدّ الاستخدام — سيعاود العامل بعد ~${Math.round(cfg.limitBackoffMs / 60_000)} دقيقة.`,
          true,
        );
      } else if (job.attempts >= cfg.maxAttempts) {
        await markFailed(job, r1.error);
      } else {
        await requeue(job, "فشل عابر: " + r1.error.slice(0, 200), false);
      }
      return;
    }

    const p1 = parseSp2Session(r1.text);
    if (!p1.ok) {
      const retriable = RETRIABLE_PARSE_RE.test(p1.error);
      if (retriable && job.attempts < cfg.maxAttempts) {
        await requeue(job, "ناتج غير مفكّك: " + p1.error.slice(0, 200), false);
      } else {
        // رفض المحرّك (draft=null) أو استنفاد المحاولات — نهائي برسالته الحقيقية
        await markFailed(job, p1.error);
      }
      return;
    }

    let draft: GeneratedDraft = p1.draft;
    const v1Sec = Math.round((Date.now() - t0) / 1000);
    let note = `ولّد المسودة في ${v1Sec}ث`;

    // ── وضع الدمج: انتظار توليدة جيبيتي ثم تركيب الأفضل من التوليدتين ──
    // توليدة جيبيتي الخام تُحفظ في alt_result دائماً (ليحكم المالك بعينه)،
    // وأي فشل في السلسلة يُبقي توليدة كلود ويهبط للنقد المعتاد أدناه.
    let altDraftG: GeneratedDraft | null = null;
    let merged = false;
    if (gptPromise) {
      const rg = await gptPromise;
      if (rg.ok) {
        const pg = parseSp2Session(rg.text);
        if (pg.ok) altDraftG = pg.draft;
        else logErr(`[worker] فشل تفكيك توليدة جيبيتي للطلب ${job.id}: ` + pg.error);
      } else {
        logErr(`[worker] فشلت توليدة جيبيتي للطلب ${job.id}: ` + rg.error);
      }
      if (!altDraftG) {
        note += " · تعذّرت توليدة جيبيتي فأكمل كلود وحده";
      } else {
        const v1OverallC = draft.quality_score?.overall ?? 0;
        const rm = await runClaude(
          sys + SESSION_CRITIQUE_JSON_INSTRUCTION,
          buildMergePrompt(draft.draft, altDraftG.draft, job.analysis, job.raw_text),
          model,
          effortArgs,
        );
        if (rm.ok) {
          const pm = parseSp2Session(rm.text);
          if (pm.ok && pm.draft.critique) {
            pm.draft.critique.before_overall = v1OverallC;
            pm.draft.critique.critic = "merge";
            draft = pm.draft;
            note += " + دمج توليدتين (كلود × جيبيتي)";
            merged = true;
          } else {
            logErr(`[worker] فشل تفكيك الدمج للطلب ${job.id} — بقيت توليدة كلود: ` + (pm.ok ? "بلا حقل critique" : pm.error));
          }
        } else {
          logErr(`[worker] فشل نداء الدمج للطلب ${job.id} — بقيت توليدة كلود: ` + rm.error);
          if (rm.usageLimited) pauseModel(model);
        }
        if (!merged) note += " · تعذّر الدمج فبقيت توليدة كلود";
      }
    }

    // حلقة النقد — اختيارية وتتراجع بلطف دائماً (v1 تبقى مهما فشل).
    // الملف 17: حين critic=codex يحكم جيبيتي أولاً (لا يكتب) ثم يعيد كلود
    // الكتابة وفق حكمه بسيادة الصوت؛ وأي فشل في السلسلة الخارجية يهبط
    // للنقد الداخلي القائم — أرضية الجودة لا تنخفض.
    if (!merged && job.critique_enabled && draft.quality_score) {
      // درجة v1 تُثبَّت هنا: إسناد draft لاحقاً يُبطل تضييق النوع
      const v1Overall = draft.quality_score.overall;
      let externalDone = false;

      if (job.critic === "codex") {
        const outPath = path.join(os.tmpdir(), `codex-critic-${job.id}.txt`);
        const rc = await runCodex(
          buildCodexCriticPrompt(draft.draft, job.analysis, job.raw_text),
          outPath,
        );
        if (rc.ok) {
          const pc = parseCodexCritic(rc.text);
          if (pc.ok) {
            log(`حكم الناقد الخارجي للطلب ${job.id}: الأضعف [${pc.critique.weakest.join("، ")}]`);
            const rf = await runClaude(
              sys + SESSION_CRITIQUE_JSON_INSTRUCTION,
              buildExternalRewritePrompt(draft.draft, job.analysis, pc.critique, job.raw_text),
              model,
              effortArgs,
            );
            if (rf.ok) {
              const pf = parseSp2Session(rf.text);
              if (pf.ok && pf.draft.critique) {
                pf.draft.critique.before_overall = v1Overall;
                pf.draft.critique.critic = "codex";
                draft = pf.draft;
                note += " + نقد خارجي (جيبيتي) وتحسين";
                externalDone = true;
              } else {
                logErr(`[worker] فشل تفكيك الكتابة النهائية بعد النقد الخارجي للطلب ${job.id}: ` + (pf.ok ? "بلا حقل critique" : pf.error));
              }
            } else {
              logErr(`[worker] فشل نداء الكتابة النهائية للطلب ${job.id}: ` + rf.error);
              if (rf.usageLimited) pauseModel(model);
            }
          } else {
            logErr(`[worker] فشل تفكيك الناقد الخارجي للطلب ${job.id}: ` + pc.error);
          }
        } else {
          logErr(`[worker] فشل الناقد الخارجي للطلب ${job.id}: ` + rc.error);
        }
        if (!externalDone) note += " · تعذّر الناقد الخارجي فنُفّذ الداخلي";
      }

      if (!externalDone) {
        const r2 = await runClaude(
          sys + SESSION_CRITIQUE_JSON_INSTRUCTION,
          buildCritiquePromptText(draft.draft, job.analysis, job.raw_text),
          model,
          effortArgs,
        );
        if (r2.ok) {
          const p2 = parseSp2Session(r2.text);
          if (p2.ok && p2.draft.critique) {
            p2.draft.critique.before_overall = v1Overall;
            draft = p2.draft;
            note += " + نقد وتحسين";
          } else {
            logErr(`[worker] فشل تفكيك النقد للطلب ${job.id} — أُبقيت v1: ` + (p2.ok ? "بلا حقل critique" : p2.error));
          }
        } else {
          logErr(`[worker] فشل نداء النقد للطلب ${job.id} — أُبقيت v1: ` + r2.error);
          if (r2.usageLimited) pauseModel(model);
        }
      }
    }

    const totalSec = Math.round((Date.now() - t0) / 1000);
    const { error: writeErr } = await db
      .from("generation_jobs")
      .update({
        status: "done",
        finished_at: new Date().toISOString(),
        result: draft,
        alt_result: altDraftG,
        model_used: model,
        worker_note: `${note}${job.effort ? " · تفكير " + job.effort : ""} · إجمالي ${totalSec}ث`,
      })
      .eq("id", job.id);
    if (writeErr) {
      logErr(`فشل كتابة نتيجة ${job.id}: ${writeErr.message}`);
      return;
    }
    log(`اكتمل الطلب ${job.id} في ${totalSec}ث (${model})`);
    const q = draft.quality_score ? ` · الجودة ${draft.quality_score.overall}/10` : "";
    await notify(`✍️ مسودة جاهزة من محرّك الجلسة${q} — افتحها في مختبر المحتوى.`);
  }

  // ── الحلقة الرئيسية ──
  const once = process.argv.includes("--once");
  log(`عامل التوليد انطلق — النموذج ${cfg.model}، استطلاع كل ${cfg.pollMs / 1000}ث${once ? " (وضع الاختبار --once)" : ""}`);

  for (;;) {
    try {
      await requeueStale();
      const job = await claimNext();
      if (job) {
        try {
          await execute(job);
        } catch (e) {
          await markFailed(job, "عطل غير متوقع في العامل: " + (e instanceof Error ? e.message : String(e)));
        }
        if (once) break;
        continue; // طلب آخر قد ينتظر — لا نوم بين الطلبات
      }
      if (once) {
        log("لا طلبات في الطابور.");
        break;
      }
      await sleep(cfg.pollMs);
    } catch (e) {
      // عطل حلقة (شبكة Supabase غالباً) — سجّل وواصل، لا تمت
      logErr("عطل الحلقة: " + (e instanceof Error ? e.message : String(e)));
      await sleep(cfg.pollMs * 3);
    }
  }
}

main();

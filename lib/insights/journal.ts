import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embed, flashJson } from "@/lib/ai/gemini";
import { parseJson } from "@/lib/agents/util";
import { computeWeeklyTaskStats, formatWeeklyStats } from "@/lib/dayplan/reports";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
} from "@/lib/telegram/api";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// المذكرة الأسبوعية — النواة المشتركة + تدفّق تيليجرام (الملف 15).
// النواة (توليد المسودة من وقائع الأسبوع) منقولة كما هي من إجراءات «الرؤى»
// لتُستدعى بعميل الجلسة من الويب وبعميل service_role من تيليجرام — نفس نمط
// processIncomingItem المشترك. الويب يبقى سطح التحرير؛ تيليجرام يعرض ويحفظ.
// ════════════════════════════════════════════════════════════

/** بداية الأسبوع (الإثنين) بصيغة YYYY-MM-DD. */
export function weekOf(): string {
  const now = new Date();
  const diff = (now.getUTCDay() + 6) % 7; // 0=الإثنين
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  return monday.toISOString().slice(0, 10);
}

export type JournalDraft = {
  learned: string;
  failed: string;
  succeeded: string;
  changed: string;
};
export type JournalDraftOutcome =
  | { ok: true; draft: JournalDraft }
  | { ok: false; error: string };

const JOURNAL_DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    learned: { type: "string" },
    failed: { type: "string" },
    succeeded: { type: "string" },
    changed: { type: "string" },
  },
  required: ["learned", "failed", "succeeded", "changed"],
};

/** يولّد مسودة المذكرة من وقائع الأسبوع الفعلية — نداء flash واحد بمخطط مقيّد.
 *  يقبل أي عميل Supabase (جلسة من الويب، service_role من تيليجرام). */
export async function generateJournalDraft(
  supabase: SupabaseClient,
): Promise<JournalDraftOutcome> {
  try {
    const monday = weekOf();

    // وقائع الأسبوع — أربعة استعلامات متوازية.
    const [stats, decisions, posts, itemCount] = await Promise.all([
      computeWeeklyTaskStats(supabase).catch(() => null),
      supabase
        .from("decisions")
        .select("decision, reasoning")
        .gte("created_at", monday)
        .limit(5),
      supabase
        .from("posts")
        .select("hook_text, draft_text, quality_score")
        .eq("status", "published")
        .gte("published_at", monday)
        .limit(5),
      supabase
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("origin", "manual")
        .gte("created_at", monday),
    ]);

    const decLines = ((decisions.data ?? []) as { decision: string; reasoning: string }[])
      .map((d) => `- قرار: ${d.decision} (السبب: ${d.reasoning})`)
      .join("\n");
    const postLines = (
      (posts.data ?? []) as { hook_text: string | null; draft_text: string; quality_score: number | null }[]
    )
      .map((p) => `- نُشر: ${(p.hook_text || p.draft_text).slice(0, 80)}`)
      .join("\n");

    const facts = [
      stats ? `المهام: ${formatWeeklyStats(stats)}` : "",
      decLines ? `قرارات الأسبوع:\n${decLines}` : "لا قرارات موثّقة هذا الأسبوع.",
      postLines ? `منشورات الأسبوع:\n${postLines}` : "لا منشورات هذا الأسبوع.",
      `التقاطات الأسبوع: ${itemCount.count ?? 0} عنصراً.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const prompt = `أنت تساعد ${OWNER_NAME} على كتابة مراجعته الأسبوعية. أمامك وقائع أسبوعه الفعلية — صُغ منها **مسودة** إجابات للأسئلة الأربعة، بصيغة المتكلم وبصوته الشخصي، صادقة ومحددة لا عامة، وقصيرة (سطر إلى سطرين لكل حقل). اعتمد على الوقائع فقط — لا تخترع إنجازاً ولا فشلاً. إن لم تكفِ الوقائع لحقلٍ فاجعله سؤالاً موجهاً له (مثل: «ما أكثر ما علّمك هذا الأسبوع؟»).

وقائع الأسبوع:
${facts}

أخرج JSON فقط: {"learned": "...", "failed": "...", "succeeded": "...", "changed": "..."}`;

    const res = await flashJson(prompt, JOURNAL_DRAFT_SCHEMA);
    if (!res.ok) return { ok: false, error: "تعذّر توليد المسودة: " + res.error };
    const p = parseJson<JournalDraft>(res.data);
    if (!p || typeof p.learned !== "string") {
      return { ok: false, error: "تعذّر قراءة مخرج المسودة — حاول مجدداً." };
    }
    return {
      ok: true,
      draft: {
        learned: String(p.learned ?? ""),
        failed: String(p.failed ?? ""),
        succeeded: String(p.succeeded ?? ""),
        changed: String(p.changed ?? ""),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "تعذّر توليد مسودة المذكرة",
    };
  }
}

// ────────────────────────────────────────────────────────────
// تدفّق تيليجرام: /مذكرة → مسودة بزرّي حفظ/تجاهل. الحالة محمولة في نصّ رسالة
// المسودة نفسها (كنمط callback_data — بلا جدول جلسات): وسوم الحقول الأربعة
// فواصل تفكيك عند ضغطة «احفظها».
// ────────────────────────────────────────────────────────────

const MARK_LEARNED = "🟢 تعلّمت:";
const MARK_FAILED = "🔴 فشل:";
const MARK_SUCCEEDED = "🔵 نجح:";
const MARK_CHANGED = "🟡 سأغيّر:";

function renderJournalDraft(d: JournalDraft): string {
  return [
    "📔 مسودة مذكرة الأسبوع — من وقائع أسبوعك الفعلية:",
    "",
    `${MARK_LEARNED} ${d.learned}`,
    `${MARK_FAILED} ${d.failed}`,
    `${MARK_SUCCEEDED} ${d.succeeded}`,
    `${MARK_CHANGED} ${d.changed}`,
  ].join("\n");
}

/** يفكّك المسودة من نصّ رسالتها بالوسوم الأربعة بالترتيب — أو null إن تشوّهت. */
export function parseJournalDraftMessage(text: string): JournalDraft | null {
  const marks = [MARK_LEARNED, MARK_FAILED, MARK_SUCCEEDED, MARK_CHANGED];
  const idx = marks.map((m) => text.indexOf(m));
  if (idx.some((i) => i < 0)) return null;
  for (let i = 1; i < idx.length; i++) if (idx[i] <= idx[i - 1]) return null;
  const slice = (i: number): string => {
    const start = idx[i] + marks[i].length;
    const end = i + 1 < idx.length ? idx[i + 1] : text.length;
    return text.slice(start, end).trim();
  };
  return { learned: slice(0), failed: slice(1), succeeded: slice(2), changed: slice(3) };
}

const fieldOrDash = (v: string | null | undefined): string => (v && v.trim() ? v : "—");

/** الأمر /مذكرة: إن حُفظت مذكرة الأسبوع تُعرض؛ وإلا تُولَّد مسودة بزرّي حفظ/تجاهل. */
export async function handleJournalCommand(chatId: number | string): Promise<void> {
  const supabase = createAdminClient();
  const monday = weekOf();
  const { data: existing } = await supabase
    .from("journal_entries")
    .select("learned, failed, succeeded, changed")
    .eq("week_of", monday)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    await sendMessage(
      chatId,
      [
        "📔 مذكرة هذا الأسبوع محفوظة ✓",
        "",
        `${MARK_LEARNED} ${fieldOrDash(existing.learned as string | null)}`,
        `${MARK_FAILED} ${fieldOrDash(existing.failed as string | null)}`,
        `${MARK_SUCCEEDED} ${fieldOrDash(existing.succeeded as string | null)}`,
        `${MARK_CHANGED} ${fieldOrDash(existing.changed as string | null)}`,
        "",
        "عدّلها من «الرؤى» متى شئت.",
      ].join("\n"),
    );
    return;
  }

  await sendMessage(chatId, "✍️ يولّد مسودة المذكرة من وقائع أسبوعك…");
  const r = await generateJournalDraft(supabase);
  if (!r.ok) {
    await sendMessage(chatId, r.error);
    return;
  }
  await sendMessage(chatId, renderJournalDraft(r.draft), [
    [
      { text: "احفظها ✓", callback_data: "jr:save" },
      { text: "تجاهل", callback_data: "jr:skip" },
    ],
  ]);
}

type JournalCallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number }; text?: string };
};

/** أزرار المذكرة (jr:) — النمط الإلزامي: تحرير فوري بلا لوحة + العمل الثقيل في after(). */
export async function handleJournalCallback(
  cbq: JournalCallbackQuery,
  chatId: number | string,
): Promise<void> {
  const messageId = cbq.message?.message_id;
  if (messageId === undefined) {
    await answerCallbackQuery(cbq.id);
    return;
  }

  if (cbq.data === "jr:skip") {
    await answerCallbackQuery(cbq.id, "تمام");
    await editMessageText(chatId, messageId, "📔 تمام — ما حُفظ شيء. /مذكرة متى شئت.");
    return;
  }

  if (cbq.data === "jr:save") {
    const draft = parseJournalDraftMessage(cbq.message?.text ?? "");
    if (!draft) {
      await answerCallbackQuery(cbq.id);
      await editMessageText(chatId, messageId, "تعذّرت قراءة المسودة من الرسالة — أعد /مذكرة.");
      return;
    }
    await answerCallbackQuery(cbq.id, "يحفظ…");
    await editMessageText(chatId, messageId, "📔 يحفظ…");
    after(async () => {
      try {
        const supabase = createAdminClient();
        const monday = weekOf();
        // حارس تكرار (درس المراجعات): ضغطة قديمة/مكررة لا تُنشئ مذكرة ثانية للأسبوع.
        const { data: dup } = await supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: false })
          .eq("week_of", monday)
          .limit(1);
        if ((dup ?? []).length > 0) {
          await editMessageText(chatId, messageId, "📔 سبق حفظ مذكرة هذا الأسبوع ✓");
          return;
        }
        const parts = [draft.learned, draft.failed, draft.succeeded, draft.changed]
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length === 0) {
          await editMessageText(chatId, messageId, "المسودة فارغة — أعد /مذكرة.");
          return;
        }
        const emb = await embed(parts.join("\n"));
        // الكتابة الجوهرية ترصد فشلها — Supabase لا يرمي (درس المراجعات).
        const { error } = await supabase.from("journal_entries").insert({
          week_of: monday,
          learned: draft.learned.trim() || null,
          failed: draft.failed.trim() || null,
          succeeded: draft.succeeded.trim() || null,
          changed: draft.changed.trim() || null,
          embedding: emb.ok ? emb.data : null,
        });
        if (error) {
          console.error("[jr:save] فشل إدراج المذكرة:", error.message);
          await editMessageText(chatId, messageId, "فشل حفظ المذكرة: " + error.message);
          return;
        }
        await editMessageText(
          chatId,
          messageId,
          "📔 حُفظت مذكرة الأسبوع ✓ — عدّلها من «الرؤى» متى شئت.",
        );
      } catch (e) {
        console.error("[jr:save]", e);
        await editMessageText(chatId, messageId, "تعذّر الحفظ الآن — حاول لاحقاً.");
      }
    });
    return;
  }

  await answerCallbackQuery(cbq.id);
}

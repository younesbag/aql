import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendMessage,
  sendLongMessage,
  editMessageText,
  answerCallbackQuery,
  type InlineKeyboard,
} from "@/lib/telegram/api";

// ════════════════════════════════════════════════════════════
// مسودات إكس من الجيب (الملف 15): عرض → نصّ كامل للنسخ → وسم النشر → حذف بتأكيد.
// يغلق النصف المكسور من حلقة الأداء: مطالبة الأرقام المسائية لا تنطلق إلا لمنشور
// «نُشر»، والوسم كان حبيس الويب — فكانت حلقة تعيش في تيليجرام تشترط زيارة الموقع
// في منتصفها. منطق الوسم/الحذف مرآة إجراءات الويب (markDraftPublished/deleteDraft).
// ════════════════════════════════════════════════════════════

type DraftRow = {
  id: string;
  hook_text: string | null;
  draft_text: string;
  final_text: string | null;
  quality_score: number | null;
};

const excerpt = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).trim() + "…";
};

type DraftText = Pick<DraftRow, "hook_text" | "draft_text">;
const draftExcerpt = (d: DraftText): string => excerpt(d.hook_text || d.draft_text);

// أعلى المسودات جودةً (فالأحدث) — نفس ترتيب اقتراح النشر في محرك الخطة.
async function fetchDrafts(limit = 5): Promise<DraftRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("posts")
    .select("id, hook_text, draft_text, final_text, quality_score")
    .eq("status", "draft")
    .order("quality_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as DraftRow[];
}

function renderDraftsList(drafts: DraftRow[]): { text: string; keyboard: InlineKeyboard } {
  const lines = [`📮 مسوداتك الجاهزة (${drafts.length}):`, ""];
  drafts.forEach((d, i) => {
    const q = d.quality_score != null ? ` — جودة ${d.quality_score}` : "";
    lines.push(`${i + 1}. «${draftExcerpt(d)}»${q}`);
  });
  lines.push("", "«نص» يرسل النص الكامل للنسخ · «نشرت» توسمها منشورة فتُسأل أرقامها لاحقاً.");

  const keyboard: InlineKeyboard = drafts.map((d, i) => [
    { text: `نص ${i + 1} 📄`, callback_data: `df:txt:${d.id}` },
    { text: `نشرت ${i + 1} ✓`, callback_data: `df:pub:${d.id}` },
    { text: `حذف ${i + 1} ✗`, callback_data: `df:del:${d.id}` },
  ]);
  return { text: lines.join("\n"), keyboard };
}

/** الأمر /مسودات: قائمة أعلى ٥ مسودات بأزرار نص/نشر/حذف. */
export async function handleDraftsCommand(chatId: number | string): Promise<void> {
  const drafts = await fetchDrafts();
  if (drafts.length === 0) {
    await sendMessage(chatId, "ما فيه مسودات محفوظة — ولّد واحفظ من «المحتوى» أولاً.");
    return;
  }
  const { text, keyboard } = renderDraftsList(drafts);
  await sendMessage(chatId, text, keyboard);
}

type DraftsCallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
};

/** أزرار المسودات (df:) — الثقيل منها بالنمط الإلزامي: تحرير فوري بلا لوحة + after(). */
export async function handleDraftsCallback(
  cbq: DraftsCallbackQuery,
  chatId: number | string,
): Promise<void> {
  const data = cbq.data ?? "";
  const messageId = cbq.message?.message_id;
  const [, action, ...rest] = data.split(":");
  const id = rest.join(":");
  if (messageId === undefined) {
    await answerCallbackQuery(cbq.id);
    return;
  }

  const supabase = createAdminClient();

  // نصّ كامل للنسخ — رسالة جديدة (القائمة تبقى صالحة للأزرار الأخرى).
  if (action === "txt") {
    await answerCallbackQuery(cbq.id, "يرسل النص…");
    const { data: post } = await supabase
      .from("posts")
      .select("draft_text, final_text")
      .eq("id", id)
      .maybeSingle();
    if (!post) {
      await sendMessage(chatId, "ما لقيت المسودة — ربما حُذفت. أعد /مسودات.");
      return;
    }
    await sendLongMessage(chatId, (post.final_text as string | null) || (post.draft_text as string));
    return;
  }

  // وسم النشر — يفتح نافذة مطالبة الأرقام المسائية (١–٣ أيام) تلقائياً.
  if (action === "pub") {
    await answerCallbackQuery(cbq.id, "يوسمها…");
    await editMessageText(chatId, messageId, "📮 يوسمها منشورة…");
    after(async () => {
      try {
        // حارس إعادة الدخول: من draft فقط — ضغطة مكررة لا تدهس published_at قائماً.
        const { data: post, error } = await supabase
          .from("posts")
          .update({ status: "published", published_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "draft")
          .select("item_id, hook_text, draft_text")
          .maybeSingle();
        if (error) {
          console.error("[df:pub] فشل الوسم:", error.message);
          await editMessageText(chatId, messageId, "فشل وسم النشر: " + error.message);
          return;
        }
        if (!post) {
          await editMessageText(chatId, messageId, "✅ سبق وسمها منشورة (أو حُذفت).");
          return;
        }
        // دورة حياة الفكرة (الملف 14 — البند ١) — مرآة markDraftPublished في الويب.
        const itemId = post.item_id as string | null;
        if (itemId) {
          const { error: itemErr } = await supabase
            .from("items")
            .update({ status: "published" })
            .eq("id", itemId);
          if (itemErr) console.error("[df:pub] تعذّر تحديث حالة الفكرة:", itemErr.message);
        }
        await editMessageText(
          chatId,
          messageId,
          `✅ «${draftExcerpt(post as DraftText)}» وُسمت منشورة — أسألك عن أرقامها تلقائياً بعد يوم إلى ثلاثة.`,
        );
      } catch (e) {
        console.error("[df:pub]", e);
        await editMessageText(chatId, messageId, "تعذّر الوسم الآن — حاول لاحقاً.");
      }
    });
    return;
  }

  // حذف بخطوتين (كما في الويب) — التأكيد يحرّر نفس الرسالة.
  if (action === "del") {
    await answerCallbackQuery(cbq.id);
    const { data: post } = await supabase
      .from("posts")
      .select("hook_text, draft_text")
      .eq("id", id)
      .maybeSingle();
    const label = post ? `«${draftExcerpt(post as DraftText)}»` : "هذه المسودة";
    await editMessageText(chatId, messageId, `🗑 حذف نهائي لـ${label}؟ ما له رجعة.`, [
      [
        { text: "تأكيد الحذف ✗", callback_data: `df:delok:${id}` },
        { text: "تراجع ↩", callback_data: "df:back" },
      ],
    ]);
    return;
  }

  if (action === "delok") {
    await answerCallbackQuery(cbq.id, "يحذف…");
    await editMessageText(chatId, messageId, "🗑 يحذف…");
    after(async () => {
      try {
        const { error } = await supabase.from("posts").delete().eq("id", id);
        if (error) {
          console.error("[df:delok] فشل الحذف:", error.message);
          await editMessageText(chatId, messageId, "فشل الحذف: " + error.message);
          return;
        }
        await editMessageText(chatId, messageId, "🗑 حُذفت نهائياً.");
      } catch (e) {
        console.error("[df:delok]", e);
        await editMessageText(chatId, messageId, "تعذّر الحذف الآن — حاول لاحقاً.");
      }
    });
    return;
  }

  if (action === "back") {
    await answerCallbackQuery(cbq.id, "رجعنا");
    const drafts = await fetchDrafts();
    if (drafts.length === 0) {
      await editMessageText(chatId, messageId, "ما فيه مسودات محفوظة.");
      return;
    }
    const { text, keyboard } = renderDraftsList(drafts);
    await editMessageText(chatId, messageId, text, keyboard);
    return;
  }

  await answerCallbackQuery(cbq.id);
}

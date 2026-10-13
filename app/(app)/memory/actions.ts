"use server";

import { createClient } from "@/lib/supabase/server";
import { retrieveRelevant } from "@/lib/memory/retrieve";
import { pro } from "@/lib/ai/gemini";
import { OWNER_NAME } from "@/lib/config/owner";
import { sourceAr } from "@/lib/memory/sourceLabels";

// حصن القناة: المُستجوِب خلف المصادقة.
async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("غير مصرّح — سجّل الدخول.");
}

export type OracleSource = {
  n: number;
  date: string;
  snippet: string;
  source_type: string;
};

export type OracleAnswer = {
  answer: string;
  sources: OracleSource[];
};

// المُستجوِب: يسترجع أكثر العناصر صلةً، يحقنها كسياق في Gemini Pro،
// ويجيب بالعربية مستشهداً بالأرقام — ولا يخترع.
export async function askOracle(question: string): Promise<OracleAnswer> {
  await requireUser();
  const q = question.trim();
  if (!q) throw new Error("اكتب سؤالاً.");

  const r = await retrieveRelevant(q, 12);
  if (!r.ok) throw new Error(r.error);
  const items = r.data;

  if (items.length === 0) {
    return {
      answer: "لا أجد في ذاكرتك ما يتعلّق بهذا السؤال بعد.",
      sources: [],
    };
  }

  const context = items
    .map((it, i) => {
      const date = new Date(it.created_at).toLocaleDateString("ar");
      return `[${i + 1}] (${sourceAr(it.source_type)} · ${date}) ${it.raw_text}`;
    })
    .join("\n");

  const prompt = `أنت «ذاكرة ${OWNER_NAME}» — تسترجع وتلخّص من أرشيف ${OWNER_NAME} (أفكاره، قراراته الموثّقة، ومراجعاته الأسبوعية) فقط، ولا تخترع.

قواعد صارمة:
- أجب فقط بناءً على العناصر المسترجَعة أدناه.
- إن لم تكفِ العناصر للإجابة، قل ذلك صراحةً ولا تخمّن.
- استشهد برقم العنصر بين قوسين (مثل [1] أو [3]) عند كل ادعاء.
- أجب بالعربية، بإيجاز ووضوح.

العناصر المسترجَعة:
${context}

سؤال ${OWNER_NAME}: ${q}`;

  const ans = await pro(prompt);
  if (!ans.ok) throw new Error(ans.error);

  const sources: OracleSource[] = items.map((it, i) => ({
    n: i + 1,
    date: new Date(it.created_at).toLocaleDateString("ar"),
    snippet: (it.summary || it.raw_text).slice(0, 140),
    source_type: it.source_type,
  }));

  return { answer: ans.data, sources };
}

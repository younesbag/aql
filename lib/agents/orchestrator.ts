import "server-only";
import { Type, type Content, type Part, type Tool, type FunctionCall } from "@google/genai";
import { generateWithTools, MODELS } from "@/lib/ai/gemini";
import {
  retrieveContext,
  type ContextSource,
  type PerformanceQuery,
} from "@/lib/agents/access";
import { dedupeSources } from "@/lib/agents/util";
import {
  analyzePatterns,
  measureAgainstSuccess,
  linkToProject,
  extractDecisions,
} from "@/lib/agents/specialists";
import { SELF_KNOWLEDGE } from "@/lib/agents/self-knowledge";
import { getSystemStatus } from "@/lib/agents/status";
import { summarizeTasksForMind } from "@/lib/dayplan/reports";
import { TASK_PROJECTS } from "@/lib/capture/task";
import { OWNER_NAME } from "@/lib/config/owner";

// ════════════════════════════════════════════════════════════
// المنسّق — العقل الموحّد (الملف 08، المرحلة ٢).
// يستقبل رسالة المالك + تاريخ المحادثة المتصل، ويوجّه عبر function calling إلى
// أدوات الجلب في طبقة الوصول (دلالي/أداء/ويب)، ثم يكوّن جواباً مؤرَّضاً بالمصادر.
// لا إطار وكلاء — نداء Gemini بأدوات تحت حلقة محدودة. server-only (يحترم RLS).
// ════════════════════════════════════════════════════════════

export type ChatTurn = { role: "user" | "model"; text: string };

export type OrchestratorResult = {
  answer: string;
  sources: ContextSource[];
};

const MAX_HISTORY_TURNS = 40; // نافذة المحادثة: آخر N دوراً (~٢٠ تبادلاً). النماذج تتّسع لمليون رمز — الحدّ للتكلفة لا للقدرة
const MAX_TOOL_ROUNDS = 3; // سقف جولات استدعاء الأدوات (يمنع حلقة لا تنتهي)

// ── تعريفات الأدوات (الموجّه يختار منها عبر function calling) ──
const TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "search_memory",
        description:
          `ابحث دلالياً في كل ذاكرة ${OWNER_NAME}: أفكاره، تغريداته، إيميلاته، ملفاته، قراراته، ومذكرته. استخدمها لأسئلة المعنى والمحتوى — ماذا قال أو كتب أو قرّر عن موضوع ما.`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "نص البحث: الموضوع أو المعنى المطلوب." },
            count: { type: Type.NUMBER, description: "عدد النتائج (اختياري، افتراضي 10)." },
          },
          required: ["query"],
        },
      },
      {
        name: "query_performance",
        description:
          `استعلم أرقام أداء منشورات ${OWNER_NAME} المنشورة على إكس. استخدمها لأسئلة الأرقام والترتيب: الأعلى أو الأدنى تفاعلاً، أو الأفضل أداءً في موضوع معيّن. لا تستخدمها لأسئلة المعنى.`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            kind: {
              type: Type.STRING,
              enum: ["top", "bottom", "byTopic"],
              description: "top=الأعلى تفاعلاً، bottom=الأدنى تفاعلاً، byTopic=الأقرب لموضوع معيّن.",
            },
            topic: { type: Type.STRING, description: "الموضوع (مطلوب مع byTopic فقط)." },
            limit: { type: Type.NUMBER, description: "عدد النتائج (اختياري)." },
            sinceDays: { type: Type.NUMBER, description: "حصر بآخر N يوماً (اختياري)." },
          },
          required: ["kind"],
        },
      },
      {
        name: "search_web",
        description:
          `ابحث حيّاً على الويب لمعلومة خارجية أو حديثة ليست في بيانات ${OWNER_NAME} (أداة جديدة، حدث، خبر). لا تستخدمها للأسئلة عن بيانات ${OWNER_NAME} نفسها.`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "استعلام البحث على الويب." },
          },
          required: ["query"],
        },
      },
      {
        name: "analyze_patterns",
        description:
          `تحليل عميق لأنماط محتوى ${OWNER_NAME} (لا مجرّد جلب أرقام). mode=success: أنماط نجاح محتواه. mode=gaps: المواضيع المهملة التي تخدم المشروع ولا يكتب عنها. mode=contradiction: هل قرار/رأي جديد يناقض قراراً سابقاً (يتطلّب input). استخدمها لطلبات «حلّل أنماطي/فجواتي/تناقض قراري».`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            mode: {
              type: Type.STRING,
              enum: ["success", "gaps", "contradiction"],
              description: "success=أنماط النجاح، gaps=الفجوات مقابل المشروع، contradiction=تناقض قرار.",
            },
            input: { type: Type.STRING, description: "القرار/الرأي الجديد (لـcontradiction فقط)." },
          },
          required: ["mode"],
        },
      },
      {
        name: "measure_against_success",
        description:
          `يقيس مسودة أو فكرة مقابل أنماط نجاح ${OWNER_NAME}. mode=predict: توقّع أداء مسودة قبل نشرها. mode=confront: مواجهة تردّد ${OWNER_NAME} في فكرة بالدليل. يتطلّب input (نصّ المسودة/الفكرة).`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            input: { type: Type.STRING, description: "نصّ المسودة أو الفكرة." },
            mode: {
              type: Type.STRING,
              enum: ["predict", "confront"],
              description: "predict=توقّع الأداء، confront=مواجهة التردّد.",
            },
          },
          required: ["input", "mode"],
        },
      },
      {
        name: "link_to_project",
        description:
          "يربط فكرة/محتوى بأهداف المشروع وشخصياته (جمهوره) وعروضه — يحوّل الفكرة من محتوى إلى محرّك نموّ. يتطلّب content.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING, description: "الفكرة/المحتوى المراد ربطه بالمشروع." },
          },
          required: ["content"],
        },
      },
      {
        name: "extract_decisions",
        description:
          "يكتشف القرارات الاستراتيجية في نصّ ملتقط ويهيّئها للتوثيق بالبنية (موقف/قرار/سبب). يتطلّب text.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "النصّ الملتقط لاستخراج القرارات منه." },
          },
          required: ["text"],
        },
      },
      {
        name: "system_status",
        description:
          "حالة «العقل» الراهنة: كم يعرف فعلاً (عناصر/منشورات/قرارات/مذكرة/محادثات) وحدود ذلك. استخدمها لأسئلة الحالة والأرقام عن نفسه: «ما حالتك؟ كم تعرف؟ كم قراراً وثّقت؟ ما حجم ذاكرتك؟» — أرقام حالته لا محتوى البيانات.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "query_tasks",
        description:
          `استعلم عن مهام ${OWNER_NAME} وخطّته اليومية ومعدّل إنجازه (مدير اليوم). kind=open: المهام المفتوحة (مع project اختياري للتصفية). kind=today_plan: خطة اليوم وحالتها. kind=completed_week: ماذا أنجز هذا الأسبوع. لأسئلة مثل «وش مهامي المفتوحة للمشروع؟»، «كم أنجزت هالأسبوع؟»، «وش خطة اليوم؟».`,
        parameters: {
          type: Type.OBJECT,
          properties: {
            kind: {
              type: Type.STRING,
              enum: ["open", "today_plan", "completed_week"],
              description: "open=مهام مفتوحة، today_plan=خطة اليوم، completed_week=منجَز الأسبوع.",
            },
            project: {
              type: Type.STRING,
              enum: [...TASK_PROJECTS],
              description: "تصفية المهام المفتوحة بمشروع (اختياري، مع open).",
            },
          },
          required: ["kind"],
        },
      },
    ],
  },
];

const SYSTEM = `أنت «العقل» — مساعد ${OWNER_NAME} الذكي الذي يعرفه عبر كل بياناته (تغريدات، أداء، إيميلات، ملفات، قرارات، مذكرة).

مبادئ إلزامية:
- افهم السؤال ضمن سياق المحادثة المتصلة (الأسئلة تبني على أجوبة سابقة — قد تعود «انتشارها» أو «هذا» لشيء ذُكر قبل قليل).
- لجلب المعلومة استخدم الأدوات: search_memory لأسئلة المعنى/المحتوى، query_performance لأسئلة الأرقام/الأداء، search_web للمعلومة الخارجية الحديثة فقط. لك أن تستدعي أكثر من أداة لسؤال مركّب.
- للتحليل العميق استخدم: analyze_patterns (أنماط نجاحك/فجواتك/تناقض قرار)، measure_against_success (تقييم أداء مسودة أو مواجهة تردّدك في فكرة)، link_to_project (ربط فكرة بالمشروع)، extract_decisions (استخراج قرارات من نصّ). قدّم نتائج الأدوات التحليلية كاملةً دون اختصار مُخلّ.
- لأسئلة حالتك الراهنة (كم تعرف؟ كم قراراً وثّقت؟ ما حدود بياناتك الآن؟): system_status.
- لأسئلة المهام والخطّة اليومية ومعدّل الإنجاز (مدير اليوم): query_tasks — «وش مهامي المفتوحة للمشروع؟»، «وش خطة اليوم؟»، «كم أنجزت هالأسبوع؟».
- أجب بالعربية، بإيجاز ووضوح وصدق.
- حدّ الصدق المطلق: اعتمد فقط على ما تُرجعه الأدوات. لا تخترع رقماً ولا اقتباساً. إن لم تكفِ البيانات، قل ذلك صراحةً.
- استشهد دائماً: اذكر مصادرك من بيانات ${OWNER_NAME} داخل الجواب (نوع المصدر).
- إن كان السؤال محادثة عامة لا تحتاج بيانات، أجب مباشرةً بلا أدوات.

${SELF_KNOWLEDGE}`;

// ينفّذ أداة جلب واحدة عبر طبقة الوصول، يجمع مصادرها في sink، ويُرجع كتلة السياق للنموذج.
// useAdmin: للعقل من تيليجرام (بلا جلسة) — بدونه عميلُ الجلسة بلا كوكيز فتحجب RLS كل شيء.
async function executeTool(
  call: FunctionCall,
  sink: ContextSource[],
  useAdmin: boolean,
): Promise<string> {
  const args = call.args ?? {};
  let block = "(لا نتائج ذات صلة)";

  if (call.name === "search_memory") {
    const ctx = await retrieveContext(
      String(args.query ?? ""),
      {
        semantic: true,
        semanticCount: typeof args.count === "number" ? args.count : undefined,
      },
      useAdmin,
    );
    sink.push(...ctx.sources);
    block = ctx.block || block;
  } else if (call.name === "query_performance") {
    const kind = args.kind === "bottom" || args.kind === "byTopic" ? args.kind : "top";
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const perf: PerformanceQuery =
      kind === "byTopic"
        ? { kind, topic: args.topic ? String(args.topic) : undefined, limit }
        : {
            kind,
            limit,
            sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
          };
    const ctx = await retrieveContext(
      String(args.topic ?? args.query ?? ""),
      { semantic: false, performance: perf },
      useAdmin,
    );
    sink.push(...ctx.sources);
    block = ctx.block || block;
  } else if (call.name === "search_web") {
    const ctx = await retrieveContext(String(args.query ?? ""), { semantic: false, web: true });
    sink.push(...ctx.sources);
    block = ctx.block || block;
  } else if (call.name === "analyze_patterns") {
    const mode =
      args.mode === "gaps" || args.mode === "contradiction" ? args.mode : "success";
    const r = await analyzePatterns(mode, String(args.input ?? ""), useAdmin);
    sink.push(...r.sources);
    block = `تحليل الأنماط (${mode}):\n${r.findings}\nإشارات: ${r.signals.join(" · ") || "—"}`;
  } else if (call.name === "measure_against_success") {
    const mode = args.mode === "confront" ? "confront" : "predict";
    const r = await measureAgainstSuccess(String(args.input ?? ""), mode, useAdmin);
    sink.push(...r.sources);
    block = `${r.verdict}\nالأداء المتوقّع: ${r.expectedTier ?? "—"}\nأدلّة: ${r.evidence.join(" · ") || "—"}`;
  } else if (call.name === "link_to_project") {
    const r = await linkToProject(String(args.content ?? ""), useAdmin);
    sink.push(...r.sources);
    block = `الشخصيات المخدومة: ${r.personas.join("، ") || "—"}\nيخدم هدف المشروع: ${r.serves_goal || "—"}\nالزاوية المقترحة: ${r.suggested_angle || "—"}\nربط الحزمة: ${r.package_hook || "—"}`;
  } else if (call.name === "extract_decisions") {
    const r = await extractDecisions(String(args.text ?? ""));
    block = r.decisions.length
      ? r.decisions
          .map(
            (d, i) =>
              `قرار ${i + 1}:\n  الموقف: ${d.situation}\n  القرار: ${d.decision}\n  السبب: ${d.reasoning}`,
          )
          .join("\n\n") + (r.note ? `\nملاحظة: ${r.note}` : "")
      : `لا قرارات استراتيجية واضحة في النصّ. ${r.note}`;
  } else if (call.name === "system_status") {
    const r = await getSystemStatus(useAdmin);
    block = r.summary;
  } else if (call.name === "query_tasks") {
    const kind =
      args.kind === "today_plan" || args.kind === "completed_week"
        ? args.kind
        : "open";
    const allowed: readonly string[] = TASK_PROJECTS;
    const project =
      typeof args.project === "string" && allowed.includes(args.project)
        ? args.project
        : undefined;
    block = await summarizeTasksForMind(kind, project);
  } else {
    return "(أداة غير معروفة)";
  }
  return block;
}

// الواجهة الرئيسية: محادثة متصلة → توجيه بالأدوات → جواب مؤرَّض بالمصادر.
// opts.useAdmin: للعقل من تيليجرام — تنتقل لكل الأدوات (الملف 13، البند ١).
export async function orchestrate(
  message: string,
  history: ChatTurn[] = [],
  opts: { useAdmin?: boolean } = {},
): Promise<OrchestratorResult> {
  const useAdmin = opts.useAdmin === true;
  const trimmed = message.trim();
  if (!trimmed) return { answer: "اكتب سؤالك.", sources: [] };

  // سياق المحادثة المتصل (مقصوص لآخر N دوراً لإدارة الطول).
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const contents: Content[] = [
    ...recent.map((t) => ({ role: t.role, parts: [{ text: t.text }] as Part[] })),
    { role: "user", parts: [{ text: trimmed }] },
  ];

  const sources: ContextSource[] = [];
  let toolsUsed = false;
  let directAnswer = "";

  // التوجيه (اختيار الأداة) على flash — تصنيفٌ سريع رخيص يناسبه flash (الدستور).
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await generateWithTools(contents, TOOLS, SYSTEM, MODELS.flash);
    if (!res.ok) {
      return { answer: "تعذّر تكوين الجواب: " + res.error, sources: dedupeSources(sources) };
    }

    const calls = res.data.functionCalls;
    if (!calls || calls.length === 0) {
      directAnswer = res.data.text ?? ""; // لا أدوات (محادثة عامة) → جواب flash المباشر
      break;
    }

    toolsUsed = true;
    // دوّن دور النموذج كما أرجعه (يحمل thought_signature عند الحاجة) ثم نفّذ أدواته.
    contents.push(
      res.data.modelContent ?? {
        role: "model",
        parts: calls.map((c) => ({ functionCall: c })),
      },
    );
    const blocks = await Promise.all(calls.map((c) => executeTool(c, sources, useAdmin)));
    const responseParts: Part[] = calls.map((c, i) => ({
      functionResponse: { name: c.name ?? "", response: { context: blocks[i] } },
    }));
    contents.push({ role: "user", parts: responseParts });
  }

  // التركيب: إن استُخدمت أدوات، يكوّن pro الجواب النهائي المؤرَّض من البيانات المجموعة
  // (الجودة حيث تهمّ). وإلّا فجواب flash المباشر يكفي (محادثة لا تحتاج بيانات).
  let answer: string;
  if (toolsUsed) {
    const final = await generateWithTools(contents, [], SYSTEM, MODELS.pro);
    answer =
      (final.ok && final.data.text) || directAnswer || "تعذّر تكوين جواب من البيانات المتاحة.";
  } else {
    answer = directAnswer || "تعذّر تكوين جواب.";
  }

  return { answer: answer.trim(), sources: dedupeSources(sources) };
}

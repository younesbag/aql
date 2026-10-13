import type { SupabaseClient } from "@supabase/supabase-js";

// ════════════════════════════════════════════════════════════
// تحديث الدفء الأسبوعي (الملف 34) — يجري على عامل الـVPS.
//
// المعادلة (نفس تصنيف 2026-08-15 الأولي): الدرجة من مئة =
//   ٤٥٪ حداثة (تحلّل أسّي بنصف عمر ٤٥ يوماً من آخر نشاط)
// + ٣٥٪ معدل فتح (حملات مفتوحة ÷ حملات مستلمة)
// + ٢٠٪ نقر (نقرة واحدة = نصف، نقرتان فأكثر = كامل).
//
// المصادر: الأساس التاريخي الثابت في email_warmth (لقطة لوحة لوبس حتى
// 2026-08-15) + أحداث webhook الملف 33 (email_events) بعد خط الأساس.
// التجميع يُحسب من الأحداث الخام في كل تشغيل — لا عدّادات تنجرف.
// الكتابة للوبس عند التغيّر فقط (طبقة مختلفة أو فرق درجة ≥ ٢).
// ════════════════════════════════════════════════════════════

const HALF_LIFE_DAYS = 45;
const LOOPS_BASE = "https://app.loops.so/api/v1";

type WarmthRow = {
  id: string;
  email: string;
  base_sends: number;
  base_opens: number;
  base_clicked: number;
  base_sales_clicks: number;
  base_last_activity_at: string | null;
  baseline_at: string;
  warmth: string;
  score: number;
  sales_clicks: number;
  replied: number;
  conversion_stage: string | null;
};

type EventAgg = {
  delivered: Set<string>;
  opened: Set<string>;
  clicked: Set<string>;
  clickedSales: Set<string>; // حملات بيعية (موسومة في loops_campaigns) نُقرت
  replied: number; // ردود مسجّلة بأمر /رد (الملف 37) — أقوى إشارة
  lastActivity: number; // ms
  unsubscribed: boolean;
  bounced: boolean;
};

export type WarmthSummary = {
  contacts: number;
  eventsRead: number;
  newContacts: number;
  changed: number;
  written: number;
  writeFailed: number;
  skippedGone: number; // ملغون/مرتدون — لا كتابة لهم
  replies: number; // ردود مسجّلة (الملف 37)
  conversions: number; // جهات بمرحلة تحويل مرصودة منذ الأساس
  tiers: Record<string, number>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function computeTier(sends: number, opens: number, score: number): string {
  // لم يُختبر بعد: بأمر المالك 2026-09-29 كل منضم جديد «دافئ» (كان "new" فتسقطه كل حملة مفلترة بالدفء)
  if (sends <= 3 && opens === 0) return "warm";
  if (score >= 55) return "vhot";
  if (score >= 30) return "warm";
  if (score >= 12) return "lukewarm";
  return "cold";
}

export async function runWarmthRefresh(
  db: SupabaseClient,
  opts: { loopsKey: string; log: (m: string) => void },
): Promise<WarmthSummary> {
  const { loopsKey, log } = opts;
  const H = { Authorization: `Bearer ${loopsKey}`, "Content-Type": "application/json" };
  const now = Date.now();

  // ── ١) كل صفوف الأساس (ترقيم — supabase-js يسقف الصفحة عند ألف) ──
  const rows: WarmthRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("email_warmth")
      .select(
        "id, email, base_sends, base_opens, base_clicked, base_sales_clicks, base_last_activity_at, baseline_at, warmth, score, sales_clicks, replied, conversion_stage",
      )
      .order("email")
      .range(from, from + 999);
    if (error) throw new Error("قراءة email_warmth: " + error.message);
    rows.push(...((data ?? []) as WarmthRow[]));
    if (!data || data.length < 1000) break;
  }
  const baselineAt = rows[0]?.baseline_at ?? new Date(0).toISOString();

  // ── الحملات البيعية المنشورة من النظام (الملف 35): نقراتها ترفع العدّاد
  //    البيعي الحي — ما كان مستحيلاً قبل وسم الغرض لحظة النشر ──
  const SALES_PURPOSES = new Set(["revive", "proof", "close", "recovery"]);
  const salesCampaignIds = new Set<string>();
  {
    const { data } = await db.from("loops_campaigns").select("campaign_id, purpose");
    for (const c of data ?? []) {
      if (c.purpose && SALES_PURPOSES.has(String(c.purpose))) salesCampaignIds.add(String(c.campaign_id));
    }
  }

  // ── التحويل (الملف 37): أحداث contact.* تحمل حالة الجهة كما يكتبها
  //    تطبيقك في لوبس (status/userGroup) — أحدث حالة لكل بريد تُعتمد ──
  const conv = new Map<string, { stage: string; at: string }>();
  {
    const { data } = await db
      .from("email_events")
      .select("contact_email, payload, occurred_at, received_at")
      .like("event_name", "contact.%")
      .gte("received_at", baselineAt)
      .order("received_at");
    for (const ev of data ?? []) {
      const email = (ev.contact_email as string | null)?.toLowerCase();
      const c = (ev.payload as Record<string, unknown> | null)?.contact as
        | Record<string, unknown>
        | undefined;
      if (!email || !c) continue;
      const group = typeof c.userGroup === "string" ? c.userGroup.trim() : "";
      const status = typeof c.status === "string" ? c.status.trim() : "";
      // مجموعة غير مجانية = مرحلة أعمق من مجرد التسجيل؛ وإلا فالحالة كما وصلت
      const stage = group && group !== "free" ? group : status || null;
      if (!stage) continue;
      conv.set(email, { stage, at: String(ev.occurred_at ?? ev.received_at) });
    }
  }

  // ── ٢) أحداث ما بعد خط الأساس، مجمّعة لكل مشترك ──
  // مفتاح «الرسالة» حملةٌ أو تدفّق أو موضوع — يوحّد الفريد عبر المصادر الثلاثة
  const agg = new Map<string, EventAgg>();
  let eventsRead = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("email_events")
      .select("event_name, contact_email, campaign_id, loop_id, transactional_id, subject, occurred_at, received_at")
      .gte("received_at", baselineAt)
      .order("received_at")
      .range(from, from + 999);
    if (error) throw new Error("قراءة email_events: " + error.message);
    for (const ev of data ?? []) {
      const email = (ev.contact_email as string | null)?.toLowerCase();
      if (!email) continue;
      eventsRead++;
      let a = agg.get(email);
      if (!a) {
        a = { delivered: new Set(), opened: new Set(), clicked: new Set(), clickedSales: new Set(), replied: 0, lastActivity: 0, unsubscribed: false, bounced: false };
        agg.set(email, a);
      }
      const msgKey =
        (ev.campaign_id as string | null) ??
        (ev.loop_id as string | null) ??
        (ev.transactional_id as string | null) ??
        (ev.subject as string | null) ??
        "unknown";
      const ts = new Date((ev.occurred_at as string | null) ?? (ev.received_at as string)).getTime();
      switch (ev.event_name as string) {
        case "email.delivered":
        case "campaign.email.sent":
          a.delivered.add(msgKey);
          break;
        case "email.opened":
          a.opened.add(msgKey);
          if (ts > a.lastActivity) a.lastActivity = ts;
          break;
        case "email.clicked":
          a.clicked.add(msgKey);
          if (ev.campaign_id && salesCampaignIds.has(String(ev.campaign_id)))
            a.clickedSales.add(String(ev.campaign_id));
          if (ts > a.lastActivity) a.lastActivity = ts;
          break;
        case "email.replied":
          a.replied++;
          if (ts > a.lastActivity) a.lastActivity = ts;
          break;
        case "email.unsubscribed":
          a.unsubscribed = true;
          break;
        case "email.hardBounced":
          a.bounced = true;
          break;
      }
    }
    if (!data || data.length < 1000) break;
  }

  // ── ٣) مشتركون جدد ظهروا في الأحداث ولا صفّ لهم — يُزرعون بأساس صفري ──
  const known = new Set(rows.map((r) => r.email));
  let newContacts = 0;
  for (const [email, a] of agg) {
    if (known.has(email) || a.unsubscribed || a.bounced) continue;
    rows.push({
      id: "",
      email,
      base_sends: 0,
      base_opens: 0,
      base_clicked: 0,
      base_sales_clicks: 0,
      base_last_activity_at: null,
      baseline_at: baselineAt,
      warmth: "warm",
      score: -1, // الزرع نفسه (id فارغ) يضمن كتابته — انظر `seeded` أدناه
      sales_clicks: 0,
      replied: 0,
      conversion_stage: null,
    });
    newContacts++;
  }

  // ── ٤) الحساب والفرز: من تغيّرت طبقته أو درجته ──
  const today = new Date().toISOString().slice(0, 10);
  let repliesTotal = 0;
  for (const a of agg.values()) repliesTotal += a.replied;
  const summary: WarmthSummary = {
    contacts: rows.length, eventsRead, newContacts,
    changed: 0, written: 0, writeFailed: 0, skippedGone: 0,
    replies: repliesTotal, conversions: conv.size, tiers: {},
  };
  type Change = {
    row: WarmthRow; warmth: string; score: number;
    lastActivity: string | null; salesClicks: number;
    replied: number; conv: { stage: string; at: string } | null;
  };
  const changes: Change[] = [];
  for (const row of rows) {
    const a = agg.get(row.email);
    if (a && (a.unsubscribed || a.bounced)) { summary.skippedGone++; continue; }
    const sends = row.base_sends + (a?.delivered.size ?? 0);
    const opens = row.base_opens + (a?.opened.size ?? 0);
    const clicked = row.base_clicked + (a?.clicked.size ?? 0);
    const salesClicks = row.base_sales_clicks + (a?.clickedSales.size ?? 0);
    // الرد أقوى إشارة: يعادل نقرتين في عامل التفاعل (لا أساس تاريخي — عدّه بدأ مع الملف 37)
    const replied = a?.replied ?? row.replied;
    const lastMs = Math.max(
      row.base_last_activity_at ? new Date(row.base_last_activity_at).getTime() : 0,
      a?.lastActivity ?? 0,
    );
    const rec = lastMs > 0 ? Math.exp((-(now - lastMs) / 86_400_000) * (Math.LN2 / HALF_LIFE_DAYS)) : 0;
    const freq = sends > 0 ? opens / sends : 0;
    const click = Math.min(1, (clicked + 2 * replied) / 2);
    const score = Math.max(0, Math.min(100, Math.round(45 * rec + 35 * freq + 20 * click)));
    const warmth = computeTier(sends, opens, score);
    summary.tiers[warmth] = (summary.tiers[warmth] ?? 0) + 1;
    const cv = conv.get(row.email) ?? null;
    // مشترك زُرع في هذا التشغيل (id فارغ) يُكتب دائماً. قبل هذا كان يُتجاوز بصمت إن خرجت درجته 0
    // (فرق 1 عن -1 أقل من عتبة 2) ولا مرحلة تحويل له — جهات المدفوعات وروتين المتابعة بلا userGroup (مقيس 2026-09-29)
    const seeded = row.id === "";
    if (
      seeded ||
      warmth !== row.warmth ||
      Math.abs(score - row.score) >= 2 ||
      salesClicks !== row.sales_clicks ||
      replied !== row.replied ||
      (cv !== null && cv.stage !== row.conversion_stage)
    ) {
      changes.push({
        row, warmth, score, salesClicks, replied,
        conv: cv !== null && cv.stage !== row.conversion_stage ? cv : null,
        lastActivity: lastMs > 0 ? new Date(lastMs).toISOString() : null,
      });
    }
  }
  summary.changed = changes.length;
  log(`الدفء: ${rows.length} مشتركاً، ${eventsRead} حدثاً جديداً، ${changes.length} تغيّراً`);

  // ── ٥) الكتابة للوبس (المتغيّرون فقط، بمهلة تحت حدّ المعدل) ثم تثبيت الحالة ──
  for (const c of changes) {
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(`${LOOPS_BASE}/contacts/update`, {
          method: "PUT",
          headers: H,
          body: JSON.stringify({
            email: c.row.email,
            warmth: c.warmth,
            warmthScore: c.score,
            warmthAt: today,
            salesClicks: c.salesClicks,
            salesClicker: c.salesClicks > 0,
            replies: c.replied,
            replier: c.replied > 0,
          }),
        });
        if (r.status === 429) { await sleep(2500); continue; }
        const j = (await r.json().catch(() => ({}))) as { success?: boolean };
        ok = r.ok && j.success === true;
        break;
      } catch {
        await sleep(1500);
      }
    }
    if (ok) summary.written++;
    else summary.writeFailed++;
    // الحالة تُثبَّت محلياً حتى لو تعثّرت كتابة لوبس — التشغيل التالي يلتقط الفرق
    // لأن synced_at لا يتحدّث إلا عند النجاح.
    await db.from("email_warmth").upsert(
      {
        email: c.row.email,
        warmth: c.warmth,
        score: c.score,
        sales_clicks: c.salesClicks,
        replied: c.replied,
        ...(c.conv ? { conversion_stage: c.conv.stage, converted_at: c.conv.at } : {}),
        base_last_activity_at: c.lastActivity,
        updated_at: new Date().toISOString(),
        ...(ok ? { synced_at: new Date().toISOString() } : {}),
      },
      { onConflict: "email" },
    );
    await sleep(120);
  }
  return summary;
}

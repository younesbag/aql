// ════════════════════════════════════════════════════════════
// حصاد الأداء من إكس (الملف 25) — وحدة نقية يستدعيها العامل.
//
// لماذا على العامل لا على Vercel: كرونا Hobby مشغولان (سقف اثنين)، والحصاد
// شبكة طويلة — أربع دفعات بالمعرّفات + صفحات آخر التغريدات — لا تليق بسقف ٣٠٠ث.
//
// مساران متكاملان عمداً:
//   ١) الدقيق: posts.external_post_id (ردمته هجرة 0030 من روابط الأفكار) →
//      /twitter/tweets دفعات — تحديث مؤكَّد بلا أي تخمين.
//   ٢) الاكتشافي: /twitter/user/last_tweets → مطابقة نصّية تربط المنشورات
//      المولَّدة حديثاً (التي لا معرّف لها بعد) وتلتقط ما نُشر خارج النظام.
// ════════════════════════════════════════════════════════════

const API = "https://api.twitterapi.io";
const ID_BATCH = 50; // سقف المزود المقيس: «max 50 tweet_ids per request» (400 فوقه)
const PAGE_PAUSE_MS = 350;
const MIN_WORDS = 15; // نفس عتبة scripts/import-x-archive.mjs — لا يدخل الأرشيف ضجيج

export type HarvestSummary = {
  known: number;
  refreshed: number;
  missing: number;
  scanned: number;
  linked: number;
  inserted: number;
  skipped: number;
  impressionsGained: number;
  errors: string[];
};

type Tweet = {
  id?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  type?: string;
  isReply?: boolean;
  viewCount?: number;
  likeCount?: number;
  replyCount?: number;
  retweetCount?: number;
  bookmarkCount?: number;
};

type PostRow = {
  id: string;
  external_post_id: string | null;
  draft_text: string | null;
  final_text: string | null;
  impressions: number | null;
};

// عميل Supabase مُمرَّر من العامل — نوع فضفاض عمداً كي تبقى الوحدة بلا تبعيات
type Db = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * تطبيع للمطابقة النصّية: يُسقط الروابط (t.co يُلحق بالوسائط تلقائياً) والتشكيل
 * ومحارف الاتجاه الخفية وكل ترقيم — فيبقى جوهر الحروف والأرقام وحده.
 */
function normalizeForMatch(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, " ")
    // التشكيل (علامات) والمحارف الخفية والتطويل تُحذف بلا بديل — لو استُبدلت
    // مسافةً لشقّت الكلمة نفسها فاختلف مفتاح «مُحَمَّد» عن «محمد».
    .replace(/[\p{M}\p{Cf}\u0640]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** مفتاح المطابقة: صدر النص وحده — الثريد يُخزَّن بفاصل "\n-\n" وأول جزء هو التغريدة. */
function matchKey(s: string): string {
  return normalizeForMatch(s.split("\n-\n")[0] ?? s).slice(0, 70);
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function parseTweetDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** الأرقام الخمسة كما يقرأها النظام — غياب الحقل يعني صفراً لا «مجهولاً». */
function metricsOf(t: Tweet) {
  return {
    impressions: t.viewCount ?? 0,
    likes: t.likeCount ?? 0,
    replies: t.replyCount ?? 0,
    reposts: t.retweetCount ?? 0,
    bookmarks: t.bookmarkCount ?? 0,
  };
}

async function apiGet(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  const body = await res.text();
  if (!res.ok) throw new Error(`المزود ردّ ${res.status}: ${body.slice(0, 180)}`);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("ردّ المزود ليس JSON صالحاً: " + body.slice(0, 180));
  }
}

function tweetsOf(payload: Record<string, unknown>): Tweet[] {
  if (Array.isArray(payload.tweets)) return payload.tweets as Tweet[];
  const d = payload.data as Record<string, unknown> | undefined;
  if (d && Array.isArray(d.tweets)) return d.tweets as Tweet[];
  if (Array.isArray(payload.data)) return payload.data as Tweet[];
  return [];
}

export async function runHarvest(
  db: Db,
  opts: { apiKey: string; handle: string; maxPages?: number; log?: (m: string) => void },
): Promise<HarvestSummary> {
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? 5;
  const s: HarvestSummary = {
    known: 0, refreshed: 0, missing: 0, scanned: 0,
    linked: 0, inserted: 0, skipped: 0, impressionsGained: 0, errors: [],
  };

  // ── تحميل المنشورات المنشورة (صفحات ١٠٠٠ — تجاوز سقف صفّ PostgREST) ──
  const posts: PostRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("posts")
      .select("id, external_post_id, draft_text, final_text, impressions")
      .eq("status", "published")
      .range(from, from + 999);
    if (error) throw new Error("تعذّرت قراءة المنشورات: " + error.message);
    const page = (data ?? []) as PostRow[];
    posts.push(...page);
    if (page.length < 1000) break;
  }

  const byExternalId = new Map<string, PostRow>();
  const byText = new Map<string, PostRow>();
  for (const p of posts) {
    if (p.external_post_id) byExternalId.set(p.external_post_id, p);
    const t = p.final_text || p.draft_text;
    // الأقدم يفوز عند التكرار — لا نربط تغريدة بنسخة معادة من نفس النص
    if (t) {
      const k = matchKey(t);
      if (k.length >= 20 && !byText.has(k)) byText.set(k, p);
    }
  }
  s.known = byExternalId.size;
  log(`الحصاد: ${posts.length} منشوراً، منها ${s.known} بمعرّف تغريدة.`);

  /** يكتب أرقام تغريدة على صفّ منشور، ويحصي المكسب في المشاهدات. */
  async function writeMetrics(post: PostRow, t: Tweet): Promise<void> {
    const m = metricsOf(t);
    const { error } = await db
      .from("posts")
      .update({
        ...m,
        external_post_id: t.id ?? post.external_post_id,
        posted_url: t.url ?? null,
        metrics_updated_at: new Date().toISOString(),
        awaiting_metrics: false,
      })
      .eq("id", post.id);
    if (error) {
      s.errors.push(`تحديث ${post.id}: ${error.message}`);
      return;
    }
    s.impressionsGained += Math.max(0, m.impressions - (post.impressions ?? 0));
  }

  // ══ المسار الأول: تحديث دقيق بالمعرّفات المعروفة ══
  const ids = [...byExternalId.keys()];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const chunk = ids.slice(i, i + ID_BATCH);
    let fetched: Tweet[] = [];
    try {
      fetched = tweetsOf(await apiGet(opts.apiKey, "/twitter/tweets", { tweet_ids: chunk.join(",") }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      s.errors.push(`دفعة ${i / ID_BATCH + 1}: ${msg}`);
      continue; // دفعة فاشلة لا تُسقط الحصاد كله
    }
    const seen = new Set<string>();
    for (const t of fetched) {
      if (!t.id) continue;
      const post = byExternalId.get(t.id);
      if (!post) continue;
      seen.add(t.id);
      await writeMetrics(post, t);
      s.refreshed++;
    }
    s.missing += chunk.filter((id) => !seen.has(id)).length;
    log(`دفعة ${Math.floor(i / ID_BATCH) + 1}: حُدّث ${seen.size}/${chunk.length}.`);
    await sleep(PAGE_PAUSE_MS);
  }

  // ══ المسار الثاني: اكتشاف الجديد وربطه ══
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    let payload: Record<string, unknown>;
    try {
      payload = await apiGet(opts.apiKey, "/twitter/user/last_tweets", {
        userName: opts.handle,
        cursor,
        includeReplies: "false",
      });
    } catch (e) {
      s.errors.push(`صفحة ${page + 1}: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    const tweets = tweetsOf(payload);
    if (tweets.length === 0) break;
    s.scanned += tweets.length;

    for (const t of tweets) {
      if (!t.id) continue;
      const text = (t.text ?? "").trim();
      // ريتويت/ردّ/اقتباس ليس محتوى أصلياً — نفس فلترة استيراد الأرشيف
      if (t.isReply || (t.type && t.type !== "tweet") || /^RT @/.test(text)) {
        s.skipped++;
        continue;
      }
      if (byExternalId.has(t.id)) continue; // عولج في المسار الأول

      const m = metricsOf(t);
      const existing = byText.get(matchKey(text));
      if (existing && !existing.external_post_id) {
        await writeMetrics(existing, t);
        existing.external_post_id = t.id;
        byExternalId.set(t.id, existing);
        s.linked++;
        continue;
      }
      if (existing) continue; // مطابق لكنه مرتبط بتغريدة أخرى — لا نلمسه

      // تغريدة أصلية خارج النظام: تُضاف مادةَ أمثلة وأنماط، بشرط عتبة الأرشيف
      const eng = m.likes + m.reposts + m.replies;
      if (wordCount(text) < MIN_WORDS && eng === 0) {
        s.skipped++;
        continue;
      }
      const { error } = await db.from("posts").insert({
        format: "single",
        draft_text: text,
        status: "published",
        published_at: parseTweetDate(t.createdAt),
        external_post_id: t.id,
        posted_url: t.url ?? null,
        metrics_updated_at: new Date().toISOString(),
        ...m,
      });
      if (error) {
        // تعارض الفريد = سبق إدراجها في دورة سابقة؛ ليس خطأ يستحق الإبلاغ
        if (!/duplicate key|unique/i.test(error.message)) {
          s.errors.push(`إدراج ${t.id}: ${error.message}`);
        }
        continue;
      }
      s.impressionsGained += m.impressions;
      s.inserted++;
    }

    const hasNext = payload.has_next_page === true;
    cursor = typeof payload.next_cursor === "string" ? payload.next_cursor : "";
    if (!hasNext || !cursor) break;
    await sleep(PAGE_PAUSE_MS);
  }

  return s;
}

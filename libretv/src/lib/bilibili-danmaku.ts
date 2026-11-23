import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { getCache, setCache } from '@/lib/fetch-utils';

/**
 * B站弹幕链路（仅服务端）：wbi 签名搜索 → 季详情取 cid → 弹幕 XML。
 *
 * 为什么不走第三方聚合接口：那几个（danmaku npm 包等）要么已失效，要么同样依赖
 * B站私有签名，白白多一层故障点。这里直连官方公开接口，签名自己算。
 *
 * 注意：wbi 的 mixinKey 由 nav 接口的 img_url/sub_url 决定，会轮换；
 * 所以缓存 30 分钟就够，过期重取，不硬编码密钥。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** wbi 混淆表（B站前端固定常量） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const SEARCH_TTL = 20 * 60 * 1000;
const SEASON_TTL = 60 * 60 * 1000;
const DANMAKU_TTL = 30 * 60 * 1000;
const REQUEST_TIMEOUT = 9000;
/** 单集弹幕上限：B站满额约 1 万条，超过 1200KB 直接截断，避免把内存打爆 */
const MAX_DANMAKU_BYTES = 1_200_000;

export interface DanmakuCandidate {
  seasonId: number;
  title: string;
  /** 电影 / 电视剧 / 番剧 / 纪录片 */
  typeName: string;
  year?: string;
  cover?: string;
  /** 可播集数（0 表示接口没给，按 1 处理） */
  episodes: number;
  /** 与片名的匹配分（0~1），仅用于排序，前端可忽略 */
  score?: number;
}

export interface DanmakuItem {
  /** 秒 */
  time: number;
  text: string;
  /** #rrggbb */
  color: string;
  /** 0 滚动 1 顶部 2 底部（artplayer-plugin-danmuku 的取值） */
  type: number;
}

interface BiliSearchRow {
  season_id?: number;
  media_id?: number;
  title?: string;
  season_type_name?: string;
  cover?: string;
  pubtime?: number;
  season_year?: string;
  ep_size?: number;
  is_avid?: boolean;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    // 未登录状态下 nav 会给 -101，但 wbi_img 仍然下发；带个随机 buvid3 能少碰风控
    cookie: `buvid3=${Math.random().toString(36).slice(2).toUpperCase()}infoc`,
    ...extra,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: headers({ 'accept-encoding': 'gzip, deflate' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`B站接口 ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- wbi 签名

let mixinCache: { key: string; at: number } | null = null;

async function getMixinKey(): Promise<string> {
  if (mixinCache && Date.now() - mixinCache.at < 30 * 60 * 1000) return mixinCache.key;
  const json = await getJson<{ data?: { wbi_img?: { img_url: string; sub_url: string } } }>(
    'https://api.bilibili.com/x/web-interface/nav'
  );
  const img = json.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0];
  const sub = json.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0];
  if (!img || !sub) throw new Error('拿不到 wbi 密钥');
  const raw = img + sub;
  const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
  mixinCache = { key, at: Date.now() };
  return key;
}

/** 按 B站规则排序参数、拼 wts、算 w_rid */
async function signedQuery(params: Record<string, string | number>): Promise<string> {
  const mixin = await getMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const entries = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`);
  const base = entries.join('&');
  const wRid = createHash('md5').update(`${base}&wts=${wts}${mixin}`).digest('hex');
  return `${base}&wts=${wts}&w_rid=${wRid}`;
}

// ---------------------------------------------------------------- 搜索候选

function cleanTitle(raw?: string): string {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

function toCandidate(row: BiliSearchRow): DanmakuCandidate | null {
  const seasonId = row.season_id ?? row.media_id;
  const title = cleanTitle(row.title);
  if (!seasonId || !title) return null;
  const year = row.season_year || (row.pubtime ? String(new Date(row.pubtime * 1000).getFullYear()) : undefined);
  return {
    seasonId: Number(seasonId),
    title,
    typeName: row.season_type_name || '影视',
    year,
    cover: row.cover ? (row.cover.startsWith('//') ? `https:${row.cover}` : row.cover) : undefined,
    episodes: Number(row.ep_size) || 1,
  };
}

async function searchType(type: 'media_ft' | 'media_bangumi', keyword: string): Promise<DanmakuCandidate[]> {
  const query = await signedQuery({ search_type: type, keyword, page: 1 });
  const json = await getJson<{ code: number; data?: { result?: BiliSearchRow[] } }>(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`
  );
  if (json.code !== 0) return [];
  return (json.data?.result || []).map(toCandidate).filter((c): c is DanmakuCandidate => !!c);
}

/** 搬运/衍生类标题：不是正片，即便字面很像也不能排在正片前面 */
const DERIVATIVE_WORDS = [
  '解说',
  '混剪',
  '剪辑',
  '一口气',
  '规则怪谈',
  '合集',
  '预告',
  '花絮',
  '彩蛋',
  '解析',
  '盘点',
  '速看',
  '吐槽',
  '二创',
];

/** 去标点、去空白、去「第二季」这类尾巴，只留下能比的主体 */
function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s:：·・\-—_()（）【】\[\]、，,。.!！?？"'“”‘’]/g, '')
    .replace(/第[一二三四五六七八九十\d]+季/g, '')
    .replace(/(国语|粤语|日语|中配|台配)版?/g, '')
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** Dice 系数：对中文短标题比编辑距离更贴合直觉 */
function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((g) => {
    if (B.has(g)) inter += 1;
  });
  return (2 * inter) / (A.size + B.size);
}

/**
 * 给候选打分。真实踩到的两类错配：
 * - 「甄嬛传」匹到「甄嬛传规则怪谈」（衍生作品，标题包含查询）
 * - 「生化危机：爆发夜」匹到「生化危机：终章」（同系列不同部）
 * 单看字面相似度这两个都会排前面，所以还要靠衍生词惩罚和年份纠偏。
 */
function scoreCandidate(query: string, cand: DanmakuCandidate, year?: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(cand.title);
  if (!q || !t) return 0;

  let score = diceSimilarity(q, t);
  if (q === t) score = Math.max(score, 0.98);
  else if (t.includes(q) || q.includes(t)) score = Math.max(score, 0.8);

  if (year && cand.year) {
    const diff = Math.abs(Number(year) - Number(cand.year));
    if (Number.isFinite(diff)) {
      // 年份对上是很强的信号（同名老片/翻拍靠它区分），差两年以上基本不是同一部
      score += diff === 0 ? 0.12 : diff >= 2 ? -0.25 : -0.05;
    }
  }

  if (DERIVATIVE_WORDS.some((w) => cand.title.includes(w))) score -= 0.45;

  // 副标题堆得很长（「XXX之YYY传」）对不上就轻微降权
  if (t.length > q.length * 1.8) score -= 0.08;

  return Math.max(0, Math.min(1, score));
}

/**
 * 搜索可用于弹幕的影视/番剧。
 * 影视（media_ft）和番剧（media_bangumi）各搜一次后合并，按 season_id 去重。
 * 顺序保持「番剧在前、影视在后」：动画类片源命中番剧的可能性更高。
 */
export async function searchCandidates(keyword: string, year?: string): Promise<DanmakuCandidate[]> {
  const wd = keyword.trim().slice(0, 60);
  if (!wd) return [];
  const cacheKey = `danmaku:search:${wd}:${year || ''}`;
  const hit = getCache<DanmakuCandidate[]>(cacheKey);
  if (hit) return hit;

  /*
   * 采集站的剧名常带空格（「斗罗 大陆」「生化危机 终章」），而 B站 是按词匹配的，
   * 原样搜经常一条都出不来。这里原词和去空格各搜一轮再合并，代价是多一次请求。
   */
  const variants = [wd];
  const compact = wd.replace(/\s+/g, '');
  if (compact && compact !== wd) variants.push(compact);

  const batches = await Promise.all(
    variants.flatMap((v) => [
      searchType('media_bangumi', v).catch(() => [] as DanmakuCandidate[]),
      searchType('media_ft', v).catch(() => [] as DanmakuCandidate[]),
    ])
  );
  const all = batches.flat();

  const seen = new Set<number>();
  const merged: DanmakuCandidate[] = [];
  for (const item of all) {
    // 同名作品在番剧/影视两侧可能各有一条，season_id 相同才是同一部
    if (seen.has(item.seasonId)) continue;
    seen.add(item.seasonId);
    merged.push(item);
  }
  // 打分排序：字面最像的排前面，衍生作品和年份对不上的沉下去
  const scored = merged
    .map((c) => ({ ...c, score: scoreCandidate(wd, c, year) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // 太低分的直接不给：宁可告诉用户「没找到」，也别让他去选一部完全不相干的
  // 先打分再截断：否则先回来的那批（原词搜索）会挤掉后一批里真正对的
  const result = scored.filter((c) => (c.score ?? 0) >= 0.3).slice(0, 8);
  setCache(cacheKey, result, SEARCH_TTL);
  return result;
}

// ---------------------------------------------------------------- 分集 cid

interface SeasonEpisode {
  cid: number;
  title: string;
}

export interface SeasonInfo {
  title: string;
  episodes: SeasonEpisode[];
}

export async function getSeason(seasonId: number): Promise<SeasonInfo> {
  const cacheKey = `danmaku:season:${seasonId}`;
  const hit = getCache<SeasonInfo>(cacheKey);
  if (hit) return hit;

  const json = await getJson<{
    code: number;
    result?: { title?: string; episodes?: Array<{ cid?: number; title?: string }> };
  }>(`https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`);

  if (json.code !== 0 || !json.result) throw new Error('季信息获取失败');
  const episodes = (json.result.episodes || [])
    .map((e) => ({ cid: Number(e.cid) || 0, title: e.title || '' }))
    .filter((e) => e.cid > 0);

  const info: SeasonInfo = { title: json.result.title || '', episodes };
  setCache(cacheKey, info, SEASON_TTL);
  return info;
}

// ---------------------------------------------------------------- 弹幕解析

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 十进制颜色 → #rrggbb（B站弹幕里 color 是整数） */
function toHexColor(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '#ffffff';
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * 解析弹幕 XML。
 * p 属性顺序：time, mode, fontSize, color, timestamp, pool, uidHash, dmid, ...
 * mode: 1~3 滚动 / 4 底部 / 5 顶部
 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const re = /<d p="([^"]*)">([^<]*)<\/d>/g;
  const out: DanmakuItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const p = m[1].split(',');
    const time = Number(p[0]);
    const text = decodeEntities(m[2]).trim();
    if (!Number.isFinite(time) || time < 0 || !text) continue;
    const mode = Number(p[1]) || 1;
    const type = mode === 5 ? 1 : mode === 4 ? 2 : 0;
    out.push({ time: Math.round(time * 10) / 10, text, color: toHexColor(p[3]), type });
  }
  // 按时间排序：插件的轨道分配依赖顺序
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 刷屏抑制。
 *
 * B站热门片单集满额 9600 条，片头全是「梦开始的地方」「前方高能」这类同一句反复刷，
 * 直接丢给播放器会叠成一团、完全看不清（实测 0 秒处十几条压在同一屏）。
 * 这里两步：同一秒内相同文本只留一条；再用 4 秒滑动窗口限流，一个窗口最多 8 条。
 * 代价是丢一部分弹幕，换来「看得清」——对观影来说是值的。
 */
function thin(list: DanmakuItem[]): DanmakuItem[] {
  const WINDOW = 4;
  const MAX_PER_WINDOW = 8;
  /** 同一秒的上限：片头 0 秒处动辄十几条，即使开着防重叠也会把轨道占满后叠在一起 */
  const MAX_PER_SECOND = 3;
  const seen = new Set<string>();
  const perSecond = new Map<number, number>();
  const out: DanmakuItem[] = [];
  let windowStart = -Infinity;
  let count = 0;
  for (const d of list) {
    const dupKey = `${Math.floor(d.time)}|${d.text}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);

    const sec = Math.floor(d.time);
    const secCount = perSecond.get(sec) ?? 0;
    if (secCount >= MAX_PER_SECOND) continue;

    if (d.time - windowStart > WINDOW) {
      windowStart = d.time;
      count = 0;
    }
    if (count >= MAX_PER_WINDOW) continue;

    perSecond.set(sec, secCount + 1);
    out.push(d);
    count += 1;
  }
  return out;
}

/**
 * 用 Node 内置 https 抓文本，而不是 fetch。
 *
 * App 里的 nodejs-mobile 是精简版 Node 18，undici（fetch 的底座）对 B站 CDN 的
 * HTTP/2 连接复用有缺陷：日志里刷 `net/spdy: Received HEADERS for invalid stream`，
 * 响应流直接被终止，前端只看到 `terminated`（实测 0.4 秒就断，不是超时）。
 * 桌面 Node 22 没有这个问题，所以这个坑只在手机上出现。
 * 这里走 HTTP/1.1，绕开 h2 复用；顺便不用 TextDecoder（无 ICU 构建下同样有风险）。
 */
function httpsGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 显式声明只接受 gzip/deflate：不发这个头时 B站 CDN 会回 Brotli，
    // 而 App 内 nodejs-mobile 的精简 Node 18 没有 brotli 解压（会拿到一堆二进制）。
    const req = httpsGet(url, { headers: headers({ 'accept-encoding': 'gzip, deflate' }) }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) {
        res.resume();
        reject(new Error(`弹幕接口 ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        // 超限后停止累积但不中断连接：保持响应完整读取，避免 destroy 引出多余错误
        if (size > MAX_DANMAKU_BYTES) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '');
        // 别看响应头，直接认魔数：B站 CDN 在 HTTP/1.1 下会压 gzip 却不回 content-encoding，
        // 只看头会漏解压，拿到一堆二进制（表现为「接口 200 但 0 条弹幕」）
        const gzipMagic = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
        try {
          if (gzipMagic || encoding.includes('gzip')) {
            buf = gunzipSync(buf);
          } else if (encoding.includes('deflate')) {
            /*
             * B站 回的 content-encoding: deflate 其实是「裸 deflate」——
             * 数据头是 84 fd 59 6f 而不是 zlib 的 78 xx，inflateSync 会报
             * incorrect header check。必须先按 raw 解，兜底再按 zlib 解。
             * （桌面 undici 内部能容错，所以只有自己调 https 时才踩到）
             */
            try {
              buf = inflateRawSync(buf);
            } catch {
              buf = inflateSync(buf);
            }
          }
        } catch {
          /* 解压失败就原样交给上层，由解析结果暴露问题 */
        }
        resolve(buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('弹幕请求超时')));
    req.on('error', reject);
  });
}

export async function getEpisodeDanmaku(
  cid: number
): Promise<{ list: DanmakuItem[]; rawLength: number; rawHead: string }> {
  const cacheKey = `danmaku:list:${cid}`;
  const hit = getCache<{ list: DanmakuItem[]; rawLength: number; rawHead: string }>(cacheKey);
  if (hit) return hit;

  const xml = await httpsGetText(`https://comment.bilibili.com/${cid}.xml`, 20000);
  const list = thin(parseDanmakuXml(xml));
  // rawLength / rawHead 用于排查：判断拿到的是占位 XML、乱码还是真数据
  const result = { list, rawLength: xml.length, rawHead: xml.slice(0, 40) };
  // 空结果也缓存，避免对「未收录弹幕」的集数反复请求
  setCache(cacheKey, result, list.length ? DANMAKU_TTL : 5 * 60 * 1000);
  return result;
}

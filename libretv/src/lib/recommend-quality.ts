import type { SearchResultItem } from './types';

/**
 * 推荐页的画质：豆瓣条目只有标题/海报/评分，没有任何播放源信息，
 * 分辨率又只存在于 m3u8 的 #EXT-X-STREAM-INF 里，所以只能
 * 「按标题搜一次 → 拿到该片的 vodId → 探测」两步走。
 *
 * 这里只负责三件事：条目与搜索结果的匹配、结果缓存、筛选阈值判定，
 * 不发请求（探测流程在 use-recommend-quality.ts）。
 */

/** 推荐条目的画质记录：键是豆瓣条目 id */
export interface RecommendQualityEntry {
  height?: number;
  /** 有值代表这次没探到（源站拒绝/超时），与「探到了但源站没写分辨率」不同 */
  error?: string;
  timestamp: number;
  /** 命中该片最高画质的源与条目，便于将来追加「去这个源看」 */
  sourceKey?: string;
  vodId?: string;
}

/** 成功结果有效期：推荐榜变化慢，源站换片源也慢，7 天内不必重探 */
export const REC_QUALITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 失败结果短有效期：超时/限流多是瞬时的，太久会把偶发失败当成永久结论 */
export const REC_QUALITY_FAIL_TTL_MS = 10 * 60 * 1000;

export function isRecommendQualityFresh(entry: RecommendQualityEntry, now = Date.now()): boolean {
  const ttl = entry.error ? REC_QUALITY_FAIL_TTL_MS : REC_QUALITY_TTL_MS;
  return now - entry.timestamp < ttl;
}

export type QualityFilter = 'all' | '4k' | '1080' | '720';

/**
 * 筛选档位的下界（像素高度）。4K 取 2000 而不是 2160：
 * 部分源写 2048×1080 之类的非常规值，卡死在 2160 会漏掉真正的 4K 片源。
 */
export const QUALITY_FILTERS: { value: QualityFilter; label: string; minHeight: number }[] = [
  { value: 'all', label: '全部', minHeight: 0 },
  { value: '4k', label: '4K', minHeight: 2000 },
  { value: '1080', label: '1080P+', minHeight: 1000 },
  { value: '720', label: '720P+', minHeight: 700 },
];

/**
 * 是否通过筛选。未探明（无 height）的条目只在「全部」下可见——
 * 具体档位下隐藏它们，避免用户看到一堆待定卡片却不知道筛没筛。
 */
export function matchesQualityFilter(height: number | undefined, filter: QualityFilter): boolean {
  if (filter === 'all') return true;
  const rule = QUALITY_FILTERS.find((f) => f.value === filter);
  if (!rule) return true;
  return typeof height === 'number' && height >= rule.minHeight;
}

/** 标题归一化：去掉空白、标点、括号内容，用于跨源比对片名 */
export function normalizeRecTitle(raw: string): string {
  return raw
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/[\s·・:：\-—–_,，.。!！?？'"“”‘’/\\|]/g, '')
    .toLowerCase();
}

/**
 * 从搜索结果里挑出与推荐条目对应的那一条。
 *
 * 顺序：完全同名 → 前缀相同（「斗罗大陆」对「斗罗大陆2」这类续作/分季也认）
 * → 包含关系。同分时保留搜索结果里靠前的那条（服务端已按精确度排过序）。
 */
export function pickRecommendMatch(title: string, list: SearchResultItem[]): SearchResultItem | undefined {
  const target = normalizeRecTitle(title);
  if (!target) return undefined;

  let prefix: SearchResultItem | undefined;
  let contains: SearchResultItem | undefined;
  for (const item of list) {
    const name = normalizeRecTitle(item.name || '');
    if (!name) continue;
    if (name === target) return item;
    if (!prefix && (name.startsWith(target) || target.startsWith(name))) prefix = item;
    if (!contains && (name.includes(target) || target.includes(name))) contains = item;
  }
  return prefix ?? contains;
}

/** 缓存键与条数上限：localStorage 里只留最近 800 条，超出按时间淘汰 */
const STORAGE_KEY = 'libretv.recommend-quality.v1';
const MAX_CACHED = 800;

type CacheMap = Record<string, RecommendQualityEntry>;

let memoryCache: CacheMap | null = null;

/** 读取缓存（合并内存与 localStorage）；SSR 下直接返回空表 */
export function loadRecommendQualityCache(): CacheMap {
  if (memoryCache) return memoryCache;
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as CacheMap) : {};
    const now = Date.now();
    const fresh: CacheMap = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.timestamp === 'number' && isRecommendQualityFresh(entry, now)) fresh[id] = entry;
    }
    memoryCache = fresh;
    return fresh;
  } catch {
    memoryCache = {};
    return memoryCache;
  }
}

/** 写入缓存并落盘；写失败（隐私模式/配额满）只影响下次要重探，不影响本次展示 */
export function saveRecommendQualityCache(map: CacheMap): void {
  memoryCache = map;
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(map);
    const trimmed: CacheMap =
      entries.length <= MAX_CACHED
        ? map
        : Object.fromEntries(entries.sort((a, b) => b[1].timestamp - a[1].timestamp).slice(0, MAX_CACHED));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* 忽略：缓存只是加速，写不进去不该打断播放/浏览 */
  }
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { useSelectedSources } from '@/lib/use-selected-sources';
import { useAppStore } from '@/lib/store';
import {
  isRecommendQualityFresh,
  loadRecommendQualityCache,
  pickRecommendMatch,
  saveRecommendQualityCache,
  type RecommendQualityEntry,
} from '@/lib/recommend-quality';
import type { DoubanItem, QualityProbeItem, SourceConfig } from '@/lib/types';

/**
 * 推荐页画质探测：把「豆瓣条目」变成「某源里的一个可探测条目」。
 *
 * 一次探测 = 按标题搜一次（限 1 页）→ 挑同名条目 → 探 m3u8 分辨率。
 * 成本比普通搜索高（每张卡两次上游），因此：
 * - 只有卡片真正滑到眼前才入队（调用方用 useInView 触发）；
 * - 并发 2，队列模块级共享，滚得再快也只会有 2 个任务在飞；
 * - 结果按豆瓣 id 缓存 7 天（失败 10 分钟），二次进入不再探测；
 * - 只用前 2 个启用源：命中率已经够，没必要把 11 个源各打一遍。
 */
const CONCURRENCY = 2;
/**
 * 每轮探测用几个源。不能只取前 2 个：源列表前几位常是垂类源
 * （短剧/AI漫剧、韩剧、日剧），豆瓣榜单里的电影在里面根本搜不到，
 * 表现为整页「未找到播放资源」。所以按 3 个一轮、失败再扩一批。
 */
const SOURCES_PER_ROUND = 3;
/** 扩源上限：再多就是把 11 个源全打一遍，收益递减且触发限流 */
const MAX_EXTRA_ROUNDS = 2;

/** 这些失败说明「这批源里没有这部片」，值得换源再试；超时/限流则不该重试 */
const isSourceMiss = (error?: string): boolean =>
  !!error && /未收录|未找到播放资源/.test(error);

interface ProbeTask {
  id: string;
  title: string;
}

export function useRecommendQuality() {
  const sources = useSelectedSources();
  const filterAdult = useAppStore((s) => s.yellowFilter);

  const [entries, setEntries] = useState<Record<string, RecommendQualityEntry>>({});
  /** 排队 + 在飞的任务数：用于「正在探测 3/12」提示 */
  const [pending, setPending] = useState(0);

  // 队列里的闭包要读最新配置，但又不该因配置变化重建 worker，统一放在 ref 里
  const sourcesRef = useRef<SourceConfig[]>(sources);
  const filterRef = useRef(filterAdult);
  sourcesRef.current = sources;
  filterRef.current = filterAdult;

  const queueRef = useRef<ProbeTask[]>([]);
  const activeRef = useRef(0);
  const queuedRef = useRef<Set<string>>(new Set());
  const pumpRef = useRef<() => void>(() => {});
  const cacheRef = useRef<Record<string, RecommendQualityEntry>>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // 首次挂载：把持久化缓存（已过滤过期项）直接铺上，避免二次进入又闪一遍省略号
  useEffect(() => {
    mountedRef.current = true;
    const cache = loadRecommendQualityCache();
    cacheRef.current = cache;
    setEntries(cache);
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveRecommendQualityCache(cacheRef.current);
      }
    };
  }, []);

  /** 落盘节流：一屏十几条陆续完成，每条都 JSON.stringify 整个缓存会卡主线程 */
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) return;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveRecommendQualityCache(cacheRef.current);
    }, 1500);
  }, []);

  const commit = useCallback(
    (id: string, entry: RecommendQualityEntry) => {
      if (!mountedRef.current) return;
      cacheRef.current = { ...cacheRef.current, [id]: entry };
      setEntries((prev) => ({ ...prev, [id]: entry }));
      scheduleSave();
    },
    [scheduleSave]
  );

  /** 用一组源探一次：搜索 → 挑同名条目 → 探 m3u8。结果可能带「这批源没有」的 error */
  const probeWithSources = useCallback(async (title: string, list: SourceConfig[]): Promise<RecommendQualityEntry> => {
    try {
      const res = await api.search(title, list, filterRef.current, { maxPages: 1 });
      const match = pickRecommendMatch(title, res.list);
      if (!match) return { error: '源站未收录', timestamp: Date.now() };

      // 优先用本地的源配置（带 detail 模板）；搜索结果只作兜底
      const source: SourceConfig =
        list.find((s) => s.key === match.sourceKey) ?? {
          key: match.sourceKey,
          name: match.sourceName,
          url: match.sourceUrl ?? list[0].url,
        };
      let height: number | undefined;
      let error: string | undefined;
      await api.qualityProbeStream([{ source, id: match.vodId } as QualityProbeItem], (result) => {
        height = result.height;
        error = result.error;
      });
      return { height, error, timestamp: Date.now(), sourceKey: match.sourceKey, vodId: match.vodId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : '探测失败', timestamp: Date.now() };
    }
  }, []);

  const runTask = useCallback(
    async (task: ProbeTask) => {
      const all = sourcesRef.current;
      if (all.length === 0) return; // 没有可用源时不写结论，等有源了还能再探

      let entry: RecommendQualityEntry | undefined;
      // 分批换源：第一批没有就换下一批。垂类源排在前面的部署里，这是唯一的补救
      for (let round = 0; round <= MAX_EXTRA_ROUNDS; round += 1) {
        const start = round * SOURCES_PER_ROUND;
        const list = all.slice(start, start + SOURCES_PER_ROUND);
        if (list.length === 0) break;
        entry = await probeWithSources(task.title, list);
        // 探到档位，或探到了但源站没写分辨率（无 error）：都算有结论，停止换源
        if (entry.height !== undefined || !isSourceMiss(entry.error)) break;
      }
      if (entry) commit(task.id, entry);
    },
    [commit, probeWithSources]
  );

  /**
   * 队列泵：while 里同步取任务，空位有多少就起多少个。
   * 用 ref 持有自身，任务完成后再踢一次，避免闭包拿到旧的计数。
   */
  const pump = useCallback(() => {
    while (activeRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const task = queueRef.current.shift()!;
      activeRef.current += 1;
      void runTask(task).finally(() => {
        activeRef.current -= 1;
        queuedRef.current.delete(task.id);
        pumpRef.current();
      });
    }
    setPending(queueRef.current.length + activeRef.current);
  }, [runTask]);
  pumpRef.current = pump;

  /** 把条目放进队列；已探过（或正在探）的直接跳过 */
  const enqueue = useCallback(
    (items: Array<Pick<DoubanItem, 'id' | 'title'>>) => {
      if (typeof window === 'undefined') return;
      let added = 0;
      for (const item of items) {
        if (!item?.id || !item.title) continue;
        const cached = cacheRef.current[item.id];
        if (cached && isRecommendQualityFresh(cached)) continue;
        if (queuedRef.current.has(item.id)) continue;
        queuedRef.current.add(item.id);
        queueRef.current.push({ id: item.id, title: item.title });
        added += 1;
      }
      if (added > 0) pumpRef.current();
    },
    []
  );

  /** 单条可见时调用 */
  const requestProbe = useCallback(
    (item: Pick<DoubanItem, 'id' | 'title'>) => enqueue([item]),
    [enqueue]
  );

  /**
   * 切换筛选档位时：把当前已加载的条目整体推进队列。
   * 隐藏的卡片不会再触发可见性探测，不主动推就永远筛不出结果。
   * 只推「还没结论」的前 limit 条：一屏几十条一次打完既慢又费流量，
   * 调用方会在新结果到达后再调一次，形成分批推进。
   */
  const requestAll = useCallback(
    (items: Array<Pick<DoubanItem, 'id' | 'title'>>, limit = 24) => {
      const pendingItems = items.filter((item) => {
        const cached = item?.id ? cacheRef.current[item.id] : undefined;
        return !cached || !isRecommendQualityFresh(cached);
      });
      enqueue(pendingItems.slice(0, limit));
    },
    [enqueue]
  );

  const summary = useMemo(() => {
    const values = Object.values(entries);
    return {
      known: values.filter((e) => typeof e.height === 'number').length,
      failed: values.filter((e) => !!e.error).length,
    };
  }, [entries]);

  return { entries, pending, summary, requestProbe, requestAll };
}

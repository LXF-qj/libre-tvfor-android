'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import {
  MOVIE_TAGS,
  TV_TAGS,
  normalizeDoubanCategories,
  type DoubanCategory,
} from '@/lib/douban-categories';
import { mergeRecommendationPages, nextRecommendationOffset, RECOMMEND_PAGE_SIZE } from '@/lib/recommendation-pages';
import { QUALITY_FILTERS, matchesQualityFilter, type QualityFilter } from '@/lib/recommend-quality';
import { useRecommendQuality } from './use-recommend-quality';
import { DoubanCard } from './video-card';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 首页推荐区：数据源由设置决定（豆瓣热门 / Bangumi 新番放送 / 影视热榜），二选一展示 */
export function RecommendSection({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);

  if (!doubanEnabled) return null;
  if (recommendSource === 'bangumi') return <BangumiView onPick={onPick} />;
  if (recommendSource === 'hot-list') return <HotListView onPick={onPick} />;
  return <DoubanView onPick={onPick} />;
}

/**
 * 豆瓣推荐：影视切换 + 标签筛选；设置里配置了自定义栏目时改为按栏目切换。
 * 首批 50 条，滚动接近列表末尾时获取下一批真实数据；分类之间隔离缓存。
 * 空页/完全重复页停止；下一页失败时保留现有卡片，用户可以重试。
 */
function DoubanView({ onPick }: { onPick: (title: string) => void }) {
  const rawCategories = useAppStore((s) => s.doubanCategories);
  // 编辑中的空名称/空标签条目不会进入首页；填完即自动生效
  const categories = useMemo(() => normalizeDoubanCategories(rawCategories), [rawCategories]);
  const custom = categories.length > 0;
  const first = categories[0];
  const [activeId, setActiveId] = useState<string | null>(first?.id ?? null);
  const [type, setType] = useState<'movie' | 'tv'>(first?.type ?? 'movie');
  const [tag, setTag] = useState(first?.tag ?? '热门');
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 设置里增删/重排栏目后，保证当前选中项仍然有效（失效则回到第一个）
  useEffect(() => {
    if (!custom) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!categories.some((c) => c.id === activeId)) {
      const next = categories[0];
      setActiveId(next.id);
      setType(next.type);
      setTag(next.tag);
    }
  }, [custom, categories, activeId]);

  const query = useInfiniteQuery({
    queryKey: ['douban-scroll', type, tag, RECOMMEND_PAGE_SIZE],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.douban(type, tag, pageParam, RECOMMEND_PAGE_SIZE, signal),
    getNextPageParam: (last, pages, offset) => nextRecommendationOffset(last, pages, offset),
    retry: false,
  });

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;
  const items = useMemo(() => mergeRecommendationPages(query.data?.pages ?? []), [query.data]);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;

  // —— 画质筛选 ——
  // 豆瓣条目没有播放源，分辨率只能「按标题搜一次 + 探 m3u8」得到，
  // 所以筛选本质是：边筛选边探测，探明的才可能出现在具体档位里。
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>('all');
  const { entries, pending, requestProbe, requestAll } = useRecommendQuality();

  // 切到具体档位时，被隐藏的卡片不会再触发可见性探测，必须主动把这批推进队列，
  // 否则用户看到的是「筛了 4K 一片空白，而且永远不会有结果」。
  // entries 进依赖是有意的：每探明几条就再补一批，形成自动续探。
  useEffect(() => {
    if (qualityFilter !== 'all') requestAll(items);
  }, [qualityFilter, items, entries, requestAll]);

  const shownItems = useMemo(
    () =>
      qualityFilter === 'all'
        ? items
        : items.filter((item) => matchesQualityFilter(entries[item.id]?.height, qualityFilter)),
    [items, qualityFilter, entries]
  );

  useEffect(() => {
    const target = loadMoreRef.current;
    // 筛选态不自动续载：筛完只剩几张卡，页面短到加载器常驻视口，
    // 会一口气把几百部推荐全拉进来逐部探测——既慢又费流量。改为点按钮手动加载。
    if (qualityFilter !== 'all') return;
    if (!target || !hasNextPage || isFetching || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage({ cancelRefetch: false });
    }, { rootMargin: '600px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, type, tag, qualityFilter]);

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    setTag('热门');
  };

  const selectCategory = (c: DoubanCategory) => {
    if (c.id === activeId) return;
    setActiveId(c.id);
    setType(c.type);
    setTag(c.tag);
  };

  return (
    <section aria-label="影视推荐">
      {!custom && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="flex bg-chip rounded-lg p-0.5">
              <TypeButton active={type === 'movie'} onClick={() => switchType('movie')}>
                电影
              </TypeButton>
              <TypeButton active={type === 'tv'} onClick={() => switchType('tv')}>
                剧集
              </TypeButton>
            </div>
          </div>
          <QualityFilterBar value={qualityFilter} onChange={setQualityFilter} pending={pending} />
        </div>
      )}

      {custom ? (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {categories.map((c) => (
            <button
              key={c.id}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                c.id === activeId ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => selectCategory(c)}
            >
              {c.name}
            </button>
          ))}
          <div className="ml-auto">
            <QualityFilterBar value={qualityFilter} onChange={setQualityFilter} pending={pending} />
          </div>
        </div>
      ) : (
        // 手机上横滑单行（原生 App 的标签条形态）：两行换行会白吃掉半屏高度，
        // 而分类总共十几个，横滑比折行更省地方；sm 以上横向空间够，恢复换行全展示
        // 负边距要跟 main 的内边距同步（lg 起是 24px），否则平板横屏下标签条左侧会缩进 8px
        <div className="-mx-4 px-4 lg:-mx-6 lg:px-6 mb-4 flex gap-1.5 overflow-x-auto scrollbar-none sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
          {tags.map((t) => (
            <button
              key={t}
              className={cn(
                'shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors',
                t === tag ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => setTag(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {query.isError && items.length === 0 ? (
        <div className="text-center text-sm text-faint py-8">
          <p>推荐内容加载失败</p>
          <button className="btn-ghost btn-sm mt-2" onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
      ) : shownItems.length === 0 ? (
        <div className="text-center text-sm text-faint py-8" role="status">
          <p>
            这批推荐里还没有确认到
            {QUALITY_FILTERS.find((f) => f.value === qualityFilter)?.label ?? ''}
            的片源
          </p>
          <p className="text-xs mt-1">
            {pending > 0 ? `已探明 ${Object.keys(entries).length} 部，还有 ${pending} 部在探测…` : '可点「全部」查看所有推荐'}
          </p>
          <button className="btn-ghost btn-sm mt-2" onClick={() => setQualityFilter('all')}>
            显示全部
          </button>
        </div>
      ) : (
        <div data-recommendation-grid className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 lg:gap-3">
          {shownItems.map((item) => (
            <DoubanCard
              key={item.id}
              item={item}
              onClick={() => onPick(item.title)}
              quality={entries[item.id]}
              // 只在筛选态显示省略号：全量探测时几乎每张卡都待探，满屏闪烁反而更乱
              probing={qualityFilter !== 'all' && !entries[item.id] && pending > 0}
              onVisible={() => requestProbe(item)}
            />
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div ref={loadMoreRef} data-recommendation-more className="text-center text-sm text-muted py-6">
          {query.isFetchingNextPage ? (
            <p role="status">正在加载更多推荐...</p>
          ) : query.isFetchNextPageError ? (
            <div role="status">
              <p>加载更多失败，已加载内容仍可浏览</p>
              <button className="btn-ghost btn-sm mt-2" onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>重试加载更多</button>
            </div>
          ) : query.hasNextPage ? (
            <button className="btn-ghost btn-sm" onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>加载更多</button>
          ) : (
            <p role="status">
              {qualityFilter === 'all'
                ? `已显示全部 ${items.length} 部推荐`
                : `已筛出 ${shownItems.length} 部（本批共 ${items.length} 部）`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Bangumi 每日放送：星期筛选，一次拉全量无分页 */
function BangumiView({ onPick }: { onPick: (title: string) => void }) {
  const [weekday, setWeekday] = useState<number | 'all'>('all');

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
  });

  let items: DoubanItem[] = [];
  if (query.data) {
    items = weekday === 'all'
      ? query.data.days.flatMap((d) => d.items)
      : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  return (
    <section aria-label="新番放送推荐">
      <div className="flex flex-wrap gap-1.5 mb-4">
        <ChipButton active={weekday === 'all'} onClick={() => setWeekday('all')}>
          全部
        </ChipButton>
        {WEEKDAYS.map((name, i) => (
          <ChipButton key={name} active={weekday === i + 1} onClick={() => setWeekday(i + 1)}>
            {name}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 lg:gap-3">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/** 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧，chips 切换 */
function HotListView({ onPick }: { onPick: (title: string) => void }) {
  const [listId, setListId] = useState(HOT_LISTS[0].id);

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
  });

  const items = query.data?.items ?? [];

  return (
    <section aria-label="影视榜单推荐">
      <div className="flex flex-wrap gap-1.5 mb-4">
        {HOT_LISTS.map((l) => (
          <ChipButton key={l.id} active={listId === l.id} onClick={() => setListId(l.id)}>
            {l.label}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败，可稍后重试或在设置中关闭</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 lg:gap-3">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-2.5 lg:gap-3">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        'px-2.5 py-1 rounded-full text-xs transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TypeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('px-3.5 py-1.5 rounded-md text-sm transition-colors', active ? 'bg-accent text-on-accent' : 'text-muted hover:text-content')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

/**
 * 画质筛选：与「电影/剧集」同排，不额外占一行。
 *
 * 推荐页的画质是「探测出来」的，不是接口给的，所以这里必须交代进度：
 * 选了 4K 却暂时一片空白时，右上角的「探测中 n」是用户唯一能判断
 * 「是在干活」还是「真没有」的依据。
 */
function QualityFilterBar({
  value,
  onChange,
  pending,
}: {
  value: QualityFilter;
  onChange: (next: QualityFilter) => void;
  pending: number;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* 窄屏（360px）上「探测中 24」会把整行挤爆：收成一个脉冲点 + 数字，语义靠 title 补 */}
      {value !== 'all' && pending > 0 && (
        <span
          className="flex items-center gap-1 text-[11px] text-faint tabular-nums"
          role="status"
          title={`正在探测 ${pending} 部的画质`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
          {pending}
        </span>
      )}
      <div className="flex bg-chip rounded-lg p-0.5" role="group" aria-label="按画质筛选">
        {QUALITY_FILTERS.map((f) => (
          <button
            key={f.value}
            className={cn(
              'quality-chip px-1.5 py-1 rounded-md text-[11px] transition-colors',
              value === f.value ? 'bg-accent text-on-accent' : 'text-muted hover:text-content'
            )}
            onClick={() => onChange(f.value)}
            aria-pressed={value === f.value}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { danmakuKey, useAppStore } from '@/lib/store';
import type { DanmakuCandidate } from '@/lib/types';

/**
 * 弹幕绑定面板（详情弹窗内）。
 *
 * 只给候选、不自动选中：实测 B站搜索结果里同系列的另一部、衍生作品经常排在最前
 * （「生化危机：爆发夜」会匹到「终章」，「甄嬛传」会匹到「甄嬛传规则怪谈」），
 * 错配的弹幕比没有弹幕更糟——用户看到的每一句都在讲别的剧情。
 */
export function DanmakuPanel({ title, year, onClose }: { title: string; year?: string; onClose: () => void }) {
  const bindings = useAppStore((s) => s.danmakuBindings);
  const bind = useAppStore((s) => s.bindDanmaku);
  const unbind = useAppStore((s) => s.unbindDanmaku);
  const setOffset = useAppStore((s) => s.setDanmakuOffset);

  const bound = bindings[danmakuKey(title)];
  const [candidates, setCandidates] = useState<DanmakuCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (bound) return;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .danmakuSearch(title, year)
      .then((res) => {
        if (alive) setCandidates(res.candidates || []);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : '搜索失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [title, year, bound]);

  return (
    <div className="rounded-lg border border-line bg-chip/30 p-3 mb-4">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <span className="text-sm font-medium text-content">弹幕</span>
        <button className="text-xs text-muted hover:text-content" onClick={onClose}>
          收起
        </button>
      </div>

      {bound ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="tag bg-accent/15 text-accent shrink-0">已绑定</span>
            <span className="text-xs text-content truncate" title={bound.title}>
              {bound.title}
            </span>
            <span className="text-[11px] text-faint shrink-0">
              {bound.typeName}
              {bound.offset ? ` · 偏移 ${bound.offset > 0 ? '+' : ''}${bound.offset}s` : ''}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-faint">对齐</span>
            {[-5, -1, 1, 5].map((step) => (
              <button
                key={step}
                className="btn-ghost btn-sm"
                onClick={() => setOffset(title, bound.offset + step)}
                title={`弹幕整体${step > 0 ? '延后' : '提前'} ${Math.abs(step)} 秒`}
              >
                {step > 0 ? `+${step}s` : `${step}s`}
              </button>
            ))}
            <button className="btn-ghost btn-sm" onClick={() => setOffset(title, 0)} title="恢复为不偏移">
              归零
            </button>
            <button className="btn-ghost btn-sm ml-auto" onClick={() => unbind(title)}>
              解绑
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            弹幕时间轴跟着 B站片源走。若片头长度与本片不同，用「对齐」把弹幕整体前后平移即可。
          </p>
        </div>
      ) : loading ? (
        <p className="text-xs text-faint py-1">正在搜索 B站…</p>
      ) : error ? (
        <p className="text-xs text-danger py-1">{error}</p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-faint py-1 leading-relaxed">
          B站没有检索到这部剧，暂时没有可用的弹幕源（新片、冷门片通常如此）。
        </p>
      ) : (
        <div className="space-y-1 max-h-52 overflow-y-auto scrollbar-thin -mx-1">
          {candidates.map((c) => (
            <button
              key={c.seasonId}
              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover transition-colors"
              onClick={() => bind(title, { seasonId: c.seasonId, title: c.title, typeName: c.typeName })}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-xs text-content truncate" title={c.title}>
                  {c.title}
                </span>
                <span className="block text-[11px] text-faint">
                  {c.typeName}
                  {c.year ? ` · ${c.year}` : ''}
                  {c.episodes > 1 ? ` · ${c.episodes} 集` : ''}
                </span>
              </span>
              <span className="text-[11px] text-accent shrink-0">选它</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

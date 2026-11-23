'use client';

import { useMemo } from 'react';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from './store';
import { validateSourceUrl } from './utils';
import type { SourceConfig } from './types';

/**
 * 当前真正参与搜索的源：已勾选 + 地址有效 + 去重 + 未处于自动停用期 + 所属订阅未整体停用。
 *
 * 首页搜索与推荐页的画质探测必须共用同一份口径：推荐页探测本质是「按标题搜一次」，
 * 若用了刚被判定不健康而停用的源，等于把已经放弃的源再打一遍，既慢又污染健康度。
 */
export function useSelectedSources(): SourceConfig[] {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  return useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is SourceConfig => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);
}

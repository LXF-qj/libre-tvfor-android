'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DISMISSED_VERSION_KEY, getManifestUrl, getNativeBridge, isNewerVersion } from '@/lib/update-config';

/**
 * 启动时静默查一次新版本，有了在底部浮一条提示。
 *
 * 只做「告诉你」，不自动下载——自动下载会吃流量、也会在用户正看片时抢带宽。
 * 用户点「去更新」进关于页，那里能看说明、看大小、决定装不装。
 */
export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const router = useRouter();

  useEffect(() => {
    const bridge = getNativeBridge();
    // 浏览器里没有安装的概念，不提示
    if (!bridge) return;

    let alive = true;
    // 延迟 5 秒：别和首页首屏的请求抢带宽
    const timer = setTimeout(async () => {
      try {
        const code = bridge.versionCode?.() ?? 0;
        const res = await fetch(
          `/api/update?url=${encodeURIComponent(getManifestUrl())}&apkVersionCode=${code}`
        );
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { current?: string; latest?: string; notes?: string };
        if (!data.latest || !data.current || !isNewerVersion(data.latest, data.current)) return;
        // 用户明确忽略过这个版本就不再打扰
        if (localStorage.getItem(DISMISSED_VERSION_KEY) === data.latest) return;
        setLatest(data.latest);
        setNotes(data.notes || '');
      } catch {
        /* 检查失败就静默，不打扰用户 */
      }
    }, 5000);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (!latest) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-[80] mx-auto flex max-w-md items-center gap-2 rounded-lg border border-line bg-surface-raised/95 px-3 py-2.5 shadow-lg backdrop-blur">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-content">新版本 v{latest}</p>
        {notes && <p className="truncate text-[11px] text-faint">{notes}</p>}
      </div>
      <button
        className="btn-primary btn-sm shrink-0"
        onClick={() => {
          setLatest(null);
          router.push('/about');
        }}
      >
        查看
      </button>
      <button
        className="shrink-0 rounded p-1 text-faint transition-colors hover:text-content"
        onClick={() => {
          localStorage.setItem(DISMISSED_VERSION_KEY, latest);
          setLatest(null);
        }}
        aria-label="忽略此版本"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_MANIFEST_URL,
  DISMISSED_VERSION_KEY,
  UPDATE_URL_KEY,
  getNativeBridge,
  isNewerVersion,
} from '@/lib/update-config';

/**
 * 软件更新。
 *
 * 两条线：patch（覆盖网页与 Node 逻辑，约 10MB，重启即生效）和 apk（完整安装包，
 * 只在原生层改动时需要）。清单里 apkVersionCode 比本机大就必须走整包，否则热更足够。
 *
 * 更新地址存在 localStorage：换托管商（GitHub → R2/OSS）时只改这个地址，不必重新打包。
 */

interface UpdateAsset {
  urls: string[];
  sha256?: string;
  size?: number;
}

interface CheckResult {
  current: string;
  latest: string;
  notes?: string;
  patch?: UpdateAsset;
  apk?: UpdateAsset;
  needApk?: boolean;
}

interface DownloadProgress {
  active: boolean;
  kind: string;
  received: number;
  total: number;
  speed: number;
  error: string;
}


function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

export function UpdateSection() {
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState<'patch' | 'apk' | null>(null);
  const [inApp, setInApp] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    setUrl(localStorage.getItem(UPDATE_URL_KEY) || DEFAULT_MANIFEST_URL);
    setInApp(!!getNativeBridge());
  }, []);

  // 下载期间每 500ms 拉一次进度：10MB 的包要下十几秒，没进度条用户会以为卡死
  useEffect(() => {
    if (!busy) {
      setProgress(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch('/api/update/progress');
        if (res.ok && alive) setProgress((await res.json()) as DownloadProgress);
      } catch {
        /* 轮询失败不影响主流程 */
      }
    };
    const timer = setInterval(tick, 500);
    tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [busy]);

  const saveUrl = (value: string) => {
    setUrl(value);
    localStorage.setItem(UPDATE_URL_KEY, value.trim());
  };

  const check = async () => {
    const target = url.trim();
    if (!target) {
      setError('先填更新清单地址');
      return;
    }
    setChecking(true);
    setError('');
    setResult(null);
    setReady(null);
    setMessage('');
    try {
      const code = getNativeBridge()?.versionCode?.() ?? 0;
      // 注意路径是 /api/update（路由文件 api/update/route.ts），不是 /api/update/check
      const res = await fetch(`/api/update?url=${encodeURIComponent(target)}&apkVersionCode=${code}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`更新接口异常（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as CheckResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || '检查失败');
      setResult(data);
      if (!data.needApk && !isNewerVersion(data.latest, data.current)) setMessage('已经是最新版本');
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查失败');
    } finally {
      setChecking(false);
    }
  };

  const apply = async (kind: 'patch' | 'apk') => {
    const asset = kind === 'patch' ? result?.patch : result?.apk;
    if (!asset) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: kind, asset }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; files?: number; size?: number };
      if (!res.ok || data.error) throw new Error(data.error || '更新失败');
      // 装完就把「忽略」标记清掉，免得下次同版本号还被压着
      localStorage.removeItem(DISMISSED_VERSION_KEY);
      setReady(kind);
      setMessage(
        kind === 'patch'
          ? `更新包已就位（写入 ${data.files ?? 0} 个文件），重启后生效`
          : `安装包已下载（${formatSize(data.size)}）`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const restart = () => getNativeBridge()?.restartApp?.();
  const install = () => getNativeBridge()?.installApk?.();

  return (
    <section>
      <h2 className="text-base font-semibold text-content mb-2.5">软件更新</h2>
      <p className="text-sm text-muted leading-relaxed mb-3">
        {result ? `当前版本 v${result.current}` : '填入更新清单地址后可以检查新版本。'}
        {!inApp && '（更新只在使用 App 时可用）'}
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          className="flex-1 rounded-md border border-line bg-transparent px-3 py-2 text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent"
          placeholder="https://example.com/libretv-manifest.json"
          value={url}
          onChange={(e) => saveUrl(e.target.value)}
          spellCheck={false}
        />
        <button className="btn-primary btn-sm shrink-0" onClick={check} disabled={checking || busy}>
          {checking ? '检查中…' : '检查更新'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {message && <p className="mt-2 text-xs text-accent">{message}</p>}

      {busy && progress && progress.total > 0 && (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-faint tabular-nums">
            {(progress.received / 1048576).toFixed(1)} / {(progress.total / 1048576).toFixed(1)} MB
            {progress.speed > 0 && ` · ${(progress.speed / 1048576).toFixed(1)} MB/s`}
          </p>
        </div>
      )}

      {result && (result.needApk || isNewerVersion(result.latest, result.current)) && (
        <div className="mt-3 rounded-lg border border-line bg-chip/30 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="tag bg-accent/15 text-accent">新版本</span>
            <span className="text-sm text-content">v{result.latest}</span>
            {result.needApk && <span className="text-[11px] text-faint">需完整安装</span>}
          </div>
          {result.notes && <p className="text-xs text-muted leading-relaxed mb-2">{result.notes}</p>}

          {result.needApk ? (
            <>
              <p className="text-[11px] text-faint mb-2 leading-relaxed">
                这一版改动了原生层，必须装完整安装包（{formatSize(result.apk?.size)}）。安装时系统会要求允许「安装未知应用」。
              </p>
              {ready === 'apk' ? (
                <button className="btn-primary btn-sm" onClick={install}>
                  安装更新
                </button>
              ) : (
                <button className="btn-primary btn-sm" onClick={() => apply('apk')} disabled={busy}>
                  {busy ? '下载中…' : '下载完整安装包'}
                </button>
              )}
            </>
          ) : (
            <>
              <p className="text-[11px] text-faint mb-2 leading-relaxed">
                热更新只覆盖界面与逻辑（{formatSize(result.patch?.size)}），不用重新安装，重启后生效。
              </p>
              {ready === 'patch' ? (
                <button className="btn-primary btn-sm" onClick={restart}>
                  重启并生效
                </button>
              ) : (
                <button className="btn-primary btn-sm" onClick={() => apply('patch')} disabled={busy}>
                  {busy ? '下载中…' : '立即更新'}
                </button>
              )}
            </>
          )}
          <p className="mt-2 text-[11px] text-faint leading-relaxed">
            更新不会动你的观看记录、收藏和源配置。
          </p>
        </div>
      )}
    </section>
  );
}

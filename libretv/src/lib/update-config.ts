/**
 * 在线更新的共享配置。
 *
 * 更新地址存在 localStorage：换托管商（Gitee → R2 / 对象存储）时只改这里或就地编辑，
 * App 不用重新打包。
 */

export const UPDATE_URL_KEY = 'libretv.updateUrl';
export const DISMISSED_VERSION_KEY = 'libretv.dismissedUpdate';

/** 内置默认清单地址，用户不用手填 */
export const DEFAULT_MANIFEST_URL =
  'https://gitee.com/longxiafan/libre-tvfor-android/raw/master/manifest.json';

export function getManifestUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_MANIFEST_URL;
  return localStorage.getItem(UPDATE_URL_KEY)?.trim() || DEFAULT_MANIFEST_URL;
}

export function setManifestUrl(url: string) {
  localStorage.setItem(UPDATE_URL_KEY, url.trim());
}

export interface NativeBridge {
  versionCode?: () => number;
  restartApp?: () => void;
  installApk?: () => void;
}

/** App 内才有原生桥；浏览器里返回 undefined，更新相关 UI 据此隐藏 */
export function getNativeBridge(): NativeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { LibreTVAndroid?: NativeBridge }).LibreTVAndroid;
}

/**
 * 语义化版本比较：latest 比 current 更新才算「有新版本」。
 * 只判不等会把降级也当成更新提示（装完新版后线上清单还没发，就会误报）。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

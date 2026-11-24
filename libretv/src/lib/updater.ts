import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import AdmZip from 'adm-zip';

/**
 * 在线更新：检查清单 → 下载（多源 + 断点续传）→ 应用。
 *
 * 分成两条线：
 * - patch：覆盖 .next / node_modules / public，重启 App 生效，不用装包；
 * - apk：完整安装包，只在 Java 原生层改动时用。
 *
 * 下载走 node:https 而不是 fetch：App 里 nodejs-mobile 的 undici 对 B站/CDN 的
 * HTTP/2 复用有缺陷（见 bilibili-danmaku.ts 里的说明），大文件更容易断。
 */

const UA = 'LibreTV-Updater/1.0';
/** 单次请求最多跟随的重定向次数（GitHub Release 会 302 到 S3） */
const MAX_REDIRECTS = 5;
/** 一上来就卡住不动的判定：15 秒没有任何数据进来就换下一个源 */
const IDLE_TIMEOUT = 15000;

/** 更新时不覆盖的路径：用户数据和配置必须保住 */
const PRESERVED = ['data/', 'data\\', '.env', 'patch.zip', 'logs/'];

/**
 * 下载进度。一次只跑一个下载，所以用一个模块级单例；
 * 前端每 500ms 轮询它来画进度条——10MB 的包下几分钟没反馈，用户会以为卡死。
 */
export interface DownloadState {
  active: boolean;
  kind: 'patch' | 'apk' | '';
  received: number;
  total: number;
  /** 字节/秒，按已用时间均摊，不追求瞬时精度 */
  speed: number;
  error: string;
}

const progress: DownloadState = { active: false, kind: '', received: 0, total: 0, speed: 0, error: '' };
let progressStartedAt = 0;

export function getDownloadState(): DownloadState {
  if (!progress.active) return { ...progress };
  const elapsed = (Date.now() - progressStartedAt) / 1000;
  return {
    ...progress,
    speed: elapsed > 0.5 ? Math.round(progress.received / elapsed) : 0,
  };
}

function resetProgress(kind: 'patch' | 'apk', total: number, received = 0) {
  progress.active = true;
  progress.kind = kind;
  progress.total = total;
  progress.received = received;
  progress.error = '';
  progressStartedAt = Date.now();
}

function failProgress(message: string) {
  progress.active = false;
  progress.error = message;
}

export interface UpdateAsset {
  /** 多个镜像，按顺序尝试 */
  urls: string[];
  sha256?: string;
  size?: number;
}

export interface UpdateManifest {
  version: string;
  /** 完整安装包的 versionCode，比当前大就必须走 APK */
  apkVersionCode?: number;
  notes?: string;
  patch?: UpdateAsset;
  apk?: UpdateAsset;
}

export interface CheckResult {
  current: string;
  latest: string;
  notes?: string;
  /** 有可用的热更新包 */
  patch?: UpdateAsset;
  /** 必须装 APK（原生层变了） */
  apk?: UpdateAsset & { versionCode?: number };
  needApk: boolean;
}

interface HttpsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: NodeJS.ReadableStream;
  resume: () => void;
}

/** 跟随重定向的 GET，返回流本身（不缓冲，便于大文件落盘） */
function httpsGetFollow(url: string, headers: Record<string, string>, redirects = 0): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'user-agent': UA, ...headers }, timeout: IDLE_TIMEOUT }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = location.startsWith('http') ? location : new URL(location, url).toString();
        httpsGetFollow(next, headers, redirects + 1).then(resolve, reject);
        return;
      }
      resolve({
        status,
        headers: res.headers as Record<string, string | string[] | undefined>,
        stream: res,
        resume: () => res.resume(),
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await httpsGetFollow(url, { accept: 'application/json' });
  if (res.status !== 200) {
    res.resume();
    throw new Error(`清单请求失败（HTTP ${res.status}）`);
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    res.stream.on('data', (c: Buffer) => chunks.push(c));
    res.stream.on('end', () => resolve());
    res.stream.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    // 把实际内容带出来：常见是 Gitee/CDN 返回的 HTML 错误页或登录页
    throw new Error(`清单不是 JSON：${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * 单源下载，带断点续传。
 * 已有部分文件时带 Range 续传：CDN 支持就只补剩下的，不支持（回 200）就重下。
 */
function downloadOnce(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers: Record<string, string> = existing > 0 ? { range: `bytes=${existing}-` } : {};

    httpsGetFollow(url, headers)
      .then((res) => {
        if (res.status === 416) {
          // 断点已经到文件末尾，视为完成
          resolve();
          return;
        }
        if (res.status !== 200 && res.status !== 206) {
          res.resume();
          reject(new Error(`下载失败（HTTP ${res.status}）`));
          return;
        }
        const append = res.status === 206 && existing > 0;
        const ws = createWriteStream(dest, { flags: append ? 'a' : 'w' });
        const stream = res.stream as NodeJS.ReadableStream & { pipe: (d: unknown) => void };
        // 累计已收字节，供前端轮询显示进度
        stream.on('data', (chunk: Buffer) => {
          progress.received += chunk.length;
        });
        stream.pipe(ws);
        ws.on('finish', () => resolve());
        ws.on('error', reject);
        stream.on('error', reject);
      })
      .catch(reject);
  });
}

/** 依次尝试多个镜像；每个源失败就保留已下载的部分，交给下一个源续传 */
async function downloadFromMirrors(asset: UpdateAsset, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 换源续传时，已下载的部分不该重复计入
  progress.received = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  const errors: string[] = [];
  for (const url of asset.urls) {
    try {
      await downloadOnce(url, dest);
      const size = fs.statSync(dest).size;
      if (asset.size && size !== asset.size) {
        errors.push(`${url}: 大小不符（${size}/${asset.size}）`);
        continue;
      }
      if (asset.sha256 && sha256File(dest).toLowerCase() !== asset.sha256.toLowerCase()) {
        errors.push(`${url}: 校验失败`);
        fs.rmSync(dest, { force: true });
        continue;
      }
      return;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  }
  throw new Error(`所有下载源都失败：${errors.join('；')}`);
}

// ---------------------------------------------------------------- 对外接口

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function checkUpdate(manifestUrl: string, apkVersionCode: number): Promise<CheckResult> {
  const manifest = await fetchJson<UpdateManifest>(manifestUrl);
  const needApk = typeof manifest.apkVersionCode === 'number' && manifest.apkVersionCode > apkVersionCode;
  return {
    current: currentVersion(),
    latest: manifest.version,
    notes: manifest.notes,
    patch: manifest.patch,
    // 需要完整更新时，热更新包没用（原生层改不动），只透出 apk
    apk: manifest.apk,
    needApk,
  };
}

/**
 * 应用热更新：解压覆盖到运行目录。
 * data/ 和 .env 一律跳过——升级不能把用户的观看记录和配置冲掉。
 */
export async function applyPatch(asset: UpdateAsset): Promise<{ files: number; skipped: number }> {
  const root = process.cwd();
  const tmp = path.join(root, 'data', 'update-patch.zip');
  resetProgress('patch', asset.size ?? 0);
  try {
    await downloadFromMirrors(asset, tmp);
  } catch (err) {
    failProgress(err instanceof Error ? err.message : '下载失败');
    throw err;
  }

  const zip = new AdmZip(tmp);
  let files = 0;
  let skipped = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.includes('..')) {
      skipped += 1;
      continue;
    }
    if (PRESERVED.some((p) => name === p.replace('/', '') || name.startsWith(p))) {
      skipped += 1;
      continue;
    }
    const target = path.join(root, name);
    // 再确认一次没有跳出运行目录
    if (!path.resolve(target).startsWith(path.resolve(root))) {
      skipped += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    files += 1;
  }
  fs.rmSync(tmp, { force: true });
  progress.active = false;
  return { files, skipped };
}

/** 下载 APK 到外部目录（Node 有写权限，Java 侧用 FileProvider 交给系统安装器） */
export async function downloadApk(asset: UpdateAsset, targetPath: string): Promise<{ path: string; size: number }> {
  resetProgress('apk', asset.size ?? 0);
  try {
    await downloadFromMirrors(asset, targetPath);
  } catch (err) {
    failProgress(err instanceof Error ? err.message : '下载失败');
    throw err;
  }
  const size = fs.statSync(targetPath).size;
  progress.active = false;
  return { path: targetPath, size };
}

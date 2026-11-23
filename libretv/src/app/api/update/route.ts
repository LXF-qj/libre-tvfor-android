import { NextResponse } from 'next/server';
import path from 'node:path';
import { guardRequest } from '@/lib/api-guard';
import { applyPatch, checkUpdate, downloadApk, type UpdateAsset } from '@/lib/updater';

export const runtime = 'nodejs';

/** 检查更新：拿清单、比版本 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = new URL(req.url).searchParams;
  const url = params.get('url')?.trim();
  const apkVersionCode = Number(params.get('apkVersionCode') || '0');
  if (!url) return NextResponse.json({ error: '缺少更新地址' }, { status: 400 });

  try {
    const result = await checkUpdate(url, Number.isFinite(apkVersionCode) ? apkVersionCode : 0);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '检查失败' }, { status: 502 });
  }
}

interface ApplyBody {
  action?: 'patch' | 'apk';
  asset?: UpdateAsset;
}

/**
 * 应用更新：热更直接覆盖运行目录，APK 只下载到本地等 Java 侧调起安装器。
 * 覆盖不会碰 data/ 与 .env（见 updater.applyPatch 的 PRESERVED）。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: ApplyBody;
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const asset = body.asset;
  if (!asset || !Array.isArray(asset.urls) || asset.urls.length === 0) {
    return NextResponse.json({ error: '缺少下载地址' }, { status: 400 });
  }

  try {
    if (body.action === 'apk') {
      // 放在运行目录内：属于 App 私有空间，FileProvider 能授权给系统安装器
      const target = path.join(process.cwd(), 'update.apk');
      const result = await downloadApk(asset, target);
      return NextResponse.json({ ok: true, ...result });
    }
    const result = await applyPatch(asset);
    return NextResponse.json({ ok: true, ...result, needRestart: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '更新失败' }, { status: 502 });
  }
}

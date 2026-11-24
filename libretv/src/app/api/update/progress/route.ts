import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getDownloadState } from '@/lib/updater';

export const runtime = 'nodejs';

/** 下载进度：前端在发起更新后每 500ms 轮询一次，画进度条和速度 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json(getDownloadState());
}

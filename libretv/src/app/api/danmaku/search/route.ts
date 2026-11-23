import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { searchCandidates } from '@/lib/bilibili-danmaku';

export const runtime = 'nodejs';

/**
 * 弹幕候选搜索：按片名去 B站找可用的影视/番剧。
 * 只返回候选，不自动绑定——错配的弹幕比没有弹幕更糟（同系列的另一部、衍生作品都会排前面），
 * 具体用哪一部由用户在详情面板里确认。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = new URL(req.url).searchParams;
  const wd = params.get('wd')?.trim();
  const year = params.get('year')?.trim() || undefined;
  if (!wd) {
    return NextResponse.json({ error: '缺少片名' }, { status: 400 });
  }

  try {
    const candidates = await searchCandidates(wd, year);
    return NextResponse.json({ candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : '搜索失败';
    return NextResponse.json({ error: message, candidates: [] }, { status: 502 });
  }
}

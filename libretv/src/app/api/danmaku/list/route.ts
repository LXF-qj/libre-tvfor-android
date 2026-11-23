import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getEpisodeDanmaku, getSeason } from '@/lib/bilibili-danmaku';

export const runtime = 'nodejs';

/**
 * 按「季 + 集序号」取弹幕。
 * index 用 0 基：采集站的「第 1 集」传 0，避免两边从 0/1 开始的口径打架。
 * 超出季长度时返回空列表而不是报错——采集站集数常常比 B站 多（花絮/预告）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const params = new URL(req.url).searchParams;
  const seasonId = Number(params.get('seasonId'));
  const index = Number(params.get('index') ?? '0');

  if (!Number.isFinite(seasonId) || seasonId <= 0) {
    return NextResponse.json({ error: '缺少季 ID' }, { status: 400 });
  }
  if (!Number.isFinite(index) || index < 0) {
    return NextResponse.json({ error: '集序号无效' }, { status: 400 });
  }

  try {
    const season = await getSeason(seasonId);
    const episode = season.episodes[Math.floor(index)];
    if (!episode) {
      return NextResponse.json({ total: season.episodes.length, list: [], reason: '集数超出 B站 收录范围' });
    }
    const result = await getEpisodeDanmaku(episode.cid);
    return NextResponse.json({
      total: season.episodes.length,
      episodeTitle: episode.title,
      list: result.list,
      rawLength: result.rawLength,
      rawHead: result.rawHead,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '弹幕获取失败';
    return NextResponse.json({ error: message, list: [] }, { status: 502 });
  }
}

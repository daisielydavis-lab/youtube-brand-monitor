/**
 * CLI — B1: boost-affiliate(其他加速器)creator 跨界扫描 (2026-08-23)
 *
 * 背景: RU 加速器 affiliate 生态是多品牌联合投放(LagZapper/Lagofast/ExitLag),
 * 同一 creator 跨品牌用同一 code(见 boost-affiliate-ecosystem 记忆)。
 * → Lagofast 等加速器的 affiliate creator 是 LagZapper 的最佳 similar_creator 候选。
 *
 * DB 内 boost-affiliate 候选频道(不在 LZ watchlist)加进 watchlist 并 channel_scan,
 * 验证跨界假设 + 看能否挖出新 LagZapper 投放。
 *
 * 用法: npm run affiliate:b1
 */

import { getSupabase } from './db/supabase';
import { getChannelRecentVideos, type YouTubeVideoResult } from './services/competitor-monitor/youtube-discovery';
import {
  extractAffiliateSignals, matchIdentity, type AffiliateIdentity,
} from './services/competitor-monitor/affiliate-extractor';

const NINETY_DAYS = new Date(Date.now() - 90 * 86400000).toISOString();
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];

// 全库枚举出的 9 个 boost-affiliate 候选(不在 LZ watchlist)
const CANDIDATES = [
  { channel_id: 'UCULk4FCLVWUNe__pXTpKDPw', channel_name: 'NC 小葉 (ncchfps)' },
  { channel_id: 'UC2saX5SKuBY8rYy-A18rb_Q', channel_name: 'CHAO TRiCKS OFFICIAL' },
  { channel_id: 'UCvuSR9j6L71oKA-6JzQ2YcA', channel_name: 'Jesusita Allabanos' },
  { channel_id: 'UC8CnPlDCBaR0Xb86XfoIflA', channel_name: 'USE APP' },
  { channel_id: 'UC-_kG6oro48NtAsrX_1ZVXw', channel_name: 'AndPah' },
  { channel_id: 'UC8-_tmVldoye6BMatC8n_mg', channel_name: 'Tinkr | Reviews & Guides' },
  { channel_id: 'UCCLVf7wyOpUmB63mVpJmU5w', channel_name: 'Gaming Mobile' },
  { channel_id: 'UCIm7SAwn-3nQOSmC94yht1g', channel_name: 'GigaBits' },
  { channel_id: 'UCPPdSfoTGCcB3ObbzHio5PA', channel_name: 'Learnify Tech' },
];

function hasLzText(v: any): boolean {
  const t = (v.title || '').toLowerCase(), d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper') || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c));
}

async function main() {
  const db = getSupabase();
  console.log('═══ B1: boost-affiliate creator 跨界扫描 ═══\n');

  // ① 加进 watchlist
  let added = 0;
  for (const c of CANDIDATES) {
    const { data: ex } = await db.from('youtube_creator_watchlist').select('channel_id').eq('brand', 'LagZapper').eq('channel_id', c.channel_id);
    if (ex?.length) continue;
    const { error } = await db.from('youtube_creator_watchlist').insert({
      brand: 'LagZapper', channel_id: c.channel_id, channel_name: c.channel_name,
      discovered_via: 'similar_creator', status: 'active',
    });
    if (!error) added++;
  }
  console.log(`① 入池: 新增 ${added}/${CANDIDATES.length} 个 boost-affiliate 候选(discovered_via=similar_creator)`);

  // ② 扫描
  const { data: idData } = await db.from('affiliate_identities').select('*').eq('brand', 'LagZapper');
  const identities = (idData || []) as AffiliateIdentity[];
  const knownIds = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id').range(from, from + 999);
    if (!data?.length) break;
    data.forEach((v: any) => knownIds.add(v.video_id));
    if (data.length < 1000) break;
  }

  let persisted = 0, lz = 0, textOnly = 0;
  const perChan: string[] = [];
  for (const ch of CANDIDATES) {
    let vids: YouTubeVideoResult[];
    try { vids = await getChannelRecentVideos(ch.channel_id, 50); }
    catch (err) { console.log(`  [SKIP] ${ch.channel_name} ${(err as Error).message.slice(0, 60)}`); continue; }
    const fresh = vids.filter(v => v.publishedAt >= NINETY_DAYS && !knownIds.has(v.videoId));
    for (const v of fresh) knownIds.add(v.videoId);
    let chanLz = 0;
    for (const v of fresh) {
      const sig = extractAffiliateSignals(v.description);
      const h = matchIdentity(sig, identities, 'LagZapper');
      const isAff = !!(h || sig.domains.length > 0);
      if (hasLzText(v) && !isAff) textOnly++;
      const { error } = await db.from('youtube_competitor_videos').upsert({
        video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle,
        title: v.title, description: v.description || '', published_at: v.publishedAt,
        duration: v.duration, is_short: v.isShort, thumbnail_url: v.thumbnailUrl || null,
        tags: v.tags, category_id: v.categoryId,
        discovery_method: 'channel_scan',
        has_paid_placement_tag: v.hasPaidPlacementTag,
        view_count: v.viewCount, like_count: v.likeCount, comment_count: v.commentCount,
        workflow_status: 'discovered', brand_id: null, performance_stage: 't0',
        first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
      }, { onConflict: 'video_id' });
      if (!error) persisted++;
      if (isAff) { lz++; chanLz++; }
    }
    perChan.push(`  ${ch.channel_name.slice(0, 22).padEnd(22)} 90d新${String(fresh.length).padEnd(3)} LZ命中${chanLz}`);
    console.log(perChan[perChan.length - 1]);
    await new Promise(s => setTimeout(s, 250));
  }
  console.log(`\n═══ B1 结果 ═══`);
  console.log(`扫描 9 频道 | 90 天新视频 ${persisted} | LagZapper 命中 ${lz} | 文本漏报 ${textOnly}`);
  console.log(`结论: ${lz > 0 ? 'boost-affiliate 跨界命中 ✓' : 'DB 内 boost-affiliate 池过薄,跨界未命中(需扩大 Lagofast 发现源,见 D3 评论区)'}`);
}

main().catch(err => { console.error('B1 failed:', err); process.exit(1); });

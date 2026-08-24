/**
 * CLI — Plan A Round-2: 冻结 crossover + 深扫已确认 partner 池 (2026-08-23)
 *
 * 方案 A(用户批准「可以试试」):
 *   ① 冻结: 60 个 similar_creator crossover 频道 status active → paused(可逆)
 *      —— Round-1 已验证 crossover 跨界对 LagZapper 无效(0/60),冻结省下扫描预算
 *   ② 深扫: 19 个已确认 partner 频道
 *      (ai_confirmed 14 + manual_seed 3 + video_backtrace 2)
 *      每条取最近 50 视频(playlistItems,无 search quota),90 天窗口,
 *      提取 affiliate 信号 → 身份匹配确认 LagZapper → 落库
 *      —— 这些频道每个都 ≥1 条确认投放(TherionGames 一个就挖出 7 条),
 *         深扫 = 把 video_backtrace 逻辑泛化到整个已确认 partner 池
 *
 * 用法:
 *   npm run affiliate:round2                (冻结 + 深扫)
 *   npm run affiliate:round2 -- --freeze-only
 *   npm run affiliate:round2 -- --no-freeze
 */

import { getSupabase } from './db/supabase';
import { getChannelRecentVideos, type YouTubeVideoResult } from './services/competitor-monitor/youtube-discovery';
import {
  extractAffiliateSignals, matchIdentity, type AffiliateIdentity,
} from './services/competitor-monitor/affiliate-extractor';

const PAGE = 1000;
const NINETY_DAYS = new Date(Date.now() - 90 * 86400000).toISOString();
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];
const FREEZE_ONLY = process.argv.includes('--freeze-only');
const NO_FREEZE = process.argv.includes('--no-freeze');

function hasLzText(v: any): boolean {
  const t = (v.title || '').toLowerCase(), d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper') || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c));
}

async function loadKnownIds(db: any): Promise<Set<string>> {
  const known = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id').range(from, from + PAGE - 1);
    if (!data?.length) break;
    data.forEach((v: any) => known.add(v.video_id));
    if (data.length < PAGE) break;
  }
  return known;
}

async function main() {
  const db = getSupabase();
  console.log('═══ Plan A Round-2: 冻结 crossover + 深扫 partner 池 ═══\n');

  // ── ① 冻结 crossover ──
  if (!NO_FREEZE) {
    const { count: activeCount } = await db.from('youtube_creator_watchlist')
      .select('channel_id', { count: 'exact', head: true })
      .eq('brand', 'LagZapper').eq('discovered_via', 'similar_creator').eq('status', 'active');
    const { data: frozenRows, error } = await db.from('youtube_creator_watchlist')
      .update({ status: 'paused' })
      .eq('brand', 'LagZapper').eq('discovered_via', 'similar_creator').eq('status', 'active')
      .select('channel_id');
    const frozenCount = Array.isArray(frozenRows) ? frozenRows.length : 0;
    console.log(`① 冻结 crossover: active ${activeCount ?? 0} → paused ${frozenCount} 个${error ? ' (ERR ' + error.message + ')' : ' ✓'}`);
  } else {
    console.log('① 跳过冻结(--no-freeze)');
  }

  // ── ② 深扫 partner 池 ──
  const PARTNER_VIA = ['ai_confirmed', 'manual_seed', 'video_backtrace'];
  const { data: partners } = await db.from('youtube_creator_watchlist')
    .select('channel_id,channel_name,discovered_via')
    .eq('brand', 'LagZapper').eq('status', 'active').in('discovered_via', PARTNER_VIA);
  const pool = partners || [];
  if (!pool.length) { console.log('② 无已确认 partner 频道可扫'); return; }
  const viaCount: Record<string, number> = {};
  for (const c of pool as any[]) viaCount[c.discovered_via] = (viaCount[c.discovered_via] || 0) + 1;
  console.log(`② 深扫 partner 池: ${pool.length} 个频道(${JSON.stringify(viaCount)} 按 via) × 50 视频\n`);

  const { data: idData } = await db.from('affiliate_identities').select('*').eq('brand', 'LagZapper');
  const identities = (idData || []) as AffiliateIdentity[];
  const knownIds = await loadKnownIds(db);

  const perChan: Array<{ channel: string; via: string; fetched: number; fresh: number; aff: number; hit: number; codes: string[] }> = [];
  const newAffVideos: any[] = [];
  let persisted = 0, textOnly = 0;

  for (const ch of pool as any[]) {
    let vids: YouTubeVideoResult[];
    try { vids = await getChannelRecentVideos(ch.channel_id, 50); }
    catch (err) { console.log(`  [SKIP] ${(ch.channel_name || ch.channel_id)} ${(err as Error).message.slice(0, 70)}`); continue; }
    const fresh = vids.filter(v => v.publishedAt >= NINETY_DAYS && !knownIds.has(v.videoId));
    for (const v of fresh) knownIds.add(v.videoId);

    let aff = 0, hit = 0; const codes: Set<string> = new Set();
    for (const v of fresh) {
      const sig = extractAffiliateSignals(v.description);
      const h = matchIdentity(sig, identities, 'LagZapper');
      const isAff = !!(h || sig.domains.length > 0);
      if (hasLzText(v) && !isAff) textOnly++;
      for (const c of sig.promoCodes) codes.add(c);
      for (const c of sig.cids) codes.add(`cid:${c}`);
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
      if (isAff) {
        aff++; if (h) hit++;
        newAffVideos.push({ video_id: v.videoId, channel: ch.channel_name, title: v.title, hit: !!h, codes: [...codes] });
      }
    }
    perChan.push({ channel: ch.channel_name || ch.channel_id, via: ch.discovered_via, fetched: fresh.length, fresh: fresh.length, aff, hit, codes: [...codes] });
    console.log(`  [${ch.discovered_via.padEnd(14)}] ${(ch.channel_name || '').slice(0, 22).padEnd(22)} 90d新${String(fresh.length).padEnd(3)} 信号${aff} (命中${hit})`);
    await new Promise(s => setTimeout(s, 250));
  }

  // ── 报告 ──
  const totalAff = newAffVideos.length;
  const totalFetched = perChan.reduce((a, b) => a + b.fetched, 0);
  console.log(`\n═══ Round-2 验证指标 ═══`);
  console.log(`1. 扫描频道: ${pool.length} 个(全部已确认 partner)`);
  console.log(`2. 新入库视频: 抓取 ${totalFetched} → 落库 ${persisted}`);
  console.log(`3. 新 LagZapper 投放确认: ${totalAff} 条(identity 命中 ${newAffVideos.filter(v => v.hit).length})`);
  console.log(`   文本命中但未匹配身份的(需人工看): ${textOnly} 条`);
  console.log(`4. 每频道贡献:`);
  for (const p of perChan.sort((a, b) => b.aff - a.aff)) {
    if (p.aff) console.log(`   ${p.channel.slice(0, 24).padEnd(24)} ${p.via.padEnd(14)} 新视频${p.fresh} 投放${p.aff}`);
  }
  if (totalAff) {
    console.log(`5. 新增投放样本:`);
    for (const v of newAffVideos.slice(0, 25)) {
      console.log(`   [${v.hit ? '身份命中' : '新域名'}] ${(v.channel || '').slice(0, 18).padEnd(18)} ${v.video_id} ${(v.title || '').slice(0, 44)} codes=${(v.codes || []).join(',')}`);
    }
  }
  console.log(`\n身份库: ${identities.length} 条(unchanged,未新增 LagZapper 身份)`);
}

main().catch(err => { console.error('Round-2 failed:', err); process.exit(1); });

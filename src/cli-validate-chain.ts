/**
 * LagZapper 链路小规模验证（2026-08-24，验证阶段，不跑完整扫描）
 *
 * 验证闭环:
 *   domain_search → affiliate extractor → affiliate_identity → watchlist → channel_scan
 *
 * 预算控制:
 *   - 只跑 LagZapper 域名 query（RU + BR，各 1 页 10 条 = 2 次 search 调用）
 *   - 只对「新视频 / 新频道」写库；已存在行只读
 *   - 不调 AI，不跑全品牌，不跑全 watchlist
 *
 * 输出 5 指标:
 *   ① domain_search 落库数量（新视频写入后回查确认）
 *   ② 已存在行 discovery_method 是否被覆盖（bug 修复验证，基线 vs 结束对比）
 *   ③ affiliate_identity 生成（brand=LagZapper）
 *   ④ creator 进 watchlist（discovered_via=affiliate_cluster）+ channel_scan 新增视频
 *   ⑤ domain_search → channel_scan 覆盖检测（期望 0）
 */
import { getSupabase } from './db/supabase';
import { searchVideosPaged, getChannelRecentVideos } from './services/competitor-monitor/youtube-discovery';
import { extractAffiliateSignals, mergeIntoIdentity, type AffiliateIdentity } from './services/competitor-monitor/affiliate-extractor';

const NINETY = new Date(Date.now() - 90 * 86400000).toISOString();

async function main() {
  const db = getSupabase();
  console.log('═══ LagZapper 链路小规模验证（domain_search → … → channel_scan）═══');

  // ── 0. 基线：全库 video_id → discovery_method，LagZapper watchlist / identities ──
  const idToMethod = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id,discovery_method,channel_id').range(from, from + 999);
    if (!data?.length) break;
    for (const v of data) idToMethod.set(v.video_id, v.discovery_method);
    if (data.length < 1000) break;
  }
  const watchMap = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_creator_watchlist').select('channel_id,discovered_via').eq('brand', 'LagZapper').range(from, from + 999);
    if (!data?.length) break;
    for (const w of data) watchMap.set(w.channel_id, w.discovered_via);
    if (data.length < 1000) break;
  }
  const { data: identRows } = await db.from('affiliate_identities').select('*').eq('brand', 'LagZapper');
  const identities = (identRows || []) as AffiliateIdentity[];
  console.log(`基线: 全库视频 ${idToMethod.size} | LagZapper watchlist ${watchMap.size} | LagZapper identities ${identities.length}`);
  const knownIds = new Set(idToMethod.keys());

  // ── 1. domain_search（小规模）──
  const QUERIES = [
    { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'ru', targetMarket: 'RU' },
    { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'pt', targetMarket: 'BR' },
  ];
  const found = new Map<string, any>();
  for (const q of QUERIES) {
    const r = await searchVideosPaged(q as any, NINETY, undefined, 1, 10);
    for (const v of r.videos) if (!found.has(v.videoId)) found.set(v.videoId, v);
    console.log(`[搜索] ${q.queryText} ${q.targetMarket}/${q.targetLanguage} → ${r.videos.length} 条（${r.pagesUsed} search 调用）`);
  }
  const newVids = [...found.values()].filter(v => !knownIds.has(v.videoId));
  const existingVids = [...found.values()].filter(v => knownIds.has(v.videoId));
  console.log(`domain_search 命中 ${found.size} 条（去重）→ 新视频 ${newVids.length} | 已存在 ${existingVids.length}`);

  // ── 2. 新视频落库（discovery_method=domain_search）──
  let newPersisted = 0;
  for (const v of newVids) {
    const { error } = await db.from('youtube_competitor_videos').upsert({
      video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle || '',
      title: v.title || '', description: v.description || '', published_at: v.publishedAt || '',
      duration: v.duration || '', is_short: !!v.isShort, thumbnail_url: v.thumbnailUrl || null,
      tags: v.tags || [], category_id: v.categoryId || null,
      discovery_method: 'domain_search', has_paid_placement_tag: !!v.hasPaidPlacementTag,
      view_count: v.viewCount || 0, like_count: v.likeCount || 0, comment_count: v.commentCount || 0,
      workflow_status: 'discovered', brand_id: null, performance_stage: 't0',
      first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id' });
    if (!error) { newPersisted++; knownIds.add(v.videoId); }
    else console.error(`  [落库失败] ${v.videoId}: ${error.message}`);
  }
  // 回查确认 domain_search 真的落库
  let confirmedDomain = 0;
  if (newPersisted) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id,discovery_method').in('video_id', newVids.slice(0, 200).map(v => v.videoId));
    confirmedDomain = (data || []).filter(r => r.discovery_method === 'domain_search').length;
  }
  console.log(`① domain_search 新落库: ${newPersisted}/${newVids.length}（回查确认 ${confirmedDomain} 条 = domain_search）`);

  // ── 3. 新频道 → affiliate_identity + watchlist + channel_scan ──
  const newChans = new Map<string, { name: string; n: number }>();
  for (const v of [...newVids, ...existingVids]) {
    if (!watchMap.has(v.channelId)) {
      const e = newChans.get(v.channelId) || { name: v.channelTitle || '', n: 0 };
      e.n++; newChans.set(v.channelId, e);
    }
  }
  console.log(`③ 新频道（未在 LagZapper watchlist）: ${newChans.size} 个`);
  let identAdded = 0, wlAdded = 0, scanVideos = 0, scanLZ = 0;
  for (const [cid, e] of newChans) {
    const sample = [...newVids, ...existingVids].find(v => v.channelId === cid);
    const sig = sample ? extractAffiliateSignals(sample.description) : null;
    let ident: AffiliateIdentity | null = null;
    if (sig?.primary) {
      ident = mergeIntoIdentity(
        { brand: 'LagZapper', channel_id: cid, channel_name: e.name, signal_type: sig.primary.type, confidence: sig.primary.confidence },
        sig,
      );
    } else if (sig?.domains.length) {
      ident = { brand: 'LagZapper', channel_id: cid, channel_name: e.name, domain: sig.domains[0], signal_type: 'domain', confidence: 0.7 };
    }
    if (ident) {
      const { error } = await db.from('affiliate_identities').upsert({
        brand: ident.brand, channel_id: ident.channel_id, channel_name: ident.channel_name || null,
        promo_code: ident.promo_code || null, affiliate_cid: ident.affiliate_cid || null,
        ref_id: ident.ref_id || null, domain: ident.domain || null,
        signal_type: ident.signal_type, confidence: ident.confidence,
        first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      }, { onConflict: 'brand,channel_id' });
      if (!error) { identAdded++; console.log(`   [identity] ${e.name.slice(0, 22).padEnd(22)} type=${ident.signal_type} conf=${ident.confidence} code=${ident.promo_code || '—'} cid=${ident.affiliate_cid || '—'} domain=${ident.domain || '—'}`); }
    }
    const { error: wlErr } = await db.from('youtube_creator_watchlist').upsert({
      brand: 'LagZapper', channel_id: cid, channel_name: e.name, market: null,
      discovered_via: 'affiliate_cluster', status: 'active', last_scan_at: null,
    }, { onConflict: 'brand,channel_id' });
    if (!wlErr) { wlAdded++; watchMap.set(cid, 'affiliate_cluster'); }

    // channel_scan（只扫 90 天内新视频；domain_search 视频已进 knownIds → 不会重写）
    const vids = await getChannelRecentVideos(cid, 20);
    for (const v of vids) {
      if (v.publishedAt < NINETY || knownIds.has(v.videoId)) continue;
      const sig2 = extractAffiliateSignals(v.description);
      const { error } = await db.from('youtube_competitor_videos').upsert({
        video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle || '',
        title: v.title || '', description: v.description || '', published_at: v.publishedAt || '',
        duration: v.duration || '', is_short: !!v.isShort, thumbnail_url: v.thumbnailUrl || null,
        tags: v.tags || [], category_id: v.categoryId || null,
        discovery_method: 'channel_scan', has_paid_placement_tag: !!v.hasPaidPlacementTag,
        view_count: v.viewCount || 0, like_count: v.likeCount || 0, comment_count: v.commentCount || 0,
        workflow_status: 'discovered', brand_id: null, performance_stage: 't0',
        first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
      }, { onConflict: 'video_id' });
      if (!error) { knownIds.add(v.videoId); scanVideos++; if (sig2.domains.length) scanLZ++; }
    }
  }
  console.log(`④ affiliate_identity 新增: ${identAdded} | watchlist 新增: ${wlAdded}`);
  console.log(`④ channel_scan 新增视频: ${scanVideos}（含 LZ 信号 ${scanLZ}）`);

  // ── 5. 覆盖检测：已存在行结束态 vs 基线 ──
  let drift = 0;
  const driftList: string[] = [];
  const foundIds = [...found.keys()].filter(id => idToMethod.has(id));
  for (let i = 0; i < foundIds.length; i += 200) {
    const chunk = foundIds.slice(i, i + 200);
    const { data } = await db.from('youtube_competitor_videos').select('video_id,discovery_method').in('video_id', chunk);
    for (const r of data || []) {
      if (r.discovery_method !== idToMethod.get(r.video_id)) { drift++; driftList.push(`${r.video_id}: ${idToMethod.get(r.video_id)}→${r.discovery_method}`); }
    }
  }
  console.log(`⑤ 已存在行 discovery_method 漂移: ${drift}（${drift === 0 ? '✓ 未被覆盖' : driftList.slice(0, 5).join('; ')}）`);

  console.log('\n═══ 汇总 ═══');
  console.log(`① domain_search 新落库: ${newPersisted}`);
  console.log(`② 已存在行未覆盖: ${drift === 0 ? '✓' : '✗'}`);
  console.log(`③ 新增 identity: ${identAdded} | watchlist: ${wlAdded}`);
  console.log(`④ channel_scan 新增视频: ${scanVideos}（LZ 信号 ${scanLZ}）`);
  console.log(`⑤ domain_search→channel_scan 覆盖: ${drift}（期望 0）`);
}

main().catch(e => { console.error(e); process.exit(1); });

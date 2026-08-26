/**
 * CLI — Affiliate Creator Seed & Recall Validation（Creator-led Discovery, 2026-08-23）
 *
 * LagZapper 投放 = Affiliate Creator Network:标题无品牌,品牌在 description 的
 * code/cid/域名里。本 CLI 分两阶段:
 *
 *   --seed  ① 存量 31 条信号视频 → 回填 affiliate_identities
 *           ② 2 个 video_backtrace creator 进 watchlist(Anastasell/TherionGames)
 *           ③ RU 优先 top-30 crossover 种子(游戏重叠 + confirmed 数)进 watchlist
 *                discovered_via='similar_creator'
 *   --scan  扫新增 watchlist 频道(uploads playlist)90 天上传 → 提取 affiliate 信号
 *           → 身份库命中确认 LagZapper → 输出 5 项验证指标
 *
 * 用法:
 *   npm run affiliate:seed            (seed + scan)
 *   npm run affiliate:seed -- --seed  (只建种子)
 *   npm run affiliate:seed -- --scan  (只扫描验证)
 */

import { getSupabase } from './db/supabase';
import { getChannelRecentVideos, type YouTubeVideoResult } from './services/competitor-monitor/youtube-discovery';
import {
  extractAffiliateSignals, matchIdentity, mergeIntoIdentity,
  type AffiliateIdentity, type AffiliateSignals,
} from './services/competitor-monitor/affiliate-extractor';

const PAGE = 1000;
const NINETY_DAYS = new Date(Date.now() - 90 * 86400000).toISOString();
const PLACEMENTS = ['confirmed_paid_placement', 'likely_sponsored'];
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];
const SEED = process.argv.includes('--seed');
const SCAN = process.argv.includes('--scan');

function hasLzSignal(v: any): boolean {
  const t = (v.title || '').toLowerCase(), d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper') || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c)) || d.includes('lagzapper.com');
}

async function fetchAll(cols: string[]): Promise<any[]> {
  const db = getSupabase();
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select(cols.join(',')).order('video_id').range(from, from + PAGE - 1);
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

// ─────────────────────────── Phase 1-3: SEED ───────────────────────────
async function runSeed() {
  const db = getSupabase();
  const all = await fetchAll(['video_id', 'title', 'description', 'channel_id', 'channel_name', 'language', 'market', 'game_name', 'placement_type', 'published_at', 'first_seen_at']);
  const lzVids = all.filter(hasLzSignal);
  console.log(`══ SEED ══ 全量 ${all.length} | LagZapper 信号视频 ${lzVids.length}\n`);

  // ── ① 身份回填:每个 channel 汇总所有视频的 affiliate 信号 ──
  const merged = new Map<string, AffiliateIdentity>();
  for (const v of lzVids) {
    const sig = extractAffiliateSignals(v.description);
    if (!sig.primary) continue;
    const base: AffiliateIdentity = merged.get(v.channel_id) || {
      brand: 'LagZapper', channel_id: v.channel_id, channel_name: v.channel_name || '',
      signal_type: 'domain', confidence: 0,
    };
    merged.set(v.channel_id, mergeIntoIdentity(base, sig));
  }
  let idUp = 0;
  for (const idn of merged.values()) {
    const { error } = await db.from('affiliate_identities').upsert({
      brand: idn.brand, channel_id: idn.channel_id, channel_name: idn.channel_name,
      promo_code: idn.promo_code || null, affiliate_cid: idn.affiliate_cid || null,
      ref_id: idn.ref_id || null, domain: idn.domain || null,
      signal_type: idn.signal_type, confidence: idn.confidence, last_seen_at: new Date().toISOString(),
    }, { onConflict: 'brand,channel_id' });
    if (!error) idUp++;
  }
  console.log(`① 身份回填: 更新 ${idUp} 个 creator 身份(共 ${merged.size} 个带信号)`);

  // ── ② 2 个 video_backtrace creator ──
  const backtraces = [
    { channel_id: 'UChz5pvXd-EZDArWDkfMrluA', channel_name: 'Anastasell' },
    { channel_id: 'UCPr4dKZFtk-gtwWghwJN_MQ', channel_name: 'TherionGames' },
  ];
  let btAdded = 0;
  for (const c of backtraces) {
    const { data: ex } = await db.from('youtube_creator_watchlist').select('channel_id').eq('brand', 'LagZapper').eq('channel_id', c.channel_id);
    if (ex?.length) continue;
    const { error } = await db.from('youtube_creator_watchlist').insert({
      brand: 'LagZapper', channel_id: c.channel_id, channel_name: c.channel_name,
      discovered_via: 'video_backtrace', status: 'active',
    });
    if (!error) btAdded++;
  }
  console.log(`② video_backtrace: 新增 ${btAdded}/2 个 creator(Anastasell/TherionGames)`);

  // ── ③ RU 优先 top-30 crossover 种子 ──
  const { data: watchAll } = await db.from('youtube_creator_watchlist').select('channel_id').eq('brand', 'LagZapper');
  const lzWatchIds = new Set((watchAll || []).map((w: any) => w.channel_id));
  const knownGames = new Set<string>();
  for (const v of lzVids) { const g = v.game_name; if (g) knownGames.add(String(g).toLowerCase()); }

  const chanConf = new Map<string, { name: string; lang: string; n: number; gameOverlap: number }>();
  for (const v of all) {
    if (!PLACEMENTS.includes(v.placement_type)) continue;
    if (v.language !== 'ru' && v.language !== 'en') continue;
    if (lzWatchIds.has(v.channel_id)) continue;
    if (!chanConf.has(v.channel_id)) {
      chanConf.set(v.channel_id, { name: v.channel_name || '', lang: v.language, n: 0, gameOverlap: 0 });
    }
    const e = chanConf.get(v.channel_id)!;
    e.n++;
    if (v.game_name && knownGames.has(String(v.game_name).toLowerCase())) e.gameOverlap++;
  }
  const cands = [...chanConf.entries()].map(([cid, e]) => ({ cid, ...e }));
  cands.sort((a, b) => {
    const ra = a.lang === 'ru' ? 0 : 1, rb = b.lang === 'ru' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (b.gameOverlap !== a.gameOverlap) return b.gameOverlap - a.gameOverlap;
    return b.n - a.n;
  });
  const top30 = cands.slice(0, 30);
  let seedAdded = 0;
  for (const c of top30) {
    const { error } = await db.from('youtube_creator_watchlist').upsert({
      brand: 'LagZapper', channel_id: c.cid, channel_name: c.name,
      discovered_via: 'similar_creator', status: 'active',
    }, { onConflict: 'brand,channel_id' });
    if (!error) seedAdded++;
  }
  console.log(`③ crossover 种子: 候选 ${cands.length} → 入池 ${seedAdded}/30 (RU 优先 + 游戏重叠)`);
  console.log(`   入池: ${top30.slice(0, 10).map(c => `${c.name.slice(0, 14)}(${c.lang},×${c.n})`).join(' | ')}…`);
  console.log(`\nSeed 完成。下一步: npm run affiliate:seed -- --scan`);
}

// ─────────────────────────── Phase 4: SCAN + VALIDATE ───────────────────────────
async function runScan() {
  const db = getSupabase();
  // similar_creator 已暂停（round-1 0/60 + b1 0/9 无效，2026-08-26 拍板）。
  // 只保留身份驱动来源。存量 similar_creator 频道均已置 paused（可逆，历史保留）。
  const NEW_SOURCES = ['video_backtrace', 'affiliate_cluster'];
  const { data: newWatch } = await db.from('youtube_creator_watchlist')
    .select('channel_id,channel_name,discovered_via')
    .eq('brand', 'LagZapper').in('discovered_via', NEW_SOURCES);
  const channels = newWatch || [];
  if (!channels.length) { console.log('没有待扫描的新种子频道(先跑 --seed)'); return; }
  console.log(`══ SCAN ══ 扫描 ${channels.length} 个新种子频道(90 天 uploads)…\n`);

  // 已有身份库
  const { data: idData } = await db.from('affiliate_identities').select('*').eq('brand', 'LagZapper');
  const identities = (idData || []) as AffiliateIdentity[];

  // 已知 video_id(避免重复)
  const knownIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id').range(from, from + PAGE - 1);
    if (!data?.length) break;
    data.forEach((v: any) => knownIds.add(v.video_id));
    if (data.length < PAGE) break;
  }

  const bySource: Record<string, { channels: number; videos: number; affiliate: number }> = {};
  const newAffVideos: any[] = [];
  const newCodes: Set<string> = new Set();
  let scanned = 0, persisted = 0;

  for (const ch of channels) {
    const src = ch.discovered_via || 'unknown';
    bySource[src] = bySource[src] || { channels: 0, videos: 0, affiliate: 0 };
    bySource[src].channels++;
    let vids: YouTubeVideoResult[];
    try {
      vids = await getChannelRecentVideos(ch.channel_id, 20);
    } catch (err) {
      console.log(`  [SKIP] ${ch.channel_id} ${(err as Error).message.slice(0, 80)}`);
      continue;
    }
    const fresh = vids.filter(v => v.publishedAt >= NINETY_DAYS && !knownIds.has(v.videoId));
    scanned++;
    for (const v of fresh) {
      knownIds.add(v.videoId);
      bySource[src].videos++;
      const sig = extractAffiliateSignals(v.description);
      // 身份命中 / 新域名 → LagZapper affiliate
      const hit = matchIdentity(sig, identities, 'LagZapper');
      const hasDomain = sig.domains.length > 0;
      const isAff = !!(hit || hasDomain);
      // 新 code/cid 记入身份库(新 creator 发现)
      for (const c of sig.promoCodes) {
        if (!identities.some(i => i.promo_code === c)) newCodes.add(c);
      }
      for (const c of sig.cids) {
        if (!identities.some(i => i.affiliate_cid === c)) newCodes.add(`cid:${c}`);
      }
      // 落库(channel_scan,后续正常 pipeline 会分类)
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
        bySource[src].affiliate++;
        newAffVideos.push({ video_id: v.videoId, channel: ch.channel_name, title: v.title, hit: !!hit, codes: [...sig.promoCodes, ...sig.cids], domains: sig.domains });
      }
    }
    await new Promise(s => setTimeout(s, 250));
  }

  // ── 验证指标输出 ──
  const before = 28; // 现状 Layer-3 LagZapper(基线)
  console.log(`\n══ 验证指标 ══`);
  console.log(`1. 新增 creator(本次扫描频道): ${channels.length} (${Object.entries(bySource).map(([k, v]) => `${k}=${v.channels}`).join(', ')})`);
  console.log(`2. 新增 LagZapper affiliate 视频: ${newAffVideos.length} 条 (本次扫描 ${scanned} 频道 / 抓取 ${Object.values(bySource).reduce((a, b) => a + b.videos, 0)} 条视频, 落库 ${persisted})`);
  console.log(`3. affiliate identity: 库内 ${identities.length} → 新发现信号 ${newCodes.size} 个(${[...newCodes].slice(0, 15).join(', ')})`);
  console.log(`4. 增长比例: 基线 ${before} → +${newAffVideos.length} affiliate 确认(identity 命中 ${newAffVideos.filter(v => v.hit).length} + 新域名 ${newAffVideos.filter(v => !v.hit).length})(全量 Layer-3 需下一轮 AI 分类确认)`);
  console.log(`5. 每 discovered_via 贡献:`);
  for (const [k, v] of Object.entries(bySource)) {
    console.log(`   ${k.padEnd(18)} 频道${String(v.channels).padEnd(4)} 抓取${String(v.videos).padEnd(5)} LagZapper信号${v.affiliate}`);
  }
  if (newAffVideos.length) {
    console.log(`\n新增 affiliate 视频样本:`);
    for (const v of newAffVideos.slice(0, 20)) {
      console.log(`  [${v.hit ? '身份命中' : '新域名'}] ${(v.channel || '').slice(0, 18).padEnd(18)} ${v.video_id} ${(v.title || '').slice(0, 40)} codes=${(v.codes || []).join(',')} dom=${(v.domains || []).join(',')}`);
    }
  }
}

async function main() {
  const doSeed = SEED || !SCAN;
  const doScan = SCAN || !SEED;
  if (doSeed) await runSeed();
  if (doScan) await runScan();
}

main().catch(err => { console.error('Affiliate seed CLI failed:', err); process.exit(1); });

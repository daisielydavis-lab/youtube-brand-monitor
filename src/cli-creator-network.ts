/**
 * CLI — LagZapper Creator Network Report（只读分析,不改代码）
 *
 * 从现有 LagZapper 信号视频 + Watchlist 反查 Creator 网络:
 *   1. 已知 Creator 画像(channel / language / market / game / 域名 / promo code / cid)
 *   2. Promo code 聚类(同 code 跨频道 = 同一 affiliate campaign)
 *   3. Affiliate 参数聚类(cid / ref)
 *   4. Crossover 候选(DB 内 RU/NA 游戏频道、未进 LagZapper watchlist、有 confirmed 投放)
 *
 * 用法: npm run creator:network
 */

import { getSupabase } from './db/supabase';
import { canonicalBrand } from './services/competitor-monitor/brand-normalization';

const PAGE = 1000;
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];

function brandOf(v: any): string {
  const r = canonicalBrand(v.canonical_brand || v.raw_brand)
    || canonicalBrand(v.classification_raw?.rule?.brand)
    || canonicalBrand(v.classification_raw?.ai?.brand)
    || canonicalBrand(v.classification_raw?.final?.brand);
  return r || 'unknown';
}
function hasLzSignal(v: any): boolean {
  const t = (v.title || '').toLowerCase(), d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper') || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c)) || d.includes('lagzapper.com');
}

interface AffSig { codes: Set<string>; cids: Set<string>; refs: Set<string>; domains: Set<string>; hasDiscount: boolean; }
function extractAff(desc: string): AffSig {
  const s: AffSig = { codes: new Set(), cids: new Set(), refs: new Set(), domains: new Set(), hasDiscount: false };
  const d = desc || '';
  const dm = d.match(/https?:\/\/[^\s"'\\)]*lagzapper[^\s"'\\)]*/gi) || [];
  for (const u of dm) {
    const dom = (u.match(/https?:\/\/(?:www\.)?(lagzapper(?:\.com|\.gg|\.net|\.io|\.app|\.ru)?)/i) || [])[1];
    if (dom) s.domains.add(dom);
    const params = u.match(/[?&](?:cid|ref|refid|aff_id|aff|partner)=([A-Za-z0-9_-]{1,24})/gi) || [];
    for (const p of params) {
      const [, k, v] = p.match(/[?&](cid|ref|refid|aff_id|aff|partner)=([A-Za-z0-9_-]{1,24})/i) || [];
      if (k === 'cid') s.cids.add(v);
      else s.refs.add(v);
    }
  }
  const codePats = [
    /промокод[а-яё]*\s*[:—-]?\s*["']?([A-Za-z0-9_-]{3,18})/gi,
    /по промокоду\s*["']?([A-Za-z0-9_-]{3,18})/gi,
    /use\s+my\s+code\s*["']?([A-Za-z0-9_-]{3,18})/gi,
    /\bcod[eo]\s*["']?([A-Za-z0-9_-]{3,18})/gi,
    /code\s*["']?([A-Za-z0-9_-]{3,18})/gi,
  ];
  const STOP = new Set(['code', 'promo', 'http', 'www', 'com', 'the', 'and', 'this', 'you', 'your', 'with', 'для', 'при', 'game']);
  for (const re of codePats) {
    let m;
    while ((m = re.exec(d)) !== null) {
      const c = m[1].toUpperCase();
      if (c.length >= 3 && c.length <= 18 && !STOP.has(c.toLowerCase()) && !/^[A-Z0-9_-]+$/.test(c) === false) {
        if (c.includes(' ')) continue;
        s.codes.add(c);
      }
    }
  }
  s.hasDiscount = /(скидк\w*\s+\d+\s*%|по\s+промокоду|discount\s+\d+\s*%|-\d+\s*%|промокод)/i.test(d);
  return s;
}

async function fetchAll(cols: string[], filter?: (q: any) => any): Promise<any[]> {
  const db = getSupabase();
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    let q: any = db.from('youtube_competitor_videos').select(cols.join(',')).order('video_id').range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  console.log('═══ LagZapper Creator Network Report ═══\n');
  const db = getSupabase();

  // Watchlist LagZapper 频道
  const { data: watch } = await db.from('youtube_creator_watchlist').select('*').ilike('brand', '%zapper%');
  const watchLz = (watch || []).filter((w: any) => (w.brand || '').toLowerCase().includes('zapper'));
  const watchIds = new Set(watchLz.map((w: any) => w.channel_id));

  // 全量视频(带信号判断)
  console.log('(加载全量视频…)');
  const all = await fetchAll(['video_id', 'title', 'description', 'channel_id', 'channel_name', 'language', 'market', 'game_name', 'placement_type', 'canonical_brand', 'raw_brand', 'classification_raw', 'published_at']);

  const lzVids = all.filter(hasLzSignal);
  console.log(`全量 ${all.length} 条 | LagZapper 信号视频 ${lzVids.length} 条\n`);

  // ── 1. 已知 Creator 画像 ──
  const byChan = new Map<string, { vids: any[]; }>();
  for (const v of lzVids) {
    if (!byChan.has(v.channel_id)) byChan.set(v.channel_id, { vids: [] });
    byChan.get(v.channel_id)!.vids.push(v);
  }
  console.log(`── 1. LagZapper 信号 Creator(信号视频 ${lzVids.length} 条,频道 ${byChan.size} 个)──\n`);
  for (const [cid, { vids }] of [...byChan.entries()].sort((a, b) => b[1].vids.length - a[1].vids.length)) {
    const v0 = vids[0];
    const games = new Set<string>();
    for (const v of vids) { const g = v.game_name || v.classification_raw?.ai?.game || v.classification_raw?.rule?.game; if (g) games.add(String(g)); }
    const conf = vids.filter(v => ['confirmed_paid_placement', 'likely_sponsored'].includes(v.placement_type)).length;
    const aff = vids.map(v => extractAff(v.description));
    const codes = new Set<string>(); const cids = new Set<string>(); const doms = new Set<string>();
    for (const a of aff) { a.codes.forEach(c => codes.add(c)); a.cids.forEach(c => cids.add(c)); a.domains.forEach(d => doms.add(d)); }
    const langs = [...new Set(vids.map(v => v.language || '?'))].join('/');
    const mkts = [...new Set(vids.map(v => v.market || '?'))].join('/');
    const inW = watchIds.has(cid) ? 'IN-WATCH' : 'NOT-WATCH';
    const latest = vids.map(v => v.published_at || '').sort().pop()?.slice(0, 10) || '';
    console.log(`  [${inW.padEnd(9)}] ${cid} ${(v0.channel_name || '').slice(0, 22).padEnd(22)} lang=${langs.padEnd(8)} mkt=${mkts.padEnd(8)} 信号${vids.length}/确认${conf} games=${[...games].slice(0, 4).join(',').slice(0, 34).padEnd(34)} ${latest}`);
    if (codes.size) console.log(`       codes: ${[...codes].join(', ')}`);
    if (cids.size) console.log(`       cid/ref: ${[...cids].join(', ')}`);
    if (doms.size) console.log(`       domains: ${[...doms].join(', ')}`);
  }

  // ── 2. Promo code 聚类 ──
  console.log(`\n── 2. Promo code 聚类(同 code 跨频道 = 同一 affiliate campaign)──`);
  const codeChan = new Map<string, Set<string>>();
  const codeVid = new Map<string, string[]>();
  for (const v of lzVids) {
    const a = extractAff(v.description);
    for (const c of a.codes) {
      if (!codeChan.has(c)) { codeChan.set(c, new Set()); codeVid.set(c, []); }
      codeChan.get(c)!.add(v.channel_id);
      codeVid.get(c)!.push(v.video_id);
    }
  }
  const sortedCodes = [...codeChan.entries()].sort((a, b) => b[1].size - a[1].size || b[0].localeCompare(a[0]));
  if (!sortedCodes.length) console.log('  (未提取到 promo code — 多为域名+cid 模式)');
  for (const [c, chans] of sortedCodes.slice(0, 25)) console.log(`  ${c.padEnd(12)} 频道×${chans.size} 视频×${codeVid.get(c)!.length} → ${[...chans].slice(0, 4).join(', ')}`);

  // ── 3. cid 聚类 ──
  console.log(`\n── 3. Affiliate 参数聚类(cid/ref)──`);
  const cidChan = new Map<string, Set<string>>();
  for (const v of lzVids) {
    const a = extractAff(v.description);
    const all = [...a.cids, ...a.refs];
    for (const c of all) {
      if (!cidChan.has(c)) cidChan.set(c, new Set());
      cidChan.get(c)!.add(v.channel_id);
    }
  }
  const sortedCid = [...cidChan.entries()].sort((a, b) => b[1].size - a[1].size);
  if (!sortedCid.length) console.log('  (未提取到 cid/ref 参数)');
  for (const [c, chans] of sortedCid.slice(0, 25)) console.log(`  ${c.padEnd(12)} 频道×${chans.size} → ${[...chans].slice(0, 4).join(', ')}`);

  // ── 4. Crossover 候选 ──
  console.log(`\n── 4. Crossover 候选(DB 内 RU/NA 游戏频道,未进 LagZapper watchlist,有 confirmed 投放)──`);
  const confVids = all.filter(v => ['confirmed_paid_placement', 'likely_sponsored'].includes(v.placement_type) && ['ru', 'en'].includes(v.language || ''));
  const chanConf = new Map<string, { name: string; n: number; brands: Set<string>; games: Set<string> }>();
  for (const v of confVids) {
    if (watchIds.has(v.channel_id)) continue;
    if (!chanConf.has(v.channel_id)) chanConf.set(v.channel_id, { name: v.channel_name || '', n: 0, brands: new Set(), games: new Set() });
    const e = chanConf.get(v.channel_id)!;
    e.n++;
    const b = brandOf(v);
    if (b !== 'unknown') e.brands.add(b);
    if (v.game_name) e.games.add(String(v.game_name));
  }
  const cands = [...chanConf.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`  RU/EN confirmed 投放频道(未进 LZ watchlist): ${cands.length} 个`);
  for (const [cid, e] of cands.slice(0, 30)) {
    console.log(`  ${cid} ${e.name.slice(0, 22).padEnd(22)} confirmed×${String(e.n).padEnd(4)} brands=[${[...e.brands].join(',')}] games=${[...e.games].slice(0, 3).join(',').slice(0, 30)}`);
  }

  // ── 摘要 ──
  const notWatchChans = [...byChan.entries()].filter(([cid]) => !watchIds.has(cid));
  console.log(`\n── 摘要 ──`);
  console.log(`  LagZapper 信号频道 ${byChan.size} 个(信号视频 ${lzVids.length})`);
  console.log(`  已进 watchlist ${byChan.size - notWatchChans.length} | 未进(video_backtrace 候选)${notWatchChans.length}: ${notWatchChans.map(([c]) => c).join(', ')}`);
  console.log(`  promo code 聚类 ${sortedCodes.length} 组 | cid/ref 聚类 ${sortedCid.length} 组`);
  console.log(`  crossover 候选频道 ${cands.length} 个(前 30 已列出)`);
}

main().catch(err => { console.error('Creator Network Report failed:', err); process.exit(1); });

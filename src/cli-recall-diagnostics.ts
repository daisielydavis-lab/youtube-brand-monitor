/**
 * CLI — 搜索召回诊断（只读）
 *
 * 评估「某条搜索路径还能不能捞到新的品牌投放」。每个 query 最多拿 1 页，
 * 输出 4 个决策指标：
 *   - unique candidates  ：返回里不在 DB 的新视频
 *   - 信号命中(placement)：新视频里含品牌信号（品牌词/域名/promo 规则，即 confirmed/likely 代理）
 *   - new creators       ：信号命中视频里去重后的新频道
 *   - search efficiency  ：本次消耗的 search 调用带回的信号命中数
 *
 * 用法：
 *   npm run recall:diag                    # LagZapper 默认探针（含 RU 泛内容 creator 池评估）
 *   npm run recall:diag -- --brand GearUP  # GearUP 亚洲探针（TW/TH/VI/ID/MY）
 *
 * 由 diag-tmp.ts 重构而来（2026-08-24）。决策原则（2026-08-26 拍板）：
 * 有增量证据的 query 才正式进 NORMAL_QUERIES，禁止拍脑袋加 query。
 */

import { getSupabase } from './db/supabase';
import { searchVideosPaged } from './services/competitor-monitor/youtube-discovery';
import { BRANDS, type BrandConfig } from './services/competitor-monitor/brand-config';

const NINETY = new Date(Date.now() - 90 * 86400000).toISOString();
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];

interface Probe { q: string; mkt: string; lang: string; note: string; }

// 品牌信号判定：品牌词 / 追踪域名 / promo 规则（+ 每品牌额外变体词）
function brandSignal(v: any, brand: BrandConfig, extra: string[] = []): boolean {
  const t = (v.title || '').toLowerCase();
  const d = (v.description || '').toLowerCase();
  if (brand.brandKeywords.some(k => t.includes(k) || d.includes(k))) return true;
  if (brand.trackedDomains.some(dom => d.includes(dom))) return true;
  if (brand.promoCodePatterns.some(p => p.test(t) || p.test(d))) return true;
  return extra.some(c => t.includes(c) || d.includes(c));
}

const LZ_PROBES: Probe[] = [
  { q: 'lagzapper.com', mkt: 'RU', lang: 'ru', note: '域名搜索(测 description 索引)' },
  { q: 'lagzapper.com', mkt: 'US', lang: 'en', note: '域名搜索 EN' },
  { q: 'как убрать лаги', mkt: 'RU', lang: 'ru', note: 'RU 泛 lag 内容(creator 池)' },
  { q: 'игровой бустер', mkt: 'RU', lang: 'ru', note: 'RU 游戏加速器 niche' },
  { q: 'снизить пинг', mkt: 'RU', lang: 'ru', note: 'RU 降 ping niche' },
];

const GEARUP_ASIA_PROBES: Probe[] = [
  { q: 'GearUP 加速器', mkt: 'TW', lang: 'zh-TW', note: 'TW 加速器词' },
  { q: 'GearUP booster', mkt: 'TW', lang: 'zh-TW', note: 'TW 品牌词' },
  { q: 'GearUP เกม', mkt: 'TH', lang: 'th', note: 'TH 游戏词' },
  { q: 'GearUP', mkt: 'TH', lang: 'th', note: 'TH 品牌词' },
  { q: 'GearUP tăng tốc', mkt: 'VI', lang: 'vi', note: 'VI 加速词' },
  { q: 'GearUP', mkt: 'VI', lang: 'vi', note: 'VI 品牌词' },
  { q: 'GearUP booster', mkt: 'ID', lang: 'id', note: 'ID 品牌词' },
  { q: 'GearUP gratis', mkt: 'ID', lang: 'id', note: 'ID 免费词' },
  { q: 'GearUP', mkt: 'MY', lang: 'ms', note: 'MY 品牌词' },
  { q: 'GearUP booster', mkt: 'MY', lang: 'ms', note: 'MY 品牌词' },
];

async function main() {
  const args = process.argv.slice(2);
  const brandArg = (args.find(a => a.startsWith('--brand=')) || '').split('=')[1] || 'LagZapper';
  const brand = BRANDS.find(b => b.brandName === brandArg) || BRANDS[0];
  const probes = brandArg === 'GearUP' ? GEARUP_ASIA_PROBES : LZ_PROBES;
  const extra = brandArg === 'LagZapper' ? CYC : [];

  const db = getSupabase();

  // ── ① DB 90 天信号基线 ──
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos')
      .select('video_id,title,description,channel_id,channel_name,language,market,published_at,discovery_method')
      .range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const db90 = all.filter(v => (v.published_at || '') >= NINETY && brandSignal(v, brand, extra));
  const byMkt: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  for (const v of db90) {
    const mkt = v.market || v.language || '?';
    byMkt[mkt] = (byMkt[mkt] || 0) + 1;
    const method = v.discovery_method || 'search';
    byMethod[method] = (byMethod[method] || 0) + 1;
  }
  const knownIds = new Set(all.map(v => v.video_id));
  const knownChans = new Set(all.map(v => v.channel_id));
  console.log(`① DB 90天 ${brandArg} 信号视频: ${db90.length} 条 (全库 ${all.length})`);
  console.log(`   按市场: ${JSON.stringify(byMkt)}`);
  console.log(`   按发现方式: ${JSON.stringify(byMethod)}`);

  // ── ② 探针实测 ──
  console.log(`\n② ${brandArg} 探针(90天,每条 1 页):`);
  const totals = { candidates: 0, signal: 0, newCreators: 0 };
  const perMarket: Record<string, { candidates: number; signal: number; newCreators: number; queries: number }> = {};
  for (const t of probes) {
    const r = await searchVideosPaged(
      { brandName: brand.brandName, queryText: t.q, queryType: 'branded', targetLanguage: t.lang, targetMarket: t.mkt } as any,
      NINETY, undefined, 1, 50,
    );
    const vids = r.videos || [];
    const candidates = vids.filter(v => !knownIds.has(v.videoId));
    const signalVids = candidates.filter(v => brandSignal(v, brand, extra));
    const creators = new Set(signalVids.map(v => v.channelId));
    const newCreators = [...creators].filter(c => !knownChans.has(c));
    totals.candidates += candidates.length;
    totals.signal += signalVids.length;
    totals.newCreators += newCreators.length;
    const mk = perMarket[t.mkt] || { candidates: 0, signal: 0, newCreators: 0, queries: 0 };
    mk.candidates += candidates.length; mk.signal += signalVids.length;
    mk.newCreators += newCreators.length; mk.queries++;
    perMarket[t.mkt] = mk;
    console.log(`  [${t.mkt}/${t.q}] 候选${candidates.length} 信号${signalVids.length} 新creator${newCreators.length}  ${t.note}`);
    for (const v of signalVids.slice(0, 5)) {
      const d = (v.description || '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`     NEW [${(v.channelTitle || '').slice(0, 18)}] ${v.videoId} ${(v.title || '').slice(0, 40)} || ${d}`);
    }
  }
  console.log(`\n── 汇总(共 ${probes.length} 次 search)──`);
  console.log(`总候选 ${totals.candidates} | 信号命中 ${totals.signal} | 新creator ${totals.newCreators} | 每 search 信号 ${(totals.signal / probes.length).toFixed(2)}`);
  console.log(`按市场:`);
  for (const [mkt, m] of Object.entries(perMarket).sort((a, b) => b[1].signal - a[1].signal)) {
    const eff = (m.signal / m.queries).toFixed(2);
    console.log(`  ${mkt.padEnd(3)} 候选${String(m.candidates).padEnd(4)} 信号${String(m.signal).padEnd(4)} 新creator${String(m.newCreators).padEnd(4)} ${m.queries}query 每query信号${eff}`);
  }
  console.log(`\n结论建议: 信号>0 且有新 creator 的 query 才值得进 NORMAL_QUERIES; 0 信号的市场暂缓。`);
}

main().catch(e => { console.error(e); process.exit(1); });

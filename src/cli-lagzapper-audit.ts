/**
 * CLI — LagZapper Discovery Audit（Phase 2 前置排查，用户 2026-08-23）
 *
 * 用户怀疑:24 条 Layer-3 不像真实投放量,更像 Discovery 链路小概率命中。
 * 三个假设:
 *   H1 投放视频标题/标签不含品牌词(只有 affiliate link) → title-search 天然漏
 *   H2 Creator pool 未建立(Watchlist 只能来自 AI 确认 → 死循环)
 *   H3 description/link/pinned 的品牌信号没被利用
 *
 * 本脚本只读不写,输出:
 *   0. 90 天含 LagZapper 的搜索结果量(backfill_windows 历史)
 *   1. LagZapper 信号候选池全漏斗:总候选 → 品牌命中 → Layer-3 / 品牌null / organic / needsAI
 *   2. Layer-3 24 条来源分布(discovery_method × language × market)+ 逐条明细
 *   3. title 无品牌但 description/link 有信号(affiliate 形态)的漏网量
 *   4. Creator 分析:信号频道数 / channel_scan / Watchlist 覆盖 / 未建立池
 *
 * 用法: npm run audit:lagzapper
 */

import { getSupabase } from './db/supabase';

const PAGE = 1000;
const PLACEMENTS = ['confirmed_paid_placement', 'likely_sponsored'] as const;
const NINETY_DAYS = Date.now() - 90 * 86400000;

function lzBrandRe(s: string): boolean {
  const x = s.toLowerCase();
  return x.includes('lagzapper') || x.includes('lag zapper') || x.includes('лагзаппер') || x.includes('ЛАГЗАППЕР'.toLowerCase());
}
function hasZapperCode(s: string): boolean {
  const x = s.toLowerCase();
  // 只含 zapper / 具体 promo code(LZ10 / ZAPPER5),不含完整 lagzapper
  return x.includes('zapper') && !lzBrandRe(x);
}
function brandIsLagZapper(v: any): boolean {
  if (v.canonical_brand === 'LagZapper') return true;
  const raws = [v.raw_brand, v.classification_raw?.rule?.brand, v.classification_raw?.ai?.brand, v.classification_raw?.final?.brand]
    .filter(Boolean).join('|');
  return lzBrandRe(raws);
}

interface Candidate {
  v: any;
  sig: { brandTitle: boolean; brandDesc: boolean; brandRaw: boolean; zapperOnly: boolean };
}

async function loadAll(): Promise<any[]> {
  const db = getSupabase();
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select('video_id,title,description,channel_id,channel_name,language,market,discovery_method,placement_type,workflow_status,published_at,first_seen_at,has_paid_placement_tag,raw_brand,canonical_brand,classification_raw')
      .order('video_id')
      .range(from, from + PAGE - 1);
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

function isL3(v: any): boolean {
  if (!PLACEMENTS.includes(v.placement_type as any)) return false;
  if (!brandIsLagZapper(v)) return false;
  const ai = v.classification_raw?.ai;
  const needsAI = !!v.classification_raw?.rule?.needsAI && !ai;
  return (!!ai || !!v.has_paid_placement_tag) && !needsAI;
}

async function main() {
  console.log('── LagZapper Discovery Audit ──');
  const db = getSupabase();

  // ── Part 0: 90 天含 LagZapper 的搜索结果量(backfill 历史)──
  console.log('\n── 0. 搜索侧:含 LagZapper 的 query 历史(backfill_windows)──');
  try {
    const { data: wins, error } = await db.from('backfill_windows')
      .select('query_text,status,videos_found,search_calls')
      .ilike('query_text', '%zapper%');
    if (error) console.log('  (backfill_windows 读取失败:', error.message, ')');
    else if (!wins?.length) console.log('  (无含 zapper 的窗口记录)');
    else {
      const byQ = new Map<string, { found: number; calls: number; n: number }>();
      for (const w of wins) {
        const e = byQ.get(w.query_text) || { found: 0, calls: 0, n: 0 };
        e.found += w.videos_found || 0; e.calls += w.search_calls || 0; e.n++;
        byQ.set(w.query_text, e);
      }
      let tFound = 0, tCalls = 0;
      for (const [q, e] of byQ) {
        console.log(`  ${q.slice(0, 70).padEnd(70)} 窗口×${e.n}  结果+${e.found}  调用${e.calls}`);
        tFound += e.found; tCalls += e.calls;
      }
      console.log(`  → 合计: ${tFound} 条搜索结果, ${tCalls} 次 search 调用`);
    }
  } catch (err) { console.log('  (backfill_windows 表不可用:', (err as Error).message, ')'); }

  // ── 全量加载 ──
  console.log('\n(加载全量数据…)');
  const all = await loadAll();
  console.log(`加载 ${all.length} 条视频。\n`);

  // ── Part 1: LagZapper 信号候选池 + 全漏斗 ──
  const cands: Candidate[] = [];
  for (const v of all) {
    const t = v.title || '', d = v.description || '';
    const sig = {
      brandTitle: lzBrandRe(t),
      brandDesc: lzBrandRe(d) || (d.toLowerCase().includes('lagzapper.com')),
      brandRaw: brandIsLagZapper(v),
      zapperOnly: hasZapperCode(d) || hasZapperCode(t),
    };
    if (sig.brandTitle || sig.brandDesc || sig.brandRaw || sig.zapperOnly) cands.push({ v, sig });
  }
  console.log(`── 1. 候选池全漏斗(全量 ${all.length} 条中命中 LagZapper 信号)──`);
  console.log(`  候选池总量: ${cands.length}`);

  const byPlacement: Record<string, number> = {};
  for (const c of cands) byPlacement[c.v.placement_type || '(null)'] = (byPlacement[c.v.placement_type || '(null)'] || 0) + 1;
  console.log(`  placement_type 分布:`);
  for (const [k, n] of Object.entries(byPlacement).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${n}`);

  const brandPresent = cands.filter(c => brandIsLagZapper(c.v)).length;
  const brandNull = cands.filter(c => !brandIsLagZapper(c.v)).length;
  console.log(`  品牌命中(rule/ai/raw/canonical=LagZapper): ${brandPresent} | 品牌 null: ${brandNull}`);

  const l3 = cands.filter(c => isL3(c.v));
  const l3BrandOnly = cands.filter(c => PLACEMENTS.includes(c.v.placement_type) && brandIsLagZapper(c.v));
  console.log(`  Layer-3(confirmed/likely + 品牌 + AI验证或paid tag): ${l3.length}`);
  console.log(`  confirmed/likely 但品牌缺失/未验证: ${l3BrandOnly.length - l3.length}`);

  const needsAI = cands.filter(c => c.v.classification_raw?.rule?.needsAI && !c.v.classification_raw?.ai).length;
  const unverified = cands.filter(c => PLACEMENTS.includes(c.v.placement_type) && !(c.v.classification_raw?.ai || c.v.has_paid_placement_tag)).length;
  console.log(`  候选内 needsAI(排队未验): ${needsAI} | confirmed/likely 但未验证(rule 层停留): ${unverified}`);

  // 90 天窗口版本
  const c90 = cands.filter(c => new Date(c.v.first_seen_at).getTime() >= NINETY_DAYS);
  const l390 = l3.filter(c => new Date(c.v.first_seen_at).getTime() >= NINETY_DAYS);
  console.log(`  [90 天窗口] 候选 ${c90.length} → Layer-3 ${l390.length}`);

  // ── Part 2: Layer-3 24 条来源分布 + 明细 ──
  console.log(`\n── 2. Layer-3 确认投放来源分布(全量 ${l3.length} 条)──`);
  const byMethod: Record<string, number> = {};
  const byLang: Record<string, number> = {};
  for (const c of l3) {
    const m = c.v.discovery_method || '(null)';
    byMethod[m] = (byMethod[m] || 0) + 1;
    byLang[c.v.language || '(null)'] = (byLang[c.v.language || '(null)'] || 0) + 1;
  }
  console.log(`  discovery_method:`);
  for (const [k, n] of Object.entries(byMethod).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(22)} ${n}`);
  console.log(`  language:`);
  for (const [k, n] of Object.entries(byLang).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(22)} ${n}`);

  console.log('\n  逐条明细:');
  for (const c of l3) {
    const v = c.v;
    const tHas = c.sig.brandTitle ? 'T' : '-';
    const dHas = c.sig.brandDesc ? 'D' : '-';
    const zHas = c.sig.zapperOnly ? 'Z' : '-';
    console.log(`  [${(v.discovery_method || '?').padEnd(14)}][${String(v.language || '?').padEnd(5)}][${String(v.market || '?').padEnd(6)}][T${tHas}D${dHas}Z${zHas}] ${v.video_id} ${(v.channel_name || '').slice(0, 18).padEnd(18)} ${(v.title || '').slice(0, 55)}`);
  }

  // ── Part 3: title 无品牌但 description/link 有信号 ──
  const affLike = cands.filter(c => !c.sig.brandTitle && !c.sig.brandRaw && (c.sig.brandDesc || c.sig.zapperOnly));
  console.log(`\n── 3. title 无品牌、但 description/link 有品牌信号(affiliate 形态,title-search 漏网)──`);
  console.log(`  候选内此类: ${affLike.length}`);
  const affPlace: Record<string, number> = {};
  for (const c of affLike) affPlace[c.v.placement_type || '(null)'] = (affPlace[c.v.placement_type || '(null)'] || 0) + 1;
  for (const [k, n] of Object.entries(affPlace).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${n}`);
  // 其中疑似真投放(confirmed/likely 或 has_paid_placement_tag)
  const affReal = affLike.filter(c => PLACEMENTS.includes(c.v.placement_type) || c.v.has_paid_placement_tag);
  console.log(`  其中 confirmed/likely 或带 paid tag: ${affReal.length}`);
  if (affReal.length) {
    console.log('  样本:');
    for (const c of affReal.slice(0, 15)) {
      const v = c.v;
      const desc = (v.description || '').replace(/\s+/g, ' ').slice(0, 90);
      console.log(`    [${(v.placement_type || '?').padEnd(24)}] ${v.video_id} ${(v.title || '').slice(0, 40)} || ${desc}`);
    }
  }

  // ── Part 4: Creator 分析 ──
  console.log(`\n── 4. Creator 分析 ──`);
  const chanCands = new Map<string, { name: string; n: number; l3: number }>();
  for (const c of cands) {
    const ch = c.v.channel_id;
    const e = chanCands.get(ch) || { name: c.v.channel_name || '', n: 0, l3: 0 };
    e.n++; if (isL3(c.v)) e.l3++;
    chanCands.set(ch, e);
  }
  console.log(`  有 LagZapper 信号视频的频道数: ${chanCands.size}`);
  const chanScan = cands.filter(c => c.v.discovery_method === 'channel_scan');
  console.log(`  其中 channel_scan 发现的候选: ${chanScan.length} 条,来自 ${new Set(chanScan.map(c => c.v.channel_id)).size} 个频道`);

  const { data: watch } = await db.from('youtube_creator_watchlist').select('*').ilike('brand', '%zapper%');
  const watchLz = (watch || []).filter((w: any) => lzBrandRe(w.brand) || w.brand.toLowerCase().includes('zapper'));
  console.log(`\n  Watchlist 中 LagZapper 品牌频道: ${watchLz.length}`);
  for (const w of watchLz) console.log(`    ${w.channel_id} ${(w.channel_name || '').slice(0, 30)} via=${w.discovered_via} status=${w.status}`);

  const watchIds = new Set(watchLz.map((w: any) => w.channel_id));
  const inWatch = [...chanCands.entries()].filter(([id]) => watchIds.has(id));
  const notInWatch = [...chanCands.entries()].filter(([id]) => !watchIds.has(id));
  console.log(`  候选频道已在 Watchlist: ${inWatch.length} | 未进 Watchlist(池未建立): ${notInWatch.length}`);
  console.log('\n  未进 Watchlist 且有信号视频的频道(top 15):');
  for (const [id, e] of notInWatch.sort((a, b) => b[1].l3 - a[1].l3 || b[1].n - a[1].n).slice(0, 15)) {
    console.log(`    ${id} ${e.name.slice(0, 30).padEnd(30)} 候选${e.n} Layer3${e.l3}`);
  }

  // ── Part 5: paid tag 命中(平台级证据,与品牌无关) ──
  const paidTag = all.filter(v => v.has_paid_placement_tag);
  const paidLz = paidTag.filter(v => lzBrandRe((v.title || '') + (v.description || '')));
  console.log(`\n── 5. paid placement tag 平台级证据 ──`);
  console.log(`  全库带 paid tag: ${paidTag.length} | 其中含 LagZapper 文本: ${paidLz.length}`);

  // 汇总结论
  console.log(`\n── 汇总 ──`);
  console.log(`  全库总视频 ${all.length} | LagZapper 信号候选 ${cands.length} | Layer-3 ${l3.length}`);
  console.log(`  [90 天] 候选 ${c90.length} → Layer-3 ${l390.length}`);
  console.log(`  affiliate 形态(title无品牌,desc有信号)${affLike.length} 条,其中疑似真投放 ${affReal.length} 条`);
  console.log(`  品牌频道池: 信号频道 ${chanCands.size}, 已建 Watchlist ${watchLz.length}, 未建 ${notInWatch.length}`);
}

main().catch(err => { console.error('LagZapper audit failed:', err); process.exit(1); });

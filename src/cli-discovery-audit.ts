/**
 * CLI — 覆盖/隐性投放审计（只读）
 *
 * 用已确认的 affiliate 身份（code/cid）反查「品牌文本匹配漏掉」的视频：
 *   ① 信号视频 → (code, cid) 映射（一人一码 → 唯一 creator 数）
 *   ② 反向扫描：全库非信号视频 × 已知 code/cid → 隐性投放候选
 *   ③ cid 序列分析 → 推断 affiliate 网络规模与缺口
 *
 * 由 a3-tmp.ts 重构而来（2026-08-24）。价值：量化品牌文本匹配的漏报，
 * 并验证「已知身份集外是否还有新 cid / 新 code」。
 *
 * Usage: npm run audit:discovery
 */

import { getSupabase } from './db/supabase';
import { extractAffiliateSignals } from './services/competitor-monitor/affiliate-extractor';

const PAGE = 1000;
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];

function hasLzSignal(v: any): boolean {
  const t = (v.title || '').toLowerCase();
  const d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper')
    || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c))
    || d.includes('lagzapper.com');
}

function hasCode(desc: string, codes: Set<string>): string | null {
  // 词边界匹配，且排除 hashtag（前驱非 #）—— nightfv 误报根因：频道标签 #nightfv 被当 code
  const d = (desc || '').toLowerCase();
  for (const c of codes) {
    const pat = new RegExp(`(^|[^a-z0-9#])${c}([^a-z0-9]|$)`);
    if (pat.test(d)) return c;
  }
  return null;
}

async function loadAll(db: any, cols: string[]): Promise<any[]> {
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await db.from('youtube_competitor_videos').select(cols.join(',')).range(from, from + PAGE - 1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  const db = getSupabase();
  const all = await loadAll(db, ['video_id', 'title', 'description', 'channel_id', 'channel_name', 'placement_type', 'workflow_status', 'raw_brand', 'canonical_brand', 'discovery_method']);
  console.log(`全库视频 ${all.length} 条`);

  // 已知 code / cid（身份库）
  const ids = (await db.from('affiliate_identities').select('*').eq('brand', 'LagZapper')).data || [];
  const knownCodes = new Set<string>();
  const knownCids = new Set<string>();
  for (const i of ids) {
    if (i.promo_code) knownCodes.add(String(i.promo_code).toLowerCase());
    if (i.affiliate_cid) knownCids.add(String(i.affiliate_cid).toLowerCase());
  }
  // 身份库快照：用于 §④ 区分「库内已有」vs「信号视频新发现」
  const dbCodes = new Set(knownCodes);
  const dbCids = new Set(knownCids);

  const lz = all.filter(hasLzSignal);

  // ── ① 信号视频 → (code, cid) 映射 ──
  const code2cid = new Map<string, Set<string>>();
  const cid2code = new Map<string, Set<string>>();
  const cid2chan = new Map<string, Set<string>>();
  // 证据表：每 code/cid 聚合 次数/频道/示例视频/描述片段/共现域名（供 §④ 人工判断）
  interface Evidence { count: number; chans: Set<string>; vid: string; desc: string; doms: Set<string>; }
  const evCode = new Map<string, Evidence>();
  const evCid = new Map<string, Evidence>();
  const addEv = (m: Map<string, Evidence>, key: string, v: any, s: any) => {
    const e = m.get(key) || { count: 0, chans: new Set(), vid: v.video_id, desc: '', doms: new Set() };
    e.count++; e.chans.add(v.channel_name || v.channel_id);
    if (!e.desc) e.desc = (v.description || '').replace(/\s+/g, ' ').slice(0, 90);
    for (const d of s.domains) e.doms.add(d);
    m.set(key, e);
  };
  for (const v of lz) {
    const s = extractAffiliateSignals(v.description);
    for (const c of s.promoCodes) {
      const k = c.toLowerCase();
      if (!code2cid.has(k)) code2cid.set(k, new Set());
      s.cids.forEach(x => code2cid.get(k)!.add(x));
      knownCodes.add(k);
      addEv(evCode, k, v, s);
    }
    for (const c of s.cids) {
      const k = c.toLowerCase();
      if (!cid2code.has(k)) cid2code.set(k, new Set());
      s.promoCodes.forEach(x => cid2code.get(k)!.add(x));
      knownCids.add(k);
      if (!cid2chan.has(k)) cid2chan.set(k, new Set());
      cid2chan.get(k)!.add(v.channel_name || v.channel_id);
      addEv(evCid, k, v, s);
    }
  }
  console.log(`信号视频 ${lz.length} | 身份库 ${ids.length} | 已知 code ${knownCodes.size} | 已知 cid ${knownCids.size}`);

  // ── ② 反向扫描：非信号视频 × 已知 code/cid → 隐性投放候选 ──
  console.log(`\n── ② 反向扫描(全库非信号视频 × 已知 code/cid)──`);
  const missed: any[] = [];
  for (const v of all) {
    if (hasLzSignal(v)) continue;
    const codeHit = hasCode(v.description, knownCodes);
    const d = (v.description || '').toLowerCase();
    const cidHit = [...knownCids].find(c => new RegExp(`[?&](?:cid|ref|refid|aff)=${c}(?:[&\\s]|$)`, 'i').test(d));
    if (codeHit || cidHit) missed.push({ ...v, codeHit, cidHit });
  }
  console.log(`隐性投放候选 ${missed.length} 条:`);
  for (const v of missed.slice(0, 40)) {
    const desc = (v.description || '').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  [${v.placement_type || '?'}/${v.workflow_status || '?'}] ${(v.channel_name || '').slice(0, 18).padEnd(18)} ${v.video_id} code=${v.codeHit || '-'} cid=${v.cidHit || '-'} || ${desc}`);
  }

  // ── ③ cid 序列分析 → 网络规模 ──
  console.log(`\n── ③ cid 序列分析 ──`);
  const numeric = [...knownCids].filter(c => /^\d+$/.test(c)).map(Number).sort((a, b) => a - b);
  if (numeric.length) {
    console.log(`数值 cid(${numeric.length}): ${numeric.join(', ')}`);
    console.log(`  min=${numeric[0]} max=${numeric[numeric.length - 1]} 若从1连续 → 网络约 ${numeric[numeric.length - 1]} 个 affiliate 槽位`);
    for (let i = 1; i < numeric.length; i++) {
      if (numeric[i] > numeric[i - 1] + 1) console.log(`  缺口: cid ${numeric[i - 1] + 1}`);
    }
    console.log(`  已知 ${numeric.length} 个 → 缺口(未知 affiliate 槽位)约 ${numeric[numeric.length - 1] - numeric.length} 个(假设从1连续)`);
    for (const c of numeric) {
      const chans = [...(cid2chan.get(String(c)) || [])].slice(0, 2).join('/');
      const codes = [...(cid2code.get(String(c)) || [])].join(',');
      console.log(`   cid ${String(c).padEnd(8)} codes=${codes.padEnd(14)} 频道=${chans}`);
    }
  } else {
    console.log('  无数值 cid');
  }

  // ── ④ 新身份候选(信号视频里有、身份库没有的 code/cid)──
  const newCodes = [...knownCodes].filter(c => !dbCodes.has(c));
  const newCids = [...knownCids].filter(c => !dbCids.has(c));
  console.log(`\n── ④ 新身份候选(信号视频 → 身份库外)──`);
  console.log(`新 code ${newCodes.length} 个 | 新 cid ${newCids.length} 个`);
  // 判断口径（2026-08-26 拍板入库标准）：
  //   lagzapper 域名 + code/cid        → HIGH  （域名归属 + 身份参数）
  //   code 由推广文案前缀提取（必然）   → HIGH  （明确推广文案 + code）
  //   cid 仅出现在非 lagzapper 域名     → MEDIUM（可能属 Lagofast 等，勿入库 LZ）
  //   无域名无推广文案                 → 待确认
  const judge = (doms: Set<string>, kind: 'code' | 'cid'): string => {
    if ([...doms].some(d => d.includes('lagzapper'))) return 'HIGH (lagzapper域名)';
    if (kind === 'code') return 'HIGH (推广文案)';
    if (doms.size > 0) return 'MEDIUM (非LZ域名,可能属Lagofast)';
    return '待确认';
  };
  const printEv = (m: Map<string, Evidence>, kind: 'code' | 'cid', only: string[]) => {
    for (const k of only) {
      const e = m.get(k);
      if (!e) continue;
      console.log(`  ${kind.padEnd(4)} ${k.padEnd(12)} ×${e.count} 域名:[${[...e.doms].join(',') || '-'}] 判断:${judge(e.doms, kind)}`);
      console.log(`        频道:[${[...e.chans].slice(0, 4).join(', ')}]`);
      console.log(`        ${e.vid} || ${e.desc}`);
    }
  };
  if (newCodes.length) { console.log(`\n【新 code 证据 (${newCodes.length})】`); printEv(evCode, 'code', newCodes); }
  if (newCids.length) { console.log(`\n【新 cid 证据 (${newCids.length})】`); printEv(evCid, 'cid', newCids); }
  console.log(`\n→ 仅 HIGH 可批量入库 affiliate_identities（形成 identity → creator → channel_scan 增量）;`);
  console.log(`   MEDIUM/待确认 人工复核后再定；nightfv 等 hashtag 误报已从反向扫描与提取中排除。`);

  // 唯一 code 数量 = 唯一 creator 数（一人一码）
  console.log(`\n已知唯一 code ${knownCodes.size} 个(≈唯一 affiliate creator,一人一码)`);
  console.log(`反向扫描候选按频道:`);
  const byC = new Map<string, number>();
  for (const v of missed) byC.set(v.channel_id, (byC.get(v.channel_id) || 0) + 1);
  for (const [c, n] of [...byC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const name = all.find(v => v.channel_id === c)?.channel_name || c;
    console.log(`   ${name.slice(0, 24).padEnd(24)} ×${n}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * CLI — Search Probe（2026-08-30，LagZapper 低成本 Discovery 探测）
 *
 * 薄、可复用的探测 CLI：跑一组自定义 probe query（**不入 NORMAL_QUERIES**），
 * 评估"每个 Search call 带回来多少独占的新 KOL / 高置信身份"，供人工决定
 * 哪些 query 维度值得进长期 Discovery。
 *
 * 全程只读：不写库 / 不触发 AI / 不 ingest candidate / 不改 watchlist。
 * channel_scan（videos.list / channels.list）不消耗 Search 独立 quota bucket，
 * 本 CLI 只用 search.list（走 quota ledger，category 默认 manual）。
 *
 * 用法：
 *   npm run search:probe -- --brand LagZapper --days 90 --max-pages 1 --category manual --limit 5 --dry-run
 *
 * Quota guard（运行前 + 执行中）：
 *   - 开始前读 ledger：hardExhausted 或 used ≥ (SEARCH_HARD_BUDGET − limit) → 直接退出。
 *   - 每条 query 前仍走 searchVideosPaged 内的 atomic reserve；
 *     任何 reserve 失败（YT_QUOTA_BUDGET_EXHAUSTED / YT_QUOTA_LEDGER_UNAVAILABLE）→ 立即停止。
 *   - 总 search 调用数 ≤ limit（默认 5），超出即停，不试探 YouTube。
 */
import { getSupabase } from './db/supabase';
import { searchVideosPaged } from './services/competitor-monitor/youtube-discovery';
import { getQuotaToday, getSearchUsed, SEARCH_HARD_BUDGET, type SearchQuotaCategory } from './services/competitor-monitor/quota-ledger';
import {
  extractKOLTrackingSignals, guardOwnership, resolveKnownIdentity,
  type IdentityRow, type KOLSignal,
} from './services/competitor-monitor/kol-tracking';
import type { BrandQuery } from './services/competitor-monitor/brand-config';
import { VIDEO_DEDUP_COLUMN, buildExistingSet } from './services/competitor-monitor/probe-dedup';

/** 本次 probe 的 query 配置（临时传入，不写 NORMAL_QUERIES）。P1 是核心。 */
const PROBE_QUERIES: BrandQuery[] = [
  // P1 Global domain —— 全语言 description-only 域名命中（TH/TR/ID/VI/zh… 可能被 en/ru/pt 过滤漏掉）
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', global: true },
  // P2 TH domain —— 泰区（NutsuruSama 已知泰语创作者）
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'th', targetMarket: 'TH' },
  // P3 TR domain —— 土区（Joker Türk 已知土语创作者）
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'tr', targetMarket: 'TR' },
  // P4 Global brand —— 全语言品牌词（标题/描述带 LagZapper 名但无域名）
  { brandName: 'LagZapper', queryText: 'lagzapper', queryType: 'branded', global: true },
];

const QUERY_LABEL: Record<string, string> = {
  'lagzapper.com|global': 'P1 Global domain',
  'lagzapper.com|TH': 'P2 TH domain',
  'lagzapper.com|TR': 'P3 TR domain',
  'lagzapper|global': 'P4 Global brand',
};
const labelOf = (q: BrandQuery): string =>
  QUERY_LABEL[`${q.queryText}|${q.global ? 'global' : (q.targetMarket || '')}`] || `${q.queryText}[${q.targetMarket || 'global'}]`;

interface ProbeRow {
  i: number;
  label: string;
  returned: number;
  calls: number;
  err?: string;
  /** DB 中不存在的新视频 id（本 query 返回的） */
  newVids: string[];
}

interface VideoMeta {
  videoId: string;
  channelId: string;
  channelTitle: string;
  description: string;
  qIdx: Set<number>;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const brand = flag('--brand');
  const days = parseInt(flag('--days') || '90', 10);
  const maxPages = Math.max(1, parseInt(flag('--max-pages') || '1', 10));
  const category = (flag('--category') || 'manual') as SearchQuotaCategory;
  const limit = Math.max(1, parseInt(flag('--limit') || '5', 10));
  const dryRun = args.includes('--dry-run');

  let queries = PROBE_QUERIES;
  if (brand) {
    const filtered = queries.filter(q => q.brandName === brand);
    if (!filtered.length) { console.error(`--brand 过滤后 0 条 probe query（可用: ${[...new Set(queries.map(q => q.brandName))].join(', ')}）`); process.exit(1); }
    queries = filtered;
  }

  // ── 运行前 quota guard（权威值来自 ledger RPC，非进程缓存）──
  const q0 = await getQuotaToday();
  console.log(`═══ Search Probe（dry-run=${dryRun}，全程只读，不写库）═══`);
  console.log(`brand=${brand || 'all'} · days=${days} · maxPages=${maxPages} · category=${category} · limit=${limit} calls`);
  if (!q0.ledgerReady) { console.error(`✗ ledger 不可用（${q0.error || 'RPC 失败'}）→ fail-closed 退出`); process.exit(1); }
  if (q0.hardExhausted) { console.error(`✗ 当前 PT 期已 hard_exhausted → 退出（不试探 YouTube）`); process.exit(1); }
  const guardThreshold = SEARCH_HARD_BUDGET - limit;
  if (q0.used >= guardThreshold) {
    console.error(`✗ 当前 used=${q0.used} ≥ ${guardThreshold}（HARD_BUDGET − limit）→ 退出`); process.exit(1);
  }
  console.log(`[quota guard] used=${q0.used}/${SEARCH_HARD_BUDGET} hardExhausted=false → 通过（阈值 ${guardThreshold}，最多再消耗 ${limit}）`);

  const db = getSupabase();
  const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();

  // ── 跑全部 probe query（上限 limit 次调用）──
  const rows: ProbeRow[] = [];
  const allById = new Map<string, VideoMeta>();
  let callsUsed = 0;
  let stoppedBy = '';

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (callsUsed >= limit) { stoppedBy = `达到 limit(${limit})`; break; }
    if (getSearchUsed() >= SEARCH_HARD_BUDGET) { stoppedBy = '达到硬门'; break; }
    const row: ProbeRow = { i, label: labelOf(q), returned: 0, calls: 0, newVids: [] };
    try {
      const res = await searchVideosPaged(q, publishedAfter, undefined, maxPages, 50, category);
      row.returned = res.videos.length;
      row.calls = res.pagesUsed;
      callsUsed += res.pagesUsed;
      for (const v of res.videos) {
        const hit = allById.get(v.videoId);
        if (hit) { hit.qIdx.add(i); }
        else {
          allById.set(v.videoId, {
            videoId: v.videoId, channelId: v.channelId, channelTitle: v.channelTitle,
            description: v.description || '', qIdx: new Set([i]),
          });
        }
      }
      console.log(`  ${row.label.padEnd(18)} → ${row.returned} videos / ${row.calls} call(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('YT_QUOTA')) { row.err = msg.slice(0, 120); stoppedBy = `reserve 失败: ${msg.slice(0, 80)}`; }
      else row.err = msg.slice(0, 120);
      rows.push(row);
      break;
    }
    rows.push(row);
  }
  if (callsUsed >= limit && !stoppedBy) stoppedBy = `达到 limit(${limit})`;
  console.log(`\n[probe] 总调用 ${callsUsed} call(s) · ${rows.length}/${queries.length} query 执行${stoppedBy ? ` · 停止原因: ${stoppedBy}` : ''}`);
  if (!callsUsed) { console.error('✗ 0 search call 消耗，无数据。'); process.exit(2); }

  // ── DB 去重：只保留 DB 中不存在的"新视频" ──
  const ids = [...allById.keys()];
  // 去重唯一键锁定 video_id（防 id vs video_id 假 DB-new，见 probe-dedup.ts 回归）。
  const existing = new Set<string>();
  for (let from = 0; from < ids.length; from += 900) {
    const chunk = ids.slice(from, from + 900);
    const { data, error } = await db.from('youtube_competitor_videos').select(VIDEO_DEDUP_COLUMN).in(VIDEO_DEDUP_COLUMN, chunk);
    if (error) throw new Error(`去重查询失败: ${error.message}`);
    for (const id of buildExistingSet(data || [])) existing.add(id);
  }
  const newIds = new Set(ids.filter(id => !existing.has(id)));
  console.log(`[dedup] ${ids.length} returned → ${newIds.size} DB-new（${ids.length - newIds.size} 已在库）`);
  for (const r of rows) r.newVids = ids.filter(id => newIds.has(id) && allById.get(id)!.qIdx.has(r.i));

  // ── matcher（仅 DB-new 视频，复用已验证 kol-tracking 逻辑）──
  const { data: ai, error: ae } = await db.from('affiliate_identities')
    .select('brand, channel_id, channel_name, promo_code, affiliate_cid, ref_id, domain, signal_type, confidence')
    .eq('brand', brand || 'LagZapper');
  if (ae) { console.error('✗ identities 查询失败:', ae.message); process.exit(1); }
  const registry: IdentityRow[] = ai || [];

  const chan = new Map<string, { chName: string; cids: Set<string>; codes: Set<string>; refs: Set<string>; utms: Set<string>; n: number; qIdx: Set<number> }>();
  for (const id of newIds) {
    const v = allById.get(id)!;
    const acc = chan.get(v.channelId) || { chName: v.channelTitle || '', cids: new Set(), codes: new Set(), refs: new Set(), utms: new Set(), n: 0, qIdx: new Set<number>() };
    acc.n++;
    v.qIdx.forEach(qi => acc.qIdx.add(qi));
    for (const s of extractKOLTrackingSignals(v.description)) {
      if (s.form === 'cid') acc.cids.add(s.value);
      else if (s.form === 'promo_code') acc.codes.add(s.value);
      else if (s.form === 'ref') acc.refs.add(s.value);
      else acc.utms.add(s.value);
    }
    chan.set(v.channelId, acc);
  }

  const knownHits: Array<{ ch: string; name: string; via: string }> = [];
  const sharedSkips: Array<{ ch: string; signal: string; owner: string }> = [];
  const highNew: Array<{ ch: string; name: string; signals: KOLSignal[] }> = [];
  const medNew: Array<{ ch: string; name: string; signals: KOLSignal[] }> = [];

  for (const [ch, acc] of chan) {
    const cids = [...acc.cids], codes = [...acc.codes], refs = [...acc.refs], utms = [...acc.utms];
    const known = resolveKnownIdentity(ch, cids, codes, utms, registry);
    if (known && known.identity.channel_id === ch) {
      knownHits.push({ ch, name: known.identity.channel_name || ch, via: known.via });
    } else {
      const { mergeable, sharedForeign } = guardOwnership(ch, [
        ...cids.map(v => ({ form: 'cid' as const, value: v })),
        ...codes.map(v => ({ form: 'promo_code' as const, value: v })),
        ...refs.map(v => ({ form: 'ref' as const, value: v })),
        ...utms.map(v => ({ form: 'utm_campaign' as const, value: v })),
      ], registry);
      for (const s of sharedForeign) sharedSkips.push({ ch, signal: `${s.form}=${s.value}`, owner: s.ownerName || s.ownerChannel });
      const clean = mergeable.filter(s => !(s.form === 'promo_code' && /^(game|00|ted)$/i.test(s.value)));
      if (clean.length) {
        const isHigh = clean.some(s => s.form === 'cid' || s.form === 'ref' || s.form === 'promo_code');
        (isHigh ? highNew : medNew).push({ ch, name: acc.chName, signals: clean });
      }
    }
  }

  // ── 每 query 计数 + 独占增量（该 query 独有的新视频/creator/HIGH 身份）──
  const perQuery = rows.map(r => {
    const vids = r.newVids;
    const creators = new Set(vids.map(id => allById.get(id)!.channelId));
    const onlyHere = vids.filter(id => allById.get(id)!.qIdx.size === 1);
    const onlyCreators = new Set(onlyHere.map(id => allById.get(id)!.channelId));
    const onlyHigh = highNew.filter(c => onlyCreators.has(c.ch)).length;
    return {
      known: knownHits.filter(k => creators.has(k.ch)).length,
      shared: sharedSkips.filter(s => creators.has(s.ch)).length,
      high: highNew.filter(c => creators.has(c.ch)).length,
      excl: { vids: onlyHere.length, creators: onlyCreators.size, high: onlyHigh },
    };
  });

  console.log(`\n[matcher] 新视频身份分析（仅 DB-new）`);
  console.log(`  known hits: ${knownHits.length}${knownHits.length ? ' · ' + knownHits.map(h => h.name).join(', ') : ''}`);
  console.log(`  HIGH new identity candidates: ${highNew.length}`);
  for (const c of highNew) console.log(`    [${c.name || c.ch}] ${c.signals.map(s => `${s.form}=${s.value}`).join(' · ')}`);
  if (medNew.length) console.log(`  MEDIUM(utm-only) candidates: ${medNew.length} · ${medNew.map(c => c.name || c.ch).join(', ')}`);
  console.log(`  shared-link skips: ${sharedSkips.length}${sharedSkips.length ? ' · ' + sharedSkips.map(s => `${s.signal}→${s.owner}`).join(', ') : ''}`);

  // ── 汇总表 ──
  const col = (s: string | number, w: number) => String(s).padEnd(w);
  const h = `${col('Query', 18)}${col('Ret', 5)}${col('DB-new', 7)}${col('Creators', 9)}${col('Known', 6)}${col('HIGH', 5)}${col('Shared', 7)}${col('Excl(v/c/H)', 13)}${col('Calls', 6)}`;
  console.log(`\n${h}\n${'-'.repeat(h.length)}`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = perQuery[i];
    console.log(`${col(r.label, 18)}${col(r.returned, 5)}${col(r.newVids.length, 7)}${col(new Set(r.newVids.map(id => allById.get(id)!.channelId)).size, 9)}${col(p.known, 6)}${col(p.high, 5)}${col(p.shared, 7)}${col(`${p.excl.vids}/${p.excl.creators}/${p.excl.high}`, 13)}${col(r.err ? `✗${r.err.slice(0, 14)}` : r.calls, 6)}`);
  }
  console.log(`\nExcl(v/c/H) = 仅被该 query 找到（其它 3 个都没找到）的 新视频/新Creator/HIGH新身份`);
  console.log(`════ 结束（只读，0 写操作，${callsUsed} search calls consumed）════`);
}

main().catch((e) => { console.error('probe 异常:', e); process.exit(2); });

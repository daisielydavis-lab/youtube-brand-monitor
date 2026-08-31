/**
 * Lagofast Discovery 漏斗对账（2026-08-29，completion-gated）
 *
 * 触发条件（completion gate）——用户指定，不用固定日期：
 *   56 个 Lagofast backfill 窗口全部离开 pending/running，且无未处理
 *   failed/quota_paused（partial 也是未收完，一并计入门槛）。
 *   门槛未满足 → 只输出窗口状态并退出（exit 2），绝不产出"看似完整实则没收完"的漏斗。
 *
 * 漏斗（用户指定全链路）：
 *   candidates → enriched → rule classified → AI reviewed
 *   → confirmed/likely → unique creators → watchlist additions
 * 另输出 title-signal / description-only 两组转化率，以及验收加项：
 *   - Discovery source contribution（global_brand_search / domain_search / channel_scan …）
 *   - 90 天 Lagofast 最终 unique placements + unique creators
 *
 * 运行： railway run -- npx ts-node src/audit-lagofast-funnel.ts
 *       railway run -- npx ts-node src/audit-lagofast-funnel.ts --gate   # 只查门槛，不拉全量
 */
import { getSupabase } from './db/supabase';

const LAGOFAST_QUERIES = ['LagoFast', '"Lago Fast"', 'lagofast.com', 'lago-fast.com'];
const PLACEMENTS = ['confirmed_paid_placement', 'likely_sponsored'];
// Lagofast 典型隐性投放形态 = 标题无品牌 + 描述带域名/cid/code。标题含信号 → title-signal。
const TITLE_SIGNALS = ['lagofast', 'lago-fast', 'lagofast.com', 'lago-fast.com', 'lago fast', 'lago_fast'];
const hasTitleSignal = (t: string): boolean => {
  const s = (t || '').toLowerCase();
  return TITLE_SIGNALS.some(x => s.includes(x));
};
const isLagofast = (v: any): boolean => v?.canonical_brand === 'Lagofast';

// ── Completion gate 纯函数（2026-08-31：动态 rolling 90d 有效窗口集）──
// 有效窗口集 = 每个 Lagofast query × 当前 winStarts（周一 UTC 锚定、步进 7 天、< now），
// 与 monitor 的 backfill 窗口生成逻辑保持一致（competitor-monitor/index.ts winStarts）。
// 滑出 90d 的历史孤儿窗口（如 2026-05-25 那 4 个 pending）保留为历史状态、不参与 gate；
// 有效集内缺失的表行按 pending 计（阻塞 gate）。expected 随日期动态推导，无硬编码 56。
// 注意：window_from 比较统一用 `YYYY-MM-DD` 前缀（DB 返回 `+00:00`、winStarts 为 `.toISOString()`
// 的 `.000Z`，全串不可比——这本身是 RESUME_CURSOR_BUG 的格式错配，见设计文档）。
const WINDOW_MS = 7 * 86400000;
const BACKFILL_DAYS = 90;
const weekStartOf = (ms: number): number => {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
};
export function currentWinStarts(nowMs: number): string[] {
  const out: string[] = [];
  for (let s = weekStartOf(nowMs - BACKFILL_DAYS * 86400000); s < nowMs; s += WINDOW_MS) {
    out.push(new Date(s).toISOString());
  }
  return out;
}
export interface GateWindowRow { query_text: string; window_from: string; status: string }
export interface GateResult {
  expected: number;
  validTotal: number;
  byStatus: Record<string, number>;
  unmet: string[];
  gateOpen: boolean;
  orphanCount: number;
  missingCount: number;
  winStarts: string[];
}
export function computeGate(rows: GateWindowRow[], nowMs: number): GateResult {
  const winStarts = currentWinStarts(nowMs);
  const byKey = new Map<string, string>(); // `${query}|${YYYY-MM-DD}` → status
  for (const w of rows) byKey.set(`${w.query_text}|${w.window_from.slice(0, 10)}`, w.status);
  const validDates = new Set(winStarts.map(f => f.slice(0, 10)));
  const orphanCount = rows.filter(w => !validDates.has(w.window_from.slice(0, 10))).length;

  const byStatus: Record<string, number> = {};
  let missingCount = 0;
  for (const q of LAGOFAST_QUERIES) {
    for (const from of winStarts) {
      const st = byKey.get(`${q}|${from.slice(0, 10)}`);
      if (!st) missingCount++;
      const s = st || 'pending';
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
  }
  const expected = LAGOFAST_QUERIES.length * winStarts.length;
  const unmet = ['pending', 'running', 'failed', 'quota_paused', 'partial'].filter(s => (byStatus[s] || 0) > 0);
  return { expected, validTotal: expected, byStatus, unmet, gateOpen: expected > 0 && unmet.length === 0, orphanCount, missingCount, winStarts };
}

async function fetchAll(base: any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await base.range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const db = getSupabase();
  const gateOnly = process.argv.includes('--gate');

  // ── Step 1: completion gate ──
  // 注意:含引号的 query_text（"Lago Fast"）会被 PostgREST in() 解析错（少 1 条 query → 14 窗口）
  // → 全量拉取 + JS 精确过滤（表小，免疫引号问题）。
  // gate 只对「当前 rolling 90d 有效窗口集」判定（用户 2026-08-31 决策：孤儿窗口保留历史、不参与 gate；
  // 有效集内缺行按 pending 计；expected 动态推导）。
  const LAGOFAST_SET = new Set(LAGOFAST_QUERIES);
  const { data: allWins, error: winErr } = await db.from('backfill_windows')
    .select('query_text, window_from, status');
  if (winErr) { console.error('gate 查询失败:', winErr.message); process.exit(1); }
  const wins = (allWins || []).filter((w: any) => LAGOFAST_SET.has(w.query_text));
  const gate = computeGate(wins, Date.now());

  console.log('== Gate: Lagofast backfill windows（动态 rolling 90d）==');
  console.log(`  有效窗口=${gate.validTotal}（期望 ${gate.expected} = ${gate.winStarts.length} 周 × ${LAGOFAST_QUERIES.length} query）`);
  if (gate.orphanCount) console.log(`  [信息] 跳过 ${gate.orphanCount} 个滑出 90d 的历史孤儿窗口（保留数据，不参与 gate）`);
  if (gate.missingCount) console.warn(`  [注意] 有效集内缺表行 ${gate.missingCount} 个（按 pending 计，阻塞 gate）`);
  console.log(`  completed=${gate.byStatus.completed||0} pending=${gate.byStatus.pending||0} running=${gate.byStatus.running||0} failed=${gate.byStatus.failed||0} quota_paused=${gate.byStatus['quota_paused']||0} partial=${gate.byStatus.partial||0}`);
  if (gateOnly) {
    console.log(gate.gateOpen ? 'GATE_MET' : `GATE_NOT_MET（剩余未完成: ${gate.unmet.join(', ')}）`);
    process.exit(gate.gateOpen ? 0 : 2);
  }
  if (!gate.gateOpen) {
    console.log(`\n❌ GATE NOT MET（${gate.unmet.join(', ') || '无有效窗口'}）—— 不产出漏斗，等 backfill 收完再跑。`);
    process.exit(2);
  }
  console.log('  ✅ Gate met —— 全部有效窗口已收完，开始漏斗对账。\n');

  // 4 条 Lagofast query 的 id（discovery_query_id 精确归属，避免与 LagZapper domain_search 混淆）。
  // 同引号问题:全量拉 + JS 过滤。
  const { data: allQ } = await db.from('competitor_queries').select('id, query_text');
  const queryIds: string[] = (allQ || []).filter((r: any) => LAGOFAST_SET.has(r.query_text)).map((r: any) => r.id);

  // ── Step 2: candidate pool ──
  let candidates: any[] = [];
  if (queryIds.length) {
    candidates = await fetchAll(db.from('youtube_competitor_videos').select('*').in('discovery_query_id', queryIds));
  }
  if (!candidates.length) {
    // 回退：global_brand_search 最早 first_seen 为锚，domain_search/global_brand_search + 锚后
    const { data: anchorR } = await db.from('youtube_competitor_videos')
      .select('first_seen_at').eq('discovery_method', 'global_brand_search').order('first_seen_at', { ascending: true }).limit(1);
    const anchor = anchorR?.[0]?.first_seen_at || new Date(Date.now() - 14 * 86400000).toISOString();
    candidates = await fetchAll(db.from('youtube_competitor_videos')
      .select('*').in('discovery_method', ['global_brand_search', 'domain_search']).gte('first_seen_at', anchor));
    if (candidates.length) console.warn('  [注意] discovery_query_id 未落库，用 first_seen 锚点代理（可能混入少量非 Lagofast domain_search）\n');
  }
  console.log(`  候选池: ${candidates.length} 条（probe 预估 726，实际以 backfill 落库为准）`);

  // ── Step 3: 漏斗各阶段 ──
  const enriched = candidates.filter(v => v.title && v.description && v.published_at);
  const ruleClassified = candidates.filter(v => v.classification_raw?.rule);
  const aiReviewed = candidates.filter(v => v.classification_raw?.ai);
  const awaitingAI = candidates.filter(v => v.classification_raw?.rule?.needsAI && !v.classification_raw?.ai);
  const confirmed = candidates.filter(v => PLACEMENTS.includes(v.placement_type) && isLagofast(v));
  const confirmedCreators = new Set(confirmed.map(v => v.channel_id));

  // title-signal vs description-only（candidates 与 confirmed 两组，算转化率）
  const candTitle = candidates.filter(v => hasTitleSignal(v.title));
  const candDesc = candidates.filter(v => !hasTitleSignal(v.title));
  const confTitle = confirmed.filter(v => hasTitleSignal(v.title));
  const confDesc = confirmed.filter(v => !hasTitleSignal(v.title));
  const rate = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—');

  // watchlist additions：confirmed creator 中已在 Lagofast watchlist 的
  const watch = await fetchAll(db.from('youtube_creator_watchlist').select('channel_id').eq('brand', 'Lagofast').eq('status', 'active'));
  const watchIds = new Set(watch.map((w: any) => w.channel_id));
  const watchAdditions = [...confirmedCreators].filter(id => watchIds.has(id)).length;

  console.log('\n== 漏斗（726 链路）==');
  const rows: Array<[string, number, string]> = [
    ['candidates（backfill 入库）', candidates.length, ''],
    ['enriched（title/desc/published 齐全）', enriched.length, rate(enriched.length, candidates.length)],
    ['rule classified（规则层判定）', ruleClassified.length, rate(ruleClassified.length, candidates.length)],
    ['AI reviewed（AI 复核过）', aiReviewed.length, rate(aiReviewed.length, candidates.length)],
    ['awaiting AI（needsAI 未复核）', awaitingAI.length, rate(awaitingAI.length, candidates.length)],
    ['confirmed/likely（Layer3）', confirmed.length, rate(confirmed.length, candidates.length)],
    ['unique creators（confirmed）', confirmedCreators.size, ''],
    ['watchlist additions', watchAdditions, ''],
  ];
  const w1 = Math.max(...rows.map(r => r[0].length)) + 2;
  for (const [label, n, pct] of rows) {
    console.log(`  ${label.padEnd(w1)} ${String(n).padStart(5)}${pct ? `   ${pct}` : ''}`);
  }

  console.log('\n== title-signal vs description-only 转化 ==');
  console.log(`  title-signal:      candidates=${candTitle.length} → confirmed/likely=${confTitle.length}（${rate(confTitle.length, candTitle.length)}）`);
  console.log(`  description-only:  candidates=${candDesc.length} → confirmed/likely=${confDesc.length}（${rate(confDesc.length, candDesc.length)}）`);

  // ── Step 4: 90 天最终量 + Discovery source contribution（验收加项）──
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const all90 = await fetchAll(db.from('youtube_competitor_videos')
    .select('*').eq('canonical_brand', 'Lagofast').in('placement_type', PLACEMENTS).gte('published_at', since));
  const sourceBuckets: Record<string, number> = { global_brand_search: 0, domain_search: 0, channel_scan: 0, keyword_search: 0, other: 0 };
  for (const v of all90) {
    const m = v.discovery_method;
    if (sourceBuckets[m] !== undefined) sourceBuckets[m]++; else sourceBuckets.other++;
  }
  const uniqueCreators90 = new Set(all90.map(v => v.channel_id)).size;
  const conf90Title = all90.filter(v => hasTitleSignal(v.title)).length;
  const conf90Desc = all90.filter(v => !hasTitleSignal(v.title)).length;

  // ── Step 5: 二次补量链（用户验收:Search/Domain → confirmed → watchlist → channel_scan 补回）──
  // Creator Network 闭环:backfill 发现 → rule/AI 确认 → ai_confirmed 自动进 watchlist
  // → 下次扫描 Phase2 scanWatchlistUploads 补回 uploads → 额外 placement（discovery_method=channel_scan）。
  const searchDomainConfirmed = confirmed.filter(v => ['global_brand_search', 'domain_search', 'keyword_search'].includes(v.discovery_method)).length;
  const chanScanConfirmed = all90.filter(v => v.discovery_method === 'channel_scan').length;
  const chanScanFromWatchlist = all90.filter(v => v.discovery_method === 'channel_scan' && watchIds.has(v.channel_id)).length;
  console.log('\n== 二次补量链（Creator Network 闭环）==');
  console.log(`  Search/Domain 回填新增 confirmed: ${searchDomainConfirmed}`);
  console.log(`  confirmed unique creators:        ${confirmedCreators.size}`);
  console.log(`  watchlist additions:              ${watchAdditions}`);
  console.log(`  channel_scan 二次补回（90d 总）:     ${chanScanConfirmed}（其中来自 watchlist creator: ${chanScanFromWatchlist}）`);

  console.log('\n== 90 天 Lagofast 最终量（验收加项）==');
  console.log(`  unique placements: ${all90.length}（原 11 → 现 ${all90.length}）`);
  console.log(`  unique creators:   ${uniqueCreators90}`);
  console.log(`  其中 title-signal: ${conf90Title} / description-only: ${conf90Desc}`);
  console.log('\n== Discovery source contribution ==');
  for (const [k, n] of Object.entries(sourceBuckets)) {
    if (n > 0) console.log(`  ${k.padEnd(22)} ${String(n).padStart(5)}   ${rate(n, all90.length)}`);
  }
  if (!all90.length) console.log('  （90 天内无 confirmed/likely）');

  process.exit(0);
}

// 作为脚本直接运行时执行主流程；被 regression-lagofast 等 import 时只暴露纯函数
// （computeGate / currentWinStarts），不触发 DB 查询。
if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

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
  const LAGOFAST_SET = new Set(LAGOFAST_QUERIES);
  const { data: allWins, error: winErr } = await db.from('backfill_windows')
    .select('query_text, status');
  if (winErr) { console.error('gate 查询失败:', winErr.message); process.exit(1); }
  const wins = (allWins || []).filter((w: any) => LAGOFAST_SET.has(w.query_text));
  if (wins.length !== 56) console.warn(`  [注意] 期望 56 窗口,实际 ${wins.length}——检查 backfill_windows 是否缺行`);
  const byStatus: Record<string, number> = {};
  for (const w of wins) byStatus[w.status] = (byStatus[w.status] || 0) + 1;
  const total = (wins || []).length;
  const unmet = ['pending', 'running', 'failed', 'quota_paused', 'partial'].filter(s => (byStatus[s] || 0) > 0);
  const gateOpen = total > 0 && unmet.length === 0;

  console.log('== Gate: Lagofast backfill windows ==');
  console.log(`  total=${total} completed=${byStatus.completed||0} pending=${byStatus.pending||0} running=${byStatus.running||0} failed=${byStatus.failed||0} quota_paused=${byStatus['quota_paused']||0} partial=${byStatus.partial||0}`);
  if (gateOnly) {
    console.log(gateOpen ? 'GATE_MET' : `GATE_NOT_MET（剩余未完成: ${unmet.join(', ')}）`);
    process.exit(gateOpen ? 0 : 2);
  }
  if (!gateOpen) {
    console.log(`\n❌ GATE NOT MET（${unmet.join(', ') || '无窗口'}）—— 不产出漏斗，等 backfill 收完再跑。`);
    process.exit(2);
  }
  console.log('  ✅ Gate met —— 全部窗口已收完，开始漏斗对账。\n');

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

main().catch(err => { console.error(err); process.exit(1); });

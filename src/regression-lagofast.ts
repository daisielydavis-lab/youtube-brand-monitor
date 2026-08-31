/**
 * Lagofast 归属回归测试(2026-08-29)
 *
 * 背景:第 4 品牌 Lagofast 曾漏进 AI prompt 枚举,导致纯 Lagofast 视频 brand=null、
 * 混合品牌被强制归给他牌。修复后 allowed brands 由 COMPETITOR_BRANDS 统一生成。
 *
 * 覆盖:
 *  1. 纯 Lagofast(lagofast.com + cid + promo)→ Lagofast
 *  2. lago-fast.com(hyphen 形式)→ Lagofast
 *  3. 纯 LagZapper → 不被 Lagofast 抢归因
 *  4. 多品牌 GearUP+Lagofast → 单品牌模式不强制改历史(rule 首命中),留 multi-brand
 *  5. 无品牌 → null
 *  6. AI prompt 枚举由统一配置生成、含全部品牌
 *
 * 运行: npm run test:lagofast (ts-node src/regression-lagofast.ts)
 */
import assert from 'assert';
import { classifyVideo } from './services/competitor-monitor/rule-classifier';
import { buildClassificationPrompt, type ClassificationPromptItem, canonicalWindowTs, buildBackfillTodo, type BackfillWindowRow } from './services/competitor-monitor/index';
import { buildSearchParams } from './services/competitor-monitor/youtube-discovery';
import { getActiveQueries, type BrandQuery } from './services/competitor-monitor/brand-config';
import { COMPETITOR_BRANDS } from './services/competitor-monitor/data-scope';
import { computeGate, currentWinStarts, type GateWindowRow } from './audit-lagofast-funnel';

type Input = Parameters<typeof classifyVideo>[0];
const v = (o: Partial<Input> = {}): ReturnType<typeof classifyVideo> => classifyVideo({
  videoId: 'test', title: '', description: '', tags: [], channelName: 'SomeGamer',
  isShort: false, viewCount: 100, publishedAt: '2026-08-01T00:00:00Z', hasPaidPlacementTag: false, ...o,
});

let passed = 0;
const failed: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e: any) { failed.push(name); console.error('  ✗', name, '—', e.message); }
}
function expectEqual(actual: unknown, expected: unknown, label: string) {
  assert.strictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

console.log('== 规则层品牌归属 ==');
check('纯 Lagofast: lagofast.com + cid + promo code → Lagofast / likely', () => {
  const r = v({ title: 'Best game booster', description: 'Use my link https://www.lagofast.com/?cid=891171 — code LAGOFAST10 for 10% off' });
  expectEqual(r.brand, 'Lagofast', 'brand');
  expectEqual(r.placementType, 'likely_sponsored', 'placement');
});
check('lago-fast.com(hyphen 形式)→ Lagofast', () => {
  const r = v({ title: 'Reduce ping in PUBG', description: 'Download https://www.lago-fast.com/?cid=964' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});

console.log('== hostname 规范化(www./protocol/path/query 不影响识别)==');
check('www.lagofast.com/?cid → Lagofast', () => {
  const r = v({ title: 'Play in Russian', description: 'Use https://www.lagofast.com/?cid=891171 code LAGOFAST10' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});
check('https://lago-fast.com/path?q=y → Lagofast', () => {
  const r = v({ title: 'Reduce ping', description: 'Download https://lago-fast.com/path?q=y' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});
check('www.lago-fast.com(无协议)→ Lagofast', () => {
  const r = v({ title: 'Reduce ping', description: 'Visit www.lago-fast.com' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});
check('lagofast.com/path?query → Lagofast', () => {
  const r = v({ title: 'Reduce ping', description: 'link: lagofast.com/path?query=1' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});
check('lagofastbooster.ru → Lagofast', () => {
  const r = v({ title: 'Reduce ping', description: 'lagofastbooster.ru promo' });
  expectEqual(r.brand, 'Lagofast', 'brand');
});
check('typosquat my-lago-fast.xyz 误报被限:不判投放,留 AI 兜底', () => {
  // bare 'lago-fast' 子串会命中关键词,但无真实域名/promo → 只能 organic_mention + needsAI,绝不进 Layer3
  const r = v({ title: 'check out', description: 'visit my-lago-fast.xyz for settings' });
  expectEqual(r.brand, 'Lagofast', 'brand(子串命中,可接受)');
  assert.ok(r.placementType !== 'likely_sponsored' && r.placementType !== 'confirmed_paid_placement',
    `typosquat 不得判投放,实际=${r.placementType}`);
  assert.strictEqual(r.needsAI, true, 'typosquat 应留 AI 复核');
});
check('纯 LagZapper 不被 Lagofast 抢归因', () => {
  const r = v({ title: 'LagZapper review', description: 'https://www.lagzapper.com/refer/123 code ZAP10' });
  expectEqual(r.brand, 'LagZapper', 'brand');
});
check('多品牌 GearUP+Lagofast → 单品牌模式 rule 首命中归 GearUP(留 multi-brand)', () => {
  const r = v({ title: 'COD MW4', description: 'GearUP: https://www.gearupbooster.com code A — LagoFast: https://www.lagofast.com/zh-tw/?cid=616 code B' });
  expectEqual(r.brand, 'GearUP', 'brand(首命中)');
});
check('无品牌 → null', () => {
  const r = v({ title: 'My favorite games', description: 'just some gaming video' });
  expectEqual(r.brand, null, 'brand');
});

console.log('== AI prompt 枚举(统一配置生成)==');
check('COMPETITOR_BRANDS 含 Lagofast', () => {
  expectEqual(COMPETITOR_BRANDS.includes('Lagofast'), true, 'includes Lagofast');
});
check('buildClassificationPrompt 枚举含全部品牌 + Lagofast', () => {
  const item: ClassificationPromptItem = {
    videoId: 'x', title: 'LagoFast test', descSnippet: '', description: '',
    channelName: 'c', channelId: 'cid', publishedAt: '', hasPaidTag: false, matchedBrand: 'Lagofast',
  };
  const p = buildClassificationPrompt([item]);
  for (const b of COMPETITOR_BRANDS) {
    assert.ok(p.includes(`"${b}"`), `prompt 品牌枚举缺 ${b}`);
  }
  assert.ok(p.includes('LagoFast'), 'prompt 缺 LagoFast 示例');
  assert.ok(p.includes('matchedBrand'), 'prompt 缺 matchedBrand 规则提示');
});

console.log('== 全局 query(Discovery 专项)==');
const makeQ = (o: Partial<{ brandName: string; queryText: string; queryType: string; targetLanguage: string; targetMarket: string; global: boolean }>) => ({
  brandName: o.brandName || 'Lagofast', queryText: o.queryText || 'LagoFast',
  queryType: o.queryType as any || 'branded', targetLanguage: o.targetLanguage, targetMarket: o.targetMarket, global: o.global,
});
check('全局 query 不带 regionCode/relevanceLanguage', () => {
  const params = buildSearchParams(makeQ({ global: true }), '2026-06-01T00:00:00Z', undefined, 50, '', 'KEY');
  expectEqual(params.regionCode, undefined, 'regionCode 应为空');
  expectEqual(params.relevanceLanguage, undefined, 'relevanceLanguage 应为空');
  expectEqual(params.q, 'LagoFast', 'q');
});
check('非全局 query 保留 regionCode/relevanceLanguage', () => {
  const params = buildSearchParams(makeQ({ targetLanguage: 'ru', targetMarket: 'RU' }), '2026-06-01T00:00:00Z', undefined, 50, '', 'KEY');
  expectEqual(params.regionCode, 'RU', 'regionCode');
  expectEqual(params.relevanceLanguage, 'ru', 'relevanceLanguage');
});
check('NORMAL_QUERIES 含 4 条 Lagofast 全局 query', () => {
  const lf = getActiveQueries().filter(q => q.brandName === 'Lagofast');
  expectEqual(lf.length, 4, 'Lagofast query 数');
  for (const q of lf) {
    assert.strictEqual(q.global, true, `query ${q.queryText} 应为 global`);
    assert.strictEqual(q.targetLanguage, undefined, `${q.queryText} 不应有 targetLanguage`);
    assert.strictEqual(q.targetMarket, undefined, `${q.queryText} 不应有 targetMarket`);
  }
  const texts = lf.map(q => q.queryText);
  for (const want of ['LagoFast', '"Lago Fast"', 'lagofast.com', 'lago-fast.com']) {
    assert.ok(texts.includes(want), `缺 query: ${want}`);
  }
});

console.log('== Completion gate（动态 rolling 90d 有效窗口集, 2026-08-31）==');
const GATE_QUERIES = ['LagoFast', '"Lago Fast"', 'lagofast.com', 'lago-fast.com'];
const dbIso = (d: string) => `${d}T00:00:00+00:00`; // DB 返回格式（PostgREST timestamptz）
function gateRows(winStarts: string[], status = 'completed', orphan: GateWindowRow[] = []): GateWindowRow[] {
  const rows: GateWindowRow[] = [];
  for (const q of GATE_QUERIES) for (const from of winStarts) rows.push({ query_text: q, window_from: dbIso(from.slice(0, 10)), status });
  return rows.concat(orphan);
}
check('Gate: 周滚动后有效窗口集自动推移, expected 动态推导（无硬编码 56）', () => {
  const winA = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const winB = currentWinStarts(Date.parse('2026-09-07T12:00:00Z'));
  expectEqual(winA.length, 14, 'winA 周数(08-31)');
  expectEqual(winB.length, 14, 'winB 周数(09-07)');
  // 集合确实推移（周一锚定 + 7 天步进）：B 尾部新增新周、A 头部滑出
  assert.ok(!winA.includes(winB[winB.length - 1]), 'B 尾部窗口不在 A 中（新周推移）');
  assert.ok(!winB.includes(winA[0]), 'A 头部窗口不在 B 中（旧周滑出）');

  // 同一份全 completed 数据在 08-31 视角 GATE_MET
  const rows = gateRows(winA, 'completed');
  const gA = computeGate(rows, Date.parse('2026-08-31T12:00:00Z'));
  expectEqual(gA.expected, winA.length * 4, 'expected = 周数 × 4（动态）');
  expectEqual(gA.gateOpen, true, '全 completed → gate open');
  expectEqual(gA.orphanCount, 0, '无孤儿');

  // 数据不补新周时, 09-07 视角: 新周窗口缺失 → 按 pending 阻塞（证明 gate 跟随滚动窗口）
  const gB = computeGate(rows, Date.parse('2026-09-07T12:00:00Z'));
  expectEqual(gB.gateOpen, false, '缺新周行 → gate not met');
  expectEqual(gB.missingCount, 4, '缺 4 个新周行（4 query × 1 周）');
  assert.ok(gB.unmet.includes('pending'), 'unmet 含 pending');
});
check('Gate: 滑出 90d 的孤儿 pending 不阻塞 gate（保留历史状态）', () => {
  const win = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const orphan = GATE_QUERIES.map(q => ({ query_text: q, window_from: '2026-05-25T00:00:00+00:00', status: 'pending' as string }));
  const rows = gateRows(win, 'completed', orphan);
  const g = computeGate(rows, Date.parse('2026-08-31T12:00:00Z'));
  expectEqual(g.gateOpen, true, '孤儿 pending 不阻塞');
  expectEqual(g.orphanCount, 4, '孤儿计数=4');
  assert.ok(!g.unmet.includes('pending'), 'unmet 不含孤儿 pending');
  expectEqual(g.byStatus.pending || 0, 0, '有效集内无 pending');
});
check('Gate: 有效窗口 partial 仍阻塞 gate', () => {
  const win = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const rows = gateRows(win, 'completed');
  rows[0].status = 'partial';
  const g = computeGate(rows, Date.parse('2026-08-31T12:00:00Z'));
  expectEqual(g.gateOpen, false, 'partial 阻塞');
  assert.ok(g.unmet.includes('partial'), 'unmet 含 partial');
});
check('Gate: 有效窗口 pending 仍阻塞 gate', () => {
  const win = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const rows = gateRows(win, 'completed');
  rows[0].status = 'pending';
  const g = computeGate(rows, Date.parse('2026-08-31T12:00:00Z'));
  expectEqual(g.gateOpen, false, 'pending 阻塞');
  assert.ok(g.unmet.includes('pending'), 'unmet 含 pending');
});

console.log('== Backfill 断点续跑决策（P0 B1 格式错配修复, 2026-08-31）==');
const BW_Q = ['LagoFast', '"Lago Fast"', 'lagofast.com', 'lago-fast.com'];
const winTo7 = (f: string) => new Date(new Date(f).getTime() + 7 * 86400000).toISOString();
const lfQuery = (t: string) => ({ queryText: t, targetLanguage: undefined } as unknown as BrandQuery);
const fullCompletedRows = (winStarts: string[]): BackfillWindowRow[] => {
  const rows: BackfillWindowRow[] = [];
  for (const q of BW_Q) for (const from of winStarts) rows.push({ query_text: q, window_from: from, window_to: winTo7(from), status: 'completed' });
  return rows;
};
check('canonicalWindowTs: +00:00 与 .000Z 命中同一窗口', () => {
  const a = canonicalWindowTs('2026-08-31T00:00:00+00:00');
  const b = canonicalWindowTs('2026-08-31T00:00:00.000Z');
  expectEqual(a, b, 'canonical 等值');
  expectEqual(a, '2026-08-31T00:00:00.000Z', 'canonical 形如 .000Z');
});
check('buildBackfillTodo: completed 不进 toDo', () => {
  const winStarts = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const todo = buildBackfillTodo(BW_Q.map(lfQuery), winStarts, fullCompletedRows(winStarts), winTo7);
  expectEqual(todo.length, 0, '全 completed → toDo 空');
});
check('buildBackfillTodo: partial 进 toDo（真实分布 = 9）', () => {
  const winStarts = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const rows = fullCompletedRows(winStarts);
  // 复刻真实分布：仅 LagoFast 的 06-29..08-24 9 个窗口为 partial
  for (const r of rows) {
    if (r.query_text === 'LagoFast') {
      const d = r.window_from.slice(0, 10);
      if (d >= '2026-06-29' && d <= '2026-08-24') r.status = 'partial';
    }
  }
  const todo = buildBackfillTodo(BW_Q.map(lfQuery), winStarts, rows, winTo7);
  expectEqual(todo.length, 9, 'toDo = 9 partial');
  expectEqual(todo.every(t => t.inserted === false), true, '均为既有窗口（非补插）');
  expectEqual([...new Set(todo.map(t => t.q.queryText))].join(','), 'LagoFast', '全部来自 LagoFast');
});
check('buildBackfillTodo: 有效 pending 进 toDo', () => {
  const winStarts = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const rows = fullCompletedRows(winStarts);
  rows[0].status = 'pending'; // LagoFast 06-01（有效窗口）
  const todo = buildBackfillTodo(BW_Q.map(lfQuery), winStarts, rows, winTo7);
  expectEqual(todo.length, 1, '1 个有效 pending 进 toDo');
  expectEqual(todo[0].inserted, false, '既有窗口');
});
check('buildBackfillTodo: 滑出 90d 的孤儿 pending 不进 toDo', () => {
  const winStarts = currentWinStarts(Date.parse('2026-08-31T12:00:00Z'));
  const rows = fullCompletedRows(winStarts);
  for (const q of BW_Q) rows.push({ query_text: q, window_from: '2026-05-25T00:00:00+00:00', window_to: '2026-06-01T00:00:00+00:00', status: 'pending' });
  const todo = buildBackfillTodo(BW_Q.map(lfQuery), winStarts, rows, winTo7);
  expectEqual(todo.length, 0, '孤儿不进 toDo');
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.error('FAILED:', failed.join('; ')); process.exit(1); }

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
import { buildClassificationPrompt, type ClassificationPromptItem } from './services/competitor-monitor/index';
import { buildSearchParams } from './services/competitor-monitor/youtube-discovery';
import { getActiveQueries } from './services/competitor-monitor/brand-config';
import { COMPETITOR_BRANDS } from './services/competitor-monitor/data-scope';

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

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.error('FAILED:', failed.join('; ')); process.exit(1); }

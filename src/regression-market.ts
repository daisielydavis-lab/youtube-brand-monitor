/**
 * Market 识别回归测试（2026-08-29 P1）
 *
 * 核心原则：**英文 ≠ 美国。语言只能说明内容语言，不能单独决定市场。**
 * detectLanguage → English → US 的默认映射已移除；无额外市场证据 → market=null。
 * 覆盖优先级链各层 + 防强猜规则 + 语言扩展（th/vi/id/ms/tr）。
 *
 * 运行: npm run test:market (ts-node src/regression-market.ts)
 */
import assert from 'assert';
import {
  inferMarket, detectLanguage, countryToMarket, languageToMarket,
  detectLocalization, normalizeMarketCode,
} from './services/competitor-monitor/market-inference';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const im = (o: { title?: string; description?: string; marketContext?: any; aiCandidate?: any } = {}) =>
  inferMarket({ title: o.title || '', description: o.description || '', marketContext: o.marketContext, aiCandidate: o.aiCandidate });

// ── P1 核心:英文 ≠ 美国 ──
check('英文无本地化证据 → market=null / source=unknown / confidence=null', () => {
  const r = im({ title: 'How to fix lag in Valorant', description: 'Best settings for lower ping' });
  assert.strictEqual(r.market, null);
  assert.strictEqual(r.source, 'unknown');
  assert.strictEqual(r.confidence, null);
});
check('detectLanguage 英文 → language=en, market=null（不再默认 US）', () => {
  const d = detectLanguage('How to fix lag', 'settings guide');
  assert.strictEqual(d.language, 'en');
  assert.strictEqual(d.market, null);
});

// ── 显式本地化（explicit_localization 层）──
check('pt-br URL + R$ → BR（explicit_localization 90）', () => {
  const r = im({ title: 'Melhor booster de ping', description: 'https://www.lagofast.com/pt-br/?cid=abc R$99' });
  assert.strictEqual(r.market, 'BR');
  assert.strictEqual(r.source, 'explicit_localization');
  assert.ok(r.evidence[0].includes('/pt-br/'));
});
check('промокод/скидка → RU', () => {
  const r = im({ title: 'Обзор лага', description: 'Промокод LAGOFAST скидка 20%' });
  assert.strictEqual(r.market, 'RU');
});
check('越南国别域名 gearup.com.vn → VI（TLD）', () => {
  const r = im({ title: 'fix lag', description: 'https://gearup.com.vn/uu-dai' });
  assert.strictEqual(r.market, 'VI');
  assert.strictEqual(r.source, 'explicit_localization');
});

// ── 防强猜:discovery_hint 默认英文/US 必须忽略 ──
check('en query hint（US/en）→ 忽略 → unknown', () => {
  const r = im({ title: 'Lag fix guide', description: 'booster app', marketContext: { discoveryHint: { market: 'US', language: 'en' } } });
  assert.strictEqual(r.market, null);
  assert.strictEqual(r.source, 'unknown');
});
check('ru query hint → discovery_hint 弱采用', () => {
  const r = im({ title: 'boost fps', description: 'app', marketContext: { discoveryHint: { market: 'RU', language: 'ru' } } });
  assert.strictEqual(r.market, 'RU');
  assert.strictEqual(r.source, 'discovery_hint');
});

// ── 不强猜 ──
check('zh 歧义（TW/HK/CN）→ 不写 CN', () => {
  const r = im({ title: '加速器评测', description: '游戏加速器推荐' });
  assert.notStrictEqual(r.market, 'CN');
  assert.strictEqual(r.source, 'unknown');
});
check('languageToMarket(en)=null, zh=null', () => {
  assert.strictEqual(languageToMarket('en'), null);
  assert.strictEqual(languageToMarket('zh'), null);
});

// ── 优先级链中高层证据 ──
check('channel_country=BR 优先于 language 英文', () => {
  const r = im({ title: 'English lag fix', description: 'plain text', marketContext: { channelCountry: 'BR' } });
  assert.strictEqual(r.market, 'BR');
  assert.strictEqual(r.source, 'channel_country');
});
check('creator_history 多数票（3/4 RU）→ RU', () => {
  const r = im({ title: 'English title', description: 'english desc', marketContext: { creatorHistoryMarkets: ['RU', 'RU', 'RU', 'US'] } });
  assert.strictEqual(r.market, 'RU');
  assert.strictEqual(r.source, 'creator_history');
});
check('AI 独立证据 → ai_inference', () => {
  const r = im({ title: 'english title', description: 'english desc', aiCandidate: { market: 'BR', confidence: 90, evidence: ['localized landing pt-br'] } });
  assert.strictEqual(r.market, 'BR');
  assert.strictEqual(r.source, 'ai_inference');
});
check('AI market 为 null → 不采用（走 unknown）', () => {
  const r = im({ title: 'english title', description: 'english desc', aiCandidate: { market: null, confidence: 50 } });
  assert.strictEqual(r.market, null);
  assert.strictEqual(r.source, 'unknown');
});

// ── 语言扩展（新增 th/vi/id/ms/tr 检测）──
check('泰文脚本 → language=th, market=TH', () => {
  const d = detectLanguage('ลดแลคในเกม', 'โค้ดส่วนลด 50%');
  assert.strictEqual(d.language, 'th');
  assert.strictEqual(d.market, 'TH');
});
check('越南语音符 → vi/VI', () => {
  const d = detectLanguage('Hướng dẫn giảm lag', 'mã giảm giá');
  assert.strictEqual(d.language, 'vi');
  assert.strictEqual(d.market, 'VI');
});
check('土耳其语 ğ → tr/TR', () => {
  const d = detectLanguage('Lag indirimi', 'indirim kuponu');
  assert.strictEqual(d.language, 'tr');
  assert.strictEqual(d.market, 'TR');
});

// ── 国家 → 市场映射 ──
check('countryToMarket: VN→VI, MX→LATAM, DE→DE, US→US', () => {
  assert.strictEqual(countryToMarket('VN'), 'VI');
  assert.strictEqual(countryToMarket('MX'), 'LATAM');
  assert.strictEqual(countryToMarket('DE'), 'DE');
  assert.strictEqual(countryToMarket('US'), 'US');
  assert.strictEqual(countryToMarket('XZ'), null);
});

// ── 归一化 ──
check('normalizeMarketCode: vn→VI, latam→LATAM, zz→null', () => {
  assert.strictEqual(normalizeMarketCode('vn'), 'VI');
  assert.strictEqual(normalizeMarketCode('LATAM'), 'LATAM');
  assert.strictEqual(normalizeMarketCode('zz'), null);
});
check('detectLocalization 排序按置信度', () => {
  const locs = detectLocalization('https://lago-fast.com/ru/?cid=1 and NT$399 and kupons');
  assert.ok(locs.length >= 2);
  assert.strictEqual(locs[0].market, 'RU'); // url path 90 最高
  assert.ok(locs[0].confidence >= locs[1].confidence);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'with failures' : '0 failed'}`);
if (process.exitCode) process.exit(1);

/**
 * Inline-script JSON 硬化回归测试 (2026-08-29)
 *
 * safeJsonForInlineScript 必须在 <script> 上下文里防住:
 *   - raw 控制字符 (LF/CR/TAB) —— JSON.stringify 已处理, 这里锁住不回归
 *   - `</script>` 逃逸 —— 纯 JSON.stringify 不够, `<` 必须转义
 *   - U+2028 / U+2029 (JS 行/段分隔符)
 *   - `&` 实体解释
 * 且数据必须无损往返 (JS 解析后 decoded === 原始字符串)。
 *
 * 运行: npm run test:inline-json (ts-node src/regression-inline-json.ts)
 */
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { execFileSync } from 'child_process';
import { safeJsonForInlineScript } from './ui/inline-script-json';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** 输出里是否还残留 raw 控制字符 / U+2028 / U+2029 / DEL */
function hasRawCtrl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** 把 safeJsonForInlineScript 的输出当作 `<script>` 内 JS 求值, 返回解码后的数据 */
function roundTrip(out: string): any {
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext('var __data = ' + out + ';', ctx);
  return JSON.parse(JSON.stringify(ctx.__data));
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

// ── 单元: 单条标题 ──
check('标题含 LF (`abc\\n27`): 无 raw 控制字符 + 无损往返', () => {
  const t = 'abc\n27';
  const out = safeJsonForInlineScript(t);
  assert.ok(!hasRawCtrl(out), 'raw control char leaked: ' + JSON.stringify(out));
  assert.strictEqual(roundTrip(out), t);
});

check('标题含 `</script><script>alert(1)</script>`: 不泄漏 + 无损往返', () => {
  const t = '</script><script>alert(1)</script>';
  const out = safeJsonForInlineScript(t);
  assert.ok(!out.includes('</script>'), 'output leaked `</script>`: ' + out);
  assert.ok(!out.includes('<script'), 'output leaked `<script`: ' + out);
  assert.ok(out.includes('\\u003c'), 'expected `\\u003c` escape in output');
  assert.strictEqual(roundTrip(out), t);
});

check('标题含 CR / TAB / CRLF', () => {
  const t = 'tab\there\r\ncrlf';
  const out = safeJsonForInlineScript(t);
  assert.ok(!hasRawCtrl(out), 'raw control char leaked: ' + JSON.stringify(out));
  assert.strictEqual(roundTrip(out), t);
});

check('标题含 U+2028 / U+2029: 转义为 \\u2028/\\u2029 + 无损往返', () => {
  const t = 'line' + LS + 'sep' + PS + 'para';
  const out = safeJsonForInlineScript(t);
  assert.ok(!out.includes(LS), 'raw U+2028 leaked');
  assert.ok(!out.includes(PS), 'raw U+2029 leaked');
  assert.strictEqual(roundTrip(out), t);
});

check('中日韩 / 俄语标题无损往返', () => {
  const t = 'PUBG LIVE 🔴 | 普通中文标题 · Русский заголовок · 日本語 · 한국어';
  assert.strictEqual(roundTrip(safeJsonForInlineScript(t)), t);
});

check('`&`/`<`/`>` 转义 + 无损往返', () => {
  const t = 'Tom & Jerry <b>Fast</b>';
  const out = safeJsonForInlineScript(t);
  assert.ok(out.includes('\\u0026'), 'expected `\\u0026` for &');
  assert.ok(out.includes('\\u003c'), 'expected `\\u003c` for <');
  assert.ok(out.includes('\\u003e'), 'expected `\\u003e` for >');
  assert.strictEqual(roundTrip(out), t);
});

// ── 集成: 模拟 dashboard 真实注入 (video 数组 + 恶意标题) ──
const adversarialVideos = [
  {
    videoId: 'v1', title: 'abc\n27',
    thumbnailUrl: 'https://i.ytimg.com/vi/v1/mqdefault.jpg',
    channelName: 'C1', brand: 'ExitLag', game: 'CS2', viewCount: 5,
    placementType: 'likely_sponsored', contentCategory: 'live',
    publishedAt: '2026-08-29T00:00:00+00:00',
    reasonCodes: ['promo_code'],
    discoveryEvidence: [{ code: 'code1', evidence: '</script><script>x</script>' }],
  },
  {
    videoId: 'v2', title: '</script><script>alert(1)</script>',
    thumbnailUrl: 'https://i.ytimg.com/vi/v2/mqdefault.jpg',
    channelName: 'C2', brand: 'LagZapper', game: 'Valorant', viewCount: 100,
    placementType: 'confirmed_paid_placement', contentCategory: 'shorts',
    publishedAt: '2026-08-28T00:00:00+00:00',
    reasonCodes: [], discoveryEvidence: [],
  },
  {
    videoId: 'v3', title: 'line' + LS + 'sep' + PS + 'para',
    thumbnailUrl: '', channelName: 'C3', brand: 'GearUP', game: 'unknown', viewCount: 0,
    placementType: 'organic_mention', contentCategory: 'unknown',
    publishedAt: '', reasonCodes: [], discoveryEvidence: [],
  },
  {
    videoId: 'v4', title: '普通的中文标题 | Русский | 日本語 | 한국어',
    thumbnailUrl: '', channelName: '中文频道', brand: 'Lagofast', game: 'Apex', viewCount: 42,
    placementType: 'likely_sponsored', contentCategory: 'integrated',
    publishedAt: '2026-08-27T00:00:00+00:00',
    reasonCodes: ['brand_in_title'], discoveryEvidence: [],
  },
];

check('视频数组嵌入 `<script>`: node --check 通过 + 解码等于原数据', () => {
  const json = safeJsonForInlineScript(adversarialVideos);
  assert.ok(!json.includes('</script>'), 'output leaked `</script>`');
  assert.ok(!json.includes('<script'), 'output leaked `<script`');
  assert.ok(!hasRawCtrl(json), 'raw control char leaked in array');

  // 模拟 dashboard.ts 注入形式: var competitorVids = ${json};
  const script = 'var competitorVids = ' + json + ';';
  const f = path.join(os.tmpdir(), 'reg-inline-' + process.pid + '.js');
  fs.writeFileSync(f, script);
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(f);
  }

  const decoded = roundTrip(json);
  assert.deepStrictEqual(decoded, adversarialVideos);
});

// ── 集成: 短字符串 (filter 值 / label 表 同路径) ──
check('短字符串注入 (curRange/curBrand 路径)', () => {
  const t = '90d';
  const out = safeJsonForInlineScript(t);
  assert.strictEqual(roundTrip(out), t);
});

console.log(`\n${passed} 项检查通过`);
if (process.exitCode) console.error('❌ 有失败项');
else console.log('✅ 全部通过');

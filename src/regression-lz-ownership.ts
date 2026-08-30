/**
 * 负向回归：shared-link ownership guard —— rhver 不被污染成 vaughnfn（2026-08-29）
 *
 * 背景：rhver 的频道里观察到 cid=155 / code=VAUGHN35，但 identity registry 已知
 * cid=155 / VAUGHN35 属于 vaughnfn → guardOwnership 必须判为 sharedForeign(owner=vaughnfn)，
 * 绝不并入 rhver。若 guard 失效，rhver 身份会被污染成 vaughnfn（Creator Network 崩溃）。
 *
 * 纯函数回归，无 DB、无 Search。npm run test:lz-ownership
 */
import { guardOwnership, resolveKnownIdentity, type IdentityRow, type KOLSignal } from './services/competitor-monitor/kol-tracking';

const registry: IdentityRow[] = [
  { channel_id: 'vaughnfn-CH', channel_name: 'vaughnfn', affiliate_cid: '155', promo_code: 'VAUGHN35', signal_type: 'cid', confidence: 1.0 },
  { channel_id: 'rhver-CH', channel_name: 'rhver', affiliate_cid: '176', promo_code: 'RHVER', signal_type: 'promo_code', confidence: 0.9 },
];

function signals(list: Array<[string, string]>): KOLSignal[] {
  return list.map(([form, value]) => ({ form: form as KOLSignal['form'], value }));
}

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failed++; }
}

// rhver 频道观察到的信号（含自己的 + 分享的 vaughnfn 链接）
const rhverObserved = signals([
  ['cid', '176'], ['promo_code', 'RHVER'],           // 自己的
  ['cid', '155'], ['promo_code', 'VAUGHN35'],        // vaughnfn 的（被分享）
]);
const r = guardOwnership('rhver-CH', rhverObserved, registry);

console.log('═══ 负向回归：shared-link ownership guard ═══\n');

// mergeable 只含 rhver 自己的信号
const mergeVals = r.mergeable.map(s => `${s.form}:${s.value}`);
check(mergeVals.includes('cid:176'), 'mergeable 含 rhver 自身 cid=176');
check(mergeVals.includes('promo_code:RHVER'), 'mergeable 含 rhver 自身 code=RHVER');
check(!mergeVals.includes('cid:155'), 'mergeable 不含 vaughnfn 的 cid=155');
check(!mergeVals.includes('promo_code:VAUGHN35'), 'mergeable 不含 vaughnfn 的 code=VAUGHN35');

// sharedForeign 恰好是 vaughnfn 的两个信号
const sf = r.sharedForeign;
check(sf.length === 2, `sharedForeign 恰好 2 条（实得 ${sf.length}）`);
check(sf.some(s => s.form === 'cid' && s.value === '155' && s.ownerChannel === 'vaughnfn-CH'), 'cid=155 → owner=vaughnfn-CH');
check(sf.some(s => s.form === 'promo_code' && s.value === 'VAUGHN35' && s.ownerChannel === 'vaughnfn-CH'), 'code=VAUGHN35 → owner=vaughnfn-CH');

// 反向：vaughnfn 频道自己观察到自己的信号 → 全 mergeable，无 sharedForeign
const v = guardOwnership('vaughnfn-CH', signals([['cid', '155'], ['promo_code', 'VAUGHN35']]), registry);
check(v.sharedForeign.length === 0, 'vaughnfn 频道自身信号不判为 sharedForeign');
check(v.mergeable.length === 2, 'vaughnfn 频道自身信号全 mergeable');

// 无人认领的信号 → mergeable（候选）
const unclaimed = guardOwnership('new-KOL-CH', signals([['cid', '121'], ['promo_code', 'EUTOPIA35']]), registry);
check(unclaimed.sharedForeign.length === 0, '无人认领 cid=121/EUTOPIA35 不判 sharedForeign');
check(unclaimed.mergeable.length === 2, '无人认领 cid=121/EUTOPIA35 全 mergeable（新候选）');

// ── 正回归：creator 6 候选产品化的身份解析（2026-08-30）──
// 转写别名：Cyrillic 频道名 Симон Клик 与 Latin utm handle THESIMON 必须互相解析。
const promotedRegistry: IdentityRow[] = [
  ...registry,
  { brand: 'LagZapper', channel_id: 'UCIVL3pSl36CNGMrL16TgZ1Q', channel_name: 'Симон Клик', signal_type: 'utm_campaign', confidence: 0.8 },
  { brand: 'LagZapper', channel_id: 'UCHjUpCxwqhqZ_ADjbgkdh1w', channel_name: 'ntswitches', affiliate_cid: '15', promo_code: 'NTSWITCHES', signal_type: 'cid', confidence: 1.0 },
  { brand: 'LagZapper', channel_id: 'UCQ0p8laY0ROqegUWlxRjAPw', channel_name: 'Timba-x', promo_code: 'TIMBA-X', signal_type: 'promo_code', confidence: 0.9 },
];

console.log('\n═══ 正回归：6 候选产品化身份解析（THESIMON 转写别名 + cid/code 归属）═══\n');

// THESIMON utm handle → 经转写别名命中 Симон Клик 身份
const simon = resolveKnownIdentity('UCIVL3pSl36CNGMrL16TgZ1Q', [], [], ['THESIMON'], promotedRegistry);
check(!!simon, 'utm=THESIMON 经转写别名解析到身份');
check(simon?.identity.channel_id === 'UCIVL3pSl36CNGMrL16TgZ1Q', 'THESIMON → Симон Клик（channel_id 一致）');

// ntswitches 自身观察 cid=15 / NTSWITCHES → 全 mergeable（owned by self）
const nsw = guardOwnership('UCHjUpCxwqhqZ_ADjbgkdh1w', signals([['cid', '15'], ['promo_code', 'NTSWITCHES']]), promotedRegistry);
check(nsw.sharedForeign.length === 0, 'ntswitches 自身 cid=15/NTSWITCHES 不判 sharedForeign');
check(nsw.mergeable.length === 2, 'ntswitches 自身信号全 mergeable');

// 他人复用 cid=15 / NTSWITCHES → sharedForeign(owner=ntswitches)，绝不并入
const other = guardOwnership('other-KOL-CH', signals([['cid', '15'], ['promo_code', 'NTSWITCHES']]), promotedRegistry);
check(other.sharedForeign.length === 2, '他人复用 cid=15/NTSWITCHES → sharedForeign ×2');
check(other.mergeable.length === 0, '他人复用 → 0 mergeable（不并入）');
check(other.sharedForeign.every(s => s.ownerChannel === 'UCHjUpCxwqhqZ_ADjbgkdh1w'), 'sharedForeign owner 均为 ntswitches');

// Timba-x promo_code=TIMBA-X → 经 code 命中
const timba = resolveKnownIdentity('UCQ0p8laY0ROqegUWlxRjAPw', [], ['TIMBA-X'], [], promotedRegistry);
check(timba?.identity.channel_id === 'UCQ0p8laY0ROqegUWlxRjAPw', 'code=TIMBA-X → Timba-x（channel_id 一致）');

// DB description 截断场景：ntswitches 的 DB 视频只留 utm=Scathe（cid=15 在截断后 URL）→ 靠转写别名解析
const ntsw = resolveKnownIdentity('UCHjUpCxwqhqZ_ADjbgkdh1w', [], [], ['scathe'], promotedRegistry);
check(ntsw?.identity.channel_id === 'UCHjUpCxwqhqZ_ADjbgkdh1w', 'utm=Scathe 经转写别名解析到 ntswitches（DB 描述截断下仍 known）');

console.log(failed === 0 ? '\n✅ 全部通过 —— rhver 不会被污染成 vaughnfn；6 候选产品化身份可解析' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

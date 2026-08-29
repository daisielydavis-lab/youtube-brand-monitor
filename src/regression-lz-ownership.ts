/**
 * 负向回归：shared-link ownership guard —— rhver 不被污染成 vaughnfn（2026-08-29）
 *
 * 背景：rhver 的频道里观察到 cid=155 / code=VAUGHN35，但 identity registry 已知
 * cid=155 / VAUGHN35 属于 vaughnfn → guardOwnership 必须判为 sharedForeign(owner=vaughnfn)，
 * 绝不并入 rhver。若 guard 失效，rhver 身份会被污染成 vaughnfn（Creator Network 崩溃）。
 *
 * 纯函数回归，无 DB、无 Search。npm run test:lz-ownership
 */
import { guardOwnership, type IdentityRow, type KOLSignal } from './services/competitor-monitor/kol-tracking';

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

console.log(failed === 0 ? '\n✅ 全部通过 —— rhver 不会被污染成 vaughnfn' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

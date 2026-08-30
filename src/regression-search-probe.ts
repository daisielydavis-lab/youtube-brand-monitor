/**
 * 回归：Search Probe 的 DB 去重唯一键必须是 `video_id`（2026-08-30）
 *
 * 背景：Probe 首轮去重误用表主键 `id`（uuid）与 YouTube 返回的 video id 比较
 * → `.in()` 全 0 命中 → 假「54 条全新」假增量，误判 P1-P4 边际贡献。
 * 本回归固化：去重唯一键 = video_id；禁止与 uuid `id` 比较。
 *
 * 纯函数回归，无 DB、无 Search。npm run test:search-probe
 */
import { VIDEO_DEDUP_COLUMN, buildExistingSet } from './services/competitor-monitor/probe-dedup';

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failed++; }
}

console.log('═══ 回归：Search Probe DB 去重唯一键 = video_id（防假 DB-new）═══\n');

// 1. 唯一键列必须是 video_id，禁止 uuid `id`
check(VIDEO_DEDUP_COLUMN === 'video_id', `VIDEO_DEDUP_COLUMN === 'video_id'（实得 '${VIDEO_DEDUP_COLUMN}'）`);
check((VIDEO_DEDUP_COLUMN as string) !== 'id', '唯一键不是 uuid id');

// 2. buildExistingSet 只认 video_id 键
const ytIds = ['AAA11', 'BBB22', 'CCC33', 'DDD44'];
const rows = [
  { video_id: 'AAA11' },
  { video_id: 'BBB22' },
  { id: '550e8400-e29b-41d4-a716-446655440000' }, // uuid `id` 行：不应贡献"已存在"
];
const existing = buildExistingSet(rows);
check(existing.has('AAA11') && existing.has('BBB22'), 'video_id 命中的行计入 existing');
check(!existing.has('CCC33'), '未命中视频不算 existing（保持 new）');
check(existing.size === 2, `uuid id 行被忽略 → size=2（实得 ${existing.size}）`);

// 3. 模拟原 bug 场景：若误拿 uuid `id` 列，DB-new 会被虚增（防呆必须捕获）
const uuidOnly = [{ id: '550e8400-e29b-41d4-a716-446655440000' }];
const badExisting = buildExistingSet(uuidOnly as Array<{ video_id?: string }>);
const fakeNew = ytIds.filter(id => !badExisting.has(id)).length;
check(badExisting.size === 0, 'uuid 行不产生任何 existing');
check(fakeNew === ytIds.length, `uuid 去重 → 假 DB-new（${fakeNew}/${ytIds.length} 全变新）→ 防呆识别为 bug`);

// 4. 正确路径：video_id 去重 → 真实 DB-new
const goodNew = ytIds.filter(id => !existing.has(id)).length;
check(goodNew === 2, `video_id 去重 → 真 DB-new = 2（实得 ${goodNew}）`);

console.log(failed === 0 ? '\n✅ 全部通过 —— 去重唯一键锁定 video_id，不再产生假 DB-new' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

/**
 * P0 Quota Ledger readiness check（2026-08-29）
 *
 * 上线前验证 ledger 已就绪：
 *   1. get_youtube_quota_status RPC 可调（表存在）
 *   2. reserve dry-run 守卫通过（原子 reserve 路径可调、未熔断）
 *
 * 只有通过才允许启用 Search jobs；未通过 = Search fail-closed
 * （YT_QUOTA_LEDGER_UNAVAILABLE），不会发任何 search.list 请求。
 *
 * 用法:
 *   npm run quota:check            # 只读，安全可重复
 *   npm run quota:check -- --verbose   # 额外打印 reserve 语义分类
 *
 * 前置：先在 Supabase SQL Editor 应用 supabase-migration-quota-ledger.sql。
 */
import { checkLedgerReady, getQuotaToday, SEARCH_HARD_BUDGET, SEARCH_SOFT } from './services/competitor-monitor/quota-ledger';

async function main() {
  const verbose = process.argv.includes('--verbose');
  console.log('═══ YouTube Search Quota Ledger · readiness check ═══');

  const { ready, detail } = await checkLedgerReady();
  for (const line of detail) console.log(`  • ${line}`);

  const q = await getQuotaToday();
  console.log('── 当前期用量 ──');
  if (q.ledgerReady) {
    console.log(`  period  : ${q.periodDate}  (PT 午夜重置)${q.resetAt ? ' · reset at ' + q.resetAt : ''}`);
    console.log(`  used    : ${q.used}/${SEARCH_HARD_BUDGET} calls · ${q.units} units`);
    console.log(`  category: normal=${q.normal} · backfill=${q.backfill} · manual=${q.manual}`);
    console.log(`  soft    : normal≤${SEARCH_SOFT.normal} · backfill≤${SEARCH_SOFT.backfill} · manual≤${SEARCH_SOFT.manual}（仅展示，非硬门）`);
    console.log(`  state   : ${q.hardExhausted ? '⚠️ 已硬熔断（真实每日配额耗尽，剩余 Search 短路）' : '正常'}`);
  } else {
    console.log(`  ✗ ledger 不可读：${q.error || '未知错误'}`);
  }

  console.log('── 结论 ──');
  if (ready) {
    console.log('  ✅ READY：Search jobs 可以启用（硬门由 SQL 原子守卫保证，跨部署持久）');
  } else {
    console.log('  ❌ NOT READY：Search 将 fail-closed（YT_QUOTA_LEDGER_UNAVAILABLE，不发请求）。');
    console.log('     请先在 Supabase SQL Editor 全量运行 supabase-migration-quota-ledger.sql，再启用 Search。');
  }
  if (verbose) {
    console.log('── reserve 分类语义 ──');
    console.log('  normal  = 常规扫描 · backfill = 历史回填 · manual = hotspot/实验/CLI probe');
  }
  process.exit(ready ? 0 : 1);
}

main().catch((e) => { console.error('CLI 异常:', e); process.exit(2); });

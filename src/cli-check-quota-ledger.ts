/**
 * P0 Quota Ledger readiness check + 首日 bootstrap 控制（2026-08-29）
 *
 * 上线前验证 ledger 已就绪；并支持把「当前 PT 日」熔断作为首日冷启动保护。
 * 三态语义：infra 可用 ≠ Search 放行（bootstrap 熔断后 infra READY 但 gated 属预期）。
 *
 * 用法（只读，安全可重复）:
 *   npm run quota:check               # readiness + 当前期用量（dry-run 不递增）
 *   npm run quota:check -- --verbose  # 附操作类 flag 说明
 *
 * 运维操作（明确指定才执行）:
 *   npm run quota:check -- --exhaust-today  # 首日 bootstrap：熔断当前 PT 日
 *                                           # （migration 之前真实 Search 用量无法重建 → fail-closed，
 *                                           #  下个 PT 午夜自动开新 period used=0）
 *   npm run quota:check -- --unlock-today   # 解除当前日熔断（仅确认今日真实用量远低于硬门时使用）
 *
 * 前置：先在 Supabase SQL Editor 应用 supabase-migration-quota-ledger.sql。
 */
import { checkLedgerReady, getQuotaToday, setQuotaDayExhausted, SEARCH_HARD_BUDGET, SEARCH_SOFT } from './services/competitor-monitor/quota-ledger';

async function main() {
  const verbose = process.argv.includes('--verbose');
  const exhaust = process.argv.includes('--exhaust-today');
  const unlock = process.argv.includes('--unlock-today');
  if (exhaust && unlock) { console.error('✗ --exhaust-today 与 --unlock-today 互斥'); process.exit(2); }

  // ── 运维操作：首日 bootstrap 熔断 / 解除 ──
  if (exhaust || unlock) {
    const r = await setQuotaDayExhausted(exhaust);
    if (r.error) { console.error('✗ 操作失败:', r.error); process.exit(1); }
    console.log(`═══ 首日 bootstrap 保护：${exhaust ? '熔断当前 PT 日' : '解除当前 PT 日熔断'} ═══`);
    console.log(`  period       : ${r.periodDate}`);
    console.log(`  used         : ${r.used}/${SEARCH_HARD_BUDGET}`);
    console.log(`  hardExhausted: ${r.hardExhausted}`);
    console.log(`  resetAt      : ${r.resetAt}`);
    console.log(exhaust
      ? '  → 当前 PT 日 Search 全类暂停（fail-closed）；下个 America/Los_Angeles 午夜自动开启新 period（used=0, hard_exhausted=false）。'
      : '  → 已解除当前日熔断。仅当你确认今日真实 Search 用量远低于硬门时使用。');
    console.log('');
  }

  // ── readiness + 当前期用量 ──
  const { ready, gated, gateReason, detail } = await checkLedgerReady();
  console.log('═══ YouTube Search Quota Ledger · readiness check ═══');
  for (const line of detail) console.log(`  • ${line}`);

  const q = await getQuotaToday();
  console.log('── 当前期用量 ──');
  if (q.ledgerReady) {
    console.log(`  ledgerReady  : ${q.ledgerReady}`);
    console.log(`  periodDate   : ${q.periodDate}  (PT 午夜重置)`);
    console.log(`  resetAt      : ${q.resetAt}`);
    console.log(`  used         : ${q.used}/${SEARCH_HARD_BUDGET} calls · ${q.units} units`);
    console.log(`  category     : normal=${q.normal} · backfill=${q.backfill} · manual=${q.manual}`);
    console.log(`  hardExhausted: ${q.hardExhausted}`);
    console.log(`  soft(展示)   : normal≤${SEARCH_SOFT.normal} · backfill≤${SEARCH_SOFT.backfill} · manual≤${SEARCH_SOFT.manual}`);
  } else {
    console.log(`  ✗ ledger 不可读：${q.error || '未知错误'}`);
  }

  console.log('── 结论 ──');
  if (ready && !gated) {
    console.log('  ✅ 基础设施 READY 且当前日未熔断：Search 可正常放行（硬门由 SQL 原子守卫保证，跨部署持久）。');
    console.log('  ✅ dry-run 不递增验证：再跑一次本命令，两次 used 必须完全一致。');
  } else if (ready && gated) {
    console.log(`  ✅ 基础设施 READY（ledger 可用），但当前 PT 日 Search 已${gateReason === 'hard_exhausted' ? '熔断' : '达硬门'}（${gateReason}）。`);
    console.log('     → 属预期：bootstrap 保护或真实配额耗尽。下个 PT 午夜自动开新 period 后恢复，ledger 数字从那时起完整可信。');
  } else {
    console.log('  ❌ 基础设施 NOT READY：Search 将 fail-closed（YT_QUOTA_LEDGER_UNAVAILABLE，不发请求）。');
    console.log('     请先在 Supabase SQL Editor 全量运行 supabase-migration-quota-ledger.sql，再启用 Search。');
  }
  if (verbose) {
    console.log('── 操作类 flag ──');
    console.log('  --exhaust-today : 熔断当前 PT 日（首日 bootstrap 保护，等待 PT 午夜自动恢复）');
    console.log('  --unlock-today  : 解除当前日熔断（仅确认今日真实用量远低于硬门时使用）');
  }
  process.exit(ready ? 0 : 1);
}

main().catch((e) => { console.error('CLI 异常:', e); process.exit(2); });

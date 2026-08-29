import { runDiscoveryPipeline, getMonitorStatus } from './services/competitor-monitor';
import { getActiveQueries } from './services/competitor-monitor/brand-config';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    console.log(JSON.stringify(await getMonitorStatus(), null, 2));
    return;
  }
  const mode = args.includes('--hotspot') ? 'hotspot' : args.includes('--manual') ? 'manual' : 'normal';
  const gameIdx = args.indexOf('--game');
  const game = gameIdx >= 0 ? args[gameIdx + 1] : undefined;
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 1;
  // --brands ExitLag,Lagofast → 只跑指定品牌的 query（2026-08-29 Lagofast-only backfill，不动其他品牌）
  const brandsIdx = args.indexOf('--brands');
  const brands = brandsIdx >= 0 ? args[brandsIdx + 1].split(',').map(b => b.trim()).filter(Boolean) : undefined;
  const queries = brands?.length ? getActiveQueries().filter(q => brands.includes(q.brandName)) : undefined;
  if (brands?.length && !queries?.length) {
    console.error(`--brands 过滤后 0 条 query（可用: ${[...new Set(getActiveQueries().map(q => q.brandName))].join(', ')}）`);
    process.exit(1);
  }

  console.log(`Running ${mode} scan (days=${days}${game ? ', game=' + game : ''}${brands ? ', brands=' + brands.join(',') : ''})`);
  const result = await runDiscoveryPipeline({ mode, backfillDays: days, hotspotGame: game, queries });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });

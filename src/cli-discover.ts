import { runDiscoveryPipeline, getMonitorStatus } from './services/competitor-monitor';

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

  console.log(`Running ${mode} scan (days=${days}${game ? ', game=' + game : ''})`);
  const result = await runDiscoveryPipeline({ mode, backfillDays: days, hotspotGame: game });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });

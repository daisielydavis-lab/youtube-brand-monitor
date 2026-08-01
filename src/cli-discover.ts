/**
 * CLI entry point — manual discovery run.
 * Usage: npm run discover [-- --backfill 30]
 */

import { runDiscoveryPipeline, runBackfill, getMonitorStatus } from './services/competitor-monitor';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    console.log('Fetching monitor status...');
    const status = await getMonitorStatus();
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const backfillIndex = args.indexOf('--backfill');
  if (backfillIndex >= 0) {
    const days = parseInt(args[backfillIndex + 1] || '30', 10);
    await runBackfill(days);
    return;
  }

  const daysIndex = args.indexOf('--days');
  const days = daysIndex >= 0 ? parseInt(args[daysIndex + 1] || '1', 10) : 1;

  const skipAI = args.includes('--skip-ai');
  const skipComments = args.includes('--skip-comments');

  console.log(`Running discovery pipeline (days=${days}, skipAI=${skipAI}, skipComments=${skipComments})`);
  const result = await runDiscoveryPipeline({
    backfillDays: days,
    skipAI,
    skipComments,
  });
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('CLI failed:', err);
  process.exit(1);
});

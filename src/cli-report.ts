/**
 * CLI entry point — report generation.
 * Usage: npm run report [--daily | --weekly]
 */

import { generateDailyReport, generateWeeklyReport, formatDailyReportText } from './services/competitor-monitor/competitor-report';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--weekly')) {
    console.log('Generating weekly report...');
    const report = await generateWeeklyReport();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Default: daily
  console.log('Generating daily report...');
  const report = await generateDailyReport();
  console.log(formatDailyReportText(report));
}

main().catch(err => {
  console.error('Report CLI failed:', err);
  process.exit(1);
});

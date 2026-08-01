/**
 * YouTube Competitor Placement Monitor — Express Server
 *
 * Endpoints:
 *   GET  /health              — Health check
 *   GET  /status              — Monitor status summary
 *   POST /run                 — Trigger discovery pipeline
 *   GET  /report/daily        — Get latest daily report
 *   GET  /report/weekly       — Get latest weekly report
 *
 * Cron:
 *   Every day at 06:00 UTC — auto discovery run
 */

import express from 'express';
import cron from 'node-cron';
import { config, validateConfig } from './config';
import {
  runDiscoveryPipeline,
  getMonitorStatus,
} from './services/competitor-monitor';
import {
  generateDailyReport,
  generateWeeklyReport,
  formatDailyReportText,
} from './services/competitor-monitor/competitor-report';
import { getSupabase } from './db/supabase';
import { renderDashboard } from './ui/dashboard';

const app = express();
app.use(express.json());

// ── Health check ──
app.get('/health', (_req, res) => {
  const missing = validateConfig();
  res.json({
    status: missing.length ? 'degraded' : 'healthy',
    missingConfig: missing,
    uptime: process.uptime(),
  });
});

// ── Status ──
app.get('/status', async (_req, res) => {
  try {
    const status = await getMonitorStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Trigger discovery ──
app.post('/run', async (req, res) => {
  try {
    const { backfillDays, skipAI, skipComments } = req.body || {};
    const result = await runDiscoveryPipeline({
      backfillDays: backfillDays || 1,
      skipAI: skipAI === true,
      skipComments: skipComments === true,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Daily report ──
app.get('/report/daily', async (_req, res) => {
  try {
    // Try getting the latest saved report first
    const db = getSupabase();
    const { data: savedReport } = await db
      .from('competitor_reports')
      .select('*')
      .eq('report_type', 'daily')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (savedReport) {
      res.json(savedReport.report_data);
      return;
    }

    // Generate fresh
    const report = await generateDailyReport();
    const textReport = formatDailyReportText(report);

    // Check if they want text format
    if (_req.query.format === 'text') {
      res.type('text/plain').send(textReport);
      return;
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Weekly report ──
app.get('/report/weekly', async (_req, res) => {
  try {
    const db = getSupabase();
    const { data: savedReport } = await db
      .from('competitor_reports')
      .select('*')
      .eq('report_type', 'weekly')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (savedReport) {
      res.json(savedReport.report_data);
      return;
    }

    const report = await generateWeeklyReport();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Dashboard ──
app.get('/', async (_req, res) => {
  try {
    const status = await getMonitorStatus();
    const dailyReport = await generateDailyReport();
    const html = renderDashboard(status, dailyReport);
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${(err as Error).message}</p>`);
  }
});

// ── Start server ──
const PORT = config.port;

app.listen(PORT, () => {
  console.log(`[Server] YouTube Competitor Monitor running on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);

  // Log config status
  const missing = validateConfig();
  if (missing.length) {
    console.warn(`[Server] ⚠️ Missing config: ${missing.join(', ')}`);
  } else {
    console.log('[Server] ✅ All config present');
  }
});

// ── Cron: Daily discovery at 06:00 UTC ──
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] Starting daily discovery run...');
  try {
    const result = await runDiscoveryPipeline({ backfillDays: 1 });
    console.log(`[Cron] Daily run complete: ${result.videosDiscovered} new videos`);
  } catch (err) {
    console.error('[Cron] Daily run failed:', (err as Error).message);
  }
});

// ── Cron: Weekly report every Monday at 08:00 UTC ──
cron.schedule('0 8 * * 1', async () => {
  console.log('[Cron] Generating weekly report...');
  try {
    await generateWeeklyReport();
    console.log('[Cron] Weekly report generated');
  } catch (err) {
    console.error('[Cron] Weekly report failed:', (err as Error).message);
  }
});

export default app;

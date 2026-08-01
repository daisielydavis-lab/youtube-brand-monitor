/**
 * YouTube Competitor Placement Monitor — Express Server
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
} from './services/competitor-monitor/competitor-report';
import { getDashboardData } from './services/competitor-monitor/dashboard-data';
import { getSupabase } from './db/supabase';
import { renderDashboard } from './ui/dashboard';

const app = express();
app.use(express.json());

// ── Background scan state ──
let scanRunning = false;
let scanProgress = { phase: '', found: 0, enriched: 0, classified: 0, startedAt: '', done: false, error: '' };

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

// ── Scan Status (poll during background run) ──
app.get('/api/scan-status', (_req, res) => {
  res.json({ running: scanRunning, ...scanProgress });
});

// ── Video Action (human correction) ──
app.post('/api/videos/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // mark_organic | confirm_placement | ignore
    const db = getSupabase();

    const updates: Record<string, unknown> = { last_updated_at: new Date().toISOString() };
    if (action === 'mark_organic') {
      updates.placement_type = 'organic_mention';
      updates.sponsor_confidence = 0.1;
    } else if (action === 'confirm_placement') {
      updates.placement_type = 'confirmed_paid_placement';
      updates.sponsor_confidence = 1.0;
    } else if (action === 'ignore') {
      updates.placement_type = 'unknown';
      updates.sponsor_confidence = 0;
    }

    const { error } = await db.from('youtube_competitor_videos').update(updates).eq('video_id', id);
    if (error) throw new Error(error.message);

    res.json({ success: true, videoId: id, action });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Trigger discovery ──
// GET: browser-friendly trigger page
app.get('/run', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Scan Running</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;text-align:center}
h2{color:#38bdf8} .status{background:#1e293b;border-radius:8px;padding:20px;max-width:500px;margin:20px auto;text-align:left}
.bar{height:4px;background:#334155;border-radius:2px;overflow:hidden;margin:16px 0}
.bar-fill{height:100%;background:#38bdf8;width:0%;transition:width 0.5s}
.step{padding:4px 0;font-size:14px} .step-done{color:#22c55e} .step-active{color:#38bdf8} .step-wait{color:#64748b}
.btn{display:inline-block;margin-top:16px;padding:10px 24px;background:#1d4ed8;color:white;border-radius:6px;text-decoration:none}
</style></head><body>
<h2>🔍 YouTube Competitor Scan</h2>
<div class="status">
  <div class="step" id="s1">⏳ Discovering videos...</div>
  <div class="step" id="s2">⏳ Enriching video data...</div>
  <div class="step" id="s3">⏳ AI classification...</div>
  <div class="step" id="s4">⏳ Saving results...</div>
  <div class="bar"><div class="bar-fill" id="bar"></div></div>
  <div id="result"></div>
</div>
<a href="/" class="btn">View Dashboard</a>
<script>
async function poll() {
  try {
    const sr = await fetch('/api/scan-status').then(r=>r.json());
    const pct = sr.done ? 100 : sr.classified > 0 ? 75 : sr.enriched > 0 ? 50 : sr.found > 0 ? 25 : 5;
    document.getElementById('bar').style.width = pct+'%';
    if (sr.found > 0) { document.getElementById('s1').innerHTML='✅ Found '+sr.found+' videos'; document.getElementById('s1').className='step step-done'; }
    if (sr.enriched > 0) { document.getElementById('s2').innerHTML='✅ Enriched '+sr.enriched+' videos'; document.getElementById('s2').className='step step-done'; }
    if (sr.classified > 0) { document.getElementById('s3').innerHTML='✅ Classified '+sr.classified+' videos'; document.getElementById('s3').className='step step-done'; }
    if (sr.done) {
      document.getElementById('s4').innerHTML='✅ Done!'; document.getElementById('s4').className='step step-done';
      document.getElementById('result').innerHTML='<p>✅ Scan complete — '+sr.found+' videos processed</p>';
      return;
    }
    if (sr.error) { document.getElementById('result').innerHTML='<p style="color:#ef4444">❌ '+sr.error+'</p>'; return; }
    setTimeout(poll, 1500);
  } catch(e) { setTimeout(poll, 2000); }
}
// Start scan in background
fetch('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({backfillDays:7})})
  .then(r=>r.json()).then(d=>{ if(!d.success) document.getElementById('result').innerHTML='<p style="color:#ef4444">❌ '+d.error+'</p>'; });
setTimeout(poll, 1000);
</script></body></html>`);
});

// POST: background scan
app.post('/run', async (req, res) => {
  if (scanRunning) {
    res.json({ success: false, error: 'Scan already running' });
    return;
  }

  const { backfillDays, skipAI, skipComments } = req.body || {};
  const days = backfillDays || 7;

  // Start background scan
  scanRunning = true;
  scanProgress = { phase: 'discovery', found: 0, enriched: 0, classified: 0, startedAt: new Date().toISOString(), done: false, error: '' };

  // Return immediately
  res.json({ success: true, message: `Scan started (${days} days backfill)`, scanStatus: '/api/scan-status' });

  // Run in background
  runDiscoveryPipeline({ backfillDays: days, skipAI: skipAI === true, skipComments: skipComments === true })
    .then(result => {
      scanProgress = { ...scanProgress, phase: 'done', found: result.videosDiscovered, enriched: result.videosDiscovered, classified: result.videosClassified, done: true, error: '' };
      scanRunning = false;
      console.log(`[Scan] Background scan complete: ${result.videosDiscovered} videos`);
    })
    .catch(err => {
      scanProgress = { ...scanProgress, phase: 'error', done: true, error: err.message };
      scanRunning = false;
      console.error('[Scan] Background scan failed:', err.message);
    });
});

// ── Daily report ──
app.get('/report/daily', async (_req, res) => {
  try {
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
    const report = await generateDailyReport();
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

// ── Dashboard (main page) ──
app.get('/', async (req, res) => {
  try {
    const filter = {
      brand: (req.query.brand as string) || undefined,
      market: (req.query.market as string) || undefined,
      language: (req.query.lang as string) || undefined,
      dateRange: (req.query.range as any) || '30d',
      videoType: (req.query.type as any) || 'all',
      placementType: (req.query.placement as string) || undefined,
    };
    const data = await getDashboardData(filter);
    const html = renderDashboard(data, filter as Record<string, string>);
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${(err as Error).message}</p>`);
  }
});

// ── Start server ──
const PORT = config.port;

app.listen(PORT, () => {
  console.log(`[Server] YouTube Competitor Monitor running on port ${PORT}`);
  const missing = validateConfig();
  if (missing.length) {
    console.warn(`[Server] ⚠️ Missing config: ${missing.join(', ')}`);
  } else {
    console.log('[Server] ✅ All config present');
  }
});

// ── Cron: Daily discovery at 06:00 UTC ──
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] Starting daily discovery...');
  try {
    scanRunning = true;
    scanProgress = { phase: 'discovery', found: 0, enriched: 0, classified: 0, startedAt: new Date().toISOString(), done: false, error: '' };
    const result = await runDiscoveryPipeline({ backfillDays: 1 });
    scanProgress = { phase: 'done', found: result.videosDiscovered, enriched: result.videosDiscovered, classified: result.videosClassified, startedAt: scanProgress.startedAt, done: true, error: '' };
    scanRunning = false;
    console.log(`[Cron] Daily run complete: ${result.videosDiscovered} new videos`);
  } catch (err) {
    scanProgress = { phase: 'error', found: 0, enriched: 0, classified: 0, startedAt: '', done: true, error: (err as Error).message };
    scanRunning = false;
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

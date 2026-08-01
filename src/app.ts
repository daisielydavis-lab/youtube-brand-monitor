/**
 * YouTube Competitor Monitor v3 — Express Server
 *
 * Modes: Normal (daily) / Hotspot (every 4h) / Manual
 * Tabs: Overview / Campaigns / Videos / Creators / Comments / System
 */

import express from 'express';
import cron from 'node-cron';
import { config, validateConfig } from './config';
import { runDiscoveryPipeline, getMonitorStatus, scanState, retryClassification } from './services/competitor-monitor';
import { detectCampaigns, getCampaigns } from './services/competitor-monitor/campaign-detector';
import { generateDailyReport, generateWeeklyReport } from './services/competitor-monitor/competitor-report';
import { getDashboardData } from './services/competitor-monitor/dashboard-data';
import { getAllCreators } from './services/competitor-monitor/creator-profiler';
import { getSupabase } from './db/supabase';
import { renderDashboard } from './ui/dashboard';

const app = express();
app.use(express.json());

// ── Health ──
app.get('/health', (_req, res) => {
  res.json({ status: validateConfig().length ? 'degraded' : 'healthy', uptime: process.uptime(), scanRunning: scanState.running });
});

// ── Scan Status ──
app.get('/api/scan-status', (_req, res) => res.json(scanState));

// ── Trigger Discovery ──
app.get('/run', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Scan</title>
<style>body{font-family:-apple-system,sans-serif;background:#0b1120;color:#e2e8f0;padding:40px;text-align:center}
h2{color:#38bdf8}.s{background:#111827;border-radius:8px;padding:20px;max-width:500px;margin:20px auto;text-align:left}
.bar{height:4px;background:#1e293b;border-radius:2px;margin:16px 0}.bar-f{height:100%;background:#38bdf8;width:0%}
.step{padding:4px 0;font-size:14px}.done{color:#22c55e}.active{color:#38bdf8}
.btn{display:inline-block;margin:16px 8px 0 0;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px}
.btn-p{background:#1d4ed8;color:#fff}.btn-s{background:#1e293b;color:#94a3b8;border:1px solid #334155}
</style></head><body>
<h2>🔍 Competitor Scan</h2>
<div class="s"><div class="step active" id="s1">⏳ Running...</div>
<div class="bar"><div class="bar-f" id="bar"></div></div><div id="r"></div></div>
<a href="/" class="btn btn-p">Dashboard</a>
<script>
fetch('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'manual',backfillDays:7})}).then(r=>r.json()).then(d=>{if(d.success) poll(); else document.getElementById('r').innerHTML='<p style=color:#ef4444>❌ '+d.error+'</p>'});
function poll(){fetch('/api/scan-status').then(r=>r.json()).then(s=>{document.getElementById('bar').style.width=(s.done?100:s.videosNew>0?50:15)+'%';document.getElementById('s1').textContent=s.done?'✅ Done — '+s.videosNew+' new videos':'⏳ Scanning... discovered '+s.videosNew;if(!s.done)setTimeout(poll,2000);else document.getElementById('s1').className='step done'})}
</script></body></html>`);
});

app.post('/run', async (req, res) => {
  if (scanState.running) return res.json({ success: false, error: 'Scan already running' });
  const { backfillDays, mode, hotspotGame, skipAI } = req.body || {};
  res.json({ success: true, message: `Scan started (${mode || 'manual'})` });
  try {
    await runDiscoveryPipeline({ backfillDays: backfillDays || 7, mode: mode || 'manual', hotspotGame, skipAI });
    await detectCampaigns();
  } catch (err) { console.error('[Scan] Failed:', (err as Error).message); }
});

// ── Status ──
app.get('/status', async (_req, res) => { res.json(await getMonitorStatus()); });

// ── Campaigns ──
app.get('/api/campaigns', async (_req, res) => {
  const status = _req.query.status as string | undefined;
  res.json(await getCampaigns(status));
});

// ── Creators ──
app.get('/api/creators', async (_req, res) => {
  res.json(await getAllCreators());
});

// ── Comments ──
app.get('/api/comments', async (req, res) => {
  const db = getSupabase();
  let q = db.from('youtube_comment_insights').select('*, youtube_competitor_videos!inner(title, channel_name)').order('published_at', { ascending: false }).limit(100);
  if (req.query.intent) {
    if (req.query.intent === 'purchase') q = q.eq('has_purchase_intent', true);
    else if (req.query.intent === 'brand') q = q.eq('is_brand_related', true);
    else if (req.query.intent === 'negative') q = q.eq('sentiment', 'negative');
  }
  const { data } = await q;
  res.json(data || []);
});

// ── System ──
app.get('/api/system', async (_req, res) => {
  const status = await getMonitorStatus();
  const db = getSupabase();
  const { data: logs } = await db.from('scan_logs').select('*').order('created_at', { ascending: false }).limit(20);
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  res.json({ status, logs: logs || [], config: cfg || {} });
});

// ── Hotspot ──
app.post('/api/hotspot/start', async (req, res) => {
  const { games, brands, durationDays } = req.body || {};
  const db = getSupabase();
  const until = new Date(Date.now() + (durationDays || 7) * 86400000).toISOString();
  await db.from('monitor_config').update({
    hotspot_active: true, hotspot_games: games || [], hotspot_brands: brands || ['GearUP','ExitLag','LagZapper'],
    hotspot_active_until: until, hotspot_started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', 1);
  res.json({ success: true, activeUntil: until });
});

// ── Retry AI Classification (no search, no channel scan) ──
app.post('/api/monitor/retry-classification', async (_req, res) => {
  if (scanState.running) return res.json({ success: false, error: 'Scan already running' });
  res.json({ success: true, message: 'Retry classification started' });
  try { await retryClassification(); } catch (err) { console.error('[Retry] Failed:', (err as Error).message); }
});

app.post('/api/hotspot/stop', async (_req, res) => {
  await getSupabase().from('monitor_config').update({ hotspot_active: false, updated_at: new Date().toISOString() }).eq('id', 1);
  res.json({ success: true });
});

// ── Video Action ──
app.post('/api/videos/:id/action', async (req, res) => {
  const { action } = req.body;
  const updates: Record<string, unknown> = {};
  if (action === 'mark_organic') { updates.placement_type = 'organic_mention'; updates.sponsor_confidence = 0.1; }
  else if (action === 'confirm_placement') { updates.placement_type = 'confirmed_paid_placement'; updates.sponsor_confidence = 1.0; }
  else if (action === 'ignore') { updates.placement_type = 'unknown'; updates.sponsor_confidence = 0; }
  updates.workflow_status = action === 'confirm_placement' ? 'confirmed' : 'needs_review';
  updates.last_updated_at = new Date().toISOString();

  const { error } = await getSupabase().from('youtube_competitor_videos').update(updates).eq('video_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Dashboard ──
app.get('/', async (req, res) => {
  try {
    const filter = {
      brand: req.query.brand as string, market: req.query.market as string,
      language: req.query.lang as string, dateRange: (req.query.range as any) || '30d',
      videoType: (req.query.type as any) || 'all', placementType: req.query.placement as string,
    };
    const data = await getDashboardData(filter);
    const campaigns = await getCampaigns('active');
    const sysStatus = await getMonitorStatus();
    const html = renderDashboard(data, filter, campaigns, sysStatus);
    res.type('html').send(html);
  } catch (err) { res.status(500).send(`<h1>Error</h1><p>${(err as Error).message}</p>`); }
});

// ── Reports ──
app.get('/report/daily', async (_req, res) => {
  const db = getSupabase();
  const { data: saved } = await db.from('competitor_reports').select('*').eq('report_type','daily').order('created_at',{ascending:false}).limit(1).maybeSingle();
  res.json(saved?.report_data || await generateDailyReport());
});
app.get('/report/weekly', async (_req, res) => {
  const db = getSupabase();
  const { data: saved } = await db.from('competitor_reports').select('*').eq('report_type','weekly').order('created_at',{ascending:false}).limit(1).maybeSingle();
  res.json(saved?.report_data || await generateWeeklyReport());
});

// ── Start ──
app.listen(config.port, () => {
  console.log(`[Server] v3 running on port ${config.port}`);
  console.log(`[Server] ${validateConfig().length ? '⚠️ Missing config' : '✅ All config present'}`);
});

// ── Cron: Normal daily at 06:00 UTC ──
cron.schedule('0 6 * * *', async () => {
  console.log('[Cron] Normal daily scan');
  try {
    await runDiscoveryPipeline({ mode: 'normal' });
    await detectCampaigns();
  } catch (err) { console.error('[Cron] Daily failed:', (err as Error).message); }
});

// ── Cron: Hotspot every 4h ──
cron.schedule('0 */4 * * *', async () => {
  const db = getSupabase();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  const c = cfg as any;
  if (!c?.hotspot_active) return;

  const until = new Date(c.hotspot_active_until).getTime();
  if (Date.now() > until) {
    await db.from('monitor_config').update({ hotspot_active: false, updated_at: new Date().toISOString() }).eq('id', 1);
    console.log('[Cron] Hotspot expired — deactivated');
    return;
  }

  console.log('[Cron] Hotspot scan');
  const games = c.hotspot_games || [];
  for (const game of games) {
    try { await runDiscoveryPipeline({ mode: 'hotspot', hotspotGame: game }); }
    catch (err) { console.error(`[Cron] Hotspot failed for ${game}:`, (err as Error).message); }
  }
  await detectCampaigns();
});

// ── Cron: Weekly report Monday 08:00 ──
cron.schedule('0 8 * * 1', async () => {
  try { await generateWeeklyReport(); console.log('[Cron] Weekly report done'); }
  catch (err) { console.error('[Cron] Weekly failed:', (err as Error).message); }
});

export default app;

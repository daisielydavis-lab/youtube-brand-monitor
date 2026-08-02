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
import { renderDashboard, renderDashboardShell } from './ui/dashboard';

const app = express();
app.use(express.json());

// ── Health (no DB, instant response) ──
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── Health (with config check) ──
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
// GET: browser-friendly. POST: JSON. Query param: ?limit=N (default 50)
app.all('/api/monitor/retry-classification', async (req, res) => {
  if (scanState.running) return res.json({ success: false, error: 'Scan already running' });
  const limit = parseInt((req.query?.limit as string) || (req.body?.limit) || '50', 10);
  res.json({ success: true, message: `Retry classification started (limit=${limit})` });
  try { await retryClassification(limit); } catch (err) { console.error('[Retry] Failed:', (err as Error).message); }
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

// ── Shared dashboard query (used by both / and /api/dashboard) ──
async function queryDashboardData(rangeDays: number) {
  const since = new Date(Date.now() - rangeDays * 86400000).toISOString();
  const db = getSupabase();

  const { data: videos, error: vidErr } = await Promise.race([
    db.from('youtube_competitor_videos')
      .select('video_id,title,channel_id,channel_name,published_at,is_short,thumbnail_url,game_name,content_type,placement_type,sponsor_confidence,topic_category,promo_code,view_count,like_count,comment_count,classification_raw,workflow_status,first_seen_at')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .limit(500),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000)),
  ]);

  if (!videos || !videos.length) {
    return { hasData: false as const, kpis: {} as any, brands: [], games: [], themes: [], creators: [], recentVideos: [], scanStatus: {} as any };
  }

  const brandMap = new Map<string, { count: number; creators: Set<string> }>();
  const gameMap = new Map<string, number>();
  const themeMap = new Map<string, number>();
  let highConf = 0;
  const creators = new Set<string>();

  for (const v of videos) {
    const brand = v.classification_raw?.sponsorship?.detectedBrand || 'unknown';
    if (!brandMap.has(brand)) brandMap.set(brand, { count: 0, creators: new Set() });
    const b = brandMap.get(brand)!; b.count++; b.creators.add(v.channel_id);
    const game = v.game_name || 'uncategorized';
    gameMap.set(game, (gameMap.get(game) || 0) + 1);
    const theme = v.topic_category || 'uncategorized';
    themeMap.set(theme, (themeMap.get(theme) || 0) + 1);
    if (v.placement_type === 'confirmed_paid_placement' || v.placement_type === 'likely_sponsored') highConf++;
    creators.add(v.channel_id);
  }

  const kpis = {
    newPlacements: videos.filter(v => new Date(v.first_seen_at!) >= new Date(Date.now() - rangeDays * 86400000)).length,
    activeCreators: creators.size,
    videosMonitored: videos.length,
    highConfidence: highConf,
  };

  const brandComparison = [...brandMap.entries()].map(([name, d]) => ({
    brandName: name, newVideos: d.count, creators: d.creators.size, topGame: '', topMarket: '', median7dViews: 0,
  }));

  const topGames = [...gameMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([game, count]) => ({
    game, videoCount: count, estimatedReach: 0, brands: {} as Record<string, number>,
  }));

  const topThemes = [...themeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topic, count]) => ({
    topic, videoCount: count, brands: {} as Record<string, number>,
  }));

  const recentVideos = videos.slice(0, 20).map(v => ({
    videoId: v.video_id, title: v.title, thumbnailUrl: v.thumbnail_url, channelName: v.channel_name,
    brand: v.classification_raw?.sponsorship?.detectedBrand || 'unknown', game: v.game_name || 'unknown',
    publishedAt: v.published_at, viewCount: v.view_count || 0,
    placementType: v.placement_type || 'unknown', sponsorConfidence: v.sponsor_confidence || 0,
    discoveryEvidence: [] as string[], promoCode: v.promo_code || null,
    growth24h: null, growth72h: null,
  }));

  return {
    hasData: true as const, kpis, brandComparison, topGames, topThemes, topCreators: [] as any[],
    recentVideos, scanStatus: { lastScanAt: null, nextScanAt: 'Tomorrow 06:00 UTC', totalVideos: videos.length, totalCreators: creators.size, queriesActive: 6 },
  };
}

// ── Dashboard (server-rendered, each sub-query safe-isolated) ──
app.get('/', async (_req, res) => {
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[Dashboard:${requestId}] Request started`);

  try {
    // Step 1: Query video data (critical)
    const data = await queryDashboardData(30);
    console.log(`[Dashboard:${requestId}] Step1 videos done: hasData=${data.hasData}`);

    // Step 2: Campaigns (non-critical, safe-fail)
    let campaigns: any[] = [];
    try {
      const { data: c } = await getSupabase().from('campaigns').select('*').eq('status', 'active').order('detected_at', { ascending: false }).limit(10);
      campaigns = c || [];
    } catch (e) { console.warn(`[Dashboard:${requestId}] Campaigns query skipped: ${(e as Error).message}`); }

    // Step 3: Status (non-critical, safe-fail)
    let status: any = {};
    try {
      status = await getMonitorStatus();
    } catch (e) { console.warn(`[Dashboard:${requestId}] Status query skipped: ${(e as Error).message}`); }

    console.log(`[Dashboard:${requestId}] Rendering HTML...`);

    const html = renderDashboard({
      hasData: data.hasData,
      scanStatus: data.scanStatus,
      kpi: data.kpis,
      brandComparison: data.brandComparison || [],
      topGames: data.topGames || [],
      topThemes: data.topThemes || [],
      topCreators: data.topCreators || [],
      recentVideos: data.recentVideos || [],
      anomalies: [],
    }, {}, campaigns, { ...status, creatorProfiles: [] });

    console.log(`[Dashboard:${requestId}] Done: ${data.recentVideos.length} videos, HTML=${html.length}chars, totalMs: ${Date.now() - startedAt}`);
    res.type('html').send(html);
  } catch (err) {
    console.error(`[Dashboard:${requestId}] FATAL: ${(err as Error).message}, ms: ${Date.now() - startedAt}`);
    // Minimal fallback — no JS, no auto-reload
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor Monitor</title>
<style>body{font-family:-apple-system,sans-serif;background:#f3f6fb;color:#46546c;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:500px;box-shadow:0 8px 30px rgba(0,0,0,0.08)}
h2{color:#14213d;margin-bottom:8px}p{color:#5f6f89;margin-bottom:20px}
a{display:inline-block;padding:10px 24px;background:#3568e8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}
a:hover{background:#2857cf}</style></head><body>
<div class="card"><h2>Unable to load dashboard</h2><p>Server encountered an error: ${(err as Error).message}</p>
<a href="/">Retry</a> &nbsp; <a href="/api/dashboard">Check API</a></div></body></html>`);
  }
});

// ── API: Dashboard data (JSON, for client-side filtering + shell fallback) ──
app.get('/api/dashboard', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();
  console.log(`[Dashboard:${requestId}] Request started`);

  try {
    const rangeDays = parseInt((req.query.range as string) || '30', 10);
    const data = await queryDashboardData(rangeDays);

    if (!data.hasData) {
      return res.json({ ok: true, hasData: false, kpis: {}, brands: [], games: [], themes: [], creators: [], recentVideos: [], scanStatus: {} });
    }

    console.log(`[Dashboard:${requestId}] Done: ${data.recentVideos.length} videos, ${data.scanStatus.totalCreators} creators, ${data.kpis.highConfidence} high-conf, totalMs: ${Date.now() - startedAt}`);

    return res.json({ ok: true, ...data, totalMs: Date.now() - startedAt });
  } catch (err) {
    console.error(`[Dashboard:${requestId}] Failed: ${(err as Error).message}, ms: ${Date.now() - startedAt}`);
    res.status(503).json({ ok: false, hasData: false, error: 'Dashboard query timed out. Data is safe — please retry.' });
  }
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
const PORT = Number(process.env.PORT || config.port || 3001);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT}`);
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

/**
 * YouTube Competitor Monitor v3 — Express Server
 *
 * Modes: Normal (daily) / Hotspot (every 4h) / Manual
 * Tabs: Overview / Campaigns / Videos / Creators / Comments / System
 */

import express from 'express';
import cron from 'node-cron';
import { config, validateConfig } from './config';
import { runDiscoveryPipeline, getMonitorStatus, scanState, retryClassification, refreshPerformanceData } from './services/competitor-monitor';
import { detectCampaigns } from './services/competitor-monitor/campaign-detector';
import { generateDailyReport, generateWeeklyReport, generateQuarterlyReport } from './services/competitor-monitor/competitor-report';
import { getCreatorsFromVideos } from './services/competitor-monitor/creator-profiler';
import { analyzePendingComments } from './services/competitor-monitor/topic-classifier';
import { marketMatches, resolveBrand, resolveGame, resolveMarket, COMPETITOR_BRANDS, filterCompetitorPlacements, filterUnresolvedCandidates, needsAIVerification, isCompetitorPlacement } from './services/competitor-monitor/data-scope';
import { getSupabase } from './db/supabase';
import { renderDashboard } from './ui/dashboard';

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

// ── Campaigns (Stage ⑧: 运行时聚合 — Scope 内 placements 分簇, 不读历史表) ──
app.get('/api/campaigns', async (req, res) => {
  const rangeDays = parseInt((req.query.range as string) || '7', 10);
  const data = await queryDashboardData(rangeDays, req.query.brand as string, req.query.market as string);
  res.json(data.hasData ? ((data as any).campaignClusters || []) : []);
});

// ── Creators (Layer 3 — Scope 内 competitor placements GROUP BY creator) ──
app.get('/api/creators', async (req, res) => {
  const rangeDays = parseInt((req.query.range as string) || '7', 10);
  const showAll = req.query.all === '1';
  res.json(await getCreatorsFromVideos({
    rangeDays,
    brand: req.query.brand as string,
    market: req.query.market as string,
    competitorOnly: !showAll,
  }));
});

// ── Comments ──
// youtube_comment_insights.video_id has NO foreign key, so PostgREST's
// `youtube_competitor_videos!inner(...)` join silently returns nothing.
// Manual join instead: fetch comments, then attach video title/channel.
async function attachVideoInfo(db: any, comments: any[]): Promise<any[]> {
  if (!comments?.length) return [];
  const ids = [...new Set(comments.map(c => c.video_id))];
  const { data: vids } = await db.from('youtube_competitor_videos').select('video_id,title,channel_name').in('video_id', ids);
  const map = new Map((vids || []).map((v: any) => [v.video_id, v]));
  return comments.map(c => ({ ...c, youtube_competitor_videos: map.get(c.video_id) || null }));
}

// PostgREST in() 数组会拼成超长 URL (310 个 video_id ≈ 6.5KB) — Railway 代理
// 会拒绝, 查询静默返回 null → 误触发 fallback。必须分批查询 (每批 ≤100 个 ID)。
async function fetchCommentsInChunks(db: any, ids: string[], cols: string, limitPerQuery = 500, applyFilter?: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let q = db.from('youtube_comment_insights').select(cols).in('video_id', chunk).limit(limitPerQuery);
    if (applyFilter) q = applyFilter(q);
    const { data } = await q;
    if (data) out.push(...data);
  }
  return out;
}

app.get('/api/comments', async (req, res) => {
  const db = getSupabase();

  // Stage ⑧: Comments 母集 = Current Scope 内 competitor placement videos
  // (range + brand + market), 与 Overview/Videos 同一事实表口径。
  const rangeDays = parseInt((req.query.range as string) || '7', 10);
  const brandFilter = req.query.brand as string | undefined;
  const marketFilter = req.query.market as string | undefined;
  const since = new Date(Date.now() - rangeDays * 86400000).toISOString();

  // Get competitor placement video IDs (paged — 90d 窗口可超 1000 条),
  // post-filtered by Scope (isCompetitorPlacement + brand + market)
  const cpVids: any[] = [];
  for (let from = 0; from < 5000; from += 999) {
    const { data } = await db.from('youtube_competitor_videos')
      // 必须含 isCompetitorPlacement 依赖的全部字段 (placement_type/has_paid_placement_tag)
      .select('video_id, classification_raw, market, placement_type, has_paid_placement_tag')
      .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
      .gte('published_at', since)
      .order('video_id', { ascending: true })
      .range(from, from + 999);
    if (!data?.length) break;
    cpVids.push(...data);
    if (data.length < 1000) break;
  }
  let competitorVideoIds = (cpVids || [])
    .filter((v: any) => isCompetitorPlacement(v))
    .filter((v: any) => !brandFilter || brandFilter === 'all' || resolveBrand(v) === brandFilter)
    .filter((v: any) => marketMatches(v, marketFilter))
    .map((v: any) => v.video_id);

  // Stage ③ fallback: no competitor-specific comments this window — show
  // comments from analyzed candidate videos instead (workflow_status=classified).
  // 候选视频评论不计入正式竞品统计, UI 必须明确标记。
  let fallback = false;
  const fetchCandidateVids = async () => {
    const { data: candVids } = await db.from('youtube_competitor_videos')
      .select('video_id, market')
      .eq('workflow_status', 'classified')
      .gte('published_at', since)
      .limit(200);
    return (candVids || [])
      .filter((v: any) => marketMatches(v, marketFilter))
      .map((v: any) => v.video_id);
  };

  if (!competitorVideoIds.length) {
    fallback = true;
    competitorVideoIds = await fetchCandidateVids();
  }

  if (!competitorVideoIds.length) return res.json([]);

  const intentFilter = (q: any) => {
    if (req.query.intent === 'purchase') return q.eq('has_purchase_intent', true);
    if (req.query.intent === 'brand') return q.eq('is_brand_related', true);
    if (req.query.intent === 'negative') return q.eq('sentiment', 'negative');
    return q;
  };
  // 分批 in() 查询 + 排序合并 (最近在前)
  let data = (await fetchCommentsInChunks(db, competitorVideoIds, '*', 100, intentFilter))
    .sort((a: any, b: any) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
    .slice(0, 100);

  // Placements exist but none of their comments were analyzed — fall back too.
  if (!data?.length && !fallback) {
    fallback = true;
    competitorVideoIds = await fetchCandidateVids();
    if (competitorVideoIds.length) {
      data = (await fetchCommentsInChunks(db, competitorVideoIds, '*', 100, intentFilter))
        .sort((a: any, b: any) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
        .slice(0, 100);
    }
  }
  res.set('X-Comments-Fallback', fallback ? '1' : '0');
  res.json(await attachVideoInfo(db, data || []));
});

// ── Comments Summary (Layer 3 — only competitor placement comments) ──
app.get('/api/comments/summary', async (req, res) => {
  const db = getSupabase();
  // Stage ⑧: 与 /api/comments 同一 Scope — 顶部 range/brand/market 控制。
  // 之前硬编码 7 天 + 裸 placement 过滤, 与 Overview 窗口不一致。
  const rangeDays = parseInt((req.query.range as string) || '7', 10);
  const brandFilter = req.query.brand as string | undefined;
  const marketFilter = req.query.market as string | undefined;
  const since = new Date(Date.now() - rangeDays * 86400000).toISOString();

  // Get competitor placement video IDs (paged), post-filtered by Scope.
  // 母集严格 = isCompetitorPlacement (brand + placement_type + AI 已验证),
  // 与 Overview 的 competitorPlacements 同源, placementTotal 必然对账。
  const cpVids: any[] = [];
  for (let from = 0; from < 5000; from += 999) {
    const { data } = await db.from('youtube_competitor_videos')
      // 必须含 isCompetitorPlacement 依赖的全部字段 (placement_type/has_paid_placement_tag)
      .select('video_id, classification_raw, market, placement_type, has_paid_placement_tag')
      .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
      .gte('published_at', since)
      .order('video_id', { ascending: true })
      .range(from, from + 999);
    if (!data?.length) break;
    cpVids.push(...data);
    if (data.length < 1000) break;
  }
  let competitorVideoIds = (cpVids || [])
    .filter(isCompetitorPlacement)
    .filter((v: any) => !brandFilter || brandFilter === 'all' || resolveBrand(v) === brandFilter)
    .filter((v: any) => marketMatches(v, marketFilter))
    .map((v: any) => v.video_id);
  // Stage ⑧: placementTotal 始终 = Current Scope 内投放视频数。
  // fallback 只换评论数据来源 (候选视频), 绝不覆盖口径数字。
  const scopePlacementTotal = competitorVideoIds.length;

  // Stage ③ fallback: if there are no competitor placement videos OR they
  // have no analyzed comments, show comments from analyzed candidate videos
  // (workflow_status=classified) and flag fallback=true so the UI can say so.
  let fallback = false;
  const fetchCandidateVids = async () => {
    const { data: candVids } = await db.from('youtube_competitor_videos')
      .select('video_id, market')
      .eq('workflow_status', 'classified')
      .gte('published_at', since)
      .limit(200);
    return (candVids || [])
      .filter((v: any) => marketMatches(v, marketFilter))
      .map((v: any) => v.video_id);
  };

  if (!competitorVideoIds.length) {
    fallback = true;
    competitorVideoIds = await fetchCandidateVids();
  }

  // NOTE: build `empty` lazily — fallback may flip true later and the object is const.
  if (!competitorVideoIds.length) return res.json({ total: 0, purchaseIntentRate: 0, brandRelatedRate: 0, sentiment: {}, topVideos: [], fallback, placementTotal: scopePlacementTotal });

  const cols = 'has_purchase_intent,is_brand_related,sentiment,comment_category,video_id,author_name,comment_text';
  let comments = await fetchCommentsInChunks(db, competitorVideoIds, cols, 500);

  // Placements exist but none of their comments were analyzed — fall back too.
  if (!comments?.length && !fallback) {
    fallback = true;
    competitorVideoIds = await fetchCandidateVids();
    if (competitorVideoIds.length) comments = await fetchCommentsInChunks(db, competitorVideoIds, cols, 500);
  }
  if (!comments?.length) return res.json({ total: 0, purchaseIntentRate: 0, brandRelatedRate: 0, sentiment: {}, topVideos: [], signals: [], placementCoverage: 0, placementTotal: scopePlacementTotal, fallback });

  const total = comments.length;
  const purchaseIntent = comments.filter((c: any) => c.has_purchase_intent).length;
  const brandRelated = comments.filter((c: any) => c.is_brand_related).length;
  const productQuestions = comments.filter((c: any) => c.comment_category === 'question').length;
  const positiveFeedback = comments.filter((c: any) => c.comment_category === 'praise').length;
  const negativeConcern = comments.filter((c: any) => c.comment_category === 'complaint').length;
  const sentiment: Record<string, number> = {};
  comments.forEach((c: any) => {
    const s = c.sentiment || 'neutral';
    sentiment[s] = (sentiment[s] || 0) + 1;
  });

  // ── Top Audience Signals (Stage ⑤): the actual comments that show intent ──
  const signalComments = comments.filter((c: any) => c.is_brand_related || c.has_purchase_intent || c.comment_category === 'question' || c.comment_category === 'complaint');
  const signalVids = [...new Set(signalComments.map((c: any) => c.video_id))];
  const { data: sigVids } = await db.from('youtube_competitor_videos').select('video_id,title').in('video_id', signalVids.slice(0, 100));
  const sigTitleMap = new Map((sigVids || []).map((v: any) => [v.video_id, v.title]));
  const topSignals = signalComments.slice(0, 8).map((c: any) => ({
    text: (c.comment_text || '').slice(0, 140),
    author: c.author_name || '?',
    videoTitle: sigTitleMap.get(c.video_id) || '?',
    flags: {
      brand: !!c.is_brand_related,
      intent: !!c.has_purchase_intent,
      question: c.comment_category === 'question',
      concern: c.comment_category === 'complaint',
    },
  }));

  // Top discussed videos
  const videoMap = new Map<string, number>();
  comments.forEach((c: any) => { videoMap.set(c.video_id, (videoMap.get(c.video_id) || 0) + 1); });
  const topVideoIds = [...videoMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);

  // Fetch video titles for top videos
  const { data: topVids } = await db.from('youtube_competitor_videos').select('video_id,title,channel_name').in('video_id', topVideoIds);
  const titleMap = new Map((topVids || []).map((v: any) => [v.video_id, { title: v.title, channelName: v.channel_name }]));
  const topVideos = topVideoIds.map(id => ({
    videoId: id,
    title: titleMap.get(id)?.title || '?',
    channelName: titleMap.get(id)?.channelName || '?',
    commentCount: videoMap.get(id) || 0,
  }));

  res.json({
    total,
    brandMentions: brandRelated,
    productQuestions,
    purchaseIntent,
    positiveFeedback,
    negativeConcern,
    sentiment,
    topVideos,
    topSignals,
    placementCoverage: videoMap.size,            // how many placement videos these comments come from
    placementTotal: scopePlacementTotal,         // Scope 内投放视频数 (fallback 不覆盖)
    fallback, // Stage ③: true = showing comments from analyzed candidates, not competitor placements
  });
});

// ── System ──
// ── Markets 列表（顶部市场筛选器动态数据源）──
app.get('/api/markets', async (_req: any, res: any) => {
  try {
    const db = getSupabase();
    const { data } = await db.from('youtube_competitor_videos').select('market');
    const counts: Record<string, number> = {};
    let none = 0;
    for (const v of (data || []) as any[]) {
      const m = (v.market as string) || '';
      if (!m) { none++; continue; }
      for (const part of m.split('|')) {
        const k = part.trim();
        if (k && k !== 'Unknown') counts[k] = (counts[k] || 0) + 1;
      }
    }
    const MKT_ZH: Record<string, string> = { US: '美国', RU: '俄罗斯', BR: '巴西', UA: '乌克兰', GE: '格鲁吉亚', CN: '中国', KR: '韩国', JP: '日本', LATAM: '拉美' };
    const list = Object.entries(counts)
      .map(([code, count]) => ({ code, label: MKT_ZH[code] || code, count }))
      .sort((a, b) => b.count - a.count);
    if (none > 0) list.push({ code: '__none__', label: '未识别', count: none });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
app.get('/api/system', async (_req, res) => {
  const status = await getMonitorStatus();
  const db = getSupabase();
  const { data: logs } = await db.from('scan_logs').select('*').order('created_at', { ascending: false }).limit(20);
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  res.json({ status, logs: logs || [], config: cfg || {} });
});

// ── Hotspot ──
// ── Admin: PIN 验证（无登录系统，轻量门禁）──
const ADMIN_PIN = process.env.ADMIN_PIN || 'ytadmin2026';
app.post('/api/admin/verify', async (req, res) => {
  const { pin } = req.body || {};
  if (pin === ADMIN_PIN) { res.json({ ok: true }); return; }
  res.status(401).json({ ok: false });
});

// ── Admin: 立即消化 AI Review Queue（limit<=0 = 全量）──
app.post('/api/admin/ai-retry', async (req, res) => {
  const { pin, limit } = req.body || {};
  if (pin !== ADMIN_PIN) { res.status(401).json({ ok: false, error: '未授权' }); return; }
  try {
    const n = parseInt(String(limit ?? 0), 10) || 0;
    const r = await retryClassification(n <= 0 ? 0 : n);
    res.json({ ok: true, classified: r.classified, remaining: r.remaining });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

// ── Admin: 立即执行 Performance Refresh（T+3/T+7）──
app.post('/api/admin/perf-refresh', async (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) { res.status(401).json({ ok: false, error: '未授权' }); return; }
  try {
    const r = await refreshPerformanceData();
    res.json({ ok: true, ...r });
  } catch (err) { res.status(500).json({ ok: false, error: (err as Error).message }); }
});

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

// ── Process AI Priority Queue (rules-first, AI only for deferred) ──
app.all('/api/monitor/process-ai-queue', async (req, res) => {
  if (scanState.running) return res.json({ success: false, error: 'Scan already running' });
  const limit = parseInt((req.query?.limit as string) || (req.body?.limit) || '50', 10);
  res.json({ success: true, message: `AI queue processing started (limit=${limit})` });
  try { await retryClassification(limit); } catch (err) { console.error('[Queue] Failed:', (err as Error).message); }
});

// ── Analyze pending comments (Audience Signals) ──
// GET /api/comments/analyze?limit=N — classify comment_category/brand/intent
// for comments missing AI labels. One flash call per video (≤20 comments).
app.all('/api/comments/analyze', async (req, res) => {
  if (scanState.running) return res.json({ success: false, error: 'Scan already running' });
  const limit = parseInt((req.query?.limit as string) || (req.body?.limit) || '10', 10);
  res.json({ success: true, message: `Comment analysis started (limit=${limit})` });
  try { await analyzePendingComments(limit); } catch (err) { console.error('[Comments] Analyze failed:', (err as Error).message); }
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

// ── Scope Resolver (Stage ⑧ 口径收口) ──
// 顶部 [竞品] + [市场] + [时间范围] 形成唯一 Current Scope。
// 所有业务页(总览/投放项目/投放视频/投放博主/观众信号)只允许从 Scope 内
// competitorPlacements 往下聚合 —— Campaigns 由 Scope 内 placements 运行时
// 聚合(brand+game 7 天滚动分簇), 不再读历史 campaigns 表。System 页除外。
// 硬性等式(全站对账):
//   campaignPlacements + standalonePlacements = competitorPlacements
//   activeCampaigns = Campaign 页返回的项目数
export interface ScopeCampaign {
  id: string;
  brand: string;
  game: string;
  cluster_type: string;
  video_count: number;
  creator_count: number;
  primary_selling_point: string;
  primary_market: string;
  total_estimated_views: number;
  status: 'active' | 'cooling' | 'ended';
  active_from: string;
  active_to: string;
  last_placement_at: string;
  moveScore: number;
}

function topOf(arr: any[], key: (x: any) => string): string {
  const m = new Map<string, number>();
  for (const x of arr) m.set(key(x), (m.get(key(x)) || 0) + 1);
  let best = '', bestN = 0;
  for (const [k, n] of m) if (n > bestN) { bestN = n; best = k; }
  return best;
}

function clusterScopeCampaigns(placements: any[], rangeDays: number): { campaigns: ScopeCampaign[]; campaignPlacements: number; standalonePlacements: number } {
  const now = Date.now();
  // 1. 按 brand+game 分簇, 7 天滚动窗口 (与 detectCampaigns 聚类一致)
  const groups: { brand: string; game: string; vids: any[] }[] = [];
  for (const v of placements) {
    const b = resolveBrand(v);
    const g = resolveGame(v);
    let matched = false;
    for (const grp of groups) {
      if (grp.brand !== b || grp.game !== g) continue;
      const head = new Date(grp.vids[0].published_at).getTime();
      if (Math.abs(new Date(v.published_at).getTime() - head) < 7 * 86400000) { grp.vids.push(v); matched = true; break; }
    }
    if (!matched) groups.push({ brand: b, game: g, vids: [v] });
  }
  // 2. ≥2 条 → 项目; 单条 → 独立投放。分簇是 placements 的划分,
  //    所以 campaignPlacements + standalonePlacements 恒等于 placements 总数
  const clusters = groups.filter(g => g.vids.length >= 2);
  const standalonePlacements = placements.length - clusters.reduce((s, g) => s + g.vids.length, 0);
  const campaignPlacements = placements.length - standalonePlacements;
  // 3. 项目卡片字段 + Move Score (新近 × 博主数 × 视频数 × 播放 × 多创作者加权)
  const campaigns: ScopeCampaign[] = clusters.map(g => {
    const ts = g.vids.map(v => new Date(v.published_at).getTime());
    const last = new Date(Math.max(...ts)).toISOString();
    const creators = new Set(g.vids.map(v => v.channel_id));
    const hours = (now - new Date(last).getTime()) / 3600000;
    const status: ScopeCampaign['status'] = hours <= 72 ? 'active' : hours <= 168 ? 'cooling' : 'ended';
    const creatorsN = creators.size;
    const videosN = g.vids.length;
    const views = g.vids.reduce((s, v) => s + (v.view_count || 0), 0);
    const recency = Math.max(0, 1 - (now - new Date(last).getTime()) / 86400000 / Math.max(rangeDays, 7));
    const moveScore = Math.round(recency * (0.5 + creatorsN) * (0.5 + videosN) * Math.log10(10 + views) * (creatorsN >= 2 ? 1.5 : 1) * 100) / 100;
    return {
      id: `scope-${g.brand}-${g.game}-${new Date(Math.min(...ts)).toISOString().slice(0, 10)}`,
      brand: g.brand,
      game: g.game,
      cluster_type: creatorsN >= 2 ? 'multi_creator_campaign' : 'creator_series',
      video_count: videosN,
      creator_count: creatorsN,
      primary_selling_point: topOf(g.vids, (v: any) => v.topic_category || 'other'),
      primary_market: topOf(g.vids, (v: any) => resolveMarket(v) || 'Unknown'),
      total_estimated_views: views,
      status,
      active_from: new Date(Math.min(...ts)).toISOString().slice(0, 10),
      active_to: new Date(Math.max(...ts)).toISOString().slice(0, 10),
      last_placement_at: last,
      moveScore,
    };
  }).sort((a, b) => b.moveScore - a.moveScore);
  return { campaigns, campaignPlacements, standalonePlacements };
}

// ── Shared dashboard query (used by both / and /api/dashboard) ──
// 3-layer data model: all analytics derived from Layer 3 (Competitor Placements)
async function queryDashboardData(rangeDays: number, brandFilter?: string, marketFilter?: string) {
  const since = new Date(Date.now() - rangeDays * 86400000).toISOString();
  const db = getSupabase();

  // ── Layer 1: Fetch ALL discovered videos in time window (paged — REST caps at 1000/query) ──
  const videos: any[] = [];
  let vidErr: Error | null = null;
  const cols = 'video_id,title,channel_id,channel_name,published_at,is_short,thumbnail_url,game_name,content_type,placement_type,sponsor_confidence,topic_category,promo_code,view_count,like_count,comment_count,classification_raw,workflow_status,first_seen_at,market,language,campaign_id';
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select(cols)
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .range(from, from + 999);
    if (error) { vidErr = error as any; break; }
    if (!data?.length) break;
    videos.push(...data);
    if (data.length < 1000) break;
  }

  console.log(`[Dashboard] rangeDays=${rangeDays} since=${since} videos=${videos?.length || 0} err=${vidErr?.message || 'none'}`);

  if (vidErr) {
    console.error(`[Dashboard] Query error: code=${(vidErr as any).code} msg=${vidErr.message} details=${(vidErr as any).details}`);
  }

  if (!videos || !videos.length) {
    return { hasData: false as const, kpis: {} as any, brands: [], games: [], themes: [], creators: [], recentVideos: [], scanStatus: {} as any };
  }

  // ── Layer 1 counts ──
  const { count: totalVideosInRange } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).gte('published_at', since);
  const totalInRange = totalVideosInRange ?? 0;

  // ── Layer 2: Classified coverage ──
  const { count: classifiedInRange } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).gte('published_at', since).or('workflow_status.eq.rule_classified,workflow_status.eq.classified');
  const totalAnalyzed = classifiedInRange ?? 0;
  const coveragePct = totalInRange > 0 ? Math.round((totalAnalyzed / totalInRange) * 100) : 0;

  // ── Layer 3: Competitor Placements (brand ∈ valid AND placement ∈ confirmed/likely) ──
  // Stage ⑦: 品牌/市场筛选 = Analytics 层 (只重聚合 DB, 不触发抓取)
  let competitorPlacements = filterCompetitorPlacements(videos);
  const unresolvedCandidates = filterUnresolvedCandidates(videos);
  if (brandFilter && brandFilter !== 'all') {
    competitorPlacements = competitorPlacements.filter(v => resolveBrand(v) === brandFilter);
  }
  if (marketFilter && marketFilter !== 'all') {
    competitorPlacements = competitorPlacements.filter(v => marketMatches(v, marketFilter));
  }

  // All discovered unique creators in window
  const allCreators = new Set(videos.map(v => v.channel_id));

  // ── Active Competitor Creators (Layer 3 only) ──
  const activeCreators = new Set(competitorPlacements.map(v => v.channel_id));

  // ── New Competitor Creators: first_seen_at within 7 days AND is a competitor placement ──
  // Use same time window + Layer 3 eligibility
  const newCreatorIds = new Set(
    competitorPlacements
      .filter(v => v.first_seen_at && new Date(v.first_seen_at).getTime() > Date.now() - 7 * 86400000)
      .map(v => v.channel_id)
  );

  // ── Brand Breakdown: only from Layer 3 placements ──
  const brandMap = new Map<string, { count: number; creators: Set<string>; markets: Map<string, number>; totalViews: number }>();
  for (const name of COMPETITOR_BRANDS) {
    brandMap.set(name, { count: 0, creators: new Set(), markets: new Map(), totalViews: 0 });
  }

  for (const v of competitorPlacements) {
    const brand = resolveBrand(v);
    if (!brandMap.has(brand)) continue; // skip non-competitor
    const b = brandMap.get(brand)!;
    b.count++;
    b.creators.add(v.channel_id);
    b.totalViews += v.view_count || 0;
    const mkt = resolveMarket(v);
    b.markets.set(mkt, (b.markets.get(mkt) || 0) + 1);
  }

  const brandComparison = [...brandMap.entries()].map(([name, d]) => ({
    brandName: name, newVideos: d.count, creators: d.creators.size,
    topGame: '', topMarket: [...d.markets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown',
    median7dViews: d.count > 0 ? Math.round(d.totalViews / d.count) : 0,
  }));

  // ── Top Games: only from Layer 3 placements ──
  const gameMap = new Map<string, { count: number; brands: Map<string, number> }>();
  for (const v of competitorPlacements) {
    const game = resolveGame(v);
    if (!gameMap.has(game)) gameMap.set(game, { count: 0, brands: new Map() });
    const g = gameMap.get(game)!;
    g.count++;
    const b = resolveBrand(v);
    g.brands.set(b, (g.brands.get(b) || 0) + 1);
  }

  const topGames = [...gameMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([game, d]) => ({ game, videoCount: d.count, estimatedReach: 0, brands: Object.fromEntries(d.brands) }));

  // ── Content Angles: only from Layer 3 placements ──
  const themeMap = new Map<string, { count: number; brands: Map<string, number> }>();
  for (const v of competitorPlacements) {
    const topic = v.topic_category || 'uncategorized';
    if (!themeMap.has(topic)) themeMap.set(topic, { count: 0, brands: new Map() });
    const t = themeMap.get(topic)!;
    t.count++;
    const b = resolveBrand(v);
    t.brands.set(b, (t.brands.get(b) || 0) + 1);
  }

  const topThemes = [...themeMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([topic, d]) => ({ topic, videoCount: d.count, brands: Object.fromEntries(d.brands) }));

  // ── KPIs ──
  // UI 口径 (Stage ④): "Classified" ≠ "AI reviewed". A video can be
  // classified by rules and still await AI verification (needsAI). Discovery
  // Coverage measures pipeline throughput; AI Review Progress measures the
  // backlog. Displayed separately so 100% never implies "all placements found".
  const aiPending = videos.filter(needsAIVerification).length;
  // Stage ⑧ 口径收口: Campaigns = Scope 内 placements 运行时聚合 (不查
  // campaigns 表)。等式: campaignPlacements + standalonePlacements 恒等于
  // competitorPlacements; activeCampaigns 恒等于 Campaign 页项目数。
  const scopeClusters = clusterScopeCampaigns(competitorPlacements, rangeDays);
  const kpis = {
    competitorPlacements: competitorPlacements.length,
    unresolvedCandidates: unresolvedCandidates.length,
    activeCreators: activeCreators.size,
    activeCampaigns: scopeClusters.campaigns.length,
    discoveryCoveragePct: coveragePct, // 100% = all videos have a processing status
    aiPending,                          // awaiting AI verification
    aiReviewed: Math.max(totalAnalyzed - aiPending, 0), // final classification done
    totalVideos: totalInRange,
    totalAnalyzed,
    newCompetitorCreators: newCreatorIds.size,
    campaignPlacements: scopeClusters.campaignPlacements,
    standalonePlacements: scopeClusters.standalonePlacements,
    uniqueCreators: activeCreators.size,          // 投放涉及的去重频道数
    totalGames: gameMap.size,                     // 投放覆盖的游戏数
    windowStart: since.slice(0, 10),              // Data scope 行: 窗口起止
    windowEnd: new Date().toISOString().slice(0, 10),
    totalPlacements: competitorPlacements.length,
  };

  // ── Map DB video rows to dashboard VideoRow shape ──
  const toVideoRow = (v: any) => ({
    videoId: v.video_id, title: v.title, thumbnailUrl: v.thumbnail_url, channelName: v.channel_name,
    brand: resolveBrand(v), game: resolveGame(v),
    publishedAt: v.published_at, viewCount: v.view_count || 0,
    placementType: v.placement_type || 'unknown', sponsorConfidence: v.sponsor_confidence || 0,
    contentCategory: v.content_type || null,
    discoveryEvidence: v.promo_code ? [`Promo code: ${v.promo_code}`] : [],
    promoCode: v.promo_code || null,
    growth24h: null, growth72h: null,
  });

  return {
    hasData: true as const,
    kpis,
    brandComparison,
    topGames,
    topThemes,
    topCreators: [] as any[],
    campaignClusters: scopeClusters.campaigns, // Scope 内运行时聚合的项目 (Overview + Campaigns 页共用)
    recentVideos: competitorPlacements.map(toVideoRow), // 全量 — 前端分页加载更多
    allRecentVideos: videos.slice(0, 30).map(toVideoRow),            // "All Discovered" toggle
    unresolvedVideos: unresolvedCandidates.map(toVideoRow), // 全量 — 前端分页加载更多
    scanStatus: { lastScanAt: null, nextScanAt: 'Tomorrow 06:00 UTC', totalVideos: totalInRange, totalCreators: activeCreators.size, queriesActive: 6 },
  };
}

// ── Dashboard (server-rendered, each sub-query safe-isolated) ──
app.get('/', async (_req, res) => {
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[Dashboard:${requestId}] Request started`);

  try {
    // Step 1: Query video data (critical)
    // Stage ⑦⑧: range/brand/market = Analytics 层筛选, 全部只查 DB 重新聚合。
    // Current Scope = 顶部三筛选器; 所有业务页从 Scope 内 placements 往下算。
    const range = parseInt((_req.query.range as string) || '7', 10);
    const brandFilter = _req.query.brand as string | undefined;
    const marketFilter = _req.query.market as string | undefined;
    const data = await queryDashboardData(range, brandFilter, marketFilter);
    console.log(`[Dashboard:${requestId}] Step1 videos done: hasData=${data.hasData}`);

    // Step 2: Campaigns — 运行时聚合 (queryDashboardData 内完成), 不读历史
    // campaigns 表。Overview「重点投放项目」与 Campaigns 页共用同一数组,
    // Move Score 排序已在聚合时完成。等式天然自洽:
    // campaignPlacements + standalonePlacements = competitorPlacements。
    const campaigns: any[] = (data as any).campaignClusters || [];

    // Step 3: Status (non-critical, safe-fail)
    let status: any = {};
    try {
      status = await getMonitorStatus();
    } catch (e) { console.warn(`[Dashboard:${requestId}] Status query skipped: ${(e as Error).message}`); }

    console.log(`[Dashboard:${requestId}] Rendering HTML...`);

    // Stage ⑧ P0: filter 必须把 URL 三参数原样回传 UI — select 选中态、
    // chip 文案、rangeLabel 全部由它决定。之前传 {} 导致顶部永远显示
    // "过去7天"而数据按 URL range 计算 (截图"过去7天 · Jul 16 → Aug 15")。
    const rawRange = String(_req.query.range || '7d');
    const filter = {
      range: /^\d+$/.test(rawRange) ? rawRange + 'd' : rawRange,
      brand: brandFilter || 'all',
      market: marketFilter || 'all',
    };
    const html = renderDashboard({
      hasData: data.hasData,
      scanStatus: data.scanStatus,
      kpi: data.kpis,
      brandComparison: data.brandComparison || [],
      topGames: data.topGames || [],
      topThemes: data.topThemes || [],
      topCreators: data.topCreators || [],
      recentVideos: data.recentVideos || [],
      allRecentVideos: ('allRecentVideos' in data ? data.allRecentVideos : []) || [],
      unresolvedVideos: ('unresolvedVideos' in data ? data.unresolvedVideos : []) || [],
      anomalies: [],
    } as any, filter, campaigns, { ...status, creatorProfiles: [] });

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
    const rangeDays = parseInt((req.query.range as string) || '7', 10);
    const data = await queryDashboardData(rangeDays, req.query.brand as string, req.query.market as string);

    if (!data.hasData) {
      return res.json({ ok: true, hasData: false, kpis: {}, brands: [], games: [], themes: [], creators: [], recentVideos: [], scanStatus: {} });
    }

    console.log(`[Dashboard:${requestId}] Done: ${data.recentVideos.length} competitor placements, discovery ${data.kpis.totalAnalyzed}/${data.kpis.totalVideos}, aiReview ${data.kpis.aiReviewed} done / ${data.kpis.aiPending} pending, totalMs: ${Date.now() - startedAt}`);

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

// ── Quarterly Report ──
app.get('/report/quarterly', async (_req, res) => {
  const db = getSupabase();
  const { data: saved } = await db.from('competitor_reports').select('*').eq('report_type','quarterly').order('created_at',{ascending:false}).limit(1).maybeSingle();
  res.json(saved?.report_data || await generateQuarterlyReport());
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

// ── Cron: Quarterly report — 2nd day of each quarter at 08:00 UTC ──
// Jan-Mar=Q1, Apr-Jun=Q2, Jul-Sep=Q3, Oct-Dec=Q4
cron.schedule('0 8 2 1,4,7,10 *', async () => {
  console.log('[Cron] Quarterly report generation');
  try { await generateQuarterlyReport(); console.log('[Cron] Quarterly report done'); }
  catch (err) { console.error('[Cron] Quarterly failed:', (err as Error).message); }
});

// ── Cron: AI backlog processing daily at 10:00 UTC ──
// Stage ②: drains the FULL classification queue until empty (batches of 10).
// AI_BACKLOG_DAILY_LIMIT env: <0 = disabled, 0 = unlimited, >0 = cap per run.
// DEFAULT 100/run — unlimited is dangerous (705-video backlog × batch of 10
// = 71 DeepSeek calls in one cron tick). 100/day drains the current backlog
// in ~a week, then tracks weekly increments naturally.
cron.schedule('0 10 * * *', async () => {
  const backlogLimit = parseInt(process.env.AI_BACKLOG_DAILY_LIMIT || '100', 10);
  if (backlogLimit < 0) { console.log('[Cron] AI backlog skipped (limit<0)'); return; }
  console.log(`[Cron] AI backlog processing — limit=${backlogLimit === 0 ? 'unlimited' : backlogLimit}`);
  try {
    const result = await retryClassification(backlogLimit);
    console.log(`[Cron] AI backlog done — ${result.classified} classified, ${result.remaining} remaining`);
    // Audience Signals: classify comments of up to 10 videos per run (~10
    // extra flash calls) so the Comments page fills in incrementally.
    try { await analyzePendingComments(10); }
    catch (err) { console.error('[Cron] Comment analysis failed:', (err as Error).message); }
  } catch (err) { console.error('[Cron] AI backlog failed:', (err as Error).message); }
});


// ── Cron: Performance Refresh (T+3/T+7) daily at 11:00 UTC ──
// 独立于 AI Review：只刷新已入库 video_id 的统计，不 search 不 AI。
cron.schedule('0 11 * * *', async () => {
  console.log('[Cron] Performance refresh (T+3/T+7)');
  try { await refreshPerformanceData(); }
  catch (err) { console.error('[Cron] Perf refresh failed:', (err as Error).message); }
});
export default app;

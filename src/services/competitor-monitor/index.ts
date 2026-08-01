/**
 * Competitor Monitor — Two-Phase Pipeline
 * Uses unified DeepSeek client (src/services/ai/deepseek-client.ts)
 */
import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, buildHotspotQueries, BRANDS } from './brand-config';
import { searchVideos, getChannelsRecentVideos, getChannelsByIds, type YouTubeVideoResult } from './youtube-discovery';
import { fetchVideoComments, hasExistingComments, saveComments } from './video-enrichment';
import { getOrCreateCreatorProfile } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';
import { chatJSON } from '../ai/deepseek-client';

// ── Types ──
export interface ScanState {
  running: boolean; mode: string; phase: string; status: string;
  searchQueriesTotal: number; searchQueriesSucceeded: number; searchQueriesFailed: number;
  creatorChannelsChecked: number;
  discoveredFromSearch: number; discoveredFromCreators: number; discoveredCount: number;
  persistedCount: number;
  selectedForAI: number; classified: number; likelyPlacements: number; queued: number; failed: number;
  searchQuotaUsed: number; generalQuotaUsed: number;
  errorCode: string; errors: string[]; startedAt: string; done: boolean;
}

export let scanState: ScanState = {
  running: false, mode: '', phase: 'idle', status: 'idle',
  searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0,
  creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, discoveredCount: 0,
  persistedCount: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0,
  searchQuotaUsed: 0, generalQuotaUsed: 0, errorCode: '', errors: [], startedAt: '', done: false,
};

let dailySearchUsed = 0, dailyGeneralUsed = 0, searchCircuitOpen = false;
const AI_BATCH_SIZE = 10, MAX_AI_PER_SCAN = 50, SCAN_TIMEOUT_MS = 10 * 60_000;

function trackSearch() { dailySearchUsed++; scanState.searchQuotaUsed = dailySearchUsed; }
function trackGeneral(n: number) { dailyGeneralUsed += n; scanState.generalQuotaUsed = dailyGeneralUsed; }

function resetState(mode: string) {
  searchCircuitOpen = false;
  scanState = { running: true, mode, phase: 'discovery', status: 'running', searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0, creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, discoveredCount: 0, persistedCount: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0, searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed, errorCode: '', errors: [], startedAt: new Date().toISOString(), done: false };
}

// ── Priority scoring (rule-based, no LLM) ──
function scorePriority(v: YouTubeVideoResult, knownIds: Set<string>, hotspotGames: string[]): number {
  let s = 0; const t = v.title.toLowerCase(), d = v.description.toLowerCase();
  for (const b of BRANDS) { for (const kw of b.brandKeywords) { if (t.includes(kw)) { s += 30; break; } } }
  if (/exitlag\.com|gearupbooster\.com|lagzapper\.com/i.test(d)) s += 25;
  if (/(?:code|promo|coupon)[:\s]*[A-Za-z0-9_-]{3,20}/i.test(d)) s += 25;
  if (/sponsored|paid.?promotion|#ad|partner|affiliate/i.test(t + ' ' + d)) s += 20;
  if (v.hasPaidPlacementTag) s += 20;
  for (const g of hotspotGames) { if (t.includes(g.toLowerCase())) { s += 15; break; } }
  if (knownIds.has(v.channelId)) s += 10;
  if (Date.now() - new Date(v.publishedAt).getTime() < 72 * 3600000) s += 10;
  if (v.viewCount > 10000 && (Date.now() - new Date(v.publishedAt).getTime()) / 3600000 < 24) s += 5;
  let hasBrand = false; for (const b of BRANDS) { for (const kw of b.brandKeywords) { if ((t + d).includes(kw)) { hasBrand = true; break; } } }
  if (!hasBrand) s -= 15;
  return s;
}

// ── True batch AI via unified client ──
async function batchClassifyVideos(
  videos: Array<{ videoId: string; title: string; description: string; channelName: string; publishedAt: string; tags: string[]; hasPaidPlacementTag: boolean }>,
): Promise<{ classified: number; likely: number; errors: string[] }> {
  let classified = 0, likely = 0;
  const errors: string[] = [];

  for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
    const batch = videos.slice(i, i + AI_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_BATCH_SIZE) + 1;

    const items = batch.map(v => ({
      videoId: v.videoId, title: v.title, descSnippet: v.description.slice(0, 300),
      channelName: v.channelName, publishedAt: v.publishedAt, hasPaidTag: v.hasPaidPlacementTag,
      matchedBrand: BRANDS.find(b => b.brandKeywords.some(kw => v.title.toLowerCase().includes(kw) || v.description.toLowerCase().includes(kw)))?.brandName || null,
    }));

    const prompt = `Classify these ${items.length} YouTube videos for game booster brand sponsorships (GearUP, ExitLag, LagZapper).

Return a JSON object: {"videos": [...]}

Each video object:
- videoId, placementType ("confirmed"|"likely"|"organic"|"official"|"irrelevant"), confidence (0-100)
- brand ("GearUP"|"ExitLag"|"LagZapper"|null), game (string|null)
- theme ("reduce_ping"|"promo_code"|"game_review"|"tutorial"|"comparison"|"new_launch"|"cross_region"|"other")
- format ("dedicated"|"integrated"|"shorts"|"live")
- reasonCodes (array of "brand_in_title"|"brand_link"|"promo_code"|"sponsored_tag"|"paid_tag"|"casual_mention"|"no_signal")

Rules: confirmed=explicit #ad/sponsored/paid tag. likely=promo code+brand link+product focus. organic=casual mention. irrelevant=no brand signal.

Videos: ${JSON.stringify(items)}`;

    const result = await chatJSON<{ videos: any[] }>(
      [{ role: 'user', content: prompt }],
      { mode: 'fast', maxTokens: 4096 },
    );

    if (result.success && result.data?.videos?.length) {
      for (const item of result.data.videos) {
        const vid = batch.find(v => v.videoId === item.videoId);
        if (!vid) continue;
        const m: Record<string, string> = { confirmed: 'confirmed_paid_placement', likely: 'likely_sponsored', organic: 'organic_mention', official: 'official_brand_video', irrelevant: 'unknown' };
        const pt = m[item.placementType] || 'unknown';
        if (pt === 'confirmed_paid_placement' || pt === 'likely_sponsored') likely++;

        await getSupabase().from('youtube_competitor_videos').update({
          placement_type: pt, sponsor_confidence: (item.confidence || 50) / 100,
          game_name: item.game || null, topic_category: item.theme || 'game_integration',
          content_type: item.format || 'integrated_placement',
          workflow_status: 'classified',
          classification_raw: { ai: item, batchNum, classifiedAt: new Date().toISOString() },
          last_updated_at: new Date().toISOString(),
        }).eq('video_id', item.videoId);
        classified++;
      }
      scanState.classified = classified;
      scanState.likelyPlacements = likely;
    } else {
      const err = `Batch ${batchNum}: ${result.error}`;
      errors.push(err);
      console.error(`[AI] ${err}`, result.diagnostic.contentPreview?.slice(0, 200));
      for (const v of batch) {
        await getSupabase().from('youtube_competitor_videos').update({
          workflow_status: 'discovered', classification_raw: { error: result.error, queuedAt: new Date().toISOString() },
        }).eq('video_id', v.videoId);
        scanState.failed++;
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { classified, likely, errors };
}

// ── Main Pipeline ──
export async function runDiscoveryPipeline(options?: {
  backfillDays?: number; mode?: 'normal' | 'hotspot' | 'manual'; hotspotGame?: string;
  skipAI?: boolean; skipComments?: boolean;
}): Promise<{ videosDiscovered: number; videosClassified: number }> {
  const mode = options?.mode || 'normal';
  const backfillDays = mode === 'manual' ? (options?.backfillDays || 7) : 1;
  const publishedAfter = new Date(Date.now() - backfillDays * 86400000).toISOString();
  resetState(mode);
  console.log(`[Monitor] ${mode} scan — since ${publishedAfter}`);

  const db = getSupabase();
  const allVids: YouTubeVideoResult[] = [];
  const seen = new Set<string>();
  const { data: existing } = await db.from('youtube_competitor_videos').select('video_id').gte('first_seen_at', new Date(Date.now() - 60 * 86400000).toISOString());
  (existing || []).forEach((v: any) => seen.add(v.video_id));

  // Phase 1: Search (with circuit breaker)
  let searchFrom = 0;
  const queries = mode === 'hotspot' && options?.hotspotGame ? buildHotspotQueries(options.hotspotGame) : getActiveQueries();
  scanState.searchQueriesTotal = queries.length;
  for (const q of queries) {
    if (searchCircuitOpen) { scanState.searchQueriesFailed++; continue; }
    try {
      trackSearch();
      const results = await searchVideos(q, publishedAfter, 50);
      scanState.searchQueriesSucceeded++;
      for (const r of results) { if (!seen.has(r.videoId)) { seen.add(r.videoId); allVids.push(r); searchFrom++; } }
      await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
    } catch (err) {
      scanState.searchQueriesFailed++;
      if ((err as Error).message.startsWith('YT_QUOTA_EXHAUSTED')) { searchCircuitOpen = true; scanState.errorCode = 'SEARCH_QUOTA_EXHAUSTED'; }
    }
  }
  scanState.discoveredFromSearch = searchFrom;

  // Phase 2: Channel monitoring
  const { data: creators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);
  let creatorFrom = 0;
  if (creators?.length) {
    scanState.creatorChannelsChecked = creators.length;
    const ids = creators.map((c: any) => c.channel_id);
    trackGeneral(Math.ceil(ids.length / 50) + ids.length);
    const chVids = await getChannelsRecentVideos(ids, publishedAfter, 5);
    for (const v of chVids) { if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod = 'channel_scan'; allVids.push(v); creatorFrom++; } }
  }
  scanState.discoveredFromCreators = creatorFrom;
  scanState.discoveredCount = allVids.length;

  // Log Supabase target
  console.log(`[Monitor] Supabase host: ${new URL(config.supabase.url).hostname} | serviceRole: ${!!config.supabase.serviceRoleKey}`);

  if (!allVids.length) { scanState.done = true; scanState.running = false; return { videosDiscovered: 0, videosClassified: 0 }; }

  // Phase 3: Save + score with PROPER error handling
  scanState.phase = 'saving';
  const knownIds = new Set((creators || []).map((c: any) => c.channel_id));
  const { data: cfg } = await db.from('monitor_config').select('hotspot_games').eq('id', 1).maybeSingle();
  const scored = allVids.map(v => ({ video: v, priority: scorePriority(v, knownIds, (cfg as any)?.hotspot_games || []) })).sort((a, b) => b.priority - a.priority);

  console.log(`[Monitor] Attempting to persist ${scored.length} videos...`);

  let persistedCount = 0;
  const persistedIds: string[] = [];
  const saveErrors: Array<{ videoId: string; error: string }> = [];

  for (const { video: v } of scored) {
    try {
      if (!knownIds.has(v.channelId)) {
        const ch = await getChannelsByIds([v.channelId]);
        if (ch[0]) await getOrCreateCreatorProfile(ch[0].channelId, ch[0].channelName);
      }

      const { error } = await db.from('youtube_competitor_videos').upsert({
        video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle,
        title: v.title, description: v.description || '', published_at: v.publishedAt,
        duration: v.duration, is_short: v.isShort, thumbnail_url: v.thumbnailUrl || null,
        tags: v.tags, category_id: v.categoryId,
        discovery_method: (v as any).discoveryMethod || 'keyword_search',
        has_paid_placement_tag: v.hasPaidPlacementTag,
        view_count: v.viewCount, like_count: v.likeCount, comment_count: v.commentCount,
        workflow_status: 'discovered',
        brand_id: null,
        first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
      }, { onConflict: 'video_id' });

      if (error) {
        saveErrors.push({ videoId: v.videoId, error: `${error.code}: ${error.message}` });
        if (saveErrors.length <= 3) {
          console.error(`[Monitor] Save FAILED for ${v.videoId}: code=${error.code} msg=${error.message} details=${error.details} hint=${error.hint}`);
        }
      } else {
        persistedCount++;
        persistedIds.push(v.videoId);
      }
    } catch (err) {
      saveErrors.push({ videoId: v.videoId, error: (err as Error).message });
    }
  }

  // ── VERIFY: query DB for actual count ──
  const { count: dbCount, error: countErr } = await db
    .from('youtube_competitor_videos')
    .select('video_id', { count: 'exact', head: true })
    .in('video_id', allVids.map(v => v.videoId));

  scanState.persistedCount = dbCount ?? 0;

  console.log(`[Monitor] Persist result: attempted=${scored.length} persisted=${persistedCount} dbConfirmed=${dbCount} saveErrors=${saveErrors.length}`);

  if (saveErrors.length > 0) {
    console.error(`[Monitor] Save errors (first 5): ${JSON.stringify(saveErrors.slice(0, 5))}`);
    scanState.errors.push(`Save errors: ${saveErrors.length}/${scored.length} failed`);
  }

  if (!dbCount || dbCount === 0) {
    scanState.errorCode = 'VIDEO_PERSISTENCE_FAILED';
    scanState.status = 'failed';
    scanState.errors.push(`0 videos persisted out of ${scored.length} attempted — check brand_id constraint and Supabase connection`);
    console.error(`[Monitor] FATAL: 0 videos persisted. Supabase: ${config.supabase.url}`);
    scanState.done = true; scanState.running = false; scanState.phase = 'failed';
    return { videosDiscovered: 0, videosClassified: 0 };
  }

  const actualCount = dbCount ?? 0;
  scanState.selectedForAI = Math.min(MAX_AI_PER_SCAN, actualCount);
  scanState.queued = Math.max(0, actualCount - MAX_AI_PER_SCAN);

  // Phase 4: AI
  if (!options?.skipAI && scanState.selectedForAI > 0) {
    scanState.phase = 'classifying';
    const aiCandidates = scored.slice(0, MAX_AI_PER_SCAN);
    const result = await batchClassifyVideos(aiCandidates.map(c => ({
      videoId: c.video.videoId, title: c.video.title, description: c.video.description,
      channelName: c.video.channelTitle, publishedAt: c.video.publishedAt, tags: c.video.tags, hasPaidPlacementTag: c.video.hasPaidPlacementTag,
    })));
    scanState.errors.push(...result.errors);
    for (const qv of scored.slice(MAX_AI_PER_SCAN)) {
      await db.from('youtube_competitor_videos').update({ classification_raw: { priorityScore: qv.priority, queuedAt: new Date().toISOString() } }).eq('video_id', qv.video.videoId);
    }
    for (const c of aiCandidates) {
      await saveSnapshot(c.video.videoId, 'discovery', Math.round((Date.now() - new Date(c.video.publishedAt).getTime()) / 3600000), c.video.viewCount, c.video.likeCount, c.video.commentCount, 0, 0.5, c.video.isShort);
    }
  }

  // Phase 5: Comments (high-conf only)
  if (!options?.skipComments && scanState.classified > 0) {
    const { data: hc } = await db.from('youtube_competitor_videos').select('video_id, comment_count').in('placement_type', ['confirmed_paid_placement', 'likely_sponsored']).gte('comment_count', 10).order('first_seen_at', { ascending: false }).limit(10);
    for (const v of (hc || [])) {
      if (await hasExistingComments(v.video_id)) continue;
      trackGeneral(1);
      const comments = await fetchVideoComments(v.video_id, 30, 'relevance');
      if (comments.length > 0) await saveComments(v.video_id, comments);
    }
  }

  scanState.phase = 'completed'; scanState.status = scanState.errorCode ? 'partial_completed' : 'completed';
  scanState.done = true; scanState.running = false;
  console.log(`[Monitor] Done: ${scanState.discoveredCount} vids AI=${scanState.classified} likely=${scanState.likelyPlacements}`);
  return { videosDiscovered: scanState.discoveredCount, videosClassified: scanState.classified };
}

// ── Retry classification (AI only) ──
export async function retryClassification(limit: number = MAX_AI_PER_SCAN): Promise<{ classified: number }> {
  const db = getSupabase();
  const { data: pending } = await db.from('youtube_competitor_videos').select('*').eq('workflow_status', 'discovered').is('placement_type', null).order('first_seen_at', { ascending: false }).limit(limit);
  if (!pending?.length) return { classified: 0 };
  resetState('retry');
  scanState.selectedForAI = pending.length;
  scanState.discoveredCount = pending.length;
  const result = await batchClassifyVideos((pending as any[]).map(v => ({
    videoId: v.video_id, title: v.title, description: v.description || '', channelName: v.channel_name || '', publishedAt: v.published_at || '', tags: v.tags || [], hasPaidPlacementTag: v.has_paid_placement_tag || false,
  })));
  scanState.classified = result.classified;
  scanState.likelyPlacements = result.likely;
  scanState.done = true; scanState.running = false; scanState.phase = 'completed';
  return { classified: result.classified };
}

export async function getMonitorStatus() {
  const db = getSupabase();
  const { count: tv } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: cr } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: lv } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  return { totalVideos: tv || 0, totalCreators: (cr || []).length, lastRun: (lv as any)?.created_at || null, searchQuotaUsed: dailySearchUsed, searchQuotaLimit: 100, generalQuotaUsed: dailyGeneralUsed, generalQuotaLimit: 10000, hotspotActive: (cfg as any)?.hotspot_active || false, scanRunning: scanState.running };
}

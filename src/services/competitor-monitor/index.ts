/**
 * Competitor Monitor — Two-Phase Pipeline with circuit breaker + true batch AI
 */
import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, buildHotspotQueries, BRANDS } from './brand-config';
import {
  searchVideos, getChannelsRecentVideos, getChannelsByIds, type YouTubeVideoResult,
} from './youtube-discovery';
import { fetchVideoComments, hasExistingComments, saveComments } from './video-enrichment';
import { getOrCreateCreatorProfile } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';
import axios from 'axios';

// ── Types ──
export interface ScanState {
  running: boolean; mode: string; phase: string; status: string;
  searchQueriesTotal: number; searchQueriesSucceeded: number; searchQueriesFailed: number;
  creatorChannelsChecked: number;
  discoveredFromSearch: number; discoveredFromCreators: number; uniqueVideos: number;
  selectedForAI: number; classified: number; likelyPlacements: number; queued: number; failed: number;
  searchQuotaUsed: number; generalQuotaUsed: number;
  errorCode: string; errors: string[]; startedAt: string; done: boolean;
}

export let scanState: ScanState = {
  running: false, mode: '', phase: 'idle', status: 'idle',
  searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0,
  creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, uniqueVideos: 0,
  selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0,
  searchQuotaUsed: 0, generalQuotaUsed: 0, errorCode: '', errors: [], startedAt: '', done: false,
};

let dailySearchUsed = 0; let dailyGeneralUsed = 0;
let searchCircuitOpen = false;

const AI_BATCH_SIZE = 10;
const MAX_AI_PER_SCAN = 50;
const SCAN_TIMEOUT_MS = 10 * 60_000;
const AI_TIMEOUT_MS = 60_000;

function trackSearch() { dailySearchUsed++; scanState.searchQuotaUsed = dailySearchUsed; }
function trackGeneral(n: number) { dailyGeneralUsed += n; scanState.generalQuotaUsed = dailyGeneralUsed; }

function resetState(mode: string) {
  searchCircuitOpen = false;
  scanState = {
    running: true, mode, phase: 'discovery', status: 'running',
    searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0,
    creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, uniqueVideos: 0,
    selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0,
    searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed,
    errorCode: '', errors: [], startedAt: new Date().toISOString(), done: false,
  };
}

// ── Rule-based priority scoring (no LLM) ──
function scorePriority(v: YouTubeVideoResult, knownIds: Set<string>, hotspotGames: string[]): number {
  let s = 0;
  const t = v.title.toLowerCase(), d = v.description.toLowerCase();
  for (const b of BRANDS) { for (const kw of b.brandKeywords) { if (t.includes(kw)) { s += 30; break; } } }
  if (/exitlag\.com|gearupbooster\.com|lagzapper\.com/i.test(d)) s += 25;
  if (/(?:code|promo|coupon)[:\s]*[A-Za-z0-9_-]{3,20}/i.test(d)) s += 25;
  if (/sponsored|paid.?promotion|#ad|partner|affiliate/i.test(t+' '+d)) s += 20;
  if (v.hasPaidPlacementTag) s += 20;
  for (const g of hotspotGames) { if (t.includes(g.toLowerCase())) { s += 15; break; } }
  if (knownIds.has(v.channelId)) s += 10;
  if (Date.now() - new Date(v.publishedAt).getTime() < 72*3600000) s += 10;
  if (v.viewCount > 10000 && (Date.now()-new Date(v.publishedAt).getTime())/3600000 < 24) s += 5;
  let hasBrand = false; for (const b of BRANDS) { for (const kw of b.brandKeywords) { if ((t+d).includes(kw)) { hasBrand=true; break; } } }
  if (!hasBrand) s -= 15;
  return s;
}

// ── TRUE batch AI: one API call per batch of 10-12 videos ──
async function batchClassifyVideos(
  videos: Array<{ videoId: string; title: string; description: string; channelName: string; publishedAt: string; tags: string[]; hasPaidPlacementTag: boolean }>,
): Promise<{ classified: number; likely: number; errors: string[] }> {
  const model = 'deepseek-chat'; // non-reasoning model for classification
  const deepseekKey = config.deepseek.apiKey;
  let classified = 0, likely = 0;
  const errors: string[] = [];

  for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
    const batch = videos.slice(i, i + AI_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(videos.length / AI_BATCH_SIZE);

    // Build true batch prompt
    const items = batch.map(v => ({
      videoId: v.videoId,
      title: v.title,
      descSnippet: v.description.slice(0, 300),
      channelName: v.channelName,
      publishedAt: v.publishedAt,
      hasPaidTag: v.hasPaidPlacementTag,
      matchedBrand: BRANDS.find(b => b.brandKeywords.some(kw => v.title.toLowerCase().includes(kw) || v.description.toLowerCase().includes(kw)))?.brandName || null,
    }));

    const prompt = `Classify these ${items.length} YouTube videos for game booster brand sponsorships (GearUP, ExitLag, LagZapper).

For each video, determine:
- placementType: "confirmed" | "likely" | "organic" | "official" | "irrelevant"
- confidence: 0-100
- brand: "GearUP" | "ExitLag" | "LagZapper" | null
- game: the specific game name or null
- theme: "reduce_ping" | "promo_code" | "game_review" | "tutorial" | "comparison" | "new_launch" | "cross_region" | "other"
- format: "dedicated" | "integrated" | "shorts" | "live"
- reasonCodes: ["brand_in_title","brand_link","promo_code","sponsored_tag","paid_tag","casual_mention","no_signal"]

Rules:
- confirmed: explicit "#ad", "sponsored by", "paid partnership", or YouTube paid tag
- likely: promo code + brand link + strong product focus
- organic: casual brand mention, no commercial signals
- irrelevant: no brand signal, unrelated to game boosters

Videos:
${JSON.stringify(items, null, 2)}

Output ONLY a JSON array — no markdown, no preamble, no explanation:
[
  {"videoId":"...","placementType":"likely","confidence":85,"brand":"ExitLag","game":"Valorant","theme":"reduce_ping","format":"integrated","reasonCodes":["brand_link","promo_code"]},
  ...
]`;

    // Try batch (2 attempts max)
    let batchSuccess = false;
    for (let attempt = 0; attempt < 2 && !batchSuccess; attempt++) {
      const startMs = Date.now();
      try {
        const resp = await Promise.race([
          axios.post(`${config.deepseek.baseUrl}/chat/completions`, {
            model, temperature: 0, max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }, {
            headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
            timeout: AI_TIMEOUT_MS,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_TIMEOUT_MS)),
        ]);

        const choice = resp.data?.choices?.[0];
        const content = choice?.message?.content?.trim() || '';
        const finishReason = choice?.finish_reason || '';
        const usage = resp.data?.usage || {};
        const latencyMs = Date.now() - startMs;

        console.log(`[AI] Batch ${batchNum}/${totalBatches}: model=${model} finish=${finishReason} contentLen=${content.length} promptTk=${usage.prompt_tokens||0} compTk=${usage.completion_tokens||0} latency=${latencyMs}ms`);

        // 3-layer JSON parsing
        let parsed: any[] | null = null;
        try { parsed = JSON.parse(content); } catch {}
        if (!parsed) {
          const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (m) try { parsed = JSON.parse(m[1]); } catch {}
        }
        if (!parsed) {
          const start = content.indexOf('['), end = content.lastIndexOf(']');
          if (start >= 0 && end > start) try { parsed = JSON.parse(content.slice(start, end + 1)); } catch {}
        }

        if (Array.isArray(parsed) && parsed.length > 0) {
          // Save results per video
          for (const item of parsed) {
            const vid = batch.find(v => v.videoId === item.videoId);
            if (!vid) continue;
            const placementMap: Record<string, string> = { confirmed: 'confirmed_paid_placement', likely: 'likely_sponsored', organic: 'organic_mention', official: 'official_brand_video', irrelevant: 'unknown' };
            const placementType = placementMap[item.placementType] || 'unknown';
            if (placementType === 'confirmed_paid_placement' || placementType === 'likely_sponsored') likely++;

            // Save to DB immediately
            await getSupabase().from('youtube_competitor_videos').update({
              placement_type: placementType,
              sponsor_confidence: (item.confidence || 50) / 100,
              game_name: item.game || null,
              topic_category: item.theme || 'game_integration',
              content_type: item.format || 'integrated_placement',
              brand_mention_position: (item.reasonCodes || []).filter((c: string) => ['brand_in_title', 'brand_link'].includes(c)).map((c: string) => c === 'brand_in_title' ? 'title' : 'description'),
              promo_code: item.reasonCodes?.includes('promo_code') ? 'yes' : null,
              workflow_status: 'classified',
              classification_raw: { ai: item, classifiedAt: new Date().toISOString(), batchNum },
              last_updated_at: new Date().toISOString(),
            }).eq('video_id', item.videoId);

            classified++;
          }
          batchSuccess = true;
          scanState.classified = classified;
          scanState.likelyPlacements = likely;
        } else {
          console.error(`[AI] Batch ${batchNum} parse failed: not an array. Raw: ${content.slice(0, 300)}`);
          if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
          errors.push(`Batch ${batchNum}: parse failed (contentLen=${content.length}, finish=${finishReason})`);
        }
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[AI] Batch ${batchNum} attempt ${attempt+1} failed: ${msg}`);
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
        errors.push(`Batch ${batchNum}: ${msg}`);
        // Mark batch videos as failed
        for (const v of batch) {
          await getSupabase().from('youtube_competitor_videos').update({
            workflow_status: 'discovered',
            classification_raw: { error: msg, queuedAt: new Date().toISOString() },
          }).eq('video_id', v.videoId);
          scanState.failed++;
        }
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
  console.log(`[Monitor] ${mode} scan — since ${publishedAfter} | search: ${dailySearchUsed}/100 | circuit: ${searchCircuitOpen}`);

  const db = getSupabase();
  const allVids: YouTubeVideoResult[] = [];
  const seen = new Set<string>();

  const { data: existing } = await db.from('youtube_competitor_videos').select('video_id')
    .gte('first_seen_at', new Date(Date.now() - 60 * 86400000).toISOString());
  (existing || []).forEach((v: any) => seen.add(v.video_id));

  // ═══ Phase 1: Search Discovery (with circuit breaker) ═══
  scanState.phase = 'discovery';
  let searchFromCount = 0;
  const queries = mode === 'hotspot' && options?.hotspotGame
    ? buildHotspotQueries(options.hotspotGame)
    : getActiveQueries();

  scanState.searchQueriesTotal = queries.length;

  for (const q of queries) {
    if (searchCircuitOpen) {
      scanState.searchQueriesFailed++;
      console.log(`[Monitor] Circuit OPEN — skipping "${q.queryText}"`);
      continue;
    }
    try {
      trackSearch();
      const results = await searchVideos(q, publishedAfter, 50);
      scanState.searchQueriesSucceeded++;
      for (const r of results) { if (!seen.has(r.videoId)) { seen.add(r.videoId); allVids.push(r); searchFromCount++; } }
      // Mark query run
      await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
    } catch (err) {
      const msg = (err as Error).message;
      scanState.searchQueriesFailed++;
      if (msg.startsWith('YT_QUOTA_EXHAUSTED')) {
        searchCircuitOpen = true;
        scanState.errorCode = 'SEARCH_QUOTA_EXHAUSTED';
        scanState.errors.push(`Search quota exhausted: ${msg}`);
        console.error(`[Monitor] Circuit BREAKER opened: ${msg}`);
      }
    }
  }

  scanState.discoveredFromSearch = searchFromCount;

  // ═══ Phase 2: Creator Channel Monitoring ═══
  scanState.phase = 'channel_scan';
  const { data: knownCreators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);
  let creatorFromCount = 0;

  if (knownCreators?.length) {
    scanState.creatorChannelsChecked = knownCreators.length;
    const chIds = knownCreators.map((c: any) => c.channel_id);
    trackGeneral(Math.ceil(chIds.length / 50) + chIds.length);
    const chVids = await getChannelsRecentVideos(chIds, publishedAfter, 5);
    for (const v of chVids) {
      if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod = 'channel_scan'; allVids.push(v); creatorFromCount++; }
    }
  }

  scanState.discoveredFromCreators = creatorFromCount;
  scanState.uniqueVideos = allVids.length;

  if (!allVids.length) {
    scanState.status = 'completed'; scanState.phase = 'completed'; scanState.done = true; scanState.running = false;
    return { videosDiscovered: 0, videosClassified: 0 };
  }

  // ═══ Phase 3: Save all as DISCOVERED ═══
  scanState.phase = 'saving';
  const knownIds = new Set((knownCreators || []).map((c: any) => c.channel_id));
  const { data: cfg } = await db.from('monitor_config').select('hotspot_games').eq('id', 1).maybeSingle();
  const hotspotGames = (cfg as any)?.hotspot_games || [];

  const scored = allVids.map(v => ({ video: v, priority: scorePriority(v, knownIds, hotspotGames) }))
    .sort((a, b) => b.priority - a.priority);

  scanState.selectedForAI = Math.min(MAX_AI_PER_SCAN, scored.length);
  scanState.queued = Math.max(0, scored.length - MAX_AI_PER_SCAN);

  console.log(`[Monitor] Saving ${allVids.length} videos (src: ${searchFromCount} search + ${creatorFromCount} creator, AI: ${scanState.selectedForAI}, queued: ${scanState.queued})`);

  // Save all
  for (const { video: v } of scored) {
    if (!knownIds.has(v.channelId)) {
      const ch = await getChannelsByIds([v.channelId]);
      if (ch[0]) await getOrCreateCreatorProfile(ch[0].channelId, ch[0].channelName);
    }
    const row = {
      video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle,
      title: v.title, description: v.description, published_at: v.publishedAt,
      duration: v.duration, is_short: v.isShort, thumbnail_url: v.thumbnailUrl,
      tags: v.tags, category_id: v.categoryId,
      discovery_method: (v as any).discoveryMethod || 'keyword_search',
      has_paid_placement_tag: v.hasPaidPlacementTag,
      view_count: v.viewCount, like_count: v.likeCount, comment_count: v.commentCount,
      workflow_status: 'discovered',
      first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
    };
    await db.from('youtube_competitor_videos').upsert(row, { onConflict: 'video_id' });
  }

  // ═══ Phase 4: True Batch AI (top N only) ═══
  if (!options?.skipAI && scanState.selectedForAI > 0 && scanState.errorCode !== 'SEARCH_QUOTA_EXHAUSTED') {
    // Note: AI runs regardless of search failure, since we have creator data
  }
  if (!options?.skipAI && scanState.selectedForAI > 0) {
    scanState.phase = 'classifying';
    const aiCandidates = scored.slice(0, MAX_AI_PER_SCAN);
    const result = await batchClassifyVideos(
      aiCandidates.map(c => ({
        videoId: c.video.videoId, title: c.video.title, description: c.video.description,
        channelName: c.video.channelTitle, publishedAt: c.video.publishedAt, tags: c.video.tags, hasPaidPlacementTag: c.video.hasPaidPlacementTag,
      })),
    );
    scanState.errors.push(...result.errors);
    if (result.errors.length > 0 && result.classified === 0) {
      scanState.errorCode = scanState.errorCode || 'AI_CLASSIFICATION_FAILED';
      scanState.status = 'partial_completed';
    }

    // Mark queued videos
    for (const qv of scored.slice(MAX_AI_PER_SCAN)) {
      await db.from('youtube_competitor_videos').update({
        classification_raw: { priorityScore: qv.priority, queuedAt: new Date().toISOString() },
      }).eq('video_id', qv.video.videoId);
    }

    // Snapshots for classified
    for (const c of aiCandidates) {
      await saveSnapshot(c.video.videoId, 'discovery',
        Math.round((Date.now() - new Date(c.video.publishedAt).getTime()) / 3600000),
        c.video.viewCount, c.video.likeCount, c.video.commentCount, 0, 0.5, c.video.isShort);
    }
  }

  // ═══ Phase 5: Comments (high-confidence only) ═══
  if (!options?.skipComments && scanState.classified > 0) {
    scanState.phase = 'deep_analysis';
    // Fetch high-conf from DB
    const { data: highConf } = await db.from('youtube_competitor_videos')
      .select('video_id, comment_count, classification_raw')
      .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
      .gte('comment_count', 10)
      .order('first_seen_at', { ascending: false })
      .limit(10);

    for (const v of (highConf || [])) {
      if (await hasExistingComments(v.video_id)) continue;
      trackGeneral(1);
      const comments = await fetchVideoComments(v.video_id, 30, 'relevance');
      if (comments.length > 0) {
        await saveComments(v.video_id, comments);
      }
    }
  }

  const timedOut = Date.now() - new Date(scanState.startedAt).getTime() > SCAN_TIMEOUT_MS;
  scanState.phase = timedOut ? 'partial_completed' : 'completed';
  scanState.status = scanState.errorCode ? 'partial_completed' : 'completed';
  scanState.done = true; scanState.running = false;

  console.log(`[Monitor] Done: ${scanState.uniqueVideos} vids (search=${scanState.discoveredFromSearch} creator=${scanState.discoveredFromCreators}), AI=${scanState.classified}, likely=${scanState.likelyPlacements}, queued=${scanState.queued}, errors=${scanState.errors.length}`);
  return { videosDiscovered: scanState.uniqueVideos, videosClassified: scanState.classified };
}

// ── Retry AI classification only (no search, no channel scan) ──
export async function retryClassification(): Promise<{ classified: number }> {
  const db = getSupabase();
  const { data: pending } = await db.from('youtube_competitor_videos')
    .select('*').eq('workflow_status', 'discovered')
    .is('placement_type', null)
    .order('first_seen_at', { ascending: false }).limit(MAX_AI_PER_SCAN);

  if (!pending?.length) return { classified: 0 };

  resetState('retry');
  scanState.selectedForAI = pending.length;
  scanState.uniqueVideos = pending.length;

  const result = await batchClassifyVideos(
    (pending as any[]).map(v => ({
      videoId: v.video_id, title: v.title, description: v.description || '',
      channelName: v.channel_name || '', publishedAt: v.published_at || '', tags: v.tags || [], hasPaidPlacementTag: v.has_paid_placement_tag || false,
    })),
  );

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
  return {
    totalVideos: tv || 0, totalCreators: (cr || []).length,
    lastRun: (lv as any)?.created_at || null,
    searchQuotaUsed: dailySearchUsed, searchQuotaLimit: 100,
    generalQuotaUsed: dailyGeneralUsed, generalQuotaLimit: 10000,
    hotspotActive: (cfg as any)?.hotspot_active || false, scanRunning: scanState.running,
  };
}

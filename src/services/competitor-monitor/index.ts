/**
 * Competitor Monitor v3 — Quota-Aware Discovery Engine
 *
 * Search budget: 100/day (search.list quota)
 * Strategy:
 *   Normal:  6 combined OR searches + channel monitoring
 *   Hotspot: brand+game searches every 4h (up to 18/game/day)
 *   Manual:  user-triggered
 *
 * Hard stops: ≥70 → no new searches, ≥80 → hotspot only, ≥90 → all search paused
 */

import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, buildHotspotQueries } from './brand-config';
import {
  searchVideos,
  getChannelsRecentVideos,
  getChannelsByIds,
  type YouTubeVideoResult,
} from './youtube-discovery';
import {
  fetchVideoComments,
  hasExistingComments,
  saveComments,
} from './video-enrichment';
import { detectSponsorshipBatch } from './sponsorship-detector';
import { classifyTopicsBatch, classifyAndUpdateComments } from './topic-classifier';
import { getOrCreateCreatorProfile, updateCreatorFromVideo } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';

// ── Scan State ──
export let scanState = {
  running: false,
  mode: '' as string,
  searchQuotaUsed: 0,
  generalQuotaUsed: 0,
  videosFound: 0,
  videosNew: 0,
  errors: [] as string[],
  startedAt: '',
  done: false,
};

// ── Quota Budget ──
let dailySearchUsed = 0;
let dailyGeneralUsed = 0;

function resetDailyQuota() { dailySearchUsed = 0; dailyGeneralUsed = 0; }

async function trackSearchQuota(count: number) {
  dailySearchUsed += count;
  const db = getSupabase();
  await db.from('monitor_config').update({ updated_at: new Date().toISOString() }).eq('id', 1);
}

function canSearch(threshold: number): boolean { return dailySearchUsed < threshold; }

// ── Scan Log ──
async function logScanStart(mode: string) {
  const db = getSupabase();
  const { data } = await db.from('scan_logs').insert({
    scan_mode: mode, search_quota_used: dailySearchUsed,
    general_quota_used: dailyGeneralUsed,
  }).select('id').single();
  return (data as any)?.id;
}

async function logScanEnd(logId: string, result: { found: number; new_: number; classified: number; errors: string[] }) {
  await getSupabase().from('scan_logs').update({
    videos_found: result.found,
    videos_new: result.new_,
    videos_classified: result.classified,
    errors: result.errors,
    search_quota_used: dailySearchUsed,
    general_quota_used: dailyGeneralUsed,
    quota_exhausted: dailySearchUsed >= 90,
    completed_at: new Date().toISOString(),
  }).eq('id', logId);
}

// ── Search with retry + cache check ──
async function searchOnce(queryText: string, publishedAfter: string, market: string, lang: string): Promise<YouTubeVideoResult[]> {
  // Cache: don't re-run same query same day
  const db = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data: recent } = await db.from('competitor_queries')
    .select('last_run_at').eq('query_text', queryText).maybeSingle();
  if (recent && (recent as any).last_run_at?.startsWith(today)) {
    console.log(`[Monitor] Query "${queryText}" already ran today — skipping`);
    return [];
  }

  // Try once, retry once on failure
  let result: YouTubeVideoResult[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      trackSearchQuota(1);
      result = await searchVideos({
        brandName: '', queryText, queryType: 'branded',
        targetLanguage: lang, targetMarket: market,
      }, publishedAfter, 50); // single page only — no pagination
      break;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`[Monitor] Search retry for "${queryText}": ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.error(`[Monitor] Search failed for "${queryText}" after retry`);
      }
    }
  }

  // Mark as run
  await db.from('competitor_queries').upsert({
    query_text: queryText, last_run_at: new Date().toISOString(),
  }, { onConflict: 'query_text' });

  return result;
}

// ── Main Pipeline ──
export async function runDiscoveryPipeline(options?: {
  backfillDays?: number;
  mode?: 'normal' | 'hotspot' | 'manual';
  hotspotGame?: string;
  skipAI?: boolean;
  skipComments?: boolean;
}): Promise<{ videosDiscovered: number; videosClassified: number }> {
  const mode = options?.mode || 'normal';
  const backfillDays = mode === 'manual' ? (options?.backfillDays || 7) : 1;
  const publishedAfter = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[Monitor] Starting ${mode} scan — since ${publishedAfter} | search used today: ${dailySearchUsed}/100`);

  const logId = await logScanStart(mode);
  scanState = { running: true, mode, searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed, videosFound: 0, videosNew: 0, errors: [], startedAt: new Date().toISOString(), done: false };

  const db = getSupabase();
  const allDiscovered: YouTubeVideoResult[] = [];
  const seenVideoIds = new Set<string>();
  const errors: string[] = [];

  // Dedup buffer
  const { data: existingVids } = await db.from('youtube_competitor_videos')
    .select('video_id').gte('first_seen_at', new Date(Date.now() - 60 * 86400000).toISOString());
  (existingVids || []).forEach((v: any) => seenVideoIds.add(v.video_id));

  // ═══════════════════════════════════════
  // Phase 1: Search Discovery (only if quota permits)
  // ═══════════════════════════════════════
  let searchQueriesRun = 0;

  if (canSearch(70)) {
    if (mode === 'hotspot' && options?.hotspotGame) {
      // Hotspot: brand + game searches
      const hq = buildHotspotQueries(options.hotspotGame);
      for (const q of hq) {
        if (!canSearch(70)) { errors.push('Search quota ≥70 — stopping hotspot searches'); break; }
        const results = await searchOnce(q.queryText, publishedAfter, q.targetMarket, q.targetLanguage);
        searchQueriesRun++;
        for (const r of results) { if (!seenVideoIds.has(r.videoId)) { seenVideoIds.add(r.videoId); allDiscovered.push(r); } }
      }
    } else {
      // Normal mode: rotate through 6 combined queries
      const queries = getActiveQueries();
      const { data: runs } = await db.from('competitor_queries').select('query_text, last_run_at').order('last_run_at', { ascending: true, nullsFirst: true });
      const runMap = new Map<string, string>(); (runs || []).forEach((r: any) => runMap.set(r.query_text, r.last_run_at));

      const sorted = [...queries].sort((a, b) => {
        const al = runMap.get(a.queryText); const bl = runMap.get(b.queryText);
        if (!al && bl) return -1; if (al && !bl) return 1; if (!al && !bl) return 0;
        return new Date(al!).getTime() - new Date(bl!).getTime();
      });

      // Run one query from rotation
      const q = sorted[0];
      if (canSearch(70)) {
        const results = await searchOnce(q.queryText, publishedAfter, q.targetMarket, q.targetLanguage);
        searchQueriesRun++;
        for (const r of results) { if (!seenVideoIds.has(r.videoId)) { seenVideoIds.add(r.videoId); allDiscovered.push(r); } }
      } else {
        errors.push('Search quota ≥70 — skipping normal search');
      }

      // If manual mode, run more queries
      if (mode === 'manual' && canSearch(70)) {
        for (let i = 1; i < sorted.length && canSearch(70); i++) {
          const extra = sorted[i];
          const results = await searchOnce(extra.queryText, publishedAfter, extra.targetMarket, extra.targetLanguage);
          searchQueriesRun++;
          for (const r of results) { if (!seenVideoIds.has(r.videoId)) { seenVideoIds.add(r.videoId); allDiscovered.push(r); } }
        }
      }
    }
  } else {
    errors.push('Search quota exhausted — skipping all search.list calls');
  }

  console.log(`[Monitor] ${searchQueriesRun} searches run, ${allDiscovered.length} new videos found`);

  // ═══════════════════════════════════════
  // Phase 2: Channel Monitoring (NO search quota)
  // ═══════════════════════════════════════
  const { data: knownCreators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);

  if (knownCreators?.length) {
    const channelIds = knownCreators.map((c: any) => c.channel_id);
    console.log(`[Monitor] Scanning ${channelIds.length} known creators (playlistItems — free quota)`);
    dailyGeneralUsed += Math.ceil(channelIds.length / 50) + channelIds.length; // channels.list + playlistItems.list

    const channelVideos = await getChannelsRecentVideos(channelIds, publishedAfter, 5);
    for (const r of channelVideos) {
      if (!seenVideoIds.has(r.videoId)) {
        seenVideoIds.add(r.videoId);
        (r as any).discoveryMethod = 'channel_scan';
        allDiscovered.push(r);
      }
    }
    console.log(`[Monitor] Channel scan: ${channelVideos.length} videos, ${allDiscovered.length} total new`);
  }

  scanState.videosFound = allDiscovered.length + (existingVids?.length || 0);
  scanState.videosNew = allDiscovered.length;
  scanState.searchQuotaUsed = dailySearchUsed;

  if (!allDiscovered.length) {
    console.log('[Monitor] No new videos');
    await logScanEnd(logId!, { found: 0, new_: 0, classified: 0, errors });
    scanState.done = true; scanState.running = false;
    return { videosDiscovered: 0, videosClassified: 0 };
  }

  // ═══════════════════════════════════════
  // Phase 3: Channel profiles (new channels)
  // ═══════════════════════════════════════
  const uniqueChannelIds = [...new Set(allDiscovered.map(v => v.channelId))];
  const newChannelIds = uniqueChannelIds.filter(id => !knownCreators?.some((c: any) => c.channel_id === id));
  if (newChannelIds.length) {
    dailyGeneralUsed += Math.ceil(newChannelIds.length / 50);
    const channels = await getChannelsByIds(newChannelIds);
    for (const ch of channels) await getOrCreateCreatorProfile(ch.channelId, ch.channelName);
  }

  // ═══════════════════════════════════════
  // Phase 4: AI Classification
  // ═══════════════════════════════════════
  let sponsorshipResults: Awaited<ReturnType<typeof detectSponsorshipBatch>>;
  let topicResults: Awaited<ReturnType<typeof classifyTopicsBatch>>;

  if (!options?.skipAI) {
    console.log(`[Monitor] AI classifying ${allDiscovered.length} videos`);
    sponsorshipResults = await detectSponsorshipBatch(allDiscovered.map(v => ({
      title: v.title, description: v.description, channelName: v.channelTitle, tags: v.tags, hasPaidPlacementTag: v.hasPaidPlacementTag,
    })));
    topicResults = await classifyTopicsBatch(allDiscovered.map(v => ({
      title: v.title, description: v.description, tags: v.tags, channelName: v.channelTitle,
    })));
  } else {
    const empty = { placementType: 'unknown' as const, sponsorConfidence: 0.1, detectedBrand: null, brandMentionPositions: [] as string[], promoCode: null, landingDomain: null, ctaType: null, sellingPoints: [] as string[], reasoning: 'AI skipped' };
    sponsorshipResults = allDiscovered.map(() => empty);
    topicResults = allDiscovered.map(() => ({ gameName: null, gameConfidence: 0, contentCategory: 'integrated_placement', topicCategory: 'game_integration', language: 'en', market: 'US' }));
  }

  // ═══════════════════════════════════════
  // Phase 5: Save
  // ═══════════════════════════════════════
  console.log('[Monitor] Saving results');
  for (let i = 0; i < allDiscovered.length; i++) {
    const video = allDiscovered[i];
    const sp = sponsorshipResults[i];
    const tp = topicResults[i];

    let brandId: string | null = null;
    if (sp.detectedBrand) {
      const { data: br } = await db.from('competitor_brands').select('id').eq('brand_name', sp.detectedBrand).maybeSingle();
      brandId = br?.id || null;
    }

    const row = {
      video_id: video.videoId, brand_id: brandId, channel_id: video.channelId, channel_name: video.channelTitle,
      title: video.title, description: video.description, published_at: video.publishedAt,
      duration: video.duration, is_short: video.isShort, thumbnail_url: video.thumbnailUrl, tags: video.tags,
      language: tp.language, market: tp.market, category_id: video.categoryId,
      discovery_method: (video as any).discoveryMethod || 'keyword_search',
      has_paid_placement_tag: video.hasPaidPlacementTag,
      game_name: tp.gameName, content_type: tp.contentCategory,
      placement_type: sp.placementType, sponsor_confidence: sp.sponsorConfidence,
      brand_mention_position: sp.brandMentionPositions, topic_category: tp.topicCategory,
      promo_code: sp.promoCode, landing_domain: sp.landingDomain, cta_type: sp.ctaType,
      product_selling_points: sp.sellingPoints,
      view_count: video.viewCount, like_count: video.likeCount, comment_count: video.commentCount,
      workflow_status: 'classified',
      classification_raw: { sponsorship: sp, topic: tp, classifiedAt: new Date().toISOString() },
      first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
    };

    const { error } = await db.from('youtube_competitor_videos').upsert(row, { onConflict: 'video_id' });
    if (!error) await updateCreatorFromVideo(video.channelId, video.channelTitle, tp, sp, video.viewCount);
  }

  // ═══════════════════════════════════════
  // Phase 6: Comments (targeted)
  // ═══════════════════════════════════════
  if (!options?.skipComments) {
    const highRelevance = allDiscovered.filter((_, i) => {
      const s = sponsorshipResults[i];
      return s.placementType === 'confirmed_paid_placement' || s.placementType === 'likely_sponsored';
    }).filter(v => v.commentCount >= 10);

    console.log(`[Monitor] Comments for ${highRelevance.length} high-relevance videos`);
    for (const video of highRelevance) {
      if (await hasExistingComments(video.videoId)) continue;
      dailyGeneralUsed += 1;
      const comments = await fetchVideoComments(video.videoId, 30, 'relevance');
      if (comments.length > 0) {
        await saveComments(video.videoId, comments);
        if (!options?.skipAI) {
          const idx = allDiscovered.indexOf(video);
          await classifyAndUpdateComments(video.videoId, comments.map(c => ({ commentId: c.commentId, text: c.text })), sponsorshipResults[idx]?.detectedBrand || 'GearUP');
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // Phase 7: Snapshots
  // ═══════════════════════════════════════
  for (const video of allDiscovered) {
    const idx = allDiscovered.indexOf(video);
    await saveSnapshot(video.videoId, 'discovery',
      Math.round((Date.now() - new Date(video.publishedAt).getTime()) / 3600000),
      video.viewCount, video.likeCount, video.commentCount, 0,
      sponsorshipResults[idx]?.sponsorConfidence || 0.5, video.isShort);
  }

  await logScanEnd(logId!, { found: allDiscovered.length + (existingVids?.length || 0), new_: allDiscovered.length, classified: allDiscovered.length, errors });
  scanState = { ...scanState, done: true, running: false, videosFound: allDiscovered.length, errors };

  console.log(`[Monitor] Complete: ${allDiscovered.length} videos | search: ${dailySearchUsed}/100 | general: ${dailyGeneralUsed}/10000`);
  return { videosDiscovered: allDiscovered.length, videosClassified: allDiscovered.length };
}

export async function getMonitorStatus() {
  const db = getSupabase();
  const { count: tv } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: cr } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: lv } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();

  return {
    totalVideos: tv || 0,
    totalCreators: (cr || []).length,
    lastRun: (lv as any)?.created_at || null,
    searchQuotaUsed: dailySearchUsed,
    searchQuotaLimit: 100,
    generalQuotaUsed: dailyGeneralUsed,
    generalQuotaLimit: 10000,
    hotspotActive: (cfg as any)?.hotspot_active || false,
    scanRunning: scanState.running,
  };
}

// ── Schedule quota reset at midnight Pacific (15:00 Beijing) ──
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() === 7 && now.getUTCMinutes() === 0) {
    resetDailyQuota();
    console.log('[Monitor] Daily quota reset');
  }
}, 60000);

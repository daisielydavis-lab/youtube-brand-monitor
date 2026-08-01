/**
 * Competitor Monitor — Main Orchestrator
 *
 * Quota-aware pipeline (search quota = 100/day = 1 search.list call):
 *   1. Run 1 search.list with the most overdue query (cost: 100 search units)
 *   2. Scan known creators' recent uploads via playlistItems.list (NO search quota)
 *   3. Deduplicate + enrich + AI classify + save
 */

import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries } from './brand-config';
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
import { generateDailyReport, generateWeeklyReport, formatDailyReportText } from './competitor-report';

export async function runDiscoveryPipeline(options?: {
  backfillDays?: number;
  skipComments?: boolean;
  skipAI?: boolean;
  skipReport?: boolean;
}): Promise<{ videosDiscovered: number; videosClassified: number; snapshotsCreated: number }> {
  const missing = validateConfig();
  if (missing.length) {
    console.error(`[Monitor] Missing config: ${missing.join(', ')}`);
    throw new Error(`Missing config: ${missing.join(', ')}`);
  }

  const backfillDays = options?.backfillDays ?? 1;
  const publishedAfter = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Monitor] Starting pipeline — scanning since ${publishedAfter}`);
  const db = getSupabase();

  const allDiscovered: YouTubeVideoResult[] = [];
  const seenVideoIds = new Set<string>();

  // Dedup: load existing video IDs
  const { data: existingVideos } = await db
    .from('youtube_competitor_videos')
    .select('video_id')
    .gte('first_seen_at', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());
  (existingVideos || []).forEach((v: any) => seenVideoIds.add(v.video_id));

  // ═══════════════════════════════════════
  // Phase 1: Run 1 search (cost: 100 search units)
  // ═══════════════════════════════════════
  const queries = getActiveQueries();

  // Find the most overdue query
  const { data: queryRuns } = await db
    .from('competitor_queries')
    .select('query_text, last_run_at')
    .order('last_run_at', { ascending: true, nullsFirst: true });

  const runMap = new Map<string, string>();
  (queryRuns || []).forEach((q: any) => runMap.set(q.query_text, q.last_run_at));

  // Sort queries: never-run first, then oldest
  const sortedQueries = [...queries].sort((a, b) => {
    const aLast = runMap.get(a.queryText);
    const bLast = runMap.get(b.queryText);
    if (!aLast && bLast) return -1;
    if (aLast && !bLast) return 1;
    if (!aLast && !bLast) return 0;
    return new Date(aLast!).getTime() - new Date(bLast!).getTime();
  });

  const queryToRun = sortedQueries[0];
  console.log(`[Monitor] Running 1 search: "${queryToRun.queryText}" (budget: 100 units)`);

  const searchResults = await searchVideos(queryToRun, publishedAfter, 20);
  for (const r of searchResults) {
    if (!seenVideoIds.has(r.videoId)) {
      seenVideoIds.add(r.videoId);
      allDiscovered.push(r);
    }
  }

  // Update last_run_at in Supabase
  await db
    .from('competitor_queries')
    .update({ last_run_at: new Date().toISOString() })
    .eq('query_text', queryToRun.queryText);

  console.log(`[Monitor] Search found ${searchResults.length} videos, ${allDiscovered.length} new`);

  // ═══════════════════════════════════════
  // Phase 2: Scan known creators (NO search quota!)
  // ═══════════════════════════════════════
  const { data: knownCreators } = await db
    .from('youtube_creator_profiles')
    .select('channel_id')
    .limit(200);

  if (knownCreators && knownCreators.length > 0) {
    const channelIds = knownCreators.map((c: any) => c.channel_id);
    console.log(`[Monitor] Scanning ${channelIds.length} known creators (playlistItems — free quota)`);

    const channelVideos = await getChannelsRecentVideos(channelIds, publishedAfter, 5);
    for (const r of channelVideos) {
      if (!seenVideoIds.has(r.videoId)) {
        seenVideoIds.add(r.videoId);
        (r as any).discoveryMethod = 'channel_scan';
        allDiscovered.push(r);
      }
    }

    console.log(`[Monitor] Channel scan found ${channelVideos.length} videos, ${allDiscovered.length} total new`);
  }

  if (!allDiscovered.length) {
    console.log('[Monitor] No new videos to process');
    return { videosDiscovered: 0, videosClassified: 0, snapshotsCreated: 0 };
  }

  // ═══════════════════════════════════════
  // Phase 3: Channel profiles (new channels only)
  // ═══════════════════════════════════════
  console.log(`[Monitor] Phase 3: Channel enrichment for ${allDiscovered.length} videos`);

  const uniqueChannelIds = [...new Set(allDiscovered.map(v => v.channelId))];
  const newChannelIds = uniqueChannelIds.filter(id => !knownCreators?.some((c: any) => c.channel_id === id));
  if (newChannelIds.length > 0) {
    const channels = await getChannelsByIds(newChannelIds);
    for (const ch of channels) {
      await getOrCreateCreatorProfile(ch.channelId, ch.channelName);
    }
  }

  // ═══════════════════════════════════════
  // Phase 4: AI Classification
  // ═══════════════════════════════════════
  let sponsorshipResults: Awaited<ReturnType<typeof detectSponsorshipBatch>> = [];
  let topicResults: Awaited<ReturnType<typeof classifyTopicsBatch>> = [];

  if (!options?.skipAI) {
    console.log(`[Monitor] Phase 4: AI classifying ${allDiscovered.length} videos`);

    sponsorshipResults = await detectSponsorshipBatch(
      allDiscovered.map(v => ({
        title: v.title, description: v.description, channelName: v.channelTitle,
        tags: v.tags, hasPaidPlacementTag: v.hasPaidPlacementTag,
      })),
    );

    topicResults = await classifyTopicsBatch(
      allDiscovered.map(v => ({
        title: v.title, description: v.description, tags: v.tags, channelName: v.channelTitle,
      })),
    );
  } else {
    sponsorshipResults = allDiscovered.map(() => ({
      placementType: 'unknown' as const, sponsorConfidence: 0.1, detectedBrand: null,
      brandMentionPositions: [], promoCode: null, landingDomain: null, ctaType: null,
      sellingPoints: [], reasoning: 'AI skipped',
    }));
    topicResults = allDiscovered.map(() => ({
      gameName: null, gameConfidence: 0, contentCategory: 'integrated_placement',
      topicCategory: 'game_integration', language: 'en', market: 'US',
    }));
  }

  // ═══════════════════════════════════════
  // Phase 5: Save to Supabase
  // ═══════════════════════════════════════
  console.log('[Monitor] Phase 5: Saving results');

  for (let i = 0; i < allDiscovered.length; i++) {
    const video = allDiscovered[i];
    const sponsorship = sponsorshipResults[i];
    const topic = topicResults[i];

    let brandId: string | null = null;
    if (sponsorship.detectedBrand) {
      const { data: brand } = await db.from('competitor_brands')
        .select('id').eq('brand_name', sponsorship.detectedBrand).maybeSingle();
      brandId = brand?.id || null;
    }

    const videoRow = {
      video_id: video.videoId, brand_id: brandId, channel_id: video.channelId,
      channel_name: video.channelTitle, title: video.title, description: video.description,
      published_at: video.publishedAt, duration: video.duration, is_short: video.isShort,
      thumbnail_url: video.thumbnailUrl, tags: video.tags,
      language: topic.language, market: topic.market, category_id: video.categoryId,
      discovery_method: (video as any).discoveryMethod || 'keyword_search',
      has_paid_placement_tag: video.hasPaidPlacementTag,
      game_name: topic.gameName, content_type: topic.contentCategory,
      placement_type: sponsorship.placementType,
      sponsor_confidence: sponsorship.sponsorConfidence,
      brand_mention_position: sponsorship.brandMentionPositions,
      topic_category: topic.topicCategory,
      promo_code: sponsorship.promoCode, landing_domain: sponsorship.landingDomain,
      cta_type: sponsorship.ctaType, product_selling_points: sponsorship.sellingPoints,
      view_count: video.viewCount, like_count: video.likeCount, comment_count: video.commentCount,
      classification_raw: { sponsorship, topic, classifiedAt: new Date().toISOString() },
      first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
    };

    const { error } = await db.from('youtube_competitor_videos').upsert(videoRow, { onConflict: 'video_id' });
    if (!error) {
      await updateCreatorFromVideo(video.channelId, video.channelTitle, topic, sponsorship, video.viewCount);
    }
  }

  // ═══════════════════════════════════════
  // Phase 6: Comment extraction (high-relevance only)
  // ═══════════════════════════════════════
  if (!options?.skipComments) {
    console.log('[Monitor] Phase 6: Comments');
    const highRelevance = allDiscovered.filter((_, i) => {
      const s = sponsorshipResults[i];
      return s.placementType === 'confirmed_paid_placement' || s.placementType === 'likely_sponsored' || s.sponsorConfidence >= 0.5;
    });

    for (const video of highRelevance) {
      if (await hasExistingComments(video.videoId)) continue;
      const comments = await fetchVideoComments(video.videoId, 30, 'relevance');
      if (comments.length > 0) {
        await saveComments(video.videoId, comments);
        if (!options?.skipAI) {
          const idx = allDiscovered.indexOf(video);
          const brand = sponsorshipResults[idx]?.detectedBrand || 'GearUP';
          await classifyAndUpdateComments(video.videoId, comments.map(c => ({ commentId: c.commentId, text: c.text })), brand);
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // Phase 7: Snapshots + Report
  // ═══════════════════════════════════════
  console.log('[Monitor] Phase 7: Snapshots');

  for (const video of allDiscovered) {
    const idx = allDiscovered.indexOf(video);
    await saveSnapshot(video.videoId, 'discovery',
      Math.round((Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60)),
      video.viewCount, video.likeCount, video.commentCount, 0,
      sponsorshipResults[idx]?.sponsorConfidence || 0.5, video.isShort,
    );
  }

  if (!options?.skipReport) {
    console.log('[Monitor] Phase 8: Reports');
    const dailyReport = await generateDailyReport();
    console.log('\n' + formatDailyReportText(dailyReport).slice(0, 500));
    if (new Date().getDay() === 1) await generateWeeklyReport();
  }

  console.log(`[Monitor] Complete: ${allDiscovered.length} videos`);
  return { videosDiscovered: allDiscovered.length, videosClassified: allDiscovered.length, snapshotsCreated: allDiscovered.length };
}

export async function runBackfill(days = 30): Promise<void> {
  console.log(`[Monitor] Backfill ${days} days`);
  await runDiscoveryPipeline({ backfillDays: days, skipReport: true });
  await generateWeeklyReport();
}

export async function getMonitorStatus(): Promise<{
  totalVideos: number; totalCreators: number;
  byBrand: Record<string, number>; byPlacement: Record<string, number>;
  lastRun: string | null;
}> {
  const db = getSupabase();
  const { count: totalVideos } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: creators } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: allVids } = await db.from('youtube_competitor_videos').select('classification_raw');
  const { data: lastVid } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();

  const brandCounts: Record<string, number> = {};
  const placementCounts: Record<string, number> = {};
  for (const v of (allVids || [])) {
    const brand = (v as any).classification_raw?.sponsorship?.detectedBrand || 'unknown';
    brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    const p = (v as any).classification_raw?.sponsorship?.placementType || 'unknown';
    placementCounts[p] = (placementCounts[p] || 0) + 1;
  }

  return {
    totalVideos: totalVideos || 0, totalCreators: (creators || []).length,
    byBrand: brandCounts, byPlacement: placementCounts,
    lastRun: (lastVid as any)?.created_at || null,
  };
}

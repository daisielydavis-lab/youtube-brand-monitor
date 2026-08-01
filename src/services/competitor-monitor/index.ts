/**
 * Competitor Monitor — Main Orchestrator
 *
 * Daily pipeline:
 *   1. Incremental search via search.list for each brand query
 *   2. Deduplicate against existing videos in Supabase
 *   3. Fetch full video + channel data
 *   4. Extract comments for high-relevance videos
 *   5. AI classification (sponsorship + topic + comments)
 *   6. Save to Supabase
 *   7. Compute initial performance snapshot
 *   8. Generate daily/weekly reports
 */

import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, getBrandConfig, type BrandQuery } from './brand-config';
import {
  searchVideos,
  searchPaidPlacements,
  getChannelsByIds,
  type YouTubeVideoResult,
} from './youtube-discovery';
import {
  fetchVideoComments,
  hasExistingComments,
  saveComments,
  preFilterComments,
} from './video-enrichment';
import { detectSponsorshipBatch } from './sponsorship-detector';
import { classifyTopicsBatch, classifyAndUpdateComments } from './topic-classifier';
import { getOrCreateCreatorProfile, updateCreatorFromVideo } from './creator-profiler';
import { saveSnapshot, processPendingSnapshots } from './performance-snapshot';
import { generateDailyReport, generateWeeklyReport, formatDailyReportText } from './competitor-report';

/** Full pipeline: discover → enrich → classify → snapshot → report */
export async function runDiscoveryPipeline(options?: {
  backfillDays?: number;      // How many days back to search (default 1)
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
  const publishedAfter = new Date(
    Date.now() - backfillDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  console.log(`[Monitor] Starting discovery pipeline — scanning since ${publishedAfter}`);
  const db = getSupabase();

  // ── Phase 1: Discovery ──
  console.log('[Monitor] Phase 1: Discovery');

  const queries = getActiveQueries();
  const allDiscovered: YouTubeVideoResult[] = [];
  const seenVideoIds = new Set<string>();

  // Get existing video IDs for dedup
  const { data: existingVideos } = await db
    .from('youtube_competitor_videos')
    .select('video_id')
    .gte('first_seen_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  (existingVideos || []).forEach((v: any) => seenVideoIds.add(v.video_id));

  // Search each query
  for (const query of queries) {
    const results = await searchVideos(query, publishedAfter, 15);
    for (const r of results) {
      if (!seenVideoIds.has(r.videoId)) {
        seenVideoIds.add(r.videoId);
        allDiscovered.push(r);
      }
    }
  }

  // Also search for paid placement tagged videos
  const paidResults = await searchPaidPlacements(publishedAfter, 20);
  for (const r of paidResults) {
    if (!seenVideoIds.has(r.videoId)) {
      seenVideoIds.add(r.videoId);
      allDiscovered.push(r);
    }
  }

  console.log(`[Monitor] Discovered ${allDiscovered.length} new videos (${existingVideos?.length || 0} already known)`);

  if (!allDiscovered.length) {
    console.log('[Monitor] No new videos to process');
    return { videosDiscovered: 0, videosClassified: 0, snapshotsCreated: 0 };
  }

  // ── Phase 2: Channel enrichment ──
  console.log('[Monitor] Phase 2: Channel enrichment');

  const uniqueChannelIds = [...new Set(allDiscovered.map(v => v.channelId))];
  const channels = await getChannelsByIds(uniqueChannelIds);

  for (const ch of channels) {
    await getOrCreateCreatorProfile(ch.channelId, ch.channelName);
  }

  // ── Phase 3: AI Classification ──
  let sponsorshipResults: Awaited<ReturnType<typeof detectSponsorshipBatch>> = [];
  let topicResults: Awaited<ReturnType<typeof classifyTopicsBatch>> = [];

  if (!options?.skipAI) {
    console.log(`[Monitor] Phase 3: AI Classification (${allDiscovered.length} videos)`);

    // Run sponsorship + topic classification in sequence (they share LLM rate limits)
    sponsorshipResults = await detectSponsorshipBatch(
      allDiscovered.map(v => ({
        title: v.title,
        description: v.description,
        channelName: v.channelTitle,
        tags: v.tags,
        hasPaidPlacementTag: v.hasPaidPlacementTag,
      })),
    );

    topicResults = await classifyTopicsBatch(
      allDiscovered.map(v => ({
        title: v.title,
        description: v.description,
        tags: v.tags,
        channelName: v.channelTitle,
      })),
    );
  } else {
    console.log('[Monitor] Skipping AI classification (skipAI=true)');
    // Provide empty defaults
    sponsorshipResults = allDiscovered.map(() => ({
      placementType: 'unknown' as const,
      sponsorConfidence: 0.1,
      detectedBrand: null,
      brandMentionPositions: [],
      promoCode: null,
      landingDomain: null,
      ctaType: null,
      sellingPoints: [],
      reasoning: 'AI classification skipped',
    }));
    topicResults = allDiscovered.map(v => ({
      gameName: null,
      gameConfidence: 0,
      contentCategory: 'integrated_placement' as const,
      topicCategory: 'game_integration' as const,
      language: 'en',
      market: 'US' as const,
    }));
  }

  // ── Phase 4: Save to Supabase ──
  console.log('[Monitor] Phase 4: Saving to Supabase');

  for (let i = 0; i < allDiscovered.length; i++) {
    const video = allDiscovered[i];
    const sponsorship = sponsorshipResults[i];
    const topic = topicResults[i];

    // Find which brand this relates to
    let brandId: string | null = null;
    if (sponsorship.detectedBrand) {
      const { data: brand } = await db
        .from('competitor_brands')
        .select('id')
        .eq('brand_name', sponsorship.detectedBrand)
        .maybeSingle();
      brandId = brand?.id || null;
    }

    const videoRow = {
      video_id: video.videoId,
      brand_id: brandId,
      channel_id: video.channelId,
      channel_name: video.channelTitle,
      title: video.title,
      description: video.description,
      published_at: video.publishedAt,
      duration: video.duration,
      is_short: video.isShort,
      thumbnail_url: video.thumbnailUrl,
      tags: video.tags,
      language: topic.language,
      market: topic.market,
      category_id: video.categoryId,
      discovery_method: video.discoveryMethod,
      has_paid_placement_tag: video.hasPaidPlacementTag,
      game_name: topic.gameName,
      content_type: topic.contentCategory,
      placement_type: sponsorship.placementType,
      sponsor_confidence: sponsorship.sponsorConfidence,
      brand_mention_position: sponsorship.brandMentionPositions,
      topic_category: topic.topicCategory,
      promo_code: sponsorship.promoCode,
      landing_domain: sponsorship.landingDomain,
      cta_type: sponsorship.ctaType,
      product_selling_points: sponsorship.sellingPoints,
      view_count: video.viewCount,
      like_count: video.likeCount,
      comment_count: video.commentCount,
      classification_raw: {
        sponsorship,
        topic,
        classifiedAt: new Date().toISOString(),
      },
      first_seen_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    };

    const { error } = await db
      .from('youtube_competitor_videos')
      .upsert(videoRow, { onConflict: 'video_id' });

    if (error) {
      console.error(`[Monitor] Failed to save video ${video.videoId}: ${error.message}`);
    } else {
      // Update creator profile
      await updateCreatorFromVideo(
        video.channelId,
        video.channelTitle,
        topic,
        sponsorship,
        video.viewCount,
      );
    }
  }

  // ── Phase 5: Comment extraction (high-relevance videos only) ──
  if (!options?.skipComments) {
    console.log('[Monitor] Phase 5: Comment extraction');

    const highRelevanceVideos = allDiscovered.filter((_, i) => {
      const s = sponsorshipResults[i];
      return s.placementType === 'confirmed_paid_placement' ||
             s.placementType === 'likely_sponsored' ||
             s.sponsorConfidence >= 0.5;
    });

    for (const video of highRelevanceVideos) {
      const alreadyHasComments = await hasExistingComments(video.videoId);
      if (alreadyHasComments) {
        console.log(`[Monitor] Comments already exist for ${video.videoId}, skipping`);
        continue;
      }

      const comments = await fetchVideoComments(video.videoId, 50, 'relevance');
      if (comments.length > 0) {
        await saveComments(video.videoId, comments);

        // Classify comments if AI is enabled
        if (!options?.skipAI) {
          const i = allDiscovered.indexOf(video);
          const brand = sponsorshipResults[i]?.detectedBrand || 'GearUP';
          await classifyAndUpdateComments(
            video.videoId,
            comments.map(c => ({ commentId: c.commentId, text: c.text })),
            brand,
          );
        }
      }
    }
  }

  // ── Phase 6: Initial performance snapshots ──
  console.log('[Monitor] Phase 6: Performance snapshots');

  for (const video of allDiscovered) {
    const i = allDiscovered.indexOf(video);
    const channel = channels.find(c => c.channelId === video.channelId);

    await saveSnapshot(
      video.videoId,
      'discovery',
      Math.round((Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60)),
      video.viewCount,
      video.likeCount,
      video.commentCount,
      channel?.subscriberCount || 0,
      sponsorshipResults[i]?.sponsorConfidence || 0.5,
      video.isShort,
    );
  }

  // Also process pending snapshots for older videos
  await processPendingSnapshots();

  // ── Phase 7: Reports ──
  if (!options?.skipReport) {
    console.log('[Monitor] Phase 7: Report generation');

    const dailyReport = await generateDailyReport();
    const reportText = formatDailyReportText(dailyReport);
    console.log('\n' + reportText);

    // Generate weekly on Mondays
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) {
      await generateWeeklyReport();
      console.log('[Monitor] Weekly report generated (Monday)');
    }
  }

  console.log(`[Monitor] Pipeline complete: ${allDiscovered.length} discovered, ${allDiscovered.length} classified`);
  return {
    videosDiscovered: allDiscovered.length,
    videosClassified: allDiscovered.length,
    snapshotsCreated: allDiscovered.length,
  };
}

/** Backfill: scan past N days */
export async function runBackfill(days: number = 30): Promise<void> {
  console.log(`[Monitor] Running backfill for past ${days} days`);
  await runDiscoveryPipeline({ backfillDays: days, skipReport: true });
  // Generate a final report after backfill
  await generateWeeklyReport();
  console.log('[Monitor] Backfill complete');
}

/** Quick status check */
export async function getMonitorStatus(): Promise<{
  totalVideos: number;
  totalCreators: number;
  byBrand: Record<string, number>;
  byPlacement: Record<string, number>;
  lastRun: string | null;
}> {
  const db = getSupabase();

  const { count: totalVideos } = await db
    .from('youtube_competitor_videos')
    .select('id', { count: 'exact', head: true });

  const { data: creators } = await db
    .from('youtube_creator_profiles')
    .select('channel_id');

  const { data: byBrand } = await db
    .from('youtube_competitor_videos')
    .select('classification_raw');

  const { data: lastVideo } = await db
    .from('youtube_competitor_videos')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Count by brand
  const brandCounts: Record<string, number> = {};
  const placementCounts: Record<string, number> = {};

  for (const v of (byBrand || [])) {
    const brand = (v as any).classification_raw?.sponsorship?.detectedBrand || 'unknown';
    brandCounts[brand] = (brandCounts[brand] || 0) + 1;

    const placement = (v as any).classification_raw?.sponsorship?.placementType || 'unknown';
    placementCounts[placement] = (placementCounts[placement] || 0) + 1;
  }

  return {
    totalVideos: totalVideos || 0,
    totalCreators: (creators || []).length,
    byBrand: brandCounts,
    byPlacement: placementCounts,
    lastRun: (lastVideo as any)?.created_at || null,
  };
}

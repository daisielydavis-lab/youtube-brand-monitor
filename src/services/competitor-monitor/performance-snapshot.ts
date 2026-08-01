/**
 * Performance Snapshot Engine.
 * Computes time-series metrics for YouTube competitor videos:
 *
 * Core metrics:
 *   - view_velocity = Δviews ÷ Δhours
 *   - engagement_rate = (likes + comments) / views
 *   - view_subscriber_ratio = views / channel_subscribers
 *   - purchase_intent_comment_rate = purchase_intent_comments / total_analyzed_comments
 *
 * Public Performance Score (0–100):
 *   - View velocity: 30 points
 *   - Engagement rate: 20 points
 *   - View/subscriber ratio: 20 points
 *   - Purchase intent in comments: 15 points
 *   - Brand placement strength: 10 points
 *   - Content-game match: 5 points
 *
 * NEVER output as: ROI, CPA, conversion rate, ad spend
 */

import { getSupabase } from '../../db/supabase';

export interface SnapshotMetrics {
  videoId: string;
  snapshotType: 'discovery' | '24h' | '72h' | '7d' | '30d';
  hoursSincePublish: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  viewVelocity: number;
  engagementRate: number;
  viewSubscriberRatio: number;
  purchaseIntentCommentRate: number;
  publicPerformanceScore: number;
  capturedAt: string;
}

export interface PerformanceScoreInput {
  viewVelocity: number;
  engagementRate: number;
  viewSubscriberRatio: number;
  purchaseIntentCommentRate: number;
  sponsorConfidence: number;
  contentGameMatch: number; // 0-1, how relevant the content is to the game
  isShort: boolean;
}

/**
 * Calculate Public Performance Score (0-100).
 *
 * Weight distribution:
 *   View velocity:     30 points  (normalized against typical ranges)
 *   Engagement rate:   20 points
 *   View/sub ratio:    20 points
 *   Purchase intent:   15 points
 *   Brand strength:    10 points  (sponsor confidence)
 *   Content-game fit:   5 points
 */
export function calculatePerformanceScore(input: PerformanceScoreInput): number {
  // ── View velocity (30 points) ──
  // Normalize: < 100/hr = low, 100-500 = medium, 500-2000 = high, > 2000 = viral
  let velocityScore: number;
  if (input.isShort) {
    // Shorts have much higher velocities, scale differently
    velocityScore = Math.min(30, (Math.log10(input.viewVelocity + 1) / Math.log10(10000)) * 30);
  } else {
    if (input.viewVelocity <= 100) velocityScore = input.viewVelocity / 100 * 10;
    else if (input.viewVelocity <= 500) velocityScore = 10 + (input.viewVelocity - 100) / 400 * 10;
    else if (input.viewVelocity <= 2000) velocityScore = 20 + (input.viewVelocity - 500) / 1500 * 7;
    else velocityScore = 27 + Math.min(3, (input.viewVelocity - 2000) / 5000 * 3);
  }

  // ── Engagement rate (20 points) ──
  // Typical: 1-5% = normal, 5-10% = good, > 10% = excellent
  let engagementScore: number;
  const er = input.engagementRate * 100; // Convert to percentage
  if (er <= 1) engagementScore = er / 1 * 5;
  else if (er <= 5) engagementScore = 5 + (er - 1) / 4 * 8;
  else if (er <= 10) engagementScore = 13 + (er - 5) / 5 * 5;
  else engagementScore = 18 + Math.min(2, (er - 10) / 10 * 2);

  // ── View/subscriber ratio (20 points) ──
  // If subs=0 or hidden, scale based on absolute views
  let ratioScore: number;
  if (input.viewSubscriberRatio <= 0) {
    ratioScore = 10; // Unknown — give neutral score
  } else {
    const ratio = input.viewSubscriberRatio;
    if (ratio >= 2) ratioScore = 20;          // Views 2x+ subscribers = viral for that channel
    else if (ratio >= 1) ratioScore = 18;     // Views ≥ subscribers = strong
    else if (ratio >= 0.5) ratioScore = 14;   // Half subscribers = good
    else if (ratio >= 0.2) ratioScore = 10;   // Decent
    else if (ratio >= 0.1) ratioScore = 6;    // Low
    else ratioScore = 3;                       // Very low
  }

  // ── Purchase intent in comments (15 points) ──
  let purchaseScore: number;
  const pi = input.purchaseIntentCommentRate * 100;
  if (pi >= 20) purchaseScore = 15;
  else if (pi >= 10) purchaseScore = 12;
  else if (pi >= 5) purchaseScore = 9;
  else if (pi >= 2) purchaseScore = 6;
  else if (pi > 0) purchaseScore = 3;
  else purchaseScore = 0;

  // ── Brand placement strength (10 points) ──
  const brandScore = Math.round(input.sponsorConfidence * 10);

  // ── Content-game match (5 points) ──
  const matchScore = Math.round(input.contentGameMatch * 5);

  const total = Math.round(
    velocityScore + engagementScore + ratioScore + purchaseScore + brandScore + matchScore,
  );

  return Math.max(0, Math.min(100, total));
}

/** Calculate metrics from raw data */
export function computeMetrics(
  currentViews: number,
  previousViews: number,
  hoursElapsed: number,
  likes: number,
  comments: number,
  subscriberCount: number,
  purchaseIntentComments: number,
  totalAnalyzedComments: number,
): {
  viewVelocity: number;
  engagementRate: number;
  viewSubscriberRatio: number;
  purchaseIntentCommentRate: number;
} {
  const viewVelocity = hoursElapsed > 0
    ? (currentViews - previousViews) / hoursElapsed
    : 0;

  const engagementRate = currentViews > 0
    ? (likes + comments) / currentViews
    : 0;

  const viewSubscriberRatio = subscriberCount > 0
    ? currentViews / subscriberCount
    : 0;

  const purchaseIntentCommentRate = totalAnalyzedComments > 0
    ? purchaseIntentComments / totalAnalyzedComments
    : 0;

  return {
    viewVelocity: Math.max(0, viewVelocity),
    engagementRate: Math.min(1, engagementRate),
    viewSubscriberRatio,
    purchaseIntentCommentRate: Math.min(1, purchaseIntentCommentRate),
  };
}

/** Save a snapshot for a video at a specific interval */
export async function saveSnapshot(
  videoId: string,
  snapshotType: SnapshotMetrics['snapshotType'],
  hoursSincePublish: number,
  viewCount: number,
  likeCount: number,
  commentCount: number,
  subscriberCount: number,
  sponsorConfidence: number,
  isShort: boolean,
): Promise<SnapshotMetrics | null> {
  const db = getSupabase();

  // Get previous snapshot for velocity calculation
  const { data: previousSnapshot } = await db
    .from('youtube_video_snapshots')
    .select('view_count, captured_at')
    .eq('video_id', videoId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let previousViews = 0;
  let hoursSincePrevious = hoursSincePublish;

  if (previousSnapshot) {
    previousViews = previousSnapshot.view_count || 0;
    const prevTime = new Date(previousSnapshot.captured_at).getTime();
    const now = Date.now();
    hoursSincePrevious = (now - prevTime) / (1000 * 60 * 60);
  }

  // Get purchase intent from comments
  const { data: commentsData } = await db
    .from('youtube_comment_insights')
    .select('has_purchase_intent')
    .eq('video_id', videoId);

  const totalComments = commentsData?.length || 0;
  const purchaseIntentComments = commentsData?.filter((c: any) => c.has_purchase_intent).length || 0;

  const metrics = computeMetrics(
    viewCount,
    previousViews,
    hoursSincePrevious > 0 ? hoursSincePrevious : hoursSincePublish,
    likeCount,
    commentCount,
    subscriberCount,
    purchaseIntentComments,
    totalComments,
  );

  const score = calculatePerformanceScore({
    viewVelocity: metrics.viewVelocity,
    engagementRate: metrics.engagementRate,
    viewSubscriberRatio: metrics.viewSubscriberRatio,
    purchaseIntentCommentRate: metrics.purchaseIntentCommentRate,
    sponsorConfidence,
    contentGameMatch: 0.5, // Default; can be refined
    isShort,
  });

  // Check if snapshot already exists for this type
  const { data: existing } = await db
    .from('youtube_video_snapshots')
    .select('id')
    .eq('video_id', videoId)
    .eq('snapshot_type', snapshotType)
    .maybeSingle();

  const snapshotRow = {
    video_id: videoId,
    snapshot_type: snapshotType,
    hours_since_publish: hoursSincePublish,
    view_count: viewCount,
    like_count: likeCount,
    comment_count: commentCount,
    view_velocity: metrics.viewVelocity,
    engagement_rate: metrics.engagementRate,
    view_subscriber_ratio: metrics.viewSubscriberRatio,
    purchase_intent_comment_rate: metrics.purchaseIntentCommentRate,
    public_performance_score: score,
    snapshot_data: {
      previousViews,
      hoursSincePrevious,
      purchaseIntentComments,
      totalAnalyzedComments: totalComments,
      sponsorConfidence,
    },
    captured_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await db
      .from('youtube_video_snapshots')
      .update(snapshotRow)
      .eq('id', existing.id);
    if (error) {
      console.error(`[Snapshot] Update failed for ${videoId}: ${error.message}`);
      return null;
    }
  } else {
    const { error } = await db
      .from('youtube_video_snapshots')
      .insert(snapshotRow);
    if (error) {
      console.error(`[Snapshot] Insert failed for ${videoId}: ${error.message}`);
      return null;
    }
  }

  // Update the video's performance_score in the main table
  await db
    .from('youtube_competitor_videos')
    .update({ public_performance_score: score, last_updated_at: new Date().toISOString() })
    .eq('video_id', videoId);

  console.log(`[Snapshot] ${snapshotType} saved for ${videoId}: score=${score}/100, velocity=${metrics.viewVelocity.toFixed(1)} views/hr`);

  return {
    videoId,
    snapshotType,
    hoursSincePublish,
    viewCount,
    likeCount,
    commentCount,
    viewVelocity: metrics.viewVelocity,
    engagementRate: metrics.engagementRate,
    viewSubscriberRatio: metrics.viewSubscriberRatio,
    purchaseIntentCommentRate: metrics.purchaseIntentCommentRate,
    publicPerformanceScore: score,
    capturedAt: snapshotRow.captured_at,
  };
}

/** Process all pending snapshots for due videos */
export async function processPendingSnapshots(): Promise<number> {
  const db = getSupabase();
  const now = Date.now();

  // Find videos that need snapshot updates
  const { data: videos } = await db
    .from('youtube_competitor_videos')
    .select('video_id, published_at, view_count, like_count, comment_count, channel_id, sponsor_confidence, is_short')
    .order('published_at', { ascending: false })
    .limit(100);

  if (!videos || !videos.length) {
    console.log('[Snapshot] No videos to snapshot');
    return 0;
  }

  let processed = 0;

  for (const v of videos) {
    const publishedAt = new Date(v.published_at).getTime();
    const hoursSincePublish = (now - publishedAt) / (1000 * 60 * 60);

    if (hoursSincePublish < 0) continue; // Future-dated? Skip

    // Determine which snapshot types are due
    // Discovery: always take on first run
    // 24h: after 20-28 hours since publish
    // 72h: after 65-79 hours
    // 7d: after 160-176 hours
    // 30d: after 700-744 hours

    const dueSnapshots: SnapshotMetrics['snapshotType'][] = [];

    // Check which snapshots already exist
    const { data: existingSnapshots } = await db
      .from('youtube_video_snapshots')
      .select('snapshot_type')
      .eq('video_id', v.video_id);

    const existingTypes = new Set((existingSnapshots || []).map((s: any) => s.snapshot_type));

    if (!existingTypes.has('discovery')) {
      dueSnapshots.push('discovery');
    }
    if (hoursSincePublish >= 20 && hoursSincePublish <= 30 && !existingTypes.has('24h')) {
      dueSnapshots.push('24h');
    }
    if (hoursSincePublish >= 65 && hoursSincePublish <= 79 && !existingTypes.has('72h')) {
      dueSnapshots.push('72h');
    }
    if (hoursSincePublish >= 160 && hoursSincePublish <= 180 && !existingTypes.has('7d')) {
      dueSnapshots.push('7d');
    }
    if (hoursSincePublish >= 700 && hoursSincePublish <= 750 && !existingTypes.has('30d')) {
      dueSnapshots.push('30d');
    }

    if (!dueSnapshots.length) continue;

    // Get channel subscriber count
    const { data: channel } = await db
      .from('youtube_creator_profiles')
      .select('subscriber_count')
      .eq('channel_id', v.channel_id)
      .maybeSingle();

    const subscriberCount = channel?.subscriber_count || 0;

    for (const snapType of dueSnapshots) {
      await saveSnapshot(
        v.video_id,
        snapType,
        Math.round(hoursSincePublish),
        v.view_count,
        v.like_count,
        v.comment_count,
        subscriberCount,
        v.sponsor_confidence || 0.5,
        v.is_short || false,
      );
      processed++;
    }
  }

  console.log(`[Snapshot] Processed ${processed} snapshots across ${videos.length} videos`);
  return processed;
}

/**
 * Creator Profiler — builds and updates YouTube creator profiles.
 * Tracks channel stats, brand mention history, primary games, and collaboration patterns.
 */

import { getSupabase } from '../../db/supabase';
import { getChannelById, type YouTubeChannelResult } from './youtube-discovery';
import type { TopicResult } from './topic-classifier';
import type { SponsorshipResult } from './sponsorship-detector';

export interface CreatorProfile {
  channelId: string;
  channelName: string;
  channelUrl: string;
  description: string;
  subscriberCount: number;
  totalViews: number;
  videoCount: number;
  thumbnailUrl: string;
  country?: string;
  primaryLanguage: string;
  primaryGames: string[];
  pastBrandMentions: Record<string, number>;
  hasPromoCodeHistory: boolean;
  promoCodesUsed: string[];
  avgViewsRecent: number;
  collaborationBrands: string[];
}

/** Get or create a creator profile, optionally updating from YouTube API */
export async function getOrCreateCreatorProfile(
  channelId: string,
  channelName?: string,
  refreshFromYouTube = false,
): Promise<CreatorProfile | null> {
  const db = getSupabase();

  // Check existing
  const { data: existing } = await db
    .from('youtube_creator_profiles')
    .select('*')
    .eq('channel_id', channelId)
    .maybeSingle();

  if (existing && !refreshFromYouTube) {
    return mapProfileFromDb(existing);
  }

  // Fetch from YouTube API
  const channel = await getChannelById(channelId);
  if (!channel) {
    if (existing) return mapProfileFromDb(existing);
    return null;
  }

  const profile = {
    channel_id: channel.channelId,
    channel_name: channel.channelName || channelName || '',
    channel_url: channel.channelUrl,
    description: channel.description,
    subscriber_count: channel.subscriberCount,
    total_views: channel.totalViews,
    video_count: channel.videoCount,
    thumbnail_url: channel.thumbnailUrl,
    country: channel.country,
    primary_language: 'en',
    primary_games: [] as string[],
    past_brand_mentions: {} as Record<string, number>,
    has_promo_code_history: false,
    promo_codes_used: [] as string[],
    avg_views_recent: 0,
    collaboration_brands: [] as string[],
    first_seen_at: existing?.first_seen_at || new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from('youtube_creator_profiles')
    .upsert(profile, { onConflict: 'channel_id' });

  if (error) {
    console.error(`[CreatorProfiler] Upsert failed for ${channelId}: ${error.message}`);
    return null;
  }

  console.log(`[CreatorProfiler] Profile updated: ${profile.channel_name} (${profile.subscriber_count} subs)`);
  return mapProfileFromDb(profile);
}

/** Update creator profile after processing a new video */
export async function updateCreatorFromVideo(
  channelId: string,
  channelName: string,
  topicResult: TopicResult,
  sponsorshipResult: SponsorshipResult,
  viewCount: number,
): Promise<void> {
  const db = getSupabase();

  const { data: profile } = await db
    .from('youtube_creator_profiles')
    .select('*')
    .eq('channel_id', channelId)
    .maybeSingle();

  if (!profile) {
    // Create new profile
    await getOrCreateCreatorProfile(channelId, channelName, true);
    return;
  }

  // Update fields
  const updates: Record<string, unknown> = {
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Track game
  if (topicResult.gameName) {
    const games: string[] = profile.primary_games || [];
    if (!games.includes(topicResult.gameName)) {
      games.push(topicResult.gameName);
      updates.primary_games = games.slice(0, 10); // Keep top 10
    }
  }

  // Track brand mentions
  if (sponsorshipResult.detectedBrand) {
    const mentions = profile.past_brand_mentions || {};
    const brand = sponsorshipResult.detectedBrand;
    mentions[brand] = (mentions[brand] || 0) + 1;
    updates.past_brand_mentions = mentions;
  }

  // Track promo codes
  if (sponsorshipResult.promoCode) {
    const codes: string[] = profile.promo_codes_used || [];
    if (!codes.includes(sponsorshipResult.promoCode)) {
      codes.push(sponsorshipResult.promoCode);
      updates.promo_codes_used = codes;
      updates.has_promo_code_history = true;
    }
  }

  // Track collaboration brands
  if (sponsorshipResult.placementType === 'confirmed_paid_placement' ||
      sponsorshipResult.placementType === 'likely_sponsored') {
    const brands: string[] = profile.collaboration_brands || [];
    if (sponsorshipResult.detectedBrand && !brands.includes(sponsorshipResult.detectedBrand)) {
      brands.push(sponsorshipResult.detectedBrand);
      updates.collaboration_brands = brands;
    }
  }

  // Update language if detected
  if (topicResult.language && topicResult.language !== 'en') {
    updates.primary_language = topicResult.language;
  }

  await db
    .from('youtube_creator_profiles')
    .update(updates)
    .eq('channel_id', channelId);

  // Recalculate recent average views
  await recalculateRecentViews(channelId);
}

/** Recalculate average views from recent videos for a creator */
async function recalculateRecentViews(channelId: string): Promise<void> {
  const db = getSupabase();

  const { data: recentVideos } = await db
    .from('youtube_competitor_videos')
    .select('view_count')
    .eq('channel_id', channelId)
    .order('published_at', { ascending: false })
    .limit(10);

  if (!recentVideos || !recentVideos.length) return;

  const avgViews = Math.round(
    recentVideos.reduce((sum: number, v: any) => sum + (v.view_count || 0), 0) / recentVideos.length,
  );

  await db
    .from('youtube_creator_profiles')
    .update({ avg_views_recent: avgViews, updated_at: new Date().toISOString() })
    .eq('channel_id', channelId);
}

/** Get all tracked creators */
export async function getAllCreators(): Promise<CreatorProfile[]> {
  const db = getSupabase();
  const { data } = await db
    .from('youtube_creator_profiles')
    .select('*')
    .order('subscriber_count', { ascending: false });

  return (data || []).map(mapProfileFromDb);
}

/** Detect anomalies: creator switching brands, unusual activity */
export async function detectCreatorAnomalies(): Promise<string[]> {
  const db = getSupabase();
  const anomalies: string[] = [];

  const { data: profiles } = await db
    .from('youtube_creator_profiles')
    .select('*');

  if (!profiles) return anomalies;

  for (const p of profiles) {
    const brands = (p.collaboration_brands || []) as string[];
    const mentions = (p.past_brand_mentions || {}) as Record<string, number>;

    // Creator recently switched primary brand (more mentions of new brand than old)
    const brandEntries = Object.entries(mentions).sort((a, b) => b[1] - a[1]);
    if (brandEntries.length >= 2 && brandEntries[0][1] > brandEntries[1][1] * 2) {
      anomalies.push(
        `Creator "${p.channel_name}" shows ${brandEntries[0][1]} ${brandEntries[0][0]} mentions vs ${brandEntries[1][1]} ${brandEntries[1][1]} — possible brand switch`,
      );
    }

    // Creator with promo codes from multiple competing brands
    const uniqueCodes = (p.promo_codes_used || []) as string[];
    if (uniqueCodes.length >= 3) {
      anomalies.push(
        `Creator "${p.channel_name}" has used ${uniqueCodes.length} different promo codes — high commercial activity`,
      );
    }
  }

  return anomalies;
}

function mapProfileFromDb(row: any): CreatorProfile {
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelUrl: row.channel_url,
    description: row.description || '',
    subscriberCount: row.subscriber_count || 0,
    totalViews: row.total_views || 0,
    videoCount: row.video_count || 0,
    thumbnailUrl: row.thumbnail_url || '',
    country: row.country,
    primaryLanguage: row.primary_language || 'en',
    primaryGames: row.primary_games || [],
    pastBrandMentions: row.past_brand_mentions || {},
    hasPromoCodeHistory: row.has_promo_code_history || false,
    promoCodesUsed: row.promo_codes_used || [],
    avgViewsRecent: row.avg_views_recent || 0,
    collaborationBrands: row.collaboration_brands || [],
  };
}

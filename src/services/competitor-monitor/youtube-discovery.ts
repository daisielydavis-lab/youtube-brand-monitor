/**
 * YouTube Data API — discovery layer.
 * Handles search.list, videos.list, channels.list with quota awareness.
 *
 * Quota costs (per call):
 *   search.list = 100 units
 *   videos.list = 1 unit
 *   channels.list = 1 unit
 *   commentThreads.list = 1 unit
 *
 * Daily quota: 10,000 units (free tier)
 */

import axios from 'axios';
import { config } from '../../config';
import type { BrandQuery } from './brand-config';

const API_KEY = config.youtube.apiKey;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideoResult {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  isShort: boolean;
  thumbnailUrl: string;
  tags: string[];
  categoryId: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  hasPaidPlacementTag: boolean;
  /** The query that discovered this video */
  discoveryQuery?: string;
  discoveryMethod: 'keyword_search' | 'paid_placement_tag';
}

export interface YouTubeChannelResult {
  channelId: string;
  channelName: string;
  channelUrl: string;
  description: string;
  subscriberCount: number;
  totalViews: number;
  videoCount: number;
  thumbnailUrl: string;
  country?: string;
}

/** Check if video is a YouTube Short based on duration */
function isYouTubeShort(duration: string): boolean {
  // Parse ISO 8601 duration: PT#M#S or PT#H#M#S
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return false;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  // Shorts are ≤60 seconds (YouTube's definition)
  return totalSeconds <= 60 && totalSeconds > 0;
}

/** Search for videos matching a query, with incremental date filtering */
export async function searchVideos(
  query: BrandQuery,
  publishedAfter: string, // ISO date string
  maxResults = 20,
): Promise<YouTubeVideoResult[]> {
  if (!API_KEY) {
    console.error('[YouTube] No API key configured');
    return [];
  }

  try {
    const params: Record<string, string | number> = {
      part: 'snippet',
      q: query.queryText,
      type: 'video',
      maxResults,
      order: 'date',
      publishedAfter,
      regionCode: query.targetMarket,
      relevanceLanguage: query.targetLanguage,
      key: API_KEY,
    };

    const { data } = await axios.get(`${YT_BASE}/search`, { params, timeout: 15000 });
    const items = data?.items || [];
    const videoIds: string[] = items.map((i: any) => i.id?.videoId).filter(Boolean);

    if (!videoIds.length) {
      console.log(`[YouTube] No results for "${query.queryText}" since ${publishedAfter}`);
      return [];
    }

    console.log(`[YouTube] search "${query.queryText}" → ${videoIds.length} videos found`);

    // Batch get full video details
    const videos = await getVideosByIds(videoIds);

    // Tag with discovery metadata
    return videos.map(v => ({
      ...v,
      discoveryQuery: query.queryText,
      discoveryMethod: 'keyword_search' as const,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[YouTube] search failed for "${query.queryText}": ${msg}`);
    return [];
  }
}

/** Search for videos marked as containing paid promotion */
export async function searchPaidPlacements(
  publishedAfter: string,
  maxResults = 20,
): Promise<YouTubeVideoResult[]> {
  if (!API_KEY) return [];

  try {
    // We search brand-keywords combined with the paid placement filter
    // YouTube doesn't support searching ONLY by paid placement tag,
    // so we search broad gaming booster terms + filter
    const broadQueries = ['game booster', 'reduce lag', 'fix ping', 'gaming vpn', 'best booster'];

    const allResults: YouTubeVideoResult[] = [];
    const seen = new Set<string>();

    for (const q of broadQueries) {
      if (allResults.length >= maxResults) break;

      const { data } = await axios.get(`${YT_BASE}/search`, {
        params: {
          part: 'snippet',
          q,
          type: 'video',
          maxResults: 10,
          order: 'date',
          publishedAfter,
          videoPaidProductPlacement: true,
          key: API_KEY,
        },
        timeout: 15000,
      });

      const items = data?.items || [];
      const videoIds: string[] = items
        .map((i: any) => i.id?.videoId)
        .filter((id: string) => id && !seen.has(id));

      if (videoIds.length) {
        videoIds.forEach(id => seen.add(id));
        const videos = await getVideosByIds(videoIds);
        allResults.push(...videos.map(v => ({
          ...v,
          hasPaidPlacementTag: true,
          discoveryMethod: 'paid_placement_tag' as const,
        })));
      }
    }

    console.log(`[YouTube] Paid placement scan → ${allResults.length} videos`);
    return allResults.slice(0, maxResults);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[YouTube] Paid placement search failed: ${msg}`);
    return [];
  }
}

/** Get video details by IDs (videos.list) */
export async function getVideosByIds(videoIds: string[]): Promise<YouTubeVideoResult[]> {
  if (!API_KEY || !videoIds.length) return [];

  const results: YouTubeVideoResult[] = [];
  // Process in batches of 50 (API limit)
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const { data } = await axios.get(`${YT_BASE}/videos`, {
        params: {
          part: 'snippet,statistics,contentDetails',
          id: batch.join(','),
          key: API_KEY,
        },
        timeout: 15000,
      });

      const items = data?.items || [];
      for (const v of items) {
        const snippet = v.snippet || {};
        const stats = v.statistics || {};
        const contentDetails = v.contentDetails || {};
        const duration = contentDetails.duration || 'PT0S';
        const isShort = isYouTubeShort(duration);

        results.push({
          videoId: v.id,
          title: snippet.title || '',
          description: snippet.description || '',
          channelId: snippet.channelId || '',
          channelTitle: snippet.channelTitle || '',
          publishedAt: snippet.publishedAt || '',
          duration,
          isShort,
          thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '',
          viewCount: parseInt(stats.viewCount || '0', 10),
          likeCount: parseInt(stats.likeCount || '0', 10),
          commentCount: parseInt(stats.commentCount || '0', 10),
          hasPaidPlacementTag: false,
          discoveryMethod: 'keyword_search',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[YouTube] videos.list batch failed: ${msg}`);
    }
  }

  return results;
}

/** Get single video by ID */
export async function getVideoById(videoId: string): Promise<YouTubeVideoResult | null> {
  const results = await getVideosByIds([videoId]);
  return results[0] || null;
}

/** Get channel details (channels.list) */
export async function getChannelById(channelId: string): Promise<YouTubeChannelResult | null> {
  if (!API_KEY) return null;

  try {
    const { data } = await axios.get(`${YT_BASE}/channels`, {
      params: {
        part: 'snippet,statistics,brandingSettings',
        id: channelId,
        key: API_KEY,
      },
      timeout: 15000,
    });

    const channel = data?.items?.[0];
    if (!channel) return null;

    const snippet = channel.snippet || {};
    const stats = channel.statistics || {};

    return {
      channelId: channel.id,
      channelName: snippet.title || '',
      channelUrl: `https://www.youtube.com/channel/${channel.id}`,
      description: snippet.description || '',
      subscriberCount: parseInt(stats.subscriberCount || '0', 10),
      totalViews: parseInt(stats.viewCount || '0', 10),
      videoCount: parseInt(stats.videoCount || '0', 10),
      thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
      country: snippet.country || undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[YouTube] channels.list failed for ${channelId}: ${msg}`);
    return null;
  }
}

/** Get channels in batch */
export async function getChannelsByIds(channelIds: string[]): Promise<YouTubeChannelResult[]> {
  if (!API_KEY || !channelIds.length) return [];

  const results: YouTubeChannelResult[] = [];
  const uniqueIds = [...new Set(channelIds)];

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    try {
      const { data } = await axios.get(`${YT_BASE}/channels`, {
        params: {
          part: 'snippet,statistics',
          id: batch.join(','),
          key: API_KEY,
        },
        timeout: 15000,
      });

      const items = data?.items || [];
      for (const c of items) {
        const snippet = c.snippet || {};
        const stats = c.statistics || {};
        results.push({
          channelId: c.id,
          channelName: snippet.title || '',
          channelUrl: `https://www.youtube.com/channel/${c.id}`,
          description: snippet.description || '',
          subscriberCount: parseInt(stats.subscriberCount || '0', 10),
          totalViews: parseInt(stats.viewCount || '0', 10),
          videoCount: parseInt(stats.videoCount || '0', 10),
          thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
          country: snippet.country || undefined,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[YouTube] channels.list batch failed: ${msg}`);
    }
  }

  return results;
}

/** Estimate quota usage for a discovery run */
export function estimateQuota(
  searchQueries: number,
  videoIdsPerQuery: number,
  channelIds: number,
  commentVideos: number,
): { searchCost: number; videoCost: number; channelCost: number; commentCost: number; total: number } {
  const searchCost = searchQueries * 100; // 100 units per search
  const videoCost = Math.ceil(videoIdsPerQuery * searchQueries / 50); // 1 unit per videos.list call (batch of 50)
  const channelCost = Math.ceil(channelIds / 50); // 1 unit per channels.list call (batch of 50)
  const commentCost = commentVideos; // 1 unit per commentThreads.list call
  return {
    searchCost,
    videoCost,
    channelCost,
    commentCost,
    total: searchCost + videoCost + channelCost + commentCost,
  };
}

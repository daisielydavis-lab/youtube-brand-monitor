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

/**
 * 2026-08-16 Discovery 层重构（用户 P0-1）：
 * Search 只负责发现新博主，Playlist 负责监控，batchGetStats 负责复查。
 * search.list 每翻一页算一次调用 —— maxPages 控制页数上限，quotaBudget 控制总调用数。
 */

export interface SearchPageResult {
  videos: YouTubeVideoResult[];
  /** 实际消耗的 search.list 调用数（页数） */
  pagesUsed: number;
  /** 还有更多页没拉（超出 maxPages）—— 调用方应拆时间窗口 */
  hadMore: boolean;
}

/** 分页搜索：pageToken 翻页 + publishedBefore 时间窗口闭合。
 *  注意 regionCode 只是"可观看区域"约束，不是博主市场标签（用户口径）。 */
export async function searchVideosPaged(
  query: BrandQuery,
  publishedAfter: string,   // ISO
  publishedBefore?: string, // ISO，可省略（不闭合右边界）
  maxPages = 1,
  maxResultsPerPage = 50,
): Promise<SearchPageResult> {
  const out: YouTubeVideoResult[] = [];
  if (!API_KEY) { console.error('[YouTube] No API key configured'); return { videos: out, pagesUsed: 0, hadMore: false }; }

  let pageToken = '';
  let pagesUsed = 0;
  let hadMore = false;
  const allVideoIds: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    try {
      const params: Record<string, string | number> = {
        part: 'snippet',
        q: query.queryText,
        type: 'video',
        maxResults: maxResultsPerPage,
        order: 'date',
        publishedAfter,
        regionCode: query.targetMarket,
        relevanceLanguage: query.targetLanguage,
        key: API_KEY,
      };
      if (publishedBefore) params.publishedBefore = publishedBefore;
      if (pageToken) params.pageToken = pageToken;

      const { data } = await axios.get(`${YT_BASE}/search`, { params, timeout: 15000 });
      pagesUsed++;
      const items = data?.items || [];
      for (const i of items) {
        const id = i.id?.videoId;
        if (id && !seen.has(id)) { seen.add(id); allVideoIds.push(id); }
      }
      hadMore = !!data?.nextPageToken;
      if (!data?.nextPageToken || pagesUsed >= maxPages) break;
      pageToken = data.nextPageToken;
    } catch (err) {
      const ae = err as { response?: { status?: number; data?: any; headers?: any } };
      const status = ae.response?.status;
      const data = ae.response?.data;
      const reason = data?.error?.errors?.[0]?.reason || data?.error?.message || 'unknown';
      const retryAfter = ae.response?.headers?.['retry-after'];
      console.error(`[YouTube] search ${status||'ERR'} for "${query.queryText}": reason=${reason} retryAfter=${retryAfter||'none'} body=${JSON.stringify(data).slice(0,400)}`);
      if (status === 429 || status === 403 || reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
        throw new Error(`YT_QUOTA_EXHAUSTED:${reason}`);
      }
      break; // 非配额错误：放弃剩余页，保留已拿到的
    }
  }

  console.log(`[YouTube] search "${query.queryText}" [${publishedAfter.slice(0,10)} → ${publishedBefore?.slice(0,10) || 'now'}] → ${allVideoIds.length} videos in ${pagesUsed} page(s)${hadMore ? ' (more available)' : ''}`);

  if (allVideoIds.length) {
    const videos = await getVideosByIds(allVideoIds);
    out.push(...videos.map(v => ({ ...v, discoveryQuery: query.queryText, discoveryMethod: 'keyword_search' as const })));
  }
  return { videos: out, pagesUsed, hadMore };
}

/** Search for videos matching a query, with incremental date filtering（单页兼容入口） */
export async function searchVideos(
  query: BrandQuery,
  publishedAfter: string, // ISO date string
  maxResults = 20,
): Promise<YouTubeVideoResult[]> {
  const res = await searchVideosPaged(query, publishedAfter, undefined, 1, maxResults);
  return res.videos;
}

export interface TimeSliceResult {
  videos: YouTubeVideoResult[];
  searchCalls: number;
  windows: Array<{ from: string; to: string; count: number; split: boolean }>;
}

/**
 * 动态时间分片回填（用户 P0-1 核心）：
 * 不做"搜 LagZapper → Top 50"，而是把 [startIso, endIso] 切成窗口：
 *   7 天窗口 → 首页满 50 且有下一页 → 先翻页（maxPages 内）→ 仍 hadMore → 窗口拆半递归
 *   → 3 天 → 1 天（minWindowDays 下限）。
 * 每个窗口 order=date + publishedAfter/publishedBefore 闭合，翻页拉全。
 * search.list 每翻一页算一次调用 —— 由 quotaBudget 上限保护。
 */
export async function searchBackfillTimeSliced(
  query: BrandQuery,
  startIso: string,
  endIso: string,
  opts: {
    initialWindowDays?: number;
    minWindowDays?: number;
    maxPages?: number;
    quotaBudget?: number;      // 该品牌 search.list 调用上限（0 = 不限）
    onSearchCall?: () => void; // 每次 search 调用回调（用于 quota 记账/中止检查）
  } = {},
): Promise<TimeSliceResult> {
  const initialWindowDays = opts.initialWindowDays ?? 7;
  const minWindowDays = opts.minWindowDays ?? 1;
  const maxPages = opts.maxPages ?? 3;
  const budget = opts.quotaBudget ?? 0;
  const out: YouTubeVideoResult[] = [];
  const seen = new Set<string>();
  const windows: TimeSliceResult['windows'] = [];
  let searchCalls = 0;

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  const processWindow = async (wStartMs: number, wEndMs: number, windowDays: number): Promise<void> => {
    for (let s = wStartMs; s < wEndMs; s += windowDays * 86400000) {
      if (budget > 0 && searchCalls >= budget) return;
      const from = new Date(s).toISOString();
      const to = new Date(Math.min(s + windowDays * 86400000, wEndMs)).toISOString();
      opts.onSearchCall?.();
      const res = await searchVideosPaged(query, from, to, maxPages, 50);
      searchCalls += res.pagesUsed;
      const fresh = res.videos.filter(v => !seen.has(v.videoId));
      fresh.forEach(v => seen.add(v.videoId));
      out.push(...fresh);
      windows.push({ from, to, count: res.videos.length, split: false });
      // 满页且仍有更多 → 拆半递归重扫该窗口（父窗口已搜过，seen 去重；代价是重复 search 调用，受预算保护）
      if ((res.hadMore || res.videos.length >= 50) && windowDays > minWindowDays) {
        const half = Math.max(minWindowDays, Math.floor(windowDays / 2));
        await processWindow(s, Math.min(s + windowDays * 86400000, wEndMs), half);
      }
    }
  };

  await processWindow(startMs, endMs, initialWindowDays);
  return { videos: out, searchCalls, windows };
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

/** Get recent videos from a channel's uploads playlist (uses NO search quota!) */
export async function getChannelRecentVideos(
  channelId: string,
  maxResults = 10,
): Promise<YouTubeVideoResult[]> {
  if (!API_KEY) return [];

  try {
    // Step 1: Get the uploads playlist ID
    const { data: chData } = await axios.get(`${YT_BASE}/channels`, {
      params: { part: 'contentDetails', id: channelId, key: API_KEY },
      timeout: 10000,
    });

    const uploadsPlaylistId = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return [];

    // Step 2: Get recent videos from playlist
    const { data: plData } = await axios.get(`${YT_BASE}/playlistItems`, {
      params: { part: 'snippet', playlistId: uploadsPlaylistId, maxResults, key: API_KEY },
      timeout: 10000,
    });

    const items = plData?.items || [];
    const videoIds: string[] = items.map((i: any) => i.snippet?.resourceId?.videoId).filter(Boolean);
    if (!videoIds.length) return [];

    return getVideosByIds(videoIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[YouTube] Channel videos failed for ${channelId}: ${msg}`);
    return [];
  }
}

/** Batch get recent videos from known channels (no search quota — uses playlistItems.list) */
export async function getChannelsRecentVideos(
  channelIds: string[],
  publishedAfter: string,
  maxPerChannel = 5,
): Promise<YouTubeVideoResult[]> {
  const results: YouTubeVideoResult[] = [];
  for (const id of channelIds) {
    const videos = await getChannelRecentVideos(id, maxPerChannel);
    // Filter by publish date
    results.push(...videos.filter(v => v.publishedAt >= publishedAfter));
  }
  return results;
}


// ── Performance Refresh: batch stats for known video IDs (T+3/T+7) ──
// 只刷新已入库 video_id 的公开统计，绝不使用 search.list，绝不调 AI。
// 优先 videos.batchGetStats（独立配额池，1 unit/批），失败 fallback
// videos.list part=statistics（general 池，1 unit/视频）。
let statsBatchQuotaUsed = 0;
export function getStatsBatchQuotaUsed() { return statsBatchQuotaUsed; }

export async function fetchStatsBatch(
  videoIds: string[],
): Promise<Record<string, { viewCount: number | null; likeCount: number | null; commentCount: number | null }>> {
  const out: Record<string, { viewCount: number | null; likeCount: number | null; commentCount: number | null }> = {};
  if (!API_KEY || !videoIds.length) return out;
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    let items: any[] | null = null;
    try {
      const { data } = await axios.get(`${YT_BASE}/videos/batchGetStats`, {
        params: { ids: batch.join(','), key: API_KEY },
        timeout: 20000,
      });
      items = data?.items || null;
      if (items) statsBatchQuotaUsed += 1;
    } catch { items = null; }
    if (!items) {
      try {
        const { data } = await axios.get(`${YT_BASE}/videos`, {
          params: { part: 'statistics', id: batch.join(','), key: API_KEY },
          timeout: 20000,
        });
        items = data?.items || [];
        statsBatchQuotaUsed += batch.length;
      } catch (err) {
        console.error(`[YouTube] fetchStatsBatch failed batch:`, (err as Error).message);
        continue;
      }
    }
    if (!items) continue;
    for (const v of items) {
      const s = v.statistics || {};
      out[v.id] = {
        viewCount: s.viewCount != null ? parseInt(s.viewCount, 10) : null,
        likeCount: s.likeCount != null ? parseInt(s.likeCount, 10) : null,
        commentCount: s.commentCount != null ? parseInt(s.commentCount, 10) : null,
      };
    }
  }
  return out;
}

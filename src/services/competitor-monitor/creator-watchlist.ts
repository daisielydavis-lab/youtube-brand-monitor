/**
 * Creator Watchlist（用户 P0-2/P0-3，2026-08-16）
 *
 * 原则（用户指定）：Search 只负责发现新博主；已确认投放（Layer 3）的 Creator
 * 自动进入品牌 Watchlist；Watchlist 用 playlistItems.list 扫 uploads playlist
 * 监控已知博主（1 unit/页，不占 Search 池），确保已知博主不漏视频。
 *
 * 表 youtube_creator_watchlist 由 supabase-migration-watchlist.sql 创建；
 * 表不存在时本模块所有函数 try/catch 降级返回空，不阻塞主流程。
 */

import axios from 'axios';
import { config } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getVideosByIds, type YouTubeVideoResult } from './youtube-discovery';

const API_KEY = config.youtube.apiKey;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export interface WatchlistCreator {
  brand: string;
  channel_id: string;
  channel_name?: string;
  market?: string;
  uploads_playlist_id?: string;
  discovered_via?: string;
  status?: string;
  first_seen_at?: string;
  last_scan_at?: string;
  last_video_at?: string;
}

/** 已确认投放的 Creator 自动加入品牌 Watchlist（幂等 upsert） */
export async function upsertWatchlistCreator(
  brand: string,
  channelId: string,
  channelName: string,
  market?: string,
  discoveredVia = 'ai_confirmed',
): Promise<void> {
  try {
    const db = getSupabase();
    const { error } = await db.from('youtube_creator_watchlist').upsert({
      brand, channel_id: channelId, channel_name: channelName,
      market: market || null, discovered_via: discoveredVia, status: 'active',
      last_scan_at: null,
    }, { onConflict: 'brand,channel_id' });
    if (error) console.error(`[Watchlist] upsert fail ${channelId}: ${error.message}`);
  } catch (err) {
    console.error(`[Watchlist] upsert ${channelId} degraded (table missing?):`, (err as Error).message);
  }
}

/** 拉取 active watchlist（可只取指定品牌） */
export async function getWatchlistCreators(brands?: string[]): Promise<WatchlistCreator[]> {
  try {
    const db = getSupabase();
    let q: any = db.from('youtube_creator_watchlist').select('*').eq('status', 'active');
    if (brands?.length) q = q.in('brand', brands);
    const { data, error } = await q;
    if (error) { console.error('[Watchlist] fetch fail:', error.message); return []; }
    return (data || []) as WatchlistCreator[];
  } catch (err) {
    console.error('[Watchlist] fetch degraded (table missing?):', (err as Error).message);
    return [];
  }
}

export interface WatchlistScanResult {
  videos: YouTubeVideoResult[];
  channelsChecked: number;
  playlistCalls: number;
  channelCalls: number; // channels.list 调用数（无缓存 playlist id 的频道）
}

/**
 * 扫描 Watchlist 频道的 uploads playlist。
 * - playlist id 缓存到表里，避免每次 channels.list
 * - 分页拉全（最多 maxPages 页），playlist 按时间倒序，遇到早于 publishedAfter 的提前停
 * - 每页 playlistItems.list = 1 unit（General 池）
 */
export async function scanWatchlistUploads(
  brands?: string[],
  publishedAfter?: string,
  maxPages = 3,
): Promise<WatchlistScanResult> {
  const result: WatchlistScanResult = { videos: [], channelsChecked: 0, playlistCalls: 0, channelCalls: 0 };
  if (!API_KEY) return result;

  const watch = await getWatchlistCreators(brands);
  if (!watch.length) return result;

  const db = getSupabase();

  for (const w of watch) {
    try {
      let playlistId = w.uploads_playlist_id || '';
      if (!playlistId) {
        const { data: chData } = await axios.get(`${YT_BASE}/channels`, {
          params: { part: 'contentDetails', id: w.channel_id, key: API_KEY },
          timeout: 10000,
        });
        result.channelCalls++;
        playlistId = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || '';
        if (playlistId) {
          try {
            await db.from('youtube_creator_watchlist')
              .update({ uploads_playlist_id: playlistId })
              .eq('channel_id', w.channel_id).eq('brand', w.brand);
          } catch { /* 表缺失/并发：忽略 */ }
        }
      }
      if (!playlistId) continue;
      result.channelsChecked++;

      // 分页拉 uploads（时间倒序）
      const videoIds: string[] = [];
      let pageToken = '';
      let got = 0;
      let pages = 0;
      for (;;) {
        const params: Record<string, string> = { part: 'snippet', playlistId, maxResults: '50', key: API_KEY };
        if (pageToken) params.pageToken = pageToken;
        const { data: plData } = await axios.get(`${YT_BASE}/playlistItems`, { params, timeout: 10000 });
        result.playlistCalls++;
        pages++;
        const items = plData?.items || [];
        let allOlder = true;
        for (const it of items) {
          const vid = it.snippet?.resourceId?.videoId;
          const pub = it.snippet?.publishedAt;
          if (!vid) continue;
          if (publishedAfter && pub && pub < publishedAfter) continue; // 早于窗口
          if (pub && publishedAfter && pub >= publishedAfter) allOlder = false;
          videoIds.push(vid);
        }
        got += items.length;
        // playlist 时间倒序：整页都比窗口早 → 后面的更早，直接停
        if (allOlder || !plData?.nextPageToken || pages >= maxPages) break;
        pageToken = plData.nextPageToken;
      }

      if (videoIds.length) {
        const videos = await getVideosByIds(videoIds);
        result.videos.push(...videos);
        const latest = videos.map(v => v.publishedAt).sort().pop();
        try {
          await db.from('youtube_creator_watchlist')
            .update({ last_scan_at: new Date().toISOString(), last_video_at: latest || null })
            .eq('channel_id', w.channel_id).eq('brand', w.brand);
        } catch { /* 表缺失/并发：忽略 */ }
      } else {
        try {
          await db.from('youtube_creator_watchlist')
            .update({ last_scan_at: new Date().toISOString() })
            .eq('channel_id', w.channel_id).eq('brand', w.brand);
        } catch { /* 表缺失/并发：忽略 */ }
      }
    } catch (err) {
      console.error(`[Watchlist] scan fail ${w.channel_id}:`, (err as Error).message);
    }
  }
  return result;
}

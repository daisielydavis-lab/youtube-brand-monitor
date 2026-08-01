/**
 * Video enrichment — comment extraction and analysis.
 * Fetches top comments for high-relevance videos via commentThreads.list.
 */

import axios from 'axios';
import { config } from '../../config';
import { getSupabase } from '../../db/supabase';

const API_KEY = config.youtube.apiKey;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeComment {
  commentId: string;
  videoId: string;
  text: string;
  authorName: string;
  likeCount: number;
  publishedAt: string;
  replyCount: number;
}

/** Fetch top comments for a video */
export async function fetchVideoComments(
  videoId: string,
  maxResults = 50,
  order: 'relevance' | 'time' = 'relevance',
): Promise<YouTubeComment[]> {
  if (!API_KEY) {
    console.error('[Comments] No API key configured');
    return [];
  }

  try {
    const { data } = await axios.get(`${YT_BASE}/commentThreads`, {
      params: {
        part: 'snippet',
        videoId,
        maxResults,
        order,
        key: API_KEY,
      },
      timeout: 15000,
    });

    const items = data?.items || [];
    const comments: YouTubeComment[] = items.map((item: any) => {
      const snippet = item.snippet?.topLevelComment?.snippet || {};
      return {
        commentId: item.id,
        videoId: snippet.videoId || videoId,
        text: snippet.textDisplay || snippet.textOriginal || '',
        authorName: snippet.authorDisplayName || '',
        likeCount: snippet.likeCount || 0,
        publishedAt: snippet.publishedAt || '',
        replyCount: item.snippet?.totalReplyCount || 0,
      };
    });

    console.log(`[Comments] ${videoId}: ${comments.length} comments fetched (order=${order})`);
    return comments;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Comments] Failed for ${videoId}: ${msg}`);
    return [];
  }
}

/** Check if we already have comments for a video in Supabase */
export async function hasExistingComments(videoId: string): Promise<boolean> {
  try {
    const { count, error } = await getSupabase()
      .from('youtube_comment_insights')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', videoId);

    if (error) return false;
    return (count || 0) > 0;
  } catch {
    return false;
  }
}

/** Save comments to Supabase */
export async function saveComments(
  videoId: string,
  comments: YouTubeComment[],
): Promise<number> {
  if (!comments.length) return 0;

  const db = getSupabase();
  const rows = comments.map(c => ({
    video_id: videoId,
    comment_id: c.commentId,
    comment_text: c.text,
    author_name: c.authorName,
    like_count: c.likeCount,
    published_at: c.publishedAt,
    reply_count: c.replyCount,
    // AI classification fields default to null — filled by classifier later
  }));

  const { error } = await db
    .from('youtube_comment_insights')
    .upsert(rows, { onConflict: 'comment_id', ignoreDuplicates: true });

  if (error) {
    console.error(`[Comments] Failed to save for ${videoId}: ${error.message}`);
    return 0;
  }

  console.log(`[Comments] Saved ${rows.length} comments for ${videoId}`);
  return rows.length;
}

/** Extract promo codes and domain mentions from comments (regex pre-filter before AI) */
export function preFilterComments(comments: YouTubeComment[]): {
  potentialPurchaseIntent: YouTubeComment[];
  potentialBrandMention: YouTubeComment[];
  other: YouTubeComment[];
} {
  const promoKeywords = /\b(code|coupon|discount|promo|free|trial|price|cost|worth|buy|work|legit|download)\b/i;
  const brandKeywords = /\b(gearup|exitlag|lagzapper|lag zapper|booster|ping|latency|lag)\b/i;

  const potentialPurchaseIntent: YouTubeComment[] = [];
  const potentialBrandMention: YouTubeComment[] = [];
  const other: YouTubeComment[] = [];

  for (const c of comments) {
    if (promoKeywords.test(c.text)) {
      potentialPurchaseIntent.push(c);
    } else if (brandKeywords.test(c.text)) {
      potentialBrandMention.push(c);
    } else {
      other.push(c);
    }
  }

  return { potentialPurchaseIntent, potentialBrandMention, other };
}

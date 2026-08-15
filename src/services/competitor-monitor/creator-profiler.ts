/**
 * Creator Profiler — builds and updates YouTube creator profiles.
 * Tracks channel stats, brand mention history, primary games, and collaboration patterns.
 */

import { getSupabase } from '../../db/supabase';
import { getChannelById, type YouTubeChannelResult } from './youtube-discovery';
import type { TopicResult } from './topic-classifier';
import type { SponsorshipResult } from './sponsorship-detector';
import { resolveBrand, isCompetitorPlacement, COMPETITOR_BRANDS } from './data-scope';

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

/**
 * Aggregate creators from videos table — always returns rows even if no profile exists.
 * Joins with youtube_creator_profiles for subscriber counts etc.
 */
export interface CreatorRow {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  subscriberCount: number | null;
  country: string | null;
  primaryLanguage: string;
  videosInWindow: number;   // = Current Scope 内该 creator 的竞品投放数 (Sponsored Videos)
  lifetimeCount: number;    // 全历史累计投放数 (独立展示, 不混入当前周期)
  confirmedCount: number;
  likelyCount: number;
  brandMentions: Record<string, number>;
  games: string[];
  markets: string[];
  avgViews: number;
  vsBaselinePct: number | null; // sponsored avg views vs creator's own non-sponsored avg (e.g. 31 = +31%)
  firstSeenAt: string;
  lastSeenAt: string;
  relationType: 'new' | 'recurring' | 'long_term' | 'multi_brand';
}

export async function getCreatorsFromVideos(options?: {
  rangeDays?: number;
  brand?: string;
  market?: string;
  competitorOnly?: boolean; // default false — when true, only show creators with competitor placements
}): Promise<CreatorRow[]> {
  const db = getSupabase();
  const days = options?.rangeDays || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sinceTs = Date.now() - days * 86400000;

  // Get all confirmed/likely videos in window (paged — REST caps at 1000/query)
  const videos: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('youtube_competitor_videos')
      .select('video_id,channel_id,channel_name,title,thumbnail_url,placement_type,game_name,market,language,view_count,like_count,comment_count,published_at,first_seen_at,classification_raw')
      .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .range(from, from + 999);
    if (!data?.length) break;
    videos.push(...data);
    if (data.length < 1000) break;
  }

  if (!videos?.length) return [];

  // ── Baseline (Vs Baseline column) ──
  // Baseline = creator's own NON-placement videos in the window (organic/
  // unknown — the "usual" videos the system sees from this channel).
  // vsBaselinePct = sponsored avg views vs that baseline, e.g. +31%.
  const baselineByChannel = new Map<string, { sum: number; n: number }>();
  {
    const baselineRows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('youtube_competitor_videos')
        .select('channel_id,view_count,views_t3,views_t7')
        .gte('published_at', since)
        .not('placement_type', 'in', '("confirmed_paid_placement","likely_sponsored")')
        .range(from, from + 999);
      if (!data?.length) break;
      baselineRows.push(...data);
      if (data.length < 1000) break;
    }
    for (const v of baselineRows) {
      const e = baselineByChannel.get(v.channel_id) || { sum: 0, n: 0 };
      e.sum += v.views_t7 ?? v.views_t3 ?? v.view_count ?? 0; e.n++;
      baselineByChannel.set(v.channel_id, e);
    }
  }

  // ── Historical relation (Recurring / Long-term) ──
  // Videos published BEFORE the window: if this channel already has a
  // placement with the same brand, today's appearance is Recurring (or
  // Long-term if that history spans >60 days). New = first time ever.
  // lifetimeCount = 同一批历史数据按 channel 累计 (历史累计列, 与周期分离)
  const historyByChannel = new Map<string, { brands: Set<string>; earliest: number }>();
  const lifetimeByChannel = new Map<string, number>();
  {
    const historyRows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('youtube_competitor_videos')
        .select('channel_id,published_at,classification_raw')
        .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
        .lt('published_at', since)
        .range(from, from + 999);
      if (!data?.length) break;
      historyRows.push(...data);
      if (data.length < 1000) break;
    }
    for (const v of historyRows) {
      const b = resolveBrand(v);
      if (!COMPETITOR_BRANDS.includes(b as any) || b === 'unknown') continue;
      lifetimeByChannel.set(v.channel_id, (lifetimeByChannel.get(v.channel_id) || 0) + 1);
      const e = historyByChannel.get(v.channel_id) || { brands: new Set<string>(), earliest: Date.now() };
      e.brands.add(b);
      const t = new Date(v.published_at).getTime();
      if (t < e.earliest) e.earliest = t;
      historyByChannel.set(v.channel_id, e);
    }
  }

  // Get all profiles for enrichment
  const { data: profiles } = await db.from('youtube_creator_profiles').select('*');
  const profileMap = new Map((profiles || []).map((p: any) => [p.channel_id, p]));

  // Group by channel_id
  // Stage ⑧ 口径收口: Sponsored Videos 必须 = Current Scope (range+brand+market)
  // 内该 creator 的竞品投放数 — 不得混入全历史或其他窗口。
  const channelMap = new Map<string, any[]>();
  for (const v of videos) {
    const brand = resolveBrand(v);
    // Layer 3 filter: competitor placements only (brand ∈ valid AND placement ∈ confirmed/likely)
    if (options?.competitorOnly && !isCompetitorPlacement(v)) continue;
    if (options?.brand && options.brand !== 'all' && brand !== options.brand) continue;
    if (options?.market && options.market !== 'all' && (v.market || '') !== options.market) continue;
    if (!channelMap.has(v.channel_id)) channelMap.set(v.channel_id, []);
    channelMap.get(v.channel_id)!.push(v);
  }

  const creators: CreatorRow[] = [];
  for (const [channelId, vids] of channelMap) {
    const profile = profileMap.get(channelId);
    const sorted = vids.sort((a: any, b: any) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    const timestamps = sorted.map((v: any) => new Date(v.published_at).getTime());

    // Brand mentions
    const brandMentions: Record<string, number> = { ExitLag: 0, GearUP: 0, LagZapper: 0 };
    const games = new Set<string>();
    const markets = new Set<string>();
    for (const v of sorted) {
      const b = resolveBrand(v);
      if (b && brandMentions.hasOwnProperty(b)) brandMentions[b]++;
      if (v.game_name && v.game_name !== 'unknown') games.add(v.game_name);
      if (v.market && v.market !== 'Unknown') markets.add(v.market);
    }

    // ── Relation type (KOL language, Stage ⑤) ──
    // Multi-Brand: sponsoring 2+ competitors in this window
    // New: first cooperation ever (no placements before this window)
    // Recurring: has placement history before this window
    // Long-term: history spans >60 days (multiple periods of cooperation)
    const allBrands = new Set<string>();
    sorted.forEach((v: any) => {
      const b = resolveBrand(v);
      if (b && b !== 'unknown') allBrands.add(b);
    });
    const history = historyByChannel.get(channelId);
    const historySpanDays = history ? (Date.now() - history.earliest) / 86400000 : 0;
    const relationType: CreatorRow['relationType'] =
      allBrands.size >= 2 ? 'multi_brand' :
      !history ? 'new' :
      historySpanDays > 60 ? 'long_term' : 'recurring';

    // ── Vs Baseline: sponsored avg vs creator's own non-sponsored avg ──
    const sponsoredAvg = sorted.reduce((s: number, v: any) => s + ((v.views_t7 ?? v.views_t3 ?? v.view_count) || 0), 0) / Math.max(sorted.length, 1);
    const bl = baselineByChannel.get(channelId);
    const baselineAvg = bl && bl.n > 0 ? bl.sum / bl.n : 0;
    const vsBaselinePct: number | null = baselineAvg > 0
      ? Math.round((sponsoredAvg - baselineAvg) / baselineAvg * 100) : null;

    creators.push({
      channelId,
      channelName: profile?.channel_name || sorted[0].channel_name || 'Unknown',
      thumbnailUrl: profile?.thumbnail_url || sorted[0].thumbnail_url || '',
      subscriberCount: profile?.subscriber_count || null,
      country: profile?.country || null,
      primaryLanguage: profile?.primary_language || sorted[0].language || 'en',
      videosInWindow: vids.length,
      lifetimeCount: (lifetimeByChannel.get(channelId) || 0) + vids.length,
      confirmedCount: sorted.filter((v: any) => v.placement_type === 'confirmed_paid_placement').length,
      likelyCount: sorted.filter((v: any) => v.placement_type === 'likely_sponsored').length,
      brandMentions,
      games: [...games].slice(0, 5),
      markets: [...markets].slice(0, 5),
      avgViews: Math.round(sponsoredAvg),
      vsBaselinePct,
      firstSeenAt: sorted[sorted.length - 1].first_seen_at,
      lastSeenAt: new Date(Math.max(...timestamps)).toISOString(),
      relationType,
    });
  }

  return creators.sort((a, b) => b.videosInWindow - a.videosInWindow);
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

// ── v3: Creator Classification ──

export function classifyCreatorSize(subscriberCount: number): string {
  if (subscriberCount < 1000) return 'nano';
  if (subscriberCount < 10000) return 'micro';
  if (subscriberCount < 100000) return 'mid_tier';
  if (subscriberCount < 1000000) return 'macro';
  return 'mega';
}

export async function classifyCreatorContentType(channelId: string): Promise<string> {
  const db = getSupabase();
  const { data: videos } = await db.from('youtube_competitor_videos')
    .select('game_name, content_type, title, tags').eq('channel_id', channelId).limit(30);

  if (!videos?.length) return 'variety_gaming';

  const games = new Set((videos as any[]).map(v => v.game_name).filter(Boolean));
  const types = (videos as any[]).map(v => v.content_type).filter(Boolean);

  if (games.size <= 2) return 'single_game';
  if (types.filter((t: string) => t === 'tutorial' || t === 'tutorial').length > types.length * 0.3) return 'guides';
  if (types.filter((t: string) => t === 'shorts').length > types.length * 0.5) return 'shorts_creator';
  if (types.filter((t: string) => t === 'dedicated_review' || t === 'comparison').length > types.length * 0.4) return 'tech_hardware';

  return 'variety_gaming';
}

export function classifyRelationship(
  pastMentions: Record<string, number>,
  collabBrands: string[],
  recentBrand: string,
): string {
  const totalMentions = Object.values(pastMentions).reduce((a, b) => a + b, 0);
  if (totalMentions === 0) return 'first_time';
  if (collabBrands.length >= 3) return 'multi_brand';

  // Check for brand switch: more mentions of a different brand recently
  const entries = Object.entries(pastMentions).sort((a, b) => b[1] - a[1]);
  if (entries.length >= 2 && entries[0][0] !== recentBrand && entries[0][1] > (pastMentions[recentBrand] || 0) * 1.5) {
    return 'switched_brand';
  }
  if ((pastMentions[recentBrand] || 0) >= 3) return 'brand_ambassador';
  if ((pastMentions[recentBrand] || 0) >= 1) return 'repeat';

  return 'first_time';
}

/** Calculate Baseline Lift: video 7d views ÷ median of creator's last 10 same-format videos */
export async function calculateBaselineLift(channelId: string, videoId: string, isShort: boolean): Promise<number | null> {
  const db = getSupabase();

  // Get creator's recent same-format videos
  const { data: recentVids } = await db.from('youtube_competitor_videos')
    .select('video_id, view_count').eq('channel_id', channelId).eq('is_short', isShort)
    .order('published_at', { ascending: false }).limit(11); // 10 + current

  if (!recentVids || recentVids.length < 2) return null;

  const others = (recentVids as any[]).filter(v => v.video_id !== videoId).slice(0, 10);
  if (!others.length) return null;

  const views = others.map((v: any) => v.view_count || 0).sort((a: number, b: number) => a - b);
  const median = views[Math.floor(views.length / 2)];

  // Current video views
  const { data: current } = await db.from('youtube_competitor_videos')
    .select('view_count').eq('video_id', videoId).maybeSingle();
  const currentViews = (current as any)?.view_count || 0;

  if (median === 0) return null;
  return Math.round((currentViews / median) * 100) / 100;
}

/** Run full creator classification update */
export async function updateCreatorClassification(channelId: string, recentBrand?: string): Promise<void> {
  const db = getSupabase();
  const { data: profile } = await db.from('youtube_creator_profiles').select('*').eq('channel_id', channelId).maybeSingle();
  if (!profile) return;

  const p = profile as any;
  const size = classifyCreatorSize(p.subscriber_count || 0);
  const contentType = await classifyCreatorContentType(channelId);
  const rel = classifyRelationship(p.past_brand_mentions || {}, p.collaboration_brands || [], recentBrand || '');

  await db.from('youtube_creator_profiles').update({
    creator_size: size, content_type: contentType, relationship_status: rel,
    baseline_views_median: p.avg_views_recent || 0,
    updated_at: new Date().toISOString(),
  }).eq('channel_id', channelId);

  console.log(`[CreatorProfile] ${p.channel_name}: ${size} | ${contentType} | ${rel}`);
}

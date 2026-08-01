/**
 * Dashboard Data Aggregation Layer.
 * Queries Supabase once and returns a unified structure for the dashboard UI.
 */

import { getSupabase } from '../../db/supabase';

export interface DashboardData {
  hasData: boolean;
  scanStatus: {
    lastScanAt: string | null;
    nextScanAt: string;
    totalVideos: number;
    totalCreators: number;
    queriesActive: number;
  };
  kpi: {
    newPlacements: number;
    activeCreators: number;
    videosMonitored: number;
    highConfidence: number;
  };
  brandComparison: BrandCard[];
  topGames: GameRow[];
  topThemes: ThemeRow[];
  topCreators: CreatorRow[];
  recentVideos: VideoRow[];
  anomalies: string[];
}

export interface BrandCard {
  brandName: string;
  newVideos: number;
  creators: number;
  topGame: string;
  topMarket: string;
  median7dViews: number;
}

export interface GameRow {
  game: string;
  videoCount: number;
  estimatedReach: number;
  brands: Record<string, number>;
}

export interface ThemeRow {
  topic: string;
  videoCount: number;
  brands: Record<string, number>;
}

export interface CreatorRow {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  subscriberCount: number;
  recentBrand: string;
  recentGame: string;
  format: string;
  views7d: number;
  engagementRate: number;
  sponsorship: string;
  performanceVsBaseline: number | null; // percentage, e.g. +42
}

export interface VideoRow {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelName: string;
  brand: string;
  game: string;
  publishedAt: string;
  viewCount: number;
  growth24h: number | null;
  growth72h: number | null;
  placementType: string;
  sponsorConfidence: number;
  discoveryEvidence: string[];
  promoCode: string | null;
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function getDashboardData(filter?: {
  brand?: string;
  market?: string;
  language?: string;
  range?: string;
  videoType?: 'all' | 'long' | 'short';
  placementType?: string;
}): Promise<DashboardData> {
  const db = getSupabase();
  const dateRangeDays = filter?.range === '90d' ? 90 : filter?.range === '7d' ? 7 : 30;
  const since = daysAgoISO(dateRangeDays);

  // Build base query — minimal columns for dashboard
  let query = db
    .from('youtube_competitor_videos')
    .select('video_id,title,channel_id,channel_name,published_at,is_short,thumbnail_url,game_name,content_type,placement_type,sponsor_confidence,topic_category,promo_code,landing_domain,view_count,like_count,comment_count,classification_raw,workflow_status,first_seen_at')
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(500);

  if (filter?.videoType === 'long') query = query.eq('is_short', false);
  else if (filter?.videoType === 'short') query = query.eq('is_short', true);

  if (filter?.language) query = query.eq('language', filter.language);
  if (filter?.market) query = query.eq('market', filter.market);

  const { data: videos, error: queryErr } = await query;
  console.log(`[Dashboard] Query returned: ${videos?.length || 0} videos, error: ${queryErr?.message || 'none'}, since: ${since}`);
  if (!videos || !videos.length) {
    // Empty state
    const { count: totalVideos } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
    const { data: lastScan } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();

    return {
      hasData: false,
      scanStatus: {
        lastScanAt: (lastScan as any)?.created_at || null,
        nextScanAt: 'Tomorrow 06:00 UTC',
        totalVideos: totalVideos || 0,
        totalCreators: 0,
        queriesActive: 15,
      },
      kpi: { newPlacements: 0, activeCreators: 0, videosMonitored: 0, highConfidence: 0 },
      brandComparison: [],
      topGames: [],
      topThemes: [],
      topCreators: [],
      recentVideos: [],
      anomalies: [],
    };
  }

  // Filter by brand
  let filteredVideos = videos as any[];
  if (filter?.brand && filter.brand !== 'all') {
    filteredVideos = filteredVideos.filter(v => {
      const b = v.classification_raw?.sponsorship?.detectedBrand || v.classification_raw?.detectedBrand;
      return b?.toLowerCase() === filter.brand!.toLowerCase();
    });
  }

  // Filter by placement type
  if (filter?.placementType && filter.placementType !== 'all') {
    filteredVideos = filteredVideos.filter(v => v.placement_type === filter.placementType);
  }

  // ── KPI ──
  const periodSince = daysAgoISO(dateRangeDays);
  const periodVideos = filteredVideos.filter((v: any) => v.first_seen_at >= periodSince);
  const creatorSet = new Set(periodVideos.map((v: any) => v.channel_id));
  const highConf = periodVideos.filter((v: any) =>
    v.placement_type === 'confirmed_paid_placement' || v.placement_type === 'likely_sponsored',
  );

  const kpi = {
    newPlacements: periodVideos.length,
    activeCreators: creatorSet.size,
    videosMonitored: filteredVideos.length,
    highConfidence: highConf.length,
  };

  // ── Brand Comparison ──
  const brandMap = new Map<string, { videos: number; creators: Set<string>; gameCounts: Map<string, number>; marketCounts: Map<string, number>; views7d: number[] }>();
  const brandNames = ['GearUP', 'ExitLag', 'LagZapper'];

  for (const name of brandNames) {
    brandMap.set(name, { videos: 0, creators: new Set(), gameCounts: new Map(), marketCounts: new Map(), views7d: [] });
  }

  for (const v of periodVideos) {
    const b = v.classification_raw?.sponsorship?.detectedBrand || v.classification_raw?.detectedBrand || 'unknown';
    if (!brandMap.has(b)) continue;
    const entry = brandMap.get(b)!;
    entry.videos++;
    entry.creators.add(v.channel_id);
    if (v.game_name) entry.gameCounts.set(v.game_name, (entry.gameCounts.get(v.game_name) || 0) + 1);
    if (v.market) entry.marketCounts.set(v.market, (entry.marketCounts.get(v.market) || 0) + 1);
    entry.views7d.push(v.view_count || 0);
  }

  const brandComparison: BrandCard[] = brandNames.map(name => {
    const d = brandMap.get(name)!;
    const topGame = [...d.gameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
    const topMarket = [...d.marketCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
    const sortedViews = d.views7d.sort((a, b) => a - b);
    const median = sortedViews.length > 0 ? sortedViews[Math.floor(sortedViews.length / 2)] : 0;
    return {
      brandName: name,
      newVideos: d.videos,
      creators: d.creators.size,
      topGame,
      topMarket,
      median7dViews: median,
    };
  });

  // ── Top Games ──
  const gameMap = new Map<string, { count: number; reach: number; brands: Map<string, number> }>();
  for (const v of periodVideos) {
    const game = v.game_name || 'Unknown';
    if (!gameMap.has(game)) gameMap.set(game, { count: 0, reach: 0, brands: new Map() });
    const g = gameMap.get(game)!;
    g.count++;
    g.reach += v.view_count || 0;
    const b = v.classification_raw?.sponsorship?.detectedBrand || 'unknown';
    g.brands.set(b, (g.brands.get(b) || 0) + 1);
  }

  const topGames: GameRow[] = [...gameMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([game, data]) => ({
      game,
      videoCount: data.count,
      estimatedReach: data.reach,
      brands: Object.fromEntries(data.brands),
    }));

  // ── Top Themes ──
  const themeMap = new Map<string, { count: number; brands: Map<string, number> }>();
  for (const v of periodVideos) {
    const topic = v.topic_category || 'uncategorized';
    if (!themeMap.has(topic)) themeMap.set(topic, { count: 0, brands: new Map() });
    const t = themeMap.get(topic)!;
    t.count++;
    const b = v.classification_raw?.sponsorship?.detectedBrand || 'unknown';
    t.brands.set(b, (t.brands.get(b) || 0) + 1);
  }

  const topThemes: ThemeRow[] = [...themeMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([topic, data]) => ({
      topic,
      videoCount: data.count,
      brands: Object.fromEntries(data.brands),
    }));

  // ── Top Creators ──
  const { data: creators } = await db
    .from('youtube_creator_profiles')
    .select('*')
    .order('subscriber_count', { ascending: false })
    .limit(20);

  const topCreators: CreatorRow[] = [];
  if (creators) {
    for (const c of creators) {
      const creatorVideos = periodVideos.filter((v: any) => v.channel_id === c.channel_id);
      if (!creatorVideos.length) continue;
      const latest = creatorVideos[0];

      // Calculate performance vs baseline
      const baseline = c.avg_views_recent || 0;
      const currentViews = latest.view_count || 0;
      const perfVsBaseline = baseline > 0 ? Math.round(((currentViews - baseline) / baseline) * 100) : null;

      // Aggregate engagement
      const totalEngagement = creatorVideos.reduce((sum: number, v: any) =>
        sum + (v.like_count || 0) + (v.comment_count || 0), 0);
      const totalViews = creatorVideos.reduce((sum: number, v: any) => sum + (v.view_count || 1), 0);
      const engRate = totalViews > 0 ? totalEngagement / totalViews : 0;

      topCreators.push({
        channelId: c.channel_id,
        channelName: c.channel_name,
        thumbnailUrl: c.thumbnail_url || '',
        subscriberCount: c.subscriber_count || 0,
        recentBrand: latest.classification_raw?.sponsorship?.detectedBrand || 'unknown',
        recentGame: latest.game_name || 'unknown',
        format: latest.content_type || 'unknown',
        views7d: creatorVideos.reduce((sum: number, v: any) => sum + (v.view_count || 0), 0),
        engagementRate: engRate,
        sponsorship: latest.placement_type || 'unknown',
        performanceVsBaseline: perfVsBaseline,
      });
    }
  }

  // ── Recent Videos ──
  const recentVideos: VideoRow[] = filteredVideos.slice(0, 50).map((v: any) => {
    const evidence: string[] = [];
    if (v.has_paid_placement_tag) evidence.push('Paid promotion disclosure');
    if (v.promo_code) evidence.push(`Promo code: ${v.promo_code}`);
    if (v.landing_domain) evidence.push(`${v.landing_domain} link detected`);
    const brandPositions = v.brand_mention_position || [];
    if (brandPositions.includes('title')) evidence.push('Brand in title');
    if (brandPositions.includes('description')) evidence.push('Brand in description');

    return {
      videoId: v.video_id,
      title: v.title || '',
      thumbnailUrl: v.thumbnail_url || '',
      channelName: v.channel_name || '',
      brand: v.classification_raw?.sponsorship?.detectedBrand || 'unknown',
      game: v.game_name || 'unknown',
      publishedAt: v.published_at,
      viewCount: v.view_count || 0,
      growth24h: null,
      growth72h: null,
      placementType: v.placement_type || 'unknown',
      sponsorConfidence: v.sponsor_confidence || 0,
      discoveryEvidence: evidence,
      promoCode: v.promo_code || null,
    };
  });

  // ── Scan Status ──
  const { data: lastScanVid } = await db
    .from('youtube_competitor_videos')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: totalVideos } = await db
    .from('youtube_competitor_videos')
    .select('id', { count: 'exact', head: true });

  const { data: allCreators } = await db
    .from('youtube_creator_profiles')
    .select('channel_id');

  return {
    hasData: true,
    scanStatus: {
      lastScanAt: (lastScanVid as any)?.created_at || null,
      nextScanAt: 'Tomorrow 06:00 UTC',
      totalVideos: totalVideos || 0,
      totalCreators: (allCreators || []).length,
      queriesActive: 15,
    },
    kpi,
    brandComparison,
    topGames,
    topThemes,
    topCreators,
    recentVideos,
    anomalies: [],
  };
}

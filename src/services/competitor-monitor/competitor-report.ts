/**
 * Competitor Report Generator.
 * Produces daily and weekly reports from Supabase data.
 *
 * Report structure:
 *   1. Overview — new placements by brand
 *   2. Hot games — most targeted games
 *   3. Hot topics — most common content themes
 *   4. Top creators — best performing channels
 *   5. Anomalies — unusual patterns
 *   6. Detailed video list
 *
 * Prohibited terminology:
 *   - ROI, CPA, conversion rate, ad spend
 *   - "estimated cost", "estimated spend"
 *   - Any suggestion that we know what the competitor paid
 *
 * Allowed terminology:
 *   - "Public Performance Score"
 *   - "view velocity", "engagement rate"
 *   - "public metrics", "visible engagement"
 */

import { getSupabase } from '../../db/supabase';
import { detectCreatorAnomalies } from './creator-profiler';

// Brand resolution chain: final → rule → ai → unknown
function resolveBrand(v: any): string {
  return v.classification_raw?.final?.brand || v.classification_raw?.rule?.brand || v.classification_raw?.ai?.brand || 'unknown';
}

// Simple public performance score from visible metrics (0-100)
function computeScore(v: any): number {
  const views = v.view_count || 0;
  const likes = v.like_count || 0;
  const comments = v.comment_count || 0;
  const viewsScore = Math.min(views / 1000, 50); // up to 50 points for views
  const engagementScore = Math.min((likes + comments * 2) / 100, 50); // up to 50 for engagement
  return Math.round(viewsScore + engagementScore);
}

export interface DailyReport {
  reportDate: string;
  period: { start: string; end: string };
  overview: {
    totalNewVideos: number;
    totalCreators: number;
    byBrand: Record<string, { videos: number; creators: number }>;
  };
  hotGames: Array<{ game: string; videoCount: number; topBrand: string }>;
  hotTopics: Array<{ topic: string; videoCount: number }>;
  topCreators: Array<{
    channelName: string;
    brand: string;
    game: string;
    contentType: string;
    views24h: number;
    views7d: number;
    engagementRate: number;
    viewSubRatio: number;
    promoCode: string | null;
    performanceScore: number;
  }>;
  anomalies: string[];
  newVideos: Array<{
    videoId: string;
    title: string;
    channelName: string;
    brand: string;
    game: string;
    placementType: string;
    performanceScore: number;
    viewCount: number;
    publishedAt: string;
  }>;
}

export interface WeeklyReport extends DailyReport {
  trends: {
    brandGrowth: Record<string, { thisWeek: number; lastWeek: number; changePercent: number }>;
    gameTrends: Array<{ game: string; thisWeek: number; lastWeek: number }>;
    marketExpansion: string[];
  };
  topPerformers: Array<{
    channelName: string;
    brand: string;
    avgPerformanceScore: number;
    totalVideos: number;
    totalViews: number;
  }>;
}

/** Generate a daily report for the last 24 hours */
export async function generateDailyReport(): Promise<DailyReport> {
  const db = getSupabase();
  const now = new Date();
  const startOfToday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Fetch new videos in the last 24h
  const { data: newVideos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .gte('first_seen_at', startOfToday)
    .order('view_count', { ascending: false });

  const videos = (newVideos || []) as any[];

  // Overview stats
  const brandSet = new Map<string, { videos: number; creators: Set<string> }>();
  const gameCount = new Map<string, number>();
  const gameBrands = new Map<string, string>();
  const topicCount = new Map<string, number>();

  for (const v of videos) {
    // By brand
    const vBrand = resolveBrand(v);
    if (!brandSet.has(vBrand)) {
      brandSet.set(vBrand, { videos: 0, creators: new Set() });
    }
    const b = brandSet.get(vBrand)!;
    b.videos++;
    b.creators.add(v.channel_id);

    // By game
    const vGame = v.game_name || 'uncategorized';
    gameCount.set(vGame, (gameCount.get(vGame) || 0) + 1);
    if (!gameBrands.has(vGame)) gameBrands.set(vGame, vBrand);

    // By topic
    const vTopic = v.topic_category || 'uncategorized';
    topicCount.set(vTopic, (topicCount.get(vTopic) || 0) + 1);
  }

  const overview = {
    totalNewVideos: videos.length,
    totalCreators: new Set(videos.map(v => v.channel_id)).size,
    byBrand: {} as Record<string, { videos: number; creators: number }>,
  };

  for (const [brand, data] of brandSet) {
    overview.byBrand[brand] = { videos: data.videos, creators: data.creators.size };
  }

  // Hot games
  const hotGames = [...gameCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([game, count]) => ({ game, videoCount: count, topBrand: gameBrands.get(game) || 'unknown' }));

  // Hot topics
  const hotTopics = [...topicCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, videoCount: count }));

  // Top creators
  const creatorMap = new Map<string, any>();
  for (const v of videos) {
    if (!creatorMap.has(v.channel_id)) {
      creatorMap.set(v.channel_id, v);
    }
  }
  const topCreators = [...creatorMap.values()]
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
    .slice(0, 10)
    .map(v => ({
      channelName: v.channel_name || 'Unknown',
      brand: resolveBrand(v),
      game: v.game_name || 'unknown',
      contentType: v.content_type || 'unknown',
      views24h: v.view_count || 0,
      views7d: v.view_count || 0,
      engagementRate: v.like_count && v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0,
      viewSubRatio: 0,
      promoCode: v.promo_code || null,
      performanceScore: computeScore(v),
    }));

  // Anomalies
  const anomalies = await detectCreatorAnomalies();

  // New videos detail
  const newVideosList = videos.slice(0, 50).map(v => ({
    videoId: v.video_id,
    title: v.title,
    channelName: v.channel_name || 'Unknown',
    brand: resolveBrand(v),
    game: v.game_name || 'unknown',
    placementType: v.placement_type || 'unknown',
    performanceScore: computeScore(v),
    viewCount: v.view_count || 0,
    publishedAt: v.published_at,
  }));

  const report: DailyReport = {
    reportDate: now.toISOString().slice(0, 10),
    period: { start: startOfToday, end: now.toISOString() },
    overview,
    hotGames,
    hotTopics,
    topCreators,
    anomalies,
    newVideos: newVideosList,
  };

  // Save to Supabase
  await db.from('competitor_reports').insert({
    report_type: 'daily',
    report_period_start: now.toISOString().slice(0, 10),
    report_period_end: now.toISOString().slice(0, 10),
    report_data: report,
    summary_text: `Daily: ${overview.totalNewVideos} new placements across ${overview.totalCreators} creators. Top brand: ${Object.entries(overview.byBrand).sort((a, b) => b[1].videos - a[1].videos)[0]?.[0] || 'N/A'}.`,
  });

  console.log(`[Report] Daily report generated: ${overview.totalNewVideos} videos`);
  return report;
}

/** Generate a weekly report for the last 7 days */
export async function generateWeeklyReport(): Promise<WeeklyReport> {
  const db = getSupabase();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // This week's videos
  const { data: thisWeekVideos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .gte('first_seen_at', weekAgo)
    .order('view_count', { ascending: false });

  // Last week's videos (for trend comparison)
  const { data: lastWeekVideos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .gte('first_seen_at', twoWeeksAgo)
    .lt('first_seen_at', weekAgo);

  const thisWeek = (thisWeekVideos || []) as any[];
  const lastWeek = (lastWeekVideos || []) as any[];

  // Build base daily report structure
  const brandSet = new Map<string, { videos: number; creators: Set<string> }>();
  const gameCount = new Map<string, number>();
  const gameBrands = new Map<string, string>();
  const topicCount = new Map<string, number>();

  for (const v of thisWeek) {
    const vBrand = resolveBrand(v);
    if (!brandSet.has(vBrand)) brandSet.set(vBrand, { videos: 0, creators: new Set() });
    const b = brandSet.get(vBrand)!;
    b.videos++;
    b.creators.add(v.channel_id);

    const vGame = v.game_name || 'uncategorized';
    gameCount.set(vGame, (gameCount.get(vGame) || 0) + 1);
    if (!gameBrands.has(vGame)) gameBrands.set(vGame, vBrand);

    const vTopic = v.topic_category || 'uncategorized';
    topicCount.set(vTopic, (topicCount.get(vTopic) || 0) + 1);
  }

  // Trends: brand growth week-over-week
  const brandGrowth: Record<string, { thisWeek: number; lastWeek: number; changePercent: number }> = {};
  const allBrands = new Set<string>();
  thisWeek.forEach(v => allBrands.add(resolveBrand(v)));
  lastWeek.forEach(v => allBrands.add(resolveBrand(v)));

  for (const brand of allBrands) {
    const tw = thisWeek.filter(v => resolveBrand(v) === brand).length;
    const lw = lastWeek.filter(v => resolveBrand(v) === brand).length;
    brandGrowth[brand] = {
      thisWeek: tw,
      lastWeek: lw,
      changePercent: lw > 0 ? Math.round(((tw - lw) / lw) * 100) : (tw > 0 ? 100 : 0),
    };
  }

  // Game trends
  const gameTrends = [...gameCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([game, thisWeekCount]) => {
      const lastWeekCount = lastWeek.filter(v => (v.game_name || 'uncategorized') === game).length;
      return { game, thisWeek: thisWeekCount, lastWeek: lastWeekCount };
    });

  // Market expansion signals
  const marketSignals: string[] = [];
  const languages = new Set(thisWeek.map(v => v.language).filter(Boolean));
  if (languages.has('ru')) marketSignals.push('Russian market activity detected');
  if (languages.has('pt')) marketSignals.push('Brazilian Portuguese market activity detected');

  // Check for brand concentration in new markets
  for (const brand of allBrands) {
    const brandVideos = thisWeek.filter(v => resolveBrand(v) === brand);
    const ruCount = brandVideos.filter(v => v.language === 'ru').length;
    const ptCount = brandVideos.filter(v => v.language === 'pt').length;
    if (ruCount >= 3) marketSignals.push(`${brand} increasing Russian market presence (${ruCount} videos)`);
    if (ptCount >= 3) marketSignals.push(`${brand} increasing Brazilian market presence (${ptCount} videos)`);
  }

  // Top performers (aggregate across the week)
  const performerMap = new Map<string, { videos: number; scores: number[]; views: number; brand: string; name: string }>();
  for (const v of thisWeek) {
    const key = v.channel_id;
    if (!performerMap.has(key)) {
      performerMap.set(key, {
        videos: 0,
        scores: [],
        views: 0,
        brand: resolveBrand(v),
        name: v.channel_name || 'Unknown',
      });
    }
    const p = performerMap.get(key)!;
    p.videos++;
    p.scores.push(computeScore(v));
    p.views += v.view_count || 0;
  }

  const topPerformers = [...performerMap.values()]
    .map(p => ({
      channelName: p.name,
      brand: p.brand,
      avgPerformanceScore: Math.round(p.scores.reduce((a, b) => a + b, 0) / p.scores.length),
      totalVideos: p.videos,
      totalViews: p.views,
    }))
    .sort((a, b) => b.avgPerformanceScore - a.avgPerformanceScore)
    .slice(0, 10);

  // Anomalies
  const anomalies = await detectCreatorAnomalies();

  const overview = {
    totalNewVideos: thisWeek.length,
    totalCreators: new Set(thisWeek.map(v => v.channel_id)).size,
    byBrand: {} as Record<string, { videos: number; creators: number }>,
  };
  for (const [brand, data] of brandSet) {
    overview.byBrand[brand] = { videos: data.videos, creators: data.creators.size };
  }

  const report: WeeklyReport = {
    reportDate: now.toISOString().slice(0, 10),
    period: { start: weekAgo, end: now.toISOString() },
    overview,
    hotGames: [...gameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([game, count]) => ({
      game, videoCount: count, topBrand: gameBrands.get(game) || 'unknown',
    })),
    hotTopics: [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([topic, count]) => ({
      topic, videoCount: count,
    })),
    topCreators: thisWeek.slice(0, 10).map(v => ({
      channelName: v.channel_name || 'Unknown',
      brand: resolveBrand(v),
      game: v.game_name || 'unknown',
      contentType: v.content_type || 'unknown',
      views24h: v.view_count || 0,
      views7d: v.view_count || 0,
      engagementRate: v.like_count && v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0,
      viewSubRatio: 0,
      promoCode: v.promo_code || null,
      performanceScore: computeScore(v),
    })),
    anomalies,
    newVideos: thisWeek.slice(0, 50).map(v => ({
      videoId: v.video_id,
      title: v.title,
      channelName: v.channel_name || 'Unknown',
      brand: resolveBrand(v),
      game: v.game_name || 'unknown',
      placementType: v.placement_type || 'unknown',
      performanceScore: computeScore(v),
      viewCount: v.view_count || 0,
      publishedAt: v.published_at,
    })),
    trends: {
      brandGrowth,
      gameTrends,
      marketExpansion: marketSignals,
    },
    topPerformers,
  };

  // Save to Supabase
  await db.from('competitor_reports').insert({
    report_type: 'weekly',
    report_period_start: now.toISOString().slice(0, 10),
    report_period_end: now.toISOString().slice(0, 10),
    report_data: report,
    summary_text: `Weekly: ${overview.totalNewVideos} placements across ${overview.totalCreators} creators. ${marketSignals.join('. ')}`,
  });

  console.log(`[Report] Weekly report generated: ${overview.totalNewVideos} videos, ${overview.totalCreators} creators`);
  return report;
}

// ═══════════════════════════════════════════
// Quarterly Competitive Intelligence Report
// ═══════════════════════════════════════════

export interface QuarterlyReport {
  reportDate: string;
  quarter: string;               // e.g. "2026-Q3"
  period: { start: string; end: string };
  previousQuarter: { start: string; end: string };
  executiveSummary: string;
  overview: {
    totalPlacements: number;
    totalCreators: number;
    confirmedPlacements: number;
    likelyPlacements: number;
  };
  brandAnalysis: Array<{
    brand: string;
    thisQuarter: { placements: number; creators: number; games: number; markets: number; avgViews: number };
    lastQuarter: { placements: number; creators: number };
    qoqChange: number;             // percentage
    topGame: string;
    topMarket: string;
    primaryAngle: string;          // most used content angle
  }>;
  gamePenetration: Array<{
    game: string;
    totalVideos: number;
    brands: Record<string, number>;
    qoqTrend: 'rising' | 'stable' | 'declining' | 'new';
  }>;
  creatorEcosystem: {
    newThisQuarter: number;
    retained: number;
    churned: number;               // present last quarter, absent this quarter
    multiBrandCount: number;       // creators who worked with ≥2 brands
    topNewCreators: Array<{ channelName: string; brand: string; game: string; views: number }>;
  };
  marketExpansion: Array<{
    market: string;
    brands: string[];
    videoCount: number;
    signal: string;                // e.g. "first significant presence"
  }>;
  strategicInsights: string[];     // AI-worthy observations
  topVideos: Array<{
    videoId: string;
    title: string;
    channelName: string;
    brand: string;
    game: string;
    viewCount: number;
    performanceScore: number;
  }>;
}

function getQuarterDates(offset: number = 0): { start: string; end: string; label: string } {
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3);
  const quarterStartMonth = currentQuarter * 3;

  // Current quarter start
  const qStart = new Date(now.getFullYear(), quarterStartMonth, 1);
  // offset = 0: current quarter, offset = 1: previous quarter
  qStart.setMonth(qStart.getMonth() - offset * 3);

  const qEnd = new Date(qStart);
  qEnd.setMonth(qEnd.getMonth() + 3);
  qEnd.setMilliseconds(-1);

  const year = qStart.getFullYear();
  const qNum = Math.floor(qStart.getMonth() / 3) + 1;

  return {
    start: qStart.toISOString(),
    end: qEnd.toISOString(),
    label: `${year}-Q${qNum}`,
  };
}

/** Generate a quarterly competitive intelligence report (~90 days) */
export async function generateQuarterlyReport(): Promise<QuarterlyReport> {
  const db = getSupabase();
  const thisQ = getQuarterDates(0);
  const lastQ = getQuarterDates(1);

  console.log(`[Report] Generating quarterly report: ${thisQ.label} (${thisQ.start} → ${thisQ.end})`);

  // Fetch this quarter's confirmed/likely videos
  const { data: thisQVideos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
    .gte('published_at', thisQ.start)
    .lt('published_at', thisQ.end)
    .order('view_count', { ascending: false });

  // Fetch last quarter's videos for comparison
  const { data: lastQVideos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
    .gte('published_at', lastQ.start)
    .lt('published_at', lastQ.end);

  const thisVids = (thisQVideos || []) as any[];
  const lastVids = (lastQVideos || []) as any[];

  // ── Brand Analysis ──
  const VALID_BRANDS = ['ExitLag', 'GearUP', 'LagZapper'];
  const brandAnalysis = VALID_BRANDS.map(brand => {
    const tq = thisVids.filter(v => resolveBrand(v) === brand);
    const lq = lastVids.filter(v => resolveBrand(v) === brand);

    const tqGames = new Set(tq.map(v => v.game_name).filter(Boolean));
    const tqMarkets = new Set(tq.map(v => v.classification_raw?.rule?.market || v.market || 'Unknown').filter(Boolean));
    const tqViews = tq.reduce((s, v) => s + (v.view_count || 0), 0);
    const tqAvgViews = tq.length > 0 ? Math.round(tqViews / tq.length) : 0;

    // Primary angle — most common topic_category
    const angleCounts = new Map<string, number>();
    tq.forEach(v => {
      const a = v.topic_category || 'game_integration';
      angleCounts.set(a, (angleCounts.get(a) || 0) + 1);
    });
    const primaryAngle = [...angleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';

    // Top game
    const gameCounts = new Map<string, number>();
    tq.forEach(v => {
      const g = v.game_name || 'unknown';
      gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
    });
    const topGame = [...gameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

    // Top market
    const mktCounts = new Map<string, number>();
    tq.forEach(v => {
      const m = v.classification_raw?.rule?.market || v.market || 'Unknown';
      mktCounts.set(m, (mktCounts.get(m) || 0) + 1);
    });
    const topMarket = [...mktCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

    const qoqChange = lq.length > 0 ? Math.round(((tq.length - lq.length) / lq.length) * 100) : (tq.length > 0 ? 100 : 0);

    return {
      brand,
      thisQuarter: {
        placements: tq.length,
        creators: new Set(tq.map(v => v.channel_id)).size,
        games: tqGames.size,
        markets: tqMarkets.size,
        avgViews: tqAvgViews,
      },
      lastQuarter: {
        placements: lq.length,
        creators: new Set(lq.map(v => v.channel_id)).size,
      },
      qoqChange,
      topGame,
      topMarket,
      primaryAngle,
    };
  });

  // ── Game Penetration ──
  const gameMap = new Map<string, { thisQ: number; lastQ: number; brands: Map<string, number> }>();
  thisVids.forEach(v => {
    const g = v.game_name || 'unknown';
    if (!gameMap.has(g)) gameMap.set(g, { thisQ: 0, lastQ: 0, brands: new Map() });
    const entry = gameMap.get(g)!;
    entry.thisQ++;
    const b = resolveBrand(v);
    entry.brands.set(b, (entry.brands.get(b) || 0) + 1);
  });
  lastVids.forEach(v => {
    const g = v.game_name || 'unknown';
    if (!gameMap.has(g)) gameMap.set(g, { thisQ: 0, lastQ: 0, brands: new Map() });
    gameMap.get(g)!.lastQ++;
  });

  const gamePenetration = [...gameMap.entries()]
    .filter(([, d]) => d.thisQ >= 2) // skip single-video games
    .sort((a, b) => b[1].thisQ - a[1].thisQ)
    .slice(0, 15)
    .map(([game, d]) => {
      let qoqTrend: 'rising' | 'stable' | 'declining' | 'new' = 'stable';
      if (d.lastQ === 0) qoqTrend = 'new';
      else if (d.thisQ > d.lastQ * 1.3) qoqTrend = 'rising';
      else if (d.thisQ < d.lastQ * 0.7) qoqTrend = 'declining';
      return {
        game,
        totalVideos: d.thisQ,
        brands: Object.fromEntries(d.brands),
        qoqTrend,
      };
    });

  // ── Creator Ecosystem ──
  const tqCreators = new Set(thisVids.map(v => v.channel_id));
  const lqCreators = new Set(lastVids.map(v => v.channel_id));
  const newThisQuarter = [...tqCreators].filter(id => !lqCreators.has(id)).length;
  const retained = [...tqCreators].filter(id => lqCreators.has(id)).length;
  const churned = [...lqCreators].filter(id => !tqCreators.has(id)).length;

  // Multi-brand creators
  const creatorBrands = new Map<string, Set<string>>();
  thisVids.forEach(v => {
    if (!creatorBrands.has(v.channel_id)) creatorBrands.set(v.channel_id, new Set());
    creatorBrands.get(v.channel_id)!.add(resolveBrand(v));
  });
  const multiBrandCount = [...creatorBrands.values()].filter(s => s.size >= 2).length;

  // Top new creators
  const newCreatorVids = thisVids
    .filter(v => !lqCreators.has(v.channel_id))
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
  const seenNewCreators = new Set<string>();
  const topNewCreators = newCreatorVids
    .filter(v => {
      if (seenNewCreators.has(v.channel_id)) return false;
      seenNewCreators.add(v.channel_id);
      return true;
    })
    .slice(0, 10)
    .map(v => ({
      channelName: v.channel_name || 'Unknown',
      brand: resolveBrand(v),
      game: v.game_name || 'unknown',
      views: v.view_count || 0,
    }));

  const creatorEcosystem = { newThisQuarter, retained, churned, multiBrandCount, topNewCreators };

  // ── Market Expansion ──
  const marketSignals: Array<{ market: string; brands: string[]; videoCount: number; signal: string }> = [];
  const NON_DEFAULT_MARKETS = ['RU', 'BR', 'LATAM', 'KR', 'JP', 'CN'];
  for (const mkt of NON_DEFAULT_MARKETS) {
    const vids = thisVids.filter(v => {
      const m = v.classification_raw?.rule?.market || v.market || 'Unknown';
      return m === mkt;
    });
    if (vids.length >= 3) {
      const brands = [...new Set(vids.map(v => resolveBrand(v)))];
      const lastVidsInMkt = lastVids.filter(v => {
        const m = v.classification_raw?.rule?.market || v.market || 'Unknown';
        return m === mkt;
      });
      const signal = lastVidsInMkt.length === 0 ? 'first significant presence' :
        vids.length > lastVidsInMkt.length * 2 ? 'rapid expansion' :
        'sustained presence';
      marketSignals.push({ market: mkt, brands, videoCount: vids.length, signal });
    }
  }

  // ── Strategic Insights ──
  const insights: string[] = [];

  // Brand with highest growth
  const fastestGrowing = brandAnalysis.sort((a, b) => b.qoqChange - a.qoqChange)[0];
  if (fastestGrowing && fastestGrowing.qoqChange > 20) {
    insights.push(`${fastestGrowing.brand} showed ${fastestGrowing.qoqChange > 0 ? '+' : ''}${fastestGrowing.qoqChange}% QoQ placement growth, driven primarily by ${fastestGrowing.topGame} content.`);
  }

  // Brand with most diverse game portfolio
  const mostDiverse = brandAnalysis.sort((a, b) => b.thisQuarter.games - a.thisQuarter.games)[0];
  if (mostDiverse && mostDiverse.thisQuarter.games >= 5) {
    insights.push(`${mostDiverse.brand} targeted ${mostDiverse.thisQuarter.games} different games — the broadest game portfolio.`);
  }

  // Rising games
  const risingGames = gamePenetration.filter(g => g.qoqTrend === 'rising' || g.qoqTrend === 'new');
  if (risingGames.length > 0) {
    insights.push(`Emerging game targets: ${risingGames.slice(0, 3).map(g => g.game).join(', ')} — these games saw increased booster sponsorship activity.`);
  }

  // Creator churn signal
  if (churned > retained * 0.5) {
    insights.push(`High creator churn: ${churned} creators from last quarter did not appear this quarter (${retained} retained). Possible campaign cycle rotation.`);
  }

  // Multi-brand creator signal
  if (multiBrandCount >= 5) {
    insights.push(`${multiBrandCount} creators worked with 2+ booster brands this quarter — these are high-value comparison targets.`);
  }

  // Market expansion
  const firstTimeMarkets = marketSignals.filter(m => m.signal === 'first significant presence');
  if (firstTimeMarkets.length > 0) {
    insights.push(`New market entry: ${firstTimeMarkets.map(m => `${m.market} (${m.brands.join('/')})`).join(', ')}.`);
  }

  // ── Executive Summary ──
  const totalPlacements = thisVids.length;
  const dominantBrand = brandAnalysis.sort((a, b) => b.thisQuarter.placements - a.thisQuarter.placements)[0];
  const summary = `${thisQ.label} Competitive Intelligence: ${totalPlacements} confirmed/likely placements across ${tqCreators.size} creators. ` +
    `${dominantBrand?.brand || 'N/A'} led with ${dominantBrand?.thisQuarter.placements || 0} placements. ` +
    `${newThisQuarter} new creators entered the ecosystem. ` +
    `Top games: ${gamePenetration.slice(0, 3).map(g => g.game).join(', ')}.`;

  // ── Top Videos ──
  const topVideos = thisVids.slice(0, 20).map(v => ({
    videoId: v.video_id,
    title: v.title,
    channelName: v.channel_name || 'Unknown',
    brand: resolveBrand(v),
    game: v.game_name || 'unknown',
    viewCount: v.view_count || 0,
    performanceScore: computeScore(v),
  }));

  // ── Overview ──
  const confirmedCount = thisVids.filter(v => v.placement_type === 'confirmed_paid_placement').length;
  const likelyCount = thisVids.filter(v => v.placement_type === 'likely_sponsored').length;

  const report: QuarterlyReport = {
    reportDate: new Date().toISOString().slice(0, 10),
    quarter: thisQ.label,
    period: { start: thisQ.start, end: thisQ.end },
    previousQuarter: { start: lastQ.start, end: lastQ.end },
    executiveSummary: summary,
    overview: {
      totalPlacements,
      totalCreators: tqCreators.size,
      confirmedPlacements: confirmedCount,
      likelyPlacements: likelyCount,
    },
    brandAnalysis,
    gamePenetration,
    creatorEcosystem,
    marketExpansion: marketSignals,
    strategicInsights: insights,
    topVideos,
  };

  // Save to Supabase
  await db.from('competitor_reports').insert({
    report_type: 'quarterly',
    report_period_start: thisQ.start.slice(0, 10),
    report_period_end: thisQ.end.slice(0, 10),
    report_data: report,
    summary_text: summary,
  });

  console.log(`[Report] Quarterly report generated: ${thisQ.label} — ${totalPlacements} placements, ${insights.length} insights`);
  return report;
}

/** Format a quarterly report as human-readable text */
export function formatQuarterlyReportText(report: QuarterlyReport): string {
  const fmt = (n: number) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const lines: string[] = [
    `══════════════════════════════════════════════`,
    `  Quarterly Competitive Intelligence Report`,
    `  ${report.quarter} | ${report.reportDate}`,
    `══════════════════════════════════════════════`,
    ``,
    `📊 EXECUTIVE SUMMARY`,
    `   ${report.executiveSummary}`,
    ``,
    `📈 OVERVIEW`,
    `   Total placements: ${report.overview.totalPlacements}`,
    `   Unique creators: ${report.overview.totalCreators}`,
    `   Confirmed: ${report.overview.confirmedPlacements} | Likely: ${report.overview.likelyPlacements}`,
    ``,
    `🏢 BRAND ANALYSIS`,
  ];

  for (const b of report.brandAnalysis) {
    const arrow = b.qoqChange > 0 ? '↑' : b.qoqChange < 0 ? '↓' : '→';
    lines.push(`   ${b.brand}: ${b.thisQuarter.placements} placements (${arrow}${Math.abs(b.qoqChange)}% QoQ) | ${b.thisQuarter.creators} creators | ${b.thisQuarter.games} games | ${b.thisQuarter.markets} markets`);
    lines.push(`     Top game: ${b.topGame} | Top market: ${b.topMarket} | Angle: ${b.primaryAngle}`);
  }

  lines.push('');
  lines.push('🎮 GAME PENETRATION');
  for (const g of report.gamePenetration.slice(0, 8)) {
    const trend = { rising: '📈', stable: '➡️', declining: '📉', new: '🆕' }[g.qoqTrend];
    const brandStr = Object.entries(g.brands).map(([b, n]) => `${b}:${n}`).join(' ');
    lines.push(`   ${trend} ${g.game}: ${g.totalVideos} videos (${brandStr})`);
  }

  lines.push('');
  lines.push('👥 CREATOR ECOSYSTEM');
  lines.push(`   New: ${report.creatorEcosystem.newThisQuarter} | Retained: ${report.creatorEcosystem.retained} | Churned: ${report.creatorEcosystem.churned}`);
  lines.push(`   Multi-brand creators: ${report.creatorEcosystem.multiBrandCount}`);
  if (report.creatorEcosystem.topNewCreators.length > 0) {
    lines.push('   Top new creators:');
    report.creatorEcosystem.topNewCreators.slice(0, 5).forEach(c => {
      lines.push(`     • ${c.channelName} (${c.brand}/${c.game}) — ${fmt(c.views)} views`);
    });
  }

  if (report.marketExpansion.length > 0) {
    lines.push('');
    lines.push('🌍 MARKET EXPANSION');
    report.marketExpansion.forEach(m => {
      lines.push(`   ${m.market}: ${m.brands.join('/')} (${m.videoCount} videos) — ${m.signal}`);
    });
  }

  if (report.strategicInsights.length > 0) {
    lines.push('');
    lines.push('💡 STRATEGIC INSIGHTS');
    report.strategicInsights.forEach((insight, i) => {
      lines.push(`   ${i + 1}. ${insight}`);
    });
  }

  lines.push('');
  lines.push('─── Note ───');
  lines.push('All metrics are PUBLIC performance estimates based on visible YouTube data.');
  lines.push('Scores do NOT represent ROI, CPA, conversion rate, or ad spend.');
  lines.push('══════════════════════════════════════════════');

  return lines.join('\n');
}

/** Format a daily report as human-readable text */
export function formatDailyReportText(report: DailyReport): string {
  const lines: string[] = [
    `═══════════════════════════════════════`,
    `  Competitor YouTube Placement Report`,
    `  ${report.reportDate}`,
    `═══════════════════════════════════════`,
    ``,
    `📊 OVERVIEW — Last 24 Hours`,
    `   Total new placements: ${report.overview.totalNewVideos}`,
    `   Unique creators: ${report.overview.totalCreators}`,
    ``,
  ];

  for (const [brand, data] of Object.entries(report.overview.byBrand)) {
    lines.push(`   ${brand}: ${data.videos} videos, ${data.creators} creators`);
  }

  lines.push('');
  lines.push('🎮 TOP GAMES');
  for (const g of report.hotGames.slice(0, 5)) {
    lines.push(`   ${g.game}: ${g.videoCount} videos (top brand: ${g.topBrand})`);
  }

  lines.push('');
  lines.push('🏷️ TOP TOPICS');
  for (const t of report.hotTopics.slice(0, 5)) {
    lines.push(`   ${t.topic}: ${t.videoCount} videos`);
  }

  lines.push('');
  lines.push('⭐ TOP CREATORS (by Public Performance Score)');
  for (const c of report.topCreators.slice(0, 5)) {
    lines.push(`   ${c.channelName} | ${c.brand} | ${c.game} | Score: ${c.performanceScore}/100`);
  }

  if (report.anomalies.length) {
    lines.push('');
    lines.push('⚠️ ANOMALIES');
    for (const a of report.anomalies) {
      lines.push(`   • ${a}`);
    }
  }

  lines.push('');
  lines.push('─── Note ───');
  lines.push('All metrics are PUBLIC performance estimates based on visible YouTube data.');
  lines.push('Scores do NOT represent ROI, CPA, conversion rate, or ad spend.');
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}

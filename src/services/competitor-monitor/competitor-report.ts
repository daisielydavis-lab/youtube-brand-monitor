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
    .order('public_performance_score', { ascending: false });

  const videos = (newVideos || []) as any[];

  // Overview stats
  const brandSet = new Map<string, { videos: number; creators: Set<string> }>();
  const gameCount = new Map<string, number>();
  const gameBrands = new Map<string, string>();
  const topicCount = new Map<string, number>();

  for (const v of videos) {
    // By brand
    const vBrand = v.detected_brand ||
      (v.classification_raw?.detectedBrand) ||
      (v.classification_raw?.brandName) ||
      'unknown';
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
    .sort((a, b) => (b.public_performance_score || 0) - (a.public_performance_score || 0))
    .slice(0, 10)
    .map(v => ({
      channelName: v.channel_name || 'Unknown',
      brand: (v.classification_raw?.detectedBrand) || 'unknown',
      game: v.game_name || 'unknown',
      contentType: v.content_type || 'unknown',
      views24h: v.view_count || 0,
      views7d: v.view_count || 0,
      engagementRate: v.like_count && v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0,
      viewSubRatio: 0,
      promoCode: v.promo_code || null,
      performanceScore: v.public_performance_score || 0,
    }));

  // Anomalies
  const anomalies = await detectCreatorAnomalies();

  // New videos detail
  const newVideosList = videos.slice(0, 50).map(v => ({
    videoId: v.video_id,
    title: v.title,
    channelName: v.channel_name || 'Unknown',
    brand: (v.classification_raw?.detectedBrand) || 'unknown',
    game: v.game_name || 'unknown',
    placementType: v.placement_type || 'unknown',
    performanceScore: v.public_performance_score || 0,
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
    .order('public_performance_score', { ascending: false });

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
    const vBrand = (v.classification_raw?.detectedBrand) || 'unknown';
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
  thisWeek.forEach(v => allBrands.add((v.classification_raw?.detectedBrand) || 'unknown'));
  lastWeek.forEach(v => allBrands.add((v.classification_raw?.detectedBrand) || 'unknown'));

  for (const brand of allBrands) {
    const tw = thisWeek.filter(v => (v.classification_raw?.detectedBrand || 'unknown') === brand).length;
    const lw = lastWeek.filter(v => (v.classification_raw?.detectedBrand || 'unknown') === brand).length;
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
    const brandVideos = thisWeek.filter(v => (v.classification_raw?.detectedBrand || 'unknown') === brand);
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
        brand: (v.classification_raw?.detectedBrand) || 'unknown',
        name: v.channel_name || 'Unknown',
      });
    }
    const p = performerMap.get(key)!;
    p.videos++;
    p.scores.push(v.public_performance_score || 0);
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
      brand: (v.classification_raw?.detectedBrand) || 'unknown',
      game: v.game_name || 'unknown',
      contentType: v.content_type || 'unknown',
      views24h: v.view_count || 0,
      views7d: v.view_count || 0,
      engagementRate: v.like_count && v.view_count ? (v.like_count + v.comment_count) / v.view_count : 0,
      viewSubRatio: 0,
      promoCode: v.promo_code || null,
      performanceScore: v.public_performance_score || 0,
    })),
    anomalies,
    newVideos: thisWeek.slice(0, 50).map(v => ({
      videoId: v.video_id,
      title: v.title,
      channelName: v.channel_name || 'Unknown',
      brand: (v.classification_raw?.detectedBrand) || 'unknown',
      game: v.game_name || 'unknown',
      placementType: v.placement_type || 'unknown',
      performanceScore: v.public_performance_score || 0,
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

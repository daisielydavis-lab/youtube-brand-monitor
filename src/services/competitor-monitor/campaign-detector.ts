/**
 * Campaign Detector — groups related placements into campaigns.
 *
 * Logic: Same brand + same game + within 7-day window + shared landing or promo pattern
 */

import { getSupabase } from '../../db/supabase';

export interface Campaign {
  id: string;
  brand: string;
  game: string;
  videoCount: number;
  creatorCount: number;
  primarySellingPoint: string;
  primaryMarket: string;
  primaryLanguage: string;
  landingDomain: string | null;
  totalEstimatedViews: number;
  avgPerformanceScore: number;
  status: 'active' | 'ended';
  activeFrom: string;
  activeTo: string;
}

/** Run after each scan — group newly classified videos into campaigns */
export async function detectCampaigns(): Promise<number> {
  const db = getSupabase();

  // Get recent videos not yet assigned to a campaign
  const { data: videos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .is('campaign_id', null)
    .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
    .gte('first_seen_at', new Date(Date.now() - 14 * 86400000).toISOString())
    .order('published_at', { ascending: false });

  if (!videos?.length) return 0;

  // Group candidates: same brand + same game + within 7 days
  const groups = new Map<string, any[]>();

  for (const v of videos as any[]) {
    const brand = v.classification_raw?.final?.brand || v.classification_raw?.rule?.brand || v.classification_raw?.ai?.brand || 'unknown';
    if (brand === 'unknown') continue; // skip unclassified
    const game = v.game_name || 'unknown';
    const published = new Date(v.published_at).getTime();

    // Find existing group or create new
    let matched = false;
    for (const [key, groupVids] of groups) {
      const firstTime = new Date(groupVids[0].published_at).getTime();
      const groupBrand = key.split('||')[0];
      const groupGame = key.split('||')[1];

      if (groupBrand === brand && groupGame === game &&
        Math.abs(published - firstTime) < 7 * 86400000 &&
        (v.landing_domain === groupVids[0].landing_domain || !v.landing_domain)) {
        groupVids.push(v);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.set(`${brand}||${game}||${v.video_id}`, [v]);
    }
  }

  // Create campaigns for groups with ≥2 videos
  let created = 0;
  for (const [, groupVids] of groups) {
    if (groupVids.length < 2) continue;

    const brand = groupVids[0].classification_raw?.final?.brand || groupVids[0].classification_raw?.rule?.brand || groupVids[0].classification_raw?.ai?.brand || 'unknown';
    const game = groupVids[0].game_name || groupVids[0].classification_raw?.ai?.game || 'unknown';
    const creators = new Set(groupVids.map((v: any) => v.channel_id));
    // Use topic_category (populated from AI theme) as selling point label
    const themeLabels: Record<string, string> = {
      reduce_ping: 'Reduce Ping', promo_code: 'Promo Code', game_review: 'Game Review',
      tutorial: 'Tutorial', comparison: 'Comparison', new_launch: 'New Launch',
      cross_region: 'Cross-Region', game_integration: 'Game Integration', other: 'General',
    };
    const sellingPoints = groupVids.map((v: any) => themeLabels[v.topic_category] || v.classification_raw?.ai?.theme || 'General');
    const topSP = sellingPoints.sort((a: string, b: string) =>
      sellingPoints.filter((x: string) => x === b).length - sellingPoints.filter((x: string) => x === a).length)[0] || 'General';

    // Market derived from AI or defaults to Global
    const markets = groupVids.map((v: any) => v.classification_raw?.ai?.market || v.market || 'Global').filter(Boolean);
    const topMarket = markets.sort((a: string, b: string) =>
      markets.filter((x: string) => x === b).length - markets.filter((x: string) => x === a).length)[0] || 'Global';

    const totalViews = groupVids.reduce((s: number, v: any) => s + (v.view_count || 0), 0);
    const avgScore = groupVids.reduce((s: number, v: any) => s + (v.public_performance_score || 0), 0) / groupVids.length;

    const timestamps = groupVids.map((v: any) => new Date(v.published_at).getTime());
    const activeFrom = new Date(Math.min(...timestamps)).toISOString().slice(0, 10);
    const activeTo = new Date(Math.max(...timestamps)).toISOString().slice(0, 10);

    // Insert campaign
    const { data: camp } = await db.from('campaigns').insert({
      brand, game, video_count: groupVids.length, creator_count: creators.size,
      primary_selling_point: topSP || null, primary_market: topMarket || 'US',
      primary_language: groupVids[0].language || 'en',
      landing_domain: groupVids[0].landing_domain || null,
      total_estimated_views: totalViews, avg_performance_score: Math.round(avgScore),
      status: 'active', active_from: activeFrom, active_to: activeTo,
      detected_at: new Date().toISOString(),
    }).select('id').single();

    if (camp) {
      // Link videos to campaign
      await db.from('youtube_competitor_videos').update({ campaign_id: (camp as any).id })
        .in('video_id', groupVids.map((v: any) => v.video_id));
      created++;
      console.log(`[Campaign] Created: ${brand}/${game} — ${groupVids.length} videos, ${creators.size} creators`);
    }
  }

  // ── Update campaign statuses based on recency ──
  // Emerging: first detected <48h, ≥1 high-conf  |  Active: new video <72h
  // Cooling: 3-7d no new  |  Ended: >7d no new  |  Insufficient: only 1 video
  const now = Date.now();
  const { data: allCampaigns } = await db.from('campaigns').select('*').in('status', ['active','emerging']);
  for (const c of (allCampaigns || [])) {
    let newStatus = c.status;
    const lastActivity = new Date(c.active_to).getTime();
    const hoursSinceLast = (now - lastActivity) / 3600000;

    if ((c.video_count || 0) < 2) {
      newStatus = 'insufficient_evidence';
    } else if (hoursSinceLast <= 48 && c.video_count >= 2) {
      newStatus = 'emerging';
    } else if (hoursSinceLast <= 72) {
      newStatus = 'active';
    } else if (hoursSinceLast <= 168) { // 7 days
      newStatus = 'cooling';
    } else {
      newStatus = 'ended';
    }

    if (newStatus !== c.status) {
      await db.from('campaigns').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', c.id);
      console.log(`[Campaign] Status: ${c.brand}/${c.game} ${c.status} → ${newStatus}`);
    }
  }
  // Also check ended campaigns for revival
  const { data: endedCampaigns } = await db.from('campaigns').select('*').eq('status', 'ended');
  for (const c of (endedCampaigns || [])) {
    const { count } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .gte('published_at', new Date(now - 7 * 86400000).toISOString());
    if (count && count > 0) {
      await db.from('campaigns').update({ status: 'active', updated_at: new Date().toISOString() }).eq('id', c.id);
    }
  }

  return created;
}

/** Get active campaigns */
export async function getCampaigns(status?: string): Promise<Campaign[]> {
  const db = getSupabase();
  let q = db.from('campaigns').select('*').order('detected_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data } = await q;
  return (data || []) as Campaign[];
}

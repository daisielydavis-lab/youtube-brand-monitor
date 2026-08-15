/**
 * Campaign Detector — groups related placements into campaigns/clusters.
 *
 * Classification:
 *   one_off_placement     — 1 creator, 1 video
 *   creator_series        — 1 creator, ≥2 videos within 7 days
 *   multi_creator_campaign — ≥2 creators, ≥2 videos, same brand+game, within 7 days
 *   brand_push            — same brand spans ≥3 games or ≥2 markets+3 creators in 7 days
 *
 * Status lifecycle:
 *   active  — last placement within 72h
 *   cooling — last placement 72h–7d ago
 *   ended   — last placement >7d ago
 */

import { getSupabase } from '../../db/supabase';
import { resolveBrand, resolveGame as resolveGameFromScope, COMPETITOR_BRANDS } from './data-scope';

export interface Campaign {
  id: string;
  brand: string;
  game: string;
  cluster_type: 'one_off_placement' | 'creator_series' | 'multi_creator_campaign' | 'brand_push';
  video_count: number;
  creator_count: number;
  confirmed_count: number;
  likely_count: number;
  primary_selling_point: string;
  primary_market: string;
  primary_language: string;
  landing_domain: string | null;
  total_estimated_views: number;
  avg_performance_score: number;
  status: 'active' | 'cooling' | 'ended';
  full_start_at: string;
  full_end_at: string;
  last_placement_at: string;
  detected_at: string;
}

// Uses shared resolveBrand / resolveGame from data-scope.ts

const THEME_LABELS: Record<string, string> = {
  reduce_ping: 'Reduce Ping', promo_code: 'Promo Code', game_review: 'Game Review',
  tutorial: 'Tutorial', comparison: 'Comparison', new_launch: 'New Launch',
  cross_region: 'Cross-Region', game_integration: 'Game Integration', other: 'General',
};

function topTheme(vids: any[]): string {
  const sps = vids.map(v => THEME_LABELS[v.topic_category] || v.classification_raw?.ai?.theme || 'General');
  return sps.sort((a, b) => sps.filter(x => x === b).length - sps.filter(x => x === a).length)[0] || 'General';
}

function calcStatus(lastPlacementAt: string): 'active' | 'cooling' | 'ended' {
  const hours = (Date.now() - new Date(lastPlacementAt).getTime()) / 3600000;
  if (hours <= 72) return 'active';
  if (hours <= 168) return 'cooling';
  return 'ended';
}

export async function detectCampaigns(): Promise<number> {
  const db = getSupabase();

  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: videos } = await db
    .from('youtube_competitor_videos')
    .select('*')
    .is('campaign_id', null)
    .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
    .gte('published_at', since)
    .order('published_at', { ascending: false });

  if (!videos?.length) return 0;

  // Group by brand+game within 7-day rolling windows
  // Multiple groups can exist for same brand+game if videos span >7 days
  const groups = new Map<string, any[]>();
  for (const v of videos as any[]) {
    const b = resolveBrand(v);
    if (b === 'unknown') continue;
    const g = resolveGameFromScope(v);
    if (g === 'unknown') continue;
    const pub = new Date(v.published_at).getTime();

    // Try to add to an existing group with same brand+game within 7 days
    let matched = false;
    for (const [key, gv] of groups) {
      const [gb, gg] = key.split('||', 2);
      if (gb !== b || gg !== g) continue;
      // Check if within 7 days of first video in group
      const groupStart = new Date(gv[0].published_at).getTime();
      if (Math.abs(pub - groupStart) < 7 * 86400000) {
        gv.push(v);
        matched = true;
        break;
      }
    }

    if (!matched) {
      const key = `${b}||${g}||${v.video_id}`;
      groups.set(key, [v]);
    }
  }

  // Clear old campaigns
  await db.from('youtube_competitor_videos').update({ campaign_id: null }).not('campaign_id', 'is', null);
  await db.from('campaigns').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Brand push detection: same brand across ≥3 games OR ≥2 markets+3 creators in 7 days
  const brandMap = new Map<string, { games: Set<string>; markets: Set<string>; creators: Set<string>; vids: any[] }>();
  for (const [, gv] of groups) {
    if (gv.length < 2) continue;
    const b = resolveBrand(gv[0]);
    if (!brandMap.has(b)) brandMap.set(b, { games: new Set(), markets: new Set(), creators: new Set(), vids: [] });
    const bd = brandMap.get(b)!;
    bd.games.add(resolveGameFromScope(gv[0]));
    gv.forEach((v: any) => { bd.markets.add(v.market || 'Unknown'); bd.creators.add(v.channel_id); });
    bd.vids.push(...gv);
  }

  // Check for brand pushes
  const brandPushBrands = new Set<string>();
  for (const [b, d] of brandMap) {
    if (d.games.size >= 3 || (d.markets.size >= 2 && d.creators.size >= 3)) {
      brandPushBrands.add(b);
    }
  }

  let created = 0;

  for (const [, gv] of groups) {
    if (gv.length < 2) continue;
    const brand = resolveBrand(gv[0]);
    if (!COMPETITOR_BRANDS.includes(brand as any)) continue;
    const game = resolveGameFromScope(gv[0]);
    const creators = new Set(gv.map((v: any) => v.channel_id));
    const timestamps = gv.map((v: any) => new Date(v.published_at).getTime());
    const lastPlacementAt = new Date(Math.max(...timestamps)).toISOString();
    const fullStart = new Date(Math.min(...timestamps)).toISOString().slice(0, 10);
    const fullEnd = new Date(Math.max(...timestamps)).toISOString().slice(0, 10);
    const status = calcStatus(lastPlacementAt);
    const confirmedCount = gv.filter((v: any) => v.placement_type === 'confirmed_paid_placement').length;
    const likelyCount = gv.filter((v: any) => v.placement_type === 'likely_sponsored').length;

    // Classify: brand_push is per-brand flag, NOT per-cluster type
    // Each cluster gets its own granular type
    let clusterType: Campaign['cluster_type'];
    if (creators.size >= 2 && gv.length >= 2) {
      clusterType = 'multi_creator_campaign';
    } else if (creators.size === 1 && gv.length >= 2) {
      clusterType = 'creator_series';
    } else {
      clusterType = 'one_off_placement';
    }

    const totalViews = gv.reduce((s: number, v: any) => s + (v.view_count || 0), 0);
    const topSP = topTheme(gv);
    const topMarket = gv.map((v: any) => v.market || 'Unknown')
      .sort((a, b) => gv.filter((v: any) => (v.market || 'Unknown') === b).length - gv.filter((v: any) => (v.market || 'Unknown') === a).length)[0] || 'Unknown';

    // Store cluster_type in landing_domain (unused field), status directly
    const { data: camp } = await db.from('campaigns').insert({
      brand, game,
      video_count: gv.length,
      creator_count: creators.size,
      primary_selling_point: `${clusterType}::${topSP}`, // cluster_type prefix in selling_point
      primary_market: topMarket,
      primary_language: 'en',
      landing_domain: clusterType, // reuse unused field for cluster_type
      total_estimated_views: totalViews,
      avg_performance_score: 50,
      status,
      active_from: fullStart,
      active_to: fullEnd,
      detected_at: new Date().toISOString(),
    }).select('id').single();

    if (camp) {
      await db.from('youtube_competitor_videos').update({ campaign_id: (camp as any).id })
        .in('video_id', gv.map((v: any) => v.video_id));
      created++;
      console.log(`[Campaign] ${clusterType}: ${brand}/${game} — ${gv.length}v ${creators.size}c ${status}`);
    }
  }

  return created;
}

export async function getCampaigns(statusFilter?: string): Promise<Campaign[]> {
  const db = getSupabase();
  // Stage ④ 口径: campaigns table holds historical metadata (detected at a
  // snapshot, mostly 'ended'). The API must match the dashboard KPI — only
  // return non-ended campaigns by default. Pass status=ended to audit history.
  let q = db.from('campaigns').select('*').order('detected_at', { ascending: false });
  if (statusFilter) q = q.eq('status', statusFilter);
  else q = q.neq('status', 'ended');
  const { data } = await q;
  return (data || []).map(c => ({
    ...c,
    cluster_type: (c.landing_domain || 'multi_creator_campaign') as Campaign['cluster_type'],
    primary_selling_point: (c.primary_selling_point || '').replace(/^[^:]*::/, ''), // strip cluster_type prefix
  })) as Campaign[];
}

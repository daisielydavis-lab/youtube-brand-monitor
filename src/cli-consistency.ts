/**
 * CLI — Stage ④ 全站数据口径一致性验收.
 *
 * Outputs a 7-day consistency table and verifies the invariant:
 *   Competitor Placements + Unresolved + Organic + Pending = Discovered
 *
 * Usage: npm run consistency
 */

import { getSupabase } from './db/supabase';
import {
  isCompetitorPlacement, isUnresolvedCandidate, needsAIVerification,
  resolveBrand, resolveGame, COMPETITOR_BRANDS,
} from './services/competitor-monitor/data-scope';

async function main() {
  const db = getSupabase();
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  console.log(`── Stage ④ Consistency Check (window: last 7 days, since ${since}) ──\n`);

  // ── Pull ALL videos in window (paged — REST caps at 1000/query) ──
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select('*')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .range(from, from + 999);
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`Fetched ${all.length} videos in window.\n`);

  // ── Buckets (strict partition of Discovered) ──
  const placements = all.filter(isCompetitorPlacement);
  const unresolved = all.filter(isUnresolvedCandidate);
  // Pending = never processed + queued for AI verification (rule-flagged
  // candidates awaiting AI review are NOT placements and NOT organic).
  const pending = all.filter(v =>
    v.workflow_status === 'discovered' || v.workflow_status === 'enriched' ||
    needsAIVerification(v));
  const classified = all.filter(v => v.workflow_status === 'classified' || v.workflow_status === 'rule_classified');
  const organic = classified.filter(v => !isCompetitorPlacement(v) && !isUnresolvedCandidate(v) && !needsAIVerification(v));

  // ── Derived metrics (ALL from Layer 3 placements) ──
  const activeCreatorIds = new Set(placements.map(v => v.channel_id));
  const campaigns = new Set(placements.map(v => v.campaign_id).filter(Boolean));

  const gameMap = new Map<string, number>();
  const angleMap = new Map<string, number>();
  const brandMap = new Map<string, number>();
  for (const v of placements) {
    const g = resolveGame(v); gameMap.set(g, (gameMap.get(g) || 0) + 1);
    const a = v.topic_category || 'uncategorized'; angleMap.set(a, (angleMap.get(a) || 0) + 1);
    const b = resolveBrand(v); brandMap.set(b, (brandMap.get(b) || 0) + 1);
  }
  const topGames = [...gameMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topAngles = [...angleMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ── Competitor comments: comments belonging to Layer 3 videos ──
  let competitorComments = 0;
  if (placements.length) {
    const { count } = await db.from('youtube_comment_insights')
      .select('id', { count: 'exact', head: true })
      .in('video_id', placements.map(v => v.video_id).slice(0, 500));
    competitorComments = count ?? 0;
  }

  // ── Table ──
  console.log('指标                    | 7 Days');
  console.log('----------------------- | -------');
  console.log(`Discovered Videos       | ${all.length}`);
  console.log(`Classified Videos       | ${classified.length} (${Math.round(classified.length / Math.max(all.length, 1) * 100)}%)`);
  console.log(`Competitor Placements   | ${placements.length}`);
  console.log(`Unresolved Candidates   | ${unresolved.length}`);
  console.log(`Organic / Irrelevant    | ${organic.length}`);
  console.log(`Pending Classification  | ${pending.length}`);
  console.log(`Active Competitor Creators | ${activeCreatorIds.size}`);
  console.log(`Campaigns               | ${campaigns.size} (active, from Layer 3)`);
  console.log(`Competitor Comments     | ${competitorComments}`);
  console.log('');
  console.log('Top Games (Layer 3)   :', topGames.map(([g, n]) => `${g}×${n}`).join(', ') || '(none)');
  console.log('Content Angles (L3)   :', topAngles.map(([a, n]) => `${a}×${n}`).join(', ') || '(none)');
  console.log('Brand distribution (L3):', [...brandMap.entries()].map(([b, n]) => `${b}×${n}`).join(', '));

  // ── Invariant ──
  const lhs = placements.length + unresolved.length + organic.length + pending.length;
  const ok = lhs === all.length;
  console.log('');
  console.log(`公式校验: Placements(${placements.length}) + Unresolved(${unresolved.length}) + Organic(${organic.length}) + Pending(${pending.length}) = ${lhs} vs Discovered(${all.length}) → ${ok ? '✅ 成立' : '❌ 不成立'}`);
  console.log(`品牌归属校验: Layer 3 brand 均 ∈ [${COMPETITOR_BRANDS.join(', ')}] → ${placements.every(v => COMPETITOR_BRANDS.includes(resolveBrand(v) as any)) ? '✅' : '❌'}`);
}

main().catch(err => {
  console.error('Consistency CLI failed:', err);
  process.exit(1);
});

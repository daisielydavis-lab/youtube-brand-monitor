import { getSupabase } from './src/db/supabase';
import { isCompetitorPlacement } from './src/services/competitor-monitor/data-scope';
import { evaluateIndustryGate } from './src/services/competitor-monitor/industry-gate';
(async () => {
  const db = getSupabase();
  const since = new Date(Date.now() - 1 * 86400000).toISOString();
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos').select('*')
      .gte('first_seen_at', since).range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const placements = all.filter(isCompetitorPlacement);
  console.log(`today's Layer 3 placements: ${placements.length}`);
  // Re-run industry gate on each: would the gate block it?
  const suspect: any[] = [];
  for (const v of placements) {
    const g = evaluateIndustryGate({ title: v.title, description: v.description || '', tags: v.tags || [], channelName: v.channel_name || '' });
    if (!g.passed) {
      suspect.push({ title: v.title.slice(0, 70), category: g.category, blockedBy: g.blockedBy, brand: v.classification_raw?.ai?.brand });
    }
  }
  console.log(`gate-blockable among AI-confirmed placements: ${suspect.length}`);
  for (const s of suspect) console.log('  [', s.category, '/', s.blockedBy, ']', s.title);
  // sanity: any of today's videos gate-blocked but kept a placement label?
  const wronglyLabeled = all.filter(v => v.classification_raw?.industryGate?.blocked && ['confirmed_paid_placement','likely_sponsored'].includes(v.placement_type));
  console.log(`today's videos with blocked gate but placement label: ${wronglyLabeled.length}`);
  process.exit(0);
})();

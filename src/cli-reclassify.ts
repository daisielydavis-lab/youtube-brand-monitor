/**
 * CLI — Stage ① historical reclassification (industry gate).
 *
 * Pulls every video currently labeled as a competitor placement
 * (confirmed_paid_placement / likely_sponsored), runs the industry gate
 * against its full metadata, and downgrades the non-gaming ones:
 *   - placement_type → organic_mention
 *   - sponsor_confidence → 0
 *   - game_name → null
 *   - classification_raw merged with industryGate: {blocked, category, blockedBy}
 *
 * Explicit YouTube paid-placement tags are trusted (official disclosure) and kept.
 *
 * Usage: npm run reclassify
 */

import { getSupabase } from './db/supabase';
import { evaluateIndustryGate } from './services/competitor-monitor/industry-gate';

const PLACEMENT_TYPES = ['confirmed_paid_placement', 'likely_sponsored'];

async function main() {
  const db = getSupabase();
  console.log('── Stage ① Historical Reclassification (industry gate) ──');

  // Fetch all current placement-labeled videos (batch pagination)
  const all: any[] = [];
  const PAGE = 500;
  let from = 0;
  for (;;) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select('video_id, title, description, channel_name, tags, has_paid_placement_tag, placement_type, sponsor_confidence, game_name, classification_raw')
      .in('placement_type', PLACEMENT_TYPES)
      .order('published_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`Loaded ${all.length} videos labeled as placements.`);

  let kept = 0, downgraded = 0, paidTagKept = 0, unchanged = 0;
  const byCategory: Record<string, number> = {};

  for (const v of all) {
    const gate = evaluateIndustryGate({
      title: v.title || '',
      description: v.description || '',
      channelName: v.channel_name || '',
      tags: Array.isArray(v.tags) ? v.tags : [],
    });

    const blocked = !gate.passed && gate.category !== 'gaming';

    // Trust YouTube's official paid-placement tag — that's an explicit disclosure.
    if (blocked && v.has_paid_placement_tag) {
      paidTagKept++;
      unchanged++;
      continue;
    }

    if (!blocked) { unchanged++; continue; }

    // ── Downgrade ──
    const raw = v.classification_raw || {};
    const newRaw = {
      ...raw,
      industryGate: {
        blocked: true,
        category: gate.category,
        blockedBy: gate.blockedBy,
        gamingSignals: gate.gamingSignals,
        nonGamingSignals: gate.nonGamingSignals,
        reclassifiedAt: new Date().toISOString(),
        previousPlacementType: v.placement_type,
      },
    };

    const { error } = await db.from('youtube_competitor_videos')
      .update({
        placement_type: 'organic_mention',
        sponsor_confidence: 0,
        game_name: null,
        classification_raw: newRaw,
        last_updated_at: new Date().toISOString(),
      })
      .eq('video_id', v.video_id);

    if (error) {
      console.error(`  [FAIL] ${v.video_id} ${v.title?.slice(0, 50)} → ${error.message}`);
      continue;
    }
    downgraded++;
    byCategory[gate.category] = (byCategory[gate.category] || 0) + 1;
    kept += 1; // counted below in summary line
    console.log(`  [DOWNGRADED] ${gate.category.padEnd(14)} ${v.title?.slice(0, 60)} (was ${v.placement_type})`);
  }

  console.log('\n── Summary ──');
  console.log(`  Total placement-labeled videos : ${all.length}`);
  console.log(`  Kept as placements             : ${unchanged} (${all.length - downgraded})`);
  console.log(`    - gate passed                : ${unchanged - paidTagKept}`);
  console.log(`    - YouTube paid tag trusted   : ${paidTagKept}`);
  console.log(`  Downgraded to organic_mention  : ${downgraded}`);
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    - ${cat}: ${n}`);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Reclassify CLI failed:', err);
  process.exit(1);
});

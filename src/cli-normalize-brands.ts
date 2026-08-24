/**
 * CLI — Phase 1 brand normalization (P0-1): raw_brand → canonical_brand.
 *
 * Reads the raw brand from classification_raw (ai.brand || rule.brand),
 * normalizes it, and reconciles the Layer-3 count between the OLD exact-match
 * logic and the NEW canonical logic — BEFORE any column is switched over.
 *
 * Usage:
 *   npm run normalize-brands                    dry-run (default, no writes)
 *   npm run normalize-brands -- --write         apply backfill to the 3 columns
 *
 * Dry-run output = the reconciliation report:
 *   1. raw → canonical mapping, by raw value (finds every variant)
 *   2. Layer-3 placement count: OLD (exact match) vs NEW (canonical) per brand
 *   3. rows that CHANGE Layer-3 membership (sampled, with titles)
 *   4. unmappable raw values (unknown brands — need a human look)
 */

import { getSupabase } from './db/supabase';
import { canonicalBrand, CANONICAL_BRANDS } from './services/competitor-monitor/brand-normalization';

const WRITE = process.argv.includes('--write');
const PAGE = 1000;
const PLACEMENTS = ['confirmed_paid_placement', 'likely_sponsored'];

/** isAIVerified mirror of data-scope: classification_raw.ai present OR paid tag */
function isVerified(v: any): boolean {
  return !!v.classification_raw?.ai || !!v.has_paid_placement_tag;
}

/** needsAIVerification mirror: rule wants AI but AI hasn't ruled */
function needsAI(v: any): boolean {
  return !!v.classification_raw?.rule?.needsAI && !v.classification_raw?.ai;
}

/** brand confidence: AI confidence (0-100) → 0-1, else rule.brandConfidence */
function brandConfidenceOf(v: any): number | null {
  const ai = v.classification_raw?.ai;
  const rule = v.classification_raw?.rule;
  if (ai && typeof ai.confidence === 'number') return Math.min(ai.confidence / 100, 1);
  if (rule && typeof rule.brandConfidence === 'number') return rule.brandConfidence;
  return null;
}

async function main() {
  const db = getSupabase();
  console.log(`── Brand normalization (${WRITE ? 'WRITE' : 'DRY-RUN'}) ──`);
  if (!WRITE) console.log('  dry-run: nothing will be written. Add --write to apply.\n');

  // ── Load all rows (batch pagination, REST cap 1000/query) ──
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('youtube_competitor_videos')
      .select('video_id,title,placement_type,has_paid_placement_tag,classification_raw')
      .order('video_id')
      .range(from, from + PAGE - 1);
    if (error) { console.error('Query failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`Loaded ${all.length} videos.`);

  // ── Per-row computation ──
  interface Row {
    v: any;
    raw: string | null;
    canonical: string | null;
  }
  const rows: Row[] = all.map(v => {
    const raw = v.classification_raw?.ai?.brand
      || v.classification_raw?.rule?.brand
      || null;
    return { v, raw, canonical: canonicalBrand(raw) };
  });

  // ── Report 1: raw → canonical mapping ──
  const byRaw = new Map<string, { canonical: string | null; count: number }>();
  for (const r of rows) {
    const key = r.raw ?? '(null)';
    const e = byRaw.get(key) || { canonical: r.canonical, count: 0 };
    e.count++;
    byRaw.set(key, e);
  }
  console.log('\n── 1. raw → canonical mapping (count per raw value) ──');
  for (const [raw, { canonical, count }] of [...byRaw.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(canonical ?? 'unmapped').padEnd(10)} ← ${raw.padEnd(34)} ×${count}`);
  }

  // ── Report 2: Layer-3 count OLD vs NEW ──
  console.log('\n── 2. Layer-3 placement count: OLD (exact match) vs NEW (canonical) ──');
  const oldCount: Record<string, number> = {};
  const newCount: Record<string, number> = {};
  const changedRows: Row[] = [];
  const changedDropped: Row[] = []; // OLD yes, NEW no
  const changedAdded: Row[] = [];   // OLD no, NEW yes
  for (const r of rows) {
    if (!PLACEMENTS.includes(r.v.placement_type)) continue;
    if (!isVerified(r.v) || needsAI(r.v)) continue;
    const oldBrand = (CANONICAL_BRANDS as readonly string[]).includes(r.raw || '') ? r.raw : null;
    const newBrand = r.canonical;
    if (oldBrand) oldCount[oldBrand] = (oldCount[oldBrand] || 0) + 1;
    if (newBrand) newCount[newBrand] = (newCount[newBrand] || 0) + 1;
    if (oldBrand !== newBrand) {
      changedRows.push(r);
      if (oldBrand && !newBrand) changedDropped.push(r);
      if (!oldBrand && newBrand) changedAdded.push(r);
    }
  }
  for (const b of CANONICAL_BRANDS) {
    const o = oldCount[b] || 0, n = newCount[b] || 0;
    const delta = n - o;
    console.log(`  ${b.padEnd(10)} OLD=${String(o).padStart(5)}  NEW=${String(n).padStart(5)}  Δ=${delta >= 0 ? '+' : ''}${delta}`);
  }
  console.log(`  Layer-3 rows changing membership: ${changedRows.length} (dropped ${changedDropped.length}, added ${changedAdded.length})`);

  // ── Report 3: samples of changed rows ──
  console.log('\n── 3. Sample changed rows ──');
  const sample = [...changedAdded, ...changedDropped].slice(0, 25);
  if (!sample.length) console.log('  (none — old and new agree on Layer 3 membership)');
  for (const r of sample) {
    const flag = r.raw ? `was ${r.raw} →` : 'was (none) →';
    console.log(`  [${r.canonical ? 'ADDED  ' : 'DROPPED'}] ${flag} canonical=${String(r.canonical).padEnd(10)} ${r.v.video_id} ${(r.v.title || '').slice(0, 50)}`);
  }

  // ── Report 4: unmappable raw values ──
  const unmapped = [...byRaw.entries()].filter(([, e]) => !e.canonical && e.count > 0).sort((a, b) => b[1].count - a[1].count);
  console.log('\n── 4. Unmappable raw values (canonical = null) ──');
  if (!unmapped.length) console.log('  (none)');
  for (const [raw, { count }] of unmapped) console.log(`  ${raw.padEnd(34)} ×${count}`);

  // ── Report 5: paid-tag rows (trusted evidence) ──
  const paidTagCount = all.filter(v => v.has_paid_placement_tag).length;
  console.log(`\n  Paid-tag rows in DB: ${paidTagCount}`);

  // ── Write mode ──
  if (WRITE) {
    console.log('\n── Applying backfill (raw_brand / canonical_brand / brand_confidence) ──');
    const targets = rows.filter(r => r.raw !== null);
    let written = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      const conf = brandConfidenceOf(r.v);
      const { error } = await db.from('youtube_competitor_videos')
        .update({
          raw_brand: r.raw,
          canonical_brand: r.canonical,
          brand_confidence: conf,
          last_updated_at: new Date().toISOString(),
        })
        .eq('video_id', r.v.video_id);
      if (error) {
        failed++;
        if (failed <= 5) console.error(`  [FAIL] ${r.v.video_id} → ${error.message}`);
      } else {
        written++;
      }
      if (i % 100 === 0 && i > 0) console.log(`  ...${written}/${targets.length}`);
      await new Promise(s => setTimeout(s, 20));
    }
    console.log(`\n  Written: ${written}, failed: ${failed} / ${targets.length}`);
    console.log('  Next: run the DB migration (supabase-migration-brand-normalization.sql) if columns missing.');
  } else {
    console.log('\n  (dry-run complete — re-run with --write to apply, after the DB columns exist)');
  }
}

main().catch(err => {
  console.error('normalize-brands CLI failed:', err);
  process.exit(1);
});

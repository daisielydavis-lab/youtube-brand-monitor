/**
 * Competitor Monitor — Four-Layer Intelligence Pipeline
 *
 * Layer 1: Full collection (100% videos saved)
 * Layer 2: Rule engine (70-80% classified, no AI cost)
 * Layer 3: AI analysis (only remaining 20-30%, priority-queued)
 * Layer 4: Weekly batch intelligence report
 */
import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, buildHotspotQueries, BRANDS } from './brand-config';
import { searchVideos, getChannelsRecentVideos, getChannelsByIds, type YouTubeVideoResult } from './youtube-discovery';
import { fetchVideoComments, hasExistingComments, saveComments } from './video-enrichment';
import { getOrCreateCreatorProfile } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';
import { chatJSON } from '../ai/deepseek-client';
import { batchClassify as ruleClassify, type RuleClassification } from './rule-classifier';

// ── Types ──
export interface ScanState {
  running: boolean; mode: string; phase: 'idle' | 'discovery' | 'saving' | 'rule_classifying' | 'ai_classifying' | 'classifying' | 'completed' | 'failed' | string; status: string;
  searchQueriesTotal: number; searchQueriesSucceeded: number; searchQueriesFailed: number;
  creatorChannelsChecked: number;
  discoveredFromSearch: number; discoveredFromCreators: number; discoveredCount: number;
  persistedCount: number;
  selectedForAI: number; classified: number; likelyPlacements: number; queued: number; failed: number;
  searchQuotaUsed: number; generalQuotaUsed: number;
  errorCode: string; errors: string[]; startedAt: string; done: boolean;
}

export let scanState: ScanState = {
  running: false, mode: '', phase: 'idle', status: 'idle',
  searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0,
  creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, discoveredCount: 0,
  persistedCount: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0,
  searchQuotaUsed: 0, generalQuotaUsed: 0, errorCode: '', errors: [], startedAt: '', done: false,
};

let dailySearchUsed = 0, dailyGeneralUsed = 0, searchCircuitOpen = false;
const AI_BATCH_SIZE = 10, MAX_AI_PER_SCAN = 50, SCAN_TIMEOUT_MS = 10 * 60_000;

function trackSearch() { dailySearchUsed++; scanState.searchQuotaUsed = dailySearchUsed; }
function trackGeneral(n: number) { dailyGeneralUsed += n; scanState.generalQuotaUsed = dailyGeneralUsed; }

function resetState(mode: string) {
  searchCircuitOpen = false;
  scanState = { running: true, mode, phase: 'discovery', status: 'running', searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0, creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, discoveredCount: 0, persistedCount: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0, searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed, errorCode: '', errors: [], startedAt: new Date().toISOString(), done: false };
}

// ── Priority scoring (rule-based, no LLM) ──
function scorePriority(v: YouTubeVideoResult, knownIds: Set<string>, hotspotGames: string[]): number {
  let s = 0; const t = v.title.toLowerCase(), d = v.description.toLowerCase();
  for (const b of BRANDS) { for (const kw of b.brandKeywords) { if (t.includes(kw)) { s += 30; break; } } }
  if (/exitlag\.com|gearupbooster\.com|lagzapper\.com/i.test(d)) s += 25;
  if (/(?:code|promo|coupon)[:\s]*[A-Za-z0-9_-]{3,20}/i.test(d)) s += 25;
  if (/sponsored|paid.?promotion|#ad|partner|affiliate/i.test(t + ' ' + d)) s += 20;
  if (v.hasPaidPlacementTag) s += 20;
  for (const g of hotspotGames) { if (t.includes(g.toLowerCase())) { s += 15; break; } }
  if (knownIds.has(v.channelId)) s += 10;
  if (Date.now() - new Date(v.publishedAt).getTime() < 72 * 3600000) s += 10;
  if (v.viewCount > 10000 && (Date.now() - new Date(v.publishedAt).getTime()) / 3600000 < 24) s += 5;
  let hasBrand = false; for (const b of BRANDS) { for (const kw of b.brandKeywords) { if ((t + d).includes(kw)) { hasBrand = true; break; } } }
  if (!hasBrand) s -= 15;
  return s;
}

// ── True batch AI via unified client ──
async function batchClassifyVideos(
  videos: Array<{ videoId: string; title: string; description: string; channelName: string; publishedAt: string; tags: string[]; hasPaidPlacementTag: boolean }>,
): Promise<{ classified: number; likely: number; errors: string[] }> {
  let classified = 0, likely = 0;
  const errors: string[] = [];

  for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
    const batch = videos.slice(i, i + AI_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_BATCH_SIZE) + 1;

    const items = batch.map(v => ({
      videoId: v.videoId, title: v.title, descSnippet: v.description.slice(0, 300),
      channelName: v.channelName, publishedAt: v.publishedAt, hasPaidTag: v.hasPaidPlacementTag,
      matchedBrand: BRANDS.find(b => b.brandKeywords.some(kw => v.title.toLowerCase().includes(kw) || v.description.toLowerCase().includes(kw)))?.brandName || null,
    }));

    const prompt = `Classify these ${items.length} YouTube videos for game booster brand sponsorships (GearUP, ExitLag, LagZapper).

Return a JSON object: {"videos": [...]}

Each video object:
- videoId, placementType ("confirmed"|"likely"|"organic"|"official"|"irrelevant"), confidence (0-100)
- brand ("GearUP"|"ExitLag"|"LagZapper"|null), game (string|null)
- theme ("reduce_ping"|"promo_code"|"game_review"|"tutorial"|"comparison"|"new_launch"|"cross_region"|"other")
- format ("dedicated"|"integrated"|"shorts"|"live")
- reasonCodes (array of "brand_in_title"|"brand_link"|"promo_code"|"sponsored_tag"|"paid_tag"|"casual_mention"|"no_signal")

Rules: confirmed=explicit #ad/sponsored/paid tag. likely=promo code+brand link+product focus. organic=casual mention. irrelevant=no brand signal.

Videos: ${JSON.stringify(items)}`;

    const result = await chatJSON<{ videos: any[] }>(
      [{ role: 'user', content: prompt }],
      { mode: 'fast', maxTokens: 4096 },
    );

    if (result.success && result.data?.videos?.length) {
      for (const item of result.data.videos) {
        const vid = batch.find(v => v.videoId === item.videoId);
        if (!vid) continue;
        const m: Record<string, string> = { confirmed: 'confirmed_paid_placement', likely: 'likely_sponsored', organic: 'organic_mention', official: 'official_brand_video', irrelevant: 'unknown' };
        const pt = m[item.placementType] || 'unknown';
        if (pt === 'confirmed_paid_placement' || pt === 'likely_sponsored') likely++;

        await getSupabase().from('youtube_competitor_videos').update({
          placement_type: pt, sponsor_confidence: (item.confidence || 50) / 100,
          game_name: item.game || null, topic_category: item.theme || 'game_integration',
          content_type: item.format || 'integrated_placement',
          workflow_status: 'classified',
          classification_raw: { ai: item, batchNum, classifiedAt: new Date().toISOString() },
          last_updated_at: new Date().toISOString(),
        }).eq('video_id', item.videoId);
        classified++;
      }
      scanState.classified = classified;
      scanState.likelyPlacements = likely;
    } else {
      const err = `Batch ${batchNum}: ${result.error}`;
      errors.push(err);
      console.error(`[AI] ${err}`, result.diagnostic.contentPreview?.slice(0, 200));
      for (const v of batch) {
        await getSupabase().from('youtube_competitor_videos').update({
          workflow_status: 'discovered', classification_raw: { error: result.error, queuedAt: new Date().toISOString() },
        }).eq('video_id', v.videoId);
        scanState.failed++;
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { classified, likely, errors };
}

// ── Main Pipeline ──
export async function runDiscoveryPipeline(options?: {
  backfillDays?: number; mode?: 'normal' | 'hotspot' | 'manual'; hotspotGame?: string;
  skipAI?: boolean; skipComments?: boolean;
}): Promise<{ videosDiscovered: number; videosClassified: number }> {
  const mode = options?.mode || 'normal';
  const backfillDays = mode === 'manual' ? (options?.backfillDays || 7) : 1;
  const publishedAfter = new Date(Date.now() - backfillDays * 86400000).toISOString();
  resetState(mode);
  console.log(`[Monitor] ${mode} scan — since ${publishedAfter}`);

  const db = getSupabase();
  const allVids: YouTubeVideoResult[] = [];
  const seen = new Set<string>();
  const { data: existing } = await db.from('youtube_competitor_videos').select('video_id').gte('first_seen_at', new Date(Date.now() - 60 * 86400000).toISOString());
  (existing || []).forEach((v: any) => seen.add(v.video_id));

  // Phase 1: Search (with circuit breaker)
  let searchFrom = 0;
  const queries = mode === 'hotspot' && options?.hotspotGame ? buildHotspotQueries(options.hotspotGame) : getActiveQueries();
  scanState.searchQueriesTotal = queries.length;
  for (const q of queries) {
    if (searchCircuitOpen) { scanState.searchQueriesFailed++; continue; }
    try {
      trackSearch();
      const results = await searchVideos(q, publishedAfter, 50);
      scanState.searchQueriesSucceeded++;
      for (const r of results) { if (!seen.has(r.videoId)) { seen.add(r.videoId); allVids.push(r); searchFrom++; } }
      await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
    } catch (err) {
      scanState.searchQueriesFailed++;
      if ((err as Error).message.startsWith('YT_QUOTA_EXHAUSTED')) { searchCircuitOpen = true; scanState.errorCode = 'SEARCH_QUOTA_EXHAUSTED'; }
    }
  }
  scanState.discoveredFromSearch = searchFrom;

  // Phase 2: Channel monitoring
  const { data: creators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);
  let creatorFrom = 0;
  if (creators?.length) {
    scanState.creatorChannelsChecked = creators.length;
    const ids = creators.map((c: any) => c.channel_id);
    trackGeneral(Math.ceil(ids.length / 50) + ids.length);
    const chVids = await getChannelsRecentVideos(ids, publishedAfter, 5);
    for (const v of chVids) { if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod = 'channel_scan'; allVids.push(v); creatorFrom++; } }
  }
  scanState.discoveredFromCreators = creatorFrom;
  scanState.discoveredCount = allVids.length;

  // Log Supabase target
  console.log(`[Monitor] Supabase host: ${new URL(config.supabase.url).hostname} | serviceRole: ${!!config.supabase.serviceRoleKey}`);

  if (!allVids.length) { scanState.done = true; scanState.running = false; return { videosDiscovered: 0, videosClassified: 0 }; }

  // Phase 3: Save + score with PROPER error handling
  scanState.phase = 'saving';
  const knownIds = new Set((creators || []).map((c: any) => c.channel_id));
  const { data: cfg } = await db.from('monitor_config').select('hotspot_games').eq('id', 1).maybeSingle();
  const scored = allVids.map(v => ({ video: v, priority: scorePriority(v, knownIds, (cfg as any)?.hotspot_games || []) })).sort((a, b) => b.priority - a.priority);

  console.log(`[Monitor] Attempting to persist ${scored.length} videos...`);

  let persistedCount = 0;
  const persistedIds: string[] = [];
  const saveErrors: Array<{ videoId: string; error: string }> = [];

  for (const { video: v } of scored) {
    try {
      if (!knownIds.has(v.channelId)) {
        const ch = await getChannelsByIds([v.channelId]);
        if (ch[0]) await getOrCreateCreatorProfile(ch[0].channelId, ch[0].channelName);
      }

      const { error } = await db.from('youtube_competitor_videos').upsert({
        video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle,
        title: v.title, description: v.description || '', published_at: v.publishedAt,
        duration: v.duration, is_short: v.isShort, thumbnail_url: v.thumbnailUrl || null,
        tags: v.tags, category_id: v.categoryId,
        discovery_method: (v as any).discoveryMethod || 'keyword_search',
        has_paid_placement_tag: v.hasPaidPlacementTag,
        view_count: v.viewCount, like_count: v.likeCount, comment_count: v.commentCount,
        workflow_status: 'discovered',
        brand_id: null,
        first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
      }, { onConflict: 'video_id' });

      if (error) {
        saveErrors.push({ videoId: v.videoId, error: `${error.code}: ${error.message}` });
        if (saveErrors.length <= 3) {
          console.error(`[Monitor] Save FAILED for ${v.videoId}: code=${error.code} msg=${error.message} details=${error.details} hint=${error.hint}`);
        }
      } else {
        persistedCount++;
        persistedIds.push(v.videoId);
      }
    } catch (err) {
      saveErrors.push({ videoId: v.videoId, error: (err as Error).message });
    }
  }

  // ── VERIFY: query DB for actual count ──
  const { count: dbCount, error: countErr } = await db
    .from('youtube_competitor_videos')
    .select('video_id', { count: 'exact', head: true })
    .in('video_id', allVids.map(v => v.videoId));

  scanState.persistedCount = dbCount ?? 0;

  console.log(`[Monitor] Persist result: attempted=${scored.length} persisted=${persistedCount} dbConfirmed=${dbCount} saveErrors=${saveErrors.length}`);

  if (saveErrors.length > 0) {
    console.error(`[Monitor] Save errors (first 5): ${JSON.stringify(saveErrors.slice(0, 5))}`);
    scanState.errors.push(`Save errors: ${saveErrors.length}/${scored.length} failed`);
  }

  if (!dbCount || dbCount === 0) {
    scanState.errorCode = 'VIDEO_PERSISTENCE_FAILED';
    scanState.status = 'failed';
    scanState.errors.push(`0 videos persisted out of ${scored.length} attempted — check brand_id constraint and Supabase connection`);
    console.error(`[Monitor] FATAL: 0 videos persisted. Supabase: ${config.supabase.url}`);
    scanState.done = true; scanState.running = false; scanState.phase = 'failed';
    return { videosDiscovered: 0, videosClassified: 0 };
  }

  const actualCount = dbCount ?? 0;

  // ── Phase 4: Rule Classification (Layer 2) — 100% coverage, zero AI cost ──
  scanState.phase = 'rule_classifying';
  console.log(`[Monitor] Phase 4: Rule classifying ${actualCount} videos...`);
  const toClassify = scored.map(c => ({
    videoId: c.video.videoId, title: c.video.title, description: c.video.description,
    tags: c.video.tags, channelName: c.video.channelTitle, isShort: c.video.isShort,
    viewCount: c.video.viewCount, publishedAt: c.video.publishedAt,
    hasPaidPlacementTag: c.video.hasPaidPlacementTag,
  }));
  const { classified: ruleDone, aiQueue } = ruleClassify(toClassify);

  // Update DB with rule classifications
  let ruleClassified = 0;
  for (const r of ruleDone) {
    await db.from('youtube_competitor_videos').update({
      placement_type: r.placementType !== 'unknown' ? r.placementType : null,
      sponsor_confidence: r.brandConfidence,
      game_name: r.game || null,
      topic_category: r.topicCategory,
      content_type: r.contentCategory,
      language: r.language,
      market: r.market,
      workflow_status: 'rule_classified',
      classification_raw: {
        rule: {
          brand: r.brand, brandConfidence: r.brandConfidence, brandEvidence: r.brandEvidence,
          game: r.game, gameConfidence: r.gameConfidence,
          placementType: r.placementType, sponsorSignals: r.sponsorSignals,
          contentCategory: r.contentCategory, topicCategory: r.topicCategory,
          language: r.language, market: r.market,
        },
        classifiedAt: new Date().toISOString(),
      },
      last_updated_at: new Date().toISOString(),
    }).eq('video_id', r.videoId);
    ruleClassified++;
  }
  console.log(`[Monitor] Rule classified: ${ruleClassified} videos (${Math.round(ruleClassified/actualCount*100)}%)`);

  // ── Phase 5: AI Queue (Layer 3) — only videos rules couldn't classify ──
  const aiCandidates = aiQueue.filter(r => r.needsAI).sort((a, b) => b.aiPriority - a.aiPriority);
  const aiLimit = options?.skipAI ? 0 : MAX_AI_PER_SCAN;
  const aiBatch = aiCandidates.slice(0, aiLimit);
  const aiDeferred = aiCandidates.slice(aiLimit);

  scanState.selectedForAI = aiBatch.length;
  scanState.queued = aiDeferred.length + ruleDone.filter(r => r.placementType === 'unknown').length;
  scanState.classified = ruleClassified;
  scanState.likelyPlacements = ruleDone.filter(r =>
    r.placementType === 'confirmed_paid_placement' || r.placementType === 'likely_sponsored'
  ).length;

  if (aiBatch.length > 0) {
    scanState.phase = 'ai_classifying';
    console.log(`[Monitor] Phase 5: AI classifying ${aiBatch.length} videos (priority-queued, ${aiDeferred.length} deferred)`);
    // Map AI queue back to full video metadata for AI classification
    const aiInputs = aiBatch.map(r => {
      const orig = scored.find(s => s.video.videoId === r.videoId);
      return {
        videoId: r.videoId,
        title: orig?.video.title || '', description: orig?.video.description || '',
        channelName: orig?.video.channelTitle || '', publishedAt: orig?.video.publishedAt || '',
        tags: orig?.video.tags || [], hasPaidPlacementTag: orig?.video.hasPaidPlacementTag || false,
      };
    });
    const aiResult = await batchClassifyVideos(aiInputs);
    scanState.errors.push(...aiResult.errors);
    scanState.classified += aiResult.classified;
    scanState.likelyPlacements += aiResult.likely;
    console.log(`[Monitor] AI classified: ${aiResult.classified} additional videos`);
  } else {
    console.log(`[Monitor] Phase 5: Skipped — all ${actualCount} videos classified by rules (no AI needed)`);
  }

  // Save snapshots for all classified videos
  for (const c of scored.slice(0, 50)) {
    await saveSnapshot(c.video.videoId, 'discovery', Math.round((Date.now() - new Date(c.video.publishedAt).getTime()) / 3600000), c.video.viewCount, c.video.likeCount, c.video.commentCount, 0, 0.5, c.video.isShort);
  }

  // Mark deferred videos in DB with priority
  for (const r of aiDeferred) {
    await db.from('youtube_competitor_videos').update({
      workflow_status: 'rule_classified',
      classification_raw: {
        rule: { brand: r.brand, game: r.game, needsAI: true, aiPriority: r.aiPriority, aiReason: r.aiReason },
        queuedAt: new Date().toISOString(),
      },
    }).eq('video_id', r.videoId);
  }

  // Phase 5: Comments (high-conf only)
  if (!options?.skipComments && scanState.classified > 0) {
    const { data: hc } = await db.from('youtube_competitor_videos').select('video_id, comment_count').in('placement_type', ['confirmed_paid_placement', 'likely_sponsored']).gte('comment_count', 10).order('first_seen_at', { ascending: false }).limit(10);
    for (const v of (hc || [])) {
      if (await hasExistingComments(v.video_id)) continue;
      trackGeneral(1);
      const comments = await fetchVideoComments(v.video_id, 30, 'relevance');
      if (comments.length > 0) await saveComments(v.video_id, comments);
    }
  }

  scanState.phase = 'completed'; scanState.status = scanState.errorCode ? 'partial_completed' : 'completed';
  scanState.done = true; scanState.running = false;
  console.log(`[Monitor] Done: ${scanState.discoveredCount} vids AI=${scanState.classified} likely=${scanState.likelyPlacements}`);
  return { videosDiscovered: scanState.discoveredCount, videosClassified: scanState.classified };
}

// ── Retry classification (Rules-first, then AI for priority queue) ──
export async function retryClassification(limit: number = MAX_AI_PER_SCAN): Promise<{ classified: number }> {
  const db = getSupabase();
  // Find videos that need classification: discovered (never processed) OR rule_classified with needsAI flag
  const { data: pending } = await db.from('youtube_competitor_videos')
    .select('*')
    .or('workflow_status.eq.discovered,and(workflow_status.eq.rule_classified,placement_type.is.null)')
    .order('first_seen_at', { ascending: false })
    .limit(limit);
  if (!pending?.length) return { classified: 0 };

  resetState('retry');
  scanState.discoveredCount = pending.length;

  // Step 1: Run rule classifier first
  const { classified: ruleDone, aiQueue } = ruleClassify((pending as any[]).map(v => ({
    videoId: v.video_id, title: v.title, description: v.description || '',
    tags: v.tags || [], channelName: v.channel_name || '', isShort: v.is_short || false,
    viewCount: v.view_count || 0, publishedAt: v.published_at || '', hasPaidPlacementTag: v.has_paid_placement_tag || false,
  })));

  // Update DB with rule classifications
  for (const r of ruleDone) {
    await db.from('youtube_competitor_videos').update({
      placement_type: r.placementType !== 'unknown' ? r.placementType : null,
      sponsor_confidence: r.brandConfidence,
      game_name: r.game || null, topic_category: r.topicCategory,
      content_type: r.contentCategory, language: r.language, market: r.market,
      workflow_status: 'rule_classified',
      classification_raw: { rule: { brand: r.brand, game: r.game, placementType: r.placementType, aiPriority: r.aiPriority, aiReason: r.aiReason }, classifiedAt: new Date().toISOString() },
      last_updated_at: new Date().toISOString(),
    }).eq('video_id', r.videoId);
  }

  // Step 2: AI for priority queue (top priority first)
  const aiBatch = aiQueue.slice(0, MAX_AI_PER_SCAN);
  const result = aiBatch.length > 0
    ? await batchClassifyVideos(aiBatch.map(r => {
        const orig = (pending as any[]).find((v: any) => v.video_id === r.videoId);
        return { videoId: r.videoId, title: orig?.title || '', description: orig?.description || '', channelName: orig?.channel_name || '', publishedAt: orig?.published_at || '', tags: orig?.tags || [], hasPaidPlacementTag: orig?.has_paid_placement_tag || false };
      }))
    : { classified: 0, likely: 0, errors: [] as string[] };

  scanState.classified = ruleDone.length + result.classified;
  scanState.likelyPlacements = ruleDone.filter(r => r.placementType === 'confirmed_paid_placement' || r.placementType === 'likely_sponsored').length + result.likely;
  scanState.done = true; scanState.running = false; scanState.phase = 'completed';
  console.log(`[Retry] Rule: ${ruleDone.length} + AI: ${result.classified} = ${scanState.classified} total`);
  return { classified: scanState.classified };
}

export async function getMonitorStatus() {
  const db = getSupabase();
  const { count: tv } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: cr } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: lv } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  return { totalVideos: tv || 0, totalCreators: (cr || []).length, lastRun: (lv as any)?.created_at || null, searchQuotaUsed: dailySearchUsed, searchQuotaLimit: 100, generalQuotaUsed: dailyGeneralUsed, generalQuotaLimit: 10000, hotspotActive: (cfg as any)?.hotspot_active || false, scanRunning: scanState.running };
}

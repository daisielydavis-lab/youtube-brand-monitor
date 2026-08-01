/**
 * Competitor Monitor v3 — Two-Phase Discovery Pipeline
 *
 * Phase 1: All videos saved as DISCOVERED — rule-based priority scoring (no LLM)
 * Phase 2: Top-N videos get batch AI classification (10-20 per call)
 * Phase 3: Only confirmed/likely flagged for deep analysis
 * Rest: QUEUED_FOR_AI — processed in subsequent scans
 *
 * Timeout: 10 min per scan → PARTIAL_COMPLETED
 * Search budget: hard stops at 70/80/90
 */

import { config, validateConfig } from '../../config';
import { getSupabase } from '../../db/supabase';
import { getActiveQueries, buildHotspotQueries } from './brand-config';
import {
  searchVideos, getChannelsRecentVideos, getChannelsByIds, type YouTubeVideoResult,
} from './youtube-discovery';
import { fetchVideoComments, hasExistingComments, saveComments } from './video-enrichment';
import { detectSponsorshipBatch, type SponsorshipResult } from './sponsorship-detector';
import { classifyTopicsBatch, classifyAndUpdateComments, type TopicResult } from './topic-classifier';
import { getOrCreateCreatorProfile, updateCreatorFromVideo } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';

// ── Types ──
export interface ScanState {
  running: boolean; mode: string; phase: string;
  discovered: number; deduplicated: number; prefiltered: number;
  selectedForAI: number; classified: number; likelyPlacements: number;
  queued: number; failed: number;
  searchQuotaUsed: number; generalQuotaUsed: number;
  errors: string[]; startedAt: string; done: boolean;
}

// ── State ──
export let scanState: ScanState = {
  running: false, mode: '', phase: 'idle',
  discovered: 0, deduplicated: 0, prefiltered: 0,
  selectedForAI: 0, classified: 0, likelyPlacements: 0,
  queued: 0, failed: 0,
  searchQuotaUsed: 0, generalQuotaUsed: 0,
  errors: [], startedAt: '', done: false,
};

let dailySearchUsed = 0;
let dailyGeneralUsed = 0;

const AI_BATCH_SIZE = 15;
const MAX_AI_PER_SCAN = 50;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const AI_CALL_TIMEOUT_MS = 90_000; // 90s per batch

function trackSearch(n: number) { dailySearchUsed += n; scanState.searchQuotaUsed = dailySearchUsed; }
function trackGeneral(n: number) { dailyGeneralUsed += n; scanState.generalQuotaUsed = dailyGeneralUsed; }
function canSearch(t: number) { return dailySearchUsed < t; }

function resetState(mode: string) {
  scanState = { running: true, mode, phase: 'discovery', discovered: 0, deduplicated: 0, prefiltered: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0, searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed, errors: [], startedAt: new Date().toISOString(), done: false };
}

function timeoutCheck(startedAt: string): { timedOut: boolean } {
  return { timedOut: Date.now() - new Date(startedAt).getTime() > SCAN_TIMEOUT_MS };
}

// ── Priority scoring (rule-based, no LLM) ──
function scoreVideoPriority(v: YouTubeVideoResult, brandKeywords: string[], knownCreatorIds: Set<string>, hotspotGames: string[]): number {
  let score = 0;
  const t = v.title.toLowerCase();
  const d = v.description.toLowerCase();
  // Brand in title
  for (const kw of brandKeywords) { if (t.includes(kw)) { score += 30; break; } }
  // Brand domain in description
  if (/exitlag\.com|gearupbooster\.com|lagzapper\.com/i.test(d)) score += 25;
  // Promo/discount code
  if (/(?:code|promo|coupon|discount)[:\s]*["']?[A-Za-z0-9_-]{3,20}/i.test(d)) score += 25;
  // Sponsored/partner signals
  if (/sponsored|paid.?promotion|#ad|#sponsored|partner|affiliate/i.test(t + ' ' + d)) score += 20;
  // Paid placement tag
  if (v.hasPaidPlacementTag) score += 20;
  // Hotspot game
  for (const g of hotspotGames) { if (t.includes(g.toLowerCase())) { score += 15; break; } }
  // Known creator
  if (knownCreatorIds.has(v.channelId)) score += 10;
  // Recent (within 72h)
  if (Date.now() - new Date(v.publishedAt).getTime() < 72 * 3600000) score += 10;
  // High view velocity (rough: >10K views in first 24h)
  const hoursSincePub = (Date.now() - new Date(v.publishedAt).getTime()) / 3600000;
  if (hoursSincePub > 0 && v.viewCount / hoursSincePub > 400) score += 5;
  // Weak match penalty
  let brandSignal = false;
  for (const kw of brandKeywords) { if ((t + d).includes(kw)) { brandSignal = true; break; } }
  if (!brandSignal) score -= 15;

  return score;
}

// ── Batch AI classifier ──
async function batchClassify(
  videos: Array<{ videoId: string; title: string; description: string; channelName: string; tags: string[]; hasPaidPlacementTag: boolean }>,
): Promise<{ sponsorship: SponsorshipResult[]; topic: TopicResult[] }> {
  const sponsorshipResults: SponsorshipResult[] = [];
  const topicResults: TopicResult[] = [];

  for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
    const batch = videos.slice(i, i + AI_BATCH_SIZE);
    if (timeoutCheck(scanState.startedAt).timedOut) {
      // Pad remaining with empty
      const emptyS: SponsorshipResult = { placementType: 'unknown', sponsorConfidence: 0, detectedBrand: null, brandMentionPositions: [], promoCode: null, landingDomain: null, ctaType: null, sellingPoints: [], reasoning: 'Timeout — queued' };
      const emptyT: TopicResult = { gameName: null, gameConfidence: 0, contentCategory: 'integrated_placement', topicCategory: 'game_integration', language: 'en', market: 'US' };
      for (let j = i; j < videos.length; j++) { sponsorshipResults.push({ ...emptyS }); topicResults.push({ ...emptyT }); }
      scanState.errors.push('Scan timeout — remaining videos queued');
      break;
    }

    try {
      const batchSponsorship = await Promise.race([
        detectSponsorshipBatch(batch.map(v => ({
          title: v.title, description: v.description.slice(0, 500), channelName: v.channelName, tags: v.tags, hasPaidPlacementTag: v.hasPaidPlacementTag,
        }))),
        new Promise<SponsorshipResult[]>((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_CALL_TIMEOUT_MS)),
      ]);
      sponsorshipResults.push(...batchSponsorship);

      const batchTopic = await Promise.race([
        classifyTopicsBatch(batch.map(v => ({
          title: v.title, description: v.description.slice(0, 500), tags: v.tags, channelName: v.channelName,
        }))),
        new Promise<TopicResult[]>((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_CALL_TIMEOUT_MS)),
      ]);
      topicResults.push(...batchTopic);

      scanState.classified += batch.length;
      // Count likely placements
      scanState.likelyPlacements = sponsorshipResults.filter(s =>
        s.placementType === 'confirmed_paid_placement' || s.placementType === 'likely_sponsored').length;

      console.log(`[Monitor] AI batch ${Math.floor(i/AI_BATCH_SIZE)+1}: ${batch.length} videos classified (${scanState.classified}/${videos.length}), ${scanState.likelyPlacements} likely placements`);
    } catch (err) {
      const msg = (err as Error).message;
      // Retry once
      if (msg !== 'AI_TIMEOUT_RETRIED') {
        console.warn(`[Monitor] AI batch failed, retrying: ${msg}`);
        try {
          const retrySponsorship = await detectSponsorshipBatch(batch.map(v => ({
            title: v.title, description: v.description.slice(0, 500), channelName: v.channelName, tags: v.tags, hasPaidPlacementTag: v.hasPaidPlacementTag,
          })));
          const retryTopic = await classifyTopicsBatch(batch.map(v => ({
            title: v.title, description: v.description.slice(0, 500), tags: v.tags, channelName: v.channelName,
          })));
          sponsorshipResults.push(...retrySponsorship);
          topicResults.push(...retryTopic);
          scanState.classified += batch.length;
          scanState.likelyPlacements = sponsorshipResults.filter(s =>
            s.placementType === 'confirmed_paid_placement' || s.placementType === 'likely_sponsored').length;
          continue;
        } catch {
          scanState.errors.push(`AI batch ${Math.floor(i/AI_BATCH_SIZE)+1} failed after retry`);
        }
      }
      // Pad with failed
      const emptyS: SponsorshipResult = { placementType: 'unknown', sponsorConfidence: 0, detectedBrand: null, brandMentionPositions: [], promoCode: null, landingDomain: null, ctaType: null, sellingPoints: [], reasoning: 'AI_FAILED_RETRYABLE' };
      const emptyT: TopicResult = { gameName: null, gameConfidence: 0, contentCategory: 'integrated_placement', topicCategory: 'game_integration', language: 'en', market: 'US' };
      for (let j = 0; j < batch.length; j++) { sponsorshipResults.push({ ...emptyS }); topicResults.push({ ...emptyT }); }
      scanState.failed += batch.length;
    }

    // Small gap between batches
    await new Promise(r => setTimeout(r, 500));
  }

  return { sponsorship: sponsorshipResults, topic: topicResults };
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
  console.log(`[Monitor] ${mode} scan — since ${publishedAfter} | search: ${dailySearchUsed}/100`);

  const db = getSupabase();
  const allDiscovered: YouTubeVideoResult[] = [];
  const seen = new Set<string>();

  // Dedup buffer
  const { data: existing } = await db.from('youtube_competitor_videos').select('video_id')
    .gte('first_seen_at', new Date(Date.now() - 60 * 86400000).toISOString());
  (existing || []).forEach((v: any) => seen.add(v.video_id));

  // ═══ Phase 1: Discovery ═══
  scanState.phase = 'discovery';

  if (canSearch(70)) {
    if (mode === 'hotspot' && options?.hotspotGame) {
      const hq = buildHotspotQueries(options.hotspotGame);
      for (const q of hq) { if (!canSearch(70)) break;
        trackSearch(1); const r = await searchVideos(q, publishedAfter, 50);
        for (const v of r) { if (!seen.has(v.videoId)) { seen.add(v.videoId); allDiscovered.push(v); } }
      }
    } else {
      const queries = getActiveQueries();
      const { data: runs } = await db.from('competitor_queries').select('query_text, last_run_at').order('last_run_at', { ascending: true, nullsFirst: true });
      const runMap = new Map<string,string>(); (runs||[]).forEach((r:any)=>runMap.set(r.query_text,r.last_run_at));
      const sorted = [...queries].sort((a,b)=>{
        const al=runMap.get(a.queryText),bl=runMap.get(b.queryText);
        if(!al&&bl)return -1;if(al&&!bl)return 1;if(!al&&!bl)return 0;
        return new Date(al!).getTime()-new Date(bl!).getTime();
      });
      // Run 1 query in normal, more in manual
      const toRun = mode === 'manual' ? sorted : [sorted[0]];
      for (const q of toRun) { if (!canSearch(70)) break;
        trackSearch(1); const r = await searchVideos(q, publishedAfter, 50);
        for (const v of r) { if (!seen.has(v.videoId)) { seen.add(v.videoId); allDiscovered.push(v); } }
        await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
      }
    }
  }

  // Channel monitoring
  const { data: knownCreators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);
  if (knownCreators?.length) {
    const channelIds = knownCreators.map((c:any)=>c.channel_id);
    trackGeneral(Math.ceil(channelIds.length/50)+channelIds.length);
    const chVids = await getChannelsRecentVideos(channelIds, publishedAfter, 5);
    for (const v of chVids) { if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod='channel_scan'; allDiscovered.push(v); } }
  }

  scanState.discovered = allDiscovered.length;
  scanState.deduplicated = allDiscovered.length; // already deduped above

  if (!allDiscovered.length) { scanState.done = true; scanState.running = false; return { videosDiscovered: 0, videosClassified: 0 }; }

  // ═══ Phase 2: Save all as DISCOVERED, score priority ═══
  scanState.phase = 'prefiltering';
  const knownIds = new Set((knownCreators || []).map((c:any)=>c.channel_id));
  const { data: brands } = await db.from('competitor_brands').select('*');
  const brandKeywords = (brands||[]).flatMap((b:any)=>[b.brand_name.toLowerCase(), b.display_name?.toLowerCase()].filter(Boolean));
  const { data: cfg } = await db.from('monitor_config').select('hotspot_games').eq('id',1).maybeSingle();
  const hotspotGames = (cfg as any)?.hotspot_games || [];

  // Score and sort
  const scored = allDiscovered.map(v => ({
    video: v,
    priority: scoreVideoPriority(v, brandKeywords, knownIds, hotspotGames),
  })).sort((a, b) => b.priority - a.priority);

  scanState.prefiltered = allDiscovered.length;
  const aiCandidates = scored.slice(0, MAX_AI_PER_SCAN);
  const queued = scored.slice(MAX_AI_PER_SCAN);
  scanState.selectedForAI = aiCandidates.length;
  scanState.queued = queued.length;

  // Save all videos first
  console.log(`[Monitor] Saving ${allDiscovered.length} videos (${aiCandidates.length} for AI, ${queued.length} queued)`);
  scanState.phase = 'saving';

  for (const { video: v, priority } of scored) {
    const isAI = aiCandidates.some(c => c.video.videoId === v.videoId);
    // New channels
    if (!knownIds.has(v.channelId)) {
      const ch = await getChannelsByIds([v.channelId]);
      if (ch[0]) await getOrCreateCreatorProfile(ch[0].channelId, ch[0].channelName);
    }

    const row = {
      video_id: v.videoId, channel_id: v.channelId, channel_name: v.channelTitle,
      title: v.title, description: v.description, published_at: v.publishedAt,
      duration: v.duration, is_short: v.isShort, thumbnail_url: v.thumbnailUrl,
      tags: v.tags, category_id: v.categoryId,
      discovery_method: (v as any).discoveryMethod || 'keyword_search',
      has_paid_placement_tag: v.hasPaidPlacementTag,
      view_count: v.viewCount, like_count: v.likeCount, comment_count: v.commentCount,
      workflow_status: isAI ? 'discovered' : 'discovered', // Will be updated after AI
      first_seen_at: new Date().toISOString(), last_updated_at: new Date().toISOString(),
    };

    await db.from('youtube_competitor_videos').upsert(row, { onConflict: 'video_id' });
  }

  // ═══ Phase 3: AI Batch Classification (only top N) ═══
  let sponsorship: SponsorshipResult[] = [];
  let topic: TopicResult[] = [];
  if (!options?.skipAI && aiCandidates.length > 0) {
    scanState.phase = 'classifying';
    console.log(`[Monitor] Batch AI: ${aiCandidates.length} videos in ${Math.ceil(aiCandidates.length/AI_BATCH_SIZE)} batches`);

    const results = await batchClassify(
      aiCandidates.map(c => ({
        videoId: c.video.videoId, title: c.video.title, description: c.video.description,
        channelName: c.video.channelTitle, tags: c.video.tags, hasPaidPlacementTag: c.video.hasPaidPlacementTag,
      })),
    );
    sponsorship = results.sponsorship;
    topic = results.topic;

    // Save classified results
    for (let i = 0; i < aiCandidates.length; i++) {
      const sp = sponsorship[i];
      const tp = topic[i];

      let brandId: string | null = null;
      if (sp.detectedBrand) {
        const { data: br } = await db.from('competitor_brands').select('id').eq('brand_name', sp.detectedBrand).maybeSingle();
        brandId = br?.id || null;
      }

      await db.from('youtube_competitor_videos').update({
        brand_id: brandId,
        game_name: tp.gameName, content_type: tp.contentCategory,
        placement_type: sp.placementType, sponsor_confidence: sp.sponsorConfidence,
        brand_mention_position: sp.brandMentionPositions, topic_category: tp.topicCategory,
        promo_code: sp.promoCode, landing_domain: sp.landingDomain, cta_type: sp.ctaType,
        product_selling_points: sp.sellingPoints,
        language: tp.language, market: tp.market,
        workflow_status: sp.reasoning.includes('Timeout') || sp.reasoning.includes('FAILED') ? 'discovered' : 'classified',
        classification_raw: { sponsorship: sp, topic: tp, classifiedAt: new Date().toISOString(), priorityScore: aiCandidates[i].priority },
        last_updated_at: new Date().toISOString(),
      }).eq('video_id', aiCandidates[i].video.videoId);
    }

    // Update queued videos with default values + priority
    for (const qv of queued) {
      await db.from('youtube_competitor_videos').update({
        workflow_status: 'discovered',
        classification_raw: { priorityScore: qv.priority, queuedAt: new Date().toISOString() },
      }).eq('video_id', qv.video.videoId);
    }
  }

  // ═══ Phase 4: Deep analysis only for high-confidence ═══
  if (!options?.skipComments) {
    scanState.phase = 'deep_analysis';
    const highConfVids = aiCandidates.filter((_, i) => {
      if (!sponsorship[i]) return false;
      const s = (sponsorship as any)[i] || sponsorship[i];
      return s && (s.placementType === 'confirmed_paid_placement' || s.placementType === 'likely_sponsored');
    }).filter(c => c.video.commentCount >= 10);

    for (const c of highConfVids.slice(0, 10)) {
      if (await hasExistingComments(c.video.videoId)) continue;
      trackGeneral(1);
      const comments = await fetchVideoComments(c.video.videoId, 30, 'relevance');
      if (comments.length > 0) {
        await saveComments(c.video.videoId, comments);
        const aiIdx = aiCandidates.indexOf(c);
        if (aiIdx >= 0 && sponsorship[aiIdx]) {
          await classifyAndUpdateComments(c.video.videoId, comments.map(cm => ({ commentId: cm.commentId, text: cm.text })), sponsorship[aiIdx].detectedBrand || 'GearUP');
        }
      }
    }
  }

  // ═══ Phase 5: Snapshots ═══
  for (const c of aiCandidates) {
    await saveSnapshot(c.video.videoId, 'discovery',
      Math.round((Date.now() - new Date(c.video.publishedAt).getTime()) / 3600000),
      c.video.viewCount, c.video.likeCount, c.video.commentCount, 0,
      c.priority > 0 ? 0.5 : 0.1, c.video.isShort);
  }

  const timedOut = timeoutCheck(scanState.startedAt).timedOut;
  if (timedOut) scanState.errors.push('Scan reached 10-minute timeout — PARTIAL_COMPLETED');

  scanState.phase = timedOut ? 'partial_completed' : 'completed';
  scanState.done = true;
  scanState.running = false;

  console.log(`[Monitor] Complete: ${allDiscovered.length} discovered, ${scanState.classified} classified, ${scanState.likelyPlacements} likely, ${scanState.queued} queued`);
  return { videosDiscovered: allDiscovered.length, videosClassified: scanState.classified };
}

export async function getMonitorStatus() {
  const db = getSupabase();
  const { count: tv } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: cr } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: lv } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  return {
    totalVideos: tv || 0, totalCreators: (cr || []).length,
    lastRun: (lv as any)?.created_at || null,
    searchQuotaUsed: dailySearchUsed, searchQuotaLimit: 100,
    generalQuotaUsed: dailyGeneralUsed, generalQuotaLimit: 10000,
    hotspotActive: (cfg as any)?.hotspot_active || false,
    scanRunning: scanState.running,
  };
}

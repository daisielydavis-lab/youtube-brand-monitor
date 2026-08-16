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
import { searchVideosPaged, searchBackfillTimeSliced, getChannelsRecentVideos, getChannelsByIds, fetchStatsBatch, getStatsBatchQuotaUsed, type YouTubeVideoResult } from './youtube-discovery';
import { upsertWatchlistCreator, scanWatchlistUploads } from './creator-watchlist';
import { fetchVideoComments, hasExistingComments, saveComments } from './video-enrichment';
import { getOrCreateCreatorProfile } from './creator-profiler';
import { saveSnapshot } from './performance-snapshot';
import { chatJSON } from '../ai/deepseek-client';
import { batchClassify as ruleClassify, detectLanguage, type RuleClassification } from './rule-classifier';
import { evaluateIndustryGate } from './industry-gate';

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
// 配额保护（用户 2026-08-16）：Search 独立池 100/天，日常 ≤70，留 30 buffer
// 给 Hotspot/异常补扫/分页/调试。超过即熔断，绝不跑到 100。
const SEARCH_DAILY_BUDGET = 70;

function trackSearch(n = 1) { dailySearchUsed += n; scanState.searchQuotaUsed = dailySearchUsed; }
function trackGeneral(n: number) { dailyGeneralUsed += n; scanState.generalQuotaUsed = dailyGeneralUsed; }

/** Performance stage by published age: T+0 (<=3d, will get T+3 refresh),
 *  T+3 (4-7d, current stats = T+3 snapshot, will get T+7 refresh),
 *  mature (>7d, stats already mature, no refresh needed). */
export function performanceStageFor(publishedAt: string): 't0' | 't3' | 'mature' {
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
  if (ageDays <= 3) return 't0';
  if (ageDays <= 7) return 't3';
  return 'mature';
}

function resetState(mode: string) {
  searchCircuitOpen = false;
  scanState = { running: true, mode, phase: 'discovery', status: 'running', searchQueriesTotal: 0, searchQueriesSucceeded: 0, searchQueriesFailed: 0, creatorChannelsChecked: 0, discoveredFromSearch: 0, discoveredFromCreators: 0, discoveredCount: 0, persistedCount: 0, selectedForAI: 0, classified: 0, likelyPlacements: 0, queued: 0, failed: 0, searchQuotaUsed: dailySearchUsed, generalQuotaUsed: dailyGeneralUsed, errorCode: '', errors: [], startedAt: new Date().toISOString(), done: false };
}

// ── Priority scoring (rule-based, no LLM) ──
function scorePriority(v: YouTubeVideoResult, knownIds: Set<string>, hotspotGames: string[]): number {
  // Stage ① industry gate: non-gaming content (food/beauty/finance/...) is
  // never a placement — drop it to the bottom of the queue so AI quota is
  // not wasted on affiliate-link spam.
  const gate = evaluateIndustryGate({ title: v.title, description: v.description, channelName: v.channelTitle, tags: v.tags });
  if (!gate.passed && gate.category !== 'gaming') return -100;
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
  videos: Array<{ videoId: string; title: string; description: string; channelName: string; channelId: string; publishedAt: string; tags: string[]; hasPaidPlacementTag: boolean }>,
): Promise<{ classified: number; likely: number; errors: string[] }> {
  let classified = 0, likely = 0;
  const errors: string[] = [];

  for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
    const batch = videos.slice(i, i + AI_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_BATCH_SIZE) + 1;

    const items = batch.map(v => ({
      videoId: v.videoId, title: v.title, descSnippet: v.description.slice(0, 300),
      description: v.description, // full text for server-side industry gate verification (not sent to AI)
      channelName: v.channelName, channelId: v.channelId, publishedAt: v.publishedAt, hasPaidTag: v.hasPaidPlacementTag,
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

INDUSTRY GATE (MANDATORY — non-gaming content can NEVER be a game booster placement):
Game boosters (GearUP/ExitLag/LagZapper) are ONLY advertised in gaming / esports / game-hardware / game-network content.
- If the video title, channel, or content is clearly NOT gaming (e.g. food cooking/eating, mukbang, beauty, fashion, finance/trading, lifestyle/vlog, music, news, pranks, random shorts), classify it "irrelevant" with brand=null — EVEN IF its description contains a brand affiliate link, promo code, or "sponsored by" text. Affiliate links in irrelevant niches are spam, not placements.
- Only classify "confirmed"/"likely" when the content is gaming-related AND brand evidence exists (title mentions brand, promo code + brand link in a gaming video, paid tag, etc.).
- When in doubt between "likely" and "organic" for gaming content, prefer the more conservative option.

Videos: ${JSON.stringify(items.map(({ description, ...aiItem }) => aiItem))}`;

    const result = await chatJSON<{ videos: any[] }>(
      [{ role: 'user', content: prompt }],
      { mode: 'fast', maxTokens: 4096 },
    );

    if (result.success && result.data?.videos?.length) {
      for (const item of result.data.videos) {
        const vid = batch.find(v => v.videoId === item.videoId);
        if (!vid) continue;
        const m: Record<string, string> = { confirmed: 'confirmed_paid_placement', likely: 'likely_sponsored', organic: 'organic_mention', official: 'official_brand_video', irrelevant: 'unknown' };
        let pt = m[item.placementType] || 'unknown';

        // ── Industry gate verification (Stage ①) — NEVER trust AI on this ──
        // AI can't see the full context and has proven to call food videos
        // "likely_sponsored" off a stray affiliate link. Hard-block non-gaming.
        const gate = evaluateIndustryGate({
          title: vid.title, description: vid.description,
          channelName: vid.channelName, tags: vid.tags,
        });
        const industryBlocked = !gate.passed && gate.category !== 'gaming';
        let aiBrand = item.brand || null;
        if (industryBlocked) {
          if (pt === 'confirmed_paid_placement' && !vid.hasPaidPlacementTag) pt = 'organic_mention';
          else if (pt === 'confirmed_paid_placement' && vid.hasPaidPlacementTag) { /* keep — explicit disclosure */ }
          else pt = 'organic_mention';
          aiBrand = null;
        }
        const finalBrand = aiBrand;
        if (pt === 'confirmed_paid_placement' || pt === 'likely_sponsored') likely++;

        // AI 写回必须补 market/language（2026-08-16 坑 #20）：此前 AI update
        // 不写顶层 market，且 classification_raw 整体覆盖丢掉 rule.market ——
        // normal scan Phase 5 的 aiQueue 视频不经过 rule 写回，顶层 market
        // 永久 NULL（1124 条）。用与规则层同口径的语言检测兜底。
        const { market: aiMarket, language: aiLanguage } = detectLanguage(vid.title, vid.description);

        await getSupabase().from('youtube_competitor_videos').update({
          placement_type: pt, sponsor_confidence: (item.confidence || 50) / 100,
          game_name: industryBlocked ? null : (item.game || null),
          topic_category: industryBlocked ? 'game_integration' : (item.theme || 'game_integration'),
          content_type: item.format || 'integrated_placement',
          market: aiMarket, language: aiLanguage,
          workflow_status: 'classified',
          classification_raw: {
            ai: industryBlocked ? { ...item, brand: null, placementType: 'organic_mention' } : item,
            industryGate: { blocked: industryBlocked, category: gate.category, blockedBy: gate.blockedBy, gamingSignals: gate.gamingSignals, nonGamingSignals: gate.nonGamingSignals },
            batchNum, classifiedAt: new Date().toISOString(),
          },
          last_updated_at: new Date().toISOString(),
        }).eq('video_id', item.videoId);
        // 用户 P0-2：AI 确认投放（confirmed/likely + 品牌）→ Creator 自动进品牌 Watchlist，
        // 以后靠 uploads playlist 监控该频道（不依赖标题再出现品牌词）
        if ((pt === 'confirmed_paid_placement' || pt === 'likely_sponsored') && finalBrand && vid.channelId) {
          upsertWatchlistCreator(finalBrand, vid.channelId, vid.channelName, aiMarket, 'ai_confirmed').catch(() => {});
        }
        classified++;
      }
      scanState.classified = classified;
      scanState.likelyPlacements = likely;
    } else {
      const err = `Batch ${batchNum}: ${result.error}`;
      errors.push(err);
      console.error(`[AI] ${err}`, result.diagnostic.contentPreview?.slice(0, 200));
      for (const v of batch) {
        // Stage ②: stay in the AI queue (classified + needsAI) — do NOT
        // reset to discovered. Resetting caused a deadlock: every run fetched
        // the same videos, AI failed, they went back to discovered, forever.
        // NOTE: DB CHECK constraint forbids 'rule_classified' — 'classified'
        // is the only valid "processed" state; the queue is driven by the
        // classification_raw.rule.needsAI flag, not workflow_status.
        await getSupabase().from('youtube_competitor_videos').update({
          workflow_status: 'classified',
          classification_raw: { rule: { needsAI: true }, aiError: result.error, queuedAt: new Date().toISOString() },
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
  backfillDays?: number; mode?: 'normal' | 'hotspot' | 'manual' | 'backfill'; hotspotGame?: string;
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

  // Phase 1: Search (with circuit breaker) — 2026-08-16 重构：分页 + 时间闭合
  // 原则：Search 只负责发现新博主（用户 P0-1），单 query 翻 ≤2 页（100 条），
  // Search 预算 ≤70/天。backfill 模式走动态时间分片（searchBackfillTimeSliced）。
  let searchFrom = 0;
  const queries = mode === 'hotspot' && options?.hotspotGame ? buildHotspotQueries(options.hotspotGame) : getActiveQueries();
  scanState.searchQueriesTotal = queries.length;

  if (mode === 'backfill') {
    // 90 天历史回填：每个 query 按 7 天窗口切片 → 满页拆半 → 翻页拉全
    const backfillDays = options?.backfillDays || 90;
    const backfillStart = new Date(Date.now() - backfillDays * 86400000).toISOString();
    const backfillEnd = new Date().toISOString();
    console.log(`[Monitor] Backfill mode — ${backfillDays}d since ${backfillStart.slice(0,10)}, ${queries.length} queries (Search budget ≤ ${Math.max(0, SEARCH_DAILY_BUDGET - dailySearchUsed)})`);
    for (const q of queries) {
      if (searchCircuitOpen) { scanState.searchQueriesFailed++; continue; }
      try {
        const budgetLeft = Math.max(0, SEARCH_DAILY_BUDGET - dailySearchUsed);
        const res = await searchBackfillTimeSliced(q, backfillStart, backfillEnd, {
          initialWindowDays: 7, minWindowDays: 1, maxPages: 3,
          quotaBudget: budgetLeft,
          onSearchCall: () => { if (dailySearchUsed >= SEARCH_DAILY_BUDGET) searchCircuitOpen = true; trackSearch(); },
        });
        scanState.searchQueriesSucceeded++;
        for (const r of res.videos) { if (!seen.has(r.videoId)) { seen.add(r.videoId); allVids.push(r); searchFrom++; } }
        console.log(`[Monitor] backfill "${q.queryText}" → ${res.videos.length} videos in ${res.searchCalls} search calls`);
        await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
      } catch (err) {
        scanState.searchQueriesFailed++;
        if ((err as Error).message.startsWith('YT_QUOTA_EXHAUSTED')) { searchCircuitOpen = true; scanState.errorCode = 'SEARCH_QUOTA_EXHAUSTED'; }
      }
    }
  } else {
    for (const q of queries) {
      if (searchCircuitOpen) { scanState.searchQueriesFailed++; continue; }
      try {
        const res = await searchVideosPaged(q, publishedAfter, undefined, 2, 50);
        trackSearch(res.pagesUsed);
        scanState.searchQueriesSucceeded++;
        for (const r of res.videos) { if (!seen.has(r.videoId)) { seen.add(r.videoId); allVids.push(r); searchFrom++; } }
        await db.from('competitor_queries').upsert({ query_text: q.queryText, last_run_at: new Date().toISOString() }, { onConflict: 'query_text' });
      } catch (err) {
        scanState.searchQueriesFailed++;
        if ((err as Error).message.startsWith('YT_QUOTA_EXHAUSTED')) { searchCircuitOpen = true; scanState.errorCode = 'SEARCH_QUOTA_EXHAUSTED'; }
      }
    }
  }
  scanState.discoveredFromSearch = searchFrom;

  // Phase 2: Creator Watchlist uploads 扫描（用户 P0-3，2026-08-16）
  // Playlist 负责监控已知博主：playlistItems.list 1 unit/页（General 池），
  // 不占 Search 池。Watchlist 优先，creator_profiles 补充（兼容历史数据）。
  let creatorFrom = 0;
  let creatorFromWatchlist = 0;
  let creatorFromProfiles = 0;
  const wlScan = await scanWatchlistUploads(undefined, publishedAfter, 3);
  trackGeneral(wlScan.playlistCalls + wlScan.channelCalls + Math.ceil(wlScan.videos.length / 50));
  scanState.creatorChannelsChecked = wlScan.channelsChecked;
  for (const v of wlScan.videos) {
    if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod = 'channel_scan'; allVids.push(v); creatorFrom++; creatorFromWatchlist++; }
  }

  // 补充：creator_profiles（历史积累的所有博主）——playlist 扫描复用同一入口
  const { data: creators } = await db.from('youtube_creator_profiles').select('channel_id').limit(200);
  if (creators?.length) {
    const ids = creators.map((c: any) => c.channel_id);
    const profVids = await getChannelsRecentVideos(ids, publishedAfter, 5);
    trackGeneral(Math.ceil(ids.length / 50) + ids.length + Math.ceil(profVids.length / 50));
    for (const v of profVids) {
      if (!seen.has(v.videoId)) { seen.add(v.videoId); (v as any).discoveryMethod = 'channel_scan'; allVids.push(v); creatorFrom++; creatorFromProfiles++; }
    }
  }
  scanState.discoveredFromCreators = creatorFrom;
  console.log(`[Monitor] Channel scan: watchlist=${creatorFromWatchlist} profiles=${creatorFromProfiles} (${wlScan.channelsChecked} channels, ${wlScan.playlistCalls} playlist calls)`);
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
        performance_stage: performanceStageFor(v.publishedAt),
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
      placement_type: r.placementType !== 'unknown' ? r.placementType : 'unknown',
      sponsor_confidence: r.brandConfidence,
      game_name: r.game || null,
      topic_category: r.topicCategory,
      content_type: r.contentCategory,
      language: r.language,
      market: r.market,
      // 'rule_classified' is rejected by the DB CHECK constraint — use
      // 'classified' (Layer 2 rule pass counts as classified; the needsAI
      // flag in classification_raw drives the AI queue, not workflow_status).
      workflow_status: 'classified',
      classification_raw: {
        rule: {
          brand: r.brand, brandConfidence: r.brandConfidence, brandEvidence: r.brandEvidence,
          game: r.game, gameConfidence: r.gameConfidence,
          placementType: r.placementType, sponsorSignals: r.sponsorSignals,
          contentCategory: r.contentCategory, topicCategory: r.topicCategory,
          language: r.language, market: r.market,
          needsAI: false,
        },
        classifiedAt: new Date().toISOString(),
      },
      last_updated_at: new Date().toISOString(),
    }).eq('video_id', r.videoId);
    ruleClassified++;
  }
  console.log(`[Monitor] Rule classified: ${ruleClassified} videos (${Math.round(ruleClassified/actualCount*100)}%)`);

  // ── Phase 5: AI Queue (Layer 3) — only videos rules couldn't classify ──
  // Stage ②: NO cap — the full queue is processed this scan, batched 10 at a
  // time inside batchClassifyVideos, until completion. If the scan is
  // interrupted, leftovers keep the needsAI flag and the backlog cron drains them.
  const aiCandidates = aiQueue.filter(r => r.needsAI).sort((a, b) => b.aiPriority - a.aiPriority);
  const aiBatch = options?.skipAI ? [] : aiCandidates;
  const aiDeferred: RuleClassification[] = [];

  scanState.selectedForAI = aiBatch.length;
  scanState.queued = 0;
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
        channelName: orig?.video.channelTitle || '', channelId: orig?.video.channelId || '',
        publishedAt: orig?.video.publishedAt || '',
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
      workflow_status: 'classified',
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

// ── Retry classification (Rules-first, then AI for the FULL queue — batched until empty) ──
// Stage ②: the queue is drained in 200-video rounds; AI runs inside
// batchClassifyVideos at 10/batch. limit=0 (default) drains everything.
// Interrupted runs resume naturally: processed items lose the needsAI flag,
// unprocessed ones keep it.
export async function retryClassification(limit: number = 0): Promise<{ classified: number; remaining: number }> {
  const db = getSupabase();
  resetState('retry');

  // Queue = discovered (never processed) + classified flagged needsAI.
  // Two queries — PostgREST's or() can't nest jsonb paths (42703), so merge here.
  const fetchQueued = async (take: number): Promise<any[]> => {
    const [r1, r2] = await Promise.all([
      db.from('youtube_competitor_videos').select('*')
        .eq('workflow_status', 'discovered')
        .order('first_seen_at', { ascending: false })
        .limit(take),
      db.from('youtube_competitor_videos').select('*')
        .eq('workflow_status', 'classified')
        .filter('classification_raw->rule->>needsAI', 'eq', 'true')
        .order('first_seen_at', { ascending: false })
        .limit(take),
    ]);
    // Deduplicate (a video can't be both, but be safe) and prefer discovered (older backlog first)
    const seen = new Set<string>();
    return [...(r1.data || []), ...(r2.data || [])].filter(v => { if (seen.has(v.video_id)) return false; seen.add(v.video_id); return true; });
  };
  const countQueued = async () => {
    const [c1, c2] = await Promise.all([
      db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).eq('workflow_status', 'discovered'),
      db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).eq('workflow_status', 'classified').filter('classification_raw->rule->>needsAI', 'eq', 'true'),
    ]);
    return (c1.count ?? 0) + (c2.count ?? 0);
  };

  let totalClassified = 0;
  let rounds = 0;

  for (;;) {
    const pending = await fetchQueued(200);
    if (!pending.length) break;
    rounds++;
    const take = limit > 0 ? Math.max(1, Math.min(limit - totalClassified, 200)) : 200;
    const batch = (pending as any[]).slice(0, take);

    scanState.discoveredCount = batch.length;

    // Step 1: Run rule classifier first
    const { classified: ruleDone, aiQueue } = ruleClassify(batch.map(v => ({
      videoId: v.video_id, title: v.title, description: v.description || '',
      tags: v.tags || [], channelName: v.channel_name || '', isShort: v.is_short || false,
      viewCount: v.view_count || 0, publishedAt: v.published_at || '', hasPaidPlacementTag: v.has_paid_placement_tag || false,
    })));

    // Update DB with rule classifications — INCLUDING needsAI videos. Writing
    // them out with workflow_status=classified + needsAI=true moves them
    // out of the discovered pool (no deadlock at the queue head) and into the
    // needsAI pool where the AI step below (or a later run) picks them up.
    // ('rule_classified' is rejected by the DB CHECK constraint.)
    const ruleResults = ruleDone.concat(aiQueue);
    for (const r of ruleResults) {
      await db.from('youtube_competitor_videos').update({
        placement_type: r.placementType !== 'unknown' ? r.placementType : 'unknown',
        sponsor_confidence: r.brandConfidence,
        game_name: r.game || null, topic_category: r.topicCategory,
        content_type: r.contentCategory, language: r.language, market: r.market,
        workflow_status: 'classified',
        classification_raw: { rule: { brand: r.brand, game: r.game, placementType: r.placementType, needsAI: r.needsAI, aiPriority: r.aiPriority, aiReason: r.aiReason }, classifiedAt: new Date().toISOString() },
        last_updated_at: new Date().toISOString(),
      }).eq('video_id', r.videoId);
    }

    // Step 2: AI for the whole round's queue (batchClassifyVideos batches at 10 internally)
    const result = aiQueue.length > 0
      ? await batchClassifyVideos(aiQueue.map(r => {
          const orig = batch.find((v: any) => v.video_id === r.videoId);
          return { videoId: r.videoId, title: orig?.title || '', description: orig?.description || '', channelName: orig?.channel_name || '', channelId: orig?.channel_id || '', publishedAt: orig?.published_at || '', tags: orig?.tags || [], hasPaidPlacementTag: orig?.has_paid_placement_tag || false };
        }))
      : { classified: 0, likely: 0, errors: [] as string[] };

    totalClassified += ruleDone.length + result.classified;
    scanState.classified = ruleDone.length + result.classified;
    scanState.likelyPlacements = ruleDone.filter(r => r.placementType === 'confirmed_paid_placement' || r.placementType === 'likely_sponsored').length + result.likely;
    console.log(`[Retry] Round ${rounds}: rule=${ruleDone.length} ai=${result.classified} cumulative=${totalClassified}`);

    if (limit > 0 && totalClassified >= limit) break;
    if (batch.length < 200) break; // queue drained
  }

  const remaining = await countQueued();
  scanState.done = true; scanState.running = false; scanState.phase = 'completed';
  console.log(`[Retry] Done: ${totalClassified} classified in ${rounds} round(s), ${remaining} remaining in queue`);
  return { classified: totalClassified, remaining };
}


// ── Performance Refresh Queue（T+3 / T+7）──
// 独立于 AI Review：只刷新已入库 video_id 的公开统计，不重新 search、不调 AI。
// T+3: stage=t0 且发布时间<=3天前 → 存 views_t3/likes_t3/comments_t3, stage→t3
// T+7: stage=t3 且发布时间<=7天前 → 存 views_t7/likes_t7/comments_t7, stage→mature
export async function refreshPerformanceData(limit = 300): Promise<{ t3Refreshed: number; t7Refreshed: number }> {
  const db = getSupabase();
  let t3Refreshed = 0, t7Refreshed = 0;
  const now = Date.now();
  const t3Cutoff = new Date(now - 3 * 86400000).toISOString();
  const t7Cutoff = new Date(now - 7 * 86400000).toISOString();

  const { data: t3vids } = await db.from('youtube_competitor_videos')
    .select('video_id').eq('performance_stage', 't0').lte('published_at', t3Cutoff).limit(limit);
  if (t3vids?.length) {
    const stats = await fetchStatsBatch(t3vids.map((v: any) => v.video_id));
    for (const v of t3vids) {
      const s = stats[(v as any).video_id];
      if (!s) continue;
      const { error } = await db.from('youtube_competitor_videos').update({
        views_t3: s.viewCount, likes_t3: s.likeCount, comments_t3: s.commentCount,
        performance_stage: 't3', performance_updated_at: new Date().toISOString(),
      }).eq('video_id', (v as any).video_id);
      if (!error) t3Refreshed++;
    }
  }

  const { data: t7vids } = await db.from('youtube_competitor_videos')
    .select('video_id').eq('performance_stage', 't3').lte('published_at', t7Cutoff).limit(limit);
  if (t7vids?.length) {
    const stats = await fetchStatsBatch(t7vids.map((v: any) => v.video_id));
    for (const v of t7vids) {
      const s = stats[(v as any).video_id];
      if (!s) continue;
      const { error } = await db.from('youtube_competitor_videos').update({
        views_t7: s.viewCount, likes_t7: s.likeCount, comments_t7: s.commentCount,
        performance_stage: 'mature', performance_updated_at: new Date().toISOString(),
      }).eq('video_id', (v as any).video_id);
      if (!error) t7Refreshed++;
    }
  }

  console.log(`[PerfRefresh] t3=${t3Refreshed} t7=${t7Refreshed}`);
  return { t3Refreshed, t7Refreshed };
}
export async function getMonitorStatus() {
  const db = getSupabase();
  const { count: tv } = await db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true });
  const { data: cr } = await db.from('youtube_creator_profiles').select('channel_id');
  const { data: lv } = await db.from('youtube_competitor_videos').select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: cfg } = await db.from('monitor_config').select('*').eq('id', 1).maybeSingle();
  const now = Date.now();
  const t3Cut = new Date(now - 3 * 86400000).toISOString();
  const t7Cut = new Date(now - 7 * 86400000).toISOString();
  const [cT3, cT7] = await Promise.all([
    db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).eq('performance_stage', 't0').lte('published_at', t3Cut),
    db.from('youtube_competitor_videos').select('id', { count: 'exact', head: true }).eq('performance_stage', 't3').lte('published_at', t7Cut),
  ]);
  return { totalVideos: tv || 0, totalCreators: (cr || []).length, lastRun: (lv as any)?.created_at || null,
    searchQuotaUsed: dailySearchUsed, searchQuotaLimit: 100,
    generalQuotaUsed: dailyGeneralUsed, generalQuotaLimit: 10000,
    statsQuotaUsed: getStatsBatchQuotaUsed(), statsQuotaLimit: 10000,
    perfT3Pending: cT3.count ?? 0, perfT7Pending: cT7.count ?? 0,
    hotspotActive: (cfg as any)?.hotspot_active || false, scanRunning: scanState.running };
}

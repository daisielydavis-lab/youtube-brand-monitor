/**
 * Data Scope Filters — 3-layer data model for consistent analytics.
 *
 * Layer 1: Discovery Pool    — all videos fetched by YouTube API
 * Layer 2: Classified         — videos analyzed by rule/AI (workflow_status classified)
 * Layer 3: Competitor Placements — brand ∈ valid brands AND placement ∈ {confirmed, likely}
 *
 * ALL dashboard analytics (Overview, Breakdown, Top Games, Content Angles,
 * Creators, Comments, Campaigns) MUST use Layer 3 as default scope.
 */

import { canonicalBrand } from './brand-normalization';

/** Brands we actively monitor — the ONLY valid competitor targets */
export const COMPETITOR_BRANDS = ['ExitLag', 'GearUP', 'LagZapper', 'Lagofast'] as const;
export type CompetitorBrand = typeof COMPETITOR_BRANDS[number];

/** Placement types that indicate an actual competitor sponsorship */
const PLACEMENT_TYPES = ['confirmed_paid_placement', 'likely_sponsored'] as const;

// ── Brand resolution chain: ai → final → rule → unknown ──
// AI verification result takes precedence over the rule layer — a rule
// guessed "ExitLag" off a "!exitlag" Twitch chat command, AI then says
// organic; the AI verdict wins (it saw the full context).
// Industry gate (Stage ①): blocked videos resolve to 'unknown' regardless of
// what rule/AI guessed — a food video with an affiliate link is NOT a placement.
export function resolveBrand(v: any): string {
  if (v?.classification_raw?.industryGate?.blocked) return 'unknown';
  // P0-1: 优先读 canonical_brand 列(backfill 已落库),统计走 SQL 列。
  if (v?.canonical_brand) return v.canonical_brand;
  // 兜底:未回填的旧行,从 raw 链取原始值动态归一(兼容变体)。
  return canonicalBrand(
    v?.classification_raw?.ai?.brand
      || v?.classification_raw?.final?.brand
      || v?.classification_raw?.rule?.brand
      || null,
  ) || 'unknown';
}

export function resolveGame(v: any): string {
  return v?.game_name
    || v?.classification_raw?.final?.game
    || v?.classification_raw?.rule?.game
    || v?.classification_raw?.ai?.game
    || 'unknown';
}

export function resolveMarket(v: any): string {
  return v?.classification_raw?.rule?.market
    || v?.classification_raw?.ai?.market
    || v?.market
    || 'Unknown';
}

// ── Layer 3 filter ──

/**
 * Stage ④ gate: a rule-flagged placement is a CANDIDATE, not a Layer 3
 * placement. It enters Layer 3 only after AI verification (classification_raw.ai
 * written) OR when YouTube's official paid-placement tag is present (paid tag
 * is platform-level evidence — no AI needed). Rule-layer verdicts alone
 * ("!exitlag" chat commands, brand-in-title) never reach Layer 3.
 */
export function isAIVerified(v: any): boolean {
  return !!v?.classification_raw?.ai || !!v?.has_paid_placement_tag;
}

/** Is this video queued for AI verification (rule says maybe, AI hasn't ruled)? */
/**
 * Market filter matching — supports pipe-separated multi-market values
 * and the special '__none__' code (video with no market tag).
 */
export function marketMatches(v: { market?: string | null }, marketFilter?: string | null): boolean {
  if (!marketFilter || marketFilter === 'all') return true;
  if (marketFilter === '__none__') return !v.market;
  return (v.market || '').split('|').map(s => s.trim()).indexOf(marketFilter) !== -1;
}

export function needsAIVerification(v: any): boolean {
  return !!v?.classification_raw?.rule?.needsAI && !v?.classification_raw?.ai;
}

/** Is this video a confirmed competitor placement (Layer 3)? */
export function isCompetitorPlacement(v: any): boolean {
  const brand = resolveBrand(v);
  if (!COMPETITOR_BRANDS.includes(brand as CompetitorBrand)) return false;
  if (!PLACEMENT_TYPES.includes(v?.placement_type)) return false;
  return isAIVerified(v) && !needsAIVerification(v);
}

/** Is this video a likely/confirmed placement but brand is unknown? (Unresolved) */
export function isUnresolvedCandidate(v: any): boolean {
  const brand = resolveBrand(v);
  if (COMPETITOR_BRANDS.includes(brand as CompetitorBrand)) return false;
  if (!PLACEMENT_TYPES.includes(v?.placement_type)) return false;
  return isAIVerified(v) && !needsAIVerification(v);
}

/** Is this video a "classified" candidate? (Layer 2 — has been analyzed) */
export function isClassified(v: any): boolean {
  return v?.workflow_status === 'rule_classified' || v?.workflow_status === 'classified';
}

/**
 * Filter videos to Layer 3 — only competitor placements.
 * Use this for ALL dashboard analytics queries.
 */
export function filterCompetitorPlacements(videos: any[]): any[] {
  return videos.filter(isCompetitorPlacement);
}

export function filterUnresolvedCandidates(videos: any[]): any[] {
  return videos.filter(isUnresolvedCandidate);
}

// ── Confidence bucket (低置信度视图, 2026-08-24) ──
// brand_confidence 列 = 品牌证据强度 (AI confidence/100 或域名规则 0.85), 直接编码证据可信度。
// 高 = 强信号 (cid/ref/promo_code → 0.9+, AI 高置信); 中 = 域名规则命中 (0.7-0.9);
// 低 = 弱信号 / 未验证 (<0.7 或 null)。Lagofast 新品牌 52 条全是 0.7-0.9 (规则命中) → 「高」= 0,
// 切「中」才看得到全部 —— 防止新品牌数据膨胀。
export type ConfidenceBucket = 'high' | 'medium' | 'low';

export function placementConfidence(v: any): ConfidenceBucket {
  const c = v?.brand_confidence ?? v?.sponsor_confidence ?? null;
  if (c == null) return 'low';
  if (c >= 0.9) return 'high';
  if (c >= 0.7) return 'medium';
  return 'low';
}

/** 置信度过滤 (conf='all'|undefined 不过滤)。应用于所有 dashboard 分析层。 */
export function matchesConfidence(v: any, conf?: string | null): boolean {
  if (!conf || conf === 'all') return true;
  return placementConfidence(v) === conf;
}

// ── Public performance score (no proprietary metrics) ──
export function computeScore(v: any): number {
  const views = v?.view_count || 0;
  const likes = v?.like_count || 0;
  const comments = v?.comment_count || 0;
  const viewsScore = Math.min(views / 1000, 50);
  const engagementScore = Math.min((likes + comments * 2) / 100, 50);
  return Math.round(viewsScore + engagementScore);
}

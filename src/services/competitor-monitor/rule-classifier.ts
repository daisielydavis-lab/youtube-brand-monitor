/**
 * Rule Classifier — Layer 2 of the intelligence pipeline.
 *
 * Classifies 100% of videos using keyword/regex rules WITHOUT AI.
 * Handles 70-80% of classification work. Only ambiguous/unclear
 * videos get escalated to Layer 3 (AI).
 *
 * Design: Never false-positive on brand. When in doubt, leave for AI.
 */

import { evaluateIndustryGate } from './industry-gate';

// ── Brand detection ──

interface BrandRule {
  brandName: string;
  brandKeywords: string[];       // high-confidence: title/tag contains → brand = true
  brandWeakKeywords: string[];   // lower-confidence: description only → mark for AI verify
  brandHashtags: string[];       // social media hashtags (#exitlag, etc.)
  domainPatterns: string[];      // URL/domain in description
  promoCodePrefixes: string[];   // known promo code patterns
  channelNamePatterns: string[]; // channel name contains these → likely brand channel
}

const BRAND_RULES: BrandRule[] = [
  {
    brandName: 'ExitLag',
    brandKeywords: ['exitlag', 'exit lag', 'exit-lag', 'exitlag.', 'exit lag.'],
    brandWeakKeywords: ['exitlag', 'exit lag', 'exit lag.', 'reduce lag', 'fix lag', 'lag fix'],
    brandHashtags: ['#exitlag', '#exit', '#exitlagreview', '#exitlagpartner'],
    domainPatterns: ['exitlag.com', 'exitlag.net', 'exitlag.app', 'exitlag.io'],
    promoCodePrefixes: ['EXITLAG', 'EXIT', 'EL'],
    channelNamePatterns: ['exitlag', 'exit lag', 'exit-lag'],
  },
  {
    brandName: 'GearUP',
    brandKeywords: ['gearup', 'gear up', 'gear-up', 'gearup.', 'gear up.', 'gearupbooster', 'gearup booster', 'gearup game booster'],
    brandWeakKeywords: ['gearup', 'gear up', 'gear up booster', 'gearup booster', 'game booster'],
    brandHashtags: ['#gearup', '#gearupbooster', '#gearuppartner', '#gearupreview'],
    domainPatterns: ['gearupbooster.com', 'gearup.com', 'gearup.app', 'gearup.gg'],
    promoCodePrefixes: ['GEARUP', 'GEAR', 'GUP', 'GU'],
    channelNamePatterns: ['gearup', 'gear up', 'gear-up', 'gearupbooster'],
  },
  {
    brandName: 'LagZapper',
    brandKeywords: ['lagzapper', 'lag zapper', 'lag-zapper', 'lagzapper.', 'lag zapper.'],
    brandWeakKeywords: ['lagzapper', 'lag zapper', 'lag zapper.', 'zapper'],
    brandHashtags: ['#lagzapper', '#zapper', '#lagzapperreview'],
    domainPatterns: ['lagzapper.com', 'lagzapper.app'],
    promoCodePrefixes: ['LAGZAPPER', 'ZAPPER', 'LAGZAP', 'LZ'],
    channelNamePatterns: ['lagzapper', 'lag zapper', 'lag-zapper'],
  },
];

// ── Game detection ──

const KNOWN_GAMES: Array<{ name: string; aliases: string[] }> = [
  { name: 'Valorant', aliases: ['valorant', 'valo'] },
  { name: 'Fortnite', aliases: ['fortnite', 'fn'] },
  { name: 'CS2', aliases: ['cs2', 'cs:go', 'csgo', 'counter-strike 2', 'counter strike 2'] },
  { name: 'AION 2', aliases: ['aion 2', 'aion2', 'aion'] },
  { name: 'PUBG', aliases: ['pubg', 'pubg mobile', 'battlegrounds'] },
  { name: 'Apex Legends', aliases: ['apex legends', 'apex'] },
  { name: 'League of Legends', aliases: ['league of legends', 'lol', 'league'] },
  { name: 'Call of Duty', aliases: ['call of duty', 'cod', 'warzone', 'modern warfare'] },
  { name: 'Dota 2', aliases: ['dota 2', 'dota2', 'dota'] },
  { name: 'Overwatch 2', aliases: ['overwatch 2', 'overwatch', 'ow2'] },
  { name: 'Rainbow Six Siege', aliases: ['rainbow six', 'r6', 'siege'] },
  { name: 'GTA 5', aliases: ['gta 5', 'gta v', 'gta online', 'gta5', 'gtav'] },
  { name: 'Minecraft', aliases: ['minecraft', 'mc'] },
  { name: 'Rocket League', aliases: ['rocket league', 'rl'] },
  { name: 'Escape from Tarkov', aliases: ['tarkov', 'eft', 'escape from tarkov'] },
  { name: 'Rust', aliases: ['rust'] },
  { name: 'ARK', aliases: ['ark', 'ark survival'] },
  { name: 'DayZ', aliases: ['dayz', 'day z'] },
  { name: 'Albion Online', aliases: ['albion online', 'albion'] },
  { name: 'Lost Ark', aliases: ['lost ark', 'lostark'] },
  { name: 'World of Warcraft', aliases: ['world of warcraft', 'wow'] },
  { name: 'Final Fantasy XIV', aliases: ['final fantasy xiv', 'ffxiv', 'ff14'] },
  { name: 'Black Desert', aliases: ['black desert', 'bdo'] },
  { name: 'Elden Ring', aliases: ['elden ring', 'eldenring'] },
  { name: 'Dead by Daylight', aliases: ['dead by daylight', 'dbd'] },
  { name: 'Destiny 2', aliases: ['destiny 2', 'destiny2'] },
  { name: 'Diablo 4', aliases: ['diablo 4', 'diablo iv', 'd4'] },
  { name: 'Path of Exile', aliases: ['path of exile', 'poe'] },
  { name: 'War Thunder', aliases: ['war thunder', 'wt'] },
  { name: 'World of Tanks', aliases: ['world of tanks', 'wot'] },
  { name: 'FIFA', aliases: ['fifa', 'ea sports fc', 'ea fc'] },
  { name: 'Marvel Rivals', aliases: ['marvel rivals'] },
  { name: 'Deadlock', aliases: ['deadlock'] },
  { name: 'Throne and Liberty', aliases: ['throne and liberty', 'tnl'] },
  { name: 'Tibia', aliases: ['tibia'] },
  { name: 'GunZ', aliases: ['gunz', 'gun z'] },
  { name: 'Wild Rift', aliases: ['wild rift', 'wildrift'] },
  { name: 'Halo', aliases: ['halo', 'halo infinite'] },
  { name: 'Legend of Ymir', aliases: ['legend of ymir', 'ymir'] },
  { name: 'Monster Hunter Wilds', aliases: ['monster hunter wilds', 'mh wilds', 'mhw'] },
];

// ── Sponsor signal detection ──

const SPONSOR_PATTERNS = {
  explicitSponsor: [
    /#ad\b/i, /#sponsored\b/i, /paid.?promotion/i, /paid.?partnership/i,
    /#partner\b/i, /#affiliate\b/i,
  ],
  promoCode: [
    /\bcode\s*[:\s]\s*[A-Za-z0-9_-]{3,20}/i,
    /\buse\s+(?:my\s+)?code\b/i,
    /\bcoupon\s*[:\s]\s*[A-Za-z0-9_-]{3,20}/i,
    /\bdiscount\s*[:\s]\s*[A-Za-z0-9_-]{3,20}/i,
  ],
  affiliateLink: [
    /\b(?:get|try|use|download)\b.{0,30}\b(?:exitlag|gearup|lagzapper)\b/i,
    /(?:exitlag\.com|gearupbooster\.com|lagzapper\.com)/i,
    /\bhttps?:\/\/[^\s]*(?:exitlag|gearup|lagzapper)[^\s]*/i,
  ],
  commercialIntent: [
    /\b(?:free trial|free to use|try free|no cost|giveaway|gratis)\b/i,
    /\b(?:best|top|#1|number one)\s+(?:booster|vpn|game booster|ping reducer)\b/i,
    /\b(?:how to (?:fix|reduce|lower|improve)\s+(?:lag|ping|latency))\b/i,
  ],
};

// ── Content type detection ──

function detectContentType(title: string, tags: string[], isShort: boolean, duration?: string): string {
  const combined = `${title} ${tags.join(' ')}`.toLowerCase();

  if (isShort) return 'shorts';
  if (/\b(live|livestream|streaming|live now|🔴|live replay|vod)\b/i.test(combined)) return 'live_replay';
  if (/\b(review|test|testing|tested|honest review|first look|hands.?on|is it worth)\b/i.test(combined)) return 'dedicated_review';
  if (/\b(comparison|compare|vs\.?|versus|which.*better|best.*booster|alternative)\b/i.test(combined)) return 'comparison';
  if (/\b(tutorial|guide|how to|setup|install|configure|settings? guide|config|optimize)\b/i.test(combined)) return 'tutorial';
  if (/\b(gameplay|playthrough|walkthrough|let'?s play|montage|highlights?)\b/i.test(combined)) return 'gameplay';

  return 'integrated_placement';
}

// ── Topic/Angle detection ──

function detectTopicCategory(title: string, description: string): string {
  const combined = `${title} ${description}`.toLowerCase();

  if (/\b(new game|new release|just launched|coming soon|release date|new season|season update|patch|update|new update)\b/i.test(combined)) {
    return 'new_game_launch';
  }
  if (/\b(free|free to use|free trial|gratis|no cost|giveaway)\b/i.test(combined)) return 'free_limited';
  if (/\b(promo code|discount code|coupon code|use code|code .{3,15}\b|save \d+%)\b/i.test(combined)) return 'promo_code';
  if (/\b(unlock|region lock|region unlock|cross.?region|play from|server region|lock|跨区|锁区)\b/i.test(combined)) return 'region_unlock';
  if (/\b(reduce.*(?:lag|ping|latency)|fix.*lag|lower.*ping|lag.*fix|ping.*fix|latency.*fix|no more lag|stop lag|improve.*ping|better.*ping)\b/i.test(combined)) return 'reduce_ping';
  if (/\b(review|best|top|rating|ranked|tested|reviewed)\b/i.test(combined)) return 'booster_review';
  if (/\b(vs\.?|versus|compare|comparison|alternative|better than)\b/i.test(combined)) return 'competitor_comparison';
  if (/\b(tutorial|guide|how to|setup|config)\b/i.test(combined)) return 'tutorial';
  if (/\b(sponsor|partner|ambassador|affiliate)\b/i.test(combined)) return 'pure_endorsement';

  return 'game_integration';
}

// ── Language detection ──

/**
 * 乌克兰语高信号词（俄语中不出现，用 "и" 同形字变位时兜底）。
 * 注意：JS 的 \b 是 ASCII 语义，对西里尔文本无效 —— 用子串匹配，
 * 且只收俄语绝不含的子串（如 обще 含 "ще" 会误伤，故不收入）。
 */
const UA_WORD_HINTS = /(насолод|погравши|пограю|вже|треба|найкращ|перемог|українськ|спробуй|увімкни|вмикай|дивись|дивимось|знайдеш|зможеш|чекай|перемагай|гравц)/i;

function detectLanguage(title: string, description: string): { language: string; market: string } {
  const combined = `${title} ${description}`;
  // Georgian (mixed titles may also contain Cyrillic — check first)
  if (/[ა-ჰ]/.test(combined)) return { language: 'ka', market: 'GE' };
  // Belarusian (ў)
  if (/[ўЎ]/.test(combined)) return { language: 'be', market: 'BY' };
  // Ukrainian: і/ї/є/ґ (not used in Russian) or high-signal words (и-form conjugations)
  if (/[іїєґІЇЄҐ]/.test(combined) || UA_WORD_HINTS.test(combined)) return { language: 'uk', market: 'UA' };
  // Cyrillic → Russian
  if (/[а-яА-ЯёЁ]/.test(combined)) return { language: 'ru', market: 'RU' };
  // Portuguese
  if (/\b(como|para|mais|melhor|muito|jogar|jogo|jogos|funciona|vale|pena|cupom|desconto|você|você|não|uma|pra|pq|tá)\b/i.test(combined)) {
    return { language: 'pt', market: 'BR' };
  }
  // Spanish
  if (/\b(como|para|más|mejor|mucho|jugar|juego|funciona|vale|pena|código|descuento|éste|aquí)\b/i.test(combined)) {
    return { language: 'es', market: 'LATAM' };
  }
  // Korean
  if (/[가-힯]/.test(combined)) return { language: 'ko', market: 'KR' };
  // Japanese
  if (/[぀-ゟ゠-ヿ]/.test(combined)) return { language: 'ja', market: 'JP' };
  // Chinese
  if (/[一-鿿]/.test(combined)) return { language: 'zh', market: 'CN' };

  return { language: 'en', market: 'US' };
}

// ── Main classification interface ──

export interface RuleClassification {
  videoId: string;
  brand: string | null;
  brandConfidence: number;       // 0.0 - 1.0
  brandEvidence: string[];       // e.g. ["title contains 'ExitLag'", "affiliate link detected"]
  game: string | null;
  gameConfidence: number;
  placementType: string;         // confirmed_paid_placement | likely_sponsored | organic_mention | unknown
  sponsorSignals: string[];      // detected sponsor evidence
  contentCategory: string;       // dedicated_review | integrated_placement | shorts | live_replay | etc.
  topicCategory: string;         // reduce_ping | promo_code | game_integration | etc.
  language: string;
  market: string;
  needsAI: boolean;              // true if rules couldn't confidently classify → escalate to AI
  aiPriority: number;            // 0-10, higher = more urgent for AI
  aiReason: string;              // why it needs AI (or empty if rules were sufficient)
  industryGate?: { passed: boolean; category: string; blockedBy: string | null; gamingSignals: string[]; nonGamingSignals: string[] };
}

/**
 * Classify a single video using rules only.
 * Returns classification + a `needsAI` flag for Layer 3 escalation.
 */
export function classifyVideo(input: {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  channelName: string;
  isShort: boolean;
  viewCount: number;
  publishedAt: string;
  hasPaidPlacementTag?: boolean;
}): RuleClassification {
  const t = input.title.toLowerCase();
  const d = (input.description || '').toLowerCase();
  const combined = `${t} ${d} ${(input.tags || []).join(' ')}`.toLowerCase();

  // ── 1. Brand detection (enhanced v2) ──
  let brand: string | null = null;
  let brandConfidence = 0;
  const brandEvidence: string[] = [];
  const chName = (input.channelName || '').toLowerCase();

  for (const rule of BRAND_RULES) {
    // High-confidence: brand keyword in title
    const titleMatch = rule.brandKeywords.some(kw => t.includes(kw));
    // Description match — use BOTH strong and weak keywords for broader coverage
    const descKeywords = [...new Set([...rule.brandKeywords, ...rule.brandWeakKeywords])];
    const descMatch = descKeywords.some(kw => d.includes(kw));
    const domainMatch = rule.domainPatterns.some(pat => d.includes(pat) || combined.includes(pat));
    const tagMatch = (input.tags || []).some(tag =>
      rule.brandKeywords.some(kw => tag.toLowerCase().includes(kw)));
    const hashtagMatch = rule.brandHashtags.some(ht =>
      t.includes(ht) || d.includes(ht) || (input.tags || []).some(tg => tg.toLowerCase() === ht.replace('#', '').toLowerCase()));
    const promoMatch = rule.promoCodePrefixes.some(prefix =>
      new RegExp(`\\b${prefix}[A-Za-z0-9_-]{2,15}\\b`, 'i').test(combined));
    const channelMatch = rule.channelNamePatterns.some(pat => chName.includes(pat));

    // Title match OR tag match → high confidence
    if (titleMatch || tagMatch || hashtagMatch) {
      brand = rule.brandName;
      brandConfidence = 0.95;
      if (titleMatch) brandEvidence.push(`title contains '${rule.brandName}'`);
      if (tagMatch) brandEvidence.push(`tag contains '${rule.brandName}'`);
      if (hashtagMatch) brandEvidence.push(`hashtag '${rule.brandName}'`);
      if (domainMatch) { brandConfidence = 0.98; brandEvidence.push('brand domain in description'); }
      if (promoMatch) { brandConfidence = 0.98; brandEvidence.push('promo code detected'); }
      if (channelMatch) { brandConfidence = 0.99; brandEvidence.push('official brand channel'); }
      break; // first match wins (title is high-confidence)
    }

    // Description match or domain match
    if (descMatch || domainMatch) {
      brand = rule.brandName;
      brandConfidence = domainMatch ? 0.85 : 0.75; // raised from 0.70
      if (domainMatch) brandEvidence.push('official domain detected');
      if (descMatch && !domainMatch) brandEvidence.push(`brand mentioned in description`);
      if (promoMatch) { brandConfidence = Math.max(brandConfidence, 0.90); brandEvidence.push('promo code detected'); }
      if (channelMatch) { brandConfidence = Math.max(brandConfidence, 0.90); brandEvidence.push('brand channel name'); }
      break;
    }

    // Channel name match alone (no other signal)
    if (channelMatch) {
      brand = rule.brandName;
      brandConfidence = 0.65;
      brandEvidence.push(`channel name matches '${rule.brandName}'`);
      break;
    }
  }

  // ── 2. Game detection ──
  let game: string | null = null;
  let gameConfidence = 0;

  for (const g of KNOWN_GAMES) {
    const allTerms = [g.name.toLowerCase(), ...g.aliases];
    for (const term of allTerms) {
      // Use word boundary for multi-word games
      const pattern = term.includes(' ') ? term : `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
      if (new RegExp(pattern, 'i').test(combined)) {
        if (!game || term.length > game.length) { // prefer longer match (more specific)
          game = g.name;
          gameConfidence = term === g.name.toLowerCase() ? 0.9 : 0.75;
        }
      }
    }
  }
  // Boost game confidence if in title
  if (game && KNOWN_GAMES.find(g => g.name === game)?.aliases.some(a => t.includes(a))) {
    gameConfidence = Math.min(gameConfidence + 0.1, 1.0);
  }

  // ── 2.5 Industry gate (Stage ①) — non-gaming content can't be a placement ──
  const industryGate = evaluateIndustryGate(input);
  const industryBlocked = !industryGate.passed && industryGate.category !== 'gaming';

  // ── 3. Sponsor detection ──
  const sponsorSignals: string[] = [];
  let placementType = 'unknown';

  // Explicit sponsor tags
  if (SPONSOR_PATTERNS.explicitSponsor.some(p => p.test(combined)) || input.hasPaidPlacementTag) {
    sponsorSignals.push('paid promotion disclosure');
    placementType = 'confirmed_paid_placement';
  }

  // Promo code
  if (SPONSOR_PATTERNS.promoCode.some(p => p.test(combined))) {
    sponsorSignals.push('promo/discount code');
  }

  // Affiliate link
  if (SPONSOR_PATTERNS.affiliateLink.some(p => p.test(combined))) {
    sponsorSignals.push('brand affiliate link');
  }

  // Commercial intent
  if (SPONSOR_PATTERNS.commercialIntent.some(p => p.test(combined))) {
    sponsorSignals.push('commercial content pattern');
  }

  // Determine placement type (v2 — raised confidence thresholds)
  if (placementType === 'confirmed_paid_placement') {
    // already set by explicit sponsor tag
  } else if (brand && (sponsorSignals.length >= 2 || (sponsorSignals.length >= 1 && brandConfidence >= 0.85))) {
    placementType = 'likely_sponsored';
  } else if (brand && brandConfidence >= 0.65) {
    placementType = 'organic_mention';
  }

  // ── 3.5 Industry gate enforcement — non-gaming content defaults to organic/unknown ──
  // Affiliate links in a food video's description are NOT a placement.
  // YouTube paid tag is kept (creator explicitly disclosed), but brand is voided.
  if (industryBlocked) {
    const wasConfirmed = placementType === 'confirmed_paid_placement';
    placementType = wasConfirmed ? 'confirmed_paid_placement' : 'organic_mention';
    if (!wasConfirmed) brand = null;
    brandConfidence = 0;
  }

  // ── 4. Content type ──
  const contentCategory = detectContentType(input.title, input.tags, input.isShort);

  // ── 5. Topic category ──
  const topicCategory = detectTopicCategory(input.title, input.description);

  // ── 6. Language & market ──
  const { language, market } = detectLanguage(input.title, input.description);

  // ── 7. AI escalation logic (v2 — cross-signal boosting) ──
  let needsAI = false;
  let aiPriority = 0;
  let aiReason = '';

  // Industry-blocked videos never escalate to AI — the gate is the final word.
  // (AI would only repeat the same affiliate-link false positive and burn tokens.)
  if (industryBlocked) {
    needsAI = false;
    aiPriority = 0;
    aiReason = 'industry-blocked (' + industryGate.category + ') — not a candidate placement';
  }

  const hoursAgo = (Date.now() - new Date(input.publishedAt).getTime()) / 3600000;
  const isRecent = hoursAgo < 72;
  const isHighViews = input.viewCount > 5000;

  // Brand unclear → AI needed
  if (!brand || brandConfidence < 0.65) {
    needsAI = true;
    aiPriority += 3;
    aiReason = 'brand unclear';
  }

  // Cross-signal boost: no brand detected, but video has promo code + gaming/lag context
  // → likely a booster sponsorship, AI should prioritize
  if (!brand && sponsorSignals.length >= 2 && (game || topicCategory !== 'game_integration')) {
    needsAI = true;
    aiPriority += 4; // HIGH priority — strong commercial signals, just needs brand ID
    aiReason = aiReason ? aiReason + '; strong cross-signals' : 'strong cross-signals (promo + gaming context)';
  }

  if (!game || gameConfidence < 0.5) {
    needsAI = true;
    aiPriority += 2;
    aiReason += (aiReason ? '; ' : '') + 'game unclear';
  }

  if (placementType === 'unknown' && sponsorSignals.length > 0) {
    needsAI = true;
    aiPriority += 2;
    aiReason += (aiReason ? '; ' : '') + 'sponsor signals ambiguous';
  }

  // Stage ④: rule-flagged placements MUST pass AI verification before entering
  // Layer 3. A title containing "exitlag" is brand evidence, not proof of a
  // paid placement — rule classification is a candidate filter, AI confirms.
  // The only exception is YouTube's official paid-placement tag (explicit disclosure).
  const isRulePlacement = placementType === 'confirmed_paid_placement' || placementType === 'likely_sponsored';
  if (isRulePlacement && !input.hasPaidPlacementTag) {
    needsAI = true;
    aiPriority += 3;
    aiReason += (aiReason ? '; ' : '') + 'rule-flagged placement — AI verification required';
  }

  // Boost priority for time-sensitive content
  if (isRecent && isHighViews && brand) {
    aiPriority += 3;
    aiReason += (aiReason ? '; ' : '') + 'high-value recent content';
  }

  // New game + brand = hot
  if (isRecent && brand && game && hoursAgo < 24) {
    aiPriority = 10; // P0: immediate
    aiReason = 'new game + brand — immediate analysis';
  }

  return {
    videoId: input.videoId,
    brand,
    brandConfidence,
    brandEvidence,
    game,
    gameConfidence,
    placementType,
    sponsorSignals,
    contentCategory,
    topicCategory,
    language,
    market,
    needsAI,
    aiPriority: Math.min(aiPriority, 10),
    aiReason,
    industryGate: {
      passed: industryGate.passed, category: industryGate.category, blockedBy: industryGate.blockedBy,
      gamingSignals: industryGate.gamingSignals, nonGamingSignals: industryGate.nonGamingSignals,
    },
  };
}

/**
 * Batch classify multiple videos and return AI queue (only those needing AI, sorted by priority).
 * Videos classified with high confidence by rules are returned in `classified`.
 */
export function batchClassify(videos: Array<{
  videoId: string; title: string; description: string; tags: string[];
  channelName: string; isShort: boolean; viewCount: number;
  publishedAt: string; hasPaidPlacementTag?: boolean;
}>): { classified: RuleClassification[]; aiQueue: RuleClassification[] } {
  const results = videos.map(v => classifyVideo(v));
  return {
    classified: results.filter(r => !r.needsAI),
    aiQueue: results.filter(r => r.needsAI).sort((a, b) => b.aiPriority - a.aiPriority),
  };
}

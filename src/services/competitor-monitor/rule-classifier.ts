/**
 * Rule Classifier — Layer 2 of the intelligence pipeline.
 *
 * Classifies 100% of videos using keyword/regex rules WITHOUT AI.
 * Handles 70-80% of classification work. Only ambiguous/unclear
 * videos get escalated to Layer 3 (AI).
 *
 * Design: Never false-positive on brand. When in doubt, leave for AI.
 */

// ── Brand detection ──

interface BrandRule {
  brandName: string;
  brandKeywords: string[];       // high-confidence: title contains → brand = true
  brandWeakKeywords: string[];   // lower-confidence: description only → mark for AI verify
  domainPatterns: string[];      // URL/domain in description
  promoCodePrefixes: string[];   // known promo code patterns
}

const BRAND_RULES: BrandRule[] = [
  {
    brandName: 'ExitLag',
    brandKeywords: ['exitlag', 'exit lag', 'exit-lag'],
    brandWeakKeywords: ['exitlag', 'exit lag'],
    domainPatterns: ['exitlag.com', 'exitlag.net'],
    promoCodePrefixes: ['EXITLAG', 'EXIT'],
  },
  {
    brandName: 'GearUP',
    brandKeywords: ['gearup', 'gear up', 'gear-up', 'gearupbooster', 'gearup booster'],
    brandWeakKeywords: ['gearup', 'gear up booster'],
    domainPatterns: ['gearupbooster.com', 'gearup.com'],
    promoCodePrefixes: ['GEARUP', 'GEAR'],
  },
  {
    brandName: 'LagZapper',
    brandKeywords: ['lagzapper', 'lag zapper', 'lag-zapper'],
    brandWeakKeywords: ['lagzapper', 'lag zapper'],
    domainPatterns: ['lagzapper.com'],
    promoCodePrefixes: ['LAGZAPPER', 'ZAPPER', 'LAGZAP'],
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

function detectLanguage(title: string, description: string): { language: string; market: string } {
  const combined = `${title} ${description}`;
  // Cyrillic
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

  // ── 1. Brand detection ──
  let brand: string | null = null;
  let brandConfidence = 0;
  const brandEvidence: string[] = [];

  for (const rule of BRAND_RULES) {
    // High-confidence: brand keyword in title
    const titleMatch = rule.brandKeywords.some(kw => t.includes(kw));
    const descMatch = rule.brandWeakKeywords.some(kw => d.includes(kw));
    const domainMatch = rule.domainPatterns.some(pat => d.includes(pat));
    const tagMatch = (input.tags || []).some(tag => rule.brandKeywords.some(kw => tag.toLowerCase().includes(kw)));
    const promoMatch = rule.promoCodePrefixes.some(prefix =>
      new RegExp(`\\b${prefix}[A-Za-z0-9_-]{2,15}\\b`, 'i').test(combined));

    if (titleMatch || tagMatch) {
      brand = rule.brandName;
      brandConfidence = 0.95;
      brandEvidence.push(`title contains '${rule.brandName}'`);
      if (domainMatch) { brandConfidence = 0.98; brandEvidence.push('brand domain in description'); }
      if (promoMatch) { brandConfidence = 0.98; brandEvidence.push('promo code detected'); }
      break; // first match wins (title is high-confidence)
    }

    if (descMatch || domainMatch) {
      brand = rule.brandName;
      brandConfidence = descMatch ? 0.70 : 0.75;
      if (domainMatch) { brandConfidence = 0.85; brandEvidence.push('official domain detected'); }
      if (descMatch && !domainMatch) brandEvidence.push(`brand mentioned in description`);
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

  // Determine placement type
  if (placementType === 'confirmed_paid_placement') {
    // already set by explicit sponsor tag
  } else if (brand && (sponsorSignals.length >= 2 || (sponsorSignals.length >= 1 && brandConfidence >= 0.9))) {
    placementType = 'likely_sponsored';
  } else if (brand && brandConfidence >= 0.7) {
    placementType = 'organic_mention';
  }

  // ── 4. Content type ──
  const contentCategory = detectContentType(input.title, input.tags, input.isShort);

  // ── 5. Topic category ──
  const topicCategory = detectTopicCategory(input.title, input.description);

  // ── 6. Language & market ──
  const { language, market } = detectLanguage(input.title, input.description);

  // ── 7. AI escalation logic ──
  let needsAI = false;
  let aiPriority = 0;
  let aiReason = '';

  const hoursAgo = (Date.now() - new Date(input.publishedAt).getTime()) / 3600000;
  const isRecent = hoursAgo < 72;
  const isHighViews = input.viewCount > 5000;

  if (!brand || brandConfidence < 0.7) {
    needsAI = true;
    aiPriority += 3;
    aiReason = 'brand unclear';
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

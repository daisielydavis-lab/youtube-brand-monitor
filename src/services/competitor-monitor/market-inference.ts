/**
 * Market Inference — 统一 target-market(目标受众市场)判定 + 证据提取 + 标签表。
 *
 * 2026-08-29 P1 修复(用户拍板):
 *   核心原则 —— **英文 ≠ 美国。语言只能说明内容语言，不能单独决定市场。**
 *   `detectLanguage → English → US` 的默认映射已移除；content_language=en 只写入
 *   language 维度，不单独推断 market。只有存在额外市场证据(频道 country / 本地化
 *   落地页 / 本地币种 / 本地语言优惠 / creator 历史 / AI 独立证据)才能写市场。
 *   无证据 → market=null, source='unknown', confidence=null。不强猜。
 *
 * 本模块是纯函数，不 import DB。DB 侧数据(market-context.ts)作为 MarketContext 传入。
 * 中文标签(MARKET_LABELS / LANGUAGE_LABELS)是全站唯一标签源。
 */

// ── Types ──

export type MarketSource =
  | 'manual' | 'channel_country' | 'explicit_localization' | 'language'
  | 'creator_history' | 'ai_inference' | 'discovery_hint' | 'unknown';

export interface MarketContext {
  /** 管理员手动覆盖（最高优先） */
  manual?: string | null;
  /** 频道国家（youtube_creator_profiles.country / channel snippet.country） */
  channelCountry?: string | null;
  /** 该 creator 历史已确认投放视频的 market（去 null），用于多数票推断 */
  creatorHistoryMarkets?: string[];
  /** discovery query 的 region/language —— 仅弱提示，且默认英文 US 必须忽略 */
  discoveryHint?: { market?: string | null; language?: string | null } | null;
}

export interface MarketInference {
  market: string | null;      // null = unknown（写 DB 为 null，不写 'Unknown'）
  confidence: number | null;  // 0-100；unknown → null（用户指定）
  source: MarketSource;       // unknown → 'unknown'
  evidence: string[];
}

// ── 标签表（全站唯一来源；Dashboard 服务端注入复用）──

export const MARKET_LABELS: Record<string, string> = {
  US: '美国', BR: '巴西', RU: 'RU/CIS(俄语区)', UA: '乌克兰', BY: '白俄罗斯', GE: '格鲁吉亚',
  CN: '中国大陆', TW: '台湾', HK: '香港', JP: '日本', KR: '韩国',
  TH: '泰国', VI: '越南', ID: '印尼', MY: '马来西亚', SG: '新加坡', PH: '菲律宾', IN: '印度',
  TR: '土耳其', LATAM: '拉美', DE: '德国', FR: '法国', PL: '波兰', ES: '西班牙', GB: '英国', NL: '荷兰',
};

export const LANGUAGE_LABELS: Record<string, string> = {
  en: '英语', ru: '俄语', pt: '葡语', es: '西语', th: '泰语', vi: '越南语',
  id: '印尼语', ms: '马来语', zh: '中文', ko: '韩语', ja: '日语',
  uk: '乌克兰语', be: '白俄语', ka: '格鲁吉亚语', tr: '土耳其语',
  de: '德语', fr: '法语', pl: '波兰语', nl: '荷兰语', ar: '阿拉伯语',
};

export function marketLabel(code: string | null | undefined): string {
  if (!code) return '未识别';
  return MARKET_LABELS[code] || code;
}

export function languageLabel(code: string | null | undefined): string {
  if (!code) return '未识别';
  return LANGUAGE_LABELS[code] || code;
}

const VALID_MARKETS = new Set(Object.keys(MARKET_LABELS));
function marketValid(code: string): boolean { return VALID_MARKETS.has(code); }

/** 归一化 AI 返回的市场码（小写/变体 → 规范码）。不能识别返回 null。 */
export function normalizeMarketCode(raw?: string | null): string | null {
  if (!raw) return null;
  const c = String(raw).trim().toUpperCase();
  if (c === 'VN') return 'VI';
  if (marketValid(c)) return c;
  return null;
}

// ── 语言检测（detectLanguage，自 rule-classifier 迁入 + 扩展 th/vi/id/ms/tr）──
// market 字段 = 朴素 language→market 映射（en→null），仅作向后兼容/信息；
// 正式 target-market 判定一律走 inferMarket 优先级链。

/**
 * 乌克兰语高信号词（俄语中不出现，用 "и" 同形字变位时兜底）。
 * 注意：JS 的 \b 是 ASCII 语义，对西里尔文本无效 —— 用子串匹配，
 * 且只收俄语绝不含的子串（如 обще 含 "ще" 会误伤，故不收入）。
 */
const UA_WORD_HINTS = /(насолод|погравши|пограю|вже|треба|найкращ|перемог|українськ|спробуй|увімкни|вмикай|дивись|дивимось|знайдеш|зможеш|чекай|перемагай|гравц)/i;
/** 越南语专属音符字（葡/西语不含，避免 pt/es 误判） */
const VIET_SPECIAL = /[ạặậẹệịọộỗụựỳỵỷỹứừửữẫẩầếềểễỗổồô]/i;
/** 葡语专属词（与西语区分：避免 "como funciona" 西语被误判 pt） */
const PT_WORDS = /\b(você|não|muito|jogar|jogo|jogos|cupom|desconto|tá|pra|brasil|brasileiro|gratuito)\b/i;
const ES_WORDS = /\b(más|mejor|mucho|jugar|juego|funciona|código|descuento|aquí|éste|esta|dónde|gratis|beneficios)\b/i;
const TR_WORDS = /\b(indirim|kupon|ücretsiz|oyuncu|oyun|indir)\b/i;
const ID_WORDS = /\b(yang|untuk|dengan|diskon|kode|berlangganan|mempercepat)\b/i;
const MS_WORDS = /\b(percuma|kod\b|panduan|tahap|meningkatkan)\b/i;

export function detectLanguage(title: string, description: string): { language: string; market: string | null } {
  const combined = `${title} ${description}`;
  let language: string;
  // Georgian (mixed titles may also contain Cyrillic — check first)
  if (/[ა-ჰ]/.test(combined)) language = 'ka';
  // Belarusian (ў)
  else if (/[ўЎ]/.test(combined)) language = 'be';
  // Ukrainian: і/ї/є/ґ (not used in Russian) or high-signal words (и-form conjugations)
  else if (/[іїєґІЇЄҐ]/.test(combined) || UA_WORD_HINTS.test(combined)) language = 'uk';
  // Cyrillic → Russian
  else if (/[а-яА-ЯёЁ]/.test(combined)) language = 'ru';
  // Thai script (U+0E00–U+0E7F，含元音/声调符)
  else if (/[\u0E00-\u0E7F]/.test(combined)) language = 'th';
  // Korean
  else if (/[가-힣]/.test(combined)) language = 'ko';
  // Japanese (hiragana + katakana)
  else if (/[぀-ゟ゠-ヿ]/.test(combined)) language = 'ja';
  // Chinese
  else if (/[一-鿿]/.test(combined)) language = 'zh';
  // Vietnamese diacritics（checked before pt/es to avoid collision）
  else if (VIET_SPECIAL.test(combined)) language = 'vi';
  // Portuguese
  else if (PT_WORDS.test(combined)) language = 'pt';
  // Spanish
  else if (ES_WORDS.test(combined)) language = 'es';
  // Turkish
  else if (/[ğĞ]/.test(combined) || TR_WORDS.test(combined)) language = 'tr';
  // Indonesian
  else if (ID_WORDS.test(combined)) language = 'id';
  // Malay
  else if (MS_WORDS.test(combined)) language = 'ms';
  else language = 'en';

  const lm = languageToMarket(language);
  return { language, market: lm?.market ?? null };
}

// ── 语言 → 市场（en → null；zh 歧义不进 CN）──

export function languageToMarket(language: string): { market: string; confidence: number } | null {
  switch ((language || '').toLowerCase()) {
    case 'ka': return { market: 'GE', confidence: 80 };
    case 'uk': return { market: 'UA', confidence: 80 };
    case 'be': return { market: 'BY', confidence: 70 };
    case 'ru': return { market: 'RU', confidence: 75 };
    case 'th': return { market: 'TH', confidence: 80 };
    case 'vi': return { market: 'VI', confidence: 80 };
    case 'id': return { market: 'ID', confidence: 70 };
    case 'ms': return { market: 'MY', confidence: 70 };
    case 'tr': return { market: 'TR', confidence: 80 };
    case 'ko': return { market: 'KR', confidence: 80 };
    case 'ja': return { market: 'JP', confidence: 80 };
    case 'pt': return { market: 'BR', confidence: 70 };
    case 'es': return { market: 'LATAM', confidence: 50 };
    case 'de': return { market: 'DE', confidence: 50 };
    case 'fr': return { market: 'FR', confidence: 50 };
    case 'pl': return { market: 'PL', confidence: 70 };
    case 'nl': return { market: 'NL', confidence: 50 };
    // zh → null：TW/HK/CN 歧义，不进 CN（用户"不强猜"）
    // en → null：英文 ≠ 美国（P1 核心原则）
    default: return null;
  }
}

// ── 频道国家 → 市场 ──

const COUNTRY_DIRECT: Record<string, string> = {
  US: 'US', BR: 'BR', RU: 'RU', UA: 'UA', BY: 'BY', GE: 'GE', KR: 'KR', JP: 'JP',
  CN: 'CN', TW: 'TW', HK: 'HK', TR: 'TR', ID: 'ID', TH: 'TH', VI: 'VI', VN: 'VI',
  MY: 'MY', IN: 'IN', SG: 'SG', PH: 'PH', GB: 'GB', DE: 'DE', FR: 'FR', PL: 'PL',
  ES: 'ES', NL: 'NL',
};
const COUNTRY_LATAM = new Set(['MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'DO']);

export function countryToMarket(country?: string | null): string | null {
  if (!country) return null;
  const c = String(country).trim().toUpperCase();
  if (COUNTRY_LATAM.has(c)) return 'LATAM';
  return COUNTRY_DIRECT[c] || null;
}

// ── 显式本地化证据提取（explicit_localization 层）──

interface LocalizationCandidate { market: string; confidence: number; evidence: string; }

/** URL 路径语言码（限定在 URL 内匹配，避免正文里随机 "ru" 误判） */
const URL_LANG_PATH = /(?:^|\/)(zh-tw|zh-hk|zh-cn|zh|pt-br|pt(?:-[a-z]{2})?|ru|tr|id|th|vi|vn|my|ko|ja|uk|ka|de|fr|pl|es(?:-[a-z]{2})?)(?:[/?#]|$)/i;
const PATH_TO_MARKET: Record<string, string> = {
  'zh-tw': 'TW', 'zh-hk': 'HK', 'zh-cn': 'CN', zh: 'CN',
  'pt-br': 'BR', pt: 'BR', ru: 'RU', tr: 'TR', id: 'ID', th: 'TH',
  vi: 'VI', vn: 'VI', my: 'MY', ko: 'KR', ja: 'JP', uk: 'UA', ka: 'GE',
  de: 'DE', fr: 'FR', pl: 'PL', es: 'LATAM', 'es-es': 'ES', 'es-mx': 'LATAM', 'es-ar': 'LATAM',
};
/** 国家顶级域名（country TLD）→ 市场；仅匹配明确的国别域 */
const TLD_TO_MARKET: Array<[RegExp, string]> = [
  [/\.(?:com\.)?ru(?:\/|$)/i, 'RU'], [/\.com\.br(?:\/|$)/i, 'BR'], [/\.(?:com\.)?ua(?:\/|$)/i, 'UA'],
  [/\.(?:com\.)?ge(?:\/|$)/i, 'GE'], [/\.(?:com\.)?by(?:\/|$)/i, 'BY'], [/\.(?:com\.)?tr(?:\/|$)/i, 'TR'],
  [/\.co\.th(?:\/|$)/i, 'TH'], [/\.(?:com\.)?vn(?:\/|$)/i, 'VI'], [/\.co\.id(?:\/|$)/i, 'ID'],
  [/\.(?:com\.)?my(?:\/|$)/i, 'MY'], [/\.co\.kr(?:\/|$)/i, 'KR'], [/\.(?:com\.)?jp(?:\/|$)/i, 'JP'],
  [/\.com\.tw(?:\/|$)/i, 'TW'], [/\.com\.hk(?:\/|$)/i, 'HK'], [/\.(?:co\.)?de(?:\/|$)/i, 'DE'],
  [/\.(?:co\.)?fr(?:\/|$)/i, 'FR'], [/\.(?:com\.)?pl(?:\/|$)/i, 'PL'], [/\.(?:com\.)?es(?:\/|$)/i, 'ES'],
  [/\.com\.mx(?:\/|$)/i, 'LATAM'], [/\.co\.uk(?:\/|$)/i, 'GB'],
];
/** 本地币种符号 → 市场（$ 不映射 US —— 英文内容 "$10 off" 遍地都是，会虚高） */
const CURRENCY_TO_MARKET: Array<[RegExp, string]> = [
  [/R\$/i, 'BR'], [/₽/i, 'RU'], [/₩/i, 'KR'], [/NT\$/i, 'TW'], [/HK\$/i, 'HK'], [/₴/i, 'UA'],
  [/₺/i, 'TR'], [/₱/i, 'PH'], [/₹/i, 'IN'], [/₫/i, 'VI'], [/RM(?=\s*\d)/i, 'MY'], [/฿/i, 'TH'],
  [/\bUS\$|USD(?=\s|\d)/i, 'US'], [/£/i, 'GB'],
];
/** 本地语言优惠词 → 市场（弱信号；多数与语言层重合，仅作补充证据） */
const PROMO_WORD_TO_MARKET: Array<[RegExp, string]> = [
  [/(промокод|скидка|купон|промо)/i, 'RU'],
  [/(cupom|desconto|código de desconto)/i, 'BR'],
  [/(indirim|kupon)/i, 'TR'],
  [/(diskon|kode promo)/i, 'ID'],
  [/(优惠|折扣|優惠|折扣碼)/i, 'CN'],  // 中港台歧义，仅弱信号（语言层 zh→null 不强猜）
];

function extractUrls(text: string): string[] {
  return (text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"'()]*)?/gi) || []);
}

export function detectLocalization(description: string): LocalizationCandidate[] {
  const out: LocalizationCandidate[] = [];
  const desc = description || '';
  const urls = extractUrls(desc);

  for (const url of urls) {
    const m = url.match(URL_LANG_PATH);
    if (m) {
      const mk = PATH_TO_MARKET[m[1].toLowerCase()];
      if (mk) out.push({ market: mk, confidence: 90, evidence: `url:${url.slice(0, 80)}` });
    }
    for (const [re, mk] of TLD_TO_MARKET) {
      if (re.test(url)) { out.push({ market: mk, confidence: 85, evidence: `tld:${url.slice(0, 80)}` }); break; }
    }
  }

  for (const [re, mk] of CURRENCY_TO_MARKET) {
    if (re.test(desc)) out.push({ market: mk, confidence: 80, evidence: `currency:${re.source}` });
  }

  for (const [re, mk] of PROMO_WORD_TO_MARKET) {
    if (re.test(desc)) out.push({ market: mk, confidence: 70, evidence: `promo_keyword:${re.source.slice(0, 40)}` });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

// ── 主判定：优先级链 ──

export function inferMarket(input: {
  title: string;
  description: string;
  marketContext?: MarketContext | null;
  aiCandidate?: { market?: string | null; confidence?: number; evidence?: string[] } | null;
}): MarketInference {
  const ctx = input.marketContext || {};

  // 1. manual override（最强）
  if (ctx.manual && marketValid(ctx.manual)) {
    return { market: ctx.manual, confidence: 100, source: 'manual', evidence: [`manual override: ${ctx.manual}`] };
  }

  // 2. channel country（频道明确国家）
  const cc = countryToMarket(ctx.channelCountry);
  if (cc) {
    return { market: cc, confidence: 90, source: 'channel_country', evidence: [`channel_country: ${ctx.channelCountry}`] };
  }

  // 3. explicit localization（本地化落地页路径 / 国别域名 / 本地币种 / 本地优惠词）
  const locs = detectLocalization(input.description);
  if (locs.length) {
    const top = locs[0];
    return { market: top.market, confidence: top.confidence, source: 'explicit_localization', evidence: [top.evidence] };
  }

  // 4. language（内容主语言；en→null 不强猜）
  const { language } = detectLanguage(input.title, input.description);
  const lm = languageToMarket(language);
  if (lm) {
    return { market: lm.market, confidence: lm.confidence, source: 'language', evidence: [`language: ${language}`] };
  }

  // 5. creator_history（该 creator 历史已确认投放市场多数票；需 ≥60% 且 ≥3 条）
  const hist = (ctx.creatorHistoryMarkets || []).filter(Boolean);
  if (hist.length >= 3) {
    const counts: Record<string, number> = {};
    for (const mk of hist) counts[mk] = (counts[mk] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] / hist.length >= 0.6) {
      return { market: best[0], confidence: 75, source: 'creator_history', evidence: [`creator_history: ${best[0]} (${best[1]}/${hist.length})`] };
    }
  }

  // 6. ai_inference（AI 有独立本地化证据才采纳）
  const ai = input.aiCandidate;
  const aiMkt = normalizeMarketCode(ai?.market);
  if (aiMkt) {
    const conf = Math.round(80 * Math.min(Math.max((ai?.confidence ?? 50) / 100, 0.3), 1));
    return {
      market: aiMkt, confidence: conf, source: 'ai_inference',
      evidence: (ai?.evidence && ai.evidence.length) ? ai.evidence.map(e => `ai:${e}`) : [`ai: ${aiMkt}`],
    };
  }

  // 7. discovery_hint（仅弱提示，且默认英文/US query 必须忽略 —— 防强猜）
  const hint = ctx.discoveryHint;
  if (hint) {
    const hl = hint.language && String(hint.language).toLowerCase() !== 'en' ? languageToMarket(String(hint.language).toLowerCase()) : null;
    if (hl) return { market: hl.market, confidence: 40, source: 'discovery_hint', evidence: [`discovery_query: ${hint.language}/${hint.market}`] };
    if (hint.market && String(hint.market).toUpperCase() !== 'US') {
      const m = normalizeMarketCode(hint.market);
      if (m) return { market: m, confidence: 40, source: 'discovery_hint', evidence: [`discovery_query: ${m}`] };
    }
  }

  // 8. unknown（不强猜兜底）
  return { market: null, confidence: null, source: 'unknown', evidence: [] };
}

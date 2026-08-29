/**
 * Brand configuration v3 — combined OR queries to minimize search.list calls.
 * Normal mode uses 6 searches/day (down from 15).
 */

export interface BrandConfig {
  brandName: string;
  displayName: string;
  websiteDomain: string;
  trackedDomains: string[];
  promoCodePatterns: RegExp[];
  brandKeywords: string[];
}

export interface BrandQuery {
  brandName: string;
  queryText: string;
  queryType: 'branded' | 'sponsored' | 'domain';
  targetLanguage: string;
  targetMarket: string;
}

export const BRANDS: BrandConfig[] = [
  {
    brandName: 'GearUP', displayName: 'GearUP Booster', websiteDomain: 'gearupbooster.com',
    trackedDomains: ['gearupbooster.com', 'gearup.com'],
    promoCodePatterns: [/GEARUP\d+/i, /gearup/i],
    brandKeywords: ['gearup', 'gear up', 'gearup booster'],
  },
  {
    brandName: 'ExitLag', displayName: 'ExitLag', websiteDomain: 'exitlag.com',
    trackedDomains: ['exitlag.com', 'exitlag.app'],
    promoCodePatterns: [/EXITLAG\d+/i, /exitlag/i],
    brandKeywords: ['exitlag', 'exit lag'],
  },
  {
    brandName: 'LagZapper', displayName: 'LagZapper', websiteDomain: 'lagzapper.com',
    trackedDomains: ['lagzapper.com'],
    promoCodePatterns: [/LAGZAPPER\d+/i, /zapper/i],
    brandKeywords: ['lagzapper', 'lag zapper'],
  },
  {
    brandName: 'Lagofast', displayName: 'Lagofast', websiteDomain: 'lagofast.com',
    trackedDomains: ['lagofast.com', 'lagofastbooster.ru', 'lagobooster.ru', 'lago-fast.com'],
    promoCodePatterns: [/LAGOFAST\d+/i, /lagofast/i, /lago-fast/i],
    brandKeywords: ['lagofast', 'lago fast', 'lago-fast', 'lagobooster', 'лагофаст'],
  },
];

/**
 * Normal mode queries — 13 combined searches/day using OR operators.
 * 2026-08-16: 新增 RU/PT 市场 query（用户验收：LagZapper 90 天俄区投放 100+，
 * 全英文 query 是漏抓根因）。俄语商业词：скидка(折扣)/промокод(促销码)/обзор(评测)。
 * regionCode=targetMarket 只是可观看区域约束，relevanceLanguage=targetLanguage 影响召回。
 */
export const NORMAL_QUERIES: BrandQuery[] = [
  // ——— EN/US（原有 6 条）———
  { brandName: 'GearUP', queryText: 'GearUP | GearUP Booster', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper | Lag Zapper', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP sponsored | GearUP review | GearUP promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag sponsored | ExitLag review | ExitLag promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper review | LagZapper free | LagZapper promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  // ——— RU（俄区，LagZapper 主市场；西里尔变体 ЛагЗаппер 也搜）———
  { brandName: 'LagZapper', queryText: 'LagZapper скидка | LagZapper промокод | LagZapper обзор', queryType: 'sponsored', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'LagZapper', queryText: 'ЛагЗаппер | ЛАГЗАППЕР', queryType: 'branded', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'ExitLag', queryText: 'ExitLag скидка | ExitLag промокод | ExitLag обзор', queryType: 'sponsored', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'GearUP', queryText: 'GearUP скидка | GearUP промокод | GearUP обзор', queryType: 'sponsored', targetLanguage: 'ru', targetMarket: 'RU' },
  // ——— PT（巴西）———
  { brandName: 'LagZapper', queryText: 'LagZapper desconto | LagZapper cupom | LagZapper review', queryType: 'sponsored', targetLanguage: 'pt', targetMarket: 'BR' },
  { brandName: 'ExitLag', queryText: 'ExitLag desconto | ExitLag cupom | ExitLag review', queryType: 'sponsored', targetLanguage: 'pt', targetMarket: 'BR' },
  { brandName: 'GearUP', queryText: 'GearUP desconto | GearUP cupom | GearUP review', queryType: 'sponsored', targetLanguage: 'pt', targetMarket: 'BR' },
  // ——— Domain（2026-08-24：YouTube search 索引 description → 搜域名直接捞
  // description-only 投放。lagzapper.com 是 LagZapper 90 天 174 条突破的来源，
  // 不写 www. 前缀——search 做子串匹配，www.lagzapper.com 的 URL 必含 lagzapper.com）———
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'LagZapper', queryText: 'lagzapper.com', queryType: 'domain', targetLanguage: 'pt', targetMarket: 'BR' },
  // ——— GearUP 亚洲（2026-08-26 recall 探针验证：ID/TH/MY/VI 各 20-37 新候选、14-23 新 creator，
  // 召回缺口真实存在。query 文本取探针最强项。正式跑一轮后按 confirmed/search call 决定长期频率）———
  { brandName: 'GearUP', queryText: 'GearUP booster | GearUP gratis', queryType: 'sponsored', targetLanguage: 'id', targetMarket: 'ID' },
  { brandName: 'GearUP', queryText: 'GearUP | GearUP เกม', queryType: 'branded', targetLanguage: 'th', targetMarket: 'TH' },
  { brandName: 'GearUP', queryText: 'GearUP | GearUP tăng tốc', queryType: 'sponsored', targetLanguage: 'vi', targetMarket: 'VI' },
  { brandName: 'GearUP', queryText: 'GearUP | GearUP booster', queryType: 'branded', targetLanguage: 'ms', targetMarket: 'MY' },
];

/**
 * Experimental queries — 每周试跑，不进日常（探针弱，先积累样本再决定去留）。
 * 2026-08-26: TW 探针仅 7 候选 / 3 新 creator，不足以证明无价值，放 weekly 观察。
 */
export const EXPERIMENTAL_QUERIES: BrandQuery[] = [
  { brandName: 'GearUP', queryText: 'GearUP 加速器 | GearUP booster', queryType: 'sponsored', targetLanguage: 'zh-TW', targetMarket: 'TW' },
];

/** Build hotspot queries for a specific game */
export function buildHotspotQueries(
  game: string,
  brands?: string[],
  markets?: string[],
): BrandQuery[] {
  const targetBrands = brands || ['GearUP', 'ExitLag', 'LagZapper'];
  const targetMarkets = markets || ['US'];
  const queries: BrandQuery[] = [];

  for (const market of targetMarkets) {
    for (const brand of targetBrands) {
      queries.push({
        brandName: brand,
        queryText: `${brand} ${game}`,
        queryType: 'sponsored',
        targetLanguage: market === 'RU' ? 'ru' : market === 'BR' ? 'pt' : 'en',
        targetMarket: market,
      });
    }
  }

  return queries;
}

export function getActiveQueries(): BrandQuery[] { return NORMAL_QUERIES; }
export function getBrandConfig(brandName: string): BrandConfig | undefined {
  return BRANDS.find(b => b.brandName.toLowerCase() === brandName.toLowerCase());
}

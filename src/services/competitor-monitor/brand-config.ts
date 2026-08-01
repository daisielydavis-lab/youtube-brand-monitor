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
  queryType: 'branded' | 'sponsored';
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
];

/** Normal mode queries — 6 combined searches/day using OR operators */
export const NORMAL_QUERIES: BrandQuery[] = [
  { brandName: 'GearUP', queryText: 'GearUP | GearUP Booster', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper | Lag Zapper', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP sponsored | GearUP review | GearUP promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag sponsored | ExitLag review | ExitLag promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper review | LagZapper free | LagZapper promo code', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
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

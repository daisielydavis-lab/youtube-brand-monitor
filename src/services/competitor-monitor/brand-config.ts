/**
 * Brand configuration for competitor monitoring.
 * Defines brands, their search queries, and detection rules.
 */

export interface BrandConfig {
  brandName: string;
  displayName: string;
  websiteDomain: string;
  /** Domains that indicate a landing page mention */
  trackedDomains: string[];
  /** Patterns to detect promo codes in descriptions */
  promoCodePatterns: RegExp[];
  /** Keywords that signal this brand in video titles/descriptions */
  brandKeywords: string[];
  /** Common CTA phrases used by this brand's affiliates */
  commonCTAs: string[];
}

export interface BrandQuery {
  brandName: string;
  queryText: string;
  queryType: 'branded' | 'review' | 'promo' | 'sponsored' | 'comparison';
  targetLanguage: string;
  targetMarket: string;
}

export const BRANDS: BrandConfig[] = [
  {
    brandName: 'GearUP',
    displayName: 'GearUP Booster',
    websiteDomain: 'gearupbooster.com',
    trackedDomains: ['gearupbooster.com', 'gearup.com', 'gearuplink.com'],
    promoCodePatterns: [/GEARUP\d+/i, /GEARUP[A-Z]+/i, /gearup[-_]?\w+ discount/i],
    brandKeywords: ['gearup', 'gear up', 'gearup booster', 'gearup game booster'],
    commonCTAs: ['download gearup', 'try gearup', 'use code', 'gearup free', 'gearup trial'],
  },
  {
    brandName: 'ExitLag',
    displayName: 'ExitLag',
    websiteDomain: 'exitlag.com',
    trackedDomains: ['exitlag.com', 'exitlag.app', 'exitlag.net'],
    promoCodePatterns: [/EXITLAG\d+/i, /EXIT[A-Z]+/i, /exitlag[-_]?\w+ discount/i],
    brandKeywords: ['exitlag', 'exit lag', 'exitlag.com'],
    commonCTAs: ['download exitlag', 'try exitlag', 'use code', 'exitlag free', 'exitlag trial'],
  },
  {
    brandName: 'LagZapper',
    displayName: 'LagZapper',
    websiteDomain: 'lagzapper.com',
    trackedDomains: ['lagzapper.com', 'lagzapper.net'],
    promoCodePatterns: [/LAGZAPPER\d+/i, /LAGZAP[A-Z]+/i, /zapper[-_]?\w+ discount/i],
    brandKeywords: ['lagzapper', 'lag zapper', 'lagzap'],
    commonCTAs: ['download lagzapper', 'try lagzapper', 'lagzapper free', 'use code'],
  },
];

/** Search queries per brand for English market (v1 scope) */
export const BRAND_QUERIES: BrandQuery[] = [
  // GearUP
  { brandName: 'GearUP', queryText: 'GearUP Booster', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP game booster', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP lag', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP promo code', queryType: 'promo', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP review', queryType: 'review', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'GearUP', queryText: 'GearUP sponsored', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },

  // ExitLag
  { brandName: 'ExitLag', queryText: 'ExitLag', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag review', queryType: 'review', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag promo code', queryType: 'promo', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag sponsored', queryType: 'sponsored', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'ExitLag', queryText: 'ExitLag Valorant', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },

  // LagZapper
  { brandName: 'LagZapper', queryText: 'LagZapper', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'Lag Zapper', queryType: 'branded', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper free', queryType: 'promo', targetLanguage: 'en', targetMarket: 'US' },
  { brandName: 'LagZapper', queryText: 'LagZapper review', queryType: 'review', targetLanguage: 'en', targetMarket: 'US' },
];

/** Russian market queries for phase 2 expansion */
export const RU_QUERIES: BrandQuery[] = [
  { brandName: 'ExitLag', queryText: 'ExitLag обзор', queryType: 'review', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'ExitLag', queryText: 'ExitLag промокод', queryType: 'promo', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'GearUP', queryText: 'GearUP бустер', queryType: 'branded', targetLanguage: 'ru', targetMarket: 'RU' },
  { brandName: 'GearUP', queryText: 'GearUP обзор', queryType: 'review', targetLanguage: 'ru', targetMarket: 'RU' },
];

/** Brazilian Portuguese market queries for phase 2 expansion */
export const PT_QUERIES: BrandQuery[] = [
  { brandName: 'ExitLag', queryText: 'ExitLag review', queryType: 'review', targetLanguage: 'pt', targetMarket: 'BR' },
  { brandName: 'ExitLag', queryText: 'ExitLag funciona', queryType: 'review', targetLanguage: 'pt', targetMarket: 'BR' },
  { brandName: 'ExitLag', queryText: 'ExitLag cupom', queryType: 'promo', targetLanguage: 'pt', targetMarket: 'BR' },
];

/** All active queries for v1 */
export function getActiveQueries(): BrandQuery[] {
  return BRAND_QUERIES;
}

/** Get brand config by name */
export function getBrandConfig(brandName: string): BrandConfig | undefined {
  return BRANDS.find(b => b.brandName.toLowerCase() === brandName.toLowerCase());
}

/** Get all active brand names */
export function getActiveBrandNames(): string[] {
  return BRANDS.filter(b => true).map(b => b.brandName);
}

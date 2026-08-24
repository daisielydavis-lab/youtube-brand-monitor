/**
 * Brand normalization — raw_brand → canonical_brand (P0-1).
 *
 * Single source of truth for brand name normalization. Every layer
 * (rule write-back, AI write-back, resolveBrand) normalizes through
 * canonicalBrand() so counting never depends on AI's exact string form.
 *
 * Canonical brands: GearUP / ExitLag / LagZapper / Lagofast.
 *
 * Matching order:
 *   1. Exact alias match (case/space/URL/domain variants collapsed)
 *   2. Strong-token substring match — catches brand embedded in longer
 *      strings ("GearUP Booster 評價", "download gearup.gg now")
 *
 * NOTE: multi-brand strings ("GearUP vs ExitLag") resolve to the FIRST
 * canonical in iteration order (GearUP → ExitLag → LagZapper → Lagofast).
 * Primary-brand attribution is a Phase 3 (mentioned_brands) concern — for P0
 * this is deterministic and acceptable.
 */

export const CANONICAL_BRANDS = ['GearUP', 'ExitLag', 'LagZapper', 'Lagofast'] as const;
export type CanonicalBrand = typeof CANONICAL_BRANDS[number];

/** Exact-match aliases — lowercased + whitespace collapsed before compare. */
const ALIASES: Record<CanonicalBrand, string[]> = {
  GearUP: [
    'gearup', 'gear up', 'gear-up', 'gearup.', 'gear up.',
    'gearupbooster', 'gearup booster', 'gear up booster', 'gear-up booster',
    'gearup game booster', 'gear up game booster', 'gearup.gg',
    'gearupbooster.com', 'gearup.com', 'gearup.app',
  ],
  ExitLag: [
    'exitlag', 'exit lag', 'exit-lag', 'exitlag.',
    'exitlag.com', 'exitlag.net', 'exitlag.app', 'exitlag.io',
  ],
  LagZapper: [
    'lagzapper', 'lag zapper', 'lag-zapper', 'lagzapper.',
    'lagzapper.com', 'lagzapper.app',
    'лагзаппер', 'лаг заппер', 'лаг-заппер', 'лагзапер',
  ],
  Lagofast: [
    'lagofast', 'lago fast', 'lago-fast', 'lagofast.',
    'lagofast.com', 'lagofastbooster', 'lagofastbooster.ru',
    'lagobooster', 'lagobooster.ru', 'lago-fast.com',
    'лагофаст',
  ],
};

/**
 * Strong-token substring matches — fired only after exact-match fails.
 * Deliberately EXCLUDES bare "gear up" (the English phrasal verb idiom) to
 * avoid re-introducing the P0-2 false-positive: a raw brand value of
 * "gear up for warzone" must NOT normalize to GearUP. Multi-word brand-ish
 * phrases ("gear up booster") and concatenated forms ("gearup.gg") are safe.
 */
const STRONG_TOKENS: Record<CanonicalBrand, string[]> = {
  GearUP: ['gearup', 'gear up booster', 'gear-up booster', 'gearupbooster'],
  ExitLag: ['exitlag', 'exit lag.'],
  LagZapper: ['lagzapper', 'lagzapper.', 'лагзаппер', 'лаг заппер'],
  Lagofast: ['lagofast', 'lagobooster', 'лагофаст'],
};

/** Normalize any raw brand string to its canonical form, or null if un-mappable. */
export function canonicalBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;

  // 1. Exact alias match
  for (const canon of CANONICAL_BRANDS) {
    if (ALIASES[canon].includes(key)) return canon;
  }

  // 2. Strong-token substring match (longer strings, URLs, CJK-suffixed titles)
  for (const canon of CANONICAL_BRANDS) {
    for (const tok of STRONG_TOKENS[canon]) {
      if (key.includes(tok)) return canon;
    }
  }

  return null;
}

/** True if `value` is one of the canonical competitor brands. */
export function isCanonicalBrand(value: string | null | undefined): value is CanonicalBrand {
  return !!value && (CANONICAL_BRANDS as readonly string[]).includes(value);
}

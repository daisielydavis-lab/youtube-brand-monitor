/**
 * Sponsorship Detector — uses DeepSeek/Gemini to classify video placement type.
 *
 * Classification types:
 *   - confirmed_paid_placement: YouTube paid promotion tag OR explicit "sponsored/paid/ad/partner" disclosure
 *   - likely_sponsored: Multiple signals (promo code + brand focus + CTA + consistent brand mentions)
 *   - organic_mention: Casual brand mention, no promo structure, no CTA
 *   - official_brand_video: From the brand's own verified channel
 *   - unknown: Insufficient signals to classify
 */

import axios from 'axios';
import { config } from '../../config';
import { MODEL } from '../../config/deepseek-models';
import { BRANDS, type BrandConfig } from './brand-config';
import { evaluateIndustryGate } from './industry-gate';
import { COMPETITOR_BRANDS } from './data-scope';

interface SponsorshipInput {
  title: string;
  description: string;
  channelName: string;
  tags: string[];
  hasPaidPlacementTag: boolean;
  comments?: string[]; // Top comments (text only, up to 20)
}

export interface SponsorshipResult {
  placementType: 'confirmed_paid_placement' | 'likely_sponsored' | 'organic_mention' | 'official_brand_video' | 'unknown';
  sponsorConfidence: number; // 0.00 - 1.00
  detectedBrand: string | null;
  brandMentionPositions: string[]; // title / description / pinned_comment
  promoCode: string | null;
  landingDomain: string | null;
  ctaType: string | null;
  sellingPoints: string[];
  reasoning: string;
}

// ── Regex pre-filter: fast detection before AI ──

function extractPromoCode(description: string, brand: BrandConfig): string | null {
  for (const pattern of brand.promoCodePatterns) {
    const match = description.match(pattern);
    if (match) return match[0];
  }
  // Generic promo code patterns
  const genericMatch = description.match(/(?:code|promo|coupon)[:\s]*["']?([A-Za-z0-9_-]{4,20})/i);
  return genericMatch ? genericMatch[1] : null;
}

function extractLandingDomain(description: string): string | null {
  const urlMatch = description.match(/https?:\/\/([a-zA-Z0-9.-]+\.(?:com|app|net|io|gg|link|me))(?:\/[^\s]*)?/gi);
  if (!urlMatch) return null;

  for (const brand of BRANDS) {
    for (const domain of brand.trackedDomains) {
      const found = urlMatch.find(u => u.toLowerCase().includes(domain));
      if (found) return new URL(found).hostname;
    }
  }
  return null;
}

function detectBrandMentionPositions(
  title: string,
  description: string,
  brandKeywords: string[],
): string[] {
  const positions: string[] = [];
  const checkText = (text: string) => brandKeywords.some(kw => text.toLowerCase().includes(kw));

  if (checkText(title)) positions.push('title');
  if (checkText(description)) positions.push('description');
  // pinned_comment detection requires actual comment data with highlight status

  return positions;
}

function regexPreFilter(input: SponsorshipInput): {
  detectedBrand: string | null;
  promoCode: string | null;
  landingDomain: string | null;
  mentionPositions: string[];
  isExplicitlySponsored: boolean;
} {
  // Check explicit sponsorship disclosures
  const combinedText = `${input.title} ${input.description}`.toLowerCase();
  const sponsorshipPhrases = [
    'sponsored by', 'paid promotion', 'paid partnership', '#ad', '#sponsored',
    'affiliate link', 'affiliate links', 'commission earned', 'use code',
    'discount code', 'promo code', 'partner', 'ambassador',
  ];
  const isExplicitlySponsored = input.hasPaidPlacementTag ||
    sponsorshipPhrases.some(p => combinedText.includes(p));

  // Detect brand
  let detectedBrand: string | null = null;
  let promoCode: string | null = null;
  let landingDomain: string | null = null;
  let mentionPositions: string[] = [];

  for (const brand of BRANDS) {
    const brandMentioned = brand.brandKeywords.some(kw => combinedText.includes(kw));
    if (brandMentioned) {
      detectedBrand = brand.brandName;
      promoCode = extractPromoCode(input.description, brand);
      landingDomain = extractLandingDomain(input.description);
      mentionPositions = detectBrandMentionPositions(input.title, input.description, brand.brandKeywords);
      break;
    }
  }

  // If no brand directly matched, check landing domains
  if (!detectedBrand) {
    landingDomain = extractLandingDomain(input.description);
    if (landingDomain) {
      for (const brand of BRANDS) {
        if (brand.trackedDomains.some(d => landingDomain!.includes(d))) {
          detectedBrand = brand.brandName;
          mentionPositions = detectBrandMentionPositions(input.title, input.description, brand.brandKeywords);
          break;
        }
      }
    }
  }

  return { detectedBrand, promoCode, landingDomain, mentionPositions, isExplicitlySponsored };
}

// ── AI Classification via DeepSeek/Gemini ──

async function aiClassifySponsorship(
  input: SponsorshipInput,
  preFilter: ReturnType<typeof regexPreFilter>,
): Promise<SponsorshipResult> {
  const brandList = COMPETITOR_BRANDS.join(', ');
  const brandEnum = COMPETITOR_BRANDS.map(b => `"${b}"`).join('|');
  const brandSlash = COMPETITOR_BRANDS.join('/');
  const systemPrompt = `You are a sponsorship detection analyst for YouTube gaming content. Your job is to determine whether a YouTube video is sponsored by a game booster brand (${brandList}).

CLASSIFICATION DEFINITIONS:
- confirmed_paid_placement: YouTube's "Paid Promotion" tag is ON, OR the video/description contains explicit disclosure like "sponsored by [Brand]", "#ad", "paid partnership", "affiliate".
- likely_sponsored: No explicit disclosure, but strong signaling: unique promo code + brand-focused content + clear CTA + brand is central to the video narrative. The creator consistently mentions the brand as a solution.
- organic_mention: Brand is mentioned casually or in passing. No promo code, no structured CTA, no brand-centric narrative. Could be a genuine user review or comparison list.
- official_brand_video: The video comes from the brand's own official YouTube channel (channel name matches brand name closely).
- unknown: Cannot determine from available data. Insufficient signals.

INDUSTRY GATE (MANDATORY — highest priority rule):
Game boosters (${brandSlash}) are ONLY advertised in gaming / esports / game-hardware / game-network content.
- If the video title, channel, or content is clearly NOT gaming (food cooking/eating, mukbang, beauty, fashion, finance/trading, lifestyle/vlog, music, news, pranks, random shorts), classify it "organic_mention" with detectedBrand = null — EVEN IF its description contains a brand affiliate link, promo code, or "sponsored by" text. Affiliate links in irrelevant niches are spam, not placements.
- The ONLY exception: the title itself clearly promotes the product (e.g. "ExitLag review", "best game booster for [game]").

RULES:
- Promo codes are the strongest signal after explicit disclosure.
- If a creator has a unique discount code for a brand, it's at least "likely_sponsored".
- Multiple brand mentions + direct download links + "best/cheapest/fastest" language → likely_sponsored.
- Casual "I tried ExitLag and it works" without any code/link → organic_mention.
- Only classify as "official_brand_video" if the channel name IS the brand name (e.g., "ExitLag", "GearUP").

Output ONLY valid JSON — no markdown, no preamble.`;

  const commentsText = (input.comments || []).slice(0, 20).map((c, i) => `[${i + 1}] ${c}`).join('\n');

  const userPrompt = `Analyze this YouTube video for sponsorship signals:

TITLE: ${input.title}
CHANNEL: ${input.channelName}
TAGS: ${input.tags.join(', ')}
YOUTUBE PAID PLACEMENT TAG: ${input.hasPaidPlacementTag ? 'YES' : 'NO'}

DESCRIPTION:
${input.description.slice(0, 1500)}

TOP COMMENTS:
${commentsText || '(no comments available)'}

PRE-FILTER RESULTS:
- Detected Brand: ${preFilter.detectedBrand || 'none'}
- Promo Code Found: ${preFilter.promoCode || 'none'}
- Landing Domain: ${preFilter.landingDomain || 'none'}
- Brand Mention Positions: ${preFilter.mentionPositions.join(', ') || 'none'}
- Explicit Sponsorship Signals: ${preFilter.isExplicitlySponsored ? 'YES' : 'NO'}

Output JSON:
{
  "placementType": "confirmed_paid_placement" | "likely_sponsored" | "organic_mention" | "official_brand_video" | "unknown",
  "sponsorConfidence": 0.00-1.00,
  "detectedBrand": ${brandEnum} | null,
  "brandMentionPositions": ["title", "description", "video_body", "pinned_comment"],
  "promoCode": "CODE" | null,
  "landingDomain": "domain.com" | null,
  "ctaType": "download" | "free_trial" | "promo_code" | "website_visit" | null,
  "sellingPoints": ["low latency", "region unlock", "packet loss reduction", "free to use", ...],
  "reasoning": "Brief explanation of why this classification was chosen (1-2 sentences)"
}`;

  const model = config.gemini.apiKey ? 'gemini-2.0-flash' : MODEL;
  const isGemini = model.startsWith('gemini');

  try {
    if (isGemini) {
      const apiKey = config.gemini.apiKey;
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
      const result = parseAIJson(text);
      if (result) return formatResult(result, preFilter);
    } else {
      // DeepSeek
      const response = await axios.post(
        `${config.deepseek.baseUrl}/chat/completions`,
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 1024,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' as const },
        },
        {
          headers: {
            Authorization: `Bearer ${config.deepseek.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );
      const text = response.data?.choices?.[0]?.message?.content?.trim() || '';
      console.log(`[SponsorshipDetector] DeepSeek raw (first 300): ${text.slice(0, 300)}`);
      const result = parseAIJson(text);
      if (result) return formatResult(result, preFilter);
      console.error(`[SponsorshipDetector] JSON parse failed. Raw length: ${text.length}. Full raw: ${text.slice(0, 500)}`);
    }

    console.error('[SponsorshipDetector] AI returned no valid result');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const axiosErr = err as { response?: { data?: unknown; status?: number } };
    console.error(`[SponsorshipDetector] AI call failed: ${msg}`);
    if (axiosErr.response) {
      console.error(`[SponsorshipDetector] HTTP ${axiosErr.response.status}: ${JSON.stringify(axiosErr.response.data).slice(0, 500)}`);
    }
  }

  // Fallback: use regex pre-filter results
  return fallbackResult(preFilter);
}

function parseAIJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // Strip markdown fences
  const cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // Try to extract first { ... }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

function formatResult(raw: Record<string, unknown>, preFilter: ReturnType<typeof regexPreFilter>): SponsorshipResult {
  return {
    placementType: (raw.placementType as SponsorshipResult['placementType']) || 'unknown',
    sponsorConfidence: typeof raw.sponsorConfidence === 'number' ? raw.sponsorConfidence : 0.5,
    detectedBrand: (raw.detectedBrand as string) || preFilter.detectedBrand,
    brandMentionPositions: Array.isArray(raw.brandMentionPositions) ? raw.brandMentionPositions as string[] : preFilter.mentionPositions,
    promoCode: (raw.promoCode as string) || preFilter.promoCode,
    landingDomain: (raw.landingDomain as string) || preFilter.landingDomain,
    ctaType: (raw.ctaType as string) || null,
    sellingPoints: Array.isArray(raw.sellingPoints) ? raw.sellingPoints as string[] : [],
    reasoning: (raw.reasoning as string) || 'AI classification failed, using regex pre-filter',
  };
}

function fallbackResult(preFilter: ReturnType<typeof regexPreFilter>): SponsorshipResult {
  let placementType: SponsorshipResult['placementType'] = 'unknown';
  let confidence = 0.3;

  if (preFilter.isExplicitlySponsored && preFilter.detectedBrand) {
    placementType = 'confirmed_paid_placement';
    confidence = 0.85;
  } else if (preFilter.detectedBrand && preFilter.promoCode) {
    placementType = 'likely_sponsored';
    confidence = 0.7;
  } else if (preFilter.detectedBrand && preFilter.landingDomain) {
    placementType = 'likely_sponsored';
    confidence = 0.55;
  } else if (preFilter.detectedBrand) {
    placementType = 'organic_mention';
    confidence = 0.5;
  }

  return {
    placementType,
    sponsorConfidence: confidence,
    detectedBrand: preFilter.detectedBrand,
    brandMentionPositions: preFilter.mentionPositions,
    promoCode: preFilter.promoCode,
    landingDomain: preFilter.landingDomain,
    ctaType: preFilter.promoCode ? 'promo_code' : null,
    sellingPoints: [],
    reasoning: 'Regex pre-filter fallback (AI unavailable)',
  };
}

/** Main entry point: classify a video's sponsorship status */
export async function detectSponsorship(input: SponsorshipInput): Promise<SponsorshipResult> {
  // ── Stage ① industry gate — hard-block non-gaming content ──
  // A food/beauty/finance video with an affiliate link in its description is
  // NOT a placement, no matter what regex or AI says. Only bypass if the
  // gate explicitly passed (gaming signals or obvious brand promotion).
  const gate = evaluateIndustryGate({
    title: input.title, description: input.description,
    channelName: input.channelName, tags: input.tags,
  });
  if (!gate.passed && gate.category !== 'gaming') {
    return {
      placementType: 'organic_mention',
      sponsorConfidence: 0.1,
      detectedBrand: null,
      brandMentionPositions: [],
      promoCode: null,
      landingDomain: null,
      ctaType: null,
      sellingPoints: [],
      reasoning: `Industry gate blocked (${gate.category}: ${gate.blockedBy}) — affiliate links in non-gaming content are not placements`,
    };
  }

  const preFilter = regexPreFilter(input);

  // If no brand detected at all, skip AI
  if (!preFilter.detectedBrand && !preFilter.landingDomain) {
    return {
      placementType: 'unknown',
      sponsorConfidence: 0.1,
      detectedBrand: null,
      brandMentionPositions: [],
      promoCode: null,
      landingDomain: null,
      ctaType: null,
      sellingPoints: [],
      reasoning: 'No brand signals detected in title, description, or tags',
    };
  }

  // If confirmed by YouTube tag AND regex found the brand, high confidence without AI
  if (input.hasPaidPlacementTag && preFilter.detectedBrand) {
    console.log(`[SponsorshipDetector] Confirmed paid placement (YouTube tag) for ${preFilter.detectedBrand}`);
    return {
      placementType: 'confirmed_paid_placement',
      sponsorConfidence: 0.95,
      detectedBrand: preFilter.detectedBrand,
      brandMentionPositions: preFilter.mentionPositions,
      promoCode: preFilter.promoCode,
      landingDomain: preFilter.landingDomain,
      ctaType: preFilter.promoCode ? 'promo_code' : 'download',
      sellingPoints: [],
      reasoning: 'YouTube paid placement tag + brand detected in content',
    };
  }

  // Run AI classification for nuanced cases
  return aiClassifySponsorship(input, preFilter);
}

// Batch classify
export async function detectSponsorshipBatch(
  videos: SponsorshipInput[],
): Promise<SponsorshipResult[]> {
  const results: SponsorshipResult[] = [];
  for (const video of videos) {
    const result = await detectSponsorship(video);
    results.push(result);
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

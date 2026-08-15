/**
 * Topic Classifier — categorizes video content using DeepSeek/Gemini.
 *
 * Classifies:
 *   - game_name: e.g., Valorant, AION 2, ARC Raiders
 *   - content_type: dedicated_review / integrated_placement / comparison / tutorial / shorts / live_replay
 *   - topic_category: game_integration / lag_fix / booster_review / competitor_comparison /
 *                     promo_code / free_limited / new_game_launch / season_update /
 *                     region_unlock / tutorial / pure_endorsement
 */

import axios from 'axios';
import { config } from '../../config';

interface TopicInput {
  title: string;
  description: string;
  tags: string[];
  channelName: string;
}

export interface TopicResult {
  gameName: string | null;
  gameConfidence: number;
  contentCategory: string; // dedicated_review, integrated_placement, comparison, etc.
  topicCategory: string;   // game_integration, lag_fix, booster_review, etc.
  language: string;
  market: string;
}

// ── Known game list for regex pre-screening ──
const KNOWN_GAMES = [
  'Valorant', 'AION 2', 'AION', 'ARC Raiders', 'Marvel Tōkon', 'Marvel Tokon',
  'Fortnite', 'League of Legends', 'LoL', 'Call of Duty', 'CoD', 'Warzone',
  'CS2', 'CS:GO', 'Dota 2', 'Apex Legends', 'Overwatch 2', 'PUBG',
  'R6 Siege', 'Rainbow Six', 'Genshin Impact', 'GTA V', 'GTA 5', 'GTA Online',
  'Rust', 'ARK', 'DayZ', 'Tarkov', 'Escape from Tarkov', 'EFT',
  'Minecraft', 'Roblox', 'World of Warcraft', 'WoW', 'Final Fantasy XIV', 'FFXIV',
  'Lost Ark', 'New World', 'Throne and Liberty', 'Black Desert', 'BDO',
  'Albion Online', 'EVE Online', 'Destiny 2', 'The Division 2', 'Diablo 4',
  'Path of Exile', 'PoE', 'War Thunder', 'World of Tanks', 'WoT',
  'FIFA', 'EA Sports FC', 'NBA 2K', 'Madden', 'Rocket League',
  'Deadlock', 'Spectre Divide', 'FragPunk', 'Marvel Rivals',
  'Monster Hunter Wilds', 'Elden Ring', 'Cyberpunk 2077',
];

function regexExtractGame(title: string, description: string, tags: string[]): string | null {
  const combined = `${title} ${description} ${tags.join(' ')}`;
  for (const game of KNOWN_GAMES) {
    const escaped = game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(combined)) return game;
  }
  return null;
}

function regexDetectLanguage(title: string, description: string): string {
  const combined = `${title} ${description}`;
  // Georgian (mixed titles may also contain Cyrillic — check first)
  if (/[ა-ჰ]/.test(combined)) return 'ka';
  // Belarusian (ў)
  if (/[ўЎ]/.test(combined)) return 'be';
  // Ukrainian: і/ї/є/ґ (not used in Russian) or high-signal words (и-form conjugations).
  // JS \b is ASCII-only — substring match with words Russian never contains.
  if (/[іїєґІЇЄҐ]/.test(combined) || /(насолод|погравши|пограю|вже|треба|найкращ|перемог|українськ|спробуй|увімкни|вмикай|дивись|дивимось|знайдеш|зможеш|чекай|перемагай|гравц)/i.test(combined)) return 'uk';
  // Cyrillic detection
  if (/[а-яА-ЯёЁ]/.test(combined)) return 'ru';
  // Portuguese detection
  if (/\b(como|para|mais|melhor|muito|jogar|jogo|jogos|funciona|vale|pena|cupom|desconto)\b/i.test(combined)) {
    return 'pt';
  }
  return 'en';
}

function regexDetectContentType(title: string, description: string, tags: string[]): string {
  const combined = `${title} ${tags.join(' ')}`.toLowerCase();

  if (/\b(shorts?|#shorts)\b/i.test(combined)) return 'shorts';
  if (/\b(live|livestream|streaming|live now)\b/i.test(combined)) return 'live_replay';
  if (/\b(review|test|testing|tested|honest review|first look|hands.?on)\b/i.test(combined)) return 'dedicated_review';
  if (/\b(comparison|compare|vs\.?|versus|best.*booster|which.*better|exitlag vs|gearup vs)\b/i.test(combined)) return 'comparison';
  if (/\b(tutorial|guide|how to|setup|install|configure|settings? guide)\b/i.test(combined)) return 'tutorial';

  return 'integrated_placement';
}

function regexDetectTopicCategory(title: string, description: string): string {
  const combined = `${title} ${description}`.toLowerCase();

  if (/\b(new game|new release|just launched|coming soon|release date|new season|season update|patch|update)\b/i.test(combined)) {
    return 'new_game_launch';
  }
  if (/\b(free|free to use|free trial|gratis|no cost|giveaway)\b/i.test(combined)) return 'free_limited';
  if (/\b(promo code|discount code|coupon code|use code|code .{3,15}\b)\b/i.test(combined)) return 'promo_code';
  if (/\b(unlock|region lock|region unlock|cross.?region|play from|server region|lock|跨区|锁区)\b/i.test(combined)) return 'region_unlock';
  if (/\b(reduce.*(?:lag|ping|latency)|fix.*lag|lower.*ping|lag.*fix|ping.*fix|latency.*fix|no more lag|stop lag)\b/i.test(combined)) return 'lag_fix';
  if (/\b(review|best|top|rating|ranked|tested|reviewed)\b/i.test(combined)) return 'booster_review';
  if (/\b(vs\.?|versus|compare|comparison|alternative|better than)\b/i.test(combined)) return 'competitor_comparison';
  if (/\b(tutorial|guide|how to|setup|config)\b/i.test(combined)) return 'tutorial';
  if (/\b(sponsor|partner|ambassador|affiliate)\b/i.test(combined)) return 'pure_endorsement';

  return 'game_integration';
}

// ── AI Classification ──

async function aiClassifyTopic(input: TopicInput): Promise<TopicResult> {
  const systemPrompt = `You are a gaming content classifier. Analyze the YouTube video metadata and classify it.

GAME NAMES: Identify which specific game the video is about. Use exact game names. Return null if no specific game is identifiable.

CONTENT CATEGORIES:
- dedicated_review: Full review of a booster/VPN service
- integrated_placement: Game-focused content with casual brand mention
- comparison: Comparing multiple boosters/services
- tutorial: How-to or setup guide
- shorts: YouTube Shorts vertical video
- live_replay: Live stream or VOD

TOPIC CATEGORIES:
- game_integration: Brand integrated into game discussion
- lag_fix: Focus on fixing lag/ping/latency issues
- booster_review: Reviewing/evaluating a game booster
- competitor_comparison: Comparing different boosters
- promo_code: Focus on discounts/codes
- free_limited: Free/trial/giveaway content
- new_game_launch: New game or major update
- season_update: Game season/balance patch
- region_unlock: Region-locking/unlocking
- tutorial: Step-by-step guide
- pure_endorsement: Pure sponsored endorsement

Output ONLY valid JSON — no markdown:
{
  "gameName": "Valorant" | null,
  "gameConfidence": 0.0-1.0,
  "contentCategory": "...",
  "topicCategory": "...",
  "language": "en" | "ru" | "pt",
  "market": "US" | "RU" | "BR"
}`;

  const userPrompt = `Classify this YouTube video:

TITLE: ${input.title}
CHANNEL: ${input.channelName}
TAGS: ${input.tags.join(', ')}

DESCRIPTION (first 1000 chars):
${input.description.slice(0, 1000)}`;

  const model = config.gemini.apiKey ? 'gemini-2.0-flash' : 'deepseek-v4-flash';
  const isGemini = model.startsWith('gemini');

  try {
    let rawText = '';

    if (isGemini) {
      const apiKey = config.gemini.apiKey;
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
      );
      rawText = response.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    } else {
      const response = await axios.post(
        `${config.deepseek.baseUrl}/chat/completions`,
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 512,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' as const },
        },
        {
          headers: {
            Authorization: `Bearer ${config.deepseek.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        },
      );
      rawText = response.data?.choices?.[0]?.message?.content?.trim() || '';
    }
    console.log(`[TopicClassifier] Raw response (first 300): ${rawText.slice(0, 300)}`);

    const result = parseAIJson(rawText);
    if (result) {
      return {
        gameName: (result.gameName as string) || null,
        gameConfidence: typeof result.gameConfidence === 'number' ? result.gameConfidence : 0.5,
        contentCategory: (result.contentCategory as string) || 'integrated_placement',
        topicCategory: (result.topicCategory as string) || 'game_integration',
        language: (result.language as string) || 'en',
        market: (result.market as string) || 'US',
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TopicClassifier] AI failed: ${msg}`);
  }

  // Fallback to regex
  return fallbackTopicResult(input);
}

function fallbackTopicResult(input: TopicInput): TopicResult {
  return {
    gameName: regexExtractGame(input.title, input.description, input.tags),
    gameConfidence: 0.5,
    contentCategory: regexDetectContentType(input.title, input.description, input.tags),
    topicCategory: regexDetectTopicCategory(input.title, input.description),
    language: regexDetectLanguage(input.title, input.description),
    market: ({ ru: 'RU', pt: 'BR', uk: 'UA', be: 'BY', ka: 'GE' } as Record<string, string>)[regexDetectLanguage(input.title, input.description)] || 'US',
  };
}

// ── Comment classification ──

export interface CommentClassification {
  commentId: string;
  hasPurchaseIntent: boolean;
  isBrandRelated: boolean;
  sentiment: 'positive' | 'neutral' | 'negative';
  commentCategory: 'question' | 'feedback' | 'complaint' | 'praise' | 'spam';
}

async function aiClassifyComments(
  comments: Array<{ commentId: string; text: string }>,
  brandName: string,
): Promise<CommentClassification[]> {
  if (!comments.length) return [];

  const systemPrompt = `You classify YouTube comments for brand monitoring. For each comment, determine:

- hasPurchaseIntent: Does the commenter ask about price, discounts, codes, "worth it", "does it work", or express intent to try/buy?
- isBrandRelated: Does the comment mention ${brandName} or competing products?
- sentiment: positive (praising/recommending), neutral (factual/questions), negative (complaining/trashing)
- commentCategory: question (asking something), feedback (giving opinion), complaint (negative experience), praise (positive recommendation), spam (irrelevant/promotional)

Output JSON array — one object per comment, in order.`;

  const commentsList = comments.map((c, i) => `${i + 1}. [${c.commentId}] ${c.text}`).join('\n\n');

  const userPrompt = `Classify these comments for brand "${brandName}":\n\n${commentsList}\n\nOutput: [{"commentId":"...", "hasPurchaseIntent": true/false, "isBrandRelated": true/false, "sentiment": "positive|neutral|negative", "commentCategory": "question|feedback|complaint|praise|spam"}, ...]`;

  const model = config.gemini.apiKey ? 'gemini-2.0-flash' : 'deepseek-v4-flash';
  const isGemini = model.startsWith('gemini');

  try {
    let rawText = '';

    if (isGemini) {
      const apiKey = config.gemini.apiKey;
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      rawText = response.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    } else {
      const response = await axios.post(
        `${config.deepseek.baseUrl}/chat/completions`,
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 2048,
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
      rawText = response.data?.choices?.[0]?.message?.content?.trim() || '';
    }

    const result = parseAIJson(rawText);
    if (Array.isArray(result)) {
      return result.map((c: any) => ({
        commentId: c.commentId || '',
        hasPurchaseIntent: c.hasPurchaseIntent === true,
        isBrandRelated: c.isBrandRelated === true,
        sentiment: (['positive', 'neutral', 'negative'].includes(c.sentiment) ? c.sentiment : 'neutral') as CommentClassification['sentiment'],
        commentCategory: (['question', 'feedback', 'complaint', 'praise', 'spam'].includes(c.commentCategory) ? c.commentCategory : 'feedback') as CommentClassification['commentCategory'],
      }));
    }
    // Some models wrap array in object
    if (result && typeof result === 'object' && Array.isArray((result as any).comments)) {
      return (result as any).comments.map((c: any) => ({
        commentId: c.commentId || '',
        hasPurchaseIntent: c.hasPurchaseIntent === true,
        isBrandRelated: c.isBrandRelated === true,
        sentiment: (['positive', 'neutral', 'negative'].includes(c.sentiment) ? c.sentiment : 'neutral') as CommentClassification['sentiment'],
        commentCategory: (['question', 'feedback', 'complaint', 'praise', 'spam'].includes(c.commentCategory) ? c.commentCategory : 'feedback') as CommentClassification['commentCategory'],
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TopicClassifier] Comment classification failed: ${msg}`);
  }

  return [];
}

function parseAIJson(text: string): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  const startBrace = cleaned.indexOf('{');
  const endBrace = cleaned.lastIndexOf('}');
  if (startBrace >= 0 && endBrace > startBrace) {
    try { return JSON.parse(cleaned.slice(startBrace, endBrace + 1)); } catch {}
  }
  return null;
}

/** Main entry: classify a single video's topic */
export async function classifyTopic(input: TopicInput): Promise<TopicResult> {
  return aiClassifyTopic(input);
}

/** Batch classify topics */
export async function classifyTopicsBatch(inputs: TopicInput[]): Promise<TopicResult[]> {
  const results: TopicResult[] = [];
  for (const input of inputs) {
    const result = await classifyTopic(input);
    results.push(result);
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

/** Classify comments for a video and update Supabase */
export async function classifyAndUpdateComments(
  videoId: string,
  comments: Array<{ commentId: string; text: string }>,
  brandName: string,
): Promise<number> {
  const classifications = await aiClassifyComments(comments, brandName);
  if (!classifications.length) return 0;

  const { getSupabase } = require('../../db/supabase');
  const db = getSupabase();

  let updated = 0;
  for (const c of classifications) {
    const { error } = await db
      .from('youtube_comment_insights')
      .update({
        has_purchase_intent: c.hasPurchaseIntent,
        is_brand_related: c.isBrandRelated,
        sentiment: c.sentiment,
        comment_category: c.commentCategory,
      })
      .eq('comment_id', c.commentId);

    if (!error) updated++;
  }

  console.log(`[TopicClassifier] Updated ${updated}/${classifications.length} comments for ${videoId}`);
  return updated;
}

/**
 * Analyze comments that lack AI labels (comment_category IS NULL), video by
 * video. Wired into the daily AI backlog cron so the Audience Signals page
 * fills in over time. Returns number of videos processed.
 */
export async function analyzePendingComments(limit = 10): Promise<number> {
  const { getSupabase } = require('../../db/supabase');
  const db = getSupabase();
  const { resolveBrand } = require('./data-scope');

  const { data: rows } = await db
    .from('youtube_comment_insights')
    .select('video_id')
    .is('comment_category', null)
    .limit(500);
  if (!rows?.length) return 0;

  const vids: string[] = [...new Set<string>(rows.map((r: any) => String(r.video_id)))].slice(0, limit);
  let processed = 0;
  for (const vid of vids) {
    const { data: comments } = await db
      .from('youtube_comment_insights')
      .select('comment_id,comment_text')
      .eq('video_id', vid)
      .not('comment_text', 'is', null)
      .limit(20);
    if (!comments?.length) continue;

    const { data: video } = await db
      .from('youtube_competitor_videos')
      .select('*')
      .eq('video_id', vid)
      .single();
    const brand = video ? resolveBrand(video) : 'unknown';
    const updated = await classifyAndUpdateComments(
      vid,
      comments.map((c: any) => ({ commentId: c.comment_id, text: c.comment_text })),
      brand === 'unknown' ? 'the product' : brand,
    );
    if (updated > 0) processed++;
  }
  console.log(`[TopicClassifier] analyzePendingComments done — ${processed}/${vids.length} videos analyzed`);
  return processed;
}

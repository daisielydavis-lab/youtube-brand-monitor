/**
 * Industry Gate — 硬规则前置校验（Stage ① 竞品误判修复核心）。
 *
 * 候选竞品投放必须同时满足：
 *   1. 内容属于 游戏/电竞/游戏硬件/游戏网络 相关行业
 *   2. 存在 GearUP / ExitLag / LagZapper 品牌证据
 *
 * Food / Beauty / Finance / Lifestyle / 非游戏频道 即使 Description 出现
 * affiliate link，也默认降级为 organic / unknown + brand = null，
 * 除非标题/描述明显是在推广该产品（explicitPromo）。
 *
 * 原则：只降级不升级。无法判定 → 放行（交给 AI）。
 */

// ── 游戏行业信号（强）──

const GAMING_KEYWORDS = [
  // 通用游戏词
  'gaming', 'gameplay', 'gamer', 'esports', 'esport', 'ranked', 'rank',
  'solo queue', 'duo queue', 'squad', 'twitch', 'streamer', 'stream',
  'playthrough', 'walkthrough', 'let\'s play', 'lets play', 'pvp',
  'mmorpg', 'battle royale', 'multiplayer', 'competitive', 'pro player',
  'clutch', 'headshot', 'sniper', 'boosting', 'boost', 'booster',
  'ping', 'latency', 'lag', 'packet loss', 'framerate', 'fps',
  'graphics card', 'gpu', 'rtx', 'gaming setup', 'pc build', 'gaming pc',
  'keyboard', 'controller', 'headset', 'refresh rate', 'pro settings',
  'aimbot', 'aim', 'kd', 'k/d', 'win rate', 'server', 'garena', 'riot',
  'steam', 'epic games', 'battlenet', 'xbox', 'playstation', 'nintendo',
  'cod', 'console', 'pc gaming', 'e-sports', 'tournament',
  // 热门游戏（含 KNOWN_GAMES 别名）
  'valorant', 'valo', 'fortnite', 'fn', 'cs2', 'cs:go', 'csgo',
  'counter-strike', 'counter strike', 'aion 2', 'aion2', 'aion',
  'pubg', 'battlegrounds', 'apex legends', 'apex', 'league of legends',
  'lol', 'league', 'call of duty', 'warzone', 'modern warfare', 'dota 2',
  'dota2', 'dota', 'overwatch', 'ow2', 'rainbow six', 'siege',
  'gta 5', 'gta v', 'gta online', 'gta5', 'gtav', 'minecraft',
  'rocket league', 'tarkov', 'escape from tarkov', 'rust',
  'ark survival', 'dayz', 'albion', 'lost ark', 'world of warcraft',
  'ffxiv', 'ff14', 'final fantasy', 'black desert', 'bdo', 'elden ring',
  'dead by daylight', 'dbd', 'destiny 2', 'diablo 4', 'path of exile',
  'poe', 'war thunder', 'world of tanks', 'fifa', 'ea sports fc',
  'marvel rivals', 'deadlock', 'throne and liberty', 'tibia', 'gunz',
  'wild rift', 'wildrift', 'halo', 'legend of ymir', 'ymir',
  'monster hunter', 'mh wilds', 'mhw', 'genshin', 'honkai', 'mobile legends',
  'mlbb', 'free fire', 'codm', 'call of duty mobile', 'clash royale',
  'clash of clans', 'hearthstone', 'starcraft', 'age of empires',
  'civilization', 'forza', 'need for speed', 'nfs', 'resident evil',
  'god of war', 'zelda', 'pokemon', 'smash', 'tekken', 'street fighter',
  'mortal kombat', 'roblox', 'terraria', 'stardew', 'animal crossing',
  'among us', 'fall guys', 'no man\'s sky', 'starfield', 'cyberpunk',
  'witcher', 'skyrim', 'fallout', 'red dead', 'rdr2', 'ghost of tsushima',
  'spiderman', 'spider-man', 'batman', 'elden', 'sekiro', 'bloodborne',
  'dark souls', 'diablo', 'warcraft', 'wow', 'grand theft auto',
];

// ── 非游戏行业信号（按行业分组）──

const NON_GAMING_INDUSTRIES: Array<{ category: string; keywords: string[] }> = [
  {
    category: 'food',
    keywords: [
      'recipe', 'food', 'cooking', 'cook', 'kitchen', 'bake', 'baking',
      'bakery', 'restaurant', 'meal', 'dinner', 'lunch', 'breakfast',
      'taste', 'tasting', 'mukbang', 'foodie', 'snack', 'snacks',
      'pork', 'chicken', 'beef', 'steak', 'egg', 'eggs', 'dessert',
      'eating', 'street food', 'pizza', 'noodles', 'balut', 'lechon',
      'grill', 'roasted', 'fry', 'fried', 'soup', 'sushi', 'pasta',
      'burger', 'cake', 'chocolate', 'cooking show', 'roast',
    ],
  },
  {
    category: 'beauty',
    keywords: [
      'makeup', 'beauty', 'skincare', 'skin care', 'hair', 'haircare',
      'cosmetic', 'cosmetics', 'fashion', 'outfit', 'outfits', 'nails',
      'glow', 'lipstick', 'mascara', 'serum', 'moisturizer', 'blush',
      'eyeliner', 'hairstyle',
    ],
  },
  {
    category: 'finance',
    keywords: [
      'money', 'finance', 'financial', 'invest', 'investing', 'investment',
      'trading', 'trade', 'crypto', 'cryptocurrency', 'bitcoin', 'stock',
      'stocks', 'forex', 'loan', 'loans', 'insurance', 'mortgage',
      'credit', 'debt', 'budget', 'banking', 'nft', 'passive income',
      'cash', 'dividend', 'savings', 'interest rate',
    ],
  },
  {
    category: 'lifestyle',
    keywords: [
      'vlog', 'travel', 'travelling', 'tourism', 'fitness', 'workout',
      'gym', 'diet', 'weight loss', 'prank', 'pranks', 'comedy',
      'reaction', 'routine', 'cleaning', 'organization', 'house tour',
      'gardening', 'diy', 'life', 'daily', 'morning', 'night routine',
    ],
  },
  {
    category: 'music',
    keywords: [
      'music', 'song', 'songs', 'cover', 'dj', 'edm', 'kpop', 'lyrics',
      'mv', 'album', 'playlist', 'mix', 'remix', 'concert', 'band',
      'guitar', 'piano', 'rap', 'hip hop', 'hiphop', 'trap',
    ],
  },
  {
    category: 'other_non_gaming',
    keywords: [
      'news', 'breaking', 'politics', 'election', 'weather', 'toy', 'toys',
      'nursery', 'baby', 'kids', 'phone', 'iphone', 'samsung', 'macbook',
      'review of phone', 'car', 'cars', 'driving', 'auto', 'vehicle',
      'real estate', 'house', 'home buying', 'wedding', 'photography',
    ],
  },
];

// ── 推广判定（明显在推广产品 → 放行）──

const PROMO_TITLE_WORDS = [
  'review', 'reviews', 'best', 'top', 'test', 'tested', 'booster',
  'boost', 'ping', 'lag', 'latency', 'fps', 'code', 'discount',
  'deal', 'coupon', 'how to', 'fix', 'reduce', 'lower', 'improve',
  'app', 'download', 'free trial', 'vpn', 'game booster', 'gaming',
];

export interface IndustryGateResult {
  passed: boolean;            // false → 必须降级
  category: string;           // 'gaming' | 'food' | 'beauty' | 'finance' | 'lifestyle' | 'music' | 'other_non_gaming' | 'unclear'
  blockedBy: string | null;   // 判定依据说明（供 audit）
  gamingSignals: string[];    // 命中的游戏信号
  nonGamingSignals: string[]; // 命中的非游戏信号
}

interface GateInput {
  title: string;
  description?: string;
  tags?: string[];
  channelName?: string;
}

/** 在指定文本中查找命中信号词（按优先级返回） */
function findSignals(text: string, keywords: string[]): string[] {
  const found: string[] = [];
  for (const kw of keywords) {
    const pattern = kw.includes(' ') ? kw : `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    if (new RegExp(pattern, 'i').test(text)) found.push(kw);
    if (found.length >= 5) break;
  }
  return found;
}

/** 标题是否明显在推广竞品品牌（brand 词 + 推广词） */
function isExplicitPromo(input: GateInput): boolean {
  const t = (input.title || '').toLowerCase();
  const brandInTitle = /exitlag|gear ?up|lag ?zapper/i.test(t);
  if (!brandInTitle) return false;
  return PROMO_TITLE_WORDS.some(w => {
    const pattern = w.includes(' ') ? w : `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    return new RegExp(pattern, 'i').test(t);
  });
}

/**
 * 行业硬校验入口。返回 passed=false 时，调用方必须：
 *  - placement_type 降级为 organic_mention（除非有 YouTube paid tag）
 *  - brand 解析为 null
 *  - classification_raw 写入 industryGate 标记
 */
export function evaluateIndustryGate(input: GateInput): IndustryGateResult {
  const title = (input.title || '').toLowerCase();
  const channel = (input.channelName || '').toLowerCase();
  const tags = (input.tags || []).join(' ').toLowerCase();
  const desc = (input.description || '').toLowerCase();

  // 强游戏信号：标题 / 频道名 / 标签 命中（描述不算强信号，affiliate 垃圾链接常在描述里）
  const titleChannelTags = `${title} ${channel} ${tags}`;
  const gamingSignals = findSignals(titleChannelTags, GAMING_KEYWORDS);

  if (gamingSignals.length > 0) {
    return {
      passed: true, category: 'gaming', blockedBy: null,
      gamingSignals, nonGamingSignals: [],
    };
  }

  // 明显推广竞品产品 → 放行（标题含品牌名 + 推广词）
  if (isExplicitPromo(input)) {
    return {
      passed: true, category: 'gaming', blockedBy: null,
      gamingSignals: [], nonGamingSignals: [],
    };
  }

  // 非游戏行业信号：标题 / 频道名（描述不可靠）
  const titleChannel = `${title} ${channel}`;
  for (const industry of NON_GAMING_INDUSTRIES) {
    const hits = findSignals(titleChannel, industry.keywords);
    if (hits.length > 0) {
      return {
        passed: false, category: industry.category,
        blockedBy: `title/channel matches ${industry.category}: ${hits.slice(0, 3).join(', ')}`,
        gamingSignals: [], nonGamingSignals: hits,
      };
    }
  }

  // 无法判定 → 放行（保守，交给 AI）
  return {
    passed: true, category: 'unclear', blockedBy: null,
    gamingSignals: [], nonGamingSignals: [],
  };
}

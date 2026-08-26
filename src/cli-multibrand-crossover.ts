/**
 * CLI — Multi-brand Creator Crossover 候选评分（Experimental D，只读）
 *
 * 立项（2026-08-26 拍板）：投过 ≥2 个网络优化器品牌（GearUP/ExitLag/Lagofast）
 * 的 creator 是 LagZapper 的交叉候选——「商业行为相似」而非「频道内容相似」。
 *
 * 候选定义：
 *   过去 180 天有 confirmed/likely 投放，涉及 ≥2 个优化器品牌，
 *   且从未命中 LagZapper（不在 LZ watchlist、无 LZ confirmed/likely 投放）。
 *
 * 评分：
 *   +3  投过 3 个及以上竞品
 *   +2  投过 2 个竞品
 *   +2  RU/CIS creator（language=ru / market=RU / 频道名含西里尔）
 *   +1  最近 90 天仍有竞品合作
 *   +1  FPS/MMO 相关频道（game_name 命中关键词表）
 *
 * 输出 Top 30 高分候选，供人工确认后做一轮 channel_scan 验证命中率。
 * 命中率 ≥20% 可转正式 Discovery Strategy；0 命中则关闭。
 *
 * Usage: npm run crossover:multibrand
 */

import { getSupabase } from './db/supabase';
import { canonicalBrand } from './services/competitor-monitor/brand-normalization';

const PLACEMENTS = ['confirmed_paid_placement', 'likely_sponsored'];
const OPT_BRANDS = ['GearUP', 'ExitLag', 'Lagofast'];
const NINETY = new Date(Date.now() - 90 * 86400000).toISOString();
const ONE_EIGHTY = new Date(Date.now() - 180 * 86400000).toISOString();
const CYRILLIC = /[Ѐ-ӿ]/;

const FPS_MMO = [
  'pubg', 'valorant', 'apex', 'fortnite', 'cs2', 'counter-strike', 'counter strike', 'overwatch',
  'rainbow six', 'r6', 'call of duty', 'cod', 'warzone', 'delta force', 'gta', 'rocket league',
  'world of warcraft', 'wow', 'lost ark', 'aion', 'lineage', 'dota', 'league of legends', 'lol',
  'mobile legends', 'mlbb', 'genshin', 'warframe', 'destiny', 'escape from tarkov', 'tarkov',
  'rust', 'squad', 'war thunder', 'world of tanks', 'albion', 'bdo', 'black desert', 'eve',
  'throne and liberty', 'ascent', 'hyper scape',
];

interface Channel {
  channelId: string;
  name: string;
  brands: Set<string>;       // confirmed/likely 的优化器品牌
  brandVideos: number;
  lang: string;
  market: string;
  ru: boolean;
  active90: boolean;          // 90 天内仍有竞品合作
  fpsMmo: boolean;
  games: string[];
  lastAt: string;
}

async function main() {
  const db = getSupabase();

  // 全量视频（分页）
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos')
      .select('video_id,title,description,channel_id,channel_name,language,market,game_name,placement_type,canonical_brand,raw_brand,published_at')
      .range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  // 排除：已在 LZ watchlist（扫过、0 命中或已监控）或已有 LZ confirmed/likely
  const { data: watch } = await db.from('youtube_creator_watchlist').select('channel_id').eq('brand', 'LagZapper');
  const lzWatch = new Set((watch || []).map(w => w.channel_id));

  const chan = new Map<string, Channel>();
  const lzHit = new Set<string>();
  for (const v of all) {
    if (!PLACEMENTS.includes(v.placement_type)) continue;
    const brand = canonicalBrand(v.canonical_brand || v.raw_brand);
    if (!brand) continue;
    const at = v.published_at || v.first_seen_at || '';
    if (at < ONE_EIGHTY) continue;
    const c: Channel = chan.get(v.channel_id) || {
      channelId: v.channel_id, name: v.channel_name || v.channel_id,
      brands: new Set<string>(), brandVideos: 0, lang: v.language || '?', market: v.market || '?',
      ru: v.language === 'ru' || v.market === 'RU' || CYRILLIC.test(v.channel_name || ''),
      active90: false, fpsMmo: false, games: [], lastAt: '',
    };
    if (at > c.lastAt) c.lastAt = at;
    if (brand === 'LagZapper') { lzHit.add(v.channel_id); continue; }
    if (!OPT_BRANDS.includes(brand)) continue;
    c.brands.add(brand);
    c.brandVideos++;
    if (at >= NINETY) c.active90 = true;
    const g = v.game_name ? String(v.game_name) : '';
    if (g && FPS_MMO.some(k => g.toLowerCase().includes(k))) c.fpsMmo = true;
    if (g && !c.games.includes(g)) c.games.push(g);
    chan.set(v.channel_id, c);
  }

  // 评分 + 筛选
  const scored: any[] = [];
  for (const c of chan.values()) {
    if (c.brands.size < 2) continue;                 // 必须 ≥2 个优化器品牌
    if (lzWatch.has(c.channelId) || lzHit.has(c.channelId)) continue; // 从未命中 LZ
    let score = 0;
    const parts: string[] = [];
    if (c.brands.size >= 3) { score += 3; parts.push('3+竞品+3'); }
    else if (c.brands.size === 2) { score += 2; parts.push(`2竞品+2`); }
    if (c.ru) { score += 2; parts.push('RU+2'); }
    if (c.active90) { score += 1; parts.push('90d活跃+1'); }
    if (c.fpsMmo) { score += 1; parts.push('FPS/MMO+1'); }
    scored.push({ ...c, score, parts, brandsList: [...c.brands].join('/') });
  }
  scored.sort((a, b) => b.score - a.score || b.brandVideos - a.brandVideos);

  console.log(`═══ Multi-brand Creator Crossover 候选（Experimental D）═══\n`);
  console.log(`全库视频 ${all.length} | 180d confirmed/likely 优化器品牌视频频道 ${chan.size} | ≥2 品牌候选 ${scored.length}\n`);
  const top = scored.slice(0, 30);
  console.log(`Top ${top.length}（按评分）：`);
  for (const c of top) {
    const ru = c.ru ? 'RU' : c.market;
    const act = c.active90 ? '近90d活跃' : '';
    const g = c.games.slice(0, 3).join(',');
    console.log(`  [${String(c.score).padStart(3)}] ${c.name.slice(0, 26).padEnd(26)} 品牌:${c.brandsList.padEnd(18)} ${String(c.brandVideos).padStart(2)}条 ${ru.padEnd(4)} ${act.padEnd(6)} ${c.fpsMmo ? 'FPS/MMO ' : ''}${c.parts.join(' ')}`);
    if (g) console.log(`       游戏: ${g}`);
  }
  const scoreDist: Record<string, number> = {};
  for (const c of scored) scoreDist[c.score] = (scoreDist[c.score] || 0) + 1;
  console.log(`\n评分分布(全部 ${scored.length} 候选): ${JSON.stringify(Object.keys(scoreDist).sort().map(s => `${s}分×${scoreDist[s]}`).join(' | '))}`);
  console.log(`\n下一步: 人工确认 Top 20-30 后跑 channel_scan 验证命中率。≥20% 转正式，0 关闭。`);
}

main().catch(e => { console.error(e); process.exit(1); });

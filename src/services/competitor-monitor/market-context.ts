/**
 * Market Context — 从库内拼 MarketContext，供 index.ts / CLI / retry 复用。
 *
 * 与 market-inference.ts 分离：本文件是 DB loader，market-inference 保持纯函数。
 * 全部数据来自库内现有字段，不重新 Search、不调 AI：
 *   - youtube_creator_profiles.country                    → channelCountry
 *   - 该 channel 已确认投放视频(confirmed/likely)的 market → creatorHistoryMarkets
 *   - competitor_queries 的 target_market/target_language → discoveryHint
 *
 * 2026-08-29 P1：⚠️ competitor_queries 的 upsert 历史只写 query_text+last_run_at，
 * target_language/target_market 停留在 DB 默认 'en'/'US' —— discovery_hint 对旧行
 * 几乎无效(防强猜规则会忽略 en/US)。index.ts 已补写真实 target(见 getActiveQueries
 * 对应 upsert 站点)，后续 query 重跑后 hint 才生效。backfill 阶段主要依赖
 * channel_country / language / explicit_localization / creator_history。
 */
import type { MarketContext } from './market-inference';

export interface MarketContextEntry {
  channelId: string;
  discoveryQueryId?: string | null;
  discoveryQueryText?: string | null;
}

interface Hint { market?: string | null; language?: string | null }

async function chunked(ids: string[], fn: (chunk: string[]) => Promise<any[]>): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    out.push(...(await fn(chunk)));
  }
  return out;
}

export async function buildMarketContexts(
  db: any,
  entries: MarketContextEntry[],
  opts?: { historyOverride?: Map<string, string[]> | null },
): Promise<Map<string, MarketContext>> {
  const out = new Map<string, MarketContext>();
  if (!entries.length) return out;

  const channelIds = [...new Set(entries.map(e => e.channelId).filter((x): x is string => !!x))];

  // 1. 频道国家
  const countryByChannel = new Map<string, string | null>();
  if (channelIds.length) {
    const rows = await chunked(channelIds, async chunk => {
      const { data } = await db.from('youtube_creator_profiles').select('channel_id, country').in('channel_id', chunk);
      return data || [];
    });
    for (const row of rows) countryByChannel.set(row.channel_id, row.country || null);
  }

  // 2. creator 历史已确认投放市场的多数票
  //    backfill 场景：用调用方传入的 override（基于本轮新算 market，避免旧 US 虚高污染历史票）。
  //    正常 pipeline 场景：读 DB 列（旧行在 backfill 前可能仍是 legacy US，属已知限制）。
  const historyByChannel = new Map<string, string[]>();
  if (opts?.historyOverride) {
    for (const [ch, mks] of opts.historyOverride) historyByChannel.set(ch, mks);
  } else if (channelIds.length) {
    const rows = await chunked(channelIds, async chunk => {
      const { data } = await db.from('youtube_competitor_videos')
        .select('channel_id, market')
        .in('channel_id', chunk)
        .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
        .not('market', 'is', null);
      return data || [];
    });
    for (const row of rows) {
      const mk = row.market;
      if (!mk || mk === 'Unknown') continue;
      if (!historyByChannel.has(row.channel_id)) historyByChannel.set(row.channel_id, []);
      historyByChannel.get(row.channel_id)!.push(mk);
    }
  }

  // 3. discovery hint（按 id 优先，其次按 query_text）
  const hintById = new Map<string, Hint>();
  const hintByText = new Map<string, Hint>();
  const queryIds = [...new Set(entries.map(e => e.discoveryQueryId).filter((x): x is string => !!x))];
  if (queryIds.length) {
    const rows = await chunked(queryIds, async chunk => {
      const { data } = await db.from('competitor_queries').select('id, target_market, target_language').in('id', chunk);
      return data || [];
    });
    for (const row of rows) hintById.set(row.id, { market: row.target_market, language: row.target_language });
  }
  const queryTexts = [...new Set(entries.map(e => e.discoveryQueryText).filter((x): x is string => !!x))];
  if (queryTexts.length) {
    // 表小：全量拉 + JS 过滤（免疫 PostgREST in() 引号解析坑）
    const { data } = await db.from('competitor_queries').select('query_text, target_market, target_language');
    for (const row of (data || [])) hintByText.set(row.query_text, { market: row.target_market, language: row.target_language });
  }

  for (const e of entries) {
    if (!e.channelId) continue;
    const hint =
      (e.discoveryQueryId && hintById.get(e.discoveryQueryId)) ||
      (e.discoveryQueryText && hintByText.get(e.discoveryQueryText)) ||
      null;
    out.set(e.channelId, {
      channelCountry: countryByChannel.get(e.channelId) ?? null,
      creatorHistoryMarkets: historyByChannel.get(e.channelId) || [],
      discoveryHint: hint || null,
    });
  }
  return out;
}

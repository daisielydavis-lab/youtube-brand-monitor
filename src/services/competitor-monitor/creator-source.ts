/**
 * Creator Source Resolution — 博主发现来源透明化 (2026-08-24)
 *
 * 背景: 竞品投放发现 = Search + Creator Network + Affiliate Identity 三层。
 * 每个 creator 从哪条路径被捞进监控, 目前散在 watchlist.discovered_via
 * 和视频 discovery_method 两处。本模块统一解析成「来源桶」, 供 dashboard
 * 显示博主来源分布 (投放博主 tab 每行来源 + 联盟身份 tab 每品牌分布)。
 *
 * 解析规则 (按优先级):
 *   1. watchlist.discovered_via 命中 → 直接采用
 *      (affiliate_cluster / video_backtrace / manual_seed / ai_confirmed / similar_creator)
 *   2. 不在 watchlist, 但有视频 → 取最早 first_seen 视频的 discovery_method:
 *      keyword_search / domain_search / paid_placement_tag → 'search' (搜索发现)
 *      channel_scan → 'watchlist' (频道扫描/监控回扫)
 *   3. 兜底 → 'unknown'
 */

import { COMPETITOR_BRANDS } from './data-scope';

export type CreatorSource =
  | 'search' | 'watchlist'
  | 'affiliate_cluster' | 'video_backtrace' | 'manual_seed' | 'ai_confirmed'
  | 'similar_creator' | 'unknown';

/** 与 /api/creator-sources 输出顺序一致的展示标签 (dashboard) */
export const SOURCE_ORDER: CreatorSource[] = [
  'search', 'watchlist', 'affiliate_cluster', 'video_backtrace', 'manual_seed', 'ai_confirmed', 'similar_creator', 'unknown',
];

export const SOURCE_LABEL: Record<CreatorSource, string> = {
  search: '搜索', watchlist: '频道扫描',
  affiliate_cluster: '联盟簇', video_backtrace: '回溯源', manual_seed: '种子', ai_confirmed: 'AI确认',
  similar_creator: '相似博主', unknown: '未知',
};

const METHOD_TO_SOURCE: Record<string, CreatorSource> = {
  keyword_search: 'search', domain_search: 'search', paid_placement_tag: 'search',
  channel_scan: 'watchlist',
};

export interface CreatorSourceEntry { source: CreatorSource; brand: string | null }

/** 全量加载 channel → 来源 (watchlist 优先, 视频 discovery_method 兜底)。
 *  单次扫描 watchlist + 视频池两表, 供 creator 列表和来源分布复用。 */
export async function loadCreatorSourceMap(db: any): Promise<Map<string, CreatorSourceEntry>> {
  const map = new Map<string, CreatorSourceEntry>();

  // 1. watchlist.discovered_via (权威)
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_creator_watchlist')
      .select('brand,channel_id,discovered_via').range(from, from + 999);
    if (!data?.length) break;
    for (const w of data) {
      const via = (w.discovered_via || 'unknown') as CreatorSource;
      map.set(w.channel_id, { source: via, brand: w.brand || null });
    }
    if (data.length < 1000) break;
  }

  // 2. 不在 watchlist 的 channel → 最早视频的 discovery_method
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos')
      .select('channel_id,canonical_brand,discovery_method,first_seen_at').range(from, from + 999);
    if (!data?.length) break;
    for (const v of data) {
      if (map.has(v.channel_id)) continue; // watchlist 已权威
      const s = METHOD_TO_SOURCE[v.discovery_method];
      if (!s) continue;
      const ts = v.first_seen_at ? new Date(v.first_seen_at).getTime() : 0;
      const existing = map.get(v.channel_id);
      if (!existing || (existing.source === 'unknown') || (ts && ts < (existing as any).__ts)) {
        map.set(v.channel_id, { source: s, brand: v.canonical_brand || null, __ts: ts } as any);
      }
    }
    if (data.length < 1000) break;
  }
  // 去掉 __ts 辅助字段, 只留 source/brand
  for (const [k, v] of map) {
    if ((v as any).__ts !== undefined) {
      map.set(k, { source: v.source, brand: v.brand });
    }
  }
  return map;
}

/** 每品牌来源分布 (creator 网络口径: watchlist + 有品牌归属的视频 channel)。
 *  供 /api/creator-sources 使用。 */
export async function creatorSourceBuckets(db: any): Promise<Array<{ brand: string; total: number; buckets: Record<CreatorSource, number> }>> {
  const map = await loadCreatorSourceMap(db);

  // 每品牌统计: watchlist 直接计; 视频 channel 按 canonical_brand 计 (去重)
  const byBrand = new Map<string, Record<CreatorSource, number>>();
  for (const brand of COMPETITOR_BRANDS) byBrand.set(brand, emptyBuckets());

  for (const [cid, e] of map) {
    const b = e.brand && COMPETITOR_BRANDS.includes(e.brand as any) ? e.brand : null;
    if (b) {
      const rec = byBrand.get(b)!;
      rec[e.source] = (rec[e.source] || 0) + 1;
    }
  }
  // 兜底: 无品牌归属的 channel 不归任何品牌 (来源分布只统计有品牌上下文的)
  return [...byBrand.entries()].map(([brand, buckets]) => ({
    brand,
    total: SOURCE_ORDER.reduce((s, k) => s + (buckets[k] || 0), 0),
    buckets,
  }));
}

function emptyBuckets(): Record<CreatorSource, number> {
  const o = {} as Record<CreatorSource, number>;
  for (const k of SOURCE_ORDER) o[k] = 0;
  return o;
}

/** 单 channel 的来源 (供 getCreatorsFromVideos 复用已加载的 map) */
export function resolveChannelSource(map: Map<string, CreatorSourceEntry>, channelId: string): CreatorSource {
  return map.get(channelId)?.source || 'unknown';
}

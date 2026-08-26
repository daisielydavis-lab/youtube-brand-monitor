/**
 * CLI — 品牌信号统计（只读）
 *
 * 全库 90 天 LagZapper 信号视频统计：总数 / 频道数 / 按发现方式 / 按市场。
 * 用于快速判断 DB 覆盖是否退化（配合 cli-recall-diagnostics 对比搜索召回）。
 *
 * 由 count-tmp.ts 重构而来（2026-08-24）。信号口径：
 *   标题/描述含 lagzapper / lag zapper / 西里尔变体 / lagzapper.com 域名。
 *
 * Usage: npm run brand:counts
 */

import { getSupabase } from './db/supabase';

const NINETY = new Date(Date.now() - 90 * 86400000).toISOString();
const CYC = ['лаг заппер', 'лагзаппер', 'лаг-заппер', 'лагзапер'];

function hasLzSignal(v: any): boolean {
  const t = (v.title || '').toLowerCase();
  const d = (v.description || '').toLowerCase();
  return t.includes('lagzapper') || t.includes('lag zapper')
    || d.includes('lagzapper') || d.includes('lag zapper')
    || CYC.some(c => t.includes(c) || d.includes(c))
    || d.includes('lagzapper.com');
}

async function main() {
  const db = getSupabase();
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos')
      .select('video_id,title,description,channel_id,channel_name,language,market,published_at,discovery_method')
      .range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  const db90 = all.filter(v => (v.published_at || '') >= NINETY);
  const lz90 = db90.filter(hasLzSignal);
  const byMethod: Record<string, number> = {};
  const byMkt: Record<string, number> = {};
  for (const v of lz90) {
    const method = v.discovery_method || 'keyword_search';
    byMethod[method] = (byMethod[method] || 0) + 1;
    const mkt = v.market || v.language || '?';
    byMkt[mkt] = (byMkt[mkt] || 0) + 1;
  }
  const chans = new Set(lz90.map(v => v.channel_id));

  console.log(`全库 ${all.length} | 90天 ${db90.length} | 90天 LZ 信号 ${lz90.length} 条 / ${chans.size} 频道`);
  console.log(`按发现方式: ${JSON.stringify(byMethod)}`);
  console.log(`按市场: ${JSON.stringify(byMkt)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

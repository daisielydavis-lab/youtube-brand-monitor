/**
 * CLI: 种子基准样本（Ground Truth）→ recall_benchmark
 * 2026-08-16 用户验收点 #2：从库内 Layer 3 已确认投放自动种子（幂等），
 * 人工补充 50-100 条后用于 Recall 计算。
 *
 * 种子来源（全部幂等，可反复跑）：
 *   1. 已确认/疑似投放 + AI brand=LagZapper 的视频（自动）
 *   2. 反例 expected=false 不自动种子（人工加）
 *
 * 用法：npx ts-node src/cli-seed-benchmark.ts
 * 前置：supabase-migration-watchlist.sql 已跑（recall_benchmark 表存在）
 */
import { getSupabase } from './db/supabase';

async function main() {
  const db = getSupabase();

  // 检查表存在（migration 未跑 → 报错退出，不静默 0 行）
  const probe = await db.from('recall_benchmark').select('video_id', { count: 'exact', head: true }).limit(1);
  if (probe.error) {
    console.error(`❌ recall_benchmark 不存在（先跑 supabase-migration-watchlist.sql）：${probe.error.message}`);
    process.exit(1);
  }

  // ① 自动种子：AI 确认 LagZapper 投放（品牌严格匹配 LagZapper）
  const { data: confirmed, error: e1 } = await db.from('youtube_competitor_videos')
    .select('video_id, brand_id, market, classification_raw')
    .in('placement_type', ['confirmed_paid_placement', 'likely_sponsored'])
    .gte('first_seen_at', new Date(Date.now() - 120 * 86400000).toISOString());
  if (e1) { console.error(`❌ 查询投放失败：${e1.message}`); process.exit(1); }

  let autoSeeded = 0;
  const rows: Array<{ video_id: string; brand: string; market: string | null; note: string }> = [];
  for (const v of (confirmed || [])) {
    // brand 口径：顶层 brand_id（如 'lagzapper'）或 AI classification_raw 品牌
    const aiBrand = v.classification_raw?.ai?.brand || null;
    const brand = aiBrand || (v.brand_id === 'lagzapper' ? 'LagZapper' : null);
    if (brand !== 'LagZapper') continue;
    rows.push({ video_id: v.video_id, brand: 'LagZapper', market: v.market || null, note: 'auto_seed_ai_confirmed' });
  }

  if (rows.length) {
    const { error } = await db.from('recall_benchmark')
      .upsert(rows, { onConflict: 'video_id', ignoreDuplicates: true });
    if (error) { console.error(`❌ 种子写入失败：${error.message}`); process.exit(1); }
    autoSeeded = rows.length;
  }

  // 统计当前基准规模（含人工加的）
  const { count, error: e2 } = await db.from('recall_benchmark')
    .select('video_id', { count: 'exact', head: true })
    .eq('expected', true);
  if (e2) console.warn(`⚠ 统计失败：${e2.message}`);
  const brands = await db.from('recall_benchmark').select('brand, market');

  console.log(`✅ 自动种子 ${autoSeeded} 条 LagZapper 确认投放`);
  console.log(`当前基准总数（expected=true）：${count ?? '?'} 条`);
  const byBrand: Record<string, number> = {};
  (brands.data || []).forEach((b: any) => { byBrand[b.brand] = (byBrand[b.brand] || 0) + 1; });
  console.log(`品牌分布：${JSON.stringify(byBrand)}`);
  console.log('---');
  console.log('人工补充 Ground Truth 提示（目标 50-100 条 LagZapper RU）：');
  console.log('  INSERT INTO recall_benchmark (video_id, brand, market, expected, miss_reason, note)');
  console.log('  VALUES (\'<video_id>\', \'LagZapper\', \'RU\', true, NULL, \'manual_ground_truth\');');
  console.log('  反例（系统不该抓的）：expected=false。');
}

main().catch(err => { console.error('Seed failed:', err); process.exit(1); });

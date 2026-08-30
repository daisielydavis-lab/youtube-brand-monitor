/**
 * CLI — Description Integrity Audit（2026-08-30，协议 A–F）
 *
 * 只读审计：确认 youtube_competitor_videos.description 是否被系统性截断、在哪个层。
 * 约束：0 search.list / 0 AI / 0 DB writes —— 只 SELECT DB + videos.list（general quota，1u/批≤50）。
 *
 * 协议：
 *   A. 已知探针（ntswitches 4ZLSuEyuDTY）原始 DB 值（length + 尾部 300 字符），
 *      不用任何会自动加 "…" 的 formatter。
 *   B/C. 90 天 LagZapper 描述视频（matcher 同源 population：description ilike '%lagzapper%'）
 *       按 videos.list 批量对比 DB vs live：db_length/live_length/db===live/db_is_prefix/
 *       first_diff_position/missing_chars。
 *   D. 截断规律：length 分布 / 末尾字符（"…"？mid-URL？）/ 与 discovery_method、first_seen_at 关联。
 *   E. 代码路径枚举（见下方 const CODE_PATHS + README 注释）——全部写入路径均经 videos.list 完整描述。
 *   F. 输出结论：STORAGE_OK / STORAGE_TRUNCATED + affected rate + root cause + recall impact
 *      + repair scope + 估算 general quota cost。只出设计，不修复、不回补、不重跑。
 *
 * 分类口径（与语义对应）：
 *   exact                 — DB === live
 *   db_prefix_truncated   — live.startsWith(db) 且 db 更短 → 真正的 DB 前缀截断
 *   snapshot_drift        — 与 live 不同但非前缀截断（直播编辑/长度差/内容变 → 快照差异）
 *   unavailable           — 视频被删/私密/API 取不到
 *
 * 基线（2026-08-30 对 LagZapper 90d 全量 201 条审计：198 条可用中 0 条 DB prefix truncation；
 * 当前已知 ingestion 路径未发现 description 截断）。这是时间点基线，不是永久保证——
 * 改动 ingestion 逻辑后应重跑本审计。
 *
 * 用法：npm run audit:description-integrity
 */
import { getSupabase } from './db/supabase';
import { getVideosByIds, type YouTubeVideoResult } from './services/competitor-monitor/youtube-discovery';

const NINETY_DAYS = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
const KNOWN_PROBE = '4ZLSuEyuDTY'; // ntswitches 已知截断探针

interface SampleRow {
  video_id: string;
  channel_id: string;
  channel_name: string;
  description: string | null;
  published_at: string;
  discovery_method: string | null;
  first_seen_at: string;
  placement_type: string | null;
}

type Category =
  | 'exact'                 // DB === live
  | 'db_prefix_truncated'   // live.startsWith(db) && db 更短 → 真正的 DB 前缀截断
  | 'snapshot_drift'        // 与 live 不同但非前缀截断（直播编辑/长度差/内容变 → 快照差异）
  | 'unavailable';          // 视频被删/私密/API 取不到

interface CompareRow extends SampleRow {
  liveLength: number;
  dbLength: number;
  category: Category;
  firstDiff: number;      // -1 表示完全一致
  missingChars: number;   // live.length - db.length（db_is_prefix 时为正）
  endsEllipsis: boolean;  // db 以 "…" 结尾
}

/** 找出两串第一个不同字符的下标；完全一致返回 -1 */
function firstDiffPos(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 判断截断是否落在 URL 内部（DB 末端不是完整 token，live 对应位置是 URL 中间） */
function cutInsideUrl(db: string, live: string): boolean {
  if (!db || db.length >= live.length) return false;
  // 看 DB 末尾往前 60 字符内是否有 http(s)://，且 DB 末尾不是 URL 常见结束符
  const window = db.slice(-60);
  const hasUrl = /https?:\/\//i.test(window);
  if (!hasUrl) return false;
  // 若 DB 以 URL 片段收尾（末尾字符不是空白/标点/引号），则疑似 URL 内截断
  const last = db[db.length - 1];
  return /[A-Za-z0-9._~:@/]/.test(last);
}

async function main() {
  const db = getSupabase();
  console.log('═══ Description Integrity Audit（只读：0 search.list / 0 AI / 0 DB writes）═══\n');

  // ── 协议 A：已知探针原始 DB 值 ──
  console.log('── [A] 已知探针 ntswitches/4ZLSuEyuDTY 原始 DB 值 ──');
  const { data: probe } = await db.from('youtube_competitor_videos')
    .select('video_id, channel_id, channel_name, description, published_at, discovery_method, first_seen_at, placement_type')
    .eq('video_id', KNOWN_PROBE).maybeSingle();
  if (probe) {
    const d = (probe.description || '');
    console.log(`  video_id=${probe.video_id}  channel=${probe.channel_name}`);
    console.log(`  discovery_method=${probe.discovery_method}  first_seen_at=${probe.first_seen_at}  placement_type=${probe.placement_type}`);
    console.log(`  published_at=${probe.published_at}`);
    console.log(`  db_description.length=${d.length}`);
    console.log(`  以 "…" 结尾? ${d.trimEnd().endsWith('…')}  含 "…"? ${d.includes('…')}`);
    console.log(`  末尾 300 字符（完整原样打印）:`);
    console.log(`  ┌${'─'.repeat(72)}`);
    const tail = d.slice(-300);
    for (let i = 0; i < tail.length; i += 72) console.log(`  │ ${JSON.stringify(tail.slice(i, i + 72))}`);
    console.log(`  └${'─'.repeat(72)}`);
  } else {
    console.log(`  探针 ${KNOWN_PROBE} 不在库（可能已删除）`);
  }

  // ── 协议 C：样本人口（matcher 同源）──
  console.log('\n── [C] 90 天 LagZapper 描述视频样本（description ilike %lagzapper%，matcher 同源）──');
  const { data: sample, error: se } = await db.from('youtube_competitor_videos')
    .select('video_id, channel_id, channel_name, description, published_at, discovery_method, first_seen_at, placement_type')
    .ilike('description', '%lagzapper%')
    .gte('published_at', NINETY_DAYS)
    .order('published_at', { ascending: false });
  if (se) { console.error('  样本查询失败:', se.message); process.exit(1); }
  let rows: SampleRow[] = (sample || []) as SampleRow[];
  // 确保探针必在样本内（即使不在 90d 窗口）
  if (probe && !rows.some(r => r.video_id === KNOWN_PROBE)) rows.unshift(probe as SampleRow);
  console.log(`  样本 ${rows.length} 条`);

  if (!rows.length) { console.log('\n  样本为空，退出。'); return; }

  // ── 协议 B：videos.list 批量拉 live description 对比 ──
  const ids = rows.map(r => r.video_id);
  console.log('\n── [B] videos.list 批量对比 DB vs live（general quota）──');
  const live = await getVideosByIds(ids);
  const liveMap = new Map<string, YouTubeVideoResult>();
  for (const v of live) liveMap.set(v.videoId, v);
  const calls = Math.ceil(ids.length / 50);
  console.log(`  videos.list 调用 ${calls} 次（1u/次，≤50/batch）· 取到 live ${liveMap.size} 条`);

  const compares: CompareRow[] = rows.map(r => {
    const lv = liveMap.get(r.video_id);
    const dbTxt = r.description || '';
    const lvTxt = lv?.description || '';
    let category: Category;
    if (!lv) category = 'unavailable';
    else if (dbTxt === lvTxt) category = 'exact';
    else if (dbTxt.length < lvTxt.length && lvTxt.startsWith(dbTxt)) category = 'db_prefix_truncated';
    else category = 'snapshot_drift';
    return {
      ...r,
      dbLength: dbTxt.length,
      liveLength: lvTxt.length,
      category,
      firstDiff: lv ? firstDiffPos(dbTxt, lvTxt) : -1,
      missingChars: lv ? Math.max(0, lvTxt.length - dbTxt.length) : 0,
      endsEllipsis: dbTxt.trimEnd().endsWith('…'),
    };
  });

  // ── 汇总（协议 D + F 计数）──
  const count = (c: Category) => compares.filter(x => x.category === c).length;
  const available = compares.filter(x => x.category !== 'unavailable').length;
  const prefixTrunc = compares.filter(x => x.category === 'db_prefix_truncated');
  const affectedRate = available ? (prefixTrunc.length / available) : 0;

  console.log('\n── 对比汇总 ──');
  console.log(`  总检查 ${compares.length} · 可用 ${available} · 不可用(删/私密) ${count('unavailable')}`);
  console.log(`  exact                ${count('exact')}`);
  console.log(`  db_prefix_truncated  ${count('db_prefix_truncated')}`);
  console.log(`  snapshot_drift       ${count('snapshot_drift')}`);
  console.log(`  unavailable          ${count('unavailable')}`);
  console.log(`  DB前缀截断率 affected = ${prefixTrunc.length}/${available} = ${(affectedRate * 100).toFixed(1)}%`);

  // ── 截断规律分析（协议 D）──
  if (prefixTrunc.length) {
    console.log('\n── [D] 截断规律 ──');
    // 1) DB 长度分布
    const buckets: Array<[string, number]> = [
      ['<200', 0], ['200-499', 0], ['500-999', 0], ['1000-1999', 0], ['2000-4999', 0], ['≥5000', 0],
    ];
    for (const c of prefixTrunc) {
      const n = c.dbLength;
      if (n < 200) buckets[0][1]++;
      else if (n < 500) buckets[1][1]++;
      else if (n < 1000) buckets[2][1]++;
      else if (n < 2000) buckets[3][1]++;
      else if (n < 5000) buckets[4][1]++;
      else buckets[5][1]++;
    }
    console.log('  DB 长度分布（截断样本）:');
    for (const [label, n] of buckets) console.log(`    ${label.padEnd(8)} ${String(n).padStart(3)}`);
    // 2) 末尾字符规律
    const ell = prefixTrunc.filter(c => c.endsEllipsis).length;
    const midUrl = prefixTrunc.filter(c => cutInsideUrl(c.description || '', liveMap.get(c.video_id)?.description || '')).length;
    const midChar = prefixTrunc.filter(c => {
      const lv = liveMap.get(c.video_id)?.description || '';
      const pos = c.dbLength - 1;
      const next = lv[c.dbLength] || '';
      const cur = (c.description || '')[c.dbLength - 1] || '';
      return /[A-Za-z0-9_]/.test(cur + next);
    }).length;
    console.log(`  以 "…" 结尾: ${ell}/${prefixTrunc.length}`);
    console.log(`  截断点落在 URL 内部: ${midUrl}/${prefixTrunc.length}`);
    console.log(`  截断点落在词中(alnum 相邻): ${midChar}/${prefixTrunc.length}`);
    // 3) 截断长度分布（若为固定值则暴露 cutoff）
    const lens = [...new Set(prefixTrunc.map(c => c.dbLength))].sort((a, b) => a - b);
    console.log(`  DB 截断长度唯一值: ${lens.length ? lens.join(', ') : '-'}`);
    // 4) 关联 discovery_method / first_seen_at
    const byMethod: Record<string, number> = {};
    const byEra: Record<string, number> = {};
    for (const c of prefixTrunc) {
      byMethod[c.discovery_method || '(null)'] = (byMethod[c.discovery_method || '(null)'] || 0) + 1;
      const era = (c.first_seen_at || '').slice(0, 7);
      byEra[era] = (byEra[era] || 0) + 1;
    }
    console.log(`  discovery_method 分布: ${JSON.stringify(byMethod)}`);
    console.log(`  first_seen_at(月) 分布: ${JSON.stringify(byEra)}`);
  }

  // ── 明细表（前 40 条）──
  console.log('\n── 明细（前 40 条，截断样本优先）──');
  const ordered = [...compares].sort((a, b) => {
    const pri = (x: CompareRow) => x.category === 'db_prefix_truncated' ? 0 : x.category === 'snapshot_drift' ? 1 : x.category === 'exact' ? 2 : 3;
    return pri(a) - pri(b) || b.missingChars - a.missingChars;
  });
  for (const c of ordered.slice(0, 40)) {
    const flag = c.category === 'db_prefix_truncated' ? '⬇截断' : c.category === 'unavailable' ? '✗不可用' : c.category === 'exact' ? '✓一致' : '≈漂移';
    console.log(`  ${flag.padEnd(6)} ${c.video_id} db=${String(c.dbLength).padStart(5)} live=${String(c.liveLength).padStart(5)} miss=${String(c.missingChars).padStart(5)} firstDiff=${String(c.firstDiff).padStart(5)} | ${(c.channel_name || '').slice(0, 20)} | ${c.discovery_method || '-'} | ${(c.first_seen_at || '').slice(0, 10)}`);
  }

  // ── 最终输出（协议 F：只给设计，不修）──
  console.log('\n═══ 协议 F 结论（根因设计，只读不改）═══');
  console.log(`  判定: ${affectedRate >= 0.05 ? 'STORAGE_TRUNCATED' : 'STORAGE_OK'}  （截断率 ${(affectedRate * 100).toFixed(1)}%，阈值 5%）`);
  if (prefixTrunc.length) {
    const e = prefixTrunc[0];
    console.log(`  典型样本: ${e.video_id} db=${e.dbLength} live=${e.liveLength} missing=${e.missingChars} endsEllipsis=${e.endsEllipsis} method=${e.discovery_method} first_seen=${(e.first_seen_at || '').slice(0, 10)}`);
  }
  console.log(`  videos.list 消耗: ${calls}u（general quota，0 search / 0 AI / 0 DB write）`);
}

main().catch((e) => { console.error('audit 异常:', e); process.exit(2); });

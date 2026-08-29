/**
 * Market Backfill CLI（2026-08-29 P1）
 *
 * 修复区域识别：纠正 US 虚高（detectLanguage 英文默认塞 US）+ 诚实标注 unknown。
 * 只用库内数据，不重新 Search、不改 discovery 链路。
 *
 * 运行:
 *   npm run market:backfill -- --dry-run            # 只出报告不写库
 *   npm run market:backfill                          # 规则层全量 backfill
 *   npm run market:backfill -- --ai-limit=300        # 规则后对 remaining unknown 做 AI 补充（≤300/天）
 *   npm run market:backfill -- --only-unknown        # 只处理当前 market=null 的行
 *
 * 参数:
 *   --dry-run     只报告，不写库
 *   --force       即使 computed 与现库一致也重写（默认只写有变化的行）
 *   --only-unknown 只处理 market=null 的行
 *   --ai-limit=N  AI 补充上限（N<0 或 0 禁用；默认读 AI_BACKLOG_DAILY_LIMIT，无则 300）
 */
import { getSupabase } from './db/supabase';
import { buildMarketContexts } from './services/competitor-monitor/market-context';
import {
  inferMarket, MARKET_LABELS, LANGUAGE_LABELS, type MarketInference, type MarketSource,
} from './services/competitor-monitor/market-inference';
import { chatJSON } from './services/ai/deepseek-client';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const onlyUnknown = args.includes('--only-unknown');
const aiLimitArg = args.find(a => a.startsWith('--ai-limit='));
const envLimit = Number(process.env.AI_BACKLOG_DAILY_LIMIT ?? '300');
const aiLimit = aiLimitArg
  ? Number(aiLimitArg.split('=')[1] ?? '0')
  : Number.isFinite(envLimit) ? envLimit : 300;

const PAGE = 1000;
async function fetchAll(base: any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await base.range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

interface Summary {
  total: number; identified: number; unknown: number; unknownRate: string;
  us: number; usRate: string;
  byMarket: Record<string, number>; bySource: Record<string, number>; byLang: Record<string, number>;
}
function summarize(rows: Array<{ market: string | null; market_source: string | null; language: string | null }>): Summary {
  const total = rows.length;
  const identified = rows.filter(r => r.market).length;
  const unknown = total - identified;
  const us = rows.filter(r => r.market === 'US').length;
  const byMarket: Record<string, number> = {}, bySource: Record<string, number> = {}, byLang: Record<string, number> = {};
  for (const r of rows) {
    if (r.market) byMarket[r.market] = (byMarket[r.market] || 0) + 1;
    const src = r.market_source || 'legacy';
    bySource[src] = (bySource[src] || 0) + 1;
    if (r.language) byLang[r.language] = (byLang[r.language] || 0) + 1;
  }
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) + '%' : '—');
  return { total, identified, unknown, unknownRate: pct(unknown), us, usRate: pct(us), byMarket, bySource, byLang };
}

function printSummary(tag: string, s: Summary) {
  console.log(`\n[${tag}] total=${s.total} identified=${s.identified} unknown=${s.unknown} (${s.unknownRate}) US=${s.us} (${s.usRate})`);
  const topMarkets = Object.entries(s.byMarket).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  market: ${topMarkets.map(([k, n]) => `${MARKET_LABELS[k] || k} ${n}`).join(' | ')}${s.unknown ? ` | 未识别 ${s.unknown}` : ''}`);
  console.log(`  source: ${Object.entries(s.bySource).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  const topLangs = Object.entries(s.byLang).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`  lang  : ${topLangs.map(([k, n]) => `${LANGUAGE_LABELS[k] || k} ${n}`).join(' | ')}`);
}

function buildMarketPrompt(items: Array<{ videoId: string; title: string; descSnippet: string }>): string {
  const marketEnum = Object.keys(MARKET_LABELS).map(m => `"${m}"`).join('|');
  return `Determine the TARGET AUDIENCE market of each promo video. Return JSON: {"videos":[{"videoId","market"(${marketEnum}|null),"marketReason"(string)}]}

RULES (MANDATORY):
- market = the market this promo is aimed at (NOT video upload region / IP / query market).
- Only set it when there is LOCALIZATION evidence: a localized landing page path in the description URL (e.g. /pt-br/ /ru/ /zh-tw/ /tr/), a local currency, or local-language promo words (промокод→RU, cupom→BR, indirim→TR, 折扣碼→TW).
- If the content is pure English with NO localization evidence → market=null. Do NOT guess "US" from English. English ≠ America.
- marketReason = short evidence string (e.g. "landing url /pt-br/ + R$99"), or "" when market is null.

Videos: ${JSON.stringify(items)}`;
}

async function main() {
  const db = getSupabase();
  console.log('── Market Backfill (P1：英文≠美国 / 不强猜 / 诚实 unknown) ──');
  console.log(`  mode: ${dryRun ? 'DRY-RUN(只报告)' : 'WRITE'} | force=${force} | onlyUnknown=${onlyUnknown} | aiLimit=${aiLimit > 0 ? aiLimit : '禁用'}`);

  const COLS = 'video_id, channel_id, title, description, language, market, market_source, market_confidence, market_evidence, discovery_query_id, published_at, placement_type, workflow_status';
  const COLS_NO_SRC = 'video_id, channel_id, title, description, language, market, market_confidence, market_evidence, discovery_query_id, published_at, placement_type, workflow_status';
  let rows: any[], haveSource = true;
  try {
    rows = await fetchAll(db.from('youtube_competitor_videos').select(COLS));
  } catch (e) {
    // migration 未应用：market_source 列缺失。dry-run 报告不受影响（source 记 legacy）。
    console.warn('  ⚠️ market_source 列不存在（supabase-migration-market-source.sql 未应用）——按 legacy 处理；dry-run 报告仍完整');
    haveSource = false;
    rows = await fetchAll(db.from('youtube_competitor_videos').select(COLS_NO_SRC));
  }
  console.log(`  已加载 ${rows.length} 条视频`);
  if (!haveSource && !dryRun) {
    console.error('  中止：写库需要 market_source 列。请先在 Supabase SQL Editor 应用 supabase-migration-market-source.sql，再重跑。');
    process.exit(1);
  }

  const before = summarize(rows);
  printSummary('BEFORE', before);

  // ── Phase A: 规则层（只查库，不 Search）──
  console.log('\n── Phase A: 规则层 backfill ──');
  const entries = rows.map(r => ({ channelId: r.channel_id, discoveryQueryId: r.discovery_query_id || null }));

  // Pass 1: 先算不带 creator_history 的干净 market（旧 DB market 列是 legacy US 虚高，
  // 直接拿来算历史多数票会污染）。用 pass1 结果重建历史票，再 Pass 2 跑完整优先级链。
  const ctx1 = await buildMarketContexts(db, entries, { historyOverride: new Map() });
  const inf1 = new Map<string, MarketInference>();
  for (const r of rows) {
    inf1.set(r.video_id, inferMarket({ title: r.title || '', description: r.description || '', marketContext: ctx1.get(r.channel_id) || null }));
  }
  const CONFIRMED = new Set(['confirmed_paid_placement', 'likely_sponsored']);
  const historyOverride = new Map<string, string[]>();
  for (const r of rows) {
    const m = inf1.get(r.video_id)?.market;
    if (m && CONFIRMED.has(r.placement_type)) {
      if (!historyOverride.has(r.channel_id)) historyOverride.set(r.channel_id, []);
      historyOverride.get(r.channel_id)!.push(m);
    }
  }
  const mktCtx = await buildMarketContexts(db, entries, { historyOverride });

  interface Working { row: any; inf: MarketInference; changed: boolean; }
  const working: Working[] = [];
  let reclassified = 0, unchanged = 0;
  for (const r of rows) {
    if (onlyUnknown && r.market) { unchanged++; continue; }
    const inf = inferMarket({ title: r.title || '', description: r.description || '', marketContext: mktCtx.get(r.channel_id) || null });
    const curM = r.market || null, curS = r.market_source || null;
    const changed = force || (curM !== (inf.market || null)) || (curS !== inf.source);
    if (changed) { reclassified++; working.push({ row: r, inf, changed }); }
    else { unchanged++; working.push({ row: r, inf, changed }); }
  }

  // 写库（batched 并发，仅非 dry-run）
  let written = 0, errs = 0;
  const targets = working.filter(w => w.changed);
  const apply = async (w: Working) => {
    const payload = {
      market: w.inf.market || null,
      market_source: w.inf.source,
      market_confidence: w.inf.confidence,
      market_evidence: w.inf.evidence,
      last_updated_at: new Date().toISOString(),
    };
    const { error } = await db.from('youtube_competitor_videos').update(payload).eq('video_id', w.row.video_id);
    if (error) { errs++; if (errs <= 5) console.error(`  [FAIL] ${w.row.video_id}: ${error.message}`); }
    else written++;
  };
  if (!dryRun) {
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      await Promise.all(chunk.map(apply));
      if ((i / 100) % 10 === 0) console.log(`  ...${i + chunk.length}/${targets.length} 更新`);
    }
  }
  console.log(`  规则层: 变更 ${targets.length} / 不变 ${unchanged}（dryRun=${dryRun} → 写入 ${written}，失败 ${errs}）`);

  // AFTER（用 in-memory 新值）
  const afterRows = working.map(w => ({ ...w.row, market: w.inf.market || null, market_source: w.inf.source, language: w.row.language || null }));
  const after = summarize(afterRows);
  printSummary('AFTER(规则层)', after);

  // ── Phase B: AI 补充 remaining unknown ──
  let aiSupplemented = 0, aiErr = 0;
  if (aiLimit > 0 && !process.env.DEEPSEEK_API_KEY) {
    console.log('\n── Phase B: AI 补充 —— ⚠️ DEEPSEEK_API_KEY 未注入，跳过（本地跑需用 railway run -- npm run market:backfill … 注入）──');
  } else if (aiLimit > 0) {
    const unknownRows = afterRows.filter(r => !r.market);
    const take = Math.min(aiLimit, unknownRows.length);
    console.log(`\n── Phase B: AI 补充 remaining unknown（取 ${take}/${unknownRows.length}，≤ ${aiLimit}/天）──`);
    if (take > 0) {
      for (let i = 0; i < take; i += 10) {
        const batch = unknownRows.slice(i, i + 10);
        const prompt = buildMarketPrompt(batch.map(v => ({ videoId: v.video_id, title: v.title || '', descSnippet: (v.description || '').slice(0, 300) })));
        const res = await chatJSON<{ videos: any[] }>([{ role: 'user', content: prompt }], { mode: 'fast', maxTokens: 2048 });
        if (res.success && res.data?.videos?.length) {
          for (const item of res.data.videos) {
            const row = batch.find(v => v.video_id === item.videoId);
            if (!row) continue;
            const inf = inferMarket({
              title: row.title || '', description: row.description || '',
              marketContext: mktCtx.get(row.channel_id) || null,
              aiCandidate: { market: item.market || null, confidence: item.confidence ?? 60, evidence: item.marketReason ? [String(item.marketReason)] : [] },
            });
            if (!inf.market) continue; // AI 也说 unknown，不强写
            if (!dryRun) {
              const { error } = await db.from('youtube_competitor_videos').update({
                market: inf.market, market_source: inf.source, market_confidence: inf.confidence, market_evidence: inf.evidence,
                last_updated_at: new Date().toISOString(),
              }).eq('video_id', row.video_id);
              if (error) { aiErr++; continue; }
            }
            row.market = inf.market; row.market_source = inf.source;
            aiSupplemented++;
          }
        } else {
          aiErr++;
          console.error(`  [AI 批次失败] ${res.error || 'no data'}（已跳过该批，不写）`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`  AI 补充: ${aiSupplemented} 条（dryRun=${dryRun}，失败批 ${aiErr}）`);
  } else {
    console.log('\n── Phase B: AI 补充已禁用（--ai-limit 或 AI_BACKLOG_DAILY_LIMIT）──');
  }

  // ── 最终报告 ──
  const finalRows = afterRows.map(r => ({ ...r, market: r.market, market_source: r.market_source, language: r.language }));
  const final = summarize(finalRows);
  printSummary('FINAL', final);
  console.log(`\n  总结: US ${before.us} (${before.usRate}) → ${final.us} (${final.usRate})；unknown ${before.unknown} (${before.unknownRate}) → ${final.unknown} (${final.unknownRate})`);
  if (aiSupplemented) console.log(`  AI 补充数量: ${aiSupplemented}`);
  console.log(dryRun ? '  （dry-run：未写任何行）' : '  完成。');
}

main().catch(err => { console.error('Market backfill CLI failed:', err); process.exit(1); });

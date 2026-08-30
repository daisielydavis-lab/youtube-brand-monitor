/**
 * CLI — LagZapper Creator Promotion（2026-08-30）
 *
 * 把 Creator-driven Validation（cli-lz-creator-validate.ts，6/6 HIGH）判定的 6 个
 * 弱信号候选，正式产品化为 LagZapper affiliate identity：
 *   1. affiliate_identities：6 条身份（幂等 upsert onConflict brand,channel_id）
 *   2. youtube_creator_watchlist：仅补「LZ 下缺失」的行（运行时按真实 watchlist 判定）
 *
 * dry-run 默认，--apply 才写库。
 * 写前 guard：候选的 cid/code 信号若已被他频道认领 → shared-link，中止整批（绝不并入）。
 * 约束：不写 utm_campaign 字段（prod 无此列）；不调 search.list、不消耗 Search quota；无 AI。
 *
 * 用法：npm run lz-creator-promote            ← dry-run 预览
 *       npm run lz-creator-promote -- --apply ← 写库
 */
import { getSupabase } from './db/supabase';
import { guardOwnership, type IdentityRow, type KOLSignal } from './services/competitor-monitor/kol-tracking';

const APPLY = process.argv.includes('--apply');
const BRAND = 'LagZapper';

interface PromoteCandidate {
  display: string;
  channelId: string;
  channelName: string;      // affiliate_identities.channel_name
  cid?: string;
  code?: string;
  signalType: string;
  confidence: number;
}

const CANDIDATES: PromoteCandidate[] = [
  { display: 'Makar Busalkin', channelId: 'UCBJkY8Kn4EGkDZmgEPxQxnQ', channelName: 'Makar Busalkin', signalType: 'utm_campaign', confidence: 0.8 },
  { display: 'More Sn1p3rrr',  channelId: 'UCrHJImlSA2yJ9iz27FnEluA', channelName: 'More Sn1p3rrr',  signalType: 'utm_campaign', confidence: 0.8 },
  { display: 'ntswitches',     channelId: 'UCHjUpCxwqhqZ_ADjbgkdh1w', channelName: 'ntswitches',     cid: '15', code: 'NTSWITCHES', signalType: 'cid', confidence: 1.0 },
  { display: 'Bandz',          channelId: 'UC95DdAaU0dThWYS0aR-Og-Q', channelName: 'Bandz',          signalType: 'utm_campaign', confidence: 0.8 },
  { display: 'Симон Клик',     channelId: 'UCIVL3pSl36CNGMrL16TgZ1Q', channelName: 'Симон Клик',     signalType: 'utm_campaign', confidence: 0.8 },
  { display: 'Timba-x',        channelId: 'UCQ0p8laY0ROqegUWlxRjAPw', channelName: 'Timba-x',        code: 'TIMBA-X', signalType: 'promo_code', confidence: 0.9 },
];

async function main() {
  const db = getSupabase();
  console.log(`═══ LagZapper 6 候选产品化（${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}）═══\n`);

  const { data: ai, error: ae } = await db.from('affiliate_identities')
    .select('brand, channel_id, channel_name, promo_code, affiliate_cid, ref_id, domain, signal_type, confidence');
  if (ae) { console.error('✗ identities 查询失败:', ae.message); process.exit(1); }
  const registry: IdentityRow[] = ai || [];
  const lzCount = registry.filter(r => r.brand === BRAND).length;
  console.log(`[registry] LagZapper 已确认身份 ${lzCount} 条`);

  // 运行时判定 LZ watchlist 覆盖：只补缺失行（Bandz 在 GearUP 下→需 LZ 行；Timba-x 不在→需新增）
  const { data: wl, error: we } = await db.from('youtube_creator_watchlist').select('channel_id').eq('brand', BRAND);
  if (we) { console.error('✗ watchlist 查询失败:', we.message); process.exit(1); }
  const lzWatchlist = new Set((wl || []).map(r => r.channel_id));
  const needWatchlist = (c: PromoteCandidate) => !lzWatchlist.has(c.channelId);

  // 写前 guard：候选 cid/code 若已被他频道认领 → shared-link，整批中止（绝不并入）
  const aborted: string[] = [];
  for (const c of CANDIDATES) {
    const signals: KOLSignal[] = [
      ...(c.cid ? [{ form: 'cid' as const, value: c.cid }] : []),
      ...(c.code ? [{ form: 'promo_code' as const, value: c.code }] : []),
    ];
    if (!signals.length) continue;
    const { sharedForeign } = guardOwnership(c.channelId, signals, registry);
    if (sharedForeign.length) {
      aborted.push(`${c.display}: ${sharedForeign.map(s => `${s.form}=${s.value}→${s.ownerName || s.ownerChannel}`).join('; ')}`);
    }
  }
  if (aborted.length) {
    console.log('\n✗ 中止：以下候选信号已被他频道认领（shared-link），不写入：');
    for (const a of aborted) console.log(`  ${a}`);
    process.exit(1);
  }

  console.log(`\n━━━ 计划写入 affiliate_identities（brand=${BRAND}）━━━`);
  for (const c of CANDIDATES) {
    const sig = `${c.cid ? `cid=${c.cid} ` : ''}${c.code ? `code=${c.code} ` : ''}`.trim() || '(utm-only，handle 自 channel_name)';
    console.log(`  ${c.display.padEnd(16)} ${c.channelId}  [${sig}]  ${c.signalType}@${c.confidence}`);
  }

  const toWatchlist = CANDIDATES.filter(needWatchlist);
  console.log(`\n━━━ 计划写入 youtube_creator_watchlist（LZ 下缺失 ${toWatchlist.length} 条）━━━`);
  if (!toWatchlist.length) console.log('  （6 候选均已覆盖，无新增）');
  for (const c of toWatchlist) console.log(`  ${c.display.padEnd(16)} brand=LagZapper  discovered_via=video_backtrace`);

  if (!APPLY) {
    console.log(`\n⚠️  dry-run：未写库。加 --apply 执行。`);
    console.log(`  预期：affiliate_identities LagZapper ${lzCount} → ${lzCount + CANDIDATES.length} · watchlist +${toWatchlist.length}`);
    return;
  }

  // ── 写库：身份（幂等 upsert；不写 utm_campaign——prod 无此列）──
  let ok = 0;
  for (const c of CANDIDATES) {
    const { error } = await db.from('affiliate_identities').upsert({
      brand: BRAND,
      channel_id: c.channelId,
      channel_name: c.channelName,
      affiliate_cid: c.cid || null,
      promo_code: c.code || null,
      domain: 'lagzapper.com',
      signal_type: c.signalType,
      confidence: c.confidence,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'brand,channel_id' });
    if (error) console.error(`✗ 身份写入失败 [${c.display}]:`, error.message);
    else { ok++; console.log(`✓ 身份已写入 [${c.display}] ${c.signalType}@${c.confidence}`); }
  }
  for (const c of toWatchlist) {
    const { error } = await db.from('youtube_creator_watchlist').upsert({
      brand: BRAND, channel_id: c.channelId, channel_name: c.channelName,
      discovered_via: 'video_backtrace', status: 'active',
    }, { onConflict: 'brand,channel_id' });
    if (error) console.error(`✗ watchlist 写入失败 [${c.display}]:`, error.message);
    else { ok++; console.log(`✓ watchlist 已写入 [${c.display}] ${BRAND}`); }
  }
  console.log(`\n写库完成：${ok} 条。`);
}

main().catch((e) => { console.error('promote 异常:', e); process.exit(2); });

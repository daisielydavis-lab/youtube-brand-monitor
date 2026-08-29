/**
 * LagZapper KOL identity 回填（2026-08-29 最小验证集）—— dry-run 默认，--apply 写库
 *
 * 写库前置：shared-link ownership guard 必须生效（见 src/regression-lz-ownership.ts 负向回归）。
 * Observed Signal ≠ Owned Identity：归属他频道的信号 → sharedForeign → 永不并入。
 *
 * 今日写库范围（用户拍板）：
 *   1. 新身份（双信号 HIGH，cid+code 同频道且无人认领）：EUTOPIA(cid121+EUTOPIA35)、swiMa(cid179+SWIMAG)
 *   2. 补证据（guard 通过 + 自属未认领 cid/code）：cid=207 → 并入 MAJOR76™
 *   3. handle-only 候选 + TIMBA-X code-only：**不写正式身份**，只展示
 *   4. sharedForeign：跳过
 *
 * 用法：
 *   npm run lz-backfill              # dry-run：只打印写库计划，不写
 *   npm run lz-backfill -- --apply   # 实际写库（幂等 upsert）
 *
 * 只读部分不消费 Search quota；写库仅触碰 affiliate_identities。
 */
import { getSupabase } from './db/supabase';
import {
  extractKOLTrackingSignals,
  guardOwnership,
  resolveKnownIdentity,
  type IdentityRow,
  type KOLSignal,
} from './services/competitor-monitor/kol-tracking';

const APPLY = process.argv.includes('--apply');
const BRAND = 'LagZapper';
const NEW_CONF = 0.95;   // 双信号(cid+code)自证 HIGH

interface ChanAcc { chName: string; cids: Set<string>; codes: Set<string>; refs: Set<string>; utms: Set<string>; n: number; }

async function main() {
  const db = getSupabase();
  console.log(`═══ LagZapper KOL identity 回填（${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}）═══\n`);

  const { data: vidsData } = await db.from('youtube_competitor_videos')
    .select('id, channel_id, description').ilike('description', '%lagzapper%');
  const vids = (vidsData || []) as Array<{ id: string; channel_id: string; description: string | null }>;
  const { data: ai, error: ae } = await db.from('affiliate_identities')
    .select('brand, channel_id, channel_name, promo_code, affiliate_cid, ref_id, domain, signal_type, confidence')
    .eq('brand', BRAND);
  if (ae) { console.error('✗ identities 查询失败:', ae.message); process.exit(1); }
  const registry: IdentityRow[] = ai;
  const { data: wl } = await db.from('youtube_creator_watchlist')
    .select('channel_id, channel_name').eq('brand', BRAND);
  const wlName = new Map((wl || []).map(r => [r.channel_id, r.channel_name || '']));

  console.log(`视频 ${vids.length} · 现有 LagZapper identities ${registry.length}\n`);

  // ── 按 channel 聚合信号 ──
  const chan = new Map<string, ChanAcc>();
  for (const v of vids) {
    const sigs = extractKOLTrackingSignals(v.description);
    let acc = chan.get(v.channel_id);
    if (!acc) { acc = { chName: wlName.get(v.channel_id) || '', cids: new Set(), codes: new Set(), refs: new Set(), utms: new Set(), n: 0 }; chan.set(v.channel_id, acc); }
    acc.n++;
    for (const s of sigs) {
      if (s.form === 'cid') acc.cids.add(s.value);
      else if (s.form === 'promo_code') acc.codes.add(s.value);
      else if (s.form === 'ref') acc.refs.add(s.value);
      else acc.utms.add(s.value);
    }
  }

  // ── 写库计划 ──
  interface NewPlan { channel_id: string; channel_name: string; cid?: string; code?: string; n: number; }
  interface MergePlan { channel_id: string; known: string; field: 'affiliate_cid' | 'promo_code'; value: string; }
  const newPlans: NewPlan[] = [];
  const mergePlans: MergePlan[] = [];
  const deferred: string[] = []; // 不写（handle-only / code-only / shared）
  let sharedCount = 0;

  for (const [ch, acc] of chan) {
    const cids = [...acc.cids], codes = [...acc.codes], refs = [...acc.refs], utms = [...acc.utms];
    const known = resolveKnownIdentity(ch, cids, codes, utms, registry);

    const all: KOLSignal[] = [
      ...cids.map(v => ({ form: 'cid' as const, value: v })),
      ...codes.map(v => ({ form: 'promo_code' as const, value: v })),
      ...refs.map(v => ({ form: 'ref' as const, value: v })),
      ...utms.map(v => ({ form: 'utm_campaign' as const, value: v })),
    ];
    const { mergeable, sharedForeign } = guardOwnership(ch, all, registry);
    sharedCount += sharedForeign.length;

    if (known) {
      // 已已知：只有「该频道自己的身份行」才允许并入补证据。
      // known.identity.channel_id === ch 才是身份持有者；否则是 sharer（观察他人链接）→ 不写。
      if (known.identity.channel_id === ch) {
        // guard 通过的未认领 cid/code → 合并证据（utm/ref 今日不写）
        for (const s of mergeable) {
          if (s.form === 'cid' && s.value !== known.identity.affiliate_cid) {
            mergePlans.push({ channel_id: ch, known: known.identity.channel_name || ch, field: 'affiliate_cid', value: s.value });
          } else if (s.form === 'promo_code' && !(known.identity.promo_code && known.identity.promo_code.toUpperCase() === s.value) && !/^(game|00|ted)$/i.test(s.value)) {
            mergePlans.push({ channel_id: ch, known: known.identity.channel_name || ch, field: 'promo_code', value: s.value });
          }
        }
      } else {
        sharedCount += sharedForeign.length;
        deferred.push(`${ch} (${acc.chName || ''}) — 仅 shared（分享他人身份链接）`);
      }
    } else {
      // 未知频道：只有 双信号(cid+code) 升级为正式身份；handle-only / code-only 留候选
      const unclaimedCids = mergeable.filter(s => s.form === 'cid').map(s => s.value);
      const unclaimedCodes = mergeable.filter(s => s.form === 'promo_code' && !/^(game|00|ted)$/i.test(s.value)).map(s => s.value);
      if (unclaimedCids.length && unclaimedCodes.length) {
        newPlans.push({
          channel_id: ch,
          channel_name: acc.chName || ch,
          cid: unclaimedCids[0],
          code: unclaimedCodes[0],
          n: acc.n,
        });
      } else {
        const desc = mergeable.filter(s => s.form !== 'utm_campaign').map(s => `${s.form}=${s.value}`).join(' ') || '无信号/仅 utm';
        deferred.push(`${ch} (${acc.chName || ''}) — ${desc}`);
      }
    }
  }

  // ── 输出计划 ──
  console.log('━━━ 1. 新身份（双信号 HIGH）━━━');
  for (const p of newPlans) {
    console.log(`  [${p.channel_name}] ${p.channel_id}  cid=${p.cid} + code=${p.code}  视频×${p.n}`);
  }

  console.log('━━━ 2. 合并证据（guard 通过，并入已知身份）━━━');
  for (const p of mergePlans) {
    console.log(`  ${p.field}=${p.value} → 并入 ${p.known} (${p.channel_id})`);
  }

  console.log('━━━ 3. 不写（handle-only / code-only / 无信号）━━━');
  for (const d of deferred) console.log(`  ${d}`);
  console.log(`  (sharedForeign 跳过 ${sharedCount} 条)`);

  if (!APPLY) {
    console.log('\n⚠️  dry-run：未写库。加 --apply 执行。');
    console.log(`  预期：新增 identity ${newPlans.length} 条 · 合并 ${mergePlans.length} 条 · 总 identities ${registry.length} → ${registry.length + newPlans.length}`);
    return;
  }

  // ── 写库 ──
  let ok = 0;
  for (const p of newPlans) {
    const { error } = await db.from('affiliate_identities').upsert({
      brand: BRAND,
      channel_id: p.channel_id,
      channel_name: p.channel_name,
      affiliate_cid: p.cid,
      promo_code: p.code,
      domain: 'lagzapper.com',
      signal_type: 'cid',
      confidence: NEW_CONF,
    }, { onConflict: 'brand,channel_id' });
    if (error) console.error(`✗ 新身份写入失败 [${p.channel_name}]:`, error.message);
    else { ok++; console.log(`✓ 新身份已写入 [${p.channel_name}] cid=${p.cid} code=${p.code}`); }
  }
  for (const p of mergePlans) {
    const { error } = await db.from('affiliate_identities')
      .update({ [p.field]: p.value })
      .eq('brand', BRAND).eq('channel_id', p.channel_id)
      .is(p.field, null); // 只填空位，绝不覆盖已有
    if (error) console.error(`✗ 合并写入失败 [${p.known}]:`, error.message);
    else { ok++; console.log(`✓ 合并 ${p.field}=${p.value} → ${p.known}`); }
  }
  console.log(`\n写库完成：${ok} 条。`);
}

main().catch((e) => { console.error('backfill 异常:', e); process.exit(2); });

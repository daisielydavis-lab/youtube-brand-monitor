/**
 * LagZapper KOL Tracking Matcher — 只读 dry-run（2026-08-29 v2，接入 ownership guard）
 *
 * 语义：cid / promo code / ref / utm_campaign 是同一个 KOL 的身份观测；
 * Observed Signal ≠ Owned Identity —— 频道里观察到别人的 cid/code = shared link，绝不并入。
 *
 * 只读：不写库、不消费 Search quota。设计见 docs/lz-kol-tracking-matcher-design.md。
 * 用法：npm run lz-matcher
 */
import { getSupabase } from './db/supabase';
import {
  extractKOLTrackingSignals,
  guardOwnership,
  resolveKnownIdentity,
  norm,
  type IdentityRow,
  type KOLSignal,
} from './services/competitor-monitor/kol-tracking';

interface VideoRow {
  id: string;
  channel_id: string;
  title: string;
  description: string | null;
  published_at: string | null;
}

async function main() {
  const db = getSupabase();
  console.log('═══ LagZapper KOL Tracking Matcher — 只读 dry-run ═══\n');

  const { data: vids, error: ve } = await db
    .from('youtube_competitor_videos')
    .select('id, channel_id, title, description, published_at')
    .ilike('description', '%lagzapper%');
  if (ve) { console.error('✗ 视频查询失败:', ve.message); process.exit(1); }

  const { data: ai, error: ae } = await db
    .from('affiliate_identities')
    .select('brand, channel_id, channel_name, promo_code, affiliate_cid, ref_id, domain, signal_type, confidence')
    .eq('brand', 'LagZapper');
  if (ae) { console.error('✗ identities 查询失败:', ae.message); process.exit(1); }
  const registry: IdentityRow[] = ai;

  const { data: wl, error: we } = await db
    .from('youtube_creator_watchlist')
    .select('channel_id, channel_name, brand')
    .eq('brand', 'LagZapper');
  if (we) { console.error('✗ watchlist 查询失败:', we.message); process.exit(1); }
  const wlName = new Map((wl || []).map(r => [r.channel_id, r.channel_name || '']));

  console.log(`视频（描述含 lagzapper）：${vids.length} · identities：${registry.length}`);

  // ── Phase A：逐视频提取，按 channel 聚合信号 ──
  const chan = new Map<string, { chName: string; cids: Set<string>; codes: Set<string>; refs: Set<string>; utms: Set<string>; n: number }>();
  for (const v of (vids as VideoRow[])) {
    const sigs = extractKOLTrackingSignals(v.description);
    let acc = chan.get(v.channel_id);
    if (!acc) {
      acc = { chName: wlName.get(v.channel_id) || '', cids: new Set(), codes: new Set(), refs: new Set(), utms: new Set(), n: 0 };
      chan.set(v.channel_id, acc);
    }
    acc.n++;
    for (const s of sigs) {
      if (s.form === 'cid') acc.cids.add(s.value);
      else if (s.form === 'promo_code') acc.codes.add(s.value);
      else if (s.form === 'ref') acc.refs.add(s.value);
      else acc.utms.add(s.value);
    }
  }

  // ── Phase B：每 channel 解析身份 + ownership guard ──
  const tp: Array<{ ch: string; chName: string; via: string; known: string; conf: number; n: number }> = [];
  const mergeEv: Array<{ ch: string; known: string; signal: string }> = [];
  const sharedLink: Array<{ ch: string; signal: string; owner: string }> = [];
  const newKols: Array<{ ch: string; chName: string; signals: KOLSignal[] }> = [];

  for (const [ch, acc] of chan) {
    const cids = [...acc.cids], codes = [...acc.codes], refs = [...acc.refs], utms = [...acc.utms];

    const known = resolveKnownIdentity(ch, cids, codes, utms, registry);
    // 仅当该频道就是身份持有者（known.identity.channel_id === ch）才算 TP；
    // 否则是 sharer（分享他人身份链接）→ 归 shared-link，不算本频道身份。
    if (known && known.identity.channel_id === ch) {
      tp.push({ ch, chName: acc.chName, via: known.via, known: known.identity.channel_name || ch, conf: known.identity.confidence ?? 0.9, n: acc.n });
      // 已命中已知身份：guard 拆分该频道全部信号，只有 guard 通过的才可并入
      const all: KOLSignal[] = [
        ...cids.map(v => ({ form: 'cid' as const, value: v })),
        ...codes.map(v => ({ form: 'promo_code' as const, value: v })),
        ...refs.map(v => ({ form: 'ref' as const, value: v })),
        ...utms.map(v => ({ form: 'utm_campaign' as const, value: v })),
      ];
      const { mergeable, sharedForeign } = guardOwnership(ch, all, registry);
      for (const s of mergeable) {
        if (s.form === 'cid' && s.value === known.identity.affiliate_cid) continue;
        if (s.form === 'promo_code' && known.identity.promo_code && known.identity.promo_code.toUpperCase() === s.value) continue;
        if (s.form === 'utm_campaign' && matchHandleStub(s.value, registry)) continue; // 自身 handle 自证
        if (s.form === 'promo_code' && /^(game|00|ted)$/i.test(s.value)) continue;
        mergeEv.push({ ch, known: known.identity.channel_name || ch, signal: `${s.form}=${s.value}` });
      }
      for (const s of sharedForeign) {
        sharedLink.push({ ch, signal: `${s.form}=${s.value}`, owner: s.ownerName || s.ownerChannel });
      }
    } else {
      // 完全未知频道 → 新 KOL 候选（guard 过滤：归属他人的信号不引入候选）
      const { mergeable, sharedForeign } = guardOwnership(ch, [
        ...cids.map(v => ({ form: 'cid' as const, value: v })),
        ...codes.map(v => ({ form: 'promo_code' as const, value: v })),
        ...refs.map(v => ({ form: 'ref' as const, value: v })),
        ...utms.map(v => ({ form: 'utm_campaign' as const, value: v })),
      ], registry);
      const clean = mergeable.filter(s => !(s.form === 'promo_code' && /^(game|00|ted)$/i.test(s.value)));
      if (clean.length) newKols.push({ ch, chName: acc.chName, signals: clean });
      for (const s of sharedForeign) sharedLink.push({ ch, signal: `${s.form}=${s.value}`, owner: s.ownerName || s.ownerChannel });
    }
  }

  // ── 输出 ──
  console.log(`\n━━━ 1. True Positive（已知身份，按频道聚合）━━━  ${tp.length} 频道`);
  for (const t of tp) console.log(`  ${t.via.padEnd(22)} → ${t.known.padEnd(22)} conf=${t.conf.toFixed(2)}  视频×${t.n}  (${t.ch})`);

  console.log(`\n━━━ 2. 补证据（guard 通过 → 可安全并入已知身份）━━━  ${mergeEv.length}`);
  for (const m of mergeEv) console.log(`  ${m.signal.padEnd(22)} → 并入 ${m.known}  (${m.ch})`);

  console.log(`\n━━━ 3. Shared link（归属他频道 → 跳过，绝不并入）━━━  ${sharedLink.length}`);
  for (const s of sharedLink) console.log(`  ${s.signal.padEnd(22)} 在 ${s.ch} 观察到，实际归属 ${s.owner}`);

  console.log(`\n━━━ 4. 新 KOL 候选（guard 过滤后，完全未知频道）━━━  ${newKols.length}`);
  for (const k of newKols) {
    const sigStr = k.signals.map(s => `${s.form}=${s.value}`).join(' · ');
    const selfUtm = k.signals.some(s => s.form === 'utm_campaign' && k.chName && norm(k.chName).includes(norm(s.value)));
    console.log(`  [${k.chName || k.ch}] ${selfUtm ? '(自身handle)' : ''}\n     ${sigStr}`);
  }

  console.log(`\n═══ dry-run 结束（只读，无写入，0 Search 调用）═══`);
  console.log(`汇总：已知 ${tp.length} 频道 · 补证据 ${mergeEv.length} · shared-link 跳过 ${sharedLink.length} · 新KOL候选 ${newKols.length}`);
}

// 内部轻量 handle 匹配（避免把自身 handle 当补证据）：是否命中任一已知身份
function matchHandleStub(h: string, registry: IdentityRow[]): boolean {
  const nh = norm(h);
  for (const i of registry) {
    if (i.channel_name && norm(i.channel_name).includes(nh)) return true;
  }
  return false;
}

main().catch((e) => { console.error('matcher 异常:', e); process.exit(2); });

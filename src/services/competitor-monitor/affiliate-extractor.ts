/**
 * Affiliate Signal Extractor — LagZapper Creator-led Discovery (2026-08-23)
 *
 * 背景: LagZapper 投放是 Affiliate Creator Network 模式 —— 视频标题不含品牌,
 * 品牌信号藏在 description 的 affiliate link / promo code / cid 参数里。
 * 因此 keyword search 结构性漏抓,Discovery 必须走 "creator → 身份指纹 → 确认"。
 *
 * 本模块只做纯函数解析 + 身份匹配,不碰 DB。职责:
 *   1. extractAffiliateSignals(description) → 提取 domain / promo_code / cid / ref / discount
 *   2. 给每个信号打 confidence,定 primary(最高可信信号)
 *   3. matchIdentity(signals, identities) → 用 code/cid 命中已知 creator 身份
 *
 * 置信度(用户 D2 拍板):
 *   cid + domain  → 1.0  (明确的 affiliate 参数)
 *   ref + domain  → 1.0
 *   promo_code    → 0.9  (一人一码,身份性强)
 *   domain only   → 0.7  (有官方域名,但可能是普通 mention)
 *   discount 文字  → 0.3  (弱信号,仅辅助)
 */

export type SignalType = 'cid' | 'ref' | 'promo_code' | 'domain' | 'discount';

export interface AffiliateSignals {
  domains: string[];
  promoCodes: string[];
  cids: string[];
  refs: string[];
  hasDiscountText: boolean;
  /** 该视频最高可信信号(用于判信 + 身份 type) */
  primary: { type: SignalType; value: string; confidence: number } | null;
}

const SIGNAL_CONFIDENCE: Record<SignalType, number> = {
  cid: 1.0,
  ref: 1.0,
  promo_code: 0.9,
  domain: 0.7,
  discount: 0.3,
};

const STOP_CODES = new Set([
  'code', 'promo', 'http', 'www', 'com', 'the', 'and', 'you', 'your', 'with',
  'для', 'при', 'game', 'free', 'this', 'use', 'new', 'click', 'link', 'discount',
]);

/** 从 URL 提取 cid / ref / refid / aff / partner 参数 */
function urlParams(url: string): { cids: string[]; refs: string[] } {
  const cids: string[] = [], refs: string[] = [];
  const m = url.match(/[?&](?:cid|ref|refid|aff_id|aff|partner)=([A-Za-z0-9_-]{1,24})/gi) || [];
  for (const p of m) {
    const mm = p.match(/[?&](cid|ref|refid|aff_id|aff|partner)=([A-Za-z0-9_-]{1,24})/i);
    if (!mm) continue;
    const [, k, v] = mm;
    if (k === 'cid' || k === 'ref' || k === 'refid') {
      if (k === 'cid') cids.push(v);
      else refs.push(v);
    } else if (k === 'ref') refs.push(v);
    else refs.push(v);
  }
  return { cids, refs };
}

// 2026-08-24：Lagofast 第 4 品牌 —— 所有已监控品牌的 affiliate 域名（品牌无关提取）。
// 归因由 matchIdentity(signals, identities, brand) 按 brand 过滤决定。
const TRACKED_DOMAINS = [
  'lagzapper.com', 'lagzapper.gg', 'lagzapper.net', 'lagzapper.io', 'lagzapper.app', 'lagzapper.ru',
  'lagofast.com', 'lagofastbooster.ru', 'lagobooster.ru', 'lago-fast.com',
];

/** 解析 description 提取 affiliate 信号 */
export function extractAffiliateSignals(description: string | null | undefined): AffiliateSignals {
  const d = (description || '').replace(/\s+/g, ' ');
  const out: AffiliateSignals = {
    domains: [], promoCodes: [], cids: [], refs: [], hasDiscountText: false, primary: null,
  };
  if (!d) return out;

  // ── domains + 内嵌参数 ──
  const urlRe = /https?:\/\/[^\s"'\\)<>]+/gi;
  const domMatches = d.match(urlRe) || [];
  for (const u of domMatches) {
    const lower = u.toLowerCase();
    const brandDom = TRACKED_DOMAINS.find(bd => lower.includes(bd));
    if (brandDom && !out.domains.includes(brandDom)) out.domains.push(brandDom);
    const { cids, refs } = urlParams(u);
    for (const c of cids) if (!out.cids.includes(c)) out.cids.push(c);
    for (const r of refs) if (!out.refs.includes(r)) out.refs.push(r);
  }
  // 裸域名(无 https)也识别
  if (!out.domains.length) {
    const bareRe = new RegExp(`\\b(${TRACKED_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')})\\b`, 'i');
    const bare = d.toLowerCase().match(bareRe);
    if (bare) out.domains.push(bare[1].toLowerCase());
  }

  // ── promo code(含俄语 промокод)──
  const codePats: RegExp[] = [
    /промокод[а-яё]*\s*[:—-]?\s*["'«]?([A-Za-z0-9_-]{3,18})/gi,
    /по\s+промокоду\s*["'«]?([A-Za-z0-9_-]{3,18})/gi,
    /use\s+my\s+code\s*["'«]?([A-Za-z0-9_-]{3,18})/gi,
    /\bcod[eo]\s*["'«]?([A-Za-z0-9_-]{3,18})/gi,
    /\bcode\s*["'«]?([A-Za-z0-9_-]{3,18})/gi,
  ];
  for (const re of codePats) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(d)) !== null) {
      const c = m[1].toUpperCase();
      if (c.length < 3 || c.length > 18) continue;
      if (!/^[A-Z0-9_-]+$/.test(c)) continue;
      if (STOP_CODES.has(c.toLowerCase())) continue;
      if (!out.promoCodes.includes(c)) out.promoCodes.push(c);
    }
  }

  // ── discount 文字 ──
  out.hasDiscountText = /(скидк\w*\s+\d+\s*%|по\s+промокоду|промокод|-\d+\s*%|\d+\s*%\s*скидк|discount\s+\d+\s*%|coupon\s+code)/i.test(d);

  // ── primary = 最高可信信号 ──
  const cands: Array<{ type: SignalType; value: string; confidence: number }> = [];
  for (const c of out.cids) cands.push({ type: 'cid', value: c, confidence: SIGNAL_CONFIDENCE.cid });
  for (const r of out.refs) cands.push({ type: 'ref', value: r, confidence: SIGNAL_CONFIDENCE.ref });
  for (const c of out.promoCodes) cands.push({ type: 'promo_code', value: c, confidence: SIGNAL_CONFIDENCE.promo_code });
  for (const dom of out.domains) cands.push({ type: 'domain', value: dom, confidence: SIGNAL_CONFIDENCE.domain });
  if (out.hasDiscountText && !cands.length) cands.push({ type: 'discount', value: 'discount', confidence: SIGNAL_CONFIDENCE.discount });
  cands.sort((a, b) => b.confidence - a.confidence);
  out.primary = cands[0] || null;

  return out;
}

export interface AffiliateIdentity {
  brand: string;
  channel_id: string;
  channel_name?: string;
  promo_code?: string | null;
  affiliate_cid?: string | null;
  ref_id?: string | null;
  domain?: string | null;
  signal_type: SignalType;
  confidence: number;
}

/** 用信号命中已知身份库。
 * cid/ref 是品牌专用参数,无条件匹配。
 * promo_code 一人一码但会跨品牌复用(实测:KEEKING 同时投 LagZapper cid11 和 Lagofast cid891453)
 * → 纯 code 匹配会误报,必须伴随 lagzapper.* 域名才确认。
 */
export function matchIdentity(
  signals: AffiliateSignals,
  identities: AffiliateIdentity[],
  brand: string,
): AffiliateIdentity | null {
  for (const s of signals.cids) {
    const hit = identities.find(i => i.brand === brand && i.affiliate_cid === s);
    if (hit) return hit;
  }
  for (const r of signals.refs) {
    const hit = identities.find(i => i.brand === brand && i.ref_id === r);
    if (hit) return hit;
  }
  if (!signals.domains.length) return null;
  for (const c of signals.promoCodes) {
    const hit = identities.find(i => i.brand === brand && i.promo_code === c);
    if (hit) return hit;
  }
  return null;
}

/** 合并一个视频的信号进某 creator 的身份行:补字段、升级 primary 信号 */
export function mergeIntoIdentity(
  base: AffiliateIdentity,
  signals: AffiliateSignals,
): AffiliateIdentity {
  const next: AffiliateIdentity = { ...base };
  for (const c of signals.promoCodes) if (!next.promo_code) next.promo_code = c;
  for (const c of signals.cids) if (!next.affiliate_cid) next.affiliate_cid = c;
  for (const r of signals.refs) if (!next.ref_id) next.ref_id = r;
  for (const dom of signals.domains) if (!next.domain) next.domain = dom;
  if (signals.primary && (signals.primary.confidence > next.confidence)) {
    next.signal_type = signals.primary.type;
    next.confidence = signals.primary.confidence;
  }
  return next;
}

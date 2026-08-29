/**
 * KOL Tracking Identifier matcher — LagZapper 特殊 tracking signal 统一解析（2026-08-29）
 *
 * 语义：cid / promo code / ref / utm_campaign 都是同一个创作者(KOL)的身份观测。
 * 核心约束：**Observed Signal ≠ Owned Identity**
 *   —— 某频道描述里出现别人的 cid/code（被分享链接），不代表该信号属于当前频道。
 *   guardOwnership() 负责把「观察到的信号」拆成「可并入本频道」vs「归属他频道，绝不并入」。
 *
 * 纯函数，不碰 DB。设计见 docs/lz-kol-tracking-matcher-design.md。
 * 注意：utm_campaign 单独出现 ≠ HIGH identity（可能是 agency/campaign 名/被分享链接），
 *       只降级为候选(candidate/MEDIUM)，由调用方决定是否升级。
 */

import { extractAffiliateSignals } from './affiliate-extractor';

export type KOLSignalForm = 'cid' | 'promo_code' | 'ref' | 'utm_campaign';

export interface KOLSignal {
  form: KOLSignalForm;
  value: string;
}

/** affiliate_identities 行（只取所有权判定所需字段） */
export interface IdentityRow {
  brand?: string;
  channel_id: string;
  channel_name?: string | null;
  promo_code?: string | null;
  affiliate_cid?: string | null;
  ref_id?: string | null;
  domain?: string | null;
  utm_campaign?: string | null;
  signal_type?: string;
  confidence?: number;
}

export interface GuardResult {
  /** 本频道自己的 或 无人认领的 → 可并入本频道身份 */
  mergeable: KOLSignal[];
  /** 已归属其它已知频道 → 只记录为 observed，永不并入本频道 */
  sharedForeign: Array<KOLSignal & { ownerChannel: string; ownerName: string }>;
}

const LZ_DOM_RE = /lagzapper(?:\.com|\.gg|\.net|\.io|\.app|\.ru)/i;
const URL_PARAM_RE = /[?&](cid|code|promo|ref|ref_id|refid|clickid|trackid|utm_campaign)=([A-Za-z0-9_-]{1,40})/gi;

export function norm(s: string): string {
  return s.toLowerCase().replace(/[@#\s_\-.,]/g, '').trim();
}

/**
 * 从视频描述提取 LagZapper KOL tracking 信号（只收 lagzapper 域名 URL 的参数；
 * prose code 仅在描述含 lagzapper 域名时收取，防跨品牌 code 误报）。
 */
export function extractKOLTrackingSignals(description: string | null | undefined): KOLSignal[] {
  const d = (description || '').replace(/\s+/g, ' ');
  const out: KOLSignal[] = [];
  if (!d) return out;

  let sawDomain = false;
  const urls = d.match(/https?:\/\/[^\s"'\\)<>]+/gi) || [];
  for (const u of urls) {
    if (!LZ_DOM_RE.test(u)) continue;
    sawDomain = true;
    let m: RegExpExecArray | null;
    URL_PARAM_RE.lastIndex = 0;
    while ((m = URL_PARAM_RE.exec(u)) !== null) {
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'cid') out.push({ form: 'cid', value: val });
      else if (key === 'code' || key === 'promo') {
        if (/^[A-Za-z0-9_-]{3,20}$/.test(val)) out.push({ form: 'promo_code', value: val.toUpperCase() });
      } else if (key === 'utm_campaign') out.push({ form: 'utm_campaign', value: val });
      else out.push({ form: 'ref', value: val });
    }
  }

  // prose promo code：仅当描述含 lagzapper 域名时收（复用已硬化的 STOP_CODES + (?<!#) 前瞻）
  if (sawDomain) {
    const base = extractAffiliateSignals(d);
    for (const c of base.promoCodes) out.push({ form: 'promo_code', value: c });
  }

  // 去重（form+value 归一）
  const seen = new Set<string>();
  return out.filter(s => {
    const k = `${s.form}:${s.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Ownership guard —— 信号归属判定。
 *
 * registry 中已高置信归属某 channel_id 的 cid/code/ref/utm_campaign 为该频道所有；
 * 当前频道观察到它 → sharedForeign（只记录，不并入）。无人认领 → mergeable（候选/自证）。
 *
 * 负向 regression 基准（rhver 反例）：
 *   registry: vaughnfn 拥有 cid=155 / VAUGHN35；rhver 拥有 cid=176 / RHVER
 *   rhver 频道观察到 cid=155/VAUGHN35 → 必须判为 sharedForeign(owner=vaughnfn)，绝不并入 rhver。
 */
export function guardOwnership(channelId: string, signals: KOLSignal[], registry: IdentityRow[]): GuardResult {
  const mergeable: KOLSignal[] = [];
  const sharedForeign: GuardResult['sharedForeign'] = [];

  for (const s of signals) {
    const owner = registry.find(i => {
      switch (s.form) {
        case 'cid': return i.affiliate_cid === s.value;
        case 'promo_code': return i.promo_code != null && i.promo_code.toUpperCase() === s.value.toUpperCase();
        case 'ref': return i.ref_id === s.value;
        case 'utm_campaign': return i.utm_campaign === s.value;
      }
    });
    if (owner && owner.channel_id !== channelId) {
      sharedForeign.push({ ...s, ownerChannel: owner.channel_id, ownerName: owner.channel_name || '' });
    } else {
      mergeable.push(s);
    }
  }
  return { mergeable, sharedForeign };
}

/**
 * 用已知 registry 解析一个频道的已知身份（cid → code → handle 模糊/转写）。
 * 返回 { identity, via }；无命中返回 null。
 */
export function resolveKnownIdentity(
  channelId: string,
  cids: string[],
  codes: string[],
  utms: string[],
  registry: IdentityRow[],
): { identity: IdentityRow; via: string } | null {
  for (const c of cids) {
    const hit = registry.find(i => i.affiliate_cid === c);
    if (hit) return { identity: hit, via: `cid=${c}` };
  }
  for (const c of codes) {
    const hit = registry.find(i => i.promo_code != null && i.promo_code.toUpperCase() === c);
    if (hit) return { identity: hit, via: `code=${c}` };
  }
  for (const h of utms) {
    const hit = matchHandle(h, registry);
    if (hit) return { identity: hit, via: `utm_campaign=${h}` };
  }
  return null;
}

// 已确认的 handle↔已知 creator 转写/别名映射（源自 B 阶段 audit 确认 2026-08-27：
// ForitYT=Форит/16、ry6kaGOP=ry6ka Play/13 —— 字符串匹配无法覆盖转写，显式维护）
const KNOWN_ALIASES: Array<[string, string]> = [
  ['ForitYT', 'Форит'],
  ['ry6kaGOP', 'ry6ka Play'],
];

function matchHandle(h: string, registry: IdentityRow[]): IdentityRow | null {
  const nh = norm(h);
  if (!nh) return null;
  const idx: Array<{ n: string; id: IdentityRow }> = [];
  for (const i of registry) {
    if (i.channel_name) idx.push({ n: norm(i.channel_name), id: i });
    if (i.promo_code) idx.push({ n: norm(i.promo_code), id: i });
  }
  // 1) 精确/双向 substring（"Wolfy" ⊂ "Wolfy & Нитрыч"）
  for (const { n, id } of idx) {
    if (n.includes(nh) || nh.includes(n)) return id;
  }
  // 2) 转写别名（Cyrillic↔Latin）
  const alias = KNOWN_ALIASES.find(([a]) => norm(a) === nh);
  if (alias) {
    const tn = norm(alias[1]);
    for (const { n, id } of idx) {
      if (n === tn || n.includes(tn) || tn.includes(n)) return id;
    }
  }
  return null;
}

/**
 * CLI — LagZapper Creator-driven Validation（2026-08-30）
 *
 * 验证 6 个「handle/code-only 弱身份信号」候选，能否通过同频道 90 天历史
 * uploads 找到 LagZapper 强证据，从而安全升级为正式 KOL identity。
 *
 * 全程只读：
 *   - 禁止 search.list —— 不消耗 Search 独立 quota bucket，不碰 quota ledger RPC。
 *   - 禁止写 DB / 禁改 watchlist / 禁触发 AI。
 *   - 只允许 channels.list + playlistItems.list + videos.list（general quota）。
 *
 * 每候选管道：
 *   weak signal(handle/code) → channel_id（下方候选表由 DB 描述证据解析，见注释）
 *     → 90d uploads 分页扫描（playlistItems 直到整页早于 cutoff）
 *     → 逐视频 title+desc 提取 LZ 信号（extractKOLTrackingSignals 只收 lagzapper 域 URL）
 *     → guardOwnership 所有权护栏（共享链接信号绝不并入 → 不进 strong 证据）
 *     → 证据分级 HIGH / MEDIUM / REJECT
 *
 * Gate（按用户协议，2026-08-30）：
 *   HIGH   ≥1 条视频：显式 LZ 域名 + creator-specific tracking signal
 *          （cid / promo_code / utm·ref 匹配自身 handle），且该信号无 ownership 冲突
 *   MEDIUM handle/code 在 ≥2 条视频重复出现（无 LZ 域名强证据）；或 LZ 域名+信号但非强证据
 *   REJECT 仅品牌提及 / 仅 shared-link / 90d 内无可归属证据
 *
 * 决策规则（报告，不自动执行）：≥3/6 HIGH → 产品化；1-2/6 → 补充证据，暂不进池；0/6 → 停止方向。
 *
 * 用法：npm run lz-creator-validate
 */
import axios from 'axios';
import { config } from './config';
import { getSupabase } from './db/supabase';
import { getVideosByIds, type YouTubeVideoResult } from './services/competitor-monitor/youtube-discovery';
import {
  extractKOLTrackingSignals, guardOwnership, resolveKnownIdentity, norm,
  type IdentityRow, type KOLSignal,
} from './services/competitor-monitor/kol-tracking';

// kol-tracking 内同名正则为模块私有，这里按同一定义本地复刻（避免改共享模块）。
const LZ_DOM_RE = /lagzapper(?:\.com|\.gg|\.net|\.io|\.app|\.ru)/i;
const BRAND_RE = /lagzapper/i;

/** 候选：channel_id 由 DB 中「描述含 lagzapper + 含 handle/code」的视频证据唯一解析（见 _tmp 解析结果）。 */
interface Candidate {
  display: string;          // 频道名（DB channel_name）
  channelId: string;
  handle: string | null;    // utm_campaign / ref 弱信号（归一后精确匹配）
  code: string | null;      // promo_code 弱信号
  dbEvidence: number;       // DB 中该频道 lagzapper 视频条数（解析时的证据）
}

const CANDIDATES: Candidate[] = [
  { display: 'Makar Busalkin', channelId: 'UCBJkY8Kn4EGkDZmgEPxQxnQ', handle: 'makarbusalkin', code: null, dbEvidence: 4 },
  { display: 'More Sn1p3rrr',  channelId: 'UCrHJImlSA2yJ9iz27FnEluA', handle: 'sn1p3rrr',      code: null, dbEvidence: 1 },
  { display: 'ntswitches',     channelId: 'UCHjUpCxwqhqZ_ADjbgkdh1w', handle: 'scathe',        code: null, dbEvidence: 1 },
  { display: 'Bandz',          channelId: 'UC95DdAaU0dThWYS0aR-Og-Q', handle: 'bandz',         code: null, dbEvidence: 1 },
  { display: 'Симон Клик',     channelId: 'UCIVL3pSl36CNGMrL16TgZ1Q', handle: 'thesimon',      code: null, dbEvidence: 1 },
  { display: 'Timba-x',        channelId: 'UCQ0p8laY0ROqegUWlxRjAPw', handle: null,            code: 'TIMBA-X', dbEvidence: 1 },
];

/** 该信号是否匹配候选自身的 handle/code（utm·ref 精确匹配 handle；promo_code 匹配 code）。 */
function selfMatches(s: KOLSignal, c: Candidate): boolean {
  const own = new Set<string>();
  if (c.handle) own.add(norm(c.handle));
  if (c.code) own.add(norm(c.code));
  return own.has(norm(s.value));
}

/** 分页拉取 uploads 播放列表，直到整页早于 cutoff（uploads 按时间倒序）。只走 general quota。 */
async function fetchUploadsSince(channelId: string, sinceISO: string, maxPages = 8): Promise<YouTubeVideoResult[]> {
  const key = config.youtube.apiKey;
  if (!key) { console.error('✗ 无 YouTube API key'); return []; }

  const { data: chData } = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: { part: 'contentDetails', id: channelId, key }, timeout: 10000,
  });
  const uploadsId = chData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return [];

  const ids: Array<{ id: string; publishedAt: string }> = [];
  let pageToken = '';
  for (let p = 0; p < maxPages; p++) {
    const { data: plData } = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: { part: 'snippet', playlistId: uploadsId, maxResults: 50, pageToken: pageToken || undefined, key },
      timeout: 10000,
    });
    const items = plData?.items || [];
    let anyWithin = false;
    for (const it of items) {
      const pubAt = it?.snippet?.publishedAt;
      const vid = it?.snippet?.resourceId?.videoId;
      if (!vid || !pubAt) continue;
      if (pubAt >= sinceISO) { ids.push({ id: vid, publishedAt: pubAt }); anyWithin = true; }
    }
    pageToken = plData?.nextPageToken || '';
    if (!pageToken || !anyWithin) break; // 整页早于 cutoff → 停（uploads 倒序）
  }
  return (await getVideosByIds(ids.map(x => x.id))).filter(v => v.publishedAt >= sinceISO);
}

interface CandResult {
  c: Candidate;
  scanned: number;
  lzMention: number;
  lzDomain: number;
  signalVideos: number;
  strongVideos: number;
  repeatVideos: number;
  cids: string[];
  codes: string[];
  utms: string[];
  refs: string[];
  shared: Array<{ signal: string; owner: string }>;
  knownVia: string | null;
  final: 'HIGH' | 'MEDIUM' | 'REJECT';
  rationale: string;
}

async function main() {
  const db = getSupabase();
  const sinceISO = new Date(Date.now() - 90 * 86400000).toISOString();
  console.log('═══ LagZapper Creator-driven Validation（全程只读 · 无 search.list · 不写 DB）═══');
  console.log(`cutoff=${sinceISO.slice(0, 10)}（90d）· 候选 ${CANDIDATES.length} 个\n`);

  const { data: ai, error: ae } = await db.from('affiliate_identities')
    .select('brand, channel_id, channel_name, promo_code, affiliate_cid, ref_id, domain, signal_type, confidence')
    .eq('brand', 'LagZapper');
  if (ae) { console.error('✗ identities 查询失败:', ae.message); process.exit(1); }
  const registry: IdentityRow[] = ai || [];
  console.log(`[registry] LagZapper 已确认身份 ${registry.length} 条\n`);

  const results: CandResult[] = [];
  for (const c of CANDIDATES) {
    const videos = await fetchUploadsSince(c.channelId, sinceISO);
    const r: CandResult = {
      c, scanned: 0, lzMention: 0, lzDomain: 0, signalVideos: 0,
      strongVideos: 0, repeatVideos: 0, cids: [], codes: [], utms: [], refs: [],
      shared: [], knownVia: null, final: 'REJECT', rationale: '',
    };
    const allSignals: KOLSignal[] = [];
    const cidS = new Set<string>(), codeS = new Set<string>(), utmS = new Set<string>(), refS = new Set<string>();

    for (const v of videos) {
      r.scanned++;
      const text = `${v.title || ''} ${v.description || ''}`;
      if (BRAND_RE.test(text)) r.lzMention++;
      const signals = extractKOLTrackingSignals(v.description);
      if (signals.length) r.signalVideos++;
      const hasDom = LZ_DOM_RE.test(v.description || '');
      if (hasDom) r.lzDomain++;
      const selfHits = signals.filter(s => selfMatches(s, c));
      if (selfHits.length) r.repeatVideos++;
      allSignals.push(...signals);
      for (const s of signals) {
        if (s.form === 'cid') cidS.add(s.value);
        else if (s.form === 'promo_code') codeS.add(s.value);
        else if (s.form === 'ref') refS.add(s.value);
        else utmS.add(s.value);
      }
    }

    // 所有权护栏：被他人认领的信号 = 共享链接，绝不作为本频道强证据。
    const { mergeable, sharedForeign } = guardOwnership(c.channelId, allSignals, registry);
    const foreignKey = new Set(sharedForeign.map(s => `${s.form}:${norm(s.value)}`));
    const isForeign = (s: KOLSignal) => foreignKey.has(`${s.form}:${norm(s.value)}`);
    for (const s of sharedForeign) r.shared.push({ signal: `${s.form}=${s.value}`, owner: s.ownerName || s.ownerChannel });

    // strong = 显式 LZ 域名 + creator-specific 信号（cid / promo_code / 自身 handle·code），且无 ownership 冲突
    for (const v of videos) {
      const signals = extractKOLTrackingSignals(v.description);
      if (!LZ_DOM_RE.test(v.description || '')) continue;
      if (signals.some(s => !isForeign(s) && (s.form === 'cid' || s.form === 'promo_code' || selfMatches(s, c)))) {
        r.strongVideos++;
      }
    }

    r.cids = [...cidS]; r.codes = [...codeS]; r.utms = [...utmS]; r.refs = [...refS];

    // 已知身份检查（理论上这 6 个都不在 registry；命中的话按已知身份报告，不升级）
    const known = resolveKnownIdentity(c.channelId, r.cids, r.codes, r.utms, registry);
    r.knownVia = known && known.identity.channel_id === c.channelId ? `known:${known.via}` : null;

    // ── 分级 ──
    const allForeign = allSignals.length > 0 && sharedForeign.length === allSignals.length;
    if (r.knownVia) { r.final = 'MEDIUM'; r.rationale = `已入库身份（${r.knownVia}），非新候选`; }
    else if (r.strongVideos >= 1) {
      r.final = 'HIGH';
      r.rationale = `${r.strongVideos} 条 LZ 域名+creator-specific 信号强证据视频，无 ownership 冲突`;
    } else if (r.repeatVideos >= 2) {
      r.final = 'MEDIUM';
      r.rationale = `handle/code 在 ${r.repeatVideos} 条视频重复出现，但无 LZ 域名强证据`;
    } else if (allForeign) {
      r.final = 'REJECT';
      r.rationale = `仅 shared-link：观测到的 ${allSignals.length} 条信号全部归属他频道（${r.shared.map(s => s.owner).join(', ')}），不并入`;
    } else if (r.lzDomain >= 1) {
      r.final = 'MEDIUM';
      r.rationale = `LZ 域名+追踪信号存在，但信号非 creator-specific（无 cid/promo_code/自身 handle）`;
    } else if (r.lzMention >= 1) {
      r.final = 'REJECT';
      r.rationale = '仅品牌提及，无域名/追踪信号';
    } else {
      r.final = 'REJECT';
      r.rationale = '90d 内无 LagZapper 证据';
    }

    results.push(r);
    console.log(`  ✓ ${c.display.padEnd(16)} scanned=${videos.length} · strong=${r.strongVideos} · repeat=${r.repeatVideos} → ${r.final}`);
  }

  // ── 证据汇总表 ──
  const col = (s: string | number, w: number) => String(s).padEnd(w);
  const h = `${col('Creator', 16)}${col('弱信号', 12)}${col('DB证据', 6)}${col('90d扫描', 7)}${col('LZ信号', 6)}${col('强证据', 6)}${col('cid', 10)}${col('code', 10)}${col('utm', 12)}${col('ref', 10)}${col('shared冲突', 12)}${col('结论', 8)}`;
  console.log(`\n${h}\n${'-'.repeat(h.length)}`);
  for (const r of results) {
    const weak = r.c.handle ? `utm=${r.c.handle}` : `code=${r.c.code}`;
    console.log(
      `${col(r.c.display, 16)}${col(weak, 12)}${col(r.c.dbEvidence, 6)}${col(r.scanned, 7)}${col(r.signalVideos, 6)}${col(r.strongVideos, 6)}` +
      `${col(r.cids.join(',').slice(0, 9), 10)}${col(r.codes.join(',').slice(0, 9), 10)}${col(r.utms.join(',').slice(0, 11), 12)}${col(r.refs.join(',').slice(0, 9), 10)}` +
      `${col(r.shared.map(s => s.signal).join(';').slice(0, 11) || '—', 12)}${col(r.final, 8)}`
    );
  }
  console.log(`\n详细证据：`);
  for (const r of results) {
    console.log(`  [${r.final}] ${r.c.display} —— ${r.rationale}`);
    if (r.cids.length) console.log(`      cid: ${r.cids.join(', ')}`);
    if (r.codes.length) console.log(`      promo_code: ${r.codes.join(', ')}`);
    if (r.utms.length) console.log(`      utm_campaign: ${r.utms.join(', ')}`);
    if (r.refs.length) console.log(`      ref: ${r.refs.join(', ')}`);
    if (r.shared.length) console.log(`      ⚠ shared-link 冲突: ${r.shared.map(s => `${s.signal}→${s.owner}`).join('; ')}`);
  }

  const high = results.filter(r => r.final === 'HIGH').length;
  const med = results.filter(r => r.final === 'MEDIUM').length;
  console.log(`\n════ 决策参考：HIGH=${high}/6 · MEDIUM=${med}/6 · REJECT=${6 - high - med}/6`);
  console.log(`规则：≥3 HIGH → 产品化；1-2 HIGH → 补充证据暂不进池；0 HIGH → 停止方向。`);
  console.log(`本 CLI 只读，0 写操作；未写 watchlist / 未动 NORMAL_QUERIES / 未 push。`);
}

main().catch((e) => { console.error('validator 异常:', e); process.exit(2); });

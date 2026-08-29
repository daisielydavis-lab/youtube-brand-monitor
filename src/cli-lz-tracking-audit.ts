/**
 * LagZapper tracking signal 只读审计（2026-08-29）—— 不消费 Search quota
 *
 * 目的：摸清现有 DB 里 LagZapper 相关视频描述中实际出现的追踪参数形态，
 * 为「LagZapper 特殊 tracking matcher」设计提供数据依据。
 * 只读；不含任何写入 / Search / backfill。
 *
 * 用法：npm run lz-audit   （本地 getSupabase() 连生产库，只读）
 */
import { getSupabase } from './db/supabase';

const LZ_DOM_RE = /lagzapper(?:\.com|\.gg|\.net|\.io|\.app|\.ru|\.me)/i;
const URL_PARAM_RE = /[?&]([A-Za-z0-9_.-]+)=([^&\s"']*)/g;

async function main() {
  const db = getSupabase();
  console.log('═══ LagZapper tracking signal 只读审计 ═══\n');

  // ── 1. LagZapper 相关视频（描述含 lagzapper 域名或字样）──
  const { data: vids, error: ve } = await db
    .from('youtube_competitor_videos')
    .select('id, channel_id, title, description, published_at, canonical_brand, raw_brand')
    .ilike('description', '%lagzapper%');
  if (ve) { console.error('✗ 视频查询失败:', ve.message); process.exit(1); }

  console.log(`1. 描述含 "lagzapper" 的视频总数：${vids.length}`);
  const domMatch = vids.filter(v => LZ_DOM_RE.test(v.description || ''));
  console.log(`   - 其中描述含 lagzapper 域名(lagzapper.com/.gg/...) 的：${domMatch.length}`);

  // ── 2. 描述中出现的追踪参数（cid/code/ref 等）形态统计 ──
  const paramStats: Record<string, Set<string>> = {};
  const hostStats: Record<string, number> = {};
  const urlWithParams: string[] = [];
  for (const v of vids) {
    const desc = v.description || '';
    const doms = desc.match(/(?:https?:\/\/)?(?:www\.)?lagzapper\.[a-z.]+\/[^\s"']*/gi) || [];
    for (const u of doms) {
      const host = (u.match(/lagzapper\.[a-z.]+/i) || [''])[0];
      hostStats[host] = (hostStats[host] || 0) + 1;
      if (/\?/.test(u)) {
        urlWithParams.push(u);
        let m;
        URL_PARAM_RE.lastIndex = 0;
        const qs = u.split('?')[1] || '';
        while ((m = URL_PARAM_RE.exec(qs))) {
          const key = m[1].toLowerCase();
          (paramStats[key] = paramStats[key] || new Set()).add(m[2]);
        }
      }
    }
    // 描述里裸 cid=/code=/ref=（不在 URL 内）
    for (const m of desc.matchAll(/(?:cid|code|ref|promo|ref_id|refid|trackid|clickid)[\s=:]*([A-Za-z0-9_-]{2,40})/gi)) {
      const key = (m[0].match(/(cid|code|ref|promo|ref_id|refid|trackid|clickid)/i) || [''])[0].toLowerCase();
      (paramStats[key] = paramStats[key] || new Set()).add(m[1]);
    }
  }

  console.log('\n2. lagzapper.* 域名 host 分布：');
  for (const [h, c] of Object.entries(hostStats).sort((a, b) => b[1] - a[1])) console.log(`   ${h}: ${c}`);
  console.log('\n   URL 里出现的查询参数（key: 去重后的取值数 / 示例）：');
  for (const [k, s] of Object.entries(paramStats).sort((a, b) => b[1].size - a[1].size)) {
    const arr = [...s].slice(0, 5);
    console.log(`   ${k}: ${s.size} 种 → ${arr.join(', ')}${s.size > 5 ? ' …' : ''}`);
  }
  console.log('\n   带查询参数的 lagzapper URL 示例（最多 10 条）：');
  urlWithParams.slice(0, 10).forEach(u => console.log('   ' + u));

  // ── 3. affiliate_identities brand=LagZapper ──
  const { data: ai, error: ae } = await db
    .from('affiliate_identities')
    .select('*')
    .eq('brand', 'LagZapper')
    .limit(200);
  if (ae) { console.error('\n✗ affiliate_identities 查询失败:', ae.message); }
  else {
    console.log(`\n3. affiliate_identities brand=LagZapper：${ai.length} 行`);
    if (ai.length) {
      console.log('   列名:', Object.keys(ai[0]).join(', '));
      ai.slice(0, 8).forEach(r => console.log(`   [${r.brand}] ${r.channel_id} — ${JSON.stringify(r).slice(0, 200)}`));
    }
  }

  // ── 4. watchlist brand=LagZapper ──
  const { data: wl, error: we } = await db
    .from('youtube_creator_watchlist')
    .select('channel_id, brand, discovered_via')
    .eq('brand', 'LagZapper')
    .limit(500);
  if (we) { console.error('\n✗ watchlist 查询失败:', we.message); }
  else console.log(`\n4. youtube_creator_watchlist brand=LagZapper：${wl.length} 行`);

  // ── 5. 交叉核对：视频里的 cid / promo code 是否已入 identities（未映射 = 新身份候选）──
  const knownCids = new Set((ai || []).map(r => r.affiliate_cid).filter(Boolean));
  const knownCodes = new Set((ai || []).map(r => r.promo_code).filter(Boolean));
  const vidCids = paramStats['cid'] || new Set();
  const vidCodes = new Set([...(paramStats['code'] || []), ...(paramStats['promo'] || [])]);
  const newCids = [...vidCids].filter(c => !knownCids.has(String(c)) && !/^\d{1,2}$/.test(String(c)));
  const allNewCids = [...vidCids].filter(c => !knownCids.has(String(c)));
  console.log('\n5. 交叉核对（视频 vs identities）:');
  console.log(`   视频 cid ${vidCids.size} 种；已知 identities ${knownCids.size} 种`);
  console.log(`   未映射 cid：${allNewCids.length} 种 → ${[...allNewCids].slice(0, 20).join(', ')}${allNewCids.length > 20 ? ' …' : ''}`);
  console.log(`   未映射 promo code：${[...vidCodes].filter(c => !knownCodes.has(String(c))).join(', ') || '（无）'}`);
  console.log(`   utm_campaign（博主 handle 候选）：${[...(paramStats['utm_campaign'] || [])].join(', ') || '（无）'}`);

  console.log('\n═══ 审计结束（只读，无写入）═══');
}

main().catch((e) => { console.error('审计异常:', e); process.exit(2); });

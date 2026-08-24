/**
 * Lagofast 第 4 品牌回填（2026-08-24，用户已拍板）
 *
 * 背景: RU 加速器 affiliate 生态是多品牌联合投放 —— 同一批 creator 同时投
 * LagZapper / Lagofast / ExitLag。Lagofast 的 affiliate creator 是 LagZapper
 * 的最佳 crossover 候选。此前 DB 里 Lagofast 投放未被识别：
 * 诊断 52 条 desc 含 lagofast.* 域名（0 条同时含 lagzapper 域名 → 归因无歧义），
 * 当前误归属: LagZapper 2 / GearUP 3 / unknown 40 / likely_sponsored 7。
 *
 * 本脚本（幂等）:
 *   1. competitor_brands 插入 Lagofast（onConflict brand_name）
 *   2. 全库扫描 desc 含 lagofast.* 域名且无 lagzapper.* 域名的视频
 *      → 落 raw_brand='Lagofast', canonical_brand='Lagofast', brand_confidence=0.85
 *      （域名为品牌证据，置信度同 rule-classifier domainMatch）
 *   3. 每个 Lagofast creator → affiliate_identities brand='Lagofast'（domain 信号 0.7）
 *   4. 每个 Lagofast creator → youtube_creator_watchlist brand='Lagofast'（affiliate_cluster）
 *
 * 用法:
 *   npm run affiliate:lagofast             # dry-run（只读，打印计划，不写库）
 *   npm run affiliate:lagofast -- --apply  # 写库
 */
import { getSupabase } from './db/supabase';

const LAGO_DOM_RE = /lagobooster\.ru|lago-fast\.com|lagofast\.com|lagofastbooster\.ru/i;
const LZ_DOM_RE = /lagzapper(?:\.com|\.gg|\.net|\.io|\.app|\.ru)/i;
const BRAND_CONF = 0.85;

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`═══ Lagofast 第 4 品牌回填 ${apply ? '【APPLY 写库】' : '【dry-run 只读】'} ═══`);
  if (!apply) console.log('（加 --apply 才会写库）');
  const db = getSupabase();

  // ── 0. 拉全库视频（分页）──
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos')
      .select('video_id,channel_id,channel_name,description,raw_brand,canonical_brand,placement_type,workflow_status')
      .range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`全库 ${all.length} 行`);

  // ── 1. competitor_brands 插入 Lagofast ──
  console.log('\n── ① competitor_brands ──');
  const brandRow = {
    brand_name: 'Lagofast', display_name: 'Lagofast', website_domain: 'lagofast.com',
    category: 'game_booster', is_active: true,
  };
  if (apply) {
    const { data, error } = await db.from('competitor_brands')
      .upsert(brandRow, { onConflict: 'brand_name' }).select('id').single();
    if (error) console.error(`   upsert 失败: ${error.message}`);
    else console.log(`   Lagofast 品牌行 id=${data?.id} ${data ? '（已就绪）' : ''}`);
  } else {
    console.log('   将插入 brand_name=Lagofast（幂等 upsert）');
  }

  // ── 2. 视频回填归属 ──
  console.log('\n── ② 视频回填归属 ──');
  const lagoOnly = all.filter(v => LAGO_DOM_RE.test(v.description || '') && !LZ_DOM_RE.test(v.description || ''));
  const transitions: Record<string, number> = {};
  for (const v of lagoOnly) {
    const from = v.canonical_brand || v.raw_brand || v.placement_type || '(none)';
    transitions[from] = (transitions[from] || 0) + 1;
  }
  console.log(`lagofast 域名视频 ${lagoOnly.length} 条，当前归属: ${JSON.stringify(transitions)}`);
  if (apply) {
    let ok = 0;
    for (const v of lagoOnly) {
      if (v.canonical_brand === 'Lagofast' && v.raw_brand === 'Lagofast') continue;
      const { error } = await db.from('youtube_competitor_videos').update({
        raw_brand: 'Lagofast', canonical_brand: 'Lagofast', brand_confidence: BRAND_CONF,
        last_updated_at: new Date().toISOString(),
      }).eq('video_id', v.video_id);
      if (!error) ok++;
    }
    console.log(`   已回填 ${ok} 条（跳过已正确归属的）`);
  } else {
    console.log(`   将把 ${lagoOnly.length} 条 canonical_brand → Lagofast（raw_brand 同步，brand_confidence=${BRAND_CONF}）`);
  }

  // ── 3. affiliate_identities ──
  console.log('\n── ③ affiliate_identities ──');
  const chans = new Map<string, { name: string; domain: string; n: number }>();
  for (const v of lagoOnly) {
    const dom = (v.description || '').match(LAGO_DOM_RE);
    const existing = chans.get(v.channel_id) || { name: v.channel_name || '', domain: dom ? dom[0] : 'lagofast.com', n: 0 };
    existing.n++;
    chans.set(v.channel_id, existing);
  }
  console.log(`Lagofast creator ${chans.size} 个频道`);
  for (const [cid, c] of chans) console.log(`   ${cid} ${c.name.slice(0, 22).padEnd(22)} ×${c.n}`);
  if (apply) {
    let ok = 0;
    for (const [cid, c] of chans) {
      const { error } = await db.from('affiliate_identities').upsert({
        brand: 'Lagofast', channel_id: cid, channel_name: c.name,
        domain: c.domain, signal_type: 'domain', confidence: 0.7,
        first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      }, { onConflict: 'brand,channel_id' });
      if (!error) ok++;
    }
    console.log(`   已写入 ${ok} 条身份`);
  } else {
    console.log(`   将写入 ${chans.size} 条 brand=Lagofast 身份（signal_type=domain, confidence=0.7）`);
  }

  // ── 4. watchlist ──
  console.log('\n── ④ watchlist ──');
  if (apply) {
    let ok = 0;
    for (const [cid, c] of chans) {
      const { error } = await db.from('youtube_creator_watchlist').upsert({
        brand: 'Lagofast', channel_id: cid, channel_name: c.name,
        market: null, discovered_via: 'affiliate_cluster', status: 'active',
        last_scan_at: null,
      }, { onConflict: 'brand,channel_id' });
      if (!error) ok++;
    }
    console.log(`   已写入 ${ok} 个 watchlist（affiliate_cluster）`);
  } else {
    console.log(`   将写入 ${chans.size} 个 watchlist（brand=Lagofast, discovered_via=affiliate_cluster）`);
  }

  console.log('\n═══ 完成（dry-run 未写库；加 --apply 执行）═══');
}

main().catch(e => { console.error(e); process.exit(1); });

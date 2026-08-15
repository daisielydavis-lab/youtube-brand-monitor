/**
 * YouTube Competitor Monitor v3 — Tabbed Dashboard UI
 * Tabs: Overview | Campaigns | Videos | Creators | Comments | System
 */
import type { DashboardData } from '../services/competitor-monitor/dashboard-data';

/** Shell: renders instantly, no DB access. JS fetches /api/dashboard. */
export function renderDashboardShell(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor Monitor</title>
<style>${SHELL_CSS}</style></head><body>
<div class="shell">
  <div class="shell-header"><h1>📊 YouTube Competitor Monitor</h1><p>GearUP · ExitLag · LagZapper</p></div>
  <div class="shell-card" id="shell-content">
    <div class="spinner"></div>
    <p id="shell-status">Loading dashboard data…</p>
    <button id="shell-retry" onclick="loadDashboard()" style="display:none">Retry</button>
  </div>
</div>
<script>
async function loadDashboard() {
  var el = document.getElementById('shell-status');
  var retry = document.getElementById('shell-retry');
  el.textContent = 'Loading dashboard data…';
  retry.style.display = 'none';
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function(){controller.abort()}, 10000);
    var resp;
    try { resp = await fetch('/api/dashboard', {signal: controller.signal}); }
    catch(e) { resp = null; }
    clearTimeout(timeout);
    if (!resp) {
      el.innerHTML = 'Dashboard data could not be loaded.<br><small>Request timed out. The monitor data is safely stored.</small>';
      retry.style.display = 'inline-block';
      return;
    }
    if (!resp.ok) {
      el.innerHTML = 'Dashboard data could not be loaded.<br><small>The monitor data is safely stored, but the dashboard service did not respond.</small>';
      retry.style.display = 'inline-block';
      return;
    }
    var json = await resp.json();
    if (json.error) {
      el.innerHTML = '⚠️ ' + json.error + '<br><small>Your data is safe. Please retry.</small>';
      retry.style.display = 'inline-block';
      return;
    }
    // Store in sessionStorage before reload (survives reload, unlike window vars)
    sessionStorage.setItem('dashboardData', JSON.stringify(json));
    location.reload();
  } catch(e) {
    el.textContent = 'Connection failed. Please check your network.';
    retry.style.display = 'inline-block';
  }
}
// Check if data already loaded via sessionStorage
(function(){
  var cached = sessionStorage.getItem('dashboardData');
  if (cached) {
    sessionStorage.removeItem('dashboardData');
    // Redirect to server-rendered page; server will query fresh
    location.href = '/';
    return;
  }
  loadDashboard();
})();
</script></body></html>`;
}

export function renderDashboard(
  data: DashboardData,
  filter: Record<string, string>,
  campaigns: any[],
  sysStatus: any,
): string {
  const esc = (s: string) => s?.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') || '';
  const fmt = (n: number) => n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n);
  const sel = (k: string, v: string) => filter[k]===v?'selected':'';
  const bc = (b: string) => ({GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'} as any)[b]||'#94a3b8';
  const badge = (t: string) => {
    const m: Record<string,string> = {confirmed_paid_placement:'已确认',likely_sponsored:'疑似投放',organic_mention:'自然提及',official_brand_video:'官方视频',unknown:'未知'};
    return `<span class="b b-${t}">${m[t]||t}</span>`;
  };
  const timeAgo = (iso: string) => {
    if(!iso) return 'Never'; const d=(Date.now()-new Date(iso).getTime())/1000;
    return d<60?'Just now':d<3600?Math.floor(d/60)+'m':d<86400?Math.floor(d/3600)+'h':Math.floor(d/86400)+'d ago';
  };
  const timeAgoZh = (iso: string) => {
    if(!iso) return '从未'; const d=(Date.now()-new Date(iso).getTime())/1000;
    return d<60?'刚刚':d<3600?Math.floor(d/60)+' 分钟前':d<86400?Math.floor(d/3600)+' 小时前':Math.floor(d/86400)+' 天前';
  };

  // ── Empty state ──
  if (!data.hasData) return emptyState(sysStatus);

  const quotaPct = Math.round((sysStatus.searchQuotaUsed||0)/100*100);

  // ── TAB 1: Overview ──
  const kpi = data.kpi as any;
  // Two separate KPIs (Stage ④ UI 口径): Discovery Coverage = pipeline
  // throughput; AI Review Progress = final-classification backlog. 100%
  // discovery coverage does NOT mean all videos were AI-verified.
  const aiPending = kpi.aiPending ?? 0;
  const aiReviewed = kpi.aiReviewed ?? (kpi.totalAnalyzed ?? 0) - aiPending;
  const aiPct = aiReviewed + aiPending > 0 ? Math.round(aiReviewed / (aiReviewed + aiPending) * 100) : 0;
  const aiColor = aiPct >= 80 ? '#19A974' : aiPct >= 50 ? '#F59E0B' : '#EF5B5B';
  const pendingStatus = aiPending > 0
    ? `<div style="font-size:11px;color:#F59E0B;margin-top:2px">${aiReviewed.toLocaleString()} 已分析 · ${aiPending.toLocaleString()} 待复核</div>`
    : `<div style="font-size:11px;color:#19A974;margin-top:2px">${aiReviewed.toLocaleString()} 已分析 · 完成</div>`;
  // Data scope 日期友好格式: "2026-08-08" → "Aug 8, 2026"
  const fmtScopeDate = (s: string): string => {
    if (!s) return '';
    const [y, mo, d] = s.split('-');
    const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Math.max(0, Math.min(11, (+mo || 1) - 1))];
    return `${mn} ${+d || 1}, ${y}`;
  };
  // Stage ⑦ 产品化: 采集与分析解耦。KPI 行 = 业务数字; 口径条 = 数据范围+AI 进度状态
  // Stage ⑧ 口径收口: 口径条压缩成一行式 — 当前范围 直接回显顶部三筛选器
  const rangeDaysNow = parseInt((filter.range || '7').replace(/[^0-9]/g, '') || '7', 10);
  const rangeLabel = ({1:'过去24小时',7:'过去7天',30:'过去30天',90:'过去90天'} as any)[rangeDaysNow] || `过去${rangeDaysNow}天`;
  const MKT_ZH: Record<string, string> = { US: '美国', RU: '俄罗斯', BR: '巴西', Unknown: '地区未知' };
  const fmtScopeDateZh = (s: string): string => {
    if (!s) return '';
    const [, mo, d] = s.split('-');
    return `${+mo || 1}月${+d || 1}日`;
  };
  const scopeBrandZh = filter.brand && filter.brand !== 'all' ? filter.brand : '全部竞品';
  const scopeMarketZh = filter.market && filter.market !== 'all' ? (MKT_ZH[filter.market] || filter.market) : '全球';
  const totalPlacementsN = kpi.totalPlacements ?? kpi.competitorPlacements ?? 0;
  // % = AI 已复核 / 共发现 (与用户示例口径一致: 2,248/2,838 = 79%)
  const aiPctAll = (kpi.totalVideos ?? 0) > 0 ? Math.round(aiReviewed / (kpi.totalVideos ?? 1) * 100) : 0;
  const overview = `
  <div class="kpi-row" style="grid-template-columns:repeat(5,1fr)">
    <div class="kpi hl"><div class="kpi-n">${totalPlacementsN}</div><div class="kpi-l">竞品投放</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.uniqueCreators ?? 0}</div><div class="kpi-l">投放博主</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.totalGames ?? 0}</div><div class="kpi-l">覆盖游戏</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.activeCampaigns ?? 0}</div><div class="kpi-l">集中投放项目</div></div>
    <div class="kpi"><div class="kpi-n" style="color:${aiColor}">${aiPct}%</div><div class="kpi-l">AI分析完成</div>${pendingStatus}</div>
  </div>

  <div style="background:#F8FAFD;border:1px solid #E3E8F1;border-radius:8px;padding:10px 14px;margin-bottom:12px">
    <div style="font-size:12.5px;color:#4B5870;font-weight:600">当前范围：${scopeBrandZh} · ${scopeMarketZh} · ${rangeLabel}（${fmtScopeDateZh(kpi.windowStart ?? '')}–${fmtScopeDateZh(kpi.windowEnd ?? '')}）</div>
    <div style="font-size:14px;margin:5px 0;color:#172033"><b style="font-size:16px">${totalPlacementsN.toLocaleString()}</b> 条投放　<b style="font-size:16px">${(kpi.uniqueCreators ?? 0).toLocaleString()}</b> 位博主　<b style="font-size:16px">${kpi.totalGames ?? 0}</b> 款游戏　<b style="font-size:16px">${kpi.activeCampaigns ?? 0}</b> 个项目</div>
    <div style="font-size:12.5px;color:#8490A6">共发现 ${(kpi.totalVideos ?? 0).toLocaleString()} 条视频 · AI 已分析 ${aiReviewed.toLocaleString()} 条（${aiPctAll}%）· 待分析 ${aiPending.toLocaleString()} 条</div>
    <div style="font-size:12.5px;${aiPending > 0 ? 'color:#C2570B' : 'color:#19A974'};margin-top:2px">${aiPending > 0 ? `🟠 数据仍在补充，最终投放数量可能增加` : '🟢 AI 分析完成 100%，当前窗口数据已完整'}</div>
  </div>

  ${(kpi.campaignPlacements ?? 0) + (kpi.standalonePlacements ?? 0) > 0 ? `
  <div style="display:flex;align-items:center;gap:10px;font-size:12px;margin-bottom:12px;padding:8px 12px;background:#F3F7FF;border:1px solid #DCE5F7;border-radius:8px;color:#4B5870">
    <span style="font-weight:700;color:#172033">${totalPlacementsN.toLocaleString()} 条竞品投放视频</span>
    <span style="color:#A3ADC2">→</span>
    <span>🟦 <b style="color:#3B6EF5">${(kpi.campaignPlacements ?? 0).toLocaleString()}</b> 条属于集中投放项目 · 共 <b>${kpi.activeCampaigns ?? 0}</b> 个项目</span>
    <span style="color:#A3ADC2">|</span>
    <span>⬜ <b style="color:#8490A6">${(kpi.standalonePlacements ?? 0).toLocaleString()}</b> 条独立投放</span>
  </div>` : ''}

  <h2>🚨 重点投放项目</h2>
  ${campaigns.length ? campaigns.slice(0, 8).map((c: any) => {
    const brandColor = ({GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'} as any)[c.brand]||'#94a3b8';
    const statusColor = c.status === 'active' ? '#19A974' : c.status === 'cooling' ? '#F59E0B' : '#8490A6';
    const angle = c.primary_selling_point || c.primarySellingPoint || '';
    const market = fmtMarket(c.primary_market || c.primaryMarket || '');
    return `<div class="camp-card" style="margin-bottom:10px;border-left:3px solid ${brandColor}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:16px;font-weight:700;color:${brandColor}">${esc(c.brand)}</span>
          <span style="font-size:14px;color:#4B5870"> × ${esc(c.game)}</span>
          <span style="font-size:10px;background:#F3F7FF;color:#3B6EF5;padding:1px 6px;border-radius:3px;margin-left:6px">${CT_ZH[c.cluster_type]||c.cluster_type||'集中投放'}</span>
        </div>
        <span style="font-size:11px;color:${statusColor}">${STATUS_ZH[c.status]||c.status} · ${c.active_from} → ${c.active_to}</span>
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:12px;color:#4B5870">
        <span>👤 <b>${c.creator_count}</b> 位博主</span>
        <span>🎬 <b>${c.video_count}</b> 条投放</span>
        <span>👁 <b>${fmt(c.total_estimated_views||0)}</b> 播放</span>
        <span>🌍 ${esc(market)}</span>
        ${angle ? `<span style="background:#F3F7FF;color:#3B6EF5;padding:1px 8px;border-radius:4px">${esc(fmtTopic(angle)||ANGLE_ZH[angle]||angle)}</span>` : ''}
      </div>
    </div>`;
  }).join('') : '<p class="mt">当前范围内暂无集中投放项目。</p>'}

  <h2>🔍 竞品投放分布</h2>
  <div class="brand-grid">
    ${data.brandComparison.slice(0, 3).map(b=>`
    <div class="brand-card" style="border-top:3px solid ${bc(b.brandName)}">
      <div class="bc-n" style="color:${bc(b.brandName)}">${esc(b.brandName)}</div>
      <div class="bc-s"><span>${b.newVideos}</span> 条投放 · <span>${b.creators}</span> 位博主</div>
    </div>`).join('')}
  </div>

  <div class="two-col">
    <div><h2>🎮 重点投放游戏</h2>
      <div style="font-size:11px;color:#8490A6;margin-bottom:6px">Top ${Math.min(data.topGames.length, 6)} of ${kpi.totalGames ?? data.topGames.length} 个游戏 · 共 ${(kpi.totalPlacements ?? kpi.competitorPlacements ?? 0).toLocaleString()} 条投放</div>
      ${data.topGames.slice(0,6).map(g=>`<div class="game-row"><span style="flex:1">${esc(g.game)}</span><span>${g.videoCount} 条投放</span></div>`).join('')||'<p class="mt">暂无数据</p>'}
    </div>
    <div><h2>🏷 主要投放主题</h2>
      ${data.topThemes.slice(0,6).map(t=>`<div class="game-row"><span style="flex:1">${fmtTopic(t.topic)}</span><span>${t.videoCount}</span></div>`).join('')||'<p class="mt">暂无数据</p>'}
    </div>
  </div>`;

  // ── TAB 2: Campaigns (Stage ⑧: 运行时聚合 — 与 Overview 同一批项目) ──
  const campCoveragePct = (kpi.totalPlacements ?? kpi.competitorPlacements ?? 0) > 0
    ? Math.round((kpi.campaignPlacements ?? 0) / (kpi.totalPlacements ?? 1) * 100) : 0;
  const campaignsTab = (`
  <div style="font-size:11px;color:#8490A6;margin-bottom:12px;padding:6px 10px;background:#F8FAFD;border-radius:6px;border:1px solid #E3E8F1">
    范围: <b>${kpi.activeCampaigns ?? 0} 个集中投放项目</b> · ${(kpi.campaignPlacements ?? 0).toLocaleString()} 条集中投放 · ${(kpi.uniqueCreators ?? 0).toLocaleString()} 位博主 · 覆盖 ${(kpi.totalPlacements ?? kpi.competitorPlacements ?? 0).toLocaleString()} 条竞品投放视频的 ${campCoveragePct}%（${scopeBrandZh} · ${scopeMarketZh} · ${rangeLabel}）
  </div>` + (campaigns.length ? campaigns.map((c:any)=>{
    const brandColor = ({GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'} as any)[c.brand]||'#94a3b8';
    const statusColor = c.status === 'active' ? '#19A974' : c.status === 'cooling' ? '#F59E0B' : '#8490A6';
    const campAngle = c.primary_selling_point || c.primarySellingPoint || '';
    return `<div class="camp-card" style="margin-bottom:14px;border-left:3px solid ${brandColor};padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <span style="font-size:17px;font-weight:700;color:${brandColor}">${esc(c.brand)}</span>
          <span style="font-size:15px;color:#4B5870"> × ${esc(c.game)}</span>
          <span style="font-size:11px;background:#F3F7FF;color:#3B6EF5;padding:2px 8px;border-radius:3px;margin-left:8px">${CT_ZH[c.cluster_type]||c.cluster_type||'集中投放'}</span>
        </div>
        <span style="font-size:12px;padding:4px 10px;border-radius:8px;color:#fff;background:${statusColor}">${STATUS_ZH[c.status]||c.status}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:10px">
        <div><span style="font-size:11px;color:#8490A6;display:block">周期</span><span style="font-size:13px;font-weight:600;color:#172033">${c.active_from} → ${c.active_to}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">博主</span><span style="font-size:13px;font-weight:600;color:#172033">${c.creator_count}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">投放数</span><span style="font-size:13px;font-weight:600;color:#172033">${c.video_count}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">预估播放</span><span style="font-size:13px;font-weight:600;color:#172033">${fmt(c.total_estimated_views||0)}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">市场</span><span style="font-size:13px;font-weight:600;color:#172033">${esc(fmtMarket(c.primary_market||c.primaryMarket||''))}</span></div>
      </div>
      <div style="font-size:12px;color:#4B5870">
        <span style="background:#F3F7FF;color:#3B6EF5;padding:2px 8px;border-radius:4px;margin-right:6px">${esc(fmtTopic(campAngle)||ANGLE_ZH[campAngle]||campAngle||'常规植入')}</span>
      </div>
    </div>`;
  }).join('') : '<p class="mt">当前范围内暂无集中投放项目。</p>'));

  // ── TAB 3: Videos — 3 views: Competitor Placements / Unresolved / All Discovered ──
  const contentTypeLabel: Record<string,string> = {dedicated:'独立评测',integrated:'场景植入',shorts:'短视频',live:'直播',dedicated_review:'独立评测',integrated_placement:'场景植入',live_replay:'直播回放',comparison:'对比评测',tutorial:'教程攻略',gameplay:'实机演示'};
  const evidenceIcon = (rc: string[]) => {
    if (!rc?.length) return '⚪';
    const hasStrong = rc.some(r => ['brand_in_title','promo_code','sponsored_tag','paid_tag','brand_link'].includes(r));
    if (hasStrong) return '🟢';
    return '🟡';
  };
  const videoRows = (vs: any[]) => vs.slice(0, 30).map(v=>`<tr data-vid="${esc(v.videoId)}">
    <td>${v.thumbnailUrl?`<img src="${esc(v.thumbnailUrl)}" width="80" height="45" style="border-radius:4px">`:''}</td>
    <td><a href="https://youtube.com/watch?v=${esc(v.videoId)}" target="_blank">${esc(v.title.slice(0,55))}${v.title.length>55?'…':''}</a></td>
    <td style="white-space:nowrap">${esc(v.channelName)}</td>
    <td style="white-space:nowrap">${esc(v.brand)}</td>
    <td style="white-space:nowrap">${esc(v.game)}</td>
    <td><span class="et">${esc(contentTypeLabel[(v as any).contentCategory]||(v as any).contentCategory||'?')}</span></td>
    <td style="white-space:nowrap">${fmt(v.viewCount)}</td>
    <td><span title="${esc((v.reasonCodes||v.discoveryEvidence||[]).join(', '))}" style="cursor:help">${evidenceIcon(v.reasonCodes||v.discoveryEvidence)} ${badge(v.placementType)}</span></td>
    <td class="acts"><button onclick="va('${v.videoId}','confirm_placement')" class="a a-y" title="确认投放">✓</button><button onclick="va('${v.videoId}','mark_organic')" class="a a-o" title="标记自然提及">O</button><button onclick="va('${v.videoId}','ignore')" class="a a-r" title="忽略">✕</button></td>
  </tr>`).join('');

  const allVids = data.allRecentVideos || [];
  const unresolvedVids = data.unresolvedVideos || [];
  // Stage ⑤ UI 口径: button labels show TOTALS + how many are on screen,
  // never "count" pretending to be the total.
  const cpTotal = (kpi.competitorPlacements ?? 0).toLocaleString();
  const unTotal = (kpi.unresolvedCandidates ?? 0).toLocaleString();
  const discTotal = (kpi.totalVideos ?? 0).toLocaleString();
  const videosTab = `
  <div class="ctrls" style="align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-size:12px;color:#8490A6;font-weight:600">视图：</span>
    <button onclick="switchVideoView('competitor')" id="vid-btn-competitor" class="btn-scan" style="font-size:11px;padding:4px 10px">竞品投放视频 ${cpTotal} · 显示 1–${Math.min(data.recentVideos.length, kpi.competitorPlacements ?? 0).toLocaleString()} / 共 ${cpTotal}</button>
    <button onclick="switchVideoView('unresolved')" id="vid-btn-unresolved" style="background:#1e293b;color:#f59e0b;border:1px solid #f59e0b;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer">待确认视频 ${unTotal} · 显示 ${Math.min(unresolvedVids.length, kpi.unresolvedCandidates ?? 0).toLocaleString()}</button>
    <button onclick="switchVideoView('all')" id="vid-btn-all" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer">全部抓取 ${discTotal} · 显示最近 ${allVids.length} 条</button>
  </div>
  <table class="dt vf" id="video-table"><thead><tr><th></th><th>标题</th><th>频道</th><th>品牌</th><th>游戏</th><th>类型</th><th>播放</th><th>证据</th><th>操作</th></tr></thead><tbody id="video-tbody">
  ${videoRows(data.recentVideos)}
  </tbody></table>
  <script>
  // Pre-cache video data for view switching
  var competitorVids = ${JSON.stringify(data.recentVideos.map((v:any)=>({videoId:v.videoId,title:v.title,thumbnailUrl:v.thumbnailUrl,channelName:v.channelName,brand:v.brand,game:v.game,viewCount:v.viewCount,placementType:v.placementType,contentCategory:(v as any).contentCategory,reasonCodes:v.reasonCodes,discoveryEvidence:v.discoveryEvidence}))).replace(/</g,'\\u003c')};
  var unresolvedVids = ${JSON.stringify(unresolvedVids.map((v:any)=>({videoId:v.videoId,title:v.title,thumbnailUrl:v.thumbnailUrl,channelName:v.channelName,brand:v.brand,game:v.game,viewCount:v.viewCount,placementType:v.placementType,contentCategory:(v as any).contentCategory,reasonCodes:v.reasonCodes,discoveryEvidence:v.discoveryEvidence}))).replace(/</g,'\\u003c')};
  var allVids = ${JSON.stringify(allVids.map((v:any)=>({videoId:v.videoId,title:v.title,thumbnailUrl:v.thumbnailUrl,channelName:v.channelName,brand:v.brand,game:v.game,viewCount:v.viewCount,placementType:v.placementType,contentCategory:(v as any).contentCategory,reasonCodes:v.reasonCodes,discoveryEvidence:v.discoveryEvidence}))).replace(/</g,'\\u003c')};
  </script>`;

  // ── TAB 4: Creators (loaded via JS, defaults to Active in period) ──
  const relLabels: Record<string,string> = {new:'首次合作',recurring:'再次合作',loyal:'长期合作',multi_brand:'多品牌投放'};
  const creatorsTab = `
  <div class="ctrls" style="align-items:center;gap:10px;margin-bottom:12px">
    <span style="font-size:12px;color:#8490A6;font-weight:600">显示：</span>
    <button onclick="switchCreatorView('active')" id="cr-btn-active" class="btn-scan" style="font-size:11px;padding:4px 10px">本周期活跃</button>
    <button onclick="switchCreatorView('all')" id="cr-btn-all" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer">全部跟踪博主</button>
    <span style="font-size:11px;color:#8490A6;margin-left:6px">本周期投放 = 当前顶部筛选范围内的竞品投放数，历史累计单独展示</span>
  </div>
  <div id="creators-load"><p class="mt">加载中...</p></div>`;

  // ── TAB 5: Comments (loaded via JS) ──
  const commentsTab = `<div id="comments-load"><p class="mt">Loading comments...</p></div>`;

  // ── TAB 6: System ──
  // Stage ⑦ 产品化: Run Scan 从 Overview 移到这里 — 采集是系统层职责, 使用者只看分析
  const systemTab = `
  <h2>数据采集</h2>
  <div style="background:#F8FAFD;border:1px solid #E3E8F1;border-radius:8px;padding:12px 14px;margin-bottom:14px">
    <div style="font-size:13px;color:#4B5870;font-weight:600;margin-bottom:8px">🟢 自动扫描：开启</div>
    <div style="font-size:13px;color:#4B5870;line-height:1.9">
      上次扫描：<b>${timeAgoZh(sysStatus.lastRun)}</b>　下次自动扫描：每日 06:00 UTC　·　AI 复核队列：每日 10:00 UTC（每轮 100 条）<br>
      当前待 AI 复核：<b style="color:#C2570B">${kpi.aiPending ?? 0}</b> 条　·　搜索配额：<b>${sysStatus.searchQuotaUsed||0}</b>/100　·　常规配额：<b>${sysStatus.generalQuotaUsed||0}</b>/10K
    </div>
    <div style="margin-top:10px"><a href="/run" class="btn-scan">立即扫描一次</a><span style="font-size:11px;color:#8490A6;margin-left:10px">采集频率由系统配置，与页面右上角的统计周期无关</span></div>
  </div>
  <h2>Hotspot 热点模式</h2>
  <div class="ctrls" style="align-items:center">
    <input id="hs-game" placeholder="游戏名（如 AION 2）" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;width:200px">
    <input id="hs-days" placeholder="天数 (1-7)" value="7" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;width:80px">
    <button onclick="startHotspot()" class="btn-scan">开启热点模式</button>
    <button onclick="stopHotspot()" style="background:#1e293b;color:#ef4444;border:1px solid #ef4444;padding:6px 12px;border-radius:6px;cursor:pointer">关闭</button>
    <span id="hs-status" style="font-size:12px;color:#64748b">${sysStatus.hotspotActive?'🔴 热点模式进行中':'⚪ 未开启'}</span>
  </div>
  <h2>扫描日志</h2>
  <table class="dt"><thead><tr><th>时间</th><th>模式</th><th>搜索</th><th>发现</th><th>新增</th><th>配额</th><th>状态</th></tr></thead><tbody id="scan-logs"><tr><td colspan="7" class="mt">加载中...</td></tr></tbody></table>`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>竞品投放监控 v3</title><style>${CSS}</style></head><body>
<div class="container">
  <header>
    <div><h1>📊 YouTube Competitor Monitor</h1><p class="sub">GearUP · ExitLag · LagZapper</p></div>
    <div class="sys">
      <span style="color:#19A974;font-weight:600">🟢 自动监控正常</span>
      <span>最后更新：${timeAgoZh(sysStatus.lastRun)}</span>
      <span>待 AI 复核：${kpi.aiPending ?? 0}</span>
    </div>
  </header>
  <div class="ctrls">
    <select onchange="applyFilter('brand',this.value)"><option value="all" ${sel('brand','all')}>全部竞品</option><option value="GearUP" ${sel('brand','GearUP')}>GearUP</option><option value="ExitLag" ${sel('brand','ExitLag')}>ExitLag</option><option value="LagZapper" ${sel('brand','LagZapper')}>LagZapper</option></select>
    <select onchange="applyFilter('market',this.value)"><option value="all" ${sel('market','all')}>全球</option><option value="US" ${sel('market','US')}>US</option><option value="RU" ${sel('market','RU')}>俄罗斯</option><option value="BR" ${sel('market','BR')}>巴西</option></select>
    <select onchange="applyFilter('range',this.value)"><option value="1d" ${(filter.range||'7d')==='1d'?'selected':''}>过去24小时</option><option value="7d" ${(filter.range||'7d')==='7d'?'selected':''}>过去7天</option><option value="30d" ${(filter.range||'7d')==='30d'?'selected':''}>过去30天</option><option value="90d" ${(filter.range||'7d')==='90d'?'selected':''}>过去90天</option></select>
    <span class="chip" style="margin-left:8px">${rangeLabel} · ${fmtScopeDate(kpi.windowStart ?? '')} → ${fmtScopeDate(kpi.windowEnd ?? '')}</span>
  </div>
  <nav class="tabs">
    <a href="#" class="tab" onclick="switchTab('overview')" id="tab-overview">总览</a>
    <a href="#" class="tab" onclick="switchTab('campaigns')" id="tab-campaigns">投放项目</a>
    <a href="#" class="tab" onclick="switchTab('videos')" id="tab-videos">投放视频</a>
    <a href="#" class="tab" onclick="switchTab('creators')" id="tab-creators">投放博主</a>
    <a href="#" class="tab" onclick="switchTab('comments')" id="tab-comments">观众信号</a>
    <a href="#" class="tab" onclick="switchTab('system')" id="tab-system">系统</a>
  </nav>
  <div id="tab-panel-overview" class="tab-content">${overview}</div>
  <div id="tab-panel-campaigns" class="tab-content" style="display:none">${campaignsTab}</div>
  <div id="tab-panel-videos" class="tab-content" style="display:none">${videosTab}</div>
  <div id="tab-panel-creators" class="tab-content" style="display:none">${creatorsTab}</div>
  <div id="tab-panel-comments" class="tab-content" style="display:none">${commentsTab}</div>
  <div id="tab-panel-system" class="tab-content" style="display:none">${systemTab}</div>
  <div class="disc">ⓘ Public data estimates only. <span onclick="this.nextElementSibling.style.display='inline'" style="color:#38bdf8;cursor:pointer">More</span><span style="display:none;color:#64748b"> Does not represent ROI, CPA, conversion rate, or ad spend. Shorts and long-form tracked separately.</span></div>
  <div id="toast" class="toast" style="display:none"></div>
</div>
<script>
// Stage ⑧: 顶部三筛选器注入 JS — Creator/Comments 页必须用同一 Current Scope
var curRange=${JSON.stringify(filter.range || '7d')};
var curBrand=${JSON.stringify(filter.brand || 'all')};
var curMarket=${JSON.stringify(filter.market || 'all')};
var creatorView='active';
function applyFilter(k,v){const u=new URL(location);v==='all'?u.searchParams.delete(k):u.searchParams.set(k,v);location=u.toString()}
function switchTab(t){document.querySelectorAll('.tab-content').forEach(e=>e.style.display='none');document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));document.getElementById('tab-panel-'+t).style.display='block';document.getElementById('tab-'+t).classList.add('active');if(t==='creators')loadCreators();if(t==='comments')loadComments();if(t==='system')loadSystem();localStorage.setItem('tab',t)}
async function va(id,a){try{const r=await fetch('/api/videos/'+id+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});const d=await r.json();if(!d.success){showToast('❌ '+d.error);return}showToast('✅ 已更新');const row=document.querySelector('tr[data-vid="'+id+'"]');if(!row)return;const badgeCell=row.querySelector('td:nth-child(8)');if(badgeCell){const labels={confirmed_paid_placement:'已确认',likely_sponsored:'疑似投放',organic_mention:'自然提及',unknown:'未知'};const newType=a==='confirm_placement'?'confirmed_paid_placement':a==='mark_organic'?'organic_mention':'unknown';const icon=newType==='confirmed_paid_placement'?'🟢':newType==='organic_mention'?'🟡':'⚪';badgeCell.innerHTML='<span title="">'+icon+' <span class="b b-'+newType+'">'+(labels[newType]||newType)+'</span></span>'}}catch(e){showToast('❌ 操作失败')}}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2000)}
// ── Video view switcher ──
function renderVideoRows(vids){var label={dedicated:'独立评测',integrated:'场景植入',shorts:'短视频',live:'直播',dedicated_review:'独立评测',integrated_placement:'场景植入',live_replay:'直播回放',comparison:'对比评测',tutorial:'教程攻略',gameplay:'实机演示'};var badge={confirmed_paid_placement:'已确认',likely_sponsored:'疑似投放',organic_mention:'自然提及',official_brand_video:'官方视频',unknown:'未知'};function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}function fmt(n){return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n)}function evi(rc){if(!rc||!rc.length)return'\\u26aa';var hs=rc.some(function(r){return['brand_in_title','promo_code','sponsored_tag','paid_tag','brand_link'].indexOf(r)>=0});return hs?'\\uD83D\\uDFE2':'\\uD83D\\uDFE1'}return vids.slice(0,30).map(function(v){return'<tr data-vid=\"'+esc(v.videoId)+'\"><td>'+(v.thumbnailUrl?'<img src=\"'+esc(v.thumbnailUrl)+'\" width=80 height=45 style=border-radius:4px>':'')+'</td><td><a href=\"https://youtube.com/watch?v='+esc(v.videoId)+'\" target=_blank>'+esc(v.title.slice(0,55))+(v.title.length>55?'\\u2026':'')+'</a></td><td style=white-space:nowrap>'+esc(v.channelName)+'</td><td style=white-space:nowrap>'+esc(v.brand)+'</td><td style=white-space:nowrap>'+esc(v.game)+'</td><td><span class=et>'+esc(label[v.contentCategory]||v.contentCategory||'?')+'</span></td><td style=white-space:nowrap>'+fmt(v.viewCount)+'</td><td><span title=\"'+esc((v.reasonCodes||v.discoveryEvidence||[]).join(', '))+'\" style=cursor:help>'+evi(v.reasonCodes||v.discoveryEvidence)+' <span class=\"b b-'+v.placementType+'\">'+(badge[v.placementType]||v.placementType)+'</span></span></td><td class=acts><button onclick=\"va(\\''+v.videoId+'\\',\\'confirm_placement\\')\" class=\"a a-y\" title=确认投放>\\u2713</button><button onclick=\"va(\\''+v.videoId+'\\',\\'mark_organic\\')\" class=\"a a-o\" title=标记自然提及>O</button><button onclick=\"va(\\''+v.videoId+'\\',\\'ignore\\')\" class=\"a a-r\" title=忽略>\\u2715</button></td></tr>'}).join('')}
function switchVideoView(view){var tbody=document.getElementById('video-tbody');var vids=view==='competitor'?competitorVids:view==='unresolved'?unresolvedVids:allVids;tbody.innerHTML=renderVideoRows(vids);document.querySelectorAll('[id^=vid-btn-]').forEach(function(b){b.style.background='#1e293b';b.style.color='#e2e8f0';b.style.border='1px solid #334155'});var btn=document.getElementById('vid-btn-'+view);if(btn){btn.style.background='#3568e8';btn.style.color='#fff';btn.style.border='1px solid #3568e8'}}
// ── Creator view switcher ──
function switchCreatorView(view){creatorView=view;document.querySelectorAll('[id^=cr-btn-]').forEach(function(b){b.style.background='#1e293b';b.style.color='#e2e8f0';b.style.border='1px solid #334155'});var btn=document.getElementById('cr-btn-'+view);if(btn){btn.style.background='#3568e8';btn.style.color='#fff';btn.style.border='1px solid #3568e8'};loadCreators()}
async function loadCreators(){var el=document.getElementById('creators-load');try{var url='/api/creators?range='+curRange+'&brand='+curBrand+'&market='+curMarket+(creatorView==='all'?'&all=1':'');var r=await fetch(url);var d=await r.json();if(!d||!d.length){el.innerHTML='<p class=mt>当前范围内暂无投放博主。</p>';return}function fmtN(n){return n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n)}function relTag(r){var m={new:['首次合作','#3B6EF5','#F3F7FF'],recurring:['再次合作','#6B7280','#F3F4F6'],long_term:['长期合作','#7C3AED','#F5F3FF'],multi_brand:['多品牌','#D97706','#FFFBEB']};var x=m[r]||[r,'#3B6EF5','#F3F7FF'];return'<span style="font-size:10px;background:'+x[2]+';color:'+x[1]+';padding:1px 6px;border-radius:3px">'+x[0]+'</span>'}el.innerHTML='<table class=dt><thead><tr><th>博主</th><th>粉丝</th><th>本周期投放</th><th>历史累计</th><th>品牌</th><th>游戏</th><th>平均播放</th><th>对比基线</th><th>合作类型</th></tr></thead><tbody>'+d.slice(0,30).map(function(c){var conf='<span style=color:#19A974;font-weight:600>'+c.confirmedCount+' 确认</span>';var lik='<span style=color:#D97706;font-weight:600>'+c.likelyCount+' 疑似</span>';var brandCol=Object.entries(c.brandMentions||{}).filter(function(e){return e[1]>0}).sort(function(a,b){return b[1]-a[1]}).map(function(e){var col={GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'}[e[0]]||'#94a3b8';return'<span style="font-size:11px;color:'+col+';font-weight:600">'+e[0]+'</span>'}).join(' ');var vs=c.vsBaselinePct===null||c.vsBaselinePct===undefined?'-':(c.vsBaselinePct>=0?'<span style="color:#19A974;font-weight:600">+'+(c.vsBaselinePct)+'%</span>':'<span style="color:#EF5B5B;font-weight:600">'+(c.vsBaselinePct)+'%</span>');return'<tr><td style="white-space:nowrap">'+escapeHtml(c.channelName||'?')+'</td><td>'+(c.subscriberCount?fmtN(c.subscriberCount):'-')+'</td><td><span style="font-size:14px;font-weight:700">'+c.videosInWindow+'</span><br><span style="font-size:11px">'+conf+' · '+lik+'</span></td><td><span style="font-size:12px;color:#8490A6">'+((c.lifetimeCount||0)-c.videosInWindow)+'</span></td><td>'+brandCol+'</td><td>'+escapeHtml((c.games||[]).slice(0,2).join(', '))+'</td><td>'+fmtN(c.avgViews||0)+'</td><td>'+vs+'</td><td>'+relTag(c.relationType)+'</td></tr>'}).join('')+'</tbody></table>'}catch(e){el.innerHTML='<p class=mt>加载失败，请重试</p>'}}
async function loadComments(){const el=document.getElementById('comments-load');try{const scope='range='+curRange+'&brand='+curBrand+'&market='+curMarket;const[r,raw]=await Promise.all([fetch('/api/comments/summary?'+scope),fetch('/api/comments?limit=30&'+scope)]);const s=await r.json();const d=await raw.json();if(!s.total){el.innerHTML='<p class=mt>当前范围内暂无已分析评论</p>';return}const fb=s.fallback?'<div style="font-size:11px;color:#8a6d1a;background:#FDF6E3;border:1px solid #E8D9A0;border-radius:6px;padding:6px 10px;margin-bottom:12px">当前范围内暂无已确认竞品投放评论，以下展示已分析候选视频中的观众评论，仅供参考。</div>':'';const flags=c=>'<span class=bt>'+(c.brand?'🏷 品牌':'')+(c.intent?' 💳 意向':'')+(c.question?' ❓ 咨询':'')+(c.concern?' ⚠️ 顾虑':'')+'</span>';const cov=s.placementTotal?'<div style="font-size:11px;color:#8490A6;margin:4px 0 12px">'+s.total+' 条评论来自 '+s.placementCoverage+' / '+s.placementTotal+' 条投放视频</div>':'';el.innerHTML=fb+'<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px"><div class=kpi><div class=kpi-n>'+s.total+'</div><div class=kpi-l>已分析评论</div></div><div class=kpi><div class=kpi-n style=color:#3b82f6>'+s.brandMentions+'</div><div class=kpi-l>品牌提及</div></div><div class=kpi><div class=kpi-n style=color:#F59E0B>'+s.productQuestions+'</div><div class=kpi-l>产品咨询</div></div><div class=kpi><div class=kpi-n style=color:#19A974>'+s.purchaseIntent+'</div><div class=kpi-l>购买·试用意向</div></div><div class=kpi><div class=kpi-n style=color:#19A974>'+s.positiveFeedback+'</div><div class=kpi-l>正向反馈</div></div><div class=kpi><div class=kpi-n style=color:#EF5B5B>'+s.negativeConcern+'</div><div class=kpi-l>负向反馈·顾虑</div></div></div>'+cov+'<h2>重点观众信号</h2>'+((s.topSignals||[]).length?'': '<p class=mt>暂无强信号</p>')+ (s.topSignals||[]).slice(0,8).map(x=>'<div class=comment><b>'+escapeHtml(x.author)+'</b> 评论于 '+escapeHtml((x.videoTitle||'').slice(0,50))+'<br>“'+escapeHtml(x.text)+'”<br>'+flags(x.flags)+'</div>').join('')+'<h2>讨论最多</h2><table class=dt><thead><tr><th>视频</th><th>频道</th><th>评论数</th></tr></thead><tbody>'+s.topVideos.slice(0,10).map(v=>'<tr><td><a href="https://youtube.com/watch?v='+escapeHtml(v.videoId)+'" target=_blank>'+escapeHtml((v.title||'').slice(0,60))+'</a></td><td>'+escapeHtml(v.channelName||'?')+'</td><td>'+v.commentCount+'</td></tr>').join('')+'</tbody></table><h2>最近评论</h2>'+d.slice(0,20).map(c=>'<div class=comment><b>'+escapeHtml(c.author_name||'?')+'</b> 评论于 '+escapeHtml((c.youtube_competitor_videos||{}).title||'?').slice(0,50)+'<br>'+escapeHtml((c.comment_text||'').slice(0,200))+'<br><span class=bt>'+(c.has_purchase_intent?'💳 意向':'')+' '+(c.is_brand_related?'🏷 品牌':'')+' '+(c.sentiment||'')+'</span></div>').join('')}catch(e){el.innerHTML='<p class=mt>加载失败，请重试</p>'}}
async function loadSystem(){try{const r=await fetch('/api/system');const d=await r.json();const logs=d.logs||[];document.getElementById('scan-logs').innerHTML=logs.slice(0,15).map(l=>'<tr><td>'+new Date(l.created_at).toLocaleString()+'</td><td>'+l.scan_mode+'</td><td>'+l.queries_attempted+'/'+l.queries_succeeded+'</td><td>'+l.videos_found+'</td><td>'+l.videos_new+'</td><td>'+l.search_quota_used+'S/'+l.general_quota_used+'G</td><td>'+(l.quota_exhausted?'⚠️ Quota':'✅')+'</td></tr>').join('')||'<tr><td colspan="7" class="mt">No logs</td></tr>';document.getElementById('hs-status').textContent=d.config?.hotspot_active?'🔴 Active until '+new Date(d.config.hotspot_active_until).toLocaleString():'⚪ Inactive'}catch(e){}}
async function startHotspot(){const g=document.getElementById('hs-game').value;const d=parseInt(document.getElementById('hs-days').value)||7;if(!g)return showToast('❌ Enter a game name');try{const r=await fetch('/api/hotspot/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({games:[g],durationDays:d})});const j=await r.json();showToast(j.success?'✅ Hotspot active':'❌ Failed');setTimeout(loadSystem,500)}catch(e){showToast('❌ Failed')}}
async function stopHotspot(){try{await fetch('/api/hotspot/stop',{method:'POST'});showToast('✅ Hotspot stopped');setTimeout(loadSystem,500)}catch(e){showToast('❌ Failed')}}
function escapeHtml(t){return t?t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
// Restore tab
const savedTab=localStorage.getItem('tab')||'overview';
switchTab(savedTab);
</script></body></html>`;
}

function emptyState(sys: any): string {
  const sqPct = Math.round((sys.searchQuotaUsed||0)/100*100);
  const gqPct = Math.round((sys.generalQuotaUsed||0)/10000*100);
  const quotaColor = (pct: number) => pct>=95?'#DC4C4C':pct>=85?'#E89417':pct>=70?'#E89417':'#4777EC';
  const nextReset = new Date(); nextReset.setUTCHours(7,0,0,0);
  if (nextReset <= new Date()) nextReset.setDate(nextReset.getDate()+1);
  const resetBeijing = new Date(nextReset.getTime() + 8*3600000).toLocaleString('en-US', {hour:'numeric',minute:'2-digit'});
  const creatorCount = sys.totalCreators||0;
  const estGeneral = Math.ceil(creatorCount/50) + creatorCount;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor Monitor</title><style>${EMPTY_CSS}</style></head><body>
<div class="page">
  <header class="topbar">
    <div>
      <div class="logo-row"><span class="logo-icon">◈</span><span class="logo-text">Monitor</span></div>
      <h1 class="page-title">YouTube Competitor Monitor</h1>
      <p class="page-subtitle">GearUP · ExitLag · LagZapper</p>
    </div>
    <a class="settings-link" href="/system">Settings</a>
  </header>

  <main class="card" id="main-card">
    <h2 class="card-title">No scan results yet</h2>
    <p class="card-desc">Your monitor is ready for its first discovery scan.</p>

    <div class="metrics-row">
      <div class="metric-block"><div class="metric-val">3</div><div class="metric-lbl">Brands</div></div>
      <div class="metric-block"><div class="metric-val">${creatorCount}</div><div class="metric-lbl">Tracked Creators</div></div>
      <div class="metric-block"><div class="metric-val">6</div><div class="metric-lbl">Queries</div></div>
    </div>

    <div class="meta-row">
      <span class="chip">Global</span>
      <span class="chip">All Languages</span>
      <span class="chip">Normal Mode</span>
    </div>

    <div class="status-row">
      <span class="status-item done">API Connected</span>
      <span class="status-item done">Creator Monitoring</span>
      <span class="status-item pending">First Scan Pending</span>
    </div>

    <div class="scan-panel" id="scan-config">
      <div class="scan-header">
        <span class="scan-title">Initial Discovery Scan</span>
        <select id="scan-days" class="scan-select">
          <option value="7">Past 7 days</option>
          <option value="30" selected>Past 30 days</option>
          <option value="60">Past 60 days</option>
        </select>
      </div>

      <div class="scan-usage-title">Estimated API Usage</div>
      <div class="usage-row">
        <div class="usage-block"><div class="usage-val" id="est-search">6</div><div class="usage-lbl">Search Calls</div></div>
        <div class="usage-block"><div class="usage-val" id="est-general">~${estGeneral}</div><div class="usage-lbl">General Reads</div></div>
        <div class="usage-block"><div class="usage-val" id="est-videos">300</div><div class="usage-lbl">Max Results</div></div>
      </div>

      <div class="scan-info">
        ⓘ Latest 50 results per query. Results are deduplicated by video ID.${creatorCount>0?'<br>Creator uploads use General quota instead of Search quota.':''}
      </div>

      <button onclick="startFirstScan()" class="btn-primary" id="scan-btn">Run First Scan</button>
    </div>

    <div id="scan-progress" class="scan-progress" style="display:none">
      <h3 class="scan-progress-title">Running first scan…</h3>
      <div class="sp-status" id="sp-status"></div>
      <div class="sp-bar"><div class="sp-bar-fill" id="sp-bar" style="width:5%"></div></div>
      <div class="sp-stats" id="sp-stats"></div>
      <div id="sp-result"></div>
    </div>

    <div class="quota-section">
      <h3 class="quota-title">Today's API Usage</h3>
      <div class="q-row">
        <span class="q-label">Search discovery</span>
        <span class="q-num">${sys.searchQuotaUsed||0} / 100</span>
        <span class="q-pct">${sqPct}%</span>
        <div class="q-bar"><div class="q-fill" style="width:${sqPct}%;background:${quotaColor(sqPct)}"></div></div>
      </div>
      <div class="q-row">
        <span class="q-label">General data reads</span>
        <span class="q-num">${sys.generalQuotaUsed||0} / 10,000</span>
        <span class="q-pct">${gqPct}%</span>
        <div class="q-bar"><div class="q-fill" style="width:${gqPct}%;background:${quotaColor(gqPct)}"></div></div>
      </div>
      <div class="q-reset">Next reset: Today at ${resetBeijing} Beijing Time <span title="7:00 AM UTC" style="cursor:help">ⓘ</span></div>
    </div>
  </main>
</div>

<script>
const CREATOR_COUNT = ${creatorCount};
const EST_GENERAL = ${estGeneral};
async function startFirstScan() {
  var days = document.getElementById('scan-days').value;
  var btn = document.getElementById('scan-btn');
  btn.textContent = 'Scanning…'; btn.disabled = true; btn.style.opacity = '0.6'; btn.style.cursor = 'default';
  document.getElementById('scan-config').style.display = 'none';
  document.getElementById('scan-progress').style.display = 'block';
  fetch('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'manual',backfillDays:parseInt(days)})})
    .then(function(r){return r.json()}).then(function(d){if(!d.success)document.getElementById('sp-result').innerHTML='<p style="color:#DC4C4C">❌ '+d.error+'</p>'});
  pollProgress();
}
function pollProgress() {
  fetch('/api/scan-status').then(function(r){return r.json()}).then(function(s){
    var pct = s.done?100:s.phase==='classifying'?60:s.phase==='deep_analysis'?80:s.phase==='prefiltering'?30:15;
    document.getElementById('sp-bar').style.width = pct+'%';
    if(s.running){
      var parts = [];
      parts.push('Brand queries: <b>'+(s.searchQuotaUsed||0)+' / 6</b>');
      parts.push('Videos discovered: <b>'+(s.discoveredCount||s.discovered||0)+'</b>');
      if(s.persistedCount>0||s.discoveredCount>0) parts.push('Videos saved: <b>'+(s.persistedCount||s.discoveredCount||0)+'</b>');
      if(s.selectedForAI>0) parts.push('Selected for AI: <b>'+s.selectedForAI+'</b>');
      if(s.classified>0) parts.push('AI classified: <b>'+s.classified+' / '+(s.selectedForAI||50)+'</b>');
      if(s.likelyPlacements>0) parts.push('Likely placements: <b>'+s.likelyPlacements+'</b>');
      if(s.queued>0) parts.push('Queued: <b>'+s.queued+'</b>');
      document.getElementById('sp-status').innerHTML = parts.length?parts.join('<br>'):'Starting…';
      document.getElementById('sp-stats').innerHTML = s.errors&&s.errors.length?'<span class="sp-err">⚠️ '+s.errors.join(', ')+'</span>':'';
    }
    if(s.done){
      document.getElementById('sp-bar').style.width='100%';
      document.getElementById('sp-status').innerHTML='';
      var dCount = s.discoveredCount||s.discovered||0;
      if(dCount>0){
        var msg = s.classified+' classified, '+(s.likelyPlacements||0)+' likely placements';
        if(s.queued>0) msg += ', '+s.queued+' queued for later';
        if(s.persistedCount>0) msg = (s.persistedCount||0)+' videos saved · '+msg;
        document.getElementById('sp-result').innerHTML='<div class="scan-done"><h3 class="scan-done-title">✅ First scan complete</h3><p class="scan-done-desc">'+dCount+' videos discovered · '+msg+'</p><a href="/" class="btn-primary" style="display:inline-block;width:auto;padding:12px 32px">View Results</a></div>';
      } else {
        document.getElementById('sp-result').innerHTML='<div class="scan-done"><h3 class="scan-done-title">⚠️ Scan finished</h3><p class="scan-done-desc">No new videos found. Try a wider date range or check quota.</p><a href="/" class="btn-primary" style="display:inline-block;width:auto;padding:12px 32px">Return to Dashboard</a></div>';
      }
      return;
    }
    setTimeout(pollProgress,2000);
  }).catch(function(){setTimeout(pollProgress,3000)});
}
document.getElementById('scan-days').addEventListener('change',function(){
  var d = parseInt(this.value);
  var searches = d<=7?6:d<=30?12:24;
  document.getElementById('est-search').textContent = searches;
  document.getElementById('est-videos').textContent = d<=7?300:d<=30?600:1200;
  document.getElementById('est-general').textContent = '~'+EST_GENERAL;
});
</script>
</body></html>`;
}

function fmtTopic(t: string): string {
  const m: Record<string,string> = {game_integration:'游戏场景植入',lag_fix:'降低延迟',booster_review:'加速器评测',competitor_comparison:'竞品对比',promo_code:'优惠码',free_limited:'免费/试用',new_game_launch:'新品/新游上线',season_update:'赛季更新',region_unlock:'跨区解锁',tutorial:'教程攻略',pure_endorsement:'纯推荐植入',game_review:'游戏评测',general:'常规植入',other:'其他',uncategorized:'其他'};
  return m[t]||t;
}
// Campaign 主题角度中文化 (primary_selling_point 存的是英文显示名)
const ANGLE_ZH: Record<string,string> = {'Reduce Ping':'降低延迟','Promo Code':'优惠码','Game Review':'游戏评测','Game Integration':'游戏场景植入','Tutorial':'教程攻略','New Launch':'新品/新游上线','General':'常规植入','Other':'其他','Free/Trial':'免费/试用','Season Update':'赛季更新','Cross-Region':'跨区解锁','Booster Review':'加速器评测','Comparison':'竞品对比','Sponsored':'纯推荐植入','Gameplay':'实机演示','Shorts':'短视频','Livestream':'直播'};
// 集群类型中文化
const CT_ZH: Record<string,string> = {multi_creator_campaign:'多博主投放',creator_series:'单博主连续投放',one_off_placement:'单次投放',brand_push:'品牌集中推广'};
// 状态中文化
const STATUS_ZH: Record<string,string> = {active:'进行中',cooling:'降温中',ended:'已结束'};
// 市场显示: Unknown → 地区未知
const fmtMarket = (mkt: string): string => (mkt === 'Unknown' || !mkt) ? '地区未知' : mkt;

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F7FB;color:#172033;font-size:14px;line-height:1.5}
.container{max-width:1280px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;gap:12px}
h1{font-size:22px;color:#172033}h2{font-size:15px;color:#4B5870;margin:20px 0 10px;padding-bottom:4px;border-bottom:1px solid #E3E8F1}
.sub{color:#718099;font-size:13px}
.sys{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:#8490A6}
.sys span,.dot{background:#FFFFFF;padding:3px 8px;border-radius:10px;display:inline-flex;align-items:center;gap:4px;border:1px solid #E3E8F1}
.dot::before{content:'';width:5px;height:5px;border-radius:50%}.dot.ok::before{background:#19A974}.dot.warn::before{background:#F59E0B}

/* Controls */
.ctrls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;background:#FFFFFF;padding:10px 14px;border-radius:10px;border:1px solid #E3E8F1;box-shadow:0 1px 3px rgba(35,50,80,0.04)}
.ctrls select{background:#FFFFFF;color:#172033;border:1px solid #CFD8E8;padding:5px 8px;border-radius:6px;font-size:12px}
.btn-scan{display:inline-block;padding:7px 14px;background:#3B6EF5;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;margin-left:auto;box-shadow:0 2px 8px rgba(59,110,245,0.18)}
.btn-scan:hover{background:#2F5DDB}

/* Tabs */
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #E3E8F1;padding-bottom:0}
.tab{padding:8px 16px;color:#8490A6;text-decoration:none;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:#4B5870}.tab.active{color:#3B6EF5;border-bottom-color:#3B6EF5}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.kpi{background:#FFFFFF;border:1px solid #E3E8F1;border-radius:12px;padding:16px;text-align:center;box-shadow:0 1px 3px rgba(35,50,80,0.04)}
.kpi.hl{border-color:#3B6EF5;background:#F3F7FF}
.kpi-n{font-size:28px;font-weight:700;color:#172033}.kpi-l{font-size:11px;color:#8490A6;margin-top:2px}

/* Brand */
.brand-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:20px}
.brand-card{background:#FFFFFF;border:1px solid #E3E8F1;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(35,50,80,0.04)}
.bc-n{font-size:15px;font-weight:700;margin-bottom:6px}.bc-s{font-size:12px;color:#4B5870;margin-bottom:3px}.bc-s span{color:#172033;font-weight:600}

/* Game rows */
.game-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #F5F7FB;font-size:13px;color:#4B5870}
.game-row i{font-style:normal;font-size:11px;margin:0 2px}
.g-bar{width:80px;height:5px;background:#E9EEF6;border-radius:3px;overflow:hidden;flex-shrink:0}
.g-fill{height:100%;background:#3B6EF5;border-radius:3px;display:block}

/* Tables */
.dt{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
.dt th{text-align:left;padding:6px 8px;background:#F8FAFD;color:#8490A6;font-weight:500;font-size:10px;text-transform:uppercase;border-bottom:1px solid #E3E8F1}
.dt td{padding:6px 8px;border-bottom:1px solid #F5F7FB;color:#4B5870}.dt tr:hover{background:#F8FAFD}
.dt a{color:#3B6EF5;text-decoration:none}

/* Badges */
.b{padding:1px 6px;border-radius:8px;font-size:10px;font-weight:500;white-space:nowrap}
.b-confirmed_paid_placement,.b-Confirmed{background:#FEF2F2;color:#DC2626}
.b-likely_sponsored,.b-Likely{background:#FFFBEB;color:#D97706}
.b-organic_mention,.b-Organic{background:#ECFDF5;color:#059669}
.b-official_brand_video{background:#EFF6FF;color:#2563EB}
.b-unknown{background:#F8FAFD;color:#8490A6}

/* Evidence tags */
.et{font-size:9px;background:#F8FAFD;color:#8490A6;padding:1px 5px;border-radius:3px;margin:1px;display:inline-block;border:1px solid #E3E8F1}

/* Video actions */
.acts{white-space:nowrap}.a{width:22px;height:22px;border:1px solid #CFD8E8;border-radius:3px;background:#fff;color:#8490A6;cursor:pointer;font-size:11px;margin:0 1px}
.a:hover{background:#F8FAFD}.a-y:hover{color:#19A974;border-color:#19A974}
.a-o:hover{color:#F59E0B;border-color:#F59E0B}.a-r:hover{color:#EF5B5B;border-color:#EF5B5B}

/* Campaign card */
.camp-card{background:#FFFFFF;border:1px solid #E3E8F1;border-radius:8px;padding:12px}

/* Comments */
.comment{background:#FFFFFF;border:1px solid #E3E8F1;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px}
.bt{font-size:10px;background:#F8FAFD;padding:1px 4px;border-radius:3px;margin-right:3px;color:#8490A6}

/* Two col */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:768px){.two-col{grid-template-columns:1fr}}

/* Empty / Onboard */
.mt{color:#8490A6;font-style:italic;padding:16px;text-align:center}
.onboard{max-width:560px;margin:40px auto;background:#FFFFFF;border:1px solid #E3E8F1;border-radius:18px;padding:32px 36px;box-shadow:0 8px 28px rgba(35,50,80,0.06)}
.onboard h2{font-size:20px;color:#172033;border:none;margin-bottom:4px}
.onboard>p{color:#4B5870;margin-bottom:20px;font-size:13px}
/* Config summary */
.config-summary{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin-bottom:20px;padding:12px;background:#F8FAFD;border:1px solid #E8EDF5;border-radius:8px}
.cs-row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:#8490A6}
.cs-row span:last-child{color:#172033;font-weight:600}
/* Checklist */
.checklist{text-align:left;margin-bottom:20px}
.cl-item{font-size:13px;padding:6px 0;display:flex;align-items:center;gap:8px;color:#8490A6}
.cl-item::before{content:'';width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cl-item.done{color:#4B5870}.cl-item.done::before{background:#19A974}
.cl-item.pending{color:#8490A6}.cl-item.pending::before{background:#A6B0C2}
/* Scan config */
.scan-config{background:#F3F7FF;border:1px solid #DCE7FF;border-radius:10px;padding:16px;margin-bottom:16px}
.sc-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.sc-label{font-size:13px;color:#4B5870}
.sc-select{background:#FFFFFF;color:#172033;border:1px solid #CFD8E8;padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer}
.sc-estimate{display:flex;justify-content:space-between;font-size:12px;color:#8490A6;margin-bottom:14px}
.sc-estimate strong{color:#172033}
.sc-note{font-size:11px;color:#8490A6;margin-bottom:12px;line-height:1.6}
/* Scan progress */
.scan-progress{margin-bottom:16px;text-align:left}
.scan-progress h3{font-size:15px;color:#3B6EF5;margin-bottom:12px}
.sp-steps{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.sp-step{font-size:13px;color:#8490A6;padding:3px 0}
.sp-step.active{color:#3B6EF5}.sp-step.done{color:#19A974}
.sp-bar{height:4px;background:#E9EEF6;border-radius:2px;overflow:hidden;margin-bottom:10px}
.sp-bar-fill{height:100%;background:#3B6EF5;transition:width 0.5s}
.sp-stats{font-size:12px;color:#4B5870;display:flex;flex-wrap:wrap;gap:12px}
.sp-stats b{color:#172033}
.scan-done{text-align:center;padding:16px 0}
.scan-done h3{color:#19A974}.scan-done p{color:#4B5870;margin:4px 0 12px}
/* Quota */
.quota-section{margin-top:20px;border-top:1px solid #E3E8F1;padding-top:16px}
.q-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px}
.q-label{color:#4B5870;width:130px;flex-shrink:0}.q-num{color:#8490A6;width:80px;flex-shrink:0;text-align:right}
.q-bar{flex:1;height:4px;background:#E9EEF6;border-radius:2px;overflow:hidden}
.q-fill{height:100%;border-radius:2px;transition:width 0.5s}
.q-reset{font-size:11px;color:#8490A6;margin-top:6px;text-align:right}
.oc{font-size:14px;padding:8px 0;color:#4B5870;display:flex;align-items:center;gap:8px;text-align:left}
.oc-i{font-size:16px;width:20px;text-align:center;flex-shrink:0}.oc-i.ok{color:#19A974}.oc-i.wait{color:#A6B0C2}
.btn-p{display:inline-block;padding:12px 24px;background:#3B6EF5;color:white;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;cursor:pointer;border:none;box-shadow:0 6px 16px rgba(59,110,245,0.22)}
.btn-p:hover{background:#2F5DDB}
.disc{font-size:10px;color:#8490A6;text-align:center;margin-top:24px;padding-top:10px;border-top:1px solid #E3E8F1}
.toast{position:fixed;bottom:20px;right:20px;background:#FFFFFF;color:#172033;padding:10px 18px;border-radius:8px;border:1px solid #E3E8F1;z-index:100;box-shadow:0 4px 12px rgba(35,50,80,0.1)}
`;

const EMPTY_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F3F6FB;color:#46546C;font-size:15px;line-height:1.5}
.page{max-width:1200px;margin:0 auto;padding:40px 24px 60px}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px}
.logo-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.logo-icon{font-size:16px;color:#3568E8}.logo-text{font-size:13px;font-weight:700;color:#6F7D96;text-transform:uppercase;letter-spacing:0.5px}
.page-title{font-size:30px;line-height:38px;font-weight:750;color:#14213D;margin-bottom:4px}
.page-subtitle{font-size:15px;color:#5F6F89}
.settings-link{font-size:14px;color:#6F7D96;text-decoration:none;padding:8px 16px;border:1px solid #D9E2F0;border-radius:8px;background:#fff;flex-shrink:0;margin-right:0}
.settings-link:hover{color:#3568E8;border-color:#C9D9FF}
/* Card */
.card{max-width:860px;margin:0 auto;background:#FFFFFF;border:1px solid #D9E2F0;border-radius:20px;padding:44px 48px;box-shadow:0 18px 50px rgba(28,48,82,0.08),0 2px 8px rgba(28,48,82,0.04)}
.card-title{font-size:26px;line-height:34px;font-weight:720;color:#14213D;margin-bottom:6px}
.card-desc{font-size:16px;line-height:25px;color:#46546C;margin-bottom:28px}
/* Metrics */
.metrics-row{display:flex;gap:20px;margin-bottom:20px}
.metric-block{flex:1;text-align:center;padding:16px 12px;background:#F7F9FC;border:1px solid #E7ECF4;border-radius:12px}
.metric-val{font-size:24px;font-weight:750;color:#1E3A6D;line-height:30px}
.metric-lbl{font-size:14px;color:#687790;margin-top:2px}
/* Chips */
.meta-row{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
.chip{font-size:14px;color:#42516A;background:#FFFFFF;border:1px solid #DEE5F0;border-radius:8px;padding:8px 14px}
/* Status */
.status-row{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:28px}
.status-item{font-size:15px;color:#46546C;display:flex;align-items:center;gap:8px}
.status-item::before{content:'';width:8px;height:8px;border-radius:50%;flex-shrink:0}
.status-item.done::before{background:#16A66A}.status-item.pending{color:#74829A}.status-item.pending::before{background:#9AA6B8}
/* Scan */
.scan-panel{background:#EEF4FF;border:1px solid #C9D9FF;border-radius:14px;padding:24px;margin-bottom:28px}
.scan-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.scan-title{font-size:17px;font-weight:700;color:#14213D}
.scan-select{background:#FFFFFF;color:#14213D;border:1px solid #C9D9FF;padding:8px 14px;border-radius:8px;font-size:15px;cursor:pointer;font-weight:500}
.usage-row{display:flex;gap:12px;margin-bottom:14px}
.usage-block{flex:1;background:#FFFFFF;border:1px solid #D6E1F7;border-radius:10px;padding:14px 16px;text-align:center}
.usage-val{font-size:20px;font-weight:750;color:#1F478F;line-height:26px}
.usage-lbl{font-size:13px;color:#687790;margin-top:2px}
.scan-usage-title{font-size:14px;font-weight:600;color:#46546C;margin-bottom:10px}
.scan-info{font-size:14px;line-height:21px;color:#6F7D96;margin-bottom:20px;padding:10px 14px;background:#FFFFFF;border:1px solid #D6E1F7;border-radius:8px}
.btn-primary{display:block;width:100%;height:54px;background:#3568E8;color:#FFFFFF;border:none;border-radius:10px;font-size:17px;font-weight:700;cursor:pointer;box-shadow:0 8px 18px rgba(53,104,232,0.22);transition:background 0.15s;margin-top:4px}
.btn-primary:hover{background:#2857CF}.btn-primary:active{background:#214BB7}
.btn-primary:disabled{opacity:0.6;cursor:default}
/* Progress */
.scan-progress{margin-bottom:28px}
.scan-progress-title{font-size:17px;font-weight:700;color:#14213D;margin-bottom:14px}
.sp-status{font-size:15px;line-height:24px;color:#46546C;margin-bottom:12px}
.sp-status b{color:#14213D}
.sp-bar{height:8px;background:#DDE5F0;border-radius:999px;overflow:hidden;margin-bottom:12px}
.sp-bar-fill{height:100%;background:#4777EC;border-radius:999px;transition:width 0.5s}
.sp-stats{font-size:14px;color:#6F7D96;margin-bottom:12px}
.sp-err{color:#E89417}
.scan-done{text-align:center;padding:20px 0}
.scan-done-title{font-size:22px;font-weight:720;color:#16A66A;margin-bottom:6px}
.scan-done-desc{font-size:16px;color:#46546C;margin-bottom:16px}
/* Quota */
.quota-section{margin-top:32px;padding-top:24px;border-top:1px solid #E7ECF4}
.quota-title{font-size:17px;font-weight:700;color:#263652;margin-bottom:16px}
.q-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;font-size:14px}
.q-label{color:#46546C;width:150px;flex-shrink:0}.q-num{color:#6F7D96;width:100px;flex-shrink:0}.q-pct{color:#6F7D96;width:36px;flex-shrink:0;font-size:13px}
.q-bar{flex:1;height:8px;background:#DDE5F0;border-radius:999px;overflow:hidden}
.q-fill{height:100%;border-radius:999px;transition:width 0.5s}
.q-reset{font-size:14px;color:#66758D;margin-top:10px}
`;

const SHELL_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F3F6FB;color:#46546C;font-size:15px;line-height:1.5}
.shell{max-width:860px;margin:60px auto;padding:0 24px}
.shell-header h1{font-size:28px;color:#14213D}.shell-header p{color:#5F6F89;font-size:14px;margin-top:4px}
.shell-card{background:#FFFFFF;border:1px solid #D9E2F0;border-radius:20px;padding:60px 48px;text-align:center;margin-top:32px;box-shadow:0 8px 28px rgba(28,48,82,0.06)}
.spinner{width:40px;height:40px;border:3px solid #E6EBF3;border-top-color:#3568E8;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
#shell-status{font-size:16px;color:#46546C}
#shell-status small{font-size:13px;color:#8490A6;display:block;margin-top:6px}
#shell-retry{margin-top:16px;padding:10px 24px;background:#3568E8;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
#shell-retry:hover{background:#2857CF}
`;

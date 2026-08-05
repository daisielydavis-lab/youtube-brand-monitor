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
    const m: Record<string,string> = {confirmed_paid_placement:'Confirmed',likely_sponsored:'Likely',organic_mention:'Organic',official_brand_video:'Official',unknown:'Unknown'};
    return `<span class="b b-${t}">${m[t]||t}</span>`;
  };
  const timeAgo = (iso: string) => {
    if(!iso) return 'Never'; const d=(Date.now()-new Date(iso).getTime())/1000;
    return d<60?'Just now':d<3600?Math.floor(d/60)+'m':d<86400?Math.floor(d/3600)+'h':Math.floor(d/86400)+'d ago';
  };

  // ── Empty state ──
  if (!data.hasData) return emptyState(sysStatus);

  const quotaPct = Math.round((sysStatus.searchQuotaUsed||0)/100*100);

  // ── TAB 1: Overview ──
  const kpi = data.kpi as any;
  const coverageColor = (kpi.coveragePct ?? 0) >= 80 ? '#19A974' : (kpi.coveragePct ?? 0) >= 50 ? '#F59E0B' : '#EF5B5B';
  const overview = `
  <div class="kpi-row" style="grid-template-columns:repeat(5,1fr)">
    <div class="kpi"><div class="kpi-n">${kpi.confirmedLikely ?? kpi.newAds ?? 0}</div><div class="kpi-l">Confirmed/Likely</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.activeCreators ?? 0}</div><div class="kpi-l">Active Creators</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.activeCampaigns ?? 0}</div><div class="kpi-l">Active Campaigns</div></div>
    <div class="kpi hl"><div class="kpi-n" style="color:${coverageColor}">${kpi.coveragePct ?? 0}%</div><div class="kpi-l">Analysis Coverage</div></div>
    <div class="kpi"><div class="kpi-n">${kpi.newCreatorsThisWeek ?? 0}</div><div class="kpi-l">New Creators</div></div>
  </div>

  <h2>🚨 Recent Competitive Moves</h2>
  ${campaigns.length ? campaigns.slice(0, 8).map((c: any) => {
    const brandColor = ({GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'} as any)[c.brand]||'#94a3b8';
    const ovCtLabel: Record<string,string> = {multi_creator_campaign:'Multi-Creator',creator_series:'Creator Series',one_off_placement:'Placement',brand_push:'Brand Push'};
    const statusColor = c.status === 'active' ? '#19A974' : c.status === 'cooling' ? '#F59E0B' : '#8490A6';
    const angle = c.primary_selling_point || c.primarySellingPoint || '';
    return `<div class="camp-card" style="margin-bottom:10px;border-left:3px solid ${brandColor}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:16px;font-weight:700;color:${brandColor}">${esc(c.brand)}</span>
          <span style="font-size:14px;color:#4B5870"> × ${esc(c.game)}</span>
          <span style="font-size:10px;background:#F3F7FF;color:#3B6EF5;padding:1px 6px;border-radius:3px;margin-left:6px">${ovCtLabel[c.cluster_type]||c.cluster_type||'Campaign'}</span>
        </div>
        <span style="font-size:11px;color:${statusColor}">${c.status} · ${c.active_from} → ${c.active_to}</span>
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:12px;color:#4B5870">
        <span>👤 <b>${c.creator_count}</b> creators</span>
        <span>🎬 <b>${c.video_count}</b> videos</span>
        <span>👁 <b>${fmt(c.total_estimated_views||0)}</b> views</span>
        <span>🌍 ${esc(c.primary_market||c.primaryMarket||'Global')}</span>
        ${angle ? `<span style="background:#F3F7FF;color:#3B6EF5;padding:1px 8px;border-radius:4px">${esc(angle)}</span>` : ''}
      </div>
    </div>`;
  }).join('') : '<p class="mt">No active campaigns detected. Run a scan to discover competitive moves.</p>'}

  <h2>🔍 Competitor Breakdown</h2>
  <div class="brand-grid">
    ${data.brandComparison.slice(0, 3).map(b=>`
    <div class="brand-card" style="border-top:3px solid ${bc(b.brandName)}">
      <div class="bc-n" style="color:${bc(b.brandName)}">${esc(b.brandName)}</div>
      <div class="bc-s"><span>${b.newVideos}</span> placements · <span>${b.creators}</span> creators</div>
    </div>`).join('')}
  </div>

  <div class="two-col">
    <div><h2>🎮 Top Games</h2>
      ${data.topGames.slice(0,6).map(g=>`<div class="game-row"><span style="flex:1">${esc(g.game)}</span><span>${g.videoCount} videos</span></div>`).join('')||'<p class="mt">No data</p>'}
    </div>
    <div><h2>🏷 Content Angles</h2>
      ${data.topThemes.slice(0,6).map(t=>`<div class="game-row"><span style="flex:1">${fmtTopic(t.topic)}</span><span>${t.videoCount}</span></div>`).join('')||'<p class="mt">No data</p>'}
    </div>
  </div>`;

  // ── TAB 2: Campaigns ──
  const ctLabel: Record<string,string> = {multi_creator_campaign:'Multi-Creator Campaign',creator_series:'Creator Series',one_off_placement:'One-off Placement',brand_push:'Brand Push'};
  const campaignsTab = campaigns.length ? campaigns.map((c:any)=>{
    const brandColor = ({GearUP:'#f59e0b',ExitLag:'#3b82f6',LagZapper:'#22c55e'} as any)[c.brand]||'#94a3b8';
    const statusColor = c.status === 'active' ? '#19A974' : c.status === 'cooling' ? '#F59E0B' : '#8490A6';
    return `<div class="camp-card" style="margin-bottom:14px;border-left:3px solid ${brandColor};padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <span style="font-size:17px;font-weight:700;color:${brandColor}">${esc(c.brand)}</span>
          <span style="font-size:15px;color:#4B5870"> × ${esc(c.game)}</span>
          <span style="font-size:11px;background:#F3F7FF;color:#3B6EF5;padding:2px 8px;border-radius:3px;margin-left:8px">${ctLabel[c.cluster_type]||c.cluster_type||'Campaign'}</span>
        </div>
        <span style="font-size:12px;padding:4px 10px;border-radius:8px;color:#fff;background:${statusColor}">${c.status}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:10px">
        <div><span style="font-size:11px;color:#8490A6;display:block">Period</span><span style="font-size:13px;font-weight:600;color:#172033">${c.active_from} → ${c.active_to}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">Creators</span><span style="font-size:13px;font-weight:600;color:#172033">${c.creator_count}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">Videos</span><span style="font-size:13px;font-weight:600;color:#172033">${c.video_count}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">Est. Views</span><span style="font-size:13px;font-weight:600;color:#172033">${fmt(c.total_estimated_views||0)}</span></div>
        <div><span style="font-size:11px;color:#8490A6;display:block">Market</span><span style="font-size:13px;font-weight:600;color:#172033">${esc(c.primary_market||c.primaryMarket||'Global')}</span></div>
      </div>
      <div style="font-size:12px;color:#4B5870">
        <span style="background:#F3F7FF;color:#3B6EF5;padding:2px 8px;border-radius:4px;margin-right:6px">${esc(c.primary_selling_point||c.primarySellingPoint||'General')}</span>
      </div>
    </div>`;
  }).join('') : '<p class="mt">No campaigns detected yet. Campaigns are auto-detected when the same brand+game combination has multiple placements within 7 days.</p>';

  // ── TAB 3: Videos with filter + actions ──
  const contentTypeLabel: Record<string,string> = {dedicated:'Dedicated',integrated:'Integration',shorts:'Shorts',live:'Livestream',dedicated_review:'Dedicated',integrated_placement:'Integration',live_replay:'Livestream'};
  const evidenceIcon = (rc: string[]) => {
    if (!rc?.length) return '⚪';
    const hasStrong = rc.some(r => ['brand_in_title','promo_code','sponsored_tag','paid_tag','brand_link'].includes(r));
    if (hasStrong) return '🟢';
    return '🟡';
  };
  const videosTab = `
  <div class="ctrls">
    <select onchange="applyFilter('placement',this.value)"><option value="all">All Placements</option><option value="confirmed_paid_placement" ${sel('placement','confirmed_paid_placement')}>Confirmed</option><option value="likely_sponsored" ${sel('placement','likely_sponsored')}>Likely</option><option value="organic_mention" ${sel('placement','organic_mention')}>Organic</option></select>
    <select onchange="applyFilter('type',this.value)"><option value="all">All Types</option><option value="dedicated" ${sel('type','dedicated')}>Dedicated</option><option value="integrated" ${sel('type','integrated')}>Integrated</option><option value="shorts" ${sel('type','shorts')}>Shorts</option><option value="live" ${sel('type','live')}>Livestream</option></select>
  </div>
  <table class="dt vf"><thead><tr><th></th><th>Title</th><th>Channel</th><th>Brand</th><th>Game</th><th>Type</th><th>Views</th><th>Evidence</th><th>Actions</th></tr></thead><tbody>
  ${data.recentVideos.slice(0,30).map(v=>`<tr>
    <td>${v.thumbnailUrl?`<img src="${esc(v.thumbnailUrl)}" width="80" height="45" style="border-radius:4px">`:''}</td>
    <td><a href="https://youtube.com/watch?v=${esc(v.videoId)}" target="_blank">${esc(v.title.slice(0,55))}${v.title.length>55?'…':''}</a></td>
    <td style="white-space:nowrap">${esc(v.channelName)}</td>
    <td style="white-space:nowrap">${esc(v.brand)}</td>
    <td style="white-space:nowrap">${esc(v.game)}</td>
    <td><span class="et">${esc(contentTypeLabel[(v as any).contentCategory]||(v as any).contentCategory||'?')}</span></td>
    <td style="white-space:nowrap">${fmt(v.viewCount)}</td>
    <td><span title="${esc((v.reasonCodes||v.discoveryEvidence||[]).join(', '))}" style="cursor:help">${evidenceIcon(v.reasonCodes||v.discoveryEvidence)} ${badge(v.placementType)}</span></td>
    <td class="acts"><button onclick="va('${v.videoId}','confirm_placement')" class="a a-y" title="Confirm">✓</button><button onclick="va('${v.videoId}','mark_organic')" class="a a-o" title="Organic">O</button><button onclick="va('${v.videoId}','ignore')" class="a a-r" title="Ignore">✕</button></td>
  </tr>`).join('')}
  </tbody></table>`;

  // ── TAB 4: Creators (loaded via JS) ──
  const relLabels: Record<string,string> = {new:'New',recurring:'Recurring',loyal:'Loyal',multi_brand:'Multi-Brand'};
  const creatorsTab = `<div id="creators-load"><p class="mt">Loading creators...</p></div>`;

  // ── TAB 5: Comments (loaded via JS) ──
  const commentsTab = `<div id="comments-load"><p class="mt">Loading comments...</p></div>`;

  // ── TAB 6: System ──
  const systemTab = `
  <div class="kpi-row" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi ${quotaPct>70?'hl':''}"><div class="kpi-n">${sysStatus.searchQuotaUsed||0}<small style="font-size:14px;color:#64748b">/100</small></div><div class="kpi-l">Search Quota</div></div>
    <div class="kpi"><div class="kpi-n">${sysStatus.generalQuotaUsed||0}<small style="font-size:14px;color:#64748b">/10K</small></div><div class="kpi-l">General Quota</div></div>
    <div class="kpi"><div class="kpi-n">${sysStatus.totalVideos||0}</div><div class="kpi-l">Total Videos</div></div>
    <div class="kpi"><div class="kpi-n">${sysStatus.totalCreators||0}</div><div class="kpi-l">Tracked Creators</div></div>
  </div>
  <h2>Scan Logs</h2>
  <table class="dt"><thead><tr><th>Time</th><th>Mode</th><th>Searches</th><th>Found</th><th>New</th><th>Quota Used</th><th>Status</th></tr></thead><tbody id="scan-logs"><tr><td colspan="7" class="mt">Loading...</td></tr></tbody></table>
  <h2>Hotspot</h2>
  <div class="ctrls" style="align-items:center">
    <input id="hs-game" placeholder="Game name (e.g. Valorant)" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;width:200px">
    <input id="hs-days" placeholder="Days (1-7)" value="7" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;width:80px">
    <button onclick="startHotspot()" class="btn-scan">Start Hotspot</button>
    <button onclick="stopHotspot()" style="background:#1e293b;color:#ef4444;border:1px solid #ef4444;padding:6px 12px;border-radius:6px;cursor:pointer">Stop Hotspot</button>
    <span id="hs-status" style="font-size:12px;color:#64748b">${sysStatus.hotspotActive?'🔴 Active':'⚪ Inactive'}</span>
  </div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor Monitor v3</title><style>${CSS}</style></head><body>
<div class="container">
  <header>
    <div><h1>📊 YouTube Competitor Monitor</h1><p class="sub">GearUP · ExitLag · LagZapper</p></div>
    <div class="sys">
      <span class="dot ${(sysStatus.searchQuotaUsed||0)>70?'warn':'ok'}">Search: ${sysStatus.searchQuotaUsed||0}/100</span>
      <span>General: ${sysStatus.generalQuotaUsed||0}/10K</span>
      <span>Last: ${timeAgo(sysStatus.lastRun)}</span>
      <span>Hotspot: ${sysStatus.hotspotActive?'🔴':'⚪'}</span>
    </div>
  </header>
  <div class="ctrls">
    <select onchange="applyFilter('brand',this.value)"><option value="all">All Brands</option><option value="GearUP" ${sel('brand','GearUP')}>GearUP</option><option value="ExitLag" ${sel('brand','ExitLag')}>ExitLag</option><option value="LagZapper" ${sel('brand','LagZapper')}>LagZapper</option></select>
    <select onchange="applyFilter('market',this.value)"><option value="all">Global</option><option value="US" ${sel('market','US')}>US</option><option value="RU" ${sel('market','RU')}>Russia</option><option value="BR" ${sel('market','BR')}>Brazil</option></select>
    <select onchange="applyFilter('range',this.value)"><option value="7d" ${sel('range','7d')}>7 Days</option><option value="30d" ${sel('range','30d')}>30 Days</option><option value="90d" ${sel('range','90d')}>90 Days</option></select>
    <a href="/run" class="btn-scan">Run Scan</a>
  </div>
  <nav class="tabs">
    <a href="#" class="tab" onclick="switchTab('overview')" id="tab-overview">Overview</a>
    <a href="#" class="tab" onclick="switchTab('campaigns')" id="tab-campaigns">Campaigns</a>
    <a href="#" class="tab" onclick="switchTab('videos')" id="tab-videos">Videos</a>
    <a href="#" class="tab" onclick="switchTab('creators')" id="tab-creators">Creators</a>
    <a href="#" class="tab" onclick="switchTab('comments')" id="tab-comments">Comments</a>
    <a href="#" class="tab" onclick="switchTab('system')" id="tab-system">System</a>
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
function applyFilter(k,v){const u=new URL(location);v==='all'?u.searchParams.delete(k):u.searchParams.set(k,v);location=u.toString()}
function switchTab(t){document.querySelectorAll('.tab-content').forEach(e=>e.style.display='none');document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));document.getElementById('tab-panel-'+t).style.display='block';document.getElementById('tab-'+t).classList.add('active');if(t==='creators')loadCreators();if(t==='comments')loadComments();if(t==='system')loadSystem();localStorage.setItem('tab',t)}
async function va(id,a){try{const r=await fetch('/api/videos/'+id+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});const d=await r.json();showToast(d.success?'✅ Updated':'❌ '+d.error);if(d.success)setTimeout(()=>location.reload(),500)}catch(e){showToast('❌ Failed')}}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2000)}
async function loadCreators(){const el=document.getElementById('creators-load');try{const r=await fetch('/api/creators?range=30');const d=await r.json();if(!d||!d.length){el.innerHTML='<p class=mt>No creators match the current filters.</p>';return}el.innerHTML='<table class=dt><thead><tr><th>Creator</th><th>Subs</th><th>Videos</th><th>Avg Views</th><th>Games</th><th>Brand Mentions</th><th>Relation</th></tr></thead><tbody>'+d.slice(0,30).map(c=>'<tr><td>'+escapeHtml(c.channelName||'?')+'</td><td>'+(c.subscriberCount?c.subscriberCount>=1000000?(c.subscriberCount/1000000).toFixed(1)+'M':c.subscriberCount>=1000?(c.subscriberCount/1000).toFixed(1)+'K':String(c.subscriberCount):'-')+'</td><td>'+c.videosInWindow+' ('+c.confirmedCount+'✓ '+c.likelyCount+'~)'+'</td><td>'+ (c.avgViews>=1000?(c.avgViews/1000).toFixed(1)+'K':String(c.avgViews)) +'</td><td>'+escapeHtml((c.games||[]).slice(0,2).join(', '))+'</td><td>'+Object.entries(c.brandMentions||{}).filter(([,n])=>n>0).map(([b,n])=>b+' '+n).join(' ') +'</td><td><span style=font-size:10px;background:#F3F7FF;color:#3B6EF5;padding:1px 6px;border-radius:3px>'+(({new:'New',recurring:'Recurring',loyal:'Loyal',multi_brand:'Multi-Brand'} as any)[c.relationType]||c.relationType)+'</span></td></tr>').join('')+'</tbody></table>'}catch(e){el.innerHTML='<p class=mt>Failed to load creators</p>'}}
async function loadComments(){const el=document.getElementById('comments-load');try{const r=await fetch('/api/comments?limit=50');const d=await r.json();el.innerHTML=d.length?d.slice(0,30).map(c=>'<div class="comment"><b>'+escapeHtml(c.author_name||'?')+'</b> on '+escapeHtml((c.youtube_competitor_videos||{}).title||'?').slice(0,50)+'<br>'+escapeHtml((c.comment_text||'').slice(0,200))+'<br><span class="bt">'+(c.has_purchase_intent?'💳 Intent':'')+' '+(c.is_brand_related?'🏷 Brand':'')+' '+(c.sentiment||'')+'</span></div>').join(''):'<p class="mt">No comments analyzed yet</p>'}catch(e){el.innerHTML='<p class="mt">Failed to load</p>'}}
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
  const m: Record<string,string> = {game_integration:'Game Integration',lag_fix:'Reduce Ping',booster_review:'Booster Review',competitor_comparison:'Comparison',promo_code:'Promo Code',free_limited:'Free/Trial',new_game_launch:'New Launch',season_update:'Season Update',region_unlock:'Cross-Region',tutorial:'Tutorial',pure_endorsement:'Sponsored'};
  return m[t]||t;
}

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

/**
 * YouTube Competitor Monitor v3 — Tabbed Dashboard UI
 * Tabs: Overview | Campaigns | Videos | Creators | Comments | System
 */
import type { DashboardData } from '../services/competitor-monitor/dashboard-data';

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
  const overview = `
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-n">${data.kpi.newPlacements}</div><div class="kpi-l">New Placements</div></div>
    <div class="kpi"><div class="kpi-n">${data.kpi.activeCreators}</div><div class="kpi-l">Active Creators</div></div>
    <div class="kpi"><div class="kpi-n">${data.kpi.videosMonitored}</div><div class="kpi-l">Monitored</div></div>
    <div class="kpi hl"><div class="kpi-n">${data.kpi.highConfidence}</div><div class="kpi-l">High-Confidence</div></div>
  </div>
  <h2>🔍 Competitor Comparison</h2>
  <div class="brand-grid">
    ${data.brandComparison.map(b=>`
    <div class="brand-card" style="border-top:3px solid ${bc(b.brandName)}">
      <div class="bc-n" style="color:${bc(b.brandName)}">${esc(b.brandName)}</div>
      <div class="bc-s"><span>${b.newVideos}</span> new · <span>${b.creators}</span> creators · <span>${fmt(b.median7dViews)}</span> median views</div>
      <div class="bc-s">Top: ${esc(b.topGame)} · ${esc(b.topMarket)}</div>
    </div>`).join('')}
  </div>
  <div class="two-col">
    <div><h2>🎮 Top Games</h2>
      ${data.topGames.slice(0,8).map(g=>`<div class="game-row"><span>${esc(g.game)}</span><span class="g-bar"><span class="g-fill" style="width:${Math.round(g.videoCount/Math.max(...data.topGames.map(x=>x.videoCount),1)*100)}%"></span></span><span>${g.videoCount}</span><span>${Object.entries(g.brands).map(([b,n])=>`<i style="color:${bc(b)}">${b} ${n}</i>`).join(' ')}</span></div>`).join('')||'<p class="mt">No data</p>'}
    </div>
    <div><h2>🏷 Top Themes</h2>
      ${data.topThemes.slice(0,8).map(t=>`<div class="game-row"><span>${fmtTopic(t.topic)}</span><span>${t.videoCount}</span><span>${Object.entries(t.brands).map(([b,n])=>`<i style="color:${bc(b)}">${b} ${n}</i>`).join(' ')}</span></div>`).join('')||'<p class="mt">No data</p>'}
    </div>
  </div>
  <h2>📊 Active Campaigns</h2>
  ${campaigns.length?campaigns.slice(0,5).map((c:any)=>`<div class="camp-card"><b>${esc(c.brand)} · ${esc(c.game)}</b> — ${c.video_count} videos · ${c.creator_count} creators · ${fmt(c.total_estimated_views||0)} views · ${c.primary_selling_point||'N/A'}</div>`).join(''):'<p class="mt">No active campaigns detected</p>'}
  <h2>⭐ Top Creators</h2>
  <table class="dt"><thead><tr><th>Creator</th><th>Brand</th><th>Game</th><th>Subs</th><th>7D Views</th><th>Eng.</th><th>Sponsor</th><th>vs Baseline</th></tr></thead><tbody>
  ${data.topCreators.slice(0,10).map(c=>`<tr><td>${esc(c.channelName)}</td><td>${esc(c.recentBrand)}</td><td>${esc(c.recentGame)}</td><td>${fmt(c.subscriberCount)}</td><td>${fmt(c.views7d)}</td><td>${(c.engagementRate*100).toFixed(1)}%</td><td>${badge(c.sponsorship)}</td><td>${c.performanceVsBaseline!==null?`<span style="color:${c.performanceVsBaseline>0?'#22c55e':'#ef4444'}">${c.performanceVsBaseline>0?'+':''}${c.performanceVsBaseline}%</span>`:'-'}</td></tr>`).join('')}
  </tbody></table>`;

  // ── TAB 2: Campaigns ──
  const campaignsTab = campaigns.length ? campaigns.map((c:any)=>`
    <div class="camp-card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between"><b>${esc(c.brand)} · ${esc(c.game)}</b><span class="b b-${c.status==='active'?'confirmed_paid_placement':'unknown'}">${c.status}</span></div>
      <div class="bc-s">${c.video_count} videos · ${c.creator_count} creators · ${fmt(c.total_estimated_views||0)} total views</div>
      <div class="bc-s">Selling point: ${esc(c.primary_selling_point||'N/A')} · Market: ${esc(c.primary_market||'N/A')} · ${c.active_from}→${c.active_to}</div>
    </div>`).join('') : '<p class="mt">No campaigns detected yet. Campaigns are auto-detected when the same brand+game combination has multiple placements within 7 days.</p>';

  // ── TAB 3: Videos with filter + actions ──
  const videosTab = `
  <div class="ctrls">
    <select onchange="applyFilter('placement',this.value)"><option value="all">All Placements</option><option value="confirmed_paid_placement" ${sel('placement','confirmed_paid_placement')}>Confirmed</option><option value="likely_sponsored" ${sel('placement','likely_sponsored')}>Likely</option><option value="organic_mention" ${sel('placement','organic_mention')}>Organic</option></select>
    <select onchange="applyFilter('type',this.value)"><option value="all">All</option><option value="long" ${sel('type','long')}>Long-form</option><option value="short" ${sel('type','short')}>Shorts</option></select>
  </div>
  <table class="dt vf"><thead><tr><th></th><th>Title</th><th>Channel</th><th>Brand</th><th>Game</th><th>Views</th><th>Confidence</th><th>Status</th><th>Actions</th></tr></thead><tbody>
  ${data.recentVideos.slice(0,30).map(v=>`<tr>
    <td>${v.thumbnailUrl?`<img src="${esc(v.thumbnailUrl)}" width="80" height="45" style="border-radius:4px">`:''}</td>
    <td><a href="https://youtube.com/watch?v=${esc(v.videoId)}" target="_blank">${esc(v.title.slice(0,60))}${v.title.length>60?'…':''}</a></td>
    <td>${esc(v.channelName)}</td><td>${esc(v.brand)}</td><td>${esc(v.game)}</td>
    <td>${fmt(v.viewCount)}</td><td>${badge(v.placementType)}</td>
    <td>${v.discoveryEvidence.slice(0,2).map(e=>`<span class="et">${esc(e)}</span>`).join('')}</td>
    <td class="acts"><button onclick="va('${v.videoId}','confirm_placement')" class="a a-y" title="Confirm">✓</button><button onclick="va('${v.videoId}','mark_organic')" class="a a-o" title="Organic">O</button><button onclick="va('${v.videoId}','ignore')" class="a a-r" title="Ignore">✕</button></td>
  </tr>`).join('')}
  </tbody></table>`;

  // ── TAB 4: Creators ──
  const creatorsTab = `
  <table class="dt"><thead><tr><th>Creator</th><th>Size</th><th>Type</th><th>Subs</th><th>Avg Views</th><th>Games</th><th>Brand Mentions</th><th>Relation</th></tr></thead><tbody>
  ${data.topCreators.slice(0,20).map(c=>`<tr><td>${esc(c.channelName)}</td><td>${(sysStatus.creatorProfiles||[]).find((x:any)=>x.channel_id===c.channelId)?.creator_size||'-'}</td><td>${(sysStatus.creatorProfiles||[]).find((x:any)=>x.channel_id===c.channelId)?.content_type||'-'}</td><td>${fmt(c.subscriberCount)}</td><td>${fmt(c.views7d)}</td><td>${esc(c.recentGame)}</td><td>${esc(c.recentBrand)}</td><td>${(sysStatus.creatorProfiles||[]).find((x:any)=>x.channel_id===c.channelId)?.relationship_status||'-'}</td></tr>`).join('')}
  </tbody></table>`;

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
  <div id="tab-overview" class="tab-content">${overview}</div>
  <div id="tab-campaigns" class="tab-content" style="display:none">${campaignsTab}</div>
  <div id="tab-videos" class="tab-content" style="display:none">${videosTab}</div>
  <div id="tab-creators" class="tab-content" style="display:none">${creatorsTab}</div>
  <div id="tab-comments" class="tab-content" style="display:none">${commentsTab}</div>
  <div id="tab-system" class="tab-content" style="display:none">${systemTab}</div>
  <div class="disc">ⓘ Public data estimates only. <span onclick="this.nextElementSibling.style.display='inline'" style="color:#38bdf8;cursor:pointer">More</span><span style="display:none;color:#64748b"> Does not represent ROI, CPA, conversion rate, or ad spend. Shorts and long-form tracked separately.</span></div>
  <div id="toast" class="toast" style="display:none"></div>
</div>
<script>
function applyFilter(k,v){const u=new URL(location);v==='all'?u.searchParams.delete(k):u.searchParams.set(k,v);location=u.toString()}
function switchTab(t){document.querySelectorAll('.tab-content').forEach(e=>e.style.display='none');document.querySelectorAll('.tab').forEach(e=>e.classList.remove('active'));document.getElementById('tab-'+t).style.display='block';document.getElementById('tab-'+t).classList.add('active');if(t==='comments')loadComments();if(t==='system')loadSystem();localStorage.setItem('tab',t)}
async function va(id,a){try{const r=await fetch('/api/videos/'+id+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});const d=await r.json();showToast(d.success?'✅ Updated':'❌ '+d.error);if(d.success)setTimeout(()=>location.reload(),500)}catch(e){showToast('❌ Failed')}}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2000)}
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
  const quotaColor = (pct: number) => pct>=95?'#ef4444':pct>=85?'#f59e0b':pct>=70?'#f97316':'#22c55e';
  // Quota reset: midnight Pacific = 07:00 UTC
  const nextReset = new Date(); nextReset.setUTCHours(7,0,0,0);
  if (nextReset <= new Date()) nextReset.setDate(nextReset.getDate()+1);
  const resetLocal = nextReset.toLocaleString('en-US', {hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  const resetBeijing = new Date(nextReset.getTime() + 8*3600000).toLocaleString('en-US', {hour:'numeric',minute:'2-digit'});
  const creatorCount = sys.totalCreators||0;
  const estChGeneral = Math.ceil(creatorCount/50) + creatorCount; // channels.list batch + playlistItems per channel

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Competitor Monitor</title><style>${CSS}</style></head><body>
<div class="container">
<header><div><h1>📊 YouTube Competitor Monitor</h1><p class="sub">GearUP · ExitLag · LagZapper</p></div>
<div class="sys"><span class="dot ${sqPct>70?'warn':'ok'}" title="App-tracked usage">Search: ${sys.searchQuotaUsed||0}/100</span><span>General: ${sys.generalQuotaUsed||0}/10K</span></div></header>

<div class="onboard">
<h2>No scan results yet</h2>
<p>Your monitor is configured and ready for its first discovery scan.</p>

<div class="config-summary">
  <div class="cs-row"><span>Brands</span><span>3</span></div>
  <div class="cs-row"><span>Discovery queries</span><span>6</span></div>
  <div class="cs-row"><span>Creator watchlist</span><span>${creatorCount} channels</span></div>
  <div class="cs-row"><span>Markets</span><span>Global</span></div>
  <div class="cs-row"><span>Languages</span><span>All</span></div>
  <div class="cs-row"><span>Scan mode</span><span>Normal</span></div>
</div>

<div class="checklist">
  <div class="cl-item done">YouTube API connected</div>
  <div class="cl-item done">Creator monitoring enabled</div>
  <div class="cl-item pending">First discovery scan pending</div>
</div>

<div class="scan-config" id="scan-config">
  <div class="sc-row">
    <span class="sc-label">Scan window</span>
    <select id="scan-days" class="sc-select">
      <option value="7">Past 7 days</option>
      <option value="30" selected>Past 30 days</option>
      <option value="60">Past 60 days</option>
    </select>
  </div>
  <div class="sc-estimate">
    <span>Estimated usage</span>
    <div>
      <div><strong id="est-search">6</strong> Search calls</div>
      <div><strong id="est-general">~${estChGeneral}</strong> General API reads</div>
      <div>Up to <strong id="est-videos">300</strong> raw results</div>
    </div>
  </div>
  <div class="sc-note">Latest 50 results per query · Deduplicated after discovery${creatorCount>0?'<br>Creator uploads checked without using Search quota':''}</div>
  <button onclick="startFirstScan()" class="btn-p" id="scan-btn">🔍 Run First Scan</button>
  <div class="sc-note" style="margin-top:6px;font-size:11px;color:#475569">ⓘ Quota values are app-tracked. Google Cloud Console may have slight delay.</div>
</div>

<div id="scan-progress" class="scan-progress" style="display:none">
  <h3>Running first scan…</h3>
  <div class="sp-status" id="sp-status"></div>
  <div class="sp-bar"><div class="sp-bar-fill" id="sp-bar" style="width:5%"></div></div>
  <div class="sp-stats" id="sp-stats"></div>
  <div id="sp-result"></div>
  <button id="sp-abort" onclick="location.reload()" style="display:none;margin-top:12px;background:transparent;color:#64748b;border:1px solid #334155;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">Abort</button>
</div>

<div class="quota-section">
  <div class="q-row">
    <span class="q-label">Search discovery</span>
    <span class="q-num">${sys.searchQuotaUsed||0} / 100</span>
    <div class="q-bar"><div class="q-fill" style="width:${sqPct}%;background:${quotaColor(sqPct)}"></div></div>
  </div>
  <div class="q-row">
    <span class="q-label">General data reads</span>
    <span class="q-num">${sys.generalQuotaUsed||0} / 10,000</span>
    <div class="q-bar"><div class="q-fill" style="width:${gqPct}%;background:${quotaColor(gqPct)}"></div></div>
  </div>
  <div class="q-reset">Next reset: Today, ${resetBeijing} Beijing Time <span title="7:00 AM UTC · Google quota resets at midnight Pacific">ⓘ</span></div>
</div>
</div>

<script>
const CREATOR_COUNT = ${creatorCount};
async function startFirstScan() {
  const days = document.getElementById('scan-days').value;
  const btn = document.getElementById('scan-btn');
  btn.textContent = 'Scanning…'; btn.disabled = true; btn.style.opacity = '0.6';
  document.getElementById('scan-config').style.display = 'none';
  document.getElementById('scan-progress').style.display = 'block';

  fetch('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'manual',backfillDays:parseInt(days)})})
    .then(r=>r.json()).then(d=>{ if(!d.success) document.getElementById('sp-result').innerHTML='<p style="color:#ef4444">❌ '+d.error+'</p>'; });
  pollProgress();
}
function pollProgress() {
  fetch('/api/scan-status').then(r=>r.json()).then(s=>{
    var pct = s.done?100:s.videosNew>0?50:15;
    document.getElementById('sp-bar').style.width = pct+'%';
    if (s.running) {
      var parts = [];
      if (s.searchQuotaUsed>0) parts.push('Brand queries: <b>'+s.searchQuotaUsed+' / 6</b>');
      if (CREATOR_COUNT>0) parts.push('Creator channels: scanning ' + CREATOR_COUNT);
      if (s.videosFound>0) parts.push('Videos discovered: <b>'+s.videosFound+'</b>');
      if (s.videosNew>0) parts.push('Unique: <b>'+s.videosNew+'</b>');
      document.getElementById('sp-status').innerHTML = parts.length ? parts.join('<br>') : 'Starting…';
      document.getElementById('sp-stats').innerHTML = s.errors.length ? '<span style="color:#f59e0b">⚠️ '+s.errors.join(', ')+'</span>' : '';
    }
    if (s.done) {
      document.getElementById('sp-bar').style.width='100%';
      document.getElementById('sp-status').innerHTML = '';
      document.getElementById('sp-abort').style.display='none';
      if (s.videosNew>0) {
        document.getElementById('sp-result').innerHTML = '<div class="scan-done"><h3>✅ First scan complete</h3><p>'+s.videosNew+' videos discovered</p><a href="/" class="btn-p">View Results</a></div>';
      } else {
        document.getElementById('sp-result').innerHTML = '<div class="scan-done"><h3>⚠️ Scan finished</h3><p>No new videos found in selected window. Try a wider date range or check quota.</p><a href="/" class="btn-p">Return to Dashboard</a></div>';
      }
      return;
    }
    setTimeout(pollProgress, 2000);
  }).catch(()=>setTimeout(pollProgress, 3000));
}
document.getElementById('scan-days').addEventListener('change', function(){
  var d = parseInt(this.value);
  var searches = d<=7?6:d<=30?12:24;
  document.getElementById('est-search').textContent = searches;
  document.getElementById('est-videos').textContent = d<=7?300:d<=30?600:1200;
  document.getElementById('est-general').textContent = '~'+CREATOR_COUNT+'–'+(Math.ceil(CREATOR_COUNT/50)+CREATOR_COUNT);
});
</script>
</div></body></html>`;
}

function fmtTopic(t: string): string {
  const m: Record<string,string> = {game_integration:'Game Integration',lag_fix:'Reduce Ping',booster_review:'Booster Review',competitor_comparison:'Comparison',promo_code:'Promo Code',free_limited:'Free/Trial',new_game_launch:'New Launch',season_update:'Season Update',region_unlock:'Cross-Region',tutorial:'Tutorial',pure_endorsement:'Sponsored'};
  return m[t]||t;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b1120;color:#e2e8f0;font-size:14px;line-height:1.5}
.container{max-width:1280px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;gap:12px}
h1{font-size:22px}h2{font-size:15px;color:#94a3b8;margin:20px 0 10px;padding-bottom:4px;border-bottom:1px solid #1e293b}
.sub{color:#64748b;font-size:13px}.sys{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:#94a3b8}
.sys span,.dot{background:#111827;padding:3px 8px;border-radius:10px;display:inline-flex;align-items:center;gap:4px}
.dot::before{content:'';width:5px;height:5px;border-radius:50%}.dot.ok::before{background:#22c55e}.dot.warn::before{background:#f59e0b}

/* Controls */
.ctrls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;background:#111827;padding:10px 14px;border-radius:8px}
.ctrls select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:5px 8px;border-radius:6px;font-size:12px}
.btn-scan{display:inline-block;padding:7px 14px;background:#1d4ed8;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;margin-left:auto}

/* Tabs */
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #1e293b;padding-bottom:0}
.tab{padding:8px 16px;color:#64748b;text-decoration:none;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:#e2e8f0}.tab.active{color:#38bdf8;border-bottom-color:#38bdf8}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.kpi{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px;text-align:center}
.kpi.hl{border-color:#1d4ed8;background:#1d4ed810}
.kpi-n{font-size:28px;font-weight:700}.kpi-l{font-size:11px;color:#64748b;margin-top:2px}

/* Brand */
.brand-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:20px}
.brand-card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:14px}
.bc-n{font-size:15px;font-weight:700;margin-bottom:6px}.bc-s{font-size:12px;color:#94a3b8;margin-bottom:3px}.bc-s span{color:#e2e8f0;font-weight:600}

/* Game rows */
.game-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #0f172a;font-size:13px}
.game-row i{font-style:normal;font-size:11px;margin:0 2px}
.g-bar{width:80px;height:5px;background:#1e293b;border-radius:3px;overflow:hidden;flex-shrink:0}
.g-fill{height:100%;background:#3b82f6;border-radius:3px;display:block}

/* Tables */
.dt{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px}
.dt th{text-align:left;padding:6px 8px;background:#111827;color:#64748b;font-weight:500;font-size:10px;text-transform:uppercase;border-bottom:1px solid #1e293b}
.dt td{padding:6px 8px;border-bottom:1px solid #0f172a}.dt tr:hover{background:#1e293b33}
.dt a{color:#38bdf8;text-decoration:none}

/* Badges */
.b{padding:1px 6px;border-radius:8px;font-size:10px;font-weight:500;white-space:nowrap}
.b-confirmed_paid_placement,.b-Confirmed{background:#dc262620;color:#ef4444}
.b-likely_sponsored,.b-Likely{background:#f59e0b20;color:#f59e0b}
.b-organic_mention,.b-Organic{background:#22c55e20;color:#22c55e}
.b-official_brand_video{background:#3b82f620;color:#3b82f6}
.b-unknown{background:#64748b20;color:#64748b}

/* Evidence tags */
.et{font-size:9px;background:#1e293b;padding:1px 5px;border-radius:3px;margin:1px;display:inline-block}

/* Video actions */
.acts{white-space:nowrap}.a{width:22px;height:22px;border:1px solid #334155;border-radius:3px;background:#1e293b;color:#94a3b8;cursor:pointer;font-size:11px;margin:0 1px}
.a:hover{background:#334155}.a-y:hover{color:#22c55e;border-color:#22c55e}
.a-o:hover{color:#f59e0b;border-color:#f59e0b}.a-r:hover{color:#ef4444;border-color:#ef4444}

/* Campaign card */
.camp-card{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px}

/* Comments */
.comment{background:#111827;border:1px solid #1e293b;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px}
.bt{font-size:10px;background:#1e293b;padding:1px 4px;border-radius:3px;margin-right:3px}

/* Two col */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:768px){.two-col{grid-template-columns:1fr}}

/* Empty / Onboard */
.mt{color:#64748b;font-style:italic;padding:16px;text-align:center}
.onboard{max-width:560px;margin:40px auto;background:#111827;border:1px solid #1e293b;border-radius:12px;padding:32px 36px}
.onboard h2{font-size:20px;color:#f1f5f9;border:none;margin-bottom:4px}
.onboard>p{color:#94a3b8;margin-bottom:20px;font-size:13px}
/* Config summary */
.config-summary{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin-bottom:20px;padding:12px;background:#0b1120;border-radius:8px}
.cs-row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:#94a3b8}
.cs-row span:last-child{color:#e2e8f0;font-weight:500}
/* Checklist */
.checklist{text-align:left;margin-bottom:20px}
.cl-item{font-size:13px;padding:6px 0;display:flex;align-items:center;gap:8px;color:#64748b}
.cl-item::before{content:'';width:6px;height:6px;border-radius:50%;flex-shrink:0}
.cl-item.done{color:#94a3b8}.cl-item.done::before{background:#22c55e}
.cl-item.pending{color:#64748b}.cl-item.pending::before{background:#64748b}
/* Scan config */
.scan-config{background:#0b1120;border-radius:8px;padding:16px;margin-bottom:16px}
.sc-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.sc-label{font-size:13px;color:#94a3b8}
.sc-select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer}
.sc-estimate{display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:14px}
.sc-estimate strong{color:#e2e8f0}
/* Scan progress */
.scan-progress{margin-bottom:16px;text-align:left}
.scan-progress h3{font-size:15px;color:#38bdf8;margin-bottom:12px}
.sp-steps{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.sp-step{font-size:13px;color:#64748b;padding:3px 0}
.sp-step.active{color:#38bdf8}.sp-step.done{color:#22c55e}
.sp-bar{height:4px;background:#1e293b;border-radius:2px;overflow:hidden;margin-bottom:10px}
.sp-bar-fill{height:100%;background:#38bdf8;transition:width 0.5s}
.sp-stats{font-size:12px;color:#94a3b8;display:flex;flex-wrap:wrap;gap:12px}
.sp-stats b{color:#e2e8f0}
.scan-done{text-align:center;padding:16px 0}
.scan-done h3{color:#22c55e}.scan-done p{color:#94a3b8;margin:4px 0 12px}
/* Quota */
.quota-section{margin-top:20px;border-top:1px solid #1e293b;padding-top:16px}
.q-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px}
.q-label{color:#94a3b8;width:130px;flex-shrink:0}.q-num{color:#64748b;width:80px;flex-shrink:0;text-align:right}
.q-bar{flex:1;height:4px;background:#1e293b;border-radius:2px;overflow:hidden}
.q-fill{height:100%;border-radius:2px;transition:width 0.5s}
.q-reset{font-size:11px;color:#475569;margin-top:6px;text-align:right}
.oc{font-size:14px;padding:8px 0;color:#e2e8f0;display:flex;align-items:center;gap:8px;text-align:left}
.oc-i{font-size:16px;width:20px;text-align:center;flex-shrink:0}.oc-i.ok{color:#22c55e}.oc-i.wait{color:#64748b}
.btn-p{display:inline-block;padding:12px 24px;background:#1d4ed8;color:white;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;cursor:pointer;border:none}
.btn-p:hover{background:#2563eb}
.disc{font-size:10px;color:#475569;text-align:center;margin-top:24px;padding-top:10px;border-top:1px solid #1e293b}
.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;color:#e2e8f0;padding:10px 18px;border-radius:8px;border:1px solid #334155;z-index:100}`;

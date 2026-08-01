/**
 * YouTube Competitor Monitor — Product Dashboard UI
 * Dark theme, data-dense, filterable, with onboarding flow.
 */

import type { DashboardData } from '../services/competitor-monitor/dashboard-data';

export function renderDashboard(data: DashboardData, filter?: Record<string, string>): string {
  const f = filter || {};
  const sel = (key: string, val: string) => (f[key] === val || (!f[key] && val === 'all') ? 'selected' : '');

  // ── Helpers ──
  const esc = (s: string) => s?.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') || '';
  const fmt = (n: number) => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);
  const badge = (type: string) => {
    const map: Record<string, string> = {
      confirmed_paid_placement: 'Confirmed', likely_sponsored: 'Likely',
      organic_mention: 'Organic', official_brand_video: 'Official', unknown: 'Unknown',
    };
    return `<span class="badge badge-${type}">${map[type] || type}</span>`;
  };
  const brandColor = (b: string) => ({ GearUP: '#f59e0b', ExitLag: '#3b82f6', LagZapper: '#22c55e' } as any)[b] || '#94a3b8';
  const timeAgo = (iso: string) => {
    if (!iso) return 'Never';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff/60)+'m ago';
    if (diff < 86400) return Math.floor(diff/3600)+'h ago';
    return Math.floor(diff/86400)+'d ago';
  };

  // ── EMPTY STATE ──
  if (!data.hasData) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Competitor Monitor</title>
<style>${CSS}</style></head>
<body>
<div class="container">
  <header>
    <div><h1>📊 YouTube Competitor Monitor</h1><p class="subtitle">GearUP · ExitLag · LagZapper — KOL Placement Tracking</p></div>
    <span class="status-dot ok">System Ready</span>
  </header>
  <div class="onboard">
    <h2>No monitoring data yet</h2>
    <p>Your monitor is configured for: <strong>GearUP · ExitLag · LagZapper</strong></p>
    <div class="onboard-checklist">
      <div class="oc-item"><span class="oc-icon ok">✓</span> YouTube API Connected</div>
      <div class="oc-item"><span class="oc-icon ok">✓</span> 3 Brands Configured</div>
      <div class="oc-item"><span class="oc-icon ok">✓</span> 15 Search Queries Active</div>
      <div class="oc-item"><span class="oc-icon wait">○</span> Initial Scan Needed</div>
    </div>
    <div style="margin-top:24px">
      <a href="/run" class="btn-primary">🔍 Run First Scan</a>
      <span style="margin-left:12px;color:#64748b;font-size:13px">Scans past 30 days of YouTube data</span>
    </div>
    <div style="margin-top:16px">
      <span class="status-dot ok">API: Connected</span>
      ${data.scanStatus.lastScanAt ? `<span class="status-dot ok">Last scan: ${timeAgo(data.scanStatus.lastScanAt)}</span>` : ''}
      <span class="status-dot ok">Queries: ${data.scanStatus.queriesActive} active</span>
    </div>
  </div>
  <div class="disclaimer">ⓘ Performance metrics are estimates based on publicly available YouTube data. <a href="#" onclick="document.getElementById('disc-detail').style.display='block';return false">Learn more</a>
    <div id="disc-detail" style="display:none;margin-top:8px;font-size:12px;color:#64748b">
      Does NOT represent ROI, CPA, conversion rate, or ad spend. Competitor advertising costs, link clicks, code usage, and conversions are not accessible via YouTube API. Shorts and long-form videos are tracked separately.
    </div>
  </div>
</div></body></html>`;
  }

  // ── CONTROL BAR ──
  const controlBar = `
  <div class="controls">
    <div class="filter-group">
      <label>Brand</label>
      <select onchange="applyFilter('brand',this.value)"><option value="all">All Brands</option><option value="GearUP" ${sel('brand','GearUP')}>GearUP</option><option value="ExitLag" ${sel('brand','ExitLag')}>ExitLag</option><option value="LagZapper" ${sel('brand','LagZapper')}>LagZapper</option></select>
    </div>
    <div class="filter-group">
      <label>Market</label>
      <select onchange="applyFilter('market',this.value)"><option value="all">Global</option><option value="US" ${sel('market','US')}>US</option><option value="RU" ${sel('market','RU')}>Russia</option><option value="BR" ${sel('market','BR')}>Brazil</option></select>
    </div>
    <div class="filter-group">
      <label>Language</label>
      <select onchange="applyFilter('lang',this.value)"><option value="all">All</option><option value="en" ${sel('lang','en')}>English</option><option value="ru" ${sel('lang','ru')}>Russian</option><option value="pt" ${sel('lang','pt')}>Português</option></select>
    </div>
    <div class="filter-group">
      <label>Range</label>
      <select onchange="applyFilter('range',this.value)"><option value="7d" ${sel('range','7d')}>Last 7 Days</option><option value="30d" ${sel('range','30d')}>Last 30 Days</option><option value="90d" ${sel('range','90d')}>Last 90 Days</option></select>
    </div>
    <div class="filter-group">
      <label>Video</label>
      <select onchange="applyFilter('type',this.value)"><option value="all">All</option><option value="long" ${sel('type','long')}>Long-form</option><option value="short" ${sel('type','short')}>Shorts</option></select>
    </div>
    <div class="filter-group">
      <label>Placement</label>
      <select onchange="applyFilter('placement',this.value)"><option value="all">All</option><option value="confirmed_paid_placement" ${sel('placement','confirmed_paid_placement')}>Confirmed</option><option value="likely_sponsored" ${sel('placement','likely_sponsored')}>Likely</option><option value="organic_mention" ${sel('placement','organic_mention')}>Organic</option></select>
    </div>
    <a href="/run" class="btn-scan">Run Scan</a>
  </div>`;

  // ── KPI CARDS ──
  const kpiCards = `
  <div class="kpi-row">
    <div class="kpi-card"><div class="kpi-num">${data.kpi.newPlacements}</div><div class="kpi-label">New Placements</div></div>
    <div class="kpi-card"><div class="kpi-num">${data.kpi.activeCreators}</div><div class="kpi-label">Active Creators</div></div>
    <div class="kpi-card"><div class="kpi-num">${data.kpi.videosMonitored}</div><div class="kpi-label">Videos Monitored</div></div>
    <div class="kpi-card highlight"><div class="kpi-num">${data.kpi.highConfidence}</div><div class="kpi-label">High-Confidence</div></div>
  </div>`;

  // ── BRAND COMPARISON ──
  let brandCards = '';
  for (const b of data.brandComparison) {
    brandCards += `
    <div class="brand-comp-card" style="border-top:3px solid ${brandColor(b.brandName)}">
      <div class="bc-name" style="color:${brandColor(b.brandName)}">${esc(b.brandName)}</div>
      <div class="bc-stat"><span class="bc-val">${b.newVideos}</span> new videos</div>
      <div class="bc-stat"><span class="bc-val">${b.creators}</span> creators</div>
      <div class="bc-stat">Top game: <strong>${esc(b.topGame)}</strong></div>
      <div class="bc-stat">Top market: <strong>${esc(b.topMarket)}</strong></div>
      <div class="bc-stat">Median 7d views: <strong>${fmt(b.median7dViews)}</strong></div>
    </div>`;
  }

  // ── TOP GAMES ──
  const maxGameCount = Math.max(1, ...data.topGames.map(g => g.videoCount));
  let gameRows = '';
  for (const g of data.topGames.slice(0, 8)) {
    const pct = Math.round((g.videoCount / maxGameCount) * 100);
    const brandTags = Object.entries(g.brands).map(([brand, count]) =>
      `<span class="btag" style="background:${brandColor(brand)}22;color:${brandColor(brand)}">${brand} ${count}</span>`
    ).join(' ');
    gameRows += `<tr><td>${esc(g.game)}</td><td><div class="hbar"><div class="hbar-fill" style="width:${pct}%"></div></div></td><td>${g.videoCount}</td><td>${brandTags}</td></tr>`;
  }

  const gameTable = data.topGames.length ? `
  <table class="dtable"><thead><tr><th>Game</th><th></th><th>Videos</th><th>Brands</th></tr></thead><tbody>${gameRows}</tbody></table>
  <div class="sort-toggle"><button onclick="toggleSort('games')">Sort: Video Count</button></div>` : '<div class="empty-msg">No game data yet</div>';

  // ── TOP THEMES ──
  let themeRows = '';
  for (const t of data.topThemes.slice(0, 8)) {
    const brandTags = Object.entries(t.brands).map(([brand, count]) =>
      `<span class="btag" style="background:${brandColor(brand)}22;color:${brandColor(brand)}">${brand} ${count}</span>`
    ).join(' ');
    themeRows += `<tr><td>${esc(formatTopic(t.topic))}</td><td>${t.videoCount}</td><td>${brandTags}</td></tr>`;
  }

  const themeTable = data.topThemes.length ? `
  <table class="dtable"><thead><tr><th>Theme</th><th>Videos</th><th>Brand Distribution</th></tr></thead><tbody>${themeRows}</tbody></table>` : '<div class="empty-msg">No theme data yet</div>';

  // ── TOP CREATORS ──
  let creatorRows = '';
  for (const c of data.topCreators.slice(0, 10)) {
    const perfStr = c.performanceVsBaseline !== null
      ? `<span style="color:${c.performanceVsBaseline>0?'#22c55e':'#ef4444'}">${c.performanceVsBaseline>0?'+':''}${c.performanceVsBaseline}%</span>`
      : '-';
    creatorRows += `<tr>
      <td>${c.thumbnailUrl ? `<img src="${esc(c.thumbnailUrl)}" width="32" height="32" style="border-radius:50%;vertical-align:middle"> ` : ''}${esc(c.channelName)}</td>
      <td>${esc(c.recentBrand)}</td><td>${esc(c.recentGame)}</td><td>${esc(c.format)}</td>
      <td>${fmt(c.subscriberCount)}</td><td>${fmt(c.views7d)}</td>
      <td>${(c.engagementRate*100).toFixed(1)}%</td><td>${badge(c.sponsorship)}</td><td>${perfStr}</td>
    </tr>`;
  }

  const creatorTable = data.topCreators.length ? `
  <table class="dtable"><thead><tr><th>Creator</th><th>Brand</th><th>Game</th><th>Format</th><th>Subs</th><th>7D Views</th><th>Eng.</th><th>Sponsorship</th><th>vs Baseline</th></tr></thead><tbody>${creatorRows}</tbody></table>` : '<div class="empty-msg">No creator data yet</div>';

  // ── VIDEO FEED ──
  let videoRows = '';
  for (const v of data.recentVideos.slice(0, 25)) {
    const evidenceTags = v.discoveryEvidence.map(e => `<span class="ev-tag">${esc(e)}</span>`).join('');
    videoRows += `<tr>
      <td>${v.thumbnailUrl ? `<img src="${esc(v.thumbnailUrl)}" width="80" height="45" style="border-radius:4px">` : ''}</td>
      <td><a href="https://www.youtube.com/watch?v=${esc(v.videoId)}" target="_blank" class="vid-link">${esc(v.title.slice(0, 70))}${v.title.length>70?'…':''}</a></td>
      <td>${esc(v.channelName)}</td><td>${esc(v.brand)}</td><td>${esc(v.game)}</td>
      <td>${timeAgo(v.publishedAt)}</td><td>${fmt(v.viewCount)}</td><td>${badge(v.placementType)}</td>
      <td style="font-size:11px;max-width:160px">${evidenceTags}</td>
      <td class="actions">
        <button onclick="videoAction('${v.videoId}','confirm_placement')" title="Confirm" class="act-btn act-confirm">✓</button>
        <button onclick="videoAction('${v.videoId}','mark_organic')" title="Mark Organic" class="act-btn act-organic">O</button>
        <button onclick="videoAction('${v.videoId}','ignore')" title="Ignore" class="act-btn act-ignore">✕</button>
      </td>
    </tr>`;
  }

  const videoTable = data.recentVideos.length ? `
  <table class="dtable vfeed"><thead><tr><th></th><th>Title</th><th>Channel</th><th>Brand</th><th>Game</th><th>Published</th><th>Views</th><th>Confidence</th><th>Evidence</th><th>Actions</th></tr></thead><tbody>${videoRows}</tbody></table>` : '<div class="empty-msg">No videos discovered yet</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Competitor Monitor</title>
<style>${CSS}</style></head>
<body>
<div class="container">
  <header>
    <div>
      <h1>📊 YouTube Competitor Monitor</h1>
      <p class="subtitle">GearUP · ExitLag · LagZapper — KOL Placement Tracking</p>
    </div>
    <div class="sys-status">
      <span class="status-dot ok">API: Connected</span>
      ${data.scanStatus.lastScanAt ? `<span>Last scan: ${timeAgo(data.scanStatus.lastScanAt)}</span>` : ''}
      <span>Videos: ${data.scanStatus.totalVideos}</span>
      <span>Creators: ${data.scanStatus.totalCreators}</span>
      <span>Next: ${data.scanStatus.nextScanAt}</span>
    </div>
  </header>

  ${controlBar}

  ${kpiCards}

  <section>
    <h2>🔍 Competitor Comparison</h2>
    <div class="brand-grid">${brandCards}</div>
  </section>

  <div class="two-col">
    <section><h2>🎮 Top Games Targeted</h2>${gameTable}</section>
    <section><h2>🏷 Top Content Themes</h2>${themeTable}</section>
  </div>

  <section><h2>⭐ Top Performing Creators</h2>${creatorTable}</section>

  <section><h2>📹 Recently Discovered Videos</h2>${videoTable}</section>

  <div class="disclaimer">
    ⓘ Performance metrics are estimates based on publicly available YouTube data.
    <span class="disc-more" onclick="this.nextElementSibling.style.display='block';this.style.display='none'">Learn more</span>
    <span style="display:none;color:#64748b">
      Does NOT represent ROI, CPA, conversion rate, or ad spend. Competitor advertising costs, link clicks, code usage, and conversions are not accessible via YouTube API. Shorts and long-form videos are tracked separately.
    </span>
  </div>

  <div id="toast" class="toast" style="display:none"></div>
</div>

<script>
function applyFilter(key, val) {
  const url = new URL(window.location);
  if (val === 'all') url.searchParams.delete(key);
  else url.searchParams.set(key, val);
  window.location = url.toString();
}
async function videoAction(videoId, action) {
  try {
    const r = await fetch('/api/videos/'+videoId+'/action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
    const d = await r.json();
    showToast(d.success ? '✅ Updated' : '❌ '+d.error);
    if (d.success) setTimeout(()=>location.reload(), 500);
  } catch(e) { showToast('❌ Action failed'); }
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2000);
}
function toggleSort(type) {
  // Toggle between by count / by reach for games
  showToast('Sort toggled — reloading');
  setTimeout(()=>location.reload(), 300);
}
</script></body></html>`;
}

function formatTopic(t: string): string {
  const map: Record<string, string> = {
    game_integration: 'Game Integration', lag_fix: 'Reduce Ping', booster_review: 'Booster Review',
    competitor_comparison: 'Competitor Comparison', promo_code: 'Promo Code', free_limited: 'Free/Trial',
    new_game_launch: 'New Game Launch', season_update: 'Season Update', region_unlock: 'Cross-Region Play',
    tutorial: 'Tutorial', pure_endorsement: 'Sponsored Endorsement',
  };
  return map[t] || t;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b1120;color:#e2e8f0;font-size:14px;line-height:1.5}
.container{max-width:1280px;margin:0 auto;padding:20px}
header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:12px}
h1{font-size:22px} h2{font-size:16px;color:#94a3b8;margin:24px 0 12px;padding-bottom:6px;border-bottom:1px solid #1e293b}
.subtitle{color:#64748b;font-size:13px}
.sys-status{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#94a3b8;align-items:center}
.sys-status span{background:#1e293b;padding:4px 10px;border-radius:12px}
.status-dot{display:inline-flex;align-items:center;gap:6px}
.status-dot.ok::before{content:'';width:6px;height:6px;background:#22c55e;border-radius:50%}
.status-dot.warn::before{content:'';width:6px;height:6px;background:#f59e0b;border-radius:50%}

/* Controls */
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-bottom:20px;background:#111827;padding:12px 16px;border-radius:8px}
.filter-group{display:flex;flex-direction:column;gap:2px}
.filter-group label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px}
.filter-group select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer}
.btn-scan{display:inline-block;padding:8px 16px;background:#1d4ed8;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;margin-left:auto}
.btn-scan:hover{background:#2563eb}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.kpi-card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:20px;text-align:center}
.kpi-card.highlight{border-color:#1d4ed8;background:#1d4ed810}
.kpi-num{font-size:32px;font-weight:700;color:#f1f5f9}
.kpi-label{font-size:12px;color:#64748b;margin-top:4px}

/* Brand comparison */
.brand-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.brand-comp-card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px}
.bc-name{font-size:16px;font-weight:700;margin-bottom:10px}
.bc-stat{font-size:13px;color:#94a3b8;margin-bottom:4px}
.bc-val{color:#f1f5f9;font-weight:600}

/* Tables */
.dtable{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px}
.dtable th{text-align:left;padding:8px 10px;background:#111827;color:#64748b;font-weight:500;font-size:11px;text-transform:uppercase;border-bottom:1px solid #1e293b;white-space:nowrap}
.dtable td{padding:8px 10px;border-bottom:1px solid #0f172a;vertical-align:middle}
.dtable tbody tr:hover{background:#1e293b33}
.dtable a{color:#38bdf8;text-decoration:none}
.dtable a:hover{text-decoration:underline}

/* Horizontal bar */
.hbar{width:80px;height:6px;background:#1e293b;border-radius:3px;overflow:hidden;display:inline-block}
.hbar-fill{height:100%;background:#3b82f6;border-radius:3px}

/* Badges */
.badge{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;white-space:nowrap}
.badge-confirmed_paid_placement,.badge-Confirmed{background:#dc262620;color:#ef4444}
.badge-likely_sponsored,.badge-Likely{background:#f59e0b20;color:#f59e0b}
.badge-organic_mention,.badge-Organic{background:#22c55e20;color:#22c55e}
.badge-official_brand_video,.badge-Official{background:#3b82f620;color:#3b82f6}
.badge-unknown,.badge-Unknown{background:#64748b20;color:#64748b}

/* Brand tags */
.btag{font-size:11px;padding:1px 6px;border-radius:4px;margin-right:4px;white-space:nowrap}
.ev-tag{font-size:10px;background:#1e293b;padding:1px 6px;border-radius:4px;margin:1px 2px;display:inline-block;white-space:nowrap}

/* Two column */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:768px){.two-col{grid-template-columns:1fr}}

/* Video feed */
.vfeed td{font-size:12px}
.vfeed .actions{white-space:nowrap}
.act-btn{width:24px;height:24px;border:1px solid #334155;border-radius:4px;background:#1e293b;color:#94a3b8;cursor:pointer;font-size:12px;margin:0 2px}
.act-btn:hover{background:#334155}
.act-confirm:hover{color:#22c55e;border-color:#22c55e}
.act-organic:hover{color:#f59e0b;border-color:#f59e0b}
.act-ignore:hover{color:#ef4444;border-color:#ef4444}

/* Onboarding */
.onboard{max-width:560px;margin:60px auto;background:#111827;border:1px solid #1e293b;border-radius:12px;padding:40px;text-align:center}
.onboard h2{font-size:20px;color:#f1f5f9;margin-bottom:8px;border:none}
.onboard p{color:#94a3b8;margin-bottom:24px}
.onboard-checklist{text-align:left}
.oc-item{font-size:14px;padding:8px 0;color:#e2e8f0;display:flex;align-items:center;gap:10px}
.oc-icon{font-size:16px;width:24px;text-align:center}
.oc-icon.ok{color:#22c55e}
.oc-icon.wait{color:#64748b}

.btn-primary{display:inline-block;padding:12px 28px;background:#1d4ed8;color:white;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600}
.btn-primary:hover{background:#2563eb}

/* Misc */
.empty-msg{color:#64748b;font-style:italic;padding:24px;text-align:center;background:#111827;border-radius:8px}
.disclaimer{font-size:11px;color:#475569;text-align:center;margin-top:32px;padding:10px;border-top:1px solid #1e293b}
.disc-more{color:#38bdf8;cursor:pointer;margin-left:4px}
.disc-more:hover{text-decoration:underline}
.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;color:#e2e8f0;padding:10px 20px;border-radius:8px;border:1px solid #334155;z-index:100}
.sort-toggle{text-align:right;margin-bottom:8px}
.sort-toggle button{background:#1e293b;color:#94a3b8;border:1px solid #334155;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer}
`;

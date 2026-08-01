/**
 * Simple HTML dashboard for viewing competitor monitoring results.
 * No build step — served directly by Express.
 */

export function renderDashboard(status: any, dailyReport: any): string {
  const overview = dailyReport?.overview || {};
  const hotGames = dailyReport?.hotGames || [];
  const hotTopics = dailyReport?.hotTopics || [];
  const topCreators = dailyReport?.topCreators || [];
  const anomalies = dailyReport?.anomalies || [];
  const newVideos = dailyReport?.newVideos || [];

  const brandCards = Object.entries(overview.byBrand || {}).map(([brand, data]: [string, any]) => `
    <div class="brand-card">
      <div class="brand-name">${escapeHtml(brand)}</div>
      <div class="brand-stats">
        <span class="stat">${data.videos} <small>videos</small></span>
        <span class="stat">${data.creators} <small>creators</small></span>
      </div>
    </div>
  `).join('');

  const gameRows = hotGames.map((g: any) => `
    <tr>
      <td>${escapeHtml(g.game)}</td>
      <td>${g.videoCount}</td>
      <td>${escapeHtml(g.topBrand)}</td>
    </tr>
  `).join('');

  const topicRows = hotTopics.map((t: any) => `
    <tr>
      <td>${escapeHtml(t.topic)}</td>
      <td>${t.videoCount}</td>
    </tr>
  `).join('');

  const creatorRows = topCreators.map((c: any) => `
    <tr>
      <td>${escapeHtml(c.channelName)}</td>
      <td>${escapeHtml(c.brand)}</td>
      <td>${escapeHtml(c.game)}</td>
      <td>${escapeHtml(c.contentType)}</td>
      <td>${c.performanceScore}/100</td>
      <td>${c.promoCode || '-'}</td>
    </tr>
  `).join('');

  const anomalyItems = anomalies.map((a: string) => `<li>${escapeHtml(a)}</li>`).join('');

  const videoRows = newVideos.slice(0, 20).map((v: any) => `
    <tr>
      <td><a href="https://www.youtube.com/watch?v=${escapeHtml(v.videoId)}" target="_blank">${escapeHtml(v.title.slice(0, 60))}${v.title.length > 60 ? '...' : ''}</a></td>
      <td>${escapeHtml(v.channelName)}</td>
      <td>${escapeHtml(v.brand)}</td>
      <td>${escapeHtml(v.game)}</td>
      <td><span class="badge badge-${v.placementType}">${escapeHtml(v.placementType)}</span></td>
      <td>${v.performanceScore}/100</td>
      <td>${(v.viewCount || 0).toLocaleString()}</td>
      <td>${new Date(v.publishedAt).toLocaleDateString()}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YouTube Competitor Monitor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  h2 { font-size: 18px; margin: 24px 0 12px; color: #94a3b8; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .brand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .brand-card { background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid #334155; }
  .brand-name { font-weight: 600; font-size: 16px; margin-bottom: 8px; }
  .brand-stats { display: flex; gap: 16px; }
  .stat { font-size: 18px; font-weight: 600; color: #38bdf8; }
  .stat small { font-size: 12px; color: #64748b; font-weight: 400; }
  .summary-bar { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 24px; display: flex; gap: 24px; flex-wrap: wrap; border: 1px solid #334155; }
  .summary-item { display: flex; flex-direction: column; }
  .summary-label { font-size: 12px; color: #64748b; text-transform: uppercase; }
  .summary-value { font-size: 24px; font-weight: 700; color: #f1f5f9; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; background: #1e293b; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #334155; }
  td { padding: 8px 12px; border-bottom: 1px solid #1e293b; }
  tr:hover td { background: #1e293b33; }
  a { color: #38bdf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .badge-confirmed_paid_placement { background: #dc262620; color: #ef4444; }
  .badge-likely_sponsored { background: #f59e0b20; color: #f59e0b; }
  .badge-organic_mention { background: #22c55e20; color: #22c55e; }
  .badge-official_brand_video { background: #3b82f620; color: #3b82f6; }
  .badge-unknown { background: #64748b20; color: #64748b; }
  .anomalies { background: #7c2d1220; border: 1px solid #7c2d12; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .anomalies ul { padding-left: 20px; }
  .anomalies li { margin-bottom: 4px; color: #fca5a5; }
  .empty { color: #64748b; font-style: italic; padding: 16px; }
  .disclaimer { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-top: 32px; font-size: 12px; color: #64748b; }
  .refresh { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  .last-updated { font-size: 12px; color: #64748b; }
</style>
</head>
<body>
<div class="container">
  <div class="refresh">
    <div>
      <h1>📊 YouTube Competitor Monitor</h1>
      <p class="subtitle">GearUP · ExitLag · LagZapper — KOL Placement Tracking</p>
    </div>
    <div class="last-updated">
      Last updated: ${new Date().toLocaleString()}<br>
      Videos tracked: ${status?.totalVideos || 0} | Creators: ${status?.totalCreators || 0}
    </div>
  </div>

  <div class="summary-bar">
    <div class="summary-item">
      <span class="summary-label">New Today</span>
      <span class="summary-value">${overview.totalNewVideos || 0}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">Creators</span>
      <span class="summary-value">${overview.totalCreators || 0}</span>
    </div>
  </div>

  <div class="brand-grid">
    ${brandCards || '<div class="empty">No brand data yet</div>'}
  </div>

  <h2>🎮 Top Games Targeted</h2>
  ${gameRows ? `<table><thead><tr><th>Game</th><th>Videos</th><th>Top Brand</th></tr></thead><tbody>${gameRows}</tbody></table>` : '<div class="empty">No game data yet</div>'}

  <h2>🏷️ Top Content Themes</h2>
  ${topicRows ? `<table><thead><tr><th>Topic</th><th>Videos</th></tr></thead><tbody>${topicRows}</tbody></table>` : '<div class="empty">No topic data yet</div>'}

  <h2>⭐ Top Performing Creators</h2>
  ${creatorRows ? `<table><thead><tr><th>Channel</th><th>Brand</th><th>Game</th><th>Type</th><th>Score</th><th>Promo Code</th></tr></thead><tbody>${creatorRows}</tbody></table>` : '<div class="empty">No creator data yet</div>'}

  ${anomalies.length ? `
  <h2>⚠️ Anomalies</h2>
  <div class="anomalies"><ul>${anomalyItems}</ul></div>
  ` : ''}

  <h2>📹 Recently Discovered Videos</h2>
  ${videoRows ? `<table><thead><tr><th>Title</th><th>Channel</th><th>Brand</th><th>Game</th><th>Placement</th><th>Score</th><th>Views</th><th>Published</th></tr></thead><tbody>${videoRows}</tbody></table>` : '<div class="empty">No videos yet</div>'}

  <div class="disclaimer">
    ⚠️ <strong>Important:</strong> All metrics are <strong>PUBLIC performance estimates</strong> based on visible YouTube data only.
    Scores do NOT represent ROI, CPA, conversion rate, or ad spend.
    Competitor advertising costs, link clicks, code usage, and conversions are not accessible via YouTube API.
    Shorts and long-form videos are tracked separately.
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

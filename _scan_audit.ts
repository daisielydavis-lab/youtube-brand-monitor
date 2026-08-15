import { getSupabase } from './src/db/supabase';
(async () => {
  const db = getSupabase();
  // 1. scan logs
  const { data: logs } = await db.from('scan_logs').select('*').order('created_at', { ascending: false }).limit(5);
  console.log('── scan_logs ──');
  for (const l of logs || []) console.log(' ', l.created_at, '|', l.mode || l.type, '|', l.discovered || l.result || JSON.stringify(l).slice(0, 120));
  // 2. duplicates in last 24h
  const since = new Date(Date.now() - 1 * 86400000).toISOString();
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('youtube_competitor_videos').select('video_id,title,first_seen_at,comment_count,workflow_status').gte('first_seen_at', since).range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  const ids = all.map(v => v.video_id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`\n── last 24h: ${all.length} videos, duplicates: ${dupes.length} ──`);
  // 3. comment fetch status
  const withComments = all.filter(v => v.comment_count && v.comment_count > 0).length;
  console.log('videos with comment_count>0:', withComments);
  process.exit(0);
})();

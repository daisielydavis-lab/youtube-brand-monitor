-- ============================================================
-- Performance Refresh (T+3 / T+7) — 2026-08-15
-- AI Review 与 Performance Refresh 解耦：
--   AI Review 队列 = 判断"投了什么"（T+0 当天，DeepSeek）
--   Performance Refresh = 刷新"表现怎么样"（T+3/T+7，只调 YouTube API）
-- 执行：Supabase → SQL Editor → 粘贴运行（幂等，可重复跑）
-- ============================================================

-- 1. videos 表加效果快照列（view_count/like_count/comment_count = T+0 数据，不加列）
alter table public.youtube_competitor_videos
  add column if not exists views_t3 bigint,
  add column if not exists likes_t3 bigint,
  add column if not exists comments_t3 bigint,
  add column if not exists views_t7 bigint,
  add column if not exists likes_t7 bigint,
  add column if not exists comments_t7 bigint,
  add column if not exists performance_stage text default 't0',
  add column if not exists performance_updated_at timestamptz;

-- 2. 历史回填：按发布时间分类（90天历史中大部分已成熟）
-- >7 天 → mature（当前统计即成熟快照，不进刷新队列）
update public.youtube_competitor_videos
  set performance_stage = 'mature'
  where performance_stage = 't0'
    and published_at < now() - interval '7 days';

-- 4-7 天 → t3（当前值作为 T+3 快照），排 T+7 刷新
update public.youtube_competitor_videos
  set performance_stage = 't3',
      views_t3 = view_count,
      likes_t3 = like_count,
      comments_t3 = comment_count,
      performance_updated_at = now()
  where performance_stage = 't0'
    and published_at >= now() - interval '7 days'
    and published_at <= now() - interval '3 days';

-- ≤3 天 → t0（等 T+3 到期刷新，默认值已覆盖）

-- 3. 索引：刷新队列查询
create index if not exists idx_videos_perf_refresh
  on public.youtube_competitor_videos (performance_stage, published_at);

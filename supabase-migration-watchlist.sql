-- ============================================================
-- Migration: Creator Watchlist（用户 P0-2/P0-3，2026-08-16）
-- 在 Supabase SQL Editor 运行一次。
--
-- 原则：Search 只负责发现新博主；已确认投放的 Creator 自动进入
-- Watchlist；Watchlist 用 playlistItems.list 扫 uploads playlist
-- 监控已知博主（1 unit/页，不占 Search 池）。
-- ============================================================

create table if not exists public.youtube_creator_watchlist (
  brand text not null,              -- GearUP / ExitLag / LagZapper
  channel_id text not null,
  channel_name text,
  market text,                      -- 投放市场信号（RU / US / ...）
  uploads_playlist_id text,         -- 缓存，避免每次 channels.list
  discovered_via text,              -- ai_confirmed / manual_seed / channel_scan
  confirmed_placements int not null default 0,
  status text not null default 'active',  -- active / paused
  first_seen_at timestamptz not null default now(),
  last_scan_at timestamptz,
  last_video_at timestamptz,        -- 频道最近上传时间（扫描时更新）
  primary key (brand, channel_id)
);

create index if not exists idx_watchlist_brand on public.youtube_creator_watchlist(brand);
create index if not exists idx_watchlist_status on public.youtube_creator_watchlist(status);

-- 种子：LagZapper 已知合作博主（2026-08-16 从库内 AI 确认投放 + description 含词识别）
-- channel_id 待确认后补充（或由系统 ai_confirmed 自动写入）
-- 已识别频道名：Stormyrite / MavericK Bro / ry6ka Play / keking / WoNWOnK /
--               GamePunk / vaughnfn / iLevvvy / August Station

-- 回填：现有 Layer 3 竞品投放的博主自动进 Watchlist（一次性的 SQL 侧种子）
insert into public.youtube_creator_watchlist (brand, channel_id, channel_name, market, discovered_via)
select
  (classification_raw->'ai'->>'brand') as brand,
  channel_id,
  channel_name,
  market,
  'ai_confirmed'
from public.youtube_competitor_videos
where placement_type in ('confirmed_paid_placement', 'likely_sponsored')
  and classification_raw->'ai'->>'brand' is not null
  and classification_raw->'ai'->>'brand' <> 'null'
on conflict (brand, channel_id) do nothing;

-- 同品牌同一 channel 多品牌投放去重保护（seed 只保留确认过的品牌）
delete from public.youtube_creator_watchlist w
where exists (
  select 1 from public.youtube_competitor_videos v
  where v.channel_id = w.channel_id
    and v.placement_type in ('confirmed_paid_placement', 'likely_sponsored')
    and coalesce(v.classification_raw->'ai'->>'brand', '') <> w.brand
    and coalesce(v.classification_raw->'ai'->>'brand', '') <> ''
);

-- ============================================================
-- recall_benchmark：人工确认投放样本（Ground Truth）
-- /api/discovery-coverage 用它算 Recall（用户 P0-4）
-- miss_reason（用户 2026-08-16 验收点）：漏抓原因标注，指导 P1 优先级
--   search_not_returned       Search 没返回这条视频
--   unknown_creator           博主完全没见过
--   creator_not_in_watchlist  见过但没进 Watchlist（漏了监控）
--   query_language_gap        query 语言/市场不覆盖（如俄语投放 vs 英文 query）
--   pagination_gap            分页/时间片截断
--   classification_false_negative 抓到了但 AI/规则误判为非投放
--   deleted_private           视频已删除/私密（天然漏失，不追责）
--   other
-- ============================================================
create table if not exists public.recall_benchmark (
  video_id text primary key,
  brand text not null,
  market text,
  expected boolean not null default true,   -- true=应被系统抓到；false=已知非投放（反例）
  miss_reason text,                         -- 人工/自动标注的漏抓原因（见上枚举）
  note text,
  added_by text default 'manual',
  added_at timestamptz not null default now()
);
create index if not exists idx_benchmark_brand on public.recall_benchmark(brand);

-- ============================================================
-- backfill_windows：90 天历史回填断点状态（用户 2026-08-16 验收点）
-- 每个 query × 7 天窗口一行；第二天续跑只处理未完成窗口，
-- 绝不清库重扫 90 天。
--   status: pending / running / completed / partial / quota_paused / failed
-- ============================================================
create table if not exists public.backfill_windows (
  id uuid primary key default gen_random_uuid(),
  query_text text not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  status text not null default 'pending',
  videos_found int not null default 0,
  search_calls int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (query_text, window_from, window_to)
);
create index if not exists idx_backfill_status on public.backfill_windows(status);
create index if not exists idx_backfill_query on public.backfill_windows(query_text);

-- watchlist 补索引：channel_id 单独索引（频道维度查询）
create index if not exists idx_watchlist_channel on public.youtube_creator_watchlist(channel_id);

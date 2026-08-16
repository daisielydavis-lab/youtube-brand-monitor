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
-- ============================================================
create table if not exists public.recall_benchmark (
  video_id text primary key,
  brand text not null,
  market text,
  expected boolean not null default true,   -- true=应被系统抓到；false=已知非投放（反例）
  note text,
  added_by text default 'manual',
  added_at timestamptz not null default now()
);

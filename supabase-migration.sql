-- ============================================================
-- YouTube Competitor Placement Monitor — Database Schema
-- 竞品 YouTube KOL 投放监控
-- ============================================================

-- 1. 竞品品牌
create table if not exists public.competitor_brands (
  id uuid primary key default gen_random_uuid(),
  brand_name text not null unique,                  -- GearUP / ExitLag / LagZapper
  display_name text not null,                       -- 显示名称
  website_domain text,                              -- exitlag.com
  category text not null default 'game_booster',    -- game_booster / vpn / gaming_tool
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. 搜索查询词（每个品牌多组关键词）
create table if not exists public.competitor_queries (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.competitor_brands(id) on delete cascade,
  query_text text not null,                         -- "GearUP Booster"
  query_type text not null default 'branded',       -- branded / review / promo / sponsored / comparison
  target_language text not null default 'en',       -- en / ru / pt
  target_market text not null default 'US',         -- US / RU / BR
  is_active boolean not null default true,
  last_run_at timestamptz,                          -- 上次搜索时间
  created_at timestamptz not null default now()
);

-- 3. YouTube 博主画像
create table if not exists public.youtube_creator_profiles (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null unique,                  -- YouTube Channel ID
  channel_name text not null,
  channel_url text not null,
  description text,
  subscriber_count bigint default 0,
  total_views bigint default 0,
  video_count int default 0,
  thumbnail_url text,
  country text,                                     -- 从标题/描述/简介推断
  primary_language text,                            -- en / ru / pt
  primary_games text[],                             -- 主要游戏（数组）
  past_brand_mentions jsonb default '{}',           -- {"GearUP": 5, "ExitLag": 2}
  has_promo_code_history boolean default false,
  promo_codes_used text[],                          -- 历史优惠码
  avg_views_recent int,                             -- 近期平均播放量（最近10条）
  collaboration_brands text[],                      -- 合作过的品牌列表
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. 竞品相关视频
create table if not exists public.youtube_competitor_videos (
  id uuid primary key default gen_random_uuid(),
  video_id text not null unique,                    -- YouTube Video ID
  brand_id uuid not null references public.competitor_brands(id) on delete cascade,
  channel_id text not null,                         -- denormalized for query speed
  channel_name text not null,

  -- Video metadata
  title text not null,
  description text,
  published_at timestamptz not null,
  duration text,                                    -- ISO 8601 duration
  is_short boolean not null default false,          -- Shorts vs long-form
  thumbnail_url text,
  tags text[],
  language text,                                    -- en / ru / pt
  market text,                                      -- US / RU / BR
  category_id text,                                 -- YouTube category ID

  -- Discovery metadata
  discovery_query_id uuid references public.competitor_queries(id),
  discovery_method text not null default 'keyword_search',  -- keyword_search / paid_placement_tag / channel_scan
  has_paid_placement_tag boolean default false,    -- videoPaidProductPlacement=true

  -- AI Classification (DeepSeek/Gemini)
  game_name text,                                   -- Valorant / AION 2
  content_type text,                                -- dedicated_review / integrated_placement / comparison / tutorial / shorts / live_replay
  placement_type text not null default 'unknown',   -- confirmed_paid_placement / likely_sponsored / organic_mention / official_brand_video / unknown
  sponsor_confidence numeric(3,2),                  -- 0.00 - 1.00
  brand_mention_position text[],                    -- title / description / video_body / pinned_comment
  topic_category text,                              -- game_integration / lag_fix / booster_review / competitor_comparison / promo_code / free_limited / new_game_launch / season_update / region_unlock / tutorial / pure_endorsement / shorts / live_replay

  -- Extracted data
  promo_code text,                                  -- CREATOR20
  landing_domain text,                              -- exitlag.com
  cta_type text,                                    -- download / free_trial / promo_code / website_visit
  product_selling_points text[],                    -- 低延迟 / 解锁区域 / 降丢包 / 免费使用

  -- Public metrics (discovery snapshot)
  view_count bigint default 0,
  like_count bigint default 0,
  comment_count bigint default 0,

  -- Performance
  public_performance_score int,                     -- 0-100
  classification_raw jsonb,                         -- Full AI response for audit

  first_seen_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Index for common queries
create index if not exists idx_videos_brand on public.youtube_competitor_videos(brand_id);
create index if not exists idx_videos_published on public.youtube_competitor_videos(published_at desc);
create index if not exists idx_videos_channel on public.youtube_competitor_videos(channel_id);
create index if not exists idx_videos_placement on public.youtube_competitor_videos(placement_type);
create index if not exists idx_videos_game on public.youtube_competitor_videos(game_name);
create index if not exists idx_videos_is_short on public.youtube_competitor_videos(is_short);

-- 5. 视频指标快照（时间序列）
create table if not exists public.youtube_video_snapshots (
  id uuid primary key default gen_random_uuid(),
  video_id text not null references public.youtube_competitor_videos(video_id) on delete cascade,
  snapshot_type text not null,                      -- discovery / 24h / 72h / 7d / 30d
  hours_since_publish int not null,                 -- 发布时间到快照时间的小时数

  -- Metrics at snapshot time
  view_count bigint default 0,
  like_count bigint default 0,
  comment_count bigint default 0,

  -- Computed metrics
  view_velocity numeric(10,2),                      -- 播放增速 = 新增播放量 ÷ 间隔小时数
  engagement_rate numeric(5,4),                     -- 互动率 = (点赞+评论) / 播放量
  view_subscriber_ratio numeric(5,2),               -- 播放/订阅比
  purchase_intent_comment_rate numeric(5,4),        -- 品牌意图评论率
  public_performance_score int,                     -- 0-100 at this snapshot

  snapshot_data jsonb,                              -- Full metrics payload

  captured_at timestamptz not null default now()
);

create index if not exists idx_snapshots_video on public.youtube_video_snapshots(video_id);
create index if not exists idx_snapshots_type on public.youtube_video_snapshots(snapshot_type);
create index if not exists idx_snapshots_captured on public.youtube_video_snapshots(captured_at desc);

-- 6. 评论分析
create table if not exists public.youtube_comment_insights (
  id uuid primary key default gen_random_uuid(),
  video_id text not null references public.youtube_competitor_videos(video_id) on delete cascade,
  comment_id text not null unique,                  -- YouTube Comment ID
  comment_text text not null,
  author_name text,
  like_count int default 0,
  published_at timestamptz,
  reply_count int default 0,

  -- AI Classification
  has_purchase_intent boolean default false,        -- 下载/价格/优惠码/是否有效
  is_brand_related boolean default false,           -- 提及品牌
  sentiment text,                                   -- positive / neutral / negative
  comment_category text,                            -- question / feedback / complaint / praise / spam

  classification_raw jsonb,

  created_at timestamptz not null default now()
);

create index if not exists idx_comments_video on public.youtube_comment_insights(video_id);
create index if not exists idx_comments_intent on public.youtube_comment_insights(has_purchase_intent);
create index if not exists idx_comments_brand on public.youtube_comment_insights(is_brand_related);

-- 7. 日报/周报缓存
create table if not exists public.competitor_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,                        -- daily / weekly
  report_period_start date not null,
  report_period_end date not null,
  report_data jsonb not null,                       -- Full report JSON
  summary_text text,                                -- AI-generated summary
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_period on public.competitor_reports(report_period_start desc);

-- ============================================================
-- Seed data: 3 brands
-- ============================================================
insert into public.competitor_brands (brand_name, display_name, website_domain, category) values
  ('GearUP', 'GearUP Booster', 'gearupbooster.com', 'game_booster'),
  ('ExitLag', 'ExitLag', 'exitlag.com', 'game_booster'),
  ('LagZapper', 'LagZapper', 'lagzapper.com', 'game_booster')
on conflict (brand_name) do nothing;

-- ============================================================
-- Seed data: search queries (English only for first version)
-- ============================================================
do $$
declare
  gearup_id uuid;
  exitlag_id uuid;
  lagzapper_id uuid;
begin
  select id into gearup_id from public.competitor_brands where brand_name = 'GearUP';
  select id into exitlag_id from public.competitor_brands where brand_name = 'ExitLag';
  select id into lagzapper_id from public.competitor_brands where brand_name = 'LagZapper';

  -- GearUP queries
  insert into public.competitor_queries (brand_id, query_text, query_type, target_language, target_market) values
    (gearup_id, 'GearUP Booster', 'branded', 'en', 'US'),
    (gearup_id, 'GearUP game booster', 'branded', 'en', 'US'),
    (gearup_id, 'GearUP lag', 'branded', 'en', 'US'),
    (gearup_id, 'GearUP promo code', 'promo', 'en', 'US'),
    (gearup_id, 'GearUP review', 'review', 'en', 'US'),
    (gearup_id, 'GearUP sponsored', 'sponsored', 'en', 'US')
  on conflict do nothing;

  -- ExitLag queries
  insert into public.competitor_queries (brand_id, query_text, query_type, target_language, target_market) values
    (exitlag_id, 'ExitLag', 'branded', 'en', 'US'),
    (exitlag_id, 'ExitLag review', 'review', 'en', 'US'),
    (exitlag_id, 'ExitLag promo code', 'promo', 'en', 'US'),
    (exitlag_id, 'ExitLag sponsored', 'sponsored', 'en', 'US'),
    (exitlag_id, 'ExitLag Valorant', 'branded', 'en', 'US')
  on conflict do nothing;

  -- LagZapper queries
  insert into public.competitor_queries (brand_id, query_text, query_type, target_language, target_market) values
    (lagzapper_id, 'LagZapper', 'branded', 'en', 'US'),
    (lagzapper_id, 'Lag Zapper', 'branded', 'en', 'US'),
    (lagzapper_id, 'LagZapper free', 'promo', 'en', 'US'),
    (lagzapper_id, 'LagZapper review', 'review', 'en', 'US')
  on conflict do nothing;
end $$;

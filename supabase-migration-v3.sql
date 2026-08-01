-- ============================================================
-- YouTube Competitor Monitor v3 — Schema Upgrade
-- ============================================================

-- 1. Scan logs — every pipeline run recorded
create table if not exists public.scan_logs (
  id uuid primary key default gen_random_uuid(),
  scan_mode text not null check (scan_mode in ('normal','hotspot','manual')),
  queries_attempted int default 0,
  queries_succeeded int default 0,
  search_quota_used int default 0,
  general_quota_used int default 0,
  videos_found int default 0,
  videos_new int default 0,
  videos_classified int default 0,
  errors text[],
  quota_exhausted boolean default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_logs_mode on public.scan_logs(scan_mode);
create index if not exists idx_scan_logs_created on public.scan_logs(created_at desc);

-- 2. Campaigns — grouped placements
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  game text not null,
  detected_at timestamptz not null default now(),
  active_from date,
  active_to date,
  video_count int default 0,
  creator_count int default 0,
  primary_selling_point text,
  primary_market text,
  primary_language text,
  landing_domain text,
  total_estimated_views bigint default 0,
  avg_performance_score numeric(5,1),
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_campaigns_brand on public.campaigns(brand);
create index if not exists idx_campaigns_game on public.campaigns(game);
create index if not exists idx_campaigns_status on public.campaigns(status);

-- 3. Monitor config — single-row settings
create table if not exists public.monitor_config (
  id int primary key default 1 check (id = 1),
  normal_mode_enabled boolean default true,
  hotspot_active boolean default false,
  hotspot_games text[] default '{}',
  hotspot_brands text[] default '{}',
  hotspot_active_until timestamptz,
  hotspot_started_at timestamptz,
  search_budget_normal int default 10,
  search_budget_hotspot int default 40,
  search_budget_manual int default 20,
  search_stop_threshold int default 70,
  hotspot_stop_threshold int default 80,
  total_stop_threshold int default 90,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed default config
insert into public.monitor_config (id) values (1) on conflict (id) do nothing;

-- 4. New columns: youtube_competitor_videos
alter table public.youtube_competitor_videos
  add column if not exists workflow_status text not null default 'classified'
    check (workflow_status in ('discovered','enriched','classified','needs_review','confirmed','tracking','comment_analyzed','reported')),
  add column if not exists baseline_lift numeric(5,2),
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null,
  add column if not exists market_confidence int default 0 check (market_confidence between 0 and 100),
  add column if not exists market_evidence text[] default '{}';

create index if not exists idx_videos_wf_status on public.youtube_competitor_videos(workflow_status);
create index if not exists idx_videos_campaign on public.youtube_competitor_videos(campaign_id);

-- 5. New columns: youtube_creator_profiles
alter table public.youtube_creator_profiles
  add column if not exists creator_size text
    check (creator_size in ('nano','micro','mid_tier','macro','mega')),
  add column if not exists content_type text
    check (content_type in ('single_game','variety_gaming','fps_mmo','guides','tech_hardware','deals_codes','streamer','shorts_creator','news')),
  add column if not exists relationship_status text
    check (relationship_status in ('first_time','repeat','switched_brand','multi_brand','brand_ambassador')),
  add column if not exists baseline_views_median int default 0,
  add column if not exists baseline_engagement_median numeric(5,4) default 0;

-- 6. Updated queries with OR operators (seed data refresh)
-- Delete old individual queries and replace with combined OR queries
delete from public.competitor_queries;

do $$
declare
  g_id uuid; e_id uuid; l_id uuid;
begin
  select id into g_id from public.competitor_brands where brand_name = 'GearUP';
  select id into e_id from public.competitor_brands where brand_name = 'ExitLag';
  select id into l_id from public.competitor_brands where brand_name = 'LagZapper';

  -- Combined brand queries (6 searches/day for normal mode)
  insert into public.competitor_queries (brand_id, query_text, query_type, target_language, target_market) values
    -- Brand discovery (3 queries, combined with OR)
    (g_id, 'GearUP | GearUP Booster', 'branded', 'en', 'US'),
    (e_id, 'ExitLag', 'branded', 'en', 'US'),
    (l_id, 'LagZapper | Lag Zapper', 'branded', 'en', 'US'),
    -- Sponsored/review detection (3 queries)
    (g_id, 'GearUP sponsored | GearUP review | GearUP promo code', 'sponsored', 'en', 'US'),
    (e_id, 'ExitLag sponsored | ExitLag review | ExitLag promo code', 'sponsored', 'en', 'US'),
    (l_id, 'LagZapper review | LagZapper free | LagZapper promo code', 'sponsored', 'en', 'US')
  on conflict do nothing;
end $$;

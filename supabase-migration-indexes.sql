-- Dashboard performance indexes (v2 — updated for final→rule→ai brand path)
-- Run in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/cnzctiicglcgccszeuxb

-- Primary time-range filter (most critical)
create index if not exists idx_videos_published_at on public.youtube_competitor_videos (published_at desc);

-- Status + time (for coverage / classification queries)
create index if not exists idx_videos_status_published on public.youtube_competitor_videos (workflow_status, published_at desc);

-- Rule brand classification (new path — replaces old sponsorship.detectedBrand)
create index if not exists idx_videos_rule_brand on public.youtube_competitor_videos ((classification_raw->'rule'->>'brand'), published_at desc);

-- Placement type filter (dashboard filters + campaign detection)
create index if not exists idx_videos_placement on public.youtube_competitor_videos (placement_type, published_at desc);

-- Creator lookup (videos per channel)
create index if not exists idx_videos_channel_published on public.youtube_competitor_videos (channel_id, published_at desc);

-- Campaign grouping (unassigned confirmed/likely videos)
create index if not exists idx_videos_campaign_null on public.youtube_competitor_videos (campaign_id, published_at desc) where campaign_id is null;

-- First_seen_at for new creator detection
create index if not exists idx_videos_first_seen on public.youtube_competitor_videos (first_seen_at);

-- Drop obsolete index (old brand path that no longer exists)
drop index if exists idx_videos_brand_published;

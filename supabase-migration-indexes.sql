-- Dashboard performance indexes
create index if not exists idx_videos_published_at on public.youtube_competitor_videos (published_at desc);
create index if not exists idx_videos_status_published on public.youtube_competitor_videos (workflow_status, published_at desc);
create index if not exists idx_videos_brand_published on public.youtube_competitor_videos ((classification_raw->'sponsorship'->>'detectedBrand'), published_at desc);
create index if not exists idx_videos_placement on public.youtube_competitor_videos (placement_type, published_at desc);

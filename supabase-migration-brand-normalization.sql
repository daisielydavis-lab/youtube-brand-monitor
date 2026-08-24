-- ============================================================
-- Migration: Brand normalization (P0-1) — 2026-08-23
-- youtube_competitor_videos 加 canonical_brand / raw_brand / brand_confidence。
--
-- 执行顺序:
--   1. 在 Supabase SQL Editor 跑本文件(幂等,可重复跑)
--   2. CLI 对账:      npm run normalize-brands            (dry-run,不写库)
--   3. CLI 回填:      npm run normalize-brands -- --write
--
-- canonical_brand = 归一化品牌('GearUP'/'ExitLag'/'LagZapper'/NULL),
-- 让统计从"解析 classification_raw JSON"变成直接 SQL 列:
--   WHERE canonical_brand = 'GearUP' AND placement_type IN ('confirmed_paid_placement','likely_sponsored')
-- ============================================================

alter table public.youtube_competitor_videos
  add column if not exists raw_brand text,               -- AI/规则原始输出,如 'GearUp Booster'
  add column if not exists canonical_brand text,         -- 'GearUP' / 'ExitLag' / 'LagZapper' / NULL
  add column if not exists brand_confidence numeric(3,2); -- 0-1,主品牌置信度

-- 主品牌维度计数(替代 classification_raw->'ai'->>'brand' 表达式索引)
create index if not exists idx_videos_canonical_brand
  on public.youtube_competitor_videos (canonical_brand, published_at desc);

-- 排查用:原始 brand 值分布
create index if not exists idx_videos_raw_brand
  on public.youtube_competitor_videos (raw_brand);

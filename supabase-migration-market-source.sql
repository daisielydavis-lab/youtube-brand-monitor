-- P1 区域识别修复：market_source 列 + 索引（2026-08-29）
-- market_confidence / market_evidence 已在 v3 建过（if not exists 兜底未跑 v3 的库）。
-- 语义：
--   market_source        —— 该行 market 的来源（manual/channel_country/explicit_localization/
--                            language/creator_history/ai_inference/discovery_hint/unknown）
--   market_confidence    —— 0-100；unknown → null（不强猜）
--   market_evidence      —— 证据数组（url:.../currency:.../language:.../channel_country:...）

alter table public.youtube_competitor_videos
  add column if not exists market_source text,
  add column if not exists market_confidence int default 0 check (market_confidence between 0 and 100),
  add column if not exists market_evidence text[] default '{}';

create index if not exists idx_videos_market on public.youtube_competitor_videos (market);
create index if not exists idx_videos_market_source on public.youtube_competitor_videos (market_source);

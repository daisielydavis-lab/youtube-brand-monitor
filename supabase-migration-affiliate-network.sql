-- ============================================================
-- Migration: Affiliate Network (Creator-led Discovery) — 2026-08-23
-- LagZapper 是 Affiliate Creator Network 模式:投放视频标题无品牌,
-- 品牌信号在 description 的 affiliate link / promo code / cid 参数里。
--
-- 本迁移:
--   1. affiliate_identities 表 —— 每个 creator 的 affiliate 指纹
--      (promo_code / cid / ref / domain),识别该 creator 的投放
--   2. youtube_creator_watchlist.discovered_via 扩展枚举 + 索引
--      (manual_seed / ai_confirmed / video_backtrace / affiliate_cluster / similar_creator)
--
-- 执行: 在 Supabase SQL Editor 跑本文件(幂等)。
-- 执行后: npm run affiliate:seed -- --seed  ← 回填身份 + 建种子
--         npm run affiliate:seed -- --scan  ← 扫新增频道 + 验证 Recall
-- ============================================================

-- ── 1. Affiliate identity 表 ──
-- 一行 = 一个 creator 对一个品牌的 affiliate 身份。
-- signal_type = 识别该 creator 的最高可信信号;confidence = 该信号置信度。
-- 置信度: cid/ref(1.0) > promo_code(0.9) > domain-only(0.7) > discount文字(0.3)
create table if not exists public.affiliate_identities (
  id bigserial primary key,
  brand text not null,
  channel_id text not null,
  channel_name text,
  promo_code text,
  affiliate_cid text,
  ref_id text,
  domain text,
  signal_type text not null default 'promo_code',   -- cid | ref | promo_code | domain | discount
  confidence numeric(3,2) not null default 0.9,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  unique (brand, channel_id)
);

create index if not exists idx_aff_identities_code
  on public.affiliate_identities (brand, promo_code);
create index if not exists idx_aff_identities_cid
  on public.affiliate_identities (brand, affiliate_cid);
create index if not exists idx_aff_identities_channel
  on public.affiliate_identities (brand, channel_id);

-- ── 2. discovered_via 扩展(兼容存量,不删旧值)──
-- 存量: manual_seed(3) / ai_confirmed(14+)。新增: video_backtrace / affiliate_cluster / similar_creator
-- PostgreSQL 不支持 ADD CONSTRAINT IF NOT EXISTS → 用 DO 块 + pg_constraint 判重。
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_watchlist_discovered_via') then
    alter table public.youtube_creator_watchlist
      add constraint ck_watchlist_discovered_via check (
        discovered_via in (
          'manual_seed', 'ai_confirmed',
          'video_backtrace', 'affiliate_cluster', 'similar_creator'
        )
      );
  end if;
end $$;

create index if not exists idx_watchlist_discovered_via
  on public.youtube_creator_watchlist (discovered_via);

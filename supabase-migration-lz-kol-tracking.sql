-- ─────────────────────────────────────────────────────────────────────────────
-- LagZapper KOL Tracking — utm_campaign 证据列（2026-08-29）
--
-- 语义（Observed Signal ≠ Owned Identity）：
--   cid / promo code / ref / utm_campaign 都是同一个 KOL 的身份观测。
--   utm_campaign = 追踪链接里的博主 handle，是新信号形态；但单独出现 ≠ HIGH identity
--   （可能是 agency / campaign 名 / 被分享链接），只降级为候选(MEDIUM)，由人工/证据升级。
--
-- 幂等，可在 Supabase SQL Editor 全量粘贴运行。不影响存量行（add column if not exists）。
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliate_identities
  add column if not exists utm_campaign text;

create index if not exists idx_aff_identities_utm
  on public.affiliate_identities (brand, utm_campaign);

-- signal_type 是 text 列（注释枚举：cid | ref | promo_code | domain | discount），
-- 无 CHECK 约束，扩展 utm_campaign 无需改表 —— 更新注释即可：
comment on column public.affiliate_identities.signal_type is
  'cid | ref | promo_code | domain | discount | utm_campaign（utm 单独出现≠HIGH，仅候选）';

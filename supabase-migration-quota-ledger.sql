-- ─────────────────────────────────────────────────────────────────────────────
-- P0: Persistent Global Search Quota Ledger (2026-08-29, v2 修复版)
--
-- 根因：dailySearchUsed 是进程内存计数，Railway deploy/restart 清零，但
-- YouTube API Key 的真实日 Search quota 不随进程重置 → 多部署后穿透真实 bucket。
--
-- 方案：search.list 每次调用前 atomic reserve，按 **Pacific Time 午夜**重置的
-- quota 周期持久化到 Supabase，跨部署/多实例共享。Search 在 ledger 不可用时
-- fail-closed（抛 YT_QUOTA_LEDGER_UNAVAILABLE，不发请求），绝不降级。
--
-- 在 Supabase SQL Editor 全量粘贴运行一次（幂等，可重跑）。
-- 幂等修复：每个函数前 DROP FUNCTION IF EXISTS，清掉任何遗留/冲突签名
-- （避免 "duplicate declaration"），再 CREATE 全新函数。
-- 参考 docs/quota-ledger-p0-design.md
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 表 ──
create table if not exists youtube_quota_usage (
  id bigserial primary key,
  quota_period_date date not null,               -- America/Los_Angeles 当地日期（PT 午夜重置，非 UTC）
  reset_at timestamptz not null,                 -- 本期重置时刻（下个 PT 午夜，ISO UTC）
  api_key_id text not null default 'primary',
  search_calls_used integer not null default 0,
  quota_units_used integer not null default 0,   -- search.list = 100 units/次（保留 units 模型防盲区）
  normal_calls_used   integer not null default 0,
  backfill_calls_used integer not null default 0,
  manual_calls_used   integer not null default 0,
  hard_exhausted boolean not null default false, -- 真实每日配额耗尽 → 当天剩余 Search 短路
  updated_at timestamptz not null default now(),
  constraint youtube_quota_usage_day_key unique (quota_period_date, api_key_id)
);

-- ── Atomic reserve：每次真实 search.list 调用前执行 ──
-- 单函数 = 单事务，无 read→+1→write 竞态。硬门在 UPDATE 的 WHERE 里。
-- p_category: normal | backfill | manual（hotspot/实验/CLI probe 归 manual）
-- p_dry_run: true → 只跑守卫检查不递增（readiness check 用）
drop function if exists reserve_youtube_search_quota cascade;
create function reserve_youtube_search_quota(
  p_key text default 'primary',
  p_category text default 'manual',
  p_hard_budget integer default 85,
  p_dry_run boolean default false
) returns table (
  reserved boolean,
  reason text,
  used_after integer,
  period_date date,
  reset_at timestamptz
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_period date;
  v_reset_ts timestamptz;
  v_used integer;
  v_total integer;
  v_he boolean;
begin
  -- PT 时区（IANA）计算当前 quota 周期：search.list 在 Pacific Time 午夜重置
  v_period := (current_timestamp at time zone 'America/Los_Angeles')::date;
  v_reset_ts := (date_trunc('day', current_timestamp at time zone 'America/Los_Angeles') + interval '1 day')
                at time zone 'America/Los_Angeles';

  insert into youtube_quota_usage (quota_period_date, reset_at, api_key_id)
  values (v_period, v_reset_ts, p_key)
  on conflict (quota_period_date, api_key_id) do update set reset_at = excluded.reset_at;

  -- dry_run：只验证守卫（表 + RPC + 原子路径可调），不消耗配额
  if p_dry_run then
    select search_calls_used, hard_exhausted into v_total, v_he
      from youtube_quota_usage
     where quota_period_date = v_period and api_key_id = p_key;
    if v_total + 1 <= p_hard_budget and not v_he then
      return query select true, 'ok', v_total, v_period, v_reset_ts;
    end if;
    return query select false, case when v_he then 'hard_exhausted' else 'budget' end, v_total, v_period, v_reset_ts;
  end if;

  -- 原子 reserve：guard 在 WHERE，绝不可能并发突破硬门
  update youtube_quota_usage
     set search_calls_used = search_calls_used + 1,
         quota_units_used  = quota_units_used + 100,
         normal_calls_used   = normal_calls_used   + (case when p_category = 'normal'   then 1 else 0 end),
         backfill_calls_used = backfill_calls_used + (case when p_category = 'backfill' then 1 else 0 end),
         manual_calls_used   = manual_calls_used   + (case when p_category = 'manual'   then 1 else 0 end),
         updated_at = now()
   where quota_period_date = v_period
     and api_key_id = p_key
     and not hard_exhausted
     and search_calls_used + 1 <= p_hard_budget
   returning search_calls_used into v_used;

  if v_used is not null then
    return query select true, 'ok', v_used, v_period, v_reset_ts;
  end if;

  select hard_exhausted into v_he
    from youtube_quota_usage
   where quota_period_date = v_period and api_key_id = p_key;

  if v_he then
    return query select false, 'hard_exhausted', 0, v_period, v_reset_ts;
  else
    return query select false, 'budget', 0, v_period, v_reset_ts;
  end if;
end;
$$;

-- ── 读当前期状态（惰性建行，不递增）── hydrate / dashboard / readiness 共用
drop function if exists get_youtube_quota_status cascade;
create function get_youtube_quota_status(p_key text default 'primary')
returns table (
  quota_period_date date,
  reset_at timestamptz,
  search_calls_used integer,
  quota_units_used integer,
  normal_calls_used integer,
  backfill_calls_used integer,
  manual_calls_used integer,
  hard_exhausted boolean
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_period date;
  v_reset_ts timestamptz;
begin
  v_period := (current_timestamp at time zone 'America/Los_Angeles')::date;
  v_reset_ts := (date_trunc('day', current_timestamp at time zone 'America/Los_Angeles') + interval '1 day')
                at time zone 'America/Los_Angeles';

  insert into youtube_quota_usage (quota_period_date, reset_at, api_key_id)
  values (v_period, v_reset_ts, p_key)
  on conflict (quota_period_date, api_key_id) do update set reset_at = excluded.reset_at;

  return query
    select q.quota_period_date, q.reset_at, q.search_calls_used, q.quota_units_used,
           q.normal_calls_used, q.backfill_calls_used, q.manual_calls_used, q.hard_exhausted
      from youtube_quota_usage q
     where q.quota_period_date = v_period and q.api_key_id = p_key;
end;
$$;

-- ── 首日 bootstrap / 运维控制：设置或解除当前 PT 期的 hard_exhausted ──
-- ledger 是当天中途新建的，migration 之前同一 API Key 已消耗的真实 Search quota
-- 无法重建 → 当前 PT 日视为已耗尽（fail-closed），等下一个 PT 午夜自动开新 period。
-- 幂等；p_exhaust=false 可解除（仅在确认今日真实用量远低于硬门时使用）。
drop function if exists set_youtube_quota_day_exhausted cascade;
create function set_youtube_quota_day_exhausted(
  p_key text default 'primary',
  p_exhaust boolean default true
) returns table (
  quota_period_date date,
  reset_at timestamptz,
  search_calls_used integer,
  hard_exhausted boolean
)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_period date;
  v_reset_ts timestamptz;
begin
  v_period := (current_timestamp at time zone 'America/Los_Angeles')::date;
  v_reset_ts := (date_trunc('day', current_timestamp at time zone 'America/Los_Angeles') + interval '1 day')
                at time zone 'America/Los_Angeles';

  insert into youtube_quota_usage (quota_period_date, reset_at, api_key_id)
  values (v_period, v_reset_ts, p_key)
  on conflict (quota_period_date, api_key_id) do update set reset_at = excluded.reset_at;

  update youtube_quota_usage
     set hard_exhausted = p_exhaust,
         updated_at = now()
   where quota_period_date = v_period and api_key_id = p_key;

  return query
    select q.quota_period_date, q.reset_at, q.search_calls_used, q.hard_exhausted
      from youtube_quota_usage q
     where q.quota_period_date = v_period and q.api_key_id = p_key;
end;
$$;

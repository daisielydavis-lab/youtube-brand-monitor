# P0：Persistent Global Search Quota Ledger — 设计（2026-08-29 v3，已加首日 bootstrap 保护）

## 1. 根因（已确认）

`dailySearchUsed` 是**进程内存计数**。Railway 每次 deploy / restart 清零，
但 YouTube API Key 的真实日 Search quota **不随进程重置**。应用软预算（70/天）不是可靠的全局日预算。

今天的实际链路（部署 12 次 → 每进程各拿 70 软预算 → 同一 key 真实累计 >100 → 429 风暴）。
07:30 回填日志实锤：`Backfill resume: 336 个未完成窗口` + 连续 `search 429 ... limit 'Search Queries per day'`。

**日界线**：YouTube Search daily quota 在 **Pacific Time 午夜**重置（IANA `America/Los_Angeles`），
不是 UTC 午夜。北京夏令时约 **15:00**、冬令时约 **16:00** 重置。代码不得写死 UTC offset，必须用 IANA 时区。

## 2. search.list 调用入口枚举（无旁路确认）

**唯一真实 HTTP 调用点**：`searchVideosPaged()` → `axios.get(`${YT_BASE}/search`)`（`youtube-discovery.ts:107`）。
所有活动入口汇到它（或经 `searchBackfillTimeSliced`）：

| 入口 | 位置 | 类别 |
|---|---|---|
| 06:00 normal cron | app.ts:1099 → index.ts:423 | normal |
| 07:30 backfill cron | app.ts:1122 → index.ts:383/322 | backfill |
| 4h hotspot cron | app.ts:1144 → index.ts:423 | manual（异常补扫） |
| 周实验 query | app.ts:1160 → index.ts:423 | manual |
| `/run`、`/api/scan`、`/api/backfill` POST | app.ts:55/65/517 | manual |
| cli-discover.ts | cli:30 | manual |
| cli-validate-chain.ts / cli-recall-diagnostics.ts | cli:56 / cli:102（**直调**） | manual |

**旁路（必须接 ledger）**：`searchPaidPlacements()`（youtube-discovery.ts:283）含独立 axios `/search` 调用，
当前死代码（无调用方）——**也必须接 ledger**，杜绝未来旁路。

**非 Search 调用**（videos/channels/playlistItems/commentThreads，1 unit/次，General 池）超出本轮范围；
同样有 in-memory 随部署清零问题但风险低（1 unit/次，10K/天）。列后续。

## 3. 数据模型 + RPC（PT 日界 + 原子 category 计数）

```sql
-- 见 supabase-migration-quota-ledger.sql（Supabase SQL Editor 手动应用，幂等）
create table youtube_quota_usage (
  id bigserial primary key,
  quota_period_date date not null,          -- America/Los_Angeles 当地日期（PT 午夜重置，非 UTC）
  reset_at timestamptz not null,            -- 本次期重置时刻（下个 PT 午夜，ISO）
  api_key_id text not null default 'primary',
  search_calls_used integer not null default 0,
  quota_units_used integer not null default 0,  -- search.list=100 units/次（保留 units 模型，防只看 call count 的盲区）
  normal_calls_used   integer not null default 0,
  backfill_calls_used integer not null default 0,
  manual_calls_used   integer not null default 0,
  hard_exhausted boolean not null default false,  -- 真实每日配额耗尽 → 当天剩余 Search 短路
  updated_at timestamptz not null default now(),
  unique (quota_period_date, api_key_id)
);
```

**RPC 一**：`reserve_youtube_search_quota(p_key text, p_category text, p_hard_budget int default 85, p_dry_run boolean default false)`
returns `(reserved boolean, reason text, used_after integer, period_date date, reset_at timestamptz)`

- **期计算在 SQL 内**：`(current_timestamp at time zone 'America/Los_Angeles')::date`；
  `reset_at = (date_trunc('day', pt_now) + interval '1 day') at time zone 'America/Los_Angeles'`。
  App 不重复算，dashboard/hydrate 一律读 DB（单一来源）。
- 单函数 = 单事务：`INSERT ... ON CONFLICT DO UPDATE`（幂等建行）→
  `UPDATE ... SET search_calls_used+1, quota_units_used+100, [category]_calls_used+1,
  WHERE NOT hard_exhausted AND search_calls_used+1 <= p_hard_budget RETURNING` —— **原子**。
- 失败区分：`budget`（内部硬门满）vs `hard_exhausted`（当天已熔断短路）。
- `p_dry_run=true`：只跑守卫检查不递增，供 readiness check 做 reserve 路径测试。

**RPC 二**：`get_youtube_quota_status(p_key)` returns 当前 PT 期行（含 `reset_at`）。
惰性建行（不递增），供 hydrate + dashboard + readiness。

**RPC 三**：`set_youtube_quota_day_exhausted(p_key, p_exhaust boolean default true)`
returns 当前 PT 期行。幂等设置/解除当前 PT 期 `hard_exhausted` —— 首日 bootstrap 保护 / 运维控制用。
`p_exhaust=false` 仅限确认今日真实用量远低于硬门时使用。

Supabase-js UPDATE 不支持 server-side 自增表达式，**必须走 RPC**（原子返回 used_after 的唯一路径）。

## 4. 运行时接入（fail-closed）

新模块 `src/services/competitor-monitor/quota-ledger.ts`：

| 导出 | 职责 |
|---|---|
| `SEARCH_HARD_BUDGET = 85` | 全局硬预算（RPC 内 enforced；真实 Search bucket=100/day） |
| `SEARCH_SOFT = { normal:45, backfill:30, manual:10 }` | 仅展示/借用，非硬门 |
| `reserveSearchQuota(category)` | 调 RPC；`reserved=false` → 抛 `YT_QUOTA_BUDGET_EXHAUSTED:${reason}`；RPC 调用本身失败 → 抛 `YT_QUOTA_LEDGER_UNAVAILABLE`（**不发请求**） |
| `markSearchHardExhausted()` | 真实每日配额耗尽 → `hard_exhausted=true`（literal UPDATE 即可，无需 RPC） |
| `getQuotaToday()` | 读 status RPC，供 dashboard |
| `setQuotaDayExhausted(exhaust)` | 首日 bootstrap：熔断/解除当前 PT 日（RPC 三） |
| `checkLedgerReady()` | readiness **三态**：`{ready, gated, gateReason, detail}` —— ready=infra 可用；gated=当前期守卫拒绝（bootstrap 熔断后属预期，非故障） |
| `hydrateSearchUsed()` | 扫描开始时同步缓存（跨部署准确算 budgetWin） |
| `getSearchUsed()` | 进程内缓存（每次 reserve 返回 used_after 更新） |

**接入点（3 处）**：

1. `searchVideosPaged()`（youtube-discovery.ts）：
   - 加参数 `quotaCategory`（默认 `'manual'`）。
   - 分页循环内、**每次 HTTP 调用前**（try 之外）`await reserveSearchQuota(quotaCategory)`。
     失败 → 抛（`YT_QUOTA_LEDGER_UNAVAILABLE` / `YT_QUOTA_BUDGET_EXHAUSTED`），**绝不发请求**。
   - catch 里每日配额耗尽 → `await markSearchHardExhausted()` → 抛 `YT_QUOTA_EXHAUSTED`。
2. `searchBackfillTimeSliced()`：opts 加 `quotaCategory` 透传。
3. `runDiscoveryPipeline()`（index.ts）：mode→category（normal/backfill/manual）；`SEARCH_DAILY_BUDGET=70`→`SEARCH_HARD_BUDGET=85`；
   `trackSearch`/`onSearchCall` 内存计数改由 ledger 缓存；`startsWith('YT_QUOTA_EXHAUSTED')` 收敛为 `startsWith('YT_QUOTA')`。

**错误语义统一**：
- `YT_QUOTA_LEDGER_UNAVAILABLE` — ledger 表/RPC 缺失 → 不调用 YouTube。
- `YT_QUOTA_BUDGET_EXHAUSTED` — 内部硬门满 / hard_exhausted 短路 → 不发请求。
- `YT_QUOTA_EXHAUSTED` — 真实每日配额耗尽 → 记 ledger + 熔断。
- 三者都开熔断、回填窗口标 `quota_paused`（不是 failed）。

**真实配额耗尽判定（区分 rateLimitExceeded）**：

```
quotaExceeded (403 或 429)
→ hard_exhausted=true

429 rateLimitExceeded + 响应含每日 bucket 耗尽证据（message 含 "Queries per day" / "Search Queries"）
→ hard_exhausted=true

429 rateLimitExceeded + ledger 已 ≥90% HARD_BUDGET
→ hard_exhausted=true（经验规则，保守）

普通 429 rateLimitExceeded（无上述证据）
→ 瞬时 QPS：短退避重试（既有坑 #23 逻辑），不锁全天
```

## 5. Fail-closed 原则

- **Dashboard / API 正常启动**；任何 Search 在 ledger 不可用时 **fail-closed**，禁止绕过。
- `reserveSearchQuota` 遇 RPC 错误 → `YT_QUOTA_LEDGER_UNAVAILABLE` → search.list **不发请求**。
  **没有**"降级为进程内计数"的 fallback——否则 migration 忘跑 = 硬门关闭 = 重演今日 429。
- 上线前 readiness check（`checkLedgerReady` + CLI）：表存在 / RPC 可调 / atomic reserve 路径通 → infra READY。
  READY 且当前期未熔断（`gated=false`）才放行 Search；READY 但 `gated=true`（bootstrap 熔断）属预期，Search 暂停至下个 PT 午夜。
- 部署顺序：**先应用 migration，再跑 `quota:check --exhaust-today`（首日 bootstrap），后部署**（否则 Search fail-closed 不工作 / 或首日从 0 低估真实用量）。

## 6. Dashboard 指标

`/api/system` 增加 `quota` 字段：

```
YouTube Search Today: 47 / 85 (internal hard budget)
  Normal: 31 · Backfill: 14 · Manual: 2
  Hard exhausted: no · Ledger ready: yes
  Reset: next Pacific midnight (2026-08-30 07:00:00Z)
```

数据源 `getQuotaToday()`（读 status RPC，与 hard ledger 同源）+ `SEARCH_SOFT` + `ledgerReady`。

## 7. Migration（手动执行一次）

`supabase-migration-quota-ledger.sql`：建表 + **三个 RPC**，幂等（IF NOT EXISTS / OR REPLACE）。
在 Supabase SQL Editor 全量粘贴运行。**上线前必须应用**，否则 Search fail-closed（不吞请求，但也不发请求）。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `supabase-migration-quota-ledger.sql` | **新增**：表 + 3 RPC（PT 日界；RPC 三=set_youtube_quota_day_exhausted bootstrap） |
| `src/services/competitor-monitor/quota-ledger.ts` | **新增**：ledger 客户端 + 硬/软预算 + readiness 三态 + setQuotaDayExhausted |
| `src/services/competitor-monitor/youtube-discovery.ts` | reserve 接入 + quotaCategory；searchBackfillTimeSliced 透传；searchPaidPlacements 接 ledger；rateLimitExceeded 区分 |
| `src/services/competitor-monitor/index.ts` | SEARCH_DAILY_BUDGET→SEARCH_HARD_BUDGET；ledger 缓存；category 映射；错误判断收敛 |
| `src/app.ts` | /api/system quota 字段 + 启动 readiness check |
| `src/ui/dashboard.ts` | System 面板渲染 quota 行 |
| `src/cli-check-quota-ledger.ts` | **新增**：上线前 readiness check CLI（含 `--exhaust-today` / `--unlock-today` bootstrap 控制） |
| `docs/quota-ledger-p0-design.md` | 本设计 |

## 9. 回归验证

1. `hydrateSearchUsed` 后 `budgetWin` 反映真实全局用量（部署重启不重置）。
2. 硬门满 → reserve `budget` → `YT_QUOTA_BUDGET_EXHAUSTED` → 熔断 + 窗口 `quota_paused`。
3. 模拟真实每日耗尽 → `hard_exhausted=true` → 后续 reserve 短路（reason `hard_exhausted`），不试探 YouTube。
4. 普通 429（无 bucket 证据、ledger 未近满）→ 退避重试，不锁全天。
5. 跨 PT 午夜：期变化 → 新行、计数从 0、reset_at 正确。
6. 两进程并发 reserve → 总和 ≤85（原子 UPDATE）。
7. `/api/system` quota 与 ledger 一致；`ledgerReady` 反映 readiness。
8. 未应用 migration 时：dashboard 可开，search 抛 `YT_QUOTA_LEDGER_UNAVAILABLE`，不发请求。
9. 现有回归 `npm run test:market` / `test:inline-json` / `test:lagofast` 全绿。

## 10. 本轮不做（用户拍板：只做 quota ledger P0）

- LagZapper global queries / 90d backfill / 新 creator discovery / comments / crossover —— **完全不动**。
- General quota ledger（1 unit/次，低优先）。
- YouTube 配额提升 / 第二 API key（外部）。

## 11. 首日 bootstrap 保护（冷启动，2026-08-29 用户补充）

**缺口**：ledger 是当天中途新建的。migration 之前同一 API Key 已消耗的真实 Search quota
（今天 08-29 已有 07:30 backfill 24 queries + 12 次 deploy，真实 bucket 大概率已被打满 ~100）
**无法从新 ledger 体现** —— 新 ledger 首见 `used=0`，但 YouTube 真实日 bucket 可能已 60/80/近 100。
若不处理，上线第一天就再次低估真实 quota（上一轮根因的变体：不是"部署归零"，而是"ledger 半天才启用"）。

**是否可重建**：backfill_windows.search_calls 只覆盖 backfill，normal/probe 不落账；且无法把
历史窗口精确映射到「今天 PT 期」。**无法可靠重建 → 按 fail-closed 原则 bootstrap**。

**做法（RPC 三 + CLI flag）**：
```
npm run quota:check -- --exhaust-today   # 熔断当前 PT 日：hard_exhausted=true，全类 Search 暂停
npm run quota:check -- --unlock-today    # 解除（仅确认今日真实用量远低于硬门时用）
```
熔断只作用于当前 PT 期行；下个 `America/Los_Angeles` 午夜，RPC 计算新的 `quota_period_date` →
INSERT ON CONFLICT 自动建新行（`used=0, hard_exhausted=false`）→ **ledger 数字从此完整可信**。

**上线顺序（最终版）**：
1. Supabase SQL Editor 全量运行 `supabase-migration-quota-ledger.sql`（幂等）。
2. 生产 env 连跑两次 `npm run quota:check`：两次 `used` 完全一致（dry-run 不递增）+ infra READY。
3. `npm run quota:check -- --exhaust-today` —— 首日 bootstrap：当前 PT 日熔断。
4. push → Railway deploy（`BACKFILL_BRANDS=Lagofast` 保持不解）。
5. 部署后当前日 Search fail-closed（System 面板显示"已硬熔断"+ 下个 PT 午夜 reset 时间）。
6. 下个 PT 午夜后：`used=0/85, hardExhausted=false`，此后每次真实 Search 只 +1 —— 从此刻起 ledger 才算权威。
7. 重启验收：Railway redeploy/restart 后 `used` 不归零（核心验收）。

**readiness 三态**（避免把 bootstrap 熔断误判为 infra 故障）：
- `ready=true, gated=false` —— infra 可用且当前日放行 → Search 正常。
- `ready=true, gated=true`  —— infra 可用但当前日熔断（bootstrap / 真实耗尽）→ 预期，Search 暂停。
- `ready=false`           —— infra 不可用（migration 未跑）→ fail-closed，不发请求。

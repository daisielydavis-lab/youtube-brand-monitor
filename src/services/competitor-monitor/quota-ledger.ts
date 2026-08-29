/**
 * P0: Persistent Global Search Quota Ledger (2026-08-29)
 *
 * 根因：dailySearchUsed 是进程内存计数，Railway deploy/restart 清零，但 YouTube
 * API Key 的真实日 Search quota 不随进程重置 → 多部署后穿透真实 bucket（今天 429 风暴）。
 *
 * 本模块把 Search 配额按 **Pacific Time 午夜重置**的 quota 周期持久化到 Supabase：
 *  - reserve_youtube_search_quota RPC：每次真实 search.list 调用前 atomic reserve
 *    （硬门在 SQL 的 WHERE 里，绝无并发突破）。
 *  - get_youtube_quota_status RPC：读当前期状态（惰性建行，不递增）。
 *
 * 错误语义（统一前缀 YT_QUOTA_*，调用方按 startsWith('YT_QUOTA') 收敛）：
 *  - YT_QUOTA_LEDGER_UNAVAILABLE  —— ledger 表/RPC 缺失 → 不发请求（fail-closed）。
 *  - YT_QUOTA_BUDGET_EXHAUSTED    —— 内部硬门满 / hard_exhausted 短路 → 不发请求。
 *  - YT_QUOTA_EXHAUSTED           —— 真实每日配额耗尽（在 youtube-discovery 抛，本模块记硬熔断）。
 *
 * 无"降级为进程内计数"的 fallback：migration 忘跑 = 硬门关闭 = 重演今日 429。
 */
import { getSupabase } from '../../db/supabase';

export type SearchQuotaCategory = 'normal' | 'backfill' | 'manual';

/** 内部全局硬预算（RPC 内 enforced）。真实 Search bucket = 100 calls/day，
 *  故意不设满，给人工 probe / 异常重试 / 统计误差留 buffer。 */
export const SEARCH_HARD_BUDGET = 85;

/** soft budget：仅展示/借用目标，非硬门（用户拍板 45/30/10） */
export const SEARCH_SOFT: Record<SearchQuotaCategory, number> = {
  normal: 45,
  backfill: 30,
  manual: 10, // 含 hotspot/实验/CLI probe 的紧急储备
};

const API_KEY_ID = 'primary';

export interface QuotaToday {
  periodDate: string | null;
  resetAt: string | null;
  used: number;
  units: number;
  normal: number;
  backfill: number;
  manual: number;
  hardExhausted: boolean;
  ledgerReady: boolean;
  error?: string;
}

// ── 进程内缓存（权威值来自 ledger；hydrate + 每次 reserve 返回值维护）──
let ledgerReady = false;
let cachedUsed = 0;
let cachedPeriod: string | null = null;
let cachedResetAt: string | null = null;

export function getLedgerReady(): boolean { return ledgerReady; }
export function getSearchUsed(): number { return cachedUsed; }
export function getCachedPeriod(): string | null { return cachedPeriod; }
export function getCachedResetAt(): string | null { return cachedResetAt; }

/** 扫描开始时同步全局真实用量（跨部署重启后 budgetWin 仍准确）。 */
export async function hydrateSearchUsed(): Promise<number> {
  const q = await getQuotaToday();
  if (q.ledgerReady) {
    cachedUsed = q.used;
    cachedPeriod = q.periodDate;
    cachedResetAt = q.resetAt;
  }
  return cachedUsed;
}

/**
 * 每次真实 search.list 调用前执行。原子 reserve；硬门由 SQL 保证。
 * @throws YT_QUOTA_BUDGET_EXHAUSTED（硬门满 / 已熔断短路）或 YT_QUOTA_LEDGER_UNAVAILABLE（ledger 缺失）
 */
export async function reserveSearchQuota(category: SearchQuotaCategory = 'manual'): Promise<{ used: number; periodDate: string; resetAt: string }> {
  const db = getSupabase();
  try {
    const { data, error } = await db.rpc('reserve_youtube_search_quota', {
      p_key: API_KEY_ID,
      p_category: category,
      p_hard_budget: SEARCH_HARD_BUDGET,
    });
    if (error) throw new Error(`RPC_ERR:${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.reserved !== true) {
      const reason = row?.reason || 'unknown';
      throw new Error(`YT_QUOTA_BUDGET_EXHAUSTED:${reason}`);
    }
    ledgerReady = true;
    cachedUsed = Number(row.used_after) || 0;
    cachedPeriod = row.period_date ? String(row.period_date) : cachedPeriod;
    cachedResetAt = row.reset_at ? String(row.reset_at) : cachedResetAt;
    return { used: cachedUsed, periodDate: cachedPeriod || '', resetAt: cachedResetAt || '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('YT_QUOTA_BUDGET_EXHAUSTED')) throw err; // 硬门拒绝，原样抛
    // RPC 调用本身失败（函数/表缺失 PGRST202、网络等）→ fail-closed，绝不放行 search.list
    ledgerReady = false;
    throw new Error(`YT_QUOTA_LEDGER_UNAVAILABLE:${msg.slice(0, 200)}`);
  }
}

/** 真实每日配额耗尽（403/429 quotaExceeded，或带每日 bucket 证据的 rateLimitExceeded）
 *  → 当天剩余 Search 全部短路（后续 reserve 返回 hard_exhausted，不再试探 YouTube）。 */
export async function markSearchHardExhausted(): Promise<void> {
  try {
    const { periodDate } = await getQuotaToday();
    if (!periodDate) return;
    const db = getSupabase();
    const { error } = await db.from('youtube_quota_usage')
      .update({ hard_exhausted: true, updated_at: new Date().toISOString() })
      .eq('quota_period_date', periodDate)
      .eq('api_key_id', API_KEY_ID);
    if (error) throw error;
    ledgerReady = true;
  } catch (err) {
    console.error('[QuotaLedger] markHardExhausted 失败（硬熔断未落库，需人工关注）:', (err as Error).message);
  }
}

/** 当前期用量（dashboard / hydrate 共用；与 hard ledger 同源）。 */
export async function getQuotaToday(): Promise<QuotaToday> {
  const db = getSupabase();
  const zero: QuotaToday = { periodDate: null, resetAt: null, used: 0, units: 0, normal: 0, backfill: 0, manual: 0, hardExhausted: false, ledgerReady };
  try {
    const { data, error } = await db.rpc('get_youtube_quota_status', { p_key: API_KEY_ID });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    ledgerReady = true;
    if (!row) return zero;
    return {
      periodDate: row.quota_period_date ? String(row.quota_period_date) : null,
      resetAt: row.reset_at ? String(row.reset_at) : null,
      used: Number(row.search_calls_used) || 0,
      units: Number(row.quota_units_used) || 0,
      normal: Number(row.normal_calls_used) || 0,
      backfill: Number(row.backfill_calls_used) || 0,
      manual: Number(row.manual_calls_used) || 0,
      hardExhausted: !!row.hard_exhausted,
      ledgerReady: true,
    };
  } catch (err) {
    ledgerReady = false;
    return { ...zero, ledgerReady: false, error: (err as Error).message.slice(0, 160) };
  }
}

/**
 * 上线前 readiness check：表存在 + status RPC 可调 + reserve 原子路径守卫通过。
 * 全部通过才允许启用 Search jobs。
 */
export async function checkLedgerReady(): Promise<{ ready: boolean; detail: string[] }> {
  const detail: string[] = [];
  const db = getSupabase();
  try {
    const st = await db.rpc('get_youtube_quota_status', { p_key: API_KEY_ID });
    if (st.error) { ledgerReady = false; return { ready: false, detail: [`get_youtube_quota_status 失败: ${st.error.message}`] }; }
    detail.push('status RPC ok（表存在）');

    const dry = await db.rpc('reserve_youtube_search_quota', {
      p_key: API_KEY_ID, p_category: 'manual', p_hard_budget: SEARCH_HARD_BUDGET, p_dry_run: true,
    });
    if (dry.error) { ledgerReady = false; return { ready: false, detail: [...detail, `reserve dry-run 失败: ${dry.error.message}`] }; }
    const row = Array.isArray(dry.data) ? dry.data[0] : dry.data;
    if (row && row.reserved === false) { ledgerReady = false; return { ready: false, detail: [...detail, `reserve 守卫已满/熔断: ${row.reason}`] }; }
    detail.push(`reserve dry-run ok（used=${row?.used_after ?? 0}, 守卫通过）`);
    ledgerReady = true;
    return { ready: true, detail };
  } catch (err) {
    ledgerReady = false;
    return { ready: false, detail: [...detail, String((err as Error).message).slice(0, 200)] };
  }
}

/**
 * 模型 token 消耗统计 store。
 *
 * 数据来源：
 *  1. 主：定期拉取 /v0/management/usage 队列，按 model 累加 tokens。
 *  2. 辅：本机最近一次手动输入（localStorage）作为"实时"估算。
 *
 * 聚合粒度：
 *  - monthly：自然月（YYYY-MM）
 *  - daily：自然日（YYYY-MM-DD）
 *
 * 数据存到 localStorage：每个 modelKey 一份，按月分桶，避免跨月污染。
 */

import { create } from 'zustand';
import { usageQueueApi, type UsageQueueRecord } from '@/services/api/usageQueue';

const STORAGE_KEY = 'cli-proxy-token-usage-v1';
const POLL_INTERVAL_MS = 30 * 1000;
const POLL_BATCH_SIZE = 100;

const toFiniteNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

export type TokenBreakdown = {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  total: number;
  requests: number;
};

const emptyBreakdown = (): TokenBreakdown => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cached: 0,
  total: 0,
  requests: 0,
});

// 稳定的 fallback 引用 — 避免 selector 每次返回新对象导致无限重渲染。
const FALLBACK_MONTH_BUCKET: MonthlyBucket = {
  input: 0,
  output: 0,
  reasoning: 0,
  cached: 0,
  total: 0,
  requests: 0,
  daily: {},
};

export type DailyBucket = TokenBreakdown;
export type MonthlyBucket = TokenBreakdown & { daily: Record<string, DailyBucket> };

export interface ModelUsageState {
  monthly: Record<string, MonthlyBucket>;
  /** 最近一次拉取时间，用于显示"实时"标记。 */
  lastUpdatedAt: number | null;
  /** 累计所有时间的总数（不区分月份），方便顶部聚合。 */
  lifetime: TokenBreakdown;
  /** 已拉取的记录 ID 集合，防止重复入账。 */
  seenIds: number[];
}

interface PersistedShape {
  models: Record<string, ModelUsageState>;
  /** schema 版本，方便未来迁移。 */
  version: 1;
}

const emptyModelState = (): ModelUsageState => ({
  monthly: {},
  lastUpdatedAt: null,
  lifetime: emptyBreakdown(),
  seenIds: [],
});

const STORAGE_VERSION = 1;

export interface TokenUsageStoreState {
  models: Record<string, ModelUsageState>;
  loading: boolean;
  error: string | null;
  lastPolledAt: number | null;
  pollIntervalMs: number;

  start: () => void;
  stop: () => void;
  pollOnce: () => Promise<void>;
  reset: () => void;
  resetModel: (modelKey: string) => void;

  /** 暴露给 UI 使用的纯查询函数。 */
  getModelUsage: (modelKey: string) => ModelUsageState;
  getMonthlyUsage: (modelKey: string, yearMonth: string) => MonthlyBucket | null;
  getDailyUsage: (modelKey: string, dateKey: string) => DailyBucket | null;
  getCurrentMonthUsage: (modelKey: string) => MonthlyBucket;
  /** 估算的"实时"显示值（按月聚合）。 */
  getDisplayTotal: (modelKey: string) => number;
}

const monthKey = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const dayKey = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseIsoMonth = (value: string): Date | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return new Date(year, month - 1, 1);
};

const parseRecordTimestamp = (value: string | undefined): Date | null => {
  if (!value) return null;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return new Date(direct);
  // 容错：尝试 "2026-04-25T00:00:00Z" 等格式
  const normalized = value.replace(' ', 'T');
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? new Date(ts) : null;
};

const normalizeRecordModelKey = (record: UsageQueueRecord): string => {
  // 优先使用 alias（客户端看到的别名），其次使用 model 真名。
  if (record.alias && record.alias.trim()) return record.alias.trim();
  if (record.model && record.model.trim()) return record.model.trim();
  if (record.endpoint) return record.endpoint;
  return 'unknown';
};

const seenIdsCapacity = 4000;

const trimSeenIds = (ids: number[]): number[] =>
  ids.length > seenIdsCapacity ? ids.slice(ids.length - seenIdsCapacity) : ids;

const loadFromStorage = (): Record<string, ModelUsageState> => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || parsed.version !== STORAGE_VERSION || typeof parsed.models !== 'object') {
      return {};
    }
    return parsed.models;
  } catch {
    return {};
  }
};

const saveToStorage = (models: Record<string, ModelUsageState>): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: PersistedShape = { version: STORAGE_VERSION, models };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage 可能因为隐私模式或容量上限不可用——静默忽略。
  }
};

const applyRecord = (
  state: ModelUsageState,
  record: UsageQueueRecord,
  month: string,
  day: string
): ModelUsageState => {
  const tokens = record.tokens ?? {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  };
  const input = toFiniteNumber(tokens.input_tokens);
  const output = toFiniteNumber(tokens.output_tokens);
  const reasoning = toFiniteNumber(tokens.reasoning_tokens);
  const cached = toFiniteNumber(tokens.cached_tokens);
  const total = toFiniteNumber(tokens.total_tokens) || input + output;

  const nextMonthly = { ...state.monthly };
  const monthBucket: MonthlyBucket = nextMonthly[month]
    ? {
        ...nextMonthly[month],
        daily: { ...nextMonthly[month].daily },
      }
    : {
        ...emptyBreakdown(),
        daily: {},
      };
  monthBucket.input += input;
  monthBucket.output += output;
  monthBucket.reasoning += reasoning;
  monthBucket.cached += cached;
  monthBucket.total += total;
  monthBucket.requests += 1;

  const dayBucket: DailyBucket = monthBucket.daily[day]
    ? { ...monthBucket.daily[day] }
    : emptyBreakdown();
  dayBucket.input += input;
  dayBucket.output += output;
  dayBucket.reasoning += reasoning;
  dayBucket.cached += cached;
  dayBucket.total += total;
  dayBucket.requests += 1;
  monthBucket.daily[day] = dayBucket;

  nextMonthly[month] = monthBucket;
  const lifetime = { ...state.lifetime };
  lifetime.input += input;
  lifetime.output += output;
  lifetime.reasoning += reasoning;
  lifetime.cached += cached;
  lifetime.total += total;
  lifetime.requests += 1;

  let seenIds = state.seenIds;
  if (typeof record.id === 'number') {
    if (!seenIds.includes(record.id)) {
      seenIds = trimSeenIds([...seenIds, record.id]);
    }
  }

  return {
    monthly: nextMonthly,
    lastUpdatedAt: Date.now(),
    lifetime,
    seenIds,
  };
};

export const useTokenUsageStore = create<TokenUsageStoreState>((set, get) => {
  let timer: number | null = null;
  let pollInFlight = false;

  const persist = () => {
    saveToStorage(get().models);
  };

  const processRecords = (records: UsageQueueRecord[]) => {
    if (records.length === 0) return;
    const current = get().models;
    const next: Record<string, ModelUsageState> = { ...current };

    for (const record of records) {
      const modelKey = normalizeRecordModelKey(record);
      const dt = parseRecordTimestamp(record.timestamp) ?? new Date();
      const mKey = monthKey(dt);
      const dKey = dayKey(dt);

      const prev = next[modelKey] ?? emptyModelState();

      // 去重：按 ID 去重；没有 ID 的按 (timestamp + endpoint) 估算。
      if (typeof record.id === 'number' && prev.seenIds.includes(record.id)) {
        continue;
      }
      next[modelKey] = applyRecord(prev, record, mKey, dKey);
    }

    set({ models: next });
    persist();
  };

  const pollOnce = async (): Promise<void> => {
    if (pollInFlight) return;
    pollInFlight = true;
    set({ loading: true, error: null });
    try {
      const records = await usageQueueApi.pop(POLL_BATCH_SIZE);
      processRecords(records);
      set({ lastPolledAt: Date.now() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch usage';
      set({ error: message });
    } finally {
      set({ loading: false });
      pollInFlight = false;
    }
  };

  const start = () => {
    if (timer !== null) return;
    void pollOnce();
    timer = window.setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
  };

  const stop = () => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  return {
    models: loadFromStorage(),
    loading: false,
    error: null,
    lastPolledAt: null,
    pollIntervalMs: POLL_INTERVAL_MS,

    start,
    stop,
    pollOnce,

    reset: () => {
      set({ models: {} });
      persist();
    },
    resetModel: (modelKey) => {
      const next = { ...get().models };
      delete next[modelKey];
      set({ models: next });
      persist();
    },

    getModelUsage: (modelKey) => get().models[modelKey] ?? emptyModelState(),
    getMonthlyUsage: (modelKey, yearMonth) => {
      const state = get().models[modelKey];
      return state?.monthly[yearMonth] ?? null;
    },
    getDailyUsage: (modelKey, dateKey) => {
      const state = get().models[modelKey];
      if (!state) return null;
      const monthBucket = state.monthly[dateKey.slice(0, 7)];
      return monthBucket?.daily[dateKey] ?? null;
    },
    getCurrentMonthUsage: (modelKey) => {
      const state = get().models[modelKey];
      const ym = monthKey(new Date());
      return state?.monthly[ym] ?? FALLBACK_MONTH_BUCKET;
    },
    getDisplayTotal: (modelKey) => {
      const usage = get().getCurrentMonthUsage(modelKey);
      return usage.total;
    },
  };
});

/** 工具函数：从 tokenUsageStore 中按模型名汇总"按月"数据，供 UI 直接消费。 */
export function summarizeMonthly(
  store: TokenUsageStoreState,
  modelKey: string,
  yearMonth: string
): MonthlyBucket {
  if (!yearMonth) {
    return FALLBACK_MONTH_BUCKET;
  }
  return store.getMonthlyUsage(modelKey, yearMonth) ?? FALLBACK_MONTH_BUCKET;
}

/** 工具函数：列出某年月中所有有数据的日期。 */
export function listDaysInMonth(
  store: TokenUsageStoreState,
  modelKey: string,
  yearMonth: string
): string[] {
  const bucket = store.getMonthlyUsage(modelKey, yearMonth);
  if (!bucket) return [];
  return Object.keys(bucket.daily).sort();
}

/** 工具函数：列出该模型有数据的所有月份。 */
export function listMonthsForModel(
  store: TokenUsageStoreState,
  modelKey: string
): string[] {
  const state = store.models[modelKey];
  if (!state) return [];
  return Object.keys(state.monthly).sort();
}

/** 工具函数：列出某年月中所有有数据的日期（包含没数据的填充为 0）。 */
export function expandDailyInMonth(
  store: TokenUsageStoreState,
  modelKey: string,
  yearMonth: string
): DailyBucket[] {
  const baseDate = parseIsoMonth(yearMonth);
  if (!baseDate) return [];
  const bucket = store.getMonthlyUsage(modelKey, yearMonth);
  const daysInMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0).getDate();
  const result: DailyBucket[] = [];
  for (let i = 1; i <= daysInMonth; i += 1) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), i);
    const dKey = dayKey(d);
    const daily = bucket?.daily[dKey] ?? emptyBreakdown();
    result.push(daily);
  }
  return result;
}

/** 工具函数：按"近 N 天"展开趋势图数据。 */
export function expandLastDays(
  store: TokenUsageStoreState,
  modelKey: string,
  days: number
): { dateKey: string; bucket: DailyBucket }[] {
  const result: { dateKey: string; bucket: DailyBucket }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dayKey(d);
    const daily = store.getDailyUsage(modelKey, key) ?? emptyBreakdown();
    result.push({ dateKey: key, bucket: daily });
  }
  return result;
}

/** 工具函数：展开"近 N 个月"按月聚合趋势。 */
export function expandLastMonths(
  store: TokenUsageStoreState,
  modelKey: string,
  months: number
): { monthKey: string; bucket: TokenBreakdown }[] {
  const result: { monthKey: string; bucket: TokenBreakdown }[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const bucket = store.getMonthlyUsage(modelKey, key);
    const summary: TokenBreakdown = bucket
      ? {
          input: bucket.input,
          output: bucket.output,
          reasoning: bucket.reasoning,
          cached: bucket.cached,
          total: bucket.total,
          requests: bucket.requests,
        }
      : emptyBreakdown();
    result.push({ monthKey: key, bucket: summary });
  }
  return result;
}

/** 工具函数：展开"近 N 年"按年聚合（按自然年汇总）。 */
export function expandLastYears(
  store: TokenUsageStoreState,
  modelKey: string,
  years: number
): { yearKey: string; bucket: TokenBreakdown }[] {
  const result: { yearKey: string; bucket: TokenBreakdown }[] = [];
  const now = new Date();
  for (let i = years - 1; i >= 0; i -= 1) {
    const year = now.getFullYear() - i;
    const summary: TokenBreakdown = emptyBreakdown();
    const state = store.models[modelKey];
    if (state) {
      for (const [mKey, monthly] of Object.entries(state.monthly)) {
        const m = parseIsoMonth(mKey);
        if (!m) continue;
        if (m.getFullYear() !== year) continue;
        summary.input += monthly.input;
        summary.output += monthly.output;
        summary.reasoning += monthly.reasoning;
        summary.cached += monthly.cached;
        summary.total += monthly.total;
        summary.requests += monthly.requests;
      }
    }
    result.push({ yearKey: String(year), bucket: summary });
  }
  return result;
}
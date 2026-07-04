/**
 * 用量统计 API（来自 CLI Proxy API 的 /v0/management/usage Redis 队列）
 *
 * 每条记录包含：时间戳、来源、auth_index、token 分解、模型、端点、请求 ID 等。
 * 用于按模型聚合自然月内的 token 消耗。
 */

import { apiClient } from './client';

const USAGE_TIMEOUT_MS = 10 * 1000;

export interface UsageQueueTokens {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  total_tokens?: number;
}

export interface UsageQueueRecord {
  id?: number;
  timestamp?: string;
  latency_ms?: number;
  source?: string;
  auth_index?: string;
  tokens?: UsageQueueTokens;
  failed?: boolean;
  provider?: string;
  model?: string;
  alias?: string;
  endpoint?: string;
  auth_type?: string;
  api_key?: string;
  request_id?: string;
  response_headers?: Record<string, string[]>;
}

const toFiniteNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const normalizeTokens = (raw: unknown): UsageQueueTokens => {
  if (!raw || typeof raw !== 'object') {
    return { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0 };
  }
  const record = raw as Record<string, unknown>;
  const input = toFiniteNumber(record.input_tokens ?? record.inputTokens);
  const output = toFiniteNumber(record.output_tokens ?? record.outputTokens);
  const reasoning = toFiniteNumber(record.reasoning_tokens ?? record.reasoningTokens);
  const cached = toFiniteNumber(record.cached_tokens ?? record.cachedTokens);
  const totalRaw = toFiniteNumber(record.total_tokens ?? record.totalTokens);
  const total = totalRaw > 0 ? totalRaw : input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cached_tokens: cached,
    total_tokens: total,
  };
};

const normalizeRecord = (raw: unknown): UsageQueueRecord | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'number' ? r.id : undefined;
  const timestamp = typeof r.timestamp === 'string' ? r.timestamp : undefined;
  const model = typeof r.model === 'string' && r.model.trim() ? r.model : undefined;
  return {
    id,
    timestamp,
    latency_ms: toFiniteNumber(r.latency_ms ?? r.latencyMs),
    source: typeof r.source === 'string' ? r.source : undefined,
    auth_index:
      typeof r.auth_index === 'string'
        ? r.auth_index
        : typeof r.authIndex === 'string'
          ? r.authIndex
          : undefined,
    tokens: normalizeTokens(r.tokens),
    failed: r.failed === true,
    provider: typeof r.provider === 'string' ? r.provider : undefined,
    model,
    alias: typeof r.alias === 'string' ? r.alias : undefined,
    endpoint: typeof r.endpoint === 'string' ? r.endpoint : undefined,
    auth_type:
      typeof r.auth_type === 'string'
        ? r.auth_type
        : typeof r.authType === 'string'
          ? r.authType
          : undefined,
    api_key: typeof r.api_key === 'string' ? r.api_key : undefined,
    request_id:
      typeof r.request_id === 'string'
        ? r.request_id
        : typeof r.requestId === 'string'
          ? r.requestId
          : undefined,
    response_headers: undefined,
  };
};

export const usageQueueApi = {
  /** 一次性从后端弹出一条或多条使用记录。 */
  async pop(count = 50): Promise<UsageQueueRecord[]> {
    // NOTE: endpoint path is /usage-queue, not /usage. /usage is an obsolete
    // 404 path that used to (pre-restructure) return records; now
    // /usage-queue is the canonical pop endpoint (see server.go:658
    // mgmt.GET("/usage-queue", ...)).
    //
    // apiClient already prefixes every request with the management base
    // (`<apiBase>/v0/management`), so the path here must be RELATIVE —
    // an absolute `/v0/management/...` would be double-prefixed and 404.
    const data = await apiClient.get<unknown>('/usage-queue', {
      params: { count },
      timeout: USAGE_TIMEOUT_MS,
    });
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => normalizeRecord(item))
      .filter((item): item is UsageQueueRecord => item !== null);
  },
};

/**
 * 持久化 token 用量 API（<dataDir>/token_usage.json on the server）。
 *
 * 数据流：
 *  1. 前端启动时 `getSummary()` — 后端是 source of truth，覆盖本地缓存。
 *  2. 前端 `pollOnce()` 拉到新 record → 调 `mergeDelta()` 把新增 delta 同步到后端。
 *  3. 一次性迁移：`migrateFromLocal()` 把 localStorage 的旧数据 PUT 到后端，
 *     后端 Replace 整个文件，前端再 clear localStorage。
 *
 * 后端对应接口见 fork/cli332-src/internal/api/handlers/management/token_usage.go。
 */
export interface PersistedModelState {
  monthly: Record<
    string,
    {
      input: number;
      output: number;
      reasoning: number;
      cached: number;
      total: number;
      requests: number;
      daily: Record<string, {
        input: number;
        output: number;
        reasoning: number;
        cached: number;
        total: number;
        requests: number;
      }>;
    }
  >;
  lastUpdatedAt: number | null;
  lifetime: {
    input: number;
    output: number;
    reasoning: number;
    cached: number;
    total: number;
    requests: number;
  };
}

export interface UsageSummaryPayload {
  version: 1;
  models: Record<string, PersistedModelState>;
}

export const usageSummaryApi = {
  /** 从后端读全量历史。后端空时返回空 map（首次安装是正常状态）。 */
  async getSummary(): Promise<UsageSummaryPayload> {
    const data = await apiClient.get<unknown>('/usage-summary', {
      timeout: USAGE_TIMEOUT_MS,
    });
    if (!data || typeof data !== 'object') {
      return { version: 1, models: {} };
    }
    return data as UsageSummaryPayload;
  },

  /** 把本次拉取到的新增 record 的 delta 合并到后端。幂等（多次同 delta = 一次结果）。 */
  async mergeDelta(payload: UsageSummaryPayload): Promise<void> {
    await apiClient.post('/usage-summary', payload, { timeout: USAGE_TIMEOUT_MS });
  },

  /** 一次性迁移：把 localStorage 的 dump 直接覆盖到后端。调用方负责之后清 localStorage。 */
  async replace(payload: UsageSummaryPayload): Promise<void> {
    await apiClient.put('/usage-summary', payload, { timeout: USAGE_TIMEOUT_MS });
  },
};
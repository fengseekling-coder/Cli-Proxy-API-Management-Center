/**
 * 模型工具函数
 * 迁移自基线 utils/models.js
 */

import { isRecord } from './helpers';

export interface ModelInfo {
  name: string;
  alias?: string;
  description?: string;
  ownedBy?: string;
}

const MODEL_CATEGORIES = [
  { id: 'gpt', label: 'GPT', patterns: [/gpt/i, /\bo\d\b/i, /\bo\d+\.?/i, /\bchatgpt/i] },
  { id: 'claude', label: 'Claude', patterns: [/claude/i] },
  { id: 'gemini', label: 'Gemini', patterns: [/gemini/i, /\bgai\b/i] },
  { id: 'kimi', label: 'Kimi', patterns: [/kimi/i] },
  { id: 'qwen', label: 'Qwen', patterns: [/qwen/i] },
  { id: 'glm', label: 'GLM', patterns: [/glm/i, /chatglm/i] },
  { id: 'grok', label: 'Grok', patterns: [/grok/i] },
  { id: 'deepseek', label: 'DeepSeek', patterns: [/deepseek/i] },
  { id: 'minimax', label: 'MiniMax', patterns: [/minimax/i, /abab/i] },
];

const matchCategory = (text: string) => {
  for (const category of MODEL_CATEGORIES) {
    if (category.patterns.some((pattern) => pattern.test(text))) {
      return category.id;
    }
  }
  return null;
};

export function normalizeModelList(payload: unknown, { dedupe = false } = {}): ModelInfo[] {
  const toModel = (entry: unknown): ModelInfo | null => {
    if (typeof entry === 'string') {
      return { name: entry };
    }
    if (!isRecord(entry)) {
      return null;
    }
    const name = entry.id || entry.name || entry.model || entry.value;
    if (!name) return null;

    const alias = entry.alias || entry.display_name || entry.displayName;
    const description = entry.description || entry.note || entry.comment;
    const ownedBy = entry.owned_by || entry.ownedBy;
    const model: ModelInfo = { name: String(name) };
    if (alias && alias !== name) {
      model.alias = String(alias);
    }
    if (description) {
      model.description = String(description);
    }
    if (ownedBy) {
      model.ownedBy = String(ownedBy);
    }
    return model;
  };

  let models: (ModelInfo | null)[] = [];

  if (Array.isArray(payload)) {
    models = payload.map(toModel);
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      models = payload.data.map(toModel);
    } else if (Array.isArray(payload.models)) {
      models = payload.models.map(toModel);
    }
  }

  const normalized = models.filter(Boolean) as ModelInfo[];
  if (!dedupe) {
    return normalized;
  }

  // The CLI Proxy API backend republishes upstream /v1/models entries for
  // every configured provider. Two unrelated upstreams can expose models
  // with the same base name (e.g. the codex OAuth credential exposes
  // `gpt-5.4` under owned_by `openai`, while the inroi.shop relay exposes
  // `blue/gpt-5.4` under owned_by `openaiRelay`). Dedupe on the *route*
  // (owned_by + base name) so users still see both rows in the Models page
  // — they route to different upstreams, get billed separately, and count
  // toward different quotas.
  //
  // We also keep the id-prefixed form (e.g. `blue/gpt-5.4`) when the same
  // base name appears with and without a prefix under the same owned_by —
  // the prefixed form is the id clients actually call, so showing it is
  // more useful than the bare upstream id.
  const seen = new Set<string>();
  const accepted: ModelInfo[] = [];
  const dedupeKey = (model: ModelInfo): string => {
    const rawName = String(model?.name ?? '').trim();
    if (!rawName) return '';
    const slashIndex = rawName.indexOf('/');
    const base = slashIndex >= 0 ? rawName.slice(slashIndex + 1) : rawName;
    const ownedBy = String(model?.ownedBy ?? '').trim().toLowerCase();
    return `${ownedBy}::${base.toLowerCase()}`;
  };
  const accept = (model: ModelInfo): boolean => {
    const key = dedupeKey(model);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    accepted.push(model);
    return true;
  };
  normalized.forEach((model) => {
    if (model?.name?.includes('/')) accept(model);
  });
  normalized.forEach((model) => {
    if (!model?.name?.includes('/')) accept(model);
  });
  return accepted;
}

export interface ModelGroup {
  id: string;
  label: string;
  items: ModelInfo[];
}

export function classifyModels(
  models: ModelInfo[] = [],
  { otherLabel = 'Other' } = {}
): ModelGroup[] {
  const groups: ModelGroup[] = MODEL_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    items: [],
  }));

  const otherGroup: ModelGroup = { id: 'other', label: otherLabel, items: [] };

  models.forEach((model) => {
    const name = (model?.name || '').toString();
    const alias = (model?.alias || '').toString();
    const haystack = `${name} ${alias}`.toLowerCase();
    const matchedId = matchCategory(haystack);
    const target = matchedId ? groups.find((group) => group.id === matchedId) : null;

    if (target) {
      target.items.push(model);
    } else {
      otherGroup.items.push(model);
    }
  });

  const populatedGroups = groups.filter((group) => group.items.length > 0);
  if (otherGroup.items.length) {
    populatedGroups.push(otherGroup);
  }

  return populatedGroups;
}

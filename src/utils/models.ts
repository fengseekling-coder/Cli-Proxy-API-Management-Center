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

  // Models can come back from upstream APIs (or the proxy itself) under
  // multiple id forms for the same underlying model — for example the rsx
  // provider exposes `rsx/claude-sonnet-5` (the proxied id the proxy wants
  // clients to use) alongside `claude-sonnet-5` (the raw id published by
  // the upstream host). We dedupe on the *base* name (the segment after
  // the first `/`, or the full id when none) so the UI only surfaces one
  // row per logical model. We pass over the list twice — once preferring
  // the prefixed form, then again allowing the bare id only when no
  // prefixed form was seen — so the user-facing id is stable across
  // reorderings of the upstream response.
  const seen = new Set<string>();
  const accepted: ModelInfo[] = [];
  const accept = (model: ModelInfo): boolean => {
    const key = dedupeKeyFor(model?.name ?? '');
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

/**
 * Returns the dedupe key for a model id. Strips an optional single-segment
 * prefix of the form `<prefix>/<base>` and lowercases the result so callers
 * collapse id variants that differ only in prefix or case. Plain ids (no
 * slash) are returned lowercased as-is.
 */
function dedupeKeyFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const slashIndex = trimmed.indexOf('/');
  const base = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  return base.toLowerCase();
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { TokenDetailModal } from '@/components/tokens/TokenDetailModal';
import { TokenUsageCell } from '@/components/tokens/TokenUsageCell';
import { useAuthStore, useModelsStore, useNotificationStore, useTokenUsageStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import type { ModelInfo } from '@/utils/models';
import styles from './ModelsPage.module.scss';

type DisplayModel = {
  id: string;
  ownedBy: string;
  displayName: string;
};

// Build a lookup that tells us whether a given model id (or its base name
// after stripping a registered provider prefix) is in fact served by one of
// the user-configured `openai-compatibility` providers. The proxy backend
// publishes upstream `/v1/models` entries with the upstream's own owned_by
// (often `openai`), which is misleading because the actual request is
// routed through the configured relay (e.g. inroi.shop). When the user has
// declared an explicit model list for a compatibility provider, we trust
// that declaration over the upstream's owned_by and bucket the model under
// that provider's group.
const deriveOwnedByFromModelInfo = (model: ModelInfo, fallbackId: string): string => {
  // Trust the upstream `owned_by` field — cli-proxy-api's /v1/models now
  // returns distinct values for codex OAuth (`openai`) vs inroi.shop relay
  // (`openaiRelay`), so we don't need a config-side override. When the
  // upstream returns no owned_by, fall back to the model's prefix (e.g.
  // `blue/gpt-5.4` → `blue`).
  if (model.ownedBy) return model.ownedBy;
  const text = `${model.name ?? ''} ${model.alias ?? ''}`.trim();
  const slashMatch = text.match(/^([^/]+)\//);
  if (slashMatch) return slashMatch[1];
  const aliasOwner = model.alias?.split('/')[0]?.trim();
  if (aliasOwner) return aliasOwner;
  const nameOwner = model.name?.split('/')[0]?.trim();
  if (nameOwner) return nameOwner;
  return fallbackId;
};

// Map raw owned_by values to user-friendly provider labels so you can tell at
// a glance which channel each model is being served through. In this setup
// the `openai` upstream is reached exclusively through the user's Codex CLI
// OAuth subscription, so we surface the group under `codex:` to make it clear
// the credential is a Codex team OAuth token rather than a raw OpenAI key.
// `openaiRelay` is the inroi.shop forwarding service — models from that
// provider are exposed under the `blue:` prefix to keep them visually
// distinct from a real OpenAI key.
const OWNER_LABEL_MAP: Record<string, string> = {
  'rsx': 'rsx',
  'ollama-cloud': 'ollama',
  'ark-coding': 'ark',
  'gemini': 'gemini',
  'anthropic': 'rsx',
  'openai': 'codex',
  'openaiRelay': 'blue',
};

// Provider labels that map to a third-party upstream that serves the OpenAI
// official API. Right now `codex` → OpenAI, `ark` → Volcengine coding,
// `gemini` → Google, `ollama` → local. All four are reached via the vendor's
// first-party endpoint (or local daemon), so we tag each with its official
// upstream name.
const OFFICIAL_UPSTREAM_LABEL: Record<string, string> = {
  'codex': 'OpenAI 官方',
  'ark': '火山引擎 官方',
  'gemini': 'Google 官方',
  'ollama': '本机 Ollama',
};

// Provider labels that are reached via a reverse-proxy / forwarding service
// rather than the upstream vendor's own API. Tagging these as "中转站" makes
// it obvious that requests hop through a third party (rsx terminates at a
// paid Claude-mirror host) before reaching the real vendor.
//
// `url` is the homepage of the proxy vendor — when present, the badge is
// rendered as an anchor so a click takes the operator straight to the
// dashboard / billing page for that service.
type ProxyBadge = { label: string; url?: string };
const PROXY_LABEL: Record<string, ProxyBadge> = {
  'rsx': { label: '中转站', url: 'https://rsxermu666.cn' },
  'blue': { label: '中转站', url: 'https://www.inroi.shop' },
};

// Display titles shown in the group header. The grouping key (a short
// lowercase tag from OWNER_LABEL_MAP) is used for the model id prefix and the
// search/filter dropdown, but the human-facing header in ModelsPage can be
// friendlier — e.g. `blue` is surfaced as "Blue OpenAI GPT" to make it clear
// the group is OpenAI-family models served through a paid relay.
const GROUP_DISPLAY_NAME: Record<string, string> = {
  'blue': 'Blue OpenAI GPT',
};

const normalizeProviderLabel = (ownedBy: string): string => {
  const key = (ownedBy ?? '').toLowerCase().trim();
  if (!key) return 'other';
  return OWNER_LABEL_MAP[key] ?? key;
};

// Group-level badges, in priority order:
//   1. Official upstream tag (e.g. "OpenAI 官方" for codex, "Google 官方"
//      for gemini) — request lands on the vendor's first-party endpoint.
//   2. Proxy tag (e.g. "中转站" for rsx) — request hops through a third
//      party before reaching the real vendor. When the proxy vendor has a
//      known homepage (see PROXY_LABEL), the badge is rendered as a link
//      so the operator can jump straight to its dashboard.
// (The earlier "自定义 alias ×N" badge was dropped; user preferred to
//  keep the header uncluttered and let the model id speak for itself.)
type GroupBadge = { label: string; variant: 'Official' | 'Proxy'; url?: string };
const groupBadgesFor = (source: string, _list: DisplayModel[]): GroupBadge[] => {
  const badges: GroupBadge[] = [];
  const official = OFFICIAL_UPSTREAM_LABEL[source];
  if (official) badges.push({ label: official, variant: 'Official' });
  const proxy = PROXY_LABEL[source];
  if (proxy) badges.push({ label: proxy.label, variant: 'Proxy', url: proxy.url });
  return badges;
};

const toDisplayModel = (model: ModelInfo): DisplayModel => {
  const name = model.name ?? '';
  const ownedBy = deriveOwnedByFromModelInfo(model, name);
  const providerLabel = normalizeProviderLabel(ownedBy);
  const bareName = name.includes('/') ? name.split('/').slice(1).join('/') : name;
  const displayName = providerLabel && providerLabel !== 'other'
    ? `${providerLabel}:${bareName}`
    : bareName;
  return {
    id: name,
    ownedBy: providerLabel,
    displayName,
  };
};

const matchesQuery = (model: DisplayModel, lowerQuery: string): boolean => {
  if (!lowerQuery) return true;
  const haystack = `${model.id} ${model.displayName} ${model.ownedBy}`.toLowerCase();
  return haystack.includes(lowerQuery);
};

// Grouping key is the normalized provider label (no regex guessing).
const groupKeyOf = (model: DisplayModel): string => model.ownedBy || 'other';

export function ModelsPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const showNotification = useNotificationStore((state) => state.showNotification);

  const models = useModelsStore((state) => state.models);
  const modelsLoading = useModelsStore((state) => state.loading);
  const modelsError = useModelsStore((state) => state.error);
  const fetchModels = useModelsStore((state) => state.fetchModels);

  const resolveApiKeysForModels = useApiKeysForModels();

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [detailModel, setDetailModel] = useState<string | null>(null);

  // 后端使用量轮询：连接就绪后启动，断开后停止。
  const startTokenUsage = useTokenUsageStore((state) => state.start);
  const stopTokenUsage = useTokenUsageStore((state) => state.stop);
  useEffect(() => {
    if (connectionStatus === 'connected') {
      startTokenUsage();
    }
    return () => {
      stopTokenUsage();
    };
  }, [connectionStatus, startTokenUsage, stopTokenUsage]);

  // 监听 TokenUsageCell 自定义点击事件，避免把 modelKey 一路 props 透传。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ modelKey: string }>).detail;
      if (detail?.modelKey) setDetailModel(detail.modelKey);
    };
    document.addEventListener('token-cell-click', handler as EventListener);
    return () => document.removeEventListener('token-cell-click', handler as EventListener);
  }, []);

  const load = useCallback(
    async (forceRefresh = false) => {
      if (connectionStatus !== 'connected' || !apiBase) return;
      try {
        const apiKeys = await resolveApiKeysForModels();
        const primaryKey = apiKeys[0];
        await fetchModels(apiBase, primaryKey, forceRefresh);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === 'string' ? err : '';
        showNotification(
          `${t('models.error_title')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    },
    [connectionStatus, apiBase, fetchModels, resolveApiKeysForModels, showNotification, t]
  );

  useEffect(() => {
    if (connectionStatus === 'connected' && models.length === 0 && !modelsLoading) {
      void load(false);
    }
  }, [connectionStatus, models.length, modelsLoading, load]);

  const displayModels: DisplayModel[] = useMemo(() => {
    if (models.length === 0) return [];
    return models.map((m) => toDisplayModel(m));
  }, [models]);

  const providerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of displayModels) {
      const key = groupKeyOf(m);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [displayModels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return displayModels.filter((model) => {
      if (!matchesQuery(model, q)) return false;
      if (providerFilter !== 'all') {
        if (groupKeyOf(model) !== providerFilter) return false;
      }
      return true;
    });
  }, [displayModels, query, providerFilter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DisplayModel[]>();
    for (const m of filtered) {
      const key = groupKeyOf(m);
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
      showNotification(t('notification.data_refreshed'), 'success');
    } catch {
      // notification already shown in load()
    } finally {
      setRefreshing(false);
    }
  };

  const isLoading = modelsLoading || refreshing;
  const showEmpty = !isLoading && modelsError == null && displayModels.length === 0;
  const showError = modelsError != null && !isLoading;
  const showTable = !isLoading && displayModels.length > 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>{t('models.endpoint')}</span>
          <h1 className={styles.title}>{t('models.title')}</h1>
          <p className={styles.subtitle}>
            {t('models.subtitle', { endpoint: t('models.endpoint') })}
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void handleRefresh()}
          disabled={isLoading}
          title={t('models.refresh')}
        >
          <IconRefreshCw size={16} />
          <span>{refreshing ? t('models.refreshing') : t('models.refresh')}</span>
        </button>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('models.search_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!showTable && !showEmpty}
          />
        </div>
        <div className={styles.filterWrap}>
          <select
            className={styles.filterSelect}
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            disabled={!showTable && !showEmpty}
          >
            <option value="all">{t('models.provider_filter_all')}</option>
            {providerOptions.map(([key, count]) => (
              <option key={key} value={key}>
                {GROUP_DISPLAY_NAME[key] ?? key} ({count})
              </option>
            ))}
          </select>
        </div>
        <div className={styles.counts}>
          <span className={styles.countTotal}>
            {t('models.total_label', { count: displayModels.length })}
          </span>
          {query.trim() || providerFilter !== 'all' ? (
            <span className={styles.countFiltered}>
              {t('models.filtered_label', { count: filtered.length })}
            </span>
          ) : null}
        </div>
      </div>

      {isLoading && (
        <div className={styles.stateBlock} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          <span>{t('models.loading')}</span>
        </div>
      )}

      {showError && (
        <div className={`${styles.stateBlock} ${styles.errorBlock}`} role="alert">
          <div className={styles.errorTitle}>{t('models.error_title')}</div>
          <div className={styles.errorMsg}>
            {t('models.error_desc', { message: modelsError ?? '' })}
          </div>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={() => void handleRefresh()}
          >
            {t('models.retry')}
          </button>
        </div>
      )}

      {showEmpty && (
        <div className={styles.stateBlock}>
          <div className={styles.emptyTitle}>{t('models.empty_title')}</div>
          <div className={styles.emptyDesc}>{t('models.empty_desc')}</div>
        </div>
      )}

      {showTable && grouped.length > 0 && (
        <div className={styles.groups}>
          {grouped.map(([source, list]) => {
            const badges = groupBadgesFor(source, list);
            return (
            <section key={source} className={styles.group}>
              <header className={styles.groupHeader}>
                <div className={styles.groupTitle}>
                  <span className={styles.groupName}>
                    {GROUP_DISPLAY_NAME[source] ?? source}
                  </span>
                  <span className={styles.groupCount}>{list.length}</span>
                </div>
                {badges.map((badge) => {
                  const tooltip = badge.variant === 'Proxy'
                    ? badge.url
                      ? t('models.proxy_tooltip_with_url', {
                          defaultValue:
                            'Reverse-proxied via a third-party forwarding service. Click to open the provider homepage.',
                          url: badge.url,
                        })
                      : t('models.proxy_tooltip', {
                          defaultValue:
                            'Reverse-proxied via a third-party forwarding service before reaching the upstream vendor.',
                        })
                    : t('models.codex_official_tooltip', {
                        defaultValue:
                          'Models in this group hit the upstream vendor API directly with no intermediate proxy.',
                      });
                  const className = `${styles.groupBadge} ${styles[`groupBadge${badge.variant}`] ?? ''}${badge.url ? ` ${styles.groupBadgeLink}` : ''}`;
                  if (badge.url) {
                    return (
                      <a
                        key={badge.label}
                        className={className}
                        href={badge.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={tooltip}
                      >
                        {badge.label} <span className={styles.groupBadgeUrl}>{badge.url}</span>
                      </a>
                    );
                  }
                  return (
                    <span key={badge.label} className={className} title={tooltip}>
                      {badge.label}
                    </span>
                  );
                })}
              </header>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colName}>{t('models.table_name')}</th>
                      <th className={styles.colSource}>{t('models.table_source', { defaultValue: 'Source' })}</th>
                      <th className={styles.colActions}>
                        {t('models.table_tokens', { defaultValue: '本月 Token' })}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => {
                      const sourceLabel = m.ownedBy || t('models.no_provider');
                      const sourceTitle = GROUP_DISPLAY_NAME[source] ?? source;
                      return (
                        <tr key={`${source}-${m.id}`}>
                          <td className={styles.colName}>
                            <code className={styles.modelId}>{m.displayName}</code>
                          </td>
                          <td className={styles.colSource}>
                            <span className={styles.providerBadge} title={sourceTitle}>
                              {sourceLabel}
                            </span>
                          </td>
                          <td className={styles.colActions}>
                            <TokenUsageCell modelKey={m.id} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            );
          })}
        </div>
      )}

      <TokenDetailModal
        modelKey={detailModel ?? ''}
        open={detailModel !== null}
        onClose={() => setDetailModel(null)}
      />
    </div>
  );
}
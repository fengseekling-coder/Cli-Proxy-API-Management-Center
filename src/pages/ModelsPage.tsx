import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useAuthStore, useModelsStore, useNotificationStore } from '@/stores';
import { useApiKeysForModels } from '@/hooks/useApiKeysForModels';
import type { ModelInfo } from '@/utils/models';
import styles from './ModelsPage.module.scss';

type DisplayModel = {
  id: string;
  ownedBy: string;
  displayName: string;
};

const deriveOwnedByFromModelInfo = (model: ModelInfo, fallbackId: string): string => {
  // Prefer the owned_by field returned by the upstream /v1/models response —
  // it's the source of truth for which channel actually serves the model.
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
const OWNER_LABEL_MAP: Record<string, string> = {
  'rsx': 'rsx',
  'ollama-cloud': 'ollama',
  'ark-coding': 'ark',
  'gemini': 'gemini',
  'anthropic': 'rsx',
  'openai': 'codex',
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
const PROXY_LABEL: Record<string, string> = {
  'rsx': '中转站',
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
//      party before reaching the real vendor.
// (The earlier "自定义 alias ×N" badge was dropped; user preferred to
//  keep the header uncluttered and let the model id speak for itself.)
const groupBadgesFor = (source: string, _list: DisplayModel[]): string[] => {
  const badges: string[] = [];
  const official = OFFICIAL_UPSTREAM_LABEL[source];
  if (official) badges.push(official);
  const proxy = PROXY_LABEL[source];
  if (proxy) badges.push(proxy);
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
    // useModelsStore normalizes payloads to ModelInfo[]; we re-derive ownedBy from name/alias.
    return models.map(toDisplayModel);
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

  const handleCopy = useCallback(
    async (id: string) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(id);
        } else {
          const ta = document.createElement('textarea');
          ta.value = id;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showNotification(t('models.copied'), 'success');
      } catch {
        showNotification(t('models.copy_failed'), 'error');
      }
    },
    [t]
  );

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
                {key} ({count})
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
                <span className={styles.groupName}>{source}</span>
                <span className={styles.groupCount}>{list.length}</span>
                {badges.map((label) => {
                  const variant = label === PROXY_LABEL['rsx']
                    ? 'Proxy'
                    : 'Official';
                  const tooltip = variant === 'Proxy'
                    ? t('models.proxy_tooltip', {
                        defaultValue:
                          'Reverse-proxied via a third-party forwarding service before reaching the upstream vendor.',
                      })
                    : t('models.codex_official_tooltip', {
                        defaultValue:
                          'Models in this group hit the upstream vendor API directly with no intermediate proxy.',
                      });
                  return (
                    <span
                      key={label}
                      className={`${styles.groupBadge} ${styles[`groupBadge${variant}`] ?? ''}`}
                      title={tooltip}
                    >
                      {label}
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
                      <th className={styles.colActions} aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => {
                      const sourceLabel = m.ownedBy || t('models.no_provider');
                      return (
                        <tr key={`${source}-${m.id}`}>
                          <td className={styles.colName}>
                            <code className={styles.modelId}>{m.displayName}</code>
                          </td>
                          <td className={styles.colSource}>
                            <span className={styles.providerBadge}>
                              {sourceLabel}
                            </span>
                          </td>
                          <td className={styles.colActions}>
                            <button
                              type="button"
                              className={styles.copyBtn}
                              onClick={() => void handleCopy(m.id)}
                              title={t('models.copy_id')}
                            >
                              {t('models.copy_id')}
                            </button>
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
    </div>
  );
}
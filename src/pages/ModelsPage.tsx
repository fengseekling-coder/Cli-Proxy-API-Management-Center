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
  created: number | null;
  alias: string | null;
};

const formatCreatedAt = (epochSeconds: number | null): string => {
  if (!epochSeconds) return '—';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
};

const deriveOwnedByFromModelInfo = (model: ModelInfo, fallbackId: string): string => {
  const text = `${model.name ?? ''} ${model.alias ?? ''}`.trim();
  const slashMatch = text.match(/^([^/]+)\//);
  if (slashMatch) return slashMatch[1];
  const aliasOwner = model.alias?.split('/')[0]?.trim();
  if (aliasOwner) return aliasOwner;
  const nameOwner = model.name?.split('/')[0]?.trim();
  if (nameOwner) return nameOwner;
  return fallbackId;
};

const toDisplayModel = (model: ModelInfo): DisplayModel => {
  const name = model.name ?? '';
  const ownedBy = deriveOwnedByFromModelInfo(model, name);
  return {
    id: name,
    ownedBy,
    created: null,
    alias: model.alias ?? null,
  };
};

const matchesQuery = (model: DisplayModel, lowerQuery: string): boolean => {
  if (!lowerQuery) return true;
  const haystack = `${model.id} ${model.ownedBy} ${model.alias ?? ''}`.toLowerCase();
  return haystack.includes(lowerQuery);
};

const PROVIDER_BUCKETS: Array<{ key: string; match: (text: string) => boolean; fallback?: string }> = [
  { key: 'openai', match: (t) => /openai|gpt|o\d|^o\d|chatgpt|dall-?e|gpt-image/i.test(t) },
  { key: 'anthropic', match: (t) => /claude|anthropic/i.test(t) },
  { key: 'gemini', match: (t) => /gemini|gai/i.test(t) },
  { key: 'ark', match: (t) => /\bark\b|volces|doubao|ark-coding|deepseek/i.test(t) },
  { key: 'kimi', match: (t) => /kimi|moonshot/i.test(t) },
  { key: 'glm', match: (t) => /glm|chatglm|zhipu/i.test(t) },
  { key: 'qwen', match: (t) => /qwen|tongyi/i.test(t) },
  { key: 'ollama', match: (t) => /ollama/i.test(t) },
];

const bucketProvider = (text: string): string => {
  const lower = text.toLowerCase();
  for (const bucket of PROVIDER_BUCKETS) {
    if (bucket.match(lower)) return bucket.key;
  }
  return text || 'other';
};

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
      const key = m.ownedBy ? bucketProvider(m.ownedBy) : 'other';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [displayModels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return displayModels.filter((model) => {
      if (!matchesQuery(model, q)) return false;
      if (providerFilter !== 'all') {
        const bucket = model.ownedBy ? bucketProvider(model.ownedBy) : 'other';
        if (bucket !== providerFilter) return false;
      }
      return true;
    });
  }, [displayModels, query, providerFilter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DisplayModel[]>();
    for (const m of filtered) {
      const key = m.ownedBy ? bucketProvider(m.ownedBy) : 'other';
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
          {grouped.map(([provider, list]) => (
            <section key={provider} className={styles.group}>
              <header className={styles.groupHeader}>
                <span className={styles.groupName}>{provider}</span>
                <span className={styles.groupCount}>{list.length}</span>
              </header>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colName}>{t('models.table_name')}</th>
                      <th className={styles.colProvider}>{t('models.table_provider')}</th>
                      <th className={styles.colAlias}>{t('models.table_alias')}</th>
                      <th className={styles.colCreated}>{t('models.table_created')}</th>
                      <th className={styles.colActions} aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => {
                      const hasAlias = !!m.alias && m.alias !== m.id;
                      return (
                        <tr key={`${provider}-${m.id}`}>
                          <td className={styles.colName}>
                            <code className={styles.modelId}>{m.id}</code>
                          </td>
                          <td className={styles.colProvider}>
                            <span className={styles.providerBadge}>
                              {m.ownedBy || t('models.no_provider')}
                            </span>
                          </td>
                          <td className={styles.colAlias}>
                            {hasAlias ? (
                              <span className={styles.aliasText}>{m.alias}</span>
                            ) : (
                              <span className={styles.aliasEmpty}>{t('models.no_alias')}</span>
                            )}
                          </td>
                          <td className={styles.colCreated}>
                            <span className={styles.createdText}>
                              {formatCreatedAt(m.created)}
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
          ))}
        </div>
      )}
    </div>
  );
}
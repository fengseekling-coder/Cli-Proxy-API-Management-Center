import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CODEX_CONFIG } from '@/components/quota';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { authFilesApi } from '@/services/api';
import { isCodexFile, isDisabledAuthFile } from '@/utils/quota';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/ModelsPage.module.scss';

const QUOTA_HIGH_THRESHOLD = 70;
const QUOTA_MEDIUM_THRESHOLD = 30;

// Aggregate across every codex auth file in the quota store. Worst-case
// wins: if any file is still loading or errored, surface that to the
// operator (they need to know the full picture is unknown). If multiple
// files have success data, take the smallest remaining % so the badge
// reflects the bottleneck — operators route around the most-constrained
// file first.
type CodexAggregate = {
  status: 'idle' | 'loading' | 'partial' | 'success' | 'error';
  remaining: number | null;
  windowLabel: string | null;
  resetLabel: string | null;
  loadingCount: number;
  errorCount: number;
  successCount: number;
  totalFiles: number;
  errorMessage: string | null;
};

const clampPercent = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
};

const resolveFillClass = (remaining: number | null): string => {
  if (remaining === null) return styles.codexGroupQuotaFillUnknown ?? '';
  if (remaining >= QUOTA_HIGH_THRESHOLD) return styles.codexGroupQuotaFillHigh ?? '';
  if (remaining >= QUOTA_MEDIUM_THRESHOLD) return styles.codexGroupQuotaFillMedium ?? '';
  return styles.codexGroupQuotaFillLow ?? '';
};

const aggregateCodexQuotas = (
  quotas: Record<string, CodexQuotaState | undefined>
): CodexAggregate => {
  const entries = Object.values(quotas);
  const totalFiles = entries.length;
  let loadingCount = 0;
  let errorCount = 0;
  let successCount = 0;
  let errorMessage: string | null = null;
  let worstRemaining: number | null = null;
  let windowLabel: string | null = null;
  let resetLabel: string | null = null;

  for (const q of entries) {
    if (!q) continue;
    if (q.status === 'loading') {
      loadingCount += 1;
      continue;
    }
    if (q.status === 'error') {
      errorCount += 1;
      if (!errorMessage) errorMessage = q.error ?? null;
      continue;
    }
    if (q.status !== 'success') continue;
    const first = q.windows?.[0];
    if (!first) continue;
    const used = clampPercent(first.usedPercent);
    const remaining = used === null ? null : Math.max(0, Math.min(100, 100 - used));
    if (remaining === null) continue;
    successCount += 1;
    if (worstRemaining === null || remaining < worstRemaining) {
      worstRemaining = remaining;
      windowLabel = first.labelKey
        ? null // resolved by caller with t()
        : first.label;
      resetLabel = first.resetLabel ?? null;
    }
  }

  let status: CodexAggregate['status'];
  if (loadingCount > 0 && successCount === 0 && errorCount === 0) status = 'loading';
  else if (loadingCount > 0 || (successCount > 0 && (loadingCount > 0 || errorCount > 0)))
    status = 'partial';
  else if (errorCount > 0 && successCount === 0) status = 'error';
  else if (successCount > 0) status = 'success';
  else status = 'idle';

  return {
    status,
    remaining: worstRemaining,
    windowLabel,
    resetLabel,
    loadingCount,
    errorCount,
    successCount,
    totalFiles,
    errorMessage,
  };
};

export function CodexGroupQuotaBadge() {
  const { t } = useTranslation();
  const codexQuotaMap = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  // We need the full AuthFileItem (with auth_index) when the badge lives
  // on ModelsPage, since the quota store alone doesn't carry the index.
  // Cache the most-recent fetch's file list so subsequent refresh clicks
  // don't have to re-list /auth-files.
  const lastCodexFilesRef = useRef<AuthFileItem[]>([]);

  const aggregate = aggregateCodexQuotas(codexQuotaMap);

  const refresh = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    let entries = Object.entries(codexQuotaMap);
    let codexFiles: AuthFileItem[] = lastCodexFilesRef.current;

    if (entries.length === 0 && codexFiles.length === 0) {
      // ModelsPage doesn't keep an auth-files cache, so the quota store
      // starts empty here. Pull the file list once and filter down to the
      // codex files so we have something concrete to fetch against.
      try {
        const response = await authFilesApi.list();
        const files = Array.isArray(response?.files) ? response.files : [];
        codexFiles = files.filter(
          (f: AuthFileItem) => isCodexFile(f) && !isDisabledAuthFile(f) && !f.runtimeOnly
        );
        lastCodexFilesRef.current = codexFiles;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        // surface as a single pseudo-entry so the badge falls into error state
        setCodexQuota((prev) => ({
          ...prev,
          __models_fetch_error__: CODEX_CONFIG.buildErrorState(message) as CodexQuotaState,
        }));
        return;
      }
    }
    if (entries.length === 0 && codexFiles.length === 0) return;
    if (entries.length === 0) {
      entries = codexFiles.map((f) => [f.name, undefined as unknown as CodexQuotaState]);
    }

    setCodexQuota((prev) => {
      const next = { ...prev };
      for (const [name, q] of entries) {
        if (q && q.status === 'loading') continue;
        next[name] = CODEX_CONFIG.buildLoadingState() as CodexQuotaState;
      }
      return next;
    });

    await Promise.all(
      entries.map(async ([name], index) => {
        const file: AuthFileItem = codexFiles[index] || ({ name } as AuthFileItem);
        try {
          const data = (await CODEX_CONFIG.fetchQuota(file, t as TFunction)) as Awaited<
            ReturnType<typeof CODEX_CONFIG.fetchQuota>
          >;
          setCodexQuota((prev) => ({
            ...prev,
            [name]: CODEX_CONFIG.buildSuccessState(data) as CodexQuotaState,
          }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          setCodexQuota((prev) => ({
            ...prev,
            [name]: CODEX_CONFIG.buildErrorState(message) as CodexQuotaState,
          }));
        }
      })
    );
  }, [codexQuotaMap, connectionStatus, setCodexQuota, t]);

  // Clean up the synthetic error sentinel once a real fetch has happened.
  useEffect(() => {
    if (codexQuotaMap['__models_fetch_error__']) {
      setCodexQuota((prev) => {
        if (!('__models_fetch_error__' in prev)) return prev;
        const next = { ...prev };
        delete next.__models_fetch_error__;
        return next;
      });
    }
  }, [codexQuotaMap, setCodexQuota]);

  const remaining = aggregate.remaining;
  const fillClass = resolveFillClass(remaining);
  const fillStyle: CSSProperties | undefined =
    remaining === null ? undefined : { width: `${Math.round(remaining)}%` };

  const fileSummary =
    aggregate.totalFiles > 0
      ? t('codex_quota.files_count', { count: aggregate.totalFiles, defaultValue: `${aggregate.totalFiles} 个账号` })
      : null;

  if (aggregate.status === 'loading') {
    return (
      <span
        className={`${styles.codexGroupQuotaBadge} ${styles.codexGroupQuotaBadgeLoading}`}
        title={t('codex_quota.loading', { defaultValue: '加载中…' })}
      >
        <LoadingSpinner size={12} className={styles.codexGroupQuotaBadgeSpinner} />
        <span className={styles.codexGroupQuotaBadgeLabel}>
          {t('codex_quota.loading_short', { defaultValue: '额度' })}…
        </span>
      </span>
    );
  }

  if (aggregate.status === 'error') {
    return (
      <button
        type="button"
        className={`${styles.codexGroupQuotaBadge} ${styles.codexGroupQuotaBadgeError} ${styles.codexGroupQuotaBadgeAction}`}
        onClick={() => void refresh()}
        title={
          aggregate.errorMessage ||
          t('codex_quota.load_failed_short', { defaultValue: '点击重新加载额度' })
        }
      >
        <span className={styles.codexGroupQuotaBadgeDot} aria-hidden="true" />
        <span className={styles.codexGroupQuotaBadgeLabel}>
          {t('codex_quota.error_short', { defaultValue: '额度' })}
        </span>
        <IconRefreshCw size={11} className={styles.codexGroupQuotaBadgeIcon} />
      </button>
    );
  }

  if (aggregate.status === 'success' && remaining !== null) {
    const percentLabel = `${Math.round(remaining)}%`;
    const tooltipParts = [percentLabel];
    if (aggregate.windowLabel) tooltipParts.push(aggregate.windowLabel);
    if (aggregate.resetLabel) tooltipParts.push(aggregate.resetLabel);
    if (fileSummary) tooltipParts.push(fileSummary);
    if (aggregate.errorCount > 0) {
      tooltipParts.push(
        t('codex_quota.partial_error_count', {
          count: aggregate.errorCount,
          defaultValue: `${aggregate.errorCount} 个账号加载失败`,
        })
      );
    }
    return (
      <button
        type="button"
        className={`${styles.codexGroupQuotaBadge} ${styles.codexGroupQuotaBadgeSuccess} ${styles.codexGroupQuotaBadgeAction}`}
        onClick={() => void refresh()}
        title={tooltipParts.join(' · ')}
      >
        <span className={styles.codexGroupQuotaBadgeLabel}>
          {t('codex_quota.quota_short', { defaultValue: '额度' })}
        </span>
        <span className={styles.codexGroupQuotaBadgeTrack} aria-hidden="true">
          <span className={`${styles.codexGroupQuotaBadgeFill} ${fillClass}`} style={fillStyle} />
        </span>
        <span className={styles.codexGroupQuotaBadgePercent}>{percentLabel}</span>
      </button>
    );
  }

  // idle / no data — provide a discoverable refresh action
  return (
    <button
      type="button"
      className={`${styles.codexGroupQuotaBadge} ${styles.codexGroupQuotaBadgeIdle} ${styles.codexGroupQuotaBadgeAction}`}
      onClick={() => void refresh()}
      title={t('codex_quota.idle_hint_short', { defaultValue: '点击查询 Codex 额度' })}
    >
      <IconRefreshCw size={11} className={styles.codexGroupQuotaBadgeIcon} />
      <span className={styles.codexGroupQuotaBadgeLabel}>
        {t('codex_quota.idle_short', { defaultValue: '额度' })}
      </span>
    </button>
  );
}
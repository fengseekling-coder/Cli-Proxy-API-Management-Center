import { useCallback, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CODEX_CONFIG } from '@/components/quota';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { isCodexFile } from '@/utils/quota';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/AuthFilesPage.module.scss';

const QUOTA_HIGH_THRESHOLD = 70;
const QUOTA_MEDIUM_THRESHOLD = 30;

const clampPercent = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
};

const resolveFillClass = (remaining: number | null): string => {
  if (remaining === null) return styles.codexQuotaBarFillUnknown ?? '';
  if (remaining >= QUOTA_HIGH_THRESHOLD) return styles.codexQuotaBarFillHigh ?? '';
  if (remaining >= QUOTA_MEDIUM_THRESHOLD) return styles.codexQuotaBarFillMedium ?? '';
  return styles.codexQuotaBarFillLow ?? '';
};

type CodexQuotaBadgeProps = {
  file: AuthFileItem;
};

export function CodexQuotaBadge({ file }: CodexQuotaBadgeProps) {
  const { t } = useTranslation();
  const quota = useQuotaStore((state) => state.codexQuota[file.name] as CodexQuotaState | undefined);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);

  const refresh = useCallback(async () => {
    if (!isCodexFile(file)) return;
    if (file.disabled) return;
    if (quota?.status === 'loading') return;
    setCodexQuota((prev) => ({ ...prev, [file.name]: CODEX_CONFIG.buildLoadingState() }));
    try {
      const data = (await CODEX_CONFIG.fetchQuota(file, t as TFunction)) as Awaited<
        ReturnType<typeof CODEX_CONFIG.fetchQuota>
      >;
      setCodexQuota((prev) => ({ ...prev, [file.name]: CODEX_CONFIG.buildSuccessState(data) }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      setCodexQuota((prev) => ({
        ...prev,
        [file.name]: CODEX_CONFIG.buildErrorState(message),
      }));
    }
  }, [file, quota?.status, setCodexQuota, t]);

  if (!isCodexFile(file)) return null;

  const status = quota?.status ?? 'idle';
  const firstWindow = quota?.windows?.[0];
  const usedPercent = clampPercent(firstWindow?.usedPercent ?? null);
  const remaining = usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
  const fillClass = resolveFillClass(remaining);
  const fillStyle: CSSProperties | undefined =
    remaining === null ? undefined : { width: `${Math.round(remaining)}%` };

  if (status === 'loading') {
    return (
      <span
        className={`${styles.codexQuotaBadge} ${styles.codexQuotaBadgeLoading}`}
        title={t('codex_quota.loading', { defaultValue: '加载中…' })}
      >
        <LoadingSpinner size={12} className={styles.codexQuotaBadgeSpinner} />
        <span className={styles.codexQuotaBadgeLabel}>{t('codex_quota.loading_short', { defaultValue: '额度' })}…</span>
      </span>
    );
  }

  if (status === 'error') {
    return (
      <button
        type="button"
        className={`${styles.codexQuotaBadge} ${styles.codexQuotaBadgeError} ${styles.codexQuotaBadgeAction}`}
        onClick={() => void refresh()}
        title={quota?.error || t('codex_quota.load_failed_short', { defaultValue: '点击重新加载额度' })}
      >
        <span className={styles.codexQuotaBadgeDot} aria-hidden="true" />
        <span className={styles.codexQuotaBadgeLabel}>{t('codex_quota.error_short', { defaultValue: '额度' })}</span>
        <IconRefreshCw size={11} className={styles.codexQuotaBadgeIcon} />
      </button>
    );
  }

  if (status === 'success' && firstWindow) {
    const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
    const windowLabel = firstWindow.labelKey
      ? t(firstWindow.labelKey, firstWindow.labelParams as Record<string, string | number>)
      : firstWindow.label;
    const tooltip = `${windowLabel}: ${percentLabel}${firstWindow.resetLabel ? ` · ${firstWindow.resetLabel}` : ''}`;
    return (
      <button
        type="button"
        className={`${styles.codexQuotaBadge} ${styles.codexQuotaBadgeSuccess} ${styles.codexQuotaBadgeAction}`}
        onClick={() => void refresh()}
        title={tooltip}
      >
        <span className={styles.codexQuotaBadgeLabel}>{t('codex_quota.quota_short', { defaultValue: '额度' })}</span>
        <span className={styles.codexQuotaBadgeTrack} aria-hidden="true">
          <span className={`${styles.codexQuotaBadgeFill} ${fillClass}`} style={fillStyle} />
        </span>
        <span className={styles.codexQuotaBadgePercent}>{percentLabel}</span>
      </button>
    );
  }

  // idle / 未拉取：提供一个轻量"查看额度"按钮，用户可主动触发
  return (
    <button
      type="button"
      className={`${styles.codexQuotaBadge} ${styles.codexQuotaBadgeIdle} ${styles.codexQuotaBadgeAction}`}
      onClick={() => void refresh()}
      title={t('codex_quota.idle_hint_short', { defaultValue: '点击查询 Codex 额度' })}
    >
      <IconRefreshCw size={11} className={styles.codexQuotaBadgeIcon} />
      <span className={styles.codexQuotaBadgeLabel}>{t('codex_quota.idle_short', { defaultValue: '额度' })}</span>
    </button>
  );
}
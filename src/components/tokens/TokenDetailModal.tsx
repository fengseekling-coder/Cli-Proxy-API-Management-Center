/**
 * 模型 token 消耗详情弹窗。
 *
 * - 顶部：模型元信息 + 当前自然月总览
 * - 中部：近 30 天趋势图（SVG 自绘，避免引入图表库）
 * - 下方：按日 / 按月 / 按年 三个 tab 的历史表
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconChartLine, IconRefreshCw, IconTimer, IconTrash2, IconX } from '@/components/ui/icons';
import {
  expandLastDays,
  expandLastMonths,
  expandLastYears,
  type TokenBreakdown,
  useTokenUsageStore,
} from '@/stores';
import { resolveTokenizerForModel } from '@/utils/tokenizer';
import styles from './TokenDetailModal.module.scss';

type Range = 'day' | 'month' | 'year';

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: 'compact',
});

const formatTokens = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  return numberFormatter.format(Math.round(value));
};

const formatCompact = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) return '0';
  if (Math.abs(value) >= 1000) {
    return compactFormatter.format(value);
  }
  return numberFormatter.format(Math.round(value));
};

const monthKeyOf = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const shortDateLabel = (key: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${m[2]}/${m[3]}`;
};

const shortMonthLabel = (key: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${m[1]}-${m[2]}`;
};

const TREND_DAYS = 30;

export interface TokenDetailModalProps {
  modelKey: string;
  open: boolean;
  onClose: () => void;
}

export function TokenDetailModal({ modelKey, open, onClose }: TokenDetailModalProps) {
  const { t } = useTranslation();
  const profile = useMemo(() => resolveTokenizerForModel(modelKey), [modelKey]);
  const state = useTokenUsageStore((s) => s.models[modelKey]);
  const currentMonth = useMemo(() => monthKeyOf(new Date()), []);
  const monthly = state?.monthly[currentMonth];
  const lastUpdatedAt = state?.lastUpdatedAt ?? null;
  const pollOnce = useTokenUsageStore((s) => s.pollOnce);
  const resetModel = useTokenUsageStore((s) => s.resetModel);
  const loading = useTokenUsageStore((s) => s.loading);

  const [range, setRange] = useState<Range>('day');

  // 锁定 body 滚动条，避免弹窗背后的页面跟着滚。
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, onClose]);

  const trendData = useMemo<TrendPoint[]>(() => {
    if (!open) return [];
    const snapshot = useTokenUsageStore.getState();
    if (range === 'day') {
      return expandLastDays(snapshot, modelKey, TREND_DAYS).map(
        ({ dateKey, bucket }: { dateKey: string; bucket: TokenBreakdown }) => ({
          key: dateKey,
          bucket,
        })
      );
    }
    if (range === 'month') {
      return expandLastMonths(snapshot, modelKey, 12).map(
        ({ monthKey, bucket }: { monthKey: string; bucket: TokenBreakdown }) => ({
          key: monthKey,
          bucket,
        })
      );
    }
    return expandLastYears(snapshot, modelKey, 5).map(
      ({ yearKey, bucket }: { yearKey: string; bucket: TokenBreakdown }) => ({
        key: yearKey,
        bucket,
      })
    );
  }, [range, modelKey, open]);

  const lifetime = state?.lifetime;

  const dayBreakdown = useMemo<TokenBreakdown>(() => {
    return monthly
      ? {
          input: monthly.input,
          output: monthly.output,
          reasoning: monthly.reasoning,
          cached: monthly.cached,
          total: monthly.total,
          requests: monthly.requests,
        }
      : { input: 0, output: 0, reasoning: 0, cached: 0, total: 0, requests: 0 };
  }, [monthly]);

  if (!open) return null;

  const modalContent = (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-detail-title"
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <span className={styles.eyebrow}>{t('models.token_modal.eyebrow')}</span>
            <h2 id="token-detail-title" className={styles.title}>
              <code className={styles.modelId}>{modelKey}</code>
            </h2>
            <div className={styles.profile}>
              <IconChartLine size={12} aria-hidden="true" />
              <span>{profile.label}</span>
              {profile.note && <span className={styles.profileNote}>· {profile.note}</span>}
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void pollOnce()}
              disabled={loading}
              title={t('models.token_modal.refresh')}
            >
              <IconRefreshCw size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.danger}`}
              onClick={() => {
                if (window.confirm(t('models.token_modal.reset_confirm'))) {
                  resetModel(modelKey);
                }
              }}
              title={t('models.token_modal.reset')}
            >
              <IconTrash2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onClose}
              title={t('common.close')}
            >
              <IconX size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        <section className={styles.summaryGrid}>
          <SummaryCard
            label={t('models.token_modal.month_total', { defaultValue: '本月累计' })}
            primary={formatCompactTokens(dayBreakdown.total)}
            hint={t('models.token_modal.requests', {
              defaultValue: '请求数 {{count}}',
              count: numberFormatter.format(dayBreakdown.requests),
            })}
          />
          <SummaryCard
            label={t('models.token_modal.input', { defaultValue: '输入 token' })}
            primary={formatCompactTokens(dayBreakdown.input)}
            hint={t('models.token_modal.cached_short', {
              defaultValue: '缓存命中 {{count}}',
              count: formatCompactTokens(dayBreakdown.cached),
            })}
          />
          <SummaryCard
            label={t('models.token_modal.output', { defaultValue: '输出 token' })}
            primary={formatCompactTokens(dayBreakdown.output)}
            hint={t('models.token_modal.reasoning_short', {
              defaultValue: '推理 {{count}}',
              count: formatCompactTokens(dayBreakdown.reasoning),
            })}
          />
          <SummaryCard
            label={t('models.token_modal.lifetime', { defaultValue: '累计总览' })}
            primary={formatCompactTokens(lifetime?.total ?? 0)}
            hint={
              lastUpdatedAt
                ? t('models.token_modal.last_updated', {
                    defaultValue: '更新于 {{time}}',
                    time: new Date(lastUpdatedAt).toLocaleTimeString(),
                  })
                : t('models.token_modal.never_updated', { defaultValue: '尚无数据' })
            }
          />
        </section>

        <section className={styles.chartSection}>
          <header className={styles.chartHeader}>
            <h3 className={styles.sectionTitle}>
              <IconChartLine size={14} aria-hidden="true" />
              {t('models.token_modal.trend_title', { defaultValue: '趋势图' })}
            </h3>
            <div className={styles.rangeTabs} role="tablist">
              {(['day', 'month', 'year'] as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={range === r}
                  className={`${styles.rangeTab} ${range === r ? styles.rangeTabActive : ''}`}
                  onClick={() => setRange(r)}
                >
                  {t(`models.token_modal.range_${r}`)}
                </button>
              ))}
            </div>
          </header>
          <TrendChart data={trendData} range={range} />
        </section>

        <section className={styles.historySection}>
          <header className={styles.chartHeader}>
            <h3 className={styles.sectionTitle}>
              <IconTimer size={14} aria-hidden="true" />
              {t('models.token_modal.history_title', { defaultValue: '历史记录' })}
            </h3>
          </header>
          <HistoryTable data={trendData.slice().reverse()} range={range} />
        </section>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}

interface SummaryCardProps {
  label: string;
  primary: string;
  hint?: string;
}

function SummaryCard({ label, primary, hint }: SummaryCardProps) {
  return (
    <div className={styles.summaryCard}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={styles.summaryPrimary}>{primary}</span>
      {hint && <span className={styles.summaryHint}>{hint}</span>}
    </div>
  );
}

interface TrendPoint {
  key: string;
  bucket: TokenBreakdown;
}

interface TrendChartProps {
  data: TrendPoint[];
  range: Range;
}

function TrendChart({ data, range }: TrendChartProps) {
  const { t } = useTranslation();
  const width = 720;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const max = useMemo(
    () => data.reduce((acc, p) => Math.max(acc, p.bucket.total), 0),
    [data]
  );

  const niceMax = useMemo(() => {
    if (max <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    const steps = [1, 1.5, 2, 3, 5, 10];
    for (const s of steps) {
      const candidate = s * magnitude;
      if (candidate >= max) return candidate;
    }
    return max * 1.2;
  }, [max]);

  const points = useMemo(() => {
    if (data.length === 0) return [];
    const stepX = data.length > 1 ? innerWidth / (data.length - 1) : 0;
    return data.map((p, idx) => {
      const x = padding.left + idx * stepX;
      const yRatio = p.bucket.total / niceMax;
      const y = padding.top + innerHeight - yRatio * innerHeight;
      return { x, y, point: p };
    });
  }, [data, innerWidth, innerHeight, niceMax, padding.left, padding.top]);

  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    if (points.length === 1) {
      const { x, y } = points[0];
      return `M ${x} ${y}`;
    }
    return points
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
  }, [points]);

  const fillD = useMemo(() => {
    if (points.length === 0) return '';
    const baselineY = padding.top + innerHeight;
    const top = points
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    const tail = points.length > 0 ? ` L ${points[points.length - 1].x.toFixed(1)} ${baselineY} L ${points[0].x.toFixed(1)} ${baselineY} Z` : '';
    return `${top}${tail}`;
  }, [points, innerHeight, padding.top]);

  const yAxisTicks = useMemo(() => {
    const ticks = 4;
    const result: { y: number; label: string }[] = [];
    for (let i = 0; i <= ticks; i += 1) {
      const ratio = i / ticks;
      const value = niceMax * (1 - ratio);
      const y = padding.top + ratio * innerHeight;
      result.push({ y, label: formatCompact(value) });
    }
    return result;
  }, [niceMax, innerHeight, padding.top]);

  const xLabels = useMemo(() => {
    if (data.length === 0) return [];
    const targetCount = 6;
    const step = Math.max(1, Math.floor(data.length / targetCount));
    const result: { x: number; label: string }[] = [];
    for (let i = 0; i < data.length; i += step) {
      const point = data[i];
      const x = points[i]?.x ?? 0;
      const label = range === 'day'
        ? shortDateLabel(point.key)
        : range === 'month'
          ? shortMonthLabel(point.key)
          : point.key;
      result.push({ x, label });
    }
    return result;
  }, [data, points, range]);

  return (
    <div className={styles.chartWrap}>
      {data.length === 0 || max === 0 ? (
        <div className={styles.chartEmpty}>{t('models.token_modal.no_data')}</div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className={styles.chartSvg}
          role="img"
          aria-label={t('models.token_modal.trend_aria')}
        >
          <defs>
            <linearGradient id="token-trend-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary-color)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--primary-color)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yAxisTicks.map((t) => (
            <g key={`yt-${t.y}`}>
              <line
                x1={padding.left}
                y1={t.y}
                x2={padding.left + innerWidth}
                y2={t.y}
                stroke="currentColor"
                strokeOpacity="0.08"
              />
              <text
                x={padding.left - 8}
                y={t.y + 4}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                opacity="0.55"
              >
                {t.label}
              </text>
            </g>
          ))}
          <path d={fillD} fill="url(#token-trend-gradient)" stroke="none" />
          <path d={pathD} fill="none" stroke="var(--primary-color)" strokeWidth="2" />
          {points.map((p, idx) => (
            <circle
              key={`pt-${idx}`}
              cx={p.x}
              cy={p.y}
              r={2.5}
              fill="var(--primary-color)"
            >
              <title>
                {range === 'day'
                  ? shortDateLabel(p.point.key)
                  : range === 'month'
                    ? shortMonthLabel(p.point.key)
                    : p.point.key}
                {' · '}
                {formatTokens(p.point.bucket.total)} tokens
              </title>
            </circle>
          ))}
          {xLabels.map((x, idx) => (
            <text
              key={`xt-${idx}`}
              x={x.x}
              y={padding.top + innerHeight + 18}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity="0.55"
            >
              {x.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

interface HistoryTableProps {
  data: TrendPoint[];
  range: Range;
}

function HistoryTable({ data, range }: HistoryTableProps) {
  const { t } = useTranslation();
  if (data.length === 0) {
    return <div className={styles.chartEmpty}>{t('models.token_modal.no_data')}</div>;
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.historyTable}>
        <thead>
          <tr>
            <th>{range === 'year' ? t('models.token_modal.col_year') : range === 'month' ? t('models.token_modal.col_month') : t('models.token_modal.col_date')}</th>
            <th>{t('models.token_modal.col_total')}</th>
            <th>{t('models.token_modal.col_input')}</th>
            <th>{t('models.token_modal.col_output')}</th>
            <th>{t('models.token_modal.col_cached')}</th>
            <th>{t('models.token_modal.col_reasoning')}</th>
            <th>{t('models.token_modal.col_requests')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const label = range === 'day'
              ? shortDateLabel(row.key)
              : range === 'month'
                ? shortMonthLabel(row.key)
                : row.key;
            return (
              <tr key={row.key}>
                <td className={styles.dateCell}>{label}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.total)}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.input)}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.output)}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.cached)}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.reasoning)}</td>
                <td className={styles.numCell}>{formatTokens(row.bucket.requests)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatCompactTokens(value: number): string {
  return formatCompact(value);
}
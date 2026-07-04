/**
 * Token 实时显示单元。
 *
 * 显示当月（自然月）累计 token 数。点击进入详情弹窗查看历史和趋势。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconTrendingUp } from '@/components/ui/icons';
import { canonicalizeModelKey, useTokenUsageStore } from '@/stores';
import styles from './TokenUsageCell.module.scss';

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const formatCompactTokens = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  if (value < 1000) return numberFormatter.format(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(2)}M`;
};

export interface TokenUsageCellProps {
  modelKey: string;
  /** 当月显示值（可选覆盖），用于在没有后端 usage 数据时回退到估算。 */
  fallbackEstimate?: number;
}

export function TokenUsageCell({ modelKey, fallbackEstimate }: TokenUsageCellProps) {
  const { t } = useTranslation();
  // Always read stats from the canonical key so prefixed and unprefixed
  // variants of the same model (e.g. `rsx/claude-sonnet-5` vs
  // `claude-sonnet-5`) both light up the same row.
  const canonicalKey = useMemo(() => canonicalizeModelKey(modelKey) || modelKey, [modelKey]);
  const currentMonth = useTokenUsageStore((state) => state.getCurrentMonthUsage(canonicalKey));
  const lastPolledAt = useTokenUsageStore((state) => state.lastPolledAt);
  const pollOnce = useTokenUsageStore((state) => state.pollOnce);

  const [pulseKey, setPulseKey] = useState<number>(0);
  const lastPolledRef = useRef<number | null>(null);
  useEffect(() => {
    if (!lastPolledAt) return undefined;
    if (lastPolledRef.current === lastPolledAt) return undefined;
    lastPolledRef.current = lastPolledAt;
    // 推迟到下一个 microtask，避开 React `set-state-in-effect` 警告；
    // CSS 动画由 data 属性的变化驱动，自身完成动画状态管理。
    queueMicrotask(() => setPulseKey(lastPolledAt));
    return undefined;
  }, [lastPolledAt]);

  const total = currentMonth.total;
  const useFallback = total === 0 && typeof fallbackEstimate === 'number' && fallbackEstimate > 0;
  const displayValue = useFallback ? fallbackEstimate : total;
  const input = currentMonth.input;
  const output = currentMonth.output;

  return (
    <button
      type="button"
      className={`${styles.cell} ${pulseKey ? styles.cellPulse : ''}`}
      title={t('models.token_cell.title', {
        defaultValue: '点击查看 token 消耗明细',
        model: modelKey,
      })}
      onClick={(e) => {
        e.preventDefault();
        // 弹窗由父组件（ModelsPage）根据 click 事件处理，这里只冒泡自定义事件。
        const target = e.currentTarget;
        const ev = new CustomEvent('token-cell-click', {
          bubbles: true,
          detail: { modelKey: canonicalKey, anchorRect: target.getBoundingClientRect() },
        });
        target.dispatchEvent(ev);
      }}
      onDoubleClick={(e) => {
        // 双击立刻强制刷新一次。
        e.preventDefault();
        void pollOnce();
      }}
    >
      <span className={styles.row}>
        <IconTrendingUp size={14} className={styles.icon} aria-hidden="true" />
        <span className={styles.value}>{formatCompactTokens(displayValue)}</span>
        <span className={styles.unit}>tokens</span>
      </span>
      <span className={styles.row}>
        <span className={styles.sub}>
          {t('models.token_cell.io', {
            defaultValue: '输入 {{input}} · 输出 {{output}}',
            input: formatCompactTokens(input),
            output: formatCompactTokens(output),
          })}
        </span>
        <svg
          className={styles.chevron}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </span>
    </button>
  );
}
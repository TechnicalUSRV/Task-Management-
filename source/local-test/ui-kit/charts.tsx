import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { formatNumber } from '../format';

export type BarItem = { key: string; label: string; value: number; onSelect?: () => void; href?: string; detail?: string };

/**
 * Horizontal bar list for comparing counts across a handful of categories.
 * One series → one hue (the accent); the unfilled track is a lighter step of the
 * same hue. Every bar carries its value as a direct label, so nothing depends on
 * hover. Rows are buttons/links when they drill into source records.
 */
export function BarList({ items, unit = '', format = v => formatNumber(v) ?? '0', label, showShare = true, className, footer }: {
  items: BarItem[]; unit?: string; format?: (v: number) => string; label: string; showShare?: boolean; className?: string; footer?: ReactNode;
}) {
  const max = Math.max(0, ...items.map(i => i.value));
  const total = items.reduce((n, i) => n + i.value, 0);
  return (
    <div className={cn('bar-list-block', className)}>
      <ul className="bar-list" aria-label={label}>
        {items.map(i => {
          const pct = max ? Math.max(i.value > 0 ? 2 : 0, (i.value / max) * 100) : 0;
          const share = total ? Math.round((i.value / total) * 100) : 0;
          const description = `${i.label}: ${format(i.value)}${unit ? ' ' + unit : ''}${showShare && total ? ` (${share}% of ${format(total)})` : ''}${i.detail ? ` · ${i.detail}` : ''}`;
          const inner = (
            <>
              <span className="bar-label">{i.label}</span>
              <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${pct}%` }} /></span>
              <span className="bar-value">
                <span className="num">{format(i.value)}</span>
                {showShare && total > 0 && <span className="bar-share num">{share}%</span>}
              </span>
            </>
          );
          return (
            <li key={i.key}>
              {i.href ? <a className="bar-row is-interactive" href={i.href} title={description} aria-label={description}>{inner}</a>
                : i.onSelect ? <button type="button" className="bar-row is-interactive" onClick={i.onSelect} title={description} aria-label={description}>{inner}</button>
                : <div className="bar-row" title={description}>{inner}</div>}
            </li>
          );
        })}
      </ul>
      {footer && <div className="bar-list-footer">{footer}</div>}
    </div>
  );
}

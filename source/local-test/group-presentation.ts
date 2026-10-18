import { formatResult } from './group-domain.mjs';
import type { Row } from './components';
/** Display only: 25 remains 25 and is shown as 25% in Percentage format. */
export function formatColumnNumber(value: unknown, settings: Row = {}): string {
  const kind = settings.format || 'GENERAL';
  const decimals = settings.decimals ?? (kind === 'USD' ? 2 : kind === 'KHR' ? 0 : null);
  let shown = formatResult(value, decimals);
  if (typeof value !== 'number' || !Number.isFinite(value)) return shown;
  if (settings.grouping === false) shown = shown.replace(/,/g, '');
  const prefix = kind === 'USD' ? '$' : kind === 'KHR' ? '៛' : kind === 'CUSTOM' ? settings.prefix || '' : '';
  const suffix = kind === 'PERCENT' ? '%' : kind === 'CUSTOM' ? settings.suffix || '' : '';
  return prefix + shown + suffix;
}
export const cellColors = (row: Row, col: Row) => ({ color: row.styles?.[col.id]?.text_color || undefined, backgroundColor: row.styles?.[col.id]?.background_color || undefined });

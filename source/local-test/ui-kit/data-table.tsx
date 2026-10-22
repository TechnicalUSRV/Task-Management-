import { uiText, useLanguage } from "../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewState } from '../router';
import { compareValues, isMissing } from '../format';
import { Missing } from './display';
import { EmptyState, NoResults } from './states';

export type Row = Record<string, any>;

export type Column<T extends Row = Row> = {
  key: string;
  header: ReactNode;
  /** Cell content. Defaults to the raw value, with "—" for missing values. */
  cell?: (row: T) => ReactNode;
  /** Value used for sorting. Defaults to row[key]. */
  sortValue?: (row: T) => unknown;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Right-aligned, tabular figures (amounts, counts, durations). */
  numeric?: boolean;
  minWidth?: number;
  maxWidth?: number;
  /** Allow multi-line wrapping for long text columns. */
  wrap?: boolean;
  /** The cell that carries the row's link for keyboard users (defaults to the first column). */
  primary?: boolean;
  className?: string;
  headerTitle?: string;
};

type Sort = { key: string; dir: 'asc' | 'desc' } | null;
type View = { sort: Sort; page: number; pageSize: number; resetKey?: string };

export type Selection = { selected: string[]; onChange: (ids: string[]) => void; label?: (row: Row) => string };

export function DataTable<T extends Row>({
  columns, rows, rowKey, onRowClick, rowLabel, stateKey, resetKey = '', defaultSort = null,
  pageSize: initialPageSize = 25, pageSizes = [10, 25, 50, 100], empty, noResults, filtered = false, onClearFilters,
  caption, footerRow, selection, dense = false, maxHeight, className, rowClassName, itemName = 'records',
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey?: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Accessible name for the row link, e.g. "Open contact CONT-000001". */
  rowLabel?: (row: T) => string;
  /** Remembers sort, page and page size for this session. */
  stateKey?: string;
  /** When this changes (e.g. filters), the table returns to page 1. */
  resetKey?: string;
  defaultSort?: Sort;
  /** Rows per page. 0 shows every row. */
  pageSize?: number;
  pageSizes?: number[];
  empty?: ReactNode;
  noResults?: ReactNode;
  filtered?: boolean;
  onClearFilters?: () => void;
  caption?: string;
  footerRow?: Record<string, ReactNode>;
  selection?: Selection;
  dense?: boolean;
  maxHeight?: string;
  className?: string;
  rowClassName?: (row: T) => string | undefined;
  itemName?: string;
}) {
  useLanguage();
  const keyOf = (r: T, i: number) => (rowKey ? rowKey(r, i) : String(r.id ?? i));
  const [view, setView] = useViewState<View>(stateKey ? `table:${stateKey}` : undefined, { sort: defaultSort, page: 0, pageSize: initialPageSize || 25, resetKey });
  const page = view.resetKey === resetKey ? view.page : 0;
  useEffect(() => { if (view.resetKey !== resetKey) setView(v => ({ ...v, page: 0, resetKey })); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sort = view.sort && columns.some(c => c.key === view.sort!.key) ? view.sort : defaultSort;
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || ((r: T) => r[col.key]);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.map((r, i) => ({ r, i, v: get(r) })).sort((a, b) => {
      const am = isMissing(a.v), bm = isMissing(b.v);
      if (am || bm) return am && bm ? a.i - b.i : am ? 1 : -1; // missing values stay last in both directions
      return compareValues(a.v, b.v) * dir || a.i - b.i;
    }).map(x => x.r);
  }, [rows, sort, columns]);

  const showAll = initialPageSize === 0;
  const size = showAll ? Math.max(sorted.length, 1) : view.pageSize;
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages - 1);
  const start = showAll ? 0 : current * size;
  const visible = showAll ? sorted : sorted.slice(start, start + size);

  const setSort = (key: string) => setView(v => {
    const s = v.sort && columns.some(c => c.key === v.sort!.key) ? v.sort : defaultSort;
    const next: Sort = !s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : defaultSort && defaultSort.key !== key ? defaultSort : null;
    return { ...v, sort: next, page: 0, resetKey };
  });
  const goTo = (p: number) => setView(v => ({ ...v, page: Math.max(0, Math.min(pages - 1, p)), resetKey }));

  // Edge shadows show that a wide table scrolls sideways.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const update = () => setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [visible.length, columns.length]);

  if (!rows.length) {
    return <div className={cn('table-empty', className)}>{filtered ? (noResults ?? <NoResults onClear={onClearFilters} compact />) : (empty ?? <EmptyState title={uiText("No {p0} yet", { p0: itemName })} compact />)}</div>;
  }

  const primaryIndex = Math.max(0, columns.findIndex(c => c.primary));
  const selectedSet = new Set(selection?.selected || []);
  const pageIds = visible.map((r, i) => keyOf(r, start + i));
  const allOnPage = selection && pageIds.length > 0 && pageIds.every(id => selectedSet.has(id));
  const someOnPage = selection && pageIds.some(id => selectedSet.has(id));
  const alignOf = (c: Column<T>) => c.align || (c.numeric ? 'right' : 'left');

  return (
    <div className={cn('data-table-block', className)}>
      <div
        ref={wrapRef}
        className={cn('table-wrap', edges.left && 'edge-left', edges.right && 'edge-right')}
        style={{ maxHeight: maxHeight ?? (visible.length > 14 ? "min(72vh, 780px)" : undefined) }}
        tabIndex={edges.left || edges.right ? 0 : undefined}
        role={edges.left || edges.right ? 'region' : undefined}
        aria-label={edges.left || edges.right ? uiText("{p0} (scrolls horizontally)", { p0: caption || 'Table' }) : undefined}
      >
        <table className={cn('data-table', dense && 'is-dense', selection && 'has-select')}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {selection && (
                <th className="col-select" scope="col">
                  <Checkbox aria-label={allOnPage ? uiText("Deselect rows on this page") : uiText("Select rows on this page")} checked={allOnPage ? true : someOnPage ? 'indeterminate' : false}
                    onCheckedChange={v => selection.onChange(v ? [...new Set([...selection.selected, ...pageIds])] : selection.selected.filter(id => !pageIds.includes(id)))} />
                </th>
              )}
              {columns.map(c => {
                const sortable = c.sortable !== false;
                const active = sort?.key === c.key;
                const ariaSort = sortable ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                return (
                  <th key={c.key} scope="col" aria-sort={ariaSort} className={cn(`align-${alignOf(c)}`, c.className)} style={{ minWidth: c.minWidth, maxWidth: c.maxWidth }} title={c.headerTitle}>
                    {sortable ? (
                      <button type="button" className={cn('th-sort', active && 'is-active')} onClick={() => setSort(c.key)}>
                        <span>{c.header}</span>
                        {active ? (sort!.dir === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />) : <ChevronsUpDown className="th-sort-idle" aria-hidden="true" />}
                      </button>
                    ) : <span className="th-label">{c.header}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const id = keyOf(r, start + i);
              const isSelected = selectedSet.has(id);
              return (
                <tr
                  key={id}
                  className={cn(onRowClick && 'is-clickable', isSelected && 'is-selected', rowClassName?.(r))}
                  onClick={onRowClick ? e => { if ((e.target as HTMLElement).closest("button,a,input,select,textarea,label,[role=checkbox],[data-no-row-click]")) return; onRowClick(r); } : undefined}
                >
                  {selection && (
                    <td className="col-select">
                      <Checkbox aria-label={`Select ${selection.label?.(r) || id}`} checked={isSelected} onCheckedChange={v => selection.onChange(v ? [...selection.selected, id] : selection.selected.filter(x => x !== id))} />
                    </td>
                  )}
                  {columns.map((c, j) => {
                    const raw = c.cell ? c.cell(r) : r[c.key];
                    // A blank cell is ambiguous; show the "not provided" marker instead (0 still shows as 0).
                    const content = isMissing(raw) || raw === false ? <Missing /> : raw;
                    return (
                      <td key={c.key} className={cn(`align-${alignOf(c)}`, c.numeric && 'num', c.wrap && 'is-wrap', c.className)} style={{ minWidth: c.minWidth, maxWidth: c.maxWidth }}>
                        {onRowClick && j === primaryIndex
                          ? <button type="button" className="row-link" onClick={() => onRowClick(r)} aria-label={rowLabel?.(r)}>{content}</button>
                          : content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {footerRow && (
            <tfoot>
              <tr>
                {selection && <td className="col-select" />}
                {columns.map(c => <td key={c.key} className={cn(`align-${alignOf(c)}`, c.numeric && 'num')}>{footerRow[c.key]}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!showAll && sorted.length > Math.min(...pageSizes) && (
        <div className="table-footer">
          <span className="table-count" aria-live="polite">
            {uiText("Showing ")}<strong>{start + 1}–{Math.min(start + size, sorted.length)}</strong> {uiText("of ")}<strong>{sorted.length.toLocaleString('en-US')}</strong> {itemName}
          </span>
          <label className="page-size">
            <span>{uiText("Rows per page")}</span>
            <select value={view.pageSize} onChange={e => setView(v => ({ ...v, pageSize: Number(e.target.value), page: 0, resetKey }))}>
              {pageSizes.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="pager">
            <Button variant="outline" size="icon-sm" aria-label={uiText("Previous page")} disabled={current === 0} onClick={() => goTo(current - 1)}><ChevronLeft /></Button>
            <span className="pager-text">{uiText("Page ")}{current + 1} {uiText("of ")}{pages}</span>
            <Button variant="outline" size="icon-sm" aria-label={uiText("Next page")} disabled={current >= pages - 1} onClick={() => goTo(current + 1)}><ChevronRight /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

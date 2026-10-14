import { useEffect, useId, useState, type ReactNode } from 'react';
import { CalendarDays, Check, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatRange, localDate } from '../format';
import { Avatar } from './display';

// ---------------------------------------------------------------- search

export function SearchInput({ value, onChange, placeholder = 'Search…', label = 'Search', className }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; className?: string }) {
  return (
    <div className={cn('search-input', className)}>
      <Search className="search-icon" aria-hidden="true" />
      <input type="search" className="control" aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }} />
      {value && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onChange('')}><X aria-hidden="true" /></button>}
    </div>
  );
}

// ---------------------------------------------------------------- single select

export function FilterSelect({ label, value, onChange, options, allLabel = 'All', className, people }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; allLabel?: string; className?: string; people?: boolean }) {
  // A combobox takes its name from a label, not its content, so name it explicitly ("Status: Open").
  const shown = (value && options.find(([v]) => v === value)?.[1]) || (value ? value : allLabel);
  return (
    <Select value={value || '__all__'} onValueChange={v => onChange(v === '__all__' ? '' : v)}>
      <SelectTrigger size="sm" aria-label={`${label}: ${shown}`} className={cn('filter-select', value && 'is-active', className)}>
        <span className="filter-select-label">{label}<span className="sr-only">:</span></span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="__all__">{allLabel}</SelectItem>
        {options.filter(([v]) => v !== '').map(([v, l]) => <SelectItem key={v} value={v}>{people ? <span className="person-option-inline"><Avatar name={l} size="sm" />{l}</span> : l}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------- multi select

export type Option = { id: string; label: string; meta?: string };
export function FilterMulti({ label, values, onChange, options, searchable, className, emptyText = 'No values available.' }: {
  label: string; values: string[]; onChange: (v: string[]) => void; options: Option[]; searchable?: boolean; className?: string; emptyText?: string;
}) {
  const [query, setQuery] = useState('');
  const canSearch = searchable ?? options.length > 8;
  const shown = options.filter(o => !query || `${o.label} ${o.id} ${o.meta || ''}`.toLowerCase().includes(query.toLowerCase()));
  const first = options.find(o => o.id === values[0])?.label;
  const summary = values.length === 0 ? 'All' : values.length === 1 ? first || values[0] : `${values.length} selected`;
  return (
    <Popover onOpenChange={open => { if (!open) setQuery(''); }}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('control filter-select filter-multi', values.length && 'is-active', className)} aria-label={`${label}: ${summary}`}>
          <span className="filter-select-label">{label}</span>
          <span className="filter-multi-value">{summary}</span>
          <ChevronDown className="filter-chevron" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="filter-popover">
        <div className="filter-popover-head">
          <strong>{label}</strong>
          {values.length > 0 && <Button variant="link" size="xs" onClick={() => onChange([])}>Clear</Button>}
        </div>
        {canSearch && <SearchInput value={query} onChange={setQuery} placeholder={`Find ${label.toLowerCase()}…`} label={`Find ${label}`} className="filter-popover-search" />}
        <div className="filter-options" role="group" aria-label={label}>
          {shown.map(o => (
            <label key={o.id} className="filter-option">
              <Checkbox checked={values.includes(o.id)} onCheckedChange={v => onChange(v ? [...values, o.id] : values.filter(id => id !== o.id))} />
              <span className="filter-option-text"><span>{o.label}</span>{o.meta && <small>{o.meta}</small>}</span>
            </label>
          ))}
          {!shown.length && <p className="filter-empty">{options.length ? 'No matches.' : emptyText}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- date range

export type DateRange = { from: string; to: string; preset?: string };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const DATE_PRESETS: { id: string; label: string; range: () => { from: string; to: string } }[] = [
  { id: 'all', label: 'All dates', range: () => ({ from: '', to: '' }) },
  { id: 'today', label: 'Today', range: () => { const t = localDate(); return { from: t, to: t }; } },
  { id: 'week', label: 'This week', range: () => { const t = localDate(), d = new Date(`${t}T12:00:00Z`).getUTCDay(); const from = addDays(t, -((d + 6) % 7)); return { from, to: addDays(from, 6) }; } },
  { id: 'month', label: 'This month', range: () => { const t = localDate(); const from = t.slice(0, 8) + '01'; const next = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 1)); return { from, to: addDays(next.toISOString().slice(0, 10), -1) }; } },
  { id: 'last-month', label: 'Last month', range: () => { const t = localDate(); const first = t.slice(0, 8) + '01'; const to = addDays(first, -1); return { from: to.slice(0, 8) + '01', to }; } },
  { id: 'last-30', label: 'Last 30 days', range: () => { const t = localDate(); return { from: addDays(t, -29), to: t }; } },
  { id: 'next-30', label: 'Next 30 days', range: () => { const t = localDate(); return { from: t, to: addDays(t, 29) }; } },
  { id: 'quarter', label: 'This quarter', range: () => { const t = localDate(), y = Number(t.slice(0, 4)), q = Math.floor((Number(t.slice(5, 7)) - 1) / 3); const from = new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10); const to = addDays(new Date(Date.UTC(y, q * 3 + 3, 1)).toISOString().slice(0, 10), -1); return { from, to }; } },
  { id: 'year', label: 'This year', range: () => { const y = localDate().slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31` }; } },
];
export const presetRange = (id: string): DateRange => { const p = DATE_PRESETS.find(x => x.id === id) || DATE_PRESETS[0]; return { ...p.range(), preset: p.id }; };
/** Re-evaluates relative presets ("This month") so remembered filters never go stale. */
export const resolveRange = <T extends DateRange>(r: T): T => (r.preset && !['custom', 'all'].includes(r.preset) && DATE_PRESETS.some(p => p.id === r.preset) ? { ...r, ...presetRange(r.preset) } : r);
export const rangeLabel = (r: DateRange) => r.preset && r.preset !== 'custom' ? (DATE_PRESETS.find(p => p.id === r.preset)?.label ?? formatRange(r.from, r.to)) : formatRange(r.from, r.to);

export function DateRangeFilter({ value, onChange, label = 'Date', className, presets = DATE_PRESETS.map(p => p.id) }: { value: DateRange; onChange: (r: DateRange) => void; label?: string; className?: string; presets?: string[] }) {
  const [open, setOpen] = useState(false), [from, setFrom] = useState(value.from), [to, setTo] = useState(value.to), [error, setError] = useState('');
  const id = useId();
  useEffect(() => { if (open) { setFrom(value.from); setTo(value.to); setError(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = !!(value.from || value.to);
  const summary = rangeLabel(value);
  const apply = () => { if (from && to && from > to) { setError('The end date must be on or after the start date.'); return; } onChange({ from, to, preset: 'custom' }); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('control filter-select filter-date', active && 'is-active', className)} aria-label={`${label}: ${summary}`}>
          <CalendarDays className="filter-date-icon" aria-hidden="true" />
          <span className="filter-select-label">{label}</span>
          <span className="filter-multi-value">{summary}</span>
          <ChevronDown className="filter-chevron" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="filter-popover date-popover">
        <div className="date-presets" role="listbox" aria-label="Date presets">
          {DATE_PRESETS.filter(p => presets.includes(p.id)).map(p => {
            const selected = (value.preset || (active ? 'custom' : 'all')) === p.id;
            return (
              <button key={p.id} type="button" role="option" aria-selected={selected} className="date-preset" onClick={() => { onChange({ ...p.range(), preset: p.id }); setOpen(false); }}>
                <Check className="date-preset-check" aria-hidden="true" />{p.label}
              </button>
            );
          })}
        </div>
        <div className="date-custom">
          <p className="date-custom-title">Custom range</p>
          <div className="date-custom-fields">
            <label htmlFor={`${id}-from`}>From<input id={`${id}-from`} type="date" className="control" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
            <label htmlFor={`${id}-to`}>To<input id={`${id}-to`} type="date" className="control" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="date-custom-actions">
            <Button variant="ghost" size="sm" onClick={() => { onChange({ from: '', to: '', preset: 'all' }); setOpen(false); }}>Clear</Button>
            <Button size="sm" onClick={apply}>Apply range</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- toggle chip

export function ToggleFilter({ label, pressed, onChange, className }: { label: ReactNode; pressed: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <button type="button" className={cn('control filter-toggle', pressed && 'is-active', className)} aria-pressed={pressed} onClick={() => onChange(!pressed)}>
      <span className="filter-toggle-box" aria-hidden="true">{pressed && <Check />}</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- bar

export type FilterChip = { key: string; label: ReactNode; text?: string; onRemove: () => void };

/**
 * Consistent filter area: search and frequent filters in one row, optional
 * advanced filters behind "More filters", then the active filters as removable
 * chips with a reset action and the result count.
 */
export function FilterBar({ search, filters, more, chips = [], onReset, summary, actions, className }: {
  search?: ReactNode; filters?: ReactNode; more?: ReactNode; chips?: FilterChip[]; onReset?: () => void; summary?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const [showMore, setShowMore] = useState(false);
  const panelId = useId();
  return (
    <div className={cn('filter-bar', className)}>
      <div className="filter-row">
        {search && <div className="filter-search">{search}</div>}
        {(filters || more) && (
          <div className="filter-controls">
            {filters}
            {more && (
              <Button variant="ghost" size="sm" className="filter-more-toggle" aria-expanded={showMore} aria-controls={panelId} onClick={() => setShowMore(!showMore)}>
                <SlidersHorizontal />{showMore ? 'Fewer filters' : 'More filters'}
              </Button>
            )}
          </div>
        )}
        {actions && <div className="filter-actions">{actions}</div>}
      </div>
      {more && showMore && <div className="filter-more" id={panelId}>{more}</div>}
      {(chips.length > 0 || summary) && (
        <div className="filter-status">
          {summary && <span className="filter-summary" aria-live="polite">{summary}</span>}
          {chips.length > 0 && (
            <ul className="filter-chips" aria-label="Active filters">
              {chips.map(c => (
                <li key={c.key} className="chip">
                  <span>{c.label}</span>
                  <button type="button" aria-label={`Remove filter ${c.text ?? (typeof c.label === 'string' ? c.label : c.key)}`} onClick={c.onRemove}><X aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          {chips.length > 1 && onReset && <Button variant="link" size="xs" className="filter-reset" onClick={onReset}>Reset all</Button>}
        </div>
      )}
    </div>
  );
}

/** Builds chips for simple key/value filters (skips empty values). */
export function buildChips(entries: { key: string; label: string; value: string | string[] | boolean | undefined | null; display?: string; clear: () => void }[]): FilterChip[] {
  return entries.filter(e => Array.isArray(e.value) ? e.value.length > 0 : !!e.value).map(e => {
    const shown = e.display ?? (Array.isArray(e.value) ? e.value.join(', ') : typeof e.value === 'boolean' ? '' : String(e.value));
    const label = shown ? `${e.label}: ${shown}` : e.label;
    return { key: e.key, label, text: label, onRemove: e.clear };
  });
}

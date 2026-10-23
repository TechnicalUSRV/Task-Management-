import { getLanguage, uiText, useLanguage , translatedMap } from "./i18n";
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Bell, CalendarDays, CheckCheck, ClipboardCheck, Clock3, Download, FileText, Filter, Layers3, ListTodo,
  Printer, Receipt, RefreshCw, ShieldCheck, Target, Truck, UserRound, Users, Wallet, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { apiFetch } from './api-client';
import type { Row } from './components';
import type { Workspace } from './ui';
import { formatted, reportPrintHTML, filterDescription } from './report-format.mjs';
import { useViewState } from './router';
import { formatDate, formatDateTime, formatDuration, formatMoney, formatNumber, formatRange, formatRelative, isMissing, localDate, plural } from './format';
import {
  Alert, BarList, Card, DataTable, DateRangeFilter, DateText, EmptyState, ErrorState, ExpandableText, Field, FilterBar, FilterMulti,
  KeyValues, LoadingState, Money, NoAccess, PageHeader, SearchInput, Section, SectionTabs, StatCard, StatusBadge, buildChips, rangeLabel, resolveRange, statusLabel,
  type Column, type DateRange, type Tone,
} from './ui-kit';

async function json(url: string, body?: Row) {
  const r = await apiFetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const d = await r.json() as Row;
  if (!r.ok) { if (r.status === 401) window.dispatchEvent(new Event('session-expired')); throw new Error(d.error || uiText("Unable to load data.")); }
  return d;
}
const openRow = (w: Workspace, row: Row) => { if (row.can_open && row.target) w.show(row.target.type, row.target.id); };

// Presentation for each registered widget. Unknown (future) widgets fall back to generic rendering.
const KPI: Record<string, { icon: LucideIcon; one: string; noun: string; tone?: Tone }> = {
  'crm-pipeline': { icon: Target, one: 'open opportunity', noun: 'open opportunities', tone: 'accent' },
  'crm-customers': { icon: BadgeCheck, one: 'active account', noun: 'active accounts', tone: 'success' },
  'task-open': { icon: ListTodo, one: 'open task', noun: 'open tasks', tone: 'accent' },
  'time-recorded': { icon: Clock3, one: 'time entry', noun: 'time entries', tone: 'purple' },
  'ops-approval': { icon: ClipboardCheck, one: 'submitted request', noun: 'submitted requests', tone: 'warning' },
  'finance-ar': { icon: Receipt, one: 'debit note', noun: 'debit notes', tone: 'accent' },
  'finance-ap': { icon: Wallet, one: 'debit note', noun: 'debit notes', tone: 'purple' },
  'admin-active': { icon: ShieldCheck, one: 'active login', noun: 'active logins', tone: 'success' },
};
/** "1 open task" / "5 open tasks" */
const counted = (n: number, one: string, many: string) => `${formatNumber(n) ?? '0'} ${n === 1 ? one : many}`;
const CHART: Record<string, { title: string; order: string[]; one: string; noun: string }> = {
  'crm-stages': { get title() { return uiText("Opportunities by status"); }, order: ['OPEN', 'WON', 'LOST'], one: 'opportunity', noun: 'opportunities' },
  'task-stages': { get title() { return uiText("Tasks by status"); }, order: ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'], one: 'task', noun: 'tasks' },
  'ops-shipment': { get title() { return uiText("Shipments by stage"); }, order: ['IN_TRANSIT', 'ARRIVED_PORT', 'DELIVERING', 'CLOSED'], one: 'shipment', noun: 'shipments' },
  'admin-roles': { get title() { return uiText("User accounts by role"); }, order: [], one: 'account', noun: 'accounts' },
};
const LIST: Record<string, { title: string; description: string; icon: LucideIcon; empty: string }> = {
  'ops-inbox': { get title() { return uiText("My approval inbox"); }, get description() { return uiText("Requests waiting for your approval step"); }, icon: ClipboardCheck, get empty() { return uiText("Nothing is waiting for your approval."); } },
  'team-work': { get title() { return uiText("Tasks needing attention"); }, get description() { return uiText("Open tasks, earliest due first"); }, icon: ListTodo, get empty() { return uiText("No open tasks in this period."); } },
  'crm-followups': { get title() { return uiText("CRM follow-ups"); }, get description() { return uiText("Open calls, meetings and follow-ups, earliest first"); }, icon: UserRound, get empty() { return uiText("No open follow-ups in this period."); } },
  'team-meetings': { get title() { return uiText("Meeting schedule"); }, get description() { return uiText("Scheduled meetings, earliest first"); }, icon: CalendarDays, get empty() { return uiText("No scheduled meetings in this period."); } },
};
const SHIPMENT_LABEL: Record<string, string> = translatedMap({ CLOSED: 'Delivered (closed)', ARRIVED_PORT: 'Arrived at port', IN_TRANSIT: 'In transit', DELIVERING: 'Delivering' });
const TARGET_ICON: Record<string, LucideIcon> = { contact: UserRound, lead: UserRound, opportunity: Target, quotation: FileText, account: BadgeCheck, activity: Clock3, campaign: Layers3, tm_task: ListTodo, tm_meeting: CalendarDays, tm_time: Clock3, tm_workspace: Layers3, tm_profile: Users, operations: Truck };

const EMPTY_FILTERS = { modules: [] as string[], from: '', to: '', preset: 'all' };

// ================================================================ dashboard
export function ERPDashboard(w: Workspace & { drill: (f: Row) => void }) {
  useLanguage();
  const [storedFilters, setFilters] = useViewState('dashboard:filters', EMPTY_FILTERS);
  const filters = resolveRange(storedFilters);
  const [dashboard, setDashboard] = useState<Row | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const query = useMemo(() => JSON.stringify({ modules: filters.modules, from: filters.from, to: filters.to }), [filters]);
  useEffect(() => {
    let live = true; setError(''); setLoading(true);
    void json('/api/erp/dashboard?filters=' + encodeURIComponent(query)).then(d => { if (live) { setDashboard(d); setLoading(false); } }).catch(e => { if (live) { setError(e.message); setLoading(false); } });
    return () => { live = false; };
  }, [w.data, query, reload]);
  if (!w.can('dashboard')) return <><PageHeader title={uiText("Dashboard")} /><NoAccess /></>;
  const range: DateRange = { from: filters.from, to: filters.to, preset: filters.preset };
  const period = formatRange(filters.from, filters.to);
  const modules: { id: string; label: string }[] = dashboard?.modules || [];
  const chips = buildChips([
    { key: 'period', label: uiText("Period"), value: filters.from || filters.to ? 'x' : '', display: rangeLabel(range), clear: () => setFilters(f => ({ ...f, from: '', to: '', preset: 'all' })) },
    { key: 'modules', label: uiText("Modules"), value: filters.modules, display: filters.modules.map(id => modules.find(m => m.id === id)?.label || id).join(', '), clear: () => setFilters(f => ({ ...f, modules: [] })) },
  ]);
  const widgets: Row[] = dashboard?.widgets || [];
  const kpis = widgets.filter(t => t.kind === 'kpi'), bars = widgets.filter(t => t.kind === 'bar'), lists = widgets.filter(t => t.kind === 'list');
  const listOrder = ['ops-inbox', 'team-work', 'crm-followups', 'team-meetings'];
  lists.sort((a, b) => (listOrder.indexOf(a.id) + 1 || 99) - (listOrder.indexOf(b.id) + 1 || 99));
  const today = localDate();
  const kpiValue = (t: Row) => t.format === 'money' ? formatMoney(t.value, w.currency) : t.format === 'duration' ? formatDuration(t.value) : formatNumber(t.value);
  const unreadAlerts = (dashboard?.notifications || []) as Row[];

  return (
    <>
      <PageHeader title={uiText("Dashboard")} description={uiText("Your company at a glance across CRM, tasks, operations, finance and administration. Select any figure, bar or item to see its source records.")}
        meta={dashboard && <>
          <span className="meta-item"><Layers3 aria-hidden="true" />{dashboard.summary.modules} {uiText("modules · ")}{dashboard.summary.sources} {uiText("data sources")}</span>
          <span className="meta-item"><RefreshCw aria-hidden="true" />{uiText("Updated ")}{formatDateTime(dashboard.generated_at)}</span>
        </>}
        actions={<Button variant="outline" onClick={() => setReload(n => n + 1)} loading={loading && !!dashboard}><RefreshCw />{uiText("Refresh")}</Button>} />
      <FilterBar
        filters={<>
          <DateRangeFilter label={uiText("Period")} value={range} onChange={r => setFilters(f => ({ ...f, from: r.from, to: r.to, preset: r.preset || 'custom' }))} />
          <FilterMulti label={uiText("Modules")} values={filters.modules} onChange={v => setFilters(f => ({ ...f, modules: v }))} options={modules.map(m => ({ id: m.id, label: m.label }))} />
        </>}
        chips={chips} onReset={() => setFilters(EMPTY_FILTERS)}
        summary={dashboard && <><strong>{formatNumber(dashboard.summary.records)}</strong> {uiText("source records in view · each source uses its own date field")}</>}
      />
      {error && <ErrorState compact message={error} onRetry={() => setReload(n => n + 1)} />}
      {!dashboard && !error && <LoadingState variant="page" label={uiText("Loading company overview…")} />}
      {dashboard && (
        <div className={loading ? 'is-refreshing' : undefined} aria-busy={loading || undefined}>
          {!widgets.length && <EmptyState title={uiText("No dashboard data for your account")} description={uiText("Your role doesn’t include any module that contributes to the dashboard, or all its modules are filtered out.")} />}
          {kpis.length > 0 && <Section title={uiText("Key figures")} description={uiText("Period: {p0}. Balances reflect the latest records.", { p0: period })}>
            <div className="stat-grid cols-4">
              {kpis.map(t => {
                const meta = KPI[t.id] || { icon: Layers3, one: 'record', noun: 'records' };
                return <StatCard key={t.id} label={t.title} value={kpiValue(t) ?? '—'} unit={t.format === 'duration' ? 'h:mm' : undefined} icon={meta.icon} tone={meta.tone}
                  caption={counted(t.count, meta.one, meta.noun)} detail={<>{t.dateLabel} · {period}</>}
                  onClick={() => w.drill(t.drill)} actionLabel={uiText("{p0}: {p1}{p2}. View {p3} source records", { p0: t.title, p1: kpiValue(t), p2: t.format === 'duration' ? ' hours' : '', p3: t.count })} />;
              })}
            </div>
          </Section>}
          {lists.length > 0 && <Section title={uiText("Needs attention")} className="mt-6">
            <div className="dash-grid">
              {lists.map(t => {
                const meta = LIST[t.id] || { title: t.title, description: t.dateLabel, icon: FileText, empty: uiText("No items to show.") };
                return (
                  <Card key={t.id} title={<span className="card-title-icon"><meta.icon aria-hidden="true" />{meta.title}{t.count > 0 && <span className="tab-count">{t.count}</span>}</span>} description={uiText("{p0} · {p1}", { p0: meta.description, p1: t.dateLabel })}
                    actions={t.count > 0 && <Button variant="ghost" size="sm" onClick={() => w.drill(t.drill)}>{uiText("View all")}<ArrowRight /></Button>}>
                    {t.rows.length ? <ul className="item-list">{t.rows.map((row: Row) => {
                      const overdue = row.date && row.date < today && !['COMPLETED', 'CANCELLED', 'CLOSED'].includes(row.status);
                      return (
                        <li key={row.id}>
                          <button type="button" className="list-item" onClick={() => (row.can_open ? openRow(w, row) : w.drill({ ...t.drill, search: row.id }))}>
                            <span className="list-item-body">
                              <span className="list-item-title">{row.title}</span>
                              <span className="list-item-meta"><span className="id-text">{row.id}</span>{row.date && <span className={overdue ? 'text-danger' : undefined}>{overdue ? uiText("Overdue · ") : ''}{formatDate(row.date)}</span>}{row.users && <span>{row.users}</span>}</span>
                            </span>
                            <span className="list-item-end"><StatusBadge value={row.status || row.category} /></span>
                          </button>
                        </li>
                      );
                    })}</ul> : <EmptyState compact title={uiText("All clear")} description={meta.empty} />}
                  </Card>
                );
              })}
            </div>
          </Section>}
          {bars.length > 0 && <Section title={uiText("Breakdown")} description={uiText("Counts of records by stage. Bars share a zero baseline; select a bar to open its records.")} className="mt-6">
            <div className="dash-grid">
              {bars.map(t => {
                const meta = CHART[t.id] || { title: t.title, order: [], one: 'record', noun: 'records' };
                const ordered = [...t.bars].sort((a: Row, b: Row) => {
                  const ia = meta.order.indexOf(a.label), ib = meta.order.indexOf(b.label);
                  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
                  return b.value - a.value || String(a.label).localeCompare(String(b.label));
                });
                const total = ordered.reduce((n: number, b: Row) => n + b.value, 0);
                return (
                  <Card key={t.id} title={meta.title} description={uiText("Number of {p0} · {p1} · {p2}", { p0: meta.noun, p1: t.dateLabel, p2: period })} actions={<Button variant="ghost" size="sm" onClick={() => w.drill(t.drill)}>{uiText("View records")}<ArrowRight /></Button>}>
                    {ordered.length ? <BarList label={meta.title} unit={meta.noun} items={ordered.map((b: Row) => ({ key: b.label, label: t.id === 'ops-shipment' ? SHIPMENT_LABEL[b.label] || statusLabel(b.label) : statusLabel(b.label), value: b.value, onSelect: () => w.drill(b.drill) }))}
                      footer={<>{counted(total, meta.one, meta.noun)} {uiText("in total")}</>} /> : <EmptyState compact title={uiText("No records in this period")} description={uiText("Try a wider period or clear the module filter.")} />}
                  </Card>
                );
              })}
            </div>
          </Section>}
          <Section title={uiText("Latest activity")} className="mt-6">
            <div className="grid-2">
              <Card title={<span className="card-title-icon"><Bell aria-hidden="true" />{uiText("Approval alerts")}{unreadAlerts.length > 0 && <span className="tab-count">{unreadAlerts.length}</span>}</span>} description={uiText("Unread alerts for requests assigned to you · not affected by the period filter")}>
                {unreadAlerts.length ? <ul className="item-list">{unreadAlerts.map(n => (
                  <li key={n.id} className="list-row">
                    <button type="button" className="list-item" onClick={() => w.show(n.target.type, n.target.id)}>
                      <span className="list-item-icon tone-warning" aria-hidden="true"><ClipboardCheck /></span>
                      <span className="list-item-body"><span className="list-item-title">{n.message}</span><span className="list-item-meta"><span className="id-text">{n.request_id}</span><span>{formatRelative(n.created_at)}</span></span></span>
                    </button>
                    <Button variant="ghost" size="xs" onClick={() => void w.perform('ops.notification.read', { id: n.id }).catch(e => toast.error(e.message))}><CheckCheck />{uiText("Mark read")}</Button>
                  </li>
                ))}</ul> : <EmptyState compact title={uiText("No unread approval alerts")} description={uiText("New requests assigned to you will appear here.")} />}
              </Card>
              <Card title={<span className="card-title-icon"><Clock3 aria-hidden="true" />{uiText("Recent changes")}</span>} description={uiText("Latest changes in the modules you can access · all dates")}>
                {dashboard.recent.length ? <ul className="item-list">{dashboard.recent.map((e: Row, i: number) => {
                  const Icon = TARGET_ICON[e.target.type] || FileText;
                  return (
                    <li key={`${e.entity_id}-${e.id}-${i}`}>
                      <button type="button" className="list-item" onClick={() => w.show(e.target.type, e.target.id)}>
                        <span className="list-item-icon" aria-hidden="true"><Icon /></span>
                        <span className="list-item-body"><span className="list-item-title">{e.action}</span><span className="list-item-meta"><span className="id-text">{e.entity_id}</span><span>{w.lookup(e.actor_id)}</span><span title={formatDateTime(e.created_at) || undefined}>{formatRelative(e.created_at)}</span></span></span>
                        <ArrowUpRight className="list-item-chevron" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}</ul> : <EmptyState compact title={uiText("No recent changes")} />}
              </Card>
            </div>
          </Section>
        </div>
      )}
    </>
  );
}

// ================================================================ drill-down record explorer
const FILTER_LABEL: Record<string, string> = translatedMap({ statuses: 'Status', categories: 'Category', assignees: 'Assigned to', clients: 'Client', accounts: 'Business Account', opportunities: 'Opportunity', users: 'User', departments: 'Department', modules: 'Module' });

export function SourceExplorer(w: Workspace & { filters: Row; onBack: () => void }) {
  useLanguage();
  const [result, setResult] = useState<Row | null>(null), [error, setError] = useState(''), [detail, setDetail] = useState<Row | null>(null), [query, setQuery] = useState(''), [reload, setReload] = useState(0);
  const key = JSON.stringify(w.filters);
  useEffect(() => {
    let live = true; setError(''); setResult(null);
    void json('/api/erp/source?filters=' + encodeURIComponent(key)).then(d => { if (live) setResult(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key, w.data, reload]);
  const setFilters = (next: Row) => w.navigate(`/dashboard/records?f=${encodeURIComponent(JSON.stringify(next))}`, { replace: true });
  const f = w.filters;
  const chips = [
    ...(f.from || f.to ? [{ key: 'period', label: uiText("Period: {p0}", { p0: formatRange(f.from, f.to) }), onRemove: () => setFilters({ ...f, from: '', to: '' }) }] : []),
    ...Object.entries(FILTER_LABEL).filter(([k]) => Array.isArray(f[k]) && f[k].length && !(f[k].length === 1 && f[k][0] === '__NONE__')).map(([k, label]) => ({ key: k, label: uiText("{p0}: {p1}", { p0: label, p1: f[k].map((v: string) => k === 'statuses' || k === 'categories' ? statusLabel(v) : k === 'assignees' || k === 'users' ? w.lookup(v) : v).join(', ') }), onRemove: () => setFilters({ ...f, [k]: [] }) })),
    ...(f.search ? [{ key: 'search', label: uiText("Search: “{p0}”", { p0: f.search }), onRemove: () => setFilters({ ...f, search: '' }) }] : []),
  ];
  const rows: Row[] = (result?.rows || []).filter((r: Row) => !query || [r.id, r.title, r.client, r.notes, r.users].join(' ').toLowerCase().includes(query.toLowerCase()));
  const hasAmount = rows.some(r => r.amount_cents !== null && r.amount_cents !== undefined), hasMinutes = rows.some(r => r.minutes !== null && r.minutes !== undefined);
  const cols: Column[] = [
    { key: 'id', header: uiText("Record"), minWidth: 220, sortValue: r => r.title, cell: r => <span className="cell-stack"><span className="cell-title">{r.title}</span><small className="id-text">{r.id}</small></span> },
    { key: 'client', header: uiText("Client"), cell: r => r.client || null },
    { key: 'date', header: result?.dateLabel || uiText("Date"), cell: r => <DateText value={r.date} /> },
    { key: 'status', header: uiText("Status"), cell: r => <StatusBadge value={r.status} /> },
    ...(hasAmount ? [{ key: 'amount_cents', header: uiText("Amount"), numeric: true, cell: (r: Row) => <Money cents={r.amount_cents} currency={w.currency} /> } as Column] : []),
    ...(hasMinutes ? [{ key: 'minutes', header: uiText("Time (h:mm)"), numeric: true, cell: (r: Row) => isMissing(r.minutes) ? null : <span className="num">{formatDuration(r.minutes)}</span> } as Column] : []),
    { key: 'users', header: uiText("People"), wrap: true, cell: r => r.users || null },
    { key: 'open', header: <span className="sr-only">{uiText("Open")}</span>, sortable: false, align: 'right', cell: r => <Button variant="ghost" size="xs" onClick={() => (r.can_open ? openRow(w, r) : setDetail(r))}>{r.can_open ? uiText("Open") : uiText("Details")}<ArrowUpRight /></Button> },
  ];
  const total = hasAmount ? rows.reduce((n, r) => n + (r.amount_cents || 0), 0) : null;
  return (
    <>
      <PageHeader crumbs={[{ label: uiText("Dashboard"), href: '#/dashboard' }, { label: uiText("Source records") }]} title={result?.title || uiText("Source records")}
        description={result ? uiText("Exactly the records behind the dashboard figure you selected. Dates use the “{p0}” field.", { p0: result.dateLabel }) : uiText("Loading the matching records…")}
        actions={<Button variant="outline" onClick={w.onBack}>{uiText("Back to dashboard")}</Button>} />
      <FilterBar search={<SearchInput value={query} onChange={setQuery} label={uiText("Search within these records")} placeholder={uiText("Search record, client or notes…")} />}
        chips={chips} onReset={() => setFilters({ sources: f.sources })}
        summary={result && <><strong>{formatNumber(rows.length)}</strong> {uiText("of ")}{formatNumber(result.total)} {plural(result.total, 'record')}{total !== null ? <> {uiText("· total ")}<strong>{formatMoney(total, w.currency)}</strong></> : null}</>} />
      {error ? <ErrorState message={error} onRetry={() => setReload(n => n + 1)} /> : !result ? <LoadingState variant="table" /> : (
        <Card flush>
          <DataTable columns={cols} rows={rows} stateKey="source-explorer" resetKey={key + query} onRowClick={r => (r.can_open ? openRow(w, r) : setDetail(r))} rowLabel={r => `Open ${r.id}`} pageSize={50}
            filtered={!!query || chips.length > 0} onClearFilters={() => { setQuery(''); setFilters({ sources: f.sources }); }} itemName="records"
            empty={<EmptyState title={uiText("No matching records")} description={uiText("Nothing in this source matches the selected figure right now.")} />} />
        </Card>
      )}
      {detail && (
        <Dialog open onOpenChange={v => { if (!v) setDetail(null); }}>
          <DialogContent className="dialog-md">
            <DialogHeader><DialogTitle>{detail.title}</DialogTitle><DialogDescription>{detail.source_label} · {detail.id}{uiText(". The original record isn’t available to your account, so its summary is shown here.")}</DialogDescription></DialogHeader>
            <div className="dialog-plain-body"><KeyValues items={[[uiText("Status"), <StatusBadge value={detail.status} />], [uiText("Client"), detail.client || null], [detail.date_label || uiText("Date"), <DateText value={detail.date} />], [uiText("Amount"), detail.amount_cents === null ? null : <Money cents={detail.amount_cents} currency={w.currency} />], [uiText("People"), detail.users || null], [uiText("Details"), <ExpandableText text={detail.notes} lines={6} />]]} /></div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// ================================================================ reports
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
const DEFAULT_FIELDS = ['id', 'title', 'client', 'date', 'status', 'amount_cents'];
const EMPTY_FORM = { get title() { return uiText("Company Task Controlling Management report"); }, sources: [] as string[], modules: [] as string[], clients: [] as string[], accounts: [] as string[], opportunities: [] as string[], users: [] as string[], statuses: [] as string[], departments: [] as string[], fields: [] as string[], from: '', to: '', preset: 'all', search: '' };

export function CentralReports(w: Workspace & { tab: string; crm: ReactNode; operations: ReactNode }) {
  useLanguage();
  const tabs = [
    ...(w.can('reports.central') ? [{ id: 'custom', label: uiText("Custom Task Controlling Management report"), href: '#/reports/custom', icon: Filter }] : []),
    ...(w.can('reports.operations') ? [{ id: 'operations', label: uiText("Operations reports"), href: '#/reports/operations', icon: Truck }] : []),
    ...(w.can('reports.crm') ? [{ id: 'crm', label: uiText("CRM reports"), href: '#/reports/crm', icon: Target }] : []),
  ];
  const active = tabs.some(t => t.id === w.tab) ? w.tab : tabs[0]?.id;
  const descriptions: Record<string, string> = {
    custom: 'Combine data from several modules with shared filters, then preview, print or download it.',
    operations: 'Approved documents feed each report automatically. Choose a report, then filter by period, customer and status.',
    crm: 'Reports 01–08 and 10 follow the supplied CRM definitions.',
  };
  return (
    <>
      <PageHeader crumbs={[{ label: uiText("Reports"), href: '#/reports' }, ...(active ? [{ label: tabs.find(t => t.id === active)!.label }] : [])]} title={uiText("Reports")} description={active ? descriptions[active] : undefined} />
      {tabs.length > 1 && <SectionTabs label={uiText("Report types")} items={tabs} active={active} />}
      {!active ? <NoAccess /> : active === 'custom' ? <CustomReport {...w} /> : active === 'operations' ? w.operations : w.crm}
    </>
  );
}

function CustomReport(w: Workspace) {
  useLanguage();
  const [options, setOptions] = useState<Row | null>(null), [optionsError, setOptionsError] = useState('');
  const [storedForm, setForm] = useViewState('reports:custom', EMPTY_FORM);
  const form = resolveRange(storedForm);
  const [report, setReport] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [changed, setChanged] = useState(false);
  useEffect(() => { let live = true; setOptionsError(''); void json('/api/erp/report-options').then(d => { if (live) setOptions(d); }).catch(e => { if (live) setOptionsError(e.message); }); return () => { live = false; }; }, [w.data]);
  const set = (key: string, value: unknown) => { setForm(f => ({ ...f, [key]: value })); setChanged(true); };
  const available: Row[] = (options?.sources || []).filter((s: Row) => !form.modules.length || form.modules.includes(s.module));
  const selected = available.filter(s => !form.sources.length || form.sources.includes(s.id));
  const fields = form.fields.length ? form.fields : DEFAULT_FIELDS;
  const payload = () => ({ ...form, sources: selected.map(s => s.id) });
  const canExport = w.can('reports.central', 'export') && selected.length > 0 && selected.every(s => s.canExport);
  const generate = async (kind: 'preview' | 'pdf' | 'print' | 'csv') => {
    setError(''); setBusy(kind); let printWindow: Window | null = null;
    try {
      if (!selected.length) throw new Error('Select at least one available data source.');
      if (kind === 'print') { printWindow = window.open('', '_blank'); if (!printWindow) throw new Error(uiText("Allow pop-ups for this page so the print view can open in a new tab.")); printWindow.opener = null; }
      const body = payload();
      if (kind === 'csv') {
        const response = await apiFetch('/api/erp/report.csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error((await response.json() as Row).error);
        download(await response.blob(), uiText("Sunny-Task Controlling Management-Report.csv")); toast.success(uiText("CSV downloaded")); return;
      }
      const result = await json(kind === 'preview' ? '/api/erp/report' : '/api/erp/report.export', body);
      setReport(result); setChanged(false);
      if (kind === 'pdf') { const { reportPDF } = await import('./report-pdf.mjs'); const pdf = await reportPDF(result, undefined, uiText, getLanguage()); download(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), uiText("Sunny-Task Controlling Management-Report.pdf")); toast.success(uiText("PDF downloaded")); }
      if (kind === 'print' && printWindow) { const url = URL.createObjectURL(new Blob([reportPrintHTML(result, uiText, getLanguage())], { type: 'text/html' })); printWindow.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (e) { printWindow?.close(); setError((e as Error).message); }
    finally { setBusy(''); }
  };
  if (optionsError) return <ErrorState message={optionsError} />;
  if (!options) return <LoadingState variant="table" rows={4} label={uiText("Loading report options…")} />;
  const range: DateRange = { from: form.from, to: form.to, preset: form.preset };
  const multi = (key: string, label: string, items: Row[]) => <FilterMulti key={key} label={label} values={(form as Row)[key]} onChange={v => set(key, v)} options={items.map(o => ({ id: o.id, label: o.label, meta: o.dateLabel ? `${o.dateLabel}${o.canExport === false ? uiText(" · view only") : ''}` : undefined }))} />;
  const chips = buildChips([
    { key: 'modules', label: uiText("Modules"), value: form.modules, display: form.modules.map(id => options.modules.find((m: Row) => m.id === id)?.label || id).join(', '), clear: () => set('modules', []) },
    { key: 'sources', label: uiText("Sources"), value: form.sources, display: form.sources.map(id => options.sources.find((s: Row) => s.id === id)?.label || id).join(', '), clear: () => set('sources', []) },
    { key: 'period', label: uiText("Period"), value: form.from || form.to ? 'x' : '', display: formatRange(form.from, form.to), clear: () => { set('from', ''); set('to', ''); set('preset', 'all'); } },
    ...(['clients', 'accounts', 'opportunities', 'users', 'statuses', 'departments'] as const).map(k => ({ key: k, label: ({ clients: 'Client', accounts: 'Business Account', opportunities: 'Opportunity', users: 'User', statuses: 'Status', departments: 'Department' } as Row)[k], value: form[k], display: form[k].map((id: string) => options[k]?.find((o: Row) => o.id === id)?.label || id).join(', '), clear: () => set(k, []) })),
    { key: 'search', label: uiText("Search"), value: form.search, display: `“${form.search}”`, clear: () => set('search', '') },
  ]);
  const cols: Column[] = report ? [{ key: 'source_label', header: uiText("Source"), cell: r => <span className="nowrap">{r.source_label}</span> }, ...report.columns.map(([key, label]: string[]) => ({
    key, header: label, numeric: key === 'amount_cents' || key === 'minutes', wrap: key === 'notes' || key === 'title',
    cell: (r: Row) => key === 'id' && r.can_open ? <button type="button" className="text-link" onClick={() => openRow(w, r)}>{r.id}<ArrowUpRight /></button> : key === 'status' ? <StatusBadge value={r.status} /> : key === 'date' ? <DateText value={r.date} /> : key === 'amount_cents' ? <Money cents={r.amount_cents} currency={report.currency} /> : key === 'notes' ? <ExpandableText text={r.notes} /> : isMissing(r[key]) ? null : formatted(r, key, report.currency),
  } as Column))] : [];
  return (
    <>
      <Card title={uiText("Report setup")} description={uiText("Selections within one filter use OR; different filters use AND. Empty selections include everything available to you. Amounts stay separate for each source.")}>
        <div className="report-setup">
          <div className="report-setup-row"><Field label={uiText("Report title")} value={form.title} onChange={v => set('title', v)} className="report-title-field" maxLength={160} /></div>
          <div className="report-setup-group">
            <p className="report-setup-label">{uiText("Data")}</p>
            <div className="filter-controls">{multi('modules', uiText("Modules"), options.modules)}{multi('sources', uiText("Data sources"), available)}</div>
          </div>
          <div className="report-setup-group">
            <p className="report-setup-label">{uiText("Filters")}</p>
            <div className="filter-controls">
              <DateRangeFilter label={uiText("Period")} value={range} onChange={r => { set('from', r.from); set('to', r.to); set('preset', r.preset || 'custom'); }} />
              {multi('statuses', uiText("Status"), options.statuses)}{multi('clients', uiText("Client"), options.clients)}{multi('accounts', uiText("Business Account"), options.accounts)}
              {multi('opportunities', uiText("Opportunity"), options.opportunities)}{multi('users', uiText("User"), options.users)}{multi('departments', uiText("Department"), options.departments)}
              <SearchInput value={form.search} onChange={v => set('search', v)} label={uiText("Search record, client or notes")} placeholder={uiText("Search record, client or notes…")} className="filter-inline-search" />
            </div>
          </div>
          {chips.length > 0 && <ul className="filter-chips" aria-label={uiText("Active report filters")}>{chips.map(c => <li key={c.key} className="chip"><span>{c.label}</span><button type="button" aria-label={uiText("Remove {p0}", { p0: c.text })} onClick={c.onRemove}><X aria-hidden="true" /></button></li>)}<li><Button variant="link" size="xs" onClick={() => { setForm(EMPTY_FORM); setChanged(true); }}>{uiText("Reset all")}</Button></li></ul>}
          <details className="disclosure">
            <summary>{uiText("Columns and date definitions")}<span className="summary-meta">{fields.length} {uiText("columns · ")}{selected.length} sources</span></summary>
            <div className="disclosure-body stack">
              <div className="check-grid" role="group" aria-label={uiText("Report columns")}>
                {Object.entries(options.fields || {}).map(([id, label]) => (
                  <label key={id} className="check-card compact"><Checkbox checked={fields.includes(id)} onCheckedChange={v => set('fields', v ? [...new Set([...fields, id])] : fields.filter((k: string) => k !== id))} /><span>{String(label)}</span></label>
                ))}
              </div>
              <p className="inline-note">{uiText("Each source uses its own date field below. Undated records are excluded when a period is selected.")}</p>
              <ul className="source-dates">{selected.map(s => <li key={s.id}><strong>{s.label}</strong><span>{s.dateLabel}</span>{s.canExport === false && <StatusBadge tone="neutral" label={uiText("View only")} />}</li>)}</ul>
            </div>
          </details>
        </div>
        <div className="report-actions">
          <Button onClick={() => void generate('preview')} loading={busy === 'preview'} disabled={!!busy || !selected.length}>{uiText("Generate preview")}</Button>
          <Button variant="outline" onClick={() => void generate('pdf')} loading={busy === 'pdf'} disabled={!!busy || !canExport}><Download />{uiText("Download PDF")}</Button>
          <Button variant="outline" onClick={() => void generate('print')} loading={busy === 'print'} disabled={!!busy || !canExport}><Printer />{uiText("Print (selectable text)")}</Button>
          <Button variant="ghost" onClick={() => void generate('csv')} loading={busy === 'csv'} disabled={!!busy || !canExport}>{uiText("Download CSV")}</Button>
          <span className="inline-note">{!selected.length ? uiText("Select at least one data source.") : !canExport ? uiText("Downloads need Export access to Reports and to every selected source.") : uiText("Downloads include every matching row (up to 5,000). PDF keeps the page layout; Print gives selectable text.")}</span>
        </div>
      </Card>
      {error && <Alert tone="danger" title={uiText("The report could not be produced")} live>{error}</Alert>}
      {report && (
        <Card title={report.title} description={uiText("{p0} · generated {p1} · {p2}", { p0: report.company, p1: formatDateTime(report.generated_at), p2: filterDescription(report) })} flush>
          {changed && <div className="card-inset"><Alert tone="warning" title={uiText("Filters changed since this preview")}>{uiText("Generate the preview again to update it. Downloads always use your current selections.")}</Alert></div>}
          <div className="card-inset"><div className="stat-grid stat-grid-fit">
            {report.sections.map((s: Row) => <StatCard key={s.id} label={s.title} value={formatNumber(s.rows.length) ?? '0'} unit="records" caption={s.total_cents !== null ? uiText("Amount {p0}", { p0: formatMoney(s.total_cents, report.currency) }) : s.total_minutes !== null ? uiText("Time {p0} h:mm", { p0: formatDuration(s.total_minutes) }) : uiText("No amounts")} detail={`Date: ${s.dateLabel}`} />)}
          </div></div>
          <DataTable dense columns={cols} rows={report.rows} rowKey={r => `${r.source}:${r.id}`} stateKey="custom-report" resetKey={report.generated_at} pageSize={50} itemName="records" caption={report.title}
            empty={<EmptyState title={uiText("No records match this combination of filters")} description={uiText("Remove a filter or widen the period, then generate the preview again.")} />} />
        </Card>
      )}
    </>
  );
}


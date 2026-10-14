import type { ReactNode } from 'react';
import { Receipt, Wallet } from 'lucide-react';
import type { Row } from './components';
import type { Workspace } from './ui';
import { performanceRows } from './operations-domain.mjs';
import { useViewState } from './router';
import { formatMoney, formatNumber, formatRange, plural } from './format';
import {
  ButtonLink, Card, DataTable, DateRangeFilter, DateText, EmptyState, FilterBar, FilterSelect, Money, NoAccess, PageHeader, SearchInput, Segmented,
  StatCard, StatusBadge, ToggleFilter, buildChips, statusLabel, type Column, type DateRange,
} from './ui-kit';

const EMPTY = { query: '', ar: '', ap: '', overdue: false, verified: '', from: '', to: '', view: 'receivables' };

/**
 * Finance register: the AR and AP entries that approved Debit Notes and Payment
 * Requests already create. Actions (receipts, AP confirmation, payout, closing)
 * stay on the Debit Note, so every row links there.
 */
export function FinancePage(w: Workspace) {
  const [f, setF] = useViewState('finance:filters', EMPTY);
  const set = (patch: Partial<typeof EMPTY>) => setF(v => ({ ...v, ...patch }));
  if (!w.can('ops.finance')) return <><PageHeader crumbs={[{ label: 'Finance' }]} title="Finance" /><NoAccess /></>;
  const all: Row[] = performanceRows(w.data);
  const rows = all.filter(r => (!f.query || `${r.id} ${r.customer} ${r.job_id} ${r.po_id}`.toLowerCase().includes(f.query.toLowerCase()))
    && (!f.ar || r.status === f.ar) && (!f.ap || r.ap_stage === f.ap) && (!f.overdue || (r.ar_cents > 0 && r.aging_days > 0))
    && (!f.verified || r.finance_verified === f.verified) && (!f.from || r.dn_date >= f.from) && (!f.to || r.dn_date <= f.to));
  const chips = buildChips([
    { key: 'query', label: 'Search', value: f.query, display: `“${f.query}”`, clear: () => set({ query: '' }) },
    { key: 'ar', label: 'AR', value: f.ar, display: statusLabel(f.ar), clear: () => set({ ar: '' }) },
    { key: 'ap', label: 'AP stage', value: f.ap, display: statusLabel(f.ap), clear: () => set({ ap: '' }) },
    { key: 'overdue', label: 'Overdue only', value: f.overdue, clear: () => set({ overdue: false }) },
    { key: 'verified', label: 'Finance verified', value: f.verified, display: f.verified, clear: () => set({ verified: '' }) },
    { key: 'period', label: 'DN date', value: f.from || f.to ? 'x' : '', display: formatRange(f.from, f.to), clear: () => set({ from: '', to: '' }) },
  ]);
  const reset = () => setF({ ...EMPTY, view: f.view });
  const sum = (key: string, list = rows) => list.reduce((n, r) => n + Number(r[key] || 0), 0);
  const unpaid = rows.filter(r => r.ar_cents > 0), overdue = unpaid.filter(r => r.aging_days > 0), openAp = rows.filter(r => r.ap_stage !== 'PAID');
  const c = w.currency;
  const idCol: Column = { key: 'id', header: 'Debit note', minWidth: 170, cell: r => <span className="cell-stack"><span className="cell-title">{r.id}</span><small>{r.customer}</small></span>, sortValue: r => r.id };
  const receivables: Column[] = [
    idCol,
    { key: 'dn_date', header: 'DN date', cell: r => <DateText value={r.dn_date} /> },
    { key: 'due_date', header: 'Due date', cell: r => <DateText value={r.due_date} /> },
    { key: 'total_cents', header: 'Original AR', numeric: true, cell: r => <Money cents={r.total_cents} currency={c} /> },
    { key: 'ar_cents', header: 'Remaining AR', numeric: true, cell: r => <Money cents={r.ar_cents} currency={c} emphasize={r.ar_cents > 0} /> },
    { key: 'aging_days', header: 'Days overdue', numeric: true, cell: r => r.ar_cents > 0 && r.aging_days > 0 ? <span className="num text-danger">{r.aging_days}</span> : <span className="num muted">0</span> },
    { key: 'af_verified', header: 'A/F verified', cell: r => <StatusBadge value={r.af_verified} /> },
    { key: 'status', header: 'AR status', cell: r => <StatusBadge value={r.status} /> },
  ];
  const payables: Column[] = [
    idCol,
    { key: 'ap_stage', header: 'AP stage', cell: r => <StatusBadge value={r.ap_stage} /> },
    { key: 'ap_estimate_cents', header: 'AP estimate', numeric: true, cell: r => <Money cents={r.ap_estimate_cents} currency={c} /> },
    { key: 'ap_cents', header: 'Current AP', numeric: true, cell: r => <Money cents={r.ap_cents} currency={c} emphasize={r.ap_stage !== 'PAID'} /> },
    { key: 'selling_cents', header: 'Selling', numeric: true, cell: r => <Money cents={r.selling_cents} currency={c} /> },
    { key: 'costing_cents', header: 'Costing', numeric: true, cell: r => <Money cents={r.costing_cents} currency={c} /> },
    { key: 'net_cents', header: 'Net', numeric: true, cell: r => <Money cents={r.net_cents} currency={c} /> },
    { key: 'margin', header: 'Margin', numeric: true, sortValue: r => (r.selling_cents ? r.net_cents / r.selling_cents : null), cell: r => r.margin === '—' ? null : <span className="num">{r.margin}</span> },
    { key: 'finance_verified', header: 'Month closed', cell: r => r.closing_date ? <DateText value={r.closing_date} /> : <StatusBadge value="NO" label="Open" /> },
  ];
  const cols = f.view === 'payables' ? payables : receivables;
  const footer: Record<string, ReactNode> = f.view === 'payables'
    ? { id: 'Total', ap_estimate_cents: <Money cents={sum('ap_estimate_cents')} currency={c} emphasize />, ap_cents: <Money cents={sum('ap_cents')} currency={c} emphasize />, selling_cents: <Money cents={sum('selling_cents')} currency={c} emphasize />, costing_cents: <Money cents={sum('costing_cents')} currency={c} emphasize />, net_cents: <Money cents={sum('net_cents')} currency={c} emphasize /> }
    : { id: 'Total', total_cents: <Money cents={sum('total_cents')} currency={c} emphasize />, ar_cents: <Money cents={sum('ar_cents')} currency={c} emphasize /> };
  const range: DateRange = { from: f.from, to: f.to, preset: f.from || f.to ? 'custom' : 'all' };
  return (
    <>
      <PageHeader crumbs={[{ label: 'Finance', href: '#/finance' }, { label: 'AR & AP register' }]} title="Finance"
        description="Receivables and payables created by approved Debit Notes and Payment Requests. Record receipts, confirm AP and close months on each Debit Note. This is a transaction register, not a general ledger."
        actions={w.can('reports.operations') && <ButtonLink href="#/reports/operations">Operations reports</ButtonLink>} />
      <div className="stat-grid cols-4">
        <StatCard label="Remaining AR" value={formatMoney(sum('ar_cents'), c) ?? '—'} icon={Receipt} tone="accent" caption={`${formatNumber(unpaid.length)} unpaid debit note${unpaid.length === 1 ? '' : 's'}`} detail="Original AR less receipts and A/F" />
        <StatCard label="Overdue AR" value={formatMoney(sum('ar_cents', overdue), c) ?? '—'} icon={Receipt} tone={overdue.length ? 'danger' : 'success'} caption={`${formatNumber(overdue.length)} past due date`} detail="Remaining AR after the due date" onClick={overdue.length ? () => set({ overdue: true, view: 'receivables' }) : undefined} actionLabel="Show overdue receivables" />
        <StatCard label="Current AP" value={formatMoney(sum('ap_cents'), c) ?? '—'} icon={Wallet} tone="purple" caption={`${formatNumber(openAp.length)} not yet paid`} detail="Estimate until approved costs arrive" onClick={() => set({ view: 'payables' })} actionLabel="Show payables" />
        <StatCard label="Net" value={formatMoney(sum('net_cents'), c) ?? '—'} caption={`Across ${formatNumber(rows.length)} debit note${rows.length === 1 ? '' : 's'}`} detail="Selling − (Costing − Cash disbursement)" />
      </div>
      <div className="toolbar mt-6">
        <Segmented label="Register" value={f.view as 'receivables' | 'payables'} onChange={v => set({ view: v })} options={[{ value: 'receivables', label: 'Receivables (AR)', icon: Receipt }, { value: 'payables', label: 'Payables (AP) & margin', icon: Wallet }]} />
      </div>
      <FilterBar
        search={<SearchInput value={f.query} onChange={v => set({ query: v })} label="Search debit notes" placeholder="Search debit note, customer or job…" />}
        filters={<>
          <DateRangeFilter label="DN date" value={range} onChange={r => set({ from: r.from, to: r.to })} />
          <FilterSelect label="AR" value={f.ar} onChange={v => set({ ar: v })} options={[['UNPAID', 'Unpaid'], ['PAID', 'Paid']]} />
          <FilterSelect label="AP stage" value={f.ap} onChange={v => set({ ap: v })} options={['NOT_RECEIVED', 'RECEIVED_UNCONFIRMED', 'CONFIRMED', 'PAID'].map(s => [s, statusLabel(s)])} />
          <FilterSelect label="Month closed" value={f.verified} onChange={v => set({ verified: v })} options={[['Yes', 'Closed'], ['No', 'Open']]} />
          <ToggleFilter label="Overdue only" pressed={f.overdue} onChange={v => set({ overdue: v })} />
        </>}
        chips={chips} onReset={reset} summary={<><strong>{rows.length}</strong> of {all.length} {plural(all.length, 'debit note')}</>}
      />
      <Card flush>
        <DataTable columns={cols} rows={rows} stateKey={`finance-${f.view}`} resetKey={JSON.stringify(f)} onRowClick={r => w.show('operations', r.id)} rowLabel={r => `Open debit note ${r.id}`}
          rowClassName={r => (r.ar_cents > 0 && r.aging_days > 0 && f.view !== 'payables' ? 'row-attention' : undefined)} defaultSort={{ key: 'dn_date', dir: 'desc' }}
          footerRow={rows.length ? footer : undefined} filtered={chips.length > 0} onClearFilters={reset} itemName="debit notes"
          empty={<EmptyState icon={Receipt} title="No finance entries yet" description={w.can('ops.dn') ? 'AR and AP entries are created when a Debit Note receives final approval.' : 'Finance entries are linked to Debit Notes. Your account also needs View access to Operations · Debit Note to see them.'} />} />
      </Card>
      <p className="page-footnote">AP starts as the Selling estimate, becomes “received · unconfirmed” when approved Payment Requests arrive, and must be confirmed by Finance before payout. The current AP replaces the estimate; the two are never added together.</p>
    </>
  );
}

import { uiText, useLanguage , translatedMap } from "./i18n";
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowUpRight, CalendarClock, CheckCircle2, Download, FileText, Link2, Mail, Megaphone, Pencil, Phone, Plus, Printer, Truck, UserRound, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { apiFetch, apiPath } from './api-client';
import { type Row, Lines, money, sum, today } from './components';
import { REPORTS } from './reports.mjs';
import { useServerReport } from './report-hook';
import { CRM_TYPES, TABLES, crmSlug } from './crm-config';
import type { Workspace } from './ui';
import { useViewState } from './router';
import { formatDate, formatDateTime, formatMoney, formatRange, isMissing, plural } from './format';
import {
  Alert, ButtonLink, Card, DataTable, DateRangeFilter, DateText, EmptyState, ErrorState, ExpandableText, FilterBar, FilterMulti, FilterSelect,
  KeyValues, LoadingState, Money, NoAccess, PageHeader, Picker, PriorityBadge, SearchInput, SectionTabs, StatCard, StatusBadge, Stepper, Tag, buildChips,
  statusLabel, type Column, type DateRange,
} from './ui-kit';

const TYPE_LABEL: Record<string, string> = translatedMap({ contact: 'Contact', lead: 'Lead', opportunity: 'Opportunity', quotation: 'Sales quotation', account: 'Business Account', campaign: 'Campaign', order: 'Sales order' });
const DESCRIPTIONS: Record<string, string> = translatedMap({
  contact: 'Customers and the people you deal with. Every lead, deal, quotation and account stays connected to its contact.',
  lead: 'Inquiries to qualify. Qualified leads convert into opportunities.',
  opportunity: 'Deals in progress. Build pricing, then close each one as won or lost.',
  quotation: 'Formal quotations created from won opportunities, with revisions and ordered approvals.',
  account: 'Created automatically when an opportunity is won. All customer history stays connected.',
  campaign: 'Outreach that generates leads from contacts who respond.',
});
const titleFor = (r: Row) => r.title || r.name || r.customer_name || r.subject || r.id;
const statusOf = (r: Row) => r.status || (r.active === 0 ? 'INACTIVE' : 'ACTIVE');
const staffOptions = (w: Workspace): [string, string][] => w.data.lookups.filter((r: Row) => r.kind === 'staff').map((r: Row) => [r.id, r.name]);

export function CrmTabs({ w, active }: { w: Workspace; active: string }) {
  useLanguage();
  const items = [{ id: 'workflow', label: uiText("Overview"), href: '#/crm' }, ...CRM_TYPES.filter(([t]) => w.can('crm.' + TABLES[t])).map(([t, label, slug]) => ({ id: slug, label, href: `#/crm/${slug}`, count: w.data[TABLES[t]].length }))];
  return <SectionTabs label={uiText("CRM sections")} items={items} active={active} />;
}

// ================================================================ record lists
export function RecordList(w: Workspace & { type: string }) {
  useLanguage();
  const { data: d, type, currency: c } = w;
  const [view, setView] = useViewState(`crm:${type}:filters`, { query: '', status: '', owner: '' });
  const [selected, setSelected] = useState<string[]>([]), [bulk, setBulk] = useState(false);
  useEffect(() => setSelected([]), [type]);
  const source: Row[] = d[TABLES[type]];
  const contact = (id: string) => d.contacts.find((r: Row) => r.id === id);
  const customer = (id: string) => contact(id)?.customer_name;
  const hasOwner = ['contact', 'lead', 'opportunity', 'account'].includes(type);
  const statuses = [...new Set(source.map(statusOf))].sort();
  const quoteTotal = (r: Row) => d.quote_revisions.find((v: Row) => v.quotation_id === r.id && v.revision === r.revision)?.total_cents;
  const rows = source.filter(r =>
    (!view.status || statusOf(r) === view.status) && (!view.owner || r.owner_id === view.owner) &&
    (!view.query || `${Object.values(r).join(' ')} ${customer(r.contact_id) || ''} ${w.lookup(r.owner_id)}`.toLowerCase().includes(view.query.toLowerCase())));
  const set = (patch: Partial<typeof view>) => setView(v => ({ ...v, ...patch }));
  const chips = buildChips([
    { key: 'query', label: uiText("Search"), value: view.query, display: `“${view.query}”`, clear: () => set({ query: '' }) },
    { key: 'status', label: uiText("Status"), value: view.status, display: statusLabel(view.status), clear: () => set({ status: '' }) },
    { key: 'owner', label: type === 'opportunity' ? uiText("Salesman") : uiText("Owner"), value: view.owner, display: w.lookup(view.owner), clear: () => set({ owner: '' }) },
  ]);
  const filtered = chips.length > 0;
  const label = CRM_TYPES.find(([t]) => t === type)?.[1] || uiText("Records");
  const person = (r: Row) => [r.first_name, r.last_name].filter(Boolean).join(' ');

  const first: Column = { key: 'title', header: TYPE_LABEL[type] || uiText("Record"), sortValue: titleFor, minWidth: 220, cell: r => <span className="cell-stack"><span className="cell-title">{type === 'contact' ? r.customer_name : type === 'lead' ? customer(r.contact_id) || r.id : titleFor(r)}</span><small className="id-text">{r.id}{type === 'quotation' ? uiText(" · Rev. {p0}", { p0: r.revision }) : ''}</small></span> };
  const cols: Column[] = [first];
  const ownerCol = (header = 'Owner'): Column => ({ key: 'owner_id', header, sortValue: r => w.lookup(r.owner_id), cell: r => w.lookup(r.owner_id) });
  if (type === 'contact') cols.push(
    { key: 'person', header: uiText("Contact person"), sortValue: person, cell: r => person(r) || null },
    { key: 'phone', header: uiText("Phone"), cell: r => r.phone || r.mobile ? <span className="nowrap">{r.phone || r.mobile}</span> : null },
    { key: 'email', header: uiText("Email"), cell: r => r.email ? <a href={`mailto:${r.email}`} onClick={e => e.stopPropagation()}>{r.email}</a> : null },
    { key: 'source', header: uiText("Source") }, ownerCol(),
  );
  if (type === 'lead') cols.push(
    { key: 'campaign_id', header: uiText("Campaign"), sortValue: r => d.campaigns.find((x: Row) => x.id === r.campaign_id)?.name || '', cell: r => d.campaigns.find((x: Row) => x.id === r.campaign_id)?.name || <span className="muted">{uiText("Direct inquiry")}</span> },
    { key: 'rating', header: uiText("Rating"), cell: r => <StatusBadge value={r.rating} /> }, { key: 'source', header: uiText("Source") }, ownerCol(),
    { key: 'created_at', header: uiText("Created"), cell: r => <DateText value={r.created_at} /> },
  );
  if (type === 'opportunity') cols.push(
    { key: 'contact_id', header: uiText("Customer"), sortValue: r => customer(r.contact_id), cell: r => customer(r.contact_id) },
    { key: 'total_cents', header: uiText("Value"), numeric: true, cell: r => <Money cents={r.total_cents} currency={c} /> },
    { key: 'probability', header: uiText("Probability"), numeric: true, cell: r => <span className="num">{r.probability}%</span> },
    { key: 'estimation', header: uiText("Expected close"), cell: r => <DateText value={r.estimation} /> }, ownerCol(uiText("Salesman")),
  );
  if (type === 'quotation') cols.push(
    { key: 'contact_id', header: uiText("Customer"), sortValue: r => customer(r.contact_id), cell: r => customer(r.contact_id) },
    { key: 'total', header: uiText("Total"), numeric: true, sortValue: quoteTotal, cell: r => <Money cents={quoteTotal(r)} currency={c} /> },
    { key: 'valid_until', header: uiText("Valid until"), sortValue: r => d.quote_revisions.find((v: Row) => v.quotation_id === r.id && v.revision === r.revision)?.valid_until, cell: r => <DateText value={d.quote_revisions.find((v: Row) => v.quotation_id === r.id && v.revision === r.revision)?.valid_until} /> },
    { key: 'opportunity_id', header: uiText("Opportunity"), cell: r => <button type="button" className="text-link" onClick={() => w.show('opportunity', r.opportunity_id)}>{r.opportunity_id}</button> },
  );
  if (type === 'account') cols.push(
    { key: 'contact_id', header: uiText("Customer contact"), sortValue: r => customer(r.contact_id), cell: r => contact(r.contact_id) ? <button type="button" className="text-link" onClick={() => w.show('contact', r.contact_id)}>{customer(r.contact_id)}</button> : null },
    ownerCol(), { key: 'created_at', header: uiText("Customer since"), cell: r => <DateText value={r.created_at} /> },
    { key: 'sales', header: uiText("Won sales"), numeric: true, sortValue: r => d.won_sales.filter((s: Row) => s.account_id === r.id).length, cell: r => <span className="num">{d.won_sales.filter((s: Row) => s.account_id === r.id).length}</span> },
  );
  if (type === 'campaign') cols.push(
    { key: 'budget_cents', header: uiText("Budget"), numeric: true, cell: r => <Money cents={r.budget_cents} currency={c} /> },
    { key: 'start_date', header: uiText("Starts"), cell: r => <DateText value={r.start_date} /> }, { key: 'end_date', header: uiText("Ends"), cell: r => <DateText value={r.end_date} /> },
    { key: 'responses', header: uiText("Leads"), numeric: true, sortValue: r => d.leads.filter((l: Row) => l.campaign_id === r.id).length, cell: r => <span className="num">{d.leads.filter((l: Row) => l.campaign_id === r.id).length}</span> },
  );
  cols.push({ key: 'status', header: uiText("Status"), sortValue: statusOf, cell: r => <StatusBadge value={statusOf(r)} /> });

  const canCreate = w.can('crm.' + TABLES[type], 'create') && !['quotation', 'account'].includes(type);
  const canBulk = type === 'contact' && w.can('crm.leads', 'create') && d.campaigns.some((x: Row) => ['DRAFT', 'ACTIVE'].includes(x.status));
  return (
    <>
      <PageHeader crumbs={[{ label: 'CRM', href: '#/crm' }, { label }]} title={label} description={DESCRIPTIONS[type]}
        actions={canCreate && <Button onClick={() => w.edit(type)}><Plus />{uiText("New ")}{TYPE_LABEL[type].toLowerCase()}</Button>} />
      <CrmTabs w={w} active={crmSlug(type)} />
      <FilterBar
        search={<SearchInput value={view.query} onChange={v => set({ query: v })} label={uiText("Search {p0}", { p0: label.toLowerCase() })} placeholder={uiText("Search {p0}, customer or owner…", { p0: label.toLowerCase() })} />}
        filters={<>
          <FilterSelect label={uiText("Status")} value={view.status} onChange={v => set({ status: v })} options={statuses.map(s => [s, statusLabel(s)])} />
          {hasOwner && <FilterSelect label={type === 'opportunity' ? uiText("Salesman") : uiText("Owner")} value={view.owner} onChange={v => set({ owner: v })} options={staffOptions(w)} allLabel="Anyone" />}
        </>}
        chips={chips} onReset={() => setView({ query: '', status: '', owner: '' })}
        summary={<><strong>{rows.length.toLocaleString('en-US')}</strong> {uiText("of ")}{source.length.toLocaleString('en-US')} {label.toLowerCase()}</>}
      />
      {canBulk && selected.length > 0 && (
        <div className="bulk-bar" role="region" aria-label={uiText("Bulk actions")}>
          <span><strong>{selected.length}</strong> selected</span>
          <Button size="sm" onClick={() => setBulk(true)}><Megaphone />{uiText("Create campaign leads")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{uiText("Clear selection")}</Button>
        </div>
      )}
      <Card flush>
        <DataTable columns={cols} rows={rows} stateKey={`crm:${type}`} resetKey={JSON.stringify(view)} onRowClick={r => w.show(type, r.id)} rowLabel={r => `Open ${TYPE_LABEL[type].toLowerCase()} ${r.id}`}
          filtered={filtered} onClearFilters={() => setView({ query: '', status: '', owner: '' })} itemName={label.toLowerCase()} caption={label}
          selection={canBulk ? { selected, onChange: ids => setSelected(ids.slice(0, 100)), label: r => r.customer_name } : undefined}
          empty={<EmptyState title={uiText("No {p0} yet", { p0: label.toLowerCase() })} description={type === 'quotation' ? uiText("Formal quotations are created from won opportunities.") : type === 'account' ? uiText("Business Accounts appear when an opportunity is closed as won.") : uiText("Create the first {p0} to get started.", { p0: TYPE_LABEL[type].toLowerCase() })} action={canCreate && <Button size="sm" onClick={() => w.edit(type)}><Plus />{uiText("New ")}{TYPE_LABEL[type].toLowerCase()}</Button>} />} />
      </Card>
      {bulk && <BulkLeads w={w} contactIds={selected} onClose={done => { setBulk(false); if (done) setSelected([]); }} />}
    </>
  );
}

function BulkLeads({ w, contactIds, onClose }: { w: Workspace; contactIds: string[]; onClose: (done: boolean) => void }) {
  useLanguage();
  const campaigns = w.data.campaigns.filter((x: Row) => ['DRAFT', 'ACTIVE'].includes(x.status));
  const [campaign, setCampaign] = useState(campaigns[0]?.id || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return (
    <Dialog open onOpenChange={v => { if (!v && !busy) onClose(false); }}>
      <DialogContent className="dialog-sm">
        <DialogHeader><DialogTitle>{uiText("Create campaign leads")}</DialogTitle><DialogDescription>{contactIds.length} {uiText("selected contact")}{contactIds.length === 1 ? '' : 's'}{uiText(". Contacts that already responded to the campaign are skipped.")}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={async e => { e.preventDefault(); if (!campaign) { setError(uiText("Select a campaign.")); return; } setBusy(true); setError(''); try { await w.perform('campaign.generate', { id: campaign, contact_ids: contactIds }); onClose(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
          <div className="dialog-body">
            {error && <Alert tone="danger" live>{error}</Alert>}
            <Picker label={uiText("Campaign")} required value={campaign} onChange={setCampaign} options={campaigns.map((x: Row) => [x.id, `${x.name} · ${statusLabel(x.status)}`])} error={error && !campaign ? error : undefined} />
          </div>
          <div className="dialog-footer"><Button type="button" variant="outline" onClick={() => onClose(false)}>{uiText("Cancel")}</Button><Button type="submit" loading={busy}>{uiText("Create leads")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ record detail
export function Detail(w: Workspace & { type: string; row: Row }) {
  useLanguage();
  const { data: d, type, row: r, currency: c } = w;
  const [tab, setTab] = useState('overview'), [revision, setRevision] = useState(String(r.revision || '')), [journey, setJourney] = useState<Row | null>(null), [journeyError, setJourneyError] = useState(''), [busy, setBusy] = useState('');
  const contactId = type === 'contact' ? r.id : r.contact_id, contact = d.contacts.find((x: Row) => x.id === contactId);
  useEffect(() => { if (type === 'quotation') setRevision(String(r.revision)); }, [type, r.revision]);
  const loadJourney = () => {
    setJourney(null); setJourneyError('');
    if (contactId && w.can('crm.contacts')) void apiFetch(`/api/journey?contact=${encodeURIComponent(contactId)}`).then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error || uiText("Unable to load the customer journey.")); setJourney(body); }).catch(e => setJourneyError(e.message));
  };
  useEffect(loadJourney, [contactId, d]); // eslint-disable-line react-hooks/exhaustive-deps
  const command = async (action: string, data: Row, key: string) => { setBusy(key); try { const result = await w.perform(action, data); if (result.type && result.id) w.show(result.type, result.id); } catch (e) { toast.error((e as Error).message); } finally { setBusy(''); } };

  // ---------------- actions (primary action is filled; the rest are outline)
  const actions: ReactNode[] = [];
  const add = (key: string, label: string, fn: () => void, variant: 'default' | 'outline' = 'outline', icon?: ReactNode) => actions.push(<Button key={key} loading={busy === key} disabled={!!busy} variant={variant} onClick={fn}>{icon}{label}</Button>);
  const resource = 'crm.' + (TABLES[type] || type), canUpdate = w.can(resource, 'update');
  if (canUpdate && (['contact', 'campaign', 'account'].includes(type) || (type === 'lead' && r.status !== 'CONVERTED') || (type === 'opportunity' && r.status === 'OPEN'))) add('edit', uiText("Edit"), () => w.edit(type, r), 'outline', <Pencil />);
  if (type === 'contact') {
    if (w.can('crm.leads', 'create')) add('lead', uiText("New lead"), () => w.edit('lead', { contact_id: r.id, owner_id: r.owner_id, source: r.source }));
    if (w.can('crm.opportunities', 'create')) add('opp', uiText("New opportunity"), () => w.edit('opportunity', { contact_id: r.id, owner_id: r.owner_id }), 'default', <Plus />);
  }
  if (type === 'campaign' && ['DRAFT', 'ACTIVE'].includes(r.status) && w.can('crm.leads', 'create')) add('generate', uiText("Generate leads"), () => w.edit('generate', r), 'default', <Megaphone />);
  if (type === 'lead' && ['QUALIFIED', 'CONVERTED'].includes(r.status) && w.can('crm.opportunities', 'create')) add('convert', r.status === 'CONVERTED' ? uiText("Add opportunity") : uiText("Convert to opportunity"), () => w.edit('opportunity', { contact_id: r.contact_id, lead_id: r.id, owner_id: r.owner_id }), 'default');
  if (type === 'opportunity' && r.status === 'OPEN' && canUpdate) { add('lost', uiText("Mark lost"), () => w.edit('close', { ...r, status: 'LOST' })); add('won', uiText("Close as won"), () => w.edit('close', { ...r, status: 'WON' }), 'default', <CheckCircle2 />); }
  const quote = type === 'opportunity' ? d.quotations.find((q: Row) => q.opportunity_id === r.id) : null;
  if (type === 'opportunity' && r.status === 'WON') {
    if (quote) add('quote', uiText("Open sales quotation"), () => w.show('quotation', quote.id), 'default', <ArrowUpRight />);
    else if (w.can('crm.quotations', 'create')) add('quote', uiText("Create sales quotation"), () => void command('quotation.create', { opportunity_id: r.id }, 'quote'), 'default', <Plus />);
  }
  const currentRevision = type === 'quotation' ? d.quote_revisions.find((q: Row) => q.quotation_id === r.id && q.revision === r.revision) : null;
  const chain = type === 'quotation' ? JSON.parse(r.approval_chain || '[]') : [];
  if (type === 'quotation') {
    const qUpdate = w.can('crm.quotations', 'update'), qApprove = w.can('crm.quotations', 'approve');
    if (qUpdate && ['DRAFT', 'REJECTED', 'EXPIRED'].includes(r.status)) add('rev', uiText("Save new revision"), () => w.edit('quotation', r), 'outline', <Pencil />);
    if (qUpdate && r.status === 'DRAFT') add('submit', uiText("Submit for approval"), () => w.edit('process', { ...r, process: 'submit' }), 'default');
    if (r.status === 'SUBMITTED' && qApprove && chain[r.approval_step]?.approver_id === w.actor) { add('return', uiText("Return"), () => w.edit('process', { ...r, process: 'return' })); add('reject', uiText("Reject"), () => w.edit('process', { ...r, process: 'reject' })); add('approve', `Approve step ${r.approval_step + 1}`, () => w.edit('process', { ...r, process: 'approve' }), 'default', <CheckCircle2 />); }
    if (qUpdate && r.status === 'APPROVED') add('accept', uiText("Record customer acceptance"), () => w.edit('process', { ...r, process: 'accept' }), 'default');
    if (qUpdate && ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(r.status) && currentRevision?.valid_until < today()) add('expire', uiText("Mark expired"), () => w.edit('process', { ...r, process: 'expire' }));
    if (r.status === 'ACCEPTED' && w.can('ops.legacy', 'create')) add('order', uiText("Create sales order"), () => void command('order.create', { quotation_id: r.id }, 'order'), 'default');
    if (w.can('crm.quotations', 'export')) actions.unshift(<ButtonLink key="print" href={apiPath(`/api/quotation.print?id=${encodeURIComponent(r.id)}&revision=${Number(revision) || r.revision}`)} target="_blank" rel="noopener"><Printer />{uiText("Print / PDF")}</ButtonLink>);
  }
  const invoice = type === 'order' ? d.invoices.find((i: Row) => i.order_id === r.id) : null;
  const paid = invoice ? sum(d.payments.filter((p: Row) => p.invoice_id === invoice.id), 'amount_cents') : 0;
  if (type === 'order' && w.can('ops.legacy', 'update')) {
    if (r.status === 'ORDERED') add('ship', uiText("Record delivery"), () => w.edit('shipment', r), 'default', <Truck />);
    if (r.status === 'SHIPPED') add('invoice', uiText("Create invoice"), () => w.edit('invoice', r), 'default');
    if (r.status === 'INVOICED') add('pay', uiText("Record payment"), () => w.edit('payment', { invoice_id: invoice.id, balance: invoice.total_cents - paid, amount: ((invoice.total_cents - paid) / 100).toFixed(2) }), 'default');
  }

  const activities = d.activities.filter((a: Row) => a.contact_id === contactId), documents = d.documents.filter((a: Row) => a.contact_id === contactId);
  const activityParent = type === 'quotation' || type === 'order' ? 'OPPORTUNITY' : type.toUpperCase();
  const activityId = type === 'quotation' ? r.opportunity_id : type === 'order' ? d.quotations.find((q: Row) => q.id === r.quotation_id)?.opportunity_id : r.id;
  const log = () => w.edit('activity', { parent_type: activityParent === 'CAMPAIGN' ? 'TASK' : activityParent, parent_id: activityParent === 'CAMPAIGN' ? '' : activityId, type: activityParent === 'ACCOUNT' ? "AFTER SALE" : activityParent === 'OPPORTUNITY' ? 'OPPORTUNITY' : 'FOLLOWUP', channel: 'CALL' });
  const snapshot = type === 'opportunity' ? journey?.won_sales?.find((s: Row) => s.opportunity_id === r.id) : type === 'quotation' ? journey?.accepted_sales?.find((s: Row) => s.quotation_id === r.id) : null;
  const snap = snapshot ? JSON.parse(snapshot.snapshot_json) : null;
  const wonSale = type === 'opportunity' ? d.won_sales.find((s: Row) => s.opportunity_id === r.id) : null;

  // ---------------- summary strip & details
  const summary: [string, ReactNode][] = [];
  if (type === 'opportunity') summary.push([uiText("Value"), <Money cents={r.total_cents} currency={c} emphasize />], [uiText("Probability"), <span className="num">{r.probability}%</span>], [uiText("Expected close"), <DateText value={r.estimation} />], [uiText("Salesman"), w.lookup(r.owner_id)]);
  if (type === 'quotation') summary.push([uiText("Total"), <Money cents={currentRevision?.total_cents} currency={c} emphasize />], [uiText("Revision"), `Rev. ${r.revision}`], [uiText("Valid until"), <DateText value={currentRevision?.valid_until} />], [uiText("Approval"), r.status === 'SUBMITTED' ? `Step ${r.approval_step + 1} of ${chain.length}` : statusLabel(r.status)]);
  if (type === 'account') summary.push([uiText("Owner"), w.lookup(r.owner_id)], [uiText("Customer since"), <DateText value={r.created_at} />], [uiText("Won sales"), <span className="num">{d.won_sales.filter((s: Row) => s.account_id === r.id).length}</span>], [uiText("Operations requests"), <span className="num">{d.ops_requests.filter((o: Row) => o.account_id === r.id).length}</span>]);
  if (type === 'contact') summary.push([uiText("Owner"), w.lookup(r.owner_id)], [uiText("Open opportunities"), <span className="num">{d.opportunities.filter((o: Row) => o.contact_id === r.id && o.status === 'OPEN').length}</span>], [uiText("Open activities"), <span className="num">{activities.filter((a: Row) => a.status === 'OPEN').length}</span>], [uiText("Customer since"), <DateText value={r.created_at} />]);
  if (type === 'lead') summary.push([uiText("Rating"), <StatusBadge value={r.rating} />], [uiText("Owner"), w.lookup(r.owner_id)], [uiText("Campaign"), d.campaigns.find((x: Row) => x.id === r.campaign_id)?.name || uiText("Direct inquiry")], [uiText("Created"), <DateText value={r.created_at} />]);
  if (type === 'campaign') summary.push([uiText("Budget"), <Money cents={r.budget_cents} currency={c} emphasize />], [uiText("Runs"), formatRange(r.start_date, r.end_date)], [uiText("Leads"), <span className="num">{d.leads.filter((l: Row) => l.campaign_id === r.id).length}</span>], [uiText("Converted"), <span className="num">{d.leads.filter((l: Row) => l.campaign_id === r.id && l.status === 'CONVERTED').length}</span>]);
  if (type === 'order') summary.push([uiText("Order value"), <Money cents={r.total_cents} currency={c} emphasize />], [uiText("Invoiced"), invoice ? <Money cents={invoice.total_cents} currency={c} /> : uiText("Not yet")], [uiText("Paid"), <Money cents={paid} currency={c} />], [uiText("Balance"), invoice ? <Money cents={invoice.total_cents - paid} currency={c} /> : '—']);
  const details: [string, ReactNode][] = [
    [uiText("Customer"), contact ? <button type="button" className="text-link" onClick={() => w.show('contact', contact.id)}>{contact.customer_name}</button> : r.name || null],
    [uiText("Contact person"), contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null],
    ...(r.owner_id ? [[uiText("Owner"), w.lookup(r.owner_id)] as [string, ReactNode]] : []),
    ...(r.branch_id ? [[uiText("Branch"), w.lookup(r.branch_id)] as [string, ReactNode]] : []),
    ...(r.class_id ? [[uiText("Classification"), w.lookup(r.class_id)] as [string, ReactNode]] : []),
    ...(r.partner_id ? [[uiText("Partner"), w.lookup(r.partner_id)] as [string, ReactNode]] : []),
    ...(type === 'contact' ? [[uiText("Email"), r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : null], [uiText("Phone"), r.phone || null], [uiText("Mobile"), r.mobile || null], [uiText("Address"), r.address || null], [uiText("Source"), r.source || null]] as [string, ReactNode][] : []),
    ...(type === 'opportunity' ? [[uiText("Customer reference"), r.customer_reference || null], [uiText("Costing"), <Money cents={r.costing_cents} currency={c} />], [uiText("CRM payment received"), <Money cents={r.payment_received_cents} currency={c} />], [uiText("Commission"), <Money cents={r.commission_cents} currency={c} />]] as [string, ReactNode][] : []),
    ...(type === 'campaign' ? [[uiText("Audience"), r.audience || null], [uiText("Class"), r.class_id ? w.lookup(r.class_id) : null]] as [string, ReactNode][] : []),
    ...(type === 'lead' ? [[uiText("Source"), r.source || null], [uiText("Status"), <StatusBadge value={r.status} />]] as [string, ReactNode][] : []),
    [uiText("Created"), <DateText value={r.created_at} withTime />],
  ];
  const plural = type === 'order' ? uiText("Sales orders") : CRM_TYPES.find(([t]) => t === type)?.[1] || '';
  const crumbs = type === 'order' ? [{ label: uiText("Operations"), href: '#/operations' }, { label: uiText("Earlier sales handoffs"), href: '#/operations' }, { label: r.id }] : [{ label: 'CRM', href: '#/crm' }, { label: plural, href: `#/crm/${crmSlug(type)}` }, { label: r.id }];
  const meta = <>
    <span className="meta-item"><Tag>{TYPE_LABEL[type]}</Tag><span className="id-text">{r.id}</span></span>
    {contact && type !== 'contact' && <span className="meta-item"><UserRound aria-hidden="true" /><button type="button" className="text-link" onClick={() => w.show('contact', contact.id)}>{contact.customer_name}</button></span>}
    {r.updated_at && <span className="meta-item"><CalendarClock aria-hidden="true" />{uiText("Updated ")}{formatDateTime(r.updated_at)}</span>}
  </>;

  return (
    <>
      <PageHeader crumbs={crumbs} title={titleFor(r)} badge={<StatusBadge value={statusOf(r)} />} meta={meta} actions={actions.length ? actions : undefined} />
      {summary.length > 0 && <dl className="summary-strip">{summary.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{isMissing(value) ? '—' : value}</dd></div>)}</dl>}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="tabs-line" aria-label={uiText("Record sections")}>
          <TabsTrigger value="overview">{uiText("Overview")}</TabsTrigger>
          {contactId && <TabsTrigger value="journey">{uiText("Customer journey")}</TabsTrigger>}
          {contactId && <TabsTrigger value="activity">{uiText("Activities")}<span className="tab-count">{activities.length}</span></TabsTrigger>}
          {contactId && <TabsTrigger value="documents">{uiText("Documents")}<span className="tab-count">{documents.length}</span></TabsTrigger>}
          {['opportunity', 'quotation', 'account'].includes(type) && <TabsTrigger value="snapshot">{uiText("Sale snapshots")}</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <div className="two-col">
            <div className="stack">
              {type === 'opportunity' && <Card title={uiText("Pricing")} description={uiText("Line items quoted in this opportunity.")} flush={false}>
                {r.status === 'WON' && wonSale && <Alert tone="success" title={uiText("Won · pricing and history preserved")}>{uiText("Business Account ")}<button type="button" className="text-link" onClick={() => w.show('account', wonSale.account_id)}>{wonSale.account_id}</button> {uiText("is linked. ")}{quote ? uiText("The formal Sales Quotation is in progress.") : uiText("Create the formal Sales Quotation next.")}</Alert>}
                {r.status === 'LOST' && <Alert tone="warning" title={uiText("Closed as lost")}>{r.lost_reason || uiText("No reason recorded.")}</Alert>}
                <div className={r.status !== 'OPEN' ? 'mt-4' : ''}><Lines lines={d.opportunity_lines.filter((l: Row) => l.opportunity_id === r.id)} currency={c} /></div>
              </Card>}
              {type === 'quotation' && <>
                <Card title={uiText("Quotation revisions")} actions={<Picker hideLabel label={uiText("Revision")} value={revision} onChange={setRevision} options={d.quote_revisions.filter((v: Row) => v.quotation_id === r.id).map((v: Row) => [String(v.revision), `Revision ${v.revision}${v.revision === r.revision ? uiText(" · latest") : ''}`])} allowNone={false} />}><QuoteRevision {...w} row={r} revision={Number(revision) || r.revision} /></Card>
                <Card title={uiText("Approval chain")} description={uiText("Each step must be approved in order by the assigned staff member.")}><Approval {...w} row={r} /></Card>
                <Card title={uiText("Sales documents")}><RelatedOrders {...w} quotationId={r.id} /></Card>
              </>}
              {type === 'order' && <>
                <Card title={uiText("Delivery progress")}>
                  <Stepper label={uiText("Sales order progress")} steps={['ORDERED', 'SHIPPED', 'INVOICED', 'PAID'].map((s, i, all) => ({ label: statusLabel(s), state: all.indexOf(r.status) > i || r.status === 'PAID' ? 'done' : all.indexOf(r.status) === i ? 'current' : 'upcoming' }))} />
                  <div className="mt-4"><KeyValues columns={2} items={[[uiText("Sales order value"), <Money cents={r.total_cents} currency={c} />], [uiText("Source quotation"), <button type="button" className="text-link" onClick={() => w.show('quotation', r.quotation_id)}>{r.quotation_id}</button>], [uiText("Business Account"), <button type="button" className="text-link" onClick={() => w.show('account', r.account_id)}>{r.account_id}</button>], [uiText("Created"), <DateText value={r.created_at} />]]} /></div>
                  {d.shipments.filter((s: Row) => s.order_id === r.id).map((s: Row) => <Alert key={s.id} tone="neutral" icon={Truck} title={uiText("{p0} · {p1}", { p0: s.id, p1: s.reference })}>{formatDate(s.shipment_date)}{s.notes ? uiText(" · {p0}", { p0: s.notes }) : ''}</Alert>)}
                </Card>
                <Card title={uiText("Invoice and payments")}>
                  {invoice ? <>
                    <dl className="summary-strip compact"><div><dt>{invoice.id}</dt><dd><Money cents={invoice.total_cents} currency={c} /></dd></div><div><dt>{uiText("Paid")}</dt><dd><Money cents={paid} currency={c} /></dd></div><div><dt>{uiText("Remaining")}</dt><dd><Money cents={invoice.total_cents - paid} currency={c} emphasize /></dd></div><div><dt>{uiText("Due")}</dt><dd><DateText value={invoice.due_date} /></dd></div></dl>
                    <DataTable rows={d.payments.filter((p: Row) => p.invoice_id === invoice.id)} pageSize={0} columns={[{ key: 'id', header: uiText("Payment") }, { key: 'payment_date', header: uiText("Date"), cell: p => <DateText value={p.payment_date} /> }, { key: 'reference', header: uiText("Reference") }, { key: 'amount_cents', header: uiText("Amount"), numeric: true, cell: p => <Money cents={p.amount_cents} currency={c} /> }]} empty={<EmptyState compact title={uiText("No payments recorded")} />} />
                  </> : <EmptyState compact title={uiText("Not invoiced yet")} description={uiText("Record the delivery, then create the invoice.")} />}
                </Card>
                <Card title={uiText("Confirmed order lines")}><Lines lines={JSON.parse(r.snapshot_json).quotation.final_revision.lines} currency={c} /></Card>
              </>}
              {!['opportunity', 'quotation', 'order'].includes(type) && <Card title={type === 'campaign' ? uiText("Campaign description") : uiText("Notes")}><ExpandableText text={r.notes || r.description} lines={6} empty={<p className="muted">{uiText("No notes yet.")}</p>} />{r.reason && <Alert tone="warning" title={uiText("Reason")} className="mt-4">{r.reason}</Alert>}</Card>}
              {type === 'campaign' && <Card title={uiText("Campaign responses")} description={uiText("Leads generated from this campaign.")} flush>
                <DataTable rows={d.leads.filter((l: Row) => l.campaign_id === r.id)} onRowClick={l => w.show('lead', l.id)} stateKey="campaign-leads" columns={[{ key: 'id', header: uiText("Lead"), cell: l => <span className="cell-title">{l.id}</span> }, { key: 'contact_id', header: uiText("Customer"), sortValue: l => d.contacts.find((x: Row) => x.id === l.contact_id)?.customer_name, cell: l => d.contacts.find((x: Row) => x.id === l.contact_id)?.customer_name }, { key: 'rating', header: uiText("Rating"), cell: l => <StatusBadge value={l.rating} /> }, { key: 'status', header: uiText("Status"), cell: l => <StatusBadge value={l.status} /> }]} empty={<EmptyState compact title={uiText("No responses yet")} description={uiText("Use Generate leads to record responses from contacts.")} />} />
              </Card>}
              {contactId && !['quotation', 'order'].includes(type) && <Connected {...w} contactId={contactId} />}
            </div>
            <aside className="stack" aria-label={uiText("Record details")}>
              <Card title={uiText("Details")}><KeyValues dense items={details} /></Card>
              {contactId && w.can('crm.activities') && <Card title={uiText("Next activities")} actions={w.can('crm.activities', 'create') && <Button variant="ghost" size="sm" onClick={log}><Plus />{uiText("Log")}</Button>}>
                {activities.filter((a: Row) => a.status === 'OPEN').sort((a: Row, b: Row) => a.start_at.localeCompare(b.start_at)).slice(0, 3).map((a: Row) => (
                  <button key={a.id} type="button" className="list-item" onClick={() => w.edit('activity', a)}>
                    <span className="list-item-icon" aria-hidden="true">{a.channel === 'CALL' ? <Phone /> : a.channel === 'EMAIL' ? <Mail /> : a.channel === 'MEETING' ? <Users /> : <FileText />}</span>
                    <span className="list-item-body"><span className="list-item-title">{a.subject}</span><span className="list-item-meta"><span className={Date.parse(a.start_at) < Date.now() ? 'text-danger' : ''}>{formatDateTime(a.start_at)}</span><span>{w.lookup(a.assigned_to)}</span></span></span>
                  </button>
                ))}
                {!activities.some((a: Row) => a.status === 'OPEN') && <p className="muted small">{uiText("No open activities.")}</p>}
              </Card>}
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="journey">
          <div className="two-col">
            <Card title={uiText("Customer history")} description={uiText("Every change across CRM, operations and tasks for this customer, newest first.")}>
              {journeyError ? <ErrorState compact message={journeyError} onRetry={loadJourney} /> : journey ? <Timeline events={journey.events} lookup={w.lookup} /> : <LoadingState variant="table" rows={4} label={uiText("Loading customer history…")} />}
            </Card>
            <aside className="stack"><Connected {...w} contactId={contactId} compact /></aside>
          </div>
        </TabsContent>
        <TabsContent value="activity">
          <Card title={uiText("Calls, meetings, notes and follow-ups")} flush actions={w.can('crm.activities', 'create') && <Button size="sm" onClick={log}><Plus />{uiText("Log activity")}</Button>}>
            <DataTable rows={[...activities].sort((a: Row, b: Row) => b.start_at.localeCompare(a.start_at))} onRowClick={a => w.edit('activity', a)} stateKey="detail-activities"
              columns={[{ key: 'subject', header: uiText("Activity"), minWidth: 220, cell: a => <span className="cell-stack"><span className="cell-title">{a.subject}</span><small>{statusLabel(a.channel)} · {statusLabel(a.type)}</small></span> }, { key: 'summary', header: uiText("Notes"), wrap: true, cell: a => <ExpandableText text={a.summary} /> }, { key: 'parent_id', header: uiText("Linked record"), cell: a => a.parent_id || <span className="muted">{uiText("Internal")}</span> }, { key: 'start_at', header: uiText("When"), cell: a => <DateText value={a.start_at} withTime /> }, { key: 'status', header: uiText("Status"), cell: a => <StatusBadge value={a.status} /> }]}
              empty={<EmptyState compact title={uiText("No activities yet")} description={uiText("Log calls, meetings and follow-ups to keep the customer history complete.")} />} />
          </Card>
        </TabsContent>
        <TabsContent value="documents">
          <Card title={uiText("Document links")} description={uiText("Links stay connected across the customer journey. Files remain with their original provider.")} actions={w.can('crm.documents', 'create') && <Button size="sm" onClick={() => w.edit('document', { parent_type: type === 'order' ? 'CONTACT' : type === 'campaign' ? 'CONTACT' : type.toUpperCase(), parent_id: type === 'order' ? contactId : r.id })}><Link2 />{uiText("Link document")}</Button>}>
            {documents.length ? <ul className="item-list">{documents.map((doc: Row) => <li key={doc.id}><a className="list-item" href={doc.url} target="_blank" rel="noopener noreferrer"><span className="list-item-icon" aria-hidden="true"><FileText /></span><span className="list-item-body"><span className="list-item-title">{doc.title}</span><span className="list-item-meta"><span>{doc.parent_type.toLowerCase()} {doc.parent_id}</span><span>{formatDate(doc.created_at)}</span><span className="doc-url">{doc.url}</span></span></span><ArrowUpRight className="list-item-chevron" aria-hidden="true" /><span className="sr-only">{uiText("(opens in a new tab)")}</span></a></li>)}</ul> : <EmptyState compact title={uiText("No documents linked yet")} description={uiText("Link contracts, proposals or shared folders so the whole team can find them.")} />}
          </Card>
        </TabsContent>
        <TabsContent value="snapshot">
          <Card title={uiText("Preserved sale records")} description={uiText("Snapshots are saved when a sale is won and when a quotation is accepted. Later edits do not change them.")}>
            {journeyError ? <ErrorState compact message={journeyError} onRetry={loadJourney} /> : !journey ? <LoadingState variant="table" rows={3} label={uiText("Loading snapshots…")} /> : snap ? <SnapshotView snapshot={snap} currency={c} /> : type === 'account' ? <div className="stack">
              {journey.won_sales.filter((sale: Row) => sale.account_id === r.id).map((sale: Row) => <details className="disclosure" key={sale.opportunity_id}><summary>{sale.opportunity_id} {uiText("· closed won")}<span className="summary-meta">{formatDate(sale.closed_at)}</span></summary><div className="disclosure-body"><SnapshotView snapshot={JSON.parse(sale.snapshot_json)} currency={c} /></div></details>)}
              {journey.accepted_sales.map((sale: Row) => <details className="disclosure" key={sale.quotation_id}><summary>{sale.quotation_id} {uiText("· accepted revision ")}{sale.revision}<span className="summary-meta">{formatDate(sale.accepted_at)}</span></summary><div className="disclosure-body"><SnapshotView snapshot={JSON.parse(sale.snapshot_json)} currency={c} /></div></details>)}
              {!journey.won_sales.some((sale: Row) => sale.account_id === r.id) && !journey.accepted_sales.length && <EmptyState compact title={uiText("No sale snapshots yet")} />}
            </div> : <EmptyState compact title={uiText("No snapshot yet")} description={type === 'quotation' ? uiText("The acceptance snapshot is created when the customer accepts the approved quotation.") : uiText("The won-sale snapshot is created when you close the opportunity as won.")} />}
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function QuoteRevision(w: Workspace & { row: Row; revision: number }) {
  useLanguage();
  const rev = w.data.quote_revisions.find((r: Row) => r.quotation_id === w.row.id && r.revision === w.revision);
  if (!rev) return <EmptyState compact title={uiText("Choose a saved revision")} />;
  return (
    <div className="stack">
      {rev.revision !== w.row.revision && <Alert tone="info" title={uiText("Historical revision · read-only")}>{uiText("Actions at the top of the page apply to the latest revision (")}{w.row.revision}).</Alert>}
      <KeyValues columns={3} dense items={[[uiText("Quotation date"), <DateText value={rev.quotation_date} />], [uiText("Valid until"), <DateText value={rev.valid_until} />], [uiText("Saved by"), `${w.lookup(rev.created_by)} · ${formatDateTime(rev.created_at)}`]]} />
      <Lines lines={JSON.parse(rev.lines_json)} currency={w.currency} />
      {rev.notes && <div><p className="text-label">{uiText("Notes / terms")}</p><ExpandableText text={rev.notes} lines={4} /></div>}
    </div>
  );
}

function Approval(w: Workspace & { row: Row }) {
  useLanguage();
  const q = w.row, chain = JSON.parse(q.approval_chain || '[]'), steps = chain.length ? chain : w.data.approval_steps;
  const approvals = w.data.approvals.filter((a: Row) => a.quotation_id === q.id);
  const approvedAll = ['APPROVED', 'ACCEPTED', 'CONVERTED'].includes(q.status);
  return (
    <div className="stack">
      {q.status === 'SUBMITTED' && <Alert tone="warning" title={uiText("Waiting for step {p0}: {p1}", { p0: q.approval_step + 1, p1: w.lookup(chain[q.approval_step]?.approver_id) })}>{chain[q.approval_step]?.approver_id === w.actor ? uiText("You are the assigned approver for this step.") : uiText("This staff member must sign in with Approve permission to review it.")}</Alert>}
      <Stepper label={uiText("Approval steps")} orientation="vertical" steps={steps.map((step: Row, i: number) => ({
        label: w.lookup(step.approver_id),
        description: chain.length ? (approvedAll || (q.status === 'SUBMITTED' && i < q.approval_step) ? uiText("Approved") : q.status === 'SUBMITTED' && i === q.approval_step ? uiText("Awaiting approval") : q.status === 'REJECTED' ? uiText("Not approved") : uiText("Not reached")) : uiText("Configured approver"),
        state: chain.length && (approvedAll || (q.status === 'SUBMITTED' && i < q.approval_step)) ? 'done' : q.status === 'SUBMITTED' && i === q.approval_step ? 'current' : 'upcoming',
      }))} />
      <DataTable rows={approvals} pageSize={0} dense columns={[{ key: 'revision', header: uiText("Rev."), numeric: true }, { key: 'step', header: uiText("Step"), numeric: true }, { key: 'action', header: uiText("Action"), cell: a => <StatusBadge value={a.action} /> }, { key: 'actor_id', header: uiText("By"), cell: a => w.lookup(a.actor_id) }, { key: 'comment', header: uiText("Comment"), wrap: true, minWidth: 140, cell: a => a.comment || null }, { key: 'created_at', header: uiText("When"), cell: a => <DateText value={a.created_at} withTime /> }]} empty={<EmptyState compact title={uiText("No approval actions yet")} />} />
    </div>
  );
}

function RelatedOrders(w: Workspace & { quotationId: string }) {
  useLanguage();
  const orders = w.data.orders.filter((o: Row) => o.quotation_id === w.quotationId);
  return <DataTable rows={orders} pageSize={0} onRowClick={o => w.show('order', o.id)} columns={[{ key: 'id', header: uiText("Sales order"), cell: o => <span className="cell-title">{o.id}</span> }, { key: 'status', header: uiText("Status"), cell: o => <StatusBadge value={o.status} /> }, { key: 'total_cents', header: uiText("Total"), numeric: true, cell: o => <Money cents={o.total_cents} currency={w.currency} /> }]} empty={<EmptyState compact title={uiText("No sales documents yet")} description={uiText("They appear after customer acceptance and Sales Order creation.")} />} />;
}

/** Everything linked to one customer: CRM records, operations requests, tasks and meetings. */
function Connected(w: Workspace & { contactId: string; compact?: boolean }) {
  useLanguage();
  const types = ['lead', 'opportunity', 'quotation', 'account', 'order'].filter(t => t === 'order' ? w.can('ops.legacy') : w.can('crm.' + TABLES[t]));
  const label: Record<string, string> = { lead: 'Leads', opportunity: 'Opportunities', quotation: 'Sales quotations', account: 'Business Accounts', order: 'Sales orders' };
  const ops = w.data.ops_requests.filter((r: Row) => r.contact_id === w.contactId);
  const work = [...w.data.tm_tasks.filter((r: Row) => r.contact_id === w.contactId).map((r: Row) => ({ ...r, kind: 'tm_task', label: uiText("Task") })), ...w.data.tm_meetings.filter((r: Row) => r.contact_id === w.contactId).map((r: Row) => ({ ...r, kind: 'tm_meeting', label: uiText("Meeting") }))];
  return (
    <>
      <Card title={uiText("Connected records")} description={w.compact ? undefined : uiText("Every record linked to this customer.")}>
        <div className={w.compact ? 'connected-list' : 'connected-grid'}>
          {types.map(type => {
            const rows = w.data[TABLES[type]].filter((r: Row) => r.contact_id === w.contactId);
            return (
              <div key={type} className="connected-group">
                <p className="connected-title">{label[type]}<span className="tab-count">{rows.length}</span></p>
                {rows.length ? <ul className="item-list">{rows.map((r: Row) => <li key={r.id}><button type="button" className="list-item compact" onClick={() => w.show(type, r.id)}><span className="list-item-body"><span className="list-item-title">{r.title || r.name || r.id}</span><span className="list-item-meta"><span>{r.id}</span></span></span><StatusBadge value={r.status} /></button></li>)}</ul> : <p className="muted small">{uiText("None yet.")}</p>}
              </div>
            );
          })}
        </div>
      </Card>
      {!w.compact && Object.keys(w.data.auth.permissions).some(k => k.startsWith('ops.') && w.can(k)) && <Card title={uiText("Operations requests")} description={uiText("Quotations, POs, Job Files, Debit Notes and Payment Requests for this customer.")} flush>
        <DataTable rows={ops} onRowClick={r => w.show('operations', r.id)} stateKey="connected-ops" pageSize={10} columns={[{ key: 'id', header: uiText("Request"), cell: r => <span className="cell-stack"><span className="cell-title">{r.id}</span><small>{statusLabel(r.type)} {uiText("· rev ")}{r.revision}</small></span> }, { key: 'source_id', header: uiText("Source"), cell: r => r.source_id || null }, { key: 'date', header: uiText("Document date"), sortValue: r => r.payload.document_date, cell: r => <DateText value={r.payload.document_date} /> }, { key: 'total', header: uiText("Amount"), numeric: true, sortValue: r => r.payload.total_cents, cell: r => r.type === 'QUOTATION' ? <span className="muted">{uiText("Rate card")}</span> : <Money cents={r.payload.total_cents} currency={w.currency} /> }, { key: 'status', header: uiText("Status"), cell: r => <StatusBadge value={r.status} /> }]} empty={<EmptyState compact title={uiText("No operations requests for this customer")} />} />
      </Card>}
      {!w.compact && Object.keys(w.data.auth.permissions).some(k => k.startsWith('tasks.') && w.can(k)) && <Card title={uiText("Tasks and meetings")} flush>
        <DataTable rows={work} onRowClick={r => w.show(r.kind, r.id)} stateKey="connected-work" pageSize={10} columns={[{ key: 'title', header: uiText("Work item"), cell: r => <span className="cell-title">{r.title}</span> }, { key: 'label', header: uiText("Type"), cell: r => <Tag>{r.label}</Tag> }, { key: 'workspace_id', header: uiText("Workspace"), sortValue: r => w.data.tm_workspaces.find((s: Row) => s.id === r.workspace_id)?.name, cell: r => w.data.tm_workspaces.find((s: Row) => s.id === r.workspace_id)?.name || r.workspace_id }, { key: 'status', header: uiText("Status"), cell: r => <StatusBadge value={r.status} /> }]} empty={<EmptyState compact title={uiText("No connected tasks or meetings")} />} />
      </Card>}
    </>
  );
}

function Timeline({ events, lookup }: { events: Row[]; lookup: (id: string) => string }) {
  useLanguage();
  if (!events.length) return <EmptyState compact title={uiText("No history yet")} />;
  return (
    <ol className="timeline">
      {events.map(e => (
        <li key={e.id}>
          <span className="timeline-dot" aria-hidden="true" />
          <div className="timeline-body">
            <p className="timeline-title">{e.action}</p>
            {e.detail && <p className="timeline-detail">{e.detail}</p>}
            <p className="timeline-meta"><span className="id-text">{e.entity_id}</span><span className="sep-dot">{lookup(e.actor_id)}</span><span className="sep-dot"><time dateTime={e.created_at}>{formatDateTime(e.created_at)}</time></span></p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SnapshotView({ snapshot: s, currency }: { snapshot: Row; currency: string }) {
  useLanguage();
  const rev = s.quotation?.final_revision;
  return (
    <div className="stack">
      <Alert tone="success" title={uiText("Saved sale record")}>{uiText("Later edits to the contact, pricing or activities do not change this snapshot.")}</Alert>
      <KeyValues columns={2} items={[
        [uiText("Original customer"), `${s.contact.customer_name} · ${s.contact.id}`], [uiText("Original contact"), [s.contact.first_name, s.contact.last_name].filter(Boolean).join(' ') + (s.contact.phone ? ` · ${s.contact.phone}` : '')],
        [uiText("Opportunity"), `${s.opportunity.title} · ${s.opportunity.id}`], [uiText("Won value"), <Money cents={s.opportunity.total_cents} currency={currency} />],
        ...(rev ? [[uiText("Accepted quotation"), <>{s.quotation.id} {uiText("· revision ")}{rev.revision} · <Money cents={rev.total_cents} currency={currency} /></>] as [string, ReactNode]] : []),
        [uiText("Activities / document links saved"), `${s.activities?.length || 0} / ${s.documents?.length || 0}`],
      ]} />
      <Lines lines={rev?.lines || s.lines || []} currency={currency} />
      <details className="disclosure"><summary>{uiText("Inspect the complete saved record")}<span className="summary-meta">JSON</span></summary><div className="disclosure-body"><pre className="json-block">{JSON.stringify(s, null, 2)}</pre></div></details>
    </div>
  );
}

// ================================================================ CRM activities (Task Management → CRM activities)
export function CRMActivities(w: Workspace & { embedded?: boolean }) {
  useLanguage();
  const [view, setView] = useViewState('crm:activities', { query: '', status: 'OPEN', owner: '', when: 'all' });
  const set = (patch: Partial<typeof view>) => setView(v => ({ ...v, ...patch }));
  const now = Date.now(), todayKey = today();
  const localDay = (v: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
  const rows = w.data.activities.filter((a: Row) => (!view.status || a.status === view.status) && (!view.owner || a.assigned_to === view.owner)
    && (!view.query || `${a.subject} ${a.summary} ${a.parent_id} ${a.id}`.toLowerCase().includes(view.query.toLowerCase()))
    && (view.when !== 'overdue' || (a.status === 'OPEN' && Date.parse(a.start_at) < now)) && (view.when !== 'today' || localDay(a.start_at) === todayKey));
  const chips = buildChips([
    { key: 'query', label: uiText("Search"), value: view.query, display: `“${view.query}”`, clear: () => set({ query: '' }) },
    { key: 'status', label: uiText("Status"), value: view.status, display: statusLabel(view.status), clear: () => set({ status: '' }) },
    { key: 'owner', label: uiText("Assigned to"), value: view.owner, display: w.lookup(view.owner), clear: () => set({ owner: '' }) },
    { key: 'when', label: view.when === 'today' ? uiText("Due today") : uiText("Overdue"), value: view.when !== 'all', clear: () => set({ when: 'all' }) },
  ]);
  const reset = () => setView({ query: '', status: '', owner: '', when: 'all' });
  if (!w.can('crm.activities')) return <NoAccess compact />;
  return (
    <>
      <FilterBar
        search={<SearchInput value={view.query} onChange={v => set({ query: v })} label={uiText("Search activities")} placeholder={uiText("Search subject, notes or record…")} />}
        filters={<>
          <FilterSelect label={uiText("Due")} value={view.when === 'all' ? '' : view.when} onChange={v => set({ when: v || 'all', ...(v === 'overdue' ? { status: 'OPEN' } : {}) })} options={[['today', uiText("Today")], ['overdue', uiText("Overdue")]]} allLabel="Any time" />
          <FilterSelect label={uiText("Status")} value={view.status} onChange={v => set({ status: v })} options={[['OPEN', uiText("Open")], ['COMPLETED', uiText("Completed")], ['CANCELLED', uiText("Cancelled")]]} />
          <FilterSelect label={uiText("Assigned to")} value={view.owner} onChange={v => set({ owner: v })} options={staffOptions(w)} allLabel="Anyone" />
        </>}
        actions={w.can('crm.activities', 'create') && <Button size="sm" onClick={() => w.edit('activity')}><Plus />{uiText("New activity")}</Button>}
        chips={chips} onReset={reset} summary={<><strong>{rows.length}</strong> {uiText("of ")}{w.data.activities.length} {plural(w.data.activities.length, 'activity', 'activities')}</>}
      />
      <Card flush>
        <DataTable rows={rows} stateKey="crm-activities" resetKey={JSON.stringify(view)} filtered={chips.length > 0} onClearFilters={reset} onRowClick={a => w.edit('activity', a)} rowLabel={a => `Open activity ${a.subject}`}
          defaultSort={{ key: 'start_at', dir: 'asc' }} rowClassName={a => a.status === 'OPEN' && Date.parse(a.start_at) < now ? 'row-attention' : undefined} itemName="activities"
          columns={[
            { key: 'subject', header: uiText("Activity"), minWidth: 220, cell: a => <span className="cell-stack"><span className="cell-title">{a.subject}</span><small>{statusLabel(a.channel)} · {statusLabel(a.type)}</small></span> },
            { key: 'parent_id', header: uiText("Related record"), cell: a => a.parent_id ? <button type="button" className="text-link" onClick={() => w.show(a.parent_type === 'ACCOUNT' ? 'account' : a.parent_type.toLowerCase(), a.parent_id)}>{a.parent_id}</button> : <span className="muted">{uiText("Internal task")}</span> },
            { key: 'start_at', header: uiText("Due (Cambodia)"), cell: a => <span className={a.status === 'OPEN' && Date.parse(a.start_at) < now ? 'text-danger' : ''}><DateText value={a.start_at} withTime />{a.status === 'OPEN' && Date.parse(a.start_at) < now && <span className="sr-only"> {uiText("(overdue)")}</span>}</span> },
            { key: 'assigned_to', header: uiText("Assigned to"), sortValue: a => w.lookup(a.assigned_to), cell: a => w.lookup(a.assigned_to) },
            { key: 'priority', header: uiText("Priority"), sortValue: a => ({ HIGH: 0, MEDIUM: 1, LOW: 2 } as Row)[a.priority], cell: a => <PriorityBadge value={a.priority} /> },
            { key: 'status', header: uiText("Status"), cell: a => <StatusBadge value={a.status} /> },
          ]}
          empty={<EmptyState title={uiText("No CRM activities yet")} description={uiText("Calls, meetings and follow-ups logged on contacts, leads, opportunities and accounts appear here.")} />} />
      </Card>
    </>
  );
}

// ================================================================ CRM reports (specialized)
export function CRMReports(w: Workspace) {
  useLanguage();
  const [f, setF] = useViewState<Row>('reports:crm', { report: '01' });
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }));
  const activity = ['04', '05', '06'].includes(f.report);
  const params = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v))).toString();
  const { report, error, loading } = useServerReport('/api/report?' + params, w.data);
  const refs = (kind: string) => w.data.lookups.filter((r: Row) => r.kind === kind).map((r: Row) => ({ id: r.id, label: r.name }));
  const multi = (key: string, label: string, options: { id: string; label: string }[]) => <FilterMulti key={key} label={label} values={f[key] ? String(f[key]).split(',') : []} onChange={v => set(key, v.join(','))} options={options} />;
  const range: DateRange = { from: f.from || '', to: f.to || '', preset: f.from || f.to ? 'custom' : 'all' };
  const chipDefs = [['branch', uiText("Branch"), refs('branch')], ['owner', activity ? uiText("Contact owner") : uiText("Salesman"), refs('staff')], ['status', uiText("Status"), (activity ? ['OPEN', 'COMPLETED', 'CANCELLED'] : ['OPEN', 'WON', 'LOST']).map(s => ({ id: s, label: statusLabel(s) }))], ['contact', uiText("Contact"), w.data.contacts.map((r: Row) => ({ id: r.id, label: r.customer_name }))], ['class', uiText("Business group"), refs('opportunity_class')], ['material', uiText("Service"), refs('material')], ['partner', uiText("Partner"), refs('partner')], ['parent_type', uiText("Record type"), ['CONTACT', 'LEAD', 'OPPORTUNITY', 'ACCOUNT', 'TASK'].map(t => ({ id: t, label: statusLabel(t) }))], ['activity_type', uiText("Activity type"), ['FOLLOWUP', 'OPPORTUNITY', "AFTER SALE", 'CHAT'].map(t => ({ id: t, label: statusLabel(t) }))]] as [string, string, { id: string; label: string }[]][];
  const chips = [
    ...(f.from || f.to ? [{ key: 'range', label: uiText("{p0}: {p1}", { p0: activity ? 'Activity start' : 'Expected close', p1: formatRange(f.from, f.to) }), onRemove: () => setF(s => ({ ...s, from: '', to: '' })) }] : []),
    ...(f.customer ? [{ key: 'customer', label: uiText("Customer: “{p0}”", { p0: f.customer }), onRemove: () => set('customer', '') }] : []),
    ...chipDefs.filter(([k]) => f[k]).map(([k, label, opts]) => ({ key: k, label: uiText("{p0}: {p1}", { p0: label, p1: String(f[k]).split(',').map(id => opts.find(o => o.id === id)?.label || id).join(', ') }), onRemove: () => set(k, '') })),
  ];
  const moneyTotals = Object.entries(report.totals || {}).filter(([key]) => ['total_cents', 'forecast_cents', 'net_cents', 'ar_cents', 'costing_cents'].includes(key));
  const totalLabel: Record<string, string> = { total_cents: 'Total', forecast_cents: 'Forecast', net_cents: 'Net after costing', ar_cents: 'AR (CRM)', costing_cents: 'Costing' };
  const canExport = w.can('reports.crm', 'export') && w.can(activity ? 'crm.activities' : 'crm.opportunities', 'export');
  const cols: Column[] = (report.columns || []).map(([key, label]: string[]) => ({ key, header: label, numeric: key.endsWith('_cents') || key === 'quantity', wrap: ['summary', 'subject', 'reason'].includes(key),
    cell: (r: Row) => key.endsWith('_cents') ? <Money cents={r[key]} currency={w.currency} /> : key === 'status' || key === 'type' ? <StatusBadge value={r[key]} /> : key === 'date' ? <DateText value={r[key]} /> : key === 'id' && r.id && !activity ? <button type="button" className="text-link" onClick={() => w.show('opportunity', r.id)}>{r.id}</button> : key === 'summary' ? <ExpandableText text={r[key]} /> : isMissing(r[key]) ? null : String(r[key]) }));
  const footer = Object.fromEntries([[cols[0]?.key, uiText("Total")], ...Object.entries(report.totals || {}).map(([k, v]) => [k, <Money cents={v} currency={w.currency} emphasize />])]);
  return (
    <>
      <FilterBar
        search={<Picker hideLabel label={uiText("Report")} value={f.report} onChange={v => setF({ report: v || '01' })} allowNone={false} options={Object.entries(REPORTS).map(([id, title]) => [id, `RPT ${id} · ${title}`])} className="report-picker" />}
        filters={<>
          <DateRangeFilter label={activity ? uiText("Activity start") : uiText("Expected close")} value={range} onChange={r => setF(s => ({ ...s, from: r.from, to: r.to }))} />
          {!activity && <SearchInput value={f.customer || ''} onChange={v => set('customer', v)} label={uiText("Customer name")} placeholder={uiText("Customer name…")} className="filter-inline-search" />}
          {multi('status', uiText("Status"), chipDefs[2][2])}
          {multi('owner', activity ? uiText("Contact owner") : uiText("Salesman"), refs('staff'))}
        </>}
        more={<>
          {multi('branch', uiText("Branch"), refs('branch'))}
          {multi('contact', uiText("Contact"), w.data.contacts.map((r: Row) => ({ id: r.id, label: r.customer_name, meta: r.id })))}
          {!activity && <>{multi('class', uiText("Business group"), refs('opportunity_class'))}{multi('material', uiText("Service"), refs('material'))}{multi('partner', uiText("Partner"), refs('partner'))}</>}
          {activity && <>{multi('parent_type', uiText("Record type"), chipDefs[7][2])}{multi('activity_type', uiText("Activity type"), chipDefs[8][2])}</>}
        </>}
        actions={canExport && <><ButtonLink size="sm" href={apiPath(`/api/report.csv?${params}`)}><Download />CSV</ButtonLink><ButtonLink size="sm" href={apiPath(`/api/report.print?${params}`)} target="_blank" rel="noopener"><Printer />{uiText("Print / PDF")}</ButtonLink></>}
        chips={chips} onReset={() => setF({ report: f.report })}
        summary={<><strong>{report.rows.length}</strong> {uiText("matching row")}{report.rows.length === 1 ? '' : 's'}</>}
      />
      {error ? <ErrorState message={error} /> : <>
        <div className="stat-grid stat-grid-fit">
          <StatCard label={uiText("Rows")} value={report.rows.length.toLocaleString('en-US')} caption={REPORTS[f.report as keyof typeof REPORTS]} />
          {moneyTotals.map(([key, value]) => <StatCard key={key} label={totalLabel[key] || key} value={formatMoney(value, w.currency)} caption={uiText("{p0} · all matching rows", { p0: w.currency })} />)}
        </div>
        <Card title={uiText("RPT {p0} · {p1}", { p0: report.id || f.report, p1: report.title })} description={activity ? uiText("Activity dates use Cambodia time. “Contact owner” filters by the owner of the linked contact.") : uiText("Costing and commission are counted once per opportunity. AR = opportunity total − CRM payment received. Invoice balances are in Operations.")} flush className={loading ? 'is-refreshing' : undefined}>
          <DataTable dense columns={cols} rows={report.rows} stateKey={`rpt-crm-${f.report}`} resetKey={params} filtered={chips.length > 0} onClearFilters={() => setF({ report: f.report })} footerRow={report.rows.length ? footer : undefined} itemName="rows" pageSize={50}
            empty={<EmptyState compact title={uiText("No rows for this report yet")} />} />
        </Card>
        {report.groups?.length > 0 && <Card title={uiText("Group totals")} flush>
          <DataTable rows={report.groups} rowKey={g => String(g.group)} pageSize={0} columns={[{ key: 'group', header: uiText("Group") }, { key: 'count', header: uiText("Rows"), numeric: true }, ...(!activity || f.report === '06' ? [{ key: 'total_cents', header: f.report === '06' ? uiText("Forecast") : uiText("Total"), numeric: true, cell: (r: Row) => <Money cents={r.total_cents} currency={w.currency} /> } as Column] : [])]} />
        </Card>}
      </>}
    </>
  );
}


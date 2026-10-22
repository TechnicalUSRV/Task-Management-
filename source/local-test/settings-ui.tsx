import { uiText, useLanguage } from "./i18n";
import { useState } from 'react';
import { Building2, ListChecks, Pencil, Plus, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type Row } from './components';
import type { Workspace } from './ui';
import { useViewState } from './router';
import { zoneName, zoneOffset } from './format';
import { Avatar, Card, DataTable, EmptyState, KeyValues, NoAccess, PageHeader, SearchInput, StatusBadge, Tag, type Column } from './ui-kit';

/** Reference lists used across CRM, Operations and Task Management (lookup kinds the server accepts). */
const KINDS: { id: string; label: string; one: string; description: string }[] = [
  { id: 'staff', get label() { return uiText("Staff"); }, one: 'staff member', get description() { return uiText("People who own records, approve requests or sign in. Login accounts are managed in Administration."); } },
  { id: 'branch', get label() { return uiText("Branches"); }, one: 'branch', get description() { return uiText("Offices used on opportunities, activities and reports."); } },
  { id: 'material', get label() { return uiText("Services & materials"); }, one: 'service or material', get description() { return uiText("Items priced on opportunities and quotations. The unit is shown on pricing lines."); } },
  { id: 'opportunity_class', get label() { return uiText("Opportunity classes"); }, one: 'opportunity class', get description() { return uiText("Business groups for opportunities and CRM reports."); } },
  { id: 'contact_class', get label() { return uiText("Contact classes"); }, one: 'contact class', get description() { return uiText("Categories for customer contacts."); } },
  { id: 'lead_class', get label() { return uiText("Lead classes"); }, one: 'lead class', get description() { return uiText("Categories for leads."); } },
  { id: 'campaign_class', get label() { return uiText("Campaign classes"); }, one: 'campaign class', get description() { return uiText("Categories for marketing campaigns."); } },
  { id: 'partner', get label() { return uiText("Partners"); }, one: 'partner', get description() { return uiText("Referral and delivery partners linked to opportunities."); } },
];

export function SettingsView(w: Workspace) {
  useLanguage();
  const d = w.data;
  const [kind, setKind] = useViewState('settings:kind', 'staff');
  const [query, setQuery] = useState('');
  if (!w.can('settings')) return <><PageHeader crumbs={[{ label: uiText("Company settings") }]} title={uiText("Company settings")} /><NoAccess /></>;
  const canEdit = w.can('settings', 'update');
  const current = KINDS.find(k => k.id === kind) || KINDS[0];
  const all = d.lookups.filter((r: Row) => r.kind === current.id);
  const rows = all.filter((r: Row) => !query || `${r.name} ${r.id} ${r.unit || ''}`.toLowerCase().includes(query.toLowerCase()));
  const loginFor = (staffId: string) => (d.access_users || []).find((u: Row) => u.staff_id === staffId);
  const showLogins = current.id === 'staff' && w.can('admin.users');
  const columns: Column[] = [
    { key: 'name', header: uiText("Name"), minWidth: 200, cell: r => current.id === 'staff' ? <span className="person-cell"><Avatar name={r.name} size="sm" /><span className="cell-title">{r.name}</span></span> : <span className="cell-title">{r.name}</span> },
    { key: 'id', header: uiText("Code"), cell: r => <span className="id-text">{r.id}</span> },
    ...(current.id === 'material' ? [{ key: 'unit', header: uiText("Unit") } as Column] : []),
    ...(showLogins ? [{ key: 'login', header: uiText("Login account"), sortValue: (r: Row) => (loginFor(r.id) ? (loginFor(r.id)!.active ? 2 : 1) : 0), cell: (r: Row) => { const u = loginFor(r.id); return u ? <StatusBadge value={u.active ? 'ACTIVE' : 'DISABLED'} label={u.active ? uiText("Active login") : uiText("Disabled login")} /> : <span className="muted">{uiText("No login")}</span>; } } as Column] : []),
    { key: 'active', header: uiText("Status"), cell: r => <StatusBadge value={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
  ];
  const chain: Row[] = d.approval_steps || [];
  return (
    <>
      <PageHeader crumbs={[{ label: uiText("Administration") }, { label: uiText("Company settings") }]} title={uiText("Company settings")}
        description={uiText("Company details, the shared approval chain and the reference lists used across CRM, Operations and Task Management.")}
        badge={!canEdit ? <Tag>{uiText("View only")}</Tag> : undefined}
        actions={canEdit && <Button onClick={() => w.edit('settings', { ...d.company, approvers: chain.map(s => s.approver_id) })}><Pencil />{uiText("Edit settings")}</Button>} />
      <div className="grid-2">
        <Card title={<span className="card-title-icon"><Building2 aria-hidden="true" />{d.company.name}</span>} description={uiText("Printed on quotations, reports and documents.")}>
          <KeyValues columns={1} items={[
            [uiText("Address"), d.company.address],
            [uiText("Phone"), d.company.phone],
            [uiText("Email"), d.company.email ? <a className="text-link" href={`mailto:${d.company.email}`}>{d.company.email}</a> : null],
            [uiText("Tax ID"), d.company.tax_id],
            [uiText("Currency"), d.company.currency],
            [uiText("Time zone"), `${zoneName(d.company.timezone || 'Asia/Phnom_Penh')} (${zoneOffset(d.company.timezone || 'Asia/Phnom_Penh')})${d.company.timezone ? '' : uiText(" · default")}`],
          ]} />
        </Card>
        <Card title={<span className="card-title-icon"><ListChecks aria-hidden="true" />{uiText("Approval chain")}</span>} description={uiText("Used for new quotation and operations submissions, in this order. Requests already submitted keep their original chain.")}>
          {chain.length ? (
            <ol className="chain-list">
              {chain.map((s: Row) => (
                <li key={s.step}>
                  <span className="chain-step num" aria-hidden="true">{s.step}</span>
                  <Avatar name={w.lookup(s.approver_id)} size="sm" />
                  <span className="chain-text"><strong>{w.lookup(s.approver_id)}</strong><small>{uiText("Step ")}{s.step} approver</small></span>
                </li>
              ))}
            </ol>
          ) : <EmptyState compact title={uiText("No approvers set")} description={uiText("Add at least one approver before anyone submits a request.")} />}
          <p className="card-note">{uiText("Approvers need a login with Approve permission for the request type. Manage accounts and roles in Administration.")}</p>
        </Card>
      </div>
      <Card title={<span className="card-title-icon"><Settings2 aria-hidden="true" />{uiText("Reference lists")}</span>} description={uiText("Choices offered in forms, filters and reports.")} className="mt-6" flush
        actions={canEdit && <Button variant="outline" onClick={() => w.edit('lookup', { kind: current.id })}><Plus />{uiText("Add ")}{current.one}</Button>}>
        <div className="ref-layout">
          <div className="ref-kinds" role="group" aria-label={uiText("Reference list")}>
            {KINDS.map(k => {
              const count = d.lookups.filter((r: Row) => r.kind === k.id).length;
              return (
                <button key={k.id} type="button" className="ref-kind" aria-pressed={k.id === current.id} onClick={() => { setKind(k.id); setQuery(''); }}>
                  <span>{k.label}</span><span className="ref-kind-count num">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="ref-content">
            <div className="ref-head">
              <div>
                <h3 className="ref-title">{current.label}</h3>
                <p className="ref-description">{current.description}</p>
              </div>
              <SearchInput value={query} onChange={setQuery} label={uiText("Search {p0}", { p0: current.label.toLowerCase() })} placeholder={uiText("Search {p0}…", { p0: current.label.toLowerCase() })} className="ref-search" />
            </div>
            <DataTable columns={columns} rows={rows} stateKey={`settings-${current.id}`} resetKey={`${current.id}:${query}`} defaultSort={{ key: 'name', dir: 'asc' }}
              onRowClick={canEdit ? r => w.edit('lookup', r) : undefined} rowLabel={r => `Edit ${r.name}`} filtered={!!query} onClearFilters={() => setQuery('')} itemName={current.label.toLowerCase()}
              empty={<EmptyState compact title={uiText("No {p0} yet", { p0: current.label.toLowerCase() })} description={canEdit ? uiText("Add the first entry to make it available in forms.") : uiText("An administrator can add entries.")} />} />
          </div>
        </div>
      </Card>
    </>
  );
}

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
  { id: 'staff', label: 'Staff', one: 'staff member', description: 'People who own records, approve requests or sign in. Login accounts are managed in Administration.' },
  { id: 'branch', label: 'Branches', one: 'branch', description: 'Offices used on opportunities, activities and reports.' },
  { id: 'material', label: 'Services & materials', one: 'service or material', description: 'Items priced on opportunities and quotations. The unit is shown on pricing lines.' },
  { id: 'opportunity_class', label: 'Opportunity classes', one: 'opportunity class', description: 'Business groups for opportunities and CRM reports.' },
  { id: 'contact_class', label: 'Contact classes', one: 'contact class', description: 'Categories for customer contacts.' },
  { id: 'lead_class', label: 'Lead classes', one: 'lead class', description: 'Categories for leads.' },
  { id: 'campaign_class', label: 'Campaign classes', one: 'campaign class', description: 'Categories for marketing campaigns.' },
  { id: 'partner', label: 'Partners', one: 'partner', description: 'Referral and delivery partners linked to opportunities.' },
];

export function SettingsView(w: Workspace) {
  const d = w.data;
  const [kind, setKind] = useViewState('settings:kind', 'staff');
  const [query, setQuery] = useState('');
  if (!w.can('settings')) return <><PageHeader crumbs={[{ label: 'Company settings' }]} title="Company settings" /><NoAccess /></>;
  const canEdit = w.can('settings', 'update');
  const current = KINDS.find(k => k.id === kind) || KINDS[0];
  const all = d.lookups.filter((r: Row) => r.kind === current.id);
  const rows = all.filter((r: Row) => !query || `${r.name} ${r.id} ${r.unit || ''}`.toLowerCase().includes(query.toLowerCase()));
  const loginFor = (staffId: string) => (d.access_users || []).find((u: Row) => u.staff_id === staffId);
  const showLogins = current.id === 'staff' && w.can('admin.users');
  const columns: Column[] = [
    { key: 'name', header: 'Name', minWidth: 200, cell: r => current.id === 'staff' ? <span className="person-cell"><Avatar name={r.name} size="sm" /><span className="cell-title">{r.name}</span></span> : <span className="cell-title">{r.name}</span> },
    { key: 'id', header: 'Code', cell: r => <span className="id-text">{r.id}</span> },
    ...(current.id === 'material' ? [{ key: 'unit', header: 'Unit' } as Column] : []),
    ...(showLogins ? [{ key: 'login', header: 'Login account', sortValue: (r: Row) => (loginFor(r.id) ? (loginFor(r.id)!.active ? 2 : 1) : 0), cell: (r: Row) => { const u = loginFor(r.id); return u ? <StatusBadge value={u.active ? 'ACTIVE' : 'DISABLED'} label={u.active ? 'Active login' : 'Disabled login'} /> : <span className="muted">No login</span>; } } as Column] : []),
    { key: 'active', header: 'Status', cell: r => <StatusBadge value={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
  ];
  const chain: Row[] = d.approval_steps || [];
  return (
    <>
      <PageHeader crumbs={[{ label: 'Administration' }, { label: 'Company settings' }]} title="Company settings"
        description="Company details, the shared approval chain and the reference lists used across CRM, Operations and Task Management."
        badge={!canEdit ? <Tag>View only</Tag> : undefined}
        actions={canEdit && <Button onClick={() => w.edit('settings', { ...d.company, approvers: chain.map(s => s.approver_id) })}><Pencil />Edit settings</Button>} />
      <div className="grid-2">
        <Card title={<span className="card-title-icon"><Building2 aria-hidden="true" />{d.company.name}</span>} description="Printed on quotations, reports and documents.">
          <KeyValues columns={1} items={[
            ['Address', d.company.address],
            ['Phone', d.company.phone],
            ['Email', d.company.email ? <a className="text-link" href={`mailto:${d.company.email}`}>{d.company.email}</a> : null],
            ['Tax ID', d.company.tax_id],
            ['Currency', d.company.currency],
            ['Time zone', `${zoneName(d.company.timezone || 'Asia/Phnom_Penh')} (${zoneOffset(d.company.timezone || 'Asia/Phnom_Penh')})${d.company.timezone ? '' : ' · default'}`],
          ]} />
        </Card>
        <Card title={<span className="card-title-icon"><ListChecks aria-hidden="true" />Approval chain</span>} description="Used for new quotation and operations submissions, in this order. Requests already submitted keep their original chain.">
          {chain.length ? (
            <ol className="chain-list">
              {chain.map((s: Row) => (
                <li key={s.step}>
                  <span className="chain-step num" aria-hidden="true">{s.step}</span>
                  <Avatar name={w.lookup(s.approver_id)} size="sm" />
                  <span className="chain-text"><strong>{w.lookup(s.approver_id)}</strong><small>Step {s.step} approver</small></span>
                </li>
              ))}
            </ol>
          ) : <EmptyState compact title="No approvers set" description="Add at least one approver before anyone submits a request." />}
          <p className="card-note">Approvers need a login with Approve permission for the request type. Manage accounts and roles in Administration.</p>
        </Card>
      </div>
      <Card title={<span className="card-title-icon"><Settings2 aria-hidden="true" />Reference lists</span>} description="Choices offered in forms, filters and reports." className="mt-6" flush
        actions={canEdit && <Button variant="outline" onClick={() => w.edit('lookup', { kind: current.id })}><Plus />Add {current.one}</Button>}>
        <div className="ref-layout">
          <div className="ref-kinds" role="group" aria-label="Reference list">
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
              <SearchInput value={query} onChange={setQuery} label={`Search ${current.label.toLowerCase()}`} placeholder={`Search ${current.label.toLowerCase()}…`} className="ref-search" />
            </div>
            <DataTable columns={columns} rows={rows} stateKey={`settings-${current.id}`} resetKey={`${current.id}:${query}`} defaultSort={{ key: 'name', dir: 'asc' }}
              onRowClick={canEdit ? r => w.edit('lookup', r) : undefined} rowLabel={r => `Edit ${r.name}`} filtered={!!query} onClearFilters={() => setQuery('')} itemName={current.label.toLowerCase()}
              empty={<EmptyState compact title={`No ${current.label.toLowerCase()} yet`} description={canEdit ? 'Add the first entry to make it available in forms.' : 'An administrator can add entries.'} />} />
          </div>
        </div>
      </Card>
    </>
  );
}

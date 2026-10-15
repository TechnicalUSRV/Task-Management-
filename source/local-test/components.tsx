import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { lineAmounts } from './money.mjs';
import { formatDateTime, formatMoney, localDate, zoneOptions } from './format';
import { uuid } from './api-client';
import {
  Alert, Card, DataTable, EmptyState, Field, FormSection, Missing, Picker, SearchInput, StatusBadge,
  useConfirm, useFormErrors, type Column,
} from './ui-kit';

export type Row = Record<string, any>;
export type Data = { company: Row; [key: string]: any };
export type Model = { kind: string; title: string; action: string; data: Row };

// ---------------------------------------------------------------- formatting (shared API)
export const sum = (rows: Row[], key: string) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
/** Money for text contexts. Missing amounts read "—", never $0.00. */
export const money = (n: unknown, currency = 'USD') => formatMoney(n, currency) ?? '—';
export const day = (v?: string) => (v ? localDate(v) : '');
export const when = (v?: string) => formatDateTime(v) ?? '—';
export const today = () => localDate();
export const later = (days = 30) => new Date(Date.parse(`${localDate()}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** datetime-local value (Cambodia time, UTC+7) for an ISO instant. */
export const localInput = (v?: string) => new Date(new Date(v || new Date()).getTime() + 7 * 3600000).toISOString().slice(0, 16);

// ---------------------------------------------------------------- compatibility wrappers
export { Field, Picker } from './ui-kit';
export function Pill({ value, label }: { value: string; label?: string }) { return <StatusBadge value={value} label={label} />; }
export function Panel({ title, children, action, className = '', description }: { title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string; description?: ReactNode }) {
  return <Card title={title} description={description} actions={action} className={className}>{children}</Card>;
}
export function Empty({ children = 'No records yet.', title }: { children?: ReactNode; title?: ReactNode }) {
  return <EmptyState compact title={title ?? children} description={title ? children : undefined} />;
}
type LegacyColumn = { key: string; label: string; render?: (r: Row) => ReactNode; numeric?: boolean; align?: 'left' | 'right' | 'center'; wrap?: boolean; sortValue?: (r: Row) => unknown; sortable?: boolean; minWidth?: number };
/** Older column shape ({label, render}) mapped onto the shared DataTable. */
export function Grid({ columns, rows, onRow, empty, stateKey, pageSize = 25 }: { columns: LegacyColumn[]; rows: Row[]; onRow?: (r: Row) => void; empty?: string; stateKey?: string; pageSize?: number }) {
  const cols: Column[] = columns.map(c => ({ key: c.key, header: c.label, cell: c.render, numeric: c.numeric, align: c.align, wrap: c.wrap, sortValue: c.sortValue, sortable: c.sortable, minWidth: c.minWidth }));
  return <DataTable columns={cols} rows={rows} onRowClick={onRow} stateKey={stateKey} pageSize={pageSize} empty={<EmptyState compact title={empty || 'No records yet'} />} />;
}

// ---------------------------------------------------------------- pricing lines
const newLine = () => ({ material_id: '', description: '', unit: 'service', quantity: '1', unit_price: '0', discount: '0', percentage_discount: '0', tax_percent: '10' });
const LINE_FIELDS = [['quantity', 'Qty', '0.0001'], ['unit_price', 'Unit price', '0.0001'], ['discount', 'Discount', '0.01'], ['percentage_discount', 'Disc. %', '0.0001'], ['tax_percent', 'VAT %', '0.0001']] as const;

export function LineTotals({ preview, currency }: { preview: Row[]; currency: string }) {
  return (
    <dl className="line-totals">
      <div><dt>Amount</dt><dd className="num">{money(sum(preview, 'amount_cents'), currency)}</dd></div>
      <div><dt>Discounts</dt><dd className="num">{sum(preview, 'discount_cents') ? `−${money(sum(preview, 'discount_cents'), currency)}` : money(0, currency)}</dd></div>
      <div><dt>Net</dt><dd className="num">{money(sum(preview, 'net_cents'), currency)}</dd></div>
      <div><dt>VAT</dt><dd className="num">{money(sum(preview, 'vat_cents'), currency)}</dd></div>
      <div className="grand"><dt>Total</dt><dd className="num">{money(sum(preview, 'total_cents'), currency)}</dd></div>
    </dl>
  );
}

/** Pricing lines: an editable, responsive grid when onChange is given, otherwise a read-only table. */
export function Lines({ lines, onChange, materials = [], currency = 'USD', error }: { lines: Row[]; onChange?: (l: Row[]) => void; materials?: Row[]; currency?: string; error?: string }) {
  const preview: Row[] = lines.map(l => { try { return { ...l, ...lineAmounts(l), invalid: false }; } catch { return { ...l, invalid: true, amount_cents: 0, discount_cents: 0, net_cents: 0, vat_cents: 0, total_cents: 0 }; } });
  const edit = (index: number, key: string, value: string) => onChange?.(lines.map((l, i) => (i === index ? { ...l, [key]: value } : l)));
  if (!onChange) {
    const cols: Column[] = [
      { key: 'description', header: 'Service / description', cell: l => <span className="cell-stack"><strong>{l.description}</strong><small>{l.material_id || 'Custom service'} · {l.unit}</small></span>, minWidth: 220, wrap: true },
      { key: 'quantity', header: 'Qty', numeric: true, sortValue: l => Number(l.quantity) },
      { key: 'unit_price', header: 'Unit price', numeric: true, sortValue: l => Number(l.unit_price), cell: l => <span className="num">{Number(l.unit_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span> },
      { key: 'discount_cents', header: 'Discount', numeric: true, cell: l => money(l.discount_cents, currency) },
      { key: 'vat_cents', header: 'VAT', numeric: true, cell: l => money(l.vat_cents, currency) },
      { key: 'total_cents', header: 'Line total', numeric: true, cell: l => <strong className="num">{money(l.total_cents, currency)}</strong> },
    ];
    return (
      <div className="lines-view">
        <DataTable columns={cols} rows={preview} rowKey={(_, i) => String(i)} pageSize={0} empty={<EmptyState compact title="No pricing lines" description="Pricing lines appear here once they are added." />} />
        {preview.length > 0 && <LineTotals preview={preview} currency={currency} />}
      </div>
    );
  }
  return (
    <div className={cn('line-editor', error && 'has-error')}>
      <div className="line-grid line-grid-head" aria-hidden="true">
        <span>#</span><span>Service / description</span>{LINE_FIELDS.map(([, label]) => <span key={label} className="align-right">{label}</span>)}<span className="align-right">Line total</span><span />
      </div>
      {lines.map((l, i) => (
        <div className="line-grid line-row" key={i} role="group" aria-label={`Line ${i + 1}`}>
          <span className="line-index">{i + 1}</span>
          <div className="line-desc">
            <Picker hideLabel label={`Line ${i + 1} service`} value={l.material_id} options={materials.map(m => [m.id, m.name])} none="Custom service"
              onChange={v => { const m = materials.find(x => x.id === v); onChange(lines.map((row, j) => (i === j ? { ...row, material_id: v, description: m?.name || row.description, unit: m?.unit || row.unit } : row))); }} />
            <div className="line-desc-row">
              <Input aria-label={`Line ${i + 1} description`} placeholder="Description *" value={l.description} onChange={e => edit(i, 'description', e.target.value)} required aria-invalid={!l.description?.trim() && !!error ? true : undefined} />
              <Input aria-label={`Line ${i + 1} unit`} placeholder="Unit" value={l.unit} onChange={e => edit(i, 'unit', e.target.value)} className="line-unit" />
            </div>
          </div>
          {LINE_FIELDS.map(([k, label, step]) => (
            <label key={k} className="line-num">
              <span className="line-num-label">{label}</span>
              <Input aria-label={`Line ${i + 1} ${label}`} type="number" inputMode="decimal" step={step} min="0" value={l[k]} onChange={e => edit(i, k, e.target.value)} className="num" />
            </label>
          ))}
          <span className="line-total num" aria-label={`Line ${i + 1} total`}>
            <span className="line-num-label">Line total</span>
            {preview[i].invalid ? <span className="text-danger">Check values</span> : money(preview[i].total_cents, currency)}
          </span>
          <Button type="button" variant="ghost" size="icon-sm" className="line-remove" aria-label={`Remove line ${i + 1}`} title="Remove line" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      {!lines.length && <div className="line-empty">No pricing lines yet. Add the services this price covers.</div>}
      <div className="line-footer">
        <div className="stack-sm">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, newLine()])} disabled={lines.length >= 100}><Plus />Add line</Button>
          <p className="inline-note">Percentage discount applies first, then the fixed discount; VAT is calculated on the remaining amount. Up to 100 lines.</p>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <LineTotals preview={preview} currency={currency} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- CRM record editor
const options = (arr: string[]): [string, string][] => arr.map(v => [v, v.charAt(0) + v.slice(1).toLowerCase().replaceAll('_', ' ')]);
const WIDE_KINDS = ['opportunity', 'quotation'];
const NARROW_KINDS = ['close', 'process', 'invoice', 'document', 'shipment', 'payment', 'lookup'];

export function Editor({ model, state, onSave, onClose }: { model: Model; state: Data; actor: string; onSave: (action: string, data: Row) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<Row>(() => structuredClone(model.data));
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const form = useFormErrors();
  const confirm = useConfirm();
  const currency = state.company.currency;
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const set = (k: string, v: any) => { setDraft(d => ({ ...d, [k]: v, ...(k === 'parent_type' ? { parent_id: '', type: 'FOLLOWUP' } : {}) })); setDirty(true); form.clear(k); };
  const refs = (kind: string): [string, string][] => state.lookups.filter((r: Row) => r.kind === kind && r.active).map((r: Row) => [r.id, r.name]);
  const field = (k: string, label: string, type = 'text', required = false, wide = false, extra: { hint?: string; placeholder?: string; min?: string; max?: string; aliases?: string[] } = {}) => {
    form.register({ key: k, label, required, type, value: draft[k], aliases: extra.aliases });
    return <Field key={k} fieldKey={k} label={label} value={draft[k]} type={type} required={required} wide={wide} hint={extra.hint} placeholder={extra.placeholder} min={extra.min} max={extra.max} error={form.errors[k]} onChange={v => set(k, v)} />;
  };
  const pick = (k: string, label: string, opts: [string, string][], { required = false, disabled = false, none, hint, aliases, wide }: { required?: boolean; disabled?: boolean; none?: string; hint?: string; aliases?: string[]; wide?: boolean } = {}) => {
    form.register({ key: k, label, required, type: 'select', value: draft[k], aliases });
    return <Picker key={k} fieldKey={k} label={label} value={draft[k]} options={opts} required={required} disabled={disabled} none={none ?? (required ? 'Select…' : 'None')} hint={hint} wide={wide} error={form.errors[k]} onChange={v => set(k, v)} />;
  };
  const ref = (k: string, label: string, kind: string, required = false, aliases: string[] = []) => pick(k, label, refs(kind), { required, aliases: [kind.replaceAll('_', ' '), ...aliases] });
  const contactOptions: [string, string][] = state.contacts.map((c: Row) => [c.id, `${c.customer_name} · ${c.id}`]);
  const materials = state.lookups.filter((r: Row) => r.kind === 'material');
  const close = async () => {
    if (busy) return;
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', description: 'The information you entered in this form will be lost.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', tone: 'danger' }))) return;
    onClose();
  };

  let body: ReactNode;
  switch (model.kind) {
    case 'contact':
      body = <>
        <FormSection title="Customer">
          {field('customer_name', 'Customer / company name', 'text', true, true)}
          {!draft.id && field('code', 'Contact ID', 'text', false, false, { hint: 'Leave blank for an automatic ID (CONT-000123).', placeholder: 'Automatic' })}
          {pick('active', 'Contact status', [['1', 'Active'], ['0', 'Inactive']], { required: true })}
        </FormSection>
        <FormSection title="Contact person">
          {field('first_name', 'First name', 'text', true)}{field('last_name', 'Last name')}
          {field('email', 'Email', 'email', false, false, { placeholder: 'name@company.com' })}{field('phone', 'Phone')}
          {field('mobile', 'Mobile')}{field('address', 'Address')}
        </FormSection>
        <FormSection title="Ownership & source">
          {ref('owner_id', 'Owner', 'staff', true)}{ref('class_id', 'Contact class', 'contact_class')}
          {field('source', 'Inquiry source', 'text', false, false, { placeholder: 'Website, referral…' })}{ref('partner_id', 'Partner', 'partner')}
          {field('notes', 'Notes', 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'campaign':
      body = <>
        <FormSection title="Campaign">
          {field('name', 'Campaign name', 'text', true, true)}
          {ref('class_id', 'Campaign class', 'campaign_class')}{pick('status', 'Status', options(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']), { required: true })}
          {field('audience', 'Target audience', 'text', false, true)}
        </FormSection>
        <FormSection title="Schedule & budget">
          {field('start_date', 'Start date', 'date', true)}{field('end_date', 'End date', 'date', true, false, { min: draft.start_date })}
          {field('budget', 'Budget', 'number', false, false, { hint: `Amount in ${currency}.` })}
          {field('description', 'Description', 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'lead':
      body = <>
        <FormSection title="Lead">
          {pick('contact_id', 'Contact', contactOptions, { required: true, disabled: !!draft.id })}
          {pick('campaign_id', 'Campaign', state.campaigns.map((c: Row) => [c.id, c.name]), { disabled: !!draft.id, none: 'Direct inquiry (no campaign)' })}
          {pick('status', 'Status', options(['NEW', 'QUALIFIED', 'DISQUALIFIED']), { required: true, hint: 'Qualified leads can be converted into opportunities.' })}
          {pick('rating', 'Rating', options(['HOT', 'WARM', 'COLD']), { required: true })}
          {draft.status === 'DISQUALIFIED' && field('reason', 'Disqualification reason', 'textarea', true, true)}
        </FormSection>
        <FormSection title="Ownership">
          {ref('owner_id', 'Owner', 'staff', true)}{ref('class_id', 'Lead class', 'lead_class')}
          {field('source', 'Source')}
          {field('notes', 'Notes', 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'opportunity':
      body = <>
        <FormSection title="Opportunity" columns={3}>
          {pick('contact_id', 'Contact', contactOptions, { required: true, disabled: !!draft.id || !!draft.lead_id, wide: true })}
          {field('title', 'Opportunity title', 'text', true, true)}
          {ref('owner_id', 'Salesman', 'staff', true)}{ref('branch_id', 'Branch', 'branch', true)}{ref('class_id', 'Business group', 'opportunity_class', true)}
          {ref('partner_id', 'Partner', 'partner')}{field('customer_reference', 'Customer reference')}
        </FormSection>
        <FormSection title="Forecast & costs" columns={3}>
          {field('estimation', 'Expected close date', 'date', true)}{field('probability', 'Probability %', 'number', true, false, { min: '0', max: '100' })}
          {field('costing', 'Costing', 'number', false, false, { hint: `Total cost in ${currency}; counted once per opportunity.` })}
          {field('payment_received', 'CRM payment received', 'number')}{field('commission', 'Commission', 'number')}
        </FormSection>
        <FormSection title="Pricing" description="Line items for this opportunity. When the sale is won, these prices are preserved in the sale snapshot." columns={1}>
          <Lines lines={draft.lines || []} onChange={v => set('lines', v)} materials={materials} currency={currency} error={form.errors.lines} />
        </FormSection>
        <FormSection columns={1}>{field('notes', 'Notes', 'textarea', false, true)}</FormSection>
      </>;
      break;
    case 'quotation':
      body = <>
        <FormSection title="Validity">
          {field('quotation_date', 'Quotation date', 'date', true)}{field('valid_until', 'Valid until', 'date', true, false, { min: draft.quotation_date, aliases: ['valid-until date', 'valid until date'] })}
        </FormSection>
        <FormSection title="Quoted lines" description="Saving creates a new revision. Earlier revisions stay available and read-only." columns={1}>
          <Lines lines={draft.lines || []} onChange={v => set('lines', v)} materials={materials} currency={currency} error={form.errors.lines} />
        </FormSection>
        <FormSection columns={1}>{field('notes', 'Notes / terms', 'textarea', false, true)}</FormSection>
      </>;
      break;
    case 'account':
      body = <FormSection>
        {field('name', 'Account name', 'text', true, true)}
        {ref('owner_id', 'Owner', 'staff', true)}{ref('partner_id', 'Partner', 'partner')}
        {pick('status', 'Status', options(['ACTIVE', 'INACTIVE', 'SUSPENDED']), { required: true, hint: 'Only active accounts can accept new sales and purchase orders.' })}
        {field('notes', 'Notes / partner details', 'textarea', false, true)}
      </FormSection>;
      break;
    case 'activity': {
      const ptype = draft.parent_type || 'TASK';
      const entities = ptype === 'CONTACT' ? state.contacts : ptype === 'LEAD' ? state.leads : ptype === 'OPPORTUNITY' ? state.opportunities : state.accounts;
      const parents: [string, string][] = entities.map((r: Row) => [r.id, `${r.id} · ${r.customer_name || r.title || r.name || state.contacts.find((c: Row) => c.id === r.contact_id)?.customer_name || ''}`]);
      body = <>
        <FormSection title="Related record">
          {pick('parent_type', 'Related record type', [['CONTACT', 'Contact'], ['LEAD', 'Lead'], ['OPPORTUNITY', 'Opportunity'], ['ACCOUNT', 'Business Account'], ['TASK', 'Internal task (no customer)']], { required: true, disabled: !!draft.id })}
          {ptype !== 'TASK' ? pick('parent_id', 'Related record', parents, { required: true, disabled: !!draft.id }) : <p className="inline-note field-note">Internal tasks are not linked to a customer.</p>}
        </FormSection>
        <FormSection title="Activity">
          {field('subject', 'Subject', 'text', true, true)}
          {pick('type', 'Activity type', [['FOLLOWUP', 'Follow-up'], ['CHAT', 'Chat'], ...(ptype === 'OPPORTUNITY' ? [['OPPORTUNITY', 'Deal activity'] as [string, string]] : []), ...(ptype === 'ACCOUNT' ? [['AFTER SALE', 'After sale'] as [string, string]] : [])], { required: true })}
          {pick('channel', 'Channel', options(['CALL', 'MEETING', 'EMAIL', 'NOTE', 'TASK']), { required: true })}
          {ref('assigned_to', 'Assigned to', 'staff', true)}{ref('branch_id', 'Branch', 'branch', true)}
          {pick('priority', 'Priority', options(['HIGH', 'MEDIUM', 'LOW']), { required: true })}{pick('status', 'Status', options(['OPEN', 'COMPLETED', 'CANCELLED']), { required: true })}
        </FormSection>
        <FormSection title="Schedule" description="Times use Cambodia time (UTC+7).">
          {field('start_at', 'Start / due time', 'datetime-local', true, false, { aliases: ['start date time'] })}{field('end_at', 'End time', 'datetime-local', false, false, { aliases: ['end date time'] })}
          {draft.type === 'AFTER SALE' && field('forecast', 'After-sale forecast value', 'number', false, false, { hint: `Amount in ${currency}.` })}
          {draft.status === 'CANCELLED' && field('reason', 'Cancellation reason', 'textarea', true, true)}
          {field('summary', 'Notes (call, meeting or task)', 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    }
    case 'document':
      body = <FormSection columns={1}>
        {field('title', 'Document title', 'text', true)}
        {field('url', 'Document URL', 'url', true, false, { placeholder: 'https://', hint: 'A complete http or https link. Files stay with their original provider; only the link is stored.' })}
      </FormSection>;
      break;
    case 'close':
      body = <FormSection columns={1}>
        <Alert tone={draft.status === 'WON' ? 'success' : 'warning'} title={draft.status === 'WON' ? 'Close this opportunity as won' : 'Close this opportunity as lost'}>
          {draft.status === 'WON' ? 'The contact, opportunity, pricing and activity history are saved as a sale snapshot, and an active Business Account is created or linked. Create the formal Sales Quotation next.' : 'The opportunity becomes read-only. Its history remains available.'}
        </Alert>
        {draft.status === 'LOST' && field('reason', 'Lost reason', 'textarea', true, true)}
      </FormSection>;
      break;
    case 'process': {
      const text: Record<string, string> = { accept: 'Record the customer’s acceptance of the approved revision. The final quotation and acceptance snapshot are connected to the existing Business Account.', submit: 'Submit this saved revision to the configured approval chain. It is locked while under review.', approve: 'Approve the current step for this revision.', reject: 'Reject this revision. It can be revised and submitted again.', return: 'Return this revision to the author for changes.', expire: 'Mark this quotation as expired. It can be revised with a new validity date.' };
      body = <FormSection columns={1}>
        <Alert tone={['reject', 'return', 'expire'].includes(draft.process) ? 'warning' : 'info'}>{text[draft.process] || 'Record this action for the current revision.'}</Alert>
        {field('comment', ['reject', 'return'].includes(draft.process) ? 'Reason' : 'Comment', 'textarea', ['reject', 'return'].includes(draft.process), true, { aliases: ['comment'] })}
      </FormSection>;
      break;
    }
    case 'shipment':
      body = <FormSection>{field('reference', 'Delivery / shipment reference', 'text', true, true)}{field('shipment_date', 'Delivery date', 'date', true)}{field('notes', 'Notes', 'textarea', false, true)}</FormSection>;
      break;
    case 'invoice':
      body = <FormSection>{field('invoice_date', 'Invoice date', 'date', true)}{field('due_date', 'Due date', 'date', true, false, { min: draft.invoice_date })}</FormSection>;
      break;
    case 'payment':
      body = <FormSection>
        <Alert tone="info" className="span-2">Remaining balance: <strong className="num">{money(draft.balance, currency)}</strong>. Partial payments are supported.</Alert>
        {field('amount', 'Payment amount', 'number', true, false, { aliases: ['amount'] })}{field('payment_date', 'Payment date', 'date', true)}
        {field('reference', 'Receipt / bank reference', 'text', true, true, { aliases: ['payment reference'] })}
      </FormSection>;
      break;
    case 'generate':
      body = <GenerateLeads state={state} value={draft.contact_ids || []} onChange={ids => set('contact_ids', ids)} error={form.errors.contact_ids} />;
      form.register({ key: 'contact_ids', label: 'Contacts', required: true, type: 'select', value: draft.contact_ids });
      break;
    case 'settings':
      body = <>
        <FormSection title="Company details">
          {field('name', 'Company name', 'text', true, true)}{field('tax_id', 'Tax ID')}{field('phone', 'Phone')}
          {field('email', 'Email', 'email', false, false, { aliases: ['company email'] })}
          {pick('timezone', 'Time zone', zoneOptions(), { none: 'Phnom Penh (UTC+7, default)', hint: 'For the calendar, meeting times and reminders of everyone who hasn’t chosen their own.' })}
          {field('address', 'Address', 'textarea', false, true)}
        </FormSection>
        <FormSection title="Approval chain" description="Applies to future submissions of quotations and operations requests. Requests already submitted keep their original chain." columns={1}>
          <div className="approval-editor">
            {draft.approvers.map((id: string, i: number) => (
              <div className="approval-edit-row" key={i}>
                <span className="approval-step-no" aria-hidden="true">{i + 1}</span>
                <Picker label={`Step ${i + 1} approver`} value={id} options={refs('staff')} required onChange={v => { set('approvers', draft.approvers.map((a: string, j: number) => (j === i ? v : a))); form.clear(`approver-${i}`); }} error={form.errors[`approver-${i}`]} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove step ${i + 1}`} title="Remove step" disabled={draft.approvers.length === 1} onClick={() => set('approvers', draft.approvers.filter((_: string, j: number) => i !== j))}><Trash2 /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={draft.approvers.length >= 5} onClick={() => set('approvers', [...draft.approvers, ''])}><Plus />Add approval step</Button>
            <p className="inline-note">Up to five different approvers, in order.</p>
          </div>
        </FormSection>
      </>;
      draft.approvers.forEach((a: string, i: number) => form.register({ key: `approver-${i}`, label: `Step ${i + 1} approver`, required: true, type: 'select', value: a }));
      break;
    case 'lookup':
      body = <FormSection columns={1}>
        {pick('kind', 'Reference type', [['staff', 'Staff'], ['branch', 'Branch'], ['material', 'Service / material'], ['opportunity_class', 'Opportunity class'], ['contact_class', 'Contact class'], ['lead_class', 'Lead class'], ['campaign_class', 'Campaign class'], ['partner', 'Partner']], { required: true, disabled: !!draft.id })}
        {field('name', 'Name', 'text', true)}
        {draft.kind === 'material' && field('unit', 'Unit', 'text', false, false, { placeholder: 'hour, trip, service…' })}
      </FormSection>;
      break;
    default:
      body = <Alert tone="warning">This form is not available.</Alert>;
  }

  const submitLabel = ['close', 'process'].includes(model.kind) ? (model.kind === 'close' ? (draft.status === 'WON' ? 'Close as won' : 'Close as lost') : ({ submit: 'Submit for approval', approve: 'Approve step', reject: 'Reject revision', return: 'Return for changes', accept: 'Record acceptance', expire: 'Mark expired' } as Row)[draft.process] || 'Confirm')
    : model.kind === 'generate' ? `Create ${draft.contact_ids?.length || ''} lead${draft.contact_ids?.length === 1 ? '' : 's'}`.replace('  ', ' ') : draft.id ? 'Save changes' : 'Create';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if ((model.kind === 'opportunity' || model.kind === 'quotation') && (draft.lines || []).some((l: Row) => !String(l.description || '').trim())) { form.fail('Each pricing line needs a description.'); return; }
    setBusy(true); form.reset();
    try {
      const data = { ...draft };
      if (model.kind === 'activity') { data.start_at = data.start_at ? new Date(data.start_at + '+07:00').toISOString() : ''; data.end_at = data.end_at ? new Date(data.end_at + '+07:00').toISOString() : ''; }
      if (model.kind === 'contact') data.active = String(data.active) !== '0';
      await onSave(model.action, data);
      onClose();
    } catch (err) { form.fail(err instanceof Error ? err.message : 'Unable to save.'); }
    finally { setBusy(false); }
  };
  const size = WIDE_KINDS.includes(model.kind) ? 'dialog-xl' : NARROW_KINDS.includes(model.kind) ? 'dialog-sm' : 'dialog-lg';
  return (
    <Dialog open onOpenChange={v => { if (!v) void close(); }}>
      <DialogContent className={size} onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); void close(); } }}>
        <DialogHeader>
          <DialogTitle>{model.title}</DialogTitle>
          <DialogDescription>{model.kind === 'quotation' ? 'Saving creates a new revision; previous revisions stay available.' : model.kind === 'settings' ? 'Shown on quotations, reports and printed documents. Fields marked * are required.' : draft.id ? `${state.company.name} · ${draft.id}` : `${state.company.name} · fields marked * are required`}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title="This could not be saved" live>{form.formError}</Alert>}
              {body}
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>Cancel</Button>
              <Button type="submit" loading={busy} variant={['reject'].includes(draft.process) ? 'destructive' : 'default'}>{busy ? 'Saving…' : submitLabel}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GenerateLeads({ state, value, onChange, error }: { state: Data; value: string[]; onChange: (ids: string[]) => void; error?: string }) {
  const [query, setQuery] = useState('');
  const active = useMemo(() => state.contacts.filter((c: Row) => c.active), [state.contacts]);
  const shown = active.filter((c: Row) => `${c.customer_name} ${c.id} ${c.first_name} ${c.last_name}`.toLowerCase().includes(query.toLowerCase()));
  const allShown = shown.length > 0 && shown.every((c: Row) => value.includes(c.id));
  return (
    <FormSection title="Campaign responses" description="Select the contacts who responded. Contacts that already have a lead from this campaign are skipped automatically." columns={1}>
      <div className="row-between">
        <SearchInput value={query} onChange={setQuery} placeholder="Find contacts…" label="Find contacts" className="grow" />
        <Button type="button" variant="ghost" size="sm" disabled={!shown.length} onClick={() => onChange(allShown ? value.filter(id => !shown.some((c: Row) => c.id === id)) : [...new Set([...value, ...shown.map((c: Row) => c.id)])].slice(0, 100))}>{allShown ? 'Clear shown' : 'Select shown'}</Button>
      </div>
      <div className={cn('check-grid', error && 'has-error')} role="group" aria-label="Contacts">
        {shown.map((c: Row) => (
          <label key={c.id} className="check-card">
            <Checkbox checked={value.includes(c.id)} onCheckedChange={v => onChange(v ? [...value, c.id].slice(0, 100) : value.filter(id => id !== c.id))} />
            <span className="cell-stack"><strong>{c.customer_name}</strong><small>{[c.first_name, c.last_name].filter(Boolean).join(' ')} · {c.id}</small></span>
          </label>
        ))}
        {!shown.length && <p className="inline-note">No active contacts match.</p>}
      </div>
      <p className={cn('inline-note', error && 'text-danger')}>{error || `${value.length} selected · up to 100 per run`}</p>
    </FormSection>
  );
}

export function initialModel(kind: string, state: Data, actor: string, source: Row = {}): Model {
  const defaults: Record<string, Row> = {
    contact: { owner_id: actor, active: '1' }, campaign: { status: 'DRAFT', start_date: today(), end_date: later(), budget: '0' },
    lead: { status: 'NEW', rating: 'WARM', owner_id: actor },
    opportunity: { owner_id: actor, branch_id: state.lookups.find((l: Row) => l.kind === 'branch')?.id, class_id: state.lookups.find((l: Row) => l.kind === 'opportunity_class')?.id, estimation: later(), probability: 50, costing: '0', payment_received: '0', commission: '0', lines: [] },
    activity: { parent_type: 'TASK', type: 'FOLLOWUP', channel: 'TASK', subject: '', start_at: localInput(), end_at: '', assigned_to: actor, priority: 'MEDIUM', status: 'OPEN', branch_id: state.lookups.find((l: Row) => l.kind === 'branch')?.id, forecast: '0' },
    shipment: { shipment_date: today() }, invoice: { invoice_date: today(), due_date: later() }, payment: { payment_date: today(), request_key: uuid() }, generate: { contact_ids: [] }, lookup: { kind: 'material' },
  };
  const d = { ...(defaults[kind] || {}), ...source };
  if (kind === 'opportunity' && !source.id) d.request_key = uuid();
  if (source.id) d.expected_version = source.version;
  if (kind === 'contact' && source.id) d.active = source.active === 0 ? '0' : '1';
  if (kind === 'campaign' && source.id) d.budget = (source.budget_cents / 100).toFixed(2);
  if (kind === 'opportunity' && source.id) { d.lines = state.opportunity_lines.filter((l: Row) => l.opportunity_id === source.id); d.costing = (source.costing_cents / 100).toFixed(2); d.commission = (source.commission_cents / 100).toFixed(2); d.payment_received = (source.payment_received_cents / 100).toFixed(2); }
  if (kind === 'activity' && source.id) { d.start_at = localInput(source.start_at); d.end_at = source.end_at ? localInput(source.end_at) : ''; d.forecast = (source.forecast_cents / 100).toFixed(2); }
  if (kind === 'quotation') { const rev = state.quote_revisions.find((r: Row) => r.quotation_id === source.id && r.revision === source.revision); Object.assign(d, { quotation_date: rev?.quotation_date, valid_until: rev?.valid_until, notes: rev?.notes, lines: JSON.parse(rev?.lines_json || '[]') }); }
  const names: Record<string, string> = { contact: 'contact', lead: 'lead', opportunity: 'opportunity', quotation: 'quotation revision', account: 'Business Account', campaign: 'campaign', activity: 'activity', document: 'document link', shipment: 'delivery', invoice: 'invoice', payment: 'payment', generate: 'campaign leads', settings: 'company settings', lookup: 'reference' };
  const actions: Record<string, string> = { document: 'document.link', close: 'opportunity.close', process: 'quotation.process', shipment: 'order.ship', invoice: 'order.invoice', payment: 'payment.record', generate: 'campaign.generate' };
  const processTitle: Record<string, string> = { submit: 'Submit quotation for approval', approve: 'Approve quotation step', reject: 'Reject quotation', return: 'Return quotation for changes', accept: 'Record customer acceptance', expire: 'Mark quotation expired' };
  const title = kind === 'close' ? `Close opportunity as ${d.status === 'WON' ? 'won' : 'lost'}`
    : kind === 'process' ? processTitle[d.process] || 'Update quotation'
    : kind === 'generate' ? `Generate leads · ${source.name || 'campaign'}`
    : kind === 'shipment' ? 'Record delivery' : kind === 'invoice' ? 'Create invoice' : kind === 'payment' ? 'Record payment'
    : kind === 'settings' ? 'Edit company settings' : kind === 'document' ? 'Link a document'
    : kind === 'quotation' ? `Save new revision · ${source.id}` : `${source.id ? 'Edit' : 'New'} ${names[kind] || kind}`;
  return { kind, title, action: actions[kind] || `${kind}.save`, data: d };
}

export { Missing };

import { uiText, useLanguage, dynamicLabels } from "./i18n";
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
export function Pill({ value, label }: { value: string; label?: string }) {
  useLanguage(); return <StatusBadge value={value} label={label} />; }
export function Panel({ title, children, action, className = '', description }: { title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string; description?: ReactNode }) {
  useLanguage();
  return <Card title={title} description={description} actions={action} className={className}>{children}</Card>;
}
export function Empty({ children = 'No records yet.', title }: { children?: ReactNode; title?: ReactNode }) {
  useLanguage();
  return <EmptyState compact title={title ?? children} description={title ? children : undefined} />;
}
type LegacyColumn = { key: string; label: string; render?: (r: Row) => ReactNode; numeric?: boolean; align?: 'left' | 'right' | 'center'; wrap?: boolean; sortValue?: (r: Row) => unknown; sortable?: boolean; minWidth?: number };
/** Older column shape ({label, render}) mapped onto the shared DataTable. */
export function Grid({ columns, rows, onRow, empty, stateKey, pageSize = 25 }: { columns: LegacyColumn[]; rows: Row[]; onRow?: (r: Row) => void; empty?: string; stateKey?: string; pageSize?: number }) {
  useLanguage();
  const cols: Column[] = columns.map(c => ({ key: c.key, header: c.label, cell: c.render, numeric: c.numeric, align: c.align, wrap: c.wrap, sortValue: c.sortValue, sortable: c.sortable, minWidth: c.minWidth }));
  return <DataTable columns={cols} rows={rows} onRowClick={onRow} stateKey={stateKey} pageSize={pageSize} empty={<EmptyState compact title={empty || uiText("No records yet")} />} />;
}

// ---------------------------------------------------------------- pricing lines
const newLine = () => ({ material_id: '', description: '', unit: 'service', quantity: '1', unit_price: '0', discount: '0', percentage_discount: '0', tax_percent: '10' });
const LINE_FIELDS = [dynamicLabels(['quantity', "Qty", '0.0001'], { 1: () => uiText("Qty") }), dynamicLabels(['unit_price', "Unit price", '0.0001'], { 1: () => uiText("Unit price") }), dynamicLabels(['discount', "Discount", '0.01'], { 1: () => uiText("Discount") }), dynamicLabels(['percentage_discount', "Disc. %", '0.0001'], { 1: () => uiText("Disc. %") }), dynamicLabels(['tax_percent', "VAT %", '0.0001'], { 1: () => uiText("VAT %") })] as const;

export function LineTotals({ preview, currency }: { preview: Row[]; currency: string }) {
  useLanguage();
  return (
    <dl className="line-totals">
      <div><dt>{uiText("Amount")}</dt><dd className="num">{money(sum(preview, 'amount_cents'), currency)}</dd></div>
      <div><dt>{uiText("Discounts")}</dt><dd className="num">{sum(preview, 'discount_cents') ? uiText("−{p0}", { p0: money(sum(preview, 'discount_cents'), currency) }) : money(0, currency)}</dd></div>
      <div><dt>{uiText("Net")}</dt><dd className="num">{money(sum(preview, 'net_cents'), currency)}</dd></div>
      <div><dt>VAT</dt><dd className="num">{money(sum(preview, 'vat_cents'), currency)}</dd></div>
      <div className="grand"><dt>{uiText("Total")}</dt><dd className="num">{money(sum(preview, 'total_cents'), currency)}</dd></div>
    </dl>
  );
}

/** Pricing lines: an editable, responsive grid when onChange is given, otherwise a read-only table. */
export function Lines({ lines, onChange, materials = [], currency = 'USD', error }: { lines: Row[]; onChange?: (l: Row[]) => void; materials?: Row[]; currency?: string; error?: string }) {
  useLanguage();
  const preview: Row[] = lines.map(l => { try { return { ...l, ...lineAmounts(l), invalid: false }; } catch { return { ...l, invalid: true, amount_cents: 0, discount_cents: 0, net_cents: 0, vat_cents: 0, total_cents: 0 }; } });
  const edit = (index: number, key: string, value: string) => onChange?.(lines.map((l, i) => (i === index ? { ...l, [key]: value } : l)));
  if (!onChange) {
    const cols: Column[] = [
      { key: 'description', header: uiText("Service / description"), cell: l => <span className="cell-stack"><strong>{l.description}</strong><small>{l.material_id || uiText("Custom service")} · {l.unit}</small></span>, minWidth: 220, wrap: true },
      { key: 'quantity', header: uiText("Qty"), numeric: true, sortValue: l => Number(l.quantity) },
      { key: 'unit_price', header: uiText("Unit price"), numeric: true, sortValue: l => Number(l.unit_price), cell: l => <span className="num">{Number(l.unit_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span> },
      { key: 'discount_cents', header: uiText("Discount"), numeric: true, cell: l => money(l.discount_cents, currency) },
      { key: 'vat_cents', header: 'VAT', numeric: true, cell: l => money(l.vat_cents, currency) },
      { key: 'total_cents', header: uiText("Line total"), numeric: true, cell: l => <strong className="num">{money(l.total_cents, currency)}</strong> },
    ];
    return (
      <div className="lines-view">
        <DataTable columns={cols} rows={preview} rowKey={(_, i) => String(i)} pageSize={0} empty={<EmptyState compact title={uiText("No pricing lines")} description={uiText("Pricing lines appear here once they are added.")} />} />
        {preview.length > 0 && <LineTotals preview={preview} currency={currency} />}
      </div>
    );
  }
  return (
    <div className={cn('line-editor', error && 'has-error')}>
      <div className="line-grid line-grid-head" aria-hidden="true">
        <span>#</span><span>{uiText("Service / description")}</span>{LINE_FIELDS.map(([, label]) => <span key={label} className="align-right">{label}</span>)}<span className="align-right">{uiText("Line total")}</span><span />
      </div>
      {lines.map((l, i) => (
        <div className="line-grid line-row" key={i} role="group" aria-label={uiText("Line {p0}", { p0: i + 1 })}>
          <span className="line-index">{i + 1}</span>
          <div className="line-desc">
            <Picker hideLabel label={uiText("Line {p0} service", { p0: i + 1 })} value={l.material_id} options={materials.map(m => [m.id, m.name])} none={uiText("Custom service")}
              onChange={v => { const m = materials.find(x => x.id === v); onChange(lines.map((row, j) => (i === j ? { ...row, material_id: v, description: m?.name || row.description, unit: m?.unit || row.unit } : row))); }} />
            <div className="line-desc-row">
              <Input aria-label={uiText("Line {p0} description", { p0: i + 1 })} placeholder={uiText("Description *")} value={l.description} onChange={e => edit(i, 'description', e.target.value)} required aria-invalid={!l.description?.trim() && !!error ? true : undefined} />
              <Input aria-label={uiText("Line {p0} unit", { p0: i + 1 })} placeholder={uiText("Unit")} value={l.unit} onChange={e => edit(i, 'unit', e.target.value)} className="line-unit" />
            </div>
          </div>
          {LINE_FIELDS.map(([k, label, step]) => (
            <label key={k} className="line-num">
              <span className="line-num-label">{label}</span>
              <Input aria-label={uiText("Line {p0} {p1}", { p0: i + 1, p1: label })} type="number" inputMode="decimal" step={step} min="0" value={l[k]} onChange={e => edit(i, k, e.target.value)} className="num" />
            </label>
          ))}
          <span className="line-total num" aria-label={uiText("Line {p0} total", { p0: i + 1 })}>
            <span className="line-num-label">{uiText("Line total")}</span>
            {preview[i].invalid ? <span className="text-danger">{uiText("Check values")}</span> : money(preview[i].total_cents, currency)}
          </span>
          <Button type="button" variant="ghost" size="icon-sm" className="line-remove" aria-label={uiText("Remove line {p0}", { p0: i + 1 })} title={uiText("Remove line")} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      {!lines.length && <div className="line-empty">{uiText("No pricing lines yet. Add the services this price covers.")}</div>}
      <div className="line-footer">
        <div className="stack-sm">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, newLine()])} disabled={lines.length >= 100}><Plus />{uiText("Add line")}</Button>
          <p className="inline-note">{uiText("Percentage discount applies first, then the fixed discount; VAT is calculated on the remaining amount. Up to 100 lines.")}</p>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <LineTotals preview={preview} currency={currency} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- CRM record editor
const options = (arr: string[]): [string, string][] => arr.map(v => [v, uiText(v.charAt(0) + v.slice(1).toLowerCase().replaceAll('_', ' '))]);
const WIDE_KINDS = ['opportunity', 'quotation'];
const NARROW_KINDS = ['close', 'process', 'invoice', 'document', 'shipment', 'payment', 'lookup'];

export function Editor({ model, state, onSave, onClose }: { model: Model; state: Data; actor: string; onSave: (action: string, data: Row) => Promise<void>; onClose: () => void }) {
  useLanguage();
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
    return <Picker key={k} fieldKey={k} label={label} value={draft[k]} options={opts} required={required} disabled={disabled} none={none ?? (required ? uiText("Select…") : uiText("None"))} hint={hint} wide={wide} error={form.errors[k]} onChange={v => set(k, v)} />;
  };
  const ref = (k: string, label: string, kind: string, required = false, aliases: string[] = []) => pick(k, label, refs(kind), { required, aliases: [kind.replaceAll('_', ' '), ...aliases] });
  const contactOptions: [string, string][] = state.contacts.map((c: Row) => [c.id, `${c.customer_name} · ${c.id}`]);
  const materials = state.lookups.filter((r: Row) => r.kind === 'material');
  const close = async () => {
    if (busy) return;
    if (dirty && !(await confirm({ title: uiText("Discard unsaved changes?"), description: uiText("The information you entered in this form will be lost."), confirmLabel: uiText("Discard changes"), cancelLabel: uiText("Keep editing"), tone: 'danger' }))) return;
    onClose();
  };

  let body: ReactNode;
  switch (model.kind) {
    case 'contact':
      body = <>
        <FormSection title={uiText("Customer")}>
          {field('customer_name', uiText("Customer / company name"), 'text', true, true)}
          {!draft.id && field('code', uiText("Contact ID"), 'text', false, false, { hint: uiText("Leave blank for an automatic ID (CONT-000123)."), placeholder: uiText("Automatic") })}
          {pick('active', uiText("Contact status"), [['1', uiText("Active")], ['0', uiText("Inactive")]], { required: true })}
        </FormSection>
        <FormSection title={uiText("Contact person")}>
          {field('first_name', uiText("First name"), 'text', true)}{field('last_name', uiText("Last name"))}
          {field('email', uiText("Email"), 'email', false, false, { placeholder: 'name@company.com' })}{field('phone', uiText("Phone"))}
          {field('mobile', uiText("Mobile"))}{field('address', uiText("Address"))}
        </FormSection>
        <FormSection title={uiText("Ownership & source")}>
          {ref('owner_id', uiText("Owner"), 'staff', true)}{ref('class_id', uiText("Contact class"), 'contact_class')}
          {field('source', uiText("Inquiry source"), 'text', false, false, { placeholder: uiText("Website, referral…") })}{ref('partner_id', uiText("Partner"), 'partner')}
          {field('notes', uiText("Notes"), 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'campaign':
      body = <>
        <FormSection title={uiText("Campaign")}>
          {field('name', uiText("Campaign name"), 'text', true, true)}
          {ref('class_id', uiText("Campaign class"), 'campaign_class')}{pick('status', uiText("Status"), options(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']), { required: true })}
          {field('audience', uiText("Target audience"), 'text', false, true)}
        </FormSection>
        <FormSection title={uiText("Schedule & budget")}>
          {field('start_date', uiText("Start date"), 'date', true)}{field('end_date', uiText("End date"), 'date', true, false, { min: draft.start_date })}
          {field('budget', uiText("Budget"), 'number', false, false, { hint: uiText("Amount in {p0}.", { p0: currency }) })}
          {field('description', uiText("Description"), 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'lead':
      body = <>
        <FormSection title={uiText("Lead")}>
          {pick('contact_id', uiText("Contact"), contactOptions, { required: true, disabled: !!draft.id })}
          {pick('campaign_id', uiText("Campaign"), state.campaigns.map((c: Row) => [c.id, c.name]), { disabled: !!draft.id, none: uiText("Direct inquiry (no campaign)") })}
          {pick('status', uiText("Status"), options(['NEW', 'QUALIFIED', 'DISQUALIFIED']), { required: true, hint: uiText("Qualified leads can be converted into opportunities.") })}
          {pick('rating', uiText("Rating"), options(['HOT', 'WARM', 'COLD']), { required: true })}
          {draft.status === 'DISQUALIFIED' && field('reason', uiText("Disqualification reason"), 'textarea', true, true)}
        </FormSection>
        <FormSection title={uiText("Ownership")}>
          {ref('owner_id', uiText("Owner"), 'staff', true)}{ref('class_id', uiText("Lead class"), 'lead_class')}
          {field('source', uiText("Source"))}
          {field('notes', uiText("Notes"), 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    case 'opportunity':
      body = <>
        <FormSection title={uiText("Opportunity")} columns={3}>
          {pick('contact_id', uiText("Contact"), contactOptions, { required: true, disabled: !!draft.id || !!draft.lead_id, wide: true })}
          {field('title', uiText("Opportunity title"), 'text', true, true)}
          {ref('owner_id', uiText("Salesman"), 'staff', true)}{ref('branch_id', uiText("Branch"), 'branch', true)}{ref('class_id', uiText("Business group"), 'opportunity_class', true)}
          {ref('partner_id', uiText("Partner"), 'partner')}{field('customer_reference', uiText("Customer reference"))}
        </FormSection>
        <FormSection title={uiText("Forecast & costs")} columns={3}>
          {field('estimation', uiText("Expected close date"), 'date', true)}{field('probability', uiText("Probability %"), 'number', true, false, { min: '0', max: '100' })}
          {field('costing', uiText("Costing"), 'number', false, false, { hint: uiText("Total cost in {p0}; counted once per opportunity.", { p0: currency }) })}
          {field('payment_received', uiText("CRM payment received"), 'number')}{field('commission', uiText("Commission"), 'number')}
        </FormSection>
        <FormSection title={uiText("Pricing")} description={uiText("Line items for this opportunity. When the sale is won, these prices are preserved in the sale snapshot.")} columns={1}>
          <Lines lines={draft.lines || []} onChange={v => set('lines', v)} materials={materials} currency={currency} error={form.errors.lines} />
        </FormSection>
        <FormSection columns={1}>{field('notes', uiText("Notes"), 'textarea', false, true)}</FormSection>
      </>;
      break;
    case 'quotation':
      body = <>
        <FormSection title={uiText("Validity")}>
          {field('quotation_date', uiText("Quotation date"), 'date', true)}{field('valid_until', uiText("Valid until"), 'date', true, false, { min: draft.quotation_date, aliases: ["valid-until date", "valid until date"] })}
        </FormSection>
        <FormSection title={uiText("Quoted lines")} description={uiText("Saving creates a new revision. Earlier revisions stay available and read-only.")} columns={1}>
          <Lines lines={draft.lines || []} onChange={v => set('lines', v)} materials={materials} currency={currency} error={form.errors.lines} />
        </FormSection>
        <FormSection columns={1}>{field('notes', uiText("Notes / terms"), 'textarea', false, true)}</FormSection>
      </>;
      break;
    case 'account':
      body = <FormSection>
        {field('name', uiText("Account name"), 'text', true, true)}
        {ref('owner_id', uiText("Owner"), 'staff', true)}{ref('partner_id', uiText("Partner"), 'partner')}
        {pick('status', uiText("Status"), options(['ACTIVE', 'INACTIVE', 'SUSPENDED']), { required: true, hint: uiText("Only active accounts can accept new sales and purchase orders.") })}
        {field('notes', uiText("Notes / partner details"), 'textarea', false, true)}
      </FormSection>;
      break;
    case 'activity': {
      const ptype = draft.parent_type || 'TASK';
      const entities = ptype === 'CONTACT' ? state.contacts : ptype === 'LEAD' ? state.leads : ptype === 'OPPORTUNITY' ? state.opportunities : state.accounts;
      const parents: [string, string][] = entities.map((r: Row) => [r.id, `${r.id} · ${r.customer_name || r.title || r.name || state.contacts.find((c: Row) => c.id === r.contact_id)?.customer_name || ''}`]);
      body = <>
        <FormSection title={uiText("Related record")}>
          {pick('parent_type', uiText("Related record type"), [['CONTACT', uiText("Contact")], ['LEAD', uiText("Lead")], ['OPPORTUNITY', uiText("Opportunity")], ['ACCOUNT', uiText("Business Account")], ['TASK', uiText("Internal task (no customer)")]], { required: true, disabled: !!draft.id })}
          {ptype !== 'TASK' ? pick('parent_id', uiText("Related record"), parents, { required: true, disabled: !!draft.id }) : <p className="inline-note field-note">{uiText("Internal tasks are not linked to a customer.")}</p>}
        </FormSection>
        <FormSection title={uiText("Activity")}>
          {field('subject', uiText("Subject"), 'text', true, true)}
          {pick('type', uiText("Activity type"), [['FOLLOWUP', 'Follow-up'], ['CHAT', uiText("Chat")], ...(ptype === 'OPPORTUNITY' ? [['OPPORTUNITY', uiText("Deal activity")] as [string, string]] : []), ...(ptype === 'ACCOUNT' ? [["AFTER SALE", uiText("After sale")] as [string, string]] : [])], { required: true })}
          {pick('channel', uiText("Channel"), options(['CALL', 'MEETING', 'EMAIL', 'NOTE', 'TASK']), { required: true })}
          {ref('assigned_to', uiText("Assigned to"), 'staff', true)}{ref('branch_id', uiText("Branch"), 'branch', true)}
          {pick('priority', uiText("Priority"), options(['HIGH', 'MEDIUM', 'LOW']), { required: true })}{pick('status', uiText("Status"), options(['OPEN', 'COMPLETED', 'CANCELLED']), { required: true })}
        </FormSection>
        <FormSection title={uiText("Schedule")} description={uiText("Times use Cambodia time (UTC+7).")}>
          {field('start_at', uiText("Start / due time"), 'datetime-local', true, false, { aliases: ["start date time"] })}{field('end_at', uiText("End time"), 'datetime-local', false, false, { aliases: ["end date time"] })}
          {draft.type === 'AFTER SALE' && field('forecast', uiText("After-sale forecast value"), 'number', false, false, { hint: uiText("Amount in {p0}.", { p0: currency }) })}
          {draft.status === 'CANCELLED' && field('reason', uiText("Cancellation reason"), 'textarea', true, true)}
          {field('summary', uiText("Notes (call, meeting or task)"), 'textarea', false, true)}
        </FormSection>
      </>;
      break;
    }
    case 'document':
      body = <FormSection columns={1}>
        {field('title', uiText("Document title"), 'text', true)}
        {field('url', uiText("Document URL"), 'url', true, false, { placeholder: 'https://', hint: uiText("A complete http or https link. Files stay with their original provider; only the link is stored.") })}
      </FormSection>;
      break;
    case 'close':
      body = <FormSection columns={1}>
        <Alert tone={draft.status === 'WON' ? 'success' : 'warning'} title={draft.status === 'WON' ? uiText("Close this opportunity as won") : uiText("Close this opportunity as lost")}>
          {draft.status === 'WON' ? uiText("The contact, opportunity, pricing and activity history are saved as a sale snapshot, and an active Business Account is created or linked. Create the formal Sales Quotation next.") : uiText("The opportunity becomes read-only. Its history remains available.")}
        </Alert>
        {draft.status === 'LOST' && field('reason', uiText("Lost reason"), 'textarea', true, true)}
      </FormSection>;
      break;
    case 'process': {
      const text: Record<string, string> = { accept: 'Record the customer’s acceptance of the approved revision. The final quotation and acceptance snapshot are connected to the existing Business Account.', submit: 'Submit this saved revision to the configured approval chain. It is locked while under review.', approve: 'Approve the current step for this revision.', reject: 'Reject this revision. It can be revised and submitted again.', return: 'Return this revision to the author for changes.', expire: 'Mark this quotation as expired. It can be revised with a new validity date.' };
      body = <FormSection columns={1}>
        <Alert tone={['reject', 'return', 'expire'].includes(draft.process) ? 'warning' : 'info'}>{text[draft.process] || uiText("Record this action for the current revision.")}</Alert>
        {field('comment', ['reject', 'return'].includes(draft.process) ? uiText("Reason") : uiText("Comment"), 'textarea', ['reject', 'return'].includes(draft.process), true, { aliases: ['comment'] })}
      </FormSection>;
      break;
    }
    case 'shipment':
      body = <FormSection>{field('reference', uiText("Delivery / shipment reference"), 'text', true, true)}{field('shipment_date', uiText("Delivery date"), 'date', true)}{field('notes', uiText("Notes"), 'textarea', false, true)}</FormSection>;
      break;
    case 'invoice':
      body = <FormSection>{field('invoice_date', uiText("Invoice date"), 'date', true)}{field('due_date', uiText("Due date"), 'date', true, false, { min: draft.invoice_date })}</FormSection>;
      break;
    case 'payment':
      body = <FormSection>
        <Alert tone="info" className="span-2">{uiText("Remaining balance: ")}<strong className="num">{money(draft.balance, currency)}</strong>{uiText(". Partial payments are supported.")}</Alert>
        {field('amount', uiText("Payment amount"), 'number', true, false, { aliases: ['amount'] })}{field('payment_date', uiText("Payment date"), 'date', true)}
        {field('reference', uiText("Receipt / bank reference"), 'text', true, true, { aliases: ["payment reference"] })}
      </FormSection>;
      break;
    case 'generate':
      body = <GenerateLeads state={state} value={draft.contact_ids || []} onChange={ids => set('contact_ids', ids)} error={form.errors.contact_ids} />;
      form.register({ key: 'contact_ids', label: uiText("Contacts"), required: true, type: 'select', value: draft.contact_ids });
      break;
    case 'settings':
      body = <>
        <FormSection title={uiText("Company details")}>
          {field('name', uiText("Company name"), 'text', true, true)}{field('tax_id', uiText("Tax ID"))}{field('phone', uiText("Phone"))}
          {field('email', uiText("Email"), 'email', false, false, { aliases: ["company email"] })}
          {pick('timezone', uiText("Time zone"), zoneOptions(), { none: uiText("Phnom Penh (UTC+7, default)"), hint: uiText("For the calendar, meeting times and reminders of everyone who hasn’t chosen their own.") })}
          {field('address', uiText("Address"), 'textarea', false, true)}
        </FormSection>
        <FormSection title={uiText("Approval chain")} description={uiText("Applies to future submissions of quotations and operations requests. Requests already submitted keep their original chain.")} columns={1}>
          <div className="approval-editor">
            {draft.approvers.map((id: string, i: number) => (
              <div className="approval-edit-row" key={i}>
                <span className="approval-step-no" aria-hidden="true">{i + 1}</span>
                <Picker label={uiText("Step {p0} approver", { p0: i + 1 })} value={id} options={refs('staff')} required onChange={v => { set('approvers', draft.approvers.map((a: string, j: number) => (j === i ? v : a))); form.clear(`approver-${i}`); }} error={form.errors[`approver-${i}`]} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={uiText("Remove step {p0}", { p0: i + 1 })} title={uiText("Remove step")} disabled={draft.approvers.length === 1} onClick={() => set('approvers', draft.approvers.filter((_: string, j: number) => i !== j))}><Trash2 /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={draft.approvers.length >= 5} onClick={() => set('approvers', [...draft.approvers, ''])}><Plus />{uiText("Add approval step")}</Button>
            <p className="inline-note">{uiText("Up to five different approvers, in order.")}</p>
          </div>
        </FormSection>
      </>;
      draft.approvers.forEach((a: string, i: number) => form.register({ key: `approver-${i}`, label: uiText("Step {p0} approver", { p0: i + 1 }), required: true, type: 'select', value: a }));
      break;
    case 'lookup':
      body = <FormSection columns={1}>
        {pick('kind', uiText("Reference type"), [['staff', uiText("Staff")], ['branch', uiText("Branch")], ['material', uiText("Service / material")], ['opportunity_class', uiText("Opportunity class")], ['contact_class', uiText("Contact class")], ['lead_class', uiText("Lead class")], ['campaign_class', uiText("Campaign class")], ['partner', uiText("Partner")]], { required: true, disabled: !!draft.id })}
        {field('name', uiText("Name"), 'text', true)}
        {draft.kind === 'material' && field('unit', uiText("Unit"), 'text', false, false, { placeholder: uiText("hour, trip, service…") })}
      </FormSection>;
      break;
    default:
      body = <Alert tone="warning">{uiText("This form is not available.")}</Alert>;
  }

  const submitLabel = ['close', 'process'].includes(model.kind) ? (model.kind === 'close' ? (draft.status === 'WON' ? uiText("Close as won") : uiText("Close as lost")) : ({ submit: 'Submit for approval', approve: 'Approve step', reject: 'Reject revision', return: 'Return for changes', accept: 'Record acceptance', expire: 'Mark expired' } as Row)[draft.process] || uiText("Confirm"))
    : model.kind === 'generate' ? `Create ${draft.contact_ids?.length || ''} lead${draft.contact_ids?.length === 1 ? '' : 's'}`.replace('  ', ' ') : draft.id ? uiText("Save changes") : uiText("Create");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if ((model.kind === 'opportunity' || model.kind === 'quotation') && (draft.lines || []).some((l: Row) => !String(l.description || '').trim())) { form.fail(uiText("Each pricing line needs a description.")); return; }
    setBusy(true); form.reset();
    try {
      const data = { ...draft };
      if (model.kind === 'activity') { data.start_at = data.start_at ? new Date(data.start_at + '+07:00').toISOString() : ''; data.end_at = data.end_at ? new Date(data.end_at + '+07:00').toISOString() : ''; }
      if (model.kind === 'contact') data.active = String(data.active) !== '0';
      await onSave(model.action, data);
      onClose();
    } catch (err) { form.fail(err instanceof Error ? err.message : uiText("Unable to save.")); }
    finally { setBusy(false); }
  };
  const size = WIDE_KINDS.includes(model.kind) ? 'dialog-xl' : NARROW_KINDS.includes(model.kind) ? 'dialog-sm' : 'dialog-lg';
  return (
    <Dialog open onOpenChange={v => { if (!v) void close(); }}>
      <DialogContent className={size} onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); void close(); } }}>
        <DialogHeader>
          <DialogTitle>{model.title}</DialogTitle>
          <DialogDescription>{model.kind === 'quotation' ? uiText("Saving creates a new revision; previous revisions stay available.") : model.kind === 'settings' ? uiText("Shown on quotations, reports and printed documents. Fields marked * are required.") : draft.id ? uiText("{p0} · {p1}", { p0: state.company.name, p1: draft.id }) : uiText("{p0} · fields marked * are required", { p0: state.company.name })}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title={uiText("This could not be saved")} live>{form.formError}</Alert>}
              {body}
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>{uiText("Cancel")}</Button>
              <Button type="submit" loading={busy} variant={['reject'].includes(draft.process) ? 'destructive' : 'default'}>{busy ? uiText("Saving…") : submitLabel}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GenerateLeads({ state, value, onChange, error }: { state: Data; value: string[]; onChange: (ids: string[]) => void; error?: string }) {
  useLanguage();
  const [query, setQuery] = useState('');
  const active = useMemo(() => state.contacts.filter((c: Row) => c.active), [state.contacts]);
  const shown = active.filter((c: Row) => `${c.customer_name} ${c.id} ${c.first_name} ${c.last_name}`.toLowerCase().includes(query.toLowerCase()));
  const allShown = shown.length > 0 && shown.every((c: Row) => value.includes(c.id));
  return (
    <FormSection title={uiText("Campaign responses")} description={uiText("Select the contacts who responded. Contacts that already have a lead from this campaign are skipped automatically.")} columns={1}>
      <div className="row-between">
        <SearchInput value={query} onChange={setQuery} placeholder={uiText("Find contacts…")} label={uiText("Find contacts")} className="grow" />
        <Button type="button" variant="ghost" size="sm" disabled={!shown.length} onClick={() => onChange(allShown ? value.filter(id => !shown.some((c: Row) => c.id === id)) : [...new Set([...value, ...shown.map((c: Row) => c.id)])].slice(0, 100))}>{allShown ? uiText("Clear shown") : uiText("Select shown")}</Button>
      </div>
      <div className={cn('check-grid', error && 'has-error')} role="group" aria-label={uiText("Contacts")}>
        {shown.map((c: Row) => (
          <label key={c.id} className="check-card">
            <Checkbox checked={value.includes(c.id)} onCheckedChange={v => onChange(v ? [...value, c.id].slice(0, 100) : value.filter(id => id !== c.id))} />
            <span className="cell-stack"><strong>{c.customer_name}</strong><small>{[c.first_name, c.last_name].filter(Boolean).join(' ')} · {c.id}</small></span>
          </label>
        ))}
        {!shown.length && <p className="inline-note">{uiText("No active contacts match.")}</p>}
      </div>
      <p className={cn('inline-note', error && 'text-danger')}>{error || uiText("{p0} selected · up to 100 per run", { p0: value.length })}</p>
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
    : kind === 'process' ? processTitle[d.process] || uiText("Update quotation")
    : kind === 'generate' ? `Generate leads · ${source.name || 'campaign'}`
    : kind === 'shipment' ? uiText("Record delivery") : kind === 'invoice' ? uiText("Create invoice") : kind === 'payment' ? uiText("Record payment")
    : kind === 'settings' ? uiText("Edit company settings") : kind === 'document' ? uiText("Link a document")
    : kind === 'quotation' ? `Save new revision · ${source.id}` : `${source.id ? uiText("Edit") : uiText("New")} ${names[kind] || kind}`;
  return { kind, title, action: actions[kind] || `${kind}.save`, data: d };
}

export { Missing };

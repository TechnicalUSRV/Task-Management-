import { uiText, useLanguage, translatedEntries , translatedMap } from "./i18n";
import { apiFetch, apiPath, uuid } from './api-client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight, Bell, CheckCheck, CheckCircle2, ChevronDown, Download, Eye, FileText, Pencil, Plus, Printer, Send, Settings2, Trash2, Truck, Undo2, Upload, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { type Row, money, sum, today } from './components';
import type { Workspace } from './ui';
import { lineAmounts } from './money.mjs';
import { REQUEST_TYPES, SHIPMENT_STATUSES, CONTAINER_SIZES, COA_CATEGORIES, PAYMENT_CATEGORIES, priceJob, performanceRows, categoryFor } from './operations-domain.mjs';
import { OPS_REPORTS, poDeadlines } from './operations-reports.mjs';
import { useServerReport } from './report-hook';
import { OPS_RESOURCE } from './access-catalog.mjs';
import { useViewState } from './router';
import { formatDate, formatDateTime, formatMonth, formatRange, isMissing, plural } from './format';
import {
  Alert, ButtonLink, Card, CheckboxField, DataTable, DateRangeFilter, DateText, EmptyState, ErrorState, ExpandableText, Field, FilterBar, FilterSelect,
  FormSection, KeyValues, Money, NoAccess, PageHeader, Picker, SearchInput, SectionTabs, StatCard, StatusBadge, Stepper, Tag, buildChips,
  statusLabel, useConfirm, useFormErrors, type Column, type DateRange,
} from './ui-kit';

type RequestType = keyof typeof REQUEST_TYPES;
const TYPE_ORDER: RequestType[] = ['QUOTATION', 'PO', 'JOB', 'DN', 'PR'];
const SHORT: Record<string, string> = translatedMap({ QUOTATION: 'Quotation', PO: 'Purchase order', JOB: 'Job file', DN: 'Debit note', PR: 'Payment request' });
const SOURCE_TYPE: Record<string, RequestType> = { PO: 'QUOTATION', JOB: 'PO', DN: 'JOB', PR: 'DN' };
const opts = (v: string[]): [string, string][] => v.map(k => [k, statusLabel(k)]);
const newCharge = (): Row => ({ description: '', unit: 'service', quantity: '1', unit_price: '0', discount: '0', percentage_discount: '0', tax_percent: '0', category: '', container_size: 'ALL', rate_basis: 'SHIPMENT', remark: '' });
const approved = (w: Workspace, type: string) => w.data.ops_requests.filter((r: Row) => r.type === type && r.status === 'APPROVED');
const datePlus = (n: number) => new Date(Date.parse(`${today()}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const resourceOf = (type: string) => OPS_RESOURCE[type as keyof typeof OPS_RESOURCE];
const nextApprover = (r: Row) => r.status === 'SUBMITTED' ? JSON.parse(r.approval_chain)[r.approval_step - 1] : null;

function draftRequest(w: Workspace, type: string, sourceId = '', existing?: Row): Row {
  if (existing) return { ...existing.payload, id: existing.id, type: existing.type, source_id: existing.source_id, contact_id: existing.contact_id, crm_quote_id: existing.crm_quote_id, expected_version: existing.version, containers: existing.payload.containers?.join('\n') || '', commission: String((existing.payload.commission_cents || 0) / 100) };
  const source = w.data.ops_requests.find((r: Row) => r.id === sourceId), p = source?.payload || {};
  return {
    request_key: uuid(), type, source_id: sourceId, contact_id: source?.contact_id || '', crm_quote_id: '', document_date: today(), valid_until: datePlus(30), due_date: datePlus(30), booking_date: today(), booking_confirmed: false,
    commodity_type: p.commodity_type || 'GENERAL', commodity: p.commodity || '', terms: p.terms || '', consignee: '', quantity: '1', unit: 'unit', service_type: '', scope_of_services: '',
    containers: '', container_size: '20FT', eta: datePlus(7), etd: today(), extra_lines: [], lines: [newCharge()], notes: '', commission: '0', closing_date: today(),
  };
}

// ================================================================ charge lines
function ChargeLines({ lines, onChange, type, currency, rules = [], error }: { lines: Row[]; onChange?: (r: Row[]) => void; type: string; currency: string; rules?: Row[]; error?: string }) {
  useLanguage();
  const quote = type === 'QUOTATION', categories = type === 'PR' ? PAYMENT_CATEGORIES : COA_CATEGORIES;
  const preview: Row[] = lines.map(l => { try { return { ...l, ...lineAmounts(l) }; } catch { return { ...l, total_cents: 0, discount_cents: 0, vat_cents: 0, error: true }; } });
  const set = (i: number, k: string, v: string) => onChange?.(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  if (!onChange) {
    const cols: Column[] = [
      { key: 'description', header: uiText("Charge"), minWidth: 200, wrap: true, cell: r => <span className="cell-stack"><span className="cell-title">{r.description}</span><small className="charge-meta">{[r.source === 'QUOTATION' ? uiText("From approved quotation") : r.source === 'EXTRA' ? uiText("Job File extra charge") : '', r.remark].filter(Boolean).map((t, i) => <span key={i}>{t}</span>)}{r.category && <span className="charge-coa" title={uiText("Chart of accounts category")}>{uiText("COA · ")}{statusLabel(r.category)}</span>}</small></span> },
      ...(quote ? [{ key: 'container_size', header: uiText("Size"), cell: (r: Row) => <Tag>{r.container_size}</Tag> } as Column, { key: 'rate_basis', header: uiText("Rate basis"), cell: (r: Row) => r.rate_basis === 'CONTAINER' ? uiText("Per container") : uiText("Per shipment") } as Column] : []),
      { key: 'quantity', header: uiText("Qty"), numeric: true, sortValue: r => Number(r.quantity), cell: r => <span className="num">{Number(r.quantity).toLocaleString('en-US', { maximumFractionDigits: 4 })} {r.unit}</span> },
      { key: 'unit_price', header: uiText("Unit price"), numeric: true, sortValue: r => Number(r.unit_price), cell: r => <span className="num">{Number(r.unit_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span> },
      { key: 'discount_cents', header: uiText("Discount"), numeric: true, cell: r => <Money cents={r.discount_cents} currency={currency} /> },
      { key: 'vat_cents', header: 'VAT', numeric: true, cell: r => <Money cents={r.vat_cents} currency={currency} /> },
      { key: 'total_cents', header: uiText("Total"), numeric: true, cell: r => <strong className="num">{money(r.total_cents, currency)}</strong> },
    ];
    return <DataTable columns={cols} rows={preview} rowKey={(_, i) => String(i)} pageSize={0} empty={<EmptyState compact title={uiText("No charge lines")} />} />;
  }
  return (
    <div className={`line-editor charge-editor${quote ? " is-quote" : ''}${error ? " has-error" : ''}`}>
      <div className="line-grid line-grid-head" aria-hidden="true">
        <span>#</span><span>{uiText("Charge / remark")}</span>{quote && <span>{uiText("Size · basis")}</span>}<span className="align-right">{uiText("Qty · unit")}</span><span className="align-right">{uiText("Unit price")}</span><span className="align-right">{uiText("Discount")}</span><span className="align-right">{uiText("Disc. %")}</span><span className="align-right">{uiText("VAT %")}</span><span>COA</span><span className="align-right">{uiText("Total")}</span><span />
      </div>
      {lines.map((l, i) => (
        <div className="line-grid line-row" key={i} role="group" aria-label={uiText("Charge {p0}", { p0: i + 1 })}>
          <span className="line-index">{i + 1}</span>
          <div className="line-desc">
            <Input aria-label={uiText("Charge {p0} description", { p0: i + 1 })} placeholder={uiText("Charge, e.g. Clearance fee *")} value={l.description} required onChange={e => set(i, 'description', e.target.value)} />
            <Input aria-label={uiText("Charge {p0} remark", { p0: i + 1 })} placeholder={uiText("Remark (optional)")} value={l.remark || ''} onChange={e => set(i, 'remark', e.target.value)} />
          </div>
          {quote && <div className="line-desc">
            <Picker hideLabel label={uiText("Charge {p0} container size", { p0: i + 1 })} value={l.container_size} options={opts(['ALL', ...CONTAINER_SIZES]).map(([v]) => [v, v === 'ALL' ? uiText("All sizes") : v])} allowNone={false} onChange={v => set(i, 'container_size', v)} />
            <Picker hideLabel label={uiText("Charge {p0} rate basis", { p0: i + 1 })} value={l.rate_basis} options={[['SHIPMENT', uiText("Per shipment")], ['CONTAINER', uiText("Per container")]]} allowNone={false} onChange={v => set(i, 'rate_basis', v)} />
          </div>}
          <div className="line-num line-qty">
            <span className="line-num-label">{uiText("Qty · unit")}</span>
            <Input aria-label={uiText("Charge {p0} quantity", { p0: i + 1 })} type="number" inputMode="decimal" step="0.0001" min="0.0001" value={l.quantity} required onChange={e => set(i, 'quantity', e.target.value)} className="num" />
            <Input aria-label={uiText("Charge {p0} unit", { p0: i + 1 })} value={l.unit} onChange={e => set(i, 'unit', e.target.value)} placeholder={uiText("Unit")} />
          </div>
          {([['unit_price', uiText("Unit price"), '0.0001'], ['discount', uiText("Discount"), '0.01'], ['percentage_discount', uiText("Disc. %"), '0.0001'], ['tax_percent', uiText("VAT %"), '0.0001']] as const).map(([k, label, step]) => (
            <label key={k} className="line-num"><span className="line-num-label">{label}</span><Input aria-label={uiText("Charge {p0} {p1}", { p0: i + 1, p1: label })} type="number" inputMode="decimal" step={step} min="0" value={l[k] || '0'} onChange={e => set(i, k, e.target.value)} className="num" /></label>
          ))}
          <div className="line-num line-coa"><span className="line-num-label">COA</span><Picker hideLabel label={uiText("Charge {p0} COA category", { p0: i + 1 })} value={l.category} options={opts(categories)} none={uiText("Auto · {p0}", { p0: statusLabel(categoryFor(l.description || '', type, rules)) })} onChange={v => set(i, 'category', v)} /></div>
          <span className="line-total num"><span className="line-num-label">{uiText("Total")}</span>{preview[i].error ? <span className="text-danger">{uiText("Check amounts")}</span> : money(preview[i].total_cents, currency)}</span>
          <Button type="button" size="icon-sm" variant="ghost" className="line-remove" aria-label={uiText("Remove charge {p0}", { p0: i + 1 })} title={uiText("Remove charge")} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      {!lines.length && <div className="line-empty">{uiText("No charges yet.")}</div>}
      <div className="line-footer">
        <div className="stack-sm">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, newCharge()])}><Plus />{uiText("Add charge")}</Button>
          <p className="inline-note">{quote ? uiText("Size-specific rates are alternatives: “All sizes” applies to every size; per-container rates multiply by the Job File’s container count.") : uiText("Percentage discount applies first, then the fixed discount; VAT is calculated on the remaining amount.")} {uiText("COA categories follow the description rules unless you choose one.")}</p>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        {!quote && <dl className="line-totals"><div className="grand"><dt>{uiText("Total")}</dt><dd className="num">{money(sum(preview, 'total_cents'), currency)}</dd></div></dl>}
      </div>
    </div>
  );
}

// ================================================================ editor
type Modal = { mode: string; title: string; draft: Row };
function OperationsEditor({ w, model, onClose, onSaved }: { w: Workspace; model: Modal; onClose: () => void; onSaved: (r: Row) => void }) {
  useLanguage();
  const [d, setD] = useState<Row>(() => structuredClone(model.draft)), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const form = useFormErrors(), confirm = useConfirm();
  const set = (k: string, v: any) => { setD(s => ({ ...s, [k]: v })); setDirty(true); form.clear(k); };
  useEffect(() => { if (!dirty) return; const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, [dirty]);
  const close = async () => { if (busy) return; if (dirty && !(await confirm({ title: uiText("Discard unsaved changes?"), description: uiText("The information you entered in this form will be lost."), confirmLabel: uiText("Discard changes"), cancelLabel: uiText("Keep editing"), tone: 'danger' }))) return; onClose(); };
  const field = (k: string, l: string, type = 'text', required = false, wide = false, extra: { hint?: string; placeholder?: string; min?: string; aliases?: string[] } = {}) => { form.register({ key: k, label: l, required, type, value: d[k], aliases: extra.aliases }); return <Field key={k} fieldKey={k} label={l} value={d[k]} onChange={v => set(k, v)} type={type} required={required} wide={wide} hint={extra.hint} placeholder={extra.placeholder} min={extra.min} error={form.errors[k]} />; };
  const picker = (k: string, l: string, choices: [string, string][], { required = false, disabled = false, none, hint, wide }: { required?: boolean; disabled?: boolean; none?: string; hint?: string; wide?: boolean } = {}) => { form.register({ key: k, label: l, required, type: 'select', value: d[k] }); return <Picker key={k} fieldKey={k} label={l} value={d[k]} options={choices} onChange={v => set(k, v)} disabled={disabled} required={required} none={none} hint={hint} wide={wide} error={form.errors[k]} />; };
  let body: ReactNode, action = model.mode;
  const request = w.data.ops_requests.find((r: Row) => r.id === d.id), type = d.type as string;
  const rules = w.data.ops_settings.coa_rules;
  if (model.mode === 'request') {
    action = 'ops.save';
    const sourceType = SOURCE_TYPE[type];
    const sources = sourceType ? approved(w, sourceType).filter((r: Row) => type !== 'DN' || w.data.ops_jobs.some((j: Row) => j.id === r.id && ['DELIVERING', 'CLOSED'].includes(j.shipment_status))) : [];
    const source = w.data.ops_requests.find((r: Row) => r.id === d.source_id);
    let baseLines: Row[] = [], priceError = '';
    if (type === 'JOB' && source) { const q = w.data.ops_requests.find((r: Row) => r.id === source.source_id); try { baseLines = priceJob(q.payload, d.container_size, String(d.containers).split(/[\n,]/).filter(x => x.trim()).length || 1); } catch (e) { priceError = (e as Error).message; } }
    const reset = (t: string, s = '') => { setD(draftRequest(w, t, s)); setDirty(true); form.reset(); };
    const creatable = TYPE_ORDER.filter(t => w.can(resourceOf(t), 'create'));
    body = <>
      <FormSection title={uiText("Request and source")} description={sourceType ? uiText("A {p0} is created from an approved {p1}; the customer and account come from that source.", { p0: SHORT[type].toLowerCase(), p1: SHORT[sourceType].toLowerCase() }) : uiText("A customer quotation starts from a CRM contact.")}>
        <Picker label={uiText("Type of request")} required value={type} options={(d.id ? TYPE_ORDER : creatable).map(t => [t, REQUEST_TYPES[t]])} disabled={!!d.id} allowNone={false} onChange={t => reset(t || 'QUOTATION')} />
        {sourceType ? picker('source_id', `Approved ${SHORT[sourceType].toLowerCase()}`, sources.map((r: Row) => [r.id, `${r.id} · ${r.payload.customer_name}`]), { required: true, disabled: !!d.id, none: sources.length ? uiText("Select…") : uiText("No approved {p0} available", { p0: SHORT[sourceType].toLowerCase() }), hint: type === 'DN' ? uiText("Only Job Files at Delivering or Delivered (Closed) can be billed.") : undefined })
          : picker('contact_id', uiText("CRM customer"), w.data.contacts.filter((r: Row) => r.active).map((r: Row) => [r.id, `${r.customer_name} · ${r.id}`]), { required: true, disabled: !!d.id })}
        {source && <Alert tone="info" className="span-2" title={uiText("Customer: {p0}", { p0: source.payload.customer_name })}>{uiText("Linked from ")}{source.id} {uiText("(revision ")}{source.revision}{uiText("); that revision is preserved with this request.")}</Alert>}
        {field('document_date', uiText("Document date"), 'date', true, false, { hint: uiText("Cannot be in the future or earlier than the source document.") })}
      </FormSection>
      {type === 'QUOTATION' && <FormSection title={uiText("Quotation terms")}>
        {field('valid_until', uiText("Valid until"), 'date', true, false, { min: d.document_date, aliases: ["quotation valid until", "quotation validity"] })}
        {picker('commodity_type', uiText("Commodity type"), opts(['GARMENT', 'GENERAL', 'VEHICLE', 'OTHER']), { required: true, hint: d.commodity_type === 'GARMENT' ? uiText("Garment quotations need container-size-specific rates.") : undefined })}
        {field('commodity', uiText("Commodity details"), 'text', true)}{field('terms', uiText("Terms / service route"), 'text', true, false, { aliases: ["trade route terms"] })}
        {field('payment_terms', uiText("Payment terms"), 'text', false, true)}
        {picker('crm_quote_id', uiText("Import an approved CRM quotation"), w.data.quotations.filter((q: Row) => q.contact_id === d.contact_id && ['APPROVED', 'ACCEPTED', 'CONVERTED'].includes(q.status)).map((q: Row) => [q.id, `${q.id} · revision ${q.revision}`]), { disabled: !!d.id, none: uiText("None (enter rates below)"), wide: true, hint: uiText("Optional. Copies its lines as a starting rate card and keeps the quotation reference.") })}
      </FormSection>}
      {type === 'PO' && <FormSection title={uiText("Booking and service")}>
        <div className="span-2"><CheckboxField label={uiText("The customer has confirmed this booking")} description={uiText("Required before a Purchase Order can be issued.")} checked={!!d.booking_confirmed} onChange={v => set('booking_confirmed', v)} error={form.errors.booking_confirmed} /></div>
        {field('booking_date', uiText("Confirmation date"), 'date', true, false, { aliases: ["booking confirmation date"] })}{field('booking_reference', uiText("Confirmation reference / evidence"), 'text', true, false, { aliases: ["booking confirmation reference"] })}
        {field('consignee', uiText("Consignee"), 'text', true)}{field('customer_vat', uiText("Customer VAT / ID"))}
        {field('service_type', uiText("Service type"), 'text', true)}{field('terms', uiText("Terms / route"), 'text', true, false, { aliases: ["terms service route"] })}
        {field('quantity', uiText("Commodity quantity"), 'number', true)}{field('unit', uiText("Unit"), 'text', true)}
        {field('commodity', uiText("Commodity details"), 'textarea', true, true)}{field('scope_of_services', uiText("Scope of services"), 'textarea', true, true, { aliases: ["scope of services commodity details"] })}
        {field('conditions', uiText("Conditions"), 'textarea', false, true)}
        <Alert tone="info" className="span-2">{uiText("The three-working-day Job File deadline starts when the final approver issues this PO (Monday–Friday plus configured holidays).")}</Alert>
      </FormSection>}
      {type === 'JOB' && <>
        <FormSection title={uiText("Shipment")}>
          {picker('container_size', uiText("Container size"), opts(CONTAINER_SIZES), { required: true })}{field('bill_of_lading', uiText("Bill of Lading (B/L)"), 'text', true, false, { aliases: ["bill of lading"] })}
          {field('containers', uiText("Container numbers"), 'textarea', true, true, { hint: uiText("One per line (up to 200, each unique)."), aliases: ["container number"] })}
          {field('etd', 'ETD', 'date', true)}{field('eta', 'ETA', 'date', true, false, { min: d.etd })}
          {field('pol_pod', uiText("POL / POD"))}{field('delivery_place', uiText("Delivery place"))}
          {field('gross_weight', uiText("Gross weight"))}{field('volume', uiText("Volume"))}
          {field('shipment_type', uiText("Shipment type"), 'text', false, false, { placeholder: uiText("e.g. Official") })}{field('apply_co', uiText("Apply C/O"))}
        </FormSection>
        <FormSection title={uiText("References and notes")}>
          {field('client_invoice', uiText("Client invoice number"))}{field('tax_invoice', uiText("Tax invoice number"))}
          {field('partner_name', uiText("Partner name"))}{field('commission', uiText("Commission amount"), 'number')}
          {field('cut_seal_delivery', uiText("Cut seal / delivery"))}{field('source_from', uiText("Source from"))}
          {field('ops_notes', uiText("OPS department notes"), 'textarea', false, true)}{field('finance_notes', uiText("Accounting / Finance notes"), 'textarea', false, true)}
          {field('late_reason', uiText("Late issuance reason"), 'textarea', false, true, { hint: uiText("Required when the Job File is issued after the three-working-day deadline."), aliases: ["late job file reason"] })}
        </FormSection>
        <FormSection title={uiText("Prices from the approved quotation")} description={uiText("Calculated from the quotation rate card for the selected container size and count.")} columns={1}>
          {priceError ? <Alert tone="warning">{priceError}</Alert> : <ChargeLines lines={baseLines} type="JOB" currency={w.currency} />}
        </FormSection>
        <FormSection title={uiText("Extra Job File charges")} columns={1}><ChargeLines lines={d.extra_lines || []} type="JOB" currency={w.currency} rules={rules} onChange={v => set('extra_lines', v)} /></FormSection>
      </>}
      {type === 'DN' && <FormSection title={uiText("Billing")}>
        {field('due_date', uiText("AR due date"), 'date', true, false, { min: d.document_date })}
        <div className="span-2"><p className="text-label">{uiText("Charges copied from the approved Job File")}</p><ChargeLines lines={source?.payload.lines || []} type="DN" currency={w.currency} /></div>
        <Alert tone="info" className="span-2">{uiText("AR and the non-confirmed AP estimate are created only when the Debit Note receives final approval.")}</Alert>
      </FormSection>}
      {type === 'PR' && <FormSection title={uiText("Payee and bank details")}>
        {field('payee', uiText("Payee / supplier"), 'text', true)}{field('supplier_reference', uiText("Supplier invoice / bill reference"), 'text', true)}
        {field('requested_to', uiText("Requested to"))}{field('bank_name', uiText("Bank name"))}
        {field('account_name', uiText("Account name"))}{field('bank_account', uiText("Bank account number"))}
        <Alert tone="info" className="span-2">{uiText("The number is the linked Debit Note number plus A, B, C… Each approver receives an in-app alert when it is their step.")}</Alert>
      </FormSection>}
      {['QUOTATION', 'PR'].includes(type) && <FormSection title={type === 'QUOTATION' ? uiText("Customer pricing · container rate card") : uiText("Payment charges")} columns={1}>
        <ChargeLines lines={d.lines || []} type={type} currency={w.currency} rules={rules} onChange={v => set('lines', v)} error={form.errors.lines} />
      </FormSection>}
      <FormSection columns={1}>{field('notes', uiText("Notes"), 'textarea', false, true)}</FormSection>
    </>;
  } else if (model.mode === 'ops.process') {
    const text: Record<string, string> = { submit: 'Submit this saved revision to the company’s ordered approval chain. It is locked while under review.', approve: 'Approve the current revision for your step. The final approval issues the document and applies its financial effects.', return: 'Return this revision for changes. A revised draft must be submitted again.', reject: 'Reject this revision. A revised draft must be submitted again.' };
    body = <FormSection columns={1}><Alert tone={['return', 'reject'].includes(d.process) ? 'warning' : 'info'}>{text[d.process]}</Alert>{field('comment', ['return', 'reject'].includes(d.process) ? uiText("Reason") : uiText("Comment"), 'textarea', ['return', 'reject'].includes(d.process), true)}</FormSection>;
  } else if (model.mode === 'ops.shipment') {
    body = <FormSection columns={1}><Alert tone="info" title={uiText("Next stage: {p0}", { p0: SHIPMENT_STATUSES[d.status as keyof typeof SHIPMENT_STATUSES] })}>{uiText("Shipments move one stage at a time: In transit → Arrived at port → Delivering → Delivered (closed).")}</Alert>{d.status === 'CLOSED' && field('closed_date', uiText("Delivered / closed date"), 'date', true, false, { aliases: ["delivery closing date", "delivery date"] })}{field('comment', uiText("Shipment update note"), 'textarea', false, true, { aliases: ["shipment note"] })}</FormSection>;
  } else if (model.mode === 'ops.receipt' || model.mode === 'ops.af.verify') {
    body = <FormSection>
      {model.mode === 'ops.receipt' ? field('amount', uiText("Amount received"), 'number', true, false, { hint: uiText("Partial receipts are allowed up to the remaining AR."), aliases: ['receipt'] }) : <>
        <Alert tone="info" className="span-2">{uiText("A/F verification clears the remaining AR and marks the sale paid. The original Debit Note, earlier receipts and this verification stay in the audit history.")}</Alert>
        {picker('file_id', uiText("Supporting evidence"), w.data.ops_files.filter((f: Row) => f.request_id === d.id).map((f: Row) => [f.id, f.name]), { required: true, wide: true, none: w.data.ops_files.some((f: Row) => f.request_id === d.id) ? uiText("Select an uploaded file…") : uiText("Upload evidence on the Files tab first"), })}
      </>}
      {field('reference', uiText("Bank / verification reference"), 'text', true)}{field('settlement_date', uiText("Settlement date"), 'date', true)}
    </FormSection>;
  } else if (model.mode === 'ops.ap.confirm' || model.mode === 'ops.ap.pay') {
    body = <FormSection columns={1}><Alert tone="info">{model.mode === 'ops.ap.confirm' ? uiText("Confirm the approved Payment Request total as actual AP. The original Selling estimate stays visible for comparison.") : uiText("Record that the confirmed AP was paid. This records a payout reference only; no money is sent.")}</Alert>{field('reference', model.mode === 'ops.ap.confirm' ? uiText("Supplier bill reference") : uiText("Payout reference"), 'text', true)}</FormSection>;
  } else if (model.mode === 'ops.finance.close') {
    body = <FormSection columns={1}><Alert tone="warning" title={uiText("This locks the entry")}>{uiText("Finance verification saves a monthly snapshot and locks further costs for this Debit Note. AP must be confirmed, and the closing date must be in the same month as the Debit Note date.")}</Alert>{field('closing_date', uiText("Closing date"), 'date', true)}</FormSection>;
  } else {
    const staff = w.data.lookups.filter((r: Row) => r.kind === 'staff' && r.active);
    body = <>
      <FormSection title={uiText("Working calendar")} columns={1}>{field('holidays', uiText("Non-working holidays"), 'textarea', false, true, { hint: uiText("One date per line in YYYY-MM-DD format. Job File deadlines skip weekends and these dates."), aliases: ["holiday date"] })}</FormSection>
      <FormSection title={uiText("Finance operators")} description={uiText("Only these staff members can record receipts, confirm and pay AP, verify A/F and close months.")} columns={2}>
        {staff.map((r: Row) => <CheckboxField key={r.id} label={r.name} checked={d.finance_ids.includes(r.id)} onChange={v => set('finance_ids', v ? [...d.finance_ids, r.id] : d.finance_ids.filter((id: string) => id !== r.id))} />)}
      </FormSection>
      <FormSection title={uiText("Description → COA rules")} description={uiText("The first matching keyword wins. Unmatched sale lines use Selling; payment lines use Costing. VAT and discount entries are generated from each line.")} columns={1}>
        <div className="rule-list">
          {d.coa_rules.map((r: Row, i: number) => (
            <div className="rule-row" key={i}>
              <Input aria-label={uiText("Rule {p0} keyword", { p0: i + 1 })} placeholder={uiText("Keyword, e.g. duty")} value={r.contains} onChange={e => set('coa_rules', d.coa_rules.map((x: Row, j: number) => (j === i ? { ...x, contains: e.target.value } : x)))} />
              <ArrowRight className="rule-arrow" aria-hidden="true" />
              <Picker hideLabel label={uiText("Rule {p0} category", { p0: i + 1 })} value={r.category} options={opts([...COA_CATEGORIES, 'COSTING'])} allowNone={false} onChange={v => set('coa_rules', d.coa_rules.map((x: Row, j: number) => (j === i ? { ...x, category: v } : x)))} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={uiText("Remove rule {p0}", { p0: i + 1 })} title={uiText("Remove rule")} onClick={() => set('coa_rules', d.coa_rules.filter((_: Row, j: number) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => set('coa_rules', [...d.coa_rules, { contains: '', category: 'SELLING' }])}><Plus />{uiText("Add rule")}</Button>
        </div>
      </FormSection>
    </>;
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if (model.mode === 'request' && type === 'PO' && !d.booking_confirmed) { form.fail(uiText("Confirm the customer booking before issuing a Purchase Order.")); return; }
    if (model.mode === 'ops.settings' && !d.finance_ids.length) { form.fail(uiText("Assign at least one Finance operator.")); return; }
    setBusy(true); form.reset();
    try { const result = await w.perform(action, d); onSaved(result); onClose(); }
    catch (err) { form.fail((err as Error).message); }
    finally { setBusy(false); }
  };
  const submitLabel = model.mode === 'request' ? (d.id ? uiText("Save new revision") : uiText("Save draft")) : model.mode === 'ops.process' ? ({ submit: 'Submit for approval', approve: 'Approve', return: 'Return for changes', reject: 'Reject revision' } as Row)[d.process] : model.mode === 'ops.shipment' ? uiText("Update shipment") : model.mode === 'ops.finance.close' ? uiText("Verify and close") : model.mode === 'ops.settings' ? uiText("Save settings") : uiText("Save");
  const size = model.mode === 'request' ? 'dialog-xl' : model.mode === 'ops.settings' ? 'dialog-lg' : 'dialog-sm';
  return (
    <Dialog open onOpenChange={v => { if (!v) void close(); }}>
      <DialogContent className={size} onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); void close(); } }}>
        <DialogHeader><DialogTitle>{model.title}</DialogTitle><DialogDescription>{request ? uiText("{p0} · revision {p1} · {p2}", { p0: request.id, p1: request.revision, p2: statusLabel(request.status) }) : uiText("{p0} · fields marked * are required", { p0: w.data.company.name })}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title={uiText("This could not be saved")} live>{form.formError}</Alert>}
              {body}
            </div>
            <div className="dialog-footer">
              {model.mode === 'request' && <span className="footer-note">{uiText("Saved drafts can be reviewed before you submit them for approval.")}</span>}
              <Button type="button" variant="outline" onClick={() => void close()}>{uiText("Cancel")}</Button>
              <Button type="submit" loading={busy} variant={model.mode === 'ops.process' && d.process === 'reject' ? 'destructive' : 'default'}>{busy ? uiText("Saving…") : submitLabel}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ workspace (list + detail)
export function OperationsWorkspace(w: Workspace & { initialId?: string }) {
  useLanguage();
  const [modal, setModal] = useState<Modal | null>(null), [snapshot, setSnapshot] = useState<Row | null>(null), [uploading, setUploading] = useState(false);
  const config = w.data.ops_settings;
  const finance = config.finance_ids.includes(w.actor) && w.can('ops.finance');
  const create = (t = 'QUOTATION', source = '') => setModal({ mode: 'request', title: uiText("New {p0}", { p0: REQUEST_TYPES[t as RequestType].toLowerCase() }), draft: draftRequest(w, t, source) });
  const action = (mode: string, title: string, draft: Row) => setModal({ mode, title, draft });
  const next = (r: Row, verb: string) => action('ops.process', `${({ submit: 'Submit', approve: 'Approve', return: 'Return', reject: 'Reject' } as Row)[verb]} ${r.id}`, { id: r.id, expected_version: r.version, process: verb, comment: '' });
  const r = w.initialId ? w.data.ops_requests.find((x: Row) => x.id === w.initialId) : null;
  const editor = modal && <OperationsEditor key={`${modal.mode}:${modal.draft.id || 'new'}`} w={w} model={modal} onClose={() => setModal(null)} onSaved={result => { if (result.type === 'operations' && result.id) w.show('operations', result.id); }} />;
  const snapshotDialog = snapshot && (
    <Dialog open onOpenChange={v => { if (!v) setSnapshot(null); }}>
      <DialogContent className="dialog-lg"><DialogHeader><DialogTitle>{snapshot.request_id} {uiText("· saved revision ")}{snapshot.revision}</DialogTitle><DialogDescription>{uiText("Preserved customer, Business Account, source document and pricing for this revision.")}</DialogDescription></DialogHeader><div className="dialog-plain-body"><pre className="json-block">{JSON.stringify(snapshot, null, 2)}</pre></div></DialogContent>
    </Dialog>
  );
  const settingsButton = w.can('settings', 'update') && <Button variant="outline" disabled={!finance} title={finance ? undefined : uiText("Only assigned Finance operators can change these settings.")} onClick={() => action('ops.settings', uiText("Operations rules and calendar"), { expected_version: config.version, holidays: config.holidays.join('\n'), finance_ids: config.finance_ids, coa_rules: config.coa_rules })}><Settings2 />{uiText("Rules & calendar")}</Button>;
  const creatable = TYPE_ORDER.filter(t => w.can(resourceOf(t), 'create'));
  const createMenu = creatable.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button><Plus />{uiText("New request")}<ChevronDown /></Button></DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{uiText("Choose the document type")}</DropdownMenuLabel>
        {creatable.map((t, i) => <DropdownMenuItem key={t} onSelect={() => create(t)}><span className="menu-step">{i + 1}</span>{REQUEST_TYPES[t]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (r) {
    const upload = async (file: File) => {
      if (file.size > 5 * 1024 * 1024) { toast.error(uiText("Choose a file no larger than 5 MB.")); return; }
      setUploading(true);
      try { const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error(uiText("Unable to read the file."))); reader.readAsDataURL(file); }); await w.perform('ops.file.add', { id: r.id, name: file.name, base64 }); }
      catch (e) { toast.error((e as Error).message); }
      finally { setUploading(false); }
    };
    const viewSnapshot = async (revision: number) => { try { const res = await apiFetch(`/api/ops/revision?id=${encodeURIComponent(r.id)}&revision=${revision}`); const s = await res.json() as Row; if (!res.ok) throw new Error(s.error); setSnapshot(s); } catch (e) { toast.error((e as Error).message); } };
    return <><RequestDetail w={w} r={r} finance={finance} next={next} action={action} create={create} upload={upload} uploading={uploading} viewSnapshot={viewSnapshot} setModal={setModal} />{editor}{snapshotDialog}</>;
  }
  return <><RequestList w={w} action={action} create={create} settingsButton={settingsButton} createMenu={createMenu} />{editor}</>;
}

function RequestList({ w, create, settingsButton, createMenu }: { w: Workspace; action: (m: string, t: string, d: Row) => void; create: (t?: string, s?: string) => void; settingsButton: ReactNode; createMenu: ReactNode }) {
  useLanguage();
  const view = w.route.query.get('view') || 'all';
  const [f, setF] = useViewState('ops:filters', { query: '', type: '', status: '' });
  const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));
  const all: Row[] = w.data.ops_requests;
  const mine = (x: Row) => x.status === 'SUBMITTED' && nextApprover(x) === w.actor && w.can(resourceOf(x.type), 'approve');
  const notifications = w.data.ops_notifications.filter((n: Row) => n.actor_id === w.actor && !n.resolved_at);
  const deadlines = poDeadlines(w.data).filter((x: Row) => x.status !== 'ISSUED');
  const rows = all.filter(x => (view !== 'approvals' || mine(x)) && (!f.type || x.type === f.type) && (!f.status || x.status === f.status) && (!f.query || `${x.id} ${x.payload.customer_name} ${x.source_id || ''} ${x.contact_id}`.toLowerCase().includes(f.query.toLowerCase())));
  const chips = buildChips([
    { key: 'query', label: uiText("Search"), value: f.query, display: `“${f.query}”`, clear: () => set({ query: '' }) },
    { key: 'type', label: uiText("Type"), value: f.type, display: SHORT[f.type], clear: () => set({ type: '' }) },
    { key: 'status', label: uiText("Status"), value: f.status, display: statusLabel(f.status), clear: () => set({ status: '' }) },
  ]);
  const reset = () => setF({ query: '', type: '', status: '' });
  const cols: Column[] = [
    { key: 'id', header: uiText("Request"), minWidth: 200, cell: x => <span className="cell-stack"><span className="cell-title">{x.id}</span><small>{SHORT[x.type]} {uiText("· rev ")}{x.revision}</small></span> },
    { key: 'customer', header: uiText("Customer"), sortValue: x => x.payload.customer_name, cell: x => x.payload.customer_name },
    { key: 'source_id', header: uiText("Source"), cell: x => x.source_id ? <button type="button" className="text-link" onClick={() => w.show('operations', x.source_id)}>{x.source_id}</button> : x.crm_quote_id ? <span className="muted">{uiText("CRM ")}{x.crm_quote_id}</span> : null },
    { key: 'date', header: uiText("Document date"), sortValue: x => x.payload.document_date, cell: x => <DateText value={x.payload.document_date} /> },
    { key: 'total', header: uiText("Amount"), numeric: true, sortValue: x => x.type === 'QUOTATION' ? null : x.payload.total_cents, cell: x => x.type === 'QUOTATION' ? <span className="muted" title={uiText("Quotation prices are size alternatives, not one total")}>{uiText("Rate card")}</span> : <Money cents={x.payload.total_cents} currency={w.currency} /> },
    { key: 'status', header: uiText("Approval"), cell: x => <StatusBadge value={x.status} /> },
    { key: 'next', header: uiText("Waiting for"), sortValue: x => nextApprover(x) ? w.lookup(nextApprover(x)) : null, cell: x => nextApprover(x) ? (nextApprover(x) === w.actor ? <strong className="text-warning">{uiText("You")}</strong> : w.lookup(nextApprover(x))) : null },
    { key: 'updated_at', header: uiText("Updated"), cell: x => <DateText value={x.updated_at} /> },
  ];
  const tabs = [{ id: 'all', label: uiText("All requests"), href: '#/operations', count: all.length }, { id: 'approvals', label: uiText("My approvals"), href: '#/operations?view=approvals', count: all.filter(mine).length }, { id: 'deadlines', label: uiText("PO deadlines"), href: '#/operations?view=deadlines', count: deadlines.length }];
  return (
    <>
      <PageHeader crumbs={[{ label: uiText("Operations"), href: '#/operations' }, { label: tabs.find(t => t.id === view)?.label || uiText("All requests") }]} title={uiText("Operations")}
        description={uiText("Create, review and issue the five logistics documents in one approval process. Approved prices flow forward; only approved Debit Notes and Payment Requests affect finance.")}
        actions={<>{settingsButton}{createMenu}</>} />
      <ol className="doc-types" aria-label={uiText("Request types")}>
        {TYPE_ORDER.map((t, i) => {
          const count = all.filter(x => x.type === t).length, pending = all.filter(x => x.type === t && x.status === 'SUBMITTED').length;
          return (
            <li key={t}>
              <button type="button" className="doc-type" aria-pressed={f.type === t} onClick={() => set({ type: f.type === t ? '' : t })}>
                <span className="doc-type-step">{i + 1}</span>
                <span className="doc-type-body"><span className="doc-type-name">{REQUEST_TYPES[t]}</span><span className="doc-type-meta">{count} total{pending ? uiText(" · {p0} awaiting approval", { p0: pending }) : ''}</span></span>
              </button>
            </li>
          );
        })}
      </ol>
      {notifications.length > 0 && (
        <Alert tone="warning" icon={Bell} title={uiText("{p0} approval alert{p1} for you", { p0: notifications.length, p1: notifications.length === 1 ? '' : 's' })}>
          <ul className="alert-list">{notifications.map((n: Row) => (
            <li key={n.id}>
              <button type="button" className="text-link" onClick={() => w.show('operations', n.request_id)}>{n.message}</button>
              <span className="muted"> · {formatDateTime(n.created_at)}</span>
              {!n.read_at && <Button variant="link" size="xs" onClick={() => void w.perform('ops.notification.read', { id: n.id }).catch(e => toast.error(e.message))}><CheckCheck />{uiText("Mark read")}</Button>}
            </li>
          ))}</ul>
        </Alert>
      )}
      <SectionTabs label={uiText("Operations views")} items={tabs} active={view} className="mt-5" />
      {view === 'deadlines' ? (
        <Card title={uiText("Job File issue deadlines")} description={uiText("Each approved PO needs an approved Job File within three working days (Monday–Friday plus configured holidays).")} flush>
          <DataTable rows={deadlines} stateKey="ops-deadlines" onRowClick={x => w.show('operations', x.id)} rowClassName={x => (x.status === 'OVERDUE' ? 'row-attention' : undefined)} columns={[
            { key: 'id', header: uiText("Purchase order"), cell: x => <span className="cell-title">{x.id}</span> }, { key: 'customer', header: uiText("Customer") },
            { key: 'issued_date', header: uiText("PO issued"), cell: x => <DateText value={x.issued_date} /> }, { key: 'deadline', header: uiText("Job File due"), cell: x => <DateText value={x.deadline} /> },
            { key: 'draft_jobs', header: uiText("Unapproved Job Files"), numeric: true }, { key: 'status', header: uiText("Status"), cell: x => <StatusBadge value={x.status} /> },
            { key: 'act', header: <span className="sr-only">{uiText("Action")}</span>, sortable: false, align: 'right', cell: x => w.can('ops.job', 'create') ? <Button size="xs" variant="outline" onClick={() => create('JOB', x.id)}>{uiText("Create Job File")}</Button> : null },
          ]} empty={<EmptyState title={uiText("No open deadlines")} description={uiText("Every approved PO has an issued Job File.")} />} />
        </Card>
      ) : (
        <>
          <FilterBar
            search={<SearchInput value={f.query} onChange={v => set({ query: v })} label={uiText("Search operations")} placeholder={uiText("Search number, customer or source…")} />}
            filters={<>
              <FilterSelect label={uiText("Type")} value={f.type} onChange={v => set({ type: v })} options={TYPE_ORDER.map(t => [t, SHORT[t]])} />
              <FilterSelect label={uiText("Status")} value={f.status} onChange={v => set({ status: v })} options={opts(['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED', 'REJECTED'])} />
            </>}
            chips={chips} onReset={reset} summary={(() => { const n = view === 'approvals' ? all.filter(mine).length : all.length; return <><strong>{rows.length}</strong> {uiText("of ")}{n} {plural(n, 'request')}</>; })()}
          />
          <Card flush>
            <DataTable columns={cols} rows={rows} stateKey={`ops-${view}`} resetKey={JSON.stringify(f) + view} onRowClick={x => w.show('operations', x.id)} rowLabel={x => `Open ${x.id}`}
              defaultSort={{ key: 'updated_at', dir: 'desc' }} rowClassName={x => (mine(x) ? 'row-mine' : undefined)} filtered={chips.length > 0} onClearFilters={reset} itemName="requests"
              empty={view === 'approvals' ? <EmptyState title={uiText("Nothing awaiting your approval")} description={uiText("Requests appear here when it is your step in the approval chain.")} /> : <EmptyState title={uiText("No requests yet")} description={uiText("Start with a customer quotation. Each approved document unlocks the next one.")} action={w.can('ops.quotation', 'create') && <Button size="sm" onClick={() => create('QUOTATION')}><Plus />{uiText("New quotation")}</Button>} />} />
          </Card>
        </>
      )}
      <details className="disclosure mt-5">
        <summary>{uiText("About this workflow")}<span className="summary-meta">{uiText("Rules used by this local version")}</span></summary>
        <div className="disclosure-body"><ul className="rule-notes">
          <li>{uiText("PO is the approved source order; JO is the Job File number. A job contains containers of a single size.")}</li>
          <li>{uiText("Debit Notes require a Job File at Delivering or Delivered (Closed); one Debit Note per Job File.")}</li>
          <li>{uiText("Job File deadlines count Monday–Friday plus configured holidays. Late issuance needs a reason and is flagged.")}</li>
          <li>{uiText("Monthly closing uses the Debit Note’s document month. AR/AP stages remain provisional.")}</li>
        </ul></div>
      </details>
      {w.data.orders.length > 0 && w.can('ops.legacy') && (
        <Card title={uiText("Earlier sales handoffs")} description={uiText("Sales orders from the earlier CRM handoff flow (order → delivery → invoice → payment).")} flush className="mt-5">
          <DataTable rows={w.data.orders} stateKey="ops-legacy" pageSize={10} onRowClick={x => w.show('order', x.id)} columns={[
            { key: 'id', header: uiText("Sales order"), cell: x => <span className="cell-title">{x.id}</span> },
            { key: 'account_id', header: uiText("Customer"), sortValue: x => w.data.accounts.find((a: Row) => a.id === x.account_id)?.name, cell: x => w.data.accounts.find((a: Row) => a.id === x.account_id)?.name || x.account_id },
            { key: 'total_cents', header: uiText("Total"), numeric: true, cell: x => <Money cents={x.total_cents} currency={w.currency} /> },
            { key: 'status', header: uiText("Status"), cell: x => <StatusBadge value={x.status} /> },
            { key: 'created_at', header: uiText("Created"), cell: x => <DateText value={x.created_at} /> },
          ]} />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- request detail
function chainOf(w: Workspace, r: Row) {
  const byId = new Map(w.data.ops_requests.map((x: Row) => [x.id, x]));
  const ancestors: Row[] = []; let cur = r; const seen = new Set<string>();
  while (cur?.source_id && !seen.has(cur.source_id)) { seen.add(cur.source_id); const s = byId.get(cur.source_id) as Row | undefined; if (!s) break; ancestors.unshift(s); cur = s; }
  const descendants: Row[] = []; const queue = [r.id];
  while (queue.length) { const id = queue.shift(); for (const c of w.data.ops_requests.filter((x: Row) => x.source_id === id)) { descendants.push(c); queue.push(c.id); } }
  return [...ancestors, r, ...descendants];
}

function RequestDetail({ w, r, finance, next, action, create, upload, uploading, viewSnapshot }: {
  w: Workspace; r: Row; finance: boolean; next: (r: Row, verb: string) => void; action: (m: string, t: string, d: Row) => void; create: (t?: string, s?: string) => void;
  upload: (f: File) => Promise<void>; uploading: boolean; viewSnapshot: (rev: number) => Promise<void>; setModal: (m: Modal | null) => void;
}) {
  useLanguage();
  const p = r.payload, chain: string[] = JSON.parse(r.approval_chain), res = resourceOf(r.type);
  const canApprove = r.status === 'SUBMITTED' && chain[r.approval_step - 1] === w.actor && w.can(res, 'approve');
  const job = w.data.ops_jobs.find((j: Row) => j.id === r.id), dn = performanceRows(w.data).find((x: Row) => x.id === r.id), ap = w.data.ops_ap.find((a: Row) => a.dn_id === r.id), closing = w.data.ops_closings.find((c: Row) => c.dn_id === r.id);
  const children = w.data.ops_requests.filter((s: Row) => s.source_id === r.id);
  const files = w.data.ops_files.filter((f: Row) => f.request_id === r.id);
  const flow = chainOf(w, r);
  const details: Record<string, string> = { document_date: 'Document date', valid_until: 'Valid until', terms: 'Terms / service route', payment_terms: 'Payment terms', commodity_type: 'Commodity type', commodity: 'Commodity details', consignee: 'Consignee', booking_reference: 'Booking reference', booking_date: 'Booking date', customer_vat: 'Customer VAT / ID', service_type: 'Service type', scope_of_services: 'Scope of services', conditions: 'Conditions', quantity: 'Commodity quantity', unit: 'Unit', bill_of_lading: 'Bill of Lading', container_size: 'Container size', containers: 'Container numbers', eta: 'ETA', etd: 'ETD', apply_co: 'Apply C/O', gross_weight: 'Gross weight', pol_pod: 'POL / POD', client_invoice: 'Client invoice', shipment_type: 'Shipment type', partner_name: 'Partner', commission_cents: 'Commission', volume: 'Volume', delivery_place: 'Delivery place', cut_seal_delivery: 'Cut seal / delivery', source_from: 'Source from', tax_invoice: 'Tax invoice', deadline: 'Job issue deadline', late_reason: 'Late issue reason', ops_notes: 'OPS department notes', finance_notes: 'Accounting / Finance notes', payee: 'Payee / supplier', requested_to: 'Requested to', supplier_reference: 'Supplier reference', bank_name: 'Bank name', account_name: 'Account name', bank_account: 'Bank account', due_date: 'AR due date', notes: 'Notes' };
  const dateKeys = ['document_date', 'valid_until', 'booking_date', 'eta', 'etd', 'deadline', 'due_date'];
  const actions: ReactNode[] = [];
  if (w.can(res, 'export')) actions.push(<ButtonLink key="print" href={apiPath(`/api/ops/document.print?id=${encodeURIComponent(r.id)}`)} target="_blank" rel="noopener"><Printer />{uiText("Print / PDF")}</ButtonLink>);
  if (w.can(res, 'update') && ['DRAFT', 'RETURNED', 'REJECTED'].includes(r.status)) actions.push(<Button key="edit" variant="outline" onClick={() => action('request', `Revise ${r.id}`, draftRequest(w, r.type, '', r))}><Pencil />{uiText("Edit · new revision")}</Button>);
  if (w.can(res, 'update') && r.status === 'DRAFT') actions.push(<Button key="submit" onClick={() => next(r, 'submit')}><Send />{uiText("Submit for approval")}</Button>);
  if (canApprove) actions.push(<Button key="return" variant="outline" onClick={() => next(r, 'return')}><Undo2 />{uiText("Return")}</Button>, <Button key="reject" variant="danger-outline" onClick={() => next(r, 'reject')}><XCircle />{uiText("Reject")}</Button>, <Button key="approve" onClick={() => next(r, 'approve')}><CheckCircle2 />{uiText("Approve step ")}{r.approval_step}</Button>);
  const nextDoc = r.status === 'APPROVED' && (
    r.type === 'QUOTATION' && w.can('ops.po', 'create') ? <Button onClick={() => create('PO', r.id)}>{uiText("Create purchase order")}<ArrowRight /></Button>
    : r.type === 'PO' && w.can('ops.job', 'create') ? <Button onClick={() => create('JOB', r.id)}>{uiText("Create job file")}<ArrowRight /></Button>
    : r.type === 'JOB' && w.can('ops.dn', 'create') && job && ['DELIVERING', 'CLOSED'].includes(job.shipment_status) && !children.some((c: Row) => c.type === 'DN') ? <Button onClick={() => create('DN', r.id)}>{uiText("Issue debit note")}<ArrowRight /></Button>
    : r.type === 'DN' && w.can('ops.pr', 'create') && !closing && ap?.stage !== 'PAID' ? <Button onClick={() => create('PR', r.id)}>{uiText("Create payment request")}<ArrowRight /></Button> : null);
  const shipmentKeys = Object.keys(SHIPMENT_STATUSES);
  return (
    <>
      <PageHeader crumbs={[{ label: uiText("Operations"), href: '#/operations' }, { label: SHORT[r.type] + 's', href: '#/operations' }, { label: r.id }]}
        title={uiText("{p0} {p1}", { p0: REQUEST_TYPES[r.type as RequestType], p1: r.id })} badge={<StatusBadge value={r.status} />}
        meta={<>
          <span className="meta-item"><button type="button" className="text-link" onClick={() => w.show('contact', r.contact_id)}>{p.customer_name}</button></span>
          <span className="meta-item">{uiText("Revision ")}<strong>{r.revision}</strong></span>
          <span className="meta-item">{uiText("Document date ")}<strong>{formatDate(p.document_date)}</strong></span>
          {r.issued_date && <span className="meta-item">{uiText("Issued ")}<strong>{formatDate(r.issued_date)}</strong></span>}
          <span className="meta-item">{uiText("Created by ")}<strong>{w.lookup(r.created_by)}</strong></span>
        </>}
        actions={actions.length ? actions : undefined} />
      <Card className="doc-flow-card" title={uiText("Document flow")} description={uiText("The approved chain this request belongs to. Select a document to open it.")}>
        <ol className="doc-flow">
          {TYPE_ORDER.map(t => {
            const docs = flow.filter(x => x.type === t);
            return (
              <li key={t} className={`doc-flow-step${docs.some(x => x.id === r.id) ? " is-current" : ''}${docs.length ? " has-docs" : ''}`}>
                <span className="doc-flow-type">{SHORT[t]}</span>
                {docs.length ? docs.map(x => x.id === r.id ? <span key={x.id} className="doc-flow-doc is-self" aria-current="page"><strong>{x.id}</strong><StatusBadge value={x.status} /></span> : <a key={x.id} className="doc-flow-doc" href={`#/operations/${encodeURIComponent(x.id)}`}><strong>{x.id}</strong><StatusBadge value={x.status} /></a>) : <span className="doc-flow-empty">{uiText("Not created")}</span>}
              </li>
            );
          })}
        </ol>
        <div className="related-links mt-4">
          <button type="button" className="related-link" onClick={() => w.show('contact', r.contact_id)}>{uiText("Contact ")}<small>{r.contact_id}</small></button>
          {r.account_id && <button type="button" className="related-link" onClick={() => w.show('account', r.account_id)}>{uiText("Business Account ")}<small>{r.account_id}</small></button>}
          {r.crm_quote_id && <button type="button" className="related-link" onClick={() => w.show('quotation', r.crm_quote_id)}>{uiText("CRM quotation ")}<small>{r.crm_quote_id}</small></button>}
        </div>
      </Card>
      {r.status === 'SUBMITTED' && <Alert tone="warning" className="mt-5" title={uiText("Waiting for step {p0} of {p1}: {p2}", { p0: r.approval_step, p1: chain.length, p2: w.lookup(chain[r.approval_step - 1]) })}>{canApprove ? uiText("You are the assigned approver. Review the document and charges, then approve, return or reject it.") : uiText("The assigned approver must sign in with Approve permission to continue.")}</Alert>}
      {r.status === 'APPROVED' && <Alert tone="success" className="mt-5" title={uiText("Approved and issued {p0}", { p0: formatDate(r.issued_date) })} action={nextDoc || undefined}>{nextDoc ? uiText("The next document in the flow can now be created from this one.") : r.type === 'JOB' && job && !['DELIVERING', 'CLOSED'].includes(job.shipment_status) ? uiText("Move the shipment to Delivering or Delivered (Closed) to issue its Debit Note.") : uiText("This document is complete.")}</Alert>}
      {['RETURNED', 'REJECTED'].includes(r.status) && <Alert tone="warning" className="mt-5" title={r.status === 'RETURNED' ? uiText("Returned for changes") : uiText("Rejected")}>{w.data.ops_approvals.filter((a: Row) => a.request_id === r.id).slice(-1)[0]?.comment || uiText("Save a new revision and submit it again.")}</Alert>}
      <div className="two-col mt-5">
        <div className="stack">
          {job && <Card title={uiText("Shipment progress")} actions={w.can('ops.job', 'update') && job.shipment_status !== 'CLOSED' && <Button size="sm" onClick={() => action('ops.shipment', uiText("Update shipment"), { id: r.id, expected_version: job.version, status: shipmentKeys[shipmentKeys.indexOf(job.shipment_status) + 1], closed_date: today(), comment: '' })}><Truck />{uiText("Move to ")}{SHIPMENT_STATUSES[shipmentKeys[shipmentKeys.indexOf(job.shipment_status) + 1] as keyof typeof SHIPMENT_STATUSES]}</Button>}>
            <Stepper label={uiText("Shipment stages")} steps={shipmentKeys.map((k, i) => ({ label: SHIPMENT_STATUSES[k as keyof typeof SHIPMENT_STATUSES], state: i < shipmentKeys.indexOf(job.shipment_status) || job.shipment_status === 'CLOSED' ? 'done' : i === shipmentKeys.indexOf(job.shipment_status) ? 'current' : 'upcoming', description: k === 'CLOSED' && job.closed_date ? formatDate(job.closed_date) : undefined }))} />
            <KeyValues columns={3} dense items={[[uiText("Purchase order"), <a href={`#/operations/${encodeURIComponent(job.po_id)}`}>{job.po_id}</a>], [uiText("Job File due"), <DateText value={job.deadline} />], [uiText("Issued"), <span className={job.issued_date > job.deadline ? 'text-danger' : undefined}><DateText value={job.issued_date} />{job.issued_date > job.deadline ? uiText(" · late") : ''}</span>]]} />
            {job.issued_date > job.deadline && <Alert tone="warning" title={uiText("Issued after the deadline")}>{job.late_reason}</Alert>}
          </Card>}
          {dn && ap && <Card title={uiText("Receivable, payable and margin")} actions={closing ? <StatusBadge value="FINANCE_VERIFIED" /> : <StatusBadge value={dn.status} />}>
            <div className="stat-grid finance-tiles">
              <StatCard label={uiText("Original AR")} value={money(dn.total_cents, w.currency)} caption={uiText("Debit Note total")} />
              <StatCard label={uiText("Remaining AR")} value={money(dn.ar_cents, w.currency)} caption={dn.ar_cents > 0 ? uiText("Due {p0}{p1}", { p0: formatDate(dn.due_date), p1: dn.aging_days ? ` · ${dn.aging_days} days overdue` : '' }) : uiText("Fully settled")} tone={dn.aging_days ? 'danger' : undefined} />
              <StatCard label={uiText("AP estimate")} value={money(ap.estimate_cents, w.currency)} caption={uiText("Selling, set at approval")} />
              <StatCard label={uiText("Current AP")} value={money(dn.ap_cents, w.currency)} caption={statusLabel(ap.stage)} />
              <StatCard label={uiText("Selling")} value={money(dn.selling_cents, w.currency)} caption={uiText("After discounts")} />
              <StatCard label={uiText("Costing")} value={money(dn.costing_cents, w.currency)} caption={uiText("Approved payment requests")} />
              <StatCard label={uiText("Cash disbursement")} value={money(dn.cash_disbursement_cents, w.currency)} caption={uiText("Recovered from customer")} />
              <StatCard label={uiText("Net")} value={money(dn.net_cents, w.currency)} caption={uiText("Margin {p0}", { p0: dn.margin })} />
            </div>
            <p className="inline-note mt-3">{uiText("Net = Selling − (Costing − Cash disbursement). A/F verified: ")}{dn.af_verified}{uiText(". This is a transaction register, not a general ledger.")}</p>
            <div className="finance-actions">
              {finance ? <>
                {w.can('ops.finance', 'update') && dn.ar_cents > 0 && <Button variant="outline" size="sm" onClick={() => action('ops.receipt', uiText("Record AR receipt"), { id: r.id, amount: '', settlement_date: today(), reference: '', request_key: uuid() })}>{uiText("Record receipt")}</Button>}
                {w.can('ops.finance', 'approve') && dn.af_verified === 'No' && <Button variant="outline" size="sm" onClick={() => action('ops.af.verify', uiText("A/F verification"), { id: r.id, settlement_date: today(), reference: '', file_id: '', request_key: uuid() })}>{uiText("Verify A/F · clear AR")}</Button>}
                {w.can('ops.finance', 'approve') && !closing && ap.stage === 'RECEIVED_UNCONFIRMED' && <Button variant="outline" size="sm" onClick={() => action('ops.ap.confirm', uiText("Confirm AP"), { id: r.id, expected_version: ap.version, reference: '' })}>{uiText("Confirm AP")}</Button>}
                {w.can('ops.finance', 'approve') && ap.stage === 'CONFIRMED' && <Button variant="outline" size="sm" onClick={() => action('ops.ap.pay', uiText("Record AP payout"), { id: r.id, expected_version: ap.version, reference: '' })}>{uiText("Record AP payout")}</Button>}
                {w.can('ops.finance', 'approve') && !closing && ['CONFIRMED', 'PAID'].includes(ap.stage) && <Button size="sm" onClick={() => action('ops.finance.close', uiText("Finance verification and monthly closing"), { id: r.id, closing_date: today() })}>{uiText("Verify and close month")}</Button>}
              </> : <p className="inline-note">{uiText("Finance actions are limited to assigned Finance operators: ")}{w.data.ops_settings.finance_ids.map(w.lookup).join(', ') || uiText("none assigned")}.</p>}
            </div>
            {closing && <Alert tone="success" title={uiText("Monthly snapshot saved · {p0}", { p0: formatDate(closing.closing_date) })}>{uiText("Approved costs for this Debit Note are now locked.")}</Alert>}
          </Card>}
          <Tabs defaultValue="details" key={r.id}>
            <TabsList className="tabs-line" aria-label={uiText("Request sections")}>
              <TabsTrigger value="details">{uiText("Document & charges")}</TabsTrigger>
              <TabsTrigger value="approvals">{uiText("Approvals & revisions")}</TabsTrigger>
              <TabsTrigger value="files">{uiText("Files")}<span className="tab-count">{files.length}</span></TabsTrigger>
              <TabsTrigger value="history">{uiText("History & postings")}</TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="stack">
              <Card title={uiText("Document details")}><KeyValues columns={2} items={Object.entries(details).filter(([k]) => !isMissing(p[k])).map(([k, label]) => [label, k.endsWith('_cents') ? <Money cents={p[k]} currency={w.currency} /> : dateKeys.includes(k) ? <DateText value={p[k]} /> : Array.isArray(p[k]) ? p[k].join(', ') : k === 'commodity_type' ? statusLabel(p[k]) : ['scope_of_services', 'conditions', 'ops_notes', 'finance_notes', 'notes', 'late_reason'].includes(k) ? <ExpandableText text={String(p[k])} lines={4} /> : String(p[k]), k])} /></Card>
              {p.lines && <Card title={r.type === 'QUOTATION' ? uiText("Rate card · size alternatives") : uiText("Charges")} description={r.type === 'QUOTATION' ? uiText("Container prices are alternatives; the Job File’s container size and count determine its total.") : undefined} flush>
                <ChargeLines lines={p.lines} type={r.type} currency={w.currency} />
                {r.type !== 'QUOTATION' && <dl className="line-totals card-inset"><div><dt>{uiText("Discount")}</dt><dd className="num">{money(p.discount_cents, w.currency)}</dd></div><div><dt>VAT</dt><dd className="num">{money(p.vat_cents, w.currency)}</dd></div><div className="grand"><dt>{uiText("Total")}</dt><dd className="num">{money(p.total_cents, w.currency)}</dd></div></dl>}
              </Card>}
            </TabsContent>
            <TabsContent value="approvals" className="stack">
              <Card title={uiText("Approval log")} flush><DataTable rows={w.data.ops_approvals.filter((a: Row) => a.request_id === r.id)} pageSize={0} columns={[{ key: 'revision', header: uiText("Rev."), numeric: true }, { key: 'step', header: uiText("Step"), numeric: true }, { key: 'action', header: uiText("Action"), cell: a => <StatusBadge value={a.action} /> }, { key: 'actor_id', header: uiText("Approver"), cell: a => w.lookup(a.actor_id) }, { key: 'comment', header: uiText("Comment"), wrap: true, minWidth: 140, cell: a => a.comment || null }, { key: 'created_at', header: uiText("When"), cell: a => <DateText value={a.created_at} withTime /> }]} empty={<EmptyState compact title={uiText("No approval actions yet")} />} /></Card>
              <Card title={uiText("Saved revisions")} description={uiText("Every save keeps an immutable copy of the customer, account, source and prices.")} flush><DataTable rows={w.data.ops_revisions.filter((v: Row) => v.request_id === r.id)} rowKey={v => String(v.revision)} pageSize={0} defaultSort={{ key: 'revision', dir: 'desc' }} columns={[{ key: 'revision', header: uiText("Revision"), numeric: true, cell: v => <span className="num">{uiText("Rev. ")}{v.revision}{v.revision === r.revision ? uiText(" · current") : ''}</span> }, { key: 'created_by', header: uiText("Saved by"), cell: v => w.lookup(v.created_by) }, { key: 'created_at', header: uiText("Saved"), cell: v => <DateText value={v.created_at} withTime /> }, { key: 'open', header: <span className="sr-only">{uiText("Actions")}</span>, sortable: false, align: 'right', cell: v => <div className="row-actions"><Button variant="ghost" size="xs" onClick={() => void viewSnapshot(v.revision)}><Eye />{uiText("View saved data")}</Button>{w.can(res, 'export') && <ButtonLink variant="ghost" size="xs" href={apiPath(`/api/ops/document.print?id=${encodeURIComponent(r.id)}&revision=${v.revision}`)} target="_blank" rel="noopener"><Printer />{uiText("Print")}</ButtonLink>}</div> }]} /></Card>
            </TabsContent>
            <TabsContent value="files">
              <Card title={uiText("Supporting files")} description={uiText("PDF, PNG, JPG, XLSX, DOCX, CSV or TXT, up to 5 MB each. Upload A/F evidence to the Debit Note before verification.")} actions={w.can(res, 'update') && <label className={`btn-upload${uploading ? " is-busy" : ''}`}><Upload aria-hidden="true" />{uploading ? uiText("Uploading…") : uiText("Upload file")}<input type="file" accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx,.csv,.txt" disabled={uploading} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ''; }} /></label>} flush>
                <DataTable rows={files} pageSize={0} columns={[{ key: 'name', header: uiText("File"), cell: f => w.can(res, 'export') ? <a className="text-link" href={apiPath(`/api/ops/file?id=${encodeURIComponent(f.id)}`)}><Download />{f.name}</a> : f.name }, { key: 'size', header: uiText("Size"), numeric: true, cell: f => <span className="num">{Math.max(1, Math.ceil(f.size / 1024)).toLocaleString('en-US')} KB</span> }, { key: 'uploaded_by', header: uiText("Uploaded by"), cell: f => w.lookup(f.uploaded_by) }, { key: 'created_at', header: uiText("Uploaded"), cell: f => <DateText value={f.created_at} withTime /> }]} empty={<EmptyState compact icon={FileText} title={uiText("No files yet")} description={uiText("Upload booking confirmations, bills or payment evidence here.")} />} />
              </Card>
            </TabsContent>
            <TabsContent value="history" className="stack">
              {['DN', 'PR'].includes(r.type) && w.can('ops.finance') && <Card title={uiText("Approved COA posting register")} flush><DataTable rows={w.data.ops_postings.filter((x: Row) => x.request_id === r.id || (r.type === 'DN' && x.dn_id === r.id))} pageSize={25} stateKey="ops-postings" columns={[{ key: 'request_id', header: uiText("Document"), cell: x => <a href={`#/operations/${encodeURIComponent(x.request_id)}`}>{x.request_id}</a> }, { key: 'category', header: uiText("Category"), cell: x => <Tag>{statusLabel(x.category)}</Tag> }, { key: 'description', header: uiText("Description"), wrap: true }, { key: 'amount_cents', header: uiText("Amount"), numeric: true, cell: x => <Money cents={x.amount_cents} currency={w.currency} /> }]} empty={<EmptyState compact title={uiText("No postings yet")} description={uiText("Postings are created on final approval.")} />} /></Card>}
              {r.type === 'DN' && w.can('ops.finance') && <Card title={uiText("AR receipts and A/F verification")} flush><DataTable rows={w.data.ops_settlements.filter((x: Row) => x.dn_id === r.id)} pageSize={0} columns={[{ key: 'type', header: uiText("Type"), cell: x => <StatusBadge value={x.type} /> }, { key: 'settlement_date', header: uiText("Date"), cell: x => <DateText value={x.settlement_date} /> }, { key: 'amount_cents', header: uiText("AR cleared"), numeric: true, cell: x => <Money cents={x.amount_cents} currency={w.currency} /> }, { key: 'reference', header: uiText("Reference") }, { key: 'actor_id', header: uiText("Finance"), cell: x => w.lookup(x.actor_id) }]} empty={<EmptyState compact title={uiText("No receipts yet")} />} /></Card>}
              <Card title={uiText("Audit history")} flush><DataTable rows={w.data.ops_events.filter((e: Row) => e.entity_id === r.id)} pageSize={25} stateKey="ops-history" columns={[{ key: 'action', header: uiText("Action"), cell: e => <span className="cell-title">{e.action}</span> }, { key: 'detail', header: uiText("Details"), wrap: true, cell: e => e.detail || null }, { key: 'actor_id', header: uiText("By"), cell: e => w.lookup(e.actor_id) }, { key: 'created_at', header: uiText("When"), cell: e => <DateText value={e.created_at} withTime /> }]} defaultSort={{ key: 'created_at', dir: 'desc' }} empty={<EmptyState compact title={uiText("No history yet")} />} /></Card>
            </TabsContent>
          </Tabs>
        </div>
        <aside className="stack" aria-label={uiText("Approval chain")}>
          <Card title={uiText("Approval chain")} description={chain.length ? uiText("{p0} step{p1}, in order", { p0: chain.length, p1: chain.length === 1 ? '' : 's' }) : uiText("Set when the request is submitted")}>
            {chain.length ? <Stepper orientation="vertical" label={uiText("Approval steps")} steps={chain.map((id, i) => ({ label: w.lookup(id), description: r.status === 'APPROVED' || i < r.approval_step - 1 ? uiText("Approved") : r.status === 'SUBMITTED' && i === r.approval_step - 1 ? (id === w.actor ? uiText("Waiting for you") : uiText("Awaiting approval")) : uiText("Not reached"), state: r.status === 'APPROVED' || (r.status === 'SUBMITTED' && i < r.approval_step - 1) ? 'done' : r.status === 'SUBMITTED' && i === r.approval_step - 1 ? 'current' : 'upcoming' }))} />
              : <p className="muted small">{uiText("Configured approvers: ")}{w.data.approval_steps.map((s: Row) => w.lookup(s.approver_id)).join(' → ') || 'none'}.</p>}
          </Card>
          <Card title={uiText("Summary")}><KeyValues dense items={[[uiText("Type"), REQUEST_TYPES[r.type as RequestType]], [uiText("Customer"), p.customer_name], [uiText("Contact"), p.customer_contact || null], [uiText("Amount"), r.type === 'QUOTATION' ? uiText("Rate card (alternatives)") : <Money cents={p.total_cents} currency={w.currency} emphasize />], [uiText("Updated"), <DateText value={r.updated_at} withTime />]]} /></Card>
        </aside>
      </div>
    </>
  );
}

// ================================================================ operations reports
export function OperationsReports(w: Workspace) {
  useLanguage();
  const [f, setF] = useViewState<Row>('reports:ops', { report: 'jobs' });
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }));
  const params = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v))).toString();
  const { report, error, loading } = useServerReport('/api/ops/report?' + params, w.data);
  const needs = ['jobs', 'closed'].includes(f.report) ? ['ops.job', 'ops.finance'] : ['ops.finance'];
  if (!needs.every(r => w.can(r))) return <NoAccess compact description={uiText("This report needs View access to Operations · Job File and Finance registers.")} />;
  const range: DateRange = { from: f.from || '', to: f.to || '', preset: f.from || f.to ? 'custom' : 'all' };
  const statusOptions: [string, string][] = ['jobs', 'closed'].includes(f.report) ? translatedEntries(SHIPMENT_STATUSES) : f.report === 'sales' ? [['PAID', uiText("Paid")], ['UNPAID', uiText("Unpaid")]] : [];
  const chips = [
    ...(f.from || f.to ? [{ key: 'range', label: uiText("Period: {p0}", { p0: formatRange(f.from, f.to) }), onRemove: () => setF(s => ({ ...s, from: '', to: '' })) }] : []),
    ...(f.month ? [{ key: 'month', label: uiText("Month: {p0}", { p0: formatMonth(f.month) }), onRemove: () => set('month', '') }] : []),
    ...(f.customer ? [{ key: 'customer', label: uiText("Customer: “{p0}”", { p0: f.customer }), onRemove: () => set('customer', '') }] : []),
    ...(f.status ? [{ key: 'status', label: uiText("Status: {p0}", { p0: statusOptions.find(([v]) => v === f.status)?.[1] || f.status }), onRemove: () => set('status', '') }] : []),
    ...(f.ap_stage ? [{ key: 'ap', label: uiText("AP stage: {p0}", { p0: statusLabel(f.ap_stage) }), onRemove: () => set('ap_stage', '') }] : []),
  ];
  const moneyTotals = Object.entries(report.totals || {}).filter(([k]) => ['total_cents', 'ar_cents', 'ap_cents', 'selling_cents', 'costing_cents', 'net_cents'].includes(k));
  const cols: Column[] = (report.columns || []).map(([key, label]: string[]) => ({ key, header: label, numeric: key.endsWith('_cents') || ['container_count', 'aging_days'].includes(key), wrap: ['containers', 'commodity', 'files'].includes(key),
    cell: (row: Row) => key.endsWith('_cents') ? <Money cents={row[key]} currency={w.currency} /> : ['id', 'job_id', 'po_id', 'dn_id'].includes(key) && row[key] ? <a href={`#/operations/${encodeURIComponent(row[key])}`}>{row[key]}</a> : ['status', 'shipment', 'ap_stage', 'af_verified', 'finance_verified', 'late'].includes(key) && row[key] ? <StatusBadge value={key === 'shipment' ? row.shipment_status : row[key]} label={key === 'shipment' ? row[key] : undefined} /> : /date$|^eta$|^etd$|^date$/.test(key) ? <DateText value={row[key]} /> : isMissing(row[key]) ? null : String(row[key]) }));
  const footer = Object.fromEntries([[cols[0]?.key, uiText("Total")], ...Object.entries(report.totals || {}).map(([k, v]) => [k, <Money cents={v} currency={w.currency} emphasize />])]);
  const note = f.report === 'monthly' ? uiText("Monthly rows are saved snapshots of finance-verified entries with confirmed AP and a closing date in the Debit Note month. They also remain traceable in Daily Performance.") : f.report === 'statements' ? uiText("Provisional: AP starts as a Selling estimate, becomes received/unconfirmed when approved Payment Requests arrive, then needs Finance confirmation before payout. The current AP replaces the estimate — they are never added together.") : f.report === 'sales' ? uiText("AR aging shows days past the due date. A/F verification requires an uploaded file and a Finance reference, and clears the remaining AR.") : uiText("Net = Selling − (Costing − Cash disbursement). Selling and costing are after line discounts; separately classified tax and VAT are shown separately.");
  const canExport = w.can('reports.operations', 'export') && needs.every(r => w.can(r, 'export'));
  return (
    <>
      <FilterBar
        search={<Picker hideLabel label={uiText("Report")} value={f.report} onChange={v => setF({ report: v || 'jobs' })} allowNone={false} options={Object.entries(OPS_REPORTS)} className="report-picker" />}
        filters={<>
          <DateRangeFilter label={f.report === 'closed' ? uiText("Closed") : f.report === 'jobs' ? uiText("Issued") : f.report === 'monthly' ? uiText("Closing date") : uiText("DN date")} value={range} onChange={r => setF(s => ({ ...s, from: r.from, to: r.to }))} />
          <label className="filter-month"><span className="filter-select-label">{uiText("Month")}</span><input type="month" className="control" value={f.month || ''} onChange={e => set('month', e.target.value)} aria-label={uiText("Month")} /></label>
          <SearchInput value={f.customer || ''} onChange={v => set('customer', v)} label={uiText("Customer")} placeholder={uiText("Customer…")} className="filter-inline-search" />
          {statusOptions.length > 0 && <FilterSelect label={f.report === 'sales' ? uiText("Payment") : uiText("Shipment")} value={f.status || ''} onChange={v => set('status', v)} options={statusOptions} />}
          {['daily', 'statements'].includes(f.report) && <FilterSelect label={uiText("AP stage")} value={f.ap_stage || ''} onChange={v => set('ap_stage', v)} options={opts(['NOT_RECEIVED', 'RECEIVED_UNCONFIRMED', 'CONFIRMED', 'PAID'])} />}
        </>}
        actions={canExport && <><ButtonLink size="sm" href={apiPath(`/api/ops/report.csv?${params}`)}><Download />CSV</ButtonLink><ButtonLink size="sm" href={apiPath(`/api/ops/report.print?${params}`)} target="_blank" rel="noopener"><Printer />{uiText("Print / PDF")}</ButtonLink></>}
        chips={chips} onReset={() => setF({ report: f.report })} summary={<><strong>{report.rows.length}</strong> row{report.rows.length === 1 ? '' : 's'}</>}
      />
      {error ? <ErrorState message={error} /> : <>
        <div className="stat-grid stat-grid-fit">
          <StatCard label={uiText("Rows")} value={report.rows.length.toLocaleString('en-US')} caption={OPS_REPORTS[f.report as keyof typeof OPS_REPORTS]} />
          {moneyTotals.map(([k, v]) => <StatCard key={k} label={({ total_cents: 'DN total', ar_cents: 'Remaining AR', ap_cents: 'Remaining AP', selling_cents: 'Selling', costing_cents: 'Costing', net_cents: 'Net' } as Row)[k]} value={money(v, w.currency)} caption={uiText("{p0} · all rows", { p0: w.currency })} />)}
        </div>
        <Card title={report.title} description={note} flush className={`mt-5${loading ? " is-refreshing" : ''}`}>
          <DataTable dense columns={cols} rows={report.rows} stateKey={`rpt-ops-${f.report}`} resetKey={params} filtered={chips.length > 0} onClearFilters={() => setF({ report: f.report })} footerRow={report.rows.length && Object.keys(report.totals || {}).length ? footer : undefined} pageSize={50} itemName="rows"
            empty={<EmptyState compact title={uiText("No rows yet")} description={uiText("Approved documents appear in this report automatically.")} />} />
        </Card>
      </>}
    </>
  );
}


import { performanceRows, outstanding, workingDeadline, opsToday, SHIPMENT_STATUSES, REQUEST_TYPES, sum } from './operations-domain.mjs';
import { printPage } from './reports.mjs';

export const OPS_REPORTS = {jobs:'Job File Listing',closed:'Job File Report · Closed',sales:'Sale Report · OPS',daily:'Daily Performance Report',statements:'AR & AP Statement · Provisional',monthly:'Monthly Shipment Report'};
const moneyColumns=[['total_cents','DN total'],['selling_cents','Selling'],['ar_cents','AR']];
const jobColumns=[['customer','Customer'],['job_id','JO / Job File'],['jo_date','JO issue date'],['po_id','PO number'],['consignee','Consignee'],['bill_of_lading','B/L'],['containers','Containers'],['container_count','Total containers'],['eta','ETA'],['etd','ETD'],['commodity','Commodity'],['shipment','Shipment status'],...moneyColumns];
const validDay=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const t=Date.parse(`${v}T12:00:00Z`);return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function poDeadlines(s) {
 return s.ops_requests.filter(r=>r.type==='PO'&&r.status==='APPROVED').map(po=>{
  const jobs=s.ops_jobs.filter(j=>j.po_id===po.id),deadline=po.job_deadline||workingDeadline(po.issued_date,s.ops_settings.holidays);
  return {id:po.id,customer:po.payload.customer_name,issued_date:po.issued_date,deadline,jobs:jobs.length,status:jobs.length?'ISSUED':opsToday()>deadline?'OVERDUE':'DUE',draft_jobs:s.ops_requests.filter(r=>r.type==='JOB'&&r.source_id===po.id&&r.status!=='APPROVED').length};
 });
}
export function buildOpsReport(s,f={}) {
 const id=f.report||'jobs';if(!Object.hasOwn(OPS_REPORTS,id))throw Object.assign(new Error('Unknown Operations report.'),{status:400});
 for(const key of ['from','to'])if(f[key]&&!validDay(f[key]))throw Object.assign(new Error('Enter valid report dates.'),{status:400});
 if(f.from&&f.to&&f.from>f.to)throw Object.assign(new Error('The report end date must be on or after its start date.'),{status:400});
 if(f.month&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month))throw Object.assign(new Error('Enter a valid report month.'),{status:400});
 const financeRows=performanceRows(s),req=new Map(s.ops_requests.map(r=>[r.id,r]));
 let rows=[],columns=[];
 if(id==='jobs'||id==='closed') {
  rows=s.ops_jobs.filter(j=>id!=='closed'||j.shipment_status==='CLOSED').map(j=>{
   const r=req.get(j.id),p=r.payload,dn=financeRows.find(d=>d.job_id===j.id);
   return {id:j.id,group:'Approved Job Files',job_id:j.id,date:id==='closed'?j.closed_date:j.issued_date,jo_date:j.issued_date,closed_date:j.closed_date,
    customer:p.customer_name,contact_id:r.contact_id,po_id:j.po_id,consignee:p.consignee,bill_of_lading:p.bill_of_lading,containers:p.containers.join(', '),container_count:p.containers.length,
    eta:p.eta,etd:p.etd,commodity:p.commodity,commodity_type:p.commodity_type,shipment_status:j.shipment_status,shipment:SHIPMENT_STATUSES[j.shipment_status],
    selling_cents:dn?.selling_cents??sum(p.lines.filter(l=>l.category==='SELLING'),'net_cents'),ar_cents:dn?.ar_cents||0,total_cents:dn?.total_cents||0,dn_id:dn?.id||'',deadline:j.deadline,late:j.issued_date>j.deadline?'Yes':'No'};
  });
  columns=[...jobColumns,['dn_id','Debit Note'],['deadline','Issue deadline'],['late','Issued late'],...(id==='closed'?[['closed_date','Closed date']]:[])];
 } else if(id==='monthly') {
  rows=s.ops_closings.map(c=>({...JSON.parse(c.snapshot_json),date:c.closing_date,group:c.closing_date.slice(0,7)}));
  columns=[['customer','Customer'],['id','SN / DN number'],['dn_date','SN / DN date'],['closing_date','Closing date'],['commodity_type','Commodity type'],['commodity','Commodity'],['terms','Terms'],['containers','Containers'],['container_count','Container count'],['tax_cents','Tax'],['selling_cents','Selling'],['costing_cents','Costing'],['cash_disbursement_cents','Cash disbursement'],['net_cents','Net'],['margin','Profit margin']];
 } else {
  rows=financeRows;
  if(id==='sales')columns=[['customer','Customer'],['id','SN / DN number'],['date','DN date'],['bill_of_lading','B/L'],['containers','Containers'],['job_id','JO File'],['total_cents','Total'],['ar_cents','AR'],['due_date','Due date'],['aging_days','AR days overdue'],['status','Status'],['files','Uploaded files'],['af_verified','A/F verified']];
  if(id==='daily')columns=[['customer','Customer'],['id','SN / DN'],['date','DN date'],['selling_cents','Selling'],['discount_cents','Sale discount'],['tax_cents','Sale tax'],['vat_cents','Output VAT'],['cash_disbursement_cents','Cash disbursement'],['costing_cents','Costing'],['cost_discount_cents','Cost discount'],['cost_tax_cents','Cost tax'],['cost_vat_cents','Input VAT'],['net_cents','Net'],['ap_stage','AP stage'],['closing_date','Closing date'],['finance_verified','Finance verified']];
  if(id==='statements')columns=[['customer','Customer'],['id','DN'],['date','DN date'],['total_cents','Original AR'],['ar_cents','Remaining AR'],['aging_days','AR days overdue'],['ap_estimate_cents','Initial AP estimate'],['ap_cents','Remaining AP'],['ap_stage','AP stage']];
 }
 rows=rows.filter(r=>(!f.from||r.date>=f.from)&&(!f.to||r.date<=f.to)&&(!f.month||r.date?.slice(0,7)===f.month)&&(!f.customer||r.customer.toLowerCase().includes(f.customer.toLowerCase()))&&(!f.status||(id==='jobs'||id==='closed'?r.shipment_status:r.status)===f.status)&&(!f.ap_stage||r.ap_stage===f.ap_stage));
 rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))||a.id.localeCompare(b.id));
 /** @type {Record<string,number>} */
 const totals={};for(const [key] of columns)if(key.endsWith('_cents'))totals[key]=sum(rows,key);
 return {id,title:OPS_REPORTS[id],company:s.company.name,currency:s.company.currency,columns,rows,totals,groups:[],filters:f,generated_at:new Date().toISOString()};
}
const format=(r,k,currency)=>k.endsWith('_cents')?new Intl.NumberFormat('en-US',{style:'currency',currency}).format(Number(r[k]||0)/100):String(r[k]??'');
export function opsReportHTML(r) {
 const filters=Object.entries(r.filters).filter(([k,v])=>k!=='report'&&v).map(([k,v])=>`${k}: ${v}`).join(' · ');
 return printPage(r.title,`<p>${esc(r.company)} · LOCAL TEST</p><h1>${esc(r.title)}</h1><p>${esc(filters||'All approved records')} · ${r.rows.length} rows</p><table><thead><tr>${r.columns.map(([,l])=>`<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${r.rows.map(row=>`<tr>${r.columns.map(([k])=>`<td>${esc(format(row,k,r.currency))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${r.columns.length}">No matching records</td></tr>`}</tbody><tfoot><tr>${r.columns.map(([k],i)=>`<th>${i===0?'Total':k.endsWith('_cents')?esc(format(r.totals,k,r.currency)):''}</th>`).join('')}</tr></tfoot></table><p>Net = Selling − (Costing − Cash Disbursement). Selling and costing are after line discounts, excluding separate tax and VAT. AP estimates are replaced by approved costs; they are never added together.</p>`,true);
}
export function opsDocumentHTML(store,key,rev) {
 const r=store.operations.request(key),revision=rev?Number(rev):r.revision;
 const saved=store.get('SELECT * FROM ops_revisions WHERE request_id=? AND revision=?',key,revision);
 if(!saved)throw Object.assign(new Error('Revision not found.'),{status:404});
 const snap=JSON.parse(saved.snapshot_json),p=snap.payload,company=store.get('SELECT * FROM company WHERE id=1');
 const fmt=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:company.currency}).format(Number(n||0)/100);
 const fields={terms:'Terms / route',payment_terms:'Payment terms',valid_until:'Valid until',commodity_type:'Commodity type',commodity:'Commodity',source_id:'Source',booking_reference:'Booking confirmation',booking_date:'Booking confirmed on',consignee:'Consignee',customer_vat:'Customer VAT / ID',service_type:'Service type',scope_of_services:'Scope of services',quantity:'Commodity quantity',unit:'Unit',conditions:'Conditions',container_size:'Container size',containers:'Container numbers',bill_of_lading:'Bill of Lading',eta:'ETA',etd:'ETD',apply_co:'Apply C/O',gross_weight:'Gross weight',pol_pod:'POL / POD',client_invoice:'Client invoice',shipment_type:'Shipment type',partner_name:'Partner name',commission_cents:'Commission',volume:'Volume',delivery_place:'Delivery place',cut_seal_delivery:'Cut seal / delivery',source_from:'Source from',tax_invoice:'Tax invoice',ops_notes:'OPS department',finance_notes:'Accounting / Finance',due_date:'AR due date',requested_to:'Requested to',payee:'Payee / supplier',supplier_reference:'Supplier invoice reference',bank_name:'Bank name',account_name:'Account name',bank_account:'Bank account',late_reason:'Late Job File reason',notes:'Notes'};
 const approvals=store.all('SELECT a.*,l.name FROM ops_approvals a JOIN lookups l ON l.id=a.actor_id WHERE request_id=? AND revision=? ORDER BY a.id',key,revision);
 const header=`<p>${esc(company.name)} · LOCAL TEST DOCUMENT</p><h1>${esc(REQUEST_TYPES[r.type])}</h1><p><strong>${esc(key)}</strong> · Revision ${revision} · ${revision===r.revision?esc(r.status):'Historical revision'}<br>Document date ${esc(p.document_date)} · Issued ${esc(r.issued_date||'Not yet approved')}<br>Source ${esc(snap.source?.id||snap.crm_quote_id||'CRM customer')}</p><h2>${esc(p.customer_name)}</h2><p>${esc(p.customer_contact)}<br>${esc(p.customer_address)}<br>${esc(p.customer_phone)} · ${esc(p.customer_email)}</p>`;
 const details=`<table>${Object.entries(fields).filter(([k])=>p[k]!==undefined&&p[k]!==''&&p[k]!==null).map(([k,l])=>`<tr><th>${esc(l)}</th><td>${esc(k.endsWith('_cents')?fmt(p[k]):Array.isArray(p[k])?p[k].join(', '):p[k])}</td></tr>`).join('')}</table>`;
 const prices=p.lines?`<h2>${r.type==='QUOTATION'?'Rate card · size alternatives are priced separately':'Charges'}</h2><table><thead><tr>${['Description','Size / basis','Qty / unit','Price','Discount','VAT','Total','COA'].map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${p.lines.map(l=>`<tr><td>${esc(l.description)}</td><td>${esc(l.container_size)} / ${esc(l.rate_basis)}</td><td>${esc(l.quantity)} ${esc(l.unit)}</td><td>${esc(l.unit_price)}</td><td>${fmt(l.discount_cents)}</td><td>${fmt(l.vat_cents)}</td><td>${fmt(l.total_cents)}</td><td>${esc(l.category)}</td></tr>`).join('')}</tbody></table>${r.type==='QUOTATION'?'<p>Choose the applicable container size on the Job File. Rate alternatives are not one invoice total.</p>':`<p class="total">Total ${fmt(p.total_cents)}</p>`}`:'';
 return printPage(`${key} revision ${revision}`,header+details+prices+`<h2>Approval history</h2>${approvals.map(a=>`<p>Step ${a.step} · ${esc(a.action)} · ${esc(a.name)} · ${esc(a.created_at)}<br>${esc(a.comment)}</p>`).join('')||'<p>No approvals recorded.</p>'}<p>Prepared by: __________　Reviewed by: __________　Approved by: __________</p>`);
}

import { lineAmounts, scaled } from './money.mjs';

export const REQUEST_TYPES = { QUOTATION:'Customer Quotation', PO:'Purchase Order', JOB:'Job File', DN:'Debit Note', PR:'Payment Request' };
export const SHIPMENT_STATUSES = { IN_TRANSIT:'In Transit', ARRIVED_PORT:'Arrived Port', DELIVERING:'Delivering', CLOSED:'Delivered (Closed)' };
export const CONTAINER_SIZES = ['20FT','40FT','40HC','LCL'];
export const COA_CATEGORIES = ['SELLING','TAX','CASH_DISBURSEMENT'];
export const PAYMENT_CATEGORIES = ['COSTING','TAX'];
export const sum = (rows,key) => rows.reduce((n,r)=>n+Number(r[key]||0),0);
export const opsToday = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Phnom_Penh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function workingDeadline(start,holidays=[],days=3) {
 const date=new Date(`${start}T12:00:00Z`);let remaining=days;
 while(remaining){date.setUTCDate(date.getUTCDate()+1);const key=date.toISOString().slice(0,10);if(![0,6].includes(date.getUTCDay())&&!holidays.includes(key))remaining--;}
 return date.toISOString().slice(0,10);
}
export function paymentSuffix(n) {let out='';while(n>0){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;}
export function categoryFor(description,type,rules=[]) {
 const allowed=type==='PR'?PAYMENT_CATEGORIES:COA_CATEGORIES;
 return rules.find(r=>allowed.includes(r.category)&&description.toLowerCase().includes(r.contains.toLowerCase()))?.category||(type==='PR'?'COSTING':'SELLING');
}
export function priceJob(quote,containerSize,count) {
 const selected=(quote.lines||[]).filter(l=>l.container_size==='ALL'||l.container_size===containerSize);
 if(quote.commodity_type==='GARMENT'&&!selected.some(l=>l.container_size===containerSize))throw new Error(`No approved Garment rate for ${containerSize}. Revise the quotation before continuing.`);
 if(!selected.length)throw new Error('The approved quotation has no applicable prices for this container size.');
 return selected.map(l=>{
  const units=l.rate_basis==='CONTAINER'?count:1;
  const qty=BigInt(scaled(l.quantity,4))*BigInt(units);
  const quantity=`${qty/10000n}.${String(qty%10000n).padStart(4,'0')}`;
  // Fixed discounts are per quoted unit of the rate: scale with container count.
  const discount=(scaled(l.discount||'0')*units/100).toFixed(2);
  const row={...l,quantity,discount,source:'QUOTATION'};
  return {...row,...lineAmounts(row)};
 });
}
export function coaRows(lines,type) {
 return lines.flatMap((l,i)=>[
  {line_number:i+1,category:l.category,applies_to:l.category,description:l.description,amount_cents:l.amount_cents},
  ...(l.discount_cents?[{line_number:i+1,category:'DISCOUNT',applies_to:l.category,description:`Discount · ${l.description}`,amount_cents:-l.discount_cents}]:[]),
  ...(l.vat_cents?[{line_number:i+1,category:'VAT',applies_to:type==='PR'?'INPUT':'OUTPUT',description:`VAT · ${l.description}`,amount_cents:l.vat_cents}]:[])
 ]);
}
export function categoryTotal(postings,category) {
 return postings.reduce((n,p)=>n+(p.category===category||(p.category==='DISCOUNT'&&p.applies_to===category)?p.amount_cents:0),0);
}
export function outstanding(s,dnId) {
 const dn=s.ops_debit_notes.find(d=>d.id===dnId);
 return dn?dn.total_cents-sum(s.ops_settlements.filter(r=>r.dn_id===dnId),'amount_cents'):0;
}
export function performanceRows(s) {
 const req=new Map(s.ops_requests.map(r=>[r.id,r]));
 return s.ops_debit_notes.map(dn=>{
  const request=req.get(dn.id),job=req.get(dn.job_id)||{id:dn.job_id,payload:{containers:[]}},p=job.payload,po=req.get(job.source_id)||{};
  const sale=s.ops_postings.filter(e=>e.request_id===dn.id),cost=s.ops_postings.filter(e=>e.dn_id===dn.id&&e.request_id!==dn.id);
  const selling=categoryTotal(sale,'SELLING'),costing=categoryTotal(cost,'COSTING'),cash=categoryTotal(sale,'CASH_DISBURSEMENT');
  const net=selling-(costing-cash),ap=s.ops_ap.find(a=>a.dn_id===dn.id),closing=s.ops_closings.find(c=>c.dn_id===dn.id);
  return {id:dn.id,group:'Task Controlling Management',customer:request.payload.customer_name,contact_id:request.contact_id,account_id:request.account_id,
   date:request.payload.document_date,dn_date:request.payload.document_date,issued_date:dn.issued_date,job_id:job.id,jo_date:job.issued_date,po_id:po.id,consignee:p.consignee,
   bill_of_lading:p.bill_of_lading,containers:p.containers.join(', '),container_size:p.container_size,container_count:p.containers.length,
   commodity_type:p.commodity_type,commodity:p.commodity,terms:p.terms,etd:p.etd,eta:p.eta,
   total_cents:dn.total_cents,ar_cents:outstanding(s,dn.id),due_date:dn.due_date,
   aging_days:outstanding(s,dn.id)>0?Math.max(0,Math.floor((Date.parse(opsToday())-Date.parse(dn.due_date))/86400000)):0,
   status:outstanding(s,dn.id)===0?'PAID':'UNPAID',af_verified:dn.af_verified_at?'Yes':'No',
   shipment_status:s.ops_jobs.find(j=>j.id===job.id)?.shipment_status,
   selling_cents:selling,discount_cents:-sum(sale.filter(e=>e.category==='DISCOUNT'),'amount_cents'),
   tax_cents:categoryTotal(sale,'TAX'),vat_cents:categoryTotal(sale,'VAT'),cash_disbursement_cents:cash,
   costing_cents:costing,cost_tax_cents:categoryTotal(cost,'TAX'),cost_vat_cents:categoryTotal(cost,'VAT'),
   cost_discount_cents:-sum(cost.filter(e=>e.category==='DISCOUNT'),'amount_cents'),
   net_cents:net,margin:selling?`${(net/selling*100).toFixed(2)}%`:'—',
   ap_stage:ap?.stage||'NOT_RECEIVED',ap_estimate_cents:ap?.estimate_cents||0,
   ap_cents:ap?.stage==='PAID'?0:ap?.stage==='CONFIRMED'?ap.confirmed_cents:ap?.stage==='RECEIVED_UNCONFIRMED'?sum(cost,'amount_cents'):ap?.estimate_cents||0,
   files:s.ops_files.filter(f=>f.request_id===dn.id).map(f=>f.name).join('; '),
   closing_date:closing?.closing_date||'',finance_verified:closing?'Yes':'No',
  };
 });
}

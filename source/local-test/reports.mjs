export const REPORTS = {
 '01':'Opportunity by salesman','02':'Opportunity by client','03':'Opportunity by status',
 '04':'Activity details','05':'Activity task management','06':'Activity sale forecasting',
 '07':'Opportunity by service','08':'Opportunity by partner','10':'Opportunity classes',
};
const sum = (rows, key) => rows.reduce((s,r)=>s+Number(r[key]||0),0);
const ratio = (n, numerator, denominator) => denominator ? Number((BigInt(n)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator)) : n;
const esc = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validDay = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const t = Date.parse(`${v}T12:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === v; };
const dateLocal = v => v ? new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Phnom_Penh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)) : '';
export function buildReport(s, p={}) {
 const rid=p.report||'01';
 if(!Object.hasOwn(REPORTS,rid)) throw Object.assign(new Error('Select a supported report.'),{status:400});
 for(const key of ['from','to'])if(p[key]&&!validDay(p[key]))throw Object.assign(new Error('Enter a valid report date.'),{status:400});
 if(p.from&&p.to&&p.from>p.to)throw Object.assign(new Error('The report end date must be on or after its start date.'),{status:400});
 const look=new Map(s.lookups.map(x=>[x.id,x.name])), contacts=new Map(s.contacts.map(x=>[x.id,x]));
 const name=id=>look.get(id)||'Unassigned';
 const matches=(key,value)=>!p[key]||String(p[key]).split(',').includes(String(value));
 const daterange=value=>(!p.from||value>=p.from)&&(!p.to||value<=p.to);
 let rows=[], columns=[];
 const currency=s.company.currency;
 if(['04','05','06'].includes(rid)) {
   rows=s.activities.filter(a=>rid==='05'?a.type==='OPPORTUNITY':rid==='06'?a.type==='AFTER SALE':true)
    .filter(a=>matches('status',a.status)&&matches('owner',contacts.get(a.contact_id)?.owner_id)&&matches('branch',a.branch_id)&&matches('contact',a.contact_id)&&matches('activity_type',a.type)&&matches('parent_type',a.parent_type)&&daterange(dateLocal(a.start_at)))
    .map(a=>({group:contacts.get(a.contact_id)?.customer_name||'Internal tasks',id:a.id,parent:a.parent_id||'Internal',type:a.type,subject:a.subject,summary:a.summary,status:a.status,owner:name(a.assigned_to),date:dateLocal(a.start_at),reason:a.reason,forecast_cents:a.forecast_cents}));
   columns=[['group','Customer'],['id','Activity'],['parent','Parent'],['type','Type'],['subject','Subject'],['summary','Summary'],['status','Status'],['owner','Assigned to'],['date','Start date'],['reason','Reason']];
   if(rid==='06')columns.push(['forecast_cents','Forecast']);
 } else {
   const opps=s.opportunities.filter(o=>matches('status',o.status)&&matches('owner',o.owner_id)&&matches('branch',o.branch_id)&&matches('class',o.class_id)&&matches('contact',o.contact_id)&&matches('partner',o.partner_id)&&daterange(o.estimation))
    .filter(o=>!p.customer||(contacts.get(o.contact_id)?.customer_name||'').toLowerCase().includes(p.customer.toLowerCase()));
   for(const o of opps) {
     const allLines=s.opportunity_lines.filter(l=>l.opportunity_id===o.id), lines=allLines.filter(l=>matches('material',l.material_id));
     if(p.material&&!lines.length)continue;
     const base={id:o.id,customer:contacts.get(o.contact_id)?.customer_name||'',contact:o.contact_id,title:o.title,owner:name(o.owner_id),status:o.status,date:o.estimation,branch:name(o.branch_id),class:name(o.class_id),partner:o.partner_id?name(o.partner_id):'No partner'};
     if(rid==='07') {
       // Allocate document-level costing/receipts/commission once, so service groups never duplicate them.
       const allocated={costing_cents:0,payment_received_cents:0,commission_cents:0};
       let cumulative=0;
       const allocation=new Map(allLines.map((l,i)=>{
         cumulative+=l.total_cents;
         const a={};for(const key of Object.keys(allocated)) {a[key]=i===allLines.length-1?o[key]-allocated[key]:o.total_cents?ratio(o[key],cumulative,o.total_cents)-allocated[key]:0;allocated[key]+=a[key];}
         return [l.id,a];
       }));
       for(const l of lines) {
         const a=allocation.get(l.id);
         rows.push({...base,group:l.material_id?name(l.material_id):l.description,quantity:Number(l.quantity),total_cents:l.total_cents,costing_cents:a.costing_cents,commission_cents:a.commission_cents,payment_received_cents:a.payment_received_cents,net_cents:l.total_cents-a.costing_cents,ar_cents:l.total_cents-a.payment_received_cents});
       }
     } else {
       const total=p.material?sum(lines,'total_cents'):o.total_cents;
       const costing=ratio(o.costing_cents,total,o.total_cents),paid=ratio(o.payment_received_cents,total,o.total_cents),commission=ratio(o.commission_cents,total,o.total_cents);
       rows.push({...base,group:rid==='01'?base.owner:rid==='02'?base.customer:rid==='03'?base.status:rid==='08'?base.partner:base.class,quantity:sum(lines,'quantity'),total_cents:total,costing_cents:costing,payment_received_cents:paid,commission_cents:commission,net_cents:total-costing,ar_cents:total-paid});
     }
   }
   if(rid==='10') {
     const groups=new Map();
     for(const r of rows) {const key=JSON.stringify([r.class,r.contact,r.status,r.branch]);const agg=groups.get(key)||{...r,id:'',quantity:0,total_cents:0,costing_cents:0,commission_cents:0};for(const k of ['quantity','total_cents','costing_cents','commission_cents'])agg[k]+=r[k];groups.set(key,agg);}
     rows=[...groups.values()]; columns=[['group','Opportunity class'],['customer','Customer'],['status','Status'],['branch','Branch'],['quantity','Quantity'],['total_cents','Total'],['costing_cents','Costing'],['commission_cents','Commission']];
   } else columns=[['group',rid==='07'?'Service':rid==='08'?'Partner':'Group'],['id','Opportunity'],['customer','Customer'],['status','Status'],['date','Expected close'],['quantity','Quantity'],['total_cents','Total incl. VAT'],['costing_cents','Costing'],['net_cents','Net after costing'],['payment_received_cents','Payment received'],['ar_cents','AR']];
 }
 rows.sort((a,b)=>String(a.group).localeCompare(String(b.group))||String(a.id).localeCompare(String(b.id)));
 const totals={};for(const [key] of columns)if(key.endsWith('_cents'))totals[key]=sum(rows,key);
 const groups=[...new Set(rows.map(r=>r.group))].map(group=>({group,count:rows.filter(r=>r.group===group).length,total_cents:sum(rows.filter(r=>r.group===group),rid==='06'?'forecast_cents':'total_cents')}));
 return {id:rid,title:REPORTS[rid],company:s.company.name,currency,columns,rows,totals,groups,filters:p,generated_at:new Date().toISOString()};
}
const value=(r,key,currency)=>key.endsWith('_cents')?new Intl.NumberFormat('en-US',{style:'currency',currency}).format(Number(r[key]||0)/100):String(r[key]??'');
export function reportCSV(r) {
 const cell=x=>`"${String(x??'').replace(/^[=+\-@\t\r]/,"'$&").replaceAll('"','""')}"`;
 return '\uFEFF'+[r.columns.map(c=>c[1]),...r.rows.map(row=>r.columns.map(([key])=>value(row,key,r.currency)))].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function printPage(title,body,landscape=false) {
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>@page{size:A4 ${landscape?'landscape':'portrait'};margin:12mm}body{font:14px Arial,sans-serif;color:#162239;max-width:1400px;margin:28px auto;padding:0 20px}h1{font-size:25px}h2{font-size:18px}p{line-height:1.5}.muted{color:#62708a}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:9px 7px;text-align:left;border-bottom:1px solid #dce3ee;vertical-align:top;overflow-wrap:anywhere}th{background:#edf2fa}thead{display:table-header-group}tr{break-inside:avoid}button{padding:10px 20px;background:#2357d9;color:white;border:0;border-radius:5px;cursor:pointer}.total{text-align:right;font-size:18px;margin:20px 0}.group td{font-weight:bold;background:#f1f5fb}a{color:#2357d9}@media print{.controls{display:none}body{margin:0;padding:0}}</style></head><body><div class="controls"><button id="print">Print / Save as PDF</button><p class="muted">Choose “Save as PDF” in your browser’s print dialog.</p></div>${body}<script src="/print.js"></script></body></html>`;
}
export function reportHTML(r) {
 let last=null;
 const body=r.rows.map(row=>{let heading='';if(last!==row.group){last=row.group;heading=`<tr class="group"><td colspan="${r.columns.length}">${esc(row.group)}</td></tr>`;}return heading+`<tr>${r.columns.map(([k])=>`<td>${esc(value(row,k,r.currency))}</td>`).join('')}</tr>`;}).join('');
 const filters=Object.entries(r.filters).filter(([k,v])=>k!=='report'&&v).map(([k,v])=>`${k}: ${v}`).join(' · ');
 return printPage(`RPT ${r.id} · ${r.title}`,`<p>${esc(r.company)} · LOCAL TEST</p><h1>RPT ${r.id} · ${esc(r.title)}</h1><p class="muted">${esc(filters||'All records')} · ${r.rows.length} rows · Cambodia dates</p><table><thead><tr>${r.columns.map(c=>`<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${body||`<tr><td colspan="${r.columns.length}">No matching records</td></tr>`}</tbody><tfoot><tr>${r.columns.map(([k],i)=>`<th>${i===0?'Grand total':k.endsWith('_cents')?esc(value(r.totals,k,r.currency)):''}</th>`).join('')}</tr></tfoot></table><p class="muted">${['04','05','06'].includes(r.id)?'Activities are linked by explicit record type and ID.':'Costing and commission are counted once per opportunity. AR uses the CRM payment-received attribute; invoice balances are shown in Operations.'}</p>`,!['04','05','06'].includes(r.id));
}
export function quotationHTML(store,id,revision) {
 const q=store.record('quotation',id), rev=revision?store.get('SELECT * FROM quote_revisions WHERE quotation_id=? AND revision=?',q.id,Number(revision)):store.latestQuote(q);
 if(!rev)throw Object.assign(new Error('Revision not found.'),{status:404});
 const company=store.get('SELECT * FROM company WHERE id=1'), sale=store.get('SELECT * FROM accepted_sales WHERE quotation_id=?',q.id);
 const snap=sale?JSON.parse(sale.snapshot_json):JSON.parse(store.get('SELECT snapshot_json FROM won_sales WHERE opportunity_id=?',q.opportunity_id).snapshot_json);
 const contact=snap.contact,lines=JSON.parse(rev.lines_json),fmt=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:company.currency}).format(n/100);
 const approvals=store.all('SELECT a.*,l.name FROM approvals a JOIN lookups l ON l.id=a.actor_id WHERE quotation_id=? AND revision=? ORDER BY a.id',q.id,rev.revision);
 return printPage(`${q.id} revision ${rev.revision}`,`<p>${esc(company.name)} · LOCAL TEST DOCUMENT</p><h1>Sales quotation ${esc(q.id)}</h1><p>Revision ${rev.revision}${rev.revision!==q.revision?' · Historical revision':` · ${esc(q.status)}`}<br>Date: ${esc(rev.quotation_date)} · Valid until: ${esc(rev.valid_until)}<br>Source opportunity: ${esc(q.opportunity_id)}</p><h2>${esc(contact.customer_name)}</h2><p>${esc(contact.first_name+' '+contact.last_name)}<br>${esc(contact.address)}<br>${esc(contact.email)} · ${esc(contact.phone)}</p><table><thead><tr><th>Description</th><th>Qty / unit</th><th>Unit price</th><th>Discount</th><th>Net</th><th>VAT</th><th>Total</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${esc(l.description)}</td><td>${esc(l.quantity)} ${esc(l.unit)}</td><td>${esc(l.unit_price)}</td><td>${fmt(l.discount_cents)}</td><td>${fmt(l.net_cents)}</td><td>${fmt(l.vat_cents)}</td><td>${fmt(l.total_cents)}</td></tr>`).join('')}</tbody></table><div class="total">Net ${fmt(rev.net_cents)} · VAT ${fmt(rev.vat_cents)}<br><strong>Total ${fmt(rev.total_cents)}</strong></div><p>${esc(rev.notes)}</p><h2>Approval history for this revision</h2>${approvals.map(a=>`<p>Step ${a.step} · ${esc(a.action)} · ${esc(a.name)} · ${esc(a.created_at)}<br>${esc(a.comment)}</p>`).join('')||'<p>No approvals recorded.</p>'}`);
}

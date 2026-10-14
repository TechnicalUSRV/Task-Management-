import { readFileSync } from 'node:fs';
import { REQUEST_TYPES, CONTAINER_SIZES, COA_CATEGORIES, PAYMENT_CATEGORIES, workingDeadline, paymentSuffix, categoryFor, priceJob, coaRows, categoryTotal, performanceRows, outstanding, sum } from './operations-domain.mjs';

export function createOperations(c) {
 const {db,get,all,run,insert,update,id,lookup,record,version,event,fail,str,choice,date,integer,now,today,validateLines,scaled}=c;
 db.exec(readFileSync(new URL('./operations.sql',import.meta.url),'utf8'));
 const request=key=>{
  const row=get('SELECT * FROM ops_requests WHERE id=?',str(key,'Request number',60,true))||fail('Operations request not found.',404);
  return {...row,payload:JSON.parse(row.payload_json)};
 };
 const config=()=>{
  const r=get('SELECT * FROM ops_settings WHERE id=1');
  const fallback=all('SELECT approver_id FROM approval_steps ORDER BY step DESC LIMIT 1').map(a=>a.approver_id);
  return {...r,holidays:JSON.parse(r.holidays_json),finance_ids:JSON.parse(r.finance_ids_json).length?JSON.parse(r.finance_ids_json):fallback,coa_rules:JSON.parse(r.coa_rules_json)};
 };
 const finance=actor=>{if(!config().finance_ids.includes(actor))fail('Select an assigned Finance operator to perform this action.',403);};
 const approved=(key,type)=>{const r=request(key);if(r.type!==type||r.status!=='APPROVED')fail(`Select an approved ${REQUEST_TYPES[type]}.`);return r;};
 const openMonth=dn=>{if(get('SELECT dn_id FROM ops_closings WHERE dn_id=?',dn))fail('Finance has closed this entry. Its approved costs and monthly snapshot are locked.',409);};
 const dnRow=key=>get('SELECT * FROM ops_debit_notes WHERE id=?',key)||fail('Select an approved Debit Note.');
 const apRow=key=>get('SELECT * FROM ops_ap WHERE dn_id=?',key)||fail('AP entry not found.');
 const validateMoney=fn=>{try{return fn();}catch(e){if(e.status)throw e;fail(e.message);}};
 const historicalDate=(value,label)=>{const v=date(value,label);if(v>today())fail(`${label} cannot be in the future.`);return v;};
 const lines=(input,type,rateCard=false)=>{
  if(!Array.isArray(input)||!input.length)fail('Add at least one charge line.');
  const normalized=validateMoney(()=>validateLines(input));
  return normalized.map((l,i)=>({...l,
   category:choice(input[i].category||categoryFor(l.description,type,config().coa_rules),type==='PR'?PAYMENT_CATEGORIES:COA_CATEGORIES,'COA category'),
   container_size:rateCard?choice(input[i].container_size||'ALL',['ALL',...CONTAINER_SIZES],'container size'):'ALL',
   rate_basis:rateCard?choice(input[i].rate_basis||'SHIPMENT',['SHIPMENT','CONTAINER'],'rate basis'):'SHIPMENT',
   remark:str(input[i].remark,'Line remark',300),source:type==='PR'?'PAYMENT':'EXTRA'
  }));
 };
 const totals=l=>({amount_cents:sum(l,'amount_cents'),discount_cents:sum(l,'discount_cents'),net_cents:sum(l,'net_cents'),vat_cents:sum(l,'vat_cents'),total_cents:sum(l,'total_cents')});
 const common=(d,contact)=>({document_date:historicalDate(d.document_date,'Document date'),notes:str(d.notes,'Notes',5000),customer_name:contact.customer_name,
  customer_contact:`${contact.first_name} ${contact.last_name}`.trim(),customer_address:contact.address,customer_phone:contact.phone,customer_email:contact.email});
 function payload(type,d,contact,sourceId,crmQuoteId) {
  let p=common(d,contact);
  if(sourceId&&p.document_date<request(sourceId).payload.document_date)fail('Document date cannot precede its source document.');
  if(type==='QUOTATION') {
   p={...p,valid_until:date(d.valid_until,'Quotation valid until'),commodity_type:choice(d.commodity_type,['GARMENT','GENERAL','VEHICLE','OTHER'],'commodity type'),
    commodity:str(d.commodity,'Commodity',1000,true),terms:str(d.terms,'Trade / route terms',1000,true),payment_terms:str(d.payment_terms,'Payment terms',1000),lines:lines(d.lines,type,true)};
   if(p.valid_until<p.document_date)fail('Quotation validity must end on or after its document date.');
   if(p.commodity_type==='GARMENT'&&!p.lines.some(l=>l.container_size!=='ALL'))fail('Garment quotations need container-size-specific rates.');
   if(crmQuoteId){const q=record('quotation',crmQuoteId);if(q.contact_id!==contact.id||!['APPROVED','ACCEPTED','CONVERTED'].includes(q.status))fail('Select an approved CRM quotation for this customer.');p.crm_revision=q.revision;}
  } else if(type==='PO') {
   const q=approved(sourceId,'QUOTATION');
   if(q.payload.valid_until<today())fail('The approved quotation has expired. Create a renewed quotation first.');
   if(d.booking_confirmed!==true)fail('Confirm the customer booking before issuing a Purchase Order.');
   const confirmed=historicalDate(d.booking_date,'Booking confirmation date');
   if(confirmed>p.document_date)fail('Booking confirmation must be on or before the PO document date.');
   p={...p,quotation_id:q.id,quotation_revision:q.revision,booking_confirmed:true,booking_date:confirmed,booking_reference:str(d.booking_reference,'Booking confirmation reference',300,true),
    commodity_type:q.payload.commodity_type,commodity:str(d.commodity||q.payload.commodity,'Commodity details',2000,true),terms:str(d.terms||q.payload.terms,'Terms / service route',1000,true),
    consignee:str(d.consignee,'Consignee',300,true),customer_vat:str(d.customer_vat,'Customer VAT / ID',100),service_type:str(d.service_type,'Service type',300,true),
    scope_of_services:str(d.scope_of_services,'Scope of services / commodity details',3000,true),conditions:str(d.conditions,'Conditions',4000),quantity:integer(d.quantity,1,100000,'commodity quantity'),unit:str(d.unit,'Unit',30,true)};
   const account=get("SELECT * FROM accounts WHERE contact_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1",contact.id);
   if(!account)fail('This customer needs an active Business Account before creating a PO. Complete the CRM won-sale flow first.');
  } else if(type==='JOB') {
   const po=approved(sourceId,'PO'),q=approved(po.source_id,'QUOTATION');
   const containers=Array.isArray(d.containers)?d.containers:String(d.containers||'').split(/[\n,]/);
   const names=containers.map(v=>str(v,'Container number',40)).filter(Boolean);
   if(!names.length||names.length>200||new Set(names).size!==names.length)fail('Enter 1–200 unique container numbers, one per line.');
   const size=choice(d.container_size,CONTAINER_SIZES,'container size');
   const deadline=po.job_deadline||workingDeadline(po.issued_date,config().holidays);
   const late=str(d.late_reason,'Late Job File reason',1000,today()>deadline);
   const base=validateMoney(()=>priceJob(q.payload,size,names.length));
   const extras=d.extra_lines?.length?lines(d.extra_lines,'JOB'):[];
   p={...p,po_id:po.id,quotation_id:q.id,quotation_revision:q.revision,commodity_type:po.payload.commodity_type,commodity:po.payload.commodity,
    terms:po.payload.terms,consignee:po.payload.consignee,container_size:size,containers:names,deadline,late_reason:late,
    bill_of_lading:str(d.bill_of_lading,'Bill of Lading',200,true),eta:date(d.eta,'ETA'),etd:date(d.etd,'ETD'),
    apply_co:str(d.apply_co,'Apply C/O',200),gross_weight:str(d.gross_weight,'Gross weight',100),pol_pod:str(d.pol_pod,'POL / POD',300),
    client_invoice:str(d.client_invoice,'Client invoice number',200),shipment_type:str(d.shipment_type,'Shipment type',100),partner_name:str(d.partner_name,'Partner name',200),
    commission_cents:validateMoney(()=>scaled(d.commission||'0')),volume:str(d.volume,'Volume',100),delivery_place:str(d.delivery_place,'Delivery place',500),
    cut_seal_delivery:str(d.cut_seal_delivery,'Cut seal / delivery',200),source_from:str(d.source_from,'Source from',200),tax_invoice:str(d.tax_invoice,'Tax invoice',200),
    ops_notes:str(d.ops_notes,'OPS notes',3000),finance_notes:str(d.finance_notes,'Accounting and finance notes',3000),extra_lines:extras,lines:[...base,...extras]};
   if(p.eta<p.etd)fail('ETA cannot be before ETD.');
  } else if(type==='DN') {
   const job=approved(sourceId,'JOB'),j=get('SELECT * FROM ops_jobs WHERE id=?',job.id);
   if(!['DELIVERING','CLOSED'].includes(j.shipment_status))fail('Debit Notes require an approved Job File at Delivering or Delivered (Closed).');
   const due=date(d.due_date,'AR due date');if(due<p.document_date)fail('Due date must be on or after the Debit Note date.');
   p={...p,job_id:job.id,po_id:job.source_id,quotation_id:job.payload.quotation_id,terms:job.payload.terms,due_date:due,lines:job.payload.lines};
  } else if(type==='PR') {
   const dn=approved(sourceId,'DN');dnRow(dn.id);openMonth(dn.id);
   if(apRow(dn.id).stage==='PAID')fail('The AP entry is already paid. Additional costs require an adjustment workflow.');
   p={...p,dn_id:dn.id,job_id:dn.payload.job_id,payee:str(d.payee,'Payee / supplier',300,true),requested_to:str(d.requested_to,'Requested to',200),
    bank_name:str(d.bank_name,'Bank name',200),account_name:str(d.account_name,'Account name',200),bank_account:str(d.bank_account,'Bank account',100),
    supplier_reference:str(d.supplier_reference,'Supplier invoice / bill reference',300,true),lines:lines(d.lines,'PR')};
  }
  if(p.lines){Object.assign(p,totals(p.lines));if(p.total_cents>1000000000000)fail('Document total is too large.');}
  return p;
 }
 function save(d,actor) {
  const creationKey=d.request_key?str(d.request_key,'Creation key',100,true):null;
  const duplicate=!d.id&&creationKey?get('SELECT * FROM ops_requests WHERE creation_key=?',creationKey):null;
  if(duplicate){if(duplicate.type!==d.type||(duplicate.source_id||'')!==(d.source_id||''))fail('This creation key belongs to another request.',409);return {id:duplicate.id,type:'operations'};}
  const old=d.id?request(d.id):null;
  if(old){version(old,d.expected_version);if(!['DRAFT','RETURNED','REJECTED'].includes(old.status))fail('Only draft, returned or rejected requests can be revised.',409);}
  const type=old?.type||choice(d.type,Object.keys(REQUEST_TYPES),'request type');
  const sourceId=old?.source_id||d.source_id||null;
  if(type!=='QUOTATION'&&!sourceId)fail('Select the preceding approved document.');
  const source=sourceId?request(sourceId):null;
  const contact=record('contact',old?.contact_id||source?.contact_id||d.contact_id);
  if(!contact.active)fail('Reactivate this contact before creating a request.');
  const account=get("SELECT * FROM accounts WHERE contact_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1",contact.id);
  const crmQuoteId=type==='QUOTATION'?(old?.crm_quote_id||d.crm_quote_id||null):source?.crm_quote_id||null;
  const p=payload(type,d,contact,sourceId,crmQuoteId);
  const key=old?.id||(type==='PR'?`${sourceId}${paymentSuffix(get('INSERT INTO sequences(kind,value) VALUES(?,1) ON CONFLICT(kind) DO UPDATE SET value=value+1 RETURNING value',`ops-pr-${sourceId}`).value)}`:id(`ops-${type}`,{QUOTATION:'SQ',PO:'PO',JOB:'JO',DN:'DN'}[type]));
  const rev=(old?.revision||0)+1;
  const values={type,contact_id:contact.id,account_id:account?.id||null,source_id:sourceId,crm_quote_id:crmQuoteId,status:'DRAFT',revision:rev,version:old?old.version+1:0,payload_json:JSON.stringify(p),approval_chain:'[]',approval_step:0,updated_at:now()};
  if(old)update('ops_requests',key,values);else insert('ops_requests',{id:key,...values,creation_key:creationKey,created_by:actor,created_at:now()});
  const snapshot={request_id:key,type,revision:rev,payload:p,contact,account:account||null,source:source?{id:source.id,type:source.type,revision:source.revision,payload:source.payload}:null,crm_quote_id:crmQuoteId};
  insert('ops_revisions',{request_id:key,revision:rev,snapshot_json:JSON.stringify(snapshot),created_by:actor,created_at:now()});
  event(actor,contact.id,'operations',key,`Saved ${REQUEST_TYPES[type]} revision ${rev}`,sourceId||crmQuoteId||'');
  return {id:key,type:'operations'};
 }
 function alert(r,chain,step) {
  insert('ops_notifications',{request_id:r.id,revision:r.revision,step,actor_id:chain[step-1],message:`${REQUEST_TYPES[r.type]} ${r.id} · revision ${r.revision} needs your approval.`,created_at:now()});
 }
 function effect(r,actor) {
  const p=r.payload;
  if(r.type==='JOB')insert('ops_jobs',{id:r.id,po_id:r.source_id,quotation_id:p.quotation_id,issued_date:today(),deadline:p.deadline,late_reason:p.late_reason,updated_at:now()});
  if(r.type==='DN') {
   const postings=coaRows(p.lines,'DN'),selling=categoryTotal(postings,'SELLING');
   insert('ops_debit_notes',{id:r.id,job_id:r.source_id,total_cents:p.total_cents,selling_cents:selling,due_date:p.due_date,issued_date:today()});
   insert('ops_ap',{dn_id:r.id,stage:'NOT_RECEIVED',estimate_cents:selling});
   for(const row of postings)insert('ops_postings',{...row,request_id:r.id,dn_id:r.id,created_at:now()});
   event(actor,r.contact_id,'operations',r.id,'Debit Note posted to AR; Selling estimate posted to AP non-confirmed',`AR ${(p.total_cents/100).toFixed(2)} · AP estimate ${(selling/100).toFixed(2)}`);
  }
  if(r.type==='PR') {
   openMonth(r.source_id);
   const ap=apRow(r.source_id);if(ap.stage==='PAID')fail('AP is paid; additional costs cannot be posted.');
   for(const row of coaRows(p.lines,'PR'))insert('ops_postings',{...row,request_id:r.id,dn_id:r.source_id,created_at:now()});
   run("UPDATE ops_ap SET stage='RECEIVED_UNCONFIRMED',confirmed_cents=0,confirmed_by=NULL,confirmed_at=NULL,version=version+1 WHERE dn_id=?",r.source_id);
   event(actor,r.contact_id,'operations',r.source_id,'Approved Payment Request costs posted; AP requires confirmation',r.id);
  }
 }
 function process(d,actor) {
  const r=request(d.id),verb=choice(d.process,['submit','approve','return','reject'],'approval action');
  version(r,d.expected_version);
  const comment=str(d.comment,'Comment',2000,['return','reject'].includes(verb));
  let chain=JSON.parse(r.approval_chain),step=r.approval_step,status=r.status;
  if(verb==='submit') {
   if(r.status!=='DRAFT')fail('Only a saved draft can be submitted.',409);
   payload(r.type,r.payload,record('contact',r.contact_id),r.source_id,r.crm_quote_id);
   if(r.type==='QUOTATION'&&r.payload.valid_until<today())fail('Renew this expired quotation before submission.');
   chain=all('SELECT approver_id FROM approval_steps ORDER BY step').map(a=>lookup(a.approver_id,'staff'));
   if(!chain.length)fail('Configure at least one approval step in Company settings.');
   status='SUBMITTED';step=1;alert(r,chain,step);
  } else {
   if(r.status!=='SUBMITTED')fail('This request is not awaiting approval.',409);
   if(chain[step-1]!==actor)fail('Only the assigned approver may act at this step.',403);
   insert('ops_approvals',{request_id:r.id,revision:r.revision,step,action:verb.toUpperCase(),actor_id:actor,comment,created_at:now()});
   run('UPDATE ops_notifications SET resolved_at=? WHERE request_id=? AND revision=? AND step=?',now(),r.id,r.revision,step);
   if(verb==='approve') {
    // Recheck live stage/period gates inside the same transaction as approval effects.
    payload(r.type,r.payload,record('contact',r.contact_id),r.source_id,r.crm_quote_id);
    if(r.type==='QUOTATION'&&r.payload.valid_until<today())fail('This quotation has expired. Return it for revision.');
    if(step<chain.length){step++;alert(r,chain,step);}else {status='APPROVED';effect(r,actor);}
   } else {status=verb==='return'?'RETURNED':'REJECTED';step=0;}
  }
  update('ops_requests',r.id,{status,approval_chain:JSON.stringify(chain),approval_step:step,version:r.version+1,updated_at:now(),...(status==='APPROVED'?{approved_at:now(),issued_date:today(),...(r.type==='PO'?{job_deadline:workingDeadline(today(),config().holidays)}:{})}:{})});
  event(actor,r.contact_id,'operations',r.id,`${REQUEST_TYPES[r.type]} ${verb==='submit'?'submitted':status==='APPROVED'?'approved and issued':verb==='approve'?'approval recorded':status.toLowerCase()}`,comment);
  return {id:r.id,type:'operations'};
 }
 function handle(action,d,actor) {
  if(action==='ops.save')return save(d,actor);
  if(action==='ops.process')return process(d,actor);
  if(action==='ops.shipment') {
   const r=approved(d.id,'JOB'),j=get('SELECT * FROM ops_jobs WHERE id=?',r.id);version(j,d.expected_version);
   const sequence=['IN_TRANSIT','ARRIVED_PORT','DELIVERING','CLOSED'],status=choice(d.status,sequence,'shipment status');
   if(sequence.indexOf(status)!==sequence.indexOf(j.shipment_status)+1)fail('Move the shipment to its next stage in order.');
   const closed=status==='CLOSED'?historicalDate(d.closed_date,'Delivery / closing date'):null;
   if(closed&&closed<j.issued_date)fail('Delivery date cannot be before Job File issuance.');
   update('ops_jobs',r.id,{shipment_status:status,version:j.version+1,updated_at:now(),closed_date:closed});
   event(actor,r.contact_id,'operations',r.id,`Shipment changed to ${status}`,str(d.comment,'Shipment note',2000));
   return {id:r.id,type:'operations'};
  }
  if(action==='ops.file.add') {
   const r=request(d.id),name=str(d.name,'File name',160,true).replaceAll('\\','/').split('/').pop();
   const ext=name.split('.').pop().toLowerCase(),types={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',csv:'text/csv',txt:'text/plain'};
   // Own-property lookup: names such as "constructor" must be rejected, not treated as a type.
   if(!name.includes('.')||!Object.hasOwn(types,ext))fail('Upload PDF, PNG, JPG, XLSX, DOCX, CSV or TXT.');
   if(typeof d.base64!=='string'||!d.base64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(d.base64))fail('Invalid file content.');
   const content=Buffer.from(d.base64,'base64');if(!content.length||content.length>5*1024*1024)fail('Choose a file between 1 byte and 5 MB.');
   const key=id('ops-file','FILE');
   insert('ops_files',{id:key,request_id:r.id,name,mime:types[ext],size:content.length,content,uploaded_by:actor,created_at:now()});
   event(actor,r.contact_id,'operations',r.id,'Supporting file uploaded',name);
   return {id:r.id,type:'operations',file_id:key};
  }
  if(action==='ops.receipt'||action==='ops.af.verify') {
   finance(actor);const r=approved(d.id,'DN'),dn=dnRow(r.id);
   const key=str(d.request_key,'Receipt / verification key',100,true),prior=get('SELECT * FROM ops_settlements WHERE request_key=?',key);
   const type=action==='ops.receipt'?'RECEIPT':'AF_VERIFICATION';
   const reference=str(d.reference,'Bank / verification reference',300,true),settlementDate=historicalDate(d.settlement_date,'Settlement date');
   if(settlementDate<r.payload.document_date)fail('Settlement cannot predate the Debit Note.');
   if(prior){if(prior.dn_id!==r.id||prior.type!==type||prior.reference!==reference||prior.settlement_date!==settlementDate||(type==='RECEIPT'&&prior.amount_cents!==validateMoney(()=>scaled(d.amount))))fail('This key was used for a different settlement.',409);return {id:r.id,type:'operations'};}
   const balance=outstanding(stateForReport(),r.id);
   let amount=type==='RECEIPT'?validateMoney(()=>scaled(d.amount)):balance,file=null;
   if(type==='RECEIPT'&&(amount<=0||amount>balance))fail('Receipt must be positive and no larger than the remaining AR.');
   if(type==='AF_VERIFICATION') {
    if(dn.af_verified_at)fail('A/F verification was already recorded.',409);
    file=get('SELECT * FROM ops_files WHERE id=? AND request_id=?',d.file_id||'',r.id);
    if(!file)fail('Upload and select supporting evidence on this Debit Note before A/F verification.');
    update('ops_debit_notes',r.id,{af_verified_at:now(),af_verified_by:actor});
   }
   insert('ops_settlements',{id:id('ops-settlement','REC'),dn_id:r.id,type,amount_cents:amount,reference,settlement_date:settlementDate,file_id:file?.id||null,actor_id:actor,request_key:key,created_at:now()});
   event(actor,r.contact_id,'operations',r.id,type==='RECEIPT'?'AR receipt recorded':'A/F verified; remaining AR cleared',`${reference} · ${(amount/100).toFixed(2)}`);
   return {id:r.id,type:'operations'};
  }
  if(action==='ops.ap.confirm'||action==='ops.ap.pay') {
   finance(actor);const r=approved(d.id,'DN'),ap=apRow(r.id);version(ap,d.expected_version);
   const reference=str(d.reference,action==='ops.ap.confirm'?'Supplier bill reference':'Payout reference',300,true);
   if(action==='ops.ap.confirm') {
    openMonth(r.id);
    if(ap.stage!=='RECEIVED_UNCONFIRMED')fail('Approved Payment Requests are required before AP confirmation.');
    if(get("SELECT id FROM ops_requests WHERE source_id=? AND type='PR' AND status IN ('DRAFT','SUBMITTED','RETURNED')",r.id))fail('Resolve unfinished Payment Requests before confirming AP.');
    const amount=get('SELECT COALESCE(SUM(amount_cents),0) AS n FROM ops_postings WHERE dn_id=? AND request_id<>?',r.id,r.id).n;
    run("UPDATE ops_ap SET stage='CONFIRMED',confirmed_cents=?,confirmed_by=?,confirmed_at=?,supplier_reference=?,version=version+1 WHERE dn_id=?",amount,actor,now(),reference,r.id);
   } else {
    if(ap.stage!=='CONFIRMED')fail('Confirm AP before recording payout.');
    run("UPDATE ops_ap SET stage='PAID',paid_cents=confirmed_cents,paid_by=?,paid_at=?,payment_reference=?,version=version+1 WHERE dn_id=?",actor,now(),reference,r.id);
   }
   event(actor,r.contact_id,'operations',r.id,action==='ops.ap.confirm'?'AP confirmed and ready to pay':'AP payout recorded',reference);
   return {id:r.id,type:'operations'};
  }
  if(action==='ops.finance.close') {
   finance(actor);const r=approved(d.id,'DN');openMonth(r.id);
   const closing=historicalDate(d.closing_date,'Closing date'),ap=apRow(r.id);
   if(closing.slice(0,7)!==r.payload.document_date.slice(0,7)||closing<r.payload.document_date)fail('Closing must be on or after the DN date and within the same calendar month.');
   if(!['CONFIRMED','PAID'].includes(ap.stage))fail('Confirm AP before finance verification and monthly closing.');
   if(get("SELECT id FROM ops_requests WHERE source_id=? AND type='PR' AND status IN ('DRAFT','SUBMITTED','RETURNED')",r.id))fail('Resolve unfinished Payment Requests before closing.');
   const row=performanceRows(stateForReport()).find(row=>row.id===r.id);
   insert('ops_closings',{dn_id:r.id,closing_date:closing,snapshot_json:JSON.stringify({...row,closing_date:closing,finance_verified:'Yes'}),verified_by:actor,verified_at:now()});
   event(actor,r.contact_id,'operations',r.id,'Finance verified and included in Monthly Shipment Report',closing);
   return {id:r.id,type:'operations'};
  }
  if(action==='ops.notification.read') {
   run('UPDATE ops_notifications SET read_at=? WHERE id=? AND actor_id=?',now(),integer(d.id,1,Number.MAX_SAFE_INTEGER,'notification'),actor);
   return {message:'Notification marked read.'};
  }
  if(action==='ops.settings') {
   finance(actor);const old=config();version(old,d.expected_version);
   const holidays=[...new Set(String(d.holidays||'').split(/[\s,]+/).filter(Boolean).map(v=>date(v,'Holiday date')))];
   if(holidays.length>400)fail('Use up to 400 holiday dates.');
   if(!Array.isArray(d.finance_ids)||!d.finance_ids.length||d.finance_ids.length>20)fail('Assign at least one Finance operator.');
   const financeIds=[...new Set(d.finance_ids.map(v=>lookup(v,'staff')))];
   if(!Array.isArray(d.coa_rules)||d.coa_rules.length>50)fail('Use up to 50 description rules.');
   const rules=d.coa_rules.map(r=>({contains:str(r.contains,'Description keyword',100,true),category:choice(r.category,[...COA_CATEGORIES,'COSTING'],'COA category')}));
   update('ops_settings',1,{holidays_json:JSON.stringify(holidays),finance_ids_json:JSON.stringify(financeIds),coa_rules_json:JSON.stringify(rules),version:old.version+1});
   event(actor,null,'operations','SETTINGS','Operations calendar, Finance assignments and COA mapping updated');
   return {message:'Settings saved. Existing approved prices and posted classifications are unchanged.'};
  }
  fail('Unknown operations action.',404);
 }
 function stateForReport() {
  const out={ops_requests:all('SELECT * FROM ops_requests').map(r=>({...r,payload:JSON.parse(r.payload_json)}))};
  for(const table of ['ops_approvals','ops_notifications','ops_jobs','ops_debit_notes','ops_postings','ops_ap','ops_settlements','ops_closings'])out[table]=all(`SELECT * FROM ${table}`);
  out.ops_files=all('SELECT id,request_id,name,mime,size,uploaded_by,created_at FROM ops_files');
  out.ops_revisions=all('SELECT request_id,revision,created_by,created_at FROM ops_revisions');
  out.ops_events=all("SELECT * FROM events WHERE entity_type='operations' ORDER BY id DESC");
  out.ops_settings=config();
  return out;
 }
 return {handle,state:stateForReport,request,config};
}

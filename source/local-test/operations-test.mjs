import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, today, dayOffset } from './service.mjs';
import { seedDemo } from './seed.mjs';
import { workingDeadline, paymentSuffix, performanceRows, outstanding, sum } from './operations-domain.mjs';
import { OPS_REPORTS, buildOpsReport, poDeadlines, opsDocumentHTML } from './operations-reports.mjs';
import { createLocalServer } from './server.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'sunny-operations-')),filename=path.join(folder,'test.sqlite');
let s=openStore(filename),checks=0;
const check=(name,fn)=>{fn();checks++;console.log(`PASS ${name}`);};
const act=(a,d,actor)=>s.command(a,d,actor),req=id=>s.operations.request(id);
const save=(type,data)=>act('ops.save',{type,document_date:today(),...data}).id;
const process=(id,process,actor='STAFF-001',extra={})=>act('ops.process',{id,expected_version:req(id).version,process,...extra},actor);
const approve=id=>{process(id,'submit');process(id,'approve','STAFF-002');process(id,'approve','STAFF-003');};
const reject=(f,regex)=>assert.throws(f,regex);
const charge=(description,unit_price,extra={})=>({description,unit_price,quantity:'1',unit:'service',discount:'0',percentage_discount:'0',tax_percent:'0',container_size:'ALL',rate_basis:'SHIPMENT',...extra});
const prData={payee:'Test supplier',supplier_reference:'SUPPLIER-BILL-01',lines:[charge('Truck cost','100',{category:'COSTING',tax_percent:'10'}),charge('Cost tax','5',{category:'TAX'})]};
let quote,po,job,dn,pr1,pr2,contact,account,file,finalSnapshot;
try {
 seedDemo(s);
 check('working days, configured holidays, and payment suffixes beyond Z',()=>{
  assert.equal(workingDeadline('2026-09-18'),'2026-09-23');
  assert.equal(workingDeadline('2026-09-18',['2026-09-21']),'2026-09-24');
  assert.equal(paymentSuffix(26),'Z');assert.equal(paymentSuffix(27),'AA');assert.equal(paymentSuffix(52),'AZ');
 });
 check('operations retain connected CRM account and immutable source revisions',()=>{
  contact=act('contact.save',{first_name:'Operations',customer_name:'Operations test customer',owner_id:'STAFF-001'}).id;
  const opp=act('opportunity.save',{contact_id:contact,title:'Operations test sale',branch_id:'BR-PP',class_id:'OC003',owner_id:'STAFF-001',estimation:today(),probability:100,lines:[charge('Package','100')]}).id;
  act('opportunity.close',{id:opp,expected_version:0,status:'WON'});account=s.get('SELECT id FROM accounts WHERE contact_id=?',contact).id;
  quote=save('QUOTATION',{contact_id:contact,request_key:'quote-create-once',valid_until:dayOffset(30),commodity_type:'GARMENT',commodity:'Garment cartons',terms:'SHV to Phnom Penh',lines:[charge('Trucking 20FT','100',{container_size:'20FT',rate_basis:'CONTAINER',percentage_discount:'10',discount:'2',tax_percent:'10'}),charge('Trucking 40FT','200',{container_size:'40FT',rate_basis:'CONTAINER'}),charge('Clearance','50'),charge('Customs duty','20'),charge('Cash disbursement','10')]});
  assert.equal(save('QUOTATION',{contact_id:contact,request_key:'quote-create-once'}),quote);
  assert.equal(req(quote).account_id,account);assert.equal(req(quote).payload.lines[3].category,'TAX');
  const original=s.get('SELECT snapshot_json FROM ops_revisions WHERE request_id=? AND revision=1',quote).snapshot_json;
  const old=req(quote);act('ops.save',{...old.payload,id:quote,expected_version:old.version,notes:'Revised notes'});
  assert.equal(req(quote).revision,2);assert.equal(s.get('SELECT snapshot_json FROM ops_revisions WHERE request_id=? AND revision=1',quote).snapshot_json,original);
  reject(()=>act('ops.save',{...old.payload,id:quote,expected_version:old.version}),/changed/);
 });
 check('one ordered approval chain, locked submitted revisions, returns and alerts',()=>{
  process(quote,'submit');reject(()=>process(quote,'approve','STAFF-001'),/assigned/);
  assert.equal(s.get('SELECT actor_id FROM ops_notifications WHERE request_id=? AND resolved_at IS NULL',quote).actor_id,'STAFF-002');
  reject(()=>act('ops.save',{...req(quote).payload,id:quote,expected_version:req(quote).version}),/Only draft/);
  process(quote,'return','STAFF-002',{comment:'Clarify terms'});assert.equal(req(quote).status,'RETURNED');
  act('ops.save',{...req(quote).payload,id:quote,expected_version:req(quote).version,notes:'Clarified terms'});approve(quote);
  assert.equal(req(quote).status,'APPROVED');assert.equal(s.all('SELECT * FROM ops_notifications WHERE request_id=? AND resolved_at IS NULL',quote).length,0);
 });
 const poData=()=>({source_id:quote,booking_confirmed:true,booking_date:today(),booking_reference:'Customer confirmation',consignee:'Factory',service_type:'FCL import',scope_of_services:'Garments and trucking',quantity:'2',unit:'containers'});
 check('PO requires confirmed booking, approved pricing, and one company account',()=>{
  reject(()=>save('PO',{...poData(),booking_confirmed:false}),/Confirm the customer booking/);
  const foreign=act('contact.save',{first_name:'Other',customer_name:'Other customer',owner_id:'STAFF-001'}).id;
  po=save('PO',{...poData(),contact_id:foreign});assert.equal(req(po).contact_id,contact);
  reject(()=>save('JOB',{source_id:po}),/approved Purchase Order/);
  approve(po);assert.equal(req(po).job_deadline,workingDeadline(today()));
  const deadline=req(po).job_deadline,settings=s.operations.config();
  act('ops.settings',{expected_version:settings.version,holidays:deadline,finance_ids:['STAFF-003'],coa_rules:settings.coa_rules},'STAFF-003');
  assert.equal(poDeadlines(s.state()).find(p=>p.id===po).deadline,deadline);
 });
 const jobData=()=>({source_id:po,container_size:'20FT',containers:['CONTAINER1','CONTAINER2'],bill_of_lading:'TEST-BL',etd:today(),eta:dayOffset(5),extra_lines:[charge('Extra document','5',{tax_percent:'10'})]});
 check('Garment size selection, container counts, discounts and extra charges',()=>{
  reject(()=>save('JOB',{...jobData(),container_size:'40HC'}),/No approved Garment rate/);
  reject(()=>save('JOB',{...jobData(),containers:['DUP','DUP']}),/unique container/);
  job=save('JOB',jobData());const p=req(job).payload;
  assert.equal(p.lines[0].quantity,'2.0000');assert.equal(p.lines[0].discount_cents,2400);assert.equal(p.lines[0].net_cents,17600);assert.equal(p.total_cents,27910);
  assert.equal(p.lines.filter(l=>l.description.includes('40FT')).length,0);
  assert.equal(s.get('SELECT * FROM ops_jobs WHERE id=?',job),undefined);approve(job);
 });
 check('shipment sequence and strict Debit Note eligibility',()=>{
  reject(()=>save('DN',{source_id:job,due_date:dayOffset(30)}),/Delivering/);
  reject(()=>act('ops.shipment',{id:job,expected_version:0,status:'CLOSED',closed_date:today()}),/next stage/);
  act('ops.shipment',{id:job,expected_version:0,status:'ARRIVED_PORT'});
  reject(()=>save('DN',{source_id:job,due_date:dayOffset(30)}),/Delivering/);
  act('ops.shipment',{id:job,expected_version:1,status:'DELIVERING'});
  dn=save('DN',{source_id:job,due_date:dayOffset(30),lines:[charge('Tampered','1')]});
  assert.equal(req(dn).payload.total_cents,27910);assert.equal(s.get('SELECT * FROM ops_debit_notes WHERE id=?',dn),undefined);
  reject(()=>save('DN',{source_id:job,due_date:dayOffset(30)}),/already exists/);
 });
 check('final approval atomically creates AR, estimated AP and reconciled COA',()=>{
  process(dn,'submit');process(dn,'approve','STAFF-002');
  const before=s.get('SELECT COUNT(*) AS n FROM events').n;
  s.db.exec("CREATE TRIGGER fail_post BEFORE INSERT ON ops_postings BEGIN SELECT RAISE(ABORT,'posting failure'); END;");
  reject(()=>process(dn,'approve','STAFF-003'),/posting failure/);
  assert.equal(req(dn).status,'SUBMITTED');assert.equal(req(dn).approval_step,2);assert.equal(s.get('SELECT * FROM ops_debit_notes WHERE id=?',dn),undefined);assert.equal(s.get('SELECT * FROM ops_ap WHERE dn_id=?',dn),undefined);assert.equal(s.get('SELECT COUNT(*) AS n FROM events').n,before);
  s.db.exec('DROP TRIGGER fail_post');process(dn,'approve','STAFF-003');
  assert.equal(outstanding(s.state(),dn),27910);assert.equal(s.get('SELECT estimate_cents FROM ops_ap WHERE dn_id=?',dn).estimate_cents,23100);
  assert.equal(sum(s.all('SELECT * FROM ops_postings WHERE request_id=?',dn),'amount_cents'),27910);
  reject(()=>process(dn,'approve','STAFF-003'),/not awaiting/);assert.equal(s.all('SELECT * FROM ops_debit_notes WHERE id=?',dn).length,1);
 });
 check('Payment Request suffixes, approval-only costs and multiple supplier bills',()=>{
  pr1=save('PR',{source_id:dn,...prData});pr2=save('PR',{source_id:dn,...prData,supplier_reference:'BILL-02',lines:[charge('Extra supplier','50',{percentage_discount:'10'})]});
  assert.equal(pr1,dn+'A');assert.equal(pr2,dn+'B');assert.equal(performanceRows(s.state()).find(p=>p.id===dn).costing_cents,0);
  approve(pr1);assert.equal(s.get('SELECT stage FROM ops_ap WHERE dn_id=?',dn).stage,'RECEIVED_UNCONFIRMED');
  reject(()=>act('ops.ap.confirm',{id:dn,expected_version:s.get('SELECT version FROM ops_ap WHERE dn_id=?',dn).version,reference:'Bill verified'},'STAFF-003'),/unfinished/);
  approve(pr2);
  const p=performanceRows(s.state()).find(p=>p.id===dn);assert.equal(p.costing_cents,14500);assert.equal(p.cost_tax_cents,500);assert.equal(p.cost_vat_cents,1000);assert.equal(p.cost_discount_cents,500);assert.equal(p.net_cents,9600);assert.equal(p.ap_cents,16000);
 });
 check('finance controls, AP confirmation and record-only payout',()=>{
  const ap=s.get('SELECT * FROM ops_ap WHERE dn_id=?',dn);
  reject(()=>act('ops.ap.confirm',{id:dn,expected_version:ap.version,reference:'Invoice checked'},'STAFF-001'),/Finance/);
  act('ops.ap.confirm',{id:dn,expected_version:ap.version,reference:'Invoice checked'},'STAFF-003');
  assert.equal(s.get('SELECT confirmed_cents FROM ops_ap WHERE dn_id=?',dn).confirmed_cents,16000);
  reject(()=>act('ops.ap.pay',{id:dn,expected_version:ap.version,reference:'Bank transfer'},'STAFF-003'),/changed/);
 });
 check('AR partial receipts, retry protection and A/F evidence clears only remaining AR',()=>{
  const receipt={id:dn,amount:'100',reference:'Deposit receipt',settlement_date:today(),request_key:'receipt-test'};
  act('ops.receipt',receipt,'STAFF-003');act('ops.receipt',receipt,'STAFF-003');assert.equal(outstanding(s.state(),dn),17910);
  reject(()=>act('ops.receipt',{...receipt,amount:'101'},'STAFF-003'),/different settlement/);
  reject(()=>act('ops.receipt',{...receipt,amount:'180',request_key:'overpayment'},'STAFF-003'),/remaining AR/);
  reject(()=>act('ops.af.verify',{id:dn,settlement_date:today(),request_key:'verify-test',reference:'A/F checked'},'STAFF-003'),/supporting evidence/);
  reject(()=>act('ops.file.add',{id:dn,name:'attack.html',base64:Buffer.from('<script>').toString('base64')}),/Upload PDF/);
  file=act('ops.file.add',{id:dn,name:'evidence-ខ្មែរ.txt',base64:Buffer.from('Test evidence ខ្មែរ').toString('base64')}).file_id;
  act('ops.af.verify',{id:dn,file_id:file,settlement_date:today(),reference:'A/F checked',request_key:'verify-test'},'STAFF-003');
  assert.equal(outstanding(s.state(),dn),0);assert.equal(s.get("SELECT amount_cents FROM ops_settlements WHERE dn_id=? AND type='AF_VERIFICATION'",dn).amount_cents,17910);
  assert.equal(s.get('SELECT total_cents FROM ops_debit_notes WHERE id=?',dn).total_cents,27910);
 });
 check('Closed Job File report, Paid sale report and all six report filters',()=>{
  assert.equal(buildOpsReport(s.state(),{report:'closed'}).rows.some(r=>r.id===job),false);
  act('ops.shipment',{id:job,expected_version:2,status:'CLOSED',closed_date:today()});
  const closed=buildOpsReport(s.state(),{report:'closed',from:today(),to:today(),customer:'Operations test'});assert.equal(closed.rows.length,1);assert.equal(closed.rows[0].total_cents,27910);
  assert.equal(buildOpsReport(s.state(),{report:'jobs',status:'IN_TRANSIT',customer:'Operations test'}).rows.length,0);
  assert.equal(buildOpsReport(s.state(),{report:'sales',status:'PAID',month:today().slice(0,7),customer:'Operations test'}).rows.length,1);
  for(const report of Object.keys(OPS_REPORTS))assert.ok(Array.isArray(buildOpsReport(s.state(),{report}).rows));
 });
 check('same-month finance closing saves and locks a monthly snapshot',()=>{
  reject(()=>act('ops.finance.close',{id:dn,closing_date:'2020-01-01'},'STAFF-003'),/same calendar month/);
  act('ops.finance.close',{id:dn,closing_date:today()},'STAFF-003');
  finalSnapshot=s.get('SELECT snapshot_json FROM ops_closings WHERE dn_id=?',dn).snapshot_json;
  const monthly=buildOpsReport(s.state(),{report:'monthly',month:today().slice(0,7),customer:'Operations test'});assert.equal(monthly.rows.length,1);assert.equal(monthly.rows[0].net_cents,9600);
  reject(()=>save('PR',{source_id:dn,...prData}),/closed this entry/);
  act('ops.ap.pay',{id:dn,expected_version:s.get('SELECT version FROM ops_ap WHERE dn_id=?',dn).version,reference:'Sample payout'},'STAFF-003');
  assert.equal(performanceRows(s.state()).find(r=>r.id===dn).ap_cents,0);assert.equal(s.get('SELECT snapshot_json FROM ops_closings WHERE dn_id=?',dn).snapshot_json,finalSnapshot);
 });
 check('late issuance is flagged and requires an explicit reason',()=>{
  const latePO=save('PO',poData());approve(latePO);s.run('UPDATE ops_requests SET issued_date=?,job_deadline=? WHERE id=?',dayOffset(-10),dayOffset(-5),latePO);
  assert.equal(poDeadlines(s.state()).find(p=>p.id===latePO).status,'OVERDUE');
  reject(()=>save('JOB',{...jobData(),source_id:latePO}),/Late Job File reason/);
  const lateJob=save('JOB',{...jobData(),source_id:latePO,late_reason:'Customer supplied the B/L late'});approve(lateJob);
  assert.equal(buildOpsReport(s.state(),{report:'jobs'}).rows.find(r=>r.id===lateJob).late,'Yes');
 });
 check('reopening preserves CRM, approval history, files, balances and immutable monthly records',()=>{
  const won=s.get('SELECT snapshot_json FROM won_sales WHERE account_id=?',account).snapshot_json;
  assert.ok(s.journey(contact).events.some(e=>e.entity_id===dn));
  assert.match(opsDocumentHTML(s,quote,1),/Historical revision/);assert.match(opsDocumentHTML(s,job),/Bill of Lading/);
  s.db.close();s=openStore(filename);seedDemo(s);
  assert.equal(s.get('SELECT snapshot_json FROM won_sales WHERE account_id=?',account).snapshot_json,won);
  assert.equal(s.get('SELECT snapshot_json FROM ops_closings WHERE dn_id=?',dn).snapshot_json,finalSnapshot);
  assert.equal(Buffer.from(s.get('SELECT content FROM ops_files WHERE id=?',file).content).toString(),'Test evidence ខ្មែរ');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
 });
 const port=4318,server=createLocalServer(s,port);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 try {
  const base=`http://127.0.0.1:${port}`;
  const admin=s.access.bootstrap({staff_id:'STAFF-003',name:'Vanna · Director',email:'admin@example.test',password:'test-only-password'}),cookie='sunny_session='+s.access.startSession(admin);
  const fetch=(url,options={})=>globalThis.fetch(url,{...options,headers:{...options.headers,Cookie:cookie}});
  const response=await fetch(base+`/api/ops/file?id=${file}`);assert.equal(response.status,200);assert.match(response.headers.get('Content-Disposition'),/attachment/);assert.equal(await response.text(),'Test evidence ខ្មែរ');
  for(const report of Object.keys(OPS_REPORTS))for(const suffix of ['', '.csv','.print']){const response=await fetch(`${base}/api/ops/report${suffix}?report=${report}`);assert.equal(response.status,200);}
  const snapshot=await fetch(`${base}/api/ops/revision?id=${quote}&revision=1`);assert.equal((await snapshot.json()).account.id,account);
  const forbidden=await fetch(`${base}/api/command`,{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({action:'ops.ap.pay',data:{id:dn},actor:'STAFF-003'})});assert.equal(forbidden.status,403);
  assert.equal((await fetch(base+'/data/erp.sqlite')).status,404);
  console.log('PASS real HTTP operations reports, evidence download, snapshots and cross-origin guard');checks++;
 }finally{await new Promise(resolve=>server.close(resolve));}
 console.log(`\n${checks} Sunny Logistics workflow checks passed.`);
}finally{s.db.close();rmSync(folder,{recursive:true,force:true});}

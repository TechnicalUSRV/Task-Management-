import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, today, dayOffset, calculateLines } from './service.mjs';
import { seedDemo } from './seed.mjs';
import { buildReport, reportCSV, reportHTML, quotationHTML } from './reports.mjs';
import { createLocalServer } from './server.mjs';
import { APP_VERSION } from './version.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'erp-local-test-'));
const filename=path.join(folder,'test.sqlite');let s=openStore(filename),checks=0;
const check=(name,fn)=>{fn();checks++;console.log(`PASS ${name}`);};
const act=(action,data,actor)=>s.command(action,data,actor);
const revision=(type,id)=>s.record(type,id).version;
const reject=(fn,pattern)=>assert.throws(fn,pattern);
const newContact=(extra={})=>act('contact.save',{first_name:'Test',last_name:'Customer',customer_name:'Test company',owner_id:'STAFF-001',...extra}).id;
const line={material_id:'SVC-001',description:'Test service',unit:'hour',quantity:'1.005',unit_price:'1',discount:'0',percentage_discount:'0',tax_percent:'10'};
const newOpportunity=(contact_id,extra={})=>act('opportunity.save',{contact_id,title:'Test deal',branch_id:'BR-PP',class_id:'OC001',owner_id:'STAFF-001',estimation:today(),probability:50,costing:'0',commission:'0',payment_received:'0',lines:[line],...extra}).id;
const closeWon=id=>act('opportunity.close',{id,expected_version:revision('opportunity',id),status:'WON'});
const process=(id,verb,actor='STAFF-001',extra={})=>act('quotation.process',{id,expected_version:revision('quotation',id),process:verb,...extra},actor);

try {
 seedDemo(s);
 check('single company and idempotent local sample setup',()=>{const counts=s.state().contacts.length;seedDemo(s);assert.equal(s.state().contacts.length,counts);reject(()=>s.run("INSERT INTO company(id,name) VALUES(2,'Other')"),/CHECK/);assert.equal(s.all('PRAGMA foreign_key_check').length,0);});
 check('exact decimal prices, discounts, VAT, and validation',()=>{
  assert.equal(calculateLines([line])[0].amount_cents,101);
  assert.equal(calculateLines([line])[0].total_cents,111);
  const l=calculateLines([{...line,quantity:'2.5',unit_price:'19.995',percentage_discount:'10',discount:'2',tax_percent:'10'}])[0];
  assert.equal(l.amount_cents,4999);assert.equal(l.discount_cents,700);assert.equal(l.net_cents,4299);assert.equal(l.vat_cents,430);assert.equal(l.total_cents,4729);
  reject(()=>calculateLines([{...line,quantity:'-1'}]),/nonnegative/);reject(()=>calculateLines([{...line,quantity:'1e2'}]),/decimal/);reject(()=>calculateLines([{...line,quantity:'1.00001'}]),/decimal/);reject(()=>calculateLines([{...line,discount:'3'}]),/exceeds/);
 });
 let contact,lead,opp,quote,account,order,invoice;
 check('contact IDs, generated IDs, editable reference data and stale edits',()=>{
  contact=newContact({code:'CONT-000006'});assert.equal(contact,'CONT-000006');
  assert.equal(newContact(),'CONT-000007');reject(()=>newContact({code:'CONT-000006'}),/already exists/);
  const row=s.record('contact',contact);act('contact.save',{...row,expected_version:0,phone:'012111222'});
  reject(()=>act('contact.save',{...row,expected_version:0,phone:'other'}),/changed/);
  act('lookup.save',{kind:'branch',name:'Test branch'});act('lookup.save',{kind:'material',name:'Test service',unit:'hour'});
  assert.equal(s.all("SELECT id FROM lookups WHERE id LIKE 'REF-%'").length,2);
 });
 check('campaign qualification, duplicate responses, and atomic conversion',()=>{
  const campaign=s.state().campaigns[0];act('campaign.generate',{id:campaign.id,contact_ids:[contact,contact]});
  const repeat=act('campaign.generate',{id:campaign.id,contact_ids:[contact]});assert.match(repeat.message,/0 leads created; 1/);
  const leadRow=s.get('SELECT * FROM leads WHERE contact_id=?',contact);lead=leadRow.id;
  reject(()=>newOpportunity(contact,{lead_id:lead}),/Qualify/);
  act('lead.save',{...leadRow,expected_version:0,status:'QUALIFIED'});
  opp=newOpportunity(contact,{lead_id:lead,request_key:'first-conversion',lines:[{...line,quantity:'10',unit_price:'100',percentage_discount:'10',discount:'20'}],costing:'150',commission:'30',payment_received:'80'});
  assert.equal(s.record('lead',lead).status,'CONVERTED');assert.equal(s.record('opportunity',opp).total_cents,96800);
  assert.equal(newOpportunity(contact,{lead_id:lead,request_key:'first-conversion'}),opp);
  const additional=newOpportunity(contact,{lead_id:lead,request_key:'second-deal'});assert.notEqual(additional,opp);
  assert.equal(s.all('SELECT id FROM opportunities WHERE lead_id=?',lead).length,2);
  reject(()=>act('opportunity.save',{...s.record('opportunity',opp),expected_version:0,estimation:'2026-02-30',lines:[line]}),/valid/);
  assert.equal(s.record('opportunity',opp).version,0);
 });
 let activity,wonSnapshot;
 check('typed customer activities, documents and won snapshot',()=>{
  activity=act('activity.save',{parent_type:'CONTACT',parent_id:contact,type:'FOLLOWUP',channel:'CALL',subject:'Initial call',start_at:`${today()}T09:00:00+07:00`,branch_id:'BR-PP',assigned_to:'STAFF-002',priority:'HIGH'}).id;
  reject(()=>act('activity.save',{parent_type:'CONTACT',parent_id:contact,type:'AFTER SALE',channel:'CALL',subject:'Invalid type',start_at:`${today()}T09:00:00+07:00`,branch_id:'BR-PP',assigned_to:'STAFF-001'}),/Business Account/);
  act('document.link',{parent_type:'OPPORTUNITY',parent_id:opp,title:'Service brief',url:'https://example.com/brief'});
  reject(()=>act('document.link',{parent_type:'CONTACT',parent_id:contact,title:'Invalid',url:'javascript:alert(1)'}),/http/);
  reject(()=>act('quotation.create',{opportunity_id:opp}),/won opportunity/);
  closeWon(opp);closeWon(opp);assert.equal(s.all('SELECT * FROM won_sales WHERE opportunity_id=?',opp).length,1);
  wonSnapshot=s.get('SELECT snapshot_json FROM won_sales WHERE opportunity_id=?',opp).snapshot_json;
  const snap=JSON.parse(wonSnapshot);assert.equal(snap.contact.phone,'012111222');assert.equal(snap.activities.length,1);assert.equal(snap.documents.length,1);
  const automaticAccount=s.get('SELECT * FROM accounts WHERE contact_id=?',contact);
  assert.equal(automaticAccount.status,'ACTIVE');assert.equal(snap.account.id,automaticAccount.id);
  assert.equal(s.get('SELECT account_id FROM won_sales WHERE opportunity_id=?',opp).account_id,automaticAccount.id);
  reject(()=>act('opportunity.save',{...s.record('opportunity',opp),expected_version:1,lines:[line]}),/read-only/);
 });
 check('formal quotation revisions and strict approval order',()=>{
  quote=act('quotation.create',{opportunity_id:opp}).id;
  assert.equal(act('quotation.create',{opportunity_id:opp}).id,quote);
  act('quotation.save',{id:quote,expected_version:revision('quotation',quote),quotation_date:today(),valid_until:dayOffset(30),notes:'Final quote',lines:[{...line,quantity:'2',unit_price:'500',tax_percent:'10'}]});
  assert.equal(s.all('SELECT * FROM quote_revisions WHERE quotation_id=?',quote).length,2);
  process(quote,'submit');reject(()=>process(quote,'accept'),/approval/);reject(()=>process(quote,'approve','STAFF-001'),/assigned/);
  process(quote,'approve','STAFF-002');assert.equal(s.record('quotation',quote).status,'SUBMITTED');process(quote,'approve','STAFF-003');assert.equal(s.record('quotation',quote).status,'APPROVED');
  reject(()=>act('quotation.save',{id:quote,expected_version:revision('quotation',quote),lines:[line]}),/Only draft/);
 });
 check('failed acceptance preserves the won account and rolls back quote, snapshot and events',()=>{
  const count=s.get('SELECT COUNT(*) AS n FROM events').n;
  const originalAccount=s.get('SELECT id FROM accounts WHERE contact_id=?',contact).id;
  s.db.exec("CREATE TRIGGER test_fail_sale BEFORE INSERT ON accepted_sales BEGIN SELECT RAISE(ABORT,'simulated failure'); END;");
  reject(()=>process(quote,'accept'),/simulated failure/);
  assert.equal(s.record('quotation',quote).status,'APPROVED');assert.equal(s.get('SELECT id FROM accounts WHERE contact_id=?',contact).id,originalAccount);assert.equal(s.get('SELECT COUNT(*) AS n FROM events').n,count);
  s.db.exec('DROP TRIGGER test_fail_sale');
 });
 let acceptedSnapshot;
 check('acceptance connects the final quote to the existing won account and immutable journey',()=>{
  process(quote,'accept');process(quote,'accept');
  account=s.get('SELECT * FROM accounts WHERE contact_id=?',contact).id;
  const sale=s.get('SELECT * FROM accepted_sales WHERE quotation_id=?',quote);acceptedSnapshot=sale.snapshot_json;
  assert.equal(sale.revision,2);assert.equal(JSON.parse(acceptedSnapshot).quotation.final_revision.total_cents,110000);
  const cr=s.record('contact',contact);act('contact.save',{...cr,expected_version:cr.version,customer_name:'Renamed after acceptance'});
  const ar=s.record('activity',activity);act('activity.save',{...ar,expected_version:ar.version,status:'COMPLETED',summary:'Updated after sale'});
  assert.equal(s.get('SELECT snapshot_json FROM won_sales WHERE opportunity_id=?',opp).snapshot_json,wonSnapshot);
  assert.equal(s.get('SELECT snapshot_json FROM accepted_sales WHERE quotation_id=?',quote).snapshot_json,acceptedSnapshot);
  assert.equal(s.journey(contact).events.some(e=>e.action==='Business Account created automatically from won sale'),true);
 });
 check('repeat sales reuse the customer account',()=>{
  const another=newOpportunity(contact);closeWon(another);const q=act('quotation.create',{opportunity_id:another}).id;
  process(q,'submit');process(q,'approve','STAFF-002');process(q,'approve','STAFF-003');process(q,'accept');
  assert.equal(s.all('SELECT * FROM accounts WHERE contact_id=?',contact).length,1);assert.equal(s.get('SELECT account_id FROM accepted_sales WHERE quotation_id=?',q).account_id,account);
 });
 check('delivery, invoice and exact partial payments with retry protection',()=>{
  order=act('order.create',{quotation_id:quote}).id;assert.equal(act('order.create',{quotation_id:quote}).id,order);
  reject(()=>act('order.invoice',{id:order,expected_version:0,invoice_date:today(),due_date:dayOffset(30)}),/delivery/);
  act('order.ship',{id:order,expected_version:0,reference:'Proof of delivery',shipment_date:today()});
  act('order.invoice',{id:order,expected_version:1,invoice_date:today(),due_date:dayOffset(30)});
  invoice=s.get('SELECT * FROM invoices WHERE order_id=?',order).id;
  const payment={invoice_id:invoice,amount:'300',payment_date:today(),reference:'Receipt 1',request_key:'test-payment-1'};
  act('payment.record',payment);act('payment.record',payment);assert.equal(s.all('SELECT * FROM payments WHERE invoice_id=?',invoice).length,1);
  reject(()=>act('payment.record',{...payment,amount:'301'}),/different payment/);
  reject(()=>act('payment.record',{...payment,request_key:'overpay',amount:'900'}),/remaining balance/);
  act('payment.record',{...payment,request_key:'test-payment-2',amount:'800',reference:'Receipt 2'});
  assert.equal(s.record('order',order).status,'PAID');assert.equal(s.get('SELECT SUM(amount_cents) AS total FROM payments WHERE invoice_id=?',invoice).total,110000);
 });
 check('lost opportunities never create quotes/accounts; expired quotes cannot be accepted',()=>{
  const c=newContact(),o=newOpportunity(c);act('opportunity.close',{id:o,expected_version:0,status:'LOST',reason:'No longer needed'});
  reject(()=>act('quotation.create',{opportunity_id:o}),/won opportunity/);assert.equal(s.get('SELECT id FROM accounts WHERE contact_id=?',c),undefined);
  const exp=newOpportunity(c);closeWon(exp);const q=act('quotation.create',{opportunity_id:exp}).id;
  act('quotation.save',{id:q,expected_version:1,quotation_date:dayOffset(-10),valid_until:dayOffset(-1),lines:[line]});
  reject(()=>process(q,'submit'),/expired/);process(q,'expire');assert.equal(s.record('quotation',q).status,'EXPIRED');
 });
 check('failed won snapshot rolls back the sale, automatic account and history',()=>{
  const c=newContact(),o=newOpportunity(c),before=s.get('SELECT COUNT(*) AS n FROM events').n;
  s.db.exec("CREATE TRIGGER test_fail_won BEFORE INSERT ON won_sales BEGIN SELECT RAISE(ABORT,'won snapshot failure'); END;");
  reject(()=>closeWon(o),/won snapshot failure/);
  assert.equal(s.record('opportunity',o).status,'OPEN');assert.equal(s.get('SELECT id FROM accounts WHERE contact_id=?',c),undefined);assert.equal(s.get('SELECT COUNT(*) AS n FROM events').n,before);
  s.db.exec('DROP TRIGGER test_fail_won');
 });
 check('report filters, service allocations and summary amounts avoid duplicate costing',()=>{
  const state=s.state();
  const r1=buildReport(state,{report:'01',contact,status:'WON'});assert.equal(r1.rows.length,2);
  assert.equal(buildReport(state,{report:'01',contact,status:'LOST'}).rows.length,0);
  assert.equal(buildReport(state,{report:'01',contact,customer:'Renamed'}).rows.length,3);
  const activityReport=buildReport(state,{report:'04',contact,owner:'STAFF-001'});assert.equal(activityReport.rows.length,1);assert.equal(activityReport.rows[0].owner,'Sophea · Sales Manager');
  assert.equal(buildReport(state,{report:'04',contact,owner:'STAFF-002'}).rows.length,0);
  assert.equal(buildReport(state,{report:'07',contact}).totals.costing_cents,r1.totals.costing_cents);
  assert.equal(buildReport(state,{report:'10',contact}).totals.costing_cents,r1.totals.costing_cents);
  for(const code of ['01','02','03','04','05','06','07','08','10']) {const report=buildReport(state,{report:code});assert.ok(reportCSV(report).startsWith('\uFEFF'));assert.match(reportHTML(report),/<thead>/);}
  assert.match(quotationHTML(s,quote,1),/Historical revision/);assert.match(quotationHTML(s,quote,2),/Test company/);
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
 });
 check('reopening the SQLite database preserves records and snapshots',()=>{
  s.db.close();s=openStore(filename);seedDemo(s);assert.equal(s.record('order',order).status,'PAID');assert.equal(s.get('SELECT snapshot_json FROM accepted_sales WHERE quotation_id=?',quote).snapshot_json,acceptedSnapshot);
 });
 check('CRM V2 upgrades earlier local won-sale links without rewriting snapshots',()=>{
  s.run('UPDATE won_sales SET account_id=NULL WHERE opportunity_id=?',opp);s.run('DELETE FROM schema_version WHERE version=2');
  s.db.close();s=openStore(filename);
  assert.equal(s.get('SELECT account_id FROM won_sales WHERE opportunity_id=?',opp).account_id,account);
  assert.equal(s.get('SELECT snapshot_json FROM won_sales WHERE opportunity_id=?',opp).snapshot_json,wonSnapshot);
  assert.equal(s.state().app_version,APP_VERSION);
 });
 const port=4317,server=createLocalServer(s,port);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 try {
  const origin=`http://127.0.0.1:${port}`;
  const admin=s.access.bootstrap({staff_id:'STAFF-003',name:'Vanna · Director',email:'admin@example.test',password:'test-only-password'}),cookie='sunny_session='+s.access.startSession(admin);
  const fetch=(url,options={})=>globalThis.fetch(url,{...options,headers:{...options.headers,Cookie:cookie}});
  const home=await fetch(origin);assert.equal(home.status,200);assert.match(await home.text(),/Task Controlling Management/);
  const state=await fetch(origin+'/api/state');assert.equal(state.status,200);assert.equal((await state.json()).company.id,1);
  const versionResponse=await fetch(origin+'/api/version');assert.equal((await versionResponse.json()).version,APP_VERSION);
  const csrf=await fetch(origin+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://untrusted.example'},body:'{}'});assert.equal(csrf.status,403);
  const made=await fetch(origin+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action:'contact.save',actor:'STAFF-001',data:{first_name:'API',customer_name:'HTTP roundtrip',owner_id:'STAFF-001'}})});assert.equal(made.status,200);
  const csv=await fetch(origin+'/api/report.csv?report=01');assert.equal(csv.status,200);assert.match(csv.headers.get('Content-Disposition'),/attachment/);
  const printable=await fetch(origin+`/api/quotation.print?id=${quote}&revision=2`);assert.equal(printable.status,200);assert.match(await printable.text(),/Print \/ Save as PDF/);
  console.log('PASS real HTTP UI assets, API writes, exports, print routes and cross-origin rejection');checks++;
 } finally { await new Promise(resolve=>server.close(resolve)); }
 console.log(`\n${checks} workflow checks passed. No production data or hosted service used.`);
} finally { s.db.close();rmSync(folder,{recursive:true,force:true}); }

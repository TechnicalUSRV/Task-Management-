import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {buildDashboard} from './dashboard.mjs';
import {ERP_MODULES} from './erp-registry.mjs';
import {buildERPReport,reportOptions,sourceRecords,authorizedRecords,registerDataSource,DATA_SOURCES} from './erp-sources.mjs';
import {reportPrintHTML} from './report-format.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'sunny-v5-'));let hub=openCompanies(folder,{demo:true}),s=hub.primary,checks=0;
const port=4331,origin=`http://127.0.0.1:${port}`,server=createLocalServer(s,port,hub);
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const req=async(url,{cookie='',data,method,origin:headerOrigin=origin}={})=>{const response=await fetch(origin+url,{method:method||(data?'POST':'GET'),headers:{Origin:headerOrigin,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})}),raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}return {status:response.status,body,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};};
let admin,primaryCookie,companyId,secondaryCookie,member,memberCookie,roleId;
const post=(cookie,action,data,company='default')=>req(`/c/${company}/api/command`,{cookie,data:{action,data}});
const signin=async(email,password,company='default')=>req(`/c/${company}/api/auth/login`,{data:{email,password}});
const detail=id=>s.get('SELECT * FROM access_users WHERE id=?',id);
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 await check('scoped first-run sign-in and existing source catalog',async()=>{
  const setup=await req('/c/default/api/auth/setup',{data:{staff_id:'STAFF-003',name:'Vanna test',email:'admin@example.test',password:'v5-primary-password'}});assert.equal(setup.status,200);admin=setup.body.user;primaryCookie=setup.cookie;assert.match(setup.headers.get('set-cookie'),/Path=\/c\/default\//);assert.equal((await req('/c/default/api/state',{cookie:primaryCookie})).body.company_context.id,'default');assert.equal(reportOptions(s,admin).sources.length,18);assert.equal((await req('/c/default/api/erp/dashboard')).status,401);
 });
 await check('dashboard KPI, chart and inbox drill-downs reconcile under combined filters',()=>{
  for(const filters of [{},{statuses:['WON']},{from:'2099-01-01'},{modules:['tasks']},{users:['STAFF-001']}])for(const w of buildDashboard(s,admin,filters).widgets){assert.equal(sourceRecords(s,admin,w.drill).total,w.count,w.id);for(const b of w.bars||[])assert.equal(sourceRecords(s,admin,b.drill).total,b.value,w.id+':'+b.label);}
  const withExport=s.access.publicUser(admin.id);assert.ok(buildDashboard(s,withExport).widgets.some(w=>w.id==='finance-ar'));
 });
 await check('combined report filters use AND between groups and OR within a group',()=>{
  const all=buildERPReport(s,admin),target=all.rows.find(r=>r.source==='opportunities'&&r.user_ids.length&&r.departments.length&&r.status==='WON');assert.ok(target);
  const report=buildERPReport(s,admin,{sources:['opportunities','contacts','accounts'],clients:[target.client_id],accounts:[target.account_id],opportunities:target.opportunity_ids,users:target.user_ids,statuses:['WON','NO_MATCH'],departments:target.departments,from:target.date,to:target.date});assert.equal(report.rows.length,1);assert.equal(report.rows[0].id,target.id);
  assert.equal(buildERPReport(s,admin,{sources:['opportunities'],clients:[target.client_id],users:['UNKNOWN']}).rows.length,0);
  assert.equal(buildERPReport(s,admin,{sources:['staff'],from:'2026-01-01'}).rows.length,0);
  for(const sct of all.sections)assert.equal(sct.total_cents,sct.rows.some(r=>r.amount_cents!==null)?sct.rows.reduce((n,r)=>n+(r.amount_cents||0),0):null);
  assert.deepEqual(all.totals,{});assert.throws(()=>buildERPReport(s,admin,{from:'2026-02-30'}),/valid report dates/);assert.throws(()=>buildERPReport(s,admin,{from:'2027-01-01',to:'2026-01-01'}),/End date/);assert.throws(()=>buildERPReport(s,admin,{sources:['not_registered']}),/Unknown report/);assert.throws(()=>buildERPReport(s,admin,{fields:['password_hash']}),/Unknown report column/);
 });
 await check('user overrides grant, deny and inherit; View gates every action',async()=>{
  const r=await post(primaryCookie,'admin.role.save',{name:'Company reporter',permissions:{dashboard:['view'],'reports.central':['view','export'],'reports.crm':['view','export'],'tasks.reports':['view','export'],'crm.contacts':['view','create','export'],'crm.opportunities':['view','export'],'tasks.tasks':['view','export'],'tasks.company':['view']}});assert.equal(r.status,200);roleId=r.body.result.id;
  const u=await post(primaryCookie,'admin.user.save',{name:'Individual permissions test',email:'member@example.test',role_id:roleId,password:'v5-member-password',active:1,function_settings:{'crm.contacts':{view:'DENY',create:'ALLOW'},'tasks.timesheets':{view:'ALLOW',export:'ALLOW'},'tasks.tasks':{export:'DENY'}}});assert.equal(u.status,200);member=u.body.result.id;memberCookie=(await signin('member@example.test','v5-member-password')).cookie;
  const user=s.access.publicUser(member),p=s.access.permissions(user);assert.deepEqual(p['crm.contacts'],[]);assert.ok(p['tasks.timesheets'].includes('export'));assert.ok(p['tasks.tasks'].includes('view'));assert.ok(!p['tasks.tasks'].includes('export'));const view=await req('/c/default/api/state',{cookie:memberCookie});assert.equal(view.body.contacts.length,0);assert.ok(view.body.tm_timesheets.length>0);assert.doesNotMatch(JSON.stringify(view.body),/password_hash|scrypt:|token_hash/);
  assert.equal((await post(memberCookie,'contact.save',{first_name:'Blocked',customer_name:'Hidden',owner_id:user.staff_id})).status,403);assert.ok(!reportOptions(s,user).sources.some(s=>s.id==='contacts'));assert.ok(!buildDashboard(s,user).sources.some(s=>s.id==='contacts'));
 });
 await check('reports enforce source View and Export on preview, download and legacy routes',async()=>{
  assert.equal((await req('/c/default/api/erp/report',{cookie:memberCookie,data:{sources:['contacts']}})).status,403);
  assert.equal((await req('/c/default/api/erp/report',{cookie:memberCookie,data:{sources:['tasks']}})).status,200);
  assert.equal((await req('/c/default/api/erp/report.export',{cookie:memberCookie,data:{sources:['tasks']}})).status,403);
  assert.equal((await req('/c/default/api/erp/report.csv',{cookie:memberCookie,data:{sources:['tasks']}})).status,403);
  assert.equal((await req('/c/default/api/erp/report.export',{cookie:memberCookie,data:{sources:['timesheets']}})).status,200);
  assert.equal((await req('/c/default/api/report?report=04',{cookie:memberCookie})).status,403);
  assert.equal((await req('/c/default/api/tasks/report.csv?report=tasks',{cookie:memberCookie})).status,403);
  assert.equal((await req('/c/default/api/erp/source?filters='+encodeURIComponent(JSON.stringify({sources:['contacts']})),{cookie:memberCookie})).status,403);
 });
 await check('individual-setting changes revoke sessions; removing an override restores inheritance',async()=>{
  const row=detail(member);const changed=await post(primaryCookie,'admin.user.save',{id:member,expected_version:row.version,name:'Individual permissions test',email:row.email,role_id:roleId,active:1,function_settings:{'tasks.timesheets':{view:'ALLOW',export:'ALLOW'}}});assert.equal(changed.status,200);assert.equal((await req('/c/default/api/state',{cookie:memberCookie})).status,401);memberCookie=(await signin(row.email,'v5-member-password')).cookie;assert.ok(s.access.permissions(s.access.publicUser(member))['crm.contacts'].includes('create'));assert.equal((await post(primaryCookie,'admin.user.save',{id:member,expected_version:row.version,name:'Stale',email:row.email,role_id:roleId})).status,409);
 });
 await check('company module switches override even explicit Allow and retain data/permissions',async()=>{
  const before=s.state().tm_tasks.length,settings=s.all('SELECT * FROM erp_module_settings'),modules=Object.fromEntries(settings.map(m=>[m.module_id,!!m.enabled])),versions=Object.fromEntries(settings.map(m=>[m.module_id,m.version]));
  const response=await post(primaryCookie,'admin.modules.save',{modules:{...modules,tasks:false},versions});assert.equal(response.status,200);assert.equal(s.access.can(s.access.publicUser(member),'tasks.timesheets'),false);assert.ok(!reportOptions(s,admin).sources.some(r=>r.module==='tasks'));assert.equal(s.state().tm_tasks.length,before);
  assert.equal((await post(primaryCookie,'admin.modules.save',{modules,versions})).status,409);
  const next=Object.fromEntries(s.all('SELECT * FROM erp_module_settings').map(m=>[m.module_id,m.version]));assert.equal((await post(primaryCookie,'admin.modules.save',{modules:{...modules,crm:false},versions:next})).status,400);assert.equal((await post(primaryCookie,'admin.modules.save',{modules,versions:next})).status,200);assert.equal(s.access.can(s.access.publicUser(member),'tasks.timesheets'),true);
 });
 await check('company creation provisions isolated empty business data and independent roles',async()=>{
  const result=await req('/c/default/api/companies',{cookie:primaryCookie,data:{name:'Second Company QA',admin_name:'Second administrator',admin_email:'admin@example.test',admin_password:'second-company-password'}});assert.equal(result.status,200);companyId=result.body.result.id;
  assert.equal((await req(`/c/${companyId}/api/state`,{cookie:primaryCookie})).status,401);
  assert.equal((await signin('admin@example.test','v5-primary-password',companyId)).status,401);
  const signed=await signin('admin@example.test','second-company-password',companyId);assert.equal(signed.status,200);secondaryCookie=signed.cookie;assert.match(signed.headers.get('set-cookie'),new RegExp('Path=/c/'+companyId+'/'));const second=hub.get(companyId);assert.equal(second.state().contacts.length,0);assert.equal(second.state().tm_tasks.length,0);assert.ok(second.get('SELECT id FROM access_roles WHERE id=?','ROLE-ADMIN'));assert.equal(second.get('SELECT id FROM access_roles WHERE id=?',roleId),undefined);
 });
 await check('identical record IDs and mixed cookies cannot cross company boundaries',async()=>{
  const sameId=s.state().contacts[0].id,secondary=hub.get(companyId),template=s.get('SELECT * FROM contacts WHERE id=?',sameId);secondary.insert('contacts',{...template,customer_name:'Secondary only',owner_id:'STAFF-001'});
  const cookies=primaryCookie+'; '+secondaryCookie,first=(await req('/c/default/api/state',{cookie:cookies})).body,second=(await req(`/c/${companyId}/api/state`,{cookie:cookies})).body;assert.equal(second.contacts[0].id,sameId);assert.equal(second.contacts[0].customer_name,'Secondary only');assert.notEqual(first.contacts.find(c=>c.id===sameId).customer_name,'Secondary only');assert.equal((await req(`/c/${companyId}/api/erp/report`,{cookie:cookies,data:{sources:['contacts']}})).body.rows.length,1);
  assert.equal((await req(`/c/${companyId}/api/companies`,{cookie:cookies,data:{name:'Forbidden child'}})).status,403);assert.equal((await req('/c/default/api/companies',{cookie:memberCookie,data:{name:'Forbidden member'}})).status,403);assert.equal((await req('/c/unknown/api/state',{cookie:cookies})).status,404);
  const primaryName=s.get('SELECT name FROM access_roles WHERE id=?','ROLE-VIEWER').name;secondary.command('admin.role.save',{id:'ROLE-VIEWER',expected_version:0,name:'Second company viewer',permissions:{dashboard:['view']}},'STAFF-001');assert.equal(s.get('SELECT name FROM access_roles WHERE id=?','ROLE-VIEWER').name,primaryName);
 });
 await check('report CSV retains money values and blocks spreadsheet formulas; print escapes text',async()=>{
  const body={sources:['opportunities'],fields:['id','title','amount_cents','notes'],title:'<script>report title</script>'},exported=await req('/c/default/api/erp/report.export',{cookie:primaryCookie,data:body});assert.equal(exported.status,200);const amount=exported.body.rows[0].amount_cents,expected=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount/100);const csv=await req('/c/default/api/erp/report.csv',{cookie:primaryCookie,data:body});assert.equal(csv.status,200);assert.ok(csv.body.includes(expected));assert.doesNotMatch(csv.body,/NaN/);
  const html=reportPrintHTML(exported.body);assert.ok(html.includes('&lt;script&gt;report title&lt;/script&gt;'));assert.ok(!html.includes('<script>report title'));
  const id=s.state().contacts[0].id;s.run('UPDATE contacts SET customer_name=? WHERE id=?','=DANGEROUS()',id);const escaped=await req('/c/default/api/erp/report.csv',{cookie:primaryCookie,data:{sources:['contacts']}});assert.match(escaped.body,/'=DANGEROUS/);
  assert.equal((await req('/c/default/api/erp/report.export',{cookie:primaryCookie,data:body,origin:'https://untrusted.example'})).status,403);
 });
 await check('delegated user managers cannot elevate effective permissions through overrides',async()=>{
  const rid=s.command('admin.role.save',{name:'Account coordinator',permissions:{'admin.users':['view','create','update'],'dashboard':['view']}},admin.staff_id).id;
  const uid=s.command('admin.user.save',{name:'Coordinator',email:'coordinator@example.test',role_id:rid,password:'coordinator-test-password',active:1},admin.staff_id).id;const c=(await signin('coordinator@example.test','coordinator-test-password')).cookie;
  const deny=await post(c,'admin.user.save',{name:'Privilege escalation',email:'bad@example.test',role_id:rid,password:'test-password-123',active:1,function_settings:{'admin.roles':{view:'ALLOW',update:'ALLOW'}}});assert.equal(deny.status,403);assert.equal(s.get('SELECT id FROM access_users WHERE email=?','bad@example.test'),undefined);
 });
 await check('source-specific navigation and future registered sources integrate without dashboard redesign',()=>{
  const role=s.command('admin.role.save',{name:'Finance preview only',permissions:{dashboard:['view'],'ops.finance':['view'],'reports.central':['view']}},admin.staff_id).id,user={...admin,role_id:role};assert.ok(authorizedRecords(s,user,['receivables']).every(r=>!r.can_open));
  const module=ERP_MODULES.find(m=>m.id==='system');module.sources.push('qa_future');registerDataSource({id:'qa_future',label:'Registered future source',dateLabel:'Created date',resources:['settings'],read:()=>[{id:'F-1',title:'Registered future item',resource:'settings',user_ids:[],opportunity_ids:[],departments:[],date:'2026-09-22',status:'READY',category:'',amount_cents:null,minutes:null}]});
  try{assert.ok(reportOptions(s,admin).sources.some(s=>s.id==='qa_future'));const widget=buildDashboard(s,admin).widgets.find(w=>w.source==='qa_future');assert.equal(widget.value,1);assert.equal(sourceRecords(s,admin,widget.drill).total,1);}finally{module.sources=module.sources.filter(s=>s!=='qa_future');DATA_SOURCES.delete('qa_future');}
 });
 await check('company records, roles and user settings survive restart',async()=>{
  await new Promise(resolve=>server.close(resolve));hub.close();hub=openCompanies(folder,{demo:true});s=hub.primary;assert.equal(hub.list().length,2);assert.equal(hub.get(companyId).state().contacts[0].customer_name,'Secondary only');assert.equal(hub.get(companyId).get('SELECT name FROM access_roles WHERE id=?','ROLE-VIEWER').name,'Second company viewer');assert.equal(s.access.userSettings(member)['tasks.timesheets'].view,'ALLOW');assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(hub.get(companyId).all('PRAGMA foreign_key_check').length,0);
 });
 console.log(`\n${checks} V5 dashboard, company access and report checks passed.`);
}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));hub.close();rmSync(folder,{recursive:true,force:true});}

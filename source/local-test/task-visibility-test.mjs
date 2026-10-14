import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData,miniState} from './telegram-gateway.mjs';
import {taskToday,addDays} from './task-domain.mjs';

// Reporting changes must revoke access immediately on the server and tell both clients to discard cached reports.
// Telegram authentication is signed locally against a test token; no live Telegram service is used.
const folder=mkdtempSync(path.join(tmpdir(),'sunny-visibility-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;
const A='STAFF-003',B='STAFF-002',C='STAFF-001',today=taskToday();
const cmd=(action,data,actor=A)=>s.command(action,data,actor);
const user=staff=>s.access.publicUser(s.access.accountFor(staff).id);
const state=staff=>s.scopedState(user(staff));
const revision=staff=>state(staff).task_scope.revision;
const denied=(fn,status)=>assert.throws(fn,e=>e.status===status);
let server,gateway,checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 s.access.bootstrap({staff_id:A,name:'Vanna',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:B,name:'Sophea',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1});
 cmd('admin.user.save',{staff_id:C,name:'Dara',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1});
 cmd('admin.user.save',{name:'Chantha',email:'chantha@example.test',role_id:'ROLE-MANAGER',password:'chantha-password-1',active:1});
 const D=s.get('SELECT staff_id FROM access_users WHERE email=?','chantha@example.test').staff_id;
 for(const [staff_id,manager_id] of [[B,A],[C,B],[D,A]])cmd('tm.profile.manager',{staff_id,manager_id});
 const ws=cmd('tm.workspace.save',{name:'Visibility regression',owner_id:B,member_ids:[A,B,C,D]},B).id;
 const task=cmd('tm.task.save',{workspace_id:ws,title:'Reporting transfer confidential work',start_date:today,due_date:addDays(today,2),pic_id:C},C).id;
 cmd('tm.task.progress',{id:task,progress:20},C);

 await check('domain commands require administrator permission, including the profile-save path; failed edits roll back',()=>{
  const profile=s.get('SELECT * FROM tm_profiles WHERE staff_id=?',C);
  denied(()=>cmd('tm.profile.manager',{staff_id:C,manager_id:D},B),403);
  denied(()=>cmd('tm.profile.manager',{staff_id:C,manager_id:B},B),403);
  denied(()=>cmd('tm.profile.save',{...profile,name:'Must not persist',manager_id:D,expected_version:profile.version},B),403);
  assert.equal(s.get('SELECT name FROM lookups WHERE id=?',C).name,'Dara');
  assert.equal(s.get('SELECT manager_id FROM tm_profiles WHERE staff_id=?',C).manager_id,B);
  // An ordinary profile edit can resend an unchanged manager without gaining authority to change it.
  cmd('tm.profile.save',{...profile,name:'Dara',phone:'012345678',expected_version:profile.version},B);
  assert.equal(s.get('SELECT phone FROM tm_profiles WHERE staff_id=?',C).phone,'012345678');
  denied(()=>cmd('tm.profile.manager',{staff_id:B,manager_id:C}),422);
  denied(()=>cmd('tm.profile.manager',{staff_id:C,manager_id:C}),422);
 });

 await check('scope revisions are stable across ordinary updates and equal for ERP and Mini App',()=>{
  const before=revision(B),seq=s.changes();
  assert.match(before,/^[a-f0-9]{64}$/);
  assert.equal(before,revision(B));
  assert.equal(before,miniState(s,user(B)).task_scope.revision);
  cmd('tm.task.progress',{id:task,progress:25},C);
  assert.equal(revision(B),before);
  assert.ok(s.changes()>seq);
 });

 await check('employee filter choices come from authorized records, while assignment and directory options stay separate',()=>{
  const web=state(B),phone=miniState(s,user(B)),filters=web.task_scope.employee_filters;
  assert.deepEqual(phone.task_scope.employee_filters,filters);
  assert.ok(filters.tasks.includes(C));assert.ok(!filters.tasks.includes(D));
  assert.ok(!filters.workload.includes(D),'a separate branch is not included for workload');
  assert.ok(web.tm_people.some(p=>p.staff_id===D),'the existing ability to assign or request work is preserved');
  const visible=new Set(web.tm_tasks.map(t=>t.id));
  for(const staff of filters.tasks)assert.ok(web.tm_tasks.some(t=>t.pic_id===staff)||web.tm_assignees.some(a=>visible.has(a.task_id)&&a.staff_id===staff&&a.status!=='DECLINED'));
  assert.ok(state(A).task_scope.employee_filters.workload.includes(D),'explicit company authority includes all company profiles');
 });

 await check('forwarded requests disappear from the former receiver’s records and notification inbox in both clients',()=>{
  const request=cmd('tm.request.save',{manager_id:B,title:'Confidential request to pass on',workspace_id:ws},C).id;
  assert.ok(state(B).tm_notifications.some(n=>n.request_id===request));
  const before=revision(B);
  cmd('tm.request.forward',{id:request,manager_id:D},B);
  assert.notEqual(revision(B),before);
  for(const view of [state(B),miniState(s,user(B))]){
   assert.ok(!view.tm_requests.some(q=>q.id===request));
   assert.ok(!view.tm_notifications.some(n=>n.request_id===request));
  }
  assert.ok(state(D).tm_notifications.some(n=>n.request_id===request));
  assert.ok(state(C).tm_notifications.some(n=>n.request_id===request));
 });

 await check('personal note notifications cannot reveal another owner’s note or a deleted note',()=>{
  const note=cmd('tm.calnote.save',{title:'Owner-only calendar note',all_day:true,day:today},C).id;
  for(const staff of [B,C])s.insert('tm_notifications',{staff_id:staff,kind:'note_reminder',note_id:note,title:'Owner-only calendar note',body:'Private text',created_at:new Date().toISOString()});
  assert.ok(state(C).tm_notifications.some(n=>n.note_id===note));
  assert.ok(!state(B).tm_notifications.some(n=>n.note_id===note));
  assert.ok(!state(A).tm_calendar_notes.some(n=>n.id===note));
  cmd('tm.calnote.delete',{id:note,expected_version:0},C);
  assert.ok(!state(C).tm_notifications.some(n=>n.note_id===note));
 });

 const port=4365,base=`http://127.0.0.1:${port}`;
 server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const response=async r=>{const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body,headers:r.headers};};
 const request=async(url,cookie='',data)=>response(await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})}));
 const login=async(email,password,company='default')=>{const r=await request(`/c/${company}/api/auth/login`,'',{email,password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const bCookie=await login('sophea@example.test','sophea-password-1'),aCookie=await login('vanna@example.test','vanna-password-1');
 const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
 s.telegram.connectSignedIn(B,{id:7402,first_name:'Sophea'},7402);
 gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const mini=async(p,data,company='default')=>response(await fetch(`http://127.0.0.1:${gateway.address().port}/c/${company}/tg/api${p}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'tma '+signInitData({auth_date:Math.floor(Date.now()/1000),user:{id:7402,first_name:'Sophea'}},TOKEN)},...(data?{body:JSON.stringify(data)}:{})}));

 await check('moving an employee revokes lists, reports, exports, dashboard and direct APIs in ERP and Mini App',async()=>{
  const before=revision(B),seq=s.changes();
  const month=today.slice(0,7),report=`/report?report=monthly&month=${month}&scope=all`;
  assert.ok((await mini('/state')).body.tm_tasks.some(t=>t.id===task));
  assert.ok(JSON.stringify((await mini(report)).body).includes('Reporting transfer confidential work'));
  const move=await request('/c/default/api/command',aCookie,{action:'tm.profile.manager',data:{staff_id:C,manager_id:D}});
  assert.equal(move.status,200);
  assert.notEqual(revision(B),before);assert.ok(s.changes()>seq);
  assert.equal(s.tasks.scope.reason(B,s.get('SELECT * FROM tm_tasks WHERE id=?',task)),null);
  assert.equal(s.tasks.scope.reason(D,s.get('SELECT * FROM tm_tasks WHERE id=?',task)),'team');
  for(const r of [await request('/c/default/api/state',bCookie),await mini('/state')]){
   assert.equal(r.status,200);assert.ok(!r.body.tm_tasks.some(t=>t.id===task));assert.equal(r.body.task_scope.revision,revision(B));
  }
  for(const url of [`/c/default/api/tasks/report?report=monthly&month=${month}`,`/c/default/api/tasks/report.csv?report=tasks`,`/c/default/api/tasks/report.print?report=tasks`,`/c/default/api/erp/dashboard?filters=%7B%7D`]){
   const r=await request(url,bCookie);assert.equal(r.status,200,url);assert.ok(!JSON.stringify(r.body).includes('Reporting transfer confidential work'),url);
  }
  const reportAfter=await mini(report);assert.equal(reportAfter.status,200);assert.ok(!JSON.stringify(reportAfter.body).includes('Reporting transfer confidential work'));
  const edit={action:'tm.task.note',data:{id:task,note:'Guessed ID'}};
  assert.equal((await request('/c/default/api/command',bCookie,edit)).status,404);
  assert.equal((await mini('/command',edit)).status,404);
  assert.equal((await request('/c/default/api/command',bCookie,{action:'tm.profile.manager',data:{staff_id:C,manager_id:B}})).status,403);
  assert.equal((await mini('/command',{action:'tm.profile.manager',data:{staff_id:C,manager_id:B}})).status,403);
  // A manager's new viewing right still cannot edit or subscribe them to notifications.
  denied(()=>cmd('tm.task.note',{id:task,note:'Manager edit'},D),403);
  assert.ok(!state(D).tm_notifications.some(n=>n.task_id===task));
 });

 await check('permission changes invalidate cached scope without relying on job titles',()=>{
  const before=revision(B),account=s.access.accountFor(B);
  const save=settings=>cmd('admin.user.save',{...s.get('SELECT * FROM access_users WHERE id=?',account.id),name:'Executive Director',expected_version:s.get('SELECT version FROM access_users WHERE id=?',account.id).version,function_settings:settings});
  save({});assert.equal(revision(B),before);assert.ok(!state(B).tm_tasks.some(t=>t.id===task));
  save({'tasks.company':{view:'ALLOW'}});
  assert.notEqual(revision(B),before);assert.ok(state(B).tm_tasks.some(t=>t.id===task));
  const wide=revision(B);save({'tasks.company':{view:'DENY'}});
  assert.notEqual(revision(B),wide);assert.ok(!state(B).tm_tasks.some(t=>t.id===task));
 });

 await check('company-local employee IDs never grant authority in a different company',async()=>{
  const other=hub.create({name:'Separate authority',admin_name:'Other Administrator',admin_email:'other@example.test',admin_password:'other-password-1'}),o=hub.get(other.id);
  assert.ok(o.get('SELECT id FROM lookups WHERE id=?',C),'the same local ID exists independently');
  const otherUser=o.access.publicUser(o.access.accountFor(C).id);
  assert.notEqual(o.scopedState(otherUser).task_scope.revision,revision(C));
  assert.equal((await request(`/c/${other.id}/api/state`,aCookie)).status,401);
  assert.equal((await request(`/c/${other.id}/api/command`,aCookie,{action:'tm.profile.manager',data:{staff_id:C,manager_id:A}})).status,401);
  denied(()=>o.command('tm.profile.manager',{staff_id:C,manager_id:A},C),400);
  denied(()=>cmd('tm.profile.manager',{staff_id:C,manager_id:`${other.id}:${C}`}),400);
  o.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
  const r=await mini('/state',undefined,other.id);assert.equal(r.status,403);assert.equal(r.body.code,'not_linked');
 });
 console.log(`\n${checks} Task Visibility regression checks passed.`);
}finally{
 if(server)await new Promise(r=>server.close(r));
 if(gateway)await new Promise(r=>gateway.close(r));
 hub.close();rmSync(folder,{recursive:true,force:true});
}

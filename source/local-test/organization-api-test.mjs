import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';
import {taskToday} from './task-domain.mjs';
const folder=mkdtempSync(path.join(tmpdir(),'sunny-org-api-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,createWorkspace,task,wsB,user}=organizationFixture(s),{A,B,C,D,E,X,Y}=ids;
const port=4375,base=`http://127.0.0.1:${port}`,TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
const server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const response=async r=>({status:r.status,text:await r.text(),headers:r.headers});
const cookies={},init={};
const web=(who,url,data)=>fetch(base+`/c/default/api${url}`,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookies[who]||''},...(data?{body:JSON.stringify(data)}:{})}).then(response);
const mini=(who,url,data,company='default')=>fetch(`http://127.0.0.1:${gateway.address().port}/c/${company}/tg/api${url}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'tma '+init[who]},...(data?{body:JSON.stringify(data)}:{})}).then(response);
try{
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
 let n=7800;for(const [letter,staff] of Object.entries(ids)){
  const login=await web(letter,'/auth/login',{email:letter.toLowerCase()+'@review.test',password:'Review-organization-2026'});assert.equal(login.status,200);cookies[letter]=login.headers.get('set-cookie').split(';')[0];
  const identity={id:n++,first_name:letter};s.telegram.connectSignedIn(staff,identity,identity.id);init[letter]=signInitData({auth_date:Math.floor(Date.now()/1000),user:identity},TOKEN);
 }
 cmd('org.delegation.request',{beneficiary_id:C,reason:'API fixture delegate'},B);
 const wsC=createWorkspace(C,'Delegated API workspace','ORGANIZATIONAL',{joinable:true}),personal=createWorkspace(E,'PRIVATE WORKSPACE MARKER','PERSONAL'),secret=task(E,personal,'PRIVATE TASK MARKER'),work=task(C,wsC,'Organizational work');
 const file=cmd('tm.file.add',{task_id:secret,name:'private.txt',base64:Buffer.from('PRIVATE FILE MARKER').toString('base64')},E).id;
 const meeting=(actor,w,title,hours,extra={})=>cmd('tm.meeting.save',{workspace_id:w,title,organizer_id:actor,attendee_ids:[],start_at:new Date(Date.now()+hours*3600000).toISOString(),end_at:new Date(Date.now()+(hours+1)*3600000).toISOString(),...extra},actor).id;
 const secretMeeting=meeting(E,personal,'PRIVATE MEETING MARKER',100),orgMeeting=meeting(C,wsC,'Members meeting',102),note=cmd('tm.calnote.save',{title:'PRIVATE NOTE MARKER',all_day:true,day:taskToday()},E).id;
 const group=(actor,w,name,visibility='TEAM')=>cmd('tm.group.save',{workspace_id:w,name,visibility,audience:'WORKSPACE',workspace_level:'VIEW',shared:[]},actor).id;
 const secretGroup=group(E,personal,'PRIVATE GROUP MARKER'),orgGroup=group(C,wsC,'Organizational Group'),personalGroup=group(C,wsC,'Owner-only Personal Group','PERSONAL');
 await check('ERP and signed Telegram use identical task, workspace, meeting and employee-filter scopes',async()=>{
  for(const who of ['A','B','C','E','X','Y']){const a=await web(who,'/state'),b=await mini(who,'/state');assert.equal(a.status,200);assert.equal(b.status,200);const wa=JSON.parse(a.text),mb=JSON.parse(b.text);
   for(const field of ['tm_tasks','tm_workspaces','tm_meetings'])assert.deepEqual(wa[field].map(x=>x.id),mb[field].map(x=>x.id));assert.deepEqual(wa.task_scope,mb.task_scope);
   if(who!=='E')for(const marker of ['PRIVATE WORKSPACE MARKER','PRIVATE TASK MARKER','PRIVATE MEETING MARKER','PRIVATE GROUP MARKER','PRIVATE NOTE MARKER']){assert.ok(!a.text.includes(marker));assert.ok(!b.text.includes(marker));}
  }
 });
 await check('private content is excluded from task reports, CSV/print, dashboard, central exports and Calendar state',async()=>{
  for(const who of ['A','B']){
   for(const url of ['/tasks/report?report=tasks','/tasks/report.csv?report=tasks','/tasks/report.print?report=tasks','/tasks/report?report=meetings','/tasks/report?report=workspace','/erp/dashboard']){const r=await web(who,url);assert.equal(r.status,200,url);assert.ok(!r.text.includes('PRIVATE '),url);}
   const mr=await mini(who,`/report?report=monthly&scope=all&month=${taskToday().slice(0,7)}`);assert.equal(mr.status,200);assert.ok(!mr.text.includes('PRIVATE '));
  }
  const ex=await web('A','/erp/report.csv',{sources:['tasks','workspaces','meetings'],fields:['title','notes']});assert.equal(ex.status,200);assert.ok(!ex.text.includes('PRIVATE '));
 });
 await check('guessed task, Calendar note, file, Group rows/notes/XLSX and Google sync cannot bypass privacy',async()=>{
  for(const who of ['A','B','C','X']){
   for(const url of [`/tasks/file?id=${file}`,`/tasks/group?id=${secretGroup}`,`/tasks/group/rows?id=${secretGroup}`,`/tasks/group/notes?id=${secretGroup}`,`/tasks/group.xlsx?id=${secretGroup}`])assert.equal((await web(who,url)).status,404,url);
   for(const call of [{action:'tm.task.note',data:{id:secret,note:'attempt'}},{action:'tm.calnote.save',data:{id:note,title:'attempt',expected_version:0,all_day:true,day:taskToday()}},{action:'tm.meeting.save',data:{id:secretMeeting,expected_version:0,title:'attempt'}}]){assert.equal((await web(who,'/command',call)).status,404);assert.equal((await mini(who,'/command',call)).status,404);}
   await assert.rejects(s.sync.request(user(ids[who]),{action:'connect',group_id:secretGroup},{redirectUri:'http://localhost/callback'}),e=>e.status===403);
  }
 });
 await check('management oversight grants no Group/Meeting access or task action; Level 1 organizational override preserves Personal Groups',async()=>{
  assert.equal((await web('B',`/tasks/group?id=${orgGroup}`)).status,404);assert.equal((await web('A',`/tasks/group?id=${orgGroup}`)).status,200);
  assert.equal((await web('A',`/tasks/group?id=${personalGroup}`)).status,404);
  const bs=JSON.parse((await web('B','/state')).text),as=JSON.parse((await web('A','/state')).text);assert.ok(bs.tm_tasks.some(t=>t.id===work));assert.ok(!bs.tm_meetings.some(m=>m.id===orgMeeting));assert.ok(as.tm_meetings.some(m=>m.id===orgMeeting));
  assert.equal((await mini('B','/command',{action:'tm.task.progress',data:{id:work,progress:80}})).status,403);
  assert.ok(!bs.tm_notifications.some(n=>n.task_id===work));
 });
 await check('outside task/meeting invitations require capability and never activate membership or unrelated access',async()=>{
  cmd('org.membership.request',{workspace_id:wsC,beneficiary_id:D,reason:'Member for invite check'},B);
  const denied=await mini('D','/command',{action:'tm.task.save',data:{workspace_id:wsC,title:'Denied outside invite',pic_id:Y,start_date:taskToday(),due_date:taskToday()}});assert.equal(denied.status,403);
  const t=task(C,wsC,'Explicit outside task',{pic_id:Y}),m=meeting(C,wsC,'Explicit outside meeting',120,{attendee_ids:[Y]});
  assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',wsC,Y));const view=JSON.parse((await mini('Y','/state')).text);
  assert.ok(view.tm_tasks.some(x=>x.id===t));assert.ok(view.tm_meetings.some(x=>x.id===m));assert.ok(!view.tm_tasks.some(x=>x.id===work));assert.ok(!view.tm_workspaces.some(w=>w.id===wsC));assert.equal((await web('Y',`/tasks/group?id=${orgGroup}`)).status,404);
 });
 await check('pending membership and old notification links revalidate current governor after rerouting',async()=>{
  const r=await mini('Y','/command',{action:'org.membership.request',data:{workspace_id:wsC,beneficiary_id:Y,reason:'Need workspace access',approver_id:X,approved:true,request_key:'join-api'}});assert.equal(r.status,200,r.text);const id=JSON.parse(r.text).result.id;
  assert.equal(s.get('SELECT approver_id FROM org_requests WHERE id=?',id).approver_id,B);assert.ok(s.organization.notificationVisible(B,id));
  const w=s.get('SELECT * FROM tm_workspaces WHERE id=?',wsC);cmd('org.workspace.save',{expected_revision:rev(),acknowledged:true,...w,owner_id:X,governing_manager_id:X,owner_grant_id:null,expected_version:w.version},A);
  assert.equal(s.get('SELECT approver_id FROM org_requests WHERE id=?',id).approver_id,X);assert.ok(!s.organization.notificationVisible(B,id));assert.ok(s.organization.notificationVisible(X,id));
  assert.equal((await mini('B','/command',{action:'org.request.decide',data:{id,decision:'APPROVE'}})).status,404);
  const decision=await mini('X','/command',{action:'org.request.decide',data:{id,decision:'APPROVE'}});assert.equal(decision.status,200);assert.equal((await web('X','/command',{action:'org.request.decide',data:{id,decision:'APPROVE'}})).status,200);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_members WHERE workspace_id=? AND staff_id=?',wsC,Y).n,1);
 });
 await check('forged actor, ancestor preview, cross-company session and Telegram identity cannot elevate authority',async()=>{
  const promotion={action:'org.structure.save',actor:A,data:{actor_id:A,changes:[{staff_id:Y,level:1}],reason:'Spoofed',expected_revision:rev(),acknowledged:true}};assert.equal((await web('Y','/command',promotion)).status,403);assert.equal((await mini('Y','/command',promotion)).status,403);
  assert.equal((await web('E','/command',{action:'org.preview',data:{changes:[{staff_id:A,level:1}]}})).status,403);
  const other=hub.create({name:'Isolated company',admin_name:'Other admin',admin_email:'other@review.test',admin_password:'Review-organization-2026'});
  const r=await fetch(base+`/c/${other.id}/api/organization`,{headers:{Cookie:cookies.A}});assert.equal(r.status,401);
  hub.get(other.id).run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);assert.equal((await mini('A','/organization',undefined,other.id)).status,403);
 });
 await check('scoped organization directory is searchable and paged; lower levels cannot query unrelated details',async()=>{
  const redirect=await fetch(`http://127.0.0.1:${gateway.address().port}/c/default/tg?org_request=ORGREQ-CHECK`,{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/c/default/tg/?org_request=ORGREQ-CHECK');
  const edited=await mini('B','/command',{action:'org.structure.save',data:{changes:[{staff_id:E,level:5,manager_id:D}],expected_revision:rev(),acknowledged:true,reason:'Permitted Mini App reporting update'}});assert.equal(edited.status,200,edited.text);
  const r=await web('A','/organization?view=people&limit=2&page=2');assert.equal(r.status,200);const body=JSON.parse(r.text);assert.equal(body.rows.length,2);assert.ok(body.total>=7);
  assert.equal((await web('E',`/organization?view=employee&staff_id=${Y}`)).status,404);
  const q=JSON.parse((await web('A',`/organization?view=people&q=${E}`)).text);assert.equal(q.total,1);assert.equal(q.rows[0].staff_id,E);
 });
 await check('role exclusion blocks organization reads, commands, snapshots and notifications in both clients',async()=>{
  const role=cmd('admin.role.save',{name:'Tasks without organization',permissions:{'tasks.tasks':['view'],'tasks.users':['view'],'tasks.workspace':['view']}}).id;
  const created=cmd('admin.user.save',{name:'Permission regression employee',email:'restricted@review.test',role_id:role,password:'Review-organization-2026',active:1}).id;
  assert.deepEqual(s.access.permissions(s.access.publicUser(created))['tasks.organization'],[]);
  const original=s.access.publicUser(s.access.accountFor(B).id);
  const updateAccount=settings=>{const account=s.access.publicUser(original.id);return cmd('admin.user.save',{...account,expected_version:account.version,role_id:role,function_settings:settings});};
  const signIn=async()=>{const login=await web('B','/auth/login',{email:original.email,password:'Review-organization-2026'});assert.equal(login.status,200);cookies.B=login.headers.get('set-cookie').split(';')[0];};
  const assertBlocked=async()=>{
   for(const client of [web,mini]){
    assert.equal((await client('B','/organization?view=people')).status,403);
    assert.equal((await client('B','/command',{action:'org.membership.request',data:{workspace_id:wsB,beneficiary_id:C,reason:'Blocked attempt'}})).status,403);
    const state=JSON.parse((await client('B','/state')).text);
    assert.deepEqual(state.auth.permissions['tasks.organization'],[]);
    assert.deepEqual(state.organization,{enabled:true});
    assert.ok(!state.tm_notifications.some(n=>n.org_request_id));
    assert.ok(state.auth.permissions['tasks.tasks'].includes('view'));
   }
  };
  updateAccount({});await signIn();await assertBlocked();
  const roleBefore=s.all('SELECT * FROM access_permissions WHERE role_id=? ORDER BY resource,action',role);
  updateAccount({'tasks.organization':{view:'ALLOW'}});
  assert.equal((await web('B','/state')).status,401,'editing account invalidates its old session');
  await signIn();for(const client of [web,mini])assert.equal((await client('B','/organization?view=people')).status,200);
  updateAccount({'tasks.organization':{view:'DENY'}});await signIn();await assertBlocked();
  assert.deepEqual(s.all('SELECT * FROM access_permissions WHERE role_id=? ORDER BY resource,action',role),roleBefore,'individual edits must not modify the role');
  s.run('INSERT INTO access_permissions(role_id,resource,action) VALUES(?,?,?)',role,'tasks.organization','view');
  await assertBlocked(); // Explicit Deny still wins when the role allows.
  updateAccount({});await signIn();for(const client of [web,mini])assert.equal((await client('B','/organization?view=people')).status,200);
  // Level 1 scope cannot silently override an ordinary role's function denial.
  const admin=s.access.publicUser(s.access.accountFor(A).id);
  s.run('DELETE FROM access_permissions WHERE role_id=? AND resource=?',role,'tasks.organization');
  assert.deepEqual(s.access.permissions({...admin,role_id:role})['tasks.organization'],[]);
  assert.ok(s.access.permissions(admin)['tasks.organization'].includes('view'),'protected Administrator retains full access');
  s.run("UPDATE erp_module_settings SET enabled=0 WHERE module_id='tasks'");
  assert.deepEqual(s.access.permissions(admin)['tasks.organization'],[],'company module off blocks even Administrator');
  s.run("UPDATE erp_module_settings SET enabled=1 WHERE module_id='tasks'");
 });
 console.log(`\n${checks} Organizational Structure API checks passed. Signed Telegram requests and Google access checks are local; no external accounts contacted.`);
}finally{await new Promise(r=>server.close(r));await new Promise(r=>gateway.close(r));hub.close();rmSync(folder,{recursive:true,force:true});}

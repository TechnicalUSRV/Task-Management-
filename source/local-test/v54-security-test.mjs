import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {taskToday,addDays,formatMinutes} from './task-domain.mjs';
import {GROUP_LIMITS,parseNumber,cleanText,nameKey,roundTo} from './group-domain.mjs';

// V5.4 hardening, from an independent review of the V5.4 changes: workspace membership (which opens Groups) can't be
// taken, two-party approval is never skipped, closed tasks keep their agreed record, slow inputs are refused quickly,
// groups of archived workspaces stay read-only, notifications reach only the people on a task, and groups have size
// limits. Every check runs on temporary data.
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v54-security-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;let checks=0,server;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const task=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const pending=id=>s.get("SELECT * FROM tm_change_requests WHERE task_id=? AND status='PENDING'",id);
const edit=id=>{const t=task(id);return {...t,id,expected_version:t.version,estimate:formatMinutes(t.estimate_minutes),supporter_ids:s.tasks.supportersOf(t)};};
const member=(wid,staff)=>!!s.get('SELECT 1 AS ok FROM tm_members WHERE workspace_id=? AND staff_id=?',wid,staff);
const wsInput=(wid,patch={})=>{const w=s.get('SELECT * FROM tm_workspaces WHERE id=?',wid);return {id:w.id,expected_version:w.version,name:w.name,description:w.description,department:w.department,color:w.color,owner_id:w.owner_id,member_ids:s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?',wid).map(m=>m.staff_id),...patch};};
const profileInput=(staff,active)=>{const p=s.get('SELECT * FROM tm_profiles WHERE staff_id=?',staff)||{};return {staff_id:staff,name:s.get('SELECT name FROM lookups WHERE id=?',staff).name,email:p.email||'',phone:p.phone||'',position:p.position||'',department:p.department||'',active,expected_version:p.version??0};};
const today=taskToday();
const DARA='STAFF-001',SOPHEA='STAFF-002',VANNA='STAFF-003';let CHANTHA,BOPHA,KOSAL,RITH,LINA,ws,ws2;
const staffOf=email=>s.get('SELECT staff_id FROM access_users WHERE email=?',email).staff_id;
try{
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 for(const [name,email,role] of [['Chantha · Operations','chantha@example.test','ROLE-MEMBER'],['Bopha · Viewer','bopha@example.test','ROLE-VIEWER'],['Kosal · Warehouse','kosal@example.test','ROLE-MEMBER'],['Rith · Manager','rith@example.test','ROLE-MANAGER']])
  cmd('admin.user.save',{name,email,role_id:role,password:'local-password-1',active:1},VANNA);
 // A custom role with tasks and groups but without Task Management · Users (so no team details such as positions).
 const tasksOnly=cmd('admin.role.save',{name:'Tasks only',permissions:{'tasks.tasks':['view'],'tasks.groups':['view','create','update']}},VANNA).id;
 cmd('admin.user.save',{name:'Lina · Assistant',email:'lina@example.test',role_id:tasksOnly,password:'local-password-1',active:1},VANNA);
 [CHANTHA,BOPHA,KOSAL,RITH,LINA]=['chantha','bopha','kosal','rith','lina'].map(n=>staffOf(`${n}@example.test`));
 ws=cmd('tm.workspace.save',{name:'Security QA',department:'Operations',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,CHANTHA,BOPHA,RITH,LINA]},SOPHEA).id;
 ws2=cmd('tm.workspace.save',{name:'Warehouse team',department:'Warehouse',owner_id:KOSAL,member_ids:[KOSAL]},VANNA).id;
 const port=4356,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data,raw}={})=>{const r=await fetch(base+url,{method:data||raw?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data||raw?{body:raw??JSON.stringify(data)}:{})});const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body};};
 const login=async(email,password)=>{const r=await fetch(`${base}/c/default/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,email);return r.headers.get('set-cookie').split(';')[0];};
 const C={vanna:await login('vanna@example.test','vanna-password-1'),sophea:await login('sophea@example.test','sophea-password-1'),dara:await login('dara@example.test','dara-password-12'),chantha:await login('chantha@example.test','local-password-1'),bopha:await login('bopha@example.test','local-password-1'),kosal:await login('kosal@example.test','local-password-1'),lina:await login('lina@example.test','local-password-1')};
 const api=async(who,action,data)=>request('/c/default/api/command',{cookie:C[who],data:{action,data}});
 const ok=async(who,action,data)=>{const r=await api(who,action,data);assert.equal(r.status,200,`${action}: ${JSON.stringify(r.body)}`);return r.body.result;};

 // ================================================================ workspace membership opens Groups, so it can't be taken
 const G=cmd('tm.group.save',{workspace_id:ws,name:'Workspace tracker',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT'},SOPHEA).id;
 await check('someone outside a workspace can’t make themselves a member (edit it, take a task there, or invite themselves to a meeting)',async()=>{
  // Kosal's role (Team Member) can edit workspaces in general, but not one he doesn't belong to.
  let r=await api('kosal','tm.workspace.save',wsInput(ws,{member_ids:[...wsInput(ws).member_ids,KOSAL]}));assert.equal(r.status,403);assert.match(r.body.error,/Only members of this workspace/);
  r=await api('kosal','tm.workspace.save',wsInput(ws,{owner_id:KOSAL}));assert.equal(r.status,403);
  r=await api('kosal','tm.task.save',{workspace_id:ws,title:'Let me in',start_date:today,due_date:addDays(today,2),pic_id:KOSAL});assert.equal(r.status,403);assert.match(r.body.error,/aren’t a member of the workspace “Security QA”/);
  r=await api('kosal','tm.meeting.save',{workspace_id:ws,title:'Sync',organizer_id:KOSAL,attendee_ids:[KOSAL],start_at:addDays(today,1)+'T09:00:00+07:00',end_at:addDays(today,1)+'T09:30:00+07:00',status:'SCHEDULED'});assert.equal(r.status,403);
  assert.equal(member(ws,KOSAL),false);assert.equal((await request(`/c/default/api/tasks/group?id=${G}`,{cookie:C.kosal})).status,404,'the workspace group stays closed');
  // He may still give a task in that workspace to one of its members; that doesn't make him a member.
  const id=(await ok('kosal','tm.task.save',{workspace_id:ws,title:'Count the pallets',start_date:today,due_date:addDays(today,2),pic_id:CHANTHA})).id;
  assert.equal(task(id).pic_id,CHANTHA);assert.equal(member(ws,KOSAL),false);
 });
 await check('members edit a workspace’s details; only its owner and workspace managers change its owner or members',async()=>{
  const r=await api('dara','tm.workspace.save',wsInput(ws,{member_ids:[...wsInput(ws).member_ids,KOSAL]}));assert.equal(r.status,403);assert.match(r.body.error,/owner or a workspace manager/);
  assert.equal((await api('dara','tm.workspace.save',wsInput(ws,{owner_id:DARA}))).status,403);
  await ok('dara','tm.workspace.save',wsInput(ws,{description:'Shared by the operations team.'}));assert.equal(s.get('SELECT description FROM tm_workspaces WHERE id=?',ws).description,'Shared by the operations team.');
  // The owner adds and removes members; a Manager (Workspace Delete) can too.
  await ok('sophea','tm.workspace.save',wsInput(ws,{member_ids:[...wsInput(ws).member_ids,KOSAL]}));assert.equal(member(ws,KOSAL),true);
  await ok('vanna','tm.workspace.save',wsInput(ws,{member_ids:wsInput(ws).member_ids.filter(x=>x!==KOSAL)}));assert.equal(member(ws,KOSAL),false);
 });
 await check('members still add people by choosing them for work; a task request lets its asker’s workspace take in the person asked',async()=>{
  // Dara (a member) chooses Kosal as supporting person: Kosal joins the workspace, as in V5.3.
  const id=(await ok('dara','tm.task.save',{workspace_id:ws,title:'Load the truck',start_date:today,due_date:addDays(today,3),pic_id:DARA,supporter_ids:[KOSAL]})).id;
  assert.equal(member(ws,KOSAL),true);assert.ok(task(id));
  await ok('sophea','tm.workspace.save',wsInput(ws,{member_ids:wsInput(ws).member_ids.filter(x=>x!==KOSAL)}).member_ids?wsInput(ws,{member_ids:wsInput(ws).member_ids}):null).catch(()=>{});
  // Remove Kosal again (his supporting role is declined first so he has no open work there).
  cmd('tm.task.decline',{id,note:'Not my team',role:'supporter'},KOSAL);
  await ok('sophea','tm.workspace.save',wsInput(ws,{member_ids:wsInput(ws).member_ids.filter(x=>x!==KOSAL)}));assert.equal(member(ws,KOSAL),false);
  // Dara asks Kosal (not a member) to do a task in her workspace; accepting it adds him on her authority.
  const q=(await ok('dara','tm.request.save',{title:'Check the forklift',manager_id:KOSAL,doer:'RECEIVER',workspace_id:ws,proposed_due_date:addDays(today,4)})).id;
  const t=(await ok('kosal','tm.request.decide',{id:q,decision:'APPROVE'})).id;
  assert.equal(task(t).pic_id,KOSAL);assert.equal(member(ws,KOSAL),true,'the request’s asker (a member) agreed');
 });

 // ================================================================ approval is never skipped
 await check('a Team Member can’t make someone else inactive; approvals go to someone who can still decide, or are refused',async()=>{
  // Rith (Manager) gives Dara a task and has no other open work, so he could be made inactive.
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Deliver the quotation',start_date:today,due_date:addDays(today,5),pic_id:DARA,reviewer_id:RITH},RITH).id;cmd('tm.task.accept',{id},DARA);
  let r=await api('dara','tm.profile.save',profileInput(RITH,0));assert.equal(r.status,403);assert.match(r.body.error,/Only managers and administrators/);
  assert.equal((await api('dara','tm.profile.save',{...profileInput(DARA,1),phone:'012 345 678'})).status,200,'people still edit their own profile');
  // An administrator makes Rith inactive (he has no open assignments): Dara's change still needs someone's approval.
  await ok('vanna','tm.profile.save',profileInput(RITH,0));
  const h=cmd('tm.task.handover',{id,to_id:CHANTHA},DARA);assert.ok(h.change_id,'not applied directly');assert.equal(task(id).pic_id,DARA);
  const approver=pending(id).approver_id;assert.notEqual(approver,RITH);assert.ok([SOPHEA,VANNA].includes(approver),'someone whose role has Tasks Approve');
  cmd('tm.change.withdraw',{id:h.change_id},DARA);
  const c=cmd('tm.task.cancel',{id,reason:'Not needed'},DARA);assert.ok(c.change_id);assert.equal(task(id).status,'IN_PROGRESS');cmd('tm.change.withdraw',{id:c.change_id},DARA);
  // If nobody at all can decide, the change is refused rather than applied.
  // If nobody at all can decide (no other role with Tasks Approve, and the administrator can't use Task Management),
  // the change is refused rather than applied. (Changed directly in this temporary database, and put back.)
  const approvers=s.all("SELECT * FROM access_permissions WHERE resource='tasks.tasks' AND action='approve'"),vannaProfile=s.get('SELECT * FROM tm_profiles WHERE staff_id=?',VANNA);
  s.run("DELETE FROM access_permissions WHERE resource='tasks.tasks' AND action='approve'");
  s.run("INSERT INTO tm_profiles(staff_id,email,phone,position,department,active,version) VALUES(?,'','','','',0,0) ON CONFLICT(staff_id) DO UPDATE SET active=0",VANNA);
  try{fails(()=>cmd('tm.task.handover',{id,to_id:CHANTHA},DARA),/can’t approve changes any more/,409);fails(()=>cmd('tm.task.cancel',{id,reason:'x'},DARA),/can’t approve changes any more/,409);}
  finally{
   for(const p of approvers)s.run('INSERT INTO access_permissions(role_id,resource,action) VALUES(?,?,?)',p.role_id,p.resource,p.action);
   if(vannaProfile)s.run('UPDATE tm_profiles SET active=? WHERE staff_id=?',vannaProfile.active,VANNA);else s.run('DELETE FROM tm_profiles WHERE staff_id=?',VANNA);
  }
  assert.equal(task(id).pic_id,DARA);assert.equal(task(id).status,'IN_PROGRESS');
  await ok('vanna','tm.profile.save',profileInput(RITH,1));
 });
 await check('a completed task both sides agreed to keeps its record: its details change only with approval, and a new person in charge accepts first',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Pack samples',start_date:today,due_date:addDays(today,5),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  cmd('tm.task.submit',{id,note:'Done'},DARA);cmd('tm.task.close',{id},SOPHEA);assert.equal(task(id).status,'COMPLETED');
  // Sophea changes the person in charge of the completed task: Dara approves first.
  const r=cmd('tm.task.save',{...edit(id),title:'Pack samples (redo)',pic_id:CHANTHA},SOPHEA);assert.ok(r.change_id);assert.equal(task(id).pic_id,DARA);
  cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},DARA);
  let t=task(id);assert.equal(t.pic_id,CHANTHA);assert.equal(t.title,'Pack samples (redo)');assert.equal(t.accepted_at,null,'Chantha has not accepted it');
  // Reopened, it waits for Chantha to accept (she can also reject it).
  cmd('tm.task.reopen',{id,note:'Needs another pass'},SOPHEA);t=task(id);assert.equal(t.status,'NOT_STARTED');
  cmd('tm.task.decline',{id,note:'I’m on leave'},CHANTHA);assert.ok(task(id).declined_at);
  // The person in charge's edits of a completed two-sided task go to the assigner too.
  const id2=cmd('tm.task.save',{workspace_id:ws,title:'Count stock',start_date:today,due_date:addDays(today,3),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id:id2},DARA);
  cmd('tm.task.submit',{id:id2},DARA);cmd('tm.task.close',{id:id2},SOPHEA);
  const p=cmd('tm.task.save',{...edit(id2),description:'Count aisle 1 only'},DARA);assert.ok(p.change_id);assert.notEqual(task(id2).description,'Count aisle 1 only');cmd('tm.change.decide',{id:p.change_id,decision:'APPROVE'},SOPHEA);assert.equal(task(id2).description,'Count aisle 1 only');
  // A task someone gave themselves stays theirs to edit.
  const own=cmd('tm.task.save',{workspace_id:ws,title:'My notes',start_date:today,due_date:addDays(today,1),pic_id:DARA},DARA).id;cmd('tm.task.close',{id:own},DARA);
  assert.equal(cmd('tm.task.save',{...edit(own),title:'My notes (final)'},DARA).change_id,undefined);assert.equal(task(own).title,'My notes (final)');
 });

 // ================================================================ notifications
 await check('notifications reach only the people on the task: not a creator who handed it over, not a reviewer who stepped down',()=>{
  const notes=(staff,id)=>s.all('SELECT kind FROM tm_notifications WHERE staff_id=? AND task_id=? ORDER BY id',staff,id).map(n=>n.kind);
  // Chantha asks Dara for a task; Dara takes it on (creator Dara, assigner Chantha), then hands it over to Bopha... Bopha
  // is a Viewer, so to Sophea.
  const q=cmd('tm.request.save',{title:'Quote for spare parts',manager_id:DARA,doer:'RECEIVER',workspace_id:ws,proposed_due_date:addDays(today,5)},CHANTHA).id;
  const id=cmd('tm.request.decide',{id:q,decision:'APPROVE'},DARA).id;
  const h=cmd('tm.task.handover',{id,to_id:SOPHEA,keep:false},DARA);cmd('tm.change.decide',{id:h.change_id,decision:'APPROVE'},CHANTHA);cmd('tm.task.accept',{id},SOPHEA);
  const before=notes(DARA,id).length;
  cmd('tm.task.stuck',{id,reason:'Supplier closed'},SOPHEA);cmd('tm.task.note',{id,note:'Internal price note'},SOPHEA);
  assert.deepEqual(notes(DARA,id).slice(before),[],'Dara is no longer on the task');
  assert.ok(notes(CHANTHA,id).includes('task_note'),'the assigner still hears about it');
  // A reviewer who stepped down is not told when the person in charge accepts.
  const id2=cmd('tm.task.save',{workspace_id:ws,title:'Check the invoices',start_date:today,due_date:addDays(today,4),pic_id:DARA,reviewer_id:BOPHA},SOPHEA).id;
  cmd('tm.task.decline',{id:id2,note:'Not my area',role:'reviewer'},BOPHA);const b=notes(BOPHA,id2).length;
  cmd('tm.task.accept',{id:id2},DARA);assert.deepEqual(notes(BOPHA,id2).slice(b),[]);
 });

 // ================================================================ Groups
 await check('slow-input attacks are refused at once (long numbers, long trailing spaces), also over HTTP',async()=>{
  const time=fn=>{const t=performance.now();const r=fn();return [r,performance.now()-t];};
  let [r,ms]=time(()=>parseNumber('1'.repeat(80000)+'x'));assert.equal(r.ok,false);assert.ok(ms<50,`number check took ${ms} ms`);
  [r,ms]=time(()=>cleanText('a'+' '.repeat(3_000_000)+'b'));assert.equal(r.ok,false);assert.ok(ms<200,`text check took ${ms} ms`);
  [r,ms]=time(()=>cleanText('a'+' '.repeat(9000)+'b'+' '.repeat(9000)));assert.equal(r.ok,true);assert.equal(r.value.length,9002,'trailing spaces removed');assert.ok(ms<50);
  assert.deepEqual([parseNumber('12,345.5').value,parseNumber('-1e3').value,parseNumber('.5').value,parseNumber('5.').value,parseNumber('1e').ok],[12345.5,-1000,0.5,5,false]);
  assert.equal(roundTo(1.5e-7,7),2e-7,'rounding numbers written with an exponent');
  const g=(await ok('dara','tm.group.save',{workspace_id:ws,name:'Speed',visibility:'PERSONAL'})).id;
  const num=(await ok('dara','tm.group.column.save',{group_id:g,name:'Amount',type:'NUMBER'})).id;
  const t0=performance.now(),res=await api('dara','tm.group.row.add',{group_id:g,values:{[num]:'1'.repeat(60000)+'x'}});
  assert.equal(res.status,422);assert.ok(performance.now()-t0<1000,'answered quickly');
 });
 await check('groups of an archived workspace can’t be archived, restored or deleted',async()=>{
  const w=cmd('tm.workspace.save',{name:'Old project',owner_id:DARA,member_ids:[DARA]},DARA).id;
  const g=cmd('tm.group.save',{workspace_id:w,name:'Old list',visibility:'PERSONAL'},DARA).id;cmd('tm.group.row.add',{group_id:g},DARA);
  cmd('tm.workspace.archive',{id:w,expected_version:0,status:'ARCHIVED'},DARA);
  const version=s.get('SELECT version FROM tm_boards WHERE id=?',g).version;
  for(const [action,data] of [['tm.group.archive',{id:g,expected_version:version,status:'ARCHIVED'}],['tm.group.delete',{id:g,expected_version:version,confirm:true}]]){
   const r=await api('dara',action,data);assert.equal(r.status,409,action);assert.match(r.body.error,/workspace is archived/);
  }
  const read=(await request(`/c/default/api/tasks/group?id=${g}`,{cookie:C.dara})).body;
  assert.equal(read.group.caps.archive,false);assert.equal(read.group.caps.addRows,false);assert.equal(read.group.workspace_status,'ARCHIVED');
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_board_rows WHERE board_id=?',g).n,1,'nothing was deleted');
 });
 await check('the people search of a group shows job positions only to roles that can see team details',async()=>{
  cmd('tm.profile.save',{...profileInput(DARA,1),position:'Senior negotiator (probation)'},VANNA);
  const members=async who=>(await request(`/c/default/api/tasks/group/members?id=${G}&q=`,{cookie:C[who]})).body.items.find(p=>p.id===DARA);
  assert.equal((await members('lina')).position,'','a role without Users · View');
  assert.equal((await request('/c/default/api/state',{cookie:C.lina})).body.tm_profiles.find(p=>p.staff_id===DARA).position,'','the same as in the ERP’s other screens');
  assert.equal((await members('chantha')).position,'Senior negotiator (probation)','Team Members can see team details');
  assert.equal((await request(`/c/default/api/tasks/group/members?id=${G}&q=probation`,{cookie:C.lina})).body.total,0,'hidden positions are not searchable either');
 });
 await check('status labels can’t repeat, and column names that only differ by invisible characters are the same name',async()=>{
  const st=(await ok('sophea','tm.group.column.save',{group_id:G,name:'Stage',type:'STATUS'})).id;
  const col=s.get('SELECT * FROM tm_board_columns WHERE id=?',st),labels=JSON.parse(col.settings_json).labels;
  const r=await api('sophea','tm.group.column.save',{group_id:G,id:st,expected_version:col.version,name:'Stage',type:'STATUS',settings:{labels:[{id:labels[0].id,name:'Open'},{id:labels[0].id,name:'Closed'}]}});
  assert.equal(r.status,400);assert.match(r.body.error,/only once/);
  await ok('sophea','tm.group.column.save',{group_id:G,name:'Unit Price',type:'NUMBER'});
  const dup=await api('sophea','tm.group.column.save',{group_id:G,name:'Unit\u200b Price',type:'NUMBER'});
  assert.equal(nameKey('Unit\u200b Price'),nameKey('Unit Price'));assert.equal(dup.status,409);assert.match(dup.body.error,/already has a column named/);
 });
 await check('a row, a group and a workspace have size limits',async()=>{
  const g=(await ok('dara','tm.group.save',{workspace_id:ws,name:'Big texts',visibility:'PERSONAL'})).id;
  const cols=[];for(let i=1;i<=11;i++)cols.push((await ok('dara','tm.group.column.save',{group_id:g,name:`Notes ${i}`,type:'TEXT'})).id);
  const long='ក'.repeat(9990);
  const tooBig=await api('dara','tm.group.row.add',{group_id:g,values:Object.fromEntries(cols.map(c=>[c,long]))});
  assert.equal(tooBig.status,422);assert.match(tooBig.body.error,/row is too large/);
  const row=(await ok('dara','tm.group.row.add',{group_id:g,values:Object.fromEntries(cols.slice(0,9).map(c=>[c,long]))})).id;
  const grow=await api('dara','tm.group.row.update',{group_id:g,id:row,values:{[cols[9]]:long,[cols[10]]:long},expected:{[cols[9]]:null,[cols[10]]:null}});
  assert.equal(grow.status,422,'growing a row past the limit is refused too');
  assert.equal((await api('dara','tm.group.row.update',{group_id:g,id:row,values:{[cols[0]]:'short'},expected:{[cols[0]]:long}})).status,200,'shrinking is always allowed');
  // The group total (limit lowered for this check only).
  const saved=GROUP_LIMITS.groupChars;GROUP_LIMITS.groupChars=200000;
  try{
   await ok('dara','tm.group.row.add',{group_id:g,values:Object.fromEntries(cols.slice(0,9).map(c=>[c,long]))});
   const full=await api('dara','tm.group.row.add',{group_id:g,values:Object.fromEntries(cols.slice(0,9).map(c=>[c,long]))});
   assert.equal(full.status,422);assert.match(full.body.error,/group is full/);
  }finally{GROUP_LIMITS.groupChars=saved;}
  const savedGroups=GROUP_LIMITS.groups;GROUP_LIMITS.groups=s.get('SELECT COUNT(*) n FROM tm_boards WHERE workspace_id=?',ws).n;
  try{const r=await api('dara','tm.group.save',{workspace_id:ws,name:'One too many',visibility:'PERSONAL'});assert.equal(r.status,409);assert.match(r.body.error,/the most it can hold/);}
  finally{GROUP_LIMITS.groups=savedGroups;}
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');
 });

 console.log(`\n${checks} V5.4 hardening checks passed (membership, approvals, closed tasks, notifications, Groups limits). Temporary data only.`);
}finally{
 if(server)await new Promise(r=>server.close(r));
 hub.close();rmSync(folder,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {createLocalServer} from './server.mjs';
import {taskToday,addDays,enrichedTasks,taskActions,nextOccurrence,waitingFor,REQUEST_STATUS} from './task-domain.mjs';
import {qrMatrix} from './qr.mjs';

// V5.3 Task Management: open assignment (anyone with Task Management), confirmations by supporting people and
// reviewers, cancelling by the person in charge and the reviewer, requests between any two people, profile names
// and photos, checklists, files, hand-over, reminders, repeating tasks and Telegram links that do not expire.
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v53-')),filename=path.join(folder,'test.sqlite');
let s=openStore(filename),checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
// V5.5: on a task someone else assigned, a new progress figure waits for the other side's approval. Checks written for
// earlier versions approve it straight away, so they keep testing what they were written for.
const approveChange=r=>r&&r.change_id?s.command('tm.change.decide',{id:r.change_id,decision:'APPROVE'},s.get('SELECT approver_id FROM tm_change_requests WHERE id=?',r.change_id).approver_id):r;
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const task=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const support=(id,staff)=>s.get('SELECT * FROM tm_assignees WHERE task_id=? AND staff_id=?',id,staff);
const notes=(staff,kind)=>s.all('SELECT * FROM tm_notifications WHERE staff_id=? AND kind=? ORDER BY id',staff,kind);
const enriched=id=>enrichedTasks(s.state()).find(t=>t.id===id);
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==','base64');
const DARA='STAFF-001',SOPHEA='STAFF-002',VANNA='STAFF-003';let CHANTHA,FINANCE,NOLOGIN,ws,server;
try{
 seedDemo(s);
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 cmd('admin.user.save',{name:'Chantha · Viewer',email:'chantha@example.test',role_id:'ROLE-VIEWER',password:'chantha-password',active:1},VANNA);
 CHANTHA=s.get("SELECT staff_id FROM access_users WHERE email='chantha@example.test'").staff_id;
 const financeRole=cmd('admin.role.save',{name:'Finance only',permissions:{'ops.finance':['view']}},VANNA).id;
 cmd('admin.user.save',{name:'Rotha · Finance',email:'rotha@example.test',role_id:financeRole,password:'rotha-password-1',active:1},VANNA);
 FINANCE=s.get("SELECT staff_id FROM access_users WHERE email='rotha@example.test'").staff_id;
 NOLOGIN=cmd('tm.profile.save',{name:'Kosal · Driver',active:1},VANNA).id;
 ws=cmd('tm.workspace.save',{name:'V5.3 QA',department:'Operations',owner_id:SOPHEA,member_ids:[SOPHEA]},SOPHEA).id;

 await check('upgrade to schema 9: people already on tasks count as accepted; sample supporters answered',()=>{
  assert.ok(s.get('SELECT version FROM schema_version WHERE version=9'));
  for(const col of ['reviewer_status','recurrence','series_id','next_task_id','scheduled_due','series_anchor'])assert.ok(s.all('PRAGMA table_info(tm_tasks)').some(c=>c.name===col),col);
  assert.ok(s.all('PRAGMA table_info(tm_assignees)').some(c=>c.name==='status'));assert.ok(s.all('PRAGMA table_info(tm_requests)').some(c=>c.name==='doer'));
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_tasks WHERE reviewer_status<>'ACCEPTED'").n,0);
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
 });

 await check('everyone with Task Management can be chosen and is added to the workspace; others get a clear message',()=>{
  const people=s.access.taskPeople().map(p=>p.staff_id).sort();
  assert.deepEqual(people,[DARA,SOPHEA,VANNA,CHANTHA].sort(),'all roles with Task Management, including Viewer; not Finance-only or people without a login');
  assert.equal(s.access.taskPeople().find(p=>p.staff_id===VANNA).signed_in,true,'the administrator who set up the ERP has used it');
  assert.equal(s.access.taskPeople().find(p=>p.staff_id===DARA).signed_in,false,'a new login has not been used yet');
  s.access.login('dara@example.test','dara-password-12','127.0.0.1');assert.equal(s.access.taskPeople().find(p=>p.staff_id===DARA).signed_in,true);
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Count pallets in bay 3',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:CHANTHA,supporter_ids:[DARA]},SOPHEA).id;
  assert.equal(task(id).pic_id,CHANTHA);
  for(const who of [CHANTHA,DARA])assert.ok(s.get('SELECT 1 AS ok FROM tm_members WHERE workspace_id=? AND staff_id=?',ws,who),'added to the workspace');
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:taskToday(),pic_id:FINANCE},SOPHEA),/can’t open Task Management/);
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:taskToday(),pic_id:DARA,reviewer_id:FINANCE},SOPHEA),/can’t open Task Management/);
 });

 let t1;
 await check('supporting people and the reviewer confirm: accept or reject (with a reason), and are told when asked',()=>{
  t1=cmd('tm.task.save',{workspace_id:ws,title:'Prepare the customs file',start_date:taskToday(),due_date:addDays(taskToday(),5),pic_id:DARA,supporter_ids:[CHANTHA,SOPHEA],reviewer_id:VANNA},SOPHEA).id;
  assert.equal(support(t1,CHANTHA).status,'PENDING');assert.equal(support(t1,SOPHEA).status,'ACCEPTED','choosing yourself needs no confirmation');
  assert.equal(task(t1).reviewer_status,'PENDING');
  assert.match(notes(CHANTHA,'task_supporting').at(-1).body,/please accept or reject/);assert.match(notes(VANNA,'task_reviewer').at(-1).title,/Review request/);
  let t=enriched(t1);assert.deepEqual(t.waiting.map(w=>w.role).sort(),['pic','reviewer','supporter']);
  assert.deepEqual(taskActions(t,CHANTHA).allowed.sort(),['accept','decline','file','note'].sort(),'a supporting person answers first');
  fails(()=>cmd('tm.task.decline',{id:t1},CHANTHA),/Reason for rejecting/);
  cmd('tm.task.decline',{id:t1,note:'I am at the port all week.'},CHANTHA);
  assert.equal(support(t1,CHANTHA).status,'DECLINED');assert.match(notes(SOPHEA,'support_declined').at(-1).body,/port all week/);assert.match(notes(DARA,'support_declined').at(-1).body,/port all week/);
  assert.equal(cmd('tm.task.decline',{id:t1,note:'again'},CHANTHA).unchanged,true);
  t=enriched(t1);assert.ok(!t.supporters.includes(CHANTHA));assert.equal(t.declined_supporters[0].staff_id,CHANTHA);
  fails(()=>cmd('tm.task.note',{id:t1,note:'Hello'},CHANTHA),/Only people working/,403);
  // Accepting after all brings them back.
  cmd('tm.task.accept',{id:t1},CHANTHA);assert.equal(support(t1,CHANTHA).status,'ACCEPTED');assert.equal(notes(SOPHEA,'support_accepted').at(-1).task_id,t1);
  // The reviewer accepts; the person in charge accepts (their own answer is separate).
  const r=cmd('tm.task.accept',{id:t1},VANNA);assert.match(r.message,/reviewer/);assert.equal(task(t1).reviewer_status,'ACCEPTED');assert.equal(task(t1).accepted_at,null);
  assert.equal(cmd('tm.task.accept',{id:t1},VANNA).unchanged,true);
  cmd('tm.task.accept',{id:t1},DARA);assert.equal(task(t1).status,'IN_PROGRESS');assert.deepEqual(enriched(t1).waiting,[]);
  fails(()=>cmd('tm.task.decline',{id:t1,note:'x'},DARA),/already accepted/,409);
  fails(()=>cmd('tm.task.accept',{id:t1},FINANCE),/not found/,404);
 });

 await check('a reviewer who rejects stops being the reviewer; V5.4: the completion request goes on to the assigner',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Renew the forklift licence',start_date:taskToday(),due_date:addDays(taskToday(),4),pic_id:DARA,reviewer_id:CHANTHA},VANNA).id;
  cmd('tm.task.accept',{id},DARA);cmd('tm.task.submit',{id,note:'Forms ready.'},DARA);
  assert.equal(task(id).submitted_to,CHANTHA);
  cmd('tm.task.decline',{id,note:'Vanna should review licences.'},CHANTHA);
  let t=task(id);assert.equal(t.reviewer_status,'DECLINED');assert.equal(t.status,'IN_REVIEW');assert.equal(t.submitted_to,VANNA,'the work goes on to the assigner, who approves completing it');
  assert.match(notes(VANNA,'review_declined').at(-1).body,/review licences/);assert.match(notes(DARA,'review_declined').at(-1).body,/review licences/);
  assert.match(notes(VANNA,'task_submitted').at(-1).title,/Approval needed/);
  assert.equal(cmd('tm.task.submit',{id},DARA).unchanged,true,'already waiting for approval');
  fails(()=>cmd('tm.task.cancel',{id,reason:'x'},CHANTHA),/Only the person in charge, the reviewer or the person who assigned/,403);
  cmd('tm.task.return',{id,note:'Attach the insurance certificate.'},VANNA);assert.equal(task(id).status,'IN_PROGRESS');
  // The person in charge's new due date goes to the assigner for approval.
  const due=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),9),reason:'Office closed.'},DARA);
  assert.equal(s.get('SELECT approver_id FROM tm_change_requests WHERE id=?',due.change_id).approver_id,VANNA);
  cmd('tm.change.decide',{id:due.change_id,decision:'APPROVE'},VANNA);assert.equal(task(id).due_date,addDays(taskToday(),9));
  // A new reviewer (asked for by the assigner, approved by Dara) confirms the role; a pending reviewer who acts on the task has accepted it.
  const next=cmd('tm.task.save',{...task(id),expected_version:task(id).version,reviewer_id:SOPHEA},VANNA);cmd('tm.change.decide',{id:next.change_id,decision:'APPROVE'},DARA);
  assert.equal(task(id).reviewer_id,SOPHEA);assert.equal(task(id).reviewer_status,'PENDING');
  cmd('tm.task.submit',{id},DARA);assert.equal(task(id).submitted_to,SOPHEA);cmd('tm.task.return',{id,note:'Add the insurance page.'},SOPHEA);
  t=task(id);assert.equal(t.reviewer_status,'ACCEPTED');assert.equal(t.status,'IN_PROGRESS');
 });

 await check('cancelling: V5.4 the person in charge asks the assigner once they accepted; the assigner’s side cancels before that; supporting people cannot',()=>{
  const mk=()=>cmd('tm.task.save',{workspace_id:ws,title:'Book a truck',start_date:taskToday(),due_date:addDays(taskToday(),1),pic_id:DARA,supporter_ids:[CHANTHA],reviewer_id:SOPHEA},VANNA).id;
  const a=mk();fails(()=>cmd('tm.task.cancel',{id:a,reason:'x'},CHANTHA),/Only the person in charge, the reviewer/,403);
  fails(()=>cmd('tm.task.cancel',{id:a,reason:'x'},DARA),/reject it instead/,409);
  cmd('tm.task.accept',{id:a},DARA);
  const asked=cmd('tm.task.cancel',{id:a,reason:'Customer cancelled the order.'},DARA);assert.match(asked.message,/Sent to Vanna/);assert.equal(task(a).status,'IN_PROGRESS');
  cmd('tm.change.decide',{id:asked.change_id,decision:'APPROVE'},VANNA);assert.equal(task(a).status,'CANCELLED');assert.equal(task(a).reason,'Customer cancelled the order.');
  assert.match(notes(SOPHEA,'task_cancelled').at(-1).body,/Customer cancelled/);
  const b=mk();cmd('tm.task.cancel',{id:b,reason:'Duplicate of another task.'},SOPHEA);assert.equal(task(b).status,'CANCELLED');assert.equal(task(b).reviewer_status,'ACCEPTED');
  const c=mk();assert.ok(!taskActions(enriched(c),DARA).allowed.includes('cancel'),'before accepting, the person in charge rejects instead');
  cmd('tm.task.accept',{id:c},DARA);assert.ok(taskActions(enriched(c),DARA).allowed.includes('cancel'));
 });

 await check('requests go from anyone to anyone; the person asked does the work, or the requester, or it is decided',()=>{
  fails(()=>cmd('tm.request.save',{title:'x',manager_id:DARA},DARA),/can’t send a request to yourself/);
  fails(()=>cmd('tm.request.save',{title:'x',manager_id:NOLOGIN},DARA),/no ERP login/);
  fails(()=>cmd('tm.request.save',{title:'x',manager_id:FINANCE},DARA),/can’t open Task Management/);
  // A team member asks a viewer to do something; the viewer accepts and is in charge; the requester reviews.
  const q=cmd('tm.request.save',{title:'Photograph the damaged cartons',manager_id:CHANTHA,doer:'RECEIVER',workspace_id:ws,proposed_due_date:addDays(taskToday(),2),request_key:'peer-1'},DARA).id;
  assert.match(notes(CHANTHA,'request_new').at(-1).body,/asks you to do this task/);
  const r=cmd('tm.request.decide',{id:q,decision:'APPROVE'},CHANTHA),made=task(r.id);
  assert.equal(made.pic_id,CHANTHA);assert.ok(made.accepted_at);assert.equal(made.reviewer_id,DARA);assert.equal(made.reviewer_status,'ACCEPTED');assert.equal(made.created_by,CHANTHA);
  assert.match(notes(DARA,'request_approved').at(-1).body,/Chantha · Viewer will do it/);
  // The requester asks to take something on (as in V5.2).
  const q2=cmd('tm.request.save',{title:'Lead the stock count',manager_id:SOPHEA,doer:'REQUESTER',workspace_id:ws,proposed_due_date:addDays(taskToday(),3)},DARA).id;
  const made2=task(cmd('tm.request.decide',{id:q2,decision:'APPROVE'},SOPHEA).id);assert.equal(made2.pic_id,DARA);assert.ok(made2.accepted_at);assert.equal(made2.reviewer_id,SOPHEA);
  // "Let them decide": the person asked chooses who does it; that person accepts.
  const q3=cmd('tm.request.save',{title:'Fix the loading ramp',manager_id:SOPHEA,doer:'DECIDE'},DARA).id;
  fails(()=>cmd('tm.request.decide',{id:q3,decision:'APPROVE',workspace_id:ws,due_date:addDays(taskToday(),5)},SOPHEA),/person in charge/);
  const made3=task(cmd('tm.request.decide',{id:q3,decision:'APPROVE',workspace_id:ws,due_date:addDays(taskToday(),5),pic_id:VANNA},SOPHEA).id);
  assert.equal(made3.pic_id,VANNA);assert.equal(made3.accepted_at,null);
  // Passing a request on to anyone, and privacy of requests.
  const q4=cmd('tm.request.save',{title:'Order safety boots',manager_id:CHANTHA,doer:'RECEIVER'},DARA).id;
  cmd('tm.request.forward',{id:q4,manager_id:SOPHEA,note:'Sophea buys equipment.'},CHANTHA);assert.equal(s.get('SELECT manager_id FROM tm_requests WHERE id=?',q4).manager_id,SOPHEA);
  // V5.6.8: once passed on, the request is no longer Chantha's to see: it is answered as if it did not exist.
  fails(()=>cmd('tm.request.decide',{id:q4,decision:'DECLINE',note:'x'},CHANTHA),/not found/,404);
 });

 await check('the person in charge hands a task over; the new person accepts; the old one can stay as supporting',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Audit the September invoices',start_date:taskToday(),due_date:addDays(taskToday(),6),pic_id:DARA},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);approveChange(cmd('tm.task.progress',{id,progress:40},DARA));
  fails(()=>cmd('tm.task.handover',{id,to_id:VANNA},SOPHEA),/Only the person in charge can hand/,403);
  fails(()=>cmd('tm.task.handover',{id,to_id:DARA},DARA),/someone other/);
  // V5.4: the hand-over changes the person in charge, so Sophea (who assigned the task) approves it first.
  const ho=cmd('tm.task.handover',{id,to_id:CHANTHA,keep:true,note:'I am travelling.'},DARA);assert.match(ho.message,/Sent to Sophea/);assert.equal(task(id).pic_id,DARA);
  assert.match(notes(SOPHEA,'change_request').at(-1).body,/person in charge Dara · Sales → Chantha/);
  cmd('tm.change.decide',{id:ho.change_id,decision:'APPROVE'},SOPHEA);
  let t=task(id);assert.equal(t.pic_id,CHANTHA);assert.equal(t.accepted_at,null);assert.equal(t.progress,40);assert.equal(support(id,DARA).status,'ACCEPTED');
  assert.match(notes(CHANTHA,'task_assigned').at(-1).title,/Handed over to you/);assert.equal(notes(DARA,'change_approved').at(-1).task_id,id);
  assert.equal(s.get("SELECT kind FROM tm_task_history WHERE task_id=? ORDER BY id DESC LIMIT 1",id).kind,'handover');
  cmd('tm.task.accept',{id},CHANTHA);assert.ok(task(id).accepted_at);
 });

 await check('reminders reach the people who have not answered (not more than every 30 minutes)',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Update the safety sheet',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA,supporter_ids:[CHANTHA]},SOPHEA).id;
  fails(()=>cmd('tm.task.remind',{id},CHANTHA),/Only the person in charge or the task’s manager/,403);
  const r=cmd('tm.task.remind',{id},SOPHEA);assert.match(r.message,/Dara · Sales, Chantha · Viewer/);
  for(const who of [DARA,CHANTHA])assert.equal(notes(who,'task_reminder').at(-1).task_id,id);
  fails(()=>cmd('tm.task.remind',{id},SOPHEA),/less than 30 minutes/,409);
  cmd('tm.task.accept',{id},DARA);cmd('tm.task.accept',{id},CHANTHA);
  s.run("UPDATE tm_task_history SET created_at=? WHERE task_id=? AND kind='remind'",new Date(Date.now()-3600000).toISOString(),id);
  fails(()=>cmd('tm.task.remind',{id},SOPHEA),/Nobody on this task is waiting/,409);
 });

 await check('checklists (V5.5 Steps of Work): ticking starts the work but never changes progress; managers and workers edit',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Pack the export shipment',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA,supporter_ids:[CHANTHA],checklist:['Print labels','Wrap pallets','','Load the truck']},SOPHEA).id;
  const items=()=>s.all('SELECT * FROM tm_checklist WHERE task_id=? ORDER BY position',id);
  assert.deepEqual(items().map(i=>i.title),['Print labels','Wrap pallets','Load the truck']);
  fails(()=>cmd('tm.check.toggle',{id:items()[0].id,done:true},CHANTHA),/must accept this task first/,409);
  cmd('tm.check.toggle',{id:items()[0].id,done:true},DARA);
  let t=task(id);assert.equal(t.status,'IN_PROGRESS');assert.ok(t.accepted_at,'ticking accepts for the person in charge');assert.equal(t.progress,0,'V5.5: steps never change progress');
  cmd('tm.check.add',{task_id:id,title:'Photograph the seal'},SOPHEA);assert.equal(task(id).progress,0);
  cmd('tm.check.toggle',{id:items()[1].id,done:true},CHANTHA);assert.equal(support(id,CHANTHA).status,'ACCEPTED','ticking accepts for a supporting person');
  for(const i of items())cmd('tm.check.toggle',{id:i.id,done:true},DARA);assert.equal(task(id).progress,0);assert.equal(task(id).status,'IN_PROGRESS','completing every step never closes the task');
  assert.equal(cmd('tm.check.toggle',{id:items()[0].id,done:true},DARA).unchanged,true);
  cmd('tm.check.rename',{id:items()[3].id,title:'Photograph the container seal'},DARA);
  cmd('tm.check.remove',{id:items()[3].id},SOPHEA);assert.equal(items().length,3);
  fails(()=>cmd('tm.check.add',{task_id:id,title:'x'},FINANCE),/not found/,404);
  fails(()=>cmd('tm.check.add',{task_id:id,title:''},DARA),/Step is required/);
  const st=s.state();assert.equal(st.tm_checklist.filter(c=>c.task_id===id).length,3);assert.equal(enrichedTasks(st).find(x=>x.id===id).check_done,3);
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_task_history WHERE task_id=? AND kind='checklist'",id).n>=6,true);
  cmd('tm.task.submit',{id},DARA);cmd('tm.task.close',{id},SOPHEA);fails(()=>cmd('tm.check.add',{task_id:id,title:'Late'},SOPHEA),/closed/,409);
 });

 await check('files: people on the task attach and remove them; types, sizes and permissions are checked',()=>{
  const b64=PNG.toString('base64');
  fails(()=>cmd('tm.file.add',{task_id:t1,name:'seal.png',base64:b64},FINANCE),/not found/,404);
  fails(()=>cmd('tm.file.add',{task_id:t1,name:'script.exe',base64:b64},DARA),/Attach a PDF/);
  fails(()=>cmd('tm.file.add',{task_id:t1,name:'seal.png',base64:'not base64!'},DARA),/between 1 byte and 5 MB/);
  const f=cmd('tm.file.add',{task_id:t1,name:'C:\\fakepath\\seal.png',base64:b64},CHANTHA);
  const row=s.get('SELECT * FROM tm_files WHERE id=?',f.id);assert.equal(row.name,'seal.png');assert.equal(row.mime,'image/png');assert.equal(row.size,PNG.length);
  assert.match(notes(DARA,'task_file').at(-1).body,/attached seal\.png/);
  assert.equal(s.state().tm_files.find(x=>x.id===f.id).content,undefined,'file contents stay out of the screen data');
  fails(()=>cmd('tm.file.remove',{id:f.id},DARA),/Only the person who added this file or the task’s manager/,403);
  cmd('tm.file.remove',{id:f.id},SOPHEA);assert.equal(s.get('SELECT COUNT(*) n FROM tm_files WHERE id=?',f.id).n,0);
  const kept=cmd('tm.file.add',{task_id:t1,name:'Customs checklist.pdf',base64:Buffer.from('%PDF-1.4 test').toString('base64')},DARA).id;
  assert.ok(kept);
 });

 await check('people change their display name and photo; managers of the team directory can set photos',()=>{
  fails(()=>cmd('me.profile.save',{name:'Sophea · Sales Manager'},DARA),/Someone else already uses this name/,409);
  cmd('me.profile.save',{name:'Dara Sok · Sales'},DARA);assert.equal(s.get('SELECT name FROM lookups WHERE id=?',DARA).name,'Dara Sok · Sales');
  assert.ok(s.get("SELECT id FROM access_audit WHERE action='Display name changed' AND detail LIKE 'Dara · Sales → Dara Sok%'"));
  assert.equal(cmd('me.profile.save',{name:'Dara Sok · Sales'},DARA).unchanged,true);
  fails(()=>cmd('me.photo.save',{base64:Buffer.from('GIF89a......').toString('base64')},DARA),/JPEG, PNG or WebP/);
  cmd('me.photo.save',{base64:PNG.toString('base64')},DARA);
  let p=s.state().staff_photos.find(x=>x.staff_id===DARA);assert.equal(p.version,1);
  cmd('me.photo.remove',{},DARA);assert.equal(s.state().staff_photos.some(x=>x.staff_id===DARA),false);
  cmd('me.photo.save',{base64:PNG.toString('base64')},DARA);assert.equal(s.state().staff_photos.find(x=>x.staff_id===DARA).version,3,'versions keep counting so browsers never show an old copy');
  cmd('tm.profile.photo',{staff_id:NOLOGIN,base64:PNG.toString('base64')},VANNA);assert.ok(s.state().staff_photos.some(x=>x.staff_id===NOLOGIN));
 });

 await check('repeating tasks: closing creates the next one (same people, fresh checklist), until the end date',()=>{
  const due=addDays(taskToday(),1);
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Weekly stock report',start_date:taskToday(),due_date:due,pic_id:DARA,supporter_ids:[CHANTHA],recurrence:'WEEKLY',recurrence_until:addDays(due,7),checklist:['Count','Send']},SOPHEA).id;
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:due,pic_id:DARA,recurrence:'HOURLY'},SOPHEA),/repeat option/);
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:due,pic_id:DARA,recurrence:'DAILY',recurrence_until:taskToday()},SOPHEA),/Repeat until/);
  cmd('tm.task.accept',{id},DARA);cmd('tm.task.accept',{id},CHANTHA);
  for(const c of s.all('SELECT id FROM tm_checklist WHERE task_id=?',id))cmd('tm.check.toggle',{id:c.id,done:true},DARA);
  // V5.4: Dara submits each one; Sophea (who assigned the series) approves completing it.
  cmd('tm.task.submit',{id},DARA);const r=cmd('tm.task.close',{id},SOPHEA);assert.match(r.message,/next one is due/);
  const n=task(r.next_id);assert.equal(task(id).next_task_id,n.id);assert.equal(n.series_id,id);assert.equal(n.due_date,addDays(due,7));assert.equal(n.status,'NOT_STARTED');
  assert.ok(n.accepted_at,'the series was accepted');assert.equal(support(n.id,CHANTHA).status,'ACCEPTED');
  assert.deepEqual(s.all('SELECT title,done FROM tm_checklist WHERE task_id=? ORDER BY position',n.id).map(c=>`${c.title}:${c.done}`),['Count:0','Send:0']);
  assert.equal(notes(DARA,'task_repeat').at(-1).task_id,n.id,'the person in charge is told about the next one');assert.equal(n.assigned_by,SOPHEA);
  // The next one would be after the end date, so the series ends.
  cmd('tm.task.submit',{id:n.id},DARA);const last=cmd('tm.task.close',{id:n.id},SOPHEA);assert.match(last.message,/last one in this series/);assert.equal(last.next_id,undefined);
  // Reopening and closing again does not create a second copy.
  approveChange(cmd('tm.task.reopen',{id,note:'Recount'},DARA));cmd('tm.task.submit',{id},DARA);assert.equal(cmd('tm.task.close',{id},SOPHEA).next_id,undefined);
  // Cancelling stops the series unless asked to keep it.
  const d=cmd('tm.task.save',{workspace_id:ws,title:'Daily gate check',start_date:taskToday(),due_date:taskToday(),pic_id:DARA,recurrence:'DAILY'},DARA).id;
  const kept=cmd('tm.task.cancel',{id:d,reason:'Gate closed today',keep_series:true},DARA);assert.equal(task(kept.next_id).due_date,addDays(taskToday(),1));
  assert.match(cmd('tm.task.cancel',{id:kept.next_id,reason:'Gate removed'},DARA).message,/series stops here/);
  assert.equal(nextOccurrence('MONTHLY','2026-01-31',31),'2026-02-28');assert.equal(nextOccurrence('MONTHLY','2026-02-28',31),'2026-03-31');assert.equal(nextOccurrence('WEEKDAYS','2026-10-02'),'2026-10-05');
 });

 await check('due date reminders: due tomorrow to the people working on it, overdue to the person in charge and reviewer, once',()=>{
  const soon=cmd('tm.task.save',{workspace_id:ws,title:'Send the proforma',start_date:taskToday(),due_date:addDays(taskToday(),1),pic_id:DARA,supporter_ids:[CHANTHA]},SOPHEA).id;
  cmd('tm.task.accept',{id:soon},DARA);cmd('tm.task.accept',{id:soon},CHANTHA);
  const late=cmd('tm.task.save',{workspace_id:ws,title:'File the VAT return',start_date:addDays(taskToday(),-5),due_date:addDays(taskToday(),-2),pic_id:DARA},SOPHEA).id;
  const morning=new Date(`${taskToday()}T02:00:00Z`),night=new Date(`${taskToday()}T20:30:00Z`);// 09:00 and 03:30 Cambodia time
  assert.equal(s.reminders(new Date(`${taskToday()}T22:00:00Z`)),0,'nothing before 07:00 Cambodia time');
  const sent=s.reminders(morning);assert.ok(sent>=4);
  assert.equal(notes(DARA,'task_due_soon').filter(n=>n.task_id===soon).length,1);assert.equal(notes(CHANTHA,'task_due_soon').filter(n=>n.task_id===soon).length,1);
  assert.equal(notes(DARA,'task_overdue').filter(n=>n.task_id===late).length,1);assert.equal(notes(SOPHEA,'task_overdue').filter(n=>n.task_id===late).length,1);
  assert.equal(s.reminders(morning),0,'each reminder is sent once');void night;
 });

 await check('Telegram connect links no longer expire: one personal link until it is used or replaced',()=>{
  s.run("UPDATE tg_settings SET enabled=1,bot_token='123456789:AAHtestTokenForSunnyErpLocalChecks00',bot_username='sunny_tasks_bot' WHERE id=1");
  const a=cmd('tg.link.code',{},DARA);assert.match(a.link,/start=link_[A-Z2-9]{8}$/);assert.equal(a.expires_at,undefined);
  assert.equal(cmd('tg.link.code',{},DARA).code,a.code,'the same link is shown again');
  assert.equal(s.telegram.info(s.access.publicUser(s.access.accountFor(DARA).id),false,'').telegram.connect.code,a.code);
  s.run('UPDATE tg_link_codes SET created_at=? WHERE staff_id=?',new Date(Date.now()-40*86400000).toISOString(),DARA);
  const b=cmd('tg.link.code',{renew:true},DARA);assert.notEqual(b.code,a.code);
  assert.match(s.telegram.redeem(a.code,{id:7001,first_name:'Dara'},7001).error,/replaced by a newer link/);
  const before=notes(DARA,'telegram_connected').length;
  assert.equal(s.telegram.redeem(b.code,{id:7001,first_name:'Dara',username:'dara_sales'},7001).staff,DARA);
  const told=notes(DARA,'telegram_connected');assert.equal(told.length,before+1,'the ERP bell says Telegram was connected');assert.match(told.at(-1).body,/@dara_sales .*connect link.*disconnect/);
  assert.match(s.telegram.redeem(b.code,{id:7002,first_name:'Other'},7002).error,/already used/);
  assert.equal(s.telegram.info(s.access.publicUser(s.access.accountFor(DARA).id),false,'').telegram.connect,null);
  // Signing in with the ERP password in the Mini App connects without a code.
  assert.equal(s.telegram.connectSignedIn(SOPHEA,{id:7003,first_name:'Sophea'},7003).staff,SOPHEA);assert.equal(s.telegram.linkFor(7003).staff_id,SOPHEA);
  assert.match(notes(SOPHEA,'telegram_connected').at(-1).body,/^Sophea now uses your ERP account .*signed in with your ERP password/);
 });

 await check('“waiting for me” lists every answer a person owes: tasks to accept, reviews, requests and due dates',()=>{
  const st=s.state(),tasks=enrichedTasks(st);
  for(const who of [DARA,SOPHEA,VANNA,CHANTHA]){
   const w=waitingFor(st,who,tasks);
   assert.deepEqual(w.answer.map(t=>t.id).sort(),tasks.filter(t=>t.waiting.some(x=>x.staff_id===who)).map(t=>t.id).sort());
   assert.deepEqual(w.review.map(t=>t.id).sort(),tasks.filter(t=>t.status==='IN_REVIEW'&&t.submitted_to===who).map(t=>t.id).sort());
   assert.equal(w.requests.length,st.tm_requests.filter(q=>q.status==='PENDING'&&q.manager_id===who).length);
   assert.equal(w.total,w.answer.length+w.review.length+w.approvals.length+w.requests.length+w.due.length);
  }
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Label the new shelves',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA,supporter_ids:[CHANTHA],reviewer_id:VANNA},SOPHEA).id;
  const after=s.state(),w=waitingFor(after,CHANTHA);assert.ok(w.answer.some(t=>t.id===id),'a supporting person owes an answer');
  assert.ok(waitingFor(after,VANNA).answer.some(t=>t.id===id),'so does the reviewer');assert.ok(waitingFor(after,DARA).answer.some(t=>t.id===id));
  cmd('tm.task.cancel',{id,note:'Duplicate of an older task'},SOPHEA);
  assert.ok(!waitingFor(s.state(),CHANTHA).answer.some(t=>t.id===id),'nothing is owed on a cancelled task');
  assert.equal(REQUEST_STATUS.APPROVED,'Accepted');assert.equal(REQUEST_STATUS.PENDING,'Waiting for answer');
 });

 await check('independent review fixes: CRM links, creation keys, request privacy, early submits, security notices',()=>{
  const user=staff=>s.access.publicUser(s.access.accountFor(staff).id);
  // A CRM activity can be connected only when a task is created, by someone allowed to update CRM activities.
  const act=s.get("SELECT id,subject FROM activities WHERE status='OPEN' AND channel<>'MEETING' AND id NOT IN (SELECT activity_id FROM tm_tasks WHERE activity_id IS NOT NULL) LIMIT 1");
  const t=cmd('tm.task.save',{workspace_id:ws,title:'Check the forklift',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:CHANTHA},SOPHEA).id;
  cmd('tm.task.accept',{id:t},CHANTHA);
  fails(()=>s.access.authorize(user(CHANTHA),'tm.task.save',{id:t,activity_id:act.id}),/crm|activit/i,403);
  cmd('tm.task.save',{...task(t),id:t,expected_version:task(t).version,estimate:'0:00',activity_id:act.id,supporter_ids:[]},CHANTHA);
  assert.equal(task(t).activity_id,null,'editing never connects an activity');assert.equal(s.get('SELECT subject FROM activities WHERE id=?',act.id).subject,act.subject);
  // Creation keys belong to their sender, so nobody can take over the task of an accepted request.
  const nextReq='REQ-'+String(Number(s.get("SELECT COALESCE(MAX(CAST(substr(id,5) AS INTEGER)),0) n FROM tm_requests").n)+1).padStart(6,'0');
  const decoy=cmd('tm.task.save',{workspace_id:ws,title:'Decoy',start_date:taskToday(),due_date:addDays(taskToday(),1),pic_id:DARA,request_key:'request:'+nextReq},DARA).id;
  const q=cmd('tm.request.save',{title:'Order new pallets',manager_id:SOPHEA,doer:'RECEIVER',request_key:'same-key'},CHANTHA).id;assert.equal(q,nextReq);
  assert.notEqual(cmd('tm.request.save',{title:'Other',manager_id:SOPHEA,doer:'RECEIVER',request_key:'same-key'},DARA).id,q,'another person’s key is not reused');
  const made=cmd('tm.request.decide',{id:q,decision:'APPROVE',workspace_id:ws,due_date:addDays(taskToday(),5)},SOPHEA).id;
  assert.notEqual(made,decoy);assert.equal(s.get('SELECT task_id FROM tm_requests WHERE id=?',q).task_id,made);assert.equal(task(made).request_id,q);
  // Request events are private like the requests.
  const hidden=cmd('tm.request.save',{title:'Private: salary advance',manager_id:VANNA,doer:'RECEIVER'},SOPHEA).id;
  const seen=s.access.filterState(s.state(),user(CHANTHA)).tm_events.filter(e=>e.entity_type==='request').map(e=>e.entity_id);
  assert.ok(seen.includes(q));assert.ok(!seen.includes(hidden),'someone else’s request stays private');
  assert.ok(s.access.filterState(s.state(),user(VANNA)).tm_events.some(e=>e.entity_id===hidden));
  // A supporting person cannot submit before the person in charge has accepted (for example after a hand-over).
  const h=cmd('tm.task.save',{workspace_id:ws,title:'Stack the new shelves',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA},SOPHEA).id;
  cmd('tm.task.accept',{id:h},DARA);const ho=cmd('tm.task.handover',{id:h,to_id:CHANTHA,keep:true},DARA);cmd('tm.change.decide',{id:ho.change_id,decision:'APPROVE'},SOPHEA);
  assert.equal(task(h).status,'IN_PROGRESS');assert.equal(task(h).accepted_at,null);
  fails(()=>cmd('tm.task.submit',{id:h},DARA),/must accept/,409);
  cmd('tm.task.decline',{id:h,note:'I am on leave next week'},CHANTHA);assert.ok(task(h).declined_at,'the new person in charge can still reject');
  // Security notices: Telegram cannot mark them read (so a new connection cannot hide its own notice).
  s.run('DELETE FROM tg_links WHERE staff_id=?',DARA);assert.equal(s.telegram.connectSignedIn(DARA,{id:7101,first_name:'Someone'},7101).staff,DARA);
  const notice=notes(DARA,'telegram_connected').at(-1);
  s.command('tm.notification.read',{all:true},DARA,{source:'MINIAPP'});assert.equal(s.get('SELECT read_at FROM tm_notifications WHERE id=?',notice.id).read_at,null);
  s.command('tm.notification.read',{id:notice.id},DARA,{source:'TELEGRAM'});assert.equal(s.get('SELECT read_at FROM tm_notifications WHERE id=?',notice.id).read_at,null);
  s.command('tm.notification.read',{id:notice.id},DARA);assert.ok(s.get('SELECT read_at FROM tm_notifications WHERE id=?',notice.id).read_at,'read in the ERP');
 });

 await check('repeating tasks keep their rhythm when one is postponed, can move the series, and skip people who left',()=>{
  const nextDay=(from,test)=>{let d=addDays(from,1);while(!test(d))d=addDays(d,1);return d;};
  const closeIt=id=>{cmd('tm.task.submit',{id},DARA);cmd('tm.task.close',{id},SOPHEA);return task(id).next_task_id;};
  // Monthly on the 31st, postponed to the 2nd: the next one is still at the end of the month.
  const d31=nextDay(addDays(taskToday(),1),d=>d.endsWith('-31'));
  const m=cmd('tm.task.save',{workspace_id:ws,title:'Month-end stock count',start_date:taskToday(),due_date:d31,pic_id:DARA,recurrence:'MONTHLY'},SOPHEA).id;
  cmd('tm.task.accept',{id:m},DARA);
  // V5.4: Dara's new date is a change request that Sophea (who assigned the series) approves.
  const dr=cmd('tm.due.request',{task_id:m,proposed_due_date:addDays(d31,2),reason:'Stock arrives late'},DARA);
  cmd('tm.change.decide',{id:dr.change_id,decision:'APPROVE'},SOPHEA);
  assert.equal(task(m).due_date,addDays(d31,2));assert.equal(task(m).scheduled_due,d31);
  const m2=closeIt(m),[y,mo]=d31.split('-').map(Number),ny=mo===12?y+1:y,nm=mo===12?1:mo+1;
  assert.equal(task(m2).due_date,`${ny}-${String(nm).padStart(2,'0')}-${String(new Date(Date.UTC(ny,nm,0)).getUTCDate()).padStart(2,'0')}`,'end of the following month');
  assert.equal(task(m2).series_anchor,31);
  // Weekly on a Monday, postponed to Wednesday: the next one is the following Monday.
  const mon=nextDay(addDays(taskToday(),1),d=>new Date(`${d}T12:00:00Z`).getUTCDay()===1);
  const wk=cmd('tm.task.save',{workspace_id:ws,title:'Weekly safety walk',start_date:taskToday(),due_date:mon,pic_id:DARA,recurrence:'WEEKLY'},SOPHEA).id;
  cmd('tm.task.accept',{id:wk},DARA);
  const wkc=cmd('tm.task.save',{...task(wk),id:wk,expected_version:task(wk).version,estimate:'0:00',due_date:addDays(mon,2),supporter_ids:[]},SOPHEA);cmd('tm.change.decide',{id:wkc.change_id,decision:'APPROVE'},DARA);
  assert.equal(task(wk).scheduled_due,mon,'moving only this one keeps the plan');
  assert.equal(task(closeIt(wk)).due_date,addDays(mon,7));
  // Moving the series re-plans from the new date.
  const mv=cmd('tm.task.save',{workspace_id:ws,title:'Weekly supplier call',start_date:taskToday(),due_date:mon,pic_id:DARA,recurrence:'WEEKLY'},SOPHEA).id;
  cmd('tm.task.accept',{id:mv},DARA);
  const mvc=cmd('tm.task.save',{...task(mv),id:mv,expected_version:task(mv).version,estimate:'0:00',due_date:addDays(mon,1),move_series:true,supporter_ids:[]},SOPHEA);cmd('tm.change.decide',{id:mvc.change_id,decision:'APPROVE'},DARA);
  assert.equal(task(closeIt(mv)).due_date,addDays(mon,8),'the series moved to Tuesdays');
  // A repeating task created as already completed schedules the next one.
  const done=cmd('tm.task.save',{workspace_id:ws,title:'Daily cash count',start_date:taskToday(),due_date:taskToday(),pic_id:SOPHEA,recurrence:'DAILY',status:'COMPLETED'},SOPHEA);
  assert.match(done.message,/The next one is due/);assert.equal(task(task(done.id).next_task_id).due_date,addDays(taskToday(),1));
  // Someone who can no longer be given tasks is left out of the next one: the reviewer takes charge.
  const lv=cmd('tm.task.save',{workspace_id:ws,title:'Weekly yard check',start_date:taskToday(),due_date:mon,pic_id:CHANTHA,supporter_ids:[DARA],recurrence:'WEEKLY'},SOPHEA).id;
  cmd('tm.task.accept',{id:lv},CHANTHA);cmd('tm.task.accept',{id:lv},DARA);cmd('tm.task.submit',{id:lv},CHANTHA);
  const acct=s.access.accountFor(CHANTHA);cmd('admin.user.disable',{id:acct.id,expected_version:s.get('SELECT version FROM access_users WHERE id=?',acct.id).version,reason:'Left the company'},VANNA);
  cmd('tm.task.close',{id:lv},SOPHEA);
  const nx=task(task(lv).next_task_id);assert.equal(nx.pic_id,SOPHEA);assert.ok(!s.get('SELECT 1 AS ok FROM tm_assignees WHERE task_id=? AND staff_id=?',nx.id,CHANTHA));
  assert.ok(s.get('SELECT 1 AS ok FROM tm_assignees WHERE task_id=? AND staff_id=?',nx.id,DARA),'others stay');
  s.run('UPDATE access_users SET active=1 WHERE id=?',acct.id);
 });

 await check('the QR code of a connect link decodes to the link (checked by structure and size)',()=>{
  const m=qrMatrix('https://t.me/sunny_tasks_bot?start=link_ABCD2345');assert.equal(m.size,m.version*4+17);assert.ok(m.version<=5);
  assert.equal(m.modules[0].slice(0,7).join(),'true,true,true,true,true,true,true','finder pattern');
  assert.throws(()=>qrMatrix('x'.repeat(300)),/too long/);
 });

 // ------------------------------------------------------------------ HTTP
 const port=4341,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data}={})=>{const r=await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});const buf=Buffer.from(await r.arrayBuffer());let body;try{body=JSON.parse(buf.toString());}catch{body=buf;}return {status:r.status,body,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const login=async(email,password)=>(await request('/api/auth/login',{data:{email,password}})).cookie;
 const api=(cookie,action,data)=>request('/api/command',{cookie,data:{action,data}});
 const cookies={vanna:await login('vanna@example.test','vanna-password-1'),dara:await login('dara@example.test','dara-password-12'),chantha:await login('chantha@example.test','chantha-password'),rotha:await login('rotha@example.test','rotha-password-1')};

 await check('HTTP: any role with Task Management works on its own tasks; screens get people, photos, checklists and files',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Viewer’s own task',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:CHANTHA},DARA).id;
  assert.equal((await api(cookies.chantha,'tm.task.accept',{id})).status,200,'V5.3: a viewer can accept work given to them');
  assert.equal((await api(cookies.chantha,'tm.task.progress',{id,progress:20})).status,200);
  assert.equal((await api(cookies.chantha,'tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:taskToday(),pic_id:CHANTHA})).status,403,'creating tasks still needs Create');
  assert.equal((await api(cookies.chantha,'tm.request.save',{title:'Need a new badge',manager_id:VANNA,doer:'RECEIVER'})).status,200,'anyone can ask anyone');
  assert.equal((await api(cookies.rotha,'tm.task.accept',{id})).status,403);
  assert.equal((await api(cookies.rotha,'me.profile.save',{name:'Rotha Chan · Finance'})).status,200,'everyone edits their own name');
  const st=(await request('/api/state',{cookie:cookies.dara})).body;
  assert.ok(st.tm_people.some(p=>p.staff_id===CHANTHA));assert.equal(st.tm_managers,undefined);
  assert.ok(st.staff_photos.some(p=>p.staff_id===DARA));assert.ok(st.tm_checklist.length);assert.ok(st.tm_files.length);assert.ok(st.tm_assignees.every(a=>a.status));
  assert.doesNotMatch(JSON.stringify(st),/"content"/);
  const rotha=(await request('/api/state',{cookie:cookies.rotha})).body;assert.deepEqual(rotha.tm_files,[]);assert.deepEqual(rotha.tm_people,[]);
 });

 await check('HTTP: photos for signed-in people (cached by version) and task files for people who can view tasks',async()=>{
  const v=s.get('SELECT version FROM staff_photos WHERE staff_id=?',DARA).version;
  assert.equal((await request(`/api/photo?staff=${DARA}&v=${v}`)).status,401);
  const photo=await request(`/api/photo?staff=${DARA}&v=${v}`,{cookie:cookies.rotha});
  assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/png');assert.match(photo.headers.get('cache-control'),/immutable/);assert.ok(Buffer.compare(photo.body,PNG)===0);
  assert.equal((await request(`/api/photo?staff=${DARA}&v=1`,{cookie:cookies.dara})).headers.get('cache-control'),'no-store');
  assert.equal((await request(`/api/photo?staff=${VANNA}`,{cookie:cookies.dara})).status,404);
  const f=s.get("SELECT id FROM tm_files WHERE name='Customs checklist.pdf'").id;
  const dl=await request(`/api/tasks/file?id=${f}`,{cookie:cookies.chantha});assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/attachment; .*Customs%20checklist\.pdf/);assert.equal(dl.headers.get('content-type'),'application/octet-stream');
  assert.equal((await request(`/api/tasks/file?id=${f}`,{cookie:cookies.rotha})).status,403);
  const img=cmd('tm.file.add',{task_id:t1,name:'pallet.png',base64:PNG.toString('base64')},DARA).id;
  const inline=await request(`/api/tasks/file?id=${img}&inline=1`,{cookie:cookies.dara});assert.equal(inline.headers.get('content-type'),'image/png');assert.match(inline.headers.get('content-disposition'),/^inline/);
  assert.match(inline.headers.get('content-security-policy'),/sandbox/);
  const upload=await api(cookies.dara,'tm.file.add',{task_id:t1,name:'big.pdf',base64:Buffer.alloc(5*1024*1024+10).toString('base64')});assert.equal(upload.status,400);
 });

 await check('an earlier (V5.2) database upgrades: its supporters and reviewers count as accepted, and nothing is lost',()=>{
  const old=path.join(folder,'v52.sqlite'),db=new DatabaseSync(old);
  db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  // The V5.2 shape of the task tables (before the V5.3 columns).
  db.exec(`CREATE TABLE tm_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL REFERENCES lookups(id), color TEXT NOT NULL DEFAULT 'BLUE', status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE tm_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES tm_workspaces(id), activity_id TEXT UNIQUE, contact_id TEXT, related_type TEXT NOT NULL DEFAULT '', related_id TEXT,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, progress INTEGER NOT NULL, estimate_minutes INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES lookups(id), completed_at TEXT, version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    pic_id TEXT, reviewer_id TEXT, department TEXT NOT NULL DEFAULT '', department_note TEXT NOT NULL DEFAULT '', accepted_at TEXT, declined_at TEXT, declined_reason TEXT NOT NULL DEFAULT '', stuck_at TEXT, stuck_by TEXT, stuck_reason TEXT NOT NULL DEFAULT '',
    submitted_to TEXT, submitted_by TEXT, submitted_at TEXT, submit_note TEXT NOT NULL DEFAULT '', closed_by TEXT, request_id TEXT, source TEXT NOT NULL DEFAULT 'WEB');
   CREATE TABLE tm_assignees (task_id TEXT NOT NULL REFERENCES tm_tasks(id), staff_id TEXT NOT NULL REFERENCES lookups(id), PRIMARY KEY(task_id,staff_id));
   CREATE TABLE tm_requests (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', department_note TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL, proposed_due_date TEXT,
    requested_by TEXT NOT NULL, manager_id TEXT NOT NULL, status TEXT NOT NULL, decision_note TEXT NOT NULL DEFAULT '', decided_by TEXT, decided_at TEXT, task_id TEXT, source TEXT NOT NULL DEFAULT 'WEB', version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO lookups(id,kind,name,unit,active) VALUES('STAFF-101','staff','Old Manager','',1),('STAFF-102','staff','Old Worker','',1),('STAFF-103','staff','Old Helper','',1);
   INSERT INTO tm_workspaces VALUES('WS-000901','Old work','','','STAFF-101','BLUE','ACTIVE',0,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z');
   INSERT INTO tm_tasks(id,workspace_id,title,start_date,due_date,status,priority,progress,created_by,created_at,updated_at,pic_id,reviewer_id,accepted_at) VALUES('TASK-000901','WS-000901','Old task','2026-08-01','2026-08-20','IN_PROGRESS','MEDIUM',40,'STAFF-101','2026-08-01T00:00:00Z','2026-08-02T00:00:00Z','STAFF-102','STAFF-101','2026-08-01T01:00:00Z');
   INSERT INTO tm_assignees VALUES('TASK-000901','STAFF-102'),('TASK-000901','STAFF-103');
   INSERT INTO tm_requests(id,title,priority,requested_by,manager_id,status,created_at,updated_at) VALUES('REQ-000901','Old request','LOW','STAFF-102','STAFF-101','PENDING','2026-08-03T00:00:00Z','2026-08-03T00:00:00Z');
   INSERT OR IGNORE INTO schema_version VALUES(2),(3),(4),(5),(6),(7),(8);`);
  db.close();
  const up=openStore(old);
  try{
   assert.ok(up.get('SELECT version FROM schema_version WHERE version=9'));
   const t=up.get("SELECT * FROM tm_tasks WHERE id='TASK-000901'");assert.equal(t.progress,40);assert.equal(t.reviewer_status,'ACCEPTED');assert.equal(t.recurrence,'');
   assert.deepEqual(up.all("SELECT staff_id,status FROM tm_assignees WHERE task_id='TASK-000901' ORDER BY staff_id").map(a=>`${a.staff_id}:${a.status}`),['STAFF-102:ACCEPTED','STAFF-103:ACCEPTED']);
   assert.equal(up.get("SELECT doer FROM tm_requests WHERE id='REQ-000901'").doer,'REQUESTER','earlier requests keep their meaning: the requester takes the task');
   assert.equal(up.all('PRAGMA foreign_key_check').length,0);
   const e=enrichedTasks(up.state()).find(x=>x.id==='TASK-000901');assert.deepEqual(e.supporters,['STAFF-103']);assert.deepEqual(e.waiting,[]);
  }finally{up.db.close();}
 });
 console.log(`\n${checks} V5.3 Task Management checks passed.`);
}finally{
 if(server)await new Promise(r=>server.close(r));
 s.db.close();rmSync(folder,{recursive:true,force:true});
}

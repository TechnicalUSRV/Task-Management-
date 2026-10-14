import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {taskToday,addDays,enrichedTasks,waitingFor,assignedByMe,toReviewOrApprove,approvalTarget,formatMinutes} from './task-domain.mjs';
import {compileFormula,computeRow,previewFormula,formulaDisplay,roundTo,parseNumber,groupLevel,groupCaps,LEVELS} from './group-domain.mjs';
import {readXlsx} from './xlsx.mjs';

// V5.4: two-party approval of task changes (update, complete, cancel), notifications only to the people on a task,
// per-task deadline reminders, the "Assigned by me" dashboard, and Groups (customizable tables with formulas).
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v54-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;let checks=0,server,gateway;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const task=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const change=id=>s.get('SELECT * FROM tm_change_requests WHERE id=?',id);
const pending=id=>s.get("SELECT * FROM tm_change_requests WHERE task_id=? AND status='PENDING'",id);
const notes=(staff,kind,taskId)=>s.all('SELECT * FROM tm_notifications WHERE staff_id=? AND kind=?'+(taskId?' AND task_id=?':'')+' ORDER BY id',staff,kind,...(taskId?[taskId]:[]));
const historyOf=id=>s.all('SELECT * FROM tm_task_history WHERE task_id=? ORDER BY id',id);
const edit=id=>{const t=task(id);return {...t,id,expected_version:t.version,estimate:formatMinutes(t.estimate_minutes),supporter_ids:s.tasks.supportersOf(t)};};
const today=taskToday();
const DARA='STAFF-001',SOPHEA='STAFF-002',VANNA='STAFF-003';let CHANTHA,BOPHA,KOSAL,MONY,FINANCE,ws,ws2;
const staffOf=email=>s.get('SELECT staff_id FROM access_users WHERE email=?',email).staff_id;
try{
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 for(const [name,email,role] of [['Chantha · Operations','chantha@example.test','ROLE-MEMBER'],['Bopha · Viewer','bopha@example.test','ROLE-VIEWER'],['Kosal · Warehouse','kosal@example.test','ROLE-MEMBER'],['Mony · Purchasing','mony@example.test','ROLE-MEMBER']])
  cmd('admin.user.save',{name,email,role_id:role,password:'local-password-1',active:1},VANNA);
 const financeRole=cmd('admin.role.save',{name:'Finance only',permissions:{'ops.finance':['view']}},VANNA).id;
 cmd('admin.user.save',{name:'Rotha · Finance',email:'rotha@example.test',role_id:financeRole,password:'local-password-1',active:1},VANNA);
 [CHANTHA,BOPHA,KOSAL,MONY,FINANCE]=['chantha','bopha','kosal','mony','rotha'].map(n=>staffOf(`${n}@example.test`));
 ws=cmd('tm.workspace.save',{name:'V5.4 QA',department:'Operations',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,CHANTHA,BOPHA,MONY]},SOPHEA).id;
 ws2=cmd('tm.workspace.save',{name:'Warehouse team',department:'Warehouse',owner_id:KOSAL,member_ids:[KOSAL]},VANNA).id;

 // ================================================================ two-party approval
 await check('upgrade: schema 10 and 11, assigners for existing tasks, Groups permissions for the starter roles',()=>{
  for(const v of [10,11])assert.ok(s.get('SELECT version FROM schema_version WHERE version=?',v),'schema '+v);
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_tasks WHERE assigned_by IS NULL').n,0);
  const p=role=>s.access.rolePermissions(role)['tasks.groups'].sort();
  assert.deepEqual(p('ROLE-MANAGER'),['create','delete','export','update','view']);assert.deepEqual(p('ROLE-MEMBER'),['create','delete','export','update','view']);assert.deepEqual(p('ROLE-VIEWER'),['view']);
  assert.ok(s.access.can(s.access.publicUser(s.access.accountFor(VANNA).id),'tasks.groups','approve'),'administrators manage every team group');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
 });

 let t1;
 await check('the assigner’s change to an accepted task waits for the person in charge; approving applies it and the history keeps who, what and when',()=>{
  t1=cmd('tm.task.save',{workspace_id:ws,title:'Pack the samples',start_date:today,due_date:addDays(today,5),pic_id:DARA,supporter_ids:[CHANTHA],reviewer_id:SOPHEA},SOPHEA).id;
  assert.equal(task(t1).assigned_by,SOPHEA);assert.equal(JSON.parse(task(t1).reminder_days)[0],1,'one day before the due date by default');
  // Before Dara accepts, Sophea can still change the task directly (Dara then accepts or rejects it as it stands).
  cmd('tm.task.save',{...edit(t1),description:'Use the blue boxes.'},SOPHEA);assert.equal(task(t1).description,'Use the blue boxes.');assert.equal(pending(t1),undefined);
  cmd('tm.task.accept',{id:t1},DARA);
  const v=task(t1).version,r=cmd('tm.task.save',{...edit(t1),due_date:addDays(today,8),priority:'HIGH',change_note:'The customer asked for more time.'},SOPHEA);
  assert.match(r.message,/Sent to Dara .*for approval/);assert.ok(r.change_id);
  let t=task(t1);assert.equal(t.due_date,addDays(today,5));assert.equal(t.priority,'MEDIUM');assert.equal(t.version,v,'nothing about the task changes');
  const cr=change(r.change_id);assert.equal(cr.status,'PENDING');assert.equal(cr.kind,'UPDATE');assert.equal(cr.requested_by,SOPHEA);assert.equal(cr.requester_side,'ASSIGNER');assert.equal(cr.approver_id,DARA);assert.equal(cr.note,'The customer asked for more time.');
  const changes=JSON.parse(cr.changes_json);assert.deepEqual(changes.map(c=>c.field).sort(),['due_date','priority']);
  const due=changes.find(c=>c.field==='due_date');assert.equal(due.from,addDays(today,5));assert.equal(due.to,addDays(today,8));assert.ok(due.from_text&&due.to_text);
  assert.match(notes(DARA,'change_request',t1).at(-1).body,/Sophea .*asks to change .*due date/);
  assert.equal(approvalTarget(enrichedTasks(s.state()).find(x=>x.id===t1),SOPHEA),DARA);
  // One change at a time, and only the other side decides.
  fails(()=>cmd('tm.task.save',{...edit(t1),title:'Other'},SOPHEA),/already waiting for approval/,409);
  fails(()=>cmd('tm.task.cancel',{id:t1,reason:'x'},DARA),/already waiting for approval/,409);
  fails(()=>cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},CHANTHA),/Only Dara/,403);
  fails(()=>cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},SOPHEA),/Only Dara/,403);
  const ok=cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE',note:'Fine by me.'},DARA);assert.match(ok.message,/applied/);
  t=task(t1);assert.equal(t.due_date,addDays(today,8));assert.equal(t.priority,'HIGH');
  const done=change(r.change_id);assert.equal(done.status,'APPROVED');assert.equal(done.decided_by,DARA);assert.ok(done.decided_at>=done.created_at);assert.equal(done.decision_note,'Fine by me.');
  const h=historyOf(t1).at(-1);assert.equal(h.kind,'edit');assert.equal(h.actor_id,SOPHEA);assert.match(h.note,/approved by Dara/);
  assert.equal(notes(SOPHEA,'change_approved',t1).length,1);assert.equal(notes(DARA,'task_updated',t1).filter(n=>/due date/.test(n.title)).length,0,'the person who approved is not told about their own decision');
  assert.equal(cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},DARA).unchanged,true);
 });

 await check('the person in charge’s change goes to the assigner; rejecting (with a reason) or withdrawing leaves the task unchanged',()=>{
  const r=cmd('tm.task.save',{...edit(t1),title:'Pack the samples (blue boxes)',description:'Blue boxes, two layers.'},DARA);
  assert.equal(change(r.change_id).approver_id,SOPHEA);assert.equal(change(r.change_id).requester_side,'PIC');
  fails(()=>cmd('tm.change.decide',{id:r.change_id,decision:'REJECT'},SOPHEA),/Reason for rejecting/);
  cmd('tm.change.decide',{id:r.change_id,decision:'REJECT',note:'Keep the original title.'},SOPHEA);
  assert.equal(task(t1).title,'Pack the samples');assert.equal(change(r.change_id).status,'REJECTED');assert.match(notes(DARA,'change_rejected',t1).at(-1).body,/Keep the original title/);
  assert.equal(historyOf(t1).at(-1).kind,'change_rejected');
  const w=cmd('tm.task.save',{...edit(t1),description:'Changed again.'},DARA);
  fails(()=>cmd('tm.change.withdraw',{id:w.change_id},SOPHEA),/Only the person who asked/,403);
  cmd('tm.change.withdraw',{id:w.change_id},DARA);assert.equal(change(w.change_id).status,'WITHDRAWN');assert.equal(task(t1).description,'Use the blue boxes.');
  assert.equal(notes(SOPHEA,'change_withdrawn',t1).length,1);
  fails(()=>cmd('tm.change.decide',{id:w.change_id,decision:'APPROVE'},SOPHEA),/withdrawn/,409);
 });

 await check('completing: the person in charge submits; the reviewer checks and passes it on; the assigner approves or returns it',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Label the pallets',start_date:today,due_date:addDays(today,3),pic_id:DARA,reviewer_id:CHANTHA},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);
  fails(()=>cmd('tm.task.close',{id},DARA),/Submit it for approval/,409);
  const sub=cmd('tm.task.submit',{id,note:'All pallets labelled.'},DARA);assert.match(sub.message,/Submitted to Chantha .* then approves completing it/);
  let t=task(id);assert.equal(t.status,'IN_REVIEW');assert.equal(t.submitted_to,CHANTHA);
  let cr=pending(id);assert.equal(cr.kind,'COMPLETE');assert.equal(cr.requester_side,'PIC');assert.equal(cr.approver_id,SOPHEA);
  fails(()=>cmd('tm.task.close',{id},CHANTHA),/Pass it on for approval/,409);
  cmd('tm.task.pass',{id,note:'Checked every label.'},CHANTHA);
  t=task(id);assert.equal(t.submitted_to,SOPHEA);assert.equal(t.reviewer_status,'ACCEPTED','acting on the task confirms the reviewer');
  assert.match(notes(SOPHEA,'task_submitted',id).at(-1).title,/Approval needed/);assert.match(notes(DARA,'task_passed',id).at(-1).body,/passed your work to Sophea/);
  assert.ok(toReviewOrApprove(enrichedTasks(s.state()).find(x=>x.id===id),SOPHEA));
  cmd('tm.task.return',{id,note:'Photograph each pallet.'},SOPHEA);
  t=task(id);assert.equal(t.status,'IN_PROGRESS');cr=change(cr.id);assert.equal(cr.status,'REJECTED');assert.equal(cr.decided_by,SOPHEA);assert.equal(cr.decision_note,'Photograph each pallet.');
  // Submitted again: the assigner can approve at once, before the reviewer has looked.
  cmd('tm.task.submit',{id},DARA);cr=pending(id);assert.equal(task(id).submitted_to,CHANTHA);
  const approved=cmd('tm.change.decide',{id:cr.id,decision:'APPROVE'},SOPHEA);assert.match(approved.message,/completed/);
  t=task(id);assert.equal(t.status,'COMPLETED');assert.equal(t.closed_by,SOPHEA);assert.equal(t.progress,100);assert.equal(change(cr.id).status,'APPROVED');
  for(const who of [DARA,CHANTHA])assert.equal(notes(who,'task_closed',id).length,1);
 });

 await check('cancelling and completing from the assigner’s side wait for the person in charge; before acceptance the assigner cancels directly',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Book the truck',start_date:today,due_date:addDays(today,2),pic_id:DARA},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);
  const c1=cmd('tm.task.cancel',{id,reason:'The customer cancelled.'},SOPHEA);assert.match(c1.message,/Sent to Dara/);assert.equal(task(id).status,'IN_PROGRESS');
  cmd('tm.change.decide',{id:c1.change_id,decision:'REJECT',note:'The customer confirmed again this morning.'},DARA);assert.equal(task(id).status,'IN_PROGRESS');
  const c2=cmd('tm.task.cancel',{id,reason:'The truck is not needed.'},DARA);assert.equal(change(c2.change_id).approver_id,SOPHEA);
  cmd('tm.change.decide',{id:c2.change_id,decision:'APPROVE'},SOPHEA);
  let t=task(id);assert.equal(t.status,'CANCELLED');assert.equal(t.reason,'The truck is not needed.');assert.equal(t.closed_by,DARA);assert.match(historyOf(id).at(-1).note,/approved by Sophea/);
  const other=cmd('tm.task.save',{workspace_id:ws,title:'Order boxes',start_date:today,due_date:addDays(today,2),pic_id:DARA},SOPHEA).id;
  assert.equal(approvalTarget(enrichedTasks(s.state()).find(x=>x.id===other),SOPHEA),null,'Dara has not accepted it yet');
  cmd('tm.task.cancel',{id:other,reason:'Duplicate'},SOPHEA);assert.equal(task(other).status,'CANCELLED');
  const third=cmd('tm.task.save',{workspace_id:ws,title:'Count the stock',start_date:today,due_date:addDays(today,2),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id:third},DARA);
  const c3=cmd('tm.task.close',{id:third,note:'Counted yesterday.'},SOPHEA);assert.equal(change(c3.change_id).kind,'COMPLETE');assert.equal(change(c3.change_id).requester_side,'ASSIGNER');
  cmd('tm.change.decide',{id:c3.change_id,decision:'APPROVE'},DARA);t=task(third);assert.equal(t.status,'COMPLETED');assert.equal(t.closed_by,SOPHEA);
 });

 await check('a task someone gives themselves needs no approval; hand-overs and new due dates of the person in charge do',()=>{
  const own=cmd('tm.task.save',{workspace_id:ws,title:'Tidy my desk',start_date:today,due_date:addDays(today,1),pic_id:DARA},DARA).id;
  assert.equal(task(own).assigned_by,DARA);
  cmd('tm.task.save',{...edit(own),due_date:addDays(today,4)},DARA);assert.equal(task(own).due_date,addDays(today,4));
  cmd('tm.task.close',{id:own},DARA);assert.equal(task(own).status,'COMPLETED');
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Visit the supplier',start_date:today,due_date:addDays(today,4),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  const h=cmd('tm.task.handover',{id,to_id:CHANTHA},DARA);assert.equal(task(id).pic_id,DARA);assert.deepEqual(JSON.parse(change(h.change_id).changes_json).map(c=>c.field),['pic_id']);
  cmd('tm.change.decide',{id:h.change_id,decision:'APPROVE'},SOPHEA);assert.equal(task(id).pic_id,CHANTHA);assert.equal(task(id).accepted_at,null);
  cmd('tm.task.accept',{id},CHANTHA);
  const d=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(today,9),reason:'The supplier is closed next week.'},CHANTHA);assert.equal(change(d.change_id).approver_id,SOPHEA);
  cmd('tm.change.decide',{id:d.change_id,decision:'APPROVE'},SOPHEA);assert.equal(task(id).due_date,addDays(today,9));
 });

 await check('a change that no longer fits the task is closed instead of overwriting it; an unreachable assigner is replaced by the reviewer',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Check the invoices',start_date:today,due_date:addDays(today,4),pic_id:DARA,supporter_ids:[CHANTHA]},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  const r=cmd('tm.task.save',{...edit(id),supporter_ids:[CHANTHA,BOPHA]},SOPHEA);
  cmd('tm.task.decline',{id,note:'I am on leave.'},CHANTHA);
  const res=cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},DARA);assert.equal(res.closed,true);assert.match(res.message,/Out of date/);
  assert.equal(change(r.change_id).status,'CLOSED');assert.deepEqual(s.tasks.supportersOf(task(id)),[]);
  // Mony assigns a task and later loses her login: Dara's change goes to the reviewer instead.
  const m=cmd('tm.task.save',{workspace_id:ws,title:'Order spare parts',start_date:today,due_date:addDays(today,4),pic_id:DARA,reviewer_id:VANNA},MONY).id;
  cmd('tm.task.accept',{id:m},DARA);cmd('tm.task.accept',{id:m},VANNA);
  const acct=s.access.accountFor(MONY);cmd('admin.user.disable',{id:acct.id,expected_version:s.get('SELECT version FROM access_users WHERE id=?',acct.id).version,reason:'Moved to another company'},VANNA);
  const x=cmd('tm.task.save',{...edit(m),description:'Brand parts only.'},DARA);assert.equal(change(x.change_id).approver_id,VANNA);
  cmd('tm.change.decide',{id:x.change_id,decision:'APPROVE'},VANNA);assert.equal(task(m).description,'Brand parts only.');
  s.run('UPDATE access_users SET active=1 WHERE id=?',acct.id);
 });

 await check('notifications go only to the people on the task: in charge, assigner, reviewer and supporting people',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Prepare the export permit',start_date:today,due_date:addDays(today,3),pic_id:DARA,supporter_ids:[CHANTHA],reviewer_id:VANNA},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);cmd('tm.task.accept',{id},CHANTHA);cmd('tm.task.accept',{id},VANNA);
  cmd('tm.task.stuck',{id,reason:'Waiting for the customs office.'},CHANTHA);cmd('tm.task.resume',{id},DARA);cmd('tm.task.note',{id,note:'Office open again.'},DARA);
  const c=cmd('tm.task.save',{...edit(id),priority:'HIGH'},SOPHEA);cmd('tm.change.decide',{id:c.change_id,decision:'APPROVE'},DARA);
  cmd('tm.task.submit',{id},DARA);cmd('tm.task.pass',{id},VANNA);cmd('tm.task.close',{id},SOPHEA);
  const people=new Set(s.all('SELECT DISTINCT staff_id FROM tm_notifications WHERE task_id=?',id).map(r=>r.staff_id));
  for(const who of [DARA,CHANTHA,VANNA,SOPHEA])assert.ok(people.has(who),`${who} is told`);
  for(const who of [BOPHA,KOSAL,MONY,FINANCE])assert.ok(!people.has(who),`${who} is not on the task and hears nothing`);
  assert.ok(s.access.can(s.access.publicUser(s.access.accountFor(BOPHA).id),'tasks.tasks'),'Bopha can see tasks, but is not told about them');
 });

 await check('deadline reminders are set for each task (1, 2, 3 or other days before) and reach only the people on it',()=>{
  const due=addDays(today,6),id=cmd('tm.task.save',{workspace_id:ws,title:'Renew the licence',start_date:today,due_date:due,pic_id:DARA,supporter_ids:[CHANTHA],reviewer_id:VANNA,reminder_days:[3,1]},SOPHEA).id;
  assert.deepEqual(JSON.parse(task(id).reminder_days),[3,1]);
  fails(()=>cmd('tm.task.reminders',{id,reminder_days:[2]},BOPHA),/not found/,404);
  for(const bad of [[0],[91],[1,2,3,4,5,6],['x']])fails(()=>cmd('tm.task.reminders',{id,reminder_days:bad},DARA),/up to five reminders, each 1 to 90 days/);
  const v=task(id).version;cmd('tm.task.reminders',{id,reminder_days:[7,3,1]},DARA);assert.deepEqual(JSON.parse(task(id).reminder_days),[7,3,1]);assert.equal(task(id).version,v,'open forms stay valid');
  assert.equal(historyOf(id).at(-1).kind,'reminders');assert.equal(cmd('tm.task.reminders',{id,reminder_days:[1,3,7]},SOPHEA).unchanged,true);
  cmd('tm.task.reminders',{id,reminder_days:[3,1]},SOPHEA);
  const at=day=>new Date(`${day}T02:00:00Z`),sent=()=>s.all("SELECT staff_id,title FROM tm_notifications WHERE task_id=? AND kind='task_due_soon' ORDER BY id",id);
  s.reminders(at(addDays(due,-4)));assert.equal(sent().length,0,'4 days before: nothing yet');
  s.reminders(at(addDays(due,-3)));let list=sent();
  assert.deepEqual(list.map(n=>n.staff_id).sort(),[DARA,CHANTHA,SOPHEA,VANNA].sort());assert.ok(list.every(n=>/^Due in 3 days: Renew the licence/.test(n.title)));
  s.reminders(at(addDays(due,-3)));s.reminders(at(addDays(due,-2)));assert.equal(sent().length,4,'each reminder is sent once');
  s.reminders(at(addDays(due,-1)));list=sent();assert.equal(list.length,8);assert.ok(list.slice(4).every(n=>/^Due tomorrow/.test(n.title)));
  s.reminders(at(addDays(due,1)));const over=s.all("SELECT staff_id FROM tm_notifications WHERE task_id=? AND kind='task_overdue'",id).map(n=>n.staff_id).sort();
  assert.deepEqual(over,[DARA,SOPHEA,VANNA].sort(),'overdue: the person in charge, the assigner and the reviewer');
  // A reminder whose day has passed is sent once, late; reminders can be turned off.
  const late=cmd('tm.task.save',{workspace_id:ws,title:'Send the samples',start_date:today,due_date:addDays(today,2),pic_id:DARA,reminder_days:[3]},SOPHEA).id;
  s.reminders(at(today));assert.match(notes(DARA,'task_due_soon',late).at(-1).title,/Due in 2 days/);
  const off=cmd('tm.task.save',{workspace_id:ws,title:'Water the plants',start_date:today,due_date:addDays(today,1),pic_id:DARA,reminder_days:[]},SOPHEA).id;
  s.reminders(at(today));assert.equal(notes(DARA,'task_due_soon',off).length,0);
 });

 await check('the dashboard separates tasks in my charge, tasks I assigned to others and tasks waiting for my review or approval',()=>{
  const st=s.state(),tasks=enrichedTasks(st);
  const mine=tasks.filter(t=>assignedByMe(t,SOPHEA));
  assert.ok(mine.length>0);assert.ok(mine.every(t=>t.assigned_by===SOPHEA&&t.pic_id!==SOPHEA&&['NOT_STARTED','IN_PROGRESS','IN_REVIEW'].includes(t.status)));
  assert.ok(!tasks.filter(t=>assignedByMe(t,DARA)).some(t=>t.pic_id===DARA),'a task I gave myself is not “assigned by me”');
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Approve me',start_date:today,due_date:addDays(today,2),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  cmd('tm.task.save',{...edit(id),description:'Please approve.'},DARA);
  const after=s.state(),t=enrichedTasks(after).find(x=>x.id===id);
  assert.ok(toReviewOrApprove(t,SOPHEA));assert.ok(!toReviewOrApprove(t,DARA));
  const w=waitingFor(after,SOPHEA);assert.ok(w.approvals.some(c=>c.task_id===id));assert.equal(w.total,w.answer.length+w.review.length+w.approvals.length+w.requests.length+w.due.length);
  cmd('tm.change.withdraw',{id:pending(id).id},DARA);
 });

 // ================================================================ Groups: the formula language
 await check('formulas: precedence, comparisons, functions, blanks, precision, rounding and error propagation',()=>{
  const cols=[{id:'A',name:'Qty',type:'NUMBER'},{id:'B',name:'Price',type:'NUMBER'},{id:'C',name:'Note',type:'TEXT'},{id:'D',name:'Sub',type:'FORMULA',settings:{}},{id:'E',name:'Per unit',type:'FORMULA',settings:{}}];
  const val=(f,values={})=>{const r=previewFormula(f,cols,null,values);assert.ok(r.ok,r.error);return r.value;};
  assert.equal(val('=2+3*4'),14);assert.equal(val('=(2+3)*4'),20);assert.equal(val('=-2*-3'),6);assert.equal(val('10/4'),2.5);assert.equal(val('=0.1+0.2'),0.3);assert.equal(val('=1-0.9'),0.1);
  assert.equal(val('=3>2'),true);assert.equal(val('=2<>2'),false);assert.equal(val('=IF(2>=2,1,0)'),1);assert.equal(val('=IF(1>2,5)'),false);assert.equal(val('=TRUE+1'),2);
  assert.equal(val('=ROUND(2.5)'),3);assert.equal(val('=ROUND(-2.5)'),-3);assert.equal(val('=ROUND(1.005,2)'),1.01);assert.equal(val('=ROUND(1234.5,-2)'),1200);assert.equal(roundTo(2.675,2),2.68);
  assert.equal(val('=SUM({Qty},{Price},1)',{A:2}),3,'empty cells count as 0');assert.equal(val('=AVERAGE({Qty},{Price})',{A:4}),4,'AVERAGE skips empty cells');
  assert.equal(val('=MIN({Qty},{Price})',{A:4,B:-1}),-1);assert.equal(val('=MAX({Qty},{Price})',{A:4,B:-1}),4);assert.equal(val('={Qty}*{Price}',{}),null,'every cell used is empty: the result is empty');
  assert.equal(val('={Qty}*{Price}',{A:0,B:5}),0,'zero is a value');assert.equal(val('={Qty}*{Price}',{A:-3,B:2.5}),-7.5);
  assert.deepEqual(val('={Price}/{Qty}',{A:0,B:5}),{error:'#DIV/0!'});assert.equal(val('=IF({Qty}>0,{Price}/{Qty},0)',{A:0,B:5}),0,'IF calculates only the chosen value');
  assert.deepEqual(val('=AVERAGE({Qty},{Price})+1',{}),null);assert.deepEqual(val('=AVERAGE({Qty},{Price})+{Qty}*0+SUM(1)',{A:null}),null);
  // Errors pass through to formulas that use them.
  cols[3].settings.expression=compileFormula('={Price}/{Qty}',cols,'D').canonical;cols[4].settings.expression=compileFormula('=ROUND({Sub},2)+1',cols,'E').canonical;
  assert.deepEqual(computeRow({A:0,B:5},cols),{D:{error:'#DIV/0!'},E:{error:'#DIV/0!'}});assert.deepEqual(computeRow({A:4,B:5},cols),{D:1.25,E:2.25});assert.equal(parseNumber('1,234.50').value,1234.5);
  const bad=(f,pattern)=>{const r=compileFormula(f,cols,'E');assert.equal(r.ok,false,f);assert.match(r.error,pattern);};
  bad('=VLOOKUP({Qty})',/VLOOKUP isn’t supported/);bad('=({Qty}*2',/missing its closing/);bad('="text"',/Text in quotes/);bad('={Missing}+1',/no column named \{Missing\}/);bad('={Note}*2',/Text column/);
  bad('={Per unit}+1',/its own column/);bad('={Sub} {Qty}',/Expected an operator/);bad('=SUM()',/SUM takes 1/);bad('={Qty}^2',/\^ operator/);bad('',/Enter a formula/);
  const loop=compileFormula('={Per unit}*2',cols,'D');assert.equal(loop.ok,false);assert.match(loop.error,/loop: Sub → Per unit → Sub/);
  assert.equal(formulaDisplay(cols[4].settings.expression,cols.map(c=>c.id==='D'?{...c,name:'Subtotal'}:c)),'=ROUND({Subtotal},2)+1','display follows renamed columns');
 });

 await check('the Operational Tracking example exists in a new sample database only',()=>{
  const b=s.get("SELECT * FROM tm_boards WHERE name='Operational Tracking'");assert.ok(b,'seeded with the other sample data');
  const r=s.tasks.groups.read(b.id,VANNA);assert.deepEqual(r.columns.map(c=>c.name),['Item','Quantity','Unit Price','Subtotal','Discount','Net Amount','Date','Status','In Charge','Support']);
  const row=r.rows[0],col=n=>r.columns.find(c=>c.name===n).id;
  assert.equal(row.values[col('Item')],'Office supplies');assert.equal(row.computed[col('Subtotal')],50);assert.equal(row.computed[col('Net Amount')],45);assert.equal(row.values[col('Date')],'2026-10-01');
  // An existing database (it already has a company) is never given sample data.
  const other=openStore(path.join(folder,'existing.sqlite'));other.insert('company',{id:1,name:'Existing company',address:'',currency:'USD'});other.db.close();
  const again=openStore(path.join(folder,'existing.sqlite'));assert.equal(again.get('SELECT COUNT(*) n FROM tm_boards').n,0);again.db.close();
 });

 // ================================================================ Groups: the acceptance checks, over HTTP
 const port=4354,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data}={})=>{const r=await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body,headers:r.headers};};
 const login=async(email,password,company='default')=>{const r=await fetch(`${base}/c/${company}/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,email);return r.headers.get('set-cookie').split(';')[0];};
 const C={vanna:await login('vanna@example.test','vanna-password-1'),sophea:await login('sophea@example.test','sophea-password-1'),dara:await login('dara@example.test','dara-password-12'),chantha:await login('chantha@example.test','local-password-1'),bopha:await login('bopha@example.test','local-password-1'),kosal:await login('kosal@example.test','local-password-1')};
 const api=async(who,action,data)=>request('/c/default/api/command',{cookie:C[who],data:{action,data}});
 const ok=async(who,action,data)=>{const r=await api(who,action,data);assert.equal(r.status,200,`${action}: ${JSON.stringify(r.body)}`);return r.body.result;};
 const read=async(who,id)=>request(`/c/default/api/tasks/group?id=${encodeURIComponent(id)}`,{cookie:C[who]});
 const group=async(who,id)=>{const r=await read(who,id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 const colId=(g,name)=>g.columns.find(c=>c.name===name).id;
 let G1,G2;

 await check('1. two groups in one workspace, each with its own structure; a new group starts with a renameable “Item” column',async()=>{
  G1=(await ok('sophea','tm.group.save',{workspace_id:ws,name:'Operational Tracking QA',description:'Purchases with formulas.',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT'})).id;
  G2=(await ok('sophea','tm.group.save',{workspace_id:ws,name:'Supplier visits',visibility:'TEAM',audience:'SELECTED',shared:[{staff_id:CHANTHA,level:'VIEW'},{staff_id:DARA,level:'MANAGE'}]})).id;
  let g1=await group('sophea',G1),g2=await group('sophea',G2);
  assert.deepEqual(g1.columns.map(c=>`${c.name}:${c.type}`),['Item:TEXT']);assert.deepEqual(g2.columns.map(c=>c.name),['Item']);
  await ok('sophea','tm.group.column.save',{group_id:G2,id:colId(g2,'Item'),expected_version:0,name:'Supplier',type:'TEXT'});
  await ok('sophea','tm.group.column.save',{group_id:G2,name:'Visit date',type:'DATE'});
  g1=await group('sophea',G1);g2=await group('sophea',G2);
  assert.deepEqual(g1.columns.map(c=>c.name),['Item'],'changing one group never changes another');assert.deepEqual(g2.columns.map(c=>c.name),['Supplier','Visit date']);
  const st=(await request('/c/default/api/state',{cookie:C.sophea})).body;assert.ok(st.tm_boards.some(b=>b.id===G1)&&st.tm_boards.some(b=>b.id===G2));
  assert.ok(st.tm_group_workspaces.includes(ws));
 });

 await check('2–5. all seven column types, cell edits, formulas (10 × 5 = 50, 45; then 12 → 60, 55) and deleting a record',async()=>{
  for(const [name,type,settings] of [['Quantity','NUMBER',{}],['Unit Price','NUMBER',{decimals:2}],['Subtotal','FORMULA',{expression:'={Quantity} * {Unit Price}'}],['Discount','NUMBER',{}],['Net Amount','FORMULA',{expression:'{Subtotal} - {Discount}'}],['Date','DATE',{}],['Status','STATUS',{}],['In Charge','IN_CHARGE',{}],['Support','SUPPORT',{}]])
   await ok('sophea','tm.group.column.save',{group_id:G1,name,type,settings});
  let g=await group('sophea',G1);
  assert.deepEqual(g.columns.map(c=>c.type),['TEXT','NUMBER','NUMBER','FORMULA','NUMBER','FORMULA','DATE','STATUS','IN_CHARGE','SUPPORT']);
  assert.deepEqual(g.columns.find(c=>c.name==='Status').settings.labels.map(l=>l.name),['Not Started','In Progress','On Hold','Done'],'editable default labels');
  assert.equal(g.columns.find(c=>c.name==='Net Amount').settings.display,'={Subtotal} - {Discount}','a leading = is optional');
  // Eligible people come from the workspace membership (search and paging), not from other workspaces or companies.
  const people=(await request(`/c/default/api/tasks/group/members?id=${G1}`,{cookie:C.sophea})).body;
  assert.deepEqual(people.items.map(p=>p.id).sort(),[SOPHEA,DARA,CHANTHA,BOPHA,MONY].sort());assert.equal(people.total,5);
  assert.deepEqual((await request(`/c/default/api/tasks/group/members?id=${G1}&q=dara`,{cookie:C.sophea})).body.items.map(p=>p.id),[DARA]);
  const page=(await request(`/c/default/api/tasks/group/members?id=${G1}&limit=2&offset=2`,{cookie:C.sophea})).body;assert.equal(page.items.length,2);assert.equal(page.total,5);
  const row=(await ok('dara','tm.group.row.add',{group_id:G1,values:{[colId(g,'Item')]:'Office supplies',[colId(g,'Quantity')]:10,[colId(g,'Unit Price')]:'5',[colId(g,'Discount')]:5,[colId(g,'Date')]:'2026-10-01',[colId(g,'In Charge')]:DARA,[colId(g,'Support')]:[CHANTHA,BOPHA]}})).row;
  assert.equal(row.computed[colId(g,'Subtotal')],50);assert.equal(row.computed[colId(g,'Net Amount')],45);
  const inProgress=g.columns.find(c=>c.name==='Status').settings.labels.find(l=>l.name==='In Progress').id;
  const upd=(await ok('dara','tm.group.row.update',{group_id:G1,id:row.id,values:{[colId(g,'Status')]:inProgress,[colId(g,'Quantity')]:12},expected:{[colId(g,'Status')]:null,[colId(g,'Quantity')]:10}})).row;
  assert.equal(upd.computed[colId(g,'Subtotal')],60);assert.equal(upd.computed[colId(g,'Net Amount')],55);
  // Unicode / Khmer and long multi-line text are kept exactly.
  const khmer='ក្រដាស A4 សម្រាប់ការិយាល័យ\nបន្ទាត់ទីពីរ';
  await ok('dara','tm.group.row.update',{group_id:G1,id:row.id,values:{[colId(g,'Item')]:khmer},expected:{[colId(g,'Item')]:'Office supplies'}});
  g=await group('dara',G1);assert.equal(g.rows[0].values[colId(g,'Item')],khmer);
  await ok('dara','tm.group.row.update',{group_id:G1,id:row.id,values:{[colId(g,'Item')]:'Office supplies'},expected:{[colId(g,'Item')]:khmer}});
  // Values are checked by type; formula results can't be typed in; stale edits are refused.
  const bad=async(values,expected,pattern,status=422)=>{const r=await api('dara','tm.group.row.update',{group_id:G1,id:row.id,values,expected});assert.equal(r.status,status,JSON.stringify(r.body));assert.match(r.body.error,pattern);return r;};
  await bad({[colId(g,'Quantity')]:'ten'},{[colId(g,'Quantity')]:12},/isn’t a number/);
  await bad({[colId(g,'Date')]:'2026-02-30'},{[colId(g,'Date')]:'2026-10-01'},/valid date/);
  await bad({[colId(g,'Status')]:'Maybe'},{[colId(g,'Status')]:inProgress},/Choose one of this column’s labels/);
  await bad({[colId(g,'Subtotal')]:999},{[colId(g,'Subtotal')]:null},/calculated/);
  await bad({[colId(g,'In Charge')]:KOSAL},{[colId(g,'In Charge')]:DARA},/active member who can see this group/);
  await bad({[colId(g,'In Charge')]:FINANCE},{[colId(g,'In Charge')]:DARA},/active member/);
  const conflict=await bad({[colId(g,'Quantity')]:13},{[colId(g,'Quantity')]:10},/Someone changed “Quantity” in this row to “12”/,409);assert.equal(conflict.body.details.code,'cell_conflict');
  // A second record, then delete it.
  const extra=(await ok('dara','tm.group.row.add',{group_id:G1,values:{[colId(g,'Item')]:'Printer ink',[colId(g,'Quantity')]:2,[colId(g,'Unit Price')]:12.5}})).row;
  assert.equal(extra.computed[colId(g,'Subtotal')],25);assert.equal(extra.computed[colId(g,'Net Amount')],25,'an empty Discount counts as 0');
  await ok('dara','tm.group.row.delete',{group_id:G1,id:extra.id,expected_version:extra.version});
  g=await group('dara',G1);assert.equal(g.rows.length,1);
  assert.ok(s.get("SELECT 1 AS ok FROM tm_events WHERE entity_type='group' AND entity_id=? AND action='Row deleted'",G1),'deleting is recorded');
  // Choosing people or a status never creates tasks.
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_tasks WHERE title LIKE 'Office supplies%'").n,0);
 });

 await check('6. renaming Unit Price to Price and reordering columns keeps values and formulas working',async()=>{
  let g=await group('sophea',G1);const price=g.columns.find(c=>c.name==='Unit Price');
  await ok('sophea','tm.group.column.save',{group_id:G1,id:price.id,expected_version:price.version,name:'Price',type:'NUMBER',settings:{decimals:2}});
  const order=g.columns.map(c=>c.id).reverse();await ok('sophea','tm.group.column.move',{group_id:G1,order});
  g=await group('sophea',G1);
  assert.deepEqual(g.columns.map(c=>c.id),order);assert.equal(g.columns.find(c=>c.name==='Subtotal').settings.display,'={Quantity} * {Price}');
  assert.equal(g.rows[0].computed[colId(g,'Subtotal')],60);assert.equal(g.rows[0].computed[colId(g,'Net Amount')],55);
  await ok('dara','tm.group.row.update',{group_id:G1,id:g.rows[0].id,values:{[colId(g,'Price')]:4.5},expected:{[colId(g,'Price')]:5}});
  g=await group('sophea',G1);assert.equal(g.rows[0].computed[colId(g,'Subtotal')],54);assert.equal(g.rows[0].computed[colId(g,'Net Amount')],49);
  await ok('sophea','tm.group.column.move',{group_id:G1,order:order.slice().reverse()});
  const dup=await api('sophea','tm.group.column.save',{group_id:G1,name:'price',type:'NUMBER'});assert.equal(dup.status,409);assert.match(dup.body.error,/already has a column named/);
 });

 await check('7. invalid formulas, loops, division by zero, and deleting or changing a column that formulas use',async()=>{
  let g=await group('sophea',G1);
  const add=async(expression,pattern)=>{const r=await api('sophea','tm.group.column.save',{group_id:G1,name:'Check',type:'FORMULA',settings:{expression}});assert.equal(r.status,422,expression);assert.match(r.body.error,pattern);assert.equal(r.body.details.code,'formula');};
  await add('=SUMIF({Quantity})',/SUMIF isn’t supported/);await add('={Nope}*2',/no column named/);await add('={Item}*2',/Text column/);await add('={Quantity}*(2',/missing its closing/);
  const sub=g.columns.find(c=>c.name==='Subtotal');
  const loop=await api('sophea','tm.group.column.save',{group_id:G1,id:sub.id,expected_version:sub.version,name:'Subtotal',type:'FORMULA',settings:{expression:'={Net Amount} + 1'}});
  assert.equal(loop.status,422);assert.match(loop.body.error,/loop: Subtotal → Net Amount → Subtotal/);
  const self=await api('sophea','tm.group.column.save',{group_id:G1,id:sub.id,expected_version:sub.version,name:'Subtotal',type:'FORMULA',settings:{expression:'={Subtotal} * 2'}});assert.match(self.body.error,/its own column/);
  // Division by zero shows #DIV/0! in the cell (and in the CSV), and no misleading total.
  const per=(await ok('sophea','tm.group.column.save',{group_id:G1,name:'Per unit',type:'FORMULA',settings:{expression:'={Net Amount} / {Discount}',decimals:2}})).id;
  const zero=(await ok('dara','tm.group.row.add',{group_id:G1,values:{[colId(g,'Item')]:'Free sample',[colId(g,'Quantity')]:1,[colId(g,'Price')]:3,[colId(g,'Discount')]:0}})).row;
  assert.deepEqual(zero.computed[per],{error:'#DIV/0!'});
  // V5.5: the export is an Excel workbook (it replaced CSV); the error is an Excel error cell.
  const xlsxOf=async(url,cookie)=>{const r=await fetch(base+url,{headers:{Origin:base,Cookie:cookie}});return {status:r.status,headers:r.headers,sheets:r.status===200?readXlsx(Buffer.from(await r.arrayBuffer())):null};};
  const book=await xlsxOf(`/c/default/api/tasks/group.xlsx?id=${G1}`,C.sophea);assert.equal(book.status,200);assert.ok(book.sheets[0].rows.flat().some(c=>c?.error==='#DIV/0!'));assert.match(book.headers.get('content-disposition'),/Operational%20Tracking%20QA\.xlsx/);
  const guarded=(await ok('sophea','tm.group.column.save',{group_id:G1,name:'Safe per unit',type:'FORMULA',settings:{expression:'=IF({Discount}>0, {Net Amount}/{Discount}, 0)'}})).id;
  g=await group('sophea',G1);assert.equal(g.rows.find(r=>r.id===zero.id).computed[guarded],0);
  // A column that formulas use can't be deleted or turned into another type until those formulas change.
  const qty=g.columns.find(c=>c.name==='Quantity');
  const del=await api('sophea','tm.group.column.delete',{group_id:G1,id:qty.id,expected_version:qty.version,confirm:true});assert.equal(del.status,409);assert.match(del.body.error,/used by “Subtotal”/);assert.equal(del.body.details.code,'dependents');
  const retype=await api('sophea','tm.group.column.save',{group_id:G1,id:qty.id,expected_version:qty.version,name:'Quantity',type:'TEXT'});assert.equal(retype.status,409);assert.match(retype.body.error,/“Subtotal” uses this column/);
  assert.deepEqual(g.columns.find(c=>c.name==='Quantity').used_by,[colId(g,'Subtotal')]);
  // Formula columns that nothing uses can be deleted.
  for(const id of [per,guarded]){const col=(await group('sophea',G1)).columns.find(c=>c.id===id);await ok('sophea','tm.group.column.delete',{group_id:G1,id,expected_version:col.version,confirm:true});}
  await ok('dara','tm.group.row.delete',{group_id:G1,id:zero.id});
 });

 await check('type changes keep what fits, ask before clearing, and status labels keep rows when renamed or replaced',async()=>{
  let g=await group('sophea',G2);const r1=(await ok('sophea','tm.group.row.add',{group_id:G2,values:{[colId(g,'Supplier')]:'Mekong Supply'}})).row;
  const notes=(await ok('sophea','tm.group.column.save',{group_id:G2,name:'Rating',type:'TEXT'})).id;
  await ok('sophea','tm.group.row.update',{group_id:G2,id:r1.id,values:{[notes]:'4.5'},expected:{[notes]:null}});
  const r2=(await ok('sophea','tm.group.row.add',{group_id:G2,values:{[colId(g,'Supplier')]:'Angkor Paper',[notes]:'good'}})).row;
  g=await group('sophea',G2);let col=g.columns.find(c=>c.id===notes);
  const ask=await api('sophea','tm.group.column.save',{group_id:G2,id:notes,expected_version:col.version,name:'Rating',type:'NUMBER'});
  assert.equal(ask.status,409);assert.equal(ask.body.details.code,'type_change');assert.equal(ask.body.details.count,1);assert.match(ask.body.error,/“good”/);
  await ok('sophea','tm.group.column.save',{group_id:G2,id:notes,expected_version:col.version,name:'Rating',type:'NUMBER',confirm_clear:true});
  g=await group('sophea',G2);assert.equal(g.rows.find(r=>r.id===r1.id).values[notes],4.5);assert.equal(g.rows.find(r=>r.id===r2.id).values[notes],undefined);
  // Text to Status: each distinct text becomes a label.
  const stage=(await ok('sophea','tm.group.column.save',{group_id:G2,name:'Stage',type:'TEXT'})).id;
  await ok('sophea','tm.group.row.update',{group_id:G2,id:r1.id,values:{[stage]:'Visited'},expected:{[stage]:null}});
  await ok('sophea','tm.group.row.update',{group_id:G2,id:r2.id,values:{[stage]:'Planned'},expected:{[stage]:null}});
  g=await group('sophea',G2);col=g.columns.find(c=>c.id===stage);
  await ok('sophea','tm.group.column.save',{group_id:G2,id:stage,expected_version:col.version,name:'Stage',type:'STATUS'});
  g=await group('sophea',G2);col=g.columns.find(c=>c.id===stage);const labels=col.settings.labels;assert.deepEqual(labels.map(l=>l.name).sort(),['Planned','Visited']);
  const visited=labels.find(l=>l.name==='Visited'),planned=labels.find(l=>l.name==='Planned');
  assert.equal(g.rows.find(r=>r.id===r1.id).values[stage],visited.id);
  // Renaming a label keeps it on every row.
  await ok('sophea','tm.group.column.save',{group_id:G2,id:stage,expected_version:col.version,name:'Stage',type:'STATUS',settings:{labels:[{...visited,name:'Visit done',color:'GREEN'},planned]}});
  g=await group('sophea',G2);col=g.columns.find(c=>c.id===stage);assert.equal(g.rows.find(r=>r.id===r1.id).values[stage],visited.id);assert.equal(col.settings.labels.find(l=>l.id===visited.id).name,'Visit done');
  // Removing a label that rows use needs a replacement, or clearing those cells on purpose.
  const removing=await api('sophea','tm.group.column.save',{group_id:G2,id:stage,expected_version:col.version,name:'Stage',type:'STATUS',settings:{labels:[col.settings.labels.find(l=>l.id===planned.id)]}});
  assert.equal(removing.status,409);assert.equal(removing.body.details.code,'labels_in_use');assert.deepEqual(removing.body.details.labels.map(l=>[l.name,l.count]),[['Visit done',1]]);
  await ok('sophea','tm.group.column.save',{group_id:G2,id:stage,expected_version:col.version,name:'Stage',type:'STATUS',settings:{labels:[col.settings.labels.find(l=>l.id===planned.id)]},label_replacements:{[visited.id]:planned.id}});
  g=await group('sophea',G2);assert.equal(g.rows.find(r=>r.id===r1.id).values[stage],planned.id);col=g.columns.find(c=>c.id===stage);
  await ok('sophea','tm.group.column.save',{group_id:G2,id:stage,expected_version:col.version,name:'Stage',type:'STATUS',settings:{labels:[{name:'New label',color:'BLUE'}]},label_replacements:{[planned.id]:null}});
  g=await group('sophea',G2);assert.ok(g.rows.every(r=>r.values[stage]===undefined),'cleared only after the explicit choice');
 });

 await check('8. reloading (a new connection to the database) keeps structure, values, formulas, sharing and people',async()=>{
  const before=await group('sophea',G1);
  const again=openStore(path.join(folder,'erp.sqlite'));
  try{
   const after=again.tasks.groups.read(G1,SOPHEA);
   assert.deepEqual(after.columns.map(c=>[c.id,c.name,c.type,JSON.stringify(c.settings)]),before.columns.map(c=>[c.id,c.name,c.type,JSON.stringify(c.settings)]));
   assert.deepEqual(after.rows.map(r=>[r.id,r.values,r.computed]),before.rows.map(r=>[r.id,r.values,r.computed]));
   assert.equal(after.group.visibility,'TEAM');assert.equal(after.group.audience,'WORKSPACE');
   const g2=again.tasks.groups.read(G2,SOPHEA);assert.deepEqual(g2.group.shared.map(a=>[a.staff_id,a.level]).sort(),[[CHANTHA,'VIEW'],[DARA,'MANAGE']].sort());
   assert.equal(after.rows[0].values[colId(after,'In Charge')],DARA);assert.deepEqual(after.rows[0].values[colId(after,'Support')],[CHANTHA,BOPHA]);
  }finally{again.db.close();}
 });

 await check('9. private and shared access, levels, and denial of direct API requests across workspaces and companies',async()=>{
  const P=(await ok('dara','tm.group.save',{workspace_id:ws,name:'My own list',visibility:'PERSONAL'})).id;
  // Personal: nobody else sees or opens it, not even an administrator.
  for(const who of ['sophea','vanna','chantha']){
   assert.ok(!(await request('/c/default/api/state',{cookie:C[who]})).body.tm_boards.some(b=>b.id===P),`${who} does not see it`);
   assert.equal((await read(who,P)).status,404);assert.equal((await api(who,'tm.group.row.add',{group_id:P})).status,404);
  }
  assert.equal((await read('dara',P)).status,200);
  // Choosing someone in a personal group does not give them access.
  let p=await group('dara',P);await ok('dara','tm.group.column.save',{group_id:P,name:'Owner',type:'IN_CHARGE'});p=await group('dara',P);
  await ok('dara','tm.group.row.add',{group_id:P,values:{[colId(p,'Owner')]:SOPHEA}});assert.equal((await read('sophea',P)).status,404);
  // Selected people with levels: Chantha can view only; Dara can manage; Bopha is not listed.
  assert.equal((await read('chantha',G2)).status,200);
  let g2=await group('chantha',G2);assert.equal(g2.group.caps.editRows,false);
  assert.equal((await api('chantha','tm.group.row.add',{group_id:G2})).status,403);
  assert.equal((await api('chantha','tm.group.row.update',{group_id:G2,id:g2.rows[0].id,values:{[colId(g2,'Supplier')]:'x'},expected:{[colId(g2,'Supplier')]:'Mekong Supply'}})).status,403);
  assert.equal((await read('bopha',G2)).status,404);assert.equal((await read('kosal',G2)).status,404);
  assert.equal((await ok('dara','tm.group.column.save',{group_id:G2,name:'Contact person',type:'TEXT'})).type,'tm_group_column','“Can manage” changes the structure');
  const noShare=await api('dara','tm.group.save',{id:G2,expected_version:(await group('dara',G2)).group.version,name:'Supplier visits',visibility:'PERSONAL'});assert.equal(noShare.status,403);assert.match(noShare.body.error,/Only the group’s owner/);
  // The members of a group shared with selected people are limited to them.
  assert.deepEqual((await request(`/c/default/api/tasks/group/members?id=${G2}`,{cookie:C.dara})).body.items.map(x=>x.id).sort(),[SOPHEA,DARA,CHANTHA].sort());
  // Whole workspace, “can edit records”: Bopha’s role (Viewer) can open it but not change it.
  assert.equal((await read('bopha',G1)).status,200);const add=await api('bopha','tm.group.row.add',{group_id:G1});assert.equal(add.status,403);assert.match(add.body.error,/does not allow create/);
  // Chantha (Team Member role, in the workspace) edits records but can't change the structure.
  const g1=await group('chantha',G1);assert.equal(g1.group.caps.editRows,true);assert.equal(g1.group.caps.structure,false);
  assert.equal((await api('chantha','tm.group.column.save',{group_id:G1,name:'Mine',type:'TEXT'})).status,403);
  // Another workspace: Kosal is not a member, so the workspace's groups don't exist for him.
  assert.equal((await read('kosal',G1)).status,404);assert.equal((await api('kosal','tm.group.row.add',{group_id:G1})).status,404);
  assert.equal((await api('kosal','tm.group.save',{workspace_id:ws,name:'Sneaky',visibility:'PERSONAL'})).status,403);
  assert.ok(!(await request('/c/default/api/state',{cookie:C.kosal})).body.tm_boards.some(b=>b.workspace_id===ws));
  // Group administrators (Administrator role) can open and manage team groups not shared with them.
  const admin=await group('vanna',G2);assert.equal(admin.group.caps.structure,true);
  // Another company: its own database; the group IDs of this company do not exist there, and cookies do not cross.
  const second=(await request('/c/default/api/companies',{cookie:C.vanna,data:{name:'Second Company V54',admin_name:'Second admin',admin_email:'second@example.test',admin_password:'second-company-pass'}})).body.result.id;
  const sc=await login('second@example.test','second-company-pass',second);
  assert.equal((await request(`/c/${second}/api/tasks/group?id=${G1}`,{cookie:sc})).status,404);
  assert.equal((await request(`/c/${second}/api/command`,{cookie:sc,data:{action:'tm.group.row.update',data:{group_id:G1,id:'ROW-000001',values:{},expected:{}}}})).status,404);
  assert.equal((await request(`/c/${second}/api/tasks/group?id=${G1}`,{cookie:C.vanna})).status,401,'a cookie of one company is not valid in another');
  assert.equal((await request(`/c/default/api/tasks/group?id=${G1}`,{cookie:sc})).status,401);
  assert.equal((await request(`/c/${second}/api/tasks/group/members?id=${G1}`,{cookie:sc})).status,404);
  // Signed-out and forged requests.
  assert.equal((await request(`/c/default/api/tasks/group?id=${G1}`)).status,401);
  const forged=await fetch(`${base}/c/default/api/command`,{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json',Cookie:C.sophea},body:JSON.stringify({action:'tm.group.row.add',data:{group_id:G1}})});assert.equal(forged.status,403);
 });

 await check('archiving makes a group read-only; deleting needs an archived group and confirmation; CSV export needs Export',async()=>{
  const g=await group('sophea',G2);
  assert.equal((await api('chantha','tm.group.archive',{id:G2,expected_version:g.group.version,status:'ARCHIVED'})).status,403);
  await ok('sophea','tm.group.archive',{id:G2,expected_version:g.group.version,status:'ARCHIVED'});
  const a=await group('sophea',G2);assert.equal(a.group.caps.addRows,false);
  const blocked=await api('sophea','tm.group.row.add',{group_id:G2});assert.equal(blocked.status,409);assert.match(blocked.body.error,/archived/);
  assert.equal((await api('sophea','tm.group.delete',{id:G2,expected_version:a.group.version})).status,409,'needs confirmation');
  await ok('sophea','tm.group.archive',{id:G2,expected_version:a.group.version,status:'ACTIVE'});
  const r=await group('sophea',G2);assert.equal((await api('sophea','tm.group.delete',{id:G2,expected_version:r.group.version,confirm:true})).status,409,'only archived groups');
  await ok('sophea','tm.group.archive',{id:G2,expected_version:r.group.version,status:'ARCHIVED'});
  const d=await ok('sophea','tm.group.delete',{id:G2,expected_version:r.group.version+1,confirm:true});assert.match(d.message,/Group deleted with its/);
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_board_rows WHERE board_id=?',G2).n,0);assert.equal(s.get('SELECT COUNT(*) n FROM tm_board_columns WHERE board_id=?',G2).n,0);
  assert.ok(s.get("SELECT 1 AS ok FROM tm_events WHERE entity_type='group' AND entity_id=? AND action='Group deleted permanently'",G2));
  assert.equal((await request(`/c/default/api/tasks/group.xlsx?id=${G1}`,{cookie:C.bopha})).status,403,'the Viewer role has no Export');
  const g1=await group('dara',G1);await ok('dara','tm.group.row.update',{group_id:G1,id:g1.rows[0].id,values:{[colId(g1,'Item')]:'=HYPERLINK("x")'},expected:{[colId(g1,'Item')]:'Office supplies'}});
  const r2=await fetch(`${base}/c/default/api/tasks/group.xlsx?id=${G1}`,{headers:{Origin:base,Cookie:C.dara}}),cells=readXlsx(Buffer.from(await r2.arrayBuffer()))[0].rows.flat().filter(Boolean);
  assert.ok(cells.some(c=>c.v==='=HYPERLINK("x")'&&!c.formula),'text that looks like a formula is exported as text, never as a formula');assert.ok(cells.some(c=>c.v===54),'numbers stay numbers');
  // Group events stay out of other people’s screen data.
  assert.ok(!(await request('/c/default/api/state',{cookie:C.kosal})).body.tm_events.some(e=>e.entity_type==='group'));
 });

 await check('access levels follow the same rules on the server and in the screens',()=>{
  const b={owner_id:'A',visibility:'TEAM',audience:'SELECTED',workspace_level:'EDIT'},all=()=>true;
  assert.equal(groupLevel(b,'A'),LEVELS.OWNER);assert.equal(groupLevel(b,'B',{member:true}),0);assert.equal(groupLevel(b,'B',{member:true,level:'VIEW'}),LEVELS.VIEW);assert.equal(groupLevel(b,'B',{member:false,level:'MANAGE'}),0,'members only');
  assert.equal(groupLevel({...b,audience:'WORKSPACE'},'B',{member:true}),LEVELS.EDIT);assert.equal(groupLevel({...b,visibility:'PERSONAL'},'B',{member:true,admin:true,level:'MANAGE'}),0);
  const caps=groupCaps(LEVELS.EDIT,all);assert.deepEqual([caps.editRows,caps.structure,caps.share,caps.archive],[true,false,false,false]);
  // V5.5: seeAll (managers see every row and column whatever its access rule) is about seeing, not a kind of change.
  assert.deepEqual(Object.entries(groupCaps(LEVELS.MANAGE,a=>a==='view')).filter(([k,v])=>v===true&&k!=='seeAll').length,1,'the role limits what access allows');
 });

 await check('10. existing workspace and task work still behaves: create, accept, progress and close a self-assigned task, archive a workspace',()=>{
  const w=cmd('tm.workspace.save',{name:'Regression workspace',owner_id:DARA,member_ids:[DARA]},DARA).id;
  const id=cmd('tm.task.save',{workspace_id:w,title:'Regression task',start_date:today,due_date:addDays(today,1),pic_id:DARA},DARA).id;
  cmd('tm.task.progress',{id,progress:50},DARA);cmd('tm.task.close',{id},DARA);assert.equal(task(id).status,'COMPLETED');
  cmd('tm.workspace.archive',{id:w,expected_version:0,status:'ARCHIVED'},DARA);assert.equal(s.get('SELECT status FROM tm_workspaces WHERE id=?',w).status,'ARCHIVED');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');
 });

 await check('the ERP and the Telegram Mini App see and decide the same change requests',async()=>{
  const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
  s.run("UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1",TOKEN);s.telegram.connectSignedIn(DARA,{id:7101,first_name:'Dara'},7101);
  gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const gw=`http://127.0.0.1:${gateway.address().port}/c/default/tg/api`,init=signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'V54',user:{id:7101,first_name:'Dara'}},TOKEN);
  const call=async(p,data)=>{const r=await fetch(gw+p,{method:data?'POST':'GET',headers:{Authorization:'tma '+init,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json()};};
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Synchronised approval',start_date:today,due_date:addDays(today,3),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  const asked=await ok('sophea','tm.task.save',{...edit(id),due_date:addDays(today,6)});
  const mini=(await call('/state')).body;assert.equal(mini.tm_change_requests.find(c=>c.id===asked.change_id).status,'PENDING');assert.ok(mini.tm_tasks.some(t=>t.id===id));
  assert.equal((await call('/command',{action:'tm.change.decide',data:{id:asked.change_id,decision:'APPROVE'}})).status,200);
  const erp=(await request('/c/default/api/state',{cookie:C.sophea})).body;
  assert.equal(erp.tm_change_requests.find(c=>c.id===asked.change_id).status,'APPROVED');assert.equal(erp.tm_tasks.find(t=>t.id===id).due_date,addDays(today,6));
  assert.equal(change(asked.change_id).decision_source,'MINIAPP');assert.equal(change(asked.change_id).source,'WEB');
  assert.equal((await call('/command',{action:'tm.task.reminders',data:{id,reminder_days:[2,1]}})).status,200,'reminders can be set in the Mini App');
 });

 console.log(`\n${checks} V5.4 checks passed (two-party approval, notifications, reminders, dashboard, Groups). Temporary data only.`);
}finally{
 gateway?.close();if(server)await new Promise(r=>server.close(r));
 hub.close();rmSync(folder,{recursive:true,force:true});
}

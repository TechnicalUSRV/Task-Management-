import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {createLocalServer} from './server.mjs';
import {taskToday,addDays,buildTaskReport,monthlyTaskRows,taskActions,enrichedTasks,shiftMonth,currentMonth} from './task-domain.mjs';
import {createTelegramRuntime,parseCommand,parseDay} from './telegram-bot.mjs';
import {createTelegramGateway,validateInitData,signInitData,miniAppUrl} from './telegram-gateway.mjs';

// V5.2 Task workflow, monthly reports, Telegram bot (against a local mock of the Telegram Bot API) and the
// Mini App gateway. No real Telegram servers are contacted.
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v52-')),filename=path.join(folder,'test.sqlite');
let s=openStore(filename),checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
// V5.5: on a task someone else assigned, a new progress figure waits for the other side's approval. Checks written for
// earlier versions approve it straight away, so they keep testing what they were written for.
const approveChange=r=>r&&r.change_id?s.command('tm.change.decide',{id:r.change_id,decision:'APPROVE'},s.get('SELECT approver_id FROM tm_change_requests WHERE id=?',r.change_id).approver_id):r;
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const task=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const notes=(staff,kind)=>s.all('SELECT * FROM tm_notifications WHERE staff_id=? AND kind=? ORDER BY id',staff,kind);
const waitFor=async(fn,label,ms=6000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw new Error('Timed out waiting for '+label);await new Promise(r=>setTimeout(r,40));}};
const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==','base64');
// V5.6.8: attachments must really be what their name says, so the fake Telegram returns a PDF for documents.
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const DARA='STAFF-001',SOPHEA='STAFF-002',VANNA='STAFF-003';let CHANTHA;
let ws,t1,server,base,mock,runtime,gateway,gatewayBase;
try{
 seedDemo(s);
 // Accounts: Vanna administrator, Sophea manager (can approve), Dara team member, Chantha viewer.
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 cmd('admin.user.save',{name:'Chantha · Viewer',email:'chantha@example.test',role_id:'ROLE-VIEWER',password:'chantha-password',active:1},VANNA);
 CHANTHA=s.get("SELECT staff_id FROM access_users WHERE email='chantha@example.test'").staff_id;

 await check('upgrade gives every task a person in charge, reviewer, department and history; Manager can approve',()=>{
  for(const v of [6,7,8])assert.ok(s.get('SELECT version FROM schema_version WHERE version=?',v),'schema '+v);
  const st=s.state();assert.equal(st.tm_tasks.length,6);
  for(const t of st.tm_tasks){assert.ok(t.pic_id&&t.reviewer_id&&t.department,t.id);assert.ok(st.tm_task_history.some(h=>h.task_id===t.id&&h.kind==='create'));}
  assert.equal(s.access.canStaff(SOPHEA,'tasks.tasks','approve'),true);assert.equal(s.access.canStaff(DARA,'tasks.tasks','approve'),false);assert.equal(s.access.canStaff(VANNA,'tasks.tasks','approve'),true);
  assert.deepEqual(s.access.taskPeople().filter(m=>m.approver).map(m=>m.staff_id).sort(),[SOPHEA,VANNA]);
  assert.deepEqual(s.access.taskPeople().map(m=>m.staff_id).sort(),[DARA,SOPHEA,VANNA,CHANTHA].sort(),'V5.3: everyone with Task Management can be chosen');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
 });

 await check('person in charge accepts or declines; supporters wait for acceptance; progress is 0–99',()=>{
  ws=cmd('tm.workspace.save',{name:'Workflow QA',department:'Operations',owner_id:SOPHEA,member_ids:[DARA,SOPHEA,VANNA,CHANTHA]},SOPHEA).id;
  t1=cmd('tm.task.save',{workspace_id:ws,title:'Prepare the monthly customs file',description:'All documents for September.',start_date:taskToday(),due_date:addDays(taskToday(),5),pic_id:DARA,supporter_ids:[VANNA],department:'Customs',department_note:'Customs team signs off.'},SOPHEA).id;
  let t=task(t1);assert.equal(t.pic_id,DARA);assert.equal(t.reviewer_id,SOPHEA);assert.equal(t.accepted_at,null);assert.equal(t.department,'Customs');assert.equal(t.department_note,'Customs team signs off.');
  assert.deepEqual(s.tasks.supportersOf(t),[VANNA]);
  assert.equal(notes(DARA,'task_assigned').at(-1).task_id,t1);assert.equal(notes(VANNA,'task_supporting').at(-1).task_id,t1);
  fails(()=>cmd('tm.task.progress',{id:t1,progress:20},VANNA),/must accept this task first/,409);
  assert.match(cmd('tm.task.accept',{id:t1},VANNA).message,/supporting this task/,'V5.3: supporting people confirm too');
  // V5.5: a task outside someone's Task Visibility Scope is answered as if it did not exist.
  fails(()=>cmd('tm.task.accept',{id:t1},CHANTHA),/not found/,404);
  fails(()=>cmd('tm.task.decline',{id:t1},DARA),/Reason for rejecting/);
  cmd('tm.task.decline',{id:t1,note:'I am on leave next week.'},DARA);
  assert.ok(task(t1).declined_at);assert.match(notes(SOPHEA,'task_declined').at(-1).body,/on leave/);
  fails(()=>cmd('tm.task.progress',{id:t1,progress:10},DARA),/rejected this task/,409);
  const r=cmd('tm.task.accept',{id:t1},DARA);assert.match(r.message,/accepted/);
  t=task(t1);assert.equal(t.status,'IN_PROGRESS');assert.equal(t.declined_at,null);assert.ok(t.accepted_at);
  assert.equal(cmd('tm.task.accept',{id:t1},DARA).unchanged,true);
  approveChange(cmd('tm.task.progress',{id:t1,progress:30,note:'Invoices collected.'},VANNA));assert.equal(task(t1).progress,30);
  assert.match(notes(DARA,'task_progress').at(-1).body,/Invoices collected/);
  fails(()=>cmd('tm.task.progress',{id:t1,progress:100},DARA),/0–99/);
  fails(()=>cmd('tm.task.progress',{id:t1,progress:40},CHANTHA),/not found/,404);
 });

 await check('V5.4 completing needs both sides: the assigner’s side asks, the person in charge submits for approval',()=>{
  // Sophea assigned the task and Dara accepted it: Sophea (or a task approver such as Vanna) can only ask Dara to agree.
  const asked=cmd('tm.task.close',{id:t1,note:'Looks complete to me.'},SOPHEA);assert.match(asked.message,/Sent to Dara/);assert.ok(asked.change_id);
  assert.equal(task(t1).status,'IN_PROGRESS','nothing changes until the other side approves');
  fails(()=>cmd('tm.task.close',{id:t1},VANNA),/already waiting for approval/,409);
  fails(()=>cmd('tm.task.close',{id:t1},CHANTHA),/not found/,404);
  assert.equal(notes(DARA,'change_request').at(-1).task_id,t1);
  fails(()=>cmd('tm.change.decide',{id:asked.change_id,decision:'REJECT'},DARA),/Reason for rejecting/);
  fails(()=>cmd('tm.change.decide',{id:asked.change_id,decision:'APPROVE'},VANNA),/Only Dara/,403);
  cmd('tm.change.decide',{id:asked.change_id,decision:'REJECT',note:'Two permits are still missing.'},DARA);
  assert.equal(task(t1).status,'IN_PROGRESS');assert.match(notes(SOPHEA,'change_rejected').at(-1).body,/permits are still missing/);
  // Supporter submits to the person in charge, who returns it or sends it on for approval.
  cmd('tm.task.submit',{id:t1,note:'My part is done.'},VANNA);
  let t=task(t1);assert.equal(t.status,'IN_REVIEW');assert.equal(t.submitted_to,DARA);assert.equal(t.submitted_by,VANNA);
  assert.equal(notes(DARA,'task_submitted').at(-1).task_id,t1);
  assert.equal(cmd('tm.task.submit',{id:t1},VANNA).unchanged,true);
  fails(()=>cmd('tm.task.progress',{id:t1,progress:50},DARA),/waiting for review/,409);
  cmd('tm.task.submit',{id:t1,note:'Ready for your review.'},DARA);
  t=task(t1);assert.equal(t.submitted_to,SOPHEA);assert.equal(t.submitted_by,DARA);
  assert.equal(s.get("SELECT kind FROM tm_change_requests WHERE task_id=? AND status='PENDING'",t1).kind,'COMPLETE','the submission asks the assigner to approve completing it');
  fails(()=>cmd('tm.task.return',{id:t1},DARA),/Only the person this task was submitted to/,403);
  fails(()=>cmd('tm.task.return',{id:t1},SOPHEA),/What still needs to be done/);
  cmd('tm.task.return',{id:t1,note:'Add the September import permits.'},SOPHEA);
  t=task(t1);assert.equal(t.status,'IN_PROGRESS');assert.equal(t.submitted_to,null);assert.match(notes(DARA,'task_returned').at(-1).body,/import permits/);
  assert.equal(s.get('SELECT status FROM tm_change_requests WHERE task_id=? ORDER BY id DESC LIMIT 1',t1).status,'REJECTED');
  cmd('tm.task.submit',{id:t1},DARA);
  const r=cmd('tm.task.close',{id:t1,note:'Checked.'},SOPHEA);assert.match(r.message,/completed/);
  t=task(t1);assert.equal(t.status,'COMPLETED');assert.equal(t.progress,100);assert.equal(t.closed_by,SOPHEA);assert.ok(t.completed_at);
  assert.equal(cmd('tm.task.close',{id:t1},SOPHEA).unchanged,true);
  fails(()=>cmd('tm.task.reopen',{id:t1},VANNA),/Reason for reopening/);
  // V5.6.8: both sides agreed to close it, so reopening it is asked of the other side (Sophea) first.
  const reopen=cmd('tm.task.reopen',{id:t1,note:'One permit is missing.'},DARA);assert.ok(reopen.change_id);assert.equal(task(t1).status,'COMPLETED');
  cmd('tm.change.decide',{id:reopen.change_id,decision:'APPROVE'},SOPHEA);assert.equal(task(t1).status,'IN_PROGRESS');assert.equal(task(t1).progress,99);
  // V5.4: the person in charge can no longer close a task someone else assigned without the assigner's approval.
  fails(()=>cmd('tm.task.close',{id:t1},DARA),/Submit it for approval/,409);
  cmd('tm.task.submit',{id:t1},DARA);cmd('tm.task.close',{id:t1},SOPHEA);assert.equal(task(t1).status,'COMPLETED');assert.equal(task(t1).closed_by,SOPHEA);
  // A task someone assigned to themselves has no one else to submit to.
  const own=cmd('tm.task.save',{workspace_id:ws,title:'Tidy the shared drive',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:DARA},DARA).id;
  assert.ok(task(own).accepted_at);fails(()=>cmd('tm.task.submit',{id:own},DARA),/close it yourself/,409);
  const kinds=s.all('SELECT kind FROM tm_task_history WHERE task_id=? ORDER BY id',t1).map(h=>h.kind).join(',');
  // V5.5: the supporting person's progress was asked for (change_request) and then approved (progress).
  assert.equal(kinds,'create,support_accept,decline,accept,change_request,progress,change_request,change_rejected,submit,submit,return,submit,close,change_request,reopen,submit,close');
 });

 await check('stuck work, comments, cancellation and who may edit a task',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Book the October shipment',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA,supporter_ids:[CHANTHA]},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);
  fails(()=>cmd('tm.task.stuck',{id},CHANTHA),/What is blocking/);
  cmd('tm.task.stuck',{id,reason:'Carrier has no space until Friday.'},CHANTHA);
  let t=task(id);assert.ok(t.stuck_at);assert.equal(t.stuck_by,CHANTHA);assert.equal(t.status,'IN_PROGRESS');
  for(const who of [DARA,SOPHEA])assert.match(notes(who,'task_stuck').at(-1).body,/no space/);
  assert.equal(cmd('tm.task.stuck',{id,reason:'again'},DARA).unchanged,true);
  cmd('tm.task.resume',{id,note:'Space confirmed.'},SOPHEA);assert.equal(task(id).stuck_at,null);
  const version=task(id).version;cmd('tm.task.note',{id,note:'Customer prefers Monday pick-up.'},CHANTHA);assert.equal(task(id).version,version);
  fails(()=>cmd('tm.task.note',{id:s.get("SELECT id FROM tm_tasks WHERE title LIKE 'Confirm consignee details%'").id,note:'Hello'},DARA),/not found/,404);
  // Editing: supporters cannot. V5.4: once Dara (in charge) has accepted, each side's changes apply only when the other
  // side approves them.
  const base={...task(id),expected_version:task(id).version,supporter_ids:[CHANTHA]};
  fails(()=>cmd('tm.task.save',{...base,description:'Changed'},CHANTHA),/manager or the person in charge/,403);
  const due=cmd('tm.task.save',{...base,due_date:addDays(taskToday(),9)},DARA);assert.ok(due.change_id);assert.equal(task(id).due_date,base.due_date,'unchanged until approved');
  fails(()=>cmd('tm.task.save',{...base,description:'Other'},DARA),/already waiting for approval/,409);
  cmd('tm.change.decide',{id:due.change_id,decision:'REJECT',note:'Friday is the latest the customer accepts.'},SOPHEA);assert.equal(task(id).due_date,base.due_date);
  const edit=cmd('tm.task.save',{...base,description:'Pick-up Monday 9:00.',supporter_ids:[CHANTHA,VANNA],department_note:'Warehouse informed.'},DARA);
  assert.deepEqual(s.tasks.supportersOf(task(id)),[CHANTHA],'unchanged until approved');
  cmd('tm.change.decide',{id:edit.change_id,decision:'APPROVE'},SOPHEA);
  assert.deepEqual(s.tasks.supportersOf(task(id)).sort(),[CHANTHA,VANNA]);assert.equal(task(id).description,'Pick-up Monday 9:00.');
  fails(()=>cmd('tm.task.save',{...task(id),expected_version:task(id).version,status:'COMPLETED'},SOPHEA),/task actions/,409);
  const move=cmd('tm.task.save',{...task(id),expected_version:task(id).version,pic_id:VANNA,supporter_ids:[CHANTHA]},SOPHEA);assert.equal(task(id).pic_id,DARA,'the assigner’s change waits for Dara');
  cmd('tm.change.decide',{id:move.change_id,decision:'APPROVE'},DARA);
  t=task(id);assert.equal(t.pic_id,VANNA);assert.equal(t.accepted_at,null);assert.equal(notes(VANNA,'task_assigned').at(-1).task_id,id);
  assert.ok(taskActions(enrichedTasks(s.state()).find(x=>x.id===id),VANNA).allowed.includes('accept'));
  fails(()=>cmd('tm.task.cancel',{id,reason:'x'},CHANTHA),/Only the person in charge, the reviewer/,403);
  cmd('tm.task.cancel',{id,reason:'Customer postponed.'},SOPHEA);assert.equal(task(id).status,'CANCELLED');
  // New tasks: only the person in charge can create a task that is already started or completed.
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:taskToday(),pic_id:DARA,status:'IN_PROGRESS',progress:10},SOPHEA),/Only the person in charge can start/,403);
  fails(()=>cmd('tm.task.save',{workspace_id:ws,title:'x',start_date:taskToday(),due_date:taskToday(),pic_id:'STAFF-001',supporter_ids:['STAFF-002'],status:'IN_REVIEW'},SOPHEA),/New tasks start/);
 });

 await check('task requests go to the person asked, who accepts (creating the task) or declines',()=>{
  fails(()=>cmd('tm.request.save',{title:'Laptop for the new hire',manager_id:DARA},DARA),/can’t send a request to yourself/);
  const toViewer=cmd('tm.request.save',{title:'Check the badge printer',manager_id:CHANTHA},DARA).id;assert.equal(s.get('SELECT status FROM tm_requests WHERE id=?',toViewer).status,'PENDING','V5.3: anyone can be asked');cmd('tm.request.withdraw',{id:toViewer},DARA);
  fails(()=>cmd('tm.request.save',{title:'Laptop for the new hire'},DARA),/Choose the person you are asking/);
  const req=cmd('tm.request.save',{title:'Laptop for the new hire',description:'Starts on Monday.',manager_id:SOPHEA,workspace_id:ws,proposed_due_date:addDays(taskToday(),4),priority:'HIGH',department:'IT',department_note:'IT prepares the account.',request_key:'req-1'},DARA).id;
  assert.equal(cmd('tm.request.save',{title:'Laptop for the new hire',manager_id:SOPHEA,request_key:'req-1'},DARA).id,req);
  assert.equal(notes(SOPHEA,'request_new').at(-1).request_id,req);
  // V5.6.8: someone the request was not sent to is answered as if it did not exist.
  fails(()=>cmd('tm.request.decide',{id:req,decision:'APPROVE'},VANNA),/not found/,404);
  fails(()=>cmd('tm.request.decide',{id:req,decision:'DECLINE'},SOPHEA),/Reason for declining/);
  const r=cmd('tm.request.decide',{id:req,decision:'APPROVE',supporter_ids:[CHANTHA]},SOPHEA);
  const created=task(r.id),q=s.get('SELECT * FROM tm_requests WHERE id=?',req);
  assert.equal(q.status,'APPROVED');assert.equal(q.task_id,created.id);assert.equal(created.request_id,req);
  assert.equal(created.pic_id,DARA);assert.equal(created.reviewer_id,SOPHEA);assert.equal(created.created_by,SOPHEA);assert.ok(created.accepted_at,'the requester accepted by asking');
  assert.equal(created.priority,'HIGH');assert.equal(created.department,'IT');assert.equal(created.due_date,addDays(taskToday(),4));
  assert.match(notes(DARA,'request_approved').at(-1).body,/you are in charge/);assert.equal(notes(DARA,'task_assigned').filter(n=>n.task_id===created.id).length,0);
  assert.equal(cmd('tm.request.decide',{id:req,decision:'APPROVE'},SOPHEA).unchanged,true);
  // Declined, passed on and withdrawn requests.
  const r2=cmd('tm.request.save',{title:'New office chairs',manager_id:SOPHEA},DARA).id;
  fails(()=>cmd('tm.request.decide',{id:r2,decision:'APPROVE'},SOPHEA),/Choose the workspace/);
  cmd('tm.request.forward',{id:r2,manager_id:VANNA,note:'Budget owner.'},SOPHEA);
  assert.equal(s.get('SELECT manager_id FROM tm_requests WHERE id=?',r2).manager_id,VANNA);assert.equal(notes(DARA,'request_forwarded').length,1);
  cmd('tm.request.decide',{id:r2,decision:'DECLINE',note:'Not in this quarter’s budget.'},VANNA);
  assert.match(notes(DARA,'request_declined').at(-1).body,/budget/);
  fails(()=>cmd('tm.request.withdraw',{id:r2},DARA),/already been decided/,409);
  const r3=cmd('tm.request.save',{title:'Team lunch booking',manager_id:VANNA},DARA).id;
  fails(()=>cmd('tm.request.withdraw',{id:r3},SOPHEA),/not found/,404);
  cmd('tm.request.withdraw',{id:r3},DARA);assert.equal(s.get('SELECT status FROM tm_requests WHERE id=?',r3).status,'WITHDRAWN');
 });

 await check('V5.4 due date changes need both sides; supporting people ask the reviewer first',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Renew the warehouse licence',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:DARA,supporter_ids:[CHANTHA]},SOPHEA).id;
  fails(()=>cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),6),reason:'x'},SOPHEA),/Only the person in charge or a supporting person/,403);
  fails(()=>cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),-9),reason:'Late forms'},DARA),/before the start date/);
  fails(()=>cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),6)},DARA),/Reason/);
  // The person in charge asks the assigner (Sophea): a change request that applies only when she approves it.
  const asked=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),6),reason:'Government office closed for the holiday.'},DARA);
  assert.ok(asked.change_id);assert.equal(task(id).due_date,addDays(taskToday(),2),'unchanged until approved');
  assert.match(notes(SOPHEA,'change_request').at(-1).body,/Government office closed/);
  fails(()=>cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),7),reason:'Also'},CHANTHA),/already waiting/,409);
  cmd('tm.change.decide',{id:asked.change_id,decision:'APPROVE'},SOPHEA);
  assert.equal(task(id).due_date,addDays(taskToday(),6));assert.equal(notes(DARA,'change_approved').at(-1).task_id,id);
  // A supporting person asks the reviewer (Sophea). Dara has not accepted the task yet, so Sophea's answer applies at once.
  const due=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),8),reason:'Inspector moved.'},CHANTHA).id;
  assert.equal(notes(SOPHEA,'due_new').at(-1).due_request_id,due);
  fails(()=>cmd('tm.due.decide',{id:due,decision:'APPROVE'},CHANTHA),/Only the task’s reviewer/,403);
  cmd('tm.due.decide',{id:due,decision:'APPROVE'},SOPHEA);
  assert.equal(task(id).due_date,addDays(taskToday(),8));assert.ok(s.get("SELECT id FROM tm_task_history WHERE task_id=? AND kind='due_change'",id));
  for(const who of [DARA,CHANTHA])assert.equal(notes(who,'due_approved').at(-1).task_id,id);
  // Once Dara has accepted, the reviewer's yes to a supporter's date also needs Dara's approval.
  cmd('tm.task.accept',{id},DARA);
  const again=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),10),reason:'Waiting for the inspector.'},CHANTHA).id;
  fails(()=>cmd('tm.due.decide',{id:again,decision:'DECLINE'},SOPHEA),/Reason for declining/);
  cmd('tm.due.decide',{id:again,decision:'DECLINE',note:'Please keep the date.'},SOPHEA);
  assert.equal(task(id).due_date,addDays(taskToday(),8));assert.match(notes(CHANTHA,'due_declined').at(-1).body,/keep the date/);
  const third=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(taskToday(),9),reason:'One more day for the stamp.'},CHANTHA).id;
  const agreed=cmd('tm.due.decide',{id:third,decision:'APPROVE'},SOPHEA);assert.ok(agreed.change_id);assert.equal(task(id).due_date,addDays(taskToday(),8));
  assert.match(notes(CHANTHA,'due_approved').at(-1).body,/Dara/);
  cmd('tm.change.decide',{id:agreed.change_id,decision:'REJECT',note:'The customer needs it by then.'},DARA);
  assert.equal(task(id).due_date,addDays(taskToday(),8));assert.match(notes(SOPHEA,'change_rejected').at(-1).body,/customer needs it/);
 });

 await check('monthly reports: completed, in progress, stuck and overdue follow the task history',()=>{
  // Three tasks with a history placed in July and August 2026 (Cambodia time).
  const mk=title=>cmd('tm.task.save',{workspace_id:ws,title,start_date:'2026-07-01',due_date:'2026-07-25',pic_id:DARA,department:'Audit'},SOPHEA).id;
  const [x,y,z]=['History X','History Y','History Z'].map(mk);
  const put=(id,rows)=>{s.run('DELETE FROM tm_task_history WHERE task_id=?',id);for(const [at,kind,status,extra={}] of rows)s.insert('tm_task_history',{task_id:id,kind,from_status:null,to_status:status,progress:extra.progress??0,stuck:extra.stuck?1:0,due_date:extra.due||'2026-07-25',note:extra.note||'',actor_id:DARA,source:'WEB',created_at:new Date(at).toISOString()});};
  put(x,[['2026-07-05T09:00:00+07:00','create','NOT_STARTED'],['2026-07-06T09:00:00+07:00','accept','IN_PROGRESS'],['2026-07-20T09:00:00+07:00','stuck','IN_PROGRESS',{stuck:1,note:'Waiting for the bank.'}],['2026-08-03T09:00:00+07:00','resume','IN_PROGRESS'],['2026-08-10T09:00:00+07:00','close','COMPLETED',{progress:100}]]);
  put(y,[['2026-07-10T09:00:00+07:00','create','NOT_STARTED'],['2026-07-11T09:00:00+07:00','accept','IN_PROGRESS',{progress:20}]]);
  put(z,[['2026-07-01T09:00:00+07:00','create','NOT_STARTED'],['2026-07-15T23:30:00+07:00','close','COMPLETED',{progress:100}]]);
  s.run("UPDATE tm_tasks SET status='COMPLETED',progress=100,completed_at=? WHERE id IN (?,?)",new Date('2026-08-10T02:00:00Z').toISOString(),x,z);
  s.run("UPDATE tm_tasks SET status='IN_PROGRESS',progress=20,accepted_at=? WHERE id=?",'2026-07-11T02:00:00.000Z',y);
  const pick=(month,cat)=>monthlyTaskRows(s.state(),{month,department:'Audit'}).rows.filter(r=>r.category===cat).map(r=>r.id).sort();
  assert.deepEqual(pick('2026-07','completed'),[z]);assert.deepEqual(pick('2026-07','in_progress'),[y]);assert.deepEqual(pick('2026-07','stuck'),[x]);assert.deepEqual(pick('2026-07','overdue'),[x,y].sort());
  assert.deepEqual(pick('2026-08','completed'),[x]);assert.deepEqual(pick('2026-08','stuck'),[x]);assert.deepEqual(pick('2026-08','overdue'),[x,y].sort());assert.deepEqual(pick('2026-08','in_progress'),[y]);
  const aug=monthlyTaskRows(s.state(),{month:'2026-08',department:'Audit'});
  assert.equal(aug.rows.find(r=>r.id===x&&r.category==='overdue').overdue_kind,'Completed late');assert.equal(aug.rows.find(r=>r.id===x&&r.category==='stuck').still_stuck,'No');
  assert.equal(aug.rows.find(r=>r.id===y&&r.category==='overdue').days_overdue,38);
  assert.deepEqual(monthlyTaskRows(s.state(),{month:'2026-06',department:'Audit'}).rows,[]);
  const report=buildTaskReport(s.state(),{report:'monthly_stuck',month:'2026-07',department:'Audit'});
  assert.equal(report.rows[0].stuck_reason,'Waiting for the bank.');assert.equal(report.summary.stuck,1);assert.match(report.title,/July 2026/);
  assert.throws(()=>buildTaskReport(s.state(),{report:'monthly',month:'2026-13'}),/valid month/);
  assert.equal(shiftMonth('2026-01',-1),'2025-12');assert.equal(shiftMonth('2026-12',1),'2027-01');
 });

 // ------------------------------------------------------------------ HTTP: permissions and Telegram settings
 const port=4331;base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,null,{telegramPort:4336});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data}={})=>{const r=await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const login=async(email,password)=>(await request('/api/auth/login',{data:{email,password}})).cookie;
 const api=(cookie,action,data)=>request('/api/command',{cookie,data:{action,data}});
 const cookies={vanna:await login('vanna@example.test','vanna-password-1'),sophea:await login('sophea@example.test','sophea-password-1'),dara:await login('dara@example.test','dara-password-12'),chantha:await login('chantha@example.test','chantha-password')};

 await check('API: workflow actions follow ERP permissions; requests and notifications stay private',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Count the stock',start_date:taskToday(),due_date:addDays(taskToday(),1),pic_id:CHANTHA},SOPHEA).id;
  assert.equal((await api(cookies.chantha,'tm.task.accept',{id})).status,200,'V5.3: any role with Task Management answers work given to it');
  assert.equal((await api(cookies.chantha,'tm.task.accept',{id:t1})).status,404,'but not on tasks it is not part of');
  const req=cmd('tm.request.save',{title:'Private request',manager_id:VANNA},SOPHEA).id;
  assert.equal((await api(cookies.dara,'tm.request.decide',{id:req,decision:'APPROVE',workspace_id:ws,due_date:taskToday()})).status,404,'V5.6.8: someone else’s request is “not found”');
  const darasState=(await request('/api/state',{cookie:cookies.dara})).body;
  assert.ok(!darasState.tm_requests.some(q=>q.id===req),'members only see their own requests');
  assert.ok(darasState.tm_notifications.length&&darasState.tm_notifications.every(n=>n.staff_id===DARA));
  assert.ok(darasState.tm_people.some(m=>m.staff_id===CHANTHA));assert.deepEqual(darasState.tm_people.filter(m=>m.approver).map(m=>m.staff_id).sort(),[SOPHEA,VANNA]);
  assert.equal(darasState.telegram.enabled,false);assert.equal(darasState.telegram_admin,undefined);
  assert.ok((await request('/api/state',{cookie:cookies.vanna})).body.tm_requests.some(q=>q.id===req),'approvers see every request');
  const unread=darasState.tm_notifications.find(n=>!n.read_at);
  assert.equal((await api(cookies.dara,'tm.notification.read',{id:unread.id})).status,200);
  const someoneElse=s.get('SELECT id FROM tm_notifications WHERE staff_id<>? LIMIT 1',DARA).id;
  assert.equal((await api(cookies.dara,'tm.notification.read',{id:someoneElse})).status,404);
  assert.equal((await api(cookies.dara,'tm.notification.read',{all:true})).status,200);assert.equal(s.get('SELECT COUNT(*) n FROM tm_notifications WHERE staff_id=? AND read_at IS NULL',DARA).n,0);
  for(const kind of ['monthly','monthly_completed','monthly_progress','monthly_stuck','monthly_overdue'])for(const suffix of ['','.csv','.print'])assert.equal((await request(`/api/tasks/report${suffix}?report=${kind}&month=2026-07`,{cookie:cookies.vanna})).status,200,kind+suffix);
  assert.equal((await request('/api/tasks/report?report=unknown',{cookie:cookies.vanna})).status,400);
 });

 await check('Telegram settings: administrators only, token validated and never sent to the browser',async()=>{
  assert.equal((await api(cookies.sophea,'admin.telegram.save',{enabled:true,bot_token:TOKEN,expected_version:0})).status,403);
  assert.match((await api(cookies.vanna,'admin.telegram.save',{enabled:true,bot_token:'not-a-token',expected_version:0})).body.error,/BotFather/);
  assert.match((await api(cookies.vanna,'admin.telegram.save',{enabled:true,expected_version:0})).body.error,/bot token/);
  assert.match((await api(cookies.vanna,'admin.telegram.save',{enabled:false,mini_app_url:'http://insecure.example.com',expected_version:0})).body.error,/https/);
  assert.equal((await api(cookies.vanna,'admin.telegram.save',{enabled:true,bot_token:TOKEN,mini_app_url:'https://tasks.example.com/',digest_hour:8,expected_version:0})).status,200);
  const st=(await request('/api/state',{cookie:cookies.vanna})).body;
  assert.equal(st.telegram_admin.settings.token_set,true);assert.equal(st.telegram_admin.settings.mini_app_url,'https://tasks.example.com');assert.equal(st.telegram_admin.settings.app_url,'https://tasks.example.com/c/default/tg/');
  assert.doesNotMatch(JSON.stringify(st),new RegExp(TOKEN.split(':')[1]));assert.equal(st.telegram_admin.gateway.port,4336);
  assert.match((await api(cookies.dara,'tg.link.code',{})).body.error,/not connected yet/);
  assert.equal(miniAppUrl({mini_app_url:'https://x.example'},'company-1'),'https://x.example/c/company-1/tg/');
 });

 // ------------------------------------------------------------------ Telegram bot against a mock Bot API
 const tgCalls=[],queue=[],sent=[];let messageId=1000,updateId=0;
 mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const raw=Buffer.concat(chunks),download=/^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
  // File downloads (V5.3: photos and documents people send to the bot) and multipart uploads (files the bot sends).
  if(download){if(download[1]!==TOKEN){res.writeHead(401);return res.end();}tgCalls.push({method:'download',params:{path:download[2]}});res.writeHead(200,{'Content-Type':'application/octet-stream'});return res.end(download[2].includes('big')?Buffer.alloc(6*1024*1024):download[2].includes('doc')?PDF:PNG);}
  const params=String(req.headers['content-type']||'').startsWith('multipart/')?{multipart:true,body:raw.toString('latin1')}:raw.length?JSON.parse(raw.toString()):{};
  const m=/^\/bot([^/]+)\/(\w+)$/.exec(req.url),reply=(result,status=200,extra={})=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{ok:true,result}:{ok:false,error_code:status,description:extra.description||'Error'}));};
  if(!m)return reply(null,404,{description:'Not Found'});
  if(m[1]!==TOKEN)return reply(null,401,{description:'Unauthorized'});
  const method=m[2];tgCalls.push({method,params});
  if(method==='getMe')return reply({id:999,is_bot:true,first_name:'Sunny Tasks',username:'sunny_tasks_bot'});
  if(method==='getUpdates'){const end=Date.now()+Math.min(1000,(params.timeout||0)*1000);while(Date.now()<end&&!queue.some(u=>u.update_id>=(params.offset||0)))await new Promise(r=>setTimeout(r,20));return reply(queue.filter(u=>u.update_id>=(params.offset||0)));}
  if(method==='sendMessage'){const msg={message_id:++messageId,chat:{id:params.chat_id,type:params.chat_id<0?'supergroup':'private'},text:params.text,reply_markup:params.reply_markup,date:Math.floor(Date.now()/1000)};sent.push(msg);return reply(msg);}
  if(method==='getFile')return reply({file_id:params.file_id,file_unique_id:'u'+params.file_id,file_size:params.file_id.includes('big')?6*1024*1024:params.file_id.includes('doc')?PDF.length:PNG.length,file_path:`photos/${params.file_id}.jpg`});
  if(method==='sendDocument'){const msg={message_id:++messageId,chat:{id:Number(/name="chat_id"\r\n\r\n(-?\d+)/.exec(params.body)?.[1]),type:'private'},document:{file_name:/filename="([^"]+)"/.exec(params.body)?.[1]},date:Math.floor(Date.now()/1000)};sent.push(msg);return reply(msg);}
  if(method==='editMessageText'){const msg=sent.find(x=>x.message_id===params.message_id&&x.chat.id===params.chat_id);if(msg){msg.text=params.text;msg.reply_markup=params.reply_markup;msg.edited=(msg.edited||0)+1;}return reply(msg||true);}
  return reply(true);
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const apiBase=`http://127.0.0.1:${mock.address().port}`;
 const push=u=>{u.update_id=++updateId;queue.push(u);return u;};
 const users={dara:{id:5001,is_bot:false,first_name:'Dara',username:'dara_sales'},sophea:{id:5002,is_bot:false,first_name:'Sophea'},vanna:{id:5003,is_bot:false,first_name:'Vanna',username:'vanna_dir'},stranger:{id:5099,is_bot:false,first_name:'Stranger'}};
 const pm=(from,text,extra={})=>push({message:{message_id:++messageId,from,chat:{id:from.id,type:'private'},date:Math.floor(Date.now()/1000),text,...extra}});
 const group={id:-100777,type:'supergroup',title:'Operations team'};
 const gm=(from,text,extra={})=>push({message:{message_id:++messageId,from,chat:group,date:Math.floor(Date.now()/1000),text,...extra}});
 let cbId=0;const cb=(from,msg,data)=>{push({callback_query:{id:String(++cbId),from,message:{message_id:msg.message_id,chat:msg.chat.id<0?group:{id:msg.chat.id,type:'private'},date:msg.date,text:msg.text},data}});return String(cbId);};
 const answered=async id=>(await waitFor(()=>tgCalls.find(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id===id),'callback answer '+id)).params;
 const lastTo=chat=>[...sent].reverse().find(m=>m.chat.id===chat);
 const newTo=async(chat,after,pattern,label)=>waitFor(()=>sent.find(m=>m.chat.id===chat&&m.message_id>after&&(!pattern||pattern.test(m.text))),label||String(pattern));
 const buttonsOf=msg=>(msg.reply_markup?.inline_keyboard||[]).flat();
 const cardFor=(chat,after,title)=>newTo(chat,after,new RegExp(title+'[\\s\\S]*👤 In charge'),'task card '+title);
 const tap=(from,msg,match)=>{const b=buttonsOf(msg).find(x=>typeof match==='string'?x.callback_data===match:match.test(x.text));assert.ok(b,`button ${match} in: ${buttonsOf(msg).map(x=>x.text).join(' | ')}`);return cb(from,msg,b.callback_data);};
 const companies={list:()=>[{id:'default'}],get:()=>s};
 runtime=createTelegramRuntime({companies,apiBase,supervisorMs:150,outboxMs:120,pollTimeout:1,logger:{error:()=>{}},appUrlFor:(id,store)=>miniAppUrl(store.telegram.settings(),id)}).start();

 await check('bot connects with the saved token, registers commands and opens the task app from the menu button',async()=>{
  await waitFor(()=>s.telegram.settings().status==='ONLINE','bot online');
  const st=s.telegram.settings();assert.equal(st.bot_username,'sunny_tasks_bot');
  assert.ok(tgCalls.some(c=>c.method==='setMyCommands'&&c.params.scope.type==='all_group_chats'));
  assert.equal(tgCalls.find(c=>c.method==='setChatMenuButton').params.menu_button.web_app.url,'https://tasks.example.com/c/default/tg/');
  assert.equal(parseCommand('/tasks@sunny_tasks_bot now','sunny_tasks_bot').cmd,'tasks');assert.equal(parseCommand('/tasks@other_bot','sunny_tasks_bot').other,true);
  assert.equal(parseDay('2026-10-05'),'2026-10-05');assert.equal(parseDay('5/10/2026'),'2026-10-05');assert.equal(parseDay('+2'),addDays(taskToday(),2));assert.equal(parseDay('31/02/2026'),null);
 });

 await check('people link Telegram with a personal code from their ERP account (it does not expire)',async()=>{
  let before=messageId;pm(users.stranger,'/start');
  const welcome0=await newTo(users.stranger.id,before,/Connect Telegram/);assert.match(welcome0.text,/does not expire/);assert.doesNotMatch(welcome0.text,/15 minutes/);
  assert.ok(buttonsOf(welcome0).some(b=>b.web_app?.url==='https://tasks.example.com/c/default/tg/'),'a Sign in button opens the Mini App');
  const code=(await api(cookies.dara,'tg.link.code',{})).body.result;
  assert.match(code.link,/^https:\/\/t\.me\/sunny_tasks_bot\?start=link_[A-Z2-9]{8}$/);
  before=messageId;pm(users.stranger,'/link AAAA2222');await newTo(users.stranger.id,before,/not valid|expired/);
  before=messageId;pm(users.dara,`/start link_${code.code}`);
  const welcome=await newTo(users.dara.id,before,/Connected!/);
  assert.match(welcome.text,/Dara · Sales/);assert.equal(s.telegram.linkForStaff(DARA).tg_user_id,5001);assert.equal(s.telegram.linkForStaff(DARA).chat_id,5001);
  before=messageId;pm(users.sophea,`/link ${code.code}`);await newTo(users.sophea.id,before,/already used/);
  for(const [who,cookie] of [[users.sophea,cookies.sophea],[users.vanna,cookies.vanna]]){const c=(await api(cookie,'tg.link.code',{})).body.result;before=messageId;pm(who,c.code);await newTo(who.id,before,/Connected!/);}
  assert.equal((await request('/api/state',{cookie:cookies.dara})).body.telegram.link.username,'dara_sales');
 });

 let darasTask,card;
 await check('in a private chat people see their tasks and act on them with buttons',async()=>{
  darasTask=cmd('tm.task.save',{workspace_id:ws,title:'Send the quotation to Mekong Supply',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:DARA,supporter_ids:[VANNA],department:'Sales',department_note:'Sales signs; Finance checks prices.'},SOPHEA).id;
  // The assignment arrives as a Telegram message with Accept / Decline.
  const dm=await waitFor(()=>sent.find(m=>m.chat.id===5001&&/New task: Send the quotation/.test(m.text)),'assignment message');
  let answer=await answered(tap(users.dara,dm,/Accept/));assert.match(answer.text,/accepted/);
  assert.equal(task(darasTask).status,'IN_PROGRESS');assert.equal(s.get("SELECT source FROM tm_task_history WHERE task_id=? AND kind='accept'",darasTask).source,'TELEGRAM');
  let before=messageId;pm(users.dara,'/mytasks');
  const list=await newTo(5001,before,/Tasks you are in charge of/);assert.match(list.text,/Send the quotation/);
  answer=await answered(tap(users.dara,list,/Send the quotation/));card=sent.find(m=>m.message_id===list.message_id);
  assert.match(card.text,/Finance checks prices/);assert.ok(buttonsOf(card).some(b=>b.web_app?.url==='https://tasks.example.com/c/default/tg/?task='+darasTask));
  answer=await answered(tap(users.dara,card,/Progress/));answer=await answered(tap(users.dara,card,'t:p:'+darasTask+':75'));
  // V5.5: Sophea assigned the task, so the new progress waits for her approval, which she gives from Telegram.
  assert.match(answer.text,/Sent to Sophea.*for approval/);assert.equal(task(darasTask).progress,0);
  const askProgress=await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Approval needed: Send the quotation/.test(m.text)),'progress approval message to the assigner');
  assert.match(askProgress.text,/progress 0% → 75%/);
  const okProgress=await answered(tap(users.sophea,askProgress,/Approve change/));assert.match(okProgress.text,/Progress is now 75%/);
  await waitFor(()=>task(darasTask).progress===75,'progress applied');
  // Mark stuck: the bot asks for the reason and the reply is saved.
  before=messageId;await answered(tap(users.dara,card,/Stuck/));
  const ask=await newTo(5001,before,/What is blocking this task/);assert.equal(ask.reply_markup.force_reply,true);
  pm(users.dara,'Waiting for the price list from Finance.',{reply_to_message:{message_id:ask.message_id}});
  await waitFor(()=>task(darasTask).stuck_at,'stuck saved');assert.equal(task(darasTask).stuck_reason,'Waiting for the price list from Finance.');
  await waitFor(()=>/Stuck/.test(sent.find(m=>m.message_id===card.message_id).text),'card refreshed');
  // Supporting person (Vanna) is told; the reviewer is told as well.
  await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Stuck: Send the quotation/.test(m.text)),'stuck message to reviewer');
  answer=await answered(tap(users.dara,sent.find(m=>m.message_id===card.message_id),/Resume/));assert.match(answer.text,/resumed/);
  // V5.4: Dara submits for approval; Sophea (who assigned it) approves completing it from her Telegram message.
  assert.ok(!buttonsOf(sent.find(m=>m.message_id===card.message_id)).some(b=>/Close/.test(b.text)),'the person in charge of an assigned task does not close it directly');
  before=messageId;await answered(tap(users.dara,sent.find(m=>m.message_id===card.message_id),/Submit for approval/));
  const note=await newTo(5001,before,/add a note/i);pm(users.dara,'Quotation sent; copy attached in the ERP.',{reply_to_message:{message_id:note.message_id}});
  await waitFor(()=>task(darasTask).status==='IN_REVIEW','submitted');assert.equal(task(darasTask).submitted_to,SOPHEA);
  const ask2=await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Approval needed: Send the quotation/.test(m.text)),'approval message to the assigner');
  await answered(tap(users.sophea,ask2,/Approve completion/));
  const confirm=sent.find(m=>m.message_id===ask2.message_id);assert.match(confirm.text,/Approve completing this task/);
  answer=await answered(tap(users.sophea,confirm,/Yes, complete it/));assert.match(answer.text,/completed/);
  assert.equal(task(darasTask).status,'COMPLETED');assert.equal(task(darasTask).closed_by,SOPHEA);
  assert.equal(s.get('SELECT status FROM tm_change_requests WHERE task_id=?',darasTask).status,'APPROVED');
 });

 await check('the bot refuses actions the tapping person may not take and never changes the task',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Update the price list',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:VANNA,supporter_ids:[DARA]},SOPHEA).id;
  cmd('tm.task.accept',{id},VANNA);
  const before=messageId;pm(users.dara,'/task '+id);
  const view=await newTo(5001,before,/Update the price list/);
  assert.ok(!buttonsOf(view).some(b=>/Close|complete/i.test(b.text)),'supporters do not get a Close button');
  const answer=await answered(cb(users.dara,view,`t:cls!:${id}`));assert.match(answer.text,/Only the person in charge, or the person who approves the task/);assert.equal(answer.show_alert,true);
  assert.equal(task(id).status,'IN_PROGRESS');
  const stranger=await answered(cb(users.stranger,view,`t:acc:${id}`));assert.match(stranger.text,/connect this Telegram account/i);
 });

 await check('new tasks and task requests can be created step by step in Telegram',async()=>{
  let before=messageId;pm(users.dara,'/newtask Order printer paper');
  let form=await newTo(5001,before,/New task/);assert.match(form.text,/Which workspace/);
  await answered(tap(users.dara,form,/Workflow QA/));form=sent.find(m=>m.message_id===form.message_id);assert.match(form.text,/Who is in charge/);
  await answered(tap(users.dara,form,/Me/));form=sent.find(m=>m.message_id===form.message_id);assert.match(form.text,/When is it due/);
  await answered(tap(users.dara,form,/In 3 days/));form=sent.find(m=>m.message_id===form.message_id);assert.match(form.text,/Check the details/);
  before=messageId;await answered(tap(users.dara,form,/Department note/));
  const ask=await newTo(5001,before,/department note/i);pm(users.dara,'Admin team buys; Finance pays.',{reply_to_message:{message_id:ask.message_id}});
  await waitFor(()=>/Admin team buys/.test(sent.find(m=>m.message_id===form.message_id).text),'note on form');
  const answer=await answered(tap(users.dara,sent.find(m=>m.message_id===form.message_id),/Create task/));assert.match(answer.text,/created/);
  const created=s.get("SELECT * FROM tm_tasks WHERE title='Order printer paper'");
  assert.equal(created.pic_id,DARA);assert.equal(created.due_date,addDays(taskToday(),3));assert.equal(created.department_note,'Admin team buys; Finance pays.');assert.equal(created.source,'TELEGRAM');assert.ok(created.accepted_at);
  // A request to a manager, then the manager approves it from the Telegram message.
  before=messageId;pm(users.dara,'/request Replace the office router');
  form=await newTo(5001,before,/Request a task/);assert.match(form.text,/Who are you asking/);
  assert.ok(buttonsOf(form).some(b=>/Chantha/.test(b.text)),'V5.3: anyone with Task Management can be asked');
  await answered(tap(users.dara,form,/Sophea/));form=sent.find(m=>m.message_id===form.message_id);assert.match(form.text,/Who should do it/);
  await answered(tap(users.dara,form,/Me — I am asking/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/Workflow QA/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/In a week/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/Send request/));
  const q=s.get("SELECT * FROM tm_requests WHERE title='Replace the office router'");assert.equal(q.manager_id,SOPHEA);assert.equal(q.source,'TELEGRAM');assert.equal(q.proposed_due_date,addDays(taskToday(),7));
  const incoming=await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Task request: Replace the office router/.test(m.text)),'request message to manager');
  await answered(tap(users.sophea,incoming,/Approve/));
  const approve=sent.find(m=>m.message_id===incoming.message_id);assert.match(approve.text,/Approve task request/);assert.match(approve.text,/In charge: Dara/);
  const done=await answered(tap(users.sophea,approve,/Approve and create/));assert.match(done.text,/accepted as TASK-/);
  const approved=s.get('SELECT * FROM tm_requests WHERE id=?',q.id);assert.equal(approved.status,'APPROVED');assert.equal(task(approved.task_id).pic_id,DARA);assert.equal(task(approved.task_id).source,'TELEGRAM');
  await waitFor(()=>sent.find(m=>m.chat.id===5001&&/Request accepted: Replace the office router/.test(m.text)),'approval message to requester');
 });

 await check('groups link to a workspace and list its tasks; V5.4: task updates go only to the people on the task, not to groups',async()=>{
  push({my_chat_member:{chat:group,from:users.vanna,date:0,old_chat_member:{status:'left',user:{id:999}},new_chat_member:{status:'member',user:{id:999}}}});
  await waitFor(()=>s.get('SELECT * FROM tg_groups WHERE chat_id=?',group.id),'group seen');
  let before=messageId;gm(users.dara,'/connect');await newTo(group.id,before,/Only ERP administrators/);
  before=messageId;gm(users.vanna,'/connect@sunny_tasks_bot');const pickWs=await newTo(group.id,before,/Which workspace/);
  const denied=await answered(tap(users.dara,pickWs,/Workflow QA/));assert.match(denied.text,/Only ERP administrators or the workspace owner/);
  await answered(tap(users.vanna,pickWs,/Workflow QA/));assert.equal(s.get('SELECT workspace_id FROM tg_groups WHERE chat_id=?',group.id).workspace_id,ws);
  before=messageId;gm(users.dara,'/tasks');const list=await newTo(group.id,before,/Open tasks · Workflow QA/);assert.match(list.text,/Update the price list/);
  // A change made in the ERP web app reaches the people on the task privately, and is not posted to the group.
  const id=s.get("SELECT id FROM tm_tasks WHERE title='Update the price list'").id,groupBefore=sent.filter(m=>m.chat.id===group.id).length;
  assert.equal((await api(cookies.dara,'tm.task.stuck',{id,reason:'Supplier has not replied.'})).status,200);
  await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Stuck: Update the price list/.test(m.text)),'private message to the assigner');
  await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Stuck: Update the price list/.test(m.text)),'private message to the person in charge');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(sent.filter(m=>m.chat.id===group.id).length,groupBefore,'nothing is posted in the group');
  // A person without access cannot open tasks from another workspace in the group.
  const other=s.get("SELECT id FROM tm_tasks WHERE workspace_id<>? LIMIT 1",ws).id;
  before=messageId;gm(users.dara,'/task '+other);await newTo(group.id,before,/must be one you can view/);
 });

 await check('monthly report and daily summary in Telegram',async()=>{
  // Dara's account is set to not see Task Management reports (an individual Function Setting).
  const account=s.get('SELECT * FROM access_users WHERE staff_id=?',DARA);
  cmd('admin.user.save',{id:account.id,expected_version:account.version,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',active:1,function_settings:{'tasks.reports':{view:'DENY'}}},VANNA);
  let before=messageId;pm(users.dara,'/report');
  const rep=await newTo(5001,before,/Monthly task report/);assert.match(rep.text,/Completed: <b>\d+<\/b>/);assert.ok(!buttonsOf(rep).some(b=>/Whole company/.test(b.text)),'members only see their own report');
  before=messageId;pm(users.vanna,'/report 2026-07');const all=await newTo(5003,before,/July 2026/);
  await answered(tap(users.vanna,all,/Whole company/));assert.match(sent.find(m=>m.message_id===all.message_id).text,/Whole company/);
  await answered(tap(users.vanna,sent.find(m=>m.message_id===all.message_id),/^🔴/));assert.match(sent.find(m=>m.message_id===all.message_id).text,/History X/);
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Phnom_Penh',hour:'numeric',hourCycle:'h23'}).format(new Date()));
  s.run("UPDATE tg_settings SET digest_hour=?,last_digest_date='' WHERE id=1",hour);
  await waitFor(()=>sent.find(m=>m.chat.id===5001&&/Good morning/.test(m.text)),'daily summary');
  assert.equal(s.telegram.settings().last_digest_date,taskToday());
 });


 await check('V5.3 in Telegram: supporting people and reviewers answer from the message; rejecting asks for a reason',async()=>{
  const a=cmd('tm.task.save',{workspace_id:ws,title:'Pack the Phnom Penh order',start_date:taskToday(),due_date:addDays(taskToday(),3),pic_id:DARA,supporter_ids:[VANNA]},SOPHEA).id;
  const ask=await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Support request: Pack the Phnom Penh order/.test(m.text)),'support request message');
  assert.ok(buttonsOf(ask).some(b=>/Reject/.test(b.text)));
  let before=messageId;await answered(tap(users.vanna,ask,/Reject/));
  const why=await newTo(5003,before,/Why are you rejecting/);pm(users.vanna,'I am on leave on Friday.',{reply_to_message:{message_id:why.message_id}});
  await waitFor(()=>s.get('SELECT status FROM tm_assignees WHERE task_id=? AND staff_id=?',a,VANNA).status==='DECLINED','support rejected');
  await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Support rejected: Pack the Phnom Penh order/.test(m.text)),'rejection sent to the creator');
  const b=cmd('tm.task.save',{workspace_id:ws,title:'Check the October invoices',start_date:taskToday(),due_date:addDays(taskToday(),4),pic_id:DARA,reviewer_id:VANNA},DARA).id;
  const rq=await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Review request: Check the October invoices/.test(m.text)),'review request message');
  const ok=await answered(tap(users.vanna,rq,/Accept/));assert.match(ok.text,/reviewer/);assert.equal(task(b).reviewer_status,'ACCEPTED');
  cmd('tm.task.save',{workspace_id:ws,title:'Sign the customs declaration',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:VANNA},SOPHEA);
  before=messageId;pm(users.vanna,'/answer');const list=await newTo(5003,before,/Waiting for your answer/);assert.match(list.text,/Sign the customs declaration/);assert.match(list.text,/asked to take charge/);
 });

 await check('V5.4 in Telegram: the person in charge asks to cancel or hand over; the assigner approves from the message',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Collect the signed contracts',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:DARA},SOPHEA).id;
  let before=messageId;pm(users.dara,'/task '+id);let card=await cardFor(5001,before,'Collect the signed contracts');
  assert.ok(!buttonsOf(card).some(b=>/Cancel/.test(b.text)),'before accepting, the person in charge rejects instead of cancelling');
  cmd('tm.task.accept',{id},DARA);
  before=messageId;pm(users.dara,'/task '+id);card=await cardFor(5001,before,'Collect the signed contracts');
  assert.ok(buttonsOf(card).some(b=>/Ask to cancel/.test(b.text)),'the person in charge can ask to cancel');
  before=messageId;await answered(tap(users.dara,card,/Ask to cancel/));
  const why=await newTo(5001,before,/Why are you cancelling/);pm(users.dara,'The customer signed digitally.',{reply_to_message:{message_id:why.message_id}});
  await waitFor(()=>s.get("SELECT id FROM tm_change_requests WHERE task_id=? AND kind='CANCEL' AND status='PENDING'",id),'cancel request');assert.equal(task(id).status,'IN_PROGRESS');
  const approve=await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Approval needed: Collect the signed contracts/.test(m.text)),'approval message to the assigner');
  assert.match(approve.text,/cancel it/);
  const ok=await answered(tap(users.sophea,approve,/Approve change/));assert.match(ok.text,/cancelled/);
  await waitFor(()=>task(id).status==='CANCELLED','cancelled');assert.equal(task(id).reason,'The customer signed digitally.');
  await waitFor(()=>sent.find(m=>m.chat.id===5001&&/Request approved: Collect the signed contracts/.test(m.text)),'approval reaches Dara');
  const h=cmd('tm.task.save',{workspace_id:ws,title:'Arrange the warehouse visit',start_date:taskToday(),due_date:addDays(taskToday(),5),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id:h},DARA);
  before=messageId;pm(users.dara,'/task '+h);card=await cardFor(5001,before,'Arrange the warehouse visit');
  await answered(tap(users.dara,card,/Hand over/));card=sent.find(m=>m.message_id===card.message_id);assert.match(card.text,/Who should take charge/);
  await answered(tap(users.dara,card,/Vanna/));card=sent.find(m=>m.message_id===card.message_id);assert.match(card.text,/Hand this task over to Vanna/);
  const done=await answered(tap(users.dara,card,/keep me as supporting/));assert.match(done.text,/Sent to Sophea .*for approval/);assert.equal(task(h).pic_id,DARA);
  const hand=await waitFor(()=>sent.find(m=>m.chat.id===5002&&/Approval needed: Arrange the warehouse visit/.test(m.text)),'hand-over approval message');
  before=messageId;await answered(tap(users.sophea,hand,/Reject/));
  const reason=await newTo(5002,before,/Why are you rejecting this change/);pm(users.sophea,'Vanna is travelling that week.',{reply_to_message:{message_id:reason.message_id}});
  await waitFor(()=>s.get("SELECT status FROM tm_change_requests WHERE task_id=? ORDER BY id DESC LIMIT 1",h).status==='REJECTED','hand-over rejected');assert.equal(task(h).pic_id,DARA);
  before=messageId;pm(users.dara,'/task '+h);card=await cardFor(5001,before,'Arrange the warehouse visit');
  await answered(tap(users.dara,card,/Hand over/));card=sent.find(m=>m.message_id===card.message_id);
  await answered(tap(users.dara,card,/Vanna/));card=sent.find(m=>m.message_id===card.message_id);
  await answered(tap(users.dara,card,/keep me as supporting/));
  const hand2=await waitFor(()=>[...sent].reverse().find(m=>m.chat.id===5002&&/Approval needed: Arrange the warehouse visit/.test(m.text)&&m.message_id>hand.message_id),'second hand-over approval message');
  await answered(tap(users.sophea,hand2,/Approve change/));
  assert.equal(task(h).pic_id,VANNA);assert.equal(s.get('SELECT status FROM tm_assignees WHERE task_id=? AND staff_id=?',h,DARA).status,'ACCEPTED');
  const msg=await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Handed over to you: Arrange the warehouse visit/.test(m.text)),'hand-over message');
  assert.ok(buttonsOf(msg).some(b=>/Accept/.test(b.text)));
  before=messageId;pm(users.sophea,'/task '+h);card=await cardFor(5002,before,'Arrange the warehouse visit');
  const r=await answered(tap(users.sophea,card,/Remind/));assert.match(r.text,/Reminder sent to Vanna/);
  await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Reminder: Arrange the warehouse visit/.test(m.text)),'reminder message');
 });

 await check('V5.3 in Telegram: tick checklist items, attach photos and documents, and get task files back',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Load container MSKU 123',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:DARA,checklist:['Check the seal','Count the pallets']},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  let before=messageId;pm(users.dara,'/task '+id);let card=await cardFor(5001,before,'Load container');
  await answered(tap(users.dara,card,/Steps 0\/2/));card=sent.find(m=>m.message_id===card.message_id);assert.match(card.text,/0 of 2 completed/);
  const tick=await answered(tap(users.dara,card,/Check the seal/));assert.match(tick.text,/Step completed/);assert.equal(task(id).progress,0,'V5.5: steps never change progress');
  card=sent.find(m=>m.message_id===card.message_id);assert.match(card.text,/1 of 2 completed/);
  await answered(tap(users.dara,card,/Back to the task/));card=sent.find(m=>m.message_id===card.message_id);
  await answered(tap(users.dara,card,/Files/));card=sent.find(m=>m.message_id===card.message_id);
  before=messageId;await answered(tap(users.dara,card,/Attach a file/));
  const ask=await newTo(5001,before,/Send the photo or document/);
  before=messageId;pm(users.dara,undefined,{photo:[{file_id:'small1',file_unique_id:'s1',width:90,height:90,file_size:40},{file_id:'photo1',file_unique_id:'p1',width:800,height:800,file_size:PNG.length}],reply_to_message:{message_id:ask.message_id}});
  await waitFor(()=>s.get('SELECT * FROM tm_files WHERE task_id=?',id),'photo saved');
  const f=s.get('SELECT * FROM tm_files WHERE task_id=?',id);assert.match(f.name,/^photo-\d+\.jpg$/);assert.equal(f.source,'TELEGRAM');assert.ok(tgCalls.some(c=>c.method==='download'&&c.params.path==='photos/photo1.jpg'),'the largest photo size is downloaded');
  await newTo(5001,before,/attached/);
  pm(users.dara,undefined,{document:{file_id:'doc1',file_unique_id:'d1',file_name:'packing-list.pdf',file_size:PNG.length},reply_to_message:{message_id:card.message_id,from:{id:999,is_bot:true},text:`Load container MSKU 123\n${id} · Workflow QA`}});
  await waitFor(()=>s.get("SELECT * FROM tm_files WHERE task_id=? AND name='packing-list.pdf'",id),'document saved by replying to the task message');
  before=messageId;pm(users.dara,undefined,{document:{file_id:'big1',file_unique_id:'b1',file_name:'huge.pdf',file_size:6*1024*1024},reply_to_message:{message_id:card.message_id,from:{id:999,is_bot:true},text:id}});
  await newTo(5001,before,/larger than 5 MB/);
  const view=[...sent].reverse().find(m=>m.chat.id===5001&&/<b>Files<\/b>/.test(m.text||'')&&buttonsOf(m).some(b=>/packing-list/.test(b.text)));
  await answered(tap(users.dara,view,/packing-list/));
  await waitFor(()=>tgCalls.find(c=>c.method==='sendDocument'&&/packing-list\.pdf/.test(c.params.body||'')),'document sent back');
 });

 await check('V5.3 in Telegram: ask anyone for a task; the person asked accepts it and is in charge',async()=>{
  let before=messageId;pm(users.dara,'/request Print the delivery notes');
  let form=await newTo(5001,before,/Request a task/);
  await answered(tap(users.dara,form,/Vanna/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/Vanna does it/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/Workflow QA/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/^Tomorrow$/));form=sent.find(m=>m.message_id===form.message_id);
  await answered(tap(users.dara,form,/Send request/));
  const q=s.get("SELECT * FROM tm_requests WHERE title='Print the delivery notes'");assert.equal(q.manager_id,VANNA);assert.equal(q.doer,'RECEIVER');
  const incoming=await waitFor(()=>sent.find(m=>m.chat.id===5003&&/Task request: Print the delivery notes/.test(m.text)),'request to Vanna');
  assert.match(incoming.text,/asks you to do this task/);
  await answered(tap(users.vanna,incoming,/^✅ Accept$/));
  const card=sent.find(m=>m.message_id===incoming.message_id);assert.match(card.text,/Accept task request/);assert.match(card.text,/In charge: Vanna/);assert.match(card.text,/Reviewer: Dara/);
  const done=await answered(tap(users.vanna,card,/Accept and create/));assert.match(done.text,/accepted as TASK-/);
  const t=task(s.get('SELECT task_id FROM tm_requests WHERE id=?',q.id).task_id);assert.equal(t.pic_id,VANNA);assert.ok(t.accepted_at);assert.equal(t.reviewer_id,DARA);assert.equal(t.reviewer_status,'ACCEPTED');
 });

 await check('V5.3 in Telegram: due date reminders arrive as messages with a progress button (V5.4: to the people on the task)',async()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Submit the monthly VAT file',start_date:taskToday(),due_date:addDays(taskToday(),1),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id},DARA);
  s.reminders(new Date(`${taskToday()}T03:00:00Z`));
  const m=await waitFor(()=>sent.find(x=>x.chat.id===5001&&/Due tomorrow: Submit the monthly VAT file/.test(x.text)),'reminder message');
  assert.ok(buttonsOf(m).some(b=>/Update progress/.test(b.text)));
 });

 await check('Mini App gateway: signed Telegram launch data, linking, task data only and the same workflow',async()=>{
  const pub=path.join(folder,'public');mkdirSync(path.join(pub,'assets'),{recursive:true});writeFileSync(path.join(pub,'tg.html'),'<!doctype html><title>Tasks</title>');writeFileSync(path.join(pub,'assets','tg-abcdefgh.js'),'console.log(1)');
  gateway=createTelegramGateway({companies,publicDir:pub,logger:{error:()=>{}}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));gatewayBase=`http://127.0.0.1:${gateway.address().port}`;
  const init=(user,extra={})=>signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'AAF1',user,...extra},TOKEN);
  const call=async(url,{auth,data}={})=>{const r=await fetch(gatewayBase+url,{method:data?'POST':'GET',headers:{...(auth?{Authorization:'tma '+auth}:{}),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.text(),headers:r.headers};};
  assert.ok(validateInitData(init(users.dara),TOKEN));assert.equal(validateInitData(init(users.dara),TOKEN.replace('1','2')),null);
  assert.equal(validateInitData(init(users.dara).replace('Dara','Dora'),TOKEN),null);assert.equal(validateInitData(init(users.dara,{auth_date:Math.floor(Date.now()/1000)-90000}),TOKEN),null);
  const page=await call('/c/default/tg/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal((await call('/assets/tg-abcdefgh.js')).status,200);assert.equal((await call('/assets/../tg.html')).status,404);assert.equal((await call('/c/default/api/state')).status,404);
  assert.equal((await call('/c/default/tg/api/state')).status,401);
  const newcomer={id:5010,is_bot:false,first_name:'Chantha'};
  const blocked=await call('/c/default/tg/api/state',{auth:init(newcomer)});assert.equal(blocked.status,403);assert.equal(blocked.body.code,'not_linked');
  const code=(await api(cookies.chantha,'tg.link.code',{})).body.result.code;
  assert.equal((await call('/c/default/tg/api/link',{auth:init(newcomer),data:{code:'WRONG999'}})).status,400);
  assert.equal((await call('/c/default/tg/api/link',{auth:init(newcomer),data:{code}})).status,200);
  const state=(await call('/c/default/tg/api/state',{auth:init(users.dara)})).body;
  assert.ok(state.tm_tasks.length);assert.equal(state.contacts,undefined);assert.equal(state.ops_requests,undefined);assert.equal(state.auth.user.staff_id,DARA);
  assert.ok(Object.keys(state.auth.permissions).every(k=>k.startsWith('tasks.')));assert.ok(state.tm_notifications.every(n=>n.staff_id===DARA));
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Prepare the board pack',start_date:taskToday(),due_date:addDays(taskToday(),4),pic_id:DARA},SOPHEA).id;
  const acc=await call('/c/default/tg/api/command',{auth:init(users.dara),data:{action:'tm.task.accept',data:{id}}});assert.equal(acc.status,200);
  assert.equal(s.get("SELECT source FROM tm_task_history WHERE task_id=? AND kind='accept'",id).source,'MINIAPP');
  assert.equal((await call('/c/default/tg/api/command',{auth:init(newcomer),data:{action:'tm.task.accept',data:{id}}})).status,404,'only the people on a task can answer it');
  assert.equal((await call('/c/default/tg/api/command',{auth:init(users.dara),data:{action:'admin.user.save',data:{}}})).status,403);
  // V5.4: the assigner (Sophea) asks to complete Dara's accepted task from the Mini App; only Dara can decide it.
  const ask=await call('/c/default/tg/api/command',{auth:init(users.sophea),data:{action:'tm.task.close',data:{id}}});assert.equal(ask.status,200);assert.ok(ask.body.result.change_id);
  assert.equal(task(id).status,'IN_PROGRESS','nothing changes until Dara approves');
  assert.equal((await call('/c/default/tg/api/command',{auth:init(newcomer),data:{action:'tm.change.decide',data:{id:ask.body.result.change_id,decision:'APPROVE'}}})).status,404,'only the other side decides');
  assert.ok(state.tm_change_requests,'the Mini App receives change requests');
  const decided=await call('/c/default/tg/api/command',{auth:init(users.dara),data:{action:'tm.change.decide',data:{id:ask.body.result.change_id,decision:'APPROVE'}}});assert.equal(decided.status,200);
  assert.equal(task(id).status,'COMPLETED');assert.equal(s.get('SELECT decision_source FROM tm_change_requests WHERE id=?',ask.body.result.change_id).decision_source,'MINIAPP');
  const monthly=await call('/c/default/tg/api/report?report=monthly&month=2026-07&scope=all',{auth:init(users.vanna)});assert.equal(monthly.status,200);assert.ok(monthly.body.summary.stuck>=1);
  assert.equal((await call('/c/default/tg/api/report?report=monthly&scope=all',{auth:init(users.dara)})).status,403);
  assert.equal((await call('/c/default/tg/api/report?report=monthly&scope=me',{auth:init(users.dara)})).status,200);
  // Disabling the ERP account blocks Telegram access at once.
  const account=s.get('SELECT * FROM access_users WHERE staff_id=?',DARA);
  cmd('admin.user.disable',{id:account.id,expected_version:account.version,reason:'Left the company'},VANNA);
  // V5.6.8: it also ends the Telegram connection (reconnecting needs an active account).
  const off=await call('/c/default/tg/api/state',{auth:init(users.dara)});assert.equal(off.status,403);assert.equal(off.body.code,'not_linked');
  assert.ok(!s.get('SELECT 1 AS ok FROM tg_links WHERE staff_id=?',DARA),'the Telegram link is removed');
  const before=messageId;pm(users.dara,'/mytasks');await newTo(5001,before,/[Cc]onnect/);
 });


 await check('V5.3 Mini App: sign in with the ERP password, media links for photos and files, and the new actions',async()=>{
  const init=(user,extra={})=>signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'AAF3',user,...extra},TOKEN);
  const call=async(url,{auth,data}={})=>{const r=await fetch(gatewayBase+url,{method:data?'POST':'GET',headers:{...(auth?{Authorization:'tma '+auth}:{}),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const buf=Buffer.from(await r.arrayBuffer());let body;try{body=JSON.parse(buf.toString());}catch{body=buf;}return {status:r.status,body,headers:r.headers};};
  cmd('admin.user.save',{name:'Mony · Warehouse',email:'mony@example.test',role_id:'ROLE-MEMBER',password:'mony-password-1',active:1},VANNA);
  const MONY=s.get("SELECT staff_id FROM access_users WHERE email='mony@example.test'").staff_id,phone={id:5030,is_bot:false,first_name:'Mony'};
  assert.equal((await call('/c/default/tg/api/state',{auth:init(phone)})).body.code,'not_linked');
  assert.equal((await call('/c/default/tg/api/login',{auth:init(phone),data:{email:'mony@example.test',password:'wrong-password'}})).status,401);
  assert.equal((await call('/c/default/tg/api/login',{data:{email:'mony@example.test',password:'mony-password-1'}})).status,401,'only from inside Telegram');
  const ok=await call('/c/default/tg/api/login',{auth:init(phone),data:{email:'MONY@example.test',password:'mony-password-1'}});assert.equal(ok.status,200);assert.equal(ok.body.name,'Mony · Warehouse');
  assert.equal(s.telegram.linkFor(5030).staff_id,MONY);assert.match(s.get("SELECT detail FROM access_audit WHERE action='Telegram account connected' ORDER BY id DESC LIMIT 1").detail,/signed in with the ERP password/);
  const st=(await call('/c/default/tg/api/state',{auth:init(phone)})).body;
  assert.ok(st.media_token);assert.ok(st.tm_people.some(p=>p.staff_id===VANNA));assert.ok(Array.isArray(st.tm_checklist)&&Array.isArray(st.tm_files)&&Array.isArray(st.staff_photos));assert.equal(st.auth.user.email,'mony@example.test');
  cmd('me.photo.save',{base64:PNG.toString('base64')},VANNA);
  const v=s.get('SELECT version FROM staff_photos WHERE staff_id=?',VANNA).version,token=encodeURIComponent(st.media_token);
  const photo=await call(`/c/default/tg/api/photo?staff=${VANNA}&v=${v}&t=${token}`);assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/png');
  assert.equal((await call(`/c/default/tg/api/photo?staff=${VANNA}&v=${v}&t=bad`)).status,403);
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Mini App checklist',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:MONY},SOPHEA).id;
  const act=(action,data)=>call('/c/default/tg/api/command',{auth:init(phone),data:{action,data}});
  assert.equal((await act('tm.task.accept',{id})).status,200);
  assert.equal((await act('tm.check.add',{task_id:id,title:'Scan the delivery note'})).status,200);
  const up=await act('tm.file.add',{task_id:id,name:'note.png',base64:PNG.toString('base64')});assert.equal(up.status,200);
  const file=await call(`/c/default/tg/api/file?id=${up.body.result.id}&inline=1&t=${token}`);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/png');
  assert.equal((await act('me.profile.save',{name:'Mony Chea · Warehouse'})).status,200);assert.equal(s.get('SELECT name FROM lookups WHERE id=?',MONY).name,'Mony Chea · Warehouse');
  // V5.4: handing over asks the assigner (Sophea) first. Handing it to her makes it her own task.
  const ho=await act('tm.task.handover',{id,to_id:SOPHEA});assert.equal(ho.status,200);assert.equal(task(id).pic_id,MONY);
  cmd('tm.change.decide',{id:ho.body.result.change_id,decision:'APPROVE'},SOPHEA);assert.equal(task(id).pic_id,SOPHEA);
  assert.equal((await act('tg.link.unlink',{})).status,200);
  assert.equal((await call(`/c/default/tg/api/photo?staff=${VANNA}&v=${v}&t=${token}`)).status,403,'disconnecting ends media access');
 });
 await check('open ERP screens and the Mini App learn about changes made anywhere from a cheap change counter',async()=>{
  const seq=async()=>(await request('/api/changes',{cookie:cookies.vanna})).body.seq;
  assert.equal((await request('/api/changes')).status,401,'signed-in people only');
  const a=await seq();assert.equal((await request('/api/state',{cookie:cookies.vanna})).body.change_seq,a,'the state says which change it was built at');
  assert.equal(await seq(),a,'reading does not move the counter');
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Check the change counter',start_date:taskToday(),due_date:addDays(taskToday(),2),pic_id:SOPHEA},VANNA).id;
  const b=await seq();assert.ok(b>a,'a saved change moves it');
  const init=user=>signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'AAF2',user},TOKEN);
  const gw=async(url,{auth,data}={})=>{const r=await fetch(gatewayBase+url,{method:data?'POST':'GET',headers:{...(auth?{Authorization:'tma '+auth}:{}),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json()};};
  assert.equal((await gw('/c/default/tg/api/changes')).status,401,'the Mini App check needs Telegram launch data');
  const seen=s.get('SELECT last_seen_at FROM tg_links WHERE tg_user_id=?',users.vanna.id).last_seen_at;
  assert.equal((await gw('/c/default/tg/api/changes',{auth:init(users.vanna)})).body.seq,b);
  assert.equal(s.get('SELECT last_seen_at FROM tg_links WHERE tg_user_id=?',users.vanna.id).last_seen_at,seen,'checking is not counted as activity');
  assert.equal((await gw('/c/default/tg/api/command',{auth:init(users.vanna),data:{action:'tm.task.note',data:{id,note:'Please use the new template.'}}})).status,200);
  const c=await seq();assert.ok(c>b,'a change made in the Mini App moves it for the ERP screens');
  assert.equal((await gw('/c/default/tg/api/state',{auth:init(users.vanna)})).body.change_seq,c);
 });

 await check('a rejected token stops the bot with a clear status; turning Telegram off stops it',async()=>{
  const v=s.telegram.settings().version;
  cmd('admin.telegram.save',{enabled:true,bot_token:'987654321:AAHwrongTokenForSunnyErpLocalChecks0',expected_version:v},VANNA);
  await waitFor(()=>s.telegram.settings().status==='ERROR','error status');assert.match(s.telegram.settings().status_detail,/rejected the bot token/);
  cmd('admin.telegram.save',{enabled:false,expected_version:v+1},VANNA);
  await waitFor(()=>!runtime.bot('default'),'bot stopped');assert.equal(s.telegram.settings().status,'OFF');
 });
 console.log(`\n${checks} task workflow and Telegram checks passed (V5.2 and V5.3). No real Telegram servers were contacted.`);
}finally{
 await runtime?.stop();gateway?.close();mock?.close();
 if(server)await new Promise(r=>server.close(r));
 s.db.close();rmSync(folder,{recursive:true,force:true});
}

// V5.6.8 review fixes for Task Management (ERP and Telegram Mini App): authorization, privacy, organization visibility,
// workflow edge cases and the per-person sidebar colour. Temporary in-memory company only.
import assert from 'node:assert/strict';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {organizationFixture} from './organization-fixture.mjs';
import {taskToday,addDays} from './task-domain.mjs';
import {mediaToken,checkMediaToken,validateInitData,signInitData,miniState} from './telegram-gateway.mjs';

const s=openStore();seedDemo(s);
const {ids:{A,B,C,D,E,X,Y},cmd,rev,createWorkspace,task,wsB,user}=organizationFixture(s);
const state=staff=>s.scopedState(user(staff));
// A request as it arrives from the ERP or the Mini App: permission check first, then the command.
const via=(staff,action,data)=>{s.access.authorize(user(staff),action,data);return s.command(action,data,staff);};
const denied=(fn,status,pattern)=>assert.throws(fn,e=>(e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`))&&(!pattern||pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`)));
const t=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const notes=(staff,kind)=>s.all('SELECT * FROM tm_notifications WHERE staff_id=? AND kind=? ORDER BY id',staff,kind);
const due=(id)=>s.get('SELECT * FROM tm_due_requests WHERE id=?',id);
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
const today=taskToday();
const member=(staff,workspace_id)=>cmd('org.membership.request',{workspace_id,beneficiary_id:staff,reason:'Team member'},B);
try{
 member(C,wsB);member(D,wsB);

 check('team profiles: only managers change other people’s profiles, administrators their names and emails; contact details stay private',()=>{
  const profile=staff=>{const p=s.get("SELECT l.name,COALESCE(p.email,'') AS email,COALESCE(p.phone,'') AS phone,COALESCE(p.position,'') AS position,COALESCE(p.department,'') AS department,COALESCE(p.version,0) AS version FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=?",staff);return {staff_id:staff,name:p.name,email:p.email,phone:p.phone,position:p.position,department:p.department,active:1,expected_version:p.version};};
  via(D,'tm.profile.save',{...profile(D),phone:'012 345 678',email:'d.team@review.test'});
  denied(()=>via(C,'tm.profile.save',{...profile(D),position:'Changed by C'}),403,/managers and administrators/);
  denied(()=>via(C,'tm.profile.photo',{staff_id:D,remove:true}),403);
  denied(()=>via(C,'tm.profile.save',{name:'New person',email:'',active:1}),403,/add team members/);
  via(B,'tm.profile.save',{...profile(D),position:'Dispatcher'});assert.equal(profile(D).position,'Dispatcher');
  denied(()=>via(B,'tm.profile.save',{...profile(D),name:'D · Renamed'}),403,/name or team email/);
  via(A,'tm.profile.save',{...profile(D),name:'D · Review employee (Ops)'});
  assert.match(s.get("SELECT detail FROM access_audit WHERE action='Team profile changed' ORDER BY id DESC LIMIT 1").detail,/name D · Review employee → D · Review employee \(Ops\)/);
  const forC=state(C).tm_profiles.find(p=>p.staff_id===D),forB=state(B).tm_profiles.find(p=>p.staff_id===D),own=state(D).tm_profiles.find(p=>p.staff_id===D);
  assert.equal(forC.email,'');assert.equal(forC.phone,'');assert.equal(forB.phone,'012 345 678');assert.equal(own.email,'d.team@review.test');
  assert.ok(!state(C).tm_events.some(e=>e.entity_type==='user'&&e.entity_id===D),'other people’s profile history stays with them and their managers');
  assert.ok(state(C).tm_profiles.every(p=>'org_level' in p),'the governing-manager picker gets organization levels');
 });

 check('a new password or a disabled account ends the Telegram connection; anyone can sign out of every device',()=>{
  s.run("INSERT INTO tg_links(tg_user_id,staff_id,chat_id,username,first_name,notify,linked_at) VALUES(9101,?,9101,'','E',1,?)",E,new Date().toISOString());
  const u=user(E);cmd('admin.user.save',{...u,expected_version:u.version,password:'A-new-password-2026'},A);
  assert.ok(!s.get('SELECT 1 AS ok FROM tg_links WHERE staff_id=?',E),'Telegram disconnected');
  assert.match(s.get("SELECT detail FROM access_audit WHERE action='Telegram account disconnected' ORDER BY id DESC LIMIT 1").detail,/password changed/);
  const token=mediaToken('default',9101,'1:token',Date.now(),'2026-10-01T00:00:00.000Z');
  assert.equal(checkMediaToken(token,'default','1:token',Date.now(),'2026-10-01T00:00:00.000Z'),9101);
  assert.equal(checkMediaToken(token,'default','1:token',Date.now(),'2026-10-08T00:00:00.000Z'),null,'a new connection ends earlier photo and file links');
  assert.equal(checkMediaToken(token,'default','1:token',Date.now(),()=>null),null,'no connection, no access');
  const old=signInitData({auth_date:Math.floor(Date.now()/1000)-9*3600,user:{id:9101,first_name:'E'}},'1:token');
  assert.ok(validateInitData(old,'1:token'));assert.equal(validateInitData(old,'1:token',{maxAge:8*3600}),null,'Mini App launch data older than 8 hours is refused');
  s.access.startSession(user(C));s.access.startSession(user(C));
  assert.match(cmd('me.sessions.end',{},C).message,/Signed out of 2 sessions/);assert.equal(s.get('SELECT COUNT(*) AS n FROM access_sessions WHERE user_id=?',user(C).id).n,0);
 });

 check('malformed IDs are refused as bad requests, and other people’s requests are “not found”',()=>{
  for(const data of [{id:42},{id:['x']},{id:{a:1}},{task_id:7},{attendee_ids:'x'},{supporter_ids:[1]}])denied(()=>s.access.authorize(user(C),'tm.task.accept',data),400);
  s.access.authorize(user(C),'tm.notification.read',{id:5});
  const q=cmd('tm.request.save',{title:'Private ask',manager_id:C},B).id;
  denied(()=>via(D,'tm.request.withdraw',{id:q}),404,/not found/);denied(()=>via(D,'tm.request.decide',{id:q,decision:'DECLINE',note:'x'}),404);
  denied(()=>via(D,'tm.request.forward',{id:q,manager_id:D}),404);
  denied(()=>via(C,'tm.request.forward',{id:q,manager_id:B}),400,/asked for this task/);
  // Passing a request on follows the workspace's rules: C may not bring someone from another branch into Workspace B.
  const w=cmd('tm.request.save',{title:'Workspace ask',manager_id:C,workspace_id:wsB},D).id;
  denied(()=>via(C,'tm.request.forward',{id:w,manager_id:Y}),403,/outside this workspace/);
  for(let i=0;i<19;i++)cmd('tm.request.save',{title:`Ask ${i}`,manager_id:C},D);
  denied(()=>cmd('tm.request.save',{title:'One too many',manager_id:C},D),429,/20 requests/);
  denied(()=>cmd('tm.request.save',{title:'Yesterday',manager_id:B,proposed_due_date:addDays(today,-1)},D),400,/from today on/);
 });

 let wsC,personal;
 check('governing managers see their workspaces’ work (view only); personal-workspace work given to others stays under oversight',()=>{
  cmd('org.delegation.request',{beneficiary_id:C,template_id:'OWNER',reason:'Delivery team'},B);
  wsC=createWorkspace(C,'Workspace C · Delivery');
  const outside=task(C,wsC,'Pick-up with the other branch',{pic_id:Y});
  assert.equal(s.tasks.scope.reason(B,t(outside)),'governance','the governing manager sees work led outside their branch');
  assert.equal(state(B).tm_tasks.find(x=>x.id===outside).access_reason,'governance');
  denied(()=>cmd('tm.task.progress',{id:outside,progress:10},B),403);
  personal=cmd('org.workspace.save',{name:'E · Personal',kind:'PERSONAL'},E).id;
  const own=task(E,personal,'My private reminder'),given=task(E,personal,'Help me with this',{pic_id:D});
  assert.equal(s.tasks.scope.reason(C,t(given)),'team','D’s manager sees work given to D');
  assert.ok(['team','organization'].includes(s.tasks.scope.reason(A,t(given))),'Level 1 too');
  for(const staff of [C,D,A,B])assert.equal(s.tasks.scope.reason(staff,t(own)),null,'the owner’s own work stays private');
  assert.equal(state(A).task_scope.company,true);
 });

 check('workspace deletion stays with its creator, tells the people with work there, and comes back only with valid governance',()=>{
  denied(()=>via(B,'tm.workspace.delete',{id:wsC,expected_version:t0ws().version,acknowledged:true}),403,/created this workspace/);
  via(C,'tm.workspace.delete',{id:wsC,expected_version:t0ws().version,acknowledged:true});
  assert.ok(notes(Y,'workspace_deleted').length,'Y (in charge of work there) is told');
  assert.ok(!state(Y).tm_tasks.some(x=>x.workspace_id===wsC));
  assert.ok(s.organization.query(A,{view:'audit',workspace:wsC}).rows.some(r=>r.action==='workspace.deleted'),'Level 1 can still read its history');
  via(C,'tm.workspace.restore',{id:wsC,expected_version:t0ws().version,acknowledged:true});
  assert.ok(notes(Y,'workspace_restored').length);assert.ok(state(Y).tm_tasks.some(x=>x.workspace_id===wsC));
  const flags=state(C).tm_workspaces.find(w=>w.id===wsC).org_access;assert.equal(flags.can_delete,true);assert.equal(flags.can_archive,false,'archiving needs Workspace “Delete” in the role');
  function t0ws(){return s.get('SELECT * FROM tm_workspaces WHERE id=?',wsC);}
 });

 check('reopening a task both sides agreed to close waits for the other side; due date requests end with the task',()=>{
  const id=task(B,wsB,'Ship the samples',{pic_id:C,supporter_ids:[D]});
  cmd('tm.task.accept',{id},C);cmd('tm.task.accept',{id},D);
  const q=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(today,9),reason:'Customs'},D).id;
  cmd('tm.task.submit',{id},C);cmd('tm.task.close',{id},B);assert.equal(t(id).status,'COMPLETED');
  assert.equal(due(q).status,'DECLINED');assert.equal(due(q).decision_note,'The task was completed');assert.ok(notes(D,'due_declined').some(n=>n.due_request_id===q));
  const r=cmd('tm.task.reopen',{id,note:'A carton is missing'},C);assert.ok(r.change_id);assert.equal(t(id).status,'COMPLETED');assert.match(r.message,/stays completed/);
  denied(()=>cmd('tm.task.reopen',{id,note:'again'},B),409);
  cmd('tm.change.decide',{id:r.change_id,decision:'APPROVE'},B);assert.equal(t(id).status,'IN_PROGRESS');
 });

 check('a supporting person’s new date applies only when the other side approves it; a reviewer who steps down passes date requests on',()=>{
  const id=task(B,wsB,'Count the pallets',{pic_id:C,supporter_ids:[D]});cmd('tm.task.accept',{id},C);cmd('tm.task.accept',{id},D);
  const q=cmd('tm.due.request',{task_id:id,proposed_due_date:addDays(today,10),reason:'Stock arrives late'},D).id;
  const agreed=cmd('tm.due.decide',{id:q,decision:'APPROVE',expected_version:due(q).version},B);assert.ok(agreed.change_id);
  cmd('tm.change.decide',{id:agreed.change_id,decision:'REJECT',note:'We keep the date'},C);
  assert.equal(due(q).status,'DECLINED');assert.match(due(q).decision_note,/rejected the new date/);assert.equal(t(id).due_date,addDays(today,7));
  // A reviewer who has not confirmed yet decides date requests; stepping down passes them to the task's creator.
  const id2=task(B,wsB,'Label the boxes',{pic_id:C,supporter_ids:[D],reviewer_id:A});cmd('tm.task.accept',{id:id2},D);
  const q2=cmd('tm.due.request',{task_id:id2,proposed_due_date:addDays(today,11),reason:'Labels late'},D).id;assert.equal(due(q2).decide_by,A);
  cmd('tm.task.decline',{id:id2,role:'reviewer',note:'Not my area'},A);assert.equal(due(q2).decide_by,B);assert.ok(notes(B,'due_new').some(n=>n.due_request_id===q2));
  cmd('tm.due.withdraw',{id:q2},D);assert.ok(s.get("SELECT 1 AS ok FROM tm_task_history WHERE task_id=? AND kind='due_withdrawn'",id2));assert.ok(notes(B,'task_updated').some(n=>n.due_request_id===q2));
  // Taking someone off a task withdraws their date request.
  const own=task(B,wsB,'Sweep the dock',{supporter_ids:[D]});cmd('tm.task.accept',{id:own},D);
  const q3=cmd('tm.due.request',{task_id:own,proposed_due_date:addDays(today,12),reason:'Rain'},D).id;
  const o=t(own);cmd('tm.task.save',{id:own,expected_version:o.version,workspace_id:wsB,title:o.title,start_date:o.start_date,due_date:o.due_date,pic_id:B,supporter_ids:[]},B);assert.equal(due(q3).status,'WITHDRAWN');
 });

 check('meetings: the organizer (or whoever scheduled it) changes time, people and details; attendees complete it and set reminders',()=>{
  const at=h=>new Date(Date.now()+h*3600e3).toISOString();
  const M=cmd('tm.meeting.save',{workspace_id:wsB,title:'Dock planning',organizer_id:B,attendee_ids:[C,D],start_at:at(30),end_at:at(31)},B).id;
  const m=()=>s.get('SELECT * FROM tm_meetings WHERE id=?',M);
  denied(()=>cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C,D],start_at:at(32),end_at:at(33)},C),403,/organizer/);
  denied(()=>cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C],organizer_id:C},C),403);
  denied(()=>cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C,D],status:'CANCELLED',reason:'x'},C),403);
  cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C,D],reminder_offsets:[60]},C);assert.equal(m().reminder_offsets,'[60]');
  cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C]},B);assert.ok(s.get("SELECT 1 AS ok FROM tm_notifications WHERE staff_id=? AND title LIKE 'Removed from a meeting%'",D),'D is told');
  denied(()=>cmd('tm.meeting.save',{workspace_id:wsB,title:'In the past',organizer_id:B,attendee_ids:[C],start_at:at(-3),end_at:at(-2)},B),400,/still ahead/);
  cmd('tm.meeting.save',{...m(),expected_version:m().version,attendee_ids:[B,C],status:'COMPLETED',minutes_notes:'Agreed'},C);assert.equal(m().status,'COMPLETED');
 });

 check('files: real content only, and kept once a task is closed; repeated taps and empty progress are handled',()=>{
  const id=task(B,wsB,'Check the seals',{pic_id:B});
  const exe=Buffer.from('MZ\x90\x00 pretend program','latin1').toString('base64'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==','base64').toString('base64');
  denied(()=>cmd('tm.file.add',{task_id:id,name:'invoice.pdf',base64:exe},B),400,/not a real PDF/);
  const f=cmd('tm.file.add',{task_id:id,name:'seal.jpg',base64:png},B).id;
  denied(()=>cmd('tm.task.progress',{id},B),400,/Enter the progress/);
  cmd('tm.task.note',{id,note:'Seal 4 is loose'},B);assert.equal(cmd('tm.task.note',{id,note:'Seal 4 is loose'},B).unchanged,true);
  assert.equal(s.get("SELECT COUNT(*) AS n FROM tm_task_history WHERE task_id=? AND kind='note'",id).n,1);
  cmd('tm.check.add',{task_id:id,title:'Photo of each seal'},B);assert.equal(cmd('tm.check.add',{task_id:id,title:'Photo of each seal'},B).unchanged,true);
  assert.equal(cmd('tm.task.resume',{id},B).unchanged,true);
  cmd('tm.task.close',{id},B);denied(()=>cmd('tm.file.remove',{id:f},B),409,/Reopen it first/);
  assert.equal(cmd('tm.task.reopen',{id,note:'More seals'},B).message,'Task reopened.');assert.equal(cmd('tm.task.reopen',{id,note:'again'},B).unchanged,true);
 });

 check('edit history keeps what changed from and to; a person in charge who rejected the task gets no deadline reminders',()=>{
  const id=task(B,wsB,'Fix the gate',{pic_id:B});const o=t(id);
  cmd('tm.task.save',{id,expected_version:o.version,workspace_id:wsB,title:'Fix the north gate',start_date:o.start_date,due_date:addDays(today,1),pic_id:B,priority:'HIGH'},B);
  assert.match(s.get("SELECT note FROM tm_task_history WHERE task_id=? AND kind='edit'",id).note,/title Fix the gate → Fix the north gate.*due date .* → .*priority Medium → High/);
  const r=task(B,wsB,'Repaint the line',{pic_id:C,due_date:addDays(today,1)});cmd('tm.task.decline',{id:r,note:'On leave'},C);
  s.tasks.reminders(new Date(`${today}T03:00:00Z`));
  assert.ok(!s.get("SELECT 1 AS ok FROM tm_notifications WHERE task_id=? AND staff_id=? AND kind='task_due_soon'",r,C));
  assert.ok(s.get("SELECT 1 AS ok FROM tm_notifications WHERE task_id=? AND staff_id=? AND kind='task_due_soon'",r,B),'the assigner is still reminded');
 });

 check('each person keeps their own sidebar colour; the Mini App keeps the latest history of every task',()=>{
  cmd('me.profile.save',{sidebar_theme:'teal'},C);assert.equal(state(C).my_sidebar_theme,'teal');assert.equal(state(B).my_sidebar_theme,'');
  denied(()=>cmd('me.profile.save',{sidebar_theme:'purple'},C),400);cmd('me.profile.save',{sidebar_theme:'blue'},C);assert.equal(state(C).my_sidebar_theme,'');
  const id=task(B,wsB,'Busy task',{pic_id:B});for(let i=0;i<70;i++)s.run("INSERT INTO tm_task_history(task_id,kind,from_status,to_status,progress,stuck,due_date,note,actor_id,source,created_at) VALUES(?,'note','IN_PROGRESS','IN_PROGRESS',0,0,?,?,?,'WEB',?)",id,today,'n'+i,B,new Date().toISOString());
  const mini=miniState(s,user(B),'');assert.equal(mini.tm_task_history.filter(h=>h.task_id===id).length,60);assert.ok(mini.tm_task_history.some(h=>h.task_id!==id));
 });

 check('login attempts are limited per account from any address',()=>{
  for(let i=0;i<20;i++)assert.throws(()=>s.access.login('x@review.test','wrong-password',`10.0.0.${i}`),e=>e.status===401);
  denied(()=>s.access.login('x@review.test','Review-organization-2026','10.0.1.1'),429);
  assert.ok(s.access.login('y@review.test','Review-organization-2026','10.0.0.1'),'other accounts are unaffected');
 });
 console.log(`\n${checks} V5.6.8 review checks passed. Temporary in-memory company only.`);
}finally{s.db.close?.();}

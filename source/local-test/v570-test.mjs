import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {createLocalServer} from './server.mjs';
import {miniState,MINI_APP_ACTIONS} from './telegram-gateway.mjs';
import {scheduledNext,normalizeRule} from './recurrence.mjs';
import {timeRange,rangeDays} from './time-range.mjs';
import {taskToday,addDays,buildTaskReport} from './task-domain.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'tcm-v570-')),s=openStore(path.join(dir,'test.sqlite'));let count=0,server;
const check=async(label,fn)=>{await fn();console.log('PASS '+label);count++;};
const fails=(fn,pattern,status)=>assert.throws(fn,e=>pattern.test(e.message)&&(!status||e.status===status));
const admin=s.access.bootstrap({name:'Huon Sithai',email:'huon@example.test',company_name:'Test Company',password:'Test-password-2026'}),A=admin.staff_id;
const user=staff=>s.access.publicUser(s.access.accountFor(staff).id);
const cmd=(actor,action,data)=>{s.access.authorize(user(actor),action,data);return s.command(action,data,actor);};
const account=(name,role='ROLE-MEMBER')=>{const r=cmd(A,'admin.user.save',{name,email:name.replaceAll(' ','')+'@example.test',password:'Test-password-2026',role_id:role});return s.get('SELECT staff_id FROM access_users WHERE id=?',r.id).staff_id;};
const B=account('Team Member'),C=account('Peer Manager','ROLE-MANAGER'),D=account('Other Viewer');
const state=staff=>s.access.filterState(s.state(),user(staff));
const ws=cmd(A,'tm.workspace.save',{name:'Operations',owner_id:A,member_ids:[A,B,C]},).id;
const taskData={workspace_id:ws,title:'Prepare report',description:'Deliver reconciled totals with supporting evidence',pic_id:B,reviewer_id:A,start_date:taskToday(),due_date:addDays(taskToday(),4),priority:'MEDIUM',estimate:'1:00'};
let task,meeting,time;
try {
 await check('username login normalizes case/Unicode/spacing; email login is refused; duplicate normalized usernames are refused',()=>{
  assert.equal(s.access.login('  HUON   Sithai ','Test-password-2026','test').staff_id,A);
  fails(()=>s.access.login('huon@example.test','Test-password-2026','test'),/Username or password/,401);
  fails(()=>cmd(A,'admin.user.save',{name:'huon   sithai',email:'duplicate@example.test',password:'Test-password-2026',role_id:'ROLE-MEMBER'}),/username.*in use/,409);
 });
 await check('immutable display name and optional nickname across web and Mini App',()=>{
  fails(()=>cmd(B,'me.profile.save',{name:'New self name'}),/display name/,403);
  fails(()=>cmd(A,'lookup.save',{id:A,kind:'staff',name:'Renamed reference'}),/Display names/,403);
  cmd(B,'me.profile.save',{nickname:'Tong'});
  assert.equal(state(B).lookups.find(x=>x.id===B).name,'Team Member (Tong)');
  assert.equal(miniState(s,user(B)).lookups.find(x=>x.id===B).name,'Team Member (Tong)');
  assert.equal(s.organization.person(B).name,'Team Member (Tong)');
  cmd(B,'me.profile.save',{nickname:''});assert.equal(state(B).lookups.find(x=>x.id===B).name,'Team Member');
 });
 await check('blank/whitespace expectation refused for task and request; valid creation retained',()=>{
  fails(()=>cmd(A,'tm.task.save',{...taskData,description:'  '}),/Expectation is required/);
  fails(()=>cmd(B,'tm.request.save',{title:'Need help',manager_id:A,description:''}),/Expectation is required/);
  task=cmd(A,'tm.task.save',taskData).id;
  const r=cmd(B,'tm.request.save',{title:'Need help',manager_id:A,description:'A reconciled invoice'});assert.ok(r.id);
 });
 await check('custom daily, multiweekday/interval weekly, and monthly schedules handle month/year/leap boundaries',()=>{
  assert.equal(scheduledNext('DAILY','2026-12-31',31,{interval:3}),'2027-01-03');
  const r={interval:2,weekdays:[1,3],anchor:'2026-10-12'};
  assert.equal(scheduledNext('WEEKLY','2026-10-12',12,r),'2026-10-14');
  assert.equal(scheduledNext('WEEKLY','2026-10-14',12,r),'2026-10-26');
  assert.equal(scheduledNext('MONTHLY','2028-01-31',31,{interval:1,month_day:31,anchor:'2028-01-31'}),'2028-02-29');
  assert.equal(scheduledNext('MONTHLY','2028-02-29',31,{interval:1,month_day:31,anchor:'2028-01-31'}),'2028-03-31');
  assert.equal(scheduledNext('MONTHLY','2026-12-12',12,{interval:2,month_day:12}),'2027-02-12');
  fails(()=>normalizeRule('WEEKLY',{weekdays:[]},'2026-10-13'),/weekday/);
 });
 await check('recurring task close creates one next occurrence and retry never duplicates it',()=>{
  const first=cmd(A,'tm.task.save',{...taskData,pic_id:A,recurrence:'DAILY',recurrence_rule:{interval:3},request_key:'series-one'}).id;
  const t=s.get('SELECT * FROM tm_tasks WHERE id=?',first);
  cmd(A,'tm.task.close',{id:first,expected_version:t.version});
  const closed=s.get('SELECT * FROM tm_tasks WHERE id=?',first),next=s.get('SELECT * FROM tm_tasks WHERE id=?',closed.next_task_id);
  assert.equal(next.due_date,addDays(taskData.due_date,3));assert.equal(JSON.parse(next.recurrence_rule).interval,3);
  const before=s.get('SELECT COUNT(*) n FROM tm_tasks').n;try{cmd(A,'tm.task.close',{id:first,expected_version:closed.version});}catch{}
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_tasks').n,before);
 });
 await check('task edits require the opposite party even before acceptance; rejection preserves original',()=>{
  let t=s.get('SELECT * FROM tm_tasks WHERE id=?',task);const r=cmd(A,'tm.task.save',{...t,estimate:'1:00',title:'Proposed title',expected_version:t.version});
  assert.ok(r.change_id);assert.equal(s.get('SELECT title FROM tm_tasks WHERE id=?',task).title,t.title);
  fails(()=>cmd(A,'tm.change.decide',{id:r.change_id,decision:'APPROVE',expected_version:0}),/other|Only|approve/i,403);
  cmd(B,'tm.change.decide',{id:r.change_id,decision:'REJECT',note:'Keep original',expected_version:0});assert.equal(s.get('SELECT title FROM tm_tasks WHERE id=?',task).title,t.title);
 });
 await check('personal task details require a distinct reviewer; proposed invitation and changes apply only on approval',()=>{
  const id=cmd(A,'tm.task.save',{...taskData,title:'Personal draft',pic_id:A,reviewer_id:A}).id;
  const t=s.get('SELECT * FROM tm_tasks WHERE id=?',id);
  fails(()=>cmd(A,'tm.task.save',{...t,estimate:'1:00',expected_version:t.version,title:'Personal change'}),/Choose another active/);
  const r=cmd(A,'tm.task.save',{...t,estimate:'1:00',expected_version:t.version,title:'Personal change',reviewer_id:D});
  assert.ok(r.change_id);assert.equal(s.get('SELECT reviewer_id FROM tm_tasks WHERE id=?',id).reviewer_id,A);
  fails(()=>cmd(A,'tm.change.decide',{id:r.change_id,decision:'APPROVE',expected_version:0}),/Only/,403);
  cmd(D,'tm.change.decide',{id:r.change_id,decision:'APPROVE',expected_version:0});
  assert.equal(s.get('SELECT title FROM tm_tasks WHERE id=?',id).title,'Personal change');assert.equal(s.get('SELECT reviewer_id FROM tm_tasks WHERE id=?',id).reviewer_id,D);
 });
 await check('calendar task projection excludes oversight-only users and is identical through Mini App',()=>{
  assert.ok(state(C).tm_tasks.some(t=>t.id===task)===false||state(C).tm_calendar_tasks.every(t=>t.id!==task));
  assert.ok(state(B).tm_calendar_tasks.some(t=>t.id===task));assert.ok(state(D).tm_calendar_tasks.every(t=>t.id!==task));
  assert.deepEqual(miniState(s,user(B)).tm_calendar_tasks.map(t=>t.id),state(B).tm_calendar_tasks.map(t=>t.id));
 });
 await check('meetings private by default, explicit selected sharing view-only, changes are pending until another party approves',()=>{
  const start=new Date(Date.now()+3*86400000).toISOString(),end=new Date(Date.now()+3*86400000+3600000).toISOString();
  meeting=cmd(A,'tm.meeting.save',{workspace_id:ws,title:'Plan work',start_at:start,end_at:end,organizer_id:A,attendee_ids:[A,B],share_scope:'PARTICIPANTS'}).id;
  assert.ok(!state(C).tm_meetings.some(m=>m.id===meeting));assert.ok(!state(D).tm_meetings.some(m=>m.id===meeting));
  let m=s.get('SELECT * FROM tm_meetings WHERE id=?',meeting),r=cmd(A,'tm.meeting.save',{...m,expected_version:m.version,title:'Revised meeting',share_scope:'SELECTED',share_ids:[D]});
  assert.ok(r.change_id);assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',meeting).title,'Plan work');assert.ok(!state(D).tm_meetings.some(x=>x.id===meeting));
  fails(()=>cmd(A,'tm.meeting.decide',{id:r.change_id,expected_version:0,decision:'APPROVE'}),/other designated party/,403);
  cmd(B,'tm.meeting.decide',{id:r.change_id,expected_version:0,decision:'APPROVE'});
  m=s.get('SELECT * FROM tm_meetings WHERE id=?',meeting);assert.equal(m.title,'Revised meeting');assert.ok(state(D).tm_meetings.some(x=>x.id===meeting));
  fails(()=>cmd(D,'tm.meeting.save',{...m,expected_version:m.version,title:'Unauthorized'}),/authorized participants/,403);
  r=cmd(B,'tm.meeting.save',{...m,expected_version:m.version,title:'Rejected title'});cmd(A,'tm.meeting.decide',{id:r.change_id,expected_version:0,decision:'REJECT',note:'No change'});
  assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',meeting).title,'Revised meeting');
  assert.ok(miniState(s,user(B)).tm_meeting_changes.some(q=>q.id===r.change_id));
  assert.ok(s.all('SELECT * FROM tm_events WHERE entity_id=?',meeting).some(x=>x.action==='Meeting change approved'));
 });
 await check('single-participant meeting can invite a second approver without applying unapproved membership or details',()=>{
  const start=new Date(Date.now()+5*86400000).toISOString(),end=new Date(Date.now()+5*86400000+3600000).toISOString();
  const id=cmd(A,'tm.meeting.save',{workspace_id:ws,title:'Solo planning',start_at:start,end_at:end,organizer_id:A,attendee_ids:[A]}).id;
  let m=s.get('SELECT * FROM tm_meetings WHERE id=?',id);
  fails(()=>cmd(A,'tm.meeting.save',{...m,expected_version:m.version,title:'Proposed'}),/Invite another/);
  let r=cmd(A,'tm.meeting.save',{...m,expected_version:m.version,title:'Joint planning',attendee_ids:[A,D]});
  assert.ok(state(D).tm_meetings.some(x=>x.id===id));assert.ok(!s.get('SELECT 1 FROM tm_attendees WHERE meeting_id=? AND staff_id=?',id,D));
  cmd(D,'tm.meeting.decide',{id:r.change_id,expected_version:0,decision:'REJECT',note:'Unavailable'});
  assert.ok(!state(D).tm_meetings.some(x=>x.id===id));assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',id).title,'Solo planning');
  r=cmd(A,'tm.meeting.save',{...m,expected_version:m.version,title:'Joint planning',attendee_ids:[A,D]});
  cmd(D,'tm.meeting.decide',{id:r.change_id,expected_version:0,decision:'APPROVE'});
  assert.ok(s.get('SELECT 1 FROM tm_attendees WHERE meeting_id=? AND staff_id=?',id,D));assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',id).title,'Joint planning');
 });
 await check('independent and linked timesheets, private owner access, daily total limit and reports',()=>{
  time=cmd(B,'tm.time.save',{activity:'Urgent customer call',duration:'1:30',work_date:taskToday()}).id;
  const linked=cmd(B,'tm.time.save',{task_id:task,staff_id:B,duration:'2:00',work_date:taskToday()}).id;
  assert.equal(s.get('SELECT task_id FROM tm_timesheets WHERE id=?',time).task_id,null);
  assert.ok(state(B).tm_timesheets.some(x=>x.id===time));assert.ok(!state(C).tm_timesheets.some(x=>x.id===time));
  fails(()=>cmd(C,'tm.time.save',{id:time,expected_version:0,activity:'Steal',duration:'1:00',work_date:taskToday()}),/owner/,403);
  fails(()=>cmd(B,'tm.time.save',{activity:'Too much',duration:'23:00',work_date:taskToday()}),/24 hours/);
  const report=buildTaskReport(s.scopedState(user(B)),{report:'time',from:taskToday(),to:taskToday()});assert.ok(report.rows.some(x=>x.task==='Urgent customer call'));
  assert.ok(MINI_APP_ACTIONS.test('tm.time.save'));assert.ok(miniState(s,user(B)).tm_timesheets.some(x=>x.id===linked));
 });
 await check('rolling interval includes exactly previous same weekday through today; week/month boundaries are stable',()=>{
  assert.deepEqual(timeRange('rolling','2026-10-13'),{from:'2026-10-06',to:'2026-10-13'});assert.equal(rangeDays(timeRange('rolling','2026-10-13')).length,8);
  assert.deepEqual(timeRange('week','2026-10-13'),{from:'2026-10-12',to:'2026-10-18'});assert.deepEqual(timeRange('month','2028-02-15'),{from:'2028-02-01',to:'2028-02-29'});
 });
 await check('same-level workspace privacy and explicitly authorized Administration global visibility',()=>{
  s.run('UPDATE tm_profiles SET org_level=1 WHERE staff_id IN (?,?)',B,C);s.organization.invalidate();
  const privateWs=cmd(B,'tm.workspace.save',{name:'Peer private',owner_id:B,member_ids:[B]}).id;
  assert.ok(!state(C).tm_workspaces.some(w=>w.id===privateWs));assert.ok(state(A).tm_workspaces.some(w=>w.id===privateWs));
  s.run('INSERT INTO tm_members(workspace_id,staff_id) VALUES(?,?)',privateWs,C);s.organization.invalidate();assert.ok(state(C).tm_workspaces.some(w=>w.id===privateWs));
  assert.equal(s.access.can(user(C),'admin.workspaces'),false);
 });
 await check('30 MiB task upload through HTTP; oversize/type checks; username login over HTTP',async()=>{
  const port=4477;server=createLocalServer(s,port);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const post=async(route,data,cookie='')=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});return {r,body:await r.json()};};
  const login=await post('/api/auth/login',{username:'Team Member',password:'Test-password-2026'});assert.equal(login.r.status,200);const cookie=login.r.headers.get('set-cookie').split(';')[0];
  const result=await post('/api/command',{action:'tm.file.add',data:{task_id:task,name:'30MiB.txt',base64:Buffer.alloc(30*1024*1024,65).toString('base64')}},cookie);assert.equal(result.r.status,200,JSON.stringify(result.body));
  fails(()=>cmd(B,'tm.file.add',{task_id:task,name:'large.txt',base64:Buffer.alloc(30*1024*1024+1,65).toString('base64')}),/30 MB/);
  fails(()=>cmd(B,'tm.file.add',{task_id:task,name:'bad.pdf',base64:Buffer.from('MZ executable').toString('base64')}),/not a real PDF/);
 });
 await check('foreign keys, migration versions, and meeting/task audit remain valid',()=>{assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);assert.equal(s.get('SELECT MAX(version) v FROM schema_version').v,19);assert.ok(s.get('SELECT COUNT(*) n FROM tm_meeting_changes').n>=2);});
 console.log(`\n${count} integration groups passed.`);
} finally {if(server)await new Promise(r=>server.close(r));s.db.close();rmSync(dir,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createFakeGoogle} from './google-fake.mjs';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramRuntime} from './telegram-bot.mjs';
import {miniState} from './telegram-gateway.mjs';
import {taskToday,addDays} from './task-domain.mjs';
import {readXlsx,writeXlsx,zip} from './xlsx.mjs';

// V5.5 hardening. A separate reviewer who had not seen the V5.5 work tried to break it and found 19 problems; each is
// checked here so it can't come back. Fixtures as in v55-test.mjs: Director A (Vanna, Administrator), Manager B (Sophea,
// reports to A), Employee C (Dara, reports to B), Chantha (reports to A), Kosal (reports to Chantha), Bopha (Viewer).
// Google Sheets runs against the local stand-in (google-fake.mjs): SIMULATED, not a live Google connection.
const fake=await createFakeGoogle();Object.assign(process.env,fake.env,{GOOGLE_REQUESTS_PER_MINUTE:'1000'});
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v55s-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;let checks=0,server,mock,runtime;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,label,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw new Error('Timed out waiting for '+label);await sleep(40);}};
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const rejects=async(p,pattern,status)=>assert.rejects(p,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const today=taskToday(),soon=n=>addDays(today,n),at=h=>new Date(Date.now()+h*3600e3).toISOString();
const VANNA='STAFF-003',SOPHEA='STAFF-002',DARA='STAFF-001';
const staffOf=email=>s.get('SELECT staff_id FROM access_users WHERE email=?',email).staff_id;
const userOf=staff=>s.access.publicUser(s.access.accountFor(staff).id);
const stateOf=staff=>s.access.filterState(s.state(),userOf(staff));
try{
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 for(const [name,email,role] of [['Chantha · Operations','chantha@example.test','ROLE-MEMBER'],['Kosal · Warehouse','kosal@example.test','ROLE-MEMBER'],['Bopha · Viewer','bopha@example.test','ROLE-VIEWER'],['Mony · Assistant','mony@example.test','ROLE-MEMBER']])
  cmd('admin.user.save',{name,email,role_id:role,password:'local-password-1',active:1},VANNA);
 const [CHANTHA,KOSAL,BOPHA,MONY]=['chantha','kosal','bopha','mony'].map(n=>staffOf(`${n}@example.test`));
 for(const [staff,manager] of [[SOPHEA,VANNA],[DARA,SOPHEA],[CHANTHA,VANNA],[KOSAL,CHANTHA]])cmd('tm.profile.manager',{staff_id:staff,manager_id:manager},VANNA);
 const ws=cmd('tm.workspace.save',{name:'V5.5 Sales',department:'Sales',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,VANNA,BOPHA,CHANTHA,MONY]},SOPHEA).id;

 const port=4357,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data}={})=>{const r=await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body};};
 const login=async(email,password)=>{const r=await fetch(`${base}/c/default/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,email);return r.headers.get('set-cookie').split(';')[0];};
 const C={vanna:await login('vanna@example.test','vanna-password-1'),sophea:await login('sophea@example.test','sophea-password-1'),dara:await login('dara@example.test','dara-password-12'),chantha:await login('chantha@example.test','local-password-1')};
 const api=(who,action,data)=>request('/c/default/api/command',{cookie:C[who],data:{action,data}});

 // ================================================================ Task Visibility Scope, calendar and notifications
 // Vanna's own task (hidden from Sophea: reporting lines show the work of people below you, not above).
 const A1=cmd('tm.task.save',{workspace_id:ws,title:'Board preparation (private)',start_date:today,due_date:soon(3),pic_id:VANNA},VANNA).id;
 const T1=cmd('tm.time.save',{task_id:A1,staff_id:VANNA,work_date:today,duration:'2:00',notes:'Board prep'},VANNA).id;
 // Vanna gives Chantha work and asks to move its date: the change waits for Chantha (Sophea can't see this task either).
 const A2=cmd('tm.task.save',{workspace_id:ws,title:'Warehouse audit plan',start_date:today,due_date:soon(5),pic_id:CHANTHA},VANNA).id;
 cmd('tm.task.accept',{id:A2},CHANTHA);
 const t2=s.get('SELECT * FROM tm_tasks WHERE id=?',A2);
 const CR=cmd('tm.task.save',{...t2,id:A2,expected_version:t2.version,estimate:'0:00',supporter_ids:s.tasks.supportersOf(t2),due_date:soon(9)},VANNA).change_id;assert.ok(CR,'the date change waits for Chantha');

 await check('an ID with spaces or a tab around it is the same record: hidden tasks stay “not found” and unchanged',async()=>{
  const missing=await api('sophea','tm.task.progress',{id:' TASK-999999',progress:10});assert.equal(missing.status,404);
  for(const [action,data] of [['tm.task.progress',{id:` ${A1}`,progress:10}],['tm.task.note',{id:`${A1}\t`,note:'x'}],['tm.change.decide',{id:`${CR}\t`,decision:'APPROVE'}],
   ['tm.time.save',{task_id:` ${A1}`,staff_id:VANNA,work_date:today,duration:'1:00'}],['tm.time.delete',{id:` ${T1}`,expected_version:0,reason:'x'}],
   ['tm.meeting.save',{workspace_id:ws,title:'Linked',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(50),end_at:at(51),task_id:` ${A1}`}],['tm.check.add',{task_id:`${A1} `,title:'x'}]]){
   const r=await api('sophea',action,data);
   assert.equal(r.status,404,`${action}: ${JSON.stringify(r.body)}`);assert.deepEqual(r.body.error,missing.body.error,`${action} answers exactly like a missing task`);
  }
  assert.ok(s.get('SELECT 1 AS ok FROM tm_timesheets WHERE id=?',T1),'Vanna’s time entry is still there');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_timesheets WHERE task_id=?',A1).n,1,'no time was added');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_meetings WHERE task_id=?',A1).n,0,'no meeting was linked');
  assert.equal(s.get('SELECT status FROM tm_change_requests WHERE id=?',CR).status,'PENDING');
  // The same padding on a task someone may see works as before.
  const own=cmd('tm.task.save',{workspace_id:ws,title:'Dara’s call list',start_date:today,due_date:soon(2),pic_id:DARA},DARA).id;
  const r=await api('dara','tm.task.progress',{id:` ${own} `,progress:20});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(s.get('SELECT progress FROM tm_tasks WHERE id=?',own).progress,20);
 });

 await check('the CRM customer history shows task and meeting entries only to people who may see them',async()=>{
  const contact=s.get('SELECT id FROM contacts ORDER BY id LIMIT 1').id;
  const P=cmd('tm.task.save',{workspace_id:ws,title:'Private pricing plan',start_date:today,due_date:soon(4),pic_id:VANNA,related_type:'CONTACT',related_id:contact},VANNA).id;
  cmd('tm.task.note',{id:P,note:'Walk-away price is 41,000 USD - do not share'},VANNA);
  const M=cmd('tm.meeting.save',{workspace_id:ws,title:'Private: price strategy',organizer_id:VANNA,attendee_ids:[CHANTHA],start_at:at(30),end_at:at(31),task_id:P},VANNA).id;
  assert.equal(s.get('SELECT contact_id FROM tm_meetings WHERE id=?',M).contact_id,contact);
  const journey=async who=>{const r=await request(`/c/default/api/journey?contact=${contact}`,{cookie:C[who]});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.events.filter(e=>e.entity_type==='task_management').map(e=>e.entity_id);};
  const sophea=await journey('sophea');assert.ok(!sophea.includes(P)&&!sophea.includes(M),'Sophea sees neither the task nor the meeting');
  const chantha=await journey('chantha');assert.ok(chantha.includes(M)&&!chantha.includes(P),'Chantha (invited) sees the meeting, not the task');
  const vanna=await journey('vanna');assert.ok(vanna.includes(P)&&vanna.includes(M));
 });

 await check('task requests (and the tasks they became) follow the scope: approvers no longer see every request',async()=>{
  const Q=cmd('tm.request.save',{manager_id:VANNA,title:'Investigate missing stock',description:'Keep confidential.',doer:'REQUESTER',workspace_id:ws,proposed_due_date:soon(6)},CHANTHA).id;
  const task=cmd('tm.request.decide',{id:Q,decision:'APPROVE'},VANNA).id;
  assert.equal(s.get('SELECT task_id FROM tm_requests WHERE id=?',Q).task_id,task);
  const sees=staff=>stateOf(staff).tm_requests.some(q=>q.id===Q);
  assert.equal(sees(SOPHEA),false,'Sophea (Manager, Tasks “Approve”) does not see it');
  assert.ok(!stateOf(SOPHEA).tm_events.some(e=>e.entity_id===Q||String(e.detail).includes(task)),'nor its activity');
  assert.ok(sees(CHANTHA)&&sees(VANNA),'the requester and the person asked do');
  assert.equal(miniState(s,userOf(SOPHEA)).tm_requests.some(q=>q.id===Q),false,'the Mini App applies the same rule');
  const q=s.get('SELECT * FROM tm_requests WHERE id=?',Q);
  assert.equal(s.tasks.scope.canSeeRequest(SOPHEA,q),false,'and so does the bot');assert.equal(s.tasks.scope.canSeeRequest(KOSAL,q),false);
  assert.equal(s.tasks.scope.canSeeRequest(CHANTHA,q),true);
 });

 await check('when the assigner can no longer decide, a new progress figure still goes to the assigner’s side',async()=>{
  const T=cmd('tm.task.save',{workspace_id:ws,title:'Shipment documents',start_date:today,due_date:soon(5),pic_id:DARA,supporter_ids:[BOPHA],reviewer_id:VANNA},MONY).id;
  for(const who of [DARA,BOPHA,VANNA])cmd('tm.task.accept',{id:T},who);
  const change=cmd('tm.task.progress',{id:T,progress:60,note:'Mostly done'},BOPHA).change_id;
  assert.equal(s.get('SELECT approver_id FROM tm_change_requests WHERE id=?',change).approver_id,MONY);
  const acct=s.get('SELECT * FROM access_users WHERE staff_id=?',MONY);
  cmd('admin.user.disable',{id:acct.id,expected_version:acct.version,reason:'Left the company'},VANNA);
  fails(()=>cmd('tm.change.decide',{id:change,decision:'APPROVE'},DARA),/Only Mony/,403);
  assert.equal(s.get('SELECT progress FROM tm_tasks WHERE id=?',T).progress,0,'the person in charge can’t approve the work side’s own progress');
  assert.match(cmd('tm.change.decide',{id:change,decision:'APPROVE'},VANNA).message,/Progress is now 60%/);
 });

 await check('seeing a task through a reporting line is viewing only, also for its time entries',async()=>{
  const C1=cmd('tm.task.save',{workspace_id:ws,title:'Call three leads',start_date:today,due_date:soon(2),pic_id:DARA},DARA).id;
  const E=cmd('tm.time.save',{task_id:C1,staff_id:DARA,work_date:today,duration:'1:00',notes:'Called 3 leads'},DARA).id;
  assert.equal(s.tasks.scope.reason(SOPHEA,s.get('SELECT * FROM tm_tasks WHERE id=?',C1)),'team');
  for(const [action,data] of [['tm.time.save',{id:E,expected_version:0,task_id:C1,staff_id:DARA,work_date:today,duration:'9:45'}],['tm.time.save',{task_id:C1,staff_id:DARA,work_date:soon(-1),duration:'2:00'}],['tm.time.delete',{id:E,expected_version:0,reason:'x'}]]){
   const r=await api('sophea',action,data);assert.equal(r.status,403,`${action}: ${JSON.stringify(r.body)}`);assert.match(r.body.error,/view this task but not change it/);
  }
  assert.equal(s.get('SELECT minutes FROM tm_timesheets WHERE id=?',E).minutes,60);assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_timesheets WHERE task_id=?',C1).n,1);
  // People on the task still record time for each other, as before (the assigner for the person in charge).
  const G1=cmd('tm.task.save',{workspace_id:ws,title:'Quote follow-up',start_date:today,due_date:soon(3),pic_id:DARA},SOPHEA).id;cmd('tm.task.accept',{id:G1},DARA);
  assert.equal((await api('sophea','tm.time.save',{task_id:G1,staff_id:DARA,work_date:today,duration:'0:30'})).status,200);
  assert.equal((await api('dara','tm.time.save',{id:E,expected_version:0,task_id:C1,staff_id:DARA,work_date:today,duration:'1:15'})).status,200);
 });

 await check('workspace log lines never name a task the reader may not see; deleting a note without an ID is a plain “not found”',async()=>{
  s.run("INSERT INTO tm_events(entity_type,entity_id,workspace_id,action,detail,actor_id,created_at) VALUES('workspace',?,?,'Workspace member added',?,?,?)",ws,ws,`Bopha · Viewer · chosen for ${A1}`,VANNA,new Date().toISOString());
  const line=staff=>stateOf(staff).tm_events.find(e=>e.entity_type==='workspace'&&/Bopha · Viewer · chosen for/.test(e.detail)).detail;
  assert.equal(line(SOPHEA),'Bopha · Viewer · chosen for a task');assert.equal(line(VANNA),`Bopha · Viewer · chosen for ${A1}`);
  const N=cmd('tm.task.save',{workspace_id:ws,title:'New member check',start_date:today,due_date:soon(2),pic_id:KOSAL},VANNA).id;
  assert.ok(s.all("SELECT detail FROM tm_events WHERE entity_type='workspace' AND action='Workspace member added'").every(e=>!e.detail.includes(N)),'new lines say “chosen for a task”');
  fails(()=>cmd('tm.calnote.delete',{},DARA),/not found/,404);fails(()=>cmd('tm.calnote.delete',{expected_version:0},DARA),/not found/,404);
 });

 await check('people whose role has Meetings but not Tasks get meeting and note reminders too',async()=>{
  const role=cmd('admin.role.save',{name:'Meetings only',permissions:{'tasks.meetings':['view','create','update'],'tasks.workspace':['view']}},VANNA).id;
  cmd('admin.user.save',{name:'Mina · Reception',email:'mina@example.test',role_id:role,password:'local-password-1',active:1},VANNA);
  const MINA=staffOf('mina@example.test');
  const start=new Date(Date.now()+61*60000).toISOString(),end=new Date(Date.now()+121*60000).toISOString(),later=()=>new Date(Date.now()+2*60000);
  const M=cmd('tm.meeting.save',{workspace_id:ws,title:'Visitor briefing',organizer_id:SOPHEA,attendee_ids:[DARA,MINA],start_at:start,end_at:end,reminder_offsets:[60]},SOPHEA).id;
  const note=cmd('tm.calnote.save',{title:'Collect visitor badges',all_day:false,start_at:start,reminder_offsets:[60]},MINA).id;
  s.eventReminders(later());
  const got=(staff,kind,col,id)=>!!s.get(`SELECT 1 AS ok FROM tm_notifications WHERE staff_id=? AND kind=? AND ${col}=?`,staff,kind,id);
  assert.ok(got(MINA,'meeting_reminder','meeting_id',M),'Mina’s meeting reminder');assert.ok(got(MINA,'note_reminder','note_id',note),'Mina’s note reminder');
  assert.ok(got(DARA,'meeting_reminder','meeting_id',M)&&got(SOPHEA,'meeting_reminder','meeting_id',M));
  s.eventReminders(later());assert.equal(s.get("SELECT COUNT(*) AS n FROM tm_notifications WHERE staff_id=? AND kind='meeting_reminder' AND meeting_id=?",MINA,M).n,1,'never twice');
 });

 await check('Telegram: the “Meeting cancelled” notice is delivered (other messages about a cancelled meeting are not)',async()=>{
  const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00',sent=[];
  mock=http.createServer(async(req,res)=>{
   const chunks=[];for await(const c of req)chunks.push(c);
   const params=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{},m=/^\/bot([^/]+)\/(\w+)$/.exec(req.url);
   const reply=r=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:r}));};
   if(!m||m[1]!==TOKEN){res.writeHead(401);return res.end('{"ok":false,"error_code":401}');}
   if(m[2]==='getMe')return reply({id:999,is_bot:true,first_name:'Sunny Tasks',username:'sunny_tasks_bot'});
   if(m[2]==='getUpdates'){await sleep(150);return reply([]);}
   if(m[2]==='sendMessage'){sent.push(params);return reply({message_id:sent.length,chat:{id:params.chat_id,type:'private'},date:Math.floor(Date.now()/1000),text:params.text});}
   return reply(true);
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
  s.telegram.connectSignedIn(DARA,{id:7301,first_name:'Dara'},7301);
  runtime=createTelegramRuntime({companies:{list:()=>[{id:'default'}],get:()=>s},apiBase:`http://127.0.0.1:${mock.address().port}`,supervisorMs:100,outboxMs:100,pollTimeout:1,logger:{error:()=>{}}}).start();
  await waitFor(()=>s.telegram.settings().status==='ONLINE','bot online');
  // The outbox starts after what already exists (no backlog): wait until it has noted where it starts.
  await waitFor(()=>s.telegram.settings().last_notification_id>=0,'the outbox');
  const M=cmd('tm.meeting.save',{workspace_id:ws,title:'Customer visit',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(30),end_at:at(31)},SOPHEA).id;
  const status=kind=>{const n=s.get('SELECT id FROM tm_notifications WHERE staff_id=? AND meeting_id=? AND kind=? ORDER BY id DESC',DARA,M,kind);return n&&s.get("SELECT status,reason FROM tm_notification_deliveries WHERE notification_id=? AND channel='TELEGRAM' AND status IN('SENT','SKIPPED','FAILED')",n.id);};
  assert.equal((await waitFor(()=>status('meeting_invited'),'invitation')).status,'SENT');
  const m=s.get('SELECT * FROM tm_meetings WHERE id=?',M);
  cmd('tm.meeting.save',{...m,expected_version:m.version,attendee_ids:[DARA],status:'CANCELLED',reason:'Customer postponed'},SOPHEA);
  assert.equal((await waitFor(()=>status('meeting_cancelled'),'cancellation')).status,'SENT');
  await waitFor(()=>sent.some(x=>x.chat_id===7301&&/Meeting cancelled: Customer visit/.test(x.text)),'the cancellation message');
  // A reminder for the cancelled meeting (for example one queued just before) is not sent.
  const n=s.insert('tm_notifications',{staff_id:DARA,kind:'meeting_reminder',task_id:null,request_id:null,due_request_id:null,meeting_id:M,note_id:null,title:'Reminder: Customer visit',body:'',actor_id:null,created_at:new Date().toISOString()});
  const late=await waitFor(()=>s.get("SELECT status,reason FROM tm_notification_deliveries WHERE notification_id=(SELECT MAX(id) FROM tm_notifications) AND channel='TELEGRAM' AND status IN('SENT','SKIPPED')"),'the late reminder',4000);
  assert.equal(late.status,'SKIPPED');assert.match(late.reason,/cancelled/);void n;
  runtime.stop();runtime=null;
 });

 // ================================================================ Groups: rules, layouts, notes, bulk delete, import
 const G=cmd('tm.group.save',{workspace_id:ws,name:'Payroll',visibility:'TEAM',audience:'SELECTED',shared:[{staff_id:DARA,level:'EDIT'},{staff_id:BOPHA,level:'VIEW'}]},SOPHEA).id;
 const colId=(g,name)=>s.get('SELECT id FROM tm_board_columns WHERE board_id=? AND name=?',g,name).id;
 for(const [name,type,settings] of [['Qty','NUMBER'],['Salary','NUMBER'],['Total','FORMULA',{expression:'={Qty} * {Salary}'}],['Code','TEXT']])cmd('tm.group.column.save',{group_id:G,name,type,...(settings?{settings}:{})},SOPHEA);
 const COL={ITEM:colId(G,'Item'),QTY:colId(G,'Qty'),SALARY:colId(G,'Salary'),TOTAL:colId(G,'Total'),CODE:colId(G,'Code')};
 const R=[];for(let i=1;i<=6;i++)R.push(cmd('tm.group.row.add',{group_id:G,values:{[COL.ITEM]:`Item ${i}`,[COL.QTY]:i,[COL.SALARY]:1000*i+7,[COL.CODE]:`C${i}`}},SOPHEA).id);
 cmd('tm.group.column.access',{group_id:G,id:COL.SALARY,principals:[{type:'USER',id:SOPHEA}]},SOPHEA);
 cmd('tm.group.row.access',{group_id:G,ids:[R[2],R[3]],principals:[{type:'USER',id:SOPHEA}]},SOPHEA);

 await check('layouts and row positions never reveal hidden columns or rows',async()=>{
  cmd('tm.group.layout.save',{group_id:G,layout:{widths:{[COL.SALARY]:240,[COL.TOTAL]:180,[COL.ITEM]:200}}},SOPHEA);
  cmd('tm.group.view.save',{group_id:G,view:{widths:{[COL.ITEM]:210}}},DARA);
  const g=s.tasks.groups.read(G,DARA),json=JSON.stringify(g);
  assert.deepEqual(g.columns.map(c=>c.name),['Item','Qty','Code']);
  for(const hidden of [COL.SALARY,COL.TOTAL,R[2],R[3]])assert.ok(!json.includes(hidden),`no ${hidden} anywhere in Dara’s answer`);
  assert.deepEqual(g.layout.widths,{[COL.ITEM]:200});
  assert.ok(g.page.rows.every(r=>!('position' in r)),'no absolute positions while rows are hidden from her');
  assert.ok(s.tasks.groups.read(G,SOPHEA).page.rows.every(r=>Number.isInteger(r.position)),'the people who manage the group still get them');
 });

 await check('notes: their author needs edit access to change or delete them; managers can always remove one',async()=>{
  const n=cmd('tm.group.note.add',{group_id:G,row_id:R[0],body:'Check the contract'},DARA).id;
  let b=s.get('SELECT * FROM tm_boards WHERE id=?',G);
  cmd('tm.group.save',{id:G,expected_version:b.version,shared:[{staff_id:DARA,level:'VIEW'},{staff_id:BOPHA,level:'VIEW'}]},SOPHEA);
  fails(()=>cmd('tm.group.note.edit',{group_id:G,id:n,expected_version:0,body:'Edited while view-only'},DARA),/needs “Can edit records”/,403);
  fails(()=>cmd('tm.group.note.delete',{group_id:G,id:n,expected_version:0},DARA),/needs “Can edit records”/,403);
  assert.equal(s.get('SELECT body FROM tm_board_notes WHERE id=?',n).body,'Check the contract');
  assert.match(cmd('tm.group.note.delete',{group_id:G,id:n,expected_version:0},SOPHEA).message,/Note deleted/);
  b=s.get('SELECT * FROM tm_boards WHERE id=?',G);
  cmd('tm.group.save',{id:G,expected_version:b.version,shared:[{staff_id:DARA,level:'EDIT'},{staff_id:BOPHA,level:'VIEW'}]},SOPHEA);
 });

 await check('“delete all matching” deletes exactly the rows that matched when they were confirmed',async()=>{
  const match={q:'',filters:[{col:COL.CODE,value:'C'}]};
  const page=s.tasks.groups.query(G,DARA,match);assert.equal(page.total,4);assert.ok(page.match_key);
  fails(()=>cmd('tm.group.row.delete',{group_id:G,match,expected_count:4},DARA),/since you selected them/,409);
  // Someone moves a row out of the filter and another into it: the same count, different rows.
  const row=id=>s.get('SELECT * FROM tm_board_rows WHERE id=?',id);
  cmd('tm.group.row.update',{group_id:G,id:R[5],expected_version:row(R[5]).version,values:{[COL.CODE]:'X6'}},SOPHEA);
  const extra=cmd('tm.group.row.add',{group_id:G,values:{[COL.ITEM]:'Keep me!',[COL.CODE]:'C7'}},SOPHEA).id;
  assert.equal(s.tasks.groups.query(G,DARA,match).total,4);
  fails(()=>cmd('tm.group.row.delete',{group_id:G,match,expected_count:4,match_key:page.match_key},DARA),/since you selected them/,409);
  assert.ok(row(extra)&&row(R[0]),'nothing was deleted');
  const now=s.tasks.groups.query(G,DARA,match);
  assert.equal(cmd('tm.group.row.delete',{group_id:G,match,expected_count:now.total,match_key:now.match_key},DARA).deleted,4);
  assert.ok(row(R[5])&&row(R[2])&&row(R[3]),'rows that did not match (or that Dara can’t see) stay');assert.ok(!row(extra)&&!row(R[0]));
 });

 const book=writeXlsx({sheets:[{name:'Sheet1',columns:[{header:'Item',type:'text'},{header:'Qty',type:'number'}],rows:[['Paper',3],['Ink',2]]}]});
 const crafted=(sheets,sst='')=>zip([
  {name:'xl/workbook.xml',data:`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((x,i)=>`<sheet name="S${i+1}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
  {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((x,i)=>`<Relationship Id="rId${i+1}" Type="worksheet" Target="${x.target}"/>`).join('')}</Relationships>`},
  ...(sst?[{name:'xl/sharedStrings.xml',data:sst}]:[]),
  ...[...new Map(sheets.filter(x=>x.xml).map(x=>[x.target,x.xml]))].map(([target,xml])=>({name:`xl/${target}`,data:xml}))]);
 const sheetXml=rows=>`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

 await check('Excel import: a small file can’t expand into a huge upload, repeat rows past the limit or reuse one sheet’s data',async()=>{
  // One 30,000-character text used by 400 cells: 12 million characters from a file of a few kilobytes.
  const long=`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${'x'.repeat(30000)}</t></si></sst>`;
  const bomb=crafted([{target:'worksheets/sheet1.xml',xml:sheetXml(Array.from({length:20},(_,r)=>`<row r="${r+1}">${Array.from({length:20},(_,c)=>`<c t="s"><v>0</v></c>`).join('')}</row>`).join(''))}],long);
  assert.ok(bomb.length<20000,`the crafted file is small (${bomb.length} bytes)`);
  assert.throws(()=>readXlsx(bomb),/more than 10,000,000 characters/);
  const before=s.get('SELECT COUNT(*) AS n FROM tm_board_imports').n,started=Date.now();
  const r=await api('dara','tm.group.import.upload',{group_id:G,name:'bomb.xlsx',base64:bomb.toString('base64')});
  assert.equal(r.status,422);assert.ok(Date.now()-started<3000,'refused quickly');assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_imports').n,before,'nothing stored');
  // 30,000 (empty) rows all numbered 1: read as rows 1, 2, 3… and cut at the row limit.
  const many=readXlsx(crafted([{target:'worksheets/sheet1.xml',xml:sheetXml('<row r="1"/>'.repeat(30000))}]));
  assert.ok(many[0].rows.length<=20001&&many[0].truncated,`${many[0].rows.length} rows read, truncated`);
  // Two worksheets pointing at the same data.
  const one=sheetXml('<row r="1"><c t="inlineStr"><is><t>x</t></is></c></row>');
  assert.throws(()=>readXlsx(crafted([{target:'worksheets/sheet1.xml',xml:one},{target:'worksheets/sheet1.xml'}])),/two worksheets share/);
  assert.equal(readXlsx(book)[0].rows.length,3,'a normal workbook still reads');
 });

 await check('Excel import preview: the plan is bounded and checked for permission first (no clues about hidden columns)',async()=>{
  const up=await api('dara','tm.group.import.upload',{group_id:G,name:'supplies.xlsx',base64:book.toString('base64')});assert.equal(up.status,200,JSON.stringify(up.body));
  const imp=up.body.result.import.id,preview=(who,plan)=>request('/c/default/api/tasks/group/import/preview',{cookie:C[who],data:{import_id:imp,plan}});
  let started=Date.now(),r=await preview('dara',{mode:'append',sheets:[{index:0,header_row:1,columns:Array.from({length:4000},(_,i)=>({source:0,new:{name:`Col ${i}`,type:'TEXT'}}))}]});
  assert.equal(r.status,400);assert.match(r.body.error,/up to 200 columns/);assert.ok(Date.now()-started<1500,'answered at once');
  r=await preview('dara',{mode:'append',sheets:[{index:0,header_row:1,columns:[{source:0,target:COL.ITEM}]},{index:0,header_row:1,columns:[{source:0,target:COL.ITEM}]}]});
  assert.equal(r.status,400);assert.match(r.body.error,/each worksheet once/);
  const guess=async name=>(await preview('dara',{mode:'append',sheets:[{index:0,header_row:1,columns:[{source:0,target:COL.ITEM},{source:1,new:{name,type:'NUMBER'}}]}]}));
  const salary=await guess('Salary'),bonus=await guess('Bonus');
  assert.equal(salary.status,403);assert.equal(bonus.status,403);assert.equal(salary.body.error,bonus.body.error,'the same answer for a hidden column’s name and an unknown one');
  r=await preview('dara',{mode:'append',sheets:[{index:0,header_row:1,columns:[{source:0,target:COL.ITEM},{source:1,target:COL.QTY}]}]});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.totals.add,2);
 });

 // ================================================================ Google Sheets (SIMULATED): the connector's own rights
 cmd('admin.integrations.save',{client_id:'local-test.apps.googleusercontent.com',client_secret:'local-secret',interval_s:30},VANNA);
 const redirectUri=`${base}/c/default/api/google/callback`;
 const connectGoogle=async(staff,g)=>{
  const conn=await s.sync.request(userOf(staff),{action:'connect',group_id:g},{redirectUri});
  const loc=new URL((await fetch(conn.url+'&auto=1',{redirect:'manual'})).headers.get('location'));
  assert.ok((await s.sync.finishAuth({code:loc.searchParams.get('code'),state:loc.searchParams.get('state'),browser:conn.browser},redirectUri)).ok);
 };
 const syncGroup=async(staff,g,{delete_mode='KEEP'}={})=>{
  const columns=s.sync.describe(g,staff,redirectUri).columns.filter(c=>c.syncable&&!c.restricted).map(c=>({column_id:c.id}));
  const r=await s.sync.request(userOf(staff),{action:'setup',group_id:g,mode:'new',direction:'TWO_WAY',columns,delete_mode,confirm_delete:delete_mode==='PROPAGATE'},{redirectUri});
  await s.sync.request(userOf(staff),{action:'resume',id:r.id},{redirectUri});await s.sync.request(userOf(staff),{action:'sync_now',id:r.id},{redirectUri});
  return {id:r.id,sid:s.get('SELECT spreadsheet_id FROM tm_board_syncs WHERE id=?',r.id).spreadsheet_id};
 };

 await check('SIMULATED Google Sheets: the sheet can add or delete group rows only as far as the connector’s role allows',async()=>{
  const role=cmd('admin.role.save',{name:'Group keeper',permissions:{'tasks.tasks':['view'],'tasks.workspace':['view'],'tasks.groups':['view','create','update','delete']}},VANNA).id;
  cmd('admin.user.save',{name:'Rith · Records',email:'rith@example.test',role_id:role,password:'local-password-1',active:1},VANNA);
  const RITH=staffOf('rith@example.test'),w0=s.get('SELECT * FROM tm_workspaces WHERE id=?',ws);
  cmd('tm.workspace.save',{...w0,id:ws,expected_version:w0.version,member_ids:[...s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?',ws).map(m=>m.staff_id),RITH]},SOPHEA);
  const g=cmd('tm.group.save',{workspace_id:ws,name:'Stock list',visibility:'TEAM',audience:'SELECTED',shared:[{staff_id:RITH,level:'MANAGE'}]},SOPHEA).id;
  const item=colId(g,'Item'),ids=['Box','Tape','Wrap'].map(x=>cmd('tm.group.row.add',{group_id:g,values:{[item]:x}},SOPHEA).id);
  await connectGoogle(RITH,g);
  const {id,sid}=await syncGroup(RITH,g,{delete_mode:'PROPAGATE'});
  // The administrator takes Create and Delete away from Rith's role.
  cmd('admin.role.save',{id:role,expected_version:s.get('SELECT version FROM access_roles WHERE id=?',role).version,name:'Group keeper',permissions:{'tasks.tasks':['view'],'tasks.workspace':['view'],'tasks.groups':['view','update']}},VANNA);
  await rejects(s.sync.request(userOf(RITH),{action:'settings',id,delete_mode:'PROPAGATE',confirm_delete:true},{redirectUri}),/can’t delete records in groups/,403);
  const vals=()=>fake.api.values(sid),head=vals()[0];
  fake.api.deleteRow(sid,vals().findIndex(r=>r[head.indexOf('Item')]==='Box'));
  const line=Array(head.length).fill(null);line[head.indexOf('Item')]='Typed in the sheet';fake.api.insertRow(sid,vals().length,line);
  const x=await s.sync.request(userOf(RITH),{action:'sync_now',id},{redirectUri});
  assert.equal(x.summary.deleted_in_group,0);assert.equal(x.summary.new_in_group,0);
  assert.ok(s.get('SELECT 1 AS ok FROM tm_board_rows WHERE id=?',ids[0]),'the row deleted in the sheet is kept in the group');
  assert.ok(!s.get("SELECT 1 AS ok FROM tm_board_rows WHERE board_id=? AND values_json LIKE '%Typed in the sheet%'",g),'the typed row is not added');
  const detail=s.get('SELECT status_detail FROM tm_board_syncs WHERE id=?',id).status_detail;
  assert.match(detail,/not added to the group: Rith · Records’s role can’t add records/);assert.match(detail,/kept in the group: Rith · Records’s role can’t delete records/);
  // From the start, someone whose role can't delete can't turn deletions on for rows coming from the sheet.
  const g2=cmd('tm.group.save',{workspace_id:ws,name:'Stock list 2',visibility:'TEAM',audience:'SELECTED',shared:[{staff_id:RITH,level:'MANAGE'}]},SOPHEA).id;
  const columns=s.sync.describe(g2,RITH,redirectUri).columns.filter(c=>c.syncable).map(c=>({column_id:c.id}));
  await rejects(s.sync.request(userOf(RITH),{action:'setup',group_id:g2,mode:'new',direction:'TWO_WAY',columns,delete_mode:'PROPAGATE',confirm_delete:true},{redirectUri}),/can’t delete records in groups/,403);
 });

 await check('SIMULATED Google Sheets: the size limits of a row and of the whole group apply to the sync too',async()=>{
  const g=cmd('tm.group.save',{workspace_id:ws,name:'Big texts',visibility:'TEAM',audience:'SELECTED',shared:[]},SOPHEA).id;
  const item=colId(g,'Item'),noteCol=cmd('tm.group.column.save',{group_id:g,name:'Note',type:'TEXT'},SOPHEA).id;
  const first=cmd('tm.group.row.add',{group_id:g,values:{[item]:'First'}},SOPHEA).id;
  await connectGoogle(SOPHEA,g);
  const {id,sid}=await syncGroup(SOPHEA,g);
  const vals=()=>fake.api.values(sid),head=vals()[0];
  const line=Array(head.length).fill(null);line[head.indexOf('Item')]='x'.repeat(9000);line[head.indexOf('Note')]='y'.repeat(9500);
  fake.api.insertRow(sid,vals().length,line);
  const at2=vals().findIndex(r=>r[head.indexOf('Item')]==='First');fake.api.edit(sid,[[at2,head.indexOf('Note'),'z'.repeat(9999)]]);
  const before=s.get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',g).n;
  // Smaller limits for this check (the real ones are 100,000 characters a row and 10 million a group).
  const {GROUP_LIMITS}=await import('./group-domain.mjs'),saved={...GROUP_LIMITS};
  Object.assign(GROUP_LIMITS,{rowChars:12000,groupChars:8000});
  try{await s.sync.request(userOf(SOPHEA),{action:'sync_now',id},{redirectUri});}finally{Object.assign(GROUP_LIMITS,saved);}
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',g).n,before,'the oversized sheet row was not added');
  assert.ok(!s.get('SELECT values_json FROM tm_board_rows WHERE id=?',first).values_json.includes('zzzz'),'the change past the group’s limit was not saved');
  assert.match(s.get('SELECT status_detail FROM tm_board_syncs WHERE id=?',id).status_detail,/not added to the group: the row would hold/);
  assert.ok(s.get("SELECT 1 AS ok FROM tm_board_sync_conflicts WHERE sync_id=? AND status='OPEN' AND reason LIKE '%size limit%'",id),'the refused change is shown as a conflict');
  void noteCol;
 });

 console.log(`\n${checks} V5.5 hardening checks passed (task visibility, CRM history, requests, approvals, time entries, logs, calendar reminders, Telegram, Groups layouts, notes, bulk delete, Excel import, SIMULATED Google Sheets). Temporary data only.`);
}finally{
 runtime?.stop();mock?.close();
 if(server)await new Promise(r=>{server.close(()=>r());server.closeAllConnections?.();});
 await fake.close();hub.close();rmSync(folder,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFakeGoogle} from './google-fake.mjs';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import http from 'node:http';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {createTelegramRuntime} from './telegram-bot.mjs';
import {taskToday,addDays,formatMinutes} from './task-domain.mjs';
import {readXlsx,writeXlsx} from './xlsx.mjs';

// V5.5 acceptance checks 1–16 with the fixtures the request names: Director A (Vanna, company-wide task access),
// Manager B (Sophea, reports to A), Employee C (Dara, reports to B) and Employee D (Kosal, in another branch: he reports
// to Chantha, who reports to A). Google Sheets runs against the local stand-in (google-fake.mjs): these are SIMULATED
// Google tests, not a live connection.
const here=path.dirname(fileURLToPath(import.meta.url));
const fake=await createFakeGoogle();Object.assign(process.env,fake.env,{GOOGLE_REQUESTS_PER_MINUTE:'1000'});// the stand-in has no quota; pacing itself is measured separately below
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v55-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;let checks=0,server,gateway,mock,runtime;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,label,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw new Error('Timed out waiting for '+label);await sleep(40);}};
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const rejects=async(p,pattern,status)=>assert.rejects(p,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const task=id=>s.get('SELECT * FROM tm_tasks WHERE id=?',id);
const notes=(staff,kind,taskId)=>s.all('SELECT * FROM tm_notifications WHERE staff_id=? AND kind=?'+(taskId?' AND task_id=?':'')+' ORDER BY id',staff,kind,...(taskId?[taskId]:[]));
const edit=id=>{const t=task(id);return {...t,id,expected_version:t.version,estimate:formatMinutes(t.estimate_minutes),supporter_ids:s.tasks.supportersOf(t)};};
const today=taskToday();
const VANNA='STAFF-003',SOPHEA='STAFF-002',DARA='STAFF-001';let CHANTHA,KOSAL,BOPHA,ws,wsD;
const staffOf=email=>s.get('SELECT staff_id FROM access_users WHERE email=?',email).staff_id;
const userOf=staff=>s.access.publicUser(s.access.accountFor(staff).id);
const visible=(staff,state=s.state())=>new Set(s.access.filterState(state,userOf(staff)).tm_tasks.map(t=>t.id));
try{
 // Demo meetings are relative to the wall clock and can overlap this suite's reminder windows. Keep the suite's
 // calendar fixtures independent of those samples; the production seed and conflict checks are unchanged.
 s.run("UPDATE tm_meetings SET status='CANCELLED' WHERE status='SCHEDULED'");
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 for(const [name,email,role] of [['Chantha · Operations','chantha@example.test','ROLE-MEMBER'],['Kosal · Warehouse','kosal@example.test','ROLE-MEMBER'],['Bopha · Viewer','bopha@example.test','ROLE-VIEWER']])
  cmd('admin.user.save',{name,email,role_id:role,password:'local-password-1',active:1},VANNA);
 [CHANTHA,KOSAL,BOPHA]=['chantha','kosal','bopha'].map(n=>staffOf(`${n}@example.test`));
 ws=cmd('tm.workspace.save',{name:'V5.5 Sales',department:'Sales',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,VANNA,BOPHA]},SOPHEA).id;
 wsD=cmd('tm.workspace.save',{name:'Siem Reap warehouse',department:'Warehouse',owner_id:CHANTHA,member_ids:[CHANTHA,KOSAL,DARA]},VANNA).id;

 // ================================================================ HTTP: the ERP, exports, direct URLs and the Mini App
 const port=4355,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const request=async(url,{cookie='',data,raw=false}={})=>{const r=await fetch(base+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});if(raw)return r;const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:r.status,body,headers:r.headers};};
 const login=async(email,password)=>{const r=await fetch(`${base}/c/default/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,email);return r.headers.get('set-cookie').split(';')[0];};
 const C={vanna:await login('vanna@example.test','vanna-password-1'),sophea:await login('sophea@example.test','sophea-password-1'),dara:await login('dara@example.test','dara-password-12'),kosal:await login('kosal@example.test','local-password-1'),bopha:await login('bopha@example.test','local-password-1'),chantha:await login('chantha@example.test','local-password-1')};
 const api=(who,action,data)=>request('/c/default/api/command',{cookie:C[who],data:{action,data}});
 const ok=async(who,action,data)=>{const r=await api(who,action,data);assert.equal(r.status,200,`${action}: ${JSON.stringify(r.body)}`);return r.body.result;};
 const state=async who=>(await request('/c/default/api/state',{cookie:C[who]})).body;

 const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
 s.telegram.connectSignedIn(SOPHEA,{id:7202,first_name:'Sophea'},7202);s.telegram.connectSignedIn(DARA,{id:7201,first_name:'Dara'},7201);
 gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const gw=`http://127.0.0.1:${gateway.address().port}/c/default/tg/api`;
 const mini=async(uid,first,p,data)=>{const init=signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'V55',user:{id:uid,first_name:first}},TOKEN);const r=await fetch(gw+p,{method:data?'POST':'GET',headers:{Authorization:'tma '+init,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const t=await r.text();let body;try{body=JSON.parse(t);}catch{body=t;}return {status:r.status,body};};

 await check('upgrade: schema 12 with reporting lines, time zones, meeting sharing and reminders, and group layouts',()=>{
  assert.ok(s.get('SELECT version FROM schema_version WHERE version=12'),'schema 12');
  for(const [table,col] of [['tm_profiles','manager_id'],['tm_profiles','timezone'],['tm_meetings','share_scope'],['tm_meetings','reminder_offsets'],['tm_meetings','created_by'],['tm_boards','layout_json'],['company','timezone']])
   assert.ok(s.all(`PRAGMA table_info(${table})`).some(c=>c.name===col),`${table}.${col}`);
  assert.ok(s.all('SELECT share_scope FROM tm_meetings').every(m=>['PARTICIPANTS','WORKSPACE','COMPANY','SELECTED'].includes(m.share_scope)));
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');
 });

 // ================================================================ 2.1 reporting tree and the Task Visibility Scope
 await check('reporting lines: administrators set them; self-management, loops and inactive managers are refused',async()=>{
  assert.equal((await api('dara','tm.profile.manager',{staff_id:SOPHEA,manager_id:VANNA})).status,403,'Administration · User accounts “Update” is needed');
  for(const [staff,manager] of [[SOPHEA,VANNA],[DARA,SOPHEA],[CHANTHA,VANNA],[KOSAL,CHANTHA]])cmd('tm.profile.manager',{staff_id:staff,manager_id:manager},VANNA);
  fails(()=>cmd('tm.profile.manager',{staff_id:DARA,manager_id:DARA},VANNA),/can’t report to themselves/,422);
  fails(()=>cmd('tm.profile.manager',{staff_id:VANNA,manager_id:DARA},VANNA),/already reports to/,422);
  assert.deepEqual(s.tasks.scope.managersOf(DARA),[SOPHEA,VANNA]);
 });

 let A1,B1,C1,C2,D1,DS;
 await check('8. Director A sees the company; Manager B sees C’s work but not A’s private task or D’s branch; supporting never widens the hierarchy',()=>{
  A1=cmd('tm.task.save',{workspace_id:ws,title:'A private: board budget',start_date:today,due_date:addDays(today,9),pic_id:VANNA,reviewer_id:VANNA},VANNA).id;
  B1=cmd('tm.task.save',{workspace_id:ws,title:'B gives C: customs declaration',description:'Old description field',start_date:today,due_date:addDays(today,4),pic_id:DARA,reviewer_id:SOPHEA,steps:['Prepare documents','Review information','Submit final report']},SOPHEA).id;
  C1=cmd('tm.task.save',{workspace_id:ws,title:'C own: call trade fair leads',start_date:today,due_date:addDays(today,2),pic_id:DARA,reviewer_id:DARA},DARA).id;
  D1=cmd('tm.task.save',{workspace_id:wsD,title:'D branch: count packaging',start_date:today,due_date:addDays(today,1),pic_id:KOSAL,reviewer_id:CHANTHA},CHANTHA).id;
  // Dara supports Kosal's task: that never lets Dara's manager see it.
  DS=cmd('tm.task.save',{workspace_id:wsD,title:'D branch with C supporting',start_date:today,due_date:addDays(today,3),pic_id:KOSAL,supporter_ids:[DARA],reviewer_id:CHANTHA},CHANTHA).id;
  C2=cmd('tm.task.save',{workspace_id:ws,title:'C second',start_date:today,due_date:addDays(today,5),pic_id:DARA,reviewer_id:DARA},DARA).id;
  const st=s.state(),v=visible(VANNA,st),b=visible(SOPHEA,st),c=visible(DARA,st),d=visible(KOSAL,st);
  for(const id of [A1,B1,C1,D1,DS,C2])assert.ok(v.has(id),'the director sees every task: '+id);
  assert.ok(b.has(B1)&&b.has(C1)&&b.has(C2),'the manager sees the work led by C');
  assert.ok(!b.has(A1),'not A’s private task');assert.ok(!b.has(D1),'not D’s branch');assert.ok(!b.has(DS),'not a D-branch task C only supports');
  assert.ok(c.has(DS)&&c.has(B1)&&!c.has(A1)&&!c.has(D1),'C sees what C is on');
  assert.ok(d.has(D1)&&d.has(DS)&&!d.has(B1)&&!d.has(A1));
  const reasons=Object.fromEntries(s.access.filterState(st,userOf(SOPHEA)).tm_tasks.map(t=>[t.id,t.access_reason]));
  assert.equal(reasons[B1],'involved');assert.equal(reasons[C1],'team');
  assert.equal(s.access.filterState(st,userOf(VANNA)).tm_tasks.find(t=>t.id===D1).access_reason,'team','D reports to Chantha, who reports to A');
  // Bopha has no manager: A still sees her work through company-wide access; B does not.
  const BO1=cmd('tm.task.save',{workspace_id:ws,title:'Bopha own',start_date:today,due_date:addDays(today,2),pic_id:BOPHA,reviewer_id:BOPHA},BOPHA).id;
  assert.equal(s.access.filterState(s.state(),userOf(VANNA)).tm_tasks.find(t=>t.id===BO1).access_reason,'company');assert.ok(!visible(SOPHEA).has(BO1));
  // Moving C elsewhere in the tree changes what B sees at once.
  cmd('tm.profile.manager',{staff_id:DARA,manager_id:CHANTHA},VANNA);assert.ok(!visible(SOPHEA).has(C1));
  cmd('tm.profile.manager',{staff_id:DARA,manager_id:SOPHEA},VANNA);assert.ok(visible(SOPHEA).has(C1));
 });

 await check('hierarchy grants viewing only: B cannot change, approve, close or comment on C’s own task, and invisible tasks are “not found”',()=>{
  fails(()=>cmd('tm.task.progress',{id:C1,progress:50},SOPHEA),/./,403);
  fails(()=>cmd('tm.task.close',{id:C1},SOPHEA),/./,403);
  fails(()=>cmd('tm.task.note',{id:C1,note:'Manager comment'},SOPHEA),/./,403);
  fails(()=>cmd('tm.task.save',{...edit(C1),title:'Changed by B'},SOPHEA),/./,403);
  for(const [action,data] of [['tm.task.progress',{id:A1,progress:10}],['tm.task.note',{id:D1,note:'x'}],['tm.task.close',{id:A1}],['tm.check.add',{task_id:A1,title:'x'}],['tm.due.request',{task_id:D1,proposed_due_date:addDays(today,9),reason:'x'}]])
   fails(()=>cmd(action,data,SOPHEA),/not found/i,404);
  assert.equal(task(C1).title,'C own: call trade fair leads');
 });

 await check('9. the ERP, the calendar data, the Company view of the Mini App, reports, exports and direct task URLs apply the same scope',async()=>{
  const erp=await state('sophea'),ids=new Set(erp.tm_tasks.map(t=>t.id));
  assert.deepEqual([...ids].sort(),[...visible(SOPHEA)].sort());
  assert.deepEqual(erp.task_scope.team,[DARA]);assert.equal(erp.task_scope.company,false);
  const m=(await mini(7202,'Sophea','/state')).body;
  assert.deepEqual(m.tm_tasks.map(t=>t.id).sort(),[...ids].sort(),'the Mini App gets exactly the ERP’s tasks');assert.deepEqual(m.task_scope.team,[DARA]);
  assert.ok(!m.tm_checklist.some(x=>x.task_id===A1)&&!m.tm_change_requests.some(x=>x.task_id===A1));
  // Employee filter choices come only from visible tasks: Kosal (D) never appears on any of them.
  const people=new Set(erp.tm_tasks.flatMap(t=>[t.pic_id,t.reviewer_id,t.created_by]).concat(erp.tm_assignees.map(a=>a.staff_id)));assert.ok(!people.has(KOSAL));
  // Monthly report (ERP and Mini App) and the CSV export.
  const month=today.slice(0,7);
  const rep=(await request(`/c/default/api/tasks/report?report=monthly&month=${month}`,{cookie:C.sophea})).body;
  const titles=JSON.stringify(rep);assert.ok(!titles.includes('A private')&&!titles.includes('D branch'),'monthly report');
  const mrep=(await mini(7202,'Sophea',`/report?report=monthly&month=${month}&scope=all`)).body;assert.ok(!JSON.stringify(mrep).includes('A private')&&!JSON.stringify(mrep).includes('D branch'),'Mini App company report');
  const csv=await request('/c/default/api/tasks/report.csv?report=tasks',{cookie:C.sophea});assert.equal(csv.status,200);
  assert.ok(String(csv.body).includes('C own: call trade fair leads')&&!String(csv.body).includes('A private')&&!String(csv.body).includes('D branch'),'export');
  const dash=await request('/c/default/api/erp/dashboard?filters=%7B%7D',{cookie:C.sophea});assert.ok(!JSON.stringify(dash.body).includes('A private'),'dashboard');
  // Direct addresses and guessed IDs: the same answer as a task that does not exist.
  const direct=await api('sophea','tm.task.progress',{id:A1,progress:5});assert.equal(direct.status,404);
  const ghost=await api('sophea','tm.task.progress',{id:'TASK-999999',progress:5});assert.equal(ghost.status,404);assert.equal(direct.body.error,ghost.body.error,'no difference between hidden and missing');
  assert.equal((await mini(7202,'Sophea','/command',{action:'tm.task.note',data:{id:A1,note:'x'}})).status,404,'Mini App direct command');
  const file=cmd('tm.file.add',{task_id:A1,name:'budget.png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='},VANNA).id;
  assert.equal((await request(`/c/default/api/tasks/file?id=${file}`,{cookie:C.sophea})).status,404,'task file download');
  // The director sees the company in both places.
  const dv=(await mini(7202,'Sophea','/state')).body;assert.ok(dv.tm_tasks.every(t=>t.id!==D1));
  assert.ok((await state('vanna')).tm_tasks.some(t=>t.id===D1&&t.access_reason==='team'));
 });

 // ================================================================ 2.2 visibility is not notification
 await check('10. managers get no task notifications because of hierarchy visibility; queued messages are rechecked when sent',async()=>{
  const before=s.get('SELECT COUNT(*) n FROM tm_notifications WHERE staff_id IN (?,?)',SOPHEA,VANNA).n;
  cmd('tm.task.progress',{id:C1,progress:40,note:'Halfway'},DARA);cmd('tm.task.note',{id:C1,note:'Called two of three'},DARA);cmd('tm.task.stuck',{id:C1,note:'Waiting for a reply'},DARA);cmd('tm.task.resume',{id:C1},DARA);cmd('tm.task.close',{id:C1},DARA);
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_notifications WHERE staff_id IN (?,?)',SOPHEA,VANNA).n,before,'nothing for B or A about C’s own task');
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_notifications WHERE task_id=? AND staff_id NOT IN (?)',C1,DARA).n,0);
  // Telegram: the bot sends each message once, and checks again just before sending that the person may still get it.
  const sent=[];
  mock=http.createServer(async(req,res)=>{
   const chunks=[];for await(const c of req)chunks.push(c);
   const params=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{},m=/^\/bot([^/]+)\/(\w+)$/.exec(req.url);
   const reply=r=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:r}));};
   if(!m||m[1]!==TOKEN){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"ok":false,"error_code":401}');}
   if(m[2]==='getMe')return reply({id:999,is_bot:true,first_name:'Sunny Tasks',username:'sunny_tasks_bot'});
   if(m[2]==='getUpdates'){await new Promise(r=>setTimeout(r,150));return reply([]);}
   if(m[2]==='sendMessage'){sent.push(params);return reply({message_id:sent.length,chat:{id:params.chat_id,type:'private'},date:Math.floor(Date.now()/1000),text:params.text});}
   return reply(true);
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  runtime=createTelegramRuntime({companies:{list:()=>[{id:'default'}],get:()=>s},apiBase:`http://127.0.0.1:${mock.address().port}`,supervisorMs:100,outboxMs:100,pollTimeout:1,logger:{error:()=>{}}}).start();
  await waitFor(()=>s.telegram.settings().status==='ONLINE','bot online');await sleep(400);
  const x=cmd('tm.task.save',{workspace_id:ws,title:'Recheck at delivery',start_date:today,due_date:addDays(today,3),pic_id:DARA,reviewer_id:SOPHEA},SOPHEA).id;
  const n=s.get('SELECT * FROM tm_notifications WHERE staff_id=? AND task_id=? ORDER BY id DESC',DARA,x);
  const d=await waitFor(()=>s.get("SELECT * FROM tm_notification_deliveries WHERE notification_id=? AND channel='TELEGRAM' AND status='SENT'",n.id),'sent');
  assert.equal(d.attempts,1);await sleep(500);assert.equal(sent.filter(m=>m.chat_id===7201&&m.text.includes('Recheck at delivery')).length,1,'sent once, never again');
  // A message about a task Dara is no longer on (queued, then she was removed) is skipped with the reason, not sent.
  const queued=s.insert('tm_notifications',{staff_id:DARA,kind:'task_comment',task_id:A1,request_id:null,due_request_id:null,title:'About a task Dara is not on',body:'x',actor_id:VANNA,created_at:new Date().toISOString()});
  const nid=s.get('SELECT MAX(id) AS id FROM tm_notifications').id;void queued;
  const skipped=await waitFor(()=>s.get("SELECT * FROM tm_notification_deliveries WHERE notification_id=? AND status='SKIPPED'",nid),'skipped');
  assert.match(skipped.reason,/No longer on this task/);assert.ok(!sent.some(m=>m.text.includes('About a task Dara is not on')));
  assert.ok(!sent.some(m=>m.chat_id===7202&&/C own/.test(m.text)),'nothing reached the manager about C’s own task');
  runtime.stop();runtime=null;
 });

 // ================================================================ 2.3 Expectation, Steps of Work, two-party progress
 await check('12. Expectation keeps the Description data and API (description and expectation both work); My Tasks keeps direct involvement',async()=>{
  assert.equal(task(B1).description,'Old description field');
  const e=cmd('tm.task.save',{workspace_id:ws,title:'Uses the new name',expectation:'Signed contract in the shared folder.',start_date:today,due_date:addDays(today,2),pic_id:DARA,reviewer_id:SOPHEA},SOPHEA).id;
  assert.equal(task(e).description,'Signed contract in the shared folder.');
  cmd('tm.task.accept',{id:e},DARA);
  const r=cmd('tm.task.save',{...edit(e),description:'Signed contract and invoice.'},SOPHEA);assert.ok(r.change_id,'a change to an accepted task waits for approval');
  const cr=s.get('SELECT * FROM tm_change_requests WHERE id=?',r.change_id);assert.ok(JSON.parse(cr.changes_json).some(x=>x.field==='description'&&x.label==='Expectation'),'shown as “Expectation”');
  // My Tasks (Mini App) and the ERP's personal views use direct involvement: B's team tasks are marked “team”.
  const st=await state('sophea');const mine=st.tm_tasks.filter(t=>t.access_reason==='involved').map(t=>t.id);
  assert.ok(mine.includes(B1)&&!mine.includes(C1)&&!mine.includes(C2));
 });

 await check('11. completing a Step of Work notifies the assigner once per transition, needs no approval and never closes the task',()=>{
  cmd('tm.task.accept',{id:B1},DARA);
  const steps=s.all('SELECT * FROM tm_checklist WHERE task_id=? ORDER BY position',B1);assert.deepEqual(steps.map(x=>x.title),['Prepare documents','Review information','Submit final report']);
  const progress=task(B1).progress,status=task(B1).status;
  cmd('tm.check.toggle',{id:steps[0].id,done:true},DARA);
  let n=notes(SOPHEA,'step_completed',B1);assert.equal(n.length,1);assert.match(n[0].body,/Dara · Sales completed “Prepare documents” · 1 of 3 steps completed/);assert.match(n[0].title,/B gives C: customs declaration/);
  const again=cmd('tm.check.toggle',{id:steps[0].id,done:true},DARA);assert.ok(again.unchanged,'a retry changes nothing');
  assert.equal(notes(SOPHEA,'step_completed',B1).length,1,'one notification per completion');
  const row=s.get('SELECT * FROM tm_checklist WHERE id=?',steps[0].id);assert.equal(row.done_by,DARA);assert.ok(row.done_at);
  assert.equal(task(B1).progress,progress,'progress unchanged');assert.equal(task(B1).status,status,'not closed');
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_change_requests WHERE task_id=? AND status='PENDING'",B1).n,0,'no approval asked');
  cmd('tm.check.toggle',{id:steps[1].id,done:true},DARA);cmd('tm.check.toggle',{id:steps[2].id,done:true},DARA);
  assert.equal(task(B1).status,status,'all steps done still leaves the task open');
  // Reopening is recorded; completing again is a new transition with a new message.
  cmd('tm.check.toggle',{id:steps[0].id,done:false},DARA);cmd('tm.check.toggle',{id:steps[0].id,done:true},DARA);
  assert.equal(notes(SOPHEA,'step_completed',B1).length,4);
  assert.ok(s.all("SELECT * FROM tm_task_history WHERE task_id=? AND kind='checklist'",B1).some(h=>/Reopened step/.test(h.note||h.detail||'')));
  // Reordering keeps one ordered list.
  cmd('tm.check.move',{id:steps[2].id,direction:'up'},DARA);assert.deepEqual(s.all('SELECT title FROM tm_checklist WHERE task_id=? ORDER BY position',B1).map(x=>x.title),['Prepare documents','Submit final report','Review information']);
  // The assigner completing a step does not message themselves.
  const k=notes(SOPHEA,'step_completed',B1).length;cmd('tm.check.add',{task_id:B1,title:'Archive copies'},SOPHEA);
  cmd('tm.check.toggle',{id:s.get("SELECT id FROM tm_checklist WHERE task_id=? AND title='Archive copies'",B1).id,done:true},SOPHEA);assert.equal(notes(SOPHEA,'step_completed',B1).length,k);
 });

 await check('progress needs the other side: C’s 0% → 10% waits for B; approving applies it with who/when/before/after; rejecting keeps it; self-assigned applies at once',async()=>{
  const p0=task(B1).progress;
  const r=cmd('tm.task.progress',{id:B1,progress:10,note:'Documents collected.'},DARA);assert.ok(r.change_id);assert.match(r.message,/Sent to Sophea .*Progress stays/);
  assert.equal(task(B1).progress,p0,'not applied yet');
  const cr=s.get('SELECT * FROM tm_change_requests WHERE id=?',r.change_id);assert.equal(cr.approver_id,SOPHEA);assert.equal(cr.requested_by,DARA);
  assert.deepEqual(JSON.parse(cr.changes_json).map(x=>[x.field,x.from_text,x.to_text]),[['progress',`${p0}%`,'10%']]);
  cmd('tm.change.decide',{id:cr.id,decision:'APPROVE',expected_version:cr.version},SOPHEA);
  assert.equal(task(B1).progress,10);const done=s.get('SELECT * FROM tm_change_requests WHERE id=?',cr.id);assert.equal(done.status,'APPROVED');assert.equal(done.decided_by,SOPHEA);assert.ok(done.decided_at&&done.created_at);
  // Rejected in the Mini App: nothing changes.
  const r2=(await mini(7201,'Dara','/command',{action:'tm.task.progress',data:{id:B1,progress:60}})).body.result;assert.ok(r2.change_id);
  const cr2=s.get('SELECT * FROM tm_change_requests WHERE id=?',r2.change_id);
  assert.equal((await mini(7202,'Sophea','/command',{action:'tm.change.decide',data:{id:cr2.id,decision:'REJECT',note:'Not yet',expected_version:cr2.version}})).status,200);
  assert.equal(task(B1).progress,10);assert.equal(s.get('SELECT status FROM tm_change_requests WHERE id=?',cr2.id).status,'REJECTED');
  // The assigner's own progress change waits for the person in charge too.
  const r3=cmd('tm.task.progress',{id:B1,progress:30},SOPHEA);assert.ok(r3.change_id,'either side asks the other');assert.equal(s.get('SELECT approver_id FROM tm_change_requests WHERE id=?',r3.change_id).approver_id,DARA);
  cmd('tm.change.withdraw',{id:r3.change_id},SOPHEA);
  cmd('tm.task.progress',{id:C2,progress:25},DARA);assert.equal(task(C2).progress,25,'self-assigned: applied at once');
 });

 // ================================================================ 3 Calendar
 let M1,M2,M3,M4,NOTE;
 await check('13. the calendar combines meetings and tasks people may see; personal notes stay with their owner',async()=>{
  const at=(h)=>new Date(Date.now()+h*3600e3).toISOString();
  M1=cmd('tm.meeting.save',{workspace_id:ws,title:'B and C check-in',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(30),end_at:at(31),share_scope:'PARTICIPANTS'},SOPHEA).id;
  M2=cmd('tm.meeting.save',{workspace_id:ws,title:'Sales workspace review',organizer_id:SOPHEA,attendee_ids:[],start_at:at(40),end_at:at(41),share_scope:'WORKSPACE'},SOPHEA).id;
  M3=cmd('tm.meeting.save',{workspace_id:wsD,title:'Warehouse only',organizer_id:CHANTHA,attendee_ids:[KOSAL],start_at:at(50),end_at:at(51),share_scope:'SELECTED',share_ids:[BOPHA]},CHANTHA).id;
  M4=cmd('tm.meeting.save',{workspace_id:ws,title:'Company all-hands',organizer_id:VANNA,attendee_ids:[],start_at:at(60),end_at:at(61),share_scope:'COMPANY'},VANNA).id;
  NOTE=cmd('tm.calnote.save',{title:'Dara’s dentist',all_day:true,day:addDays(today,2),body:'Private'},DARA).id;
  const sees=async who=>{const st=await state(who);return {m:new Set(st.tm_meetings.map(m=>m.id)),n:st.tm_calendar_notes.map(n=>n.id),t:new Set(st.tm_tasks.map(t=>t.id))};};
  const v=await sees('vanna'),b=await sees('sophea'),c=await sees('dara'),d=await sees('kosal'),bo=await sees('bopha');
  assert.ok(b.m.has(M1)&&c.m.has(M1)&&!v.m.has(M1)&&!d.m.has(M1),'participants only (the director included: company task access is not meeting access)');
  assert.ok(b.m.has(M2)&&c.m.has(M2)&&v.m.has(M2)&&!d.m.has(M2),'workspace members');
  assert.ok(d.m.has(M3)&&bo.m.has(M3)&&!b.m.has(M3)&&!c.m.has(M3),'participants and the selected people');
  for(const x of [v,b,c,d])assert.ok(x.m.has(M4),'company-wide');
  assert.deepEqual(c.n,[NOTE]);assert.deepEqual(b.n,[]);assert.deepEqual(v.n,[],'not even the director sees someone’s notes');
  assert.ok(b.t.has(C2)&&!b.t.has(A1),'task deadlines follow the task scope');
  fails(()=>cmd('tm.calnote.save',{id:NOTE,expected_version:0,title:'x',all_day:true,day:today},VANNA),/not found/i,404);
  fails(()=>cmd('tm.calnote.delete',{id:NOTE,expected_version:0},SOPHEA),/not found/i,404);
  // Someone the meeting is shared with sees it but can't change it, and can ask for its reminders.
  fails(()=>cmd('tm.meeting.save',{...s.get('SELECT * FROM tm_meetings WHERE id=?',M3),expected_version:0,title:'Changed',attendee_ids:[KOSAL],share_ids:[BOPHA]},BOPHA),/shared with you to view/,403);
  assert.match(cmd('tm.meeting.follow',{id:M3,follow:true},BOPHA).message,/will get this meeting’s reminders/);
  fails(()=>cmd('tm.meeting.follow',{id:M1,follow:true},KOSAL),/not found/i,404);
 });

 await check('14. meeting reminders: offsets in days, hours and minutes, each person’s time zone, rescheduling, cancelling, losing access, and no duplicates',()=>{
  const t0=Date.now(),start=new Date(t0+3*3600e3).toISOString(),end=new Date(t0+4*3600e3).toISOString();
  cmd('me.profile.save',{timezone:'Europe/London'},DARA);
  const id=cmd('tm.meeting.save',{workspace_id:ws,title:'Reminder check',organizer_id:SOPHEA,attendee_ids:[DARA,BOPHA],start_at:start,end_at:end,reminder_offsets:[120,60,0]},SOPHEA).id;
  fails(()=>cmd('tm.meeting.save',{workspace_id:ws,title:'Too late',organizer_id:SOPHEA,attendee_ids:[],start_at:new Date(t0+3600e3).toISOString(),end_at:new Date(t0+7200e3).toISOString(),reminder_offsets:[1440]},SOPHEA),/would already be in the past/,422);
  fails(()=>cmd('tm.meeting.save',{workspace_id:ws,title:'Bad',organizer_id:VANNA,attendee_ids:[],start_at:new Date(t0+10*3600e3).toISOString(),end_at:new Date(t0+11*3600e3).toISOString(),reminder_offsets:[1,2,3,4,5,6]},VANNA),/up to five|5/i);
  const sent=staff=>s.all("SELECT * FROM tm_notifications WHERE meeting_id=? AND kind='meeting_reminder' AND staff_id=? ORDER BY id",id,staff);
  assert.equal(s.eventReminders(new Date(t0+30*60e3)),0,'nothing due yet');
  s.eventReminders(new Date(t0+61*60e3));assert.equal(sent(DARA).length,1);assert.equal(sent(SOPHEA).length,1);
  assert.equal(s.eventReminders(new Date(t0+61*60e3)),0,'a repeated run (or a restart) sends nothing twice');
  assert.match(sent(DARA)[0].body,/London time/,'in Dara’s time zone');assert.match(sent(SOPHEA)[0].body,/Phnom Penh time/);
  // Rescheduled: reminders are worked out again for the new time.
  const m=s.get('SELECT * FROM tm_meetings WHERE id=?',id),later=new Date(t0+6*3600e3).toISOString();
  cmd('tm.meeting.save',{...m,expected_version:m.version,attendee_ids:[DARA,BOPHA],start_at:later,end_at:new Date(t0+7*3600e3).toISOString()},SOPHEA);
  assert.equal(s.eventReminders(new Date(t0+121*60e3)),0,'the old times no longer fire');
  s.eventReminders(new Date(t0+(4*60+1)*60e3));assert.equal(sent(DARA).length,2,'the 2-hour reminder for the new time');
  // Bopha loses access (removed): no more reminders for her.
  const m2=s.get('SELECT * FROM tm_meetings WHERE id=?',id);
  cmd('tm.meeting.save',{...m2,expected_version:m2.version,attendee_ids:[DARA],start_at:m2.start_at,end_at:m2.end_at},SOPHEA);
  const bopha=sent(BOPHA).length;s.eventReminders(new Date(t0+(5*60+1)*60e3));assert.equal(sent(BOPHA).length,bopha);assert.equal(sent(DARA).length,3);
  // Cancelled: nothing more.
  const m3=s.get('SELECT * FROM tm_meetings WHERE id=?',id);
  cmd('tm.meeting.save',{...m3,expected_version:m3.version,attendee_ids:[DARA],status:'CANCELLED',reason:'Customer cancelled'},SOPHEA);
  assert.equal(s.eventReminders(new Date(t0+(6*60)*60e3)),0);
  // Personal note reminders reach only their owner; all-day notes count back from 09:00 in the owner's zone.
  const n=cmd('tm.calnote.save',{title:'Call the bank',all_day:false,start_at:new Date(t0+2*3600e3).toISOString(),reminder_offsets:[60]},DARA).id;
  s.eventReminders(new Date(t0+61*60e3));assert.equal(s.get("SELECT COUNT(*) n FROM tm_notifications WHERE note_id=?",n).n,1);assert.equal(s.get("SELECT staff_id FROM tm_notifications WHERE note_id=?",n).staff_id,DARA);
  cmd('me.profile.save',{timezone:''},DARA);
 });

 // ================================================================ 1 Groups
 const G=cmd('tm.group.save',{workspace_id:ws,name:'Purchases V5.5',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'VIEW',shared:[{staff_id:DARA,level:'EDIT'}]},SOPHEA).id;
 const cols=()=>s.tasks.groups.read(G,SOPHEA).columns,col=name=>cols().find(c=>c.name===name);
 cmd('tm.group.column.save',{group_id:G,name:'Quantity',type:'NUMBER'},SOPHEA);cmd('tm.group.column.save',{group_id:G,name:'Unit Price',type:'NUMBER',settings:{decimals:2}},SOPHEA);
 cmd('tm.group.column.save',{group_id:G,name:'Subtotal',type:'FORMULA',settings:{expression:'={Quantity} * {Unit Price}'}},SOPHEA);
 cmd('tm.group.column.save',{group_id:G,name:'Double',type:'FORMULA',settings:{expression:'={Quantity} * 2'}},SOPHEA);
 cmd('tm.group.column.save',{group_id:G,name:'Due',type:'DATE'},SOPHEA);cmd('tm.group.column.save',{group_id:G,name:'Code',type:'TEXT'},SOPHEA);
 const ITEM=col('Item').id,QTY=col('Quantity').id,PRICE=col('Unit Price').id,SUB=col('Subtotal').id,DBL=col('Double').id,DUE=col('Due').id,CODE=col('Code').id;
 const rowIds=[];for(let i=1;i<=30;i++)rowIds.push(cmd('tm.group.row.add',{group_id:G,values:{[ITEM]:`Item ${i}`,[QTY]:i,[PRICE]:i*1.5,[DUE]:addDays(today,i),[CODE]:i===1?'=SUM(A1:A9)':`00${i}`}},DARA).id);

 await check('2. restricted rows and columns stay protected in direct calls, search, filters, sorting, totals, formulas, cards, notes and exports',async()=>{
  cmd('tm.group.column.access',{group_id:G,id:PRICE,principals:[{type:'ROLE',id:'ROLE-MANAGER'}]},SOPHEA);
  cmd('tm.group.row.access',{group_id:G,ids:[rowIds[4]],principals:[{type:'USER',id:SOPHEA}]},SOPHEA);
  fails(()=>cmd('tm.group.row.access',{group_id:G,ids:[rowIds[0]],principals:[]},DARA),/manage this group/,403);
  const g=(await request(`/c/default/api/tasks/group?id=${G}&limit=200`,{cookie:C.dara})).body;
  assert.deepEqual(g.columns.map(c=>c.name),['Item','Quantity','Double','Due','Code'],'the hidden column and the formula that uses it are not sent');
  assert.equal(g.page.total,29);assert.ok(!g.page.rows.some(r=>r.id===rowIds[4]));
  // (7.5 is the hidden Unit Price of the visible Item 5; matched as a JSON value, since times like 07:39:17.512 contain "7.5".)
  const raw=JSON.stringify(g);assert.ok(!raw.includes('"'+PRICE+'"')&&!raw.includes('"'+SUB+'"')&&!/[:[,]7\.5[,\]}]/.test(raw),'no hidden value or id anywhere in the answer');
  assert.ok(!('access' in g.page.rows[0]),'access rules are shown to the people who manage the group only');
  const q=async(p)=>(await request(`/c/default/api/tasks/group/rows?id=${G}&${new URLSearchParams(p)}`,{cookie:C.dara})).body;
  assert.equal((await q({q:'45'})).total,0,'searching a hidden value (Unit Price 45) finds nothing');
  assert.equal((await q({filters:JSON.stringify([{col:PRICE,min:'0'}])})).total,29,'a filter on a hidden column is ignored');
  const sorted=await q({sort:PRICE,dir:'desc',limit:3});assert.deepEqual(sorted.rows.map(r=>r.values[ITEM]),['Item 1','Item 2','Item 3'],'sorting by a hidden column is ignored');
  assert.ok(!(PRICE in sorted.totals)&&!(SUB in sorted.totals),'totals only for visible columns');
  assert.equal((await q({q:'Item 5'})).rows.filter(r=>r.values[ITEM]==='Item 5').length,0,'a hidden row is never found');
  const mgr=(await request(`/c/default/api/tasks/group?id=${G}`,{cookie:C.sophea})).body;assert.ok(mgr.columns.some(c=>c.id===PRICE&&c.access?.length===1));assert.equal(mgr.page.all,30);
  // Direct calls.
  assert.equal((await api('dara','tm.group.row.update',{group_id:G,id:rowIds[0],values:{[PRICE]:99},expected:{[PRICE]:1.5}})).body.details?.code,'column_missing');
  assert.equal((await api('dara','tm.group.row.update',{group_id:G,id:rowIds[4],values:{[QTY]:1},expected:{[QTY]:5}})).status,404);
  assert.equal((await api('dara','tm.group.note.add',{group_id:G,row_id:rowIds[4],body:'x'})).status,404);
  assert.equal((await request(`/c/default/api/tasks/group/notes?id=${G}&row=${rowIds[4]}`,{cookie:C.dara})).status,404);
  assert.equal((await api('dara','tm.group.row.delete',{group_id:G,ids:[rowIds[4]],expected:{}})).status,404,'a hidden row answers like a deleted one');
  // Excel export: only what Dara may see.
  const x=await request(`/c/default/api/tasks/group.xlsx?id=${G}&scope=all`,{cookie:C.dara,raw:true});assert.equal(x.status,200);
  const book=readXlsx(Buffer.from(await x.arrayBuffer())),sheet=book[0],head=sheet.rows[0].map(c=>c?.v);
  assert.deepEqual(head,['Item','Quantity','Double','Due','Code']);assert.equal(sheet.rows.length,30,'29 rows + header');
  assert.ok(!JSON.stringify(book).includes('Item 5"'),'no hidden row');
  const sel=await request(`/c/default/api/tasks/group.xlsx?id=${G}&scope=selected&ids=${rowIds[0]},${rowIds[4]}`,{cookie:C.dara});assert.equal(sel.status,409,'selecting a hidden row is refused');
  // Formula leakage: Subtotal would reveal the price; Double does not use it.
  assert.equal(g.page.rows[0].computed[DBL],2);assert.ok(!(SUB in g.page.rows[0].computed));
 });

 await check('5. the Excel export is a real workbook: numbers, dates and text keep their types; text starting with “=” stays text; formulas are values',async()=>{
  const x=await request(`/c/default/api/tasks/group.xlsx?id=${G}&scope=filtered&q=Item%201`,{cookie:C.sophea,raw:true});
  assert.match(x.headers.get('content-type'),/spreadsheetml/);assert.match(x.headers.get('content-disposition'),/Purchases%20V5\.5\.xlsx/);
  const buf=Buffer.from(await x.arrayBuffer());assert.equal(buf.subarray(0,2).toString(),'PK');
  const [sheet]=readXlsx(buf),head=sheet.rows[0].map(c=>c?.v),r1=sheet.rows.find(r=>r[0]?.v==='Item 1');
  assert.deepEqual(head,['Item','Quantity','Unit Price','Subtotal','Double','Due','Code']);
  assert.equal(r1[1].v,1);assert.equal(typeof r1[2].v,'number');assert.equal(r1[3].v,1.5,'formula result as a value');assert.ok(!r1[3].formula);
  assert.equal(r1[5].date,addDays(today,1),'a real date');assert.equal(r1[6].v,'=SUM(A1:A9)');assert.ok(!r1[6].formula,'“=…” text is not a formula');
  const r10=sheet.rows.find(r=>r[0]?.v==='Item 10');assert.equal(r10[6].v,'0010','leading zeros kept as text');
  assert.equal(sheet.rows.length,1+11,'Item 1, Item 10–19 and the header: the whole result, not one page');
 });

 await check('1. row notes keep author, time and history; date filters follow each reader’s time zone; order and paging work',async()=>{
  const r=rowIds[0];
  const n1=cmd('tm.group.note.add',{group_id:G,row_id:r,body:'ទំនិញមកដល់ហើយ — goods arrived.\nTwo cartons damaged.'},DARA).id;
  const n2=cmd('tm.group.note.add',{group_id:G,row_id:r,body:'Supplier will replace them.'},SOPHEA).id;
  fails(()=>cmd('tm.group.note.add',{group_id:G,row_id:r,body:'View only'},BOPHA),/Can edit records/,403);
  fails(()=>cmd('tm.group.note.edit',{group_id:G,id:n2,expected_version:0,body:'Not mine'},DARA),/Only the person who wrote/,403);
  cmd('tm.group.note.edit',{group_id:G,id:n1,expected_version:0,body:'Goods arrived; two cartons damaged.'},DARA);
  cmd('tm.group.note.delete',{group_id:G,id:n2,expected_version:0},SOPHEA);
  let list=s.tasks.groups.notes(G,DARA,{row:r});assert.equal(list.total,2,'the deletion stays in the list as a record');
  const deleted=list.notes.find(n=>n.id===n2);assert.equal(deleted.body,'');assert.ok(deleted.deleted_at);
  const h=s.tasks.groups.noteHistory(G,DARA,n1).history;assert.equal(h.length,1);assert.match(h[0].body,/ទំនិញមកដល់ហើយ/);assert.equal(h[0].action,'EDIT');
  fails(()=>s.tasks.groups.noteHistory(G,DARA,n2),/not found/i,404);
  // A note written at 17:30 UTC on 5 October is 6 October in Phnom Penh and 5 October in London.
  s.run("UPDATE tm_board_notes SET created_at='2026-10-05T17:30:00.000Z' WHERE id=?",n1);
  cmd('me.profile.save',{timezone:'Asia/Phnom_Penh'},DARA);cmd('me.profile.save',{timezone:'Europe/London'},SOPHEA);
  const inDay=(staff,day)=>s.tasks.groups.notes(G,staff,{row:r,from:day,to:day}).notes.map(n=>n.id);
  assert.ok(inDay(DARA,'2026-10-06').includes(n1)&&!inDay(DARA,'2026-10-05').includes(n1),'Phnom Penh');
  assert.ok(inDay(SOPHEA,'2026-10-05').includes(n1)&&!inDay(SOPHEA,'2026-10-06').includes(n1),'London');
  cmd('me.profile.save',{timezone:''},SOPHEA);
  fails(()=>s.tasks.groups.notes(G,DARA,{row:r,from:'2026-10-07',to:'2026-10-01'}),/on or after/,400);
  for(let i=0;i<25;i++)cmd('tm.group.note.add',{group_id:G,row_id:rowIds[1],body:`Update ${i+1}`},DARA);
  const p1=s.tasks.groups.notes(G,DARA,{row:rowIds[1],limit:10}),p3=s.tasks.groups.notes(G,DARA,{row:rowIds[1],limit:10,offset:20}),old=s.tasks.groups.notes(G,DARA,{row:rowIds[1],order:'oldest',limit:1});
  assert.equal(p1.total,25);assert.equal(p1.notes[0].body,'Update 25');assert.equal(p3.notes.length,5);assert.equal(old.notes[0].body,'Update 1');
  const counts=s.tasks.groups.query(G,DARA,{limit:3});assert.equal(counts.rows.find(x=>x.id===rowIds[1]).notes,25,'note count on the row');
 });

 await check('3. column widths and order persist per person and as a shared default, keeping values, formulas and the Google Sheets mapping',async()=>{
  const canon=o=>JSON.stringify(Object.entries(o).sort()),before=s.tasks.groups.query(G,DARA,{limit:5}).rows.map(r=>canon(r.values)+canon(r.computed));
  await ok('dara','tm.group.view.save',{group_id:G,view:{widths:{[ITEM]:320,[QTY]:20},order:[CODE,ITEM,QTY],hidden_columns:[DUE]}});
  let g=s.tasks.groups.read(G,DARA);assert.deepEqual(g.view.widths,{[ITEM]:320,[QTY]:60},'widths are kept within 60–800 px');assert.deepEqual(g.view.order,[CODE,ITEM,QTY]);assert.deepEqual(g.view.hidden_columns,[DUE]);
  assert.deepEqual(s.tasks.groups.read(G,SOPHEA).view,{},'personal: nobody else’s view changes');
  assert.equal((await api('dara','tm.group.layout.save',{group_id:G,layout:{order:[CODE]}})).status,403,'only people who manage the group save the default');
  await ok('sophea','tm.group.layout.save',{group_id:G,layout:{widths:{[CODE]:180},order:[CODE,ITEM,QTY,PRICE,SUB,DBL,DUE]}});
  g=s.tasks.groups.read(G,BOPHA);assert.deepEqual(g.columns.map(c=>c.name).slice(0,3),['Code','Item','Quantity']);assert.equal(g.layout.widths[CODE],180);
  assert.deepEqual(s.tasks.groups.query(G,DARA,{limit:5}).rows.map(r=>canon(r.values)+canon(r.computed)),before,'values and formula results unchanged');
  assert.match(s.tasks.groups.read(G,SOPHEA).columns.find(c=>c.id===SUB).settings.display,/Quantity.*\*.*Unit Price/,'formulas keep their columns');
  await ok('dara','tm.group.view.save',{group_id:G,reset:true});assert.deepEqual(s.tasks.groups.read(G,DARA).view,{});
 });

 await check('4. single and bulk deletion: permissions, the exact selection, “select all matching” with the expected count, and all-or-nothing',async()=>{
  assert.equal((await api('bopha','tm.group.row.delete',{group_id:G,id:rowIds[29],expected_version:0})).status,403,'view-only access can’t delete');
  const v=id=>s.get('SELECT version FROM tm_board_rows WHERE id=?',id).version;
  // One of the selected rows changed since it was selected: nothing is deleted.
  const pick=[rowIds[20],rowIds[21],rowIds[22]],expected=Object.fromEntries(pick.map(id=>[id,v(id)]));
  cmd('tm.group.row.update',{group_id:G,id:rowIds[21],values:{[QTY]:999},expected:{[QTY]:22}},SOPHEA);
  const r=await api('dara','tm.group.row.delete',{group_id:G,ids:pick,expected});assert.equal(r.status,409);assert.match(r.body.error,/Nothing was deleted/);assert.deepEqual(r.body.details.changed,[rowIds[21]]);
  for(const id of pick)assert.ok(s.get('SELECT id FROM tm_board_rows WHERE id=?',id),'still there');
  // The same selection with current versions is deleted, with its notes.
  cmd('tm.group.note.add',{group_id:G,row_id:rowIds[20],body:'Goes with the row'},DARA);
  const ok2=await ok('dara','tm.group.row.delete',{group_id:G,ids:pick,expected:Object.fromEntries(pick.map(id=>[id,v(id)]))});assert.equal(ok2.deleted,3);
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_board_notes WHERE row_id=?',rowIds[20]).n,0,'notes go with their row');
  // “Select all matching”: the count and the rows themselves (the page's match_key) must still be what was shown.
  const match={q:'Item 2',filters:[]},{total:n,match_key}=s.tasks.groups.query(G,DARA,match);
  const bad=await api('dara','tm.group.row.delete',{group_id:G,match,expected_count:n+1,match_key});assert.equal(bad.status,409);assert.equal(bad.body.details.code,'bulk_changed');
  assert.equal((await api('dara','tm.group.row.delete',{group_id:G,match,expected_count:n})).status,409,'without the match key nothing is deleted');
  const good=await ok('dara','tm.group.row.delete',{group_id:G,match,expected_count:n,match_key});assert.equal(good.deleted,n);
  assert.equal(s.tasks.groups.query(G,SOPHEA,match).total,0);
  // A single delete with an old version is refused.
  const one=rowIds[29],ver=v(one);cmd('tm.group.row.update',{group_id:G,id:one,values:{[QTY]:31},expected:{[QTY]:30}},SOPHEA);
  assert.equal((await api('dara','tm.group.row.delete',{group_id:G,id:one,expected_version:ver})).status,409);
 });

 await check('6. Excel import: every worksheet or chosen ones, header rows, rows and columns, mapping, problems shown first, people resolved, and no double import',async()=>{
  const book=writeXlsx({sheets:[
   {name:'October',columns:[{header:'Item',type:'text'},{header:'Quantity',type:'number'},{header:'Due',type:'date'},{header:'Code',type:'text'},{header:'Owner',type:'text'}],rows:[['Pallets',5,addDays(today,3),'00071','Dara · Sales'],['Tape','ten',addDays(today,4),'00072',''],[null,null,null,null,null],['Labels',12,'next week','00073','Sophea']]},
   {name:'Returns',columns:[{header:'Product',type:'text'},{header:'Qty',type:'number'}],rows:[['Bubble wrap',2],['Silica gel',5]]},
  ]});
  const up=await ok('dara','tm.group.import.upload',{group_id:G,name:'purchases.xlsx',base64:book.toString('base64')});
  const imp=up.import;assert.deepEqual(imp.sheets.map(x=>[x.name,x.rows,x.columns]),[['October',5,5],['Returns',3,2]]);
  assert.equal((await api('dara','tm.group.import.upload',{group_id:G,name:'old.xls',base64:'AAAA'})).status,415);
  const preview=async(who,plan)=>request('/c/default/api/tasks/group/import/preview',{cookie:C[who],data:{import_id:imp.id,plan}});
  // Dara can edit records but not add columns: mapping to a new column is refused.
  const planNew={sheets:[{index:0,header_row:1,columns:[{source:0,target:ITEM},{source:1,target:QTY},{source:2,target:DUE},{source:3,target:CODE},{source:4,new:{name:'Owner',type:'IN_CHARGE'}}]}]};
  assert.equal((await preview('dara',planNew)).status,403);
  const plan={sheets:[{index:0,header_row:1,columns:[{source:0,target:ITEM},{source:1,target:QTY},{source:2,target:DUE},{source:3,target:CODE},{source:4,skip:true}]},{index:1,header_row:1,columns:[{source:0,target:ITEM},{source:1,target:QTY}]}]};
  const p=(await preview('dara',plan)).body;
  assert.deepEqual(p.totals,{add:3,update:0,skipped:1,failed:2},'both worksheets: 1 + 2 rows to add, 1 empty, 2 with problems');
  const errs=p.sheets[0].errors.map(e=>`${e.row}:${e.column}`);assert.ok(errs.includes('3:Quantity')&&errs.includes('5:Due'),'actionable problems: row and column');
  // Only some rows and columns of one worksheet.
  const part=(await preview('dara',{sheets:[{index:0,header_row:1,rows:[2],columns:[{source:0,target:ITEM},{source:3,target:CODE}]}]})).body;assert.deepEqual(part.totals,{add:1,update:0,skipped:0,failed:0});
  // Sophea (manages the group) maps “Owner” to a new In Charge column: names that aren't exact are asked about.
  const up2=await ok('sophea','tm.group.import.upload',{group_id:G,name:'purchases.xlsx',base64:book.toString('base64')});
  const p2=(await request('/c/default/api/tasks/group/import/preview',{cookie:C.sophea,data:{import_id:up2.import.id,plan:{...planNew,sheets:[{...planNew.sheets[0]}]}}})).body;
  assert.deepEqual(p2.new_columns,[{name:'Owner',type:'IN_CHARGE'}]);assert.ok(p2.sheets[0].errors.some(e=>/Sophea/.test(e.value)&&/Nobody/.test(e.message)),'“Sophea” is not an exact name');
  // Commit with the totals from the preview; a retry adds nothing.
  const done=await ok('dara','tm.group.import.commit',{import_id:imp.id,plan,expected:{add:3,update:0}});
  assert.equal(done.result.added,3);assert.equal(done.result.failed,2);
  const again=await ok('dara','tm.group.import.commit',{import_id:imp.id,plan,expected:{add:3,update:0}});assert.equal(again.already,true);
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Pallets'}).total,1,'imported once');
  const pal=s.tasks.groups.query(G,SOPHEA,{q:'Pallets'}).rows[0];assert.equal(pal.values[CODE],'00071','leading zeros');assert.equal(pal.values[DUE],addDays(today,3),'a real date');
  // Update mode needs a key and confirmation; the preview shows how many rows change.
  const book2=writeXlsx({sheets:[{name:'Fix',columns:[{header:'Code',type:'text'},{header:'Quantity',type:'number'}],rows:[['00071',50]]}]});
  const up3=await ok('dara','tm.group.import.upload',{group_id:G,name:'fix.xlsx',base64:book2.toString('base64')});
  const planU={mode:'update',unmatched:'skip',sheets:[{index:0,header_row:1,key:{source:0},columns:[{source:0,target:CODE},{source:1,target:QTY}]}]};
  const pu=(await request('/c/default/api/tasks/group/import/preview',{cookie:C.dara,data:{import_id:up3.import.id,plan:planU}})).body;assert.deepEqual(pu.totals,{add:0,update:1,skipped:0,failed:0});
  assert.equal((await api('dara','tm.group.import.commit',{import_id:up3.import.id,plan:planU,expected:{add:0,update:1}})).body.details?.code,'confirm_update');
  await ok('dara','tm.group.import.commit',{import_id:up3.import.id,plan:planU,expected:{add:0,update:1},confirm_update:true});
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Pallets'}).rows[0].values[QTY],50);
  assert.equal(s.tasks.groups.read(G,SOPHEA).columns.find(c=>c.id===SUB).type,'FORMULA','group formulas keep calculating');
 });

 await check('7. SIMULATED Google Sheets (local stand-in, not Google): two-way changes, reordering, conflicts, retries, loop prevention, restricted data and revocation',async()=>{
  const redirectUri=`${base}/c/default/api/google/callback`,sophea=userOf(SOPHEA);
  assert.equal((await request('/c/default/api/google/config',{cookie:C.sophea})).status,403,'administrators set Google up');
  await ok('vanna','admin.integrations.save',{client_id:'local-test.apps.googleusercontent.com',client_secret:'local-secret',interval_s:30});
  assert.ok(!JSON.stringify((await request('/c/default/api/google/config',{cookie:C.vanna})).body).includes('local-secret'),'the secret never leaves the server');
  assert.ok(!s.get('SELECT client_secret_enc FROM tm_google_config WHERE id=1').client_secret_enc.includes('local-secret'),'stored encrypted');
  await rejects(s.sync.request(userOf(DARA),{action:'connect',group_id:G},{redirectUri}),/manage this group/,403);
  const conn=await s.sync.request(sophea,{action:'connect',group_id:G},{redirectUri});
  const r=await fetch(conn.url+'&auto=1',{redirect:'manual'}),loc=new URL(r.headers.get('location'));
  assert.equal((await s.sync.finishAuth({code:loc.searchParams.get('code'),state:loc.searchParams.get('state'),browser:'another-browser'},redirectUri)).ok,false,'must finish in the same browser');
  const conn2=await s.sync.request(sophea,{action:'connect',group_id:G},{redirectUri}),r2=await fetch(conn2.url+'&auto=1',{redirect:'manual'}),loc2=new URL(r2.headers.get('location'));
  assert.equal((await s.sync.finishAuth({code:loc2.searchParams.get('code'),state:loc2.searchParams.get('state'),browser:conn2.browser},redirectUri)).ok,true);
  assert.equal((await s.sync.finishAuth({code:loc2.searchParams.get('code'),state:loc2.searchParams.get('state'),browser:conn2.browser},redirectUri)).ok,false,'a state is used once');
  const map=s.sync.describe(G,SOPHEA,redirectUri).columns.filter(c=>c.syncable).map(c=>({column_id:c.id}));
  await rejects(s.sync.request(sophea,{action:'setup',group_id:G,mode:'new',direction:'TWO_WAY',columns:map,delete_mode:'PROPAGATE'},{redirectUri}),/Confirm that deleting/,409);
  const setup=await s.sync.request(sophea,{action:'setup',group_id:G,mode:'new',title:'Purchases (ERP)',direction:'TWO_WAY',columns:map},{redirectUri});
  assert.equal(setup.preview.summary.excluded_rows,1);assert.equal(setup.preview.summary.excluded_columns,2,'Unit Price and the formula that uses it stay out by default');
  const id=setup.id,sync=()=>s.get('SELECT * FROM tm_board_syncs WHERE id=?',id);assert.equal(sync().status,'PAUSED','nothing is written before the preview is accepted');
  await s.sync.request(sophea,{action:'resume',id},{redirectUri});
  let x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.match(x.message,/Synced/);
  const SID=sync().spreadsheet_id,vals=()=>fake.api.values(SID),head=()=>vals()[0];
  assert.ok(!head().includes('Unit Price')&&!head().includes('Subtotal'),'restricted column not in the sheet');assert.ok(head().includes('ERP Row ID'));
  assert.ok(!JSON.stringify(vals()).includes('Item 5"'),'restricted row not in the sheet');
  const n0=vals().length,ver0=fake.api.get(SID).version;
  x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.equal(fake.api.get(SID).version,ver0,'a sync with no changes writes nothing (no loop)');
  // Sheet → group.
  const rowOf=item=>vals().findIndex(r=>r[head().indexOf('Item')]===item),qi=()=>head().indexOf('Quantity');
  fake.api.edit(SID,[[rowOf('Item 3'),qi(),33]]);await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Item 3'}).rows.find(r=>r.values[ITEM]==='Item 3').values[QTY],33);
  assert.equal(vals()[rowOf('Item 3')][head().indexOf('Double')],66,'the group formula result goes back to the sheet in the same run');
  // Group → sheet.
  const r3=s.tasks.groups.query(G,SOPHEA,{q:'Item 3'}).rows.find(r=>r.values[ITEM]==='Item 3');
  cmd('tm.group.row.update',{group_id:G,id:r3.id,values:{[QTY]:34},expected:{[QTY]:33}},SOPHEA);await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});
  assert.equal(vals()[rowOf('Item 3')][qi()],34);
  // Both sides changed: a conflict, nothing overwritten, resolved by choice.
  cmd('tm.group.row.update',{group_id:G,id:r3.id,values:{[QTY]:35},expected:{[QTY]:34}},SOPHEA);fake.api.edit(SID,[[rowOf('Item 3'),qi(),36]]);
  x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.match(x.message,/conflict/);
  let d=s.sync.describe(G,SOPHEA,redirectUri);assert.equal(d.sync.conflicts.length,1);assert.deepEqual([d.sync.conflicts[0].erp_text,d.sync.conflicts[0].sheet_text],['35','36']);
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Item 3'}).rows.find(r=>r.id===r3.id).values[QTY],35);assert.equal(vals()[rowOf('Item 3')][qi()],36);
  await s.sync.request(sophea,{action:'resolve',id,conflict_id:d.sync.conflicts[0].id,keep:'SHEET'},{redirectUri});await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Item 3'}).rows.find(r=>r.id===r3.id).values[QTY],36);
  // Columns reordered in the sheet and a row added there: matched by header and by row ID, not by position.
  fake.api.moveColumn(SID,qi(),0);const line=Array(head().length).fill(null);line[head().indexOf('Item')]='Added in Sheets';line[head().indexOf('Quantity')]=7;fake.api.insertRow(SID,vals().length,line);
  x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.equal(x.summary.new_in_group,1);
  assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Added in Sheets'}).total,1);assert.ok(vals().some(r=>r[head().indexOf('Item')]==='Added in Sheets'&&r[head().indexOf('ERP Row ID')]),'the new row got its ID');
  x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.equal(s.tasks.groups.query(G,SOPHEA,{q:'Added in Sheets'}).total,1,'no duplicate on the next run');
  // A group formula is never overwritten from the sheet.
  const formula=s.get('SELECT settings_json FROM tm_board_columns WHERE id=?',DBL).settings_json;
  fake.api.edit(SID,[[rowOf('Item 3'),head().indexOf('Double'),1]]);await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});
  assert.equal(s.get('SELECT settings_json FROM tm_board_columns WHERE id=?',DBL).settings_json,formula,'the formula is unchanged');assert.equal(vals()[rowOf('Item 3')][head().indexOf('Double')],72,'its result is written back');
  // Google answers “too many requests” twice: retried with backoff, then it works.
  fake.api.failNext(2,429);fake.api.edit(SID,[[rowOf('Item 6'),head().indexOf('Quantity'),61]]);
  const t0=Date.now();x=await s.sync.request(sophea,{action:'sync_now',id},{redirectUri});assert.match(x.message,/Synced/);assert.ok(Date.now()-t0>=2000,'waited before retrying');
  console.log(`  (simulated: two 429 answers retried, run took ${Date.now()-t0} ms)`);
  // Revoked access: the sync stops safely and says why.
  fake.api.revokeAll();await rejects(s.sync.request(sophea,{action:'sync_now',id},{redirectUri}),/Google/,409);
  assert.equal(sync().status,'ERROR');assert.match(sync().status_detail,/Google/);
  assert.ok(s.get('SELECT COUNT(*) n FROM tm_board_sync_runs WHERE sync_id=?',id).n>=8,'every run is recorded');
  // Quota pacing: with a limit of 3 requests a minute per Google account, the 4th request waits instead of failing.
  const G2=await import('./google-api.mjs');process.env.GOOGLE_REQUESTS_PER_MINUTE='3';
  const started=Date.now(),calls=[];for(let i=0;i<4;i++)calls.push(Promise.race([G2.call(`${fake.base}/drive/v3/files/none`,{account:'pace-test',tries:1}).catch(()=>null).then(()=>Date.now()-started),sleep(1500).then(()=>'waiting')]));
  const timing=await Promise.all(calls);assert.equal(timing.filter(t=>t==='waiting').length,1,'one request waits for the quota window');process.env.GOOGLE_REQUESTS_PER_MINUTE='1000';
 });

 // ================================================================ 5 branding and UI
 await check('15. blue sidebar, the supplied red dragon logo (proportions kept), spacious tables and phone layouts are in the build',()=>{
  // The interface source is next to this file, or (in the packaged runtime) in source/local-test.
  const src=existsSync(path.join(here,'styles/shell.css'))?here:path.join(here,'source','local-test');
  const css=readFileSync(path.join(src,'styles/shell.css'),'utf8');assert.match(css,/--sb-bg:\s*#0f3274/);
  const png=f=>{const b=readFileSync(path.join(src,'brand',f));assert.equal(b.subarray(1,4).toString(),'PNG');return [b.readUInt32BE(16),b.readUInt32BE(20)];};
  for(const [f,w] of [['usrv-logo-96.png',96],['usrv-logo-192.png',192],['usrv-logo-384.png',384]]){const [x,y]=png(f);assert.equal(x,w);assert.equal(y,Math.round(w*1554/1540),'the original 1540 × 1554 proportions');}
  const groups=readFileSync(path.join(src,'styles/groups.css'),'utf8');assert.match(groups,/\.grid-table thead th \{ position: sticky; top: 0/);assert.match(groups,/@media \(max-width: 760px\)/);
  assert.match(readFileSync(path.join(src,'styles/calendar.css'),'utf8'),/@media \(max-width: 640px\)/);
  const pub=path.join(here,'public');if(existsSync(pub)){const html=readFileSync(path.join(pub,'index.html'),'utf8');assert.match(html,/rel="icon"[^>]+usrv-favicon/);assert.ok(readdirSync(path.join(pub,'assets')).some(f=>/^usrv-logo-384-.*\.png$/.test(f)));}
 });

 // ================================================================ regression
 await check('16. existing assignment, acceptance, review, approval and closing still work; other ERP areas are untouched',()=>{
  const id=cmd('tm.task.save',{workspace_id:ws,title:'Regression: assign and close',start_date:today,due_date:addDays(today,3),pic_id:DARA,supporter_ids:[BOPHA],reviewer_id:SOPHEA},SOPHEA).id;
  cmd('tm.task.accept',{id},DARA);cmd('tm.task.accept',{id},BOPHA);
  const r=cmd('tm.task.submit',{id,note:'Done'},DARA);assert.ok(r);assert.equal(task(id).status,'IN_REVIEW');
  cmd('tm.task.close',{id},SOPHEA);assert.equal(task(id).status,'COMPLETED');
  const c=cmd('tm.task.save',{workspace_id:ws,title:'Regression: cancel needs both',start_date:today,due_date:addDays(today,3),pic_id:DARA,reviewer_id:SOPHEA},SOPHEA).id;cmd('tm.task.accept',{id:c},DARA);
  const ask=cmd('tm.task.cancel',{id:c,reason:'Not needed'},DARA);assert.ok(ask.change_id);assert.notEqual(task(c).status,'CANCELLED');
  const cr=s.get('SELECT * FROM tm_change_requests WHERE id=?',ask.change_id);cmd('tm.change.decide',{id:cr.id,decision:'APPROVE',expected_version:cr.version},SOPHEA);assert.equal(task(c).status,'CANCELLED');
  const st=s.state();assert.ok(Array.isArray(st.contacts)&&Array.isArray(st.ops_requests),'CRM and Operations data load as before');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');
 });

 console.log(`\n${checks} V5.5 checks passed (Task Visibility Scope, notifications, Expectation, Steps of Work, two-party progress, Calendar, meeting reminders, Groups notes, access rules, layouts, bulk delete, Excel export and import, SIMULATED Google Sheets sync, branding). Temporary data only.`);
}finally{
 runtime?.stop();mock?.close();gateway?.close();if(server)await new Promise(r=>server.close(r));
 hub.close();rmSync(folder,{recursive:true,force:true});await fake.close();
}

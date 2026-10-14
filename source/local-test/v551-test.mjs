import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramRuntime} from './telegram-bot.mjs';
import {createTelegramGateway,signInitData,MINI_APP_ACTIONS} from './telegram-gateway.mjs';
import {taskToday,addDays} from './task-domain.mjs';

// V5.5.1: the calendar in the Telegram Mini App (meetings, deadlines and personal notes, with the ERP's own rules), the
// Telegram buttons that open it, and a meeting keeping its link to a task the person changing it can't see.
// Fixtures as in v55-test.mjs: Vanna (Administrator), Sophea (Manager, reports to Vanna), Dara (Team member, reports to
// Sophea), Chantha (Team member) and Bopha (Viewer). Telegram is the local stand-in below; nothing leaves this computer.
const folder=mkdtempSync(path.join(tmpdir(),'sunny-v551-'));
const hub=openCompanies(folder,{demo:true}),s=hub.primary;let checks=0,server,gateway,mock,runtime;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,label,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw new Error('Timed out waiting for '+label);await sleep(40);}};
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const cmd=(action,data,actor)=>s.command(action,data,actor);
const today=taskToday(),at=h=>new Date(Date.now()+h*3600e3).toISOString();
const VANNA='STAFF-003',SOPHEA='STAFF-002',DARA='STAFF-001';
const staffOf=email=>s.get('SELECT staff_id FROM access_users WHERE email=?',email).staff_id;
try{
 // Keep the test's scheduling windows independent of clock-relative demo meetings.
 s.run("UPDATE tm_meetings SET status='CANCELLED' WHERE status='SCHEDULED'");
 s.access.bootstrap({staff_id:VANNA,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:SOPHEA,name:'Sophea · Sales Manager',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},VANNA);
 cmd('admin.user.save',{staff_id:DARA,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},VANNA);
 for(const [name,email,role] of [['Chantha · Operations','chantha@example.test','ROLE-MEMBER'],['Bopha · Viewer','bopha@example.test','ROLE-VIEWER']])
  cmd('admin.user.save',{name,email,role_id:role,password:'local-password-1',active:1},VANNA);
 const [CHANTHA,BOPHA]=['chantha','bopha'].map(n=>staffOf(`${n}@example.test`));
 for(const [staff,manager] of [[SOPHEA,VANNA],[DARA,SOPHEA],[CHANTHA,VANNA]])cmd('tm.profile.manager',{staff_id:staff,manager_id:manager},VANNA);
 const ws=cmd('tm.workspace.save',{name:'V5.5.1 Sales',department:'Sales',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,VANNA,BOPHA,CHANTHA]},SOPHEA).id;

 const port=4361,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const login=async(email,password)=>{const r=await fetch(`${base}/c/default/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,email);return r.headers.get('set-cookie').split(';')[0];};
 const C={sophea:await login('sophea@example.test','sophea-password-1'),vanna:await login('vanna@example.test','vanna-password-1')};
 const api=async(who,action,data)=>{const r=await fetch(`${base}/c/default/api/command`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:C[who]},body:JSON.stringify({action,data})});return {status:r.status,body:await r.json()};};

 const TOKEN='123456789:AAHtestTokenForSunnyErpLocalChecks00';
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',TOKEN);
 for(const [staff,id,first] of [[SOPHEA,7402,'Sophea'],[DARA,7401,'Dara'],[BOPHA,7403,'Bopha'],[CHANTHA,7404,'Chantha']])s.telegram.connectSignedIn(staff,{id,first_name:first},id);
 gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const gw=`http://127.0.0.1:${gateway.address().port}/c/default/tg/api`;
 const mini=async(uid,p,data)=>{const init=signInitData({auth_date:Math.floor(Date.now()/1000),query_id:'V551',user:{id:uid,first_name:'User'}},TOKEN);const r=await fetch(gw+p,{method:data?'POST':'GET',headers:{Authorization:'tma '+init,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const t=await r.text();let body;try{body=JSON.parse(t);}catch{body=t;}return {status:r.status,body};};
 const miniCmd=(uid,action,data)=>mini(uid,'/command',{action,data});
 const ids=list=>list.map(x=>x.id).sort();

 // Sophea's meeting with Dara (participants only), one shared with the whole workspace, and Vanna's private meeting.
 const M1=cmd('tm.meeting.save',{workspace_id:ws,title:'Pricing with Dara',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(20),end_at:at(21)},SOPHEA).id;
 const M2=cmd('tm.meeting.save',{workspace_id:ws,title:'Sales weekly (everyone)',organizer_id:SOPHEA,attendee_ids:[SOPHEA],start_at:at(26),end_at:at(27),share_scope:'WORKSPACE',reminder_offsets:[60]},SOPHEA).id;
 const M3=cmd('tm.meeting.save',{workspace_id:ws,title:'Board (private)',organizer_id:VANNA,attendee_ids:[CHANTHA],start_at:at(30),end_at:at(31)},VANNA).id;
 const N1=cmd('tm.calnote.save',{title:'Dara: call the broker',all_day:true,day:addDays(today,2)},DARA).id;
 const N2=cmd('tm.calnote.save',{title:'Sophea: private reminder',all_day:true,day:addDays(today,2)},SOPHEA).id;

 await check('Mini App: the calendar arrives with the meetings each person may see and only their own notes',async()=>{
  const dara=(await mini(7401,'/state')).body,bopha=(await mini(7403,'/state')).body,chantha=(await mini(7404,'/state')).body;
  // (The sample company has meetings of its own; only the three made here are compared.)
  const ours=list=>ids(list).filter(x=>[M1,M2,M3].includes(x));
  assert.deepEqual(ours(dara.tm_meetings),[M1,M2].sort(),'Dara: the meeting she is in and the workspace one');
  assert.deepEqual(ours(bopha.tm_meetings),[M2],'Bopha: only what is shared with the workspace');
  assert.deepEqual(ours(chantha.tm_meetings),[M2,M3].sort(),'Chantha: the workspace one and the meeting she is invited to');
  const visible=new Set(ids(dara.tm_meetings));
  assert.ok(dara.tm_calendar_notes.length>=1&&dara.tm_calendar_notes.every(n=>n.staff_id===DARA)&&dara.tm_calendar_notes.some(n=>n.id===N1),'only her own notes');assert.ok(!JSON.stringify(dara).includes('Sophea: private reminder'),'nobody else’s note text');
  assert.ok(dara.tm_attendees.every(a=>visible.has(a.meeting_id))&&dara.tm_meeting_shares.every(a=>visible.has(a.meeting_id)),'attendees and sharing of visible meetings only');
  assert.ok(!dara.tm_attendees.some(a=>a.meeting_id===M3));
  assert.ok(!JSON.stringify(dara).includes('Board (private)'),'nothing about a meeting she can’t see');
  assert.ok(dara.tm_meetings.every(m=>!('creation_key' in m)),'no internal keys');
  assert.equal(dara.my_timezone,'Asia/Phnom_Penh');
 });

 await check('Mini App: meetings and notes are added and changed with the same rules as the ERP',async()=>{
  for(const a of ['tm.meeting.save','tm.meeting.follow','tm.calnote.save','tm.calnote.delete'])assert.ok(MINI_APP_ACTIONS.test(a),a);
  assert.ok(!MINI_APP_ACTIONS.test('tm.time.save')&&!MINI_APP_ACTIONS.test('tm.meeting.delete'),'other calendar-adjacent actions stay out of the Telegram app');
  const r=await miniCmd(7401,'tm.meeting.save',{workspace_id:ws,title:'Dara’s client call',organizer_id:DARA,attendee_ids:[DARA,SOPHEA],start_at:at(40),end_at:at(41),share_scope:'PARTICIPANTS',reminder_offsets:[15,60],request_key:'mini-1'});
  assert.equal(r.status,200,JSON.stringify(r.body));const M4=r.body.result.id;
  const m4=s.get('SELECT * FROM tm_meetings WHERE id=?',M4);assert.equal(m4.organizer_id,DARA);assert.equal(m4.reminder_offsets,'[60,15]');
  assert.equal((await miniCmd(7401,'tm.meeting.save',{workspace_id:ws,title:'Dara’s client call',organizer_id:DARA,attendee_ids:[DARA],start_at:at(40),end_at:at(41),request_key:'mini-1'})).body.result.id,M4,'a repeated tap creates nothing new');
  // A Viewer can't schedule; someone who only sees a shared meeting can't change it, but can ask for its reminders.
  const viewer=await miniCmd(7403,'tm.meeting.save',{workspace_id:ws,title:'Not allowed',organizer_id:BOPHA,attendee_ids:[BOPHA],start_at:at(44),end_at:at(45)});assert.equal(viewer.status,403);
  const m2=s.get('SELECT * FROM tm_meetings WHERE id=?',M2);
  const notMine=await miniCmd(7401,'tm.meeting.save',{...m2,expected_version:m2.version,attendee_ids:[SOPHEA],title:'Changed by Dara'});assert.equal(notMine.status,403);assert.match(notMine.body.error,/Only the organizer and the attendees/);
  assert.equal((await miniCmd(7403,'tm.meeting.follow',{id:M2,follow:true})).status,200);
  assert.ok(s.get('SELECT 1 AS ok FROM tm_meeting_followers WHERE meeting_id=? AND staff_id=?',M2,BOPHA),'Bopha gets the reminders of the shared meeting');
  assert.equal((await miniCmd(7403,'tm.meeting.follow',{id:M1,follow:true})).status,404,'a meeting not shared with her is “not found”');
  // V5.6.8: an attendee can't move someone else's meeting (only its organizer or whoever scheduled it can); the organizer
  // moves it, and an attendee completes it with notes from the phone.
  const m1=s.get('SELECT * FROM tm_meetings WHERE id=?',M1);
  const notOrganizer=await miniCmd(7401,'tm.meeting.save',{...m1,expected_version:m1.version,attendee_ids:[SOPHEA,DARA],share_ids:[],reminder_offsets:[],start_at:at(22),end_at:at(23)});
  assert.equal(notOrganizer.status,403);assert.match(notOrganizer.body.error,/organizer/);
  s.command('tm.meeting.save',{...m1,expected_version:m1.version,attendee_ids:[SOPHEA,DARA],share_ids:[],reminder_offsets:[],start_at:at(22),end_at:at(23)},m1.organizer_id);
  assert.ok(Math.abs(Date.parse(s.get('SELECT start_at FROM tm_meetings WHERE id=?',M1).start_at)-Date.now()-22*3600e3)<60e3,'moved to the new time');
  const m1b=s.get('SELECT * FROM tm_meetings WHERE id=?',M1);
  assert.equal((await miniCmd(7401,'tm.meeting.save',{...m1b,expected_version:m1b.version,attendee_ids:[SOPHEA,DARA],status:'COMPLETED',minutes_notes:'Agreed on prices'})).status,200);
  assert.equal(s.get('SELECT status FROM tm_meetings WHERE id=?',M1).status,'COMPLETED');
  // Notes: Dara's own only; someone else's note is “not found”.
  const note=await miniCmd(7401,'tm.calnote.save',{title:'Pick up samples',all_day:false,start_at:at(5),end_at:at(6),reminder_offsets:[15]});assert.equal(note.status,200,JSON.stringify(note.body));
  const n=s.get('SELECT * FROM tm_calendar_notes WHERE id=?',note.body.result.id);assert.equal(n.staff_id,DARA);assert.equal(n.reminder_offsets,'[15]');
  assert.equal((await miniCmd(7401,'tm.calnote.save',{id:N2,expected_version:0,title:'x',all_day:true,day:today})).status,404);
  assert.equal((await miniCmd(7401,'tm.calnote.delete',{id:N2,expected_version:0})).status,404);
  assert.equal(s.get('SELECT title FROM tm_calendar_notes WHERE id=?',N2).title,'Sophea: private reminder','unchanged');
  assert.equal((await miniCmd(7401,'tm.calnote.delete',{id:n.id,expected_version:n.version})).status,200);
  assert.ok(!s.get('SELECT 1 AS ok FROM tm_calendar_notes WHERE id=?',n.id));
  const past=await miniCmd(7401,'tm.calnote.save',{title:'Too late',all_day:false,start_at:at(0.1),reminder_offsets:[60]});assert.equal(past.status,422,'a reminder already in the past is refused');
 });

 await check('a meeting keeps its link to a task the person changing it can’t see (ERP and Telegram app)',async()=>{
  const A1=cmd('tm.task.save',{workspace_id:ws,title:'Board preparation (private)',start_date:today,due_date:addDays(today,3),pic_id:VANNA},VANNA).id;
  const M=cmd('tm.meeting.save',{workspace_id:ws,title:'Board prep sync',organizer_id:VANNA,attendee_ids:[SOPHEA],start_at:at(50),end_at:at(51),task_id:A1},VANNA).id;
  const seen=(await mini(7402,'/state')).body.tm_meetings.find(m=>m.id===M);assert.equal(seen.task_id,null,'Sophea does not see the task behind it');
  // The ERP editor sends the (empty) task field it shows; the Telegram app leaves it out.
  let m=s.get('SELECT * FROM tm_meetings WHERE id=?',M);
  // (Sophea is an attendee: she may change the meeting's reminders and notes, not its time or details.)
  const erp=await api('sophea','tm.meeting.save',{...m,task_id:'',expected_version:m.version,attendee_ids:[VANNA,SOPHEA],reminder_offsets:[30]});
  assert.equal(erp.status,200,JSON.stringify(erp.body));assert.equal(s.get('SELECT task_id FROM tm_meetings WHERE id=?',M).task_id,A1,'still linked after the ERP change');
  m=s.get('SELECT * FROM tm_meetings WHERE id=?',M);const {task_id:_,...rest}=m;
  assert.equal((await miniCmd(7402,'tm.meeting.save',{...rest,expected_version:m.version,attendee_ids:[VANNA,SOPHEA],reminder_offsets:[60]})).status,200);
  assert.equal(s.get('SELECT task_id FROM tm_meetings WHERE id=?',M).task_id,A1,'still linked after the Telegram change');
  // Someone who can see the task can still remove the link.
  m=s.get('SELECT * FROM tm_meetings WHERE id=?',M);
  assert.equal((await api('vanna','tm.meeting.save',{...m,task_id:'',expected_version:m.version,attendee_ids:[VANNA,SOPHEA]})).status,200);
  assert.equal(s.get('SELECT task_id FROM tm_meetings WHERE id=?',M).task_id,null,'removed by Vanna');
 });

 await check('Telegram: meeting and note messages open the meeting or the note in the Mini App calendar',async()=>{
  const sent=[];
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
  const APP='https://tasks.example.test/c/default/tg/';
  runtime=createTelegramRuntime({companies:{list:()=>[{id:'default'}],get:()=>s},apiBase:`http://127.0.0.1:${mock.address().port}`,supervisorMs:100,outboxMs:100,pollTimeout:1,logger:{error:()=>{}},appUrlFor:()=>APP}).start();
  await waitFor(()=>s.telegram.settings().status==='ONLINE','bot online');
  await waitFor(()=>s.telegram.settings().last_notification_id>=0,'the outbox');
  const button=msg=>(msg.reply_markup?.inline_keyboard||[]).flat().find(b=>b.web_app);
  const M=cmd('tm.meeting.save',{workspace_id:ws,title:'Warehouse walk-through',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(60),end_at:at(61)},SOPHEA).id;
  const invite=await waitFor(()=>sent.find(x=>x.chat_id===7401&&/Warehouse walk-through/.test(x.text)),'the invitation');
  assert.equal(button(invite)?.web_app?.url,`${APP}?meeting=${M}`,'the invitation opens the meeting');
  assert.match(button(invite).text,/Open in the calendar/);
  const N=cmd('tm.calnote.save',{title:'Bring the forklift papers',all_day:false,start_at:at(1.05),reminder_offsets:[60]},DARA).id;
  assert.ok(s.eventReminders(new Date(Date.now()+5*60e3))>=1,'the note reminder is due');
  const reminder=await waitFor(()=>sent.find(x=>x.chat_id===7401&&/Bring the forklift papers/.test(x.text)),'the note reminder');
  assert.equal(button(reminder)?.web_app?.url,`${APP}?note=${N}`,'the reminder opens the note');
  // Task messages keep their own buttons (no calendar button).
  const T=cmd('tm.task.save',{workspace_id:ws,title:'Count the pallets',start_date:today,due_date:addDays(today,2),pic_id:DARA},SOPHEA).id;
  const taskMsg=await waitFor(()=>sent.find(x=>x.chat_id===7401&&/Count the pallets/.test(x.text)),'the task message');
  assert.ok(!(taskMsg.reply_markup?.inline_keyboard||[]).flat().some(b=>/calendar/i.test(b.text||'')),'no calendar button on a task message');void T;
 });

 await check('review fixes: a padded ID can’t skip the CRM check; a finished meeting’s notes don’t re-add removed members; a hidden task’s customer stays hidden',async()=>{
  // A meeting linked to a CRM activity, with Dara invited; Dara's own settings deny CRM activities.
  const ACT=cmd('activity.save',{parent_type:'TASK',type:'FOLLOWUP',subject:'Customer site visit',start_at:at(70),end_at:at(71),branch_id:'BR-PP',assigned_to:SOPHEA,channel:'MEETING'},SOPHEA).id;
  const MC=cmd('tm.meeting.save',{workspace_id:ws,activity_id:ACT,title:'Customer site visit',organizer_id:SOPHEA,attendee_ids:[DARA],start_at:at(70),end_at:at(71)},SOPHEA).id;
  const daraUser=s.get('SELECT * FROM access_users WHERE staff_id=?',DARA);
  cmd('admin.user.save',{id:daraUser.id,expected_version:daraUser.version,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',active:1,function_settings:{'crm.activities':{view:'DENY',update:'DENY',create:'DENY'}}},VANNA);
  const before=s.get('SELECT subject,start_at,version FROM activities WHERE id=?',ACT),m=s.get('SELECT * FROM tm_meetings WHERE id=?',MC);
  const body={...m,expected_version:m.version,attendee_ids:[SOPHEA,DARA],title:'Changed without CRM rights',start_at:at(72),end_at:at(73)};delete body.creation_key;delete body.activity_id;
  C.dara=await login('dara@example.test','dara-password-12');
  for(const id of [MC,` ${MC}`,`${MC}\t`]){
   assert.equal((await miniCmd(7401,'tm.meeting.save',{...body,id})).status,403,`Telegram app, id ${JSON.stringify(id)}`);
   assert.equal((await api('dara','tm.meeting.save',{...body,id})).status,403,`ERP, id ${JSON.stringify(id)}`);
  }
  assert.deepEqual(s.get('SELECT subject,start_at,version FROM activities WHERE id=?',ACT),before,'the CRM activity is unchanged');
  assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',MC).title,'Customer site visit');
  // Someone removed from a workspace after their meeting ended is not made a member again when its notes change.
  const ws2=cmd('tm.workspace.save',{name:'Ops retro space',department:'Ops',owner_id:SOPHEA,member_ids:[SOPHEA,DARA,CHANTHA]},SOPHEA).id;
  const M6=cmd('tm.meeting.save',{workspace_id:ws2,title:'Ops retro',organizer_id:SOPHEA,attendee_ids:[DARA,CHANTHA],start_at:at(2),end_at:at(3)},SOPHEA).id;
  let r=s.get('SELECT * FROM tm_meetings WHERE id=?',M6);
  cmd('tm.meeting.save',{...r,expected_version:r.version,attendee_ids:[SOPHEA,DARA,CHANTHA],status:'COMPLETED',minutes_notes:'done'},SOPHEA);
  const w2=s.get('SELECT * FROM tm_workspaces WHERE id=?',ws2);
  cmd('tm.workspace.save',{id:ws2,expected_version:w2.version,name:w2.name,department:w2.department,owner_id:SOPHEA,color:w2.color,member_ids:[SOPHEA,DARA]},SOPHEA);
  assert.ok(!s.get('SELECT 1 AS ok FROM tm_members WHERE workspace_id=? AND staff_id=?',ws2,CHANTHA),'Chantha left the workspace');
  r=s.get('SELECT * FROM tm_meetings WHERE id=?',M6);
  const notes=await miniCmd(7401,'tm.meeting.save',{...r,expected_version:r.version,attendee_ids:[SOPHEA,DARA,CHANTHA],minutes_notes:'done, with decisions'});
  assert.equal(notes.status,200,JSON.stringify(notes.body));
  assert.ok(!s.get('SELECT 1 AS ok FROM tm_members WHERE workspace_id=? AND staff_id=?',ws2,CHANTHA),'still not a member after the notes changed');
  // A meeting linked to a task someone can't see: the customer that task is about is hidden with it.
  const contact=s.get('SELECT id FROM contacts ORDER BY id LIMIT 1').id;
  const P=cmd('tm.task.save',{workspace_id:ws,title:'Private customer pricing',start_date:today,due_date:addDays(today,4),pic_id:VANNA,related_type:'CONTACT',related_id:contact},VANNA).id;
  const MP=cmd('tm.meeting.save',{workspace_id:ws,title:'Pricing call',organizer_id:VANNA,attendee_ids:[SOPHEA],start_at:at(80),end_at:at(81),task_id:P},VANNA).id;
  assert.equal(s.get('SELECT contact_id FROM tm_meetings WHERE id=?',MP).contact_id,contact);
  const sophea=(await mini(7402,'/state')).body,seen=sophea.tm_meetings.find(x=>x.id===MP);
  assert.equal(seen.task_id,null);assert.equal(seen.contact_id,null,'no customer ID from a task Sophea can’t see');
 });

 console.log(`\n${checks} V5.5.1 checks passed (Mini App calendar, its Telegram buttons, meeting task links, review fixes). Temporary data only.`);
}finally{
 runtime?.stop();mock?.close();gateway?.close();
 if(server)await new Promise(r=>{server.close(()=>r());server.closeAllConnections?.();});
 hub.close();rmSync(folder,{recursive:true,force:true});
}

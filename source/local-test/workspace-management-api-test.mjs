import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'sunny-workspace-api-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,wsB,task,createWorkspace}=organizationFixture(s),{A,B,C,D,E,X,Y}=ids;
const port=4398,base=`http://127.0.0.1:${port}`,token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
const server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:folder,logger:{error:()=>{}}});
const cookies={},signed={};let checks=0;
const result=async r=>({status:r.status,body:await r.json(),headers:r.headers});
const web=(who,url,data)=>fetch(base+'/c/default/api'+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookies[who]||''},...(data?{body:JSON.stringify(data)}:{})}).then(result);
const mini=(who,url,data)=>fetch(`http://127.0.0.1:${gateway.address().port}/c/default/tg/api${url}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'tma '+signed[who]},...(data?{body:JSON.stringify(data)}:{})}).then(result);
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
 let n=9900;for(const [who,staff] of Object.entries(ids)){
  const r=await web(who,'/auth/login',{email:who.toLowerCase()+'@review.test',password:'Review-organization-2026'});assert.equal(r.status,200);cookies[who]=r.headers.get('set-cookie').split(';')[0];
  const user={id:n++,first_name:who};s.telegram.connectSignedIn(staff,user,user.id);signed[who]=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);
 }
 cmd('org.delegation.request',{beneficiary_id:C,reason:'Owner API fixture'},B);
 const wsC=createWorkspace(C,'Creator workspace'),taskId=task(C,wsC,'Workspace API task');
 await check('Web and signed Mini App enforce scoped Owner additions and match dashboard sections',async()=>{
  for(const [i,client] of [web,mini].entries()){
   const state=await client('C','/state');assert.equal(state.status,200);assert.ok(state.body.workspace_dashboard.my.some(w=>w.id===wsC));assert.equal(state.body.workspace_dashboard.has_management,true);
   const candidates=state.body.tm_workspaces.find(w=>w.id===wsC).org_access.member_candidates.map(p=>p.id);assert.ok(candidates.includes(i?E:D));assert.ok(!candidates.includes(Y));
   const allowed=await client('C','/command',{action:'tm.workspace.member.add',data:{workspace_id:wsC,beneficiary_id:i?E:D,reason:'Scoped addition'}});assert.equal(allowed.status,200,JSON.stringify(allowed.body));assert.equal(allowed.body.result.status,'APPROVED');
   assert.equal((await client('C','/command',{action:'tm.workspace.member.add',data:{workspace_id:wsC,beneficiary_id:Y,reason:'Cross branch',approved:true,administrative:true}})).status,403);
  }
 });
 await check('Creator deletion works without a role Delete grant; ownership spoofing, stale versions and other users fail',async()=>{
  const old=s.access.publicUser(s.access.accountFor(C).id);
  cmd('admin.user.save',{...old,expected_version:old.version,function_settings:{'tasks.workspace':{delete:'DENY'},'tasks.organization':{view:'DENY'}}},A);
  const login=await web('C','/auth/login',{email:'c@review.test',password:'Review-organization-2026'});cookies.C=login.headers.get('set-cookie').split(';')[0];
  for(const client of [web,mini])assert.equal((await client('B','/command',{action:'tm.workspace.delete',data:{id:wsC,expected_version:0,acknowledged:true,created_by:B,actor_id:C}})).status,403);
  assert.equal((await web('C','/command',{action:'tm.workspace.delete',data:{id:wsC,expected_version:9,acknowledged:true}})).status,409);
  assert.equal((await web('C','/command',{action:'tm.workspace.delete',data:{id:wsC,expected_version:0,acknowledged:true}})).status,200);
  for(const client of [web,mini]){
   const state=await client('C','/state');assert.ok(!state.body.tm_workspaces.some(w=>w.id===wsC));assert.ok(!state.body.tm_tasks.some(t=>t.id===taskId));assert.equal(state.body.workspace_dashboard.my.find(w=>w.id===wsC).org_access.can_restore,true);
   assert.equal((await client('C','/command',{action:'tm.task.note',data:{id:taskId,note:'Hidden work cannot mutate'}})).status,404);
  }
  const restored=await mini('C','/command',{action:'tm.workspace.restore',data:{id:wsC,expected_version:1,acknowledged:true}});assert.equal(restored.status,200,JSON.stringify(restored.body));assert.ok((await web('C','/state')).body.tm_tasks.some(t=>t.id===taskId));
 });
 await check('Management metadata and task IDs remain branch-scoped with identical Web and Mini results',async()=>{
  cmd('org.delegation.request',{beneficiary_id:D,reason:'Delegated report'},B);const wsD=createWorkspace(D,'Managed report workspace'),t=task(D,wsD,'Visible report task',{pic_id:E});
  createWorkspace(E,'PERSONAL SECRET','PERSONAL');
  for(const client of [web,mini]){
   const state=(await client('C','/state')).body,row=state.workspace_dashboard.managed.find(w=>w.id===wsD);assert.ok(row.reference_only);assert.deepEqual(row.task_ids,[t]);assert.ok(!JSON.stringify(state.workspace_dashboard).includes('PERSONAL SECRET'));assert.ok(!state.workspace_dashboard.people.some(p=>p.staff_id===Y));
   const peer=(await client('Y','/state')).body;assert.ok(!peer.workspace_dashboard.managed.some(w=>w.id===wsD));assert.equal(peer.workspace_dashboard.has_management,false);
  }
 });
 await check('Explicit workspace View denial hides dashboard and blocks new scoped workspace commands',async()=>{
  const old=s.access.publicUser(s.access.accountFor(C).id);cmd('admin.user.save',{...old,expected_version:old.version,function_settings:{'tasks.workspace':{view:'DENY'},'tasks.organization':{view:'DENY'}}},A);
  const login=await web('C','/auth/login',{email:'c@review.test',password:'Review-organization-2026'});cookies.C=login.headers.get('set-cookie').split(';')[0];
  for(const client of [web,mini]){assert.equal((await client('C','/state')).body.workspace_dashboard,null);assert.equal((await client('C','/command',{action:'tm.workspace.delete',data:{id:wsC,expected_version:2,acknowledged:true}})).status,403);}
 });
 console.log(`\n${checks} workspace management API checks passed. Temporary company data; Telegram signatures verified locally.`);
}finally{await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}

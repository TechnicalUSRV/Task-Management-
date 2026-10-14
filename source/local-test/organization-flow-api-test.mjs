import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'sunny-org-flow-api-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,wsB,task}=organizationFixture(s),{A,B,C,D,E,Y}=ids;
const port=4397,base=`http://127.0.0.1:${port}`,token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
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
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,member_role:'VIEWER',reason:'API viewer'},B);
 const group=cmd('tm.group.save',{workspace_id:wsB,name:'Viewer API group',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT',shared:[]},B).id;
 await check('ERP enforces Viewer Group reads/writes; Mini App rejects unsupported Group writes',async()=>{
  for(const client of [web,mini]){
   const state=await client('C','/state');assert.equal(state.status,200);if(client===web)assert.equal(state.body.tm_boards.find(b=>b.id===group).level,1);else assert.equal(state.body.tm_boards,undefined);
   const edit=await client('C','/command',{action:'tm.group.row.add',data:{group_id:group,values:{}}});assert.equal(edit.status,403);
  }
 });
 await check('Both APIs reject hidden workspace replacements and leave governance unchanged',async()=>{
  const before=s.get('SELECT version FROM tm_workspaces WHERE id=?',wsB).version;
  for(const client of [web,mini])assert.equal((await client('A','/command',{action:'org.structure.save',data:{changes:[{staff_id:D,level:4,manager_id:C}],expected_revision:rev(),acknowledged:true,reason:'Invalid hidden replacement',workspace_replacements:[{id:wsB,owner_id:B,governing_manager_id:B}]}})).status,422);
  assert.equal(s.get('SELECT version FROM tm_workspaces WHERE id=?',wsB).version,before);
 });
 await check('Outside participants retain the workspace option needed to edit their own authorized task',async()=>{
  const id=task(B,wsB,'Outside participant editable',{pic_id:Y});
  cmd('tm.task.accept',{id},Y);
  for(const client of [web,mini]){
   const r=await client('Y','/state'),ref=r.body.tm_workspace_refs.find(w=>w.id===wsB);assert.equal(ref.kind,'ORGANIZATIONAL');assert.equal(ref.org_access.can_create,false);assert.equal(ref.org_access.can_collaborate_outside,false);
   assert.ok(!r.body.tm_workspaces.some(w=>w.id===wsB));assert.ok(!r.body.tm_members.some(m=>m.workspace_id===wsB));
   assert.equal((await client('Y','/command',{action:'tm.task.note',data:{id,note:'Resource-specific collaboration remains active'}})).status,200);
  }
 });
 await check('Workspace editor permission route remains usable when Organizational Structure is denied',async()=>{
  const old=s.access.publicUser(s.access.accountFor(E).id);
  cmd('admin.user.save',{...old,expected_version:old.version,function_settings:{'tasks.organization':{view:'DENY'}}},A);
  const login=await web('E','/auth/login',{email:'e@review.test',password:'Review-organization-2026'});cookies.E=login.headers.get('set-cookie').split(';')[0];
  for(const [i,client] of [web].entries()){
   assert.equal((await client('E','/command',{action:'org.workspace.save',data:{kind:'PERSONAL',name:'Denied organization route'}})).status,403);
   const created=await client('E','/command',{action:'tm.workspace.save',data:{kind:'PERSONAL',name:'Allowed workspace route '+i,owner_id:E}});assert.equal(created.status,200,JSON.stringify(created.body));
   const id=created.body.result.id;assert.equal(s.get('SELECT kind FROM tm_workspaces WHERE id=?',id).kind,'PERSONAL');
   const state=await client('E','/state');assert.deepEqual(state.body.organization,{enabled:true});
  }
 });
 console.log(`\n${checks} organization flow API checks passed. Temporary company data; Telegram signatures verified locally.`);
}finally{await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}

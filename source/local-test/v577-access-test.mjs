import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {visibilityFixture} from './v577-fixture.mjs';
const folder=mkdtempSync(path.join(tmpdir(),'tcm-v577-access-')),hub=openCompanies(folder),s=hub.primary;
const f=visibilityFixture(s),{ids,cmd,rev,pub,personal,deep,pubTask,privateTask,deepTask,grant}=f;
const port=4397,base=`http://127.0.0.1:${port}`,server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:folder});
const cookies={},signed={},token='123456789:AAHtestTokenForVisibilityTests0000';let checks=0;
const result=async r=>({status:r.status,body:await r.json(),headers:r.headers});
const web=(who,url,data)=>fetch(base+'/c/default/api'+url,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookies[who]||''},...(data?{body:JSON.stringify(data)}:{})}).then(result);
const mini=(who,url,data)=>fetch(`http://127.0.0.1:${gateway.address().port}/c/default/tg/api${url}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'tma '+signed[who]},...(data?{body:JSON.stringify(data)}:{})}).then(result);
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const auth=async who=>{const r=await web(who,'/auth/login',{username:who==='R'?'Admin R':'Employee '+who,password:f.password});assert.equal(r.status,200,JSON.stringify(r.body));cookies[who]=r.headers.get('set-cookie').split(';')[0];};
const state=async(client,who)=>{const r=await client(who,'/state');assert.equal(r.status,200);return r.body;};
const wsIds=s=>s.tm_workspaces.map(w=>w.id),taskIds=s=>s.tm_tasks.map(t=>t.id);
try{
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
 let n=9577000;for(const who of Object.keys(ids)){await auth(who);const u={id:n++,first_name:who};s.telegram.connectSignedIn(ids[who],u,u.id);signed[who]=signInitData({auth_date:Math.floor(Date.now()/1000),user:u},token);}
 await check('direct and indirect managers see Public workspaces/tasks; peers and other branches do not, on both APIs',async()=>{
  for(const client of [web,mini]){
   for(const who of ['A','B','E']){const st=await state(client,who);assert.ok(wsIds(st).includes(deep));assert.ok(taskIds(st).includes(deepTask));}
   const a=await state(client,'A');assert.ok(wsIds(a).includes(pub));assert.ok(taskIds(a).includes(pubTask));assert.ok(!wsIds(a).includes(personal));assert.ok(!taskIds(a).includes(privateTask));assert.ok(!JSON.stringify(a.workspace_dashboard).includes('B Personal'));
   for(const who of ['C','D','V']){const st=await state(client,who);for(const id of [pub,personal,deep])assert.ok(!wsIds(st).includes(id));for(const id of [pubTask,privateTask,deepTask])assert.ok(!taskIds(st).includes(id));assert.ok(!JSON.stringify(st.workspace_dashboard).includes('B Public'));}
  }
 });
 await check('reports use the same filtered task set and do not expose hidden titles',async()=>{
  for(const client of [web,mini])for(const who of ['A','C','D']){
   const r=await client(who,client===web?'/tasks/report?report=tasks':'/report?report=monthly&scope=all');assert.equal(r.status,200,JSON.stringify(r.body));
   const content=JSON.stringify(r.body);assert.ok(!content.includes('B private task'));
   if(who!=='A')assert.ok(!content.includes('B public task'));
  }
 });
 await check('Administration sees Personal workspaces regardless of organizational level; custom global grants cannot bypass privacy',async()=>{
  cmd('org.structure.save',{changes:[{staff_id:ids.R,level:3,manager_id:ids.B}],expected_revision:rev(),acknowledged:true,reason:'Administrator at a lower level'});
  grant('C',{'admin.workspaces':{view:'ALLOW'}});await auth('C');
  for(const client of [web,mini]){const admin=await state(client,'R');assert.ok(wsIds(admin).includes(personal));assert.ok(taskIds(admin).includes(privateTask));const c=await state(client,'C');assert.ok(!wsIds(c).includes(personal));assert.ok(!taskIds(c).includes(privateTask));assert.ok(!wsIds(c).includes(pub));}
 });
 await check('guessed task IDs and mutation endpoints do not disclose hidden work in web or Mini App',async()=>{
  for(const client of [web,mini])for(const who of ['A','C','D']){
   const r=await client(who,'/command',{action:'tm.task.note',data:{id:privateTask,note:'Unauthorized probe'}});assert.equal(r.status,404,JSON.stringify(r.body));
   const remove=await client(who,'/command',{action:'tm.workspace.member.remove',data:{workspace_id:personal,beneficiary_id:ids.B,expected_revision:rev(),reason:'Probe'}});assert.equal(remove.status,404,JSON.stringify(remove.body));
  }
 });
 await check('failed member additions roll back conversion, membership and audit together',async()=>{
  const audit=s.get('SELECT COUNT(*) n FROM org_audit').n;
  const r=await web('B','/command',{action:'tm.workspace.member.add',data:{workspace_id:personal,beneficiary_id:ids.D,reason:''}});assert.equal(r.status,400);
  assert.equal(s.get('SELECT visibility FROM tm_workspaces WHERE id=?',personal).visibility,'PERSONAL');assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',personal,ids.D));assert.equal(s.get('SELECT COUNT(*) n FROM org_audit').n,audit);
 });
 await check('adding a member converts Personal to Public atomically and preserves Viewer restrictions',async()=>{
  const r=await mini('B','/command',{action:'tm.workspace.member.add',data:{workspace_id:personal,beneficiary_id:ids.D,member_role:'VIEWER',reason:'Share with sibling'}});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(s.get('SELECT visibility FROM tm_workspaces WHERE id=?',personal).visibility,'PUBLIC');assert.ok(s.get("SELECT id FROM org_audit WHERE workspace_id=? AND action='workspace.public'",personal));
  for(const client of [web,mini]){const a=await state(client,'A'),d=await state(client,'D'),c=await state(client,'C');assert.ok(wsIds(a).includes(personal));assert.ok(taskIds(a).includes(privateTask));assert.ok(wsIds(d).includes(personal));assert.ok(taskIds(d).includes(privateTask));assert.equal(d.tm_workspaces.find(w=>w.id===personal).org_access.can_create,false);assert.ok(!wsIds(c).includes(personal));}
  const denied=await web('D','/command',{action:'tm.task.save',data:{workspace_id:personal,title:'Viewer probe',description:'No write',pic_id:ids.D}});assert.equal(denied.status,403,JSON.stringify(denied.body));
 });
 await check('owner removal revokes membership access; managers and task participants retain only independently authorized access',async()=>{
  const assigned=f.task('B',personal,'Assigned task retained',{pic_id:ids.D});
  const before=s.get('SELECT COUNT(*) n FROM tm_tasks').n;
  const stale=await web('B','/command',{action:'tm.workspace.member.remove',data:{workspace_id:personal,beneficiary_id:ids.D,expected_revision:-1,reason:'Stale'}});assert.equal(stale.status,409);
  const r=await web('B','/command',{action:'tm.workspace.member.remove',data:{workspace_id:personal,beneficiary_id:ids.D,expected_revision:rev(),reason:'Membership no longer needed'}});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(s.get('SELECT COUNT(*) n FROM tm_tasks').n,before);assert.ok(s.get("SELECT id FROM org_audit WHERE action='membership.revoked' AND workspace_id=?",personal));
  assert.equal(s.get('SELECT visibility FROM tm_workspaces WHERE id=?',personal).visibility,'PUBLIC');
  for(const client of [web,mini]){const d=await state(client,'D');assert.ok(!wsIds(d).includes(personal));assert.ok(!taskIds(d).includes(privateTask));assert.ok(taskIds(d).includes(assigned));assert.ok(wsIds(await state(client,'A')).includes(personal));}
  await mini('B','/command',{action:'tm.workspace.member.add',data:{workspace_id:personal,beneficiary_id:ids.A,reason:'Explicit manager membership'}});
  const rm=await mini('B','/command',{action:'tm.workspace.member.remove',data:{workspace_id:personal,beneficiary_id:ids.A,expected_revision:rev(),reason:'Management access remains'}});assert.equal(rm.status,200,JSON.stringify(rm.body));assert.ok(wsIds(await state(web,'A')).includes(personal));
  assert.ok(s.get('SELECT id FROM tm_workspaces WHERE id=?',pub));
 });
 await check('member removal protects the owner and allows an independently authorized legacy creator',async()=>{
  const owner=await web('B','/command',{action:'tm.workspace.member.remove',data:{workspace_id:personal,beneficiary_id:ids.B,expected_revision:rev(),reason:'Remove owner'}});assert.equal(owner.status,409);
  const legacy=f.workspace('B','Legacy creator test');s.run("UPDATE tm_workspaces SET kind='LEGACY' WHERE id=?",legacy);
  cmd('tm.workspace.save',{id:legacy,name:'Legacy creator test',owner_id:ids.E,member_ids:[ids.B,ids.E,ids.D],expected_version:0},'B');
  grant('B',{'tasks.workspace':{delete:'ALLOW'}});await auth('B');
  const denied=await mini('D','/command',{action:'tm.workspace.member.remove',data:{workspace_id:legacy,beneficiary_id:ids.B,expected_revision:rev(),reason:'Member probe'}});assert.equal(denied.status,403);
  const allowed=await mini('B','/command',{action:'tm.workspace.member.remove',data:{workspace_id:legacy,beneficiary_id:ids.D,expected_revision:rev(),reason:'Authorized creator removal'}});assert.equal(allowed.status,200,JSON.stringify(allowed.body));
  assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',legacy,ids.D));assert.ok(s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',legacy,ids.E));
 });
 await check('Organizational Structure View is tree-only and rejects every management command on both APIs',async()=>{
  for(const client of [web,mini]){
   const tree=await client('A','/organization?view=people');assert.equal(tree.status,200);assert.ok(tree.body.rows.some(x=>x.staff_id===ids.B));assert.ok(!tree.body.rows.some(x=>x.staff_id===ids.C));
   const employee=await client('A','/organization?view=employee&staff_id='+ids.B);assert.equal(employee.status,200);assert.deepEqual(employee.body.actions,{});
   for(const view of ['workspaces','requests','audit','migration','join'])assert.equal((await client('A','/organization?view='+view)).status,403);
   for(const action of ['org.structure.save','org.structure.request','org.preview','org.level.save','org.template.save','org.delegation.request','org.grant.revoke','org.request.decide','org.request.cancel','org.membership.remove','org.workspace.save','org.workspace.classify','org.workspace.delete','org.initialize']){
    const r=await client('A','/command',{action,data:{}});assert.equal(r.status,403,action+JSON.stringify(r.body));
   }
  }
 });
 await check('Create permission does not expose another branch through migration or impact-preview APIs',async()=>{
  grant('C',{'tasks.organization':{create:'ALLOW'}});await auth('C');
  for(const client of [web,mini]){
   const migration=await client('C','/organization?view=migration');assert.equal(migration.status,200);assert.ok(!JSON.stringify(migration.body).includes('Legacy creator test'));
   const preview=await client('C','/command',{action:'org.preview',data:{changes:[{staff_id:ids.B,level:2,manager_id:ids.A}]}});assert.equal(preview.status,200);assert.equal(preview.body.result.impact.workspaces.length,0);
   const audit=await client('C','/organization?view=audit');assert.equal(audit.status,200);assert.ok(!JSON.stringify(audit.body).includes('B Personal'));
  }
 });
 await check('Create exposes existing management controls but still requires authority, validation and revision checks',async()=>{
  grant('B',{'tasks.organization':{create:'ALLOW'}});await auth('B');
  for(const client of [web,mini]){const st=await state(client,'B');assert.equal(st.organization.me.can_manage_structure,true);assert.equal((await client('B','/organization?view=workspaces')).status,200);
   const preview=await client('B','/command',{action:'org.preview',data:{changes:[{staff_id:ids.F,level:4,manager_id:ids.E}]}});assert.equal(preview.status,200,JSON.stringify(preview.body));
   const r=await client('B','/command',{action:'org.structure.save',data:{changes:[{staff_id:ids.F,level:4,manager_id:ids.E}],expected_revision:rev(),acknowledged:true,reason:'Authorized no-op structure save'}});assert.equal(r.status,200,JSON.stringify(r.body));
   const denied=await client('B','/command',{action:'org.structure.save',data:{changes:[{staff_id:ids.C,level:3,manager_id:ids.B}],expected_revision:rev(),acknowledged:true,reason:'Outside authority'}});assert.equal(denied.status,403);
  }
 });
 console.log(`\n${checks} hierarchy/access API checks passed.`);
}finally{await Promise.all([new Promise(r=>{server.close(r);server.closeAllConnections?.();}),new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();})]);hub.close();rmSync(folder,{recursive:true,force:true});}

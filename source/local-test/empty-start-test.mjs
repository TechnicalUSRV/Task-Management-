import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {taskToday,addDays} from './task-domain.mjs';
const folder=mkdtempSync(path.join(tmpdir(),'sunny-empty-')),demoFolder=mkdtempSync(path.join(tmpdir(),'sunny-legacy-bootstrap-'));
let hub=openCompanies(folder),s=hub.primary,server,checks=0,cookie='',admin;
const port=4393,origin=`http://127.0.0.1:${port}`;
const configuration=new Set(['schema_version','ops_settings','org_settings','org_levels','org_templates','access_roles','access_permissions','erp_module_settings','tg_settings']);
const counts=store=>Object.fromEntries(store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").filter(t=>!configuration.has(t.name)).map(t=>[t.name,store.get(`SELECT count(*) n FROM ${t.name}`).n]));
const empty=store=>{for(const [name,n] of Object.entries(counts(store)))assert.equal(n,0,name+' should be empty');};
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
// Node 24's fetch keeps sockets alive; the first request after the server restarts can meet a socket the old server closed,
// so a request that fails that way (nothing was sent) is tried once more.
const send=async(url,init)=>{try{return await fetch(url,init);}catch(e){if(e?.cause?.code!=='UND_ERR_SOCKET')throw e;return fetch(url,init);}};
const request=async(route,data)=>{const r=await send(origin+'/c/default/api'+route,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
const start=async()=>{server=createLocalServer(s,port,hub);await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});};
const stop=async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections?.();});hub.close();};
try{
 await check('Normal first launch and repeated startup contain no company, users, lookups or business records',()=>{empty(s);hub.close();hub=openCompanies(folder);s=hub.primary;empty(s);assert.equal(hub.list().length,1);assert.equal(s.telegram.settings().enabled,0);});
 await start();
 await check('First-time setup is available with an empty staff list and keeps internal company setup metadata',async()=>{const r=await request('/auth/status');assert.equal(r.status,200);assert.equal(r.body.setup_required,true);assert.equal(r.body.company_setup_required,true);assert.deepEqual(r.body.staff,[]);assert.equal((await request('/state')).status,401);});
 await check('Invalid first-admin setup rolls back company, staff and account creation together',async()=>{
  for(const data of [{name:'Fresh Admin',email:'fresh@local.test',password:'short',company_name:'Fresh company'},{name:'Fresh Admin',email:'not-email',password:'Fresh-test-password',company_name:'Fresh company'},{name:'',password:'Fresh-test-password'}]){assert.equal((await request('/auth/setup',data)).status,400);empty(s);}
 });
 await check('Clean setup creates the internal company and first administrator without company or email input',async()=>{
  const r=await request('/auth/setup',{name:'Fresh Administrator',password:'Fresh-test-password'});assert.equal(r.status,200,JSON.stringify(r.body));cookie=r.cookie;admin=r.body.user;
  assert.equal(admin.role_id,'ROLE-ADMIN');assert.equal(s.get('SELECT count(*) n FROM access_users').n,1);assert.equal(s.get('SELECT count(*) n FROM lookups').n,1);assert.equal(s.get('SELECT name FROM company').name,'Task Controlling Management');assert.equal(s.get('SELECT count(*) n FROM tm_workspaces').n,0);assert.equal(s.get('SELECT count(*) n FROM tm_tasks').n,0);assert.equal(s.get('SELECT count(*) n FROM contacts').n,0);assert.equal(s.get('SELECT count(*) n FROM approval_steps').n,0);
  const state=await request('/state');assert.equal(state.status,200);assert.deepEqual(state.body.workspace_dashboard.my,[]);assert.deepEqual(state.body.organization.directory.map(p=>p.staff_id),[admin.staff_id]);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 });
 await check('Existing administrator blocks repeated bootstrap and unsolicited company-name changes',async()=>{assert.equal((await request('/auth/setup',{name:'Another',email:'another@local.test',password:'Another-password',company_name:'Overwrite'})).status,409);assert.equal(s.get('SELECT name FROM company').name,'Task Controlling Management');assert.equal(s.get('SELECT count(*) n FROM access_users').n,1);});
 await check('User-entered workspace and task persist across restart without sample records being added',async()=>{
  const created=await request('/command',{action:'tm.workspace.save',data:{kind:'PERSONAL',name:'My new project'}});assert.equal(created.status,200,JSON.stringify(created.body));const workspace=created.body.result.id;
  const task=await request('/command',{action:'tm.task.save',data:{workspace_id:workspace,title:'First entered task',description:'Verify the first entered task persists.',pic_id:admin.staff_id,start_date:taskToday(),due_date:addDays(taskToday(),7)}});assert.equal(task.status,200,JSON.stringify(task.body));
  const before=counts(s);await stop();hub=openCompanies(folder);s=hub.primary;assert.deepEqual(counts(s),before);await start();const state=await request('/state');assert.equal(state.status,200);assert.equal(state.body.tm_workspaces.length,1);assert.equal(state.body.tm_tasks[0].title,'First entered task');
 });
 await check('New secondary companies also start without placeholder master data or sample work',()=>{
  const r=hub.create({name:'Another entered company',admin_name:'Second admin',admin_email:'second@local.test',admin_password:'Second-test-password'}),second=hub.get(r.id);assert.equal(second.get('SELECT count(*) n FROM access_users').n,1);assert.equal(second.get('SELECT count(*) n FROM lookups').n,1);assert.equal(second.get('SELECT count(*) n FROM tm_workspaces').n,0);assert.equal(second.get('SELECT count(*) n FROM contacts').n,0);assert.equal(second.get('SELECT count(*) n FROM approval_steps').n,0);assert.deepEqual(second.all('PRAGMA foreign_key_check'),[]);
 });
 await check('Existing staff require an explicit identity link; normal startup preserves an existing database',()=>{
  let legacy=openCompanies(demoFolder,{demo:true});const before=counts(legacy.primary);legacy.close();legacy=openCompanies(demoFolder);try{assert.deepEqual(counts(legacy.primary),before);assert.throws(()=>legacy.primary.access.bootstrap({name:'New admin',email:'admin@local.test',password:'Another-password'}),e=>e.status===400);const u=legacy.primary.access.bootstrap({staff_id:'STAFF-003',name:'Existing administrator',email:'admin@local.test',password:'Another-password'});assert.equal(u.staff_id,'STAFF-003');assert.equal(legacy.primary.get('SELECT count(*) n FROM lookups WHERE kind=?','staff').n,3);}finally{legacy.close();}
 });
 console.log(`\n${checks} empty-start checks passed.`);
}finally{if(server?.listening)await new Promise(r=>{server.close(r);server.closeAllConnections?.();});hub.close();rmSync(folder,{recursive:true,force:true});rmSync(demoFolder,{recursive:true,force:true});}

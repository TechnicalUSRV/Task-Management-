import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'tcm-v571-')),hub=openCompanies(dir),s=hub.primary;
const port=4478,base=`http://127.0.0.1:${port}`,server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub});
const password='Test-password-2026';let checks=0,admin,cookie,member;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const post=async(route,data,session=cookie)=>{
 const r=await fetch(base+'/c/default'+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:session||''},body:JSON.stringify(data)});
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
};
const save=data=>post('/api/command',{action:'admin.user.save',data:{password,role_id:'ROLE-MEMBER',...data}});
try{
 await new Promise(r=>server.listen(port,'127.0.0.1',r));await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 await check('setup validates supplied email and rolls back incomplete registration',async()=>{
  const r=await post('/api/auth/setup',{username:'Administrator',email:'invalid',password});assert.equal(r.status,400);assert.match(r.body.error,/valid email/);
  assert.equal(s.get('SELECT COUNT(*) n FROM access_users').n,0);assert.equal(s.get('SELECT COUNT(*) n FROM company').n,0);assert.equal(s.get("SELECT COUNT(*) n FROM lookups WHERE kind='staff'").n,0);
 });
 await check('initial HTTP registration succeeds without company or contact email',async()=>{
  const r=await post('/api/auth/setup',{username:'Administrator',password});assert.equal(r.status,200,JSON.stringify(r.body));cookie=r.cookie;admin=r.body.user;
  assert.equal(admin.email,'');assert.equal(s.get('SELECT name FROM company WHERE id=1').name,'Task Controlling Management');
  assert.equal(s.access.can(admin,'admin.users','create'),true);assert.equal((await post('/api/auth/setup',{username:'Other admin',password})).status,409);
 });
 await check('multiple accounts accept missing, empty, whitespace and null contact emails',async()=>{
  for(const [name,extra] of [['Missing',{}],['Empty',{email:''}],['Whitespace',{email:'   '}],['Null',{email:null}]]){
   const r=await save({name,...extra});assert.equal(r.status,200,JSON.stringify(r.body));
   const u=s.get('SELECT * FROM access_users WHERE username=?',name);assert.equal(u.email,'');assert.equal(s.get('SELECT email FROM tm_profiles WHERE staff_id=?',u.staff_id).email,'');
   assert.equal(s.access.login(name,password,'email-optional').id,u.id);if(name==='Missing')member=s.access.publicUser(u.id);
  }
 });
 await check('provided emails retain format, length and case-insensitive uniqueness validation',async()=>{
  for(const email of ['broken','a@@example.test','a b@example.test',42,'a'.repeat(201)+'@example.test'])assert.equal((await save({name:'Bad email',email})).status,400);
  const r=await save({name:'Contact user',email:'  Contact@Example.test  '});assert.equal(r.status,200);assert.equal(s.get("SELECT email FROM access_users WHERE username='Contact user'").email,'contact@example.test');
  assert.equal((await save({name:'Duplicate email',email:'CONTACT@EXAMPLE.TEST'})).status,409);
  assert.equal((await save({name:' missing ',email:'unique@example.test'})).status,409);
 });
 await check('clearing contact email preserves identity, password and role; session revocation is unchanged',async()=>{
  const old=s.get("SELECT * FROM access_users WHERE username='Contact user'"),token=s.access.startSession(old),req={headers:{cookie:`sunny_session=${token}`}};
  const r=await save({...old,name:old.username,expected_version:old.version,email:'',password:''});assert.equal(r.status,200,JSON.stringify(r.body));
  const next=s.get('SELECT * FROM access_users WHERE id=?',old.id);for(const k of ['id','staff_id','username','role_id','password_hash'])assert.equal(next[k],old[k]);
  assert.equal(next.email,'');assert.equal(s.access.resolve(req),null);assert.equal(s.access.login(old.username,password,'changed-email').id,old.id);
 });
 await check('email-free users retain permissions, failed-login checks and company isolation',async()=>{
  const login=await post('/api/auth/login',{username:member.username,password});assert.equal(login.status,200);
  assert.equal((await post('/api/command',{action:'admin.user.save',data:{name:'Unauthorized',password,role_id:'ROLE-ADMIN'}},login.cookie)).status,403);
  assert.equal((await post('/api/auth/login',{username:member.username,password:'wrong-password'})).status,401);
  assert.equal(s.access.can(member,'tasks.tasks'),true);assert.equal(s.access.can(member,'admin.users','create'),false);
  const other=hub.create({name:'Existing company feature',admin_name:'Other administrator',admin_password:password});
  assert.equal(hub.get(other.id).get('SELECT email FROM access_users').email,'');assert.equal(hub.get(other.id).get('SELECT name FROM company WHERE id=1').name,'Existing company feature');
  assert.throws(()=>hub.get(other.id).access.login(member.username,password,'company-isolation'),e=>e.status===401);
  assert.equal(s.get('SELECT name FROM company WHERE id=1').name,'Task Controlling Management');
 });
 await check('Telegram Mini App authenticates an email-free account and enforces existing permissions',async()=>{
  const token='123456789:AAHtestTokenForTaskManagementChecks00';s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
  const signed=signInitData({auth_date:Math.floor(Date.now()/1000),user:{id:571001,first_name:'Missing'}},token),url=`http://127.0.0.1:${gateway.address().port}/c/default/tg/api`;
  const headers={Authorization:`tma ${signed}`,'Content-Type':'application/json'};
  const r=await fetch(url+'/login',{method:'POST',headers,body:JSON.stringify({username:member.username,password})});assert.equal(r.status,200,await r.text());
  const state=await fetch(url+'/state',{headers});assert.equal(state.status,200);const body=await state.json();assert.equal(body.auth.user.email,'');assert.equal(body.auth.user.staff_id,member.staff_id);
  const denied=await fetch(url+'/command',{method:'POST',headers,body:JSON.stringify({action:'admin.user.save',data:{name:'No',password,role_id:'ROLE-ADMIN'}})});assert.equal(denied.status,403);
  assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);assert.equal(s.get('PRAGMA foreign_keys').foreign_keys,1);
 });
 console.log(`\n${checks} targeted registration/account integration groups passed.`);
}finally{
 await new Promise(r=>{server.close(r);server.closeAllConnections?.();});await new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();});hub.close();rmSync(dir,{recursive:true,force:true});
}

import {cleanUsername,usernameKey,migrateIdentity,displayName} from './identity.mjs';
import {migrateContactEmail} from './access-contact-email.mjs';
import {readFileSync} from 'node:fs';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {RESOURCES,OPS_RESOURCE,roleDefaults,allowed} from './access-catalog.mjs';
import {ERP_MODULES,resourceModule,catalogFor} from './erp-registry.mjs';
import {groupLevel} from './group-domain.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const passwordHash=value=>{const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${scryptSync(value,salt,64).toString('hex')}`;};
const validPassword=(value,encoded)=>{const [,salt,hash]=encoded.split(':');const actual=scryptSync(value,salt,64),expected=Buffer.from(hash,'hex');return expected.length===actual.length&&timingSafeEqual(actual,expected);};
export function createAccess(c){
 const {db,get,all,run,insert,update,id,lookup,version,event,fail,str,choice,now}=c;
 db.exec(readFileSync(new URL('./access.sql',import.meta.url),'utf8'));
 migrateIdentity(c);
 migrateContactEmail(c);
 const catalog=new Map(RESOURCES.map(([r,,actions])=>[r,actions]));
 for(const module of ERP_MODULES)run('INSERT OR IGNORE INTO erp_module_settings(module_id,enabled) VALUES(?,1)',module.id);
 const moduleEnabled=key=>!!get('SELECT enabled FROM erp_module_settings WHERE module_id=?',key)?.enabled;
 if(!get('SELECT id FROM access_roles LIMIT 1')){
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const [key,name,kind] of [['ROLE-ADMIN','Administrator','ADMIN'],['ROLE-MANAGER','Manager','MANAGER'],['ROLE-MEMBER','Team Member','MEMBER'],['ROLE-VIEWER','Viewer','VIEWER']]){
    insert('access_roles',{id:key,name,description:kind==='ADMIN'?'Full system access. At least one active administrator is required.':`Starting ${name.toLowerCase()} permissions; customize as needed.`,protected:kind==='ADMIN'?1:0,created_at:now(),updated_at:now()});
    for(const [resource,actions] of Object.entries(roleDefaults(kind)))for(const action of actions)insert('access_permissions',{role_id:key,resource,action});
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 // V5.2: approving task requests is a new permission. The starter Manager role receives it once when an
 // earlier database is upgraded (new databases get it from the role defaults).
 if(!get('SELECT version FROM schema_version WHERE version=7')){
  db.exec('BEGIN IMMEDIATE');
  try{
   if(get("SELECT 1 AS ok FROM access_permissions WHERE role_id='ROLE-MANAGER' AND resource='tasks.tasks' AND action='update'"))run("INSERT OR IGNORE INTO access_permissions(role_id,resource,action) VALUES('ROLE-MANAGER','tasks.tasks','approve')");
   run('INSERT INTO schema_version(version) VALUES(7)');
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 // V5.4: Task Management · Groups is a new function. When an earlier database is upgraded, the starter roles receive
 // their default Group permissions once, and custom roles that can view tasks may view groups shared with them.
 if(!get('SELECT version FROM schema_version WHERE version=11')){
  db.exec('BEGIN IMMEDIATE');
  try{
   const starter={'ROLE-MANAGER':roleDefaults('MANAGER')['tasks.groups'],'ROLE-MEMBER':roleDefaults('MEMBER')['tasks.groups'],'ROLE-VIEWER':roleDefaults('VIEWER')['tasks.groups']};
   for(const r of all("SELECT id FROM access_roles WHERE id<>'ROLE-ADMIN'")){
    if(!get("SELECT 1 AS ok FROM access_permissions WHERE role_id=? AND resource='tasks.tasks' AND action='view'",r.id))continue;
    if(get("SELECT 1 AS ok FROM access_permissions WHERE role_id=? AND resource='tasks.groups'",r.id))continue;
    for(const action of starter[r.id]||['view'])run('INSERT OR IGNORE INTO access_permissions(role_id,resource,action) VALUES(?,?,?)',r.id,'tasks.groups',action);
   }
   run('INSERT INTO schema_version(version) VALUES(11)');
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 db.exec('CREATE INDEX IF NOT EXISTS access_audit_target ON access_audit(target_id,action)');
 const audit=(actor,action,target,detail='')=>insert('access_audit',{actor_id:actor||null,action,target_id:target,detail,created_at:now()});
 const publicUser=id=>get('SELECT u.id,u.staff_id,u.email,u.username,u.role_id,u.active,u.version,u.created_at,u.updated_at,l.name,r.name AS role_name FROM access_users u JOIN lookups l ON l.id=u.staff_id JOIN access_roles r ON r.id=u.role_id WHERE u.id=?',id);
 const role=key=>get('SELECT * FROM access_roles WHERE id=?',str(key,'Role',60,true))||fail('Role not found.',404);
 const rolePermissions=roleId=>{if(roleId==='ROLE-ADMIN')return roleDefaults('ADMIN');const out=Object.fromEntries(RESOURCES.map(([r])=>[r,[]]));for(const row of all('SELECT resource,action FROM access_permissions WHERE role_id=?',roleId))out[row.resource]?.push(row.action);return out;};
 const userSettings=userId=>{const out={};for(const p of all('SELECT resource,action,effect FROM access_user_permissions WHERE user_id=?',userId)){out[p.resource]??={};out[p.resource][p.action]=p.effect;}return out;};
 const normalizeSettings=input=>{if(input===undefined)return undefined;if(!input||typeof input!=='object'||Array.isArray(input))fail('Provide valid Function Settings.');const out={};for(const [resource,settings] of Object.entries(input)){if(!catalog.has(resource)||!settings||typeof settings!=='object'||Array.isArray(settings))fail('Unknown function in user settings.');for(const [action,effect] of Object.entries(settings)){if(!catalog.get(resource).includes(action)||!['ALLOW','DENY','INHERIT'].includes(effect))fail('Invalid function setting.');if(effect!=='INHERIT'){out[resource]??={};out[resource][action]=effect;}}}return out;};
 function effective(roleId,settings={}){const base=rolePermissions(roleId),enabled=new Set(all('SELECT module_id FROM erp_module_settings WHERE enabled=1').map(r=>r.module_id));return Object.fromEntries(RESOURCES.map(([r,,actions])=>{if(!enabled.has(resourceModule(r)))return [r,[]];const yes=a=>settings[r]?.[a]==='DENY'?false:settings[r]?.[a]==='ALLOW'?true:base[r]?.includes(a);return [r,yes('view')?actions.filter(yes):[]];}));}
 const memoOf=(kind,key,fn)=>c.hooks?.organization?.cached?c.hooks.organization.cached(kind,key,fn):fn();
 const permissions=u=>memoOf('permissions',`${u.id}:${u.role_id}`,()=>permissionsNow(u));
 const permissionsNow=u=>{
  const prefs=u.role_id==='ROLE-ADMIN'?{}:userSettings(u.id),out=effective(u.role_id,prefs),org=c.hooks?.organization;
  if(moduleEnabled('tasks')&&out['tasks.tasks']?.includes('view')){
   if(org?.settings().enabled){for(const action of ['view','create'])if(prefs['tasks.workspace']?.[action]!=='DENY'&&!out['tasks.workspace'].includes(action))out['tasks.workspace'].push(action);}
  }
  // Organization authority never grants platform administration or task approval/closure actions.
  if(moduleEnabled('tasks')&&org?.isLevel1(u.staff_id)){
   // Organizational Structure is an explicit function permission, even for Level 1.
   // Hierarchy determines record scope and authority only after the function is allowed.
   for(const resource of ['tasks.workspace','tasks.groups','tasks.reports'])out[resource]=catalog.get(resource)||[];
   for(const resource of ['tasks.tasks','tasks.meetings','tasks.timesheets'])if(catalog.has(resource)&&!out[resource].includes('view'))out[resource]=['view'];
  }
  if(u.role_id!=='ROLE-ADMIN')out['admin.workspaces']=[];
  return out;
 };
 const can=(u,r,a='view')=>!!u&&allowed(permissions(u),r,a);
 // Permission checks for a staff member who is not the signed-in user (for example the manager chosen for a request).
 const accountFor=staff=>memoOf('account',staff,()=>get('SELECT * FROM access_users WHERE staff_id=? AND active=1',staff));
 const canStaff=(staff,r,a='view')=>{const u=accountFor(staff);return !!u&&can(u,r,a);};
 // V5.3: everyone who can be given work or asked for a task: active logins whose role includes Task Management · Tasks,
 // whatever the role. signed_in: they have signed in to the Task Controlling Management (or set it up, or connected Telegram) at least once.
 const taskPeople=()=>all(`SELECT u.id,u.staff_id,u.role_id,l.name,COALESCE(p.department,'') AS department,COALESCE(p.position,'') AS position,
   EXISTS(SELECT 1 FROM access_audit a WHERE a.target_id=u.id AND (a.action LIKE 'Signed in%' OR (a.action='User account created' AND a.actor_id=u.staff_id))) OR EXISTS(SELECT 1 FROM tg_links k WHERE k.staff_id=u.staff_id) AS signed_in,
   EXISTS(SELECT 1 FROM tg_links k WHERE k.staff_id=u.staff_id) AS telegram
   FROM access_users u JOIN lookups l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=u.staff_id WHERE u.active=1 AND l.active=1 AND COALESCE(p.active,1)=1 ORDER BY l.name COLLATE NOCASE`)
  .filter(u=>can(u,'tasks.tasks')).map(u=>({staff_id:u.staff_id,name:u.name,department:u.department,position:u.position,signed_in:!!u.signed_in,telegram:!!u.telegram,approver:can(u,'tasks.tasks','approve')}));
 // V5.6.8: people who manage other people's team profiles (and see their contact details): Users “Update” together with
 // User accounts “Update” or Tasks “Approve” (managers and administrators).
 const profileManager=u=>can(u,'tasks.users','update')&&(can(u,'admin.users','update')||can(u,'tasks.tasks','approve'));
 const requirePermission=(u,r,a='view')=>{if(!u)fail('Sign in to continue.',401);if(!can(u,r,a))fail(`Your account does not allow ${a} for ${RESOURCES.find(x=>x[0]===r)?.[1]||r}.`,403);};
 const lastAdmin=(old,next)=>{if(old.role_id==='ROLE-ADMIN'&&old.active&&(!next.active||next.role_id!=='ROLE-ADMIN')&&!get("SELECT id FROM access_users WHERE role_id='ROLE-ADMIN' AND active=1 AND id<>?",old.id))fail('Keep at least one active Administrator account.',409);};
 const checkPassword=value=>{if(typeof value!=='string'||value.length<10||value.length>200)fail('Use a password between 10 and 200 characters.');return value;};
 const emailAddress=value=>{const email=str(value,'Contact email',200).toLowerCase();if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');return email;};
 const hasTable=name=>!!get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",name);
 function unlinkTelegram(staff,actor,why){
  if(!staff||!hasTable('tg_links'))return;
  const n=run('DELETE FROM tg_links WHERE staff_id=?',staff).changes;
  if(hasTable('tg_link_codes'))run('DELETE FROM tg_link_codes WHERE staff_id=?',staff);
  if(n)audit(actor,'Telegram account disconnected',staff,`${get('SELECT name FROM lookups WHERE id=?',staff)?.name||staff} · ${why}`);
 }
 // V5.6.8: everyone may be signed out of every device (sessions and, if asked, Telegram).
 function signOutEverywhere(user,{telegram=false}={}){
  const n=run('DELETE FROM access_sessions WHERE user_id=?',user.id).changes;
  if(telegram)unlinkTelegram(user.staff_id,user.staff_id,'signed out everywhere');
  audit(user.staff_id,'Signed out of all devices',user.id,telegram?'including Telegram':'');
  return n;
 }
 function saveUser(d,actor){
  const old=d.id?get('SELECT * FROM access_users WHERE id=?',d.id):null;if(d.id&&!old)fail('User not found.',404);if(old)version(old,d.expected_version);
  const chosenRole=role(d.role_id),email=emailAddress(d.email),active=d.active===false||d.active===0?0:1;
  const functionSettings=normalizeSettings(d.function_settings);
  if(chosenRole.id==='ROLE-ADMIN'&&functionSettings&&Object.keys(functionSettings).length)fail('Administrator access is protected. Use another role for individual overrides.');
  if(old)lastAdmin(old,{role_id:chosenRole.id,active});
  if(email&&get('SELECT id FROM access_users WHERE email=? AND id<>?',email,old?.id||''))fail('An account with this email already exists.',409);
  const name=str(cleanUsername(d.username??d.name??old?.username),'Username',200,true),normalized=usernameKey(name),staff=old?.staff_id||(d.staff_id?lookup(d.staff_id,'staff'):id('staff','STAFF'));
  if(!old&&get('SELECT id FROM access_users WHERE staff_id=?',staff))fail('This staff member already has a login account.',409);
  if(get("SELECT id FROM lookups WHERE kind='staff' AND name=? AND id<>?",name,staff))fail('Another staff member already uses this name. Add a detail, such as the department, to tell them apart.',409);
  if(old&&staff===actor&&name!==old.username)fail('Ask another administrator to change your username.',403);
  if(get('SELECT id FROM access_users WHERE username_key=? AND id<>?',normalized,old?.id||''))fail('This username is already in use. Choose a unique username.',409);
  const hash=d.password?passwordHash(checkPassword(d.password)):old?.password_hash||passwordHash(checkPassword(d.password));
  if(!old&&!d.staff_id)insert('lookups',{id:staff,kind:'staff',name,unit:'',active:1});else update('lookups',staff,{name});
  const key=old?.id||id('access-user','USER'),values={staff_id:staff,email,username:name,username_key:normalized,role_id:chosenRole.id,password_hash:hash,active,version:old?old.version+1:0,updated_at:now()};
  if(old)update('access_users',key,values);else insert('access_users',{id:key,...values,created_at:now()});
  if(functionSettings!==undefined||chosenRole.id==='ROLE-ADMIN'){
   run('DELETE FROM access_user_permissions WHERE user_id=?',key);
   for(const [resource,settings] of Object.entries(functionSettings||{}))for(const [action,effect] of Object.entries(settings))insert('access_user_permissions',{user_id:key,resource,action,effect});
  }
  const team=get('SELECT * FROM tm_profiles WHERE staff_id=?',staff);
  const teamEmail=team?.email&&(!old||team.email!==old.email)?team.email:email;
  const position=old?d.position??team?.position:d.position||team?.position,department=old?d.department??team?.department:d.department||team?.department;
  run('INSERT INTO tm_profiles(staff_id,email,position,department) VALUES(?,?,?,?) ON CONFLICT(staff_id) DO UPDATE SET email=excluded.email,position=excluded.position,department=excluded.department,version=version+1',staff,teamEmail,str(position,'Position',150),str(department,'Department',150));
  if(old&&(old.role_id!==chosenRole.id||old.username!==name||old.email!==email||d.password||!active||functionSettings!==undefined))run('DELETE FROM access_sessions WHERE user_id=?',key);
  // V5.6.8: a new password or a disabled account also ends the Telegram connection (bot and Mini App) and any connect link.
  if(old&&(d.password||!active))unlinkTelegram(staff,actor,d.password?'password changed':'account disabled');
  audit(actor,old?'User account updated':'User account created',key,`${name} · ${email} · ${chosenRole.name} · ${active?'active':'disabled'}${functionSettings!==undefined?' · Function Settings: '+JSON.stringify(functionSettings):''}`);
  return {id:key,type:'admin_user'};
 }
 function handle(action,d,actor){
  if(action==='admin.modules.save'){
   if(!d.modules||typeof d.modules!=='object'||Array.isArray(d.modules))fail('Select company modules.');
   for(const key of Object.keys(d.modules))if(!ERP_MODULES.some(m=>m.id===key))fail('Unknown Task Controlling Management module.');
   for(const m of ERP_MODULES){if(typeof d.modules[m.id]!=='boolean')fail('Set every module to enabled or disabled.');if(m.required&&!d.modules[m.id])fail(`${m.label} must stay enabled.`);if(d.modules[m.id]&&m.dependencies.some(id=>!d.modules[id]))fail(`Enable dependencies before enabling ${m.label}: ${m.dependencies.join(', ')}.`);const old=get('SELECT * FROM erp_module_settings WHERE module_id=?',m.id);version(old,d.versions?.[m.id]);}
   for(const m of ERP_MODULES)run('UPDATE erp_module_settings SET enabled=?,version=version+1 WHERE module_id=?',d.modules[m.id]?1:0,m.id);
   audit(actor,'Company modules configured','MODULES',JSON.stringify(d.modules));return {message:'Company modules updated. Existing data and saved permissions are preserved.'};
  }
  if(action==='admin.user.save')return saveUser(d,actor);
  if(action==='admin.user.disable'){
   const old=get('SELECT * FROM access_users WHERE id=?',d.id)||fail('User not found.',404);version(old,d.expected_version);lastAdmin(old,{active:0,role_id:old.role_id});
   update('access_users',old.id,{active:0,version:old.version+1,updated_at:now()});run('DELETE FROM access_sessions WHERE user_id=?',old.id);unlinkTelegram(old.staff_id,actor,'account disabled');audit(actor,'User account disabled',old.id,str(d.reason,'Reason',1000,true));return {message:'Account disabled. Staff records and history are preserved.'};
  }
  if(action==='admin.role.save'){
   const old=d.id?role(d.id):null;if(old)version(old,d.expected_version);
   if(old?.protected)fail('The Administrator role is protected. Create a custom role to change its permissions.');
   const key=old?.id||id('access-role','ROLE'),values={name:str(d.name,'Role name',150,true),description:str(d.description,'Description',2000),version:old?old.version+1:0,updated_at:now()};
   if(get('SELECT id FROM access_roles WHERE name=? COLLATE NOCASE AND id<>?',values.name,key))fail('A role with this name already exists. Choose a different name.',409);
   if(!d.permissions||typeof d.permissions!=='object'||Array.isArray(d.permissions))fail('Provide a permission matrix.');
   const perms=[];
   for(const [resource,actions] of Object.entries(d.permissions)){
    if(!catalog.has(resource)||!Array.isArray(actions))fail('Invalid permission row.');
    const unique=[...new Set(actions)];if(unique.length&&!unique.includes('view'))fail('View permission is required before granting actions in a row.');
    for(const action of unique){if(!catalog.get(resource).includes(action))fail('This permission is not supported for the selected function.');perms.push({role_id:key,resource,action});}
   }
   if(old)update('access_roles',key,values);else insert('access_roles',{id:key,...values,protected:0,created_at:now()});
   run('DELETE FROM access_permissions WHERE role_id=?',key);perms.forEach(p=>insert('access_permissions',p));
   audit(actor,old?'Role and permissions updated':'Role created',key,JSON.stringify({name:values.name,permissions:d.permissions}));return {id:key,type:'admin_role'};
  }
  if(action==='admin.role.delete'){
   const old=role(d.id);version(old,d.expected_version);if(old.protected)fail('The Administrator role cannot be deleted.');
   if(get('SELECT id FROM access_users WHERE role_id=?',old.id))fail('Reassign every account using this role before deleting it.');
   run('DELETE FROM access_roles WHERE id=?',old.id);audit(actor,'Role deleted',old.id,old.name);return {message:'Role deleted.'};
  }
  fail('Unknown Administration action.',404);
 }
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
 function bootstrap(d){return transaction(()=>{
  if(get('SELECT id FROM access_users LIMIT 1'))fail('An administrator already exists. Sign in instead.',409);
  let staff;
  if(d.staff_id)staff=lookup(d.staff_id,'staff');
  else {
   // Existing staff/history still require an explicit identity link. A genuinely empty installation has none.
   if(get("SELECT id FROM lookups WHERE kind='staff' LIMIT 1"))fail('Choose the staff identity for the first administrator.');
   staff=id('staff','STAFF');insert('lookups',{id:staff,kind:'staff',name:str(cleanUsername(d.username??d.name),'Username',200,true),unit:'',active:1});
  }
  if(!get('SELECT id FROM company WHERE id=1'))insert('company',{id:1,name:str(d.company_name,'Company name',200)||'Task Controlling Management',address:'',currency:'USD'});
  const r=saveUser({...d,staff_id:staff,role_id:'ROLE-ADMIN',active:1},staff);return publicUser(r.id);
 });}
 // V5.6.8: failed sign-ins are counted per address and email (10), per account from any address (20) and per address
 // across emails (50), each over 15 minutes.
 const LIMITS=[[k=>k.pair,10],[k=>k.account,20],[k=>k.address,50]];
 const attemptOpen=a=>a&&Date.parse(now())-Date.parse(a.window_start)<15*60000;
 function login(username,password,ip){
  const normalized=typeof username==='string'?usernameKey(username).slice(0,200):'',key=digest(`${ip}:${normalized}`);
  const keys={pair:key,account:digest(`account:${normalized}`),address:digest(`address:${ip}`)};
  for(const [pick,max] of LIMITS){const a=get('SELECT * FROM access_attempts WHERE key=?',pick(keys));if(attemptOpen(a)&&a.failures>=max)fail('Too many unsuccessful attempts. Try again in 15 minutes.',429);}
  const attempt=get('SELECT * FROM access_attempts WHERE key=?',key);
  const u=get('SELECT * FROM access_users WHERE username_key=?',normalized),input=typeof password==='string'&&password.length<=200?password:'';
  const encoded=u?.password_hash||`scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
  const verified=validPassword(input,encoded);
  if(!u||!u.active||!verified){
   for(const k of [keys.pair,keys.account,keys.address]){
    const a=k===key?attempt:get('SELECT * FROM access_attempts WHERE key=?',k),open=attemptOpen(a);
    run('INSERT INTO access_attempts(key,failures,window_start) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start',k,open?a.failures+1:1,open?a.window_start:now());
   }
   fail('Username or password is incorrect, or the account is disabled.',401);
  }
  run('DELETE FROM access_attempts WHERE key IN (?,?)',keys.pair,keys.account);audit(u.staff_id,'Signed in',u.id);return publicUser(u.id);
 }
 function startSession(user){
  run('DELETE FROM access_sessions WHERE expires_at<?',now());const token=randomBytes(32).toString('hex');insert('access_sessions',{token_hash:digest(token),user_id:user.id,expires_at:new Date(Date.now()+8*3600000).toISOString(),created_at:now()});return token;
 }
 const tokenFrom=req=>{const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sunny_session='));const token=cookie?.slice('sunny_session='.length)||'';return /^[a-f0-9]{64}$/.test(token)?token:null;};
 function resolve(req){const token=tokenFrom(req);if(!token)return null;const s=get('SELECT user_id FROM access_sessions WHERE token_hash=? AND expires_at>?',digest(token),now());if(!s)return null;const u=publicUser(s.user_id);return u?.active?u:null;}
 function logout(req){const token=tokenFrom(req);if(token)run('DELETE FROM access_sessions WHERE token_hash=?',digest(token));}
 const status=req=>{const user=resolve(req),setup=!get('SELECT id FROM access_users LIMIT 1');return {setup_required:setup,company_setup_required:setup&&!get('SELECT id FROM company WHERE id=1'),user:user||null,company_name:get('SELECT name FROM company WHERE id=1')?.name||'Task Controlling Management',staff:setup?all("SELECT id,name FROM lookups WHERE kind='staff' AND active=1"):[]};};
 const opsResource=key=>{const r=get('SELECT type FROM ops_requests WHERE id=?',str(key,'Request',60,true))||fail('Request not found.',404);return OPS_RESOURCE[r.type];};
 function authorize(user,action,d={}){
  if(!user)fail('Sign in to continue.',401);
  if(typeof action!=='string'||!d||typeof d!=='object'||Array.isArray(d))fail('Invalid command.');
  // V5.5.1: record IDs are checked exactly as the command will use them. The commands read IDs trimmed, so they are
  // trimmed here, in the request itself, before any check looks a record up (" MEET-000001" is MEET-000001: a padded ID
  // must not skip a check, for example the CRM permission a meeting linked to a CRM activity needs).
  for(const k of ['id','task_id','activity_id','meeting_id','request_id','workspace_id'])if(typeof d[k]==='string'&&d[k]!==d[k].trim())d[k]=d[k].trim();
  // V5.6.8: record IDs are text (a number, list or object where an ID belongs is refused as a bad request, never a crash).
  if(/^(tm|me|org|tg)\./.test(action))for(const [k,v] of Object.entries(d)){
   if(v===undefined||v===null||v==='')continue;
   if((k==='id'||k.endsWith('_id'))&&typeof v!=='string'&&!(k==='id'&&action==='tm.notification.read'&&Number.isSafeInteger(v)))fail('This request names a record in an invalid way.');
   if(k.endsWith('_ids')&&(!Array.isArray(v)||v.some(x=>typeof x!=='string')))fail('This request lists records in an invalid way.');
  }
  if(action.startsWith('org.')){
   requirePermission(user,'tasks.organization','create');
   // V5.6.8: workspace changes made from Organizational Structure follow the Workspace function too (a DENY stays a DENY).
   if(action==='org.workspace.save')requirePermission(user,'tasks.workspace',d.id?'update':'create');
   if(/^org\.workspace\.(delete|restore)$/.test(action))requirePermission(user,'tasks.workspace','view');
   return;
  }
  if(/^tm\.workspace\.(delete|restore|member\.(add|remove))$/.test(action)){requirePermission(user,'tasks.workspace','view');return;}
  let resource,verb;
  if(action==='admin.role.save'){resource='admin.roles';verb=d.id?'update':'create';}
  else if(action==='admin.modules.save'){resource='admin.modules';verb='update';}
  else if(action==='admin.role.delete'){resource='admin.roles';verb='delete';}
  else if(action==='admin.user.save'){resource='admin.users';verb=d.id?'update':'create';if(d.id&&(d.active===false||d.active===0))requirePermission(user,'admin.users','delete');}
  else if(action==='admin.user.disable'){resource='admin.users';verb='delete';}
  // V5.5: the Google Sheets connection's OAuth client and schedule (Administration → Google Sheets).
  else if(action==='admin.integrations.save'){resource='admin.integrations';verb='update';}
  // Your own profile (display name and photo): any signed-in person.
  else if(/^me\.(profile\.save|photo\.(save|remove)|sessions\.end)$/.test(action))return;
  // V5.3: work on a task follows the person's part in it (person in charge, supporting, reviewer, creator), not their
  // role, so these need only access to Task Management · Tasks. The task rules decide the rest. Anyone can ask anyone
  // for a task and answer the requests sent to them.
  else if(/^tm\.(task\.(accept|decline|progress|stuck|resume|submit|pass|return|close|cancel|reopen|note|handover|remind|reminders)|change\.(decide|withdraw)|due\.(request|decide|withdraw)|check\.(add|toggle|rename|move|remove)|file\.(add|remove)|request\.(save|withdraw|decide|forward)|notification\.read)$/.test(action)){resource='tasks.tasks';verb='view';}
  // V5.4 Groups: the role permission for the kind of change; the group's own sharing is checked by the group rules.
  else if(/^tm\.group\.(save|archive|delete|column\.(save|move|delete|access)|row\.(add|update|move|delete|access)|file\.(add|remove)|view\.save|layout\.save|note\.(add|edit|delete)|import\.(upload|commit))$/.test(action)){
   resource='tasks.groups';
   // V5.5: your own layout needs only View; notes (also deleting your own note) and access rules need Update; importing
   // adds records, so it needs Create.
   verb=action==='tm.group.save'?(d.id?'update':'create'):action==='tm.group.view.save'?'view':/^tm\.group\.(note|layout|row\.access|column\.access)/.test(action)?'update':/^tm\.group\.import\./.test(action)?'create':/\.(archive|delete)$/.test(action)?'delete':action==='tm.group.row.add'?'create':'update';
  }
  else if(action==='tm.profile.photo'){resource='tasks.users';verb='update';if(d.staff_id!==user.staff_id&&!profileManager(user))fail('Only managers and administrators can change other people’s photos.',403);}
  // V5.5: reporting lines decide which tasks managers can see, so administrators (User accounts “Update”) keep them.
  else if(action==='tm.profile.manager'){resource='admin.users';verb='update';}
  // V5.5 Calendar: personal notes for anyone who can open the calendar (Tasks or Meetings); asking for the reminders
  // of a meeting shared with you needs Meetings. The task rules check ownership and visibility.
  else if(/^tm\.calnote\.(save|delete)$/.test(action)){if(!can(user,'tasks.tasks')&&!can(user,'tasks.meetings'))fail('Your account does not include the calendar (Task Management · Tasks or Meetings).',403);return;}
  else if(['tm.meeting.decide','tm.meeting.withdraw','tm.meeting.follow'].includes(action)){resource='tasks.meetings';verb='view';}
  else if(action==='tm.task.save'&&d.id){
   // Editing a task: its manager or the person in charge (the task rules check which details each may change).
   resource='tasks.tasks';verb='view';
   const old=get('SELECT activity_id,related_type,related_id FROM tm_tasks WHERE id=?',d.id);
   if(old?.activity_id||(d.activity_id&&d.activity_id!==old?.activity_id))requirePermission(user,'crm.activities','update');
   if(d.related_type&&(!old||old.related_type!==d.related_type||old.related_id!==d.related_id)){const resources={CONTACT:'crm.contacts',LEAD:'crm.leads',OPPORTUNITY:'crm.opportunities',ACCOUNT:'crm.accounts',OPERATIONS:d.related_id?opsResource(d.related_id):'ops.job'};requirePermission(user,resources[d.related_type],'view');}
  }
  else if(/^tm\.(workspace\.(save|archive)|profile\.save|task\.save|time\.(save|delete)|meeting\.save)$/.test(action)){
   const area=action.split('.')[1],map={workspace:'workspace',profile:'users',task:'tasks',time:'timesheets',meeting:'meetings'};resource='tasks.'+map[area];verb=action.endsWith('.archive')||action.endsWith('.delete')?'delete':(d.id||(area==='profile'&&d.staff_id))?'update':'create';
   // V5.4: making someone else's team profile inactive (or active again) takes them out of task work and approvals, so
   // it needs Tasks "Approve" (Managers and Administrators by default), not just Users "Update".
   if(area==='profile'&&d.manager_id!==undefined&&String(d.manager_id||'')!==String(get('SELECT manager_id FROM tm_profiles WHERE staff_id=?',String(d.staff_id||''))?.manager_id||''))requirePermission(user,'admin.users','update');
   // V5.6.8: someone else's team profile (and adding a team member) is for managers and administrators; their name and
   // team email (how people are identified) are for administrators (User accounts “Update”).
   if(area==='profile'&&d.staff_id!==user.staff_id){
    if(!profileManager(user))fail(d.staff_id?'Only managers and administrators can change other people’s team profiles.':'Only managers and administrators can add team members.',403);
    const current=d.staff_id&&typeof d.staff_id==='string'?get("SELECT l.name,COALESCE(p.email,'') AS email FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=?",d.staff_id):null;
    if(current&&(String(d.name??'').trim()!==current.name||String(d.email??'').trim().toLowerCase()!==current.email.toLowerCase())&&!can(user,'admin.users','update'))fail('Only administrators (User accounts “Update”) can change someone’s name or team email.',403);
   }
   if(area==='profile'&&d.staff_id&&d.staff_id!==user.staff_id&&d.active!==undefined&&d.active!==null){
    const wanted=d.active===false||d.active===0||d.active==='0'?0:1,current=get('SELECT active FROM tm_profiles WHERE staff_id=?',String(d.staff_id))?.active??1;
    if(wanted!==current&&!can(user,'tasks.tasks','approve'))fail('Only managers and administrators (Task Management “Approve”) can make someone inactive or active again.',403);
   }
   const linkedActivity=d.activity_id||(d.id&&['task','meeting'].includes(area)?get(`SELECT activity_id FROM tm_${area==='task'?'tasks':'meetings'} WHERE id=?`,d.id)?.activity_id:null);
   if(linkedActivity)requirePermission(user,'crm.activities','update');
   if(d.related_type){const resources={CONTACT:'crm.contacts',LEAD:'crm.leads',OPPORTUNITY:'crm.opportunities',ACCOUNT:'crm.accounts',OPERATIONS:d.related_id?opsResource(d.related_id):'ops.job'};const old=d.id?get('SELECT related_type,related_id FROM tm_tasks WHERE id=?',d.id):null;if(!old||old.related_type!==d.related_type||old.related_id!==d.related_id)requirePermission(user,resources[d.related_type],'view');}
  }else if(/^admin\.telegram\.(save|group|unlink)$/.test(action)){resource='admin.telegram';verb='update';}
  else if(/^tg\.link\.(code|unlink|notify)$/.test(action)){resource='tasks.tasks';verb='view';}
  else if(action.startsWith('ops.')){
   if(['ops.receipt','ops.af.verify','ops.ap.confirm','ops.ap.pay','ops.finance.close'].includes(action)){resource='ops.finance';verb=action==='ops.receipt'?'update':'approve';}
   else if(action==='ops.settings'){resource='settings';verb='update';}
   else if(action==='ops.save'){resource=d.id?opsResource(d.id):OPS_RESOURCE[d.type];verb=d.id?'update':'create';}
   else if(action==='ops.notification.read'){const n=get('SELECT request_id FROM ops_notifications WHERE id=?',d.id)||fail('Alert not found.',404);resource=opsResource(n.request_id);verb='view';}
   else {resource=opsResource(d.id);verb=action==='ops.process'&&d.process!=='submit'?'approve':'update';}
   if(action==='ops.save'&&d.crm_quote_id)requirePermission(user,'crm.quotations','view');
   if(action==='ops.save'&&d.source_id)requirePermission(user,opsResource(d.source_id));
  }else{
   const map={'contact.save':'crm.contacts','campaign.save':'crm.campaigns','campaign.generate':'crm.leads','lead.save':'crm.leads','opportunity.save':'crm.opportunities','opportunity.close':'crm.opportunities','quotation.create':'crm.quotations','quotation.save':'crm.quotations','quotation.process':'crm.quotations','account.save':'crm.accounts','activity.save':'crm.activities','document.link':'crm.documents','order.create':'ops.legacy','order.ship':'ops.legacy','order.invoice':'ops.legacy','payment.record':'ops.legacy','settings.save':'settings','lookup.save':'settings'};
   resource=Object.hasOwn(map,action)?map[action]:undefined;verb=['settings.save','lookup.save','opportunity.close','account.save','order.ship','order.invoice','payment.record'].includes(action)?'update':action==='quotation.process'?(d.process==='submit'||d.process==='accept'||d.process==='expire'?'update':'approve'):action==='campaign.generate'||action==='quotation.create'||action==='order.create'||action==='document.link'?'create':d.id?'update':'create';
  }
  if(!resource)fail('This action is not available.',403);requirePermission(user,resource,verb);
  if(action==='admin.user.save'||action==='admin.user.disable'){
   const existing=d.id?get('SELECT id,role_id FROM access_users WHERE id=?',d.id):null;
   const manageable=(roleId,settings)=>{
    if(roleId==='ROLE-ADMIN')return user.role_id==='ROLE-ADMIN';
    if(user.role_id==='ROLE-ADMIN'||can(user,'admin.roles','update'))return true;
    return Object.entries(effective(roleId,settings)).every(([r,actions])=>actions.every(a=>can(user,r,a)));
   };
   const previous=existing?userSettings(existing.id):{},proposed=normalizeSettings(d.function_settings)??previous;
   if(existing&&!manageable(existing.role_id,previous)||d.role_id&&!manageable(d.role_id,proposed))fail('You cannot manage or assign a role with greater access than your own. Administrator accounts require an Administrator.',403);
  }
 }
 function filterState(s,user){const org=c.hooks?.organization;return org?.batch?org.batch(()=>filterStateNow(s,user)):filterStateNow(s,user);}
 function filterStateNow(s,user){
  const perms=permissions(user),v=r=>allowed(perms,r),out={...s,auth:{user,permissions:perms},erp_catalog:catalogFor(moduleEnabled),erp_module_settings:all('SELECT * FROM erp_module_settings')};
  const groups={
   'crm.contacts':['contacts'],'crm.campaigns':['campaigns'],'crm.leads':['leads'],'crm.opportunities':['opportunities','opportunity_lines','won_sales'],
   'crm.quotations':['quotations','quote_revisions','approvals','accepted_sales'],'crm.accounts':['accounts'],'crm.activities':['activities'],'crm.documents':['documents'],
   'ops.legacy':['orders','shipments','invoices','payments'],
  };
  for(const [r,tables] of Object.entries(groups))if(!v(r))for(const t of tables)out[t]=[];
  // Report pages use their authorized server report endpoint; raw module data is
  // not revealed merely because a user can see a separately scoped report.
  out.ops_requests=s.ops_requests.filter(r=>v(OPS_RESOURCE[r.type]));const opsIds=new Set(out.ops_requests.map(r=>r.id));
  for(const t of ['ops_revisions','ops_approvals','ops_files'])out[t]=s[t].filter(r=>opsIds.has(r.request_id));
  out.ops_notifications=s.ops_notifications.filter(r=>r.actor_id===user.staff_id&&opsIds.has(r.request_id));
  out.ops_jobs=s.ops_jobs.filter(r=>opsIds.has(r.id));
  for(const t of ['ops_debit_notes','ops_postings','ops_ap','ops_settlements','ops_closings'])out[t]=v('ops.finance')?s[t].filter(r=>opsIds.has(r.dn_id||r.id)):[];
  out.ops_events=s.ops_events.filter(e=>opsIds.has(e.entity_id));
  const taskAny=Object.keys(perms).some(r=>r.startsWith('tasks.')&&v(r));
  // V5.5 Task Visibility Scope: tasks and everything on them, time entries, meetings and the activity log hold only
  // what this person may see (task-scope.mjs); the role permissions below then blank whole sections.
  const sc=taskAny&&c.taskScope?c.taskScope.filterState(s,user.staff_id,{permissions:perms}):null,T=k=>sc&&sc[k]!==undefined?sc[k]:(s[k]||[]);
  out.tm_calendar_tasks=v('tasks.tasks')?T('tm_calendar_tasks'):[];
  out.tm_meeting_changes=v('tasks.meetings')?T('tm_meeting_changes'):[];
  out.tm_workspaces=T('tm_workspaces');out.tm_members=T('tm_members');out.tm_workspace_refs=T('tm_workspace_refs');
  out.organization=taskAny&&c.hooks?.organization?(v('tasks.organization')?c.hooks.organization.snapshot(user.staff_id):{enabled:!!c.hooks.organization.settings().enabled}):null;
  out.tm_task_options=v('tasks.timesheets')||v('tasks.meetings')?[...T('tm_tasks'),...(v('tasks.timesheets')&&sc?sc.tm_task_refs:[])].map(t=>({id:t.id,title:t.title,workspace_id:t.workspace_id,status:t.status})):[];
  out.tm_assignment_options=v('tasks.timesheets')?T('tm_assignees'):[];
  out.tm_notifications=[];out.tm_people=[];out.tm_calendar_notes=[];out.task_scope=sc?sc.task_scope:{company:false,team:[],involved:0};
  // V5.5: the time zone this person's calendar and dates use (their own, else the company's, else Cambodia's).
  out.my_timezone=c.taskZone?c.taskZone(user.staff_id):'Asia/Phnom_Penh';
  // V5.6.8: the sidebar colour this person chose ('' = the standard deep blue).
  out.my_sidebar_theme=c.sidebarTheme?c.sidebarTheme(user.staff_id):'';
  // V5.4 Groups: only the groups this person may open (their own, or Team groups shared with them or with their whole
  // workspace), with their access level. Rows are read separately, one group at a time.
  if(v('tasks.groups')&&s.tm_boards){
   const staff=user.staff_id,admin=allowed(perms,'tasks.groups','approve'),levels=new Map(s.tm_board_access.filter(a=>a.staff_id===staff).map(a=>[a.board_id,a.level]));
   const member=new Set(s.tm_members.filter(m=>m.staff_id===staff).map(m=>m.workspace_id));
   out.tm_boards=s.tm_boards.map(b=>({...b,level:c.groupLevel?c.groupLevel(b,staff):groupLevel(b,staff,{member:member.has(b.workspace_id),level:levels.get(b.id)||null,admin}),admin:(c.hooks?.organization?.groupContext(staff,b)?.admin??admin)&&b.visibility==='TEAM'})).filter(b=>b.level>0);
   const ids=new Set(out.tm_boards.map(b=>b.id));
   out.tm_board_access=s.tm_board_access.filter(r=>ids.has(r.board_id));
   // V5.5: rows and columns each person may see in each group (access rules apply to the counts too).
   out.tm_board_summaries=c.groupSummaries?c.groupSummaries(staff).filter(r=>ids.has(r.board_id)):[];
   // Active workspaces where this person has groups of their own (member, owner or group administrator, the same rule
   // the server uses when a group is created). The screens combine it with the role's Create permission.
   out.tm_group_workspaces=out.tm_workspaces.filter(w=>w.status==='ACTIVE'&&(c.hooks?.organization?.governed(w)?c.hooks.organization.canCreateResource(staff,w):member.has(w.id)||w.owner_id===staff||admin)).map(w=>w.id);
  }else{out.tm_boards=[];out.tm_board_access=[];out.tm_board_summaries=[];out.tm_group_workspaces=[];}
  if(!taskAny){for(const t of Object.keys(s).filter(k=>k.startsWith('tm_')))out[t]=[];}
  else {
   if(!v('tasks.workspace')){out.tm_workspaces=out.tm_workspaces.map(w=>({id:w.id,name:w.name,status:w.status,department:w.department,kind:w.kind,visibility:w.visibility,org_access:w.org_access}));if(!v('tasks.tasks')&&!v('tasks.meetings'))out.tm_members=[];}
   if(!v('tasks.users'))out.tm_profiles=s.tm_profiles.map(p=>({...p,email:'',phone:'',position:''}));
   // V5.6.8: team emails and phone numbers: your own, and everyone's for those who manage team profiles.
   else if(!profileManager(user))out.tm_profiles=s.tm_profiles.map(p=>p.staff_id===user.staff_id?p:{...p,email:'',phone:''});
   if(!v('tasks.tasks')){out.tm_tasks=[];out.tm_assignees=[];out.tm_task_history=[];out.tm_due_requests=[];out.tm_change_requests=[];out.tm_requests=[];out.tm_checklist=[];out.tm_files=[];}
   else {
    for(const k of ['tm_tasks','tm_assignees','tm_task_history','tm_checklist','tm_files','tm_change_requests','tm_due_requests'])out[k]=T(k);
    // Requests are private to the requester and the person they were sent to; an accepted request is also visible to
    // everyone who may see the task it became (V5.5: the Task Visibility Scope, also for task approvers).
    out.tm_requests=sc?T('tm_requests'):s.tm_requests.filter(q=>q.requested_by===user.staff_id||q.manager_id===user.staff_id);
    out.tm_people=v('tasks.users')?taskPeople():taskPeople().map(p=>({...p,position:''}));
   }
   out.tm_timesheets=v('tasks.timesheets')?T('tm_timesheets'):[];
   if(!v('tasks.meetings')){out.tm_meetings=[];out.tm_attendees=[];out.tm_meeting_shares=[];out.tm_meeting_followers=[];}
   else for(const k of ['tm_meetings','tm_attendees','tm_meeting_shares','tm_meeting_followers'])out[k]=T(k);
   // Notifications: your own, and only while every linked record is still visible. In particular, forwarding a
   // request must not leave its private title/body visible to the former receiver in the notification inbox.
   if(v('tasks.tasks')||v('tasks.meetings')){
    // V5.5 Calendar: personal notes and reminders are visible to their owner only.
    out.tm_calendar_notes=all('SELECT * FROM tm_calendar_notes WHERE staff_id=? ORDER BY day,start_at,id',user.staff_id);
    const taskIds=new Set(out.tm_tasks.map(t=>t.id)),meetingIds=new Set(out.tm_meetings.map(m=>m.id)),requestIds=new Set(out.tm_requests.map(q=>q.id)),noteIds=new Set(out.tm_calendar_notes.map(n=>n.id));
    out.tm_notifications=all('SELECT * FROM tm_notifications WHERE staff_id=? ORDER BY id DESC LIMIT 150',user.staff_id)
     .filter(n=>(!n.task_id||taskIds.has(n.task_id))&&(!n.meeting_id||meetingIds.has(n.meeting_id))&&(!n.request_id||requestIds.has(n.request_id))&&(!n.note_id||noteIds.has(n.note_id))&&(!n.org_request_id||(v('tasks.organization')&&c.hooks?.organization?.notificationVisible(user.staff_id,n.org_request_id)))).slice(0,100);
   }
   // Request events follow the same privacy as the requests themselves (the requester, the person asked, approvers).
   const visibleRequests=new Set((out.tm_requests||[]).map(q=>q.id));
   const profiles=profileManager(user);
   out.tm_events=T('tm_events').filter(e=>v({'task':'tasks.tasks','request':'tasks.tasks','meeting':'tasks.meetings','timesheet':'tasks.timesheets','workspace':'tasks.workspace','user':'tasks.users'}[e.entity_type])&&(e.entity_type!=='request'||visibleRequests.has(e.entity_id))&&(e.entity_type!=='user'||profiles||e.entity_id===user.staff_id));
  }
  out.workspace_dashboard=v('tasks.workspace')&&c.hooks?.organization?c.hooks.organization.workspaceDashboard(user.staff_id,out):null;
  if(sc)out.task_scope.employee_filters=c.taskScope.employeeFilters(out,user.staff_id);
  out.events=s.events.filter(e=>e.entity_type==='operations'?opsIds.has(e.entity_id):e.entity_type==='task_management'?false:v({contact:'crm.contacts',campaign:'crm.campaigns',lead:'crm.leads',opportunity:'crm.opportunities',quotation:'crm.quotations',account:'crm.accounts',activity:'crm.activities',document:'crm.documents',order:'ops.legacy',company:'settings'}[e.entity_type]));
  out.access_roles=v('admin.roles')||v('admin.users')?all('SELECT * FROM access_roles'):[];
  out.access_permissions=v('admin.roles')||v('admin.users')?all("SELECT * FROM access_permissions WHERE role_id<>'ROLE-ADMIN'").concat(RESOURCES.flatMap(([resource,,actions])=>actions.map(action=>({role_id:'ROLE-ADMIN',resource,action})))):[];
  const nicknames=new Map(s.tm_profiles.map(p=>[p.staff_id,p.nickname||'']));
  out.lookups=out.lookups.map(l=>l.kind==='staff'?{...l,username:l.name,nickname:nicknames.get(l.id)||'',name:displayName(l.name,nicknames.get(l.id))}:l);
  out.tm_people=(out.tm_people||[]).map(l=>({...l,username:l.name,nickname:nicknames.get(l.staff_id)||'',name:displayName(l.name,nicknames.get(l.staff_id))}));
  out.tm_profiles=(out.tm_profiles||[]).map(l=>({...l,username:l.name,name:displayName(l.name,l.nickname)}));
  out.access_users=v('admin.users')?all("SELECT u.id,u.staff_id,u.email,u.username,u.role_id,u.active,u.version,u.created_at,u.updated_at,l.name,COALESCE(p.position,'') AS position,COALESCE(p.department,'') AS department FROM access_users u JOIN lookups l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=u.staff_id"):[];
  out.access_audit=v('admin.roles')||v('admin.users')?all('SELECT * FROM access_audit ORDER BY id DESC LIMIT 200'):[];
  out.access_user_permissions=v('admin.users')?all('SELECT * FROM access_user_permissions'):[];
  return out;
 }
 return {signOutEverywhere,profileManager,handle,bootstrap,login,startSession,resolve,logout,status,permissions,can,canStaff,accountFor,taskPeople,requirePermission,authorize,filterState,opsResource,publicUser,moduleEnabled,rolePermissions,userSettings,effective};
}

import http from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {buildTaskReport,MONTHLY_REPORTS,PREVIEW_TYPES} from './task-domain.mjs';

// The Mini App gateway is a second, small web server meant to be published over HTTPS (for example with a
// tunnel) so Telegram can open it. It serves only the Mini App page, its static files and a task API.
// People are identified by Telegram's signed launch data (initData), checked with the company's bot token,
// and then act as their linked Task Controlling Management account: same permissions, same workflow, same database.
// V5.5.1: the calendar too (meetings, asking for a shared meeting's reminders, and personal notes); the Task Controlling Management's own rules
// decide who may do what, exactly as in the Task Controlling Management.
export const MINI_APP_ACTIONS=/^(org\.(preview|structure\.(save|request)|workspace\.(save|classify|delete|restore)|membership\.(request|remove)|delegation\.request|request\.(decide|cancel))|tm\.(workspace\.(delete|restore|member\.(add|remove))|task\.(save|accept|decline|progress|stuck|resume|submit|pass|return|close|cancel|reopen|note|handover|remind|reminders)|change\.(decide|withdraw)|request\.(save|withdraw|forward|decide)|due\.(request|decide|withdraw)|check\.(add|toggle|rename|move|remove)|file\.(add|remove)|notification\.read|meeting\.(save|follow|decide|withdraw)|time\.(save|delete)|calnote\.(save|delete))|me\.(profile\.save|photo\.(save|remove))|tg\.link\.(notify|unlink))$/;
const CSP="default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'";
const TYPES={'.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff','.svg':'image/svg+xml','.png':'image/png'};
// Task files (up to 30 MB, sent as base64) and profile photos travel in JSON bodies.
const BODY_LIMIT=43*1024*1024;
const MEDIA_HOURS=12;
const INIT_MAX_AGE=8*3600;

const check=pairs=>pairs.sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
const secretFor=token=>createHmac('sha256','WebAppData').update(token).digest();
// Validates Telegram Mini App launch data: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(raw,botToken,{maxAge=86400,now=Date.now()}={}){
 if(typeof raw!=='string'||!raw||raw.length>8192||!botToken)return null;
 const params=new URLSearchParams(raw),hash=params.get('hash');
 if(!hash||!/^[a-f0-9]{64}$/.test(hash))return null;
 const pairs=[];for(const [k,v] of params)if(k!=='hash')pairs.push([k,v]);
 const expected=createHmac('sha256',secretFor(botToken)).update(check(pairs)).digest(),given=Buffer.from(hash,'hex');
 if(given.length!==expected.length||!timingSafeEqual(given,expected))return null;
 const authDate=Number(params.get('auth_date')),age=now/1000-authDate;
 if(!Number.isFinite(authDate)||age>maxAge||age<-300)return null;
 let user;try{user=JSON.parse(params.get('user')||'null');}catch{return null;}
 if(!user||!Number.isSafeInteger(user.id)||user.is_bot)return null;
 return {user,authDate,startParam:params.get('start_param')||'',chatType:params.get('chat_type')||''};
}
// Builds signed launch data the way Telegram does (used by the automated tests and the local preview).
export function signInitData(fields,botToken){
 const pairs=Object.entries(fields).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]);
 const hash=createHmac('sha256',secretFor(botToken)).update(check([...pairs])).digest('hex');
 const p=new URLSearchParams();for(const [k,v] of pairs)p.set(k,v);p.set('hash',hash);return p.toString();
}
// Photos and files are shown with <img> and opened as links, which cannot carry Telegram's launch data. The app
// receives a signed media token instead (valid for 12 hours, for one Telegram account); it is checked like launch data.
const mediaKey=token=>createHmac('sha256','SunnyMediaAccess').update(token).digest();
// V5.6.8: `bind` ties the token to the current Telegram connection (its link time), so disconnecting Telegram — also when the
// password changes or the account is disabled — ends it at once.
export function mediaToken(companyId,tgUserId,botToken,now=Date.now(),bind=''){
 const exp=Math.floor(now/1000)+MEDIA_HOURS*3600,sig=createHmac('sha256',mediaKey(botToken)).update(`${companyId}.${tgUserId}.${exp}${bind?'.'+bind:''}`).digest('base64url');
 return `${exp}.${tgUserId}.${sig}`;
}
export function checkMediaToken(value,companyId,botToken,now=Date.now(),bind=''){
 const m=/^(\d{9,12})\.(\d{1,20})\.([A-Za-z0-9_-]{43})$/.exec(String(value||''));if(!m||!botToken)return null;
 if(Number(m[1])<now/1000)return null;
 const b=typeof bind==='function'?bind(Number(m[2])):bind;if(b===null)return null;
 const expected=createHmac('sha256',mediaKey(botToken)).update(`${companyId}.${m[2]}.${m[1]}${b?'.'+b:''}`).digest(),given=Buffer.from(m[3],'base64url');
 return given.length===expected.length&&timingSafeEqual(given,expected)?Number(m[2]):null;
}
export const miniAppUrl=(settings,companyId)=>settings?.mini_app_url?`${settings.mini_app_url}/c/${encodeURIComponent(companyId)}/tg/`:'';
// While the Task Controlling Management is shared for testing (ERP_PUBLIC_URL), the Mini App is served at that address instead of the saved one.
export const effectiveMiniAppUrl=(settings,companyId,publicUrl='')=>publicUrl?`${publicUrl}/c/${encodeURIComponent(companyId)}/tg/`:miniAppUrl(settings,companyId);

// Only Task Management data leaves through the gateway, filtered by the person's Task Controlling Management permissions.
export function miniState(store,user,media=''){
 const s=store.access.filterState(store.state(),user),tasks=new Set(s.tm_tasks.map(t=>t.id));
 return {
  company:{name:s.company.name},app_version:s.app_version,today:new Date().toISOString(),media_token:media,
  auth:{user:{staff_id:user.staff_id,name:user.name,username:user.username,role_name:user.role_name,email:user.email},permissions:Object.fromEntries(Object.entries(s.auth.permissions).filter(([k])=>k.startsWith('tasks.')))},
  lookups:s.lookups.filter(l=>l.kind==='staff').map(l=>({id:l.id,name:l.name,username:l.username,nickname:l.nickname,kind:'staff',active:l.active})),
  tm_workspaces:s.tm_workspaces,tm_workspace_refs:s.tm_workspace_refs,tm_members:s.tm_members,organization:s.organization,workspace_dashboard:s.workspace_dashboard,
  tm_tasks:s.tm_tasks,tm_assignees:s.tm_assignees,tm_timesheets:s.tm_timesheets,tm_calendar_tasks:s.tm_calendar_tasks,tm_meeting_changes:s.tm_meeting_changes,tm_requests:s.tm_requests,tm_due_requests:s.tm_due_requests,
  tm_change_requests:(s.tm_change_requests||[]).filter(c=>tasks.has(c.task_id)),
  // V5.6.8: the latest 60 history entries of every visible task (a busy task never pushes another task's history out).
  tm_task_history:(()=>{const per=new Map(),out=[];const rows=(s.tm_task_history||[]).filter(h=>tasks.has(h.task_id));for(let i=rows.length-1;i>=0;i--){const h=rows[i],n=per.get(h.task_id)||0;if(n<60){per.set(h.task_id,n+1);out.push(h);}}return out.reverse();})(),tm_notifications:s.tm_notifications.filter(n=>n.kind!=='telegram_connected'),
  tm_profiles:s.tm_profiles.map(p=>({staff_id:p.staff_id,name:p.name,nickname:p.nickname,username:p.username,department:p.department||'',position:p.position||'',active:p.active,manager_id:p.manager_id,org_level:p.org_level})),tm_people:s.tm_people,
  tm_checklist:(s.tm_checklist||[]).filter(c=>tasks.has(c.task_id)),tm_files:(s.tm_files||[]).filter(f=>tasks.has(f.task_id)),staff_photos:s.staff_photos||[],
  telegram:{bot_username:store.telegram.settings().bot_username,link:store.telegram.linkForStaff(user.staff_id)?{notify:!!store.telegram.linkForStaff(user.staff_id).notify}:null},
  // V5.5: why tasks are visible (the same Task Visibility Scope as the Task Controlling Management), and the person's time zone.
  task_scope:s.task_scope,my_timezone:s.my_timezone,
  // V5.5.1 calendar: the meetings this person may see (they take part, or it is shared with them; empty without the
  // Meetings permission) and their own notes. Nobody else's notes ever leave the server.
  tm_meetings:(s.tm_meetings||[]).map(({creation_key,...m})=>m),tm_attendees:s.tm_attendees||[],tm_meeting_shares:s.tm_meeting_shares||[],tm_meeting_followers:s.tm_meeting_followers||[],
  tm_calendar_notes:s.tm_calendar_notes||[],
  change_seq:store.changes(),
 };
}

// The request handler behind the gateway port. When the Task Controlling Management is shared for testing, the Task Controlling Management server also hands
// /c/<company>/tg/ requests to this handler, so one public address serves both the Task Controlling Management and the Mini App.
export function createTelegramGateway(options){return http.createServer(createMiniAppHandler(options));}
export function createMiniAppHandler({companies,publicDir,logger=console}){
 const hits=new Map(),failures=new Map();
 const limited=(key,max,windowMs)=>{const now=Date.now(),h=hits.get(key);if(!h||now-h.at>windowMs){hits.set(key,{at:now,n:1});return false;}h.n++;return h.n>max;};
 setInterval(()=>{const cut=Date.now()-3600000;for(const [k,v] of hits)if(v.at<cut)hits.delete(k);for(const [k,v] of failures)if(v.at<cut)failures.delete(k);},600000).unref();
 const fail=(status,error,code)=>Object.assign(new Error(error),{status,code});
 return async(req,res)=>{
  const send=(status,body,type='application/json; charset=utf-8',cache='no-store')=>{
   res.writeHead(status,{'Content-Type':type,'Cache-Control':cache,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':CSP});
   res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
  };
  try{
   const u=new URL(req.url,'http://gateway.invalid');
   if(req.method==='GET'&&u.pathname.startsWith('/assets/')){
    const root=path.join(publicDir,'assets'),file=path.resolve(root,'.'+decodeURIComponent(u.pathname.slice('/assets'.length)));
    const type=TYPES[path.extname(file).toLowerCase()];
    if(!file.startsWith(root+path.sep)||!type)throw fail(404,'Not found.');
    let body;try{if(!(await stat(file)).isFile())throw new Error();body=await readFile(file);}catch{throw fail(404,'Not found.');}
    return send(200,body,type,/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(file)?'public, max-age=31536000, immutable':'no-store');
   }
   const m=/^\/c\/([a-zA-Z0-9_-]{1,80})\/tg(\/.*)?$/.exec(u.pathname);
   if(!m)throw fail(404,'Not found.');
   const companyId=m[1],rest=m[2]||'';
   let store;try{store=companies.get(companyId);}catch{throw fail(404,'Not found.');}
   const settings=store.telegram.settings();
   if(rest===''){res.writeHead(308,{Location:`/c/${companyId}/tg/${u.search}`});return res.end();}
   if(rest==='/'&&req.method==='GET'){
    let page;try{page=await readFile(path.join(publicDir,'tg.html'));}catch{throw fail(503,'The Mini App has not been built. Run npm run build.');}
    return send(200,page,'text/html; charset=utf-8');
   }
   if(!rest.startsWith('/api/'))throw fail(404,'Not found.');
   if(!settings.enabled||!settings.bot_token)throw fail(503,'Telegram is turned off for this company.','off');
   if(req.method==='GET'&&(rest==='/api/photo'||rest==='/api/file')){
    const tgUser=checkMediaToken(u.searchParams.get('t'),companyId,settings.bot_token,Date.now(),id=>{const l=store.telegram.linkFor(id);return l?l.linked_at||'':null;}),link=tgUser?store.telegram.linkFor(tgUser):null;
    const account=link?store.access.accountFor(link.staff_id):null;
    if(!account||!store.access.can(store.access.publicUser(account.id),'tasks.tasks'))throw fail(403,'This link has expired. Open the task again in the app.','media');
    const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox"};
    if(rest==='/api/photo'){
     const photo=store.get('SELECT mime,content,version FROM staff_photos WHERE staff_id=? AND size>0',String(u.searchParams.get('staff')||'').slice(0,60));
     if(!photo)throw fail(404,'Photo not found.');
     res.writeHead(200,{...headers,'Content-Type':photo.mime,'Cache-Control':u.searchParams.get('v')===String(photo.version)?'private, max-age=86400':'no-store'});return res.end(Buffer.from(photo.content));
    }
    const file=store.get('SELECT * FROM tm_files WHERE id=?',String(u.searchParams.get('id')||'').slice(0,60));
    // V5.5: only files on tasks within this person's Task Visibility Scope.
    if(!file||!store.tasks.scope.canSee(link.staff_id,store.get('SELECT * FROM tm_tasks WHERE id=?',file.task_id)))throw fail(404,'File not found.');
    const inline=u.searchParams.get('inline')==='1'&&PREVIEW_TYPES.includes(file.mime);
    res.writeHead(200,{...headers,'Content-Type':inline?file.mime:'application/octet-stream','Cache-Control':'private, no-cache','Content-Disposition':`${inline?'inline':'attachment'}; filename="task-file"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'",'%27')}`});
    return res.end(Buffer.from(file.content));
   }
   // V5.6.8: launch data is accepted for 8 hours; after that the app is reopened from the bot (Telegram signs it again).
   const raw=String(req.headers.authorization||'').replace(/^tma /,''),init=validateInitData(raw,settings.bot_token,{maxAge:INIT_MAX_AGE});
   if(!init)throw validateInitData(raw,settings.bot_token)?fail(401,'This session has expired. Close the app and open it again from the bot.','expired'):fail(401,'Open this app from the company bot in Telegram.','auth');
   if(limited(`${companyId}:${init.user.id}`,180,60000))throw fail(429,'Too many requests. Wait a moment and try again.');
   const readBody=async()=>{
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'JSON is required.');
    const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>BODY_LIMIT)throw fail(413,'Request too large.');chunks.push(c);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'Invalid JSON.');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Invalid request.');return body;
   };
   if(rest==='/api/link'&&req.method==='POST'){
    const key=`${companyId}:${init.user.id}`,f=failures.get(key);
    if(f&&f.n>=5&&Date.now()-f.at<15*60000)throw fail(429,'Too many incorrect codes. Wait 15 minutes and create a new code in the Task Controlling Management.');
    const body=await readBody(),r=store.telegram.redeem(body.code,init.user,init.chatType==='sender'||!init.chatType?init.user.id:null);
    if(r.error){failures.set(key,{at:f&&Date.now()-f.at<15*60000?f.at:Date.now(),n:(f&&Date.now()-f.at<15*60000?f.n:0)+1});throw fail(400,r.error,'code');}
    failures.delete(key);return send(200,{ok:true,name:r.name});
   }
   // V5.3: connect by signing in with the Task Controlling Management email and password inside the Mini App (no code needed).
   if(rest==='/api/login'&&req.method==='POST'){
    const key=`${companyId}:${init.user.id}:login`,f=failures.get(key);
    if(f&&f.n>=10&&Date.now()-f.at<15*60000)throw fail(429,'Too many unsuccessful sign-ins. Wait 15 minutes and try again.');
    const body=await readBody();let signed;
    try{signed=store.access.login(body.username,body.password,`telegram:${init.user.id}`);}
    catch(e){if(e.status===401)failures.set(key,{at:f&&Date.now()-f.at<15*60000?f.at:Date.now(),n:(f&&Date.now()-f.at<15*60000?f.n:0)+1});throw e;}
    failures.delete(key);
    const r=store.telegram.connectSignedIn(signed.staff_id,init.user,init.chatType==='sender'||!init.chatType?init.user.id:null);
    if(r.error)throw fail(403,r.error,'disabled');
    return send(200,{ok:true,name:r.name});
   }
   const link=store.telegram.linkFor(init.user.id);
   if(!link)throw fail(403,'Connect your Telegram account to the Task Controlling Management first.','not_linked');
   const account=store.access.accountFor(link.staff_id);
   if(!account)throw fail(403,'Your Task Controlling Management account is disabled. Ask an administrator for help.','disabled');
   const user=store.access.publicUser(account.id);
   if(!store.access.can(user,'tasks.tasks'))throw fail(403,'Your Task Controlling Management role does not include Task Management.','no_access');
   // The open app asks every few seconds whether anything changed; that check is not counted as activity.
   if(rest==='/api/changes'&&req.method==='GET')return send(200,{seq:store.changes()});
   store.telegram.touch(init.user,null,false);
   if(rest==='/api/organization'&&req.method==='GET'){store.access.requirePermission(user,'tasks.organization');return send(200,store.organization.query(user.staff_id,Object.fromEntries(u.searchParams)));}
   if(rest==='/api/state'&&req.method==='GET')return send(200,{...miniState(store,user,mediaToken(companyId,init.user.id,settings.bot_token,Date.now(),link.linked_at||'')),company_context:{id:companyId}});
   if(rest==='/api/command'&&req.method==='POST'){
    const body=await readBody();
    if(typeof body.action!=='string'||!MINI_APP_ACTIONS.test(body.action))throw fail(403,'This action is not available in the Telegram app.');
    store.access.authorize(user,body.action,body.data);
    const result=store.command(body.action,body.data,user.staff_id,{source:'MINIAPP'});
    return send(200,{ok:true,result});
   }
   if(rest==='/api/report'&&req.method==='GET'){
    const report=u.searchParams.get('report')||'monthly',scope=u.searchParams.get('scope')||'me';
    if(!Object.hasOwn(MONTHLY_REPORTS,report))throw fail(400,'Unknown report.');
    const f={report,month:u.searchParams.get('month')||undefined};
    if(scope==='me')f.user=user.staff_id;
    else if(scope==='all'){if(!store.access.can(user,'tasks.reports'))throw fail(403,'Your role cannot view company-wide task reports.');for(const k of ['workspace','department'])if(u.searchParams.get(k))f[k]=String(u.searchParams.get(k)).slice(0,200);}
    else throw fail(400,'Unknown report scope.');
    // V5.5: reports cover only the tasks this person may see (the same Task Visibility Scope as everywhere else).
    return send(200,buildTaskReport(store.scopedState(user),f));
   }
   throw fail(404,'Not found.');
  }catch(e){
   if(!e.status){logger.error?.(e);}
   try{send(e.status||500,{error:e.status?e.message:'Unable to complete this operation. Nothing was changed.',...(e.code?{code:e.code}:{})});}catch{}
  }
 };
}

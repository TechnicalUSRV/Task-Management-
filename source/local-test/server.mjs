import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openStore, InputError } from './service.mjs';
import { buildReport, reportCSV, reportHTML, quotationHTML } from './reports.mjs';
import { APP_VERSION, APP_BUILD, DEFAULT_PORT, DEFAULT_TELEGRAM_PORT } from './version.mjs';
import { buildOpsReport, opsReportHTML, opsDocumentHTML } from './operations-reports.mjs';
import { buildTaskReport, PREVIEW_TYPES } from './task-domain.mjs';
import { taskReportHTML } from './task-reports.mjs';
import {openCompanies} from './company-hub.mjs';
import {buildDashboard} from './dashboard.mjs';
import {buildERPReport,reportOptions,sourceRecords,displayValue} from './erp-sources.mjs';
import {createTelegramRuntime} from './telegram-bot.mjs';
import {createMiniAppHandler,effectiveMiniAppUrl} from './telegram-gateway.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
// JSON bodies carry base64 files of up to 30 MB (about 40 MB encoded) plus form fields.
const BODY_LIMIT=43*1024*1024;
const STATIC_TYPES={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
// Checks an address given in ERP_PUBLIC_URL: the https:// origin that forwards to this computer while it is shared.
export function publicOrigin(value){
 if(!value)return '';
 let u;try{u=new URL(String(value).trim());}catch{throw new Error('ERP_PUBLIC_URL must be an address such as https://name.trycloudflare.com');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(u.pathname&&u.pathname!=='/'))throw new Error('ERP_PUBLIC_URL must be an https:// address with no path, for example https://name.trycloudflare.com');
 return u.origin;
}
// options.publicUrl: the Task Controlling Management is shared for testing at this HTTPS address (a tunnel to this computer). Requests
// for that host are accepted as well as localhost; its cookies are Secure; first-run setup stays local-only; and
// options.miniApp serves the Telegram Mini App under /c/<company>/tg/ on the same address.
export function createLocalServer(defaultStore,port=DEFAULT_PORT,companies=null,options={}) {
 const telegramPort=options.telegramPort??DEFAULT_TELEGRAM_PORT;
 const publicUrl=publicOrigin(options.publicUrl),publicHost=publicUrl?new URL(publicUrl).host:'';
 const origin=`http://127.0.0.1:${port}`, allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,...(publicHost?[publicHost]:[])]);
 const origins=new Set([origin,`http://localhost:${port}`,...(publicUrl?[publicUrl]:[])]);
 const miniApp=publicUrl?options.miniApp:null;
 const buckets=new Map();
 const commandLimited=key=>{const now=Date.now(),b=buckets.get(key)||{tokens:120,at:now};b.tokens=Math.min(120,b.tokens+(now-b.at)*0.005);b.at=now;if(b.tokens<1){buckets.set(key,b);return true;}b.tokens-=1;buckets.set(key,b);if(buckets.size>5000)for(const [k,v] of buckets)if(now-v.at>600000)buckets.delete(k);return false;};
 return http.createServer(async(req,res)=>{
   const send=(status,body,type='application/json; charset=utf-8',cache='no-store')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':cache,'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
   try {
     if(!allowedHosts.has(req.headers.host))throw new InputError('Open this app on localhost.',403);
     const remote=!!publicHost&&req.headers.host===publicHost;
     if(miniApp&&/^\/c\/[a-zA-Z0-9_-]{1,80}\/tg(?:[/?]|$)/.test(req.url||''))return await miniApp(req,res);
     const u=new URL(req.url,origin);
     const scope=/^\/c\/([a-zA-Z0-9_-]+)(\/.*)$/.exec(u.pathname),companyId=scope?.[1]||'default';
     if(scope)u.pathname=scope[2];
     if(!companies&&companyId!=='default')throw new InputError('Company not found.',404);
     const store=companies?companies.get(companyId):defaultStore,cookieName=scope?`sunny_session_${companyId}`:'sunny_session';
     const rawCookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));
     const authRequest={headers:{cookie:rawCookie?'sunny_session='+rawCookie.slice(cookieName.length+1):''}};
     const access=store.access,user=access.resolve(authRequest),requireAccess=(resource,action='view')=>access.requirePermission(user,resource,action);
     const companyList=()=>companies?companies.list():[{id:'default',name:store.state().company?.name||'New company'}];
     const cookie=token=>res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${scope?'/c/'+companyId+'/':'/'}; Max-Age=${token?28800:0}${remote?'; Secure':''}`);
     // V5.5 Google Sheets: the address Google sends people back to after they allow access (it must be registered in the
     // Google Cloud console exactly), and Google Drive change notifications (from Google's servers, so no Origin header).
     const prefix=scope?`/c/${companyId}`:'',redirectUri=`${remote?publicUrl:`http://${req.headers.host}`}${prefix}/api/google/callback`;
     if(req.method==='POST'&&u.pathname==='/api/google/notify'){
       for await(const chunk of req){if(chunk.length>65536)break;}
       store.sync.notify(req.headers);res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return;
     }
     if(req.method==='GET'&&u.pathname==='/api/google/callback'){
       const browser=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sunny_goauth='))?.slice('sunny_goauth='.length)||'';
       let r;try{r=await store.sync.finishAuth({code:u.searchParams.get('code'),state:u.searchParams.get('state'),error:u.searchParams.get('error'),browser},redirectUri);}catch(e){r={ok:false,message:e.message||'Google could not be connected.'};}
       res.setHeader('Set-Cookie',`sunny_goauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${remote?'; Secure':''}`);
       const esc=t=>String(t).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
       const page=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Google Sheets · Task Controlling Management</title><style>body{font-family:system-ui,sans-serif;background:#f4f7fb;color:#162033;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #dbe3ef;border-radius:12px;padding:28px 32px;max-width:440px}h1{font-size:20px;margin:0 0 8px}p{line-height:1.5}a{color:#1d4ed8;font-weight:600}</style></head><body><main><h1>${r.ok?'Google is connected':'Google was not connected'}</h1><p>${esc(r.ok?`Connected as ${r.email||'your Google account'}. Return to the Task Controlling Management to choose the spreadsheet and start the sync.`:r.message)}</p><p><a href="${prefix}/">Return to the Task Controlling Management</a></p></main></body></html>`;
       send(r.ok?200:400,page,'text/html; charset=utf-8');return;
     }
     if(req.method==='POST') {
       const from=String(req.headers.origin||'');
       if(!origins.has(from)||from.replace(/^https?:\/\//,'')!==req.headers.host)throw new InputError('This local action requires the app’s own page.',403);
       if(!['/api/command','/api/auth/setup','/api/auth/login','/api/auth/logout','/api/companies','/api/erp/report','/api/erp/report.export','/api/erp/report.csv','/api/tasks/group/import/preview','/api/google'].includes(u.pathname))throw new InputError('Route not found.',404);
       if(!req.headers['content-type']?.startsWith('application/json'))throw new InputError('JSON is required.',415);
       // Reject oversized uploads before reading them. For bodies without a declared length, keep
       // reading (and discarding) so the browser receives the 413 message instead of a reset connection.
       const tooLarge=()=>{res.setHeader('Connection','close');return new InputError('Request too large. Files must be 30 MB or smaller.',413);};
       if(Number(req.headers['content-length']||0)>BODY_LIMIT)throw tooLarge();
       const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size<=BODY_LIMIT)chunks.push(chunk);}
       if(size>BODY_LIMIT)throw tooLarge();
       let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('Invalid JSON.');}
       if(!body||typeof body!=='object'||Array.isArray(body))throw new InputError('Invalid request.');
       if(u.pathname==='/api/auth/setup'&&remote)throw new InputError(`Create the first administrator on the computer that runs the Task Controlling Management (http://127.0.0.1:${port}), then share it.`,403);
       if(u.pathname==='/api/auth/setup'||u.pathname==='/api/auth/login'){
         // Through Cloudflare every request arrives from this computer; its CF-Connecting-IP header names the real device.
         // V5.6.8: the header is trusted only from the tunnel running on this computer (a loopback connection).
         const local=/^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress||''));
         const ip=remote&&local&&req.headers['cf-connecting-ip']?String(req.headers['cf-connecting-ip']).slice(0,64):req.socket.remoteAddress;
         const signedIn=u.pathname.endsWith('/setup')?access.bootstrap(body):access.login(body.username,body.password,ip);
         cookie(access.startSession(signedIn));send(200,{ok:true,user:signedIn});return;
       }
       if(u.pathname==='/api/auth/logout'){access.logout(authRequest);cookie('');send(200,{ok:true});return;}
       if(u.pathname==='/api/companies'){
         requireAccess('admin.companies','create');
         if(!companies||companyId!=='default'||user.role_id!=='ROLE-ADMIN')throw new InputError('Create companies using an Administrator account in the original company.',403);
         const result=companies.create(body);store.insert('access_audit',{actor_id:user.staff_id,action:'Company created',target_id:result.id,detail:result.name,created_at:new Date().toISOString()});send(200,{ok:true,result});return;
       }
       // V5.5: Google Sheets actions that talk to Google (connect, choose a spreadsheet, preview, sync now…). Each one checks
       // that the person manages the group; the browser never receives tokens or secrets.
       if(u.pathname==='/api/google'){
         requireAccess('tasks.groups','view');
         const r=await store.sync.request(user,body,{redirectUri});
         if(body.action==='connect'){res.setHeader('Set-Cookie',`sunny_goauth=${r.browser}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900${remote?'; Secure':''}`);send(200,{ok:true,url:r.url});return;}
         send(200,{ok:true,result:r});return;
       }
       // V5.5: what an Excel import would do (rows added, updated, skipped and every problem), without saving anything.
       if(u.pathname==='/api/tasks/group/import/preview'){
         requireAccess('tasks.groups','create');
         send(200,store.tasks.groups.imports.preview(body.import_id,user.staff_id,body.plan));return;
       }
       if(u.pathname.startsWith('/api/erp/report')){
         const report=buildERPReport(store,user,body,u.pathname!=='/api/erp/report');
         if(u.pathname.endsWith('.csv')){
           res.setHeader('Content-Disposition','attachment; filename="Sunny-Task Controlling Management-Report.csv"');
           const columns=[['source_label','Data source'],...report.columns];const csv={...report,columns:columns.map(([,label],i)=>['column'+i,label]),rows:report.rows.map(row=>Object.fromEntries(columns.map(([key],i)=>['column'+i,displayValue(row,key,report.currency)])))};
           send(200,reportCSV(csv),'text/csv; charset=utf-8');
         }else send(200,report);
         return;
       }
       // V5.6.8: a burst of up to 120 changes, then about five a second, per signed-in person.
       if(user&&commandLimited(`${companyId}:${user.id}`))throw new InputError('Too many changes in a short time. Wait a moment and try again.',429);
       access.authorize(user,body.action,body.data);
       const result=store.command(body.action,body.data,user.staff_id);
       send(200,{ok:true,result});return;
     }
     if(req.method!=='GET')throw new InputError('Method not allowed.',405);
     if(u.pathname==='/api/auth/status'){send(200,{...access.status(authRequest),company_id:companyId,companies:companyList()});return;}
     if(u.pathname==='/api/companies'){send(200,companyList());return;}
     if(u.pathname==='/api/version'){send(200,{version:APP_VERSION,build:APP_BUILD});return;}
     if(u.pathname.startsWith('/api/')&&!user)throw new InputError('Sign in to continue.',401);
     if(u.pathname==='/api/changes'){send(200,{seq:store.changes()});return;}
     if(u.pathname==='/api/state'){
       const telegram=access.can(user,'tasks.tasks')||access.can(user,'admin.telegram')?store.telegram.info(user,access.can(user,'admin.telegram'),effectiveMiniAppUrl(store.telegram.settings(),companyId,miniApp?publicUrl:''),!!miniApp):{};
       if(telegram.telegram_admin)telegram.telegram_admin.gateway={port:telegramPort,local_url:`http://127.0.0.1:${telegramPort}`,path:`/c/${companyId}/tg/`,running:options.telegramRunning?.()??false,shared_url:publicUrl};
       const sharing=publicUrl&&(access.can(user,'admin.telegram')||access.can(user,'admin.users'))?{sharing:{url:publicUrl}}:{};
       send(200,{...access.filterState(store.state(),user),...telegram,...sharing,company_context:{id:companyId},companies:companyList(),change_seq:store.changes()});return;
     }
     if(u.pathname==='/api/erp/report-options'){send(200,reportOptions(store,user));return;}
     if(u.pathname==='/api/google/config'){requireAccess('admin.integrations');send(200,store.sync.publicConfig(redirectUri));return;}
     if(u.pathname==='/api/erp/dashboard'||u.pathname==='/api/erp/source'){
       let filters={};try{filters=JSON.parse(u.searchParams.get('filters')||'{}');}catch{throw new InputError('Invalid filters.');}
       if(!filters||typeof filters!=='object'||Array.isArray(filters))throw new InputError('Invalid filters.');
       send(200,u.pathname.endsWith('/dashboard')?buildDashboard(store,user,filters):sourceRecords(store,user,filters));return;
     }
     if(u.pathname==='/api/journey'){
       requireAccess('crm.contacts');const journey=store.journey(u.searchParams.get('contact'));
       const scope={contact:'crm.contacts',campaign:'crm.campaigns',lead:'crm.leads',opportunity:'crm.opportunities',quotation:'crm.quotations',account:'crm.accounts',activity:'crm.activities',document:'crm.documents',order:'ops.legacy'};
       journey.events=journey.events.filter(e=>{
         if(e.entity_type==='operations')return e.entity_id==='SETTINGS'?false:access.can(user,access.opsResource(e.entity_id));
         if(e.entity_type==='task_management'){
           const kind=store.get('SELECT entity_type FROM tm_events WHERE entity_id=? LIMIT 1',e.entity_id)?.entity_type;
           if(!access.can(user,'tasks.'+({task:'tasks',meeting:'meetings',timesheet:'timesheets',user:'users',workspace:'workspace'}[kind]||'')))return false;
           // V5.5: tasks, meetings and time entries in a customer's history follow the Task Visibility Scope too.
           const sc=store.tasks.scope,staff=user.staff_id,taskOk=id=>{const t=id?store.get('SELECT * FROM tm_tasks WHERE id=?',id):null;return !!t&&sc.canSee(staff,t);};
           if(kind==='task')return taskOk(e.entity_id);
           if(kind==='meeting'){const m=store.get('SELECT * FROM tm_meetings WHERE id=?',e.entity_id);return !!m&&sc.canSeeMeeting(staff,m);}
           if(kind==='timesheet'){const x=store.get('SELECT staff_id,task_id FROM tm_timesheets WHERE id=?',e.entity_id);return !!x&&(x.staff_id===staff||taskOk(x.task_id));}
           return kind==='user'||kind==='workspace';
         }
         return access.can(user,scope[e.entity_type]||'');
       });
       if(!access.can(user,'crm.opportunities'))journey.won_sales=[];
       if(!access.can(user,'crm.quotations'))journey.accepted_sales=[];
       send(200,journey);return;
     }
     // V5.3: profile photos (any signed-in person) and task files (people who can view tasks).
     if(u.pathname==='/api/organization'){requireAccess('tasks.organization');send(200,store.organization.query(user.staff_id,Object.fromEntries(u.searchParams)));return;}
     if(u.pathname==='/api/photo'){
       const photo=store.get('SELECT mime,content,version FROM staff_photos WHERE staff_id=? AND size>0',String(u.searchParams.get('staff')||'').slice(0,60));
       if(!photo)throw new InputError('Photo not found.',404);
       res.writeHead(200,{'Content-Type':photo.mime,'Cache-Control':u.searchParams.get('v')===String(photo.version)?'private, max-age=31536000, immutable':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"});
       res.end(Buffer.from(photo.content));return;
     }
     // Groups (V5.4, V5.5): one group (its columns as this person may see them, their layout and the first page of rows),
     // further pages (search, filters, sorting and paging are done here), the notes on a row, the people who may be
     // chosen in it, and the Excel export. The group rules decide who may open each group and see each row and column;
     // reading never changes anything.
     if(u.pathname.startsWith('/api/tasks/group')&&['/api/tasks/group','/api/tasks/group/rows','/api/tasks/group/notes','/api/tasks/group/note-history','/api/tasks/group/members','/api/tasks/group/audience','/api/tasks/group/import','/api/tasks/group/file','/api/tasks/group.xlsx'].includes(u.pathname)){
       requireAccess('tasks.groups',u.pathname.endsWith('.xlsx')?'export':'view');
       const groups=store.tasks.groups,key=String(u.searchParams.get('id')||'').slice(0,60),p=Object.fromEntries(u.searchParams);
       if(u.pathname==='/api/tasks/group'){send(200,groups.read(key,user.staff_id,p));return;}
       if(u.pathname==='/api/tasks/group/rows'){send(200,groups.query(key,user.staff_id,p));return;}
       if(u.pathname==='/api/tasks/group/notes'){send(200,groups.notes(key,user.staff_id,p));return;}
       if(u.pathname==='/api/tasks/group/note-history'){send(200,groups.noteHistory(key,user.staff_id,p.note));return;}
       if(u.pathname==='/api/tasks/group/members'){send(200,groups.members(key,user.staff_id,{q:u.searchParams.get('q')||'',offset:u.searchParams.get('offset'),limit:u.searchParams.get('limit')}));return;}
       if(u.pathname==='/api/tasks/group/audience'){send(200,groups.audience(key,user.staff_id));return;}
       if(u.pathname==='/api/tasks/group/import'){send(200,groups.imports.describe(p.import,user.staff_id));return;}
       // V5.6.9: a file in an Attachment cell (images open in the browser with inline=1; everything else downloads).
       if(u.pathname==='/api/tasks/group/file'){
         const f=groups.file(key,user.staff_id,u.searchParams.get('file')),inline=u.searchParams.get('inline')==='1'&&[...PREVIEW_TYPES,'application/pdf'].includes(f.mime);
         res.writeHead(200,{'Content-Type':inline?f.mime:'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename="group-file"; filename*=UTF-8''${encodeURIComponent(f.name).replaceAll("'",'%27')}`,
          'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',...(f.mime==='application/pdf'&&inline?{}:{'Content-Security-Policy':"default-src 'none'; sandbox"})});
         res.end(Buffer.from(f.content));return;
       }
       const file=groups.xlsx(key,user.staff_id,p);
       res.setHeader('Content-Disposition',`attachment; filename="group.xlsx"; filename*=UTF-8''${encodeURIComponent(file.name.replace(/[\\/:*?"<>|]+/g,'-')+'.xlsx').replaceAll("'",'%27')}`);
       send(200,file.buffer,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return;
     }
     if(u.pathname==='/api/tasks/file'){
       requireAccess('tasks.tasks');
       const file=store.get('SELECT * FROM tm_files WHERE id=?',String(u.searchParams.get('id')||'').slice(0,60));
       // V5.5: only files on tasks within this person's Task Visibility Scope.
       if(!file||!store.tasks.scope.canSee(user.staff_id,store.get('SELECT * FROM tm_tasks WHERE id=?',file.task_id)))throw new InputError('File not found.',404);
       const inline=u.searchParams.get('inline')==='1'&&PREVIEW_TYPES.includes(file.mime);
       res.writeHead(200,{'Content-Type':inline?file.mime:'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename="task-file"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'",'%27')}`,
        'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; sandbox"});
       res.end(Buffer.from(file.content));return;
     }
     if(u.pathname==='/api/ops/file'){
       const file=store.get('SELECT * FROM ops_files WHERE id=?',u.searchParams.get('id')||'');
       if(!file)throw new InputError('File not found.',404);
       requireAccess(access.opsResource(file.request_id),'export');
       res.setHeader('Content-Disposition',`attachment; filename="supporting-document"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'",'%27')}`);
       send(200,Buffer.from(file.content),'application/octet-stream');return;
     }
     if(u.pathname==='/api/ops/revision'){
       requireAccess(access.opsResource(u.searchParams.get('id')));
       const row=store.get('SELECT snapshot_json FROM ops_revisions WHERE request_id=? AND revision=?',u.searchParams.get('id')||'',Number(u.searchParams.get('revision')));
       if(!row)throw new InputError('Revision not found.',404);send(200,JSON.parse(row.snapshot_json));return;
     }
     if(u.pathname==='/api/ops/document.print'){requireAccess(access.opsResource(u.searchParams.get('id')),'export');send(200,opsDocumentHTML(store,u.searchParams.get('id'),u.searchParams.get('revision')),'text/html; charset=utf-8');return;}
     if(['/api/ops/report','/api/ops/report.csv','/api/ops/report.print'].includes(u.pathname)){
       requireAccess('reports.operations',u.pathname==='/api/ops/report'?'view':'export');
       const kind=u.searchParams.get('report')||'jobs',action=u.pathname.endsWith('/report')?'view':'export';
       for(const resource of (['jobs','closed'].includes(kind)?['ops.job','ops.finance']:['ops.finance']))requireAccess(resource,action);
       const report=buildOpsReport(store.state(),Object.fromEntries(u.searchParams));
       if(u.pathname.endsWith('.csv')){res.setHeader('Content-Disposition',`attachment; filename="Sunny-${report.id}.csv"`);send(200,reportCSV(report),'text/csv; charset=utf-8');}
       else if(u.pathname.endsWith('.print'))send(200,opsReportHTML(report),'text/html; charset=utf-8');
       else send(200,report);return;
     }
     if(['/api/report','/api/report.csv','/api/report.print'].includes(u.pathname)) {
       requireAccess('reports.crm',u.pathname==='/api/report'?'view':'export');
       requireAccess(['04','05','06'].includes(u.searchParams.get('report'))?'crm.activities':'crm.opportunities',u.pathname==='/api/report'?'view':'export');
       const report=buildReport(store.state(),Object.fromEntries(u.searchParams));
       if(u.pathname==='/api/report.csv'){res.setHeader('Content-Disposition',`attachment; filename="CRM-RPT-${report.id}.csv"`);send(200,reportCSV(report),'text/csv; charset=utf-8');}
       else if(u.pathname==='/api/report.print')send(200,reportHTML(report),'text/html; charset=utf-8');
       else if(u.pathname==='/api/report')send(200,report);
       else throw new InputError('Route not found.',404);
       return;
     }
     if(['/api/tasks/report','/api/tasks/report.csv','/api/tasks/report.print'].includes(u.pathname)){
       requireAccess('tasks.reports',u.pathname==='/api/tasks/report'?'view':'export');
       const kind=u.searchParams.get('report')||'tasks',action=u.pathname.endsWith('/report')?'view':'export';
       const needs={tasks:['tasks.tasks','tasks.timesheets'],time:['tasks.timesheets'],meetings:['tasks.meetings'],workload:['tasks.tasks','tasks.timesheets'],workspace:['tasks.workspace','tasks.tasks','tasks.timesheets'],monthly:['tasks.tasks'],monthly_completed:['tasks.tasks'],monthly_progress:['tasks.tasks'],monthly_stuck:['tasks.tasks'],monthly_overdue:['tasks.tasks']};
       if(!Object.hasOwn(needs,kind))throw new InputError('Unknown task report.',400);
       for(const resource of needs[kind]||[])requireAccess(resource,action);
       // V5.5: task reports cover only what this person may see (permissions and the Task Visibility Scope).
       const report=buildTaskReport(store.scopedState(user),Object.fromEntries(u.searchParams));
       if(u.pathname.endsWith('.csv')){res.setHeader('Content-Disposition',`attachment; filename="Tasks-${report.id}.csv"`);send(200,reportCSV(report),'text/csv; charset=utf-8');}
       else if(u.pathname.endsWith('.print'))send(200,taskReportHTML(report),'text/html; charset=utf-8');else send(200,report);return;
     }
     if(u.pathname==='/api/quotation.print'){requireAccess('crm.quotations','export');send(200,quotationHTML(store,u.searchParams.get('id'),u.searchParams.get('revision')),'text/html; charset=utf-8');return;}
     if(u.pathname==='/print.js'){send(200,"document.getElementById('print').addEventListener('click',()=>window.print());",'application/javascript; charset=utf-8');return;}
     if(u.pathname.startsWith('/api/'))throw new InputError('Route not found.',404);
     let decoded;try{decoded=decodeURIComponent(u.pathname);}catch{throw new InputError('This address is not valid.',400);}
     const publicRoot=path.join(root,'public');
     const target=path.resolve(publicRoot,decoded==='/'?'index.html':'.'+decoded);
     if(!target.startsWith(publicRoot+path.sep))throw new InputError('Not found.',404);
     let file;try{if(!(await stat(target)).isFile())throw new Error();file=await readFile(target);}catch{throw new InputError('Page not found. Build or extract the local app first.',404);}
     // Built asset names contain a content hash, so browsers may keep them; every page load still fetches index.html.
     const hashed=decoded.startsWith('/assets/')&&/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(decoded);
     send(200,file,STATIC_TYPES[path.extname(target).toLowerCase()]||'application/octet-stream',hashed?'public, max-age=31536000, immutable':'no-store');
   }catch(e){if(!(e instanceof InputError)&&!e.status)console.error(e);send(e.status||500,{error:e.status?e.message:'Unable to complete this operation. Your saved data has been preserved.',...(e.status&&e.details?{details:e.details}:{})});}
 });
}
// Opens the browser on this computer. Some security software stops programs from starting others; then the
// address is printed instead.
export function openBrowser(url){
 try{
  const child=process.platform==='win32'?spawn('cmd',['/c','start','',url],{stdio:'ignore'}):spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});
  child.on('error',()=>{});child.unref();return true;
 }catch{return false;}
}

// Starts the Task Controlling Management on this computer: the web app, and unless telegram is false, the Telegram bots and the Mini App
// gateway. Resolves once it is listening (rejects with a readable message, for example when the port is taken).
// share.mjs calls this in the same process, with publicUrl set to the temporary HTTPS address.
export function startERP({port=DEFAULT_PORT,telegramPort=DEFAULT_TELEGRAM_PORT,telegram=true,publicUrl='',open=false,dataDir=path.join(root,'data'),publicDir=path.join(root,'public'),log=console.log,warn=console.error}={}){
 return new Promise((resolve,reject)=>{
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('ERP_LOCAL_PORT must be 1024–65535.');
  const shared=publicOrigin(publicUrl);
  const companies=openCompanies(dataDir);
  // Telegram: a bot for each company that turns it on (Administration → Telegram) and a Mini App gateway
  // on a second local port that can be published over HTTPS.
  let gatewayUp=false,closing=null;
  const miniApp=telegram?createMiniAppHandler({companies,publicDir}):null;
  const server=createLocalServer(companies.primary,port,companies,{telegramPort,telegramRunning:()=>gatewayUp,publicUrl:shared,miniApp});
  const runtime=telegram?createTelegramRuntime({companies,appUrlFor:(id,store)=>effectiveMiniAppUrl(store.telegram.settings(),id,shared)}):null;
  const gateway=miniApp?http.createServer(miniApp):null;
  if(gateway){
    gateway.on('error',e=>warn(e.code==='EADDRINUSE'?`Telegram Mini App port ${telegramPort} is in use; the Mini App gateway is unavailable${shared?' (the shared address still serves the Mini App)':''}. Set ERP_TELEGRAM_PORT to another port.`:e.message));
    gateway.listen(telegramPort,'127.0.0.1',()=>{gatewayUp=true;});
  }
  // Due date reminders (Task Controlling Management bell and Telegram) for every company: shortly after start, then every 10 minutes.
  const remind=()=>{let list=[];try{list=companies.list();}catch{return;}for(const {id} of list){try{companies.get(id).reminders();}catch(e){warn(`Reminders for ${id}: ${e.message}`);}}};
  const reminderStart=setTimeout(remind,15000),reminderTimer=setInterval(remind,600000);reminderStart.unref();reminderTimer.unref();
  // V5.5: meeting and calendar reminders are checked every minute (each is sent once, see tasks.mjs eventReminders).
  const events=()=>{let list=[];try{list=companies.list();}catch{return;}for(const {id} of list){try{companies.get(id).eventReminders();}catch(e){warn(`Calendar reminders for ${id}: ${e.message}`);}}};
  const eventTimer=setInterval(events,60000);eventTimer.unref();
  // V5.5: Google Sheets connections that are due (each has its own interval), every 5 seconds.
  let syncing=false;
  const syncTick=async()=>{if(syncing)return;syncing=true;try{let list=[];try{list=companies.list();}catch{return;}for(const {id} of list){try{await companies.get(id).sync.tick({publicUrl:shared,notifyPath:id==='default'?'/api/google/notify':`/c/${id}/api/google/notify`});}catch(e){warn(`Google Sheets for ${id}: ${e.message}`);}}}finally{syncing=false;}};
  const syncTimer=setInterval(()=>void syncTick(),Number(process.env.ERP_SYNC_TICK_MS||5000));syncTimer.unref();
  const stop=()=>closing||(closing=(async()=>{
    clearTimeout(reminderStart);clearInterval(reminderTimer);clearInterval(eventTimer);clearInterval(syncTimer);
    await runtime?.stop().catch(()=>{});gateway?.close();
    await new Promise(done=>{server.close(()=>done());server.closeAllConnections?.();setTimeout(done,3000).unref();});
    companies.close();
  })());
  server.once('error',e=>{gateway?.close();void runtime?.stop().catch(()=>{});companies.close();reject(new Error(e.code==='EADDRINUSE'?`Port ${port} is already in use. Close the other Task Controlling Management window, or set ERP_LOCAL_PORT to another port.`:e.message));});
  server.listen(port,'127.0.0.1',()=>{
    const url=`http://127.0.0.1:${port}`;
    log(`\n${APP_VERSION} · ${APP_BUILD}\nOpen ${url}\nData: ${path.join(dataDir,'erp.sqlite')}${telegram?(shared?'':`\nTelegram Mini App gateway: http://127.0.0.1:${telegramPort} (publish it over HTTPS; see READ_ME_FIRST.txt)`):'\nTelegram: off (ERP_TELEGRAM=off)'}${shared?`\nShared for testing at ${shared}${telegram?' (Task Controlling Management and Telegram Mini App)':''}`:''}\nPress Ctrl+C to stop.\n`);
    runtime?.start();
    if(open&&!openBrowser(url))log(`Open ${url} in your browser.`);
    resolve({url,publicUrl:shared,server,stop});
  });
 });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 // ERP_PUBLIC_URL: the https:// address that forwards here while the Task Controlling Management is shared (your own tunnel or proxy).
 startERP({port:Number(process.env.ERP_LOCAL_PORT||DEFAULT_PORT),telegramPort:Number(process.env.ERP_TELEGRAM_PORT||DEFAULT_TELEGRAM_PORT),
  telegram:process.env.ERP_TELEGRAM!=='off',publicUrl:process.env.ERP_PUBLIC_URL||'',open:process.argv.includes('--open')})
  .then(erp=>{for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{setTimeout(()=>process.exit(0),4000).unref();void erp.stop().then(()=>process.exit(0));});})
  .catch(e=>{console.error(e.message);process.exitCode=1;});
}

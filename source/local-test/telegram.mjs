import {isPersonalWorkspace} from './workspace-privacy.mjs';
import {readFileSync} from 'node:fs';
import {randomInt,createHash} from 'node:crypto';

// Store-side Telegram data for one company: bot settings, the link between a Telegram user and an Task Controlling Management
// login, groups linked to workspaces, and short conversation steps. Task data itself is never stored here.
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// V5.3: connect links do not expire. Each works once, and creating a new one replaces the old one.
const NEVER='9999-12-31T23:59:59.999Z';
export const TOKEN_PATTERN=/^\d{5,16}:[A-Za-z0-9_-]{20,80}$/;
const digest=v=>createHash('sha256').update(String(v)).digest('hex');
export const normalizeCode=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

export function createTelegram(c){
 const {db,get,all,run,insert,update,lookup,version,fail,str,integer,now,changed=()=>{}}=c;
 db.exec(readFileSync(new URL('./telegram.sql',import.meta.url),'utf8'));
 if(!all('PRAGMA table_info(tg_link_codes)').some(col=>col.name==='code'))run('ALTER TABLE tg_link_codes ADD COLUMN code TEXT');
 const settings=()=>get('SELECT * FROM tg_settings WHERE id=1');
 const audit=(actor,action,detail='')=>insert('access_audit',{actor_id:actor||null,action,target_id:'TELEGRAM',detail,created_at:now()});
 const nameOf=staff=>get('SELECT name FROM lookups WHERE id=?',staff)?.name||staff;
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const log=(level,chat,message)=>{
  insert('tg_log',{level,chat_id:chat??null,message:String(message).slice(0,1000),created_at:now()});
  run('DELETE FROM tg_log WHERE id<=(SELECT id FROM tg_log ORDER BY id DESC LIMIT 1 OFFSET 300)');
 };
 const miniAppBase=value=>{
  const raw=str(value,'Mini App address',300);if(!raw)return '';
  let u;try{u=new URL(raw);}catch{fail('Enter the public HTTPS address of the Mini App gateway, for example https://tasks.example.com');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(u.pathname&&u.pathname!=='/'))fail('The Mini App address must be an https:// address with no path, for example https://tasks.example.com (Telegram only opens Mini Apps over HTTPS).');
  return u.origin;
 };

 function handle(action,d,actor){
  if(action==='admin.telegram.save'){
   const old=settings();version(old,d.expected_version);
   let token=old.bot_token;
   if(d.clear_token===true)token='';
   else if(typeof d.bot_token==='string'&&d.bot_token.trim()){token=d.bot_token.trim();if(!TOKEN_PATTERN.test(token))fail('Paste the bot token exactly as @BotFather shows it: numbers, a colon, then letters and numbers.');}
   const enabled=d.enabled===true||d.enabled===1?1:0;
   if(enabled&&!token)fail('Add the bot token before turning Telegram on.');
   const hour=d.digest_hour===undefined?old.digest_hour:integer(d.digest_hour,-1,23,'daily reminder time');
   const changedToken=token!==old.bot_token;
   const values={enabled,bot_token:token,mini_app_url:d.mini_app_url===undefined?old.mini_app_url:miniAppBase(d.mini_app_url),digest_hour:hour,group_updates:d.group_updates===false||d.group_updates===0?0:1,
    status:!enabled?'OFF':changedToken||old.status==='OFF'?'STARTING':old.status,status_detail:!enabled?'':changedToken?'Connecting to Telegram…':old.status_detail,version:old.version+1,updated_at:now()};
   // A different bot starts from its own first update; people and groups stay linked to the company.
   if(changedToken)Object.assign(values,{bot_id:null,bot_username:'',bot_name:'',last_update_id:0,last_notification_id:-1,last_history_id:-1});
   update('tg_settings',1,values);
   audit(actor,'Telegram settings updated',`${enabled?'On':'Off'}${changedToken?' · bot token changed':''} · Mini App ${values.mini_app_url||'not set'} · reminders ${hour<0?'off':hour+':00'}`);
   return {message:enabled?'Telegram settings saved. The bot connects within a few seconds.':'Telegram settings saved. The bot is off.'};
  }
  if(action==='admin.telegram.group'){
   const chat=Number(d.chat_id),g=Number.isSafeInteger(chat)?get('SELECT * FROM tg_groups WHERE chat_id=?',chat):null;if(!g)fail('Telegram group not found.',404);
   if(d.expected_version!==undefined)version(g,d.expected_version);
   let workspace=null;
   if(d.workspace_id){const w=get('SELECT * FROM tm_workspaces WHERE id=?',str(d.workspace_id,'Workspace',60,true))||fail('Workspace not found.',404);if(w.status!=='ACTIVE')fail('Choose an active workspace.');if(c.organization?.governed(w)&&(!c.organization.canManageWorkspace(actor,w)||isPersonalWorkspace(w)))fail('Personal or unauthorized workspaces cannot be linked to a Telegram group.',403);workspace=w.id;}
   update2(g.chat_id,{workspace_id:workspace,notify:d.notify===false||d.notify===0?0:1,linked_by:workspace?actor:null,linked_at:workspace?now():null,version:g.version+1});
   audit(actor,workspace?'Telegram group linked':'Telegram group unlinked',`${g.title} (${g.chat_id})${workspace?' → '+workspace:''}`);
   return {message:workspace?'Group linked to the workspace.':'Group unlinked.'};
  }
  if(action==='admin.telegram.unlink'){
   const staff=lookup(d.staff_id,'staff'),link=get('SELECT * FROM tg_links WHERE staff_id=?',staff);
   if(!link)return {message:'This person is not connected to Telegram.'};
   run('DELETE FROM tg_links WHERE staff_id=?',staff);audit(actor,'Telegram account disconnected',`${nameOf(staff)} · Telegram user ${link.tg_user_id}`);
   return {message:`${nameOf(staff)} is no longer connected to Telegram.`};
  }
  if(action==='tg.link.code'){
   const s=settings();
   if(!s.enabled||!s.bot_username)fail('Telegram is not connected yet. Ask an administrator to connect the company bot in Administration → Telegram.',409);
   // Keep the current link unless a new one is asked for (for example because the old one was shared by mistake).
   const current=d.renew===true?null:get('SELECT * FROM tg_link_codes WHERE staff_id=? AND code IS NOT NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1',actor,now());
   if(current)return {message:'Your connect link is ready.',...linkInfo(current.code,s,current.created_at)};
   run('DELETE FROM tg_link_codes WHERE expires_at<? OR staff_id=?',now(),actor);
   let code='';for(let i=0;i<8;i++)code+=CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
   const created=now();
   insert('tg_link_codes',{code_hash:digest(code),staff_id:actor,expires_at:NEVER,created_at:created,code});
   if(d.renew===true)audit(actor,'Telegram connect link replaced',nameOf(actor));
   return {message:d.renew===true?'New connect link created. The previous one no longer works.':'Your connect link is ready. It works once and does not expire.',...linkInfo(code,s,created)};
  }
  if(action==='tg.link.unlink'){
   const n=run('DELETE FROM tg_links WHERE staff_id=?',actor).changes;
   run('DELETE FROM tg_link_codes WHERE staff_id=?',actor);
   if(n)audit(actor,'Telegram account disconnected',nameOf(actor));
   return {message:n?'Telegram disconnected from your account.':'Your account is not connected to Telegram.'};
  }
  if(action==='tg.link.notify'){
   const link=get('SELECT * FROM tg_links WHERE staff_id=?',actor)||fail('Connect Telegram first.',409);
   run('UPDATE tg_links SET notify=? WHERE tg_user_id=?',d.notify===false||d.notify===0?0:1,link.tg_user_id);
   return {message:d.notify===false||d.notify===0?'Telegram messages turned off. You can still use the bot.':'Telegram messages turned on.'};
  }
  fail('Unknown Telegram action.',404);
 }
 const linkInfo=(code,s,created)=>({code,link:`https://t.me/${s.bot_username}?start=link_${code}`,bot_username:s.bot_username,created_at:created});
 const update2=(chat,values)=>{const keys=Object.keys(values);run(`UPDATE tg_groups SET ${keys.map(k=>k+'=?').join(',')} WHERE chat_id=?`,...keys.map(k=>values[k]),chat);};

 // ---------------------------------------------------------------- used by the bot and the Mini App gateway
 // Returns {staff} or {error}. A code links one Telegram account to the Task Controlling Management login that created it.
 function redeem(input,from,chatId){
  const code=normalizeCode(input);
  if(code.length!==8)return {error:'That link code is not valid. Open the Task Controlling Management → your name (top right) → Connect Telegram to see your personal link.'};
  const result=transaction(()=>{
   const row=get('SELECT * FROM tg_link_codes WHERE code_hash=?',digest(code));
   if(!row||row.expires_at<now())return {error:'That link code is not valid: it may be mistyped, already used or replaced by a newer link. Open the Task Controlling Management → your name (top right) → Connect Telegram to see your current link.'};
   run('DELETE FROM tg_link_codes WHERE code_hash=?',row.code_hash);
   return attach(row.staff_id,from,chatId,'connect link');
  });
  if(result.staff)changed();
  return result;
 }
 // Connects a Telegram account to an Task Controlling Management login (after a connect link, or after signing in with the Task Controlling Management email and
 // password in the Mini App). A Telegram account belongs to one login and a login to one Telegram account.
 function attach(staff,from,chatId,how){
  if(!get('SELECT id FROM access_users WHERE staff_id=? AND active=1',staff))return {error:'This Task Controlling Management account is disabled. Ask an administrator for help.'};
  run('DELETE FROM tg_links WHERE tg_user_id=? OR staff_id=?',from.id,staff);
  run('DELETE FROM tg_link_codes WHERE staff_id=?',staff);
  insert('tg_links',{tg_user_id:from.id,staff_id:staff,chat_id:chatId??null,username:String(from.username||'').slice(0,64),first_name:String(from.first_name||'').slice(0,128),notify:1,linked_at:now(),last_seen_at:now()});
  audit(staff,'Telegram account connected',`${nameOf(staff)} · Telegram user ${from.id}${from.username?' (@'+from.username+')':''} · ${how}`);
  // A note in the Task Controlling Management bell, so a connection nobody expected is noticed (connect links do not expire).
  const who=from.username?'@'+String(from.username).slice(0,64):String(from.first_name||'A Telegram account').slice(0,128);
  insert('tm_notifications',{staff_id:staff,kind:'telegram_connected',title:'Telegram connected',body:`${who} now uses your Task Controlling Management account in Telegram (${how==='connect link'?'with your connect link':'signed in with your Task Controlling Management password'}). If this was not you, open your name → My profile → Telegram and disconnect it.`,actor_id:staff,created_at:now()});
  return {staff,name:nameOf(staff)};
 }
 function connectSignedIn(staff,from,chatId){const r=transaction(()=>attach(staff,from,chatId,'signed in with the Task Controlling Management password in the Telegram app'));if(r.staff)changed();return r;}
 const linkFor=tgUser=>get('SELECT * FROM tg_links WHERE tg_user_id=?',tgUser)||null;
 const linkForStaff=staff=>get('SELECT * FROM tg_links WHERE staff_id=?',staff)||null;
 function touch(from,chatId,isPrivate){
  const link=linkFor(from.id);if(!link)return null;
  run('UPDATE tg_links SET username=?,first_name=?,last_seen_at=?,chat_id=COALESCE(?,chat_id) WHERE tg_user_id=?',String(from.username||'').slice(0,64),String(from.first_name||'').slice(0,128),now(),isPrivate?chatId:null,from.id);
  return {...link,chat_id:isPrivate?chatId:link.chat_id};
 }
 function seenGroup(chat,active=1){
  const title=String(chat.title||'Telegram group').slice(0,200),old=get('SELECT * FROM tg_groups WHERE chat_id=?',chat.id);
  if(old)run('UPDATE tg_groups SET title=?,type=?,active=?,seen_at=? WHERE chat_id=?',title,chat.type,active,now(),chat.id);
  else insert('tg_groups',{chat_id:chat.id,title,type:chat.type,active,seen_at:now()});
  return get('SELECT * FROM tg_groups WHERE chat_id=?',chat.id);
 }
 function linkGroup(chatId,workspace,actor){
  const w=get("SELECT * FROM tm_workspaces WHERE id=? AND status='ACTIVE'",workspace);if(!w||c.organization?.governed(w)&&(!c.organization.canManageWorkspace(actor,w)||isPersonalWorkspace(w)))return null;
  run('UPDATE tg_groups SET workspace_id=?,linked_by=?,linked_at=?,active=1,version=version+1 WHERE chat_id=?',w.id,actor,now(),chatId);
  audit(actor,'Telegram group linked',`${get('SELECT title FROM tg_groups WHERE chat_id=?',chatId)?.title||chatId} → ${w.name}`);
  changed();return w;
 }
 function unlinkGroup(chatId,actor){run('UPDATE tg_groups SET workspace_id=NULL,linked_by=NULL,linked_at=NULL,version=version+1 WHERE chat_id=?',chatId);audit(actor,'Telegram group unlinked',String(chatId));changed();}
 function migrateGroup(from,to){
  if(get('SELECT chat_id FROM tg_groups WHERE chat_id=?',to))run('DELETE FROM tg_groups WHERE chat_id=?',from);
  else run('UPDATE tg_groups SET chat_id=? WHERE chat_id=?',to,from);
  run('DELETE FROM tg_sessions WHERE chat_id=?',from);
 }
 const session={
  get(chat,user){const s=get('SELECT * FROM tg_sessions WHERE chat_id=? AND tg_user_id=?',chat,user);if(!s)return null;if(s.expires_at<now()){run('DELETE FROM tg_sessions WHERE chat_id=? AND tg_user_id=?',chat,user);return null;}let data={};try{data=JSON.parse(s.data);}catch{}return {...s,data};},
  set(chat,user,flow,step,data={},ids={}){run('INSERT INTO tg_sessions(chat_id,tg_user_id,flow,step,data,message_id,prompt_id,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,tg_user_id) DO UPDATE SET flow=excluded.flow,step=excluded.step,data=excluded.data,message_id=excluded.message_id,prompt_id=excluded.prompt_id,expires_at=excluded.expires_at',chat,user,flow,step,JSON.stringify(data),ids.message_id??null,ids.prompt_id??null,new Date(Date.now()+20*60000).toISOString());},
  clear(chat,user){run('DELETE FROM tg_sessions WHERE chat_id=? AND tg_user_id=?',chat,user);},
 };
 const setStatus=(status,detail='')=>{
  const old=settings(),text=String(detail).slice(0,500);
  run('UPDATE tg_settings SET status=?,status_detail=?,checked_at=? WHERE id=1',status,text,now());
  if(old.status!==status||old.status_detail!==text)changed();
 };

 // ---------------------------------------------------------------- what the Task Controlling Management screens receive
 // shared: the Task Controlling Management is shared for testing, so appUrl is the temporary public address even if none is saved.
 function info(user,canAdmin,appUrl,shared=false){
  const s=settings(),link=linkForStaff(user.staff_id),hasApp=!!appUrl&&(shared||!!s.mini_app_url);
  const code=!link&&s.enabled&&s.bot_username?get('SELECT code,created_at FROM tg_link_codes WHERE staff_id=? AND code IS NOT NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1',user.staff_id,now()):null;
  const out={telegram:{enabled:!!s.enabled,status:s.status,bot_username:s.bot_username,app_url:s.enabled&&hasApp?appUrl:'',link:link?{username:link.username,first_name:link.first_name,linked_at:link.linked_at,notify:!!link.notify}:null,
   connect:code?linkInfo(code.code,s,code.created_at):null}};
  if(canAdmin){
   out.telegram_admin={
    settings:{enabled:!!s.enabled,token_set:!!s.bot_token,token_hint:s.bot_token?'…'+s.bot_token.slice(-4):'',bot_username:s.bot_username,bot_name:s.bot_name,mini_app_url:s.mini_app_url,app_url:hasApp?appUrl:'',shared,digest_hour:s.digest_hour,group_updates:!!s.group_updates,status:s.status,status_detail:s.status_detail,checked_at:s.checked_at,version:s.version},
    links:all('SELECT k.staff_id,l.name,k.username,k.first_name,k.notify,k.linked_at,k.last_seen_at FROM tg_links k JOIN lookups l ON l.id=k.staff_id ORDER BY l.name'),
    groups:all('SELECT g.chat_id,g.title,g.type,g.workspace_id,w.name AS workspace,g.notify,g.active,g.linked_at,g.seen_at,g.version FROM tg_groups g LEFT JOIN tm_workspaces w ON w.id=g.workspace_id ORDER BY g.active DESC,g.title').filter(g=>!g.workspace_id||!c.organization||c.organization.canViewWorkspace(user.staff_id,get('SELECT * FROM tm_workspaces WHERE id=?',g.workspace_id))).map(g=>({...g,chat_id:String(g.chat_id)})),
    log:all('SELECT * FROM tg_log ORDER BY id DESC LIMIT 30'),
    // V5.5: what happened to each notification on Telegram (no task titles: only the kind, the person and the outcome).
    deliveries:{since:new Date(Date.now()-7*86400000).toISOString(),
     summary:all("SELECT status,COUNT(*) AS n FROM tm_notification_deliveries WHERE channel='TELEGRAM' AND updated_at>? GROUP BY status",new Date(Date.now()-7*86400000).toISOString()),
     recent:all("SELECT d.notification_id,d.status,d.reason,d.attempts,d.updated_at,n.kind,l.name FROM tm_notification_deliveries d JOIN tm_notifications n ON n.id=d.notification_id JOIN lookups l ON l.id=n.staff_id WHERE d.channel='TELEGRAM' ORDER BY d.updated_at DESC,d.notification_id DESC LIMIT 30")},
   };
  }
  return out;
 }
 return {handle,settings,redeem,connectSignedIn,linkFor,linkForStaff,touch,seenGroup,linkGroup,unlinkGroup,migrateGroup,session,setStatus,log,info,transaction};
}

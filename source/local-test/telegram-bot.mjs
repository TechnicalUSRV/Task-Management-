import {isPersonalWorkspace} from './workspace-privacy.mjs';
import {enrichedTasks,taskActions,taskBlock,taskStateLabel,OPEN_TASK_STATUSES,REQUEST_STATUS,RECURRENCE_SHORT,taskToday,addDays,daysBetween,localDay,monthlyTaskRows,currentMonth,monthBounds,shiftMonth,
 approvalTarget,completionApprover,twoSided,CHANGE_KIND} from './task-domain.mjs';
import {normalizeCode} from './telegram.mjs';

// The Telegram bot is another screen for Task Management. It reads and writes through the same store,
// permissions (access.authorize) and workflow rules as the Task Controlling Management web app; it keeps no task data of its own.
export const TELEGRAM_API=process.env.TELEGRAM_API_BASE||'https://api.telegram.org';
const OPEN=`('NOT_STARTED','IN_PROGRESS','IN_REVIEW')`;
// V5.6.8: work in a deleted workspace is hidden everywhere (lists, counts, the morning summary), as in the Task Controlling Management.
const LIVE=w=>`${w} NOT IN (SELECT id FROM tm_workspaces WHERE deleted_at IS NOT NULL)`;
const esc=v=>String(v??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const clip=(v,n)=>{const s=String(v??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};
const DAY=new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
const fmtDay=d=>d?DAY.format(new Date(`${d}T12:00:00Z`)):'—';
const relDay=d=>{const n=daysBetween(taskToday(),d);return n===0?'today':n===1?'tomorrow':n===-1?'yesterday':n>0?`in ${n} days`:`${-n} days ago`;};
const bar=p=>{const n=Math.max(0,Math.min(10,Math.round(Number(p||0)/10)));return '▰'.repeat(n)+'▱'.repeat(10-n);};
const ICON={'Awaiting acceptance':'🆕','Accepted':'⚪','Not started':'⚪','In progress':'🔵','In review':'🟣','Completed':'✅','Cancelled':'✖️','Stuck':'🔴','Rejected':'🟠'};
const NOTE_ICON={task_assigned:'🆕',task_supporting:'🤝',task_reviewer:'🔎',task_accepted:'👍',task_declined:'🟠',task_progress:'📈',task_stuck:'🔴',task_resumed:'▶️',task_submitted:'📤',task_returned:'↩️',task_closed:'✅',task_cancelled:'✖️',task_reopened:'🔁',task_note:'💬',task_updated:'✏️',
 step_completed:'☑️',meeting_reminder:'📅',note_reminder:'📝',meeting_invited:'📅',meeting_updated:'📅',meeting_cancelled:'✖️',
 support_accepted:'🤝',support_declined:'🟠',review_accepted:'🔎',review_declined:'🟠',task_reminder:'🔔',task_repeat:'🔁',task_file:'📎',task_due_soon:'⏰',task_overdue:'⚠️',
 request_new:'🙋',request_approved:'✅',request_declined:'🟠',request_forwarded:'👥',request_withdrawn:'🗑',due_new:'📅',due_approved:'📅',due_declined:'📅',
 change_request:'🟡',change_approved:'✅',change_rejected:'↩️',change_withdrawn:'🗑',task_passed:'➡️'};
// Notifications that ask the person to accept or reject the task.
const ANSWER_KINDS=['task_assigned','task_supporting','task_reviewer','task_reminder','task_repeat'];
const button=(text,data)=>({text,callback_data:data});
const rows=(list,per=2)=>{const out=[];for(let i=0;i<list.length;i+=per)out.push(list.slice(i,i+per));return out;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PER_PAGE=8,PEOPLE_PAGE=12,MAX_FILE=30*1024*1024;
const TASK_ID=/\b([A-Z]{2,8}-\d{6,12})\b/;
// V5.3: connect links no longer expire, and people can also sign in with their Task Controlling Management email and password in the Mini App.
const linkHelp=app=>`To use me, connect this Telegram account to your Task Controlling Management login. You only do this once:\n\n• In the Task Controlling Management, click your name (top right) → <b>Connect Telegram</b>, then tap <b>Open Telegram</b> (or scan the QR code with your phone).\n• Or send me <code>/link CODE</code> with the code shown there.${app?'\n• Or tap <b>Sign in with your Task Controlling Management account</b> below and use your Task Controlling Management email and password.':''}\n\nYour personal link does not expire. It works once, and only for you.`;
const PRIVATE_COMMANDS=[['menu','Main menu'],['answer','Tasks waiting for your answer'],['mytasks','Tasks you are in charge of'],['supporting','Tasks you support'],['review','Work waiting for your decision'],['requests','Your task requests'],['newtask','Create a task'],['request','Ask someone for a task'],['report','Monthly task report'],['task','Open a task by its ID'],['help','How to use this bot'],['unlink','Disconnect this Telegram account']];
const GROUP_COMMANDS=[['tasks','Open tasks in this workspace'],['mytasks','Your tasks in this workspace'],['newtask','Create a task here'],['request','Ask someone for a task'],['report','Monthly report for this workspace'],['connect','Link this group to a workspace (administrators and workspace owners)'],['help','How to use the bot here']];

export function parseCommand(text,botUsername){
 const m=/^\/([a-zA-Z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(String(text||'').trim());
 if(!m)return null;
 if(m[2]&&botUsername&&m[2].toLowerCase()!==botUsername.toLowerCase())return {other:true};
 return {cmd:m[1].toLowerCase(),args:(m[3]||'').trim(),addressed:!!m[2]};
}
// Accepts 2026-10-05, 5/10/2026 or 5-10 (day first, as written in Cambodia), today, tomorrow or +3.
export function parseDay(input){
 const t=String(input||'').trim().toLowerCase(),today=taskToday();
 const ok=v=>{const d=new Date(`${v}T12:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v?v:null;},pad=n=>String(n).padStart(2,'0');
 if(t==='today')return today;if(t==='tomorrow')return addDays(today,1);
 let m=/^\+(\d{1,3})(?:\s*d(?:ays?)?)?$/.exec(t);if(m)return addDays(today,Number(m[1]));
 m=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);if(m)return ok(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
 m=/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
 if(m){let y=m[3]?Number(m[3].length===2?'20'+m[3]:m[3]):Number(today.slice(0,4));let v=ok(`${y}-${pad(m[2])}-${pad(m[1])}`);if(v&&!m[3]&&v<addDays(today,-31))v=ok(`${y+1}-${pad(m[2])}-${pad(m[1])}`);return v;}
 return null;
}

export function createTelegramRuntime({companies,apiBase=TELEGRAM_API,logger=console,supervisorMs=4000,outboxMs=2500,pollTimeout=25,appUrlFor}={}){
 const bots=new Map();let timer=null;
 function supervise(){
  let list=[];try{list=companies.list();}catch(e){logger.error?.(e);}
  for(const {id} of list){
   let store;try{store=companies.get(id);}catch{continue;}
   const s=store.telegram.settings(),want=!!s.enabled&&!!s.bot_token,bot=bots.get(id);
   if(want&&(!bot||bot.token!==s.bot_token)){bot?.stop();bots.set(id,createBot({companyId:id,store,token:s.bot_token,apiBase,logger,outboxMs,pollTimeout,appUrl:()=>appUrlFor?appUrlFor(id,store):''}));}
   else if(!want&&bot){bot.stop();bots.delete(id);store.telegram.setStatus('OFF','');}
   else if(want&&bot)bot.refresh();
  }
 }
 return {
  start(){supervise();timer=setInterval(supervise,supervisorMs);timer.unref?.();return this;},
  supervise,
  bot:id=>bots.get(id),
  async stop(){clearInterval(timer);timer=null;await Promise.all([...bots.values()].map(b=>b.stop()));bots.clear();},
 };
}

export function createBot({companyId,store,token,apiBase=TELEGRAM_API,logger=console,outboxMs=2500,pollTimeout=25,appUrl=()=>''}){
 const tg=store.telegram,ac=store.access,controller=new AbortController();
 let stopped=false,me=null,menuFor=null,flushing=false,loop=null;
 const linkFailures=new Map();
 void companyId;

 // ---------------------------------------------------------------- Telegram API
 async function api(method,params={},timeout=15000){
  const res=await fetch(`${apiBase}/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)])});
  let body;try{body=await res.json();}catch{throw Object.assign(new Error(`Telegram answered with HTTP ${res.status}.`),{code:res.status});}
  if(!body.ok)throw Object.assign(new Error(body.description||`Telegram error ${res.status}`),{code:body.error_code||res.status,retryAfter:body.parameters?.retry_after,migrateTo:body.parameters?.migrate_to_chat_id});
  return body.result;
 }
 async function call(method,params){
  try{return await api(method,params);}
  catch(e){
   if(e.code===429&&e.retryAfter&&e.retryAfter<=30&&!stopped){await sleep(e.retryAfter*1000);return api(method,params);}
   if(e.migrateTo&&params.chat_id){tg.migrateGroup(params.chat_id,e.migrateTo);return api(method,{...params,chat_id:e.migrateTo});}
   throw e;
  }
 }
 // Files: downloaded from Telegram (photos and documents people send), and uploaded when someone asks for a task file.
 async function download(filePath){
  const res=await fetch(`${apiBase}/file/bot${token}/${filePath}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
  if(!res.ok)throw new Error(`Telegram answered with HTTP ${res.status}.`);
  let size=0;const chunks=[];for await(const part of res.body){size+=part.length;if(size>MAX_FILE)throw Object.assign(new Error('too large'),{tooLarge:true});chunks.push(Buffer.from(part));}return Buffer.concat(chunks);
 }
 async function upload(method,chat,field,file,extra={}){
  const form=new FormData();form.set('chat_id',String(chat));
  for(const [k,v] of Object.entries(extra))if(v!==undefined)form.set(k,typeof v==='string'?v:JSON.stringify(v));
  form.set(field,new Blob([file.content],{type:file.mime}),file.name);
  const res=await fetch(`${apiBase}/bot${token}/${method}`,{method:'POST',body:form,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
  let body;try{body=await res.json();}catch{throw Object.assign(new Error(`Telegram answered with HTTP ${res.status}.`),{code:res.status});}
  if(!body.ok)throw Object.assign(new Error(body.description||`Telegram error ${res.status}`),{code:body.error_code||res.status});
  return body.result;
 }
 const html=(text,extra={})=>({text:clip2(text),parse_mode:'HTML',link_preview_options:{is_disabled:true},...extra});
 const clip2=t=>t.length>4000?t.slice(0,3990)+'…':t;
 async function send(ctxOrChat,view,extra={}){
  const ctx=typeof ctxOrChat==='object'?ctxOrChat:null,chat=ctx?ctx.chatId:ctxOrChat;
  const params={chat_id:chat,...html(view.text),...(view.keyboard?{reply_markup:{inline_keyboard:view.keyboard}}:{}),...(ctx?.threadId?{message_thread_id:ctx.threadId}:{}),...extra};
  if(ctx?.isGroup&&ctx.messageId&&!ctx.callbackMessage&&!extra.reply_parameters)params.reply_parameters={message_id:ctx.messageId,allow_sending_without_reply:true};
  return call('sendMessage',params);
 }
 const say=(ctx,text,keyboard)=>send(ctx,{text,keyboard});
 async function show(ctx,view){
  const target=ctx.editId||ctx.callbackMessage?.message_id;
  if(target){
   try{await call('editMessageText',{chat_id:ctx.chatId,message_id:target,...html(view.text),reply_markup:{inline_keyboard:view.keyboard||[]}});return target;}
   catch(e){if(/not modified/i.test(e.message))return target;}
  }
  return (await send(ctx,view)).message_id;
 }
 async function answer(ctx,text='',alert=false){
  if(!ctx.callbackId||ctx.answered)return;ctx.answered=true;
  await call('answerCallbackQuery',{callback_query_id:ctx.callbackId,...(text?{text:clip(text,190),show_alert:alert}:{})}).catch(()=>{});
 }
 const remove=(chat,id)=>id?call('deleteMessage',{chat_id:chat,message_id:id}).catch(()=>{}):null;
 const signIn=()=>{const app=appUrl();return app?[[{text:'🔐 Sign in with your Task Controlling Management account',web_app:{url:app}}]]:undefined;};

 // ---------------------------------------------------------------- identity and Task Controlling Management access
 function context(chat,from,extra={}){
  const isGroup=chat.type==='group'||chat.type==='supergroup',isPrivate=chat.type==='private';
  const link=from&&!from.is_bot?tg.touch(from,chat.id,isPrivate):null;
  let user=null,problem=null;
  if(link){const account=ac.accountFor(link.staff_id);if(!account)problem='disabled';else{user=ac.publicUser(account.id);if(!ac.can(user,'tasks.tasks'))problem='no_access';}}
  const group=isGroup?tg.seenGroup(chat):null;
  return {chat,chatId:chat.id,from,isGroup,isPrivate,link,user,staff:user?.staff_id||null,problem,group,workspace:group?.workspace_id||null,
   can:(r,a='view')=>!!user&&ac.can(user,r,a),...extra};
 }
 const mention=from=>from.username?`@${esc(from.username)}`:`<a href="tg://user?id=${Number(from.id)}">${esc(from.first_name||'there')}</a>`;
 async function needUser(ctx){
  const w=ctx.workspace?store.get('SELECT * FROM tm_workspaces WHERE id=?',ctx.workspace):null;
  if(ctx.isGroup&&isPersonalWorkspace(w)){await say(ctx,'Personal workspace records are available only in your private bot chat or Mini App.');return false;}
  if(ctx.user&&!ctx.problem)return true;
  const message=!ctx.link?(ctx.isPrivate?linkHelp(appUrl()):'Connect your Telegram account to the Task Controlling Management first: open a private chat with me and send /start.'):ctx.problem==='disabled'?'Your Task Controlling Management account is disabled. Ask an administrator for help.':'Your Task Controlling Management role does not include Task Management.';
  if(ctx.callbackId)await answer(ctx,message.replace(/<[^>]+>/g,''),true);else await say(ctx,message,!ctx.link&&ctx.isPrivate?signIn():undefined);
  return false;
 }
 function perform(ctx,action,data){
  try{ac.authorize(ctx.user,action,data);const result=store.command(action,data,ctx.staff,{source:'TELEGRAM'});return {ok:true,result};}
  catch(e){
   if(e.status)return {ok:false,error:e.message,status:e.status};
   logger.error?.(e);tg.log('error',ctx.chatId,`${action}: ${e.message}`);
   return {ok:false,error:'Something went wrong, so nothing was changed. Please try again.'};
  }
 }
 // Before V5.4 this kept group posts from echoing actions taken in the same group. Groups no longer receive posts.
 const remember=()=>{};

 // ---------------------------------------------------------------- reading tasks
 const nameCache=new Map();
 const nameOf=id=>{if(!id)return '—';if(!nameCache.has(id))nameCache.set(id,(()=>{const r=store.get("SELECT l.name,p.nickname FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=?",id);return r?r.name+(r.nickname?` (${r.nickname})`:''):id;})());return nameCache.get(id);};
 const short=id=>clip(nameOf(id).split(' · ')[0],24);
 // What a change request asks for, in words (for example “change due date Mon 5 Oct → Fri 9 Oct”).
 const changeText=cr=>{let list=[];try{list=JSON.parse(cr.changes_json||'[]');}catch{}
  return cr.kind==='COMPLETE'?'complete the task':cr.kind==='CANCEL'?'cancel the task':'change '+list.map(c=>['description','department_note'].includes(c.field)?`the ${c.label.toLowerCase()}`:`${c.label.toLowerCase()} ${c.from_text} → ${c.to_text}`).join('; ');};
 function enrich(list){
  if(!list.length)return [];
  const ids=list.map(t=>t.id),marks=ids.map(()=>'?').join(',');
  return enrichedTasks({tm_tasks:list,tm_workspaces:store.all('SELECT id,name,department,status FROM tm_workspaces'),
   tm_assignees:store.all(`SELECT task_id,staff_id,status,invited_by,responded_at,response_note FROM tm_assignees WHERE task_id IN (${marks}) ORDER BY rowid`,...ids),tm_timesheets:[],
   tm_due_requests:store.all(`SELECT * FROM tm_due_requests WHERE status='PENDING' AND task_id IN (${marks})`,...ids),
   tm_change_requests:store.all(`SELECT * FROM tm_change_requests WHERE status='PENDING' AND task_id IN (${marks})`,...ids),
   tm_checklist:store.all(`SELECT task_id,done FROM tm_checklist WHERE task_id IN (${marks})`,...ids),tm_files:store.all(`SELECT task_id FROM tm_files WHERE task_id IN (${marks})`,...ids)});
 }
 const loadTask=id=>{const t=typeof id==='string'&&/^[A-Z]+-\d{1,12}$/.test(id)?store.get('SELECT * FROM tm_tasks WHERE id=?',id):null;return t?enrich([t])[0]:null;};
 // V5.5 Task Visibility Scope: a private chat shows the tasks this person may see (their own, their team's through
 // reporting lines, or every task with company-wide access). A group chat is seen by everyone in it, so there the bot
 // shows only tasks of the linked workspace that the person asking is directly on.
 const canSee=(ctx,t)=>!!t&&ctx.can('tasks.tasks')&&(ctx.isGroup?t.workspace_id===ctx.workspace&&store.tasks.scope.isInvolved(ctx.staff,t):store.tasks.scope.canSee(ctx.staff,t));
 const actionsFor=(ctx,t)=>taskActions(t,ctx.staff,{canApprove:ctx.can('tasks.tasks','approve')&&store.tasks.scope.isInvolved(ctx.staff,t)});
 function taskView(ctx,t,note=''){
  const state=taskStateLabel(t),{allowed}=actionsFor(ctx,t),open=OPEN_TASK_STATUSES.includes(t.status);
  const lines=[`${ICON[state]||'•'} <b>${esc(t.title)}</b>`,`<code>${esc(t.id)}</code> · ${esc(t.workspace)}${t.recurrence?` · 🔁 repeats ${RECURRENCE_SHORT[t.recurrence]}`:''}`,`<b>${esc(state)}</b> · ${t.progress}% ${bar(t.progress)}`,
   `👤 In charge: <b>${esc(nameOf(t.pic_id))}</b>${t.pic_id===ctx.staff?' (you)':''}${open&&t.pic_state==='PENDING'?' ⏳':''}`];
  const active=t.support.filter(a=>a.status!=='DECLINED');
  if(active.length)lines.push(`🤝 Supporting: ${active.map(a=>`${esc(nameOf(a.staff_id))}${a.status==='PENDING'?' ⏳':''}`).join(', ')}`);
  if(t.declined_supporters.length)lines.push(`✖️ Rejected supporting: ${t.declined_supporters.map(a=>`${esc(nameOf(a.staff_id))}${a.response_note?` (“${esc(clip(a.response_note,80))}”)`:''}`).join('; ')}`);
  if(t.reviewer_id&&t.reviewer_id!==t.pic_id)lines.push(`🔎 Reviewer: ${esc(nameOf(t.reviewer_id))}${t.reviewer_status==='PENDING'?' ⏳':t.reviewer_status==='DECLINED'?` — ✖️ rejected${t.reviewer_note?` (“${esc(clip(t.reviewer_note,80))}”)`:''}`:''}`);
  if(t.waiting.length)lines.push(`⏳ Waiting for ${t.waiting.map(w=>esc(short(w.staff_id))).join(', ')} to accept`);
  lines.push(`📅 Due ${fmtDay(t.due_date)} (${relDay(t.due_date)})${t.overdue?' · ⚠️ <b>overdue</b>':''} · ${t.priority.toLowerCase()} priority`);
  if(t.check_total||t.file_count)lines.push([t.check_total?`☑️ Steps ${t.check_done} of ${t.check_total} completed`:'',t.file_count?`📎 ${t.file_count} file${t.file_count===1?'':'s'}`:''].filter(Boolean).join(' · '));
  if(t.department||t.department_note)lines.push(`🏢 ${esc(t.department||'Department')}${t.department_note?` — ${esc(clip(t.department_note,300))}`:''}`);
  if(t.stuck)lines.push(`⛔ <b>Stuck</b> since ${fmtDay(localDay(t.stuck_at))}: ${esc(t.stuck_reason)}`);
  if(t.declined)lines.push(`🟠 Rejected by ${esc(nameOf(t.pic_id))}: ${esc(t.declined_reason)}`);
  if(t.status==='IN_REVIEW')lines.push(`📤 Submitted by ${esc(nameOf(t.submitted_by))} to <b>${esc(nameOf(t.submitted_to))}</b>${t.submit_note?`: ${esc(clip(t.submit_note,300))}`:''}`);
  if(t.due_request)lines.push(`⏳ New due date requested: ${fmtDay(t.due_request.proposed_due_date)} (by ${esc(nameOf(t.due_request.requested_by))})`);
  const cr=t.change_request,completion=cr&&cr.kind==='COMPLETE'&&cr.requester_side==='PIC';
  if(cr)lines.push(`🟡 <b>Waiting for ${esc(nameOf(cr.approver_id))}${cr.approver_id===ctx.staff?' (you)':''} to approve</b>: ${esc(nameOf(cr.requested_by))} asks to ${esc(changeText(cr))}${cr.note?` — “${esc(clip(cr.note,200))}”`:''}`);
  else if(t.approval)lines.push(`🤝 Changes need both sides: ${esc(short(t.pic_id))} and ${esc(short(t.assigned_by))}`);
  if(t.description)lines.push('',`🎯 <b>Expectation:</b> ${esc(clip(t.description,600))}`);
  if(note)lines.push('',note);
  const k=[],id=t.id,can=v=>ctx.isGroup?groupAllows(v,t):allowed.includes(v);
  const reply=[];if(can('accept'))reply.push(button('✅ Accept',`t:acc:${id}`));if(can('decline'))reply.push(button('✖️ Reject',`t:dec:${id}`));if(reply.length)k.push(reply);
  const work=[];if(can('progress'))work.push(button(t.status==='NOT_STARTED'?'▶️ Start / progress':'📈 Progress',`t:prg:${id}`));
  if(can('resume'))work.push(button('▶️ Resume',`t:res:${id}`));else if(can('stuck'))work.push(button('⛔ Stuck',`t:stk:${id}`));
  if(work.length)k.push(work);
  // V5.4: completing a task someone else assigned needs the other side, so the buttons say what they ask for.
  const pic=t.pic_id===ctx.staff,finalApprover=completionApprover(t)===ctx.staff&&t.status==='IN_REVIEW';
  const finish=[];if(can('submit'))finish.push(button(pic&&twoSided(t)?'📤 Submit for approval':t.status==='IN_REVIEW'?'📤 Send to reviewer':'📤 Submit',`t:sub:${id}`));
  if(can('pass'))finish.push(button('➡️ Pass for approval',`t:pas:${id}`));
  if(can('close'))finish.push(button(finalApprover&&completion?'✔️ Approve completion':approvalTarget(t,ctx.staff)?'✔️ Ask to complete':'✔️ Close',`t:cls:${id}`));if(can('return'))finish.push(button('↩️ Return',`t:ret:${id}`));
  if(finish.length)k.push(finish);
  const more=[];if(can('note'))more.push(button('💬 Comment',`t:note:${id}`));if(can('due'))more.push(button('📅 New due date',`t:due:${id}`));
  if(more.length)k.push(more);
  const extras=[];if(t.check_total||can('checklist'))extras.push(button(`☑️ Steps${t.check_total?` ${t.check_done}/${t.check_total}`:''}`,`t:ck:${id}`));if(t.file_count||can('file'))extras.push(button(`📎 Files${t.file_count?` (${t.file_count})`:''}`,`t:fl:${id}`));
  if(extras.length)k.push(extras);
  if(cr&&!completion&&!ctx.isGroup){
   if(cr.approver_id===ctx.staff)k.push([button('✅ Approve change',`c:ok:${cr.id}`),button('↩️ Reject',`c:no:${cr.id}`)]);
   else if(cr.requested_by===ctx.staff)k.push([button('🗑 Withdraw request',`c:wd:${cr.id}`)]);
  }else if(cr&&completion&&cr.requested_by===ctx.staff&&!ctx.isGroup)k.push([button('🗑 Take back completion request',`c:wd:${cr.id}`)]);
  if(ctx.isPrivate){const manage=[];if(can('handover'))manage.push(button('🔁 Hand over',`t:ho:${id}`));if(can('remind'))manage.push(button('🔔 Remind',`t:rm:${id}`));if(can('cancel'))manage.push(button(approvalTarget(t,ctx.staff)?'✖️ Ask to cancel':'✖️ Cancel task',`t:can:${id}`));if(manage.length)k.push(manage);}
  const nav=[button('🔄 Refresh',`t:v:${id}`)];
  const app=appUrl();if(ctx.isPrivate&&app)nav.push({text:'📱 Open in app',web_app:{url:`${app}?task=${encodeURIComponent(id)}`}});
  if(ctx.isGroup&&me?.username)nav.push({text:'🔒 Open privately',url:`https://t.me/${me.username}?start=task_${id}`});
  k.push(nav);
  return {text:lines.join('\n'),keyboard:k};
 }
 // In a group everyone sees the same buttons, so they follow the task's state; each tap is checked for the person who tapped.
 function groupAllows(v,t){
  const open=OPEN_TASK_STATUSES.includes(t.status),working=['NOT_STARTED','IN_PROGRESS'].includes(t.status),waiting=(t.waiting||[]).length>0;
  return {accept:waiting||(working&&!!t.declined_at),decline:waiting,progress:working&&!t.awaiting,stuck:working&&!t.stuck&&!t.awaiting,resume:open&&t.stuck,submit:working&&!t.awaiting,close:open&&!t.awaiting,return:t.status==='IN_REVIEW',note:open,due:open&&!t.due_request,checklist:open&&t.check_total>0,file:t.status!=='CANCELLED'}[v]||false;
 }
 // Tasks that wait for this person's answer: to take charge, to support or to review.
 const ANSWER_SQL=`t.status IN ${OPEN} AND ((t.pic_id=? AND t.accepted_at IS NULL AND t.declined_at IS NULL AND t.status<>'IN_REVIEW') OR (a.status='PENDING' AND t.pic_id<>?) OR (t.reviewer_id=? AND t.reviewer_status='PENDING'))`;
 function listQuery(kind,ctx){
  const me=ctx.staff,ws=(ctx.isGroup?' AND t.workspace_id=?':'')+` AND ${LIVE('t.workspace_id')}`,wsArg=ctx.isGroup?[ctx.workspace]:[];
  if(kind==='my')return [`SELECT t.* FROM tm_tasks t WHERE t.pic_id=? AND t.status IN ${OPEN}${ws} ORDER BY t.due_date,t.id`,[me,...wsArg]];
  if(kind==='sup')return [`SELECT t.* FROM tm_tasks t JOIN tm_assignees a ON a.task_id=t.id WHERE a.staff_id=? AND a.status<>'DECLINED' AND t.pic_id<>? AND t.status IN ${OPEN}${ws} ORDER BY t.due_date,t.id`,[me,me,...wsArg]];
  if(kind==='rev')return [`SELECT t.* FROM tm_tasks t WHERE t.status='IN_REVIEW' AND t.submitted_to=?${ws} ORDER BY t.submitted_at,t.id`,[me,...wsArg]];
  if(kind==='ans')return [`SELECT DISTINCT t.* FROM tm_tasks t LEFT JOIN tm_assignees a ON a.task_id=t.id AND a.staff_id=? WHERE ${ANSWER_SQL}${ws} ORDER BY t.due_date,t.id`,[me,me,me,me,...wsArg]];
  return [`SELECT t.* FROM tm_tasks t WHERE t.workspace_id=? AND t.status IN ${OPEN} ORDER BY t.due_date,t.id`,[ctx.workspace]];
 }
 const LIST_TITLES={my:['📋','Tasks you are in charge of','You have no open tasks in charge.'],sup:['🤝','Tasks you are supporting','You are not supporting any open tasks.'],rev:['🔎','Submitted to you for review','Nothing is waiting for your review.'],ans:['🆕','Waiting for your answer','Nothing is waiting for your answer. 🎉'],ws:['🗂','Open tasks','There are no open tasks in this workspace.']};
 function roleNote(t,staff){
  if(t.pic_id===staff&&t.pic_state==='PENDING')return 'asked to take charge';
  if(t.support.some(a=>a.staff_id===staff&&a.status==='PENDING'))return 'asked to support';
  if(t.reviewer_id===staff&&t.reviewer_status==='PENDING')return 'asked to review';
  return '';
 }
 function listView(ctx,kind,page=0){
  const [sql,args]=listQuery(kind,ctx),all=enrich(store.all(sql,...args).filter(t=>canSee(ctx,t))),slice=all.slice(page*PER_PAGE,page*PER_PAGE+PER_PAGE),[icon,title,empty]=LIST_TITLES[kind];
  const wsName=ctx.isGroup?store.get('SELECT name FROM tm_workspaces WHERE id=?',ctx.workspace)?.name:'';
  const head=`${icon} <b>${title}${wsName?` · ${esc(wsName)}`:''}</b>`;
  if(!all.length)return {text:`${head}\n\n${empty}`,keyboard:ctx.isPrivate?[[button('🏠 Menu','m:home')]]:[]};
  const lines=slice.map((t,i)=>`${page*PER_PAGE+i+1}. ${ICON[taskStateLabel(t)]||'•'} <b>${esc(clip(t.title,60))}</b>\n    ${kind==='ans'?esc(roleNote(t,ctx.staff))+' · ':''}${kind==='sup'||kind==='ws'||kind==='ans'?esc(short(t.pic_id))+' · ':''}due ${fmtDay(t.due_date)}${t.overdue?' ⚠️':''} · ${t.progress}%`);
  const k=slice.map((t,i)=>[button(`${page*PER_PAGE+i+1}. ${clip(t.title,40)}`,`t:v:${t.id}`)]);
  const pager=[];if(page>0)pager.push(button('◀ Previous',`m:${kind}:${page-1}`));if(all.length>(page+1)*PER_PAGE)pager.push(button('Next ▶',`m:${kind}:${page+1}`));
  if(pager.length)k.push(pager);if(ctx.isPrivate)k.push([button('🏠 Menu','m:home')]);
  return {text:`${head} (${all.length})\n\n${lines.join('\n')}`,keyboard:k};
 }
 function counts(staff){
  const one=(sql,...a)=>store.get(sql,...a).n;
  const live=LIVE('workspace_id'),liveT=LIVE('t.workspace_id'),liveReq=`(workspace_id IS NULL OR ${live})`;
  return {my:one(`SELECT COUNT(*) n FROM tm_tasks WHERE pic_id=? AND status IN ${OPEN} AND ${live}`,staff),overdue:one(`SELECT COUNT(*) n FROM tm_tasks WHERE pic_id=? AND status IN ${OPEN} AND due_date<? AND ${live}`,staff,taskToday()),
   sup:one(`SELECT COUNT(*) n FROM tm_tasks t JOIN tm_assignees a ON a.task_id=t.id WHERE a.staff_id=? AND a.status<>'DECLINED' AND t.pic_id<>? AND t.status IN ${OPEN} AND ${liveT}`,staff,staff),
   rev:one(`SELECT COUNT(*) n FROM tm_tasks WHERE status='IN_REVIEW' AND submitted_to=? AND ${live}`,staff)+one(`SELECT COUNT(*) n FROM tm_requests WHERE status='PENDING' AND manager_id=? AND ${liveReq}`,staff)
    +one(`SELECT COUNT(*) n FROM tm_due_requests d JOIN tm_tasks t ON t.id=d.task_id WHERE d.status='PENDING' AND d.decide_by=? AND t.status IN ${OPEN} AND ${liveT}`,staff)
    +one(`SELECT COUNT(*) n FROM tm_change_requests c JOIN tm_tasks t ON t.id=c.task_id WHERE c.status='PENDING' AND c.approver_id=? AND NOT (c.kind='COMPLETE' AND c.requester_side='PIC') AND ${liveT}`,staff),
   answer:one(`SELECT COUNT(DISTINCT t.id) n FROM tm_tasks t LEFT JOIN tm_assignees a ON a.task_id=t.id AND a.staff_id=? WHERE ${ANSWER_SQL} AND ${liveT}`,staff,staff,staff,staff)};
 }
 function menuView(ctx,intro=''){
  const c=counts(ctx.staff),company=store.get('SELECT name FROM company WHERE id=1')?.name||'Task Controlling Management';
  const lines=[intro||`👋 <b>Hi, ${esc(nameOf(ctx.staff).split(' · ')[0])}</b>`,`${esc(company)} · Task Management`,'',
   `🆕 Waiting for your answer: <b>${c.answer}</b>`,`📋 In charge: <b>${c.my}</b> open${c.overdue?` (⚠️ ${c.overdue} overdue)`:''}`,`🤝 Supporting: <b>${c.sup}</b>`,`🔎 Waiting for your decision: <b>${c.rev}</b>`];
  const k=[[button(`🆕 To answer (${c.answer})`,'m:ans:0'),button(`🔎 To review (${c.rev})`,'m:rev')],[button(`📋 My tasks (${c.my})`,'m:my:0'),button(`🤝 Supporting (${c.sup})`,'m:sup:0')]];
  const create=[];if(ctx.can('tasks.tasks','create'))create.push(button('➕ New task','m:new'));create.push(button('📨 Request a task','m:ask'));k.push(create);
  k.push([button('🙋 My requests','m:req'),button('📊 Monthly report',`rep:me:${currentMonth()}`)]);
  const app=appUrl();if(app)k.push([{text:'📱 Open the task app',web_app:{url:app}}]);
  return {text:lines.join('\n'),keyboard:k};
 }
 function reviewView(ctx){
  const tasks=enrich(store.all(`SELECT * FROM tm_tasks WHERE status='IN_REVIEW' AND submitted_to=? AND ${LIVE('workspace_id')} ORDER BY submitted_at`,ctx.staff));
  const requests=store.all(`SELECT * FROM tm_requests WHERE status='PENDING' AND manager_id=? AND (workspace_id IS NULL OR ${LIVE('workspace_id')}) ORDER BY created_at`,ctx.staff);
  const dues=store.all(`SELECT d.*,t.title FROM tm_due_requests d JOIN tm_tasks t ON t.id=d.task_id WHERE d.status='PENDING' AND d.decide_by=? AND t.status IN ${OPEN} AND ${LIVE('t.workspace_id')} ORDER BY d.created_at`,ctx.staff);
  const changes=store.all(`SELECT c.*,t.title FROM tm_change_requests c JOIN tm_tasks t ON t.id=c.task_id WHERE c.status='PENDING' AND c.approver_id=? AND NOT (c.kind='COMPLETE' AND c.requester_side='PIC') AND ${LIVE('t.workspace_id')} ORDER BY c.created_at`,ctx.staff);
  const lines=['🔎 <b>Waiting for your decision</b>'],k=[];
  if(!tasks.length&&!requests.length&&!dues.length&&!changes.length)lines.push('','Nothing is waiting for you. 🎉');
  if(changes.length){lines.push('',`<b>Changes to approve (${changes.length})</b>`);changes.slice(0,8).forEach(c=>{lines.push(`• ${esc(clip(c.title,50))}: ${esc(short(c.requested_by))} asks to ${esc(clip(changeText(c),90))}`);k.push([button(`🟡 ${clip(c.title,40)}`,`t:v:${c.task_id}`)]);});}
  if(tasks.length){lines.push('',`<b>Tasks to review (${tasks.length})</b>`);tasks.slice(0,8).forEach(t=>{lines.push(`• ${esc(clip(t.title,60))} — from ${esc(short(t.submitted_by))}`);k.push([button(`📤 ${clip(t.title,40)}`,`t:v:${t.id}`)]);});}
  if(requests.length){lines.push('',`<b>Task requests (${requests.length})</b>`);requests.slice(0,8).forEach(q=>{lines.push(`• ${esc(clip(q.title,60))} — from ${esc(short(q.requested_by))}`);k.push([button(`🙋 ${clip(q.title,40)}`,`r:v:${q.id}`)]);});}
  if(dues.length){lines.push('',`<b>Due date requests (${dues.length})</b>`);dues.slice(0,8).forEach(d=>{lines.push(`• ${esc(clip(d.title,50))}: ${fmtDay(d.current_due_date)} → ${fmtDay(d.proposed_due_date)}`);k.push([button(`📅 ${clip(d.title,40)}`,`d:v:${d.id}`)]);});}
  if(ctx.isPrivate)k.push([button('🏠 Menu','m:home')]);
  return {text:lines.join('\n'),keyboard:k};
 }
 const DOER={RECEIVER:q=>`${nameOf(q.manager_id)} does it`,REQUESTER:q=>`${nameOf(q.requested_by)} does it`,DECIDE:()=>'decided when accepted'};
 function myRequestsView(ctx){
  const list=store.all('SELECT * FROM tm_requests WHERE requested_by=? ORDER BY created_at DESC LIMIT 10',ctx.staff);
  const lines=['🙋 <b>Your task requests</b>'];
  if(!list.length)lines.push('','You have not requested any tasks yet.');
  list.forEach(q=>lines.push(`• ${esc(clip(q.title,60))} — ${q.status==='APPROVED'?'Accepted':REQUEST_STATUS[q.status]}${q.status==='PENDING'?` (with ${esc(short(q.manager_id))})`:''}`));
  const k=list.map(q=>[button(`${q.status==='PENDING'?'⏳':q.status==='APPROVED'?'✅':'•'} ${clip(q.title,40)}`,`r:v:${q.id}`)]);
  k.push([button('📨 Request a task','m:ask')]);
  k.push([button('🏠 Menu','m:home')]);
  return {text:lines.join('\n'),keyboard:k};
 }
 function requestView(ctx,q,note=''){
  const status=q.status==='APPROVED'?`✅ Accepted${q.task_id?` as <code>${esc(q.task_id)}</code>`:''}`:q.status==='DECLINED'?`🟠 Declined${q.decision_note?`: ${esc(q.decision_note)}`:''}`:q.status==='WITHDRAWN'?'🗑 Withdrawn':'⏳ Waiting for an answer';
  const ws=q.workspace_id?store.get('SELECT name FROM tm_workspaces WHERE id=?',q.workspace_id)?.name:'';
  const lines=[`🙋 <b>Task request</b> <code>${esc(q.id)}</code>`,`<b>${esc(q.title)}</b>`,`From <b>${esc(nameOf(q.requested_by))}</b> · asked: <b>${esc(nameOf(q.manager_id))}</b>`,
   `Who does it: ${esc((DOER[q.doer]||DOER.REQUESTER)(q))}`,`Workspace: ${esc(ws||'decided when accepted')} · ${q.priority.toLowerCase()} priority`,`Needed by: ${q.proposed_due_date?fmtDay(q.proposed_due_date):'not set'}`];
  if(q.department||q.department_note)lines.push(`🏢 ${esc(q.department||'Department')}${q.department_note?` — ${esc(clip(q.department_note,300))}`:''}`);
  lines.push(status);if(q.description)lines.push('',`🎯 <b>Expectation:</b> ${esc(clip(q.description,600))}`);if(note)lines.push('',note);
  const k=[];
  if(q.status==='PENDING'&&q.manager_id===ctx.staff)k.push([button(q.doer==='RECEIVER'?'✅ Accept':'✅ Approve',`r:ok:${q.id}`),button('↩️ Decline',`r:no:${q.id}`)],[button('👥 Pass to someone else',`r:fw:${q.id}`)]);
  if(q.status==='PENDING'&&q.requested_by===ctx.staff)k.push([button('🗑 Withdraw request',`r:wd:${q.id}`)]);
  if(q.task_id)k.push([button('👁 View task',`t:v:${q.task_id}`)]);
  k.push([button('🔄 Refresh',`r:v:${q.id}`)]);
  return {text:lines.join('\n'),keyboard:k};
 }
 function dueView(ctx,d,note=''){
  const t=loadTask(d.task_id),status={PENDING:'⏳ Waiting for a decision',APPROVED:'✅ Approved',DECLINED:`🟠 Declined${d.decision_note?': '+esc(d.decision_note):''}`,WITHDRAWN:'🗑 Withdrawn'}[d.status];
  const lines=['📅 <b>New due date requested</b>',`<code>${esc(d.task_id)}</code> · ${esc(t?.title||'')}`,`${esc(nameOf(d.requested_by))} asks to move it from <b>${fmtDay(d.current_due_date)}</b> to <b>${fmtDay(d.proposed_due_date)}</b>.`,`Reason: ${esc(d.reason)}`,status];
  if(note)lines.push('',note);
  const k=[];if(d.status==='PENDING'&&(d.decide_by===ctx.staff||ctx.can('tasks.tasks','approve')))k.push([button('✅ Approve',`d:ok:${d.id}`),button('↩️ Decline',`d:no:${d.id}`)]);
  k.push([button('👁 View task',`t:v:${d.task_id}`)]);
  return {text:lines.join('\n'),keyboard:k};
 }
 function reportView(ctx,scope,month,category=''){
  const b=monthBounds(month),f={month};
  if(scope==='me')f.user=ctx.staff;else if(scope==='ws')f.workspace=ctx.workspace;
  // V5.5: the report counts only tasks this person may see (in a group chat: only their own tasks in the workspace).
  const full=store.tasks.state(),sc=store.tasks.scope.filterState(full,ctx.staff,{meetings:false});
  const mine=scope==='ws'?sc.tm_tasks.filter(t=>t.access_reason==='involved'):sc.tm_tasks,ids=new Set(mine.map(t=>t.id));
  const state={...full,tm_tasks:mine,tm_task_history:full.tm_task_history.filter(h=>ids.has(h.task_id)),tm_assignees:full.tm_assignees.filter(a=>ids.has(a.task_id)),tm_checklist:full.tm_checklist.filter(c=>ids.has(c.task_id)),
   tm_due_requests:full.tm_due_requests.filter(d=>ids.has(d.task_id)),tm_change_requests:full.tm_change_requests.filter(c=>ids.has(c.task_id)),tm_timesheets:full.tm_timesheets.filter(e=>ids.has(e.task_id)),lookups:store.all("SELECT id,name,kind FROM lookups WHERE kind='staff'")};
  const {rows,summary}=monthlyTaskRows(state,f),label=scope==='me'?'Your tasks':scope==='ws'?`Your tasks in ${esc(store.get('SELECT name FROM tm_workspaces WHERE id=?',ctx.workspace)?.name||'this workspace')}`:sc.task_scope.company?'Whole company':'Your tasks and your team’s';
  const running=month===currentMonth(),lines=[`📊 <b>Monthly task report · ${esc(b.label)}</b>`,`${label}${running?' · so far this month':''}`,''];
  const cats=[['completed','✅','Completed'],['in_progress','🔵','In progress'],['stuck','🔴','Stuck'],['overdue','⚠️','Overdue']];
  if(!category)cats.forEach(([key,icon,name])=>lines.push(`${icon} ${name}: <b>${summary[key]}</b>`));
  else{
   const [,icon,name]=cats.find(c=>c[0]===category),list=rows.filter(r=>r.category===category);
   lines.push(`${icon} <b>${name} (${list.length})</b>`);
   if(!list.length)lines.push('None.');
   list.slice(0,15).forEach(r=>lines.push(`• <b>${esc(clip(r.title,55))}</b> — ${esc(short(r.pic_id))}\n    ${esc(clip(r.detail,90))}`));
   if(list.length>15)lines.push(`…and ${list.length-15} more. Open the task app or the Task Controlling Management for the full list.`);
  }
  const k=[cats.map(([key,icon])=>button(`${icon} ${summary[key]}`,`rep:${scope}:${month}:${key}`))];
  const nav=[button(`◀ ${monthBounds(shiftMonth(month,-1)).label.split(' ')[0].slice(0,3)}`,`rep:${scope}:${shiftMonth(month,-1)}`)];
  if(!running)nav.push(button(`${monthBounds(shiftMonth(month,1)).label.split(' ')[0].slice(0,3)} ▶`,`rep:${scope}:${shiftMonth(month,1)}`));
  if(category)nav.push(button('↩ Summary',`rep:${scope}:${month}`));
  k.push(nav);
  if(ctx.isPrivate&&ctx.can('tasks.reports'))k.push([scope==='me'?button(store.tasks.scope.companyWide(ctx.staff)?'🏢 Whole company':'👥 With my team',`rep:all:${month}`):button('👤 Only my tasks',`rep:me:${month}`)]);
  if(ctx.isPrivate)k.push([button('🏠 Menu','m:home')]);
  return {text:lines.join('\n'),keyboard:k};
 }
 function checklistView(ctx,t,note=''){
  const items=store.all('SELECT * FROM tm_checklist WHERE task_id=? ORDER BY position',t.id),{allowed}=actionsFor(ctx,t);
  const can=ctx.isGroup?groupAllows('checklist',t):allowed.includes('checklist');
  const lines=[`☑️ <b>Steps of work</b> · ${esc(t.title)}`,`${items.filter(i=>i.done).length} of ${items.length} completed`,''];
  items.forEach((i,n)=>lines.push(`${i.done?'✅':'⬜'} ${n+1}. ${esc(i.title)}`));
  if(!items.length)lines.push('No steps yet.');
  if(can&&items.length)lines.push('','Tap a step to complete it (or reopen it). Steps never change the task’s progress.');
  if(note)lines.push('',note);
  const k=can?rows(items.slice(0,30).map((i,n)=>button(`${i.done?'✅':'⬜'} ${n+1}. ${clip(i.title,24)}`,`k:t:${i.id}`)),2):[];
  const foot=[];if(can&&ctx.isPrivate)foot.push(button('➕ Add a step',`k:add:${t.id}`));foot.push(button('↩ Back to the task',`t:v:${t.id}`));k.push(foot);
  return {text:lines.join('\n'),keyboard:k};
 }
 function filesView(ctx,t,note=''){
  const files=store.all('SELECT id,name,size,uploaded_by,created_at FROM tm_files WHERE task_id=? ORDER BY created_at,id',t.id),{allowed}=actionsFor(ctx,t);
  const lines=[`📎 <b>Files</b> · ${esc(t.title)}`,''];
  files.forEach((f,n)=>lines.push(`${n+1}. ${esc(f.name)} — ${Math.max(1,Math.ceil(f.size/1024))} KB · ${esc(short(f.uploaded_by))}`));
  if(!files.length)lines.push('No files yet.');
  const canAdd=ctx.isGroup?groupAllows('file',t):allowed.includes('file');
  if(canAdd)lines.push('',ctx.isPrivate?'To add a photo or document, tap “Attach a file” and send it (up to 30 MB).':'To add a photo or document, reply to the task’s message with it (up to 30 MB).');
  if(note)lines.push('',note);
  const k=ctx.isPrivate?files.slice(0,20).map((f,n)=>[button(`⬇️ ${n+1}. ${clip(f.name,34)}`,`a:g:${f.id}`)]):[];
  const foot=[];if(canAdd&&ctx.isPrivate)foot.push(button('📎 Attach a file',`a:add:${t.id}`));foot.push(button('↩ Back to the task',`t:v:${t.id}`));k.push(foot);
  if(ctx.isGroup&&files.length&&me?.username)k.push([{text:'🔒 Get the files privately',url:`https://t.me/${me.username}?start=task_${t.id}`}]);
  return {text:lines.join('\n'),keyboard:k};
 }

 // ---------------------------------------------------------------- people pickers (everyone with Task Management)
 const people=()=>ac.taskPeople();
 function peopleRows(ctx,prefix,page,{exclude=[],selected=[],data=''}={}){
  const all=people().filter(p=>!exclude.includes(p.staff_id)).sort((a,b)=>(b.staff_id===ctx.staff)-(a.staff_id===ctx.staff));
  const pages=Math.max(1,Math.ceil(all.length/PEOPLE_PAGE)),p=Math.min(Math.max(0,Number(page)||0),pages-1);
  const label=x=>`${selected.includes(x.staff_id)?'✅ ':''}${x.staff_id===ctx.staff?`🙋 Me (${clip(x.name.split(' · ')[0],16)})`:clip(x.name,28)}`;
  const out=rows(all.slice(p*PEOPLE_PAGE,(p+1)*PEOPLE_PAGE).map(x=>button(label(x),`${prefix}${x.staff_id}`)),2);
  if(pages>1){const nav=[];if(p>0)nav.push(button('◀ Previous',`${data}${p-1}`));nav.push(button(`${p+1} of ${pages}`,'x:page'));if(p<pages-1)nav.push(button('Next ▶',`${data}${p+1}`));out.push(nav);}
  return {rows:out,count:all.length};
 }

 // ---------------------------------------------------------------- conversations (multi-step forms)
 async function prompt(ctx,flow,step,data,question,placeholder){
  const text=ctx.isGroup?`${mention(ctx.from)}, ${question}`:`${question.charAt(0).toUpperCase()}${question.slice(1)}\n\n<i>Send /cancel to stop.</i>`;
  const m=await send(ctx,{text},{reply_markup:{force_reply:true,selective:true,input_field_placeholder:clip(placeholder,64)},...(ctx.isGroup&&ctx.messageId&&!ctx.callbackMessage?{reply_parameters:{message_id:ctx.messageId,allow_sending_without_reply:true}}:{})});
  tg.session.set(ctx.chatId,ctx.from.id,flow,step,data,{prompt_id:m.message_id,message_id:data.card??null});
 }
 const workspacesFor=ctx=>{
  const mine=store.all("SELECT w.id,w.name FROM tm_workspaces w JOIN tm_members m ON m.workspace_id=w.id WHERE m.staff_id=? AND w.status='ACTIVE' ORDER BY w.name",ctx.staff);
  const allowed=store.all("SELECT * FROM tm_workspaces WHERE status='ACTIVE' ORDER BY name").filter(w=>store.organization.canCreateResource(ctx.staff,w));
  return mine.length?mine.filter(w=>allowed.some(a=>a.id===w.id)):allowed;
 };
 function nextStep(d){
  if(d.sub)return d.sub;
  if(d.kind==='newtask'){if(!d.workspace_id)return 'workspace';if(!d.pic_id)return 'pic';if(!d.due_date)return 'due';return 'confirm';}
  if(d.kind==='request'){if(!d.manager_id)return 'manager';if(!d.doer)return 'doer';if(d.workspace_id===undefined)return 'workspace';if(d.due_date===undefined)return 'due';return 'confirm';}
  if(!d.workspace_id)return 'workspace';if(!d.pic_id)return 'pic';if(!d.due_date)return 'due';return 'confirm';
 }
 const DOER_CHOICE={RECEIVER:d=>`${nameOf(d.manager_id).split(' · ')[0]} does it`,REQUESTER:()=>'I do it (asking to take it on)',DECIDE:d=>`${nameOf(d.manager_id).split(' · ')[0]} decides who does it`};
 function flowView(ctx,d){
  const step=nextStep(d),ws=d.workspace_id?store.get('SELECT name FROM tm_workspaces WHERE id=?',d.workspace_id)?.name:'';
  const title=d.kind==='newtask'?'➕ <b>New task</b>':d.kind==='request'?'📨 <b>Request a task</b>':d.doer==='RECEIVER'?'✅ <b>Accept task request</b>':'✅ <b>Approve task request</b>';
  const summary=[title,`<b>${esc(d.title)}</b>`];
  if(d.kind==='request'&&d.manager_id)summary.push(`Asking: ${esc(nameOf(d.manager_id))}`);
  if(d.kind==='request'&&d.doer)summary.push(`Who does it: ${esc(DOER_CHOICE[d.doer](d))}`);
  if(ws)summary.push(`Workspace: ${esc(ws)}`);
  if(d.pic_id)summary.push(`In charge: ${esc(nameOf(d.pic_id))}`);
  if(d.kind==='approve')summary.push(`Reviewer: ${esc(nameOf(d.doer==='RECEIVER'?d.requester:ctx.staff))}`);
  if(d.supporter_ids?.length)summary.push(`Supporting: ${esc(d.supporter_ids.map(nameOf).join(', '))}`);
  if(d.due_date)summary.push(`Due: ${fmtDay(d.due_date)} (${relDay(d.due_date)})`);
  if(d.kind!=='approve')summary.push(`Priority: ${(d.priority||'MEDIUM').toLowerCase()}`);
  if(d.department_note)summary.push(`🏢 Department note: ${esc(clip(d.department_note,200))}`);
  if(d.description)summary.push(`📝 ${esc(clip(d.description,300))}`);
  const cancel=[button('✖️ Cancel','f:x')],k=[],pages=d.pages||{};
  if(step==='workspace'){
   const question=d.kind==='request'?'Which workspace is it for? (optional)':'Which workspace is it for?';
   workspacesFor(ctx).slice(0,20).forEach(w=>k.push(button(clip(w.name,30),`f:ws:${w.id}`)));
   const out=rows(k,2);if(d.kind==='request')out.push([button('Skip — decided when accepted','f:ws:-')]);out.push(cancel);return {text:[...summary,'',`<b>${question}</b>`].join('\n'),keyboard:out};
  }
  if(step==='pic'){
   const {rows:out}=peopleRows(ctx,'f:pic:',pages.pic,{data:'f:pg:pic:'});out.push(cancel);
   return {text:[...summary,'','<b>Who is in charge?</b> Everyone who uses Task Management is listed; they are asked to accept.'].join('\n'),keyboard:out};
  }
  if(step==='manager'){
   const {rows:out,count}=peopleRows(ctx,'f:mgr:',pages.mgr,{exclude:[ctx.staff],data:'f:pg:mgr:'});
   if(!count)return {text:[...summary,'','Nobody else uses Task Management yet. Ask an administrator to add people.'].join('\n'),keyboard:[cancel]};
   out.push(cancel);return {text:[...summary,'','<b>Who are you asking?</b>'].join('\n'),keyboard:out};
  }
  if(step==='doer')return {text:[...summary,'','<b>Who should do it?</b>'].join('\n'),keyboard:[[button(`👤 ${clip(DOER_CHOICE.RECEIVER(d),40)}`,'f:doer:RECEIVER')],[button('🙋 Me — I am asking to take it on','f:doer:REQUESTER')],[button(`🤔 ${clip(DOER_CHOICE.DECIDE(d),40)}`,'f:doer:DECIDE')],cancel]};
  if(step==='due'){
   const out=[[button('Today','f:due:0'),button('Tomorrow','f:due:1')],[button('In 3 days','f:due:3'),button('In a week','f:due:7')],[button('In 2 weeks','f:due:14'),button('Other date…','f:due:other')]];
   if(d.kind==='request')out.push([button('No date — decided when accepted','f:due:-')]);out.push(cancel);
   return {text:[...summary,'',`<b>${d.kind==='request'?'When do you need it?':'When is it due?'}</b>`].join('\n'),keyboard:out};
  }
  if(step==='supporters'){
   const {rows:out}=peopleRows(ctx,'f:sup:',pages.sup,{exclude:[d.pic_id],selected:d.supporter_ids||[],data:'f:pg:sup:'});out.push([button('Done','f:sup:done')]);
   return {text:[...summary,'','<b>Who is supporting?</b> Tap to select, then Done. They are asked to accept.'].join('\n'),keyboard:out};
  }
  if(step==='priority')return {text:[...summary,'','<b>Priority?</b>'].join('\n'),keyboard:[[button('🔴 High','f:pri:HIGH'),button('🟡 Medium','f:pri:MEDIUM'),button('🟢 Low','f:pri:LOW')]]};
  // confirm
  const out=[];
  if(d.kind==='newtask')out.push([button('✅ Create task','f:ok')],[button(`🤝 Supporting (${d.supporter_ids?.length||0})`,'f:edit:supporters'),button('⚡ Priority','f:edit:priority')],[button('🎯 Expectation','f:text:description'),button('🏢 Department note','f:text:department_note')]);
  else if(d.kind==='request')out.push([button('📨 Send request','f:ok')],[button('🎯 Expectation','f:text:description'),button('🏢 Department note','f:text:department_note')],[button('⚡ Priority','f:edit:priority'),button('👤 Who does it','f:edit:doer')]);
  else out.push([button(d.doer==='RECEIVER'?'✅ Accept and create the task':'✅ Approve and create the task','f:ok')],[button('👤 Person in charge','f:edit:pic'),button('📅 Due date','f:edit:due')],[button(`🤝 Supporting (${d.supporter_ids?.length||0})`,'f:edit:supporters')]);
  out.push(cancel);
  return {text:[...summary,'','Check the details, then confirm.'].join('\n'),keyboard:out};
 }
 async function startFlow(ctx,kind,seed={}){
  if(!await needUser(ctx))return;
  if(kind==='newtask'&&!ctx.can('tasks.tasks','create'))return reply(ctx,'Your Task Controlling Management role cannot create tasks. You can still ask someone for a task with /request.');
  if(ctx.isGroup&&!ctx.workspace&&kind==='newtask')return reply(ctx,'Link this group to a workspace first: an administrator can send /connect here.');
  const d={kind,supporter_ids:[],priority:'MEDIUM',description:'',department_note:'',pages:{},...seed};
  if(ctx.isGroup&&ctx.workspace&&kind!=='approve')d.workspace_id=ctx.workspace;
  if(kind!=='approve'&&!d.title)return prompt(ctx,'flow','title',d,kind==='newtask'?'what is the task? Reply with a short title.':'what do you need? Reply with a short title for your request.',kind==='newtask'?'Task title':'Request title');
  if(kind==='newtask'&&!d.workspace_id){const list=workspacesFor(ctx);if(list.length===1)d.workspace_id=list[0].id;}
  const view=flowView(ctx,d);
  ctx.editId=d.card||undefined;
  const id=await show(ctx,view);d.card=id;
  tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:id});
 }
 async function reply(ctx,text){if(ctx.callbackId)return answer(ctx,text,true);return say(ctx,text);}
 async function onFlowButton(ctx,[what,value,extra]){
  const s=tg.session.get(ctx.chatId,ctx.from.id);
  if(!s||s.flow!=='flow'||(s.data.card&&s.data.card!==ctx.callbackMessage.message_id))return answer(ctx,'This form belongs to someone else or has expired. Start again with /newtask or /request.',true);
  if(!await needUser(ctx))return;
  const d=s.data;d.pages=d.pages||{};
  const person=id=>people().some(p=>p.staff_id===id);
  if(what==='x'){tg.session.clear(ctx.chatId,ctx.from.id);await show(ctx,{text:`${d.kind==='approve'?'Answer':'Form'} cancelled.`,keyboard:[]});return answer(ctx,'Cancelled.');}
  if(what==='pg'&&['pic','sup','mgr'].includes(value))d.pages[value]=Math.max(0,Number(extra)||0);
  else if(what==='ws'){if(value==='-')d.workspace_id=null;else if(workspacesFor(ctx).some(w=>w.id===value))d.workspace_id=value;}
  else if(what==='pic'&&person(value)){d.pic_id=value;d.supporter_ids=(d.supporter_ids||[]).filter(x=>x!==value);d.sub=null;}
  else if(what==='mgr'&&person(value)&&value!==ctx.staff){d.manager_id=value;d.sub=null;}
  else if(what==='doer'&&['RECEIVER','REQUESTER','DECIDE'].includes(value)){d.doer=value;d.sub=null;}
  else if(what==='due'&&!/^(\d{1,3}|-|other)$/.test(value||''))return answer(ctx);
  else if(what==='due'){if(value==='other'){tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:d.card});await answer(ctx);return prompt(ctx,'flow','due_date',d,'send the due date, for example 2026-10-05 or 5/10.','YYYY-MM-DD or day/month');}d.due_date=value==='-'?null:addDays(taskToday(),Number(value));d.sub=null;}
  else if(what==='sup'){if(value==='done')d.sub=null;else if(person(value)&&value!==d.pic_id)d.supporter_ids=d.supporter_ids.includes(value)?d.supporter_ids.filter(x=>x!==value):[...d.supporter_ids,value];}
  else if(what==='pri'&&['HIGH','MEDIUM','LOW'].includes(value)){d.priority=value;d.sub=null;}
  else if(what==='edit'&&['supporters','priority','pic','due','doer'].includes(value))d.sub=value;
  else if(what==='text'&&['description','department_note'].includes(value)){tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:d.card});await answer(ctx);return prompt(ctx,'flow',value,d,value==='description'?(d.kind==='request'?'send the expectation: the result you expect, and how you’ll know it is done (up to a few paragraphs).':'send the details (up to a few paragraphs).'):'send the department note — which department or team this is for and anything they should know.',value==='description'?(d.kind==='request'?'Expectation':'Details'):'Department note');}
  else if(what==='ok')return finishFlow(ctx,d);
  tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:d.card});
  await show(ctx,flowView(ctx,d));await answer(ctx);
 }
 async function finishFlow(ctx,d){
  if(['newtask','request'].includes(d.kind)&&!String(d.description||'').trim()){await answer(ctx);return prompt(ctx,'flow','description',d,'send the expected result before creating this task.','Expectation (required)');}
  let r;
  if(d.kind==='newtask'){const start=taskToday()<=d.due_date?taskToday():d.due_date;r=perform(ctx,'tm.task.save',{workspace_id:d.workspace_id,title:d.title,description:d.description,department_note:d.department_note,priority:d.priority,start_date:start,due_date:d.due_date,pic_id:d.pic_id,supporter_ids:d.supporter_ids,request_key:`tg:${ctx.chatId}:${d.card}`});}
  else if(d.kind==='request')r=perform(ctx,'tm.request.save',{title:d.title,description:d.description,department_note:d.department_note,priority:d.priority,manager_id:d.manager_id,doer:d.doer,workspace_id:d.workspace_id||null,proposed_due_date:d.due_date||null,request_key:`tg:${ctx.chatId}:${d.card}`});
  else r=perform(ctx,'tm.request.decide',{id:d.request_id,decision:'APPROVE',workspace_id:d.workspace_id,pic_id:d.pic_id,supporter_ids:d.supporter_ids,due_date:d.due_date});
  if(!r.ok)return answer(ctx,r.error,true);
  tg.session.clear(ctx.chatId,ctx.from.id);
  await answer(ctx,r.result.message||'Done.');
  if(r.result.type==='tm_request'){const q=store.get('SELECT * FROM tm_requests WHERE id=?',r.result.id);return show(ctx,requestView(ctx,q,`✅ ${esc(r.result.message)}`));}
  remember(ctx,r.result.id);
  const t=loadTask(r.result.id);if(t)return show(ctx,taskView(ctx,t,`✅ ${esc(r.result.message)}`));
 }
 async function onAnswer(ctx,s,text){
  const d=s.data,value=text==null?null:String(text).trim();
  await remove(ctx.chatId,s.prompt_id);
  if(s.flow==='flow'){
   if(s.step==='title'){if(!value)return prompt(ctx,'flow','title',d,'please send a title.','Title');d.title=clip(value,300);ctx.editId=undefined;return startFlow(ctx,d.kind,d);}
   if(s.step==='due_date'){const day=value?parseDay(value):null;if(!day)return prompt(ctx,'flow','due_date',d,'I could not read that date. Send it like 2026-10-05 or 5/10.','YYYY-MM-DD');if(day<taskToday())return prompt(ctx,'flow','due_date',d,'that date has passed. Send a date from today onward.','YYYY-MM-DD');d.due_date=day;d.sub=null;}
   if(s.step==='description')d.description=value?value.slice(0,8000):'';
   if(s.step==='department_note')d.department_note=value?value.slice(0,2000):'';
   tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:d.card});
   ctx.editId=d.card;return show(ctx,flowView(ctx,d));
  }
  if(s.flow==='attach'){
   if(value==null){tg.session.clear(ctx.chatId,ctx.from.id);return say(ctx,'OK, no file was attached.');}
   return prompt(ctx,'attach','file',d,'send the photo or document itself (as a file or photo), or send /cancel.','Photo or document');
  }
  tg.session.clear(ctx.chatId,ctx.from.id);
  if(s.flow==='check'){
   const t=loadTask(d.id);if(!canSee(ctx,t))return say(ctx,'That task is no longer available.');
   if(!value)return prompt(ctx,'check','x',d,'send the step, for example “Photograph the seal”.','Step');
   const r=perform(ctx,'tm.check.add',{task_id:t.id,title:clip(value,300)});remember(ctx,t.id);
   const fresh=loadTask(t.id);ctx.editId=d.card;return show(ctx,checklistView(ctx,fresh||t,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));
  }
  if(s.flow==='task'){
   const t=loadTask(d.id);if(!canSee(ctx,t))return say(ctx,'That task is no longer available.');
   let r;
   if(d.verb==='progress'){const n=Number(value);if(!Number.isInteger(n)||n<0||n>99)return prompt(ctx,'task','x',d,'send a whole number from 0 to 99. (Use Close or Submit when the work is finished.)','0–99');r=perform(ctx,'tm.task.progress',{id:t.id,progress:n});}
   else if(d.verb==='due'){
    if(!d.date){const day=value?parseDay(value):null;if(!day)return prompt(ctx,'task','x',d,'I could not read that date. Send it like 2026-10-05 or 5/10.','YYYY-MM-DD');d.date=day;return prompt(ctx,'task','x',d,`why do you need ${fmtDay(day)}? The person who approves it will see this reason.`,'Reason');}
    if(!value)return prompt(ctx,'task','x',d,'please give a short reason.','Reason');
    r=perform(ctx,'tm.due.request',{task_id:t.id,proposed_due_date:d.date,reason:value});
   }else{
    const needs=['decline','stuck','return','note','cancel'].includes(d.verb);
    if(needs&&!value)return prompt(ctx,'task','x',d,'this needs a short note. Please reply with it.','Note');
    r=perform(ctx,'tm.task.'+d.verb,{id:t.id,note:value||''});
   }
   remember(ctx,t.id);
   const fresh=loadTask(t.id),msg=r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`;
   ctx.editId=d.card;return show(ctx,fresh?taskView(ctx,fresh,msg):{text:msg});
  }
  if(s.flow==='request'){
   if(!value)return prompt(ctx,'request','x',d,'please reply with a short reason.','Reason');
   const r=perform(ctx,'tm.request.decide',{id:d.id,decision:'DECLINE',note:value}),q=store.get('SELECT * FROM tm_requests WHERE id=?',d.id);
   ctx.editId=d.card;return show(ctx,requestView(ctx,q,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));
  }
  if(s.flow==='change'){
   if(!value)return prompt(ctx,'change','x',d,'please reply with a short reason.','Reason');
   const r=perform(ctx,'tm.change.decide',{id:d.id,decision:'REJECT',note:value}),c=store.get('SELECT task_id FROM tm_change_requests WHERE id=?',d.id),t=c?loadTask(c.task_id):null;
   ctx.editId=d.card;const msg=r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`;return show(ctx,t?taskView(ctx,t,msg):{text:msg});
  }
  if(s.flow==='due'){
   if(!value)return prompt(ctx,'due','x',d,'please reply with a short reason.','Reason');
   const r=perform(ctx,'tm.due.decide',{id:d.id,decision:'DECLINE',note:value}),q=store.get('SELECT * FROM tm_due_requests WHERE id=?',d.id);
   ctx.editId=d.card;return show(ctx,dueView(ctx,q,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));
  }
 }
 // A photo or document sent to the bot: attached to the task the person chose (📎 Attach a file), or to the task
 // whose message it replies to.
 async function onMedia(ctx,m){
  const session=tg.session.get(ctx.chatId,m.from.id);
  let taskId=session?.flow==='attach'&&(!ctx.isGroup||m.reply_to_message?.message_id===session.prompt_id)?session.data.id:null;
  if(!taskId&&m.reply_to_message?.from?.id&&m.reply_to_message.from.id===me?.id)taskId=TASK_ID.exec(String(m.reply_to_message.text||m.reply_to_message.caption||''))?.[1]||null;
  if(!taskId){if(ctx.isPrivate&&ctx.link)await say(ctx,'To add this to a task, open the task, tap 📎 Files → Attach a file, and send it again. You can also reply to a task’s message with the file.');return;}
  if(!await needUser(ctx))return;
  const t=loadTask(taskId);if(!canSee(ctx,t))return say(ctx,'That task is not available to you.');
  let fileId,name,size;
  if(m.document){fileId=m.document.file_id;name=m.document.file_name||'document';size=m.document.file_size||0;}
  else{const sizes=[...m.photo].sort((a,b)=>(a.file_size||0)-(b.file_size||0)),best=sizes.filter(p=>(p.file_size||0)<=MAX_FILE).pop()||sizes[0];fileId=best.file_id;size=best.file_size||0;name=`photo-${new Date().toISOString().slice(0,16).replace(/[-:T]/g,'')}.jpg`;}
  if(size>20*1024*1024&&apiBase==='https://api.telegram.org')return say(ctx,'Files over 20 MB must be uploaded from the Telegram Mini App or web system (up to 30 MB per file).');
  if(size>MAX_FILE)return say(ctx,'⚠️ That file is larger than 30 MB. Send a smaller file, or add it in the Task Controlling Management.');
  let content;
  try{const f=await call('getFile',{file_id:fileId});if((f.file_size||0)>MAX_FILE)return say(ctx,'⚠️ That file is larger than 30 MB. Send a smaller file, or add it in the Task Controlling Management.');content=await download(f.file_path);}
  catch(e){if(e.tooLarge)return say(ctx,'⚠️ That file is larger than 30 MB. Send a smaller file, or add it in the Task Controlling Management.');tg.log('warn',ctx.chatId,`File download: ${e.message}`);return say(ctx,'⚠️ I could not get that file from Telegram. Please try again.');}
  const r=perform(ctx,'tm.file.add',{task_id:t.id,name,base64:content.toString('base64')});
  if(session?.flow==='attach'){tg.session.clear(ctx.chatId,m.from.id);await remove(ctx.chatId,session.prompt_id);}
  remember(ctx,t.id);
  return send(ctx,filesView(ctx,loadTask(t.id)||t,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));
 }

 // ---------------------------------------------------------------- buttons
 const QUESTIONS={decline:['why are you rejecting this? The people on the task will see your reason.','Reason'],stuck:['what is blocking this task?','What is blocking it'],return:['what still needs to be done? This goes back to the person who submitted it.','What is missing'],note:['send your comment.','Comment'],submit:['add a note for the person who checks or approves it, or send /skip.','Note (optional)'],cancel:['why are you cancelling this task? Everyone on it will see your reason.','Reason']};
 async function onTaskButton(ctx,[verb,id,extra,more]){
  if(!await needUser(ctx))return;
  const t=loadTask(id);
  if(!t)return answer(ctx,'This task no longer exists.',true);
  if(!canSee(ctx,t))return answer(ctx,'This task belongs to another workspace.',true);
  const card=ctx.callbackMessage.message_id,act=async(action,data)=>{const r=perform(ctx,action,data);remember(ctx,t.id);await answer(ctx,r.ok?r.result.message:r.error,!r.ok);const fresh=loadTask(t.id);if(fresh)await show(ctx,taskView(ctx,fresh,r.ok?`✅ ${esc(r.result.message)}`:''));};
  if(verb==='v'){await show(ctx,taskView(ctx,t));return answer(ctx);}
  if(verb==='acc')return act('tm.task.accept',{id});
  if(verb==='res')return act('tm.task.resume',{id});
  if(verb==='rm')return act('tm.task.remind',{id});
  if(verb==='pas')return act('tm.task.pass',{id});
  if(verb==='p'){const n=Number(extra);if(!Number.isInteger(n)||n<0||n>99)return answer(ctx,'Choose a value from the list.');return act('tm.task.progress',{id,progress:n});}
  if(verb==='cls!')return act('tm.task.close',{id});
  if(verb==='ck'){await show(ctx,checklistView(ctx,t));return answer(ctx);}
  if(verb==='fl'){await show(ctx,filesView(ctx,t));return answer(ctx);}
  if(verb==='prg'){
   const k=[[10,25,50].map(n=>button(`${n}%`,`t:p:${id}:${n}`)),[75,90].map(n=>button(`${n}%`,`t:p:${id}:${n}`)).concat(button('Other…',`t:po:${id}`)),[button('↩ Back',`t:v:${id}`)]];
   await show(ctx,{text:taskView(ctx,t).text+'\n\n📈 <b>How far along is it?</b>',keyboard:k});return answer(ctx);
  }
  if(verb==='po'){await answer(ctx);return prompt(ctx,'task','x',{verb:'progress',id,card},'send the progress as a number from 0 to 99.','0–99');}
  const {roles,allowed}=actionsFor(ctx,t),blocked=v=>taskBlock(v,t,roles)?.message||'This action is not available.';
  if(verb==='cls'){
   if(!allowed.includes('close'))return answer(ctx,blocked('close'),true);
   const other=approvalTarget(t,ctx.staff),question=other&&t.status!=='IN_REVIEW'?`✔️ <b>Ask ${esc(nameOf(other))} to approve completing this task?</b> It stays open until they approve.`:t.change_request?.kind==='COMPLETE'?'✔️ <b>Approve completing this task?</b>':'✔️ <b>Close this task as completed?</b>';
   await show(ctx,{text:taskView(ctx,t).text+'\n\n'+question,keyboard:[[button(other&&t.status!=='IN_REVIEW'?'✔️ Yes, ask':'✔️ Yes, complete it',`t:cls!:${id}`),button('↩ Back',`t:v:${id}`)]]});return answer(ctx);
  }
  if(['ho','hop','hp','hx'].includes(verb)){
   if(!allowed.includes('handover'))return answer(ctx,blocked('handover'),true);
   if(verb==='hx'){const r=perform(ctx,'tm.task.handover',{id,to_id:extra,keep:more==='1'});await answer(ctx,r.ok?r.result.message:r.error,!r.ok);const fresh=loadTask(id);return show(ctx,taskView(ctx,fresh||t,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));}
   if(verb==='hp'){
    if(!people().some(p=>p.staff_id===extra))return answer(ctx,'Choose someone from the list.');
    await show(ctx,{text:`${taskView(ctx,t).text}\n\n🔁 <b>Hand this task over to ${esc(nameOf(extra))}?</b> They are asked to accept it.`,keyboard:[[button('🔁 Hand over',`t:hx:${id}:${extra}:0`)],[button('🤝 Hand over, and keep me as supporting',`t:hx:${id}:${extra}:1`)],[button('↩ Back',`t:ho:${id}`)]]});return answer(ctx);
   }
   const {rows:list}=peopleRows(ctx,`t:hp:${id}:`,verb==='hop'?extra:0,{exclude:[t.pic_id],data:`t:hop:${id}:`});list.push([button('↩ Back',`t:v:${id}`)]);
   await show(ctx,{text:`${taskView(ctx,t).text}\n\n🔁 <b>Who should take charge?</b>`,keyboard:list});return answer(ctx);
  }
  const map={dec:'decline',stk:'stuck',ret:'return',note:'note',sub:'submit',due:'due',can:'cancel'},action=map[verb];
  if(!action)return answer(ctx,'This button is no longer available.');
  if(!allowed.includes(action))return answer(ctx,blocked(action),true);
  await answer(ctx);
  if(action==='due')return prompt(ctx,'task','x',{verb:'due',id,card},`what due date do you need instead of ${fmtDay(t.due_date)}? For example 2026-10-05 or 5/10.`,'YYYY-MM-DD or day/month');
  const [q,ph]=QUESTIONS[action];return prompt(ctx,'task','x',{verb:action,id,card},q,ph);
 }
 async function onCheckButton(ctx,[verb,id]){
  if(!await needUser(ctx))return;
  if(verb==='add'){
   const t=loadTask(id);if(!canSee(ctx,t))return answer(ctx,'This task is not available to you.',true);
   if(!actionsFor(ctx,t).allowed.includes('checklist'))return answer(ctx,taskBlock('checklist',t,actionsFor(ctx,t).roles)?.message||'You cannot change this checklist.',true);
   await answer(ctx);return prompt(ctx,'check','x',{id,card:ctx.callbackMessage.message_id},'send the new step.','Step');
  }
  const item=typeof id==='string'?store.get('SELECT * FROM tm_checklist WHERE id=?',id):null,t=item?loadTask(item.task_id):null;
  if(!item||!canSee(ctx,t))return answer(ctx,'This step is no longer available.',true);
  const r=perform(ctx,'tm.check.toggle',{id,done:!item.done});remember(ctx,t.id);
  await answer(ctx,r.ok?r.result.message:r.error,!r.ok);
  return show(ctx,checklistView(ctx,loadTask(t.id)||t));
 }
 async function onFileButton(ctx,[verb,id]){
  if(!await needUser(ctx))return;
  if(verb==='add'){
   const t=loadTask(id);if(!canSee(ctx,t))return answer(ctx,'This task is not available to you.',true);
   if(!actionsFor(ctx,t).allowed.includes('file'))return answer(ctx,taskBlock('file',t,actionsFor(ctx,t).roles)?.message||'You cannot add files to this task.',true);
   await answer(ctx);return prompt(ctx,'attach','file',{id,card:ctx.callbackMessage.message_id},`send the photo or document for “${clip(t.title,60)}” (up to 30 MB).`,'Photo or document');
  }
  if(verb==='g'){
   if(!ctx.isPrivate)return answer(ctx,'Open the task in a private chat with me to get its files.',true);
   const f=typeof id==='string'?store.get('SELECT * FROM tm_files WHERE id=?',id):null,t=f?loadTask(f.task_id):null;
   if(!f||!canSee(ctx,t))return answer(ctx,'This file is no longer available.',true);
   await answer(ctx,'Sending…');
   try{await upload('sendDocument',ctx.chatId,'document',{content:Buffer.from(f.content),mime:f.mime,name:f.name},{caption:`${f.name} · ${t.id}`});}
   catch(e){tg.log('warn',ctx.chatId,`Send file: ${e.message}`);await say(ctx,'⚠️ I could not send that file. Please try again, or open it in the Task Controlling Management.');}
   return;
  }
  return answer(ctx);
 }
 async function onRequestButton(ctx,[verb,id,extra]){
  if(!await needUser(ctx))return;
  const q=typeof id==='string'?store.get('SELECT * FROM tm_requests WHERE id=?',id):null;
  if(!q||!store.tasks.scope.canSeeRequest(ctx.staff,q))return answer(ctx,'This request is not available to you.',true);
  if(ctx.isGroup&&q.workspace_id!==ctx.workspace)return answer(ctx,'Open this request in a private chat with me.',true);
  const card=ctx.callbackMessage.message_id;
  if(verb==='v'){await show(ctx,requestView(ctx,q));return answer(ctx);}
  if(verb==='wd'){const r=perform(ctx,'tm.request.withdraw',{id});await answer(ctx,r.ok?r.result.message:r.error,!r.ok);return show(ctx,requestView(ctx,store.get('SELECT * FROM tm_requests WHERE id=?',id)));}
  if(q.manager_id!==ctx.staff)return answer(ctx,'Only the person this request was sent to can answer it.',true);
  if(q.status!=='PENDING'){await show(ctx,requestView(ctx,q));return answer(ctx,'This request has already been answered.',true);}
  if(verb==='no'){await answer(ctx);return prompt(ctx,'request','x',{id,card},'why are you declining this request? The requester will see this.','Reason');}
  if(verb==='fw'||verb==='fp'){
   const {rows:list,count}=peopleRows(ctx,`r:to:${id}:`,verb==='fp'?extra:0,{exclude:[ctx.staff,q.requested_by],data:`r:fp:${id}:`});
   if(!count)return answer(ctx,'There is nobody else to pass it to.',true);
   list.push([button('↩ Back',`r:v:${id}`)]);
   await show(ctx,{text:requestView(ctx,q).text+'\n\n👥 <b>Pass it to whom?</b>',keyboard:list});return answer(ctx);
  }
  if(verb==='to'){const r=perform(ctx,'tm.request.forward',{id,manager_id:extra});await answer(ctx,r.ok?r.result.message:r.error,!r.ok);return show(ctx,requestView(ctx,store.get('SELECT * FROM tm_requests WHERE id=?',id)));}
  if(verb==='ok'){
   const doer=q.doer||'REQUESTER';
   const d={kind:'approve',request_id:q.id,requester:q.requested_by,doer,title:q.title,workspace_id:q.workspace_id||null,pic_id:doer==='RECEIVER'?ctx.staff:doer==='REQUESTER'?q.requested_by:null,due_date:q.proposed_due_date&&q.proposed_due_date>=taskToday()?q.proposed_due_date:null,supporter_ids:[],pages:{},card};
   if(!d.workspace_id){const list=workspacesFor(ctx);if(list.length===1)d.workspace_id=list[0].id;}
   tg.session.set(ctx.chatId,ctx.from.id,'flow','buttons',d,{message_id:card});
   await show(ctx,flowView(ctx,d));return answer(ctx);
  }
  return answer(ctx);
 }
 async function onDueButton(ctx,[verb,id]){
  if(!await needUser(ctx))return;
  const d=typeof id==='string'?store.get('SELECT * FROM tm_due_requests WHERE id=?',id):null,t=d?loadTask(d.task_id):null;
  if(!d||!canSee(ctx,t))return answer(ctx,'This request is not available to you.',true);
  if(verb==='v'){await show(ctx,dueView(ctx,d));return answer(ctx);}
  if(verb==='ok'){const r=perform(ctx,'tm.due.decide',{id,decision:'APPROVE'});remember(ctx,d.task_id);await answer(ctx,r.ok?r.result.message:r.error,!r.ok);return show(ctx,dueView(ctx,store.get('SELECT * FROM tm_due_requests WHERE id=?',id)));}
  if(verb==='no'){if(d.decide_by!==ctx.staff&&!ctx.can('tasks.tasks','approve'))return answer(ctx,'Only the task’s reviewer or a task approver can decide this request.',true);await answer(ctx);return prompt(ctx,'due','x',{id,card:ctx.callbackMessage.message_id},'why are you declining the new date?','Reason');}
  return answer(ctx);
 }
 // V5.4: approving, rejecting or withdrawing a change to a task (details, completion or cancellation).
 async function onChangeButton(ctx,[verb,id]){
  if(!await needUser(ctx))return;
  const c=typeof id==='string'?store.get('SELECT * FROM tm_change_requests WHERE id=?',id):null,t=c?loadTask(c.task_id):null;
  if(!c||!canSee(ctx,t)||(c.approver_id!==ctx.staff&&c.requested_by!==ctx.staff))return answer(ctx,'This request is not available to you.',true);
  if(ctx.isGroup)return answer(ctx,'Open the task in a private chat with me to decide changes.',true);
  const card=ctx.callbackMessage.message_id;
  if(c.status!=='PENDING'){await show(ctx,taskView(ctx,t));return answer(ctx,'This request has already been decided.',true);}
  if(verb==='wd'||verb==='ok'){
   const r=verb==='wd'?perform(ctx,'tm.change.withdraw',{id}):perform(ctx,'tm.change.decide',{id,decision:'APPROVE'});
   await answer(ctx,r.ok?r.result.message:r.error,!r.ok);const fresh=loadTask(c.task_id);return show(ctx,taskView(ctx,fresh||t,r.ok?`✅ ${esc(r.result.message)}`:`⚠️ ${esc(r.error)}`));
  }
  if(verb==='no'){if(c.approver_id!==ctx.staff)return answer(ctx,`Only ${nameOf(c.approver_id)} can reject this request.`,true);await answer(ctx);return prompt(ctx,'change','x',{id,card},'why are you rejecting this change? The person who asked will see your reason.','Reason');}
  return answer(ctx);
 }
 async function onMenuButton(ctx,[what,page]){
  if(!await needUser(ctx))return;
  const p=Math.max(0,Number(page)||0);
  if(what==='home'){await show(ctx,menuView(ctx));return answer(ctx);}
  if(['my','sup','ws','ans'].includes(what)){if(what==='ws'&&!ctx.workspace)return answer(ctx,'This group is not linked to a workspace.',true);await show(ctx,listView(ctx,what,p));return answer(ctx);}
  if(what==='rev'){await show(ctx,reviewView(ctx));return answer(ctx);}
  if(what==='req'){await show(ctx,myRequestsView(ctx));return answer(ctx);}
  if(what==='new'||what==='ask'){await answer(ctx);ctx.callbackMessage=null;return startFlow(ctx,what==='new'?'newtask':'request');}
  return answer(ctx);
 }
 async function onReportButton(ctx,[scope,month,category]){
  if(!await needUser(ctx))return;
  if(!['me','all','ws'].includes(scope)||!/^\d{4}-\d{2}$/.test(month||''))return answer(ctx);
  if(scope==='all'&&!ctx.can('tasks.reports'))return answer(ctx,'Your role cannot view company-wide task reports.',true);
  if(scope==='ws'&&!ctx.workspace)return answer(ctx,'This group is not linked to a workspace.',true);
  if(month>currentMonth())return answer(ctx,'That month has not started yet.');
  if(category&&!['completed','in_progress','stuck','overdue'].includes(category))return answer(ctx);
  try{await show(ctx,reportView(ctx,scope,month,category));}catch(e){return answer(ctx,e.message,true);}
  return answer(ctx);
 }
 // Linking a group shares that workspace's task titles and updates with everyone in the group, so only
 // Task Controlling Management administrators (Administration · Telegram) or the workspace's owner may do it.
 const linkableWorkspaces=ctx=>store.all("SELECT * FROM tm_workspaces WHERE status='ACTIVE' ORDER BY name").filter(w=>!isPersonalWorkspace(w)&&store.organization.canManageWorkspace(ctx.staff,w)&&(ctx.can('admin.telegram','update')||ctx.can('tasks.workspace','update')&&w.owner_id===ctx.staff));
 const NOT_ALLOWED='Only Task Controlling Management administrators or the workspace owner can link this group to a workspace.';
 async function onGroupButton(ctx,[what,id]){
  if(!ctx.isGroup)return answer(ctx);
  if(!await needUser(ctx))return;
  const allowed=linkableWorkspaces(ctx);
  if(what==='ws'&&!allowed.some(w=>w.id===id))return answer(ctx,NOT_ALLOWED,true);
  if(what==='off'&&!(ctx.can('admin.telegram','update')||allowed.some(w=>w.id===ctx.workspace)))return answer(ctx,NOT_ALLOWED,true);
  if(what==='ws'){const w=tg.linkGroup(ctx.chatId,id,ctx.staff);if(!w)return answer(ctx,'Choose an active workspace.',true);await show(ctx,{text:`✅ This group is now linked to <b>${esc(w.name)}</b>.\n\nTask updates for this workspace will be posted here. Members who connected their Telegram to the Task Controlling Management can use /tasks, /mytasks, /newtask and /report.`,keyboard:[[button('🗂 Open tasks','m:ws:0')]]});return answer(ctx,'Group linked.');}
  if(what==='off'){tg.unlinkGroup(ctx.chatId,ctx.staff);await show(ctx,{text:'This group is no longer linked to a workspace.',keyboard:[]});return answer(ctx,'Group unlinked.');}
  return answer(ctx);
 }

 // ---------------------------------------------------------------- commands
 async function link(ctx,code){
  if(!ctx.isPrivate)return say(ctx,'For your security, connect your account in a private chat with me, not in a group.');
  const key=String(ctx.from.id),f=linkFailures.get(key);
  if(f&&f.count>=5&&Date.now()-f.at<15*60000)return say(ctx,'Too many incorrect codes. Please wait 15 minutes and try again with the link from the Task Controlling Management.');
  const r=tg.redeem(code,ctx.from,ctx.chatId);
  if(r.error){linkFailures.set(key,{count:(f&&Date.now()-f.at<15*60000?f.count:0)+1,at:Date.now()});return say(ctx,`⚠️ ${r.error}`,signIn());}
  linkFailures.delete(key);
  const fresh=context(ctx.chat,ctx.from);
  if(!fresh.user)return say(ctx,'✅ Connected. Your Task Controlling Management role does not include Task Management yet, so ask an administrator for access.');
  return send(fresh,menuView(fresh,`✅ <b>Connected!</b> This Telegram account now works as <b>${esc(r.name)}</b> in the Task Controlling Management.`));
 }
 function helpText(ctx){
  if(ctx.isGroup){const ws=ctx.workspace?store.get('SELECT name FROM tm_workspaces WHERE id=?',ctx.workspace)?.name:'';return `<b>Task Management in this group</b>${ws?`\nLinked workspace: <b>${esc(ws)}</b>`:'\nThis group is not linked to a workspace yet.'}\n\n${GROUP_COMMANDS.map(([c,d])=>`/${c} – ${d}`).join('\n')}\n\nOnly people who connected their Telegram to the Task Controlling Management can use the buttons, and each action follows their part in the task. To attach a photo or document to a task, reply to the task’s message with it.`;}
  return `<b>What I can do</b>\n\n${PRIVATE_COMMANDS.map(([c,d])=>`/${c} – ${d}`).join('\n')}\n\nTap the buttons under a task to accept or reject it, update progress, tick its checklist, mark it stuck, submit it for review, close or cancel it, or hand it over. To attach a photo or document, reply to a task’s message with it. Everything you do here is saved in the Task Controlling Management straight away.`;
 }
 async function onCommand(ctx,cmd,args){
  if(cmd==='start'){
   if(args.startsWith('link_'))return link(ctx,args.slice(5));
   if(!ctx.link&&ctx.isPrivate)return say(ctx,`👋 <b>Welcome!</b> I help your team manage Task Controlling Management tasks from Telegram.\n\n${linkHelp(appUrl())}`,signIn());
   if(args.startsWith('task_')){if(!await needUser(ctx))return;const t=loadTask(args.slice(5));return canSee(ctx,t)?send(ctx,taskView(ctx,t)):say(ctx,'That task was not found, or you cannot view it.');}
   if(ctx.isGroup)return say(ctx,helpText(ctx));
   if(!await needUser(ctx))return;return send(ctx,menuView(ctx));
  }
  if(cmd==='link'){if(!args)return say(ctx,'Send /link followed by the code from the Task Controlling Management, for example <code>/link ABCD2345</code>.');return link(ctx,args);}
  if(cmd==='help')return say(ctx,helpText(ctx));
  if(cmd==='unlink'){
   if(!ctx.isPrivate)return say(ctx,'Send /unlink in a private chat with me.');
   if(!ctx.link)return say(ctx,'This Telegram account is not connected to the Task Controlling Management.');
   return say(ctx,'Disconnect this Telegram account from the Task Controlling Management? You will stop receiving task messages here.',[[button('Disconnect','u:yes'),button('Keep connected','u:no')]]);
  }
  if(cmd==='connect'||cmd==='disconnect'){
   if(!ctx.isGroup)return say(ctx,'Use this command in a group chat after adding me to it.');
   if(!await needUser(ctx))return;
   const list=linkableWorkspaces(ctx);
   if(cmd==='disconnect'){if(!ctx.workspace)return say(ctx,'This group is not linked to a workspace.');if(!(ctx.can('admin.telegram','update')||list.some(w=>w.id===ctx.workspace)))return say(ctx,NOT_ALLOWED);return say(ctx,'Unlink this group from its workspace?',[[button('Unlink','g:off:-'),button('Keep','x:')]]);}
   if(!list.length)return say(ctx,ctx.can('tasks.workspace','update')?'Only Task Controlling Management administrators or the workspace owner can link this group, and you do not own an active workspace.':NOT_ALLOWED);
   return say(ctx,'Which workspace should this group follow?',rows(list.slice(0,20).map(w=>button(clip(w.name,30),`g:ws:${w.id}`)),2));
  }
  if(!await needUser(ctx))return;
  if(cmd==='menu')return ctx.isPrivate?send(ctx,menuView(ctx)):say(ctx,helpText(ctx));
  if(cmd==='answer')return send(ctx,listView(ctx,'ans'));
  if(cmd==='mytasks')return send(ctx,listView(ctx,'my'));
  if(cmd==='supporting')return send(ctx,listView(ctx,'sup'));
  if(cmd==='tasks'){if(ctx.isPrivate)return send(ctx,listView(ctx,'my'));if(!ctx.workspace)return say(ctx,helpText(ctx));return send(ctx,listView(ctx,'ws'));}
  if(cmd==='review')return send(ctx,ctx.isPrivate?reviewView(ctx):listView(ctx,'rev'));
  if(cmd==='requests')return ctx.isPrivate?send(ctx,myRequestsView(ctx)):say(ctx,'Open your requests in a private chat with me: /requests');
  if(cmd==='newtask')return startFlow(ctx,'newtask',args?{title:clip(args,300)}:{});
  if(cmd==='request')return startFlow(ctx,'request',args?{title:clip(args,300)}:{});
  if(cmd==='task'){const t=loadTask(args.toUpperCase());return canSee(ctx,t)?send(ctx,taskView(ctx,t)):say(ctx,'Send /task followed by a task ID, for example <code>/task TASK-000012</code>. The task must be one you can view.');}
  if(cmd==='report'){
   const month=/^\d{4}-\d{2}$/.test(args)?args:currentMonth();
   if(month>currentMonth())return say(ctx,'That month has not started yet.');
   try{return send(ctx,reportView(ctx,ctx.isGroup?(ctx.workspace?'ws':'me'):'me',month));}catch(e){return say(ctx,esc(e.message));}
  }
  if(cmd==='app'){const app=appUrl();if(!ctx.isPrivate||!app)return say(ctx,app?'Open the task app from a private chat with me.':'The task app has not been set up yet. Ask an administrator.');return say(ctx,'Open the task app:',[[{text:'📱 Open the task app',web_app:{url:app}}]]);}
  if(ctx.isPrivate)return say(ctx,'I did not recognise that command. Send /help to see what I can do.');
 }

 // ---------------------------------------------------------------- updates
 async function handleUpdate(u){
  if(u.my_chat_member){
   const m=u.my_chat_member,status=m.new_chat_member?.status;if(!['group','supergroup'].includes(m.chat?.type))return;
   const active=['member','administrator','creator'].includes(status)?1:0,g=tg.seenGroup(m.chat,active);
   if(active&&!['member','administrator','creator'].includes(m.old_chat_member?.status))await send(m.chat.id,{text:`👋 Hello! I connect this group to the Task Controlling Management’s Task Management.\n\n${g.workspace_id?'This group is already linked to a workspace.':'An Task Controlling Management administrator can link this group to a workspace with /connect.'}\nEveryone who wants to use the buttons should first connect their Telegram in a private chat with me (send me /start).`}).catch(()=>{});
   return;
  }
  if(u.callback_query){
   const q=u.callback_query,msg=q.message;
   if(!msg?.chat)return call('answerCallbackQuery',{callback_query_id:q.id,text:'This message is too old. Send /menu to start again.'}).catch(()=>{});
   const ctx=context(msg.chat,q.from,{callbackId:q.id,messageId:msg.message_id,callbackMessage:msg,threadId:msg.is_topic_message?msg.message_thread_id:undefined});
   const [kind,...parts]=String(q.data||'').split(':');
   try{
    if(kind==='t')await onTaskButton(ctx,parts);
    else if(kind==='k')await onCheckButton(ctx,parts);
    else if(kind==='a')await onFileButton(ctx,parts);
    else if(kind==='r')await onRequestButton(ctx,parts);
    else if(kind==='d')await onDueButton(ctx,parts);
    else if(kind==='c')await onChangeButton(ctx,parts);
    else if(kind==='m')await onMenuButton(ctx,parts);
    else if(kind==='f')await onFlowButton(ctx,parts);
    else if(kind==='rep')await onReportButton(ctx,parts);
    else if(kind==='g')await onGroupButton(ctx,parts);
    else if(kind==='u'){
     if(parts[0]==='yes'&&ctx.link){try{store.command('tg.link.unlink',{},ctx.link.staff_id,{source:'TELEGRAM'});}catch{store.run('DELETE FROM tg_links WHERE tg_user_id=?',ctx.from.id);}await show(ctx,{text:'Disconnected. Send /start whenever you want to connect again.',keyboard:[]});}
     else await show(ctx,{text:ctx.link?'Still connected.':'This Telegram account is not connected.',keyboard:[]});
    }
    else if(kind==='x'&&parts[0]!=='page')await show(ctx,{text:'OK.',keyboard:[]});
   }finally{await answer(ctx);}
   return;
  }
  const m=u.message;
  if(!m?.chat||!['private','group','supergroup'].includes(m.chat.type)||!m.from||m.from.is_bot)return;
  if(m.migrate_to_chat_id){tg.migrateGroup(m.chat.id,m.migrate_to_chat_id);return;}
  const ctx=context(m.chat,m.from,{messageId:m.message_id,threadId:m.is_topic_message?m.message_thread_id:undefined});
  if(m.document||(Array.isArray(m.photo)&&m.photo.length))return onMedia(ctx,m);
  const text=typeof m.text==='string'?m.text:'',command=text.startsWith('/')?parseCommand(text,me?.username):null;
  if(command?.other)return;
  const session=tg.session.get(ctx.chatId,m.from.id);
  if(session&&session.prompt_id&&(!command||['skip','cancel'].includes(command.cmd))){
   if(ctx.isGroup&&m.reply_to_message?.message_id!==session.prompt_id)return;
   if(command?.cmd==='cancel'){tg.session.clear(ctx.chatId,m.from.id);await remove(ctx.chatId,session.prompt_id);return say(ctx,'Cancelled.');}
   return onAnswer(ctx,session,command?.cmd==='skip'?null:text);
  }
  if(command){if(session&&!['skip','cancel'].includes(command.cmd))tg.session.clear(ctx.chatId,m.from.id);if(command.cmd==='cancel'||command.cmd==='skip')return ctx.isPrivate?say(ctx,'There is nothing to cancel.'):undefined;return onCommand(ctx,command.cmd,command.args);}
  if(ctx.isPrivate){
   if(!ctx.link&&/^[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}$/.test(text.trim()))return link(ctx,normalizeCode(text));
   if(!ctx.link)return say(ctx,linkHelp(appUrl()),signIn());
   if(!await needUser(ctx))return;
   return send(ctx,menuView(ctx,'Use the buttons below, or send /help to see all commands.'));
  }
 }

 // ---------------------------------------------------------------- outgoing messages from Task Controlling Management activity
 const NOTIFY_MAX_AGE=6*3600000;
 // V5.5 durable delivery: every notification gets one Telegram delivery record (tm_notification_deliveries): SENT,
 // SKIPPED with the reason, or FAILED after retries. Just before sending, the bot checks again that the person may
 // still receive it (an active login with Task Management, Telegram connected with notifications on, and still directly
 // involved in the task, meeting or request it is about). A record is written before each attempt, so a notification
 // is never sent twice, even if the Task Controlling Management stops halfway; failed attempts are retried with growing pauses.
 const RETRY_AFTER=[30000,120000,600000,1800000];
 const nowIso=()=>new Date().toISOString();
 const delivery=(id,status,reason,attempts,next=null)=>store.run(`INSERT INTO tm_notification_deliveries(notification_id,channel,status,reason,attempts,next_at,updated_at) VALUES(?,'TELEGRAM',?,?,?,?,?)
  ON CONFLICT(notification_id,channel) DO UPDATE SET status=excluded.status,reason=excluded.reason,attempts=excluded.attempts,next_at=excluded.next_at,updated_at=excluded.updated_at`,id,status,String(reason||'').slice(0,300),attempts,next,nowIso());
 // Why this notification must not be sent now (null: it may be sent).
 function ineligible(n){
  if(n.kind==='telegram_connected')return 'Shown in the Task Controlling Management only';
  if(Date.parse(n.created_at)<=Date.now()-NOTIFY_MAX_AGE)return 'Older than 6 hours when Telegram was ready';
  const link=tg.linkForStaff(n.staff_id);
  if(!link)return 'Telegram is not connected';if(!link.notify)return 'Telegram notifications are turned off';if(!link.chat_id)return 'The bot cannot message this person (blocked or never started)';
  const account=ac.accountFor(n.staff_id);if(!account)return 'The login is disabled';
  const user=ac.publicUser(account.id);if(!ac.can(user,'tasks.tasks')&&!ac.can(user,'tasks.meetings'))return 'The role no longer includes Task Management';
  if(n.org_request_id&&(!ac.can(user,'tasks.organization')||!store.organization.notificationVisible(n.staff_id,n.org_request_id)))return 'Organization request no longer requires or permits this recipient';
  const scope=store.tasks.scope;
  if(n.task_id){const t=store.get('SELECT * FROM tm_tasks WHERE id=?',n.task_id);if(!t)return 'The task no longer exists';if(!ac.can(user,'tasks.tasks'))return 'The role no longer includes Tasks';if(!scope.canSee(n.staff_id,t)||!scope.isInvolved(n.staff_id,t))return 'No longer on this task';}
  // A cancelled meeting sends nothing more, except the notice that it was cancelled.
  if(n.meeting_id){const m=store.get('SELECT * FROM tm_meetings WHERE id=?',n.meeting_id);if(!m)return 'The meeting no longer exists';if(m.status==='CANCELLED'&&n.kind!=='meeting_cancelled')return 'The meeting was cancelled';if(!scope.canSeeMeeting(n.staff_id,m))return 'No longer invited to this meeting';}
  if(n.note_id){const x=store.get('SELECT staff_id FROM tm_calendar_notes WHERE id=?',n.note_id);if(!x||x.staff_id!==n.staff_id)return 'The note was deleted';}
  if(n.request_id&&!n.task_id){const q=store.get('SELECT * FROM tm_requests WHERE id=?',n.request_id);if(!q||(q.requested_by!==n.staff_id&&q.manager_id!==n.staff_id))return 'No longer part of this request';if(!scope.canSeeRequest(n.staff_id,q))return 'The workspace was deleted';}
  return null;
 }
 async function attempt(n,attempts){
  const why=ineligible(n);if(why){delivery(n.id,'SKIPPED',why,attempts);return;}
  delivery(n.id,'PENDING','Sending',attempts+1);
  try{await deliver(n);delivery(n.id,'SENT','',attempts+1);}
  catch(e){
   const retry=attempts+1<=RETRY_AFTER.length&&e.code!==403;
   delivery(n.id,'FAILED',e.code===403?'The person blocked the bot':e.message,attempts+1,retry?new Date(Date.now()+RETRY_AFTER[attempts]).toISOString():null);
   tg.log('error',null,`Notification ${n.id}: ${e.message}${retry?' (will retry)':''}`);
  }
 }
 async function deliver(n){
  const link=tg.linkForStaff(n.staff_id);
  const account=ac.accountFor(n.staff_id),user=ac.publicUser(account.id);
  const ctx={chatId:link.chat_id,isPrivate:true,staff:n.staff_id,user,can:(r,a='view')=>ac.can(user,r,a)};
  const k=[];
  if(n.task_id){
   const t=loadTask(n.task_id),allowed=t?actionsFor(ctx,t).allowed:[];
   if(t&&ANSWER_KINDS.includes(n.kind)&&allowed.includes('accept'))k.push([button('✅ Accept',`t:acc:${t.id}`),...(allowed.includes('decline')?[button('✖️ Reject',`t:dec:${t.id}`)]:[])]);
   if(t&&n.kind==='task_submitted'&&allowed.includes('close'))k.push([button(t.change_request?.kind==='COMPLETE'?'✔️ Approve completion':'✔️ Close',`t:cls:${t.id}`),button('↩️ Return',`t:ret:${t.id}`)]);
   else if(t&&n.kind==='task_submitted'&&allowed.includes('pass'))k.push([button('➡️ Pass for approval',`t:pas:${t.id}`),button('↩️ Return',`t:ret:${t.id}`)]);
   if(t&&['task_due_soon','task_overdue'].includes(n.kind)&&allowed.includes('progress'))k.push([button('📈 Update progress',`t:prg:${t.id}`)]);
   if(n.kind==='due_new'&&n.due_request_id)k.push([button('✅ Approve date',`d:ok:${n.due_request_id}`),button('↩️ Decline',`d:no:${n.due_request_id}`)]);
   const cr=t?.change_request;
   if(cr&&n.kind==='change_request'&&cr.approver_id===n.staff_id)k.push([button('✅ Approve change',`c:ok:${cr.id}`),button('↩️ Reject',`c:no:${cr.id}`)]);
   k.push([button('👁 View task',`t:v:${n.task_id}`)]);
  }else if(n.request_id){
   const q=store.get('SELECT * FROM tm_requests WHERE id=?',n.request_id);
   if(q&&n.kind==='request_new'&&q.status==='PENDING'&&q.manager_id===n.staff_id)k.push([button(q.doer==='RECEIVER'?'✅ Accept':'✅ Approve',`r:ok:${q.id}`),button('↩️ Decline',`r:no:${q.id}`)]);
   k.push([button('👁 View request',`r:v:${n.request_id}`)]);
  }
  // V5.5.1: meeting invitations, changes and reminders, and note reminders open the calendar in the Mini App.
  const app=appUrl();
  if(app&&n.org_request_id)k.push([{text:'Review organization request',web_app:{url:`${app}?org_request=${encodeURIComponent(n.org_request_id)}`}}]);
  if(app&&ctx.can('tasks.tasks')&&(n.note_id||(n.meeting_id&&ctx.can('tasks.meetings'))))k.push([{text:'📅 Open in the calendar',web_app:{url:`${app}?${n.meeting_id?'meeting':'note'}=${encodeURIComponent(n.meeting_id||n.note_id)}`}}]);
  try{await send(ctx,{text:`${NOTE_ICON[n.kind]||'🔔'} <b>${esc(n.title)}</b>\n${esc(n.body)}`,keyboard:k});}
  catch(e){if(e.code===403){store.run('UPDATE tg_links SET chat_id=NULL WHERE tg_user_id=?',link.tg_user_id);tg.log('warn',link.chat_id,`${nameOf(n.staff_id)} blocked the bot; messages paused until they message it again.`);}throw e;}
 }
 async function flush(){
  if(flushing||stopped||!me)return;flushing=true;
  try{
   nameCache.clear();
   const s=tg.settings();
   // Personal notifications: start from the newest when the bot is first connected (no old backlog).
   let cursor=s.last_notification_id;
   if(cursor<0){cursor=store.get('SELECT COALESCE(MAX(id),0) AS n FROM tm_notifications').n;store.run('UPDATE tg_settings SET last_notification_id=? WHERE id=1',cursor);}
   // An attempt interrupted by a stop or crash (sent or not, nobody knows) is not repeated, so nothing arrives twice.
   store.run("UPDATE tm_notification_deliveries SET status='SKIPPED',reason='Interrupted while sending; not repeated so it can never arrive twice',next_at=NULL,updated_at=? WHERE channel='TELEGRAM' AND status='PENDING' AND updated_at<?",nowIso(),new Date(Date.now()-120000).toISOString());
   for(const n of store.all("SELECT * FROM tm_notifications n WHERE id>? AND NOT EXISTS (SELECT 1 FROM tm_notification_deliveries d WHERE d.notification_id=n.id AND d.channel='TELEGRAM') ORDER BY id LIMIT 25",cursor)){
    if(stopped)break;
    // “Telegram connected” notices are for the Task Controlling Management bell only (they would reach the newly connected chat).
    try{await attempt(n,0);}catch(e){tg.log('error',null,`Notification ${n.id}: ${e.message}`);}
    store.run('UPDATE tg_settings SET last_notification_id=? WHERE id=1 AND last_notification_id<?',n.id,n.id);
   }
   // Retries of failed attempts that are due.
   for(const d of store.all("SELECT d.attempts,n.* FROM tm_notification_deliveries d JOIN tm_notifications n ON n.id=d.notification_id WHERE d.channel='TELEGRAM' AND d.status='FAILED' AND d.next_at IS NOT NULL AND d.next_at<=? ORDER BY d.next_at LIMIT 10",nowIso())){
    if(stopped)break;
    try{await attempt(d,d.attempts);}catch(e){tg.log('error',null,`Notification ${d.id}: ${e.message}`);}
   }
   // V5.4: task updates are no longer posted to linked Telegram groups. Notifications go only to the people on each
   // task (above), so nobody outside a task hears about it.
   await digest(s);
  }catch(e){if(!stopped){logger.error?.(e);tg.log('error',null,e.message);}}
  finally{flushing=false;}
 }
 // A short morning summary for each connected person (due today, overdue and waiting for them).
 async function digest(s){
  const today=taskToday(),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Phnom_Penh',hour:'numeric',hourCycle:'h23'}).format(new Date()));
  if(s.digest_hour<0||hour!==s.digest_hour||s.last_digest_date===today)return;
  store.run('UPDATE tg_settings SET last_digest_date=? WHERE id=1',today);
  for(const link of store.all('SELECT * FROM tg_links WHERE notify=1 AND chat_id IS NOT NULL')){
   if(stopped)return;
   const account=ac.accountFor(link.staff_id);if(!account)continue;const user=ac.publicUser(account.id);if(!ac.can(user,'tasks.tasks'))continue;
   const mine=enrich(store.all(`SELECT DISTINCT t.* FROM tm_tasks t JOIN tm_assignees a ON a.task_id=t.id WHERE a.staff_id=? AND a.status<>'DECLINED' AND t.status IN ${OPEN} AND t.due_date<=? AND ${LIVE('t.workspace_id')} ORDER BY t.due_date`,link.staff_id,today));
   const c=counts(link.staff_id),dueToday=mine.filter(t=>t.due_date===today),late=mine.filter(t=>t.due_date<today);
   if(!mine.length&&!c.rev&&!c.answer)continue;
   const lines=[`☀️ <b>Good morning, ${esc(nameOf(link.staff_id).split(' · ')[0])}</b>`,`Your tasks for ${fmtDay(today)}:`,''];
   if(late.length)lines.push(`⚠️ Overdue: <b>${late.length}</b>`);if(dueToday.length)lines.push(`📅 Due today: <b>${dueToday.length}</b>`);if(c.answer)lines.push(`🆕 Waiting for your answer: <b>${c.answer}</b>`);if(c.rev)lines.push(`🔎 Waiting for your decision: <b>${c.rev}</b>`);
   mine.slice(0,5).forEach(t=>lines.push(`• ${esc(clip(t.title,60))} — ${t.due_date<today?'overdue':'due today'}`));
   try{await send(link.chat_id,{text:lines.join('\n'),keyboard:[[button('🆕 To answer','m:ans:0'),button('📋 My tasks','m:my:0')],[button('🔎 To review','m:rev')]]},{disable_notification:false});}catch(e){if(e.code===403)store.run('UPDATE tg_links SET chat_id=NULL WHERE tg_user_id=?',link.tg_user_id);}
  }
 }

 // ---------------------------------------------------------------- lifecycle
 async function configure(){
  await call('deleteWebhook',{drop_pending_updates:false}).catch(()=>{});
  await call('setMyCommands',{commands:PRIVATE_COMMANDS.map(([command,description])=>({command,description})),scope:{type:'all_private_chats'}}).catch(e=>tg.log('warn',null,`Commands: ${e.message}`));
  await call('setMyCommands',{commands:GROUP_COMMANDS.map(([command,description])=>({command,description})),scope:{type:'all_group_chats'}}).catch(e=>tg.log('warn',null,`Group commands: ${e.message}`));
  await refreshMenu();
 }
 async function refreshMenu(){
  const app=appUrl();if(app===menuFor)return;
  try{await call('setChatMenuButton',{menu_button:app?{type:'web_app',text:'Tasks',web_app:{url:app}}:{type:'commands'}});menuFor=app;}catch(e){tg.log('warn',null,`Menu button: ${e.message}`);}
 }
 async function run(){
  let backoff=1000;
  while(!stopped){
   try{
    me=await api('getMe');
    store.run('UPDATE tg_settings SET bot_id=?,bot_username=?,bot_name=? WHERE id=1',me.id,me.username||'',me.first_name||'');
    await configure();
    tg.setStatus('ONLINE',`Connected as @${me.username}`);tg.log('info',null,`Connected as @${me.username}`);
    break;
   }catch(e){
    if(stopped)return;
    if(e.code===401||e.code===404){tg.setStatus('ERROR','Telegram rejected the bot token. Check it in Administration → Telegram.');tg.log('error',null,'Bot token rejected');return;}
    tg.setStatus('RECONNECTING',`Cannot reach Telegram: ${e.message}`);await sleep(backoff);backoff=Math.min(backoff*2,60000);
   }
  }
  const timer=setInterval(()=>void flush(),outboxMs);timer.unref?.();
  backoff=1000;
  while(!stopped){
   try{
    const s=tg.settings();
    const updates=await api('getUpdates',{offset:s.last_update_id+1,timeout:pollTimeout,allowed_updates:['message','callback_query','my_chat_member']},(pollTimeout+10)*1000);
    if(backoff>1000)tg.setStatus('ONLINE',`Connected as @${me.username}`);
    backoff=1000;
    for(const u of updates){
     if(stopped)break;
     nameCache.clear();
     try{await handleUpdate(u);}catch(e){logger.error?.(e);tg.log('error',null,`Update ${u.update_id}: ${e.message}`);}
     store.run('UPDATE tg_settings SET last_update_id=? WHERE id=1 AND last_update_id<?',u.update_id,u.update_id);
    }
   }catch(e){
    if(stopped)break;
    if(e.code===401){tg.setStatus('ERROR','Telegram rejected the bot token. Check it in Administration → Telegram.');break;}
    if(e.code===409){await api('deleteWebhook',{drop_pending_updates:false}).catch(()=>{});tg.setStatus('RECONNECTING','Another program is using this bot token (only one Task Controlling Management should run a bot). Retrying…');}
    else tg.setStatus('RECONNECTING',`Connection to Telegram lost: ${e.message}`);
    await sleep(backoff);backoff=Math.min(backoff*2,60000);
   }
  }
  clearInterval(timer);
 }
 loop=run().catch(e=>{logger.error?.(e);tg.log('error',null,e.message);});
 return {
  token,
  get username(){return me?.username||'';},
  refresh(){if(me)void refreshMenu();},
  flush,
  handleUpdate,
  async stop(){stopped=true;controller.abort();await loop;},
 };
}

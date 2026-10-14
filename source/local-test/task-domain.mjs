export const TASK_SECTIONS={workspace:'Workspace',users:'Users',organization:'Organizational Structure',tasks:'Tasks',requests:'Requests',groups:'Groups',calendar:'Calendar',timesheets:'Timesheets',reports:'Reports'};
// Each section is shown to people who can view its function. Requests belong to the Tasks function.
export const taskSectionResource=key=>'tasks.'+(key==='requests'?'tasks':key==='calendar'?'meetings':key);
/** V5.5: whether a Task Management section is open to someone. The Calendar (meetings, task deadlines and personal
 *  notes) is open to everyone who can use Tasks or Meetings. */
export const taskSectionVisible=(key,can)=>key==='calendar'?can('tasks.tasks')||can('tasks.meetings'):can(taskSectionResource(key));
// V5.6.8: one spelling everywhere (sentence case), the same in the Task Controlling Management, the Mini App, the bot and exports.
export const TASK_STATUS={NOT_STARTED:'Not started',IN_PROGRESS:'In progress',IN_REVIEW:'In review',COMPLETED:'Completed',CANCELLED:'Cancelled'};
export const OPEN_TASK_STATUSES=['NOT_STARTED','IN_PROGRESS','IN_REVIEW'];
export const REQUEST_STATUS={PENDING:'Waiting for answer',APPROVED:'Accepted',DECLINED:'Declined',WITHDRAWN:'Withdrawn'};
export const TASK_SOURCES={WEB:'Task Controlling Management',TELEGRAM:'Telegram',MINIAPP:'Telegram app',MIGRATION:'Earlier version'};
export const TASK_COLORS={BLUE:'#346be6',PURPLE:'#8257ce',TEAL:'#178c8e',ORANGE:'#bc751b',PINK:'#c34483'};
export const localDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Phnom_Penh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export const taskToday=()=>localDay(new Date().toISOString());
export const addDays=(d,n)=>new Date(Date.parse(`${d}T12:00:00Z`)+n*86400000).toISOString().slice(0,10);
export const daysBetween=(from,to)=>Math.round((Date.parse(`${to}T12:00:00Z`)-Date.parse(`${from}T12:00:00Z`))/86400000);
export const weekStart=d=>{const n=new Date(`${d}T12:00:00Z`).getUTCDay();return addDays(d,-(n===0?6:n-1));};
export const formatMinutes=m=>`${Math.floor(Number(m||0)/60)}:${String(Number(m||0)%60).padStart(2,'0')}`;
export function parseDuration(value){const v=String(value??'').trim(),m=/^(\d{1,4}):([0-5]\d)$/.exec(v);if(!m)throw new Error('Use duration H:MM, for example 1:30 for 90 minutes.');return Number(m[1])*60+Number(m[2]);}

// ------------------------------------------------------------------ people and workflow rules
// One person in charge (PIC) plus any number of supporting people. tm_assignees holds all of them, so timesheets
// and membership checks keep working; supporters are the assignees other than the PIC. V5.3: supporting people and
// the reviewer are asked to confirm (status PENDING → ACCEPTED or DECLINED), like the person in charge.
export const RECURRENCE={'':'Does not repeat',DAILY:'Every day',WEEKDAYS:'Every weekday (Mon–Fri)',WEEKLY:'Every week',MONTHLY:'Every month'};
export const RECURRENCE_SHORT={DAILY:'daily',WEEKDAYS:'on weekdays',WEEKLY:'weekly',MONTHLY:'monthly'};
export const REQUEST_DOER={RECEIVER:'The person asked does it',REQUESTER:'The requester does it',DECIDE:'Decided when accepted'};
// Files people can attach to a task (up to 5 MB each). Images show a preview; everything else downloads.
export const TASK_FILE_TYPES={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',heic:'image/heic',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',csv:'text/csv',txt:'text/plain',zip:'application/zip'};
export const TASK_FILE_ACCEPT=Object.keys(TASK_FILE_TYPES).map(x=>'.'+x).join(',');
export const PREVIEW_TYPES=['image/png','image/jpeg','image/webp','image/gif'];
export const ROLE_LABEL={pic:'person in charge',supporter:'supporting person',reviewer:'reviewer'};

// ------------------------------------------------------------------ V5.4 two-party approval
// Every task has two sides: the person in charge and the person who assigned it (the assigner). Once the person
// in charge has accepted an open task that someone else assigned, changing its details, completing it or cancelling
// it takes effect only when the other side approves. A task someone gives themselves needs no approval.
export const CHANGE_STATUS={PENDING:'Waiting for approval',APPROVED:'Approved',REJECTED:'Rejected',WITHDRAWN:'Withdrawn',CLOSED:'Closed'};
export const CHANGE_KIND={UPDATE:'Change details',COMPLETE:'Complete the task',CANCEL:'Cancel the task'};
export const assignerOf=t=>t.assigned_by||t.created_by;
export const activeReviewerOf=t=>t.reviewer_id&&(t.reviewer_status||'ACCEPTED')!=='DECLINED'?t.reviewer_id:null;
export const twoSided=t=>!!t.pic_id&&t.pic_id!==assignerOf(t);
export const needsApproval=t=>OPEN_TASK_STATUSES.includes(t.status)&&twoSided(t)&&!!t.accepted_at&&!t.declined_at;
/** Who completes a task: `review` checks the work first (a reviewer other than both sides); `approver` makes it final
 *  (the assigner on a two-sided task; otherwise the reviewer, or nobody when the person in charge can close it). */
export function completionPath(t){
 const reviewer=activeReviewerOf(t),assigner=assignerOf(t);
 if(twoSided(t))return {review:reviewer&&reviewer!==t.pic_id&&reviewer!==assigner?reviewer:null,approver:assigner};
 return {review:null,approver:reviewer&&reviewer!==t.pic_id?reviewer:null};
}
// Deadline reminders chosen for each task: days before the due date (1–90, up to five). New tasks remind one day before.
export const REMINDER_PRESETS=[1,2,3];
export function reminderDays(value){
 if(value===undefined||value===null||value==='')return [1];
 let list=value;if(typeof value==='string'){try{list=JSON.parse(value);}catch{return [1];}}
 if(!Array.isArray(list))return [1];
 return [...new Set(list.map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=90))].sort((a,b)=>b-a).slice(0,5);
}
export const reminderText=days=>{const d=reminderDays(days);if(!d.length)return 'No reminders';const parts=d.map(n=>`${n}`);return `${parts.length>1?parts.slice(0,-1).join(', ')+' and '+parts.at(-1):parts[0]} day${d.length===1&&d[0]===1?'':'s'} before the due date`;};
export function enrichedTasks(s){
 const workspaces=new Map([...(s.tm_workspace_refs||[]),...s.tm_workspaces].map(w=>[w.id,w])),rows=new Map(),minutes=new Map(),today=taskToday();
 for(const a of s.tm_assignees){if(!rows.has(a.task_id))rows.set(a.task_id,[]);rows.get(a.task_id).push(a);}
 for(const e of s.tm_timesheets||[])minutes.set(e.task_id,(minutes.get(e.task_id)||0)+e.minutes);
 const pendingDue=new Map((s.tm_due_requests||[]).filter(r=>r.status==='PENDING').map(r=>[r.task_id,r]));
 // V5.6.8: a due date request only matters while its task is open (closing a task settles it).
 const pendingChange=new Map((s.tm_change_requests||[]).filter(r=>r.status==='PENDING').map(r=>[r.task_id,r]));
 const checks=new Map();for(const c of s.tm_checklist||[]){const x=checks.get(c.task_id)||[0,0];x[0]++;if(c.done)x[1]++;checks.set(c.task_id,x);}
 const files=new Map();for(const f of s.tm_files||[])files.set(f.task_id,(files.get(f.task_id)||0)+1);
 return s.tm_tasks.map(t=>{
  const list=rows.get(t.id)||[],pic=t.pic_id||list[0]?.staff_id||null,open=OPEN_TASK_STATUSES.includes(t.status),w=workspaces.get(t.workspace_id);
  const support=list.filter(a=>a.staff_id!==pic).map(a=>({staff_id:a.staff_id,status:a.status||'ACCEPTED',responded_at:a.responded_at||null,response_note:a.response_note||'',invited_by:a.invited_by||null}));
  const supporters=support.filter(a=>a.status!=='DECLINED').map(a=>a.staff_id),reviewer_status=t.reviewer_status||'ACCEPTED';
  const pic_state=t.declined_at?'DECLINED':t.accepted_at?'ACCEPTED':'PENDING',[check_total,check_done]=checks.get(t.id)||[0,0];
  // People whose answer (accept or reject) the task is still waiting for.
  const waiting=!open?[]:[
   ...(pic&&pic_state==='PENDING'&&['NOT_STARTED','IN_PROGRESS'].includes(t.status)?[{staff_id:pic,role:'pic'}]:[]),
   ...support.filter(a=>a.status==='PENDING').map(a=>({staff_id:a.staff_id,role:'supporter'})),
   ...(t.reviewer_id&&reviewer_status==='PENDING'?[{staff_id:t.reviewer_id,role:'reviewer'}]:[])];
  const e={...t,pic_id:pic,assigned_by:t.assigned_by||t.created_by,workspace:w?.name||'',workspace_department:w?.department||'',department:t.department||w?.department||'',
   assignees:pic?[pic,...supporters]:supporters,supporters,support,declined_supporters:support.filter(a=>a.status==='DECLINED'),reviewer_status,pic_state,waiting,
   logged_minutes:minutes.get(t.id)||0,check_total,check_done,file_count:files.get(t.id)||0,recurrence:t.recurrence||'',
   overdue:open&&t.due_date<today,stuck:open&&!!t.stuck_at,declined:open&&!!t.declined_at,
   awaiting:t.status==='NOT_STARTED'&&!t.accepted_at&&!t.declined_at,due_request:open?pendingDue.get(t.id)||null:null,
   change_request:pendingChange.get(t.id)||null,reminder_days:reminderDays(t.reminder_days)};
  e.approval=needsApproval(e);
  return e;
 });
}
/** Change requests waiting for this person's approval. A completion asked for by the person in charge travels as
 *  work submitted for review, so it is listed with the reviews instead. */
export const approvalsFor=(s,staff)=>(s.tm_change_requests||[]).filter(c=>c.status==='PENDING'&&c.approver_id===staff&&!(c.kind==='COMPLETE'&&c.requester_side==='PIC'));
/** Everything waiting for one person: tasks to accept or reject (in charge, supporting or reviewing), work submitted to them, changes to approve, and task / due date requests to decide. */
export function waitingFor(s,staff,tasks=enrichedTasks(s)){
 const answer=tasks.filter(t=>(t.waiting||[]).some(x=>x.staff_id===staff));
 const review=tasks.filter(t=>t.status==='IN_REVIEW'&&t.submitted_to===staff);
 const approvals=approvalsFor(s,staff).filter(c=>tasks.some(t=>t.id===c.task_id));
 const requests=(s.tm_requests||[]).filter(q=>q.status==='PENDING'&&q.manager_id===staff);
 const open=new Set(tasks.filter(t=>OPEN_TASK_STATUSES.includes(t.status)).map(t=>t.id));
 const due=(s.tm_due_requests||[]).filter(q=>q.status==='PENDING'&&q.decide_by===staff&&open.has(q.task_id));
 return {answer,review,approvals,requests,due,total:answer.length+review.length+approvals.length+requests.length+due.length};
}
export function workspaceStats(s,id){const tasks=enrichedTasks(s).filter(t=>t.workspace_id===id),active=tasks.filter(t=>t.status!=='CANCELLED');return {tasks:tasks.length,completed:tasks.filter(t=>t.status==='COMPLETED').length,overdue:tasks.filter(t=>t.overdue).length,progress:active.length?Math.round(active.reduce((n,t)=>n+t.progress,0)/active.length):0,minutes:tasks.reduce((n,t)=>n+t.logged_minutes,0),members:s.tm_members.filter(m=>m.workspace_id===id).map(m=>m.staff_id)};}

// Who the viewer is on this task. "Governors" (the creator, the reviewer and anyone allowed to approve tasks) manage
// the task itself: its details, cancelling and reopening. A reviewer who rejected the role is no longer its reviewer;
// supporting people who rejected are no longer supporting. `support` is the list of supporting rows
// ({staff_id,status}); plain staff IDs are treated as accepted.
export function taskRoles(t,staff,support=t.support||[],{canApprove=false}={}){
 const rows=(support||[]).map(x=>typeof x==='string'?{staff_id:x,status:'ACCEPTED'}:x);
 const isPic=!!staff&&t.pic_id===staff,mine=!isPic&&staff?rows.find(x=>x.staff_id===staff):null;
 const supportStatus=mine?(mine.status||'ACCEPTED'):null,isSupporter=supportStatus==='PENDING'||supportStatus==='ACCEPTED';
 const reviewerStatus=!!staff&&t.reviewer_id===staff?(t.reviewer_status||'ACCEPTED'):null,isReviewer=reviewerStatus==='PENDING'||reviewerStatus==='ACCEPTED';
 const isCreator=!!staff&&t.created_by===staff,picState=isPic?(t.declined_at?'DECLINED':t.accepted_at?'ACCEPTED':'PENDING'):null;
 const isAssigner=!!staff&&assignerOf(t)===staff;
 const toAnswer=[picState==='PENDING'&&'pic',supportStatus==='PENDING'&&'supporter',reviewerStatus==='PENDING'&&'reviewer'].filter(Boolean);
 const rejected=[picState==='DECLINED'&&'pic',supportStatus==='DECLINED'&&'supporter',reviewerStatus==='DECLINED'&&'reviewer'].filter(Boolean);
 const isGovernor=isCreator||isReviewer||isAssigner||!!canApprove;
 // V5.4: the side a person acts for when a change needs the other side's approval.
 const side=isPic?'PIC':isGovernor?'ASSIGNER':null;
 return {staff,isPic,isSupporter,isReviewer,isCreator,isAssigner,isGovernor,side,isSubmittedTo:t.status==='IN_REVIEW'&&!!staff&&t.submitted_to===staff,canApprove:!!canApprove,
  picState,supportStatus,reviewerStatus,toAnswer,rejected};
}
const deny=message=>({status:403,message}),conflict=message=>({status:409,message});
// The roles a person can accept or reject on this task (all their open answers unless `role` names one),
// with the reason when there are none.
export function answerRoles(verb,t,r,role){
 const open=OPEN_TASK_STATUSES.includes(t.status),working=['NOT_STARTED','IN_PROGRESS'].includes(t.status),roles=[];let why=null;
 const states={pic:r.picState,supporter:r.supportStatus,reviewer:r.reviewerStatus};
 for(const name of ['pic','supporter','reviewer']){
  const state=states[name];if(!state||(role&&role!==name))continue;
  if(verb==='accept'&&state==='ACCEPTED'){why=why||conflict('You already accepted this task.');continue;}
  if(verb==='decline'&&state!=='PENDING'){why=why||conflict(state==='DECLINED'?'You already rejected this task.':'You already accepted this task. Ask its manager if you can no longer do it.');continue;}
  if(name==='pic'&&!working){why=why||conflict(open?'This task is waiting for review.':'This task is closed.');continue;}
  if(!open){why=why||conflict('This task is closed.');continue;}
  roles.push(name);
 }
 return {roles,block:roles.length?null:(why||deny(`Only people asked to work on or review this task can ${verb==='accept'?'accept':'reject'} it.`))};
}
// Returns null when the action is allowed, otherwise {status,message}. The server enforces these
// rules; the Task Controlling Management screens, the Telegram bot and the Mini App use them to decide which buttons to show.
export function taskBlock(verb,t,r,opts={}){
 const open=OPEN_TASK_STATUSES.includes(t.status),working=['NOT_STARTED','IN_PROGRESS'].includes(t.status),worker=r.isPic||r.isSupporter;
 const declinedByMe=r.isPic&&!!t.declined_at,cr=t.change_request||null,path=completionPath(t),two=needsApproval(t),sided=twoSided(t);
 const waitingChange=()=>conflict('A change to this task is already waiting for approval. Wait for the answer, or withdraw it.');
 // V5.4 completion: the person in charge submits; a reviewer (if any) passes it on; the approver makes it final.
 const completionAsked=!!cr&&cr.kind==='COMPLETE'&&cr.requester_side==='PIC',approver=completionAsked?cr.approver_id:path.approver;
 switch(verb){
  case 'close':
   if(!open)return conflict('This task is already closed.');
   if(r.isPic){
    if(declinedByMe)return conflict('You rejected this task. Accept it first to continue.');
    // A task someone gave themselves can be closed directly (a reviewer, if any, is optional).
    if(!sided)return null;
    return conflict(t.status==='IN_REVIEW'&&t.submitted_to!==t.pic_id?'This task is waiting for approval.':'Submit it for approval: the task is completed once it is approved.');
   }
   if(t.status==='IN_REVIEW'){
    if(r.isSubmittedTo)return !approver||r.staff===approver?null:conflict('Pass it on for approval: someone else makes the completion final.');
    if(r.staff===approver&&completionAsked)return null;
    return t.submitted_to===t.pic_id?conflict('The person in charge is checking work a supporting person submitted. Try again once they submit or return it.'):deny('Only the person who approves this task can complete it.');
   }
   if(r.side==='ASSIGNER'&&two)return cr?waitingChange():null;
   return deny('Only the person in charge, or the person who approves the task, can complete it.');
  case 'pass':
   if(t.status!=='IN_REVIEW')return conflict('This task is not waiting for review.');
   if(!r.isSubmittedTo)return deny('Only the person reviewing this task can pass it on.');
   if(r.isPic)return conflict('Submit the task for approval instead.');
   return approver&&approver!==r.staff?null:conflict('You make the final decision on this task: complete it or return it.');
  case 'return':
   if(t.status!=='IN_REVIEW')return conflict('This task is not waiting for review.');
   if(r.isSubmittedTo||(r.staff===approver&&completionAsked))return null;
   return deny('Only the person this task was submitted to can return it.');
  case 'reminders':
   if(!open)return conflict('This task is closed.');
   return r.isPic||r.isGovernor?null:deny('Only the person in charge or the task’s assigner can change its reminders.');
  case 'accept':case 'decline':return answerRoles(verb,t,r,opts.role).block;
  case 'progress':case 'stuck':
   // V5.5: the assigner's side may also propose a new progress figure on a task both sides agreed to; the person in
   // charge approves it before it shows (the same two-party rule in the other direction).
   if(verb==='progress'&&!worker&&r.side==='ASSIGNER'&&two)return !working?conflict(t.status==='IN_REVIEW'?'This task is waiting for review.':'This task is closed.'):cr?waitingChange():null;
   if(!worker)return deny(`Only the person in charge or a supporting person can ${verb==='stuck'?'mark this task as stuck':'update progress'}.`);
   if(!working)return conflict(t.status==='IN_REVIEW'?'This task is waiting for review. It must be returned before more work is recorded.':'This task is closed.');
   if(declinedByMe)return conflict('You rejected this task. Accept it first to continue.');
   if(!r.isPic&&!t.accepted_at)return conflict('The person in charge must accept this task first.');
   if(verb==='stuck'&&t.stuck_at)return conflict('This task is already marked as stuck.');
   return null;
  case 'resume':
   if(!(worker||r.isGovernor))return deny('Only people working on this task or its manager can resume it.');
   if(!t.stuck_at)return conflict('This task is not marked as stuck.');
   return null;
  case 'submit':
   if(r.isPic){
    if(declinedByMe)return conflict('You rejected this task. Accept it first to continue.');
    if(t.status==='IN_REVIEW'&&t.submitted_to!==t.pic_id)return conflict('This task is already waiting for review.');
    if(!open)return conflict('This task is closed.');
    if(!approver&&!path.review)return conflict('Nobody else needs to approve this task, so you can close it yourself.');
    return cr?waitingChange():null;
   }
   if(r.isSupporter){
    if(!t.accepted_at||t.declined_at)return conflict('The person in charge must accept this task first.');
    if(t.status==='IN_REVIEW')return conflict('This task is already waiting for review.');
    if(t.status!=='IN_PROGRESS')return conflict(open?'The task must be in progress before it is submitted.':'This task is closed.');
    return null;
   }
   return deny('Only the person in charge or a supporting person can submit this task.');
  case 'cancel':
   if(!open)return conflict('This task is already closed.');
   if(r.isPic&&sided&&(!t.accepted_at||t.declined_at))return conflict(t.declined_at?'You rejected this task. Its assigner decides what happens next.':'You have not accepted this task yet: reject it instead, with a reason.');
   if(!(r.isGovernor||r.isPic))return deny('Only the person in charge, the reviewer or the person who assigned the task can cancel it.');
   return cr?waitingChange():null;
  case 'reopen':
   if(open)return conflict('This task is already open.');
   if(!(r.isGovernor||r.isPic))return deny('Only the person in charge or the task’s manager can reopen it.');
   // V5.6.8: reopening a task both sides agreed to close needs the other side's approval (see reopenNeedsApproval).
   return cr?waitingChange():null;
  case 'edit':
   if(!(r.isGovernor||r.isPic))return deny('Only the task’s manager or the person in charge can edit this task.');
   return cr?waitingChange():null;
  case 'note':
   return worker||r.isGovernor||r.isSubmittedTo?null:deny('Only people working on this task or its manager can comment.');
  case 'due':
   if(!worker)return deny('Only the person in charge or a supporting person can ask for a new due date.');
   if(!open)return conflict('This task is closed.');
   // On a task someone else assigned, the new date the person in charge asks for goes to the assigner for approval.
   if(r.isPic&&sided)return cr?waitingChange():null;
   if(r.isGovernor)return conflict('You manage this task, so you can change its due date directly.');
   if(cr)return waitingChange();
   if(t.due_request)return conflict('A due date request for this task is already waiting for a decision.');
   return null;
  case 'handover':
   if(!r.isPic)return deny('Only the person in charge can hand this task over.');
   if(!working)return conflict(t.status==='IN_REVIEW'?'Return or close the review before handing the task over.':'This task is closed.');
   return cr?waitingChange():null;
  case 'remind':
   if(!(r.isGovernor||r.isPic))return deny('Only the person in charge or the task’s manager can send a reminder.');
   if(!open)return conflict('This task is closed.');
   if(!(t.waiting||[]).some(x=>x.staff_id!==r.staff))return conflict('Nobody on this task is waiting to answer.');
   return null;
  case 'checklist':
   if(!open)return conflict('This task is closed.');
   if(r.isGovernor&&!worker)return null;
   if(!worker)return deny('Only people working on this task or its manager can change the checklist.');
   if(declinedByMe)return conflict('You rejected this task. Accept it first to continue.');
   if(!r.isPic&&!t.accepted_at&&!r.isGovernor)return conflict('The person in charge must accept this task first.');
   return null;
  case 'file':
   if(t.status==='CANCELLED')return conflict('This task is cancelled.');
   return worker||r.isGovernor||r.isSubmittedTo?null:deny('Only people on this task or its manager can add files.');
  default:return deny('This task action is not available.');
 }
}
export const TASK_VERBS=['accept','decline','progress','stuck','resume','submit','pass','return','close','cancel','reopen','note','due','edit','handover','remind','reminders','checklist','file'];
export function taskActions(t,staff,opts={}){
 const r=taskRoles(t,staff,t.support||t.supporters||[],opts);let allowed=TASK_VERBS.filter(v=>!taskBlock(v,t,r));
 // Until they answer, people asked to take charge or to support first accept or reject (and can still comment).
 if(r.isPic&&t.status==='NOT_STARTED'&&(!t.accepted_at||t.declined_at))allowed=allowed.filter(v=>['accept','decline','edit','note','cancel','handover','file','reminders'].includes(v));
 else if(r.supportStatus==='PENDING'&&!r.isGovernor)allowed=allowed.filter(v=>['accept','decline','note','file'].includes(v));
 return {roles:r,allowed,approval:needsApproval(t),path:completionPath(t)};
}
/** V5.4: who must approve this person's change to the task (edit, cancel, completion, hand-over), as far as the screen
 *  can tell (the server picks a substitute if that person can no longer use the Task Controlling Management), or null when it applies at once.
 *  Changes the person in charge proposes always go to the assigner; the assigner's side needs the person in charge's
 *  approval once they have accepted the task (before that, they accept or reject the task as it stands). */
export function approvalTarget(t,staff){
 if(!staff||!OPEN_TASK_STATUSES.includes(t.status)||!twoSided(t))return null;
 if(staff===t.pic_id)return assignerOf(t);
 return t.pic_id;
}
/** V5.4: whose approval a change of a task's details needs. Like approvalTarget, and also for a completed or cancelled
 *  task both sides had agreed to, so its record (for example the person in charge, before reopening it) can't be
 *  rewritten by one side alone. */
export function editApprovalTarget(t,staff){
 if(OPEN_TASK_STATUSES.includes(t.status))return approvalTarget(t,staff);
 if(!staff||!twoSided(t))return null;
 return staff===t.pic_id?assignerOf(t):t.pic_id;
}
/** V5.4: an open task this person gave to someone else (they are its assigner). */
export const assignedByMe=(t,me)=>OPEN_TASK_STATUSES.includes(t.status)&&assignerOf(t)===me&&t.pic_id!==me;
/** V5.4: a task waiting for this person to review its work or approve a change to it. */
export const toReviewOrApprove=(t,me)=>(t.status==='IN_REVIEW'&&t.submitted_to===me)||(!!t.change_request&&t.change_request.approver_id===me&&!(t.change_request.kind==='COMPLETE'&&t.change_request.requester_side==='PIC'));
/** The person who makes a completion final: the approver of a pending completion request, otherwise the task's approver. */
export const completionApprover=t=>{const cr=t.change_request;return cr&&cr.kind==='COMPLETE'&&cr.requester_side==='PIC'?cr.approver_id:completionPath(t).approver;};
// The single status label people see, including the workflow flags that sit alongside the status.
export function taskStateLabel(t){
 if(t.status==='IN_REVIEW')return 'In review';
 if(!OPEN_TASK_STATUSES.includes(t.status))return TASK_STATUS[t.status];
 if(t.declined_at)return 'Rejected';
 if(t.stuck_at)return 'Stuck';
 if(t.status==='NOT_STARTED')return t.accepted_at?'Accepted':'Awaiting acceptance';
 return TASK_STATUS[t.status];
}
// The reviewer decides due date requests unless they rejected the role; then the task's creator does.
export const dueDecider=t=>t.reviewer_id&&(t.reviewer_status||'ACCEPTED')!=='DECLINED'?t.reviewer_id:t.created_by;
/** V5.6.8: whether `staff` may decide the pending due date request `q` on task `t` — the same rule the server applies:
 *  the person it was sent to, the task's current due decider (its reviewer, else its creator), or a task approver who is on
 *  the task (`involved`: the task is visible to them because they are on it, not only through oversight). */
export const canDecideDue=(t,q,staff,{canApprove=false,involved=false}={})=>!!staff&&!!t&&!!q&&q.status==='PENDING'&&OPEN_TASK_STATUSES.includes(t.status)
 &&(q.decide_by===staff||dueDecider(t)===staff||(!!canApprove&&!!involved));
/** V5.6.8: who may change a meeting's time, people, organizer or details, or cancel it: its organizer, whoever scheduled it,
 *  or a participant who may approve meetings. Other participants can still complete it with notes and keep their own
 *  reminders; people it is shared with only follow it. The server applies the same rule. */
export const canManageMeeting=(m,staff,{participant=false,canApprove=false}={})=>!!staff&&!!m&&(m.organizer_id===staff||m.created_by===staff||!!participant);
/** V5.6.8: reopening a completed or cancelled task both sides had agreed to is a change like any other: it applies once
 *  the other side approves it. Returns that person (the screens then say “Ask to reopen…”), or null when it reopens at once. */
export const reopenNeedsApproval=(t,staff)=>!OPEN_TASK_STATUSES.includes(t.status)?editApprovalTarget(t,staff):null;
// Repeating tasks: the next due date after `from` (YYYY-MM-DD). Monthly tasks keep the day of the month of the
// first task in the series (anchorDay), moved to the month's last day when that month is shorter.
export function nextOccurrence(rule,from,anchorDay){
 if(rule==='DAILY')return addDays(from,1);
 if(rule==='WEEKLY')return addDays(from,7);
 if(rule==='WEEKDAYS'){let d=addDays(from,1);while([0,6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))d=addDays(d,1);return d;}
 if(rule==='MONTHLY'){
  const [y,m,day]=from.split('-').map(Number),ny=m===12?y+1:y,nm=m===12?1:m+1,last=new Date(Date.UTC(ny,nm,0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2,'0')}-${String(Math.min(anchorDay||day,last)).padStart(2,'0')}`;
 }
 return null;
}

// ------------------------------------------------------------------ monthly reports
const validDay=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const t=Date.parse(`${v}T12:00:00Z`);return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;};
const reportError=message=>Object.assign(new Error(message),{status:400});
export const currentMonth=()=>taskToday().slice(0,7);
export function monthBounds(month=currentMonth()){
 if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw reportError('Choose a valid month (YYYY-MM).');
 const [y,m]=month.split('-').map(Number),next=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;
 const start=Date.parse(`${month}-01T00:00:00+07:00`),end=Date.parse(`${next}-01T00:00:00+07:00`);
 return {month,start,end,firstDay:`${month}-01`,lastDay:addDays(`${next}-01`,-1),label:new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${month}-15T12:00:00Z`))};
}
export const shiftMonth=(month,n)=>{const [y,m]=month.split('-').map(Number),i=y*12+(m-1)+n;return `${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;};
// Rebuilds a task's state over time from its workflow history (tm_task_history). Tasks from earlier
// versions receive a starting history row when the database is upgraded.
export function taskTimeline(t,rows=[]){
 const list=rows.map(h=>({at:Date.parse(h.created_at),kind:h.kind,status:h.to_status||t.status,stuck:!!h.stuck,progress:h.progress??t.progress,due_date:h.due_date||t.due_date,note:h.note||''}));
 if(list.length)return list;
 const created=Date.parse(t.created_at),done=['COMPLETED','CANCELLED'].includes(t.status);
 const out=[{at:created,kind:'create',status:done?'IN_PROGRESS':t.status,stuck:!done&&!!t.stuck_at,progress:done?0:t.progress,due_date:t.due_date,note:''}];
 if(done)out.push({at:Date.parse(t.completed_at||t.updated_at),kind:t.status==='COMPLETED'?'close':'cancel',status:t.status,stuck:false,progress:t.progress,due_date:t.due_date,note:''});
 return out;
}
const stateAt=(line,ms)=>{let s=null;for(const e of line){if(e.at<ms)s=e;else break;}return s;};
export function classifyMonth(t,line,b,nowMs=Date.now()){
 const cutoff=Math.min(b.end,nowMs),end=stateAt(line,cutoff);
 if(!end)return null;
 const cutoffDay=cutoff===b.end?addDays(b.lastDay,1):localDay(new Date(cutoff).toISOString());
 const out={status:end.status,stuck:end.stuck,progress:end.progress,due_date:end.due_date,completed:null,inProgress:false,stuckInfo:null,overdue:null};
 // Completed: closed during the month and still closed at the end of it.
 let completedAt=null;
 for(let i=0;i<line.length&&line[i].at<cutoff;i++){const e=line[i];if(e.at>=b.start&&e.status==='COMPLETED'&&line[i-1]?.status!=='COMPLETED')completedAt=e;}
 if(end.status==='COMPLETED'&&completedAt){const day=localDay(new Date(completedAt.at).toISOString());out.completed={at:new Date(completedAt.at).toISOString(),day,late:day>completedAt.due_date,due_date:completedAt.due_date};}
 out.inProgress=['IN_PROGRESS','IN_REVIEW'].includes(end.status)&&!end.stuck;
 // Stuck: marked stuck at any time during the month, including tasks that were already stuck when it began.
 // Each history state lasts until the next entry; a stuck run is reported by the entry that started it.
 let run=null,found=null;
 for(let i=0;i<line.length&&line[i].at<cutoff;i++){
  const e=line[i];run=e.stuck&&OPEN_TASK_STATUSES.includes(e.status)?(run||e):null;
  if(run&&(line[i+1]?.at??Infinity)>b.start)found=run;
 }
 if(found)out.stuckInfo={since:new Date(found.at).toISOString(),reason:found.note,still:!!end.stuck&&OPEN_TASK_STATUSES.includes(end.status)};
 // Overdue: open past its due date at the end of the month (or today), or completed late during it.
 if(OPEN_TASK_STATUSES.includes(end.status)&&end.due_date<cutoffDay)out.overdue={days:daysBetween(end.due_date,cutoffDay),late_completion:false};
 else if(out.completed?.late)out.overdue={days:daysBetween(out.completed.due_date,out.completed.day),late_completion:true};
 return out;
}
export const MONTHLY_REPORTS={monthly:'Monthly task summary',monthly_completed:'Monthly completed tasks',monthly_progress:'Monthly tasks in progress',monthly_stuck:'Monthly stuck tasks',monthly_overdue:'Monthly overdue tasks'};
export const MONTHLY_CATEGORIES=[['completed','Completed','monthly_completed'],['in_progress','In progress','monthly_progress'],['stuck','Stuck','monthly_stuck'],['overdue','Overdue','monthly_overdue']];
export function monthlyTaskRows(s,f={}){
 const b=monthBounds(f.month||currentMonth()),name=id=>s.lookups.find(l=>l.id===id)?.name||id||'—',history=new Map();
 for(const h of s.tm_task_history||[]){if(!history.has(h.task_id))history.set(h.task_id,[]);history.get(h.task_id).push(h);}
 for(const list of history.values())list.sort((a,c)=>a.id-c.id);
 const tasks=enrichedTasks(s).filter(t=>(!f.workspace||t.workspace_id===f.workspace)&&(!f.user||t.assignees.includes(f.user))&&(!f.pic||t.pic_id===f.pic)&&(!f.department||t.department===f.department));
 const rows=[],summary={completed:0,in_progress:0,stuck:0,overdue:0};
 for(const t of tasks){
  const c=classifyMonth(t,taskTimeline(t,history.get(t.id)||[]),b,f.now?Date.parse(f.now):Date.now());if(!c)continue;
  const base={id:t.id,title:t.title,workspace:t.workspace,workspace_id:t.workspace_id,department:t.department,department_note:t.department_note||'',pic_id:t.pic_id,pic:name(t.pic_id),supporters:t.supporters.map(name).join(', '),reviewer:t.reviewer_id?name(t.reviewer_id):'',due_date:c.due_date,status:TASK_STATUS[c.status]||c.status,progress:c.progress,priority:t.priority};
  if(c.completed){summary.completed++;rows.push({...base,category:'completed',group:'Completed',completed_on:c.completed.day,on_time:c.completed.late?'Late':'On time',detail:`Completed ${c.completed.day}${c.completed.late?' (after the due date)':''}`});}
  if(c.inProgress){summary.in_progress++;rows.push({...base,category:'in_progress',group:'In progress',detail:`${c.progress}% complete${c.status==='IN_REVIEW'?' · waiting for review':''}`});}
  if(c.stuckInfo){summary.stuck++;rows.push({...base,category:'stuck',group:'Stuck',stuck_since:localDay(c.stuckInfo.since),stuck_reason:c.stuckInfo.reason,still_stuck:c.stuckInfo.still?'Yes':'No',detail:`Stuck since ${localDay(c.stuckInfo.since)}${c.stuckInfo.reason?': '+c.stuckInfo.reason:''}${c.stuckInfo.still?'':' (resolved)'}`});}
  if(c.overdue){summary.overdue++;rows.push({...base,category:'overdue',group:'Overdue',days_overdue:c.overdue.days,overdue_kind:c.overdue.late_completion?'Completed late':'Still open',detail:c.overdue.late_completion?`Completed ${c.overdue.days} day${c.overdue.days===1?'':'s'} late`:`${c.overdue.days} day${c.overdue.days===1?'':'s'} past due`});}
 }
 return {bounds:b,rows,summary};
}
const MONTHLY_COLUMNS={
 monthly:[['group','Category'],['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['status','Status'],['due_date','Due'],['detail','Details']],
 monthly_completed:[['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['supporters','Supporting'],['due_date','Due'],['completed_on','Completed'],['on_time','On time']],
 monthly_progress:[['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['supporters','Supporting'],['status','Status'],['progress','Progress %'],['due_date','Due']],
 monthly_stuck:[['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['stuck_since','Stuck since'],['stuck_reason','Blocker'],['still_stuck','Still stuck']],
 monthly_overdue:[['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['due_date','Due'],['status','Status'],['days_overdue','Days overdue'],['overdue_kind','Result']],
};

export const TASK_REPORTS={...MONTHLY_REPORTS,tasks:'Task register',workload:'Workload by user',time:'Timesheet detail',workspace:'Workspace performance',meetings:'Meeting register'};
export function buildTaskReport(s,f={}){
 const id=f.report||'tasks';if(!Object.hasOwn(TASK_REPORTS,id))throw reportError('Unknown task report.');
 for(const key of ['from','to'])if(f[key]&&!validDay(f[key]))throw reportError('Enter valid report dates.');
 if(f.from&&f.to&&f.from>f.to)throw reportError('The report end date must be on or after its start date.');
 const name=id=>s.lookups.find(l=>l.id===id)?.name||id||'—';
 if(Object.hasOwn(MONTHLY_REPORTS,id)){
  const {bounds,rows,summary}=monthlyTaskRows(s,f),category=MONTHLY_CATEGORIES.find(c=>c[2]===id)?.[0];
  const order={completed:0,in_progress:1,stuck:2,overdue:3};
  const list=(category?rows.filter(r=>r.category===category):rows).sort((a,b)=>order[a.category]-order[b.category]||String(a.due_date).localeCompare(String(b.due_date))||a.id.localeCompare(b.id));
  return {id,title:`${TASK_REPORTS[id]} · ${bounds.label}`,company:s.company.name,currency:s.company.currency,columns:MONTHLY_COLUMNS[id],rows:list,totals:{},summary,month:bounds.month,month_label:bounds.label,groups:[],filters:{...f,month:bounds.month},generated_at:new Date().toISOString()};
 }
 const tasks=enrichedTasks(s).filter(t=>(!f.workspace||t.workspace_id===f.workspace)&&(!f.user||t.assignees.includes(f.user))&&(!f.department||t.department===f.department));
 const period=d=>(!f.from||d>=f.from)&&(!f.to||d<=f.to);
 let rows=[],columns=[];
 if(id==='tasks'){
  rows=tasks.filter(t=>period(t.due_date)&&(!f.status||t.status===f.status)).map(t=>({...t,group:t.workspace,pic:name(t.pic_id),supporting:t.supporters.map(name).join(', '),assigned_to:t.assignees.map(name).join(', '),status:TASK_STATUS[t.status],state:taskStateLabel(t),logged:formatMinutes(t.logged_minutes),estimate:formatMinutes(t.estimate_minutes),overdue:t.overdue?'Yes':'No'}));
  columns=[['id','Task'],['title','Title'],['workspace','Workspace'],['department','Department'],['pic','Person in charge'],['supporting','Supporting'],['start_date','Start'],['due_date','Due'],['status','Status'],['state','Workflow state'],['priority','Priority'],['progress','Progress %'],['estimate','Estimated H:MM'],['logged','Logged H:MM'],['overdue','Overdue']];
 }else if(id==='time'){
  rows=s.tm_timesheets.filter(e=>period(e.work_date)&&(!f.user||e.staff_id===f.user)).map(e=>{const t=s.tm_tasks.find(t=>t.id===e.task_id)||(s.tm_task_options||[]).find(t=>t.id===e.task_id)||{workspace_id:e.workspace_id||'',title:e.activity||'Independent work'};return {...e,workspace_id:t.workspace_id,group:name(e.staff_id),user:name(e.staff_id),task:t.title,workspace:s.tm_workspaces.find(w=>w.id===t.workspace_id)?.name,duration:formatMinutes(e.minutes)};}).filter(e=>!f.workspace||e.workspace_id===f.workspace);
  columns=[['work_date','Date'],['user','User'],['task_id','Task'],['task','Title'],['workspace','Workspace'],['duration','H:MM'],['minutes','Minutes'],['notes','Notes']];
 }else if(id==='workload'){
  // V5.5: without company-wide access, only the people whose work this person can see (their team and the people on
  // tasks they can see) are listed, so the report never hints at work outside their scope.
  const limit=s.task_scope&&!s.task_scope.company?new Set([...tasks.flatMap(t=>t.assignees),...s.tm_timesheets.map(e=>e.staff_id),...(s.task_scope.team||[]),...(s.auth?.user?.staff_id?[s.auth.user.staff_id]:[])]):null;
  rows=s.tm_profiles.filter(p=>(!limit||limit.has(p.staff_id))&&(!f.user||p.staff_id===f.user)).map(p=>{const own=tasks.filter(t=>t.assignees.includes(p.staff_id)&&period(t.due_date)),entries=s.tm_timesheets.filter(e=>e.staff_id===p.staff_id&&period(e.work_date)&&(!f.workspace||(e.workspace_id||s.tm_tasks.find(t=>t.id===e.task_id)?.workspace_id)===f.workspace));return {id:p.staff_id,group:'Team',user:name(p.staff_id),tasks:own.length,in_charge:own.filter(t=>t.pic_id===p.staff_id).length,open:own.filter(t=>!['COMPLETED','CANCELLED'].includes(t.status)).length,completed:own.filter(t=>t.status==='COMPLETED').length,stuck:own.filter(t=>t.stuck).length,overdue:own.filter(t=>t.overdue).length,minutes:entries.reduce((n,e)=>n+e.minutes,0),logged:formatMinutes(entries.reduce((n,e)=>n+e.minutes,0))};});
  columns=[['user','User'],['tasks','Assigned tasks'],['in_charge','In charge'],['open','Open'],['completed','Completed'],['stuck','Stuck'],['overdue','Overdue'],['logged','Logged H:MM']];
 }else if(id==='workspace'){
  rows=s.tm_workspaces.filter(w=>!f.workspace||w.id===f.workspace).map(w=>{const own=tasks.filter(t=>t.workspace_id===w.id&&period(t.due_date)),eligible=own.filter(t=>t.status!=='CANCELLED'),ids=new Set(own.map(t=>t.id)),minutes=s.tm_timesheets.filter(e=>ids.has(e.task_id)&&period(e.work_date)&&(!f.user||e.staff_id===f.user)).reduce((n,e)=>n+e.minutes,0);return {id:w.id,group:'Workspaces',workspace:w.name,department:w.department,owner:name(w.owner_id),status:w.status,tasks:own.length,completed:own.filter(t=>t.status==='COMPLETED').length,overdue:own.filter(t=>t.overdue).length,progress:eligible.length?Math.round(eligible.reduce((n,t)=>n+t.progress,0)/eligible.length):0,minutes,logged:formatMinutes(minutes)};});
  columns=[['workspace','Workspace'],['department','Department'],['owner','Owner'],['status','Status'],['tasks','Tasks'],['completed','Completed'],['overdue','Overdue'],['progress','Progress %'],['logged','Logged H:MM']];
 }else{
  rows=s.tm_meetings.filter(m=>(!f.workspace||m.workspace_id===f.workspace)&&(!f.user||s.tm_attendees.some(a=>a.meeting_id===m.id&&a.staff_id===f.user))&&period(localDay(m.start_at))&&(!f.status||m.status===f.status)).map(m=>({...m,group:'Meetings',workspace:s.tm_workspaces.find(w=>w.id===m.workspace_id)?.name,organizer:name(m.organizer_id),date:localDay(m.start_at),attendees:s.tm_attendees.filter(a=>a.meeting_id===m.id).map(a=>name(a.staff_id)).join(', ')}));
  columns=[['id','Meeting'],['title','Subject'],['workspace','Workspace'],['date','Date (Cambodia)'],['start_at','Start UTC'],['end_at','End UTC'],['status','Status'],['organizer','Organizer'],['attendees','Attendees'],['minutes_notes','Meeting notes']];
 }
 return {id,title:TASK_REPORTS[id],company:s.company.name,currency:s.company.currency,columns,rows,totals:{minutes:rows.reduce((n,r)=>n+Number(r.minutes||0),0)},groups:[],filters:f,generated_at:new Date().toISOString()};
}

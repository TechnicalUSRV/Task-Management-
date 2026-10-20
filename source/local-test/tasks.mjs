import {isPersonalWorkspace} from './workspace-privacy.mjs';
import {readFileSync} from 'node:fs';
import {TASK_STATUS,TASK_COLORS,OPEN_TASK_STATUSES,RECURRENCE,RECURRENCE_SHORT,TASK_FILE_TYPES,parseDuration,taskRoles,taskBlock,answerRoles,dueDecider,nextOccurrence,taskToday,addDays,daysBetween,localDay,
 assignerOf,needsApproval,twoSided,completionPath,approvalTarget,editApprovalTarget,reopenNeedsApproval,canManageMeeting,reminderDays,reminderText,taskStateLabel,formatMinutes} from './task-domain.mjs';
import {createGroups} from './task-groups.mjs';
import {migrateEnhancements} from './enhancement-migration.mjs';
import {normalizeRule,scheduledNext} from './recurrence.mjs';
import {createMeetingWorkflow} from './meeting-workflow.mjs';
import {createTaskScope} from './task-scope.mjs';
import {contentMatches} from './file-check.mjs';

// Columns added in V5.2 and V5.3. New databases get them from tasks.sql; earlier databases are upgraded below.
const V52_TASK_COLUMNS=[['pic_id','TEXT REFERENCES lookups(id)'],['reviewer_id','TEXT REFERENCES lookups(id)'],['department',"TEXT NOT NULL DEFAULT ''"],['department_note',"TEXT NOT NULL DEFAULT ''"],
 ['accepted_at','TEXT'],['declined_at','TEXT'],['declined_reason',"TEXT NOT NULL DEFAULT ''"],['stuck_at','TEXT'],['stuck_by','TEXT REFERENCES lookups(id)'],['stuck_reason',"TEXT NOT NULL DEFAULT ''"],
 ['submitted_to','TEXT REFERENCES lookups(id)'],['submitted_by','TEXT REFERENCES lookups(id)'],['submitted_at','TEXT'],['submit_note',"TEXT NOT NULL DEFAULT ''"],
 ['closed_by','TEXT REFERENCES lookups(id)'],['request_id','TEXT REFERENCES tm_requests(id)'],['source',"TEXT NOT NULL DEFAULT 'WEB'"]];
const V53_TASK_COLUMNS=[['reviewer_status',"TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK(reviewer_status IN('PENDING','ACCEPTED','DECLINED'))"],['reviewer_responded_at','TEXT'],['reviewer_note',"TEXT NOT NULL DEFAULT ''"],
 ['recurrence',"TEXT NOT NULL DEFAULT '' CHECK(recurrence IN('','DAILY','WEEKDAYS','WEEKLY','MONTHLY'))"],['recurrence_until','TEXT'],['series_id','TEXT'],['next_task_id','TEXT'],['scheduled_due','TEXT'],['series_anchor','INTEGER']];
const V53_ASSIGNEE_COLUMNS=[['status',"TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK(status IN('PENDING','ACCEPTED','DECLINED'))"],['invited_by','TEXT REFERENCES lookups(id)'],['invited_at','TEXT'],['responded_at','TEXT'],['response_note',"TEXT NOT NULL DEFAULT ''"]];
const V53_REQUEST_COLUMNS=[['doer',"TEXT NOT NULL DEFAULT 'REQUESTER' CHECK(doer IN('RECEIVER','REQUESTER','DECIDE'))"]];
const V54_TASK_COLUMNS=[['assigned_by','TEXT REFERENCES lookups(id)'],['reminder_days',"TEXT NOT NULL DEFAULT '[1]'"]];
// V5.5: reporting lines and time zones, meeting sharing and reminders, calendar reminders in notifications, and a shared
// default layout for each group.
const V55_COLUMNS={tm_profiles:[['manager_id','TEXT REFERENCES lookups(id)'],['timezone',"TEXT NOT NULL DEFAULT ''"],['sidebar_theme',"TEXT NOT NULL DEFAULT ''"]],
 tm_meetings:[['share_scope',"TEXT NOT NULL DEFAULT 'PARTICIPANTS' CHECK(share_scope IN('PARTICIPANTS','WORKSPACE','COMPANY','SELECTED'))"],['reminder_offsets',"TEXT NOT NULL DEFAULT '[]'"],['created_by','TEXT REFERENCES lookups(id)']],
 tm_notifications:[['meeting_id','TEXT'],['note_id','TEXT']],company:[['timezone',"TEXT NOT NULL DEFAULT ''"]],tm_boards:[['layout_json',"TEXT NOT NULL DEFAULT '{}'"]]};
const SOURCES=['WEB','TELEGRAM','MINIAPP'];
const DAY=new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const human=d=>d?DAY.format(new Date(`${d}T12:00:00Z`)):'';
const FLOW_LABELS={accept:'Task accepted',decline:'Task rejected',progress:'Progress updated',stuck:'Marked as stuck',resume:'Work resumed',submit:'Submitted for review',pass:'Passed on for approval',return:'Returned for more work',close:'Task closed',cancel:'Task cancelled',reopen:'Task reopened',note:'Comment added'};
const BASE64=/^[A-Za-z0-9+/]*={0,2}$/;
// V5.5: valid IANA time zones for people and the company ('' = not set: the company's, then Cambodia's).
const ZONES=new Set(typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[]);ZONES.add('UTC');ZONES.add('Asia/Phnom_Penh');
export const DEFAULT_ZONE='Asia/Phnom_Penh';
// V5.6.8: the sidebar colour each person chooses for themselves ('' = the standard deep blue).
export const SIDEBAR_THEMES=['blue','graphite','light','red','teal'];
const MAX_FILE=30*1024*1024,MAX_PHOTO=2*1024*1024,MAX_FILES=30,MAX_CHECKS=50;

export function createTasks(c){
 const {db,get,all,run,insert,update,id,lookup,record,version,event,fail,str,choice,date,instant,integer,now,today}=c;
 // hooks.canStaff(staffId, resource, action) is provided by Administration once it has loaded.
 const hooks=c.hooks||{canStaff:()=>false};
 db.exec(readFileSync(new URL('./tasks.sql',import.meta.url),'utf8'));
 migrate();
 migrateEnhancements(c);
 // V5.5: one Task Visibility Scope for every screen, the bot, the Mini App, reports and commands (task-scope.mjs).
 const scope=createTaskScope({get,all,governance:()=>hooks.organization,can:(staff,resource,action)=>!!hooks.canStaff(staff,resource,action)});
 // A task (or something on it) that this person may not see is answered exactly like one that does not exist.
 const hidden=()=>fail('Task Management record not found.',404);
 const zoneOf=staff=>{const own=staff?get('SELECT timezone FROM tm_profiles WHERE staff_id=?',staff)?.timezone:'';return own||get('SELECT timezone FROM company WHERE id=1')?.timezone||DEFAULT_ZONE;};
 const zoneInput=(v,label='Time zone')=>{const z=str(v,label,64);if(z&&!ZONES.has(z))fail(`Choose a valid ${label.toLowerCase()} (for example Asia/Phnom_Penh).`);return z;};
 const find=(table,key)=>get(`SELECT * FROM ${table} WHERE id=?`,str(key,'Record ID',60,true))||fail('Task Management record not found.',404);
 const workspace=key=>find('tm_workspaces',key);
 const activeWorkspace=key=>{const w=workspace(key);if(w.status!=='ACTIVE')fail('Restore the workspace before changing its work.');return w;};
 const profile=staff=>{lookup(staff,'staff');const p=get('SELECT * FROM tm_profiles WHERE staff_id=?',staff);if(p?.active===0)fail('Choose an active team member.');return p;};
 const isMember=(wid,staff)=>!!get('SELECT 1 AS ok FROM tm_members WHERE workspace_id=? AND staff_id=?',wid,staff);
 const nameOf=staff=>{const r=get("SELECT l.name,p.nickname FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=?",staff);return r?r.name+(r.nickname?` (${r.nickname})`:''):staff||'';};
 const canonicalName=staff=>get('SELECT name FROM lookups WHERE id=?',staff)?.name||staff||'';
 const accountOf=staff=>get('SELECT id,active FROM access_users WHERE staff_id=?',staff);
 // Anyone whose login includes Task Management can be given work or asked for a task, whatever their role.
 // Team profiles without a login (from earlier versions) can still be assigned.
 const assignable=input=>{
  const key=lookup(input,'staff');profile(key);
  const a=accountOf(key);
  if(a&&!a.active)fail(`${nameOf(key)}’s login is disabled. Choose someone else.`);
  if(a&&!hooks.canStaff(key,'tasks.tasks','view'))fail(`${nameOf(key)} can’t open Task Management. Ask an administrator to add it to their role, or choose someone else.`);
  return key;
 };
 const log=(actor,type,key,wid,action,detail='',contact=null)=>{
  insert('tm_events',{entity_type:type,entity_id:key,workspace_id:wid||null,action,detail,actor_id:actor,created_at:now()});
  event(actor,contact,'task_management',key,action,detail);
 };
 // Choosing someone for work in a workspace adds them to it, so nobody has to be added to a workspace first.
 // Who may add people to a workspace: its members and owner, and people who manage every workspace (Workspace Delete)
 // or every task (Tasks Approve). V5.4: membership opens the workspace's Groups, so nobody can make themselves (or
 // someone else) a member of a workspace they don't belong to, for example by giving themselves a task there.
 const canAddMembers=(wid,actor)=>!actor||isMember(wid,actor)||get('SELECT owner_id FROM tm_workspaces WHERE id=?',wid)?.owner_id===actor||!!hooks.canStaff(actor,'tasks.workspace','delete')||!!hooks.canStaff(actor,'tasks.tasks','approve');
 // `authority`: someone else whose agreement adds people too (the person who asked for a task in their workspace).
 const ensureMember=(wid,staff,actor,why,{system=false,authority=null}={})=>{
  const w=get('SELECT * FROM tm_workspaces WHERE id=?',wid);
  if(hooks.organization?.governed(w)){hooks.organization.checkCollaborator(authority||actor,w,staff,{system});return;}
  if(!staff||isMember(wid,staff))return;
  if(!system&&!canAddMembers(wid,actor)&&!(authority&&authority!==actor&&isMember(wid,authority)))fail(staff===actor?`You aren’t a member of the workspace “${get('SELECT name FROM tm_workspaces WHERE id=?',wid)?.name||wid}”. Ask its owner to add you, or ask a member for a task instead.`:`${nameOf(staff)} isn’t a member of this workspace, and only its members can add people to it. Choose members of the workspace, or ask its owner to add ${nameOf(staff)}.`,403);
  insert('tm_members',{workspace_id:wid,staff_id:staff});log(actor,'workspace',wid,wid,'Workspace member added',`${nameOf(staff)} · ${why}`);
 };
 // `known`: people already on the record, who are not added to the workspace again (V5.5.1: someone removed from a
 // workspace after their meeting ended is not made a member again when its notes are changed).
 const people=(input,wid,actor,known=[])=>{
  if(!Array.isArray(input)||!input.length||input.length>100)fail('Choose 1–100 people.');
  const ids=[...new Set(input)];for(const key of ids){profile(key);if(wid&&!known.includes(key))ensureMember(wid,key,actor,'invited to a meeting');}return ids;
 };
 const relation=(type,key)=>{
  if(!type)return {related_type:'',related_id:null,contact_id:null};
  choice(type,['CONTACT','LEAD','OPPORTUNITY','ACCOUNT','OPERATIONS'],'related record type');
  const r=type==='OPERATIONS'?(get('SELECT * FROM ops_requests WHERE id=?',key)||fail('Operations record not found.')):record(type.toLowerCase(),key);
  return {related_type:type,related_id:key,contact_id:type==='CONTACT'?r.id:r.contact_id};
 };
 const duration=(v,max=600000)=>{let n;try{n=parseDuration(v||'0:00');}catch(e){fail(e.message);}if(n>max)fail('Duration is too large.');return n;};
 // V5.4 Groups (customizable tables inside a workspace) live in their own module, with the same helpers and audit log.
 const groups=createGroups({...c,hooks,log,nameOf,isMember,workspace,zoneOf});
 const activity=(key,channel)=>{
  if(!key)return null;const a=record('activity',key);
  if((channel==='MEETING')!==(a.channel==='MEETING'))fail(channel==='MEETING'?'Choose a CRM meeting activity.':'Use Meetings to link this CRM meeting.');
  return a;
 };

 // ---------------------------------------------------------------- upgrade (schema versions 6 and 9)
 function missingColumns(table,list){const have=new Set(all(`PRAGMA table_info(${table})`).map(col=>col.name));return list.filter(([n])=>!have.has(n));}
 function migrate(){
  const first6=!get('SELECT version FROM schema_version WHERE version=6'),first9=!get('SELECT version FROM schema_version WHERE version=9'),first10=!get('SELECT version FROM schema_version WHERE version=10'),first12=!get('SELECT version FROM schema_version WHERE version=12');
  const add=[['tm_tasks',missingColumns('tm_tasks',[...V52_TASK_COLUMNS,...V53_TASK_COLUMNS,...V54_TASK_COLUMNS])],['tm_assignees',missingColumns('tm_assignees',V53_ASSIGNEE_COLUMNS)],['tm_requests',missingColumns('tm_requests',V53_REQUEST_COLUMNS)],
   ...Object.entries(V55_COLUMNS).map(([table,list])=>[table,missingColumns(table,list)])];
  if(first6||first9||first10||first12||add.some(([,list])=>list.length)){
   db.exec('BEGIN IMMEDIATE');
   try{
    for(const [table,list] of add)for(const [n,def] of list)run(`ALTER TABLE ${table} ADD COLUMN ${n} ${def}`);
    if(first6){
     const stamp=now();
     for(const t of all('SELECT * FROM tm_tasks WHERE pic_id IS NULL')){
      // The first assignee becomes the person in charge; the creator becomes the reviewer.
      const pic=get('SELECT staff_id FROM tm_assignees WHERE task_id=? ORDER BY rowid LIMIT 1',t.id)?.staff_id||t.created_by;
      run('INSERT OR IGNORE INTO tm_assignees(task_id,staff_id) VALUES(?,?)',t.id,pic);
      const started=['IN_PROGRESS','IN_REVIEW','COMPLETED'].includes(t.status)||pic===t.created_by;
      update('tm_tasks',t.id,{pic_id:pic,reviewer_id:t.created_by,department:t.department||get('SELECT department FROM tm_workspaces WHERE id=?',t.workspace_id)?.department||'',
       accepted_at:started?t.created_at:null,submitted_to:t.status==='IN_REVIEW'?t.created_by:null,submitted_by:t.status==='IN_REVIEW'?pic:null,submitted_at:t.status==='IN_REVIEW'?t.updated_at:null,source:'WEB'});
     }
     // A starting history for existing tasks, so monthly reports can place them in time.
     for(const t of all('SELECT * FROM tm_tasks t WHERE NOT EXISTS (SELECT 1 FROM tm_task_history h WHERE h.task_id=t.id) ORDER BY created_at')){
      const done=['COMPLETED','CANCELLED'].includes(t.status),initial=done?(t.accepted_at?'IN_PROGRESS':'NOT_STARTED'):t.status;
      insert('tm_task_history',{task_id:t.id,kind:'create',from_status:null,to_status:initial,progress:initial==='NOT_STARTED'?0:done?Math.min(t.progress,99):t.progress,stuck:0,due_date:t.due_date,note:'Recorded before the V5.2 workflow',actor_id:t.created_by,source:'MIGRATION',created_at:t.created_at});
      if(done)insert('tm_task_history',{task_id:t.id,kind:t.status==='COMPLETED'?'close':'cancel',from_status:initial,to_status:t.status,progress:t.progress,stuck:0,due_date:t.due_date,note:t.reason||'',actor_id:t.created_by,source:'MIGRATION',created_at:t.completed_at||t.updated_at||stamp});
     }
     run('INSERT INTO schema_version(version) VALUES(6)');
    }
    // V5.3: people already on a task in an earlier version count as having accepted it (the column defaults do this).
    if(first9)run('INSERT INTO schema_version(version) VALUES(9)');
    // V5.4: the assigner of existing tasks is the person who created them, except when someone accepted a request and
    // took the work on themselves: then the person who asked for it assigned it. Reminders keep one day before the due
    // date (the column default), as before.
    if(first10){
     run(`UPDATE tm_tasks SET assigned_by=COALESCE((SELECT q.requested_by FROM tm_requests q WHERE q.id=tm_tasks.request_id AND tm_tasks.pic_id=tm_tasks.created_by AND q.requested_by<>tm_tasks.created_by),created_by) WHERE assigned_by IS NULL`);
     run('INSERT INTO schema_version(version) VALUES(10)');
    }
    // V5.5: meetings scheduled before this version were visible to everyone who could open Meetings, so they stay
    // visible company-wide; new meetings are visible to their participants unless they are shared. Nobody has a
    // reporting line yet (administrators set them), and everyone follows the company's time zone.
    if(first12){
     run("UPDATE tm_meetings SET share_scope='COMPANY'");
     run('INSERT INTO schema_version(version) VALUES(12)');
    }
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
  db.exec('CREATE INDEX IF NOT EXISTS tm_task_pic ON tm_tasks(pic_id,status); CREATE INDEX IF NOT EXISTS tm_task_review ON tm_tasks(submitted_to,status); CREATE INDEX IF NOT EXISTS tm_task_request ON tm_tasks(request_id); CREATE INDEX IF NOT EXISTS tm_task_reviewer ON tm_tasks(reviewer_id,reviewer_status); CREATE INDEX IF NOT EXISTS tm_task_series ON tm_tasks(series_id); CREATE INDEX IF NOT EXISTS tm_assignee_status ON tm_assignees(staff_id,status); CREATE INDEX IF NOT EXISTS tm_task_assigner ON tm_tasks(assigned_by,status); CREATE INDEX IF NOT EXISTS tm_profile_manager ON tm_profiles(manager_id); CREATE INDEX IF NOT EXISTS tm_task_creator ON tm_tasks(created_by,status); CREATE INDEX IF NOT EXISTS tm_notification_meeting ON tm_notifications(meeting_id);');
 }

 // ---------------------------------------------------------------- helpers for the workflow
 const assigneeRows=taskId=>all('SELECT staff_id,status,invited_by,invited_at,responded_at,response_note FROM tm_assignees WHERE task_id=? ORDER BY rowid',taskId);
 const supportRows=t=>assigneeRows(t.id).filter(a=>a.staff_id!==t.pic_id);
 const supportersOf=t=>supportRows(t).filter(a=>a.status!=='DECLINED').map(a=>a.staff_id);
 const canApprove=staff=>!!hooks.canStaff(staff,'tasks.tasks','approve');
 // V5.5: seeing a task through a reporting line or company-wide access never lets anyone change it, so the Tasks
 // “Approve” permission counts only on tasks the person is directly involved in.
 const rolesFor=(t,actor)=>taskRoles(t,actor,supportRows(t),{canApprove:canApprove(actor)&&scope.isInvolved(actor,t)});
 const pendingDue=taskId=>get("SELECT * FROM tm_due_requests WHERE task_id=? AND status='PENDING'",taskId)||null;
 // The people whose answer (accept or reject) the task is still waiting for.
 const waitingOn=t=>{
  if(!OPEN_TASK_STATUSES.includes(t.status))return [];
  return [...(!t.accepted_at&&!t.declined_at&&['NOT_STARTED','IN_PROGRESS'].includes(t.status)?[{staff_id:t.pic_id,role:'pic'}]:[]),
   ...supportRows(t).filter(a=>a.status==='PENDING').map(a=>({staff_id:a.staff_id,role:'supporter'})),
   ...(t.reviewer_id&&(t.reviewer_status||'ACCEPTED')==='PENDING'?[{staff_id:t.reviewer_id,role:'reviewer'}]:[])];
 };
 const guard=(verb,t,roles,opts)=>{const b=taskBlock(verb,{...t,due_request:pendingDue(t.id),waiting:waitingOn(t),change_request:pendingChange(t.id)},roles,opts);if(b)fail(b.message,b.status);};
 const history=(t,kind,before,actor,source,note='')=>insert('tm_task_history',{task_id:t.id,kind,from_status:before?before.status:null,to_status:t.status,progress:t.progress,stuck:t.stuck_at?1:0,due_date:t.due_date,note,actor_id:actor,source,created_at:now()});
 // While an approved change is applied, the person who approved it is not told about their own decision again.
 let quiet=null;
 const notify=(ids,kind,{task=null,request=null,due=null,title,body=''},actor)=>{
  for(const staff of new Set(ids.filter(Boolean)))if(staff!==actor&&staff!==quiet)insert('tm_notifications',{staff_id:staff,kind,task_id:task?.id||null,request_id:request?.id||null,due_request_id:due?.id||null,title,body,actor_id:actor,created_at:now()});
 };
 const activeReviewer=t=>(t.reviewer_status||'ACCEPTED')==='DECLINED'?null:t.reviewer_id;
 // V5.4: notifications about a task go only to the people on it: the person in charge, supporting people, the
 // reviewer, the assigner and the creator.
 const everyone=t=>[t.pic_id,...supportersOf(t),activeReviewer(t),assignerOf(t)];
 const onTask=(t,staff)=>staff&&everyone(t).includes(staff)?staff:null;

 // ---------------------------------------------------------------- V5.4 two-party approval
 // Someone who can still decide: an active team member whose login (if they have one) is active and includes Tasks.
 const reachable=staff=>{
  if(!staff||!get("SELECT 1 AS ok FROM lookups WHERE id=? AND kind='staff' AND active=1",staff))return false;
  if(get('SELECT active FROM tm_profiles WHERE staff_id=?',staff)?.active===0)return false;
  const a=accountOf(staff);return a?!!a.active&&!!hooks.canStaff(staff,'tasks.tasks','view'):true;
 };
 // V5.5: calendar reminders (meetings and personal notes) reach everyone who can open the calendar: people whose role
 // has Meetings but not Tasks get them too.
 const calendarReachable=staff=>{
  if(!staff||!get("SELECT 1 AS ok FROM lookups WHERE id=? AND kind='staff' AND active=1",staff))return false;
  if(get('SELECT active FROM tm_profiles WHERE staff_id=?',staff)?.active===0)return false;
  const a=accountOf(staff);return a?!!a.active&&(!!hooks.canStaff(staff,'tasks.tasks','view')||!!hooks.canStaff(staff,'tasks.meetings','view')):true;
 };
 // Who decides a change asked for by `actor`: the other side of the task. The person in charge asks the assigner (or, if
 // the assigner can no longer use Task Management, the reviewer, then the creator); everyone on the assigner's side (the
 // assigner, the reviewer, the creator, task approvers) asks the person in charge once they have accepted the task.
 // null: nobody else needs to agree (a task someone gave themselves, or the other side can no longer use the Task Controlling Management).
 // If none of them can decide any more, someone whose role has Tasks Approve decides; if there is nobody, the change is
 // refused (it is never applied without the other side).
 const approverFor=(t,actor,{edit=false}={})=>{
  if(!(edit?editApprovalTarget(t,actor):approvalTarget(t,actor)))return null;
  if(actor===t.pic_id){
   for(const c of [assignerOf(t),activeReviewer(t),t.created_by])if(c&&c!==t.pic_id&&reachable(c))return c;
   for(const r of all("SELECT l.id FROM lookups l JOIN access_users u ON u.staff_id=l.id WHERE l.kind='staff' AND l.active=1 AND u.active=1 ORDER BY l.name COLLATE NOCASE,l.id"))
    if(r.id!==t.pic_id&&reachable(r.id)&&hooks.canStaff(r.id,'tasks.tasks','approve')&&scope.canSee(r.id,t))return r.id;
   fail(`${nameOf(assignerOf(t))} can’t approve changes any more, and nobody else can decide for them. Ask an administrator to give someone Task Management “Approve”.`,409);
  }
  if(!reachable(t.pic_id))fail('The other responsible party is unavailable. Restore their access or resolve responsibility before requesting a change.',409);
  return t.pic_id;
 };
 const pendingChange=taskId=>get("SELECT * FROM tm_change_requests WHERE task_id=? AND status='PENDING'",taskId)||null;
 // V5.5: who approves a new progress figure on a task someone else assigned. Progress is reported by the people working
 // on it (the person in charge or a supporting person) and approved by the assigner's side: the assigner, or if they can
 // no longer decide, the reviewer, then the creator, then someone with Tasks “Approve” who can already see the task.
 // null: a task someone gave themselves (nobody else needs to agree).
 const progressApprover=(t,actor)=>{
  if(!twoSided(t)||!OPEN_TASK_STATUSES.includes(t.status))return null;
  if(actor!==t.pic_id&&!supportersOf(t).includes(actor))return approverFor(t,actor);
  for(const c of [assignerOf(t),activeReviewer(t),t.created_by])if(c&&c!==t.pic_id&&c!==actor&&reachable(c))return c;
  for(const r of all("SELECT l.id FROM lookups l JOIN access_users u ON u.staff_id=l.id WHERE l.kind='staff' AND l.active=1 AND u.active=1 ORDER BY l.name COLLATE NOCASE,l.id"))
   if(r.id!==t.pic_id&&r.id!==actor&&reachable(r.id)&&hooks.canStaff(r.id,'tasks.tasks','approve')&&scope.canSee(r.id,t))return r.id;
  fail(`${nameOf(assignerOf(t))} can’t approve progress any more, and nobody else can decide for them. Ask an administrator to give someone Task Management “Approve”.`,409);
 };
 const clip=(v,n)=>{const s=String(v??'');return s.length>n?s.slice(0,n-1)+'…':s;};
 const FIELD_LABELS={title:'Title',description:'Expectation',progress:'Progress',start_date:'Start date',due_date:'Due date',priority:'Priority',estimate_minutes:'Estimated effort',pic_id:'Person in charge',
  supporters:'Supporting people',reviewer_id:'Reviewer',department:'Department',department_note:'Department note',recurrence:'Repeat',recurrence_rule:'Repeat schedule',recurrence_until:'Repeat until',related:'Related record',status:'Status'};
 const shown=(field,v)=>{
  if(v===null||v===undefined||v===''||(Array.isArray(v)&&!v.length))return field==='supporters'?'Nobody':'—';
  if(['start_date','due_date','recurrence_until'].includes(field))return human(v);
  if(field==='priority')return v.charAt(0)+v.slice(1).toLowerCase();
  if(field==='estimate_minutes')return `${formatMinutes(v)} h`;
  if(field==='progress')return `${v}%`;
  if(field==='recurrence')return RECURRENCE[v]||v;
  if(field==='pic_id'||field==='reviewer_id')return nameOf(v);
  if(field==='supporters')return v.map(nameOf).join(', ');
  return clip(v,300);
 };
 const change=(field,from,to,fromText,toText)=>({field,label:FIELD_LABELS[field]||field,from,to,from_text:fromText??shown(field,from),to_text:toText??shown(field,to)});
 const changeSummary=(kind,changes)=>kind==='COMPLETE'?'mark it completed':kind==='CANCEL'?'cancel it':changes.map(c=>c.field==='description'||c.field==='department_note'?`${c.label.toLowerCase()} changed`:`${c.label.toLowerCase()} ${c.from_text} → ${c.to_text}`).join(' · ');
 // One change can wait for approval per task; the other side is told and decides.
 // quiet: a completion asked for by submitting the task, whose own history entry and notification already say so.
 function requestChange(t,kind,actor,source,{approver,changes=[],payload={},note='',quiet:silent=false}){
  const pending=pendingChange(t.id);
  if(pending)fail(pending.requested_by===actor?'You already asked for a change to this task. Wait for the answer, or withdraw it first.':`${nameOf(pending.requested_by)}’s change to this task is waiting for ${nameOf(pending.approver_id)}. Wait for the answer first.`,409);
  const key=id('tm-change','CHG'),at=now(),side=actor===t.pic_id?'PIC':'ASSIGNER',summary=changeSummary(kind,changes);
  insert('tm_change_requests',{id:key,task_id:t.id,kind,requested_by:actor,requester_side:side,approver_id:approver,status:'PENDING',changes_json:JSON.stringify(changes),payload_json:JSON.stringify(payload),
   note,base_version:t.version,decision_note:'',decided_by:null,decided_at:null,source,decision_source:null,version:0,created_at:at,updated_at:at});
  if(!silent)history(t,'change_request',t,actor,source,`Asked ${nameOf(approver)} to ${kind==='UPDATE'?'approve: '+summary:summary}${note?' · '+note:''}`);
  if(!silent)notify([approver],'change_request',{task:t,title:`Approval needed: ${t.title}`,body:`${nameOf(actor)} asks to ${kind==='UPDATE'?'change '+summary:summary}${note?' · '+note:''} · approve or reject`},actor);
  log(actor,'task',t.id,t.workspace_id,'Change requested',`${t.title} · ${CHANGE_WORD[kind]} · to ${nameOf(approver)}${note?' · '+note:''}`,t.contact_id);
  return key;
 }
 const CHANGE_WORD={UPDATE:'change details',COMPLETE:'complete',CANCEL:'cancel'};
 // Records the decision on a change request (the task itself is changed by the caller).
 function settleChange(cr,status,actor,source,note=''){
  update('tm_change_requests',cr.id,{status,decided_by:actor,decided_at:now(),decision_note:note,decision_source:source,version:cr.version+1,updated_at:now()});
  // V5.6.8: a supporting person's new due date that the decider agreed to waits for this change; when the change does not
  // apply (rejected, withdrawn or closed) the due date request is declined too and its requester is told.
  let payload={};try{payload=JSON.parse(cr.payload_json||'{}');}catch{}
  if(status!=='APPROVED'&&payload.due_request_id){
   const q=get('SELECT * FROM tm_due_requests WHERE id=?',payload.due_request_id),t=get('SELECT * FROM tm_tasks WHERE id=?',cr.task_id);
   if(q&&q.status==='APPROVED'&&t){
    const why=status==='REJECTED'?`${nameOf(actor)} rejected the new date${note?': '+note:''}`:status==='WITHDRAWN'?'The change was withdrawn':note||'The change could no longer apply';
    update('tm_due_requests',q.id,{status:'DECLINED',decision_note:clip(why,1000),decided_by:actor,decided_at:now(),version:q.version+1,updated_at:now()});
    notify([q.requested_by],'due_declined',{task:t,due:q,title:`New due date not applied: ${t.title}`,body:why},actor);
   }
  }
 }
 // V5.6.8: pending due date requests end with the task (closed or cancelled), or when their requester leaves it.
 function endDueRequests(t,status,why,actor,{requester=null}={}){
  for(const q of all("SELECT * FROM tm_due_requests WHERE task_id=? AND status='PENDING'"+(requester?' AND requested_by=?':''),...(requester?[t.id,requester]:[t.id]))){
   update('tm_due_requests',q.id,{status,decision_note:why,decided_by:status==='DECLINED'?actor:null,decided_at:now(),version:q.version+1,updated_at:now()});
   notify([status==='DECLINED'?q.requested_by:q.decide_by],status==='DECLINED'?'due_declined':'task_updated',{task:t,due:q,title:`${status==='DECLINED'?'Due date request declined':'Due date request withdrawn'}: ${t.title}`,body:why},actor);
  }
 }
 // A change that can no longer apply as asked (the person in charge changed, the reviewer stepped down…) is closed.
 function closePending(t,why,actor,source){
  const cr=pendingChange(t.id);if(!cr)return null;
  settleChange(cr,'CLOSED',actor,source,why);
  notify([cr.requested_by],'change_rejected',{task:t,title:`Change closed: ${t.title}`,body:why},actor);
  return cr;
 }
 // A task as the edit form sends it, so an approved change can be applied on top of the task as it is now.
 const taskInput=t=>({workspace_id:t.workspace_id,title:t.title,description:t.description,start_date:t.start_date,due_date:t.due_date,priority:t.priority,estimate:formatMinutes(t.estimate_minutes),
  pic_id:t.pic_id,supporter_ids:supportersOf(t),reviewer_id:t.reviewer_id,department:t.department,department_note:t.department_note,recurrence:t.recurrence||'',recurrence_rule:t.recurrence_rule||'{}',recurrence_until:t.recurrence_until||null,
  related_type:t.activity_id?undefined:t.related_type||'',related_id:t.activity_id?undefined:t.related_id||''});
 const currentValue=(t,field)=>field==='supporters'?supportersOf(t):field==='related'?`${t.related_type||''}:${t.related_id||''}`:t[field]??null;
 const sameValue=(a,b)=>Array.isArray(a)||Array.isArray(b)?JSON.stringify([...(a||[])].sort())===JSON.stringify([...(b||[])].sort()):String(a??'')===String(b??'');
 const REMINDER_ERROR='Choose up to five reminders, each 1 to 90 days before the due date.';
 const reminderInput=v=>{if(!Array.isArray(v)||v.length>5||v.some(n=>!Number.isInteger(Number(n))||Number(n)<1||Number(n)>90))fail(REMINDER_ERROR);return reminderDays(v);};
 const syncActivity=t=>{
  if(!t.activity_id)return;const a=get('SELECT * FROM activities WHERE id=?',t.activity_id);if(!a)return;
  const status=['COMPLETED','CANCELLED'].includes(t.status)?t.status:'OPEN',reason=t.status==='CANCELLED'?t.reason:'';
  if(a.status===status&&a.assigned_to===(t.pic_id||a.assigned_to)&&a.reason===reason)return;
  update('activities',a.id,{status,assigned_to:t.pic_id||a.assigned_to,reason,version:a.version+1,updated_at:now()});
 };
 const cleared={stuck_at:null,stuck_by:null,stuck_reason:''},unsubmitted={submitted_to:null,submitted_by:null,submitted_at:null,submit_note:''};
 // Acting on a task confirms a role the person was still asked to confirm.
 const confirmReviewer=(t,roles,at)=>roles.reviewerStatus==='PENDING'?{reviewer_status:'ACCEPTED',reviewer_responded_at:at,reviewer_note:''}:{};
 const confirmSupport=(t,roles,actor,at)=>{if(roles.supportStatus==='PENDING')run("UPDATE tm_assignees SET status='ACCEPTED',responded_at=?,response_note='' WHERE task_id=? AND staff_id=?",at,t.id,actor);};

 // ---------------------------------------------------------------- create / edit a task
 function saveTask(d,actor,source,opts={}){
  const old=d.id?find('tm_tasks',d.id):null;if(old)version(old,d.expected_version);
  const creationKey=old?null:opts.creationKey||(d.request_key?`${actor}:${str(d.request_key,'Creation key',100,true)}`:null);
  if(creationKey){const duplicate=get('SELECT * FROM tm_tasks WHERE creation_key=?',creationKey);if(duplicate){if(duplicate.workspace_id!==d.workspace_id)fail('Creation key already belongs to another workspace.');return {id:duplicate.id,type:'tm_task',message:'Task already created.'};}}
  const w=activeWorkspace(old?.workspace_id||d.workspace_id),key=old?.id||id('tm-task','TASK');
  if(!old&&!hooks.organization.canCreateResource(actor,w)&&!(opts.requestId&&hooks.organization.canCreateResource(opts.memberAuthority,w)))fail('Join this workspace before creating work in it.',403);
  // People: one person in charge plus supporting people. Earlier clients send assignee_ids (first = in charge).
  let pic=d.pic_id,supporters=d.supporter_ids;
  if(pic===undefined&&Array.isArray(d.assignee_ids)){pic=d.assignee_ids[0];supporters=d.assignee_ids.slice(1);}
  if(old&&(pic===undefined||pic===null||pic===''))pic=old.pic_id;
  const previous=old?assigneeRows(old.id):[],prevBy=new Map(previous.map(r=>[r.staff_id,r]));
  const previousSupport=old?previous.filter(r=>r.staff_id!==old.pic_id):[],previousActive=previousSupport.filter(r=>r.status!=='DECLINED').map(r=>r.staff_id);
  if(old&&supporters===undefined)supporters=previousActive;
  if(!pic)fail('Choose the person in charge.');
  pic=typeof pic==='string'&&pic===old?.pic_id?lookup(pic,'staff'):assignable(pic);
  if(supporters!=null&&!Array.isArray(supporters))fail('Select the supporting people.');
  supporters=[...new Set((supporters||[]).filter(s=>s&&s!==pic))];
  if(supporters.length>50)fail('Choose up to 50 supporting people.');
  for(const s of supporters)if(!previousActive.includes(s))assignable(s);
  let reviewer=d.reviewer_id||old?.reviewer_id||actor;
  reviewer=reviewer===old?.reviewer_id||reviewer===actor?lookup(reviewer,'staff'):assignable(reviewer);
  for(const target of [pic,...supporters,reviewer])hooks.organization.checkCollaborator(opts.memberAuthority||actor,w,target,{existing:!!old&&[old.pic_id,old.reviewer_id,old.created_by,...previous.map(r=>r.staff_id)].includes(target)});
  const a=activity(old?old.activity_id:d.activity_id,'TASK'),rel=a?{related_type:a.parent_type==='TASK'?'':a.parent_type,related_id:a.parent_id,contact_id:a.contact_id}:relation(d.related_type,d.related_id);
  if(a&&get('SELECT id FROM tm_tasks WHERE activity_id=? AND id<>?',a.id,key))fail('This CRM activity is already linked to a task.');
  const start=date(d.start_date,'Start date'),due=date(d.due_date,'Due date');if(due<start)fail('Due date cannot be before start date.');
  const recurrence=d.recurrence===undefined||d.recurrence===null?(old?.recurrence||''):choice(String(d.recurrence),Object.keys(RECURRENCE),'repeat option');
  let recurrence_rule;try{let rule=d.recurrence_rule??old?.recurrence_rule;if(d.move_series===true||d.move_series===1){rule=typeof rule==='string'?JSON.parse(rule):rule||{};rule={...rule,anchor:due};}recurrence_rule=JSON.stringify(normalizeRule(recurrence,rule,due));}catch(e){fail(e.message);}
  const until=!recurrence?null:d.recurrence_until===undefined?(old?.recurrence_until||null):d.recurrence_until?date(d.recurrence_until,'Repeat until'):null;
  if(until&&until<due)fail('“Repeat until” must be on or after the due date.');
  const values={workspace_id:w.id,activity_id:a?.id||null,...rel,title:str(d.title,'Task title',300,true),
   // V5.5: the form calls it “Expectation”; the API keeps `description` and also accepts `expectation`.
   description:str(d.description===undefined&&d.expectation!==undefined?d.expectation:d.description,'Expectation',8000,!old),start_date:start,due_date:due,
   priority:choice(d.priority||'MEDIUM',['HIGH','MEDIUM','LOW'],'priority'),estimate_minutes:duration(d.estimate),pic_id:pic,reviewer_id:reviewer,
   department:d.department===undefined||d.department===null?(old?old.department:w.department||''):str(d.department,'Department',150),department_note:str(d.department_note??(old?.department_note||''),'Department note',2000),
   recurrence,recurrence_rule,recurrence_until:until};
  // The reviewer confirms the role, unless they chose it themselves (or asked for the task, when a request is accepted).
  const reviewerChanged=!old||reviewer!==old.reviewer_id,reviewerSelf=reviewer===actor||opts.reviewerAccepted===reviewer;
  const reviewerValues=reviewerChanged?{reviewer_status:reviewerSelf?'ACCEPTED':'PENDING',reviewer_responded_at:reviewerSelf?now():null,reviewer_note:''}:{};
  let t,message,roles=null;
  if(!old){
   if(['IN_REVIEW','CANCELLED'].includes(d.status))fail('New tasks start as Not started, In progress or Completed.');
   const status=choice(d.status||'NOT_STARTED',['NOT_STARTED','IN_PROGRESS','COMPLETED'],'starting status');
   if(status!=='NOT_STARTED'&&pic!==actor)fail('Only the person in charge can start or complete a task. Create it as Not started; they can accept it and record progress.',403);
   const progress=status==='COMPLETED'?100:status==='NOT_STARTED'?0:integer(d.progress||0,0,99,'progress (0–99 until completed)');
   const accepted=pic===actor||opts.accepted;
   const plan=recurrence?{scheduled_due:due,series_anchor:Number(due.slice(8,10))}:{};
   // V5.4: the assigner is the other side of two-party approval (the creator, or the person who asked for it when the
   // creator took the work on themselves); deadline reminders default to one day before the due date.
   const reminders=d.reminder_days===undefined||d.reminder_days===null?[1]:reminderInput(d.reminder_days);
   t={id:key,...values,...reviewerValues,...plan,status,progress,reason:'',completed_at:status==='COMPLETED'?now():null,closed_by:status==='COMPLETED'?actor:null,accepted_at:accepted?now():null,request_id:opts.requestId||null,source,version:0,creation_key:creationKey,created_by:actor,created_at:now(),updated_at:now(),
    assigned_by:opts.assignedBy&&opts.assignedBy!==pic?opts.assignedBy:actor,reminder_days:JSON.stringify(reminders)};
   insert('tm_tasks',t);
   history(t,'create',null,actor,source,opts.requestId?`From task request ${opts.requestId}`:recurrence?`Repeats ${RECURRENCE_SHORT[recurrence]}`:'');
   message='Task created.';
  }else{
   if(d.status!==undefined&&d.status!==null&&d.status!==''&&d.status!==old.status)fail('Use the task actions (accept, submit, close and so on) to change its status.',409);
   if(d.progress!==undefined&&d.progress!==null&&d.progress!==''&&Number(d.progress)!==old.progress)fail('Use “Update progress” to change progress.',409);
   roles=rolesFor(old,actor);if(!opts.applying)guard('edit',old,roles);
   const changed=k=>String(values[k]??'')!==String(old[k]??'');
   // V5.4: on a task both sides have agreed to, the change is sent to the other side and applies once they approve it.
   let approver=opts.applying?null:approverFor(old,actor,{edit:true});
   if(!opts.applying&&!approver){
    const hasChanges=Object.keys(values).some(changed)||!sameValue(supporters,previousActive);
    if(!hasChanges)return {id:key,type:'tm_task',unchanged:true,message:'Nothing was changed.'};
    // A personal task still needs a second responsible party for a detail modification.
    // Proposing a distinct reviewer/PIC grants only pending-decision visibility until approved.
    // Approval counts distinct people: when the editor holds every responsible role, nobody else approves (saved directly).
    const others=[old.reviewer_id,old.created_by,values.reviewer_id,values.pic_id].filter(who=>who&&who!==actor);
    approver=others.find(who=>reachable(who)&&accountOf(who)?.active&&hooks.canStaff(who,'tasks.tasks','view'));
    if(others.length&&!approver)fail('Choose another active reviewer or person in charge to approve this change. The task remains unchanged until approved.',409);
   }
   if(approver){
    const diff=[],payload={};
    const put=(field,from,to,keys)=>{diff.push(change(field,from,to));Object.assign(payload,keys);};
    for(const [field,input] of [['title','title'],['description','description'],['start_date','start_date'],['due_date','due_date'],['priority','priority'],['pic_id','pic_id'],['reviewer_id','reviewer_id'],['department','department'],['department_note','department_note'],['recurrence','recurrence'],['recurrence_rule','recurrence_rule'],['recurrence_until','recurrence_until']])
     if(changed(field))put(field,old[field]??null,values[field]??null,{[input]:values[field]??(field==='recurrence'?'':null)});
    if(values.estimate_minutes!==old.estimate_minutes)put('estimate_minutes',old.estimate_minutes,values.estimate_minutes,{estimate:formatMinutes(values.estimate_minutes)});
    if(!sameValue(supporters,previousActive))put('supporters',previousActive,supporters,{supporter_ids:supporters});
    if(`${values.related_type}:${values.related_id||''}`!==`${old.related_type||''}:${old.related_id||''}`)put('related',`${old.related_type||''}:${old.related_id||''}`,`${values.related_type}:${values.related_id||''}`,{related_type:values.related_type,related_id:values.related_id});
    if(!diff.length)return {id:key,type:'tm_task',message:'Nothing was changed.',unchanged:true};
    if(d.move_series===true||d.move_series===1)payload.move_series=true;
    const note=str(d.change_note,'Reason for the change',1000);
    const change_id=requestChange(old,'UPDATE',actor,source,{approver,changes:diff,payload,note});
    return {id:key,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. Nothing changes until they approve.`};
   }
   if(!roles.isGovernor&&!opts.applying){
    const locked=['title','start_date','due_date','priority','pic_id','reviewer_id','department','workspace_id','recurrence','recurrence_rule','recurrence_until'].filter(changed);
    if(locked.length)fail('Only the task’s manager can change its title, dates, priority, department, repeat, person in charge or reviewer. Ask for a new due date instead.',403);
   }
   const extra={...(reviewerChanged?reviewerValues:confirmReviewer(old,roles,now()))};
   if(changed('pic_id')){
    if(old.status==='IN_REVIEW')fail('Return or close the review before changing the person in charge.',409);
    // A new person in charge accepts the task themselves (unless they chose themselves), also on a closed task: reopening
    // it then asks them first.
    Object.assign(extra,{accepted_at:pic===actor?(old.accepted_at||now()):null,declined_at:null,declined_reason:''});
   }
   if(changed('reviewer_id')&&old.status==='IN_REVIEW'&&old.submitted_to===old.reviewer_id)extra.submitted_to=reviewer;
   // Repeating tasks: a new due date moves only this one (the series keeps its planned dates) unless “move the
   // series” is chosen; setting or changing the repeat rule plans the series from the new due date.
   if(recurrence){
    const moveSeries=d.move_series===true||d.move_series===1;
    if(!old.recurrence||changed('recurrence')||changed('recurrence_rule')||moveSeries||(!old.scheduled_due&&!changed('due_date')))Object.assign(extra,{scheduled_due:due,series_anchor:Number(due.slice(8,10))});
    else if(changed('due_date')&&!old.scheduled_due)Object.assign(extra,{scheduled_due:old.due_date,series_anchor:old.series_anchor||Number(old.due_date.slice(8,10))});
   }
   t={...old,...values,...extra,version:old.version+1,updated_at:now()};
   const {id:_,...patch}=t;update('tm_tasks',key,patch);
   const supportChanged=supporters.join()!==previousActive.join();
   // V5.6.8: the history keeps what each detail was and what it became.
   const diff=[];
   for(const field of ['title','description','start_date','due_date','priority','pic_id','reviewer_id','department','department_note','recurrence','recurrence_rule','recurrence_until'])if(changed(field))diff.push(change(field,old[field]??null,values[field]??null));
   if(values.estimate_minutes!==old.estimate_minutes)diff.push(change('estimate_minutes',old.estimate_minutes,values.estimate_minutes));
   if(!sameValue(supporters,previousActive))diff.push(change('supporters',previousActive,supporters));
   if(`${values.related_type}:${values.related_id||''}`!==`${old.related_type||''}:${old.related_id||''}`)diff.push(change('related',`${old.related_type||''}:${old.related_id||''}`,`${values.related_type}:${values.related_id||''}`,old.related_id?`${old.related_type} ${old.related_id}`:'—',values.related_id?`${values.related_type} ${values.related_id}`:'—'));
   const summary=clip(changeSummary('UPDATE',diff),1800);
   history(t,'edit',old,actor,source,`${summary?`Changed ${summary}`:'Details saved'}${opts.approvedBy?` · approved by ${nameOf(opts.approvedBy)}`:''}`);
   if(changed('pic_id')){
    // V5.6.8: on a closed task nobody can answer yet; they are asked to accept it when it is reopened.
    notify([pic],'task_assigned',{task:t,title:`New task: ${t.title}`,body:`${nameOf(actor)} made you the person in charge · due ${human(due)}${t.accepted_at?'':OPEN_TASK_STATUSES.includes(t.status)?' · please accept or reject':` · the task is ${TASK_STATUS[t.status].toLowerCase()}; you are asked to accept it if it is reopened`}`},actor);
    notify([old.pic_id],'task_updated',{task:t,title:`Reassigned: ${t.title}`,body:`${nameOf(pic)} is now the person in charge`},actor);
   }
   if(changed('due_date'))notify([pic,...supporters],'task_updated',{task:t,title:`New due date: ${t.title}`,body:`${nameOf(actor)} changed the due date from ${human(old.due_date)} to ${human(due)}`},actor);
   message='Task saved.';
  }
  // Assignee rows: the person in charge, then supporting people (each with their answer). People who rejected
  // supporting stay on record until they are asked again.
  const stamp=now(),rows=[],invited=[],picPrev=prevBy.get(pic);
  rows.push({task_id:key,staff_id:pic,status:'ACCEPTED',invited_by:picPrev?.invited_by||actor,invited_at:picPrev?.invited_at||stamp,responded_at:null,response_note:''});
  for(const s of supporters){
   const p=prevBy.get(s);
   if(p&&old&&s!==old.pic_id&&p.status!=='DECLINED'){rows.push({task_id:key,...p});continue;}
   const accepted=s===actor||(old&&s===old.pic_id&&old.accepted_at&&!old.declined_at);
   rows.push({task_id:key,staff_id:s,status:accepted?'ACCEPTED':'PENDING',invited_by:actor,invited_at:stamp,responded_at:accepted?stamp:null,response_note:''});
   if(!accepted)invited.push(s);
  }
  for(const p of previousSupport)if(p.status==='DECLINED'&&!supporters.includes(p.staff_id)&&p.staff_id!==pic)rows.push({task_id:key,...p});
  run('DELETE FROM tm_assignees WHERE task_id=?',key);rows.forEach(r=>insert('tm_assignees',r));
  if(old)for(const s of previousActive)if(s!==pic&&!supporters.includes(s))endDueRequests(t,'WITHDRAWN',`${nameOf(s)} no longer supports this task`,actor,{requester:s});
  if(!hooks.organization.governed(w))for(const s of [pic,...supporters])ensureMember(w.id,s,actor,'chosen for a task',{authority:opts.memberAuthority||null});
  if(!old){
   if(!opts.quietPic)notify([pic],'task_assigned',{task:t,title:`New task: ${t.title}`,body:`${nameOf(actor)} made you the person in charge · due ${human(due)}${t.accepted_at?'':' · please accept or reject'}`},actor);
   // V5.5 Steps of Work (optional): `steps` or the earlier name `checklist`.
   const stepList=Array.isArray(d.steps)?d.steps:d.checklist;
   if(Array.isArray(stepList)){
    const items=stepList.map(x=>str(x,'Step',300)).filter(Boolean);if(items.length>MAX_CHECKS)fail(`A task can have up to ${MAX_CHECKS} steps.`);
    items.forEach((title,i)=>insert('tm_checklist',{id:id('tm-check','CHK'),task_id:key,position:i+1,title,done:0,created_by:actor,created_at:stamp}));
   }
  }
  if(!old&&t.status==='COMPLETED'&&t.recurrence){const following=scheduleNext(t,actor,source);message+=following?` The next one is due ${human(following.due_date)}.`:'';}
  notify(invited,'task_supporting',{task:t,title:`Support request: ${t.title}`,body:`${nameOf(actor)} asked you to support ${pic===actor?'them':nameOf(pic)} · due ${human(due)}${OPEN_TASK_STATUSES.includes(t.status)?' · please accept or reject':` · the task is ${TASK_STATUS[t.status].toLowerCase()}; you can answer if it is reopened`}`},actor);
  if(reviewerChanged&&t.reviewer_status==='PENDING'&&reviewer!==pic)notify([reviewer],'task_reviewer',{task:t,title:`Review request: ${t.title}`,body:`${nameOf(actor)} asked you to review this task · ${nameOf(pic)} is in charge · due ${human(due)} · please accept or reject`},actor);
  if(a)update('activities',a.id,{subject:t.title,summary:t.description,assigned_to:pic,priority:t.priority,status:['COMPLETED','CANCELLED'].includes(t.status)?t.status:'OPEN',reason:t.status==='CANCELLED'?t.reason:'',version:a.version+1,updated_at:now()});
  log(actor,'task',key,w.id,old?'Task updated':'Task created',`${t.title} · ${TASK_STATUS[t.status]} · ${t.progress}% · in charge ${nameOf(pic)}`,rel.contact_id);
  return {id:key,type:'tm_task',message};
 }

 // ---------------------------------------------------------------- accept / reject (person in charge, supporting people, reviewer)
 function respond(verb,t,roles,d,actor,source){
  const role=d.role?choice(d.role,['pic','supporter','reviewer'],'role'):undefined;
  const {roles:targets,block}=answerRoles(verb,t,roles,role);
  if(!targets.length){
   const mine=Object.entries({pic:roles.picState,supporter:roles.supportStatus,reviewer:roles.reviewerStatus}).filter(([k,v])=>v&&(!role||k===role)).map(([,v])=>v);
   // Repeated taps from Telegram (or a second browser tab) find the work already done.
   if(verb==='accept'&&mine.length&&mine.every(s=>s==='ACCEPTED'))return {id:t.id,type:'tm_task',message:'You already accepted this task.',unchanged:true};
   if(verb==='decline'&&mine.length&&mine.every(s=>s==='DECLINED'))return {id:t.id,type:'tm_task',message:'You already rejected this task.',unchanged:true};
   fail(block.message,block.status);
  }
  const at=now(),who=nameOf(actor),note=verb==='decline'?str(d.note??d.reason,'Reason for rejecting',1000,true):'';
  const supportRow=supportRows(t).find(a=>a.staff_id===actor),changes={},messages=[],tells=[];let closing=null;
  for(const r of targets){
   if(r==='pic'){
    if(verb==='accept'){Object.assign(changes,{accepted_at:at,declined_at:null,declined_reason:'',status:t.status==='NOT_STARTED'?'IN_PROGRESS':t.status});messages.push('Task accepted. It is now in progress.');tells.push([[activeReviewer(t),assignerOf(t)],'task_accepted',`Accepted: ${t.title}`,`${who} accepted the task`]);}
    else{Object.assign(changes,{declined_at:at,declined_reason:note});messages.push('Task rejected. Its manager has been told.');tells.push([[activeReviewer(t),assignerOf(t)],'task_declined',`Rejected: ${t.title}`,`${who}: ${note}`]);}
   }else if(r==='reviewer'){
    if(verb==='accept'){Object.assign(changes,{reviewer_status:'ACCEPTED',reviewer_responded_at:at,reviewer_note:''});messages.push('You are the reviewer of this task.');tells.push([[assignerOf(t)],'review_accepted',`Reviewer confirmed: ${t.title}`,`${who} will review the task`]);}
    else{
     Object.assign(changes,{reviewer_status:'DECLINED',reviewer_responded_at:at,reviewer_note:note});
     // Work waiting for this reviewer goes on to whoever approves the completion (V5.4), or back to the person who
     // submitted it. A change waiting for this reviewer's decision is closed: they can no longer decide it.
     const c=pendingChange(t.id);
     if(t.status==='IN_REVIEW'&&t.submitted_to===actor){
      if(c&&c.kind==='COMPLETE'&&c.requester_side==='PIC'&&c.approver_id!==actor){changes.submitted_to=c.approver_id;tells.push([[c.approver_id],'task_submitted',`Approval needed: ${t.title}`,`${nameOf(t.submitted_by)} asks to complete the task · ${who} is no longer reviewing it`]);}
      else Object.assign(changes,{status:'IN_PROGRESS',...unsubmitted});
     }
     if(c&&c.approver_id===actor)closing=c;
     messages.push('You are no longer the reviewer. The people on the task have been told.');tells.push([[assignerOf(t),t.pic_id,t.status==='IN_REVIEW'?t.submitted_by:null],'review_declined',`Review rejected: ${t.title}`,`${who}: ${note}`]);
    }
   }else{
    run('UPDATE tm_assignees SET status=?,responded_at=?,response_note=? WHERE task_id=? AND staff_id=?',verb==='accept'?'ACCEPTED':'DECLINED',at,note,t.id,actor);
    if(verb==='accept'){messages.push('You are supporting this task.');tells.push([[onTask(t,supportRow?.invited_by)||assignerOf(t)],'support_accepted',`Supporting: ${t.title}`,`${who} accepted to support the task`]);}
    else{messages.push('You are no longer supporting this task. The people on it have been told.');tells.push([[onTask(t,supportRow?.invited_by)||assignerOf(t),t.pic_id,activeReviewer(t)],'support_declined',`Support rejected: ${t.title}`,`${who}: ${note}`]);}
   }
  }
  let next=t;
  if(Object.keys(changes).length){next={...t,...changes,version:t.version+1,updated_at:at};update('tm_tasks',t.id,{...changes,version:next.version,updated_at:at});}
  const kinds={pic:verb,supporter:verb==='accept'?'support_accept':'support_decline',reviewer:verb==='accept'?'review_accept':'review_decline'};
  for(const r of targets)history(next,kinds[r],t,actor,source,note);
  if(targets.includes('reviewer')&&verb==='decline'){
   const decider=dueDecider(next);
   for(const q of all("SELECT * FROM tm_due_requests WHERE task_id=? AND status='PENDING' AND decide_by=?",t.id,actor))if(decider&&decider!==actor){
    update('tm_due_requests',q.id,{decide_by:decider,version:q.version+1,updated_at:at});
    notify([decider],'due_new',{task:next,due:q,title:`New due date requested: ${t.title}`,body:`${nameOf(q.requested_by)} asks to move it from ${human(q.current_due_date)} to ${human(q.proposed_due_date)}: ${q.reason} · ${who} is no longer the reviewer`},actor);
   }
  }
  if(closing){settleChange(closing,'CLOSED',actor,source,`${who} is no longer the reviewer`);notify([closing.requested_by],'change_rejected',{task:next,title:`Change closed: ${t.title}`,body:`${who} is no longer the reviewer, so your request was closed. Ask again if it is still needed.`},actor);}
  if(next.status!==t.status)syncActivity(next);
  for(const [ids,kind,title,body] of tells)notify(ids,kind,{task:next,title,body},actor);
  log(actor,'task',t.id,t.workspace_id,verb==='accept'?'Task accepted':'Task rejected',`${t.title} · as ${targets.map(r=>({pic:'person in charge',supporter:'supporting person',reviewer:'reviewer'})[r]).join(' and ')}${note?' · '+note:''}`,t.contact_id);
  return {id:t.id,type:'tm_task',message:messages.join(' ')};
 }

 // ---------------------------------------------------------------- workflow actions
 // opts.applying: an approved change request being applied (the other side has already agreed); opts.approvedBy: who.
 function flow(verb,d,actor,source,opts={}){
  const t=find('tm_tasks',d.id),applying=opts.applying||null;
  if(!applying&&d.expected_version!==undefined&&d.expected_version!==null)version(t,d.expected_version);
  activeWorkspace(t.workspace_id);
  const roles=rolesFor(t,actor),done=message=>({id:t.id,type:'tm_task',message,unchanged:true});
  if(verb==='accept'||verb==='decline')return respond(verb,t,roles,d,actor,source);
  // Repeated taps from Telegram (or a second browser tab) find the work already done.
  if(verb==='stuck'&&(roles.isPic||roles.isSupporter)&&t.stuck_at&&OPEN_TASK_STATUSES.includes(t.status))return done('This task is already marked as stuck.');
  if(verb==='submit'&&t.status==='IN_REVIEW'&&t.submitted_by===actor)return done('This task is already waiting for review.');
  if(verb==='close'&&t.status==='COMPLETED'&&(roles.isPic||t.closed_by===actor))return done('This task is already closed.');
  if(verb==='cancel'&&t.status==='CANCELLED'&&(roles.isGovernor||roles.isPic))return done('This task is already cancelled.');
  if(verb==='reopen'&&OPEN_TASK_STATUSES.includes(t.status)&&(roles.isGovernor||roles.isPic))return done('This task is already open.');
  if(verb==='resume'&&!t.stuck_at&&OPEN_TASK_STATUSES.includes(t.status)&&(roles.isPic||roles.isSupporter||roles.isGovernor))return done('This task is not marked as stuck.');
  // A second tap of the same comment (a slow connection, two devices) finds it already recorded.
  if(verb==='note'&&typeof d.note==='string'&&d.note.trim()&&get("SELECT 1 AS ok FROM tm_task_history WHERE task_id=? AND kind='note' AND actor_id=? AND note=? AND created_at>?",t.id,actor,d.note.trim(),new Date(Date.now()-15000).toISOString()))return done('Comment added.');
  if(!applying)guard(verb,t,roles);
  const cr=pendingChange(t.id),completion=cr&&cr.kind==='COMPLETE'&&cr.requester_side==='PIC'?cr:null;
  // V5.4: on a task someone else assigned, cancelling it (either side) and completing it from the assigner's side wait
  // for the other side's approval. The task stays exactly as it is until they approve.
  // V5.6.8: reopening a task both sides had agreed to close (or cancel) is asked of the other side, like any change.
  if(!applying&&verb==='reopen'&&reopenNeedsApproval(t,actor)){
   const approver=approverFor(t,actor,{edit:true});
   if(approver){
    const note=str(d.note??d.reason,'Reason for reopening',2000,true);
    const change_id=requestChange(t,'UPDATE',actor,source,{approver,note,changes:[change('status',t.status,'REOPENED',taskStateLabel(t),'Reopened')],payload:{reopen:{note}}});
    return {id:t.id,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. The task stays ${TASK_STATUS[t.status].toLowerCase()} until they approve.`};
   }
  }
  if(!applying&&(verb==='cancel'||(verb==='close'&&t.status!=='IN_REVIEW'&&!roles.isPic))){
   const approver=approverFor(t,actor);
   if(approver){
    const cancel=verb==='cancel',note=str(d.note??d.reason,cancel?'Cancellation reason':'Closing note',cancel?1000:2000,cancel);
    const change_id=requestChange(t,cancel?'CANCEL':'COMPLETE',actor,source,{approver,note,
     changes:[change('status',t.status,cancel?'CANCELLED':'COMPLETED',`${taskStateLabel(t)} · ${t.progress}%`,cancel?'Cancelled':'Completed · 100%')],
     payload:cancel?{reason:note,keep_series:d.keep_series===true||d.keep_series===1}:{note}});
    return {id:t.id,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. The task stays open until they approve.`};
   }
  }
  const at=now(),changes={},noteText=(label,required,max=2000)=>str(d.note??d.reason,label,max,required);
  let note='',message='',tell=[],kind='',title='',body='',settle=null,askApproval=null;const also=[];
  const who=nameOf(actor),approvedBy=applying?` · approved by ${nameOf(opts.approvedBy)}`:'';
  if(verb!=='note'){Object.assign(changes,confirmReviewer(t,roles,at));if(['progress','stuck','resume','submit'].includes(verb))confirmSupport(t,roles,actor,at);}
  if(verb==='progress'){
   if(d.progress===undefined||d.progress===null||d.progress==='')fail('Enter the progress (0–99%).');
   const progress=integer(d.progress,0,99,'progress: 0–99% (close or submit the task when the work is finished)');
   note=noteText('Progress note',false);
   if(progress===t.progress&&t.status==='IN_PROGRESS'&&!note)return done(`Progress is already ${progress}%.`);
   // V5.5: on a task someone else assigned, a new progress figure is a change the other side approves (the assigner's
   // side, when someone working on it reports it). Until then the task keeps its progress. A note alone is recorded.
   if(!applying&&progress!==t.progress){
    const approver=progressApprover(t,actor);
    if(approver){
     const change_id=requestChange(t,'UPDATE',actor,source,{approver,note,changes:[change('progress',t.progress,progress)],payload:{progress,note}});
     return {id:t.id,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. Progress stays ${t.progress}% until they approve.`};
    }
   }
   Object.assign(changes,{progress,status:t.status==='NOT_STARTED'?'IN_PROGRESS':t.status});
   if(roles.isPic&&!t.accepted_at)Object.assign(changes,{accepted_at:at,declined_at:null,declined_reason:''});
   message=`Progress updated to ${progress}%.`;
   if(note&&!roles.isPic){tell=[t.pic_id];kind='task_progress';title=`Progress ${progress}%: ${t.title}`;body=`${who}: ${note}`;}
  }else if(verb==='stuck'){
   note=noteText('What is blocking the task',true,1000);
   Object.assign(changes,{stuck_at:at,stuck_by:actor,stuck_reason:note});
   if(roles.isPic&&!t.accepted_at)changes.accepted_at=at;
   message='Task marked as stuck. The people involved have been told.';tell=everyone(t);kind='task_stuck';title=`Stuck: ${t.title}`;body=`${who}: ${note}`;
  }else if(verb==='resume'){
   note=noteText('Note',false);
   Object.assign(changes,cleared);
   message='Task resumed.';tell=everyone(t);kind='task_resumed';title=`Resumed: ${t.title}`;body=note?`${who}: ${note}`:`${who} resumed the work`;
  }else if(verb==='submit'){
   note=noteText('Note for the reviewer',false);
   let to=t.pic_id,approver=null;
   if(roles.isPic){
    // The person in charge asks for completion: a reviewer (if any) checks the work first, then the approver (the
    // assigner, when someone else assigned the task) makes it final.
    const path=completionPath(t);
    approver=twoSided(t)?approverFor(t,actor)||path.approver:path.approver;
    to=path.review&&path.review!==approver?path.review:approver;
    if(twoSided(t))askApproval=approver;
   }
   Object.assign(changes,{status:'IN_REVIEW',submitted_to:to,submitted_by:actor,submitted_at:at,submit_note:note,...cleared});
   if(!t.accepted_at)changes.accepted_at=at;
   const final=!!askApproval&&to===approver;
   message=askApproval?(final?`Sent to ${nameOf(approver)} to approve completing it.`:`Submitted to ${nameOf(to)} for review. ${nameOf(approver)} then approves completing it.`):`Submitted to ${nameOf(to)} for review.`;
   tell=[to];kind='task_submitted';title=`${final?'Approval needed':'Review requested'}: ${t.title}`;body=`${who} ${final?'asks to complete the task':'submitted the task to you'}${note?': '+note:''}`;
  }else if(verb==='pass'){
   note=noteText('Note for the approver',false);
   const approver=completion?.approver_id||completionPath(t).approver;
   changes.submitted_to=approver;
   message=`Passed to ${nameOf(approver)} to approve completing it.`;
   tell=[approver];kind='task_submitted';title=`Approval needed: ${t.title}`;body=`${who} reviewed the work${note?': '+note:''} · ${nameOf(t.submitted_by)} asks to complete the task`;
   also.push([[t.submitted_by],'task_passed',`Reviewed: ${t.title}`,`${who} passed your work to ${nameOf(approver)} for approval${note?': '+note:''}`]);
  }else if(verb==='return'){
   note=noteText('What still needs to be done',true);
   Object.assign(changes,{status:'IN_PROGRESS',...unsubmitted});
   if(completion)settle=[completion,'REJECTED',note];
   message=`Returned to ${nameOf(t.submitted_by)}.`;tell=[t.submitted_by,t.pic_id,t.submitted_to];kind='task_returned';title=`Returned: ${t.title}`;body=`${who}: ${note}`;
  }else if(verb==='close'){
   note=noteText('Closing note',false);
   Object.assign(changes,{status:'COMPLETED',progress:100,completed_at:at,closed_by:actor,accepted_at:t.accepted_at||at,...cleared,...unsubmitted});
   if(completion)settle=[completion,'APPROVED',note];
   message=applying||completion?'Completion approved. The task is completed.':'Task closed as completed.';
   tell=[...everyone(t),t.submitted_by,t.submitted_to];kind='task_closed';title=`Completed: ${t.title}`;body=`${who} ${completion?'approved completing the task':'closed the task'}${approvedBy}${note?': '+note:''}`;
  }else if(verb==='cancel'){
   note=noteText('Cancellation reason',true,1000);
   Object.assign(changes,{status:'CANCELLED',reason:note,closed_by:actor,...cleared,...unsubmitted});
   message=applying?'Cancellation approved. The task is cancelled.':'Task cancelled.';
   tell=everyone(t);kind='task_cancelled';title=`Cancelled: ${t.title}`;body=`${who}: ${note}${approvedBy}`;
  }else if(verb==='reopen'){
   note=noteText('Reason for reopening',true);
   Object.assign(changes,{status:t.accepted_at?'IN_PROGRESS':'NOT_STARTED',progress:t.accepted_at?Math.min(t.progress,99):0,completed_at:null,closed_by:null,reason:''});
   message='Task reopened.';tell=everyone(t);kind='task_reopened';title=`Reopened: ${t.title}`;body=`${who}: ${note}`;
  }else if(verb==='note'){
   note=str(d.note,'Comment',2000,true);
   message='Comment added.';tell=[...everyone(t),t.submitted_to];kind='task_note';title=`Comment on ${t.title}`;body=`${who}: ${note}`;
  }
  // A comment is kept in the history without changing the task itself (so open edit forms stay valid).
  const next=verb==='note'?t:{...t,...changes,version:t.version+1,updated_at:at};
  if(verb!=='note')update('tm_tasks',t.id,{...changes,version:next.version,updated_at:at});
  history(next,verb,t,actor,source,applying?[note,`approved by ${nameOf(opts.approvedBy)}`].filter(Boolean).join(' · '):note);
  if(settle)settleChange(settle[0],settle[1],actor,source,settle[2]);
  if(verb==='close'||verb==='cancel')endDueRequests(next,'DECLINED',verb==='close'?'The task was completed':'The task was cancelled',actor);
  if(askApproval)requestChange(next,'COMPLETE',actor,source,{approver:askApproval,note,quiet:true,payload:{note},
   changes:[change('status',t.status,'COMPLETED',`${taskStateLabel(t)} · ${t.progress}%`,'Completed · 100%')]});
  if(next.status!==t.status||next.pic_id!==t.pic_id)syncActivity(next);
  // Repeating tasks: closing one (or cancelling it while keeping the series) creates the next one.
  let following=null;
  if(t.recurrence&&!t.next_task_id&&(verb==='close'||(verb==='cancel'&&(d.keep_series===true||d.keep_series===1)))){
   following=scheduleNext(next,actor,source);
   message+=following?` The next one is due ${human(following.due_date)}.`:' That was the last one in this series.';
  }else if(verb==='cancel'&&t.recurrence&&!t.next_task_id)message+=' The series stops here.';
  if(kind)notify(tell,kind,{task:next,title,body},actor);
  for(const [ids,k,ti,bo] of also)notify(ids,k,{task:next,title:ti,body:bo},actor);
  log(actor,'task',t.id,t.workspace_id,FLOW_LABELS[verb],`${t.title}${note?' · '+note:''}${verb==='progress'?' · '+next.progress+'%':''}${approvedBy}`,t.contact_id);
  return {id:t.id,type:'tm_task',message,...(following?{next_id:following.id}:{})};
 }

 // The next task in a repeating series: same work, people and checklist; the next planned date after this one's
 // planned date (a postponed occurrence does not move the series), never in the past. People who accepted the
 // series do not need to accept each new one; anyone who can no longer be given tasks is left out.
 function scheduleNext(t,actor,source){
  const rule=t.recurrence;if(!rule)return null;
  const base=t.scheduled_due||t.due_date,anchor=t.series_anchor||Number(base.slice(8,10)),todayKey=taskToday();
  let due=scheduledNext(rule,base,anchor,t.recurrence_rule);
  for(let i=0;due&&due<todayKey&&i<3700000;i++)due=scheduledNext(rule,due,anchor,t.recurrence_rule);
  if(!due||(t.recurrence_until&&due>t.recurrence_until))return null;
  let start=addDays(due,-Math.max(0,daysBetween(t.start_date,base)));if(start<todayKey)start=todayKey;
  const ok=staff=>{try{assignable(staff);return true;}catch{return false;}};
  const reviewerKept=(t.reviewer_status||'ACCEPTED')!=='DECLINED'&&ok(t.reviewer_id),reviewer=reviewerKept?t.reviewer_id:ok(t.created_by)?t.created_by:actor;
  const picKept=ok(t.pic_id),pic=picKept?t.pic_id:reviewer,rows=assigneeRows(t.id);
  const key=id('tm-task','TASK'),stamp=now();
  const n={id:key,workspace_id:t.workspace_id,activity_id:null,contact_id:t.contact_id,related_type:t.related_type,related_id:t.related_id,title:t.title,description:t.description,start_date:start,due_date:due,
   status:'NOT_STARTED',priority:t.priority,progress:0,estimate_minutes:t.estimate_minutes,reason:'',created_by:t.created_by,completed_at:null,version:0,creation_key:`series:${t.series_id||t.id}:${due}`,created_at:stamp,updated_at:stamp,
   pic_id:pic,reviewer_id:reviewer,department:t.department,department_note:t.department_note,accepted_at:(picKept&&t.accepted_at&&!t.declined_at)||pic===actor?stamp:null,declined_at:null,declined_reason:'',
   stuck_at:null,stuck_by:null,stuck_reason:'',submitted_to:null,submitted_by:null,submitted_at:null,submit_note:'',closed_by:null,request_id:null,source,
   reviewer_status:reviewerKept?(t.reviewer_status||'ACCEPTED'):'ACCEPTED',reviewer_responded_at:reviewerKept?t.reviewer_responded_at||null:stamp,reviewer_note:'',recurrence:rule,recurrence_rule:t.recurrence_rule||'{}',recurrence_until:t.recurrence_until||null,series_id:t.series_id||t.id,next_task_id:null,
   scheduled_due:due,series_anchor:anchor,assigned_by:t.assigned_by||t.created_by,reminder_days:t.reminder_days||'[1]'};
  insert('tm_tasks',n);
  const picRow=rows.find(a=>a.staff_id===t.pic_id);
  insert('tm_assignees',{task_id:key,staff_id:pic,status:'ACCEPTED',invited_by:picKept?picRow?.invited_by||t.created_by:actor,invited_at:picKept?picRow?.invited_at||stamp:stamp,responded_at:null,response_note:''});
  for(const a of rows)if(a.staff_id!==t.pic_id&&a.staff_id!==pic&&a.status!=='DECLINED'&&ok(a.staff_id))insert('tm_assignees',{task_id:key,...a});
  if(pic!==t.pic_id)ensureMember(n.workspace_id,pic,actor,'put in charge of a task',{system:true});
  all('SELECT title FROM tm_checklist WHERE task_id=? ORDER BY position',t.id).forEach((item,i)=>insert('tm_checklist',{id:id('tm-check','CHK'),task_id:key,position:i+1,title:item.title,done:0,created_by:actor,created_at:stamp}));
  update('tm_tasks',t.id,{next_task_id:key});
  history(n,'create',null,actor,source,`Repeats ${RECURRENCE_SHORT[rule]} · follows ${t.id}${picKept?'':` · ${nameOf(t.pic_id)} can no longer be given tasks`}`);
  notify([n.pic_id],'task_repeat',{task:n,title:`Next up: ${n.title}`,body:`Repeats ${RECURRENCE_SHORT[rule]} · due ${human(due)}${n.accepted_at?'':' · please accept or reject'}`},actor);
  log(actor,'task',key,n.workspace_id,'Repeating task created',`${n.title} · due ${due} · follows ${t.id}`,n.contact_id);
  return n;
 }

 // ---------------------------------------------------------------- hand over, reminders
 function handover(d,actor,source,opts={}){
  const t=find('tm_tasks',d.id),applying=opts.applying||null;if(!applying&&d.expected_version!==undefined&&d.expected_version!==null)version(t,d.expected_version);
  activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);if(!applying)guard('handover',t,roles);
  if(!d.to_id)fail('Choose who should take charge.');
  const to=assignable(d.to_id);
  const asked=pendingChange(t.id);if(!applying&&asked&&asked.requested_by===actor&&(()=>{try{return JSON.parse(asked.payload_json||'{}').handover?.to_id===to;}catch{return false;}})())return {id:t.id,type:'tm_task',change_id:asked.id,message:`You already asked to hand this task over to ${nameOf(to)}. Wait for the answer.`,unchanged:true};
  if(to===t.pic_id)fail('Choose someone other than the current person in charge.');
  hooks.organization.checkCollaborator(actor,workspace(t.workspace_id),to,{existing:scope.isInvolved(to,t)});
  const note=str(d.note,'Note',1000),keep=d.keep===true||d.keep===1,at=now();
  // V5.4: handing over a task someone else assigned changes its person in charge, so the assigner approves it first.
  const approver=applying?null:approverFor(t,actor);
  if(approver){
   const change_id=requestChange(t,'UPDATE',actor,source,{approver,note,changes:[change('pic_id',t.pic_id,to)],payload:{handover:{to_id:to,keep,note}}});
   return {id:t.id,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. You stay in charge until they approve.`};
  }
  const rows=assigneeRows(t.id).filter(a=>a.staff_id!==to&&a.staff_id!==t.pic_id);
  run('DELETE FROM tm_assignees WHERE task_id=?',t.id);
  insert('tm_assignees',{task_id:t.id,staff_id:to,status:'ACCEPTED',invited_by:actor,invited_at:at,responded_at:null,response_note:''});
  if(keep)insert('tm_assignees',{task_id:t.id,staff_id:t.pic_id,status:'ACCEPTED',invited_by:actor,invited_at:at,responded_at:at,response_note:''});
  rows.forEach(r=>insert('tm_assignees',{task_id:t.id,...r}));
  const changes={pic_id:to,accepted_at:null,declined_at:null,declined_reason:'',...confirmReviewer(t,roles,at)};
  const next={...t,...changes,version:t.version+1,updated_at:at};update('tm_tasks',t.id,{...changes,version:next.version,updated_at:at});
  ensureMember(t.workspace_id,to,actor,'given a task by hand-over');
  history(next,'handover',t,actor,source,`${nameOf(t.pic_id)} → ${nameOf(to)}${note?': '+note:''}${applying?` · approved by ${nameOf(opts.approvedBy)}`:''}`);
  syncActivity(next);
  notify([to],'task_assigned',{task:next,title:`Handed over to you: ${t.title}`,body:`${nameOf(actor)} asks you to take charge · due ${human(t.due_date)}${note?' · '+note:''} · please accept or reject`},actor);
  notify([activeReviewer(t),assignerOf(t)],'task_updated',{task:next,title:`Handed over: ${t.title}`,body:`${nameOf(actor)} → ${nameOf(to)}${note?': '+note:''}`},actor);
  log(actor,'task',t.id,t.workspace_id,'Task handed over',`${t.title} · ${nameOf(t.pic_id)} → ${nameOf(to)}`,t.contact_id);
  return {id:t.id,type:'tm_task',message:`Handed over to ${nameOf(to)}. They are asked to accept it.`};
 }
 function remind(d,actor,source){
  const t=find('tm_tasks',d.id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('remind',t,roles);
  const last=get("SELECT created_at FROM tm_task_history WHERE task_id=? AND kind='remind' ORDER BY id DESC LIMIT 1",t.id);
  if(last&&Date.now()-Date.parse(last.created_at)<30*60000)fail('A reminder was sent less than 30 minutes ago. Please wait a little before sending another.',409);
  const waiting=waitingOn(t).filter(x=>x.staff_id!==actor),who=nameOf(actor);
  const asks={pic:'to take charge of',supporter:'to support',reviewer:'to review'};
  for(const w of waiting)notify([w.staff_id],'task_reminder',{task:t,title:`Reminder: ${t.title}`,body:`${who} is waiting for your answer ${asks[w.role]} this task · due ${human(t.due_date)} · please accept or reject`},actor);
  history(t,'remind',t,actor,source,`Reminded ${waiting.map(w=>nameOf(w.staff_id)).join(', ')}`);
  return {id:t.id,type:'tm_task',message:`Reminder sent to ${waiting.map(w=>nameOf(w.staff_id)).join(', ')}.`};
 }

 // V5.4: deadline reminders for one task (days before the due date). Either side can change them without approval:
 // they only decide when the people on the task are reminded. The task's version does not move, so open forms stay valid.
 function setReminders(d,actor,source){
  const t=find('tm_tasks',d.id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('reminders',t,roles);
  const list=reminderInput(d.reminder_days);
  if(JSON.stringify(list)===JSON.stringify(reminderDays(t.reminder_days)))return {id:t.id,type:'tm_task',message:'Reminders unchanged.',unchanged:true};
  run('UPDATE tm_tasks SET reminder_days=? WHERE id=?',JSON.stringify(list),t.id);
  history(t,'reminders',t,actor,source,reminderText(list));
  log(actor,'task',t.id,t.workspace_id,'Reminders changed',`${t.title} · ${reminderText(list)}`,t.contact_id);
  return {id:t.id,type:'tm_task',message:list.length?`Reminders set: ${reminderText(list)}.`:'Deadline reminders are off for this task.'};
 }

 // ---------------------------------------------------------------- V5.4 deciding a change request
 const crSummary=cr=>changeSummary(cr.kind,JSON.parse(cr.changes_json||'[]'));
 function changeAction(action,d,actor,source){
  const cr=find('tm_change_requests',d.id),t=find('tm_tasks',cr.task_id),summary=crSummary(cr);
  const asked=cr.kind==='UPDATE'?`change ${summary}`:summary;
  if(action==='tm.change.withdraw'){
   if(cr.requested_by!==actor)fail('Only the person who asked for this change can withdraw it.',403);
   if(cr.status==='WITHDRAWN')return {id:cr.id,type:'tm_change',task_id:t.id,message:'This request was already withdrawn.',unchanged:true};
   if(cr.status!=='PENDING')fail('This request has already been decided.',409);
   activeWorkspace(t.workspace_id);
   const note=str(d.note,'Note',1000);
   settleChange(cr,'WITHDRAWN',actor,source,note);
   // Taking back a completion request takes the task back out of review.
   let next=t;const back=cr.kind==='COMPLETE'&&cr.requester_side==='PIC'&&t.status==='IN_REVIEW';
   if(back){const changes={status:'IN_PROGRESS',...unsubmitted};next={...t,...changes,version:t.version+1,updated_at:now()};update('tm_tasks',t.id,{...changes,version:next.version,updated_at:next.updated_at});}
   history(next,'change_withdrawn',t,actor,source,`Withdrew the request to ${asked}${note?' · '+note:''}`);
   notify([cr.approver_id,back?t.submitted_to:null],'change_withdrawn',{task:next,title:`Request withdrawn: ${t.title}`,body:`${nameOf(actor)} withdrew the request to ${asked}`},actor);
   log(actor,'task',t.id,t.workspace_id,'Change request withdrawn',`${t.title} · ${CHANGE_WORD[cr.kind]}`,t.contact_id);
   return {id:cr.id,type:'tm_change',task_id:t.id,message:back?'Completion request withdrawn. The task is back in progress.':'Request withdrawn. Nothing was changed.'};
  }
  if(action!=='tm.change.decide')fail('Unknown change request action.',404);
  const decision=choice(d.decision,['APPROVE','REJECT'],'decision');
  if((cr.status==='APPROVED'&&decision==='APPROVE')||(cr.status==='REJECTED'&&decision==='REJECT'))return {id:cr.id,type:'tm_change',task_id:t.id,message:'This request was already decided.',unchanged:true};
  if(cr.status!=='PENDING')fail(cr.status==='WITHDRAWN'?'This request was withdrawn.':'This request has already been decided.',409);
  if(d.expected_version!==undefined&&d.expected_version!==null)version(cr,d.expected_version);
  activeWorkspace(t.workspace_id);
  if(actor!==cr.approver_id){
   // If the person asked can no longer use Task Management, the next person on that side decides instead. A new progress
   // figure is chosen the same way it was sent (progressApprover): it always stays on the assigner's side, so the people
   // working on the task never approve their own progress.
   const progressOnly=cr.kind==='UPDATE'&&(()=>{try{const list=JSON.parse(cr.changes_json||'[]');return list.length>0&&list.every(x=>x.field==='progress');}catch{return false;}})();
   const substitute=reachable(cr.approver_id)?null:progressOnly?progressApprover(t,cr.requested_by):approverFor(t,cr.requested_by,{edit:cr.kind==='UPDATE'});
   if(substitute!==actor)fail(`Only ${nameOf(cr.approver_id)} can approve or reject this request.`,403);
   update('tm_change_requests',cr.id,{approver_id:actor,updated_at:now()});
   if(t.status==='IN_REVIEW'&&t.submitted_to===cr.approver_id)update('tm_tasks',t.id,{submitted_to:actor});
   cr.approver_id=actor;
  }
  // A completion the person in charge asked for travels as work submitted for approval: approving closes the task
  // and rejecting returns it, exactly as on the task itself.
  if(cr.kind==='COMPLETE'&&cr.requester_side==='PIC'){
   const r=flow(decision==='APPROVE'?'close':'return',{id:t.id,note:d.note},actor,source);
   return {...r,change_id:cr.id};
  }
  if(decision==='REJECT'){
   const note=str(d.note??d.reason,'Reason for rejecting',1000,true);
   settleChange(cr,'REJECTED',actor,source,note);
   history(t,'change_rejected',t,actor,source,`Rejected ${nameOf(cr.requested_by)}’s request to ${asked}: ${note}`);
   notify([cr.requested_by],'change_rejected',{task:t,title:`Request rejected: ${t.title}`,body:`${nameOf(actor)} rejected your request to ${asked}: ${note}`},actor);
   log(actor,'task',t.id,t.workspace_id,'Change rejected',`${t.title} · ${CHANGE_WORD[cr.kind]} · ${note}`,t.contact_id);
   return {id:cr.id,type:'tm_change',task_id:t.id,message:'Request rejected. The task is unchanged.'};
  }
  const note=str(d.note,'Note',1000),changes=JSON.parse(cr.changes_json||'[]'),payload=JSON.parse(cr.payload_json||'{}');
  // A task that was closed after the request was made: the change no longer applies. (A change asked for on a task
  // that was already closed, and has not changed since, is applied like any other.)
  if(!OPEN_TASK_STATUSES.includes(t.status)&&!(cr.kind==='UPDATE'&&t.version===cr.base_version)){settleChange(cr,'CLOSED',actor,source,'The task was already closed');fail('This task is already closed, so the change can no longer apply. The request was closed.',409);}
  // A detail that changed after the request was made (for example a new due date approved for a supporting person)
  // would be overwritten: the request is closed instead and can be asked again.
  const stale=cr.kind==='UPDATE'?changes.filter(c=>!sameValue(currentValue(t,c.field),c.from)):[];
  if(stale.length){
   const why=`Out of date: ${stale.map(c=>c.label.toLowerCase()).join(', ')} changed after it was asked`;
   settleChange(cr,'CLOSED',actor,source,why);
   history(t,'change_closed',t,actor,source,`${nameOf(cr.requested_by)}’s request to ${asked} · ${why}`);
   notify([cr.requested_by],'change_rejected',{task:t,title:`Request closed: ${t.title}`,body:`${why}. Nothing was changed; ask again if it is still needed.`},actor);
   return {id:cr.id,type:'tm_change',task_id:t.id,closed:true,message:`${why}. The request was closed and nothing was changed; ${nameOf(cr.requested_by)} can ask again.`};
  }
  quiet=actor;
  try{
   if(cr.kind==='UPDATE'&&payload.reopen)flow('reopen',{id:t.id,note:payload.reopen.note||cr.note},cr.requested_by,source,{applying:cr,approvedBy:actor});
   else if(cr.kind==='UPDATE'&&payload.handover)handover({id:t.id,to_id:payload.handover.to_id,keep:payload.handover.keep,note:payload.handover.note},cr.requested_by,source,{applying:cr,approvedBy:actor});
   else if(cr.kind==='UPDATE'&&payload.progress!==undefined)flow('progress',{id:t.id,progress:payload.progress,note:payload.note||''},cr.requested_by,source,{applying:cr,approvedBy:actor});
   else if(cr.kind==='UPDATE'){const {handover:_h,reopen:_r,due_request_id:_q,...fields}=payload;saveTask({...taskInput(t),...fields,id:t.id,expected_version:t.version},cr.requested_by,source,{applying:cr,approvedBy:actor});}
   else if(cr.kind==='CANCEL')flow('cancel',{id:t.id,reason:payload.reason||cr.note,keep_series:payload.keep_series},cr.requested_by,source,{applying:cr,approvedBy:actor});
   else flow('close',{id:t.id,note:payload.note||cr.note},cr.requested_by,source,{applying:cr,approvedBy:actor});
  }finally{quiet=null;}
  settleChange(cr,'APPROVED',actor,source,note);
  notify([cr.requested_by],'change_approved',{task:t,title:`Request approved: ${t.title}`,body:`${nameOf(actor)} approved your request to ${asked}${note?': '+note:''}`},actor);
  log(actor,'task',t.id,t.workspace_id,'Change approved',`${t.title} · ${CHANGE_WORD[cr.kind]} · asked by ${nameOf(cr.requested_by)}`,t.contact_id);
  return {id:cr.id,type:'tm_change',task_id:t.id,message:cr.kind==='CANCEL'?'Approved. The task is cancelled.':cr.kind==='COMPLETE'?'Approved. The task is completed.':payload.reopen?'Approved. The task is reopened.':payload.progress!==undefined?`Approved. Progress is now ${payload.progress}%.`:'Approved. The change is applied.'};
 }

 // ---------------------------------------------------------------- V5.5 Steps of Work (the checklist)
 // An optional, ordered list of steps on a task. Completing a step saves who completed it and when, and tells the
 // assigner (once per completion: a repeated tap finds the step already completed). Steps need no approval, never change
 // the task's progress and never close the task: progress is reported (and approved) separately. Unticking a completed
 // step reopens it (its completion is cleared and the history keeps both). Steps keep their state when a task is
 // reopened, and can't be changed while the task is closed.
 const stepCount=taskId=>get('SELECT COUNT(*) AS n,COALESCE(SUM(done),0) AS done FROM tm_checklist WHERE task_id=?',taskId);
 const renumber=taskId=>all('SELECT id FROM tm_checklist WHERE task_id=? ORDER BY position,created_at,id',taskId).forEach((r,i)=>run('UPDATE tm_checklist SET position=? WHERE id=?',i+1,r.id));
 function checklist(action,d,actor,source){
  if(action==='tm.check.add'){
   const t=find('tm_tasks',d.task_id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('checklist',t,roles);
   const title=str(d.title,'Step',300,true);
   const twin=get('SELECT id FROM tm_checklist WHERE task_id=? AND title=? AND created_by=? AND created_at>?',t.id,title,actor,new Date(Date.now()-15000).toISOString());
   if(twin)return {id:twin.id,type:'tm_check',message:'Step added.',unchanged:true};
   if(get('SELECT COUNT(*) AS n FROM tm_checklist WHERE task_id=?',t.id).n>=MAX_CHECKS)fail(`A task can have up to ${MAX_CHECKS} steps.`);
   const key=id('tm-check','CHK'),position=(get('SELECT MAX(position) AS p FROM tm_checklist WHERE task_id=?',t.id).p||0)+1;
   insert('tm_checklist',{id:key,task_id:t.id,position,title,done:0,created_by:actor,created_at:now()});
   afterChecklist(t,roles,actor,source,`Added step “${title}”`);
   return {id:key,type:'tm_check',message:'Step added.'};
  }
  const item=find('tm_checklist',d.id),t=find('tm_tasks',item.task_id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('checklist',t,roles);
  if(action==='tm.check.toggle'){
   const done=d.done===true||d.done===1;
   if(!!item.done===done)return {id:item.id,type:'tm_check',message:done?'This step is already completed.':'This step is already open.',unchanged:true};
   run('UPDATE tm_checklist SET done=?,done_by=?,done_at=? WHERE id=?',done?1:0,done?actor:null,done?now():null,item.id);
   const c=stepCount(t.id),next=afterChecklist(t,roles,actor,source,`${done?'Completed':'Reopened'} step “${item.title}”`);
   // One completion, one message to the assigner (the step, who completed it and how far the steps are).
   if(done)notify([assignerOf(t)],'step_completed',{task:next,title:`Step completed: ${t.title}`,body:`${nameOf(actor)} completed “${clip(item.title,120)}” · ${c.done} of ${c.n} steps completed`},actor);
   return {id:item.id,type:'tm_check',message:done?`Step completed (${c.done} of ${c.n}).`:`Step reopened (${c.done} of ${c.n} completed).`};
  }
  if(action==='tm.check.rename'){
   const title=str(d.title,'Step',300,true);if(title===item.title)return {id:item.id,type:'tm_check',message:'No change.',unchanged:true};
   run('UPDATE tm_checklist SET title=? WHERE id=?',title,item.id);afterChecklist(t,roles,actor,source,`Renamed step “${item.title}” to “${title}”`);
   return {id:item.id,type:'tm_check',message:'Step renamed.'};
  }
  if(action==='tm.check.move'){
   // To a position (1 = first), or one place up or down.
   const list=all('SELECT id FROM tm_checklist WHERE task_id=? ORDER BY position,created_at,id',t.id).map(r=>r.id),from=list.indexOf(item.id);
   const to=d.direction==='up'?from-1:d.direction==='down'?from+1:integer(d.position,1,list.length,'step position')-1;
   if(to<0||to>=list.length||to===from)return {id:item.id,type:'tm_check',message:'The step is already there.',unchanged:true};
   list.splice(from,1);list.splice(to,0,item.id);list.forEach((key,i)=>run('UPDATE tm_checklist SET position=? WHERE id=?',i+1,key));
   afterChecklist(t,roles,actor,source,`Moved step “${item.title}” to position ${to+1}`);
   return {id:item.id,type:'tm_check',message:`Step moved to position ${to+1}.`};
  }
  if(action==='tm.check.remove'){
   run('DELETE FROM tm_checklist WHERE id=?',item.id);renumber(t.id);afterChecklist(t,roles,actor,source,`Removed step “${item.title}”`);
   return {id:t.id,type:'tm_task',message:'Step removed.'};
  }
  fail('Unknown step action.',404);
 }
 // Working on a step confirms the person's role, and completing the first step of a task that has not started yet
 // starts it (and accepts it, for the person in charge). Progress is never changed here.
 function afterChecklist(t,roles,actor,source,note){
  const c=stepCount(t.id),at=now(),changes={...confirmReviewer(t,roles,at)};
  confirmSupport(t,roles,actor,at);
  if((roles.isPic||roles.isSupporter)&&t.status==='NOT_STARTED'&&c.done>0){changes.status='IN_PROGRESS';if(roles.isPic&&!t.accepted_at)Object.assign(changes,{accepted_at:at,declined_at:null,declined_reason:''});}
  let next=t;
  if(Object.keys(changes).length){next={...t,...changes,version:t.version+1,updated_at:at};update('tm_tasks',t.id,{...changes,version:next.version,updated_at:at});}
  history(next,'checklist',t,actor,source,`${note} · ${c.done} of ${c.n} steps completed`);
  log(actor,'task',t.id,t.workspace_id,'Steps of work updated',`${t.title} · ${note}`,t.contact_id);
  return next;
 }

 // ---------------------------------------------------------------- files and photos
 const decode=(value,max,message)=>{
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(max*4/3)+8||!BASE64.test(value))fail(message);
  const content=Buffer.from(value,'base64');if(!content.length||content.length>max)fail(message);return content;
 };
 function files(action,d,actor,source){
  if(action==='tm.file.add'){
   const t=find('tm_tasks',d.task_id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('file',t,roles);
   const name=str(d.name,'File name',160,true).replaceAll('\\','/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'').trim()||'file';
   const ext=name.includes('.')?name.split('.').pop().toLowerCase():'';
   if(!Object.hasOwn(TASK_FILE_TYPES,ext))fail('Attach a PDF, image (JPG, PNG, WebP, GIF, HEIC), Word, Excel, PowerPoint, CSV, TXT or ZIP file.');
   const content=decode(d.base64,MAX_FILE,'Choose a file between 1 byte and 30 MB.');
   if(!contentMatches(ext,content))fail(`This file is not a real ${ext.toUpperCase()} file. Choose the original file.`);
   if(get('SELECT COUNT(*) AS n FROM tm_files WHERE task_id=?',t.id).n>=MAX_FILES)fail(`A task can have up to ${MAX_FILES} files. Remove one first.`);
   const key=id('tm-file','FILE');
   insert('tm_files',{id:key,task_id:t.id,name,mime:TASK_FILE_TYPES[ext],size:content.length,content,uploaded_by:actor,source,created_at:now()});
   history(t,'file',t,actor,source,name);
   notify([t.pic_id,activeReviewer(t),assignerOf(t)],'task_file',{task:t,title:`File added: ${t.title}`,body:`${nameOf(actor)} attached ${name}`},actor);
   log(actor,'task',t.id,t.workspace_id,'File attached',`${t.title} · ${name}`,t.contact_id);
   return {id:key,type:'tm_file',task_id:t.id,message:`${name} attached.`};
  }
  if(action==='tm.file.remove'){
   const f=find('tm_files',d.id),t=find('tm_tasks',f.task_id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);
   if(f.uploaded_by!==actor&&!roles.isGovernor)fail('Only the person who added this file or the task’s manager can remove it.',403);
   // V5.6.8: the files of a completed or cancelled task are part of its record.
   if(!OPEN_TASK_STATUSES.includes(t.status))fail('This task is closed, so its files are kept. Reopen it first to remove a file.',409);
   run('DELETE FROM tm_files WHERE id=?',f.id);history(t,'file_removed',t,actor,source,f.name);
   log(actor,'task',t.id,t.workspace_id,'File removed',`${t.title} · ${f.name}`,t.contact_id);
   return {id:t.id,type:'tm_task',message:`${f.name} removed.`};
  }
  fail('Unknown file action.',404);
 }
 function setPhoto(staff,base64,actor){
  const b=decode(base64,MAX_PHOTO,'Choose a JPEG, PNG or WebP photo up to 2 MB.');
  const mime=b[0]===0xff&&b[1]===0xd8&&b[2]===0xff?'image/jpeg':b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))?'image/png':b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP'?'image/webp':null;
  if(!mime)fail('Choose a JPEG, PNG or WebP photo up to 2 MB.');
  run('INSERT INTO staff_photos(staff_id,mime,size,content,version,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(staff_id) DO UPDATE SET mime=excluded.mime,size=excluded.size,content=excluded.content,version=staff_photos.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',staff,mime,b.length,b,actor,now());
 }
 // Removing keeps the row (empty), so the photo's version keeps counting up and browsers never show an old copy.
 const removePhoto=(staff,actor)=>run("UPDATE staff_photos SET mime='',size=0,content=X'',version=version+1,updated_by=?,updated_at=? WHERE staff_id=? AND size>0",actor,now(),staff).changes;
 function me(action,d,actor){
  if(action==='me.profile.save'){
   if(d.name!==undefined&&str(d.name,'Display name',200,true)!==canonicalName(actor))fail('Your display name comes from your username. Ask an administrator to change it.',403);
   if(d.nickname!==undefined){
    const nickname=str(d.nickname,'Nickname',80);
    run("INSERT INTO tm_profiles(staff_id,nickname) VALUES(?,?) ON CONFLICT(staff_id) DO UPDATE SET nickname=excluded.nickname,version=version+1",actor,nickname);
    log(actor,'user',actor,null,'Nickname changed',nickname);
    return {id:actor,type:'me',message:'Your nickname is saved.'};
   }
   // V5.6.8: your own sidebar colour (only your screens change).
   if(d.sidebar_theme!==undefined){
    const theme=d.sidebar_theme===''||d.sidebar_theme==='blue'?'':choice(d.sidebar_theme,SIDEBAR_THEMES,'Sidebar colour');
    const before=get('SELECT sidebar_theme FROM tm_profiles WHERE staff_id=?',actor)?.sidebar_theme||'';
    if(theme!==before)run("INSERT INTO tm_profiles(staff_id,sidebar_theme) VALUES(?,?) ON CONFLICT(staff_id) DO UPDATE SET sidebar_theme=excluded.sidebar_theme",actor,theme);
    if(d.name===undefined&&d.timezone===undefined)return {id:actor,type:'me',message:theme!==before?'Your sidebar colour is saved.':'Your sidebar colour is unchanged.',...(theme!==before?{}:{unchanged:true})};
   }
   // V5.5: your own time zone (calendar, reminders and note dates follow it; empty = the company's).
   let zoneChanged=false;
   if(d.timezone!==undefined){
    const zone=zoneInput(d.timezone),before=get('SELECT timezone FROM tm_profiles WHERE staff_id=?',actor)?.timezone||'';
    if(zone!==before){run("INSERT INTO tm_profiles(staff_id,timezone) VALUES(?,?) ON CONFLICT(staff_id) DO UPDATE SET timezone=excluded.timezone",actor,zone);log(actor,'user',actor,null,'Time zone changed',`${before||'company time zone'} → ${zone||'company time zone'}`);zoneChanged=true;}
    if(d.name===undefined)return {id:actor,type:'me',message:zoneChanged?'Your time zone is saved.':'Your time zone is unchanged.',...(zoneChanged?{}:{unchanged:true})};
   }
   return {id:actor,type:'me',message:'Your profile is unchanged.',unchanged:true};
  }
  if(action==='me.photo.save'){setPhoto(actor,d.base64,actor);log(actor,'user',actor,null,'Profile photo changed',nameOf(actor));return {id:actor,type:'me',message:'Your photo is saved.'};}
  if(action==='me.photo.remove'){const n=removePhoto(actor,actor);if(n)log(actor,'user',actor,null,'Profile photo removed',nameOf(actor));return {id:actor,type:'me',message:n?'Your photo is removed.':'You have no photo.'};}
  fail('Unknown profile action.',404);
 }

 // ---------------------------------------------------------------- task requests (anyone can ask anyone)
 const receiverFor=(staff,requester)=>{
  if(!staff)fail('Choose the person you are asking.');
  const m=assignable(staff);
  if(m===requester)fail('Choose someone else. You can’t send a request to yourself.');
  if(!accountOf(m))fail(`${nameOf(m)} has no Task Controlling Management login, so they can’t answer requests. Choose someone who uses the Task Controlling Management.`);
  return m;
 };
 function request(action,d,actor,source){
  if(action==='tm.request.save'){
   const old=d.id?find('tm_requests',d.id):null;
   if(old){version(old,d.expected_version);if(old.requested_by!==actor)fail('Only the person who made this request can change it.',403);if(old.status!=='PENDING')fail('This request has already been decided.',409);}
   const creationKey=!old&&d.request_key?`${actor}:${str(d.request_key,'Creation key',100,true)}`:null;
   if(creationKey){const duplicate=get('SELECT * FROM tm_requests WHERE creation_key=?',creationKey);if(duplicate)return {id:duplicate.id,type:'tm_request',message:'Request already sent.'};}
   const receiver=receiverFor(d.manager_id,actor),wid=d.workspace_id?activeWorkspace(d.workspace_id).id:null;
   // V5.6.8: one person can't flood another with requests.
   if((!old||old.manager_id!==receiver)&&get("SELECT COUNT(*) AS n FROM tm_requests WHERE requested_by=? AND manager_id=? AND status='PENDING'",actor,receiver).n>=20)fail(`You already have 20 requests waiting for ${nameOf(receiver)}. Wait for answers, or withdraw some first.`,429);
   if(wid){const w=workspace(wid);if(!old&&!hooks.organization.canCreateResource(actor,w))fail('Join this workspace before requesting work in it.',403);hooks.organization.checkCollaborator(actor,w,receiver,{existing:old?.manager_id===receiver&&old?.workspace_id===wid});}
   const proposed=d.proposed_due_date?date(d.proposed_due_date,'Proposed due date'):null;
   if(proposed&&proposed<taskToday()&&proposed!==old?.proposed_due_date)fail('Choose a “needed by” date from today on.');
   // Who does the work: the person asked (the default in the Task Controlling Management and Telegram), the requester, or decided later.
   const doer=d.doer===undefined||d.doer===null||d.doer===''?(old?.doer||'REQUESTER'):choice(d.doer,['RECEIVER','REQUESTER','DECIDE'],'option for who does the work');
   const key=old?.id||id('tm-request','REQ');
   const values={workspace_id:wid,title:str(d.title,'Request title',300,true),description:str(d.description,'Expectation',8000,!old),department:str(d.department??'','Department',150),department_note:str(d.department_note??'','Department note',2000),
    priority:choice(d.priority||'MEDIUM',['HIGH','MEDIUM','LOW'],'priority'),proposed_due_date:proposed,manager_id:receiver,doer,version:old?old.version+1:0,updated_at:now()};
   if(old)update('tm_requests',key,values);else insert('tm_requests',{id:key,...values,requested_by:actor,status:'PENDING',source,creation_key:creationKey,created_at:now()});
   const q=find('tm_requests',key);
   const ask=doer==='RECEIVER'?'asks you to do this task':doer==='REQUESTER'?'asks to take on this task':'asks for this task';
   if(!old||old.manager_id!==receiver)notify([receiver],'request_new',{request:q,title:`Task request: ${q.title}`,body:`${nameOf(actor)} ${ask}${proposed?` · needed by ${human(proposed)}`:''}`},actor);
   log(actor,'request',key,wid,old?'Task request updated':'Task requested',`${q.title} · to ${nameOf(receiver)}`);
   return {id:key,type:'tm_request',message:old?'Request updated.':`Request sent to ${nameOf(receiver)}.`};
  }
  const q=find('tm_requests',d.id);
  // A request this person may not see is answered exactly like one that does not exist.
  if(!scope.canSeeRequest(actor,q))fail('Task Management record not found.',404);
  if(action==='tm.request.withdraw'){
   if(q.requested_by!==actor)fail('Only the person who made this request can withdraw it.',403);
   if(q.status==='WITHDRAWN')return {id:q.id,type:'tm_request',message:'This request was already withdrawn.',unchanged:true};
   if(q.status!=='PENDING')fail('This request has already been decided.',409);
   if(d.expected_version!==undefined&&d.expected_version!==null)version(q,d.expected_version);
   update('tm_requests',q.id,{status:'WITHDRAWN',decision_note:str(d.note,'Note',1000),version:q.version+1,updated_at:now()});
   notify([q.manager_id],'request_withdrawn',{request:q,title:`Request withdrawn: ${q.title}`,body:`${nameOf(actor)} withdrew the request`},actor);
   log(actor,'request',q.id,q.workspace_id,'Task request withdrawn',q.title);return {id:q.id,type:'tm_request',message:'Request withdrawn.'};
  }
  if(action==='tm.request.forward'){
   if(q.manager_id!==actor)fail('Only the person this request was sent to can pass it on.',403);
   if(q.status!=='PENDING')fail('This request has already been decided.',409);
   if(d.expected_version!==undefined&&d.expected_version!==null)version(q,d.expected_version);
   if(d.manager_id&&d.manager_id===q.requested_by)fail(`${nameOf(q.requested_by)} asked for this task. To give it back, decline it with a note instead.`);
   const receiver=receiverFor(d.manager_id,q.requested_by);if(receiver===actor)fail('Choose someone else to pass it to.');
   // V5.6.8: passing a request on follows the same workspace rules as sending it.
   if(q.workspace_id){const w=workspace(q.workspace_id);if(w.status!=='ACTIVE')fail('Restore the workspace before changing its work.');hooks.organization.checkCollaborator(actor,w,receiver,{});}
   const note=str(d.note,'Note',1000);
   update('tm_requests',q.id,{manager_id:receiver,version:q.version+1,updated_at:now()});
   notify([receiver],'request_new',{request:q,title:`Task request: ${q.title}`,body:`${nameOf(actor)} passed on a request from ${nameOf(q.requested_by)}${note?': '+note:''}`},actor);
   notify([q.requested_by],'request_forwarded',{request:q,title:`Request passed on: ${q.title}`,body:`${nameOf(actor)} passed your request to ${nameOf(receiver)}`},actor);
   log(actor,'request',q.id,q.workspace_id,'Task request passed on',`${q.title} · to ${nameOf(receiver)}`);return {id:q.id,type:'tm_request',message:`Request passed to ${nameOf(receiver)}.`};
  }
  if(action==='tm.request.decide'){
   const decision=choice(d.decision,['APPROVE','DECLINE'],'decision');
   if(q.manager_id!==actor)fail('Only the person this request was sent to can decide it.',403);
   if(q.status==='APPROVED'&&decision==='APPROVE')return {id:q.task_id,type:'tm_task',message:'This request was already accepted.',unchanged:true};
   if(q.status==='DECLINED'&&decision==='DECLINE')return {id:q.id,type:'tm_request',message:'This request was already declined.',unchanged:true};
   if(q.status!=='PENDING')fail('This request has already been decided.',409);
   if(d.expected_version!==undefined&&d.expected_version!==null)version(q,d.expected_version);
   if(decision==='DECLINE'){
    const note=str(d.note,'Reason for declining',1000,true);
    update('tm_requests',q.id,{status:'DECLINED',decision_note:note,decided_by:actor,decided_at:now(),version:q.version+1,updated_at:now()});
    notify([q.requested_by],'request_declined',{request:q,title:`Request declined: ${q.title}`,body:`${nameOf(actor)}: ${note}`},actor);
    log(actor,'request',q.id,q.workspace_id,'Task request declined',`${q.title} · ${note}`);return {id:q.id,type:'tm_request',message:'Request declined. The requester has been told.'};
   }
   const wid=d.workspace_id||q.workspace_id;if(!wid)fail('Choose the workspace for this task.');
   const doer=q.doer||'REQUESTER',pic=d.pic_id||(doer==='RECEIVER'?actor:doer==='REQUESTER'?q.requested_by:null);
   if(!pic)fail('Choose the person in charge of this task.');
   const reviewer=d.reviewer_id||(doer==='RECEIVER'?q.requested_by:actor);
   const due=d.due_date||q.proposed_due_date;if(!due)fail('Choose a due date for this task.');
   const dueDay=date(due,'Due date'),start=d.start_date||(taskToday()<=dueDay?taskToday():dueDay);
   // The requester agreed by asking: as the person in charge when they asked to take it on, or as the reviewer
   // when they asked someone else to do it.
   const requesterDoes=pic===q.requested_by&&doer==='REQUESTER';
   const created=saveTask({workspace_id:wid,title:d.title||q.title,description:d.description??q.description,start_date:start,due_date:dueDay,priority:d.priority||q.priority,estimate:d.estimate||'0:00',
    pic_id:pic,supporter_ids:d.supporter_ids||[],reviewer_id:reviewer,department:d.department??(q.department||undefined),department_note:d.department_note??q.department_note,recurrence:d.recurrence,recurrence_until:d.recurrence_until,checklist:d.checklist},
    actor,source,{creationKey:'request:'+q.id,requestId:q.id,accepted:requesterDoes,quietPic:requesterDoes,memberAuthority:q.requested_by,reviewerAccepted:doer==='RECEIVER'&&reviewer===q.requested_by?reviewer:null,
     // V5.4: whoever takes the work on themselves was given it by the person who asked for it.
     assignedBy:pic===actor?q.requested_by:actor});
   const note=str(d.note,'Note',1000);
   update('tm_requests',q.id,{status:'APPROVED',task_id:created.id,decision_note:note,decided_by:actor,decided_at:now(),version:q.version+1,updated_at:now()});
   const who=pic===q.requested_by?'you are in charge':pic===actor?`${nameOf(actor)} will do it`:'in charge: '+nameOf(pic);
   notify([q.requested_by],'request_approved',{request:q,task:{id:created.id},title:`Request accepted: ${q.title}`,body:`${nameOf(actor)} accepted it as ${created.id} · ${who} · due ${human(dueDay)}${note?' · '+note:''}`},actor);
   log(actor,'request',q.id,wid,'Task request accepted',`${q.title} · ${created.id}`);
   return {id:created.id,type:'tm_task',message:`Request accepted as ${created.id}.`};
  }
  fail('Unknown task request action.',404);
 }

 // ---------------------------------------------------------------- due date change requests
 function dueRequest(action,d,actor,source){
  if(action==='tm.due.request'){
   const t=find('tm_tasks',d.task_id);activeWorkspace(t.workspace_id);const roles=rolesFor(t,actor);guard('due',t,roles);
   const proposed=date(d.proposed_due_date,'New due date');
   if(proposed<t.start_date)fail('The new due date cannot be before the start date.');
   if(proposed===t.due_date)fail('Choose a date that differs from the current due date.');
   const reason=str(d.reason,'Reason',1000,true);
   // V5.4: the person in charge of a task someone else assigned asks the assigner, as a change for approval.
   if(roles.isPic&&twoSided(t)){
    const approver=approverFor(t,actor);
    if(approver){
     const change_id=requestChange(t,'UPDATE',actor,source,{approver,note:reason,changes:[change('due_date',t.due_date,proposed)],payload:{due_date:proposed}});
     return {id:t.id,type:'tm_task',change_id,message:`Sent to ${nameOf(approver)} for approval. The due date stays ${human(t.due_date)} until they approve.`};
    }
   }
   const decider=dueDecider(t),key=id('tm-due','DUE');
   confirmSupport(t,roles,actor,now());
   insert('tm_due_requests',{id:key,task_id:t.id,requested_by:actor,decide_by:decider,current_due_date:t.due_date,proposed_due_date:proposed,reason,status:'PENDING',source,created_at:now(),updated_at:now()});
   history(t,'due_request',t,actor,source,`${t.due_date} → ${proposed}: ${reason}`);
   const q=find('tm_due_requests',key);
   notify([decider],'due_new',{task:t,due:q,title:`New due date requested: ${t.title}`,body:`${nameOf(actor)} asks to move it from ${human(t.due_date)} to ${human(proposed)}: ${reason}`},actor);
   log(actor,'task',t.id,t.workspace_id,'New due date requested',`${t.due_date} → ${proposed} · ${reason}`,t.contact_id);
   return {id:key,type:'tm_due_request',message:`Request sent to ${nameOf(decider)}.`};
  }
  const q=find('tm_due_requests',d.id),t=find('tm_tasks',q.task_id);
  if(action==='tm.due.withdraw'){
   if(q.requested_by!==actor)fail('Only the person who asked can withdraw this request.',403);
   if(q.status==='WITHDRAWN')return {id:q.id,type:'tm_due_request',message:'Already withdrawn.',unchanged:true};
   if(q.status!=='PENDING')fail('This request has already been decided.',409);
   update('tm_due_requests',q.id,{status:'WITHDRAWN',version:q.version+1,updated_at:now()});
   history(t,'due_withdrawn',t,actor,source,`${q.current_due_date} → ${q.proposed_due_date} withdrawn`);
   notify([q.decide_by],'task_updated',{task:t,due:q,title:`Due date request withdrawn: ${t.title}`,body:`${nameOf(actor)} withdrew the request to move it to ${human(q.proposed_due_date)}`},actor);
   log(actor,'task',t.id,t.workspace_id,'Due date request withdrawn',`${q.current_due_date} → ${q.proposed_due_date}`,t.contact_id);
   return {id:q.id,type:'tm_due_request',message:'Due date request withdrawn.'};
  }
  if(action==='tm.due.decide'){
   const decision=choice(d.decision,['APPROVE','DECLINE'],'decision');
   // The person asked decides; if the reviewer later rejected the role, the task's creator can decide instead.
   if(q.decide_by!==actor&&dueDecider(t)!==actor&&!(canApprove(actor)&&scope.isInvolved(actor,t)))fail('Only the task’s reviewer or a task approver on this task can decide this request.',403);
   if((q.status==='APPROVED'&&decision==='APPROVE')||(q.status==='DECLINED'&&decision==='DECLINE'))return {id:q.id,type:'tm_due_request',message:'This request was already decided.',unchanged:true};
   if(q.status!=='PENDING')fail('This request has already been decided.',409);
   if(d.expected_version!==undefined&&d.expected_version!==null)version(q,d.expected_version);
   activeWorkspace(t.workspace_id);
   const note=str(d.note,decision==='DECLINE'?'Reason for declining':'Note',1000,decision==='DECLINE');
   update('tm_due_requests',q.id,{status:decision==='APPROVE'?'APPROVED':'DECLINED',decision_note:note,decided_by:actor,decided_at:now(),version:q.version+1,updated_at:now()});
   const confirm=confirmReviewer(t,rolesFor(t,actor),now());
   if(decision==='APPROVE'){
    if(!OPEN_TASK_STATUSES.includes(t.status))fail('This task is closed, so its due date can no longer change.',409);
    if(q.proposed_due_date<t.start_date)fail('The new due date is before the task’s start date.',409);
    // V5.4: on a task both sides agreed to, agreeing to a supporting person's new date is a change like any other:
    // it applies once the other side (usually the person in charge) approves it.
    const approver=approverFor(t,actor);
    if(approver){
     const change_id=requestChange(t,'UPDATE',actor,source,{approver,note:`${nameOf(q.requested_by)} asked: ${q.reason}`,changes:[change('due_date',t.due_date,q.proposed_due_date)],payload:{due_date:q.proposed_due_date,due_request_id:q.id}});
     update('tm_due_requests',q.id,{decision_note:[note,`sent to ${nameOf(approver)} for approval`].filter(Boolean).join(' · ')});
     notify([q.requested_by],'due_approved',{task:t,due:q,title:`New due date agreed: ${t.title}`,body:`${nameOf(actor)} agreed to ${human(q.proposed_due_date)}; ${nameOf(approver)} approves it before it applies`},actor);
     log(actor,'task',t.id,t.workspace_id,'Due date change agreed',`${t.due_date} → ${q.proposed_due_date} · sent to ${nameOf(approver)}`,t.contact_id);
     return {id:q.id,type:'tm_due_request',change_id,message:`Agreed. ${nameOf(approver)} approves the new date before it applies.`};
    }
    const plan=t.recurrence&&!t.scheduled_due?{scheduled_due:t.due_date,series_anchor:t.series_anchor||Number(t.due_date.slice(8,10))}:{};
    const next={...t,...confirm,...plan,due_date:q.proposed_due_date,version:t.version+1,updated_at:now()};
    update('tm_tasks',t.id,{...confirm,...plan,due_date:next.due_date,version:next.version,updated_at:next.updated_at});
    history(next,'due_change',t,actor,source,`${t.due_date} → ${next.due_date}${note?': '+note:''}`);
    notify([q.requested_by,t.pic_id,...supportersOf(t)],'due_approved',{task:next,due:q,title:`Due date moved: ${t.title}`,body:`${nameOf(actor)} approved ${human(next.due_date)} (was ${human(t.due_date)})`},actor);
    log(actor,'task',t.id,t.workspace_id,'Due date change approved',`${t.due_date} → ${next.due_date}`,t.contact_id);
    return {id:q.id,type:'tm_due_request',message:`Due date changed to ${next.due_date}.`};
   }
   if(Object.keys(confirm).length)update('tm_tasks',t.id,{...confirm,version:t.version+1,updated_at:now()});
   history(t,'due_declined',t,actor,source,`${q.proposed_due_date} declined: ${note}`);
   notify([q.requested_by],'due_declined',{task:t,due:q,title:`Due date request declined: ${t.title}`,body:`${nameOf(actor)}: ${note}`},actor);
   log(actor,'task',t.id,t.workspace_id,'Due date change declined',note,t.contact_id);
   return {id:q.id,type:'tm_due_request',message:'Due date request declined.'};
  }
  fail('Unknown due date action.',404);
 }

 // ---------------------------------------------------------------- deadline reminders (bell, Telegram and the Mini App)
 // Called every few minutes by the Task Controlling Management. From 07:00 Cambodia time each open task reminds the people on it (the person
 // in charge, supporting people, the assigner and the reviewer) on the days before its due date chosen for that task
 // (one day unless changed; a reminder whose day was missed is sent once, late), and says once that it is overdue (to
 // the person in charge, the assigner and whoever decides new due dates). Nobody else is told.
 function dueReminders(at=new Date()){
  const todayKey=localDay(at.toISOString()),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Phnom_Penh',hour:'numeric',hourCycle:'h23'}).format(at));
  if(hour<7)return 0;
  let sent=0;
  const send=(t,staff,key,kind,title,body)=>{
   if(!staff||get('SELECT 1 AS x FROM tm_reminders WHERE task_id=? AND staff_id=? AND kind=? AND due_date=?',t.id,staff,key,t.due_date))return;
   insert('tm_reminders',{task_id:t.id,staff_id:staff,kind:key,due_date:t.due_date,created_at:now()});
   insert('tm_notifications',{staff_id:staff,kind,task_id:t.id,request_id:null,due_request_id:null,title,body,actor_id:null,created_at:now()});sent++;
  };
  for(const t of all("SELECT t.* FROM tm_tasks t JOIN tm_workspaces w ON w.id=t.workspace_id WHERE w.status='ACTIVE' AND t.status IN ('NOT_STARTED','IN_PROGRESS','IN_REVIEW') AND t.due_date<=?",addDays(todayKey,90))){
   const days=daysBetween(todayKey,t.due_date);
   if(days>=1){
    // The nearest chosen reminder whose day has come (reminder days are sorted from the earliest reminder).
    const n=reminderDays(t.reminder_days).filter(x=>x>=days).at(-1);if(!n)continue;
    const key=n===1?'task_due_soon':`due_in_${n}`,when=days===1?'Due tomorrow':`Due in ${days} days`,workers=[t.declined_at?null:t.pic_id,...supportersOf(t)].filter(Boolean);
    const state=`${t.progress}% done${t.status==='IN_REVIEW'?' · waiting for review':t.stuck_at?' · stuck':!t.accepted_at?' · not accepted yet':''}`;
    for(const s of new Set(workers))send(t,s,key,'task_due_soon',`${when}: ${t.title}`,`${human(t.due_date)} · ${state}`);
    for(const s of new Set([assignerOf(t),activeReviewer(t)]))if(s&&!workers.includes(s))send(t,s,key,'task_due_soon',`${when}: ${t.title}`,`${human(t.due_date)} · ${nameOf(t.pic_id)} is in charge · ${state}`);
   }else if(days<0){
    const body=`It was due ${human(t.due_date)} (${-days} day${days===-1?'':'s'} ago) · ${t.progress}% done`;
    for(const s of new Set([t.declined_at?null:t.pic_id,assignerOf(t),dueDecider(t)]))send(t,s,'task_overdue','task_overdue',`Overdue: ${t.title}`,body);
   }
  }
  return sent;
 }

 // ---------------------------------------------------------------- V5.5 meetings and the calendar
 // Meetings are visible to their participants (the organizer and attendees) and to the people they are shared with:
 // everyone in the meeting's workspace, everyone who can use Meetings, or selected people (task-scope.mjs). Only
 // participants change a meeting. Reminders (minutes before the start) reach the participants and anyone the meeting is
 // shared with who asked for its reminders; each person sees times in their own time zone.
 const MAX_OFFSET=30*1440;
 const offsetsInput=(v,label='Reminders')=>{
  if(v===undefined||v===null||v==='')return [];
  // The stored form (a JSON list, as the state sends it) is accepted too.
  if(typeof v==='string'&&/^\s*\[/.test(v)){try{v=JSON.parse(v);}catch{fail(`${label}: choose up to five reminders.`);}}
  if(!Array.isArray(v)||v.length>5)fail(`${label}: choose up to five reminders.`);
  const list=[...new Set(v.map(Number))];
  if(list.some(n=>!Number.isInteger(n)||n<0||n>MAX_OFFSET))fail(`${label}: each reminder is 0 minutes to 30 days before the start.`);
  return list.sort((a,b)=>b-a);
 };
 const offsetText=n=>n===0?'at the start':n%1440===0?`${n/1440} day${n===1440?'':'s'} before`:n%60===0?`${n/60} hour${n===60?'':'s'} before`:`${n} minute${n===1?'':'s'} before`;
 const at=(iso,zone)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
 const zoneLabel=zone=>zone==='UTC'?'UTC':`${zone.split('/').pop().replace(/_/g,' ')} time`;
 // Reminders that would already be in the past when they are set are refused, so nobody expects one that never comes.
 const pastOffsets=(start,offsets)=>offsets.filter(n=>Date.parse(start)-n*60000<Date.now()-60000);
 // The organizer, the attendees and whoever scheduled the meeting.
 const isParticipant=(m,staff)=>m.organizer_id===staff||m.created_by===staff||!!get('SELECT 1 AS ok FROM tm_attendees WHERE meeting_id=? AND staff_id=?',m.id,staff);
 const meetingWorkflow=createMeetingWorkflow({...c,scope,hooks,save:saveMeeting,log,nameOf});
 function saveMeeting(d,actor,source){
  const old=d.id?find('tm_meetings',d.id):null;
  if(old){
   if(!scope.canSeeMeeting(actor,old))hidden();
   version(old,d.expected_version);
   if(!isParticipant(old,actor))fail('Only the organizer and the attendees can change this meeting. It is shared with you to view.',403);
  }
  // V5.6.8: the organizer and whoever scheduled the meeting manage it (time, people, organizer, details, cancelling); the
  // other participants may complete it with notes and set its reminders.
  const manager=!old||isParticipant(old,actor);
  const creationKey=!old&&d.request_key?`${actor}:${str(d.request_key,'Creation key',100,true)}`:null;
  if(creationKey){const duplicate=get('SELECT * FROM tm_meetings WHERE creation_key=?',creationKey);if(duplicate){if(duplicate.workspace_id!==d.workspace_id)fail('Creation key already belongs to another workspace.');return {id:duplicate.id,type:'tm_meeting'};}}
  const w=activeWorkspace(old?.workspace_id||d.workspace_id),key=old?.id||id('tm-meeting','MEET');
  if(!old&&!hooks.organization.canCreateResource(actor,w))fail('Join this workspace before scheduling a meeting in it.',403);
  const a=activity(old?.activity_id||d.activity_id,'MEETING');
  let task=d.task_id?find('tm_tasks',d.task_id):null;
  // V5.5.1: a link to a task this person can't see stays as it is (they could not see it, so they did not remove it),
  // and a change that leaves task_id out (the Telegram app) keeps the link too.
  if(!task&&old?.task_id){const linked=get('SELECT * FROM tm_tasks WHERE id=?',old.task_id);if(linked&&(d.task_id===undefined||!scope.canSee(actor,linked)))task=linked;}
  if(task&&task.id!==old?.task_id&&!scope.canSee(actor,task))hidden();
  if(task&&task.workspace_id!==w.id)fail('Choose a task from the same workspace.');
  if(a&&get('SELECT id FROM tm_meetings WHERE activity_id=? AND id<>?',a.id,key))fail('This CRM meeting is already linked.');
  if(d.attendee_ids&&!Array.isArray(d.attendee_ids))fail('Select meeting attendees.');
  // A meeting linked to a CRM activity changes that activity too, so it needs CRM Activities "Update" (also checked
  // when the request arrives; this keeps it true for every way in).
  if((old?.activity_id||d.activity_id)&&!hooks.canStaff(actor,'crm.activities','update'))fail('This meeting is linked to a CRM activity: changing it needs CRM Activities “Update”.',403);
  // People already invited are not added to the workspace again, unless the meeting is being scheduled again.
  const status0=choice(d.status||'SCHEDULED',['SCHEDULED','COMPLETED','CANCELLED'],'meeting status');
  const known=old&&!(status0==='SCHEDULED'&&old.status!=='SCHEDULED')?all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',old.id).map(r=>r.staff_id):[];
  const organizer=lookup(old?(d.organizer_id??old.organizer_id):(d.organizer_id||actor),'staff'),attendees=people([...new Set([...(d.attendee_ids||(old?all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',old.id).map(r=>r.staff_id):[])),organizer])],w.id,actor,known);
  const start=instant(d.start_at,'Meeting start'),end=instant(d.end_at,'Meeting end');if(end<=start)fail('Meeting end must be after its start.');
  if(Date.parse(end)-Date.parse(start)>7*86400000)fail('Meetings cannot last longer than seven days.');
  const status=choice(d.status||'SCHEDULED',['SCHEDULED','COMPLETED','CANCELLED'],'meeting status');
  // V5.6.8: a new or moved meeting starts in the future.
  if(status==='SCHEDULED'&&(!old||old.start_at!==start||old.status!=='SCHEDULED')&&Date.parse(start)<Date.now()-5*60000)fail('Choose a start time that is still ahead.');
  if(status==='SCHEDULED')for(const staff of attendees){if(get("SELECT m.id FROM tm_meetings m JOIN tm_attendees a ON a.meeting_id=m.id WHERE a.staff_id=? AND m.status='SCHEDULED' AND m.id<>? AND m.start_at<? AND m.end_at>?",staff,key,end,start))fail(`${nameOf(staff)} already has a scheduled meeting during this time.`);}
  let url=str(d.url,'Meeting URL',2000);if(url){let u;try{u=new URL(url);}catch{fail('Enter a complete meeting URL.');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('Use an http or https meeting URL without credentials.');url=u.href;}
  // V5.5 sharing and reminders. New meetings are visible to their participants unless they are shared.
  const share=d.share_scope===undefined||d.share_scope===null?(old?.share_scope==='SELECTED'?'SELECTED':'PARTICIPANTS'):choice(d.share_scope,['PARTICIPANTS','SELECTED'],'sharing option');
  let shareIds=[];
  if(share==='SELECTED'){
   const list=d.share_ids===undefined?all('SELECT staff_id FROM tm_meeting_shares WHERE meeting_id=?',key).map(r=>r.staff_id):d.share_ids;
   if(!Array.isArray(list)||list.length>100)fail('Choose up to 100 people to share the meeting with.');
   shareIds=[...new Set(list)].filter(x=>!attendees.includes(x));for(const x of shareIds)lookup(x,'staff');
   if(!shareIds.length)fail('Choose the people to share this meeting with, or keep it visible to its participants only.');
  }
  if(hooks.organization.governed(w)){
   if(share==='COMPANY'&&isPersonalWorkspace(w))fail('A personal workspace meeting can be shared with named people, not the whole company.',403);
   if(share==='COMPANY'&&share!==old?.share_scope&&!hooks.organization.canCollaborateOutside(actor,w))fail('Company sharing requires outside-collaboration authority.',403);
   const previous=new Set(old?all('SELECT staff_id FROM tm_meeting_shares WHERE meeting_id=?',old.id).map(x=>x.staff_id):[]);
   for(const target of shareIds)hooks.organization.checkCollaborator(actor,w,target,{existing:previous.has(target)});
  }
  const offsets=d.reminder_offsets===undefined?(old?JSON.parse(old.reminder_offsets||'[]'):[]):offsetsInput(d.reminder_offsets);
  if(old&&!manager){
   const before=new Set(all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',old.id).map(r=>r.staff_id)),shareBefore=all('SELECT staff_id FROM tm_meeting_shares WHERE meeting_id=?',old.id).map(r=>r.staff_id);
   const same=(a,b)=>String(a??'')===String(b??'');
   const moved=!same(organizer,old.organizer_id)||attendees.length!==before.size||attendees.some(x=>!before.has(x))||!same(start,old.start_at)||!same(end,old.end_at)||!same(str(d.title,'Meeting title',300,true),old.title)||!same(str(d.agenda,'Agenda',8000),old.agenda)
    ||!same(str(d.location,'Location',500),old.location)||!same(url,old.url)||share!==old.share_scope||!sameValue(shareIds,share==='SELECTED'?shareBefore:[])||!same(task?.id||null,old.task_id||null)||status==='CANCELLED'||(status==='SCHEDULED'&&old.status!=='SCHEDULED');
   if(moved)fail(`Only ${nameOf(old.organizer_id)} (the organizer)${old.created_by&&old.created_by!==old.organizer_id?` or ${nameOf(old.created_by)}`:''} can change this meeting’s time, people or details, or cancel it. You can complete it with notes or change its reminders.`,403);
  }
  const timing=!old||old.start_at!==start||old.reminder_offsets!==JSON.stringify(offsets)||old.status!==status;
  if(status==='SCHEDULED'&&timing){const late=pastOffsets(start,offsets);if(late.length)fail(`The reminder ${late.map(offsetText).join(' and ')} would already be in the past. Choose a shorter reminder, or none.`,422);}
  const values={workspace_id:w.id,task_id:task?.id||null,activity_id:a?.id||null,contact_id:task?.contact_id||a?.contact_id||null,title:str(d.title,'Meeting title',300,true),agenda:str(d.agenda,'Agenda',8000),organizer_id:organizer,start_at:start,end_at:end,location:str(d.location,'Location',500),url,status,
   minutes_notes:str(d.minutes_notes,'Meeting notes / decisions',8000),reason:str(d.reason,'Cancellation reason',1000,status==='CANCELLED'),share_scope:share,reminder_offsets:JSON.stringify(offsets),version:old?old.version+1:0,updated_at:now()};
  if(old)update('tm_meetings',key,values);else insert('tm_meetings',{id:key,...values,creation_key:creationKey,created_by:actor,created_at:now()});
  const before=old?all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',key).map(r=>r.staff_id):[];
  run('DELETE FROM tm_attendees WHERE meeting_id=?',key);attendees.forEach(staff=>insert('tm_attendees',{meeting_id:key,staff_id:staff}));
  run('DELETE FROM tm_meeting_shares WHERE meeting_id=?',key);shareIds.forEach(staff=>insert('tm_meeting_shares',{meeting_id:key,staff_id:staff}));
  // People who asked for reminders of a shared meeting stop getting them if it is no longer shared with them.
  for(const f of all('SELECT staff_id FROM tm_meeting_followers WHERE meeting_id=?',key))if(!scope.canSeeMeeting(f.staff_id,{...values,id:key}))run('DELETE FROM tm_meeting_followers WHERE meeting_id=? AND staff_id=?',key,f.staff_id);
  if(a)update('activities',a.id,{subject:values.title,summary:values.agenda+(values.minutes_notes?'\n\nMeeting notes: '+values.minutes_notes:''),assigned_to:organizer,start_at:start,end_at:end,status:status==='SCHEDULED'?'OPEN':status,reason:values.reason,version:a.version+1,updated_at:now()});
  // Only the participants hear about a meeting: newly invited people, and everyone when it moves or is cancelled.
  const tell=(ids,kind,title,body)=>{for(const staff of new Set(ids.filter(x=>x&&x!==actor)))insert('tm_notifications',{staff_id:staff,kind,task_id:null,request_id:null,due_request_id:null,meeting_id:key,title,body,actor_id:actor,created_at:now()});};
  const invited=attendees.filter(x=>!before.includes(x)),when=staff=>`${at(start,zoneOf(staff))} (${zoneLabel(zoneOf(staff))})`;
  if(status==='SCHEDULED')for(const staff of invited)tell([staff],'meeting_invited',`Meeting: ${values.title}`,`${nameOf(actor)} invited you · ${when(staff)}${values.location?' · '+values.location:''}`);
  // People who follow a shared meeting's reminders are told when it moves or is cancelled too; people taken off it are told.
  const followers=old?all('SELECT staff_id FROM tm_meeting_followers WHERE meeting_id=?',key).map(r=>r.staff_id):[];
  if(old&&status==='SCHEDULED'&&(old.start_at!==start||old.end_at!==end))for(const staff of new Set([...attendees.filter(x=>before.includes(x)),...followers]))tell([staff],'meeting_updated',`Meeting moved: ${values.title}`,`${nameOf(actor)} moved it to ${when(staff)}`);
  if(old&&old.status!=='CANCELLED'&&status==='CANCELLED')tell([...attendees,...followers],'meeting_cancelled',`Meeting cancelled: ${values.title}`,`${nameOf(actor)}: ${values.reason}`);
  if(old&&old.status==='SCHEDULED')for(const staff of before.filter(x=>!attendees.includes(x)&&x!==actor))insert('tm_notifications',{staff_id:staff,kind:'meeting_updated',task_id:null,request_id:null,due_request_id:null,meeting_id:null,title:`Removed from a meeting: ${values.title}`,body:`${nameOf(actor)} took you off this meeting (${at(start,zoneOf(staff))}).`,actor_id:actor,created_at:now()});
  log(actor,'meeting',key,w.id,old?'Meeting updated':'Meeting scheduled',`${values.title} · ${status}${share!=='PARTICIPANTS'?' · shared with '+{WORKSPACE:'the workspace',COMPANY:'the company',SELECTED:shareIds.length+' people'}[share]:''}`,values.contact_id);
  return {id:key,type:'tm_meeting'};
 }
 // Someone a meeting is shared with can ask for its reminders (participants always get them).
 function followMeeting(d,actor){
  const m=find('tm_meetings',d.id);if(!scope.canSeeMeeting(actor,m))hidden();
  const on=d.follow===true||d.follow===1;
  if(isParticipant(m,actor))return {id:m.id,type:'tm_meeting',message:'You get this meeting’s reminders as a participant.',unchanged:true};
  const was=!!get('SELECT 1 AS ok FROM tm_meeting_followers WHERE meeting_id=? AND staff_id=?',m.id,actor);
  if(was===on)return {id:m.id,type:'tm_meeting',message:on?'You already get its reminders.':'You don’t get its reminders.',unchanged:true};
  if(on)insert('tm_meeting_followers',{meeting_id:m.id,staff_id:actor,created_at:now()});else run('DELETE FROM tm_meeting_followers WHERE meeting_id=? AND staff_id=?',m.id,actor);
  return {id:m.id,type:'tm_meeting',message:on?'You will get this meeting’s reminders.':'You will no longer get this meeting’s reminders.'};
 }
 // Personal calendar notes and reminders: visible to and changed by their owner only (anyone else is told “not found”).
 function calendarNote(action,d,actor){
  const old=d.id?get('SELECT * FROM tm_calendar_notes WHERE id=?',String(d.id)):null;
  if(d.id&&(!old||old.staff_id!==actor))hidden();
  if(action==='tm.calnote.delete'){
   if(!old)hidden();
   version(old,d.expected_version);
   run('DELETE FROM tm_calendar_notes WHERE id=?',old.id);run("DELETE FROM tm_event_reminders WHERE kind='NOTE' AND ref_id=?",old.id);
   return {id:old.id,type:'tm_calnote',message:'Note deleted.'};
  }
  if(old)version(old,d.expected_version);
  const allDay=d.all_day===undefined?(old?!!old.all_day:true):(d.all_day===true||d.all_day===1);
  let day,start=null,end=null;
  if(allDay)day=date(d.day,'Date');
  else{
   start=instant(d.start_at,'Start');end=d.end_at?instant(d.end_at,'End'):null;
   if(end&&end<start)fail('The end must be after the start.');
   day=new Intl.DateTimeFormat('en-CA',{timeZone:zoneOf(actor),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(start));
  }
  const offsets=d.reminder_offsets===undefined?(old?JSON.parse(old.reminder_offsets||'[]'):[]):offsetsInput(d.reminder_offsets);
  const done=d.done===true||d.done===1?1:0;
  const moment=allDay?noteMoment(day,actor):start;
  const timing=!old||old.day!==day||old.start_at!==start||old.reminder_offsets!==JSON.stringify(offsets)||old.all_day!==(allDay?1:0);
  if(!done&&timing){const late=pastOffsets(moment,offsets);if(late.length)fail(`The reminder ${late.map(offsetText).join(' and ')} would already be in the past. Choose a shorter reminder, or none.`,422);}
  const key=old?.id||id('tm-calnote','NOTE'),values={title:str(d.title,'Title',200,true),body:str(d.body,'Note',4000),all_day:allDay?1:0,day,start_at:start,end_at:end,reminder_offsets:JSON.stringify(offsets),done,version:old?old.version+1:0,updated_at:now()};
  if(old)update('tm_calendar_notes',key,values);else insert('tm_calendar_notes',{id:key,staff_id:actor,...values,created_at:now()});
  return {id:key,type:'tm_calnote',message:old?'Note saved.':'Note added to your calendar.'};
 }
 // An all-day note's reminders count back from 09:00 on its day, in its owner's time zone.
 function noteMoment(day,staff){
  const zone=zoneOf(staff),guess=Date.parse(`${day}T09:00:00Z`);
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(guess));
  const v=k=>Number(parts.find(p=>p.type===k).value),shown=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'));
  return new Date(guess-(shown-guess)).toISOString();
 }
 // Called every minute: meeting and note reminders that are due. Each one is recorded before it is sent (kind, meeting
 // or note, person, offset and start time), so a retry or restart never sends it twice; a meeting that moves is
 // reminded again for its new time, and a cancelled meeting (or someone who lost access to it) gets nothing.
 // A reminder whose moment passed while the Task Controlling Management was off is still sent, once, until the meeting starts.
 function eventReminders(nowDate=new Date()){
  const nowMs=nowDate.getTime(),stamp=nowDate.toISOString(),horizon=new Date(nowMs+MAX_OFFSET*60000).toISOString();
  let sent=0;
  const remind=(kind,ref,staff,offset,startAt,notify)=>{
   if(run('INSERT OR IGNORE INTO tm_event_reminders(kind,ref_id,staff_id,offset_min,start_at,notification_id,created_at) VALUES(?,?,?,?,?,NULL,?)',kind,ref,staff,offset,startAt,stamp).changes!==1)return;
   insert('tm_notifications',{staff_id:staff,kind:kind==='MEETING'?'meeting_reminder':'note_reminder',task_id:null,request_id:null,due_request_id:null,meeting_id:kind==='MEETING'?ref:null,note_id:kind==='NOTE'?ref:null,...notify,actor_id:null,created_at:stamp});
   run('UPDATE tm_event_reminders SET notification_id=last_insert_rowid() WHERE kind=? AND ref_id=? AND staff_id=? AND offset_min=? AND start_at=?',kind,ref,staff,offset,startAt);sent++;
  };
  for(const m of all("SELECT m.* FROM tm_meetings m JOIN tm_workspaces w ON w.id=m.workspace_id WHERE m.status='SCHEDULED' AND w.status='ACTIVE' AND m.reminder_offsets<>'[]' AND m.start_at>? AND m.start_at<=?",new Date(nowMs-300000).toISOString(),horizon)){
   const offsets=JSON.parse(m.reminder_offsets||'[]'),startMs=Date.parse(m.start_at);
   const due=offsets.filter(n=>startMs-n*60000<=nowMs);if(!due.length)continue;
   // The latest reminder that is due; an earlier one missed while the Task Controlling Management was off is not sent late as well.
   const n=Math.min(...due);
   const people=[m.organizer_id,...all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',m.id).map(r=>r.staff_id),...all('SELECT staff_id FROM tm_meeting_followers WHERE meeting_id=?',m.id).map(r=>r.staff_id)];
   for(const staff of new Set(people)){
    if(!calendarReachable(staff)||!scope.canSeeMeeting(staff,m))continue;
    const zone=zoneOf(staff);
    remind('MEETING',m.id,staff,n,m.start_at,{title:`${n===0?'Starting now':'Reminder'}: ${m.title}`,body:`${at(m.start_at,zone)} (${zoneLabel(zone)})${m.location?' · '+m.location:''}${m.url?' · online':''}`});
   }
  }
  for(const x of all("SELECT * FROM tm_calendar_notes WHERE done=0 AND reminder_offsets<>'[]' AND day>=?",new Date(nowMs-2*86400000).toISOString().slice(0,10))){
   const startAt=x.all_day?noteMoment(x.day,x.staff_id):x.start_at,startMs=Date.parse(startAt);
   if(startMs<=nowMs-300000||!calendarReachable(x.staff_id))continue;
   const due=JSON.parse(x.reminder_offsets||'[]').filter(n=>startMs-n*60000<=nowMs);if(!due.length)continue;
   const n=Math.min(...due),zone=zoneOf(x.staff_id);
   remind('NOTE',x.id,x.staff_id,n,startAt,{title:`Reminder: ${x.title}`,body:x.all_day?`${human(x.day)}${x.body?' · '+clip(x.body,200):''}`:`${at(startAt,zone)} (${zoneLabel(zone)})${x.body?' · '+clip(x.body,200):''}`});
  }
  return sent;
 }

 // ---------------------------------------------------------------- V5.5 reporting lines
 // Who reports to whom, kept by administrators (Administration · User accounts “Update”). Nobody reports to themselves,
 // a line never loops back (A → B → A) and both people belong to this company (each company has its own staff list).
 // Reporting lines only decide which tasks a manager can see; they never let anyone change someone else's task.
 function setManager(staffInput,managerInput,actor){
  const key=lookup(staffInput,'staff');
  const manager=managerInput===null||managerInput===undefined||managerInput===''?null:lookup(managerInput,'staff');
  const current=get('SELECT manager_id FROM tm_profiles WHERE staff_id=?',key)?.manager_id||null;
  if(current===manager)return false;
  if(!hooks.canStaff(actor,'admin.users','update'))fail('Changing reporting lines needs Administration · User accounts “Update”.',403);
  if(manager===key)fail(`${nameOf(key)} can’t report to themselves. Choose someone else as their manager.`,422);
  if(manager){
   if(get('SELECT active FROM tm_profiles WHERE staff_id=?',manager)?.active===0)fail('Choose an active team member as the manager.');
   if(scope.managersOf(manager).includes(key))fail(`${nameOf(manager)} already reports to ${nameOf(key)} (directly or through others), so ${nameOf(key)} can’t report to ${nameOf(manager)}.`,422);
  }
  run('INSERT INTO tm_profiles(staff_id,manager_id) VALUES(?,?) ON CONFLICT(staff_id) DO UPDATE SET manager_id=excluded.manager_id,version=version+1',key,manager);
  log(actor,'user',key,null,'Reporting line changed',`${nameOf(key)} reports to ${manager?nameOf(manager):'nobody'}${current?` (was ${nameOf(current)})`:''}`);
  return true;
 }
 // The task an action works on (directly, or through a checklist step, file, request or time entry), for the scope check.
 function taskFor(action,d){
  const via=(table,key)=>key==null?null:get(`SELECT task_id FROM ${table} WHERE id=?`,String(key))?.task_id||null;
  if(action==='tm.task.save')return d.id||null;
  if(action.startsWith('tm.task.'))return d.id||null;
  if(action==='tm.check.add'||action==='tm.file.add'||action==='tm.due.request')return d.task_id||null;
  if(action.startsWith('tm.check.'))return via('tm_checklist',d.id);
  if(action==='tm.file.remove')return via('tm_files',d.id);
  if(action.startsWith('tm.due.'))return via('tm_due_requests',d.id);
  if(action.startsWith('tm.change.'))return via('tm_change_requests',d.id);
  if(action==='tm.time.save')return d.id?via('tm_timesheets',d.id):d.task_id||null;
  if(action==='tm.time.delete')return via('tm_timesheets',d.id);
  if(action==='tm.meeting.save')return d.task_id||null;
  return null;
 }
 function handle(action,d,actor,meta={}){
  const source=SOURCES.includes(meta.source)?meta.source:'WEB';
  // The commands read IDs trimmed (str()), so they are trimmed here first: the scope check below must look up exactly
  // the record the command will then act on (" TASK-000007" is the same task as "TASK-000007").
  if(d&&typeof d==='object'&&!Array.isArray(d))for(const k of ['id','task_id'])if(typeof d[k]==='string'&&d[k]!==d[k].trim())d={...d,[k]:d[k].trim()};
  // V5.5: everything about a task needs the task to be within this person's Task Visibility Scope; otherwise it is
  // answered as if it did not exist (the same for a guessed ID in the Task Controlling Management, the bot or the Mini App).
  const tid=taskFor(action,d);
  if(tid!=null){const t=get('SELECT * FROM tm_tasks WHERE id=?',String(tid));if(t&&!scope.canSee(actor,t))hidden();}
  if(action==='tm.profile.manager'){
   if(!hooks.canStaff(actor,'admin.users','update'))fail('Changing reporting lines needs Administration · User accounts “Update”.',403);
   const changed=setManager(d.staff_id,d.manager_id,actor);
   return {id:d.staff_id,type:'tm_user',message:changed?'Reporting line saved.':'Reporting line unchanged.',...(changed?{}:{unchanged:true})};
  }
  if(action.startsWith('me.'))return me(action,d,actor);
  if(action==='tm.profile.photo'){
   const staff=lookup(d.staff_id,'staff');
   if(d.remove===true){const n=removePhoto(staff,actor);if(n)log(actor,'user',staff,null,'Profile photo removed',nameOf(staff));return {id:staff,type:'tm_user',message:n?'Photo removed.':'There was no photo.'};}
   setPhoto(staff,d.base64,actor);log(actor,'user',staff,null,'Profile photo changed',nameOf(staff));return {id:staff,type:'tm_user',message:'Photo saved.'};
  }
  if(action==='tm.profile.save'){
   const old=d.staff_id?get('SELECT * FROM tm_profiles WHERE staff_id=?',d.staff_id):null;
   if(old)version(old,d.expected_version);
   const key=d.staff_id?lookup(d.staff_id,'staff'):id('staff','STAFF');
   const canonical=d.staff_id?get('SELECT username FROM access_users WHERE staff_id=?',key)?.username:null;
   if(canonical&&d.name!==undefined&&d.name!==canonical)fail('Change usernames in Administration → User accounts.',403);
   const name=canonical||str(d.name,'Full name',200,true),email=str(d.email,'Email',200).toLowerCase();
   if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email address.');
   if(get("SELECT id FROM lookups WHERE kind='staff' AND name=? AND id<>?",name,key))fail('Another team member already uses this name. Add a detail, such as the department, to tell them apart.',409);
   const active=d.active===false||d.active===0?0:1;
   if(!active&&(get("SELECT t.id FROM tm_tasks t JOIN tm_assignees a ON a.task_id=t.id WHERE a.staff_id=? AND a.status<>'DECLINED' AND t.status NOT IN('COMPLETED','CANCELLED')",key)||get("SELECT m.id FROM tm_meetings m JOIN tm_attendees a ON a.meeting_id=m.id WHERE a.staff_id=? AND m.status='SCHEDULED'",key)||get("SELECT id FROM tm_requests WHERE manager_id=? AND status='PENDING'",key)))fail('Reassign open tasks, scheduled meetings and task requests waiting for this team member before making them inactive.');
   const values={email,phone:str(d.phone,'Phone',50),position:str(d.position,'Position',150),department:str(d.department,'Department',150),active,version:old?old.version+1:0,
    timezone:d.timezone===undefined?(old?.timezone||''):zoneInput(d.timezone)};
   const previousName=d.staff_id?canonicalName(key):'';
   if(!d.staff_id)insert('lookups',{id:key,kind:'staff',name,unit:'',active:1});else update('lookups',key,{name});
   run('INSERT INTO tm_profiles(staff_id,email,phone,position,department,active,version,timezone) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(staff_id) DO UPDATE SET email=excluded.email,phone=excluded.phone,position=excluded.position,department=excluded.department,active=excluded.active,version=excluded.version,timezone=excluded.timezone',key,...Object.values(values));
   // V5.6.8: changes to someone's name, team email or active state are kept in the access audit.
   const identity=[old&&previousName!==name&&`name ${previousName} → ${name}`,old&&(old.email||'')!==email&&`team email ${old.email||'—'} → ${email||'—'}`,old&&(old.active??1)!==active&&(active?'made active':'made inactive'),!d.staff_id&&`team member ${name} added`].filter(Boolean);
   if(identity.length)insert('access_audit',{actor_id:actor,action:'Team profile changed',target_id:accountOf(key)?.id||key,detail:`${name} · ${identity.join(' · ')}`,created_at:now()});
   // V5.5: the reporting line can be saved with the profile (access.mjs requires Administration · User accounts “Update”).
   if(d.manager_id!==undefined)setManager(key,d.manager_id,actor);
   log(actor,'user',key,null,'Team profile saved',name);return {id:key,type:'tm_user'};
  }
  if(action==='tm.workspace.delete'||action==='tm.workspace.restore')return hooks.organization.removeWorkspace(d,actor,action.endsWith('.restore'));
  if(action==='tm.workspace.member.remove')return hooks.organization.removeMember(d,actor);
  if(action==='tm.workspace.member.add')return hooks.organization.membershipRequest(d,actor);
  if(action==='tm.workspace.save'&&hooks.organization&&(d.id?hooks.organization.governed(workspace(d.id)):hooks.organization.settings().enabled||['PERSONAL','PUBLIC','ORGANIZATIONAL'].includes(d.kind)))return hooks.organization.saveWorkspace(d,actor);
  if(action==='tm.workspace.save'){
   const old=d.id?workspace(d.id):null;if(old)version(old,d.expected_version);
   if(d.member_ids&&!Array.isArray(d.member_ids))fail('Select workspace members.');
   const owner=lookup(d.owner_id,'staff'),members=people([...new Set([...(d.member_ids||[]),owner])]);
   // V5.4: membership opens the workspace's Groups. Its members can edit the workspace's details; only its owner and
   // workspace managers (Workspace Delete) change its owner or members.
   if(old){
    if(!hooks.organization.canViewWorkspace(actor,old))hidden();
    const manager=old.owner_id===actor||!!hooks.canStaff(actor,'tasks.workspace','delete');
    if(!manager&&!isMember(old.id,actor))fail('Only members of this workspace, its owner and workspace managers can change it.',403);
    if(!manager){
     const current=new Set([old.owner_id,...all('SELECT staff_id FROM tm_members WHERE workspace_id=?',old.id).map(m=>m.staff_id)]),next=new Set(members);
     if(owner!==old.owner_id||next.size!==current.size||[...next].some(x=>!current.has(x)))fail('Only the workspace’s owner or a workspace manager can change its owner or members.',403);
    }
   }
   const key=old?.id||id('tm-workspace','WS');
   if(old){for(const member of all('SELECT staff_id FROM tm_members WHERE workspace_id=?',key).filter(m=>!members.includes(m.staff_id))){
    if(get("SELECT t.id FROM tm_tasks t JOIN tm_assignees a ON a.task_id=t.id WHERE t.workspace_id=? AND a.staff_id=? AND a.status<>'DECLINED' AND t.status NOT IN('COMPLETED','CANCELLED')",key,member.staff_id)||get("SELECT m.id FROM tm_meetings m JOIN tm_attendees a ON a.meeting_id=m.id WHERE m.workspace_id=? AND a.staff_id=? AND m.status='SCHEDULED'",key,member.staff_id))fail('Reassign open work before removing this workspace member.');
   }}
   const status=old?.status||'ACTIVE',values={name:str(d.name,'Workspace name',200,true),description:str(d.description,'Description',5000),department:str(d.department,'Department',150),owner_id:owner,color:choice(d.color||'BLUE',Object.keys(TASK_COLORS),'workspace color'),status,version:old?old.version+1:0,updated_at:now()};
   if(get('SELECT id FROM tm_workspaces WHERE name=? COLLATE NOCASE AND id<>?',values.name,key))fail('A workspace with this name already exists. Choose a different name.',409);
   if(old)update('tm_workspaces',key,values);else insert('tm_workspaces',{id:key,...values,created_by:actor,created_at:now()});
   run('DELETE FROM tm_members WHERE workspace_id=?',key);members.forEach(staff=>insert('tm_members',{workspace_id:key,staff_id:staff}));
   log(actor,'workspace',key,key,old?'Workspace updated':'Workspace created',values.name);return {id:key,type:'tm_workspace'};
  }
  if(action==='tm.workspace.archive'){
   // Archiving needs Workspace “Delete” (checked when the request arrives) and, for governed workspaces, management authority.
   const w=workspace(d.id),governed=hooks.organization.governed(w);if(!hooks.organization.canViewWorkspace(actor,w))hidden();
   if(governed&&!hooks.organization.canManageWorkspace(actor,w))fail('Workspace management authority is required.',403);
   version(w,d.expected_version);const status=choice(d.status,['ACTIVE','ARCHIVED'],'workspace status');
   if(status==='ARCHIVED'&&(get("SELECT id FROM tm_tasks WHERE workspace_id=? AND status NOT IN('COMPLETED','CANCELLED')",w.id)||get("SELECT id FROM tm_meetings WHERE workspace_id=? AND status='SCHEDULED'",w.id)))fail('Complete or cancel open tasks and meetings before archiving this workspace.');
   update('tm_workspaces',w.id,{status,version:w.version+1,updated_at:now()});log(actor,'workspace',w.id,w.id,`Workspace ${status.toLowerCase()}`);return {id:w.id,type:'tm_workspace'};
  }
  if(action==='tm.task.save')return saveTask(d,actor,source);
  if(action==='tm.task.handover')return handover(d,actor,source);
  if(action==='tm.task.remind')return remind(d,actor,source);
  if(action==='tm.task.reminders')return setReminders(d,actor,source);
  const verb=/^tm\.task\.(accept|decline|progress|stuck|resume|submit|pass|return|close|cancel|reopen|note)$/.exec(action)?.[1];
  if(verb)return flow(verb,d,actor,source);
  if(action==='tm.change.decide'||action==='tm.change.withdraw')return changeAction(action,d,actor,source);
  if(action.startsWith('tm.group.'))return groups.handle(action,d,actor,source);
  if(action.startsWith('tm.check.'))return checklist(action,d,actor,source);
  if(action.startsWith('tm.file.'))return files(action,d,actor,source);
  if(action.startsWith('tm.request.'))return request(action,d,actor,source);
  if(action.startsWith('tm.due.'))return dueRequest(action,d,actor,source);
  if(action==='tm.notification.read'){
   // “Telegram connected” notices can only be dismissed in the Task Controlling Management, so a new Telegram connection cannot hide its own notice.
   const telegram=source!=='WEB';
   if(d.all===true){const n=run(`UPDATE tm_notifications SET read_at=? WHERE staff_id=? AND read_at IS NULL${telegram?" AND kind<>'telegram_connected'":''}`,now(),actor).changes;return {message:n?`${n} notification${n===1?'':'s'} marked as read.`:'No unread notifications.'};}
   const n=get('SELECT * FROM tm_notifications WHERE id=?',integer(d.id,1,Number.MAX_SAFE_INTEGER,'notification'));
   if(!n||n.staff_id!==actor)fail('Notification not found.',404);
   if(telegram&&n.kind==='telegram_connected')return {message:'Open the Task Controlling Management to review this notice.',unchanged:true};
   if(!n.read_at)run('UPDATE tm_notifications SET read_at=? WHERE id=?',now(),n.id);
   return {message:'Marked as read.'};
  }
  if(action==='tm.time.save'){
   const old=d.id?find('tm_timesheets',d.id):null,taskId=old?old.task_id:d.task_id,task=taskId?find('tm_tasks',taskId):null,staff=lookup(old?.staff_id||d.staff_id||actor,'staff');
   const wid=task?.workspace_id||(old?old.workspace_id:d.workspace_id)||null;
   if(!task&&wid&&!hooks.organization.canViewWorkspace(actor,workspace(wid)))hidden();
   if(!task&&staff!==actor)fail('Only the owner can change an independent time entry.',403);
   // V5.5: seeing a task through a reporting line or company-wide access is viewing only, also for its time entries:
   // people on the task (and anyone for their own time) record and correct time, as before.
   if(staff!==actor&&!scope.isInvolved(actor,task))fail('You can view this task but not change it, so you can’t record or change other people’s time on it. Ask someone on the task.',403);
   if(old)version(old,d.expected_version);
   if(wid)activeWorkspace(wid);profile(staff);
   if(task&&!get("SELECT * FROM tm_assignees WHERE task_id=? AND staff_id=? AND status<>'DECLINED'",task.id,staff))fail('Log time for someone assigned to this task (the person in charge or a supporting person).');
   if(task?.status==='CANCELLED')fail('Time cannot be added or revised on a cancelled task.');
   const day=date(d.work_date,'Work date');if(day>today())fail('Time entries cannot be in the future.');
   const minutes=duration(d.duration,1440);if(!minutes)fail('Time must be at least one minute.');
   if(task&&get('SELECT id FROM tm_timesheets WHERE task_id=? AND staff_id=? AND work_date=? AND id<>?',task.id,staff,day,old?.id||''))fail('This person already has time recorded for this task on that date. Open that entry to change it.',409);
   const dayTotal=get('SELECT COALESCE(SUM(minutes),0) AS n FROM tm_timesheets WHERE staff_id=? AND work_date=? AND id<>?',staff,day,old?.id||'').n;
   if(dayTotal+minutes>1440)fail('Total logged time for one person cannot exceed 24 hours in a day.');
   const key=old?.id||id('tm-time','TIME'),values={task_id:task?.id||null,workspace_id:wid,activity:task?'':str(d.activity??old?.activity,'Activity',300,true),staff_id:staff,work_date:day,minutes,notes:str(d.notes,'Time entry notes',2000),version:old?old.version+1:0,updated_at:now()};
   if(old)update('tm_timesheets',key,values);else insert('tm_timesheets',{id:key,...values,created_at:now()});
   log(actor,'timesheet',key,wid,old?'Time entry updated':'Time logged',`${task?.id||values.activity} · ${staff} · ${day} · ${minutes} minutes`,task?.contact_id);return {id:key,type:'tm_time'};
  }
  if(action==='tm.time.delete'){
   const row=find('tm_timesheets',d.id),task=row.task_id?find('tm_tasks',row.task_id):null;
   if(row.staff_id!==actor&&!scope.isInvolved(actor,task))fail('You can view this task but not change it, so you can’t remove other people’s time on it. Ask someone on the task.',403);
   version(row,d.expected_version);if(task?.workspace_id||row.workspace_id)activeWorkspace(task?.workspace_id||row.workspace_id);
   const reason=str(d.reason,'Deletion reason',1000,true);run('DELETE FROM tm_timesheets WHERE id=?',row.id);
   log(actor,'timesheet',row.id,task?.workspace_id||row.workspace_id,'Time entry deleted',`${row.task_id} · ${row.staff_id} · ${row.work_date} · ${row.minutes} minutes · ${reason}`,task?.contact_id);return {message:'Time entry removed; deletion retained in history.'};
  }
  if(action==='tm.meeting.save')return meetingWorkflow.request(d,actor,source);
  if(action==='tm.meeting.decide'||action==='tm.meeting.withdraw')return meetingWorkflow.decide(action,d,actor,source);
  if(action==='tm.meeting.follow')return followMeeting(d,actor);
  if(action==='tm.calnote.save'||action==='tm.calnote.delete')return calendarNote(action,d,actor);
  fail('Unknown Task Management action.',404);
 }
 function state(){
  const out={};for(const t of ['tm_workspaces','tm_members','tm_tasks','tm_timesheets','tm_meetings','tm_attendees','tm_events','tm_requests','tm_due_requests','tm_change_requests','tm_meeting_changes','tm_meeting_shares','tm_meeting_followers'])out[t]=all(`SELECT * FROM ${t}`);
  out.tm_assignees=all('SELECT task_id,staff_id,status,invited_by,responded_at,response_note FROM tm_assignees ORDER BY task_id,rowid');
  out.tm_task_history=all('SELECT * FROM tm_task_history ORDER BY id');
  out.tm_checklist=all('SELECT id,task_id,position,title,done,done_by,done_at,created_by,created_at FROM tm_checklist ORDER BY task_id,position');
  out.tm_files=all('SELECT id,task_id,name,mime,size,uploaded_by,source,created_at FROM tm_files ORDER BY task_id,created_at,id');
  out.staff_photos=all('SELECT staff_id,version FROM staff_photos WHERE size>0');
  out.tm_profiles=all("SELECT l.id AS staff_id,l.name,COALESCE(p.email,'') AS email,COALESCE(p.phone,'') AS phone,COALESCE(p.position,'') AS position,COALESCE(p.department,'') AS department,COALESCE(p.active,1) AS active,COALESCE(p.version,0) AS version,p.manager_id,COALESCE(p.timezone,'') AS timezone,p.org_level,COALESCE(p.nickname,'') AS nickname FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.kind='staff'");
  return {...out,...groups.state()};
 }
 const sidebarThemeOf=staff=>(staff&&get('SELECT sidebar_theme FROM tm_profiles WHERE staff_id=?',staff)?.sidebar_theme)||'';
 return {handle,state,find,supportersOf,rolesFor,reminders:dueReminders,eventReminders,assignable,groups,scope,zoneOf,sidebarThemeOf};
}

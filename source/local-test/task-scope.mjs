// V5.5 Task Visibility Scope: one rule for who may see which task (and which meeting), used by the Task Controlling Management screens, the
// Telegram bot, the Mini App, reports, the dashboard, the calendar, exports and every task command.
//
//  - Everyone sees the tasks they are directly involved in (person in charge, supporting person, reviewer, assigner,
//    creator, or the person a decision is currently waiting for).
//  - A manager also sees the tasks whose person in charge reports to them, directly or indirectly (reporting lines are
//    tm_profiles.manager_id). Supporting someone, or having looked at a task, never widens this.
//  - A role with "Task Management · All company tasks" (tasks.company, View) sees every task of the company.
//  - Seeing a task never subscribes anyone to its notifications and never grants editing, approval or closing rights:
//    those follow the existing task rules (task-domain.mjs).
//
// Meetings: their participants (organizer, attendees and whoever scheduled it), plus the people they are shared with (share_scope
// SELECTED = tm_meeting_shares). Pending change approvers have temporary view access. Personal calendar notes are visible to their owner only and are not handled here.

import {createHash,randomUUID} from 'node:crypto';

export const SCOPE_REASONS={involved:'You are on this task',team:'Someone in your reporting line is in charge',company:'Company-wide task access',organization:'Organization administrator',membership:'Workspace member',owner:'Workspace owner',governance:'Workspace governance'};

/** Everyone below `staff` in the reporting tree (direct and indirect reports), given manager links as [staff, manager]. */
export function reportsUnder(staff,links){
 const children=new Map();
 for(const [s,m] of links)if(m&&s!==m){if(!children.has(m))children.set(m,[]);children.get(m).push(s);}
 const out=new Set(),queue=[...(children.get(staff)||[])];
 while(queue.length){const s=queue.shift();if(s===staff||out.has(s))continue;out.add(s);for(const c of children.get(s)||[])queue.push(c);}
 return out;
}

/** The managers above `staff` (nearest first), stopping at a loop. */
export function managersOf(staff,links){
 const up=new Map(links.filter(([s,m])=>m&&s!==m)),out=[];let at=up.get(staff);
 while(at&&!out.includes(at)&&at!==staff){out.push(at);at=up.get(at);}
 return out;
}

/** Why a task is visible to `staff` (or null), from plain rows: involvement first, then hierarchy, then company scope. */
export function taskReason(t,staff,{involved,team,company}){
 if(involved.has(t.id))return 'involved';
 if(t.pic_id&&team.has(t.pic_id))return 'team';
 if(company)return 'company';
 return null;
}

export function createTaskScope({get,all,can,governance=()=>null}){
 // A company/store-specific salt keeps identical local staff IDs in separate companies from sharing a cache key.
 const scopeInstance=randomUUID();
 const links=()=>all('SELECT staff_id,manager_id FROM tm_profiles WHERE manager_id IS NOT NULL').map(r=>[r.staff_id,r.manager_id]);
 const companyWide=staff=>!!staff&&(can(staff,'tasks.company','view')||!!governance()?.globalWorkspaces(staff));
 const team=staff=>reportsUnder(staff,links());
 // Directly involved: the people on the task and anyone a pending decision about it is waiting for.
 const involvedIds=staff=>new Set(all(`SELECT id FROM tm_tasks WHERE pic_id=?1 OR created_by=?1 OR assigned_by=?1 OR reviewer_id=?1 OR submitted_to=?1
   UNION SELECT task_id FROM tm_assignees WHERE staff_id=?1
   UNION SELECT task_id FROM tm_change_requests WHERE approver_id=?1 AND status='PENDING'
   UNION SELECT task_id FROM tm_due_requests WHERE decide_by=?1 AND status='PENDING'`,staff).map(r=>r.id));
 const isInvolved=(staff,t)=>!!staff&&!!t&&([t.pic_id,t.created_by,t.assigned_by,t.reviewer_id,t.submitted_to].includes(staff)
  ||!!get('SELECT 1 AS ok FROM tm_assignees WHERE task_id=? AND staff_id=?',t.id,staff)
  ||!!get("SELECT 1 AS ok FROM tm_change_requests WHERE task_id=? AND approver_id=? AND status='PENDING'",t.id,staff)
  ||!!get("SELECT 1 AS ok FROM tm_due_requests WHERE task_id=? AND decide_by=? AND status='PENDING'",t.id,staff));
 /** Why `staff` may see task `t` ('involved' | 'team' | 'company') or null. */
 function reason(staff,t){
  if(!staff||!t)return null;
  const direct=isInvolved(staff,t),org=governance()?.taskReason(staff,t,direct);if(org!==undefined)return org;
  if(direct)return 'involved';
  if(t.pic_id&&team(staff).has(t.pic_id))return 'team';
  return companyWide(staff)?'company':null;
 }
 const canSee=(staff,t)=>!!reason(staff,t);
 /** A task request: its requester and the person it was sent to; once accepted, whoever may see the task it became. */
 const canSeeRequest=(staff,q)=>!!staff&&!!q&&!governance()?.workspaceRemoved(q.workspace_id)&&(q.requested_by===staff||q.manager_id===staff||(!!q.task_id&&canSee(staff,get('SELECT * FROM tm_tasks WHERE id=?',q.task_id))));
 /** Everything needed to filter a whole state for one person in memory. */
 function context(staff){return {staff,company:companyWide(staff),team:team(staff),involved:involvedIds(staff)};}

 // Employee filters describe the records already authorized by filterState and module permissions. They never
 // establish access, and must not restrict assignment pickers or the separately permissioned staff directory.
 function employeeFilters(s,staff){
  const sorted=values=>[...new Set(values.filter(Boolean))].sort();
  const taskIds=new Set((s.tm_tasks||[]).map(t=>t.id)),meetingIds=new Set((s.tm_meetings||[]).map(m=>m.id));
  const tasks=sorted([...(s.tm_tasks||[]).map(t=>t.pic_id),...(s.tm_assignees||[]).filter(a=>taskIds.has(a.task_id)&&a.status!=='DECLINED').map(a=>a.staff_id)]);
  const time=sorted((s.tm_timesheets||[]).map(e=>e.staff_id));
  const meetings=sorted((s.tm_attendees||[]).filter(a=>meetingIds.has(a.meeting_id)).map(a=>a.staff_id));
  const workload=s.task_scope?.company?sorted((s.tm_profiles||[]).map(p=>p.staff_id)):sorted([...tasks,...time,...(s.task_scope?.team||[]),staff]);
  return {tasks,time,meetings,workload,workspace:sorted([...tasks,...time])};
 }

 // ---------------------------------------------------------------- meetings
 const meetingParticipants=id=>all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',id).map(r=>r.staff_id);
 function canSeeMeeting(staff,m){
  if(!staff||!m)return false;
  const participant=m.organizer_id===staff||m.created_by===staff||meetingParticipants(m.id).includes(staff)||!!get("SELECT 1 FROM tm_meeting_changes WHERE meeting_id=? AND approver_id=? AND status='PENDING'",m.id,staff),scope=m.share_scope||'PARTICIPANTS';
  const shared=!!can(staff,'tasks.meetings','view')&&(scope==='SELECTED'&&!!get('SELECT 1 FROM tm_meeting_shares WHERE meeting_id=? AND staff_id=?',m.id,staff));
  const org=governance()?.meetingReason(staff,m,participant,shared);return org===undefined?participant||shared:org;
 }

 /** The task-related part of a full state, filtered for one person (`perms` = their permission map). */
 function filterState(s,staff,opts={}){const g=governance();return g?.batch?g.batch(()=>filterStateNow(s,staff,opts)):filterStateNow(s,staff,opts);}
 function filterStateNow(s,staff,{meetings=true,permissions={}}={}){
  const ctx=context(staff),out={};
  const visible=new Map();
  for(const t of s.tm_tasks||[]){const org=governance()?.taskReason(staff,t,ctx.involved.has(t.id)),r=org===undefined?taskReason(t,staff,ctx):org;if(r)visible.set(t.id,r);}
  out.tm_tasks=(s.tm_tasks||[]).filter(t=>visible.has(t.id)).map(t=>({...t,access_reason:visible.get(t.id),calendar_visible:[t.pic_id,t.created_by,t.assigned_by,t.reviewer_id].includes(staff)||(s.tm_assignees||[]).some(a=>a.task_id===t.id&&a.staff_id===staff&&a.status!=='DECLINED')}));
  out.tm_calendar_tasks=out.tm_tasks.filter(t=>t.calendar_visible);
  for(const table of ['tm_assignees','tm_task_history','tm_checklist','tm_files','tm_change_requests','tm_due_requests'])if(s[table])out[table]=s[table].filter(r=>visible.has(r.task_id));
  // Time entries: on tasks this person may see, and always their own (with the name of the task they worked on, even
  // if they are no longer on it).
  if(s.tm_timesheets){
   const byId=new Map((s.tm_tasks||[]).map(t=>[t.id,t]));
   out.tm_timesheets=s.tm_timesheets.filter(e=>visible.has(e.task_id)||e.staff_id===staff&&!governance()?.personalTaskHidden(staff,byId.get(e.task_id)));
   const own=new Set(out.tm_timesheets.filter(e=>!visible.has(e.task_id)).map(e=>e.task_id));
   out.tm_task_refs=(s.tm_tasks||[]).filter(t=>own.has(t.id)).map(t=>({id:t.id,title:t.title,workspace_id:t.workspace_id,status:t.status}));
  }else out.tm_task_refs=[];
  // Meetings: participants and the people they are shared with. A linked task stays hidden unless it is visible.
  if(meetings&&s.tm_meetings){
   const attendees=new Map();for(const a of s.tm_attendees||[]){if(!attendees.has(a.meeting_id))attendees.set(a.meeting_id,new Set());attendees.get(a.meeting_id).add(a.staff_id);}
   const shares=new Set((s.tm_meeting_shares||[]).filter(x=>x.staff_id===staff).map(x=>x.meeting_id));
   const member=new Set((s.tm_members||[]).filter(m=>m.staff_id===staff).map(m=>m.workspace_id));
   const meetingsView=!!can(staff,'tasks.meetings','view');
   const pendingMeetings=new Set((s.tm_meeting_changes||[]).filter(q=>q.approver_id===staff&&q.status==='PENDING').map(q=>q.meeting_id));
   const seeMeeting=m=>{
    const participant=m.organizer_id===staff||m.created_by===staff||attendees.get(m.id)?.has(staff)||pendingMeetings.has(m.id),shared=meetingsView&&(m.share_scope==='SELECTED'&&shares.has(m.id));
    const org=governance()?.meetingReason(staff,m,participant,shared);return org===undefined?participant||shared:org;
   };
   // V5.5.1: the meeting's customer (contact_id) usually comes from that task, so it is hidden with it.
   out.tm_meetings=s.tm_meetings.filter(seeMeeting).map(m=>m.task_id&&!visible.has(m.task_id)?{...m,task_id:null,contact_id:null}:m);
   const ids=new Set(out.tm_meetings.map(m=>m.id));
   out.tm_attendees=(s.tm_attendees||[]).filter(a=>ids.has(a.meeting_id));
   out.tm_meeting_changes=(s.tm_meeting_changes||[]).filter(x=>ids.has(x.meeting_id)&&[x.requested_by,x.approver_id].includes(staff));
   if(s.tm_meeting_shares)out.tm_meeting_shares=s.tm_meeting_shares.filter(x=>ids.has(x.meeting_id));
   if(s.tm_meeting_followers)out.tm_meeting_followers=s.tm_meeting_followers.filter(x=>x.staff_id===staff&&ids.has(x.meeting_id));
  }
  // Task requests: the person who asked and the person it was sent to; once accepted, also everyone who may see the task
  // it became (a request holds the same title and details as its task).
  if(s.tm_requests)out.tm_requests=s.tm_requests.filter(q=>!governance()?.workspaceRemoved(q.workspace_id)&&(q.requested_by===staff||q.manager_id===staff||(!!q.task_id&&visible.has(q.task_id))));
  // Membership exposes workspace contents; hierarchy/individual invitations expose only their authorized records.
  out.tm_workspaces=(s.tm_workspaces||[]).filter(w=>!governance()||governance().canViewWorkspace(staff,w)).map(w=>({...w,org_access:governance()?.workspaceAccess(staff,w)}));
  const workspaceIds=new Set(out.tm_workspaces.map(w=>w.id));
  out.tm_members=(s.tm_members||[]).filter(m=>workspaceIds.has(m.workspace_id));
  const recordWorkspaces=new Set([...out.tm_tasks,...(out.tm_meetings||[]),...(out.tm_task_refs||[]),...(out.tm_requests||[])].map(t=>t.workspace_id));
  out.tm_workspace_refs=(s.tm_workspaces||[]).filter(w=>!workspaceIds.has(w.id)&&recordWorkspaces.has(w.id)).map(w=>({id:w.id,name:w.name,kind:w.kind,visibility:w.visibility,reference_only:true,org_access:{can_create:false,can_collaborate_outside:!!governance()?.canCollaborateOutside(staff,w)}}));
  // The activity log follows the same rules as the records it describes. Workspace lines written before V5.5 could name
  // the task someone was chosen for; a task this person may not see is not named.
  if(s.tm_events){
   const meetingIds=new Set((out.tm_meetings||s.tm_meetings||[]).map(m=>m.id)),entries=new Set((out.tm_timesheets||[]).map(e=>e.id));
   const requests=new Set((out.tm_requests||[]).map(q=>q.id));
   out.tm_events=s.tm_events.filter(e=>e.entity_type==='task'?visible.has(e.entity_id):e.entity_type==='meeting'?meetingIds.has(e.entity_id):e.entity_type==='timesheet'?entries.has(e.entity_id):e.entity_type==='request'&&s.tm_requests?requests.has(e.entity_id):!e.workspace_id||workspaceIds.has(e.workspace_id))
    .map(e=>e.entity_type!=='task'&&/TASK-\d+/.test(e.detail||'')?{...e,detail:e.detail.replace(/TASK-\d+/g,key=>visible.has(key)?key:'a task')}:e);
  }
  // Clients must discard previously fetched reports when authority changes, including a reporting-line move,
  // reassignment or role change. Hash IDs, not record contents: ordinary updates use the existing change sequence.
  const ids=rows=>(rows||[]).map(r=>r.id).sort();
  const permissionKey=Object.entries(permissions).sort(([a],[b])=>a.localeCompare(b)).map(([resource,actions])=>[resource,[...actions].sort()]);
  const revision=createHash('sha256').update(JSON.stringify([scopeInstance,staff,ctx.company,[...ctx.team].sort(),[...visible.keys()].sort(),ids(out.tm_timesheets),ids(out.tm_meetings),ids(out.tm_requests),permissionKey,governance()?.settings().revision])).digest('hex');
  // V5.6.8: “all company tasks” only when it really is everything: with Organizational Structure in use, company-wide task
  // access covers the earlier (legacy) workspaces; governed work follows the organization (Level 1 sees all of it).
  const gov=governance(),companyAll=ctx.company&&(!gov?.settings().enabled||gov.globalWorkspaces(staff)||!(s.tm_workspaces||[]).some(w=>w.kind&&w.kind!=='LEGACY'&&!w.deleted_at));
  out.task_scope={company:companyAll,company_legacy:ctx.company&&!companyAll,team:[...ctx.team],involved:ctx.involved.size,revision};
  return out;
 }
 return {reason,canSee,canSeeRequest,canSeeMeeting,context,filterState,employeeFilters,companyWide,team,links,isInvolved,managersOf:staff=>managersOf(staff,links())};
}

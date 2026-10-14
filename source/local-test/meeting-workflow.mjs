// Approval is separate from the effective meeting. Validation and application use the same domain function.
export function createMeetingWorkflow({db,get,all,run,insert,update,id,now,fail,str,version,scope,hooks,save,log,nameOf}) {
 const meeting=key=>get('SELECT * FROM tm_meetings WHERE id=?',key)||fail('Meeting not found.',404);
 const participant=(m,who)=>[m.organizer_id,m.created_by].includes(who)||!!get('SELECT 1 FROM tm_attendees WHERE meeting_id=? AND staff_id=?',m.id,who);
 const activeReviewer=who=>!!hooks.canStaff(who,'tasks.meetings','view')&&get('SELECT active FROM access_users WHERE staff_id=?',who)?.active===1;
 const eligible=(m,who)=>participant(m,who)&&activeReviewer(who);
 const tell=(m,who,actor,title)=>insert('tm_notifications',{staff_id:who,kind:'meeting_change',meeting_id:m.id,title,body:m.title,actor_id:actor,created_at:now()});
 function request(d,actor,source){
  if(!d.id)return save(d,actor,source);
  const m=meeting(d.id);if(!scope.canSeeMeeting(actor,m))fail('Meeting not found.',404);
  if(!eligible(m,actor)||!hooks.canStaff(actor,'tasks.meetings','update'))fail('Only authorized participants can request meeting changes.',403);
  version(m,d.expected_version);
  if(get("SELECT id FROM tm_meeting_changes WHERE meeting_id=? AND status='PENDING'",m.id))fail('Decide or withdraw the pending meeting change first.',409);
  // Validate all fields, scheduling conflicts, memberships and linked-record rights without applying side effects.
  let preview;
  db.exec('SAVEPOINT meeting_preview');
  try {save(d,actor,source);preview={...meeting(m.id),attendee_ids:all('SELECT staff_id FROM tm_attendees WHERE meeting_id=?',m.id).map(x=>x.staff_id),share_ids:all('SELECT staff_id FROM tm_meeting_shares WHERE meeting_id=?',m.id).map(x=>x.staff_id)};}
  finally {db.exec('ROLLBACK TO meeting_preview; RELEASE meeting_preview');}
  const changes=Object.entries(preview).filter(([k,v])=>!['version','updated_at','attendee_ids','share_ids'].includes(k)&&JSON.stringify(v)!==JSON.stringify(m[k])).map(([field,to])=>({field,from:m[field],to}));
  for(const [field,table] of [['attendee_ids','tm_attendees'],['share_ids','tm_meeting_shares']]) {const before=all(`SELECT staff_id FROM ${table} WHERE meeting_id=?`,m.id).map(x=>x.staff_id).sort(),after=[...preview[field]].sort();if(JSON.stringify(before)!==JSON.stringify(after))changes.push({field,from:before,to:after});}
  if(!changes.length)return {id:m.id,type:'tm_meeting',unchanged:true,message:'Nothing was changed.'};
  // A sole participant can nominate another responsible party by proposing an invitation.
  // That person receives temporary view access to this approval only; membership changes on approval.
  const candidates=[m.organizer_id,m.created_by,...all('SELECT staff_id FROM tm_attendees WHERE meeting_id=? ORDER BY staff_id',m.id).map(x=>x.staff_id),...preview.attendee_ids].filter(x=>x!==actor&&activeReviewer(x));
  const approver=d.approver_id||candidates[0];
  if(!approver||!candidates.includes(approver))fail('Invite another active participant to approve this change. The meeting remains unchanged until they approve.',409);
  const key=id('tm-meeting-change','MCHANGE');
  insert('tm_meeting_changes',{id:key,meeting_id:m.id,requested_by:actor,approver_id:approver,base_version:m.version,payload_json:JSON.stringify({data:d,changes}),source,note:str(d.change_note,'Reason for change',1000),created_at:now()});
  log(actor,'meeting',m.id,m.workspace_id,'Meeting change requested',JSON.stringify({request:key,approver,changes}));
  tell(m,approver,actor,`Meeting change awaiting your approval: ${m.title}`);
  return {id:m.id,type:'tm_meeting',change_id:key,message:`Sent to ${nameOf(approver)} for approval. The meeting stays unchanged until approved.`};
 }
 function decide(action,d,actor,source){
  const q=get('SELECT * FROM tm_meeting_changes WHERE id=?',String(d.id||''));if(!q)fail('Change request not found.',404);
  const m=meeting(q.meeting_id);if(!scope.canSeeMeeting(actor,m)||![q.requested_by,q.approver_id].includes(actor))fail('Change request not found.',404);
  const withdrawing=action==='tm.meeting.withdraw';
  if(withdrawing?q.requested_by!==actor:q.approver_id!==actor||q.requested_by===actor)fail('Only the other designated party can decide this request.',403);
  if(q.status!=='PENDING')fail('This request has already been decided.',409);
  version(q,d.expected_version);
  if(!withdrawing&&!['APPROVE','REJECT'].includes(d.decision))fail('Choose Approve or Reject.');
  const status=withdrawing?'WITHDRAWN':d.decision==='APPROVE'?'APPROVED':'REJECTED',note=str(d.note,'Decision note',1000,status==='REJECTED');
  if(status==='APPROVED'){
   const {data}=JSON.parse(q.payload_json);
   const invited=(data.attendee_ids||[]).includes(actor)||data.organizer_id===actor;
   if(!activeReviewer(actor)||!(participant(m,actor)||invited)||!eligible(m,q.requested_by)||!hooks.canStaff(q.requested_by,'tasks.meetings','update'))fail('A responsible participant no longer has authority. Withdraw and submit a new request.',409);
   if(m.version!==q.base_version)fail('The meeting changed since this request. Withdraw and request the change again.',409);
   save({...data,expected_version:m.version},q.requested_by,source);
  }
  update('tm_meeting_changes',q.id,{status,decision_note:note,decided_by:actor,decided_at:now(),version:q.version+1});
  log(actor,'meeting',m.id,m.workspace_id,`Meeting change ${status.toLowerCase()}`,JSON.stringify({request:q.id,note,source}));
  tell(m,withdrawing?q.approver_id:q.requested_by,actor,`Meeting change ${status.toLowerCase()}: ${m.title}`);
  return {id:m.id,type:'tm_meeting',message:status==='APPROVED'?'Approved change applied.':'The meeting remains unchanged.'};
 }
 return {request,decide};
}

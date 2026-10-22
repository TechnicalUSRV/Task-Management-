import { uiText, useLanguage } from "./i18n";
import {Identity} from './identity-ui';
import {useState} from 'react';
type Row=Record<string,any>;
export function MeetingApprovals({records,meeting,me,name,perform,onApplied}:{records:Row[];meeting:string;me:string;name:(id:string)=>string;perform:(action:string,d:Row)=>Promise<any>;onApplied?:()=>void}){
  useLanguage();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 const rows=records.filter(q=>q.meeting_id===meeting);if(!rows.length)return null;
 const act=async(q:Row,decision:string)=>{if(decision==='REJECT'&&!note.trim()){setError(uiText("Enter a reason for rejection."));return;}setBusy(true);setError('');try{await perform(decision==='WITHDRAW'?'tm.meeting.withdraw':'tm.meeting.decide',{id:q.id,expected_version:q.version,decision,note});onApplied?.();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const show=(v:any)=>Array.isArray(v)?v.map(x=>name(x)).join(', '):v===null||v===''?'—':String(v);
 return <section className="meeting-approval stack-sm"><h3>{uiText("Meeting change history")}</h3>{error&&<p role="alert" className="error">{error}</p>}{rows.slice().reverse().map(q=>{let changes:Row[]=[];try{changes=JSON.parse(q.payload_json).changes||[];}catch{}return <div key={q.id} className="callout"><strong>{q.status==='PENDING'?uiText("Pending approval"):q.status}</strong><p><Identity name={name(q.requested_by)}/> {uiText("requested · ")}<Identity name={name(q.approver_id)}/> decides</p><ul>{changes.map(x=><li key={x.field}><strong>{x.field.replaceAll('_',' ')}</strong>: {show(x.from)} → {show(x.to)}</li>)}</ul>{q.decision_note&&<p>{q.decision_note}</p>}{q.status==='PENDING'&&<>{q.approver_id===me&&<><label className="field">{uiText("Decision note")}<textarea className="input" value={note} onChange={e=>setNote(e.target.value)}/></label><div className="row"><button type="button" className="btn" disabled={busy} onClick={()=>void act(q,'APPROVE')}>{uiText("Approve change")}</button><button type="button" className="btn" disabled={busy} onClick={()=>void act(q,'REJECT')}>{uiText("Reject change")}</button></div></>}{q.requested_by===me&&<button type="button" className="btn" disabled={busy} onClick={()=>void act(q,'WITHDRAW')}>{uiText("Withdraw request")}</button>}</>}</div>;})}</section>;
}

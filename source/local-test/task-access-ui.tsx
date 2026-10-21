import { useState } from 'react';
import type { Row } from './components';
import './styles/camera-attachment.css';
export const TASK_CATEGORIES = [['mine','My Tasks'],['management','Tasks Under My Management'],['shared','Shared With Me']] as const;
export function TaskCategories({value,onChange,tasks}:{value:string;onChange:(v:string)=>void;tasks:Row[]}){
  return <div className="task-category-bar" role="group" aria-label="Task categories">{TASK_CATEGORIES.map(([key,label])=><button type="button" key={key} aria-pressed={value===key} onClick={()=>onChange(key)}>{label} ({tasks.filter(t=>t.task_categories?.includes(key)).length})</button>)}</div>;
}
export function TaskVisibility({value,onChange,organizational,disabled,request=false}:{value?:string;onChange:(v:string)=>void;organizational:boolean;disabled?:boolean;request?:boolean}){
 return <label className="task-visibility">Task visibility<select aria-label="Task visibility" value={value||'PUBLIC'} disabled={disabled} onChange={e=>onChange(e.target.value)}>
  {!request&&<option value="PERSONAL">Personal – Owner Only</option>}<option value="PUBLIC">Public – Owner Managed</option><option value="ORGANIZATIONAL" disabled={!organizational}>Organizational – Level 2 Governance</option>
 </select><small>{value==='PERSONAL'?'Owner only. Choose Public before adding other participants.':value==='ORGANIZATIONAL'?'Oversight follows this Workspace’s authorized governing manager and management scope.':'Only authorized Task participants, explicit shares and authorized management can view this Task.'}</small></label>;
}
export function TaskSharing({task,data,command,name}:{task:Row;data:Row;command:(a:string,d:Row)=>Promise<unknown>;name:(id:string)=>string}){
 const [editing,setEditing]=useState(false),[members,setMembers]=useState<Row[]>([]),[person,setPerson]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[version,setVersion]=useState(0);
 const existing:Row[]=(data.tm_task_members||[]).filter((m:Row)=>m.task_id===task.id);
 const save=async()=>{setBusy(true);setError('');try{await command('tm.task.members.save',{id:task.id,expected_version:version,members:members.map(m=>({staff_id:m.staff_id,permission:m.permission}))});setEditing(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="task-sharing"><h3>Task sharing</h3><p>Visibility: {task.visibility||'PUBLIC'}. Responsible roles are managed through the existing Task workflow.</p>
 {!editing?<><ul>{existing.map(m=><li key={m.staff_id}>{name(m.staff_id)} · {m.permission==='CONTRIBUTOR'?'Contributor (comments and files)':'Viewer'}</li>)}</ul>{!existing.length&&<p>No additional Task members.</p>}
 {task.can_manage_members&&task.visibility!=='PERSONAL'&&<button type="button" className="btn" onClick={()=>{setMembers(existing);setVersion(task.version);setEditing(true);}}>Manage Task members</button>}</>:
 <><ul>{members.map((m,i)=><li key={m.staff_id}><span>{name(m.staff_id)}</span><select aria-label={`Permission for ${name(m.staff_id)}`} value={m.permission} disabled={busy} onChange={e=>setMembers(s=>s.map((v,j)=>j===i?{...v,permission:e.target.value}:v))}><option value="VIEWER">Viewer</option><option value="CONTRIBUTOR">Contributor: comments and files</option></select><button type="button" disabled={busy} onClick={()=>setMembers(s=>s.filter((_,j)=>j!==i))}>Remove</button></li>)}</ul>
 <select aria-label="Add Task member" value={person} disabled={busy} onChange={e=>setPerson(e.target.value)}><option value="">Choose a person</option>{(data.tm_people||[]).filter((p:Row)=>p.staff_id!==task.created_by&&!members.some(m=>m.staff_id===p.staff_id)).map((p:Row)=><option key={p.staff_id} value={p.staff_id}>{name(p.staff_id)}</option>)}</select>
 <button type="button" disabled={!person||busy||members.length>=50} onClick={()=>{setMembers(s=>[...s,{staff_id:person,permission:'VIEWER'}]);setPerson('');}}>Add</button>
 <p>Removing a share revokes only that share. Required Task roles and independent management rights remain in effect.</p>
 <button type="button" className="btn" disabled={busy} onClick={()=>void save()}>Save sharing</button><button type="button" className="btn" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button></>}
 {error&&<p role="alert">{error}</p>}</section>;
}

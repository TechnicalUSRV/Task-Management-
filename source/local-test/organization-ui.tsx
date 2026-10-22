import { uiText, useLanguage, dynamicLabels } from "./i18n";
import {Identity} from './identity-ui';
import {Badge,Bar,Btn,Empty,FilterChips,FilterPick,Pager,SearchBox,Toggle,WorkspaceSections,cx} from './workspace-sections';
import {useEffect,useId,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {AlertCircle,AlertTriangle,CheckCircle2,ChevronDown,ChevronRight,GitBranch,History,Info,Layers,List,Plus,SearchX,ShieldCheck,Users,X,type LucideIcon} from 'lucide-react';
import {formatDateTime,localDate,plural} from './format';
import {uuid} from './api-client';
import './styles/organization.css';
type Row=Record<string,any>;
type Props={data:Row;actor:string;read:(params:Row)=>Promise<Row>;perform:(action:string,data:Row,options?:{quiet?:boolean})=>Promise<Row>;mini?:boolean;requestId?:string;onOpenTask?:(id:string)=>void};
type Edit={kind:string;title:string;data:Row};

// V5.6.8: sentence-case labels for stored codes (statuses, kinds, roles) instead of lower-cased codes.
const KIND:Record<string,string>={PERSONAL:'Personal',ORGANIZATIONAL:'Organizational',LEGACY:'Legacy'};
const ROLE:Record<string,string>={MEMBER:'Member',VIEWER:'Viewer'};
const REQUEST_KIND:Record<string,string>={MEMBERSHIP:'Membership request',DELEGATION:'Delegation request',STRUCTURE:'Reporting change request'};
const REQUEST_NOUN:Record<string,string>={MEMBERSHIP:'a membership request',DELEGATION:'a delegation request',STRUCTURE:'a reporting change request'};
const STATUS:Record<string,[string,string]>={PENDING:dynamicLabels(["Pending", 'warning'], { 0: () => uiText("Pending") }),REVIEW:dynamicLabels(["Needs Level 1 review", 'warning'], { 0: () => uiText("Needs Level 1 review") }),APPROVED:dynamicLabels(["Approved", 'success'], { 0: () => uiText("Approved") }),REJECTED:dynamicLabels(["Rejected", 'danger'], { 0: () => uiText("Rejected") }),CANCELLED:dynamicLabels(["Cancelled", 'neutral'], { 0: () => uiText("Cancelled") }),ACTIVE:dynamicLabels(["Active", 'success'], { 0: () => uiText("Active") }),SUSPENDED:dynamicLabels(["Suspended", 'neutral'], { 0: () => uiText("Suspended") }),REVOKED:dynamicLabels(["Revoked", 'neutral'], { 0: () => uiText("Revoked") }),ARCHIVED:dynamicLabels(["Archived", 'neutral'], { 0: () => uiText("Archived") })};
const sentence=(v:unknown)=>{const s=String(v??'').replaceAll('_',' ').replaceAll('.',' ').trim().toLowerCase();return s.charAt(0).toUpperCase()+s.slice(1);};
const statusOf=(v:string):[string,string]=>STATUS[v]||[sentence(v),'neutral'];
const parse=(v:unknown)=>{try{return typeof v==='string'?JSON.parse(v):v??null;}catch{return null;}};
const addDays=(d:string,n:number)=>new Date(Date.parse(`${d}T12:00:00Z`)+n*86400000).toISOString().slice(0,10);
// History filters: readable change types (the server matches part of the stored action code) and date presets.
const CHANGE_TYPES:[string,string][]=[dynamicLabels(['request.', "Requests and decisions"], { 1: () => uiText("Requests and decisions") }),dynamicLabels(['employee.structure', "Reporting lines"], { 1: () => uiText("Reporting lines") }),dynamicLabels(['level1', "Level 1 administrators"], { 1: () => uiText("Level 1 administrators") }),dynamicLabels(['membership', "Workspace memberships"], { 1: () => uiText("Workspace memberships") }),dynamicLabels(['personal.shared', "Personal sharing"], { 1: () => uiText("Personal sharing") }),dynamicLabels(['delegation', "Delegated authority"], { 1: () => uiText("Delegated authority") }),dynamicLabels(['workspace.', "Workspaces"], { 1: () => uiText("Workspaces") }),dynamicLabels(['migration', "Migration"], { 1: () => uiText("Migration") }),dynamicLabels(['level.configured', "Level labels"], { 1: () => uiText("Level labels") }),dynamicLabels(['template', "Title templates"], { 1: () => uiText("Title templates") })];
const RANGES:[string,string][]=[dynamicLabels(['today', "Today"], { 1: () => uiText("Today") }),dynamicLabels(['7', "Last 7 days"], { 1: () => uiText("Last 7 days") }),dynamicLabels(['30', "Last 30 days"], { 1: () => uiText("Last 30 days") }),dynamicLabels(['month', "This month"], { 1: () => uiText("This month") }),dynamicLabels(['last-month', "Last month"], { 1: () => uiText("Last month") }),dynamicLabels(['custom', "Custom range"], { 1: () => uiText("Custom range") })];
function rangeOf(f:Row):{from:string;to:string}{
 const t=localDate(),first=t.slice(0,8)+'01';
 switch(f.range){case 'today':return {from:t,to:t};case '7':return {from:addDays(t,-6),to:t};case '30':return {from:addDays(t,-29),to:t};case 'month':return {from:first,to:t};
  case 'last-month':{const to=addDays(first,-1);return {from:to.slice(0,8)+'01',to};}case 'custom':return {from:f.from||'',to:f.to||''};default:return {from:'',to:''};}
}
const ALERT_ICON:Record<string,LucideIcon>={danger:AlertCircle,success:CheckCircle2,warning:AlertTriangle,info:Info};
function Note({tone='info',title,children,action,live}:{tone?:string;title?:ReactNode;children?:ReactNode;action?:ReactNode;live?:boolean}){
  useLanguage();
 const Icon=ALERT_ICON[tone]||Info;
 return <div className={`alert tone-${tone} org-alert`} role={live?(tone==='danger'?'alert':'status'):undefined}><Icon className="alert-icon" aria-hidden="true"/><div className="alert-body">{title&&<p className="alert-title">{title}</p>}{children&&<div className="alert-text">{children}</div>}</div>{action&&<div className="alert-action">{action}</div>}</div>;
}
/** Keeps the previous result on screen (dimmed) while the next one loads (V5.6.8). Results are remembered per query. */
function useQuery(read:Props['read'],params:Row|null,revision:unknown){
 const key=params?JSON.stringify(params):'',view=params?.view;
 const cache=useRef(new Map<string,Row>());
 const [state,setState]=useState<{key:string;revision:unknown;view:unknown;value:Row|null;error:string;loading:boolean}>({key:'',revision:null,view:null,value:null,error:'',loading:true});
 useEffect(()=>{
  if(!key)return;let live=true;
  setState(s=>({key,revision,view,value:cache.current.get(key)??(s.view===view?s.value:null),error:'',loading:true}));
  void read(JSON.parse(key)).then(value=>{if(live){cache.current.set(key,value);setState({key,revision,view,value,error:'',loading:false});}}).catch(e=>{if(live)setState(s=>({...s,error:(e as Error).message,loading:false}));});
  return()=>{live=false;};
 },[read,key,revision]);// eslint-disable-line react-hooks/exhaustive-deps
 if(!key)return {value:null,error:'',loading:false};
 const current=state.key===key&&state.revision===revision;
 return current?{value:state.value,error:state.error,loading:state.loading}:{value:cache.current.get(key)??(state.view===view?state.value:null),error:'',loading:true};
}

export function OrganizationPage(p:Props){
  useLanguage();
 const mini=!!p.mini,org=p.data.organization||{},me=org.me||{},canManage=!!me.can_manage_structure,manager=!!(me.is_admin||me.is_governor);
 const requestDefaults=()=>({status:'PENDING',mine:manager?'1':''});
 const [tab,setTab]=useState(p.requestId&&canManage?'requests':'people'),[mode,setMode]=useState(mini?'list':'tree'),[q,setQ]=useState(''),[page,setPage]=useState(1),[tick,setTick]=useState(0);
 const [selected,setSelected]=useState(''),[edit,setEdit]=useState<Edit|null>(null),[notice,setNotice]=useState(''),[filters,setFilters]=useState<Row>(requestDefaults);
 const panel=useRef<HTMLElement>(null);
 useEffect(()=>{if(p.requestId&&canManage){setTab('requests');setQ(p.requestId);setFilters({status:'',mine:''});setPage(1);}},[p.requestId,canManage]);
 useEffect(()=>{if(!canManage){setTab('people');setEdit(null);}},[canManage]);
 // Mini App: the selected person's details are below the list, so bring them into view.
 useEffect(()=>{if(mini&&selected)panel.current?.scrollIntoView({behavior:'smooth',block:'start'});},[mini,selected]);
 const revision=`${org.revision}:${tick}`;
 const lookups=new Map<string,string>((p.data.lookups||[]).map((l:Row)=>[l.id,l.name]));
 const name=(id:string)=>id?lookups.get(id)||id:uiText("Top of the organization");
 const dash=p.data.workspace_dashboard||{};
 const wsIndex=new Map<string,string>([...(p.data.tm_workspaces||[]),...(p.data.tm_workspace_refs||[]),...(dash.my||[]),...(dash.managed||[]),...(dash.shared||[])].map((w:Row)=>[w.id,w.name]));
 const wsName=(id:string,fallback?:string)=>wsIndex.get(id)||fallback||uiText("a workspace you can’t open");
 const levelName=(n:number)=>org.levels?.find((l:Row)=>l.id===n)?.name;
 const levelText=(n?:number|null)=>n?`Level ${n}`:uiText("Not mapped to a level");
 const range=rangeOf(filters);
 const params:Row|null=['workspaces','settings'].includes(tab)?null:{view:tab,q,page,limit:30,
  ...(tab==='requests'?{status:filters.status||'',mine:filters.mine||''}:{}),
  ...(tab==='audit'?{employee:filters.employee||'',workspace:filters.workspace||'',actor:filters.actor||'',action:filters.action||'',from:range.from,to:range.to}:{}),
  ...(tab==='people'&&mode==='tree'&&!q?{parent:'root'}:{})};
 const {value,error,loading}=useQuery(p.read,params,revision);
 const detail=useQuery(p.read,tab==='people'?{view:'employee',staff_id:selected||p.actor}:null,revision);
 const choose=(t:string)=>{setTab(t);setPage(1);setQ('');setFilters(t==='requests'?requestDefaults():{});};
 const open=(kind:string,title:string,data:Row={})=>{if(canManage)setEdit({kind,title,data});};
 const action=async(a:string,d:Row)=>{const r=await p.perform(a,d,{quiet:true});setNotice(r.message||uiText("Saved"));setTick(v=>v+1);return r;};
 const change=(r:Row)=>open('structure',uiText("Reporting relationship"),{changes:[{staff_id:r.staff_id,level:r.org_level||3,manager_id:r.manager_id||'',additional_manager_ids:r.additional_manager_ids??[]}],reason:''});
 const delegation=(r:Row)=>{const g=org.grants?.find((g:Row)=>g.capabilities.includes('delegate_request')),t=org.templates?.find((x:Row)=>x.active&&x.id==='OWNER')||org.templates?.find((x:Row)=>x.active);open('delegation',uiText("Grant or request delegated authority"),{beneficiary_id:r.staff_id,template_id:t?.id||'',capabilities:(t?.capabilities||[]).filter((k:string)=>manager||g?.capabilities.includes(k)),parent_grant_id:g?.id||'',workspace_id:manager?'':g?.workspace_id||'',reason:''});};
 const newWorkspace=()=>open('workspace',uiText("New workspace"),{kind:'PERSONAL',owner_id:p.actor,color:'BLUE',name:'',description:'',department:'',reason:''});
 const people:[string,string][]=(org.directory||p.data.tm_people||[]).map((x:Row)=>[x.staff_id,x.name]);
 const workspaceOptions:[string,string][]=[...wsIndex.entries()];
 const caps=(list:string[])=>(list||[]).map(k=>org.capabilities?.[k]||sentence(k)).join(' · ');
 const when=(v:unknown)=>{const s=formatDateTime(v)||'';return mini?s.replace(` ${localDate().slice(0,4)},`,','):s;};

 const tag=<span className="tag org-level-tag" title={uiText("Your organizational level")}><ShieldCheck aria-hidden="true"/>{me.org_level?uiText("{p0}{p1}", { p0: levelText(me.org_level), p1: levelName(me.org_level)?` · ${levelName(me.org_level)}`:'' }):uiText("No organizational level")}</span>;
 const tabs:[string,LucideIcon,string,number?][]=[['people',Users,uiText("People")],['workspaces',GitBranch,uiText("Workspaces")],['requests',ShieldCheck,uiText("Approvals"),org.pending||undefined],['audit',History,uiText("History")],
  ...(!mini&&(me.is_admin||me.can_initialize)?[['migration',List,uiText("Migration")] as [string,LucideIcon,string]]:[]),...(!mini&&me.is_admin?[['settings',Layers,uiText("Levels & titles")] as [string,LucideIcon,string]]:[])];
 // V5.6.8: “Request to join” belongs to Workspaces, so that tab stays highlighted.
 const current=(id:string)=>tab===id||id==='workspaces'&&tab==='join';
 const search=(label:string,placeholder:string)=><SearchBox mini={mini} label={label} placeholder={placeholder} value={q} onChange={v=>{setQ(v);setPage(1);}}/>;
 const clearSearch=q?<Btn size="sm" onClick={()=>{setQ('');setPage(1);}}>{uiText("Clear search")}</Btn>:undefined;
 const results=(content:ReactNode)=>error&&!value?<Note tone="danger" title={uiText("This information could not be loaded")} live action={<Btn size="sm" onClick={()=>setTick(x=>x+1)}>{uiText("Try again")}</Btn>}>{error}</Note>
  :!value?(mini?<p className="hint org-loading" role="status">{uiText("Loading…")}</p>:<div className="loading-state" role="status" aria-live="polite"><span className="sr-only">{uiText("Loading…")}</span><div className="loading-table">{[0,1,2,3].map(i=><div className="loading-row" key={i}><span className="skeleton sk-line sk-w30"/><span className="skeleton sk-line sk-w20"/><span className="skeleton sk-line sk-w15"/></div>)}</div></div>)
  :<div className={cx('org-results',loading&&'is-refreshing')} aria-busy={loading||undefined}>{error&&<Note tone="danger" live action={<Btn size="sm" onClick={()=>setTick(x=>x+1)}>{uiText("Try again")}</Btn>}>{error}</Note>}{content}</div>;
 const rows:Row[]=value?.rows||[];

 // ---------------------------------------------------------------- people
 const meta=(r:Row)=>[r.org_level?levelText(r.org_level):"Not mapped",r.manager_id?`reports to ${name(r.manager_id)}`:r.org_level===1?"top of the organization":'',...(r.titles||[]),r.active===0?'inactive':''].filter(Boolean).join(' · ');
 const person=detail.value;
 const personPanel=<aside ref={panel} className={cx("org-card org-person-panel",detail.loading&&person&&'is-refreshing')} aria-label={uiText("Selected employee")} aria-busy={detail.loading||undefined}>
  {detail.error&&!person?<p role="alert" className="field-error">{detail.error}</p>:!person?<p role="status" className="org-muted">{uiText("Loading employee…")}</p>:<>
   <h2><Identity name={person.name}/></h2>
   <p className="org-muted">{levelText(person.org_level)}{levelName(person.org_level)?uiText(" · {p0}", { p0: levelName(person.org_level) }):''}{person.active===0?uiText(" · Inactive"):''}{me.is_admin&&<span className="id-text"> · {person.staff_id}</span>}</p>
   <dl className="org-facts">
    <div><dt>{uiText("Manager")}</dt><dd>{person.manager_id?name(person.manager_id):uiText("Top of the organization")}</dd></div>
    {!!person.additional_manager_ids?.length&&<div><dt>{uiText("Also reports to")}</dt><dd>{person.additional_manager_ids.map(name).join(', ')}</dd></div>}
    {person.org_level!==1&&<div><dt>{uiText("Level 2 authority")}</dt><dd>{person.governing_manager_id?name(person.governing_manager_id):uiText("Not configured")}</dd></div>}
    <div><dt>{uiText("Direct reports")}</dt><dd>{person.direct_reports?.length?person.direct_reports.map((x:Row)=>x.name).join(', '):uiText("None")}</dd></div>
   </dl>
   {canManage&&org.enabled&&(person.actions?.change_structure||person.actions?.request_structure||person.actions?.delegate)&&<div className="org-actions">
    {(person.actions?.change_structure||person.actions?.request_structure)&&<Btn size="sm" onClick={()=>change(person)}>{manager?uiText("Change reporting"):uiText("Request reporting change")}</Btn>}
    {person.actions?.delegate&&<Btn size="sm" onClick={()=>delegation(person)}>{uiText("Delegate authority")}</Btn>}</div>}
   {canManage&&<><h3>{uiText("Owned workspaces")}</h3>{person.owned?.length?<ul className="org-plain-list">{person.owned.map((w:Row)=><li key={w.id}>{w.name}<small>{w.visibility==='PUBLIC'?uiText("Public"):KIND[w.kind]||sentence(w.kind)}</small></li>)}</ul>:<p className="org-muted">{uiText("None visible in your scope.")}</p>}
   <h3>{uiText("Memberships")}</h3>{person.memberships?.length?<ul className="org-plain-list">{person.memberships.map((w:Row)=><li key={w.id}>{w.name}<small>{ROLE[w.member_role]||sentence(w.member_role)} · {w.visibility==='PUBLIC'?uiText("Public"):KIND[w.kind]||sentence(w.kind)}</small></li>)}</ul>:<p className="org-muted">{uiText("No visible memberships.")}</p>}
   <h3>{uiText("Delegated capabilities")}</h3>{person.grants?.length?person.grants.map((g:Row)=>{const [label,tone]=g.effective?STATUS.ACTIVE:g.status==='ACTIVE'?[uiText("Not in effect"),'warning']:statusOf(g.status);return <div key={g.id} className="org-grant">
    <div className="org-grant-head"><strong>{g.title}</strong><Badge label={label} tone={tone}/></div>
    <p>{caps(g.capabilities)}</p>
    <small>{uiText("Scope: ")}{g.workspace_id?wsName(g.workspace_id):uiText("Reporting branch")} {uiText("· approved by ")}{name(g.granted_by)} {uiText("· Level 2 manager ")}{name(g.governing_manager_id)}</small>
    {g.status==='ACTIVE'&&!mini&&(me.is_admin||g.governing_manager_id===p.actor)&&<Btn size="sm" onClick={()=>open('revoke',uiText("Revoke authority"),{id:g.id,grant_id:g.id,_title:g.title,_beneficiary:person.name,reason:''})}>{uiText("Preview revocation")}</Btn>}
   </div>;}):<p className="org-muted">{uiText("No delegated authority.")}</p>}</>}
  </>}
 </aside>;
 const peopleView=results(mini?<>
   {rows.length?<ul className="list org-people-list">{rows.map(r=><PersonRow key={r.staff_id} r={r} meta={meta(r)} selected={selected===r.staff_id} onSelect={()=>setSelected(r.staff_id)}/>)}</ul>:<Empty mini icon={SearchX} title={uiText("No employees match this view")} action={clearSearch}/>}
   <Pager total={value?.total||0} page={page} size={30} onPage={setPage} noun={['person','people']}/>
   {personPanel}
  </>:<div className="org-layout"><div className="org-card org-people">
   {mode==='tree'&&!q?<><div className="org-root"><GitBranch aria-hidden="true"/><strong>{p.data.company?.name}</strong><span>{uiText("Top of the organization")}</span></div><ul className="org-branch">{rows.map(r=><TreeNode key={r.staff_id} r={r} p={p} revision={revision} selected={selected} onSelect={setSelected} meta={meta}/>)}</ul></>
    :<div className="table-wrap org-table"><table className="data-table"><thead><tr><th>{uiText("Employee")}</th><th>{uiText("Level / title")}</th><th>{uiText("Reports to")}</th><th>{uiText("Governing manager")}</th></tr></thead><tbody>{rows.map(r=><tr key={r.staff_id} className={selected===r.staff_id?'is-selected':undefined}>
     <td><span className="cell-stack"><button type="button" className="row-link org-person-link" onClick={()=>setSelected(r.staff_id)}><span className="cell-title"><Identity name={r.name}/></span></button>{(me.is_admin||!r.active)&&<small>{[me.is_admin?r.staff_id:'',r.active?'':"Inactive"].filter(Boolean).join(' · ')}</small>}</span></td>
     <td><span className="cell-stack"><span>{levelText(r.org_level)}</span>{!!r.titles?.length&&<small>{r.titles.join(', ')}</small>}</span></td>
     <td>{r.manager_id?name(r.manager_id):<span className="org-muted">{uiText("Top of the organization")}</span>}</td>
     <td>{r.governing_manager_id?name(r.governing_manager_id):<span className="missing">—</span>}</td></tr>)}</tbody></table></div>}
   {!rows.length&&<Empty icon={SearchX} title={uiText("No employees match this view")} action={clearSearch}/>}
   <Pager total={value?.total||0} page={page} size={30} onPage={setPage} noun={['person','people']}/>
  </div>{personPanel}</div>);

 // ---------------------------------------------------------------- approvals
 const decideButtons=(r:Row)=><>{r.can_decide&&<><Btn variant="primary" size="sm" onClick={()=>open('decision',uiText("Review and approve request"),{...r,decision:'APPROVE',note:''})}>{uiText("Review approval")}</Btn><Btn size="sm" onClick={()=>open('decision',uiText("Reject request"),{...r,decision:'REJECT',note:''})}>{uiText("Reject")}</Btn></>}{r.can_cancel&&<Btn size="sm" onClick={()=>open('cancel',uiText("Cancel request"),{id:r.id,_kind:r.kind,reason:''})}>{uiText("Cancel request")}</Btn>}</>;
 const defaultRequestFilters=filters.status==='PENDING'&&filters.mine===(manager?'1':'');
 const requestsView=results(<>{rows.length?<div className="org-request-list">{rows.map(r=>{const [label,tone]=statusOf(r.status);return <article className={cx("org-card org-request",r.id===p.requestId&&'org-highlight')} key={r.id}>
   <div className="org-card-head"><h2 className="org-card-title">{REQUEST_KIND[r.kind]||sentence(r.kind)}</h2><Badge label={label} tone={tone}/></div>
   <p className="org-muted">{when(r.created_at)} {uiText("· requested by ")}{name(r.requester_id)}{r.beneficiary_id&&r.beneficiary_id!==r.requester_id?uiText(" for {p0}", { p0: name(r.beneficiary_id) }):''}{me.is_admin&&<span className="id-text"> · {r.id}</span>}</p>
   <dl className="org-facts">
    <div><dt>{uiText("Approver")}</dt><dd>{r.approver_id?name(r.approver_id):uiText("Level 1 configuration review needed")}</dd></div>
    {r.workspace_id&&<div><dt>{uiText("Workspace")}</dt><dd>{wsName(r.workspace_id)}</dd></div>}
    {r.payload?.member_role&&<div><dt>{uiText("Role")}</dt><dd>{ROLE[r.payload.member_role]||sentence(r.payload.member_role)}</dd></div>}
    {r.reason&&<div><dt>{uiText("Reason")}</dt><dd>{r.reason}</dd></div>}
    {r.payload?.capabilities&&<div><dt>{uiText("Capabilities")}</dt><dd>{caps(r.payload.capabilities)}</dd></div>}
    {!!r.payload?.changes?.length&&<div><dt>{uiText("Changes")}</dt><dd>{r.payload.changes.map((c:Row)=><span className="org-line" key={c.staff_id}>{name(c.staff_id)} → {levelText(c.level)}{uiText(", reports to ")}{c.manager_id?name(c.manager_id):uiText("nobody (top of the organization)")}</span>)}</dd></div>}
    {r.decision_note&&<div><dt>{uiText("Decision note")}</dt><dd>{r.decision_note}</dd></div>}
   </dl>
   {(r.can_decide||r.can_cancel)&&<div className="org-actions">{decideButtons(r)}</div>}
  </article>;})}</div>
  :<Empty mini={mini} icon={q||!defaultRequestFilters?SearchX:CheckCircle2} title={q||!defaultRequestFilters?uiText("No requests match these filters"):uiText("Nothing is waiting for your decision")} action={q||!defaultRequestFilters?<Btn size="sm" onClick={()=>{setQ('');setFilters(requestDefaults());setPage(1);}}>{uiText("Reset filters")}</Btn>:<Btn size="sm" onClick={()=>{setFilters({status:'',mine:''});setPage(1);}}>{uiText("Show all requests")}</Btn>}/>}
  <Pager total={value?.total||0} page={page} size={30} onPage={setPage} noun={['request','requests']}/></>);

 // ---------------------------------------------------------------- history
 const historyText=(r:Row)=>{
  const actor=name(r.actor_id),emp=r.employee_id?name(r.employee_id):'',after=parse(r.after_json)||{},before=parse(r.before_json)||{},ws=r.workspace_id?wsName(r.workspace_id,after.name||before.name):'';
  const forWhom=emp&&r.employee_id!==r.actor_id?` for ${emp}`:'',inWs=ws?` in ${ws}`:'';
  switch(r.action){
   case 'request.created':return `${actor} submitted ${REQUEST_NOUN[after.kind]||uiText("a request")}${forWhom}${inWs}`;
   case 'request.approve':return `${actor} approved the request${forWhom}${inWs}`;
   case 'request.reject':return `${actor} rejected the request${forWhom}${inWs}`;
   case 'request.cancelled':return `${actor} cancelled the request${forWhom}${inWs}`;
   case 'request.rerouted':return `A pending request${forWhom} was passed to ${after.approver?name(after.approver):uiText("Level 1 configuration review")}`;
   case 'employee.structure':return `${actor} set ${emp||uiText("an employee")} to ${levelText(after.org_level)}, reporting to ${after.manager_id?name(after.manager_id):uiText("nobody (top of the organization)")}`;
   case 'level1.assigned':return `${actor} made ${emp} a Level 1 administrator`;
   case 'membership.approved':return `${actor} added ${emp} to ${ws} as ${(ROLE[after.member_role]||'member').toLowerCase()}`;
   case 'membership.revoked':return `${actor} removed ${emp} from ${ws}`;
   case 'personal.shared':return `${actor} shared ${ws} with ${emp}`;
   case 'delegation.approved':return `${actor} granted ${after.title?`“${after.title}”`:uiText("delegated authority")} to ${emp}`;
   case 'delegation.revoked':return `${actor} revoked ${emp}’s ${before.title?`“${before.title}” `:''}authority`;
   case 'delegation.suspended':return `${emp}’s ${before.title?`“${before.title}” `:''}authority was suspended`;
   case 'workspace.created':return `${actor} created ${ws}`;
   case 'workspace.updated':return `${actor} updated ${ws}`;
   case 'workspace.governance':return `${actor} changed who is responsible for ${ws}`;
   case 'workspace.deleted':return `${actor} deleted ${ws}`;
   case 'workspace.restored':return `${actor} restored ${ws}`;
   case 'migration.workspace':return `${actor} classified ${ws} as ${(KIND[after.kind]||sentence(after.kind)).toLowerCase()}`;
   case 'level.configured':return `${actor} named Level ${after.id} “${after.name}”`;
   case 'template.configured':return `${actor} saved the title template “${after.name}”`;
   default:return `${actor}: ${sentence(r.action).toLowerCase()}${forWhom}${inWs}`;
  }
 };
 const setFilter=(k:string,v:string)=>{setFilters(f=>({...f,[k]:v}));setPage(1);};
 const historyChips=[
  ...[['employee',uiText("Employee")],['workspace',uiText("Workspace")],['actor',uiText("Changed by")]].filter(([k])=>filters[k]).map(([k,l])=>({key:k,label:uiText("{p0}: {p1}", { p0: l, p1: k==='workspace'?wsName(filters[k]):name(filters[k]) }),clear:()=>setFilter(k,'')})),
  ...(filters.action?[{key:'action',label:uiText("Change: {p0}", { p0: CHANGE_TYPES.find(([v])=>v===filters.action)?.[1]||filters.action }),clear:()=>setFilter('action','')}]:[]),
  ...(filters.range?[{key:'range',label:uiText("Date: {p0}", { p0: filters.range==='custom'?[range.from&&`from ${formatDateTime(`${range.from}T12:00:00Z`)?.slice(0,-7)}`,range.to&&`to ${formatDateTime(`${range.to}T12:00:00Z`)?.slice(0,-7)}`].filter(Boolean).join(' ')||'custom':RANGES.find(([v])=>v===filters.range)?.[1] }),clear:()=>setFilters(f=>({...f,range:'',from:'',to:''}))}]:[])];
 const historyFilters=<>
  <FilterPick mini={mini} label={uiText("Employee")} value={filters.employee||''} onChange={v=>setFilter('employee',v)} options={people} allLabel="Anyone"/>
  <FilterPick mini={mini} label={uiText("Workspace")} value={filters.workspace||''} onChange={v=>setFilter('workspace',v)} options={workspaceOptions} allLabel="All workspaces"/>
  <FilterPick mini={mini} label={uiText("Changed by")} value={filters.actor||''} onChange={v=>setFilter('actor',v)} options={people} allLabel="Anyone"/>
  <FilterPick mini={mini} label={uiText("Change")} value={filters.action||''} onChange={v=>setFilter('action',v)} options={CHANGE_TYPES} allLabel="All changes"/>
  <FilterPick mini={mini} label={uiText("Date")} value={filters.range||''} onChange={v=>setFilter('range',v)} options={RANGES} allLabel="All dates"/>
  {filters.range==='custom'&&<span className="org-date-range"><label className={mini?"mini-field org-mini-field":'org-date-field'}><span>{uiText("From")}</span><input type="date" className={mini?'input':'org-control'} value={filters.from||''} max={filters.to||undefined} onChange={e=>setFilter('from',e.target.value)}/></label><label className={mini?"mini-field org-mini-field":'org-date-field'}><span>{uiText("To")}</span><input type="date" className={mini?'input':'org-control'} value={filters.to||''} min={filters.from||undefined} onChange={e=>setFilter('to',e.target.value)}/></label></span>}
 </>;
 const historyView=results(<>{rows.length?<ol className="org-history">{rows.map(r=>{const after=parse(r.after_json),before=parse(r.before_json);return <li key={r.id} className="org-history-item">
   <time className="org-history-when" dateTime={r.created_at}>{when(r.created_at)}</time>
   <div className="org-history-body"><p className="org-history-text">{historyText(r)}</p>{r.reason&&<p className="org-muted">{uiText("Reason: ")}{r.reason}</p>}
    {me.is_admin&&<details className="org-tech"><summary>{uiText("Technical details")}</summary><dl className="org-tech-ids"><div><dt>{uiText("Change code")}</dt><dd>{r.action}</dd></div>{r.approval_id&&<div><dt>{uiText("Request")}</dt><dd>{r.approval_id}</dd></div>}{r.employee_id&&<div><dt>{uiText("Employee ID")}</dt><dd>{r.employee_id}</dd></div>}{r.workspace_id&&<div><dt>{uiText("Workspace ID")}</dt><dd>{r.workspace_id}</dd></div>}<div><dt>{uiText("Changed by")}</dt><dd>{r.actor_id}</dd></div></dl><pre className="json-block org-json">{JSON.stringify({before,after},null,2)}</pre></details>}
   </div></li>;})}</ol>
  :<Empty mini={mini} icon={SearchX} title={uiText("No changes match these filters")} action={historyChips.length?<Btn size="sm" onClick={()=>{setFilters({});setPage(1);}}>{uiText("Reset filters")}</Btn>:undefined}/>}
  <Pager total={value?.total||0} page={page} size={30} onPage={setPage} noun={['change','changes']}/></>);

 // ---------------------------------------------------------------- workspaces
 const workspaceCard=(w:Row)=>{const tasks=(p.data.tm_tasks||[]).filter((t:Row)=>w.task_ids?.includes(t.id));return <article className="org-card org-ws-card" key={w.id}>
  <div className="org-card-head"><h3 className="org-card-title">{w.name}</h3><span className="org-badges">{w.kind&&<Badge label={w.visibility==='PUBLIC'?uiText("Public"):KIND[w.kind]||sentence(w.kind)} tone={w.kind==='ORGANIZATIONAL'?'info':'neutral'}/>}{w.deleted_at?<Badge label={uiText("Deleted")} tone="neutral"/>:w.status==='ARCHIVED'&&<Badge label={uiText("Archived")} tone="neutral"/>}</span></div>
  <p className="org-muted">{uiText("Owner: ")}{name(w.owner_id)}</p>
  {!w.deleted_at&&<details className="org-ws-tasks"><summary>{uiText("View tasks (")}{w.task_ids?.length||0})</summary>{tasks.length?<ul className="org-plain-list">{tasks.map((t:Row)=><li key={t.id} className="org-task-row"><span>{t.title}<small>{sentence(t.status)} · {name(t.pic_id)}</small></span>{p.onOpenTask&&<Btn size="sm" onClick={()=>p.onOpenTask?.(t.id)}>{uiText("Open task")}</Btn>}</li>)}</ul>:<p className="org-muted">{uiText("No tasks are visible within your permitted scope.")}</p>}</details>}
  {(()=>{const buttons=<>
   {!w.deleted_at&&!w.reference_only&&w.org_access?.can_manage&&w.kind!=='LEGACY'&&<Btn size="sm" onClick={()=>open('workspace',uiText("Workspace governance"),{...p.data.tm_workspaces.find((r:Row)=>r.id===w.id),expected_version:w.version})}>{uiText("Manage")}</Btn>}
   {w.status==='ACTIVE'&&!w.deleted_at&&(w.org_access?.can_add_members||w.org_access?.can_request_membership)&&<Btn size="sm" onClick={()=>open('membership',w.kind==='PERSONAL'?uiText("Share personal workspace"):uiText("Add or request a member"),{workspace_id:w.id,beneficiary_id:'',member_role:'MEMBER',reason:''})}>{uiText("Add member")}</Btn>}
   {w.status==='ACTIVE'&&!w.deleted_at&&w.org_access?.can_remove_members&&<Btn size="sm" onClick={()=>open('remove',uiText("Remove workspace member"),{workspace_id:w.id,beneficiary_id:'',reason:''})}>{uiText("Remove member")}</Btn>}
   {w.org_access?.can_delete&&<Btn size="sm" onClick={()=>open('deleteWorkspace',uiText("Delete workspace"),{id:w.id,_name:w.name,expected_version:w.version,reason:''})}>{uiText("Delete workspace")}</Btn>}
   {w.org_access?.can_restore&&<Btn size="sm" onClick={()=>open('restoreWorkspace',uiText("Restore workspace"),{id:w.id,_name:w.name,expected_version:w.version,reason:''})}>{uiText("Restore workspace")}</Btn>}
   {!w.deleted_at&&w.kind==='LEGACY'&&w.owner_id===p.actor&&<Btn size="sm" onClick={()=>open('classify',uiText("Classify personal workspace"),{...p.data.tm_workspaces.find((r:Row)=>r.id===w.id),kind:'PERSONAL',expected_version:w.version,shared_member_ids:p.data.tm_members.filter((m:Row)=>m.workspace_id===w.id).map((m:Row)=>m.staff_id),reason:''})}>{uiText("Review personal classification")}</Btn>}
  </>;return <div className="org-actions">{buttons}</div>;})()}
 </article>;};
 const workspacesView=p.data.workspace_dashboard?<WorkspaceSections mini={mini} actor={p.actor} dashboard={p.data.workspace_dashboard} render={workspaceCard}
   actions={<>{tag}<Btn onClick={()=>choose('join')}>{uiText("Request to join")}</Btn><Btn variant="primary" icon={Plus} onClick={newWorkspace}>{uiText("New workspace")}</Btn></>}/>
  :<Empty mini={mini} title={uiText("Workspace viewing permission is required to open this dashboard.")}/>;
 const joinView=results(<>{rows.length?<div className="org-workspace-list">{rows.map(w=><article className="org-card org-ws-card" key={w.id}>
   <div className="org-card-head"><h3 className="org-card-title">{w.name}</h3><Badge label={KIND[w.kind||'ORGANIZATIONAL']} tone="info"/></div>
   {w.owner_id&&<p className="org-muted">{uiText("Owner: ")}{name(w.owner_id)}</p>}{w.governing_manager_id&&<p className="org-muted">{uiText("Level 2 manager: ")}{name(w.governing_manager_id)}</p>}
   <div className="org-actions"><Btn size="sm" onClick={()=>open('membership',uiText("Request to join"),{workspace_id:w.id,_workspace:w.name,beneficiary_id:p.actor,self_join:true,member_role:'MEMBER',reason:''})}>{uiText("Request membership")}</Btn></div>
  </article>)}</div>
  :<Empty mini={mini} icon={q?SearchX:GitBranch} title={q?uiText("No workspaces match “{p0}”", { p0: q }):uiText("No workspaces are open for join requests")} description={q?undefined:uiText("Organizational workspaces appear here when their owner lists them in the join directory and you are not a member yet.")} action={clearSearch}/>}
  <Pager total={value?.total||0} page={page} size={30} onPage={setPage} noun={['workspace','workspaces']}/></>);

 // ---------------------------------------------------------------- migration and settings
 const migrationView=results(value&&<div className="org-card org-section-card"><h2 className="org-card-title">{uiText("Explicit migration review")}</h2><p className="org-muted">{value.policy}</p>
   {!!value.employees?.length&&<><h3>{value.employees.length} {plural(value.employees.length,uiText("employee needs"),uiText("employees need"))} {uiText("a level assignment")}</h3><div className="table-wrap org-table"><table className="data-table"><thead><tr><th>{uiText("Employee")}</th><th>{uiText("Existing manager")}</th><th><span className="sr-only">{uiText("Review")}</span></th></tr></thead><tbody>{value.employees.map((r:Row)=><tr key={r.staff_id}><td><span className="cell-stack"><span className="cell-title"><Identity name={r.name}/></span><small>{r.staff_id}</small></span></td><td>{r.manager_id?name(r.manager_id):<span className="org-muted">{uiText("Unassigned")}</span>}</td><td className="align-right"><Btn size="sm" disabled={!org.enabled} onClick={()=>change(r)}>{uiText("Assign level")}</Btn></td></tr>)}</tbody></table></div></>}
   {!!value.workspaces?.length&&<><h3>{value.workspaces.length} {uiText("legacy ")}{plural(value.workspaces.length,uiText("workspace needs"),uiText("workspaces need"))} classification</h3><p className="org-muted">{uiText("Records and valid memberships are retained. Personal classification requires the existing owner’s explicit sharing decision.")}</p>
    <ul className="org-plain-list org-migration">{value.workspaces.map((w:Row)=><li key={w.id} className="org-task-row"><span><strong>{w.name}</strong><small>{w.task_count} {plural(w.task_count,'task')} · {w.member_count} {plural(w.member_count,'member')} {uiText("· owner ")}{name(w.owner_id)}</small></span><Btn size="sm" disabled={!org.enabled} onClick={()=>open('classify',uiText("Classify legacy workspace"),{...w,kind:'ORGANIZATIONAL',expected_version:w.version,shared_member_ids:p.data.tm_members.filter((m:Row)=>m.workspace_id===w.id).map((m:Row)=>m.staff_id),reason:''})}>{uiText("Review classification")}</Btn></li>)}</ul></>}
   {!value.employees?.length&&!value.workspaces?.length&&<Empty icon={CheckCircle2} title={uiText("Nothing is waiting for migration review")} description={uiText("Every employee has a level and every legacy workspace has been classified.")}/>}
  </div>);
 const settingsView=<div className="org-workspace-list org-settings">
  <section className="org-card"><h2 className="org-card-title">{uiText("Organizational levels")}</h2><p className="org-muted">{uiText("Level numbers enforce reporting order. Labels are configurable.")}</p>
   <ul className="org-plain-list">{org.levels?.map((l:Row)=><li className="org-task-row" key={l.id}><span>{uiText("Level ")}{l.id} · {l.name}</span><Btn size="sm" variant="ghost" onClick={()=>open('level',uiText("Configure level"),{level:l.id,name:l.name})}>{uiText("Edit")}</Btn></li>)}</ul>
   <Btn size="sm" icon={Plus} onClick={()=>open('level',uiText("Add organizational level"),{level:Math.max(0,...(org.levels||[]).map((l:Row)=>l.id))+1,name:''})}>{uiText("Add level")}</Btn></section>
  <section className="org-card"><h2 className="org-card-title">{uiText("Title templates")}</h2><p className="org-muted">{uiText("Approval records freeze the granted capabilities. Renaming a title does not change active grants.")}</p>
   <ul className="org-plain-list">{org.templates?.map((t:Row)=><li className="org-task-row" key={t.id}><span>{t.name}{!t.active&&<> <Badge label={uiText("Inactive")}/></>}<small>{caps(t.capabilities)}</small></span><Btn size="sm" variant="ghost" onClick={()=>open('template',uiText("Configure title template"),{...t})}>{uiText("Edit")}</Btn></li>)}</ul>
   <Btn size="sm" icon={Plus} onClick={()=>open('template',uiText("New title template"),{name:'',capabilities:[],active:true})}>{uiText("Add title")}</Btn></section>
 </div>;

 // ---------------------------------------------------------------- toolbar per tab (search and filters left; level and primary actions right)
 const toolbar=tab==='people'?<Bar search={search(uiText("Search organization"),mini?uiText("Search name or department…"):uiText("Search name, employee ID or department…"))}
   filters={!mini&&<div role="group" aria-label={uiText("Show")} className="segmented org-segmented">{[['tree',uiText("Tree"),GitBranch],['list',uiText("Table"),List]].map(([v,l,Icon]:any)=><button key={v} type="button" aria-pressed={mode===v} onClick={()=>{setMode(v);setPage(1);}}><Icon aria-hidden="true"/><span>{l}</span></button>)}</div>}
   actions={<>{tag}{canManage&&me.is_admin&&<Btn variant="primary" icon={Plus} onClick={()=>change({staff_id:'',org_level:3})}>{uiText("Assign employee")}</Btn>}</>}/>
  :tab==='join'?<Bar search={search(uiText("Search workspaces"),uiText("Search workspaces you can join…"))} actions={<>{tag}<Btn onClick={()=>choose('workspaces')}>{uiText("Back to workspaces")}</Btn></>}/>
  :tab==='requests'?<Bar search={search(uiText("Search requests"),uiText("Search reason or request number…"))}
   filters={<><FilterPick mini={mini} label={uiText("Status")} value={filters.status||''} onChange={v=>setFilter('status',v)} options={Object.entries(STATUS).filter(([k])=>['PENDING','REVIEW','APPROVED','REJECTED','CANCELLED'].includes(k)).map(([k,[l]])=>[k,l])} allLabel="All statuses"/><Toggle mini={mini} label={uiText("Waiting for me")} pressed={!!filters.mine} onChange={v=>setFilter('mine',v?'1':'')}/></>} actions={tag}/>
  :tab==='audit'?(mini?<details className="org-filter-drawer"><summary>{uiText("Filters")}{historyChips.length?uiText(" ({p0})", { p0: historyChips.length }):''}</summary><div className="filter-grid org-filter-grid">{historyFilters}{historyChips.length>0&&<Btn onClick={()=>{setFilters({});setPage(1);}}>{uiText("Reset filters")}</Btn>}</div></details>
   :<Bar filters={historyFilters} actions={tag} status={historyChips.length?<FilterChips items={historyChips} onReset={()=>{setFilters({});setPage(1);}}/>:undefined}/>)
  :tab==='migration'?<Bar actions={<>{tag}{me.can_initialize&&<Btn variant="primary" onClick={()=>open('initialize',uiText("Assign initial organization administrator"),{level1_ids:[p.actor],reason:''})}>{uiText("Initialize organization")}</Btn>}</>}/>
  :tab==='settings'?<Bar actions={tag}/>:null;

 return <section className={cx('org-page',mini&&'org-mini')} aria-labelledby="org-page-title">
  {/* V5.6.8: compact header as on the other Task Management pages (the title is in the sidebar / back bar). */}
  <h1 id="org-page-title" className="sr-only">{uiText("Organizational Structure")}</h1>
  <nav className={mini?"org-tabs org-tabs-mini":"section-tabs org-tabs"} aria-label={uiText("Organization views")}><div className={mini?'chips':'section-tabs-track'}>
   {tabs.filter(([id])=>canManage||id==='people').map(([id,Icon,label,count])=><button key={id} type="button" className={mini?'chip':'section-tab'} aria-current={current(id)?'page':undefined} onClick={()=>choose(id)}>{!mini&&<Icon aria-hidden="true"/>}<span>{label}</span>{count?<span className={mini?'chip-count':'section-tab-count'}>{count}</span>:null}</button>)}
  </div></nav>
  {!org.enabled&&<Note tone="info" title={uiText("Governance is not initialized")} action={me.can_initialize&&!mini?<Btn size="sm" onClick={()=>choose('migration')}>{uiText("Review migration")}</Btn>:undefined}>{uiText("Legacy data and access are preserved. ")}{me.can_initialize?uiText("Review migration and explicitly assign your first Level 1 administrators."):uiText("An existing company administrator can initialize it in the Task Controlling Management.")}</Note>}
  {notice&&<Note tone="success" live action={<button type="button" className="org-dismiss" onClick={()=>setNotice('')} aria-label={uiText("Dismiss confirmation")}><X aria-hidden="true"/></button>}>{notice}</Note>}
  {toolbar}
  {tab==='people'?peopleView:tab==='workspaces'?workspacesView:tab==='join'?<><div className="org-subhead"><h2>{uiText("Request to join a workspace")}</h2><p className="org-muted">{uiText("Ask to join an organizational workspace. Its Level 2 manager decides; access begins after approval.")}</p></div>{joinView}</>
   :tab==='requests'?requestsView:tab==='audit'?historyView:tab==='migration'?migrationView:tab==='settings'&&me.is_admin?settingsView:null}
  <details className="disclosure org-policy"><summary>{uiText("How access works")}</summary><div className="disclosure-body"><p>{uiText("Public workspaces are visible to their owner, authorized members and the owner’s direct and indirect reporting managers. Personal workspaces are private to their owner and the Administration role; adding another member makes them Public. Organizational rank alone grants no workspace access. Existing task participation remains separately authorized. View permission is read-only; Create enables authorized organizational management. Calendar notes and Personal Groups retain their owner-only protection. Titles alone grant nothing. Notifications go to participants and responsible approvers.")}</p></div></details>
  {canManage&&edit&&<OrganizationEditor p={p} edit={edit} close={()=>setEdit(null)} run={action} revision={org.revision} name={name} wsName={wsName}/>}
 </section>;
}

function PersonRow({r,meta,selected,onSelect}:{r:Row;meta:string;selected:boolean;onSelect:()=>void}){
  useLanguage();
 const id=useId();
 return <li><button type="button" className={cx("list-row org-person-row",selected&&'is-selected')} aria-labelledby={`${id}-n`} aria-describedby={`${id}-m`} aria-current={selected||undefined} onClick={onSelect}>
  <span className="avatar avatar-sm" aria-hidden="true">{String(r.name||'?').slice(0,1).toUpperCase()}</span>
  <span className="row-main"><span className="row-title" id={`${id}-n`}><Identity name={r.name}/></span><span className="row-meta" id={`${id}-m`}>{meta}</span></span><ChevronRight className="chev" aria-hidden="true"/></button></li>;
}

function TreeNode({r,p,revision,selected,onSelect,meta}:{r:Row;p:Props;revision:unknown;selected:string;onSelect:(s:string)=>void;meta:(r:Row)=>string}){
  useLanguage();
 const [open,setOpen]=useState(false),[rows,setRows]=useState<Row[]>([]),[page,setPage]=useState(1),[total,setTotal]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const id=useId();
 // Children stay on screen (dimmed) while a branch reloads after a change.
 useEffect(()=>{if(!open)return;let live=true;setLoading(true);void p.read({view:'people',parent:r.staff_id,page,limit:30}).then(v=>{if(live){setRows(v.rows);setTotal(v.total);setError('');}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[open,p.read,r.staff_id,page,revision]);
 const reports=r.children?`${r.children} direct ${plural(r.children,'report')}`:'';
 return <li><div className={cx('org-node',selected===r.staff_id&&'is-selected')}>
  <button type="button" className="org-expand" disabled={!r.children} aria-label={uiText("{p0} {p1}", { p0: open?'Collapse':'Expand', p1: r.name })} aria-expanded={r.children?open:undefined} onClick={()=>setOpen(v=>!v)}>{open?<ChevronDown aria-hidden="true"/>:<ChevronRight aria-hidden="true"/>}</button>
  <button type="button" className="org-node-person" aria-labelledby={`${id}-n`} aria-describedby={`${id}-m`} onClick={()=>onSelect(r.staff_id)}><span className="org-avatar" aria-hidden="true">{String(r.name||'?').slice(0,1).toUpperCase()}</span>
   <span className="org-node-text"><strong id={`${id}-n`}><Identity name={r.name}/></strong><small id={`${id}-m`}>{[meta(r),reports].filter(Boolean).join(' · ')}</small>{!!r.workspaces?.length&&<small>{r.workspaces.map((w:Row)=>w.name).join(' · ')}</small>}</span></button>
 </div>{open&&<>{loading&&!rows.length&&<p role="status" className="org-muted org-branch-status">{uiText("Loading…")}</p>}{error&&<p role="alert" className="field-error org-branch-status">{error}</p>}<ul className={cx('org-branch',loading&&rows.length>0&&'is-refreshing')}>{rows.map(x=><TreeNode key={x.staff_id} r={x} p={p} revision={revision} selected={selected} onSelect={onSelect} meta={meta}/>)}</ul><Pager total={total} page={page} size={30} onPage={setPage} noun={['person','people']}/></>}</li>;
}

/** Label + control + error/hint, with the Task Controlling Management's “*” for required fields (the control carries aria-required). */
function Fld({label,required,hint,error,wide,children}:{label:ReactNode;required?:boolean;hint?:ReactNode;error?:string;wide?:boolean;children:(f:{id:string;'aria-describedby'?:string;'aria-invalid'?:boolean;'aria-required'?:boolean})=>ReactNode}){
  useLanguage();
 const id=useId(),hintId=hint?`${id}-hint`:'',errorId=error?`${id}-error`:'';
 return <div className={cx('field',wide&&'span-2',error&&'has-error')}>
  <label htmlFor={id} className="field-label">{label}{required&&<span className="field-required" aria-hidden="true">*</span>}</label>
  {children({id,'aria-describedby':[errorId,hintId].filter(Boolean).join(' ')||undefined,'aria-invalid':!!error||undefined,'aria-required':required||undefined})}
  {error&&<p id={errorId} className="field-error"><AlertCircle aria-hidden="true"/>{error}</p>}
  {hint&&<p id={hintId} className="field-hint">{hint}</p>}
 </div>;
}
function Check({label,checked,onChange,disabled,error}:{label:ReactNode;checked:boolean;onChange:(v:boolean)=>void;disabled?:boolean;error?:string}){
  useLanguage();
 const id=useId();
 return <div className={cx('org-check-field',error&&'has-error')}><label className="org-check"><input type="checkbox" className="org-checkbox" checked={checked} disabled={disabled} aria-invalid={!!error||undefined} aria-describedby={error?`${id}-e`:undefined} onChange={e=>onChange(e.target.checked)}/><span>{label}</span></label>{error&&<p id={`${id}-e`} className="field-error"><AlertCircle aria-hidden="true"/>{error}</p>}</div>;
}

function OrganizationEditor({p,edit,close,run,revision,name,wsName}:{p:Props;edit:Edit;close:()=>void;run:Props['perform'];revision:number;name:(id:string)=>string;wsName:(id:string,fallback?:string)=>string}){
  useLanguage();
 const mini=!!p.mini;
 const [d,setD]=useState<Row>(()=>({...edit.data,request_key:uuid()})),[busy,setBusy]=useState(false),[previewing,setPreviewing]=useState(false),[formError,setFormError]=useState(''),[errors,setErrors]=useState<Record<string,string>>({}),[impact,setImpact]=useState<Row|null>(null),[ack,setAck]=useState(false),[dirty,setDirty]=useState(false),[discard,setDiscard]=useState(false);
 const [openedRevision]=useState(revision);
 const keepButton=useRef<HTMLButtonElement>(null),returnFocus=useRef<HTMLElement|null>(null),returnScroll=useRef(0),previewSequence=useRef(0),body=useRef<HTMLDivElement>(null),impactRef=useRef<HTMLDivElement>(null);
 const dialog=useRef<HTMLDialogElement>(null),org=p.data.organization,me=org.me||{},kind=edit.kind,manager=!!(me.is_admin||me.is_governor);
 const titleId=useId(),discardTitleId=useId(),discardTextId=useId();
 useEffect(()=>{const element=dialog.current;element?.showModal();return()=>{previewSequence.current++;element?.close();};},[]);
 useEffect(()=>{
  if(discard)keepButton.current?.focus();
  else if(returnFocus.current){returnFocus.current.focus({preventScroll:true});if(body.current)body.current.scrollTop=returnScroll.current;returnFocus.current=null;}
 },[discard]);
 const clearError=(key:string)=>{setErrors(e=>{if(!e[key])return e;const n={...e};delete n[key];return n;});setFormError('');};
 const set=(k:string,v:any,errorKey=k)=>{setD(s=>({...s,[k]:v}));setDirty(true);clearError(errorKey);if(['changes','id','grant_id','owner_id','governing_manager_id','owner_grant_id','kind'].includes(k)){previewSequence.current++;setPreviewing(false);setImpact(null);setAck(false);}};
 const people:[string,string][]=(org.directory||p.data.tm_people||[]).map((x:Row)=>[x.staff_id,x.name]),workspaces=p.data.tm_workspaces||[];
 const pick=(key:string,label:string,options:[string,string][],o:{required?:boolean;none?:string;hint?:ReactNode;value?:string;onChange?:(v:string)=>void;disabled?:boolean;wide?:boolean}={})=><Fld key={key} label={label} required={o.required} hint={o.hint} error={errors[key]} wide={o.wide}>{f=><select {...f} className="org-control org-select" value={o.value??d[key]??''} disabled={o.disabled||busy} onChange={e=>(o.onChange||(v=>set(key,v)))(e.target.value)}>{o.none!==undefined&&<option value="">{o.none}</option>}{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>}</Fld>;
 const text=(key:string,label:string,o:{type?:string;required?:boolean;hint?:ReactNode;textarea?:boolean;wide?:boolean}={})=><Fld key={key} label={label} required={o.required} hint={o.hint} error={errors[key]} wide={o.wide}>{f=>o.textarea?<textarea {...f} className="org-control" rows={3} disabled={busy} value={d[key]??''} onChange={e=>set(key,e.target.value)}/>:<input {...f} type={o.type||'text'} className="org-control" disabled={busy} value={d[key]??''} onChange={e=>set(key,o.type==='number'?Number(e.target.value):e.target.value)}/>}</Fld>;
 const supportingGrant=org.grants?.find((g:Row)=>g.id===d.parent_grant_id);
 const template=org.templates?.find((t:Row)=>t.id===d.template_id);
 const allowedCapabilities=(template?.capabilities||[]).filter((k:string)=>manager||supportingGrant?.capabilities.includes(k));
 const capsField=<fieldset className="org-fieldset span-2"><legend className="field-label">{uiText("Explicit capabilities")}</legend><div className="org-check-list">{Object.entries(org.capabilities||{}).map(([k,label]:any)=><Check key={k} label={label} disabled={busy||kind==='delegation'&&!allowedCapabilities.includes(k)} checked={(d.capabilities||[]).includes(k)} onChange={v=>set('capabilities',v?[...(d.capabilities||[]),k]:d.capabilities.filter((x:string)=>x!==k))}/>)}</div></fieldset>;
 const requestStructure=kind==='decision'&&d.kind==='STRUCTURE'&&d.decision==='APPROVE';
 const needsPreview=kind==='structure'||kind==='revoke'||requestStructure||kind==='workspace'&&d.id&&d.kind==='ORGANIZATIONAL';
 const hasReason=!['decision','cancel','level','template'].includes(kind);
 const preview=async()=>{const seq=++previewSequence.current;setPreviewing(true);setFormError('');try{const r=await p.perform('org.preview',kind==='revoke'?{grant_id:d.id}:kind==='workspace'?{workspace_id:d.id}:{changes:requestStructure?d.payload.changes:d.changes},{quiet:true});if(seq===previewSequence.current){setImpact(r);setAck(false);clearError('ack');requestAnimationFrame(()=>impactRef.current?.scrollIntoView({block:'nearest',behavior:'smooth'}));}}catch(e){if(seq===previewSequence.current)setFormError((e as Error).message);}finally{if(seq===previewSequence.current)setPreviewing(false);}};
 const dismiss=()=>{if(busy)return;if(discard){setDiscard(false);return;}if(dirty){returnFocus.current=document.activeElement as HTMLElement|null;returnScroll.current=body.current?.scrollTop||0;setDiscard(true);}else close();};
 const members=workspaces.find((w:Row)=>w.id===d.workspace_id),isPersonal=members?.visibility==='PERSONAL';
 const canCreateOrganization=manager||org.grants?.some((g:Row)=>g.capabilities.includes('workspace_create'));
 // V5.6.8: required fields are checked here and explained next to each field (noValidate: no browser bubbles).
 const missing=()=>{
  const m:Record<string,string>={};const need=(k:string,ok:unknown,msg:string)=>{if(!ok)m[k]=msg;};
  if(kind==='initialize')need('level1_ids',d.level1_ids?.length,uiText("Choose at least one Level 1 administrator."));
  if(kind==='structure')d.changes.forEach((c:Row,i:number)=>{need(`changes.${i}.staff_id`,c.staff_id,uiText("Select the employee."));if(c.level>1)need(`changes.${i}.manager_id`,c.manager_id,uiText("Select the reporting manager."));});
  if(kind==='delegation'){need('beneficiary_id',d.beneficiary_id,uiText("Select the employee."));if(!manager)need('parent_grant_id',d.parent_grant_id,uiText("Select your supporting grant."));}
  if(['membership','remove'].includes(kind))need('beneficiary_id',d.beneficiary_id,uiText("Select the employee."));
  if(kind==='workspace'){need('name',String(d.name||'').trim(),uiText("Enter the workspace name."));if(d.kind==='ORGANIZATIONAL')need('owner_id',d.owner_id,uiText("Select the operational owner."));}
  if(kind==='classify'||kind==='deleteWorkspace'||kind==='restoreWorkspace')need('acknowledged',d.acknowledged,uiText("Confirm before you continue."));
  if(kind==='decision'&&d.decision==='REJECT')need('note',String(d.note||'').trim(),uiText("Enter the reason for rejecting."));
  if(kind==='level'){need('level',Number(d.level)>0,uiText("Enter the level number."));need('name',String(d.name||'').trim(),uiText("Enter the level label."));}
  if(kind==='template')need('name',String(d.name||'').trim(),uiText("Enter the title label."));
  if(hasReason)need('reason',String(d.reason||'').trim(),uiText("Enter the reason."));
  return m;
 };
 const focusFirstError=()=>requestAnimationFrame(()=>(dialog.current?.querySelector('[aria-invalid=true]') as HTMLElement|null)?.focus());
 const submit=async(e:FormEvent)=>{e.preventDefault();if(busy)return;setFormError('');
  const m=missing(),n=Object.keys(m).length;
  if(n){setErrors(m);setFormError(n===1?uiText("Complete the highlighted field."):`Complete the ${n} highlighted fields.`);focusFirstError();return;}
  if(needsPreview&&!impact){setFormError(uiText("Preview the affected scope before saving."));requestAnimationFrame(()=>(dialog.current?.querySelector('.org-preview-button') as HTMLElement|null)?.focus());return;}
  if(needsPreview&&!ack){setErrors({ack:'Confirm that you reviewed the affected scope.'});setFormError(uiText("Confirm that you reviewed the affected scope."));focusFirstError();return;}
  setBusy(true);try{
  const shown=Object.fromEntries(Object.entries(d).filter(([k])=>!k.startsWith('_')));
  let action='';let payload:Row={...shown,expected_revision:impact?.revision??openedRevision,acknowledged:ack||kind==='classify'&&d.acknowledged};
  if(kind==='deleteWorkspace'||kind==='restoreWorkspace'){action=kind==='deleteWorkspace'?'org.workspace.delete':'org.workspace.restore';payload.acknowledged=d.acknowledged;}else if(kind==='initialize')action='org.initialize';else if(kind==='structure')action=manager?'org.structure.save':'org.structure.request';else if(kind==='delegation')action='org.delegation.request';else if(kind==='membership')action='org.membership.request';else if(kind==='remove')action='org.membership.remove';else if(kind==='workspace')action='org.workspace.save';else if(kind==='classify')action='org.workspace.classify';else if(kind==='decision'){action='org.request.decide';payload={id:d.id,expected_version:d.version,expected_revision:impact?.revision??openedRevision,decision:d.decision,note:d.note,acknowledged:ack};}else if(kind==='cancel')action='org.request.cancel';else if(kind==='revoke')action='org.grant.revoke';else if(kind==='level')action='org.level.save';else if(kind==='template')action='org.template.save';
  await run(action,payload);close();
 }catch(err){setFormError((err as Error).message);if(body.current)body.current.scrollTop=0;}finally{setBusy(false);}};
 const levelOptions:[string,string][]=(org.levels||[]).filter((l:Row)=>me.is_admin||l.id>=3).map((l:Row)=>[String(l.id),`Level ${l.id} · ${l.name}`]);
 const levelOf=(id:string)=>p.data.tm_profiles?.find((pr:Row)=>pr.staff_id===id)?.org_level as number|undefined;
 const setChange=(i:number,k:string,v:any)=>set('changes',d.changes.map((x:Row,j:number)=>i===j?{...x,[k]:v}:x),`changes.${i}.${k}`);
 const governingManagers=people.filter(([id])=>p.data.tm_profiles?.some((pr:Row)=>pr.staff_id===id&&pr.org_level===2));
 const grantOptions:[string,string][]=[...(org.grants||[]).map((g:Row)=>[g.id,g.workspace_id?`${g.title} · ${wsName(g.workspace_id)}`:g.title] as [string,string]),...(d.owner_grant_id&&!(org.grants||[]).some((g:Row)=>g.id===d.owner_grant_id)?[[d.owner_grant_id,d.owner_grant_id] as [string,string]]:[])];
 const description=kind==='decision'?`${REQUEST_KIND[d.kind]||sentence(d.kind)} from ${name(d.requester_id)}`:kind==='cancel'?undefined:['deleteWorkspace','restoreWorkspace'].includes(kind)?d._name:['membership','remove'].includes(kind)?(members?.name||d._workspace||wsName(d.workspace_id)):uiText("Fields marked * are required.");
 const size=discard?'dialog-sm':['structure','workspace','delegation'].includes(kind)||requestStructure?'dialog-lg':'dialog-md';
 const primary=kind==='decision'?(d.decision==='APPROVE'?uiText("Approve request"):uiText("Reject request")):kind==='structure'&&!manager?uiText("Submit for approval"):kind==='cancel'?uiText("Cancel request"):kind==='deleteWorkspace'?uiText("Delete workspace"):kind==='restoreWorkspace'?uiText("Restore workspace"):kind==='revoke'?uiText("Revoke authority"):uiText("Save");
 const danger=kind==='deleteWorkspace'||kind==='revoke'||kind==='decision'&&d.decision==='REJECT';
 const form=<div className="org-form">
  {kind==='initialize'&&<><p className="span-2">{uiText("Choose at least one active employee as a company Level 1 administrator. Existing platform roles and workspace classifications are retained.")}</p>
   <fieldset className={cx("org-fieldset span-2",errors.level1_ids&&'has-error')}><legend className="field-label">{uiText("Initial Level 1 administrators")}<span className="field-required" aria-hidden="true">*</span></legend><div className="org-check-list">{people.map(([id,label])=><Check key={id} label={label} disabled={busy} checked={d.level1_ids.includes(id)} onChange={v=>set('level1_ids',v?[...d.level1_ids,id]:d.level1_ids.filter((k:string)=>k!==id))}/>)}</div>{errors.level1_ids&&<p className="field-error"><AlertCircle aria-hidden="true"/>{errors.level1_ids}</p>}</fieldset></>}
  {kind==='structure'&&<><p className="span-2">{uiText("Move a branch by changing its reporting manager. Add related level changes to save them in the same transaction. The original task owners and reviewers stay unchanged.")}</p>
   {d.changes.map((c:Row,i:number)=><div className="org-change span-2" key={i}>
    {d.changes.length>1&&<div className="org-change-head"><strong>{uiText("Change ")}{i+1}</strong><Btn variant="ghost" size="sm" disabled={busy} onClick={()=>set('changes',d.changes.filter((_:any,j:number)=>i!==j))}>{uiText("Remove change")}</Btn></div>}
    <div className="org-change-grid">
     {pick(`changes.${i}.staff_id`,uiText("Employee"),people,{required:true,none:uiText("Select employee"),value:c.staff_id||'',onChange:v=>setChange(i,'staff_id',v||null)})}
     {pick(`changes.${i}.manager_id`,uiText("Reporting manager"),people,{required:c.level>1,none:uiText("Nobody (top of the organization)"),value:c.manager_id||'',onChange:v=>setChange(i,'manager_id',v||null)})}
     {pick(`changes.${i}.level`,uiText("Organizational level"),levelOptions,{none:uiText("Not mapped"),value:c.level?String(c.level):'',onChange:v=>setChange(i,'level',v?Number(v):null)})}
    </div>
    {c.staff_id&&<fieldset className="org-fieldset"><legend className="field-label">{uiText("Additional reporting managers")}</legend>
     <p className="field-hint">{uiText("Optional. The primary manager keeps levels, Level 2 governance and approvals. An additional manager sees this employee’s work only where the employee chooses them as a responsible manager.")}</p>
     <div className="org-check-list">{people.filter(([id])=>{const lv=levelOf(id);return id!==c.staff_id&&id!==c.manager_id&&!!lv&&!!c.level&&lv<c.level&&(c.level>=3?lv>=2:lv===1);}).map(([id,label])=><Check key={id} label={label} disabled={busy} checked={(c.additional_manager_ids??[]).includes(id)} onChange={v=>setChange(i,'additional_manager_ids',v?[...(c.additional_manager_ids??[]),id]:(c.additional_manager_ids??[]).filter((x:string)=>x!==id))}/>)}</div></fieldset>}
    </div>)}
   <div className="span-2"><Btn size="sm" icon={Plus} disabled={busy} onClick={()=>set('changes',[...d.changes,{staff_id:'',level:3,manager_id:''}])}>{uiText("Add related employee change")}</Btn></div></>}
  {kind==='delegation'&&<>{pick('beneficiary_id',uiText("Employee"),people,{required:true,none:uiText("Select employee")})}
   {pick('template_id',uiText("Title template"),(org.templates||[]).filter((t:Row)=>t.active).map((t:Row)=>[t.id,t.name]),{required:true,onChange:v=>{const t=org.templates.find((t:Row)=>t.id===v);setD(s=>({...s,template_id:v,capabilities:(t?.capabilities||[]).filter((k:string)=>manager||supportingGrant?.capabilities.includes(k))}));setDirty(true);}})}
   {capsField}
   {pick('workspace_id',uiText("Workspace scope"),workspaces.filter((w:Row)=>w.kind==='ORGANIZATIONAL').map((w:Row)=>[w.id,w.name]),{none:uiText("Approved reporting branch")})}
   {!manager&&pick('parent_grant_id',uiText("Supporting grant"),(org.grants||[]).filter((g:Row)=>g.capabilities.includes('delegate_request')).map((g:Row)=>[g.id,g.workspace_id?`${g.title} · ${wsName(g.workspace_id)}`:g.title]),{required:true,none:uiText("Select your authority"),onChange:v=>{const g=org.grants.find((g:Row)=>g.id===v);setD(s=>({...s,parent_grant_id:v,workspace_id:g?.workspace_id||'',capabilities:(template?.capabilities||[]).filter((k:string)=>g?.capabilities.includes(k))}));setDirty(true);clearError('parent_grant_id');}})}
   <p className="field-hint span-2">{uiText("The responsible Level 2 manager is derived from the employee’s reporting branch. Pending capabilities cannot be used.")}</p></>}
  {['membership','remove'].includes(kind)&&<>{d.self_join?<p className="span-2">{uiText("You are asking to join ")}<strong>{members?.name||d._workspace||wsName(d.workspace_id)}</strong>.</p>
    :pick('beneficiary_id',kind==='remove'?uiText("Member to remove"):uiText("Employee"),(kind==='remove'?(p.data.tm_members||[]).filter((m:Row)=>m.workspace_id===d.workspace_id&&m.staff_id!==members?.owner_id).map((m:Row)=>({id:m.staff_id,name:name(m.staff_id)})):members?.org_access?.can_add_members?members.org_access.member_candidates:people.map(([id,n])=>({id,name:n}))).map((x:Row)=>[x.id,x.name]),{required:true,none:uiText("Select employee"),wide:true})}
   {kind==='membership'&&<>{pick('member_role',uiText("Requested role"),[['MEMBER',uiText("Member")],['VIEWER',uiText("Viewer")]],{required:true,wide:true})}<p className="field-hint span-2">{d.self_join?uiText("Access begins when the responsible manager approves your request."):isPersonal?uiText("The workspace stays Personal: only its owner, members and authorized Administration can open it."):members?.org_access?.can_add_members?uiText("Your authorized approval will be recorded with this addition."):uiText("Access begins only after the governing Level 2 manager approves.")}</p></>}
   {kind==='remove'&&<p className="field-hint span-2">{uiText("Membership access ends immediately. Independently authorized task/meeting participation is retained.")}</p>}</>}
  {['workspace','classify'].includes(kind)&&<>{kind==='workspace'&&<>{text('name',uiText("Workspace name"),{required:true})}{text('department',uiText("Department"))}{text('description',uiText("Description"),{textarea:true,wide:true})}</>}
   {pick('kind',uiText("Classification"),[['PERSONAL',uiText("Personal — owner only")],['PUBLIC',uiText("Public — owner managed")],...(kind!=='workspace'||d.id||canCreateOrganization?[['ORGANIZATIONAL',uiText("Organizational — governed by Level 2")] as [string,string]]:[])],{required:true,wide:true,value:d.kind==='PERSONAL'&&d.visibility==='PUBLIC'?'PUBLIC':d.kind,disabled:kind==='workspace'&&!!d.id,onChange:v=>{set('kind',v);if(v==='PERSONAL'||v==='PUBLIC')set('owner_id',p.actor);else if(me.is_admin&&!d.id)set('owner_id','');}})}
   {['PERSONAL','PUBLIC'].includes(d.kind)?<p className="field-hint span-2">{uiText("Owner: ")}{name(d.owner_id)}{uiText(". New workspaces start with only their owner. A Personal workspace stays Personal when members are added; choose responsible managers in My Workspaces. Use the separate Add member action.")}</p>:<>
    {pick('owner_id',uiText("Operational owner"),people,{required:true,none:uiText("Select employee")})}
    {pick('governing_manager_id',uiText("Responsible Level 2 manager"),governingManagers,{none:uiText("From the owner’s reporting branch"),hint:uiText("If empty, the manager is derived from the owner’s reporting branch.")})}
    {pick('owner_grant_id',uiText("Owner grant"),grantOptions,{none:uiText("Use a matching active grant"),hint:uiText("Delegated owners need an approved grant.")})}
    {pick('origin_workspace_id',uiText("Originating workspace"),[...(d.origin_workspace_id&&!workspaces.some((w:Row)=>w.id===d.origin_workspace_id)?[[d.origin_workspace_id,wsName(d.origin_workspace_id)] as [string,string]]:[]),...workspaces.filter((w:Row)=>w.kind==='ORGANIZATIONAL'&&w.id!==d.id).map((w:Row)=>[w.id,w.name] as [string,string])],{none:uiText("None"),disabled:!!d.id&&!manager})}
    <div className="span-2"><Check label={uiText("List in the company join-request directory")} disabled={busy} checked={!!d.joinable} onChange={v=>set('joinable',v)}/></div></>}
   {kind==='classify'&&<><p className="span-2">{uiText("Existing records and memberships are preserved. Current members: ")}{(d.shared_member_ids||[]).map(name).join(', ')||uiText("None")}{uiText(". Unresolved legacy access remains unchanged until this classification is saved.")}</p><div className="span-2"><Check label={uiText("I reviewed the new access rules and confirm retained memberships and explicit personal sharing, where applicable.")} disabled={busy} checked={!!d.acknowledged} error={errors.acknowledged} onChange={v=>set('acknowledged',v)}/></div></>}</>}
  {kind==='decision'&&<><dl className="org-facts span-2">
    <div><dt>{uiText("Requested by")}</dt><dd>{name(d.requester_id)}</dd></div>{d.beneficiary_id&&d.beneficiary_id!==d.requester_id&&<div><dt>{uiText("For")}</dt><dd>{name(d.beneficiary_id)}</dd></div>}
    {d.workspace_id&&<div><dt>{uiText("Workspace")}</dt><dd>{wsName(d.workspace_id)}</dd></div>}{d.reason&&<div><dt>{uiText("Reason")}</dt><dd>{d.reason}</dd></div>}
    {!!d.payload?.changes?.length&&<div><dt>{uiText("Changes")}</dt><dd>{d.payload.changes.map((c:Row)=><span className="org-line" key={c.staff_id}>{name(c.staff_id)} {uiText("→ Level ")}{c.level}{uiText(", reports to ")}{c.manager_id?name(c.manager_id):'nobody'}{c.additional_manager_ids?.length?uiText(" and also to {p0}", { p0: c.additional_manager_ids.map(name).join(', ') }):''}</span>)}</dd></div>}
    {d.payload?.capabilities&&<div><dt>{uiText("Capabilities")}</dt><dd>{d.payload.capabilities.map((k:string)=>org.capabilities[k]).join(' · ')}</dd></div>}
   </dl>{text('note',uiText("Decision note"),{textarea:true,wide:true,required:d.decision==='REJECT',hint:d.decision==='REJECT'?uiText("The requester sees this note."):uiText("Optional. The requester sees this note.")})}</>}
  {kind==='cancel'&&<p className="span-2">{uiText("Withdraw this ")}{(REQUEST_KIND[d._kind]||'request').toLowerCase()}{uiText("? Its approver will no longer be asked to decide. You can submit a new request later.")}</p>}
  {kind==='level'&&<>{text('level',uiText("Level number"),{type:'number',required:true})}{text('name',uiText("Level label"),{required:true})}</>}
  {kind==='template'&&<>{text('name',uiText("Title label"),{required:true,wide:true})}{capsField}<div className="span-2"><Check label={uiText("Available for new requests")} disabled={busy} checked={!!d.active} onChange={v=>set('active',v)}/></div></>}
  {['deleteWorkspace','restoreWorkspace'].includes(kind)&&<><p className="span-2">{kind==='deleteWorkspace'?uiText("The workspace and its contents will be hidden and work will stop. Tasks, members and history are retained for recovery, and the people affected are told. Pending workspace requests are cancelled. It can be restored later from My Workspaces with “Show deleted”."):uiText("Restore the workspace with its previous status, members, tasks and history. Cancelled requests must be submitted again.")}</p><div className="span-2"><Check label={uiText("I confirm this workspace action.")} disabled={busy} checked={!!d.acknowledged} error={errors.acknowledged} onChange={v=>set('acknowledged',v)}/></div></>}
  {kind==='revoke'&&<p className="span-2">{uiText("Revoke ")}{d._title?uiText("“{p0}”", { p0: d._title }):uiText("this authority")}{d._beneficiary?uiText(" from {p0}", { p0: d._beneficiary }):''}{uiText(". Dependent grants will be re-evaluated. Workspaces need a valid replacement owner before this can be saved.")}</p>}
  {hasReason&&text('reason',uiText("Reason"),{textarea:true,required:true,wide:true})}
  {needsPreview&&<div className="span-2 org-preview"><Btn className="org-preview-button" disabled={busy||previewing} onClick={()=>void preview()}>{previewing?uiText("Loading preview…"):uiText("Preview affected scope")}</Btn>
   {impact&&<div className="org-impact" ref={impactRef}><h3>{uiText("Affected scope")}</h3>
    <p>{[[impact.impact.employees.length,'employee','employees'],[impact.impact.workspaces.length,'workspace','workspaces'],[impact.impact.grants.length,'grant','grants'],[impact.impact.memberships.length,"membership to review","memberships to review"],[impact.impact.requests.length,"pending request","pending requests"]].map(([n,one,many]:any)=>`${n} ${plural(n,one,many)}`).join(' · ')}</p>
    <details><summary>{uiText("Affected employees and pending requests")}</summary><p>{impact.impact.employees.map(name).join(', ')||uiText("No reporting changes")}</p><p>{impact.impact.requests.map((q:Row)=>`${REQUEST_KIND[q.kind]||"Request"} ${q.id}`).join(', ')||uiText("No pending requests")}</p></details>
    {impact.impact.workspaces.map((w:Row)=>{const replacement=(requestStructure?d.payload?.workspace_replacements||[]:d.workspace_replacements||[]).find((x:Row)=>x.id===w.id)||w;const replace=(key:string,value:string)=>set('workspace_replacements',[...(d.workspace_replacements||[]).filter((x:Row)=>x.id!==w.id),{...replacement,[key]:value}]);return <div key={w.id} className="org-change"><strong>{w.name}</strong><p className="org-muted">{uiText("Keep the existing authority if valid, or choose a responsible replacement.")}</p>
     {requestStructure&&<p>{uiText("Proposed owner: ")}{name(replacement.owner_id)} {uiText("· governing manager: ")}{name(replacement.governing_manager_id)}{replacement.owner_grant_id?uiText(" · with an approved owner grant"):''}</p>}
     {!requestStructure&&kind!=='workspace'&&<div className="org-change-grid">{pick(`replace.${w.id}.owner_id`,uiText("Replacement operational owner"),people,{value:replacement.owner_id||'',onChange:v=>replace('owner_id',v)})}{pick(`replace.${w.id}.governing_manager_id`,uiText("Replacement Level 2 manager"),people,{value:replacement.governing_manager_id||'',onChange:v=>replace('governing_manager_id',v)})}
      <Fld label={uiText("Replacement owner grant")} hint={uiText("Leave empty when the owner is a Level 2 manager.")}>{f=><input {...f} className="org-control" value={replacement.owner_grant_id||''} onChange={e=>replace('owner_grant_id',e.target.value)}/>}</Fld></div>}</div>;})}
    <Check label={uiText("I reviewed the affected scope and workspace responsibility. Independently valid memberships will be retained.")} disabled={busy} checked={ack} error={errors.ack} onChange={v=>{setAck(v);clearError('ack');}}/></div>}</div>}
 </div>;
 return <dialog className={cx('org-dialog',mini?"org-page org-mini":'dialog-surface',size)} data-state="open" ref={dialog} aria-labelledby={discard?discardTitleId:titleId} aria-describedby={discard?discardTextId:undefined} onCancel={e=>{e.preventDefault();dismiss();}}>
  {discard&&<section className="org-discard">
   <div className="confirm-body"><span className="confirm-icon tone-danger" aria-hidden="true"><AlertTriangle/></span><div className="confirm-text"><h2 id={discardTitleId} className="org-dialog-title">{uiText("Discard unsaved changes?")}</h2><p id={discardTextId} className="org-dialog-description">{uiText("Your changes have not been saved. Discard them to close this form, or keep editing.")}</p></div></div>
   <div className="confirm-footer"><button ref={keepButton} type="button" className="org-btn org-btn-outline" onClick={()=>setDiscard(false)}>{uiText("Keep editing")}</button><Btn variant="danger" onClick={close}>{uiText("Discard changes")}</Btn></div>
  </section>}
  <form className="dialog-form org-dialog-form" hidden={discard} onSubmit={submit} noValidate>
   <header className="dialog-header org-dialog-header"><h2 id={titleId} className="org-dialog-title">{edit.title}</h2>{description&&<p className="org-dialog-description">{description}</p>}</header>
   <div className="dialog-body org-dialog-body" ref={body}>
    {formError&&<Note tone="danger" title={uiText("This could not be saved")} live>{formError}</Note>}
    {form}
   </div>
   <div className="dialog-footer">{needsPreview&&!impact&&<span className="footer-note">{uiText("Preview the affected scope before saving.")}</span>}<Btn disabled={busy} onClick={dismiss}>{kind==='cancel'?uiText("Keep request"):uiText("Cancel")}</Btn><Btn type="submit" variant={danger?'danger':'primary'} disabled={busy||previewing} aria-busy={busy||undefined}>{busy?uiText("Saving…"):primary}</Btn></div>
  </form>
  {!discard&&<button type="button" className="org-dialog-close" aria-label={uiText("Close dialog")} onClick={dismiss}><X aria-hidden="true"/></button>}
 </dialog>;
}

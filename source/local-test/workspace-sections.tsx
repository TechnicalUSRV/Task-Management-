import {useState,type ComponentProps,type ReactNode} from 'react';
import {AlertCircle,Check,ChevronDown,Clock3,FolderKanban,Inbox,Search,SearchX,X,type LucideIcon} from 'lucide-react';
import {plural} from './format';
import './styles/organization.css';
type Row=Record<string,any>;

// V5.6.8: Workspace sections and Organizational Structure are shared by the Task Controlling Management and the Telegram Mini App. They do not import
// the Task Controlling Management UI kit (its Radix/Tailwind code would be added to the Mini App bundle). These small parts use the Task Controlling Management's own class names
// (button sizes, search box, filter toggles and selects, status badges, empty states), so they look like the rest of the Task Controlling Management;
// organization.css gives the same parts the Mini App's look under .org-mini.
export const cx=(...c:unknown[])=>c.filter(Boolean).join(' ');

type BtnProps=ComponentProps<'button'>&{variant?:'primary'|'outline'|'ghost'|'danger'|'link';size?:'sm';icon?:LucideIcon};
/** A button with the Task Controlling Management's sizes and variants (primary 36 px, sm 32 px; 44 px touch targets in the Mini App). */
export function Btn({variant='outline',size,icon:Icon,className,children,type='button',...rest}:BtnProps){
 return <button type={type} className={cx('org-btn',`org-btn-${variant}`,size&&`org-btn-${size}`,className)} {...rest}>{Icon&&<Icon aria-hidden="true"/>}{children}</button>;
}

/** Same markup as the Task Controlling Management SearchInput (search icon, clear button, Escape clears). */
export function SearchBox({value,onChange,label,placeholder='Search…',mini}:{value:string;onChange:(v:string)=>void;label:string;placeholder?:string;mini?:boolean}){
 return <div className="search-input org-search"><Search className="search-icon" aria-hidden="true"/>
  <input type="search" className={mini?'input':'control'} aria-label={label} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'&&value){e.stopPropagation();onChange('');}}}/>
  {value&&<button type="button" className="search-clear" aria-label="Clear search" onClick={()=>onChange('')}><X aria-hidden="true"/></button>}
 </div>;
}

/** Same markup as the Task Controlling Management ToggleFilter (an on/off filter button); a chip in the Mini App. */
export function Toggle({label,pressed,onChange,mini}:{label:ReactNode;pressed:boolean;onChange:(v:boolean)=>void;mini?:boolean}){
 return mini?<button type="button" className="chip org-chip" aria-pressed={pressed} onClick={()=>onChange(!pressed)}>{pressed&&<Check className="chip-icon" aria-hidden="true"/>}{label}</button>
  :<button type="button" className={cx('control filter-toggle',pressed&&'is-active')} aria-pressed={pressed} onClick={()=>onChange(!pressed)}><span className="filter-toggle-box" aria-hidden="true">{pressed&&<Check/>}</span>{label}</button>;
}

/** A filter choice that looks like the Task Controlling Management FilterSelect (“Manager  All managers ⌄”) and keeps a native list for the choice. */
export function FilterPick({label,value,onChange,options,allLabel='All',all=true,active,mini}:{label:string;value:string;onChange:(v:string)=>void;options:[string,string][];allLabel?:string;all?:boolean;active?:boolean;mini?:boolean}){
 const select=<select aria-label={label} className={mini?'input':undefined} value={value} onChange={e=>onChange(e.target.value)}>{all&&<option value="">{allLabel}</option>}{options.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>;
 if(mini)return <label className="mini-field org-mini-field"><span>{label}</span>{select}</label>;
 const shown=options.find(([v])=>v===value)?.[1]||allLabel;
 return <label className={cx('control filter-select org-filter-select',(active??!!value)&&'is-active')}><span className="filter-select-label">{label}</span><span className="org-filter-value" aria-hidden="true">{shown}</span><ChevronDown className="filter-chevron" aria-hidden="true"/>{select}</label>;
}

const TONE_ICON:Partial<Record<string,LucideIcon>>={success:Check,warning:Clock3,danger:AlertCircle};
/** Same markup as the Task Controlling Management StatusBadge: label + tone + shape cue. */
export function Badge({label,tone='neutral',title}:{label:ReactNode;tone?:string;title?:string}){
 const Icon=TONE_ICON[tone];
 return <span className={`badge tone-${tone}`} title={title}>{Icon?<Icon className="badge-icon" aria-hidden="true"/>:<span className="badge-dot" aria-hidden="true"/>}<span>{label}</span></span>;
}

/** Same markup as the Task Controlling Management EmptyState / NoResults (and the Mini App's empty card). */
export function Empty({icon:Icon=Inbox,title,description,action,mini}:{icon?:LucideIcon;title:ReactNode;description?:ReactNode;action?:ReactNode;mini?:boolean}){
 return mini?<div className="empty org-empty"><span className="empty-icon" aria-hidden="true"><Icon/></span><p className="empty-title">{title}</p>{description&&<p className="hint">{description}</p>}{action}</div>
  :<div className="state state-compact table-empty org-empty"><span className="state-icon" aria-hidden="true"><Icon/></span><p className="state-title">{title}</p>{description&&<p className="state-description">{description}</p>}{action&&<div className="state-actions">{action}</div>}</div>;
}

/** Same layout as the Task Controlling Management FilterBar: search, filters, then actions on the right; status (chips, counts) below. */
export function Bar({search,filters,actions,status,className}:{search?:ReactNode;filters?:ReactNode;actions?:ReactNode;status?:ReactNode;className?:string}){
 return <div className={cx('filter-bar org-bar',className)}><div className="filter-row">{search&&<div className="filter-search">{search}</div>}{filters&&<div className="filter-controls">{filters}</div>}{actions&&<div className="filter-actions">{actions}</div>}</div>{status&&<div className="filter-status">{status}</div>}</div>;
}

/** Active filters as removable chips with “Reset all” (as in the Task Controlling Management FilterBar). */
export function FilterChips({items,onReset}:{items:{key:string;label:string;clear:()=>void}[];onReset?:()=>void}){
 if(!items.length)return null;
 return <><ul className="filter-chips" aria-label="Active filters">{items.map(c=><li key={c.key} className="chip"><span>{c.label}</span><button type="button" aria-label={`Remove filter ${c.label}`} onClick={c.clear}><X aria-hidden="true"/></button></li>)}</ul>{items.length>1&&onReset&&<Btn variant="link" className="filter-reset" onClick={onReset}>Reset all</Btn>}</>;
}

/** Previous / Next, shown only when there is more than one page. */
export function Pager({total,page,size,onPage,noun=['result','results']}:{total:number;page:number;size:number;onPage:(n:number)=>void;noun?:[string,string]}){
 const pages=Math.max(1,Math.ceil(total/size));
 if(pages<=1)return null;
 return <div className="table-footer org-pager"><span className="table-count"><strong>{total}</strong> {plural(total,noun[0],noun[1])}</span><div className="pager"><span className="pager-text">Page {page} of {pages}</span><Btn size="sm" disabled={page<=1} onClick={()=>onPage(page-1)}>Previous</Btn><Btn size="sm" disabled={page>=pages} onClick={()=>onPage(page+1)}>Next</Btn></div></div>;
}

type Props={dashboard:Row;actor:string;render:(row:Row)=>ReactNode;actions?:ReactNode;mini?:boolean};
// Shared Web / Mini App navigation. These filters narrow the server-authorized dashboard only.
export function WorkspaceSections({dashboard:d,actor,render,actions,mini}:Props){
 const [query,setQuery]=useState(''),[archived,setArchived]=useState(false),[deleted,setDeleted]=useState(false);
 const [manager,setManager]=useState(''),[member,setMember]=useState(''),[hierarchy,setHierarchy]=useState('all'),[workspace,setWorkspace]=useState('');
 const people:Row[]=d.people||[],managed:Row[]=d.managed||[],my:Row[]=d.my||[],shared:Row[]=d.shared||[];
 const under=(staff:string,root:string)=>{const seen=new Set<string>();let at=people.find(p=>p.staff_id===staff)?.manager_id;while(at&&!seen.has(at)){if(at===root)return true;seen.add(at);at=people.find(p=>p.staff_id===at)?.manager_id;}return false;};
 const matches=(r:Row)=>(r.deleted_at?deleted:archived||r.status==='ACTIVE')&&`${r.name} ${r.department||''} ${r.description||''}`.toLowerCase().includes(query.trim().toLowerCase());
 const management=managed.filter(matches).filter(r=>(!manager||r.owner_id===manager||under(r.owner_id,manager))&&(!member||r.owner_id===member||r.member_ids?.includes(member))&&(hierarchy==='all'||people.find(p=>p.staff_id===r.owner_id)?.manager_id===(manager||actor))&&(!workspace||r.id===workspace));
 const mine=my.filter(matches),sharedRows=shared.filter(matches);
 const resetManagement=()=>{setManager('');setMember('');setHierarchy('all');setWorkspace('');};
 const managementActive=!!manager||!!member||hierarchy!=='all'||!!workspace;
 const clearSearch=<Btn size="sm" onClick={()=>setQuery('')}>Clear search</Btn>;
 const people2=(list:Row[])=>list.map(p=>[p.staff_id,p.name] as [string,string]);
 return <div className={cx('workspace-sections',mini&&'workspace-sections-mini')}>
  <Bar className="workspace-toolbar" search={<SearchBox mini={mini} value={query} onChange={setQuery} label="Search workspaces" placeholder={mini?'Search workspaces…':'Search name, department or description…'}/>}
   filters={<><Toggle mini={mini} label="Show archived" pressed={archived} onChange={setArchived}/><Toggle mini={mini} label="Show deleted" pressed={deleted} onChange={setDeleted}/></>} actions={actions}/>
  <section aria-label="My Workspaces" className="workspace-section"><h2>My Workspaces</h2><p className="workspace-section-note">Workspaces you created or directly own.</p>
   {mine.length?<WorkspacePage rows={mine} render={render} mini={mini}/>
    :query.trim()?<Empty mini={mini} icon={SearchX} title={`No workspaces match “${query.trim()}”`} description="Check the spelling or search for a department or description instead." action={clearSearch}/>
    :my.length?<Empty mini={mini} icon={FolderKanban} title="No workspaces match this view" description={archived||deleted?undefined:'Archived and deleted workspaces are hidden. Turn on “Show archived” or “Show deleted” to see them.'}/>
    :<Empty mini={mini} icon={FolderKanban} title="You don’t own any workspaces yet" description="Workspaces you create appear here."/>}
  </section>
  {d.has_management&&managed.length>0&&<details className="workspace-management"><summary><strong>Workspaces Under My Management</strong> <span className="workspace-count">({management.length})</span></summary>
   <p className="workspace-section-note">Browse your reporting hierarchy. Task totals include only work you are permitted to view.</p>
   {mini?<div className="filter-grid org-filter-grid">
     <FilterPick mini label="Manager" value={manager} onChange={v=>{setManager(v);setWorkspace('');}} options={people2(people.filter(p=>people.some(c=>c.manager_id===p.staff_id)))} allLabel="All managers"/>
     <FilterPick mini label="Member" value={member} onChange={setMember} options={people2(people)} allLabel="All members"/>
     <FilterPick mini label="Organizational hierarchy" value={hierarchy} onChange={setHierarchy} all={false} options={[['all','All levels'],['direct','Direct reports only']]}/>
     <FilterPick mini label="Workspace" value={workspace} onChange={setWorkspace} options={managed.map(w=>[w.id,w.name] as [string,string])} allLabel="All workspaces"/>
     {managementActive&&<Btn onClick={resetManagement}>Reset filters</Btn>}
    </div>
    :<Bar filters={<>
     <FilterPick label="Manager" value={manager} onChange={v=>{setManager(v);setWorkspace('');}} options={people2(people.filter(p=>people.some(c=>c.manager_id===p.staff_id)))} allLabel="All managers"/>
     <FilterPick label="Member" value={member} onChange={setMember} options={people2(people)} allLabel="All members"/>
     <FilterPick label="Organizational hierarchy" value={hierarchy} onChange={setHierarchy} all={false} active={hierarchy!=='all'} options={[['all','All levels'],['direct','Direct reports only']]}/>
     <FilterPick label="Workspace" value={workspace} onChange={setWorkspace} options={managed.map(w=>[w.id,w.name] as [string,string])} allLabel="All workspaces"/>
     {managementActive&&<Btn variant="link" className="filter-reset" onClick={resetManagement}>Reset filters</Btn>}</>}/>}
   {management.length?<WorkspacePage rows={management} render={render} mini={mini}/>
    :<Empty mini={mini} icon={SearchX} title="No workspaces match this management scope." action={managementActive?<Btn size="sm" onClick={resetManagement}>Reset filters</Btn>:query.trim()?clearSearch:undefined}/>}
  </details>}
  {!!shared.length&&<details className="workspace-shared"><summary><strong>Shared with me</strong> <span className="workspace-count">({sharedRows.length})</span></summary><p className="workspace-section-note">Other workspaces you can access through existing sharing or membership.</p>
   {sharedRows.length?<WorkspacePage rows={sharedRows} render={render} mini={mini}/>:<Empty mini={mini} icon={SearchX} title="No shared workspaces match these filters." action={query.trim()?clearSearch:undefined}/>}</details>}
 </div>;
}
function WorkspacePage({rows,render,mini}:{rows:Row[];render:(r:Row)=>ReactNode;mini?:boolean}){
 const [pagination,setPagination]=useState({key:'',page:1});const key=rows.map(r=>r.id).join('|'),page=key===pagination.key?pagination.page:1,size=8;
 return <><div className={mini?'org-workspace-list':'card-grid'}>{rows.slice((page-1)*size,page*size).map(render)}</div><Pager total={rows.length} page={page} size={size} noun={['workspace','workspaces']} onPage={n=>setPagination({key,page:n})}/></>;
}

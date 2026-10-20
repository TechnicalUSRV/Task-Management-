import {migrateWorkspacePrivacy,isPersonalWorkspace} from './workspace-privacy.mjs';
import {displayName} from './identity.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const ORG_CAPABILITIES={workspace_create:'Create delegated workspaces',workspace_manage:'Manage owned workspaces',membership_request:'Request workspace membership',delegate_request:'Request further delegation',structure_request:'Request reporting changes',collaborate_outside:'Invite outside task/meeting participants'};
const parse=(v,fallback={})=>{try{return JSON.parse(v);}catch{return fallback;}};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uniq=v=>[...new Set(v.filter(Boolean))];

// One company-local authority service. It never trusts employee/role/approver identifiers supplied as identity.
// All mutations run inside service.command's transaction; its revision is a compare-and-swap for governance edits.
export function createOrganization(c){
 const {db,get,all,run,insert,update,id,lookup,version,fail,str,integer,now,hooks}=c;
 db.exec(readFileSync(new URL('./organization.sql',import.meta.url),'utf8'));
 const add=(table,name,type)=>{if(!all(`PRAGMA table_info(${table})`).some(x=>x.name===name))run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
 db.exec('BEGIN IMMEDIATE');
 try{
  add('tm_profiles','org_level','INTEGER REFERENCES org_levels(id)');
  add('tm_workspaces','kind',"TEXT NOT NULL DEFAULT 'LEGACY' CHECK(kind IN('LEGACY','ORGANIZATIONAL','PERSONAL'))");
  add('tm_workspaces','governing_manager_id','TEXT REFERENCES lookups(id)');
  add('tm_workspaces','origin_workspace_id','TEXT REFERENCES tm_workspaces(id)');
  add('tm_workspaces','owner_grant_id','TEXT REFERENCES org_grants(id)');
  add('tm_workspaces','joinable','INTEGER NOT NULL DEFAULT 0');
  add('tm_workspaces','created_by','TEXT REFERENCES lookups(id)');
  add('tm_workspaces','deleted_at','TEXT');
  add('tm_workspaces','deleted_by','TEXT REFERENCES lookups(id)');
  add('tm_workspaces','deleted_from_status','TEXT');
  // Recover only recorded creation identity. Ownership is transferable and is not proof of creation.
  run(`UPDATE tm_workspaces SET created_by=COALESCE(
   (SELECT actor_id FROM org_audit a WHERE a.workspace_id=tm_workspaces.id AND a.action='workspace.created' ORDER BY a.id LIMIT 1),
   (SELECT actor_id FROM tm_events e WHERE e.workspace_id=tm_workspaces.id AND e.action='Workspace created' ORDER BY e.id LIMIT 1)) WHERE created_by IS NULL`);
  run('CREATE INDEX IF NOT EXISTS org_workspace_creator ON tm_workspaces(created_by,deleted_at)');
  run('INSERT OR IGNORE INTO schema_version(version) VALUES(14)');
  add('tm_members','approved_by','TEXT REFERENCES lookups(id)');
  add('tm_members','approval_id','TEXT REFERENCES org_requests(id)');
  add('tm_members','member_role',"TEXT NOT NULL DEFAULT 'MEMBER'");
  add('tm_members','joined_at','TEXT');
  add('tm_notifications','org_request_id','TEXT REFERENCES org_requests(id)');
  run('CREATE INDEX IF NOT EXISTS org_profile_level ON tm_profiles(org_level,manager_id)');
  run('CREATE INDEX IF NOT EXISTS org_workspace_governor ON tm_workspaces(governing_manager_id,kind)');
  run('INSERT OR IGNORE INTO schema_version(version) VALUES(13)');
  run('INSERT OR IGNORE INTO org_templates(id,name,capabilities_json) VALUES(?,?,?)','OWNER','Owner',JSON.stringify(Object.keys(ORG_CAPABILITIES)));
  migrateWorkspacePrivacy(c);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 const settings=()=>get('SELECT * FROM org_settings WHERE id=1');
 const bump=()=>run('UPDATE org_settings SET revision=revision+1 WHERE id=1');
 // V5.6.8: reading a whole state for one person asks the same questions thousands of times (is this person active, which
 // workspace is this, who governs it…). Inside batch() — read-only work only — the answers are remembered until it ends.
 let memo=null;
 const cached=(kind,key,fn)=>{if(!memo)return fn();let m=memo[kind];if(!m)m=memo[kind]=new Map();if(m.has(key))return m.get(key);const v=fn();m.set(key,v);return v;};
 const batch=fn=>{if(memo)return fn();memo={};try{return fn();}finally{memo=null;}};
 const wsById=key=>key?cached('ws',key,()=>get('SELECT * FROM tm_workspaces WHERE id=?',key)):undefined;
 const memberRole=(wid,staff)=>memo?cached('roles',wid,()=>new Map(all('SELECT staff_id,member_role FROM tm_members WHERE workspace_id=?',wid).map(r=>[r.staff_id,r.member_role]))).get(staff)||null:get('SELECT member_role FROM tm_members WHERE workspace_id=? AND staff_id=?',wid,staff)?.member_role||null;
 const active=staff=>cached('active',staff,()=>!!get("SELECT 1 FROM access_users u JOIN lookups l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE u.staff_id=? AND u.active=1 AND l.active=1 AND COALESCE(p.active,1)=1",staff));
 const requireActive=staff=>{lookup(staff,'staff');if(!active(staff))fail('Choose an active employee with a company login.',422);return staff;};
 const named=p=>p?{...p,username:p.name,name:displayName(p.name,p.nickname)}:p;
 const person=staff=>cached('person',staff,()=>named(get('SELECT l.id AS staff_id,l.name,p.nickname,p.org_level,p.manager_id,COALESCE(p.active,1) AS active,p.department,p.position FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=? AND l.kind=\'staff\'',staff)));
 const level=staff=>person(staff)?.org_level||null;
 const isLevel1=staff=>active(staff)&&level(staff)===1;
 const legacyAdmin=staff=>cached('administration-role',staff,()=>get('SELECT role_id FROM access_users WHERE staff_id=? AND active=1',staff)?.role_id==='ROLE-ADMIN');
 const requireAdmin=staff=>{if(!isLevel1(staff))fail('An organization administrator (Level 1) must approve this action.',403);};
 const ws=key=>get('SELECT * FROM tm_workspaces WHERE id=?',str(key,'Workspace',60,true))||fail('Workspace not found.',404);
 const governed=w=>!!w&&w.kind!=='LEGACY';
 const member=(wid,staff)=>active(staff)&&(memo?!!memberRole(wid,staff):!!get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',wid,staff));
 // Rebuild once after a database change; subtree walks are iterative and stop even for invalid legacy loops.
 let treeStamp=-1,treeRows=[],parents=new Map(),children=new Map(),subtrees=new Map();
 function tree(){
  if(memo?.tree)return treeRows;if(memo)memo.tree=true;
  const stamp=get('SELECT total_changes() AS n').n;
  if(stamp!==treeStamp){treeStamp=stamp;treeRows=all('SELECT staff_id,manager_id,org_level FROM tm_profiles');parents=new Map(treeRows.map(p=>[p.staff_id,p.manager_id]));children=new Map();subtrees=new Map();for(const p of treeRows)if(p.manager_id){const a=children.get(p.manager_id)||[];a.push(p.staff_id);children.set(p.manager_id,a);}}
  return treeRows;
 }
 function descendants(staff){tree();if(subtrees.has(staff))return subtrees.get(staff);const out=new Set(),queue=[...(children.get(staff)||[])];for(let at=0;at<queue.length;at++){const k=queue[at];if(k===staff||out.has(k))continue;out.add(k);queue.push(...(children.get(k)||[]));}subtrees.set(staff,out);return out;}
 const inBranch=(root,staff)=>root===staff||descendants(root).has(staff);
 const governor=staff=>cached('governor',staff,()=>governorOf(staff));
 function governorOf(staff){tree();const seen=new Set();for(let at=staff;at&&!seen.has(at);at=parents.get(at)){seen.add(at);if(level(at)===2&&active(at)){const p=person(at);return p.manager_id&&isLevel1(p.manager_id)?at:null;}}return null;}
 const governs=(staff,w)=>w.kind==='ORGANIZATIONAL'&&w.governing_manager_id===staff&&governor(staff)===staff;
 function validGrant(g,seen=new Set()){
  if(!g||g.status!=='ACTIVE'||seen.has(g.id)||!active(g.beneficiary_id)||level(g.beneficiary_id)<3||governor(g.beneficiary_id)!==g.governing_manager_id||!inBranch(g.branch_root_id,g.beneficiary_id))return false;
  seen.add(g.id);
  if(g.workspace_id){const w=get('SELECT * FROM tm_workspaces WHERE id=?',g.workspace_id);if(!w||w.kind!=='ORGANIZATIONAL'||w.governing_manager_id!==g.governing_manager_id)return false;}
  if(g.parent_grant_id){const p=get('SELECT * FROM org_grants WHERE id=?',g.parent_grant_id);if(!validGrant(p,seen)||!inBranch(p.branch_root_id,g.beneficiary_id)||!parse(g.capabilities_json,[]).every(k=>parse(p.capabilities_json,[]).includes(k)))return false;}
  return true;
 }
 const grants=staff=>cached('grants',staff,()=>all("SELECT * FROM org_grants WHERE beneficiary_id=? AND status='ACTIVE'",staff).filter(g=>validGrant(g)));
 function hasCapability(staff,cap,w=null){
  if(isLevel1(staff))return !w||w.kind!=='PERSONAL';
  if(w&&governs(staff,w))return true;
  if(!w&&governor(staff)===staff)return true;
  return grants(staff).some(g=>parse(g.capabilities_json,[]).includes(cap)&&(!w||w.kind==='ORGANIZATIONAL'&&w.governing_manager_id===g.governing_manager_id&&(!g.workspace_id||g.workspace_id===w.id||g.id===w.owner_grant_id)));
 }
 const globalWorkspaces=staff=>legacyAdmin(staff)&&!!hooks.canStaff(staff,'admin.workspaces','view');
 const canManageStructure=staff=>!!hooks.canStaff(staff,'tasks.organization','create');
 function workspaceReason(staff,w){
  if(!w||w.deleted_at||!active(staff))return null;
  if(globalWorkspaces(staff))return 'organization';
  if(w.owner_id===staff)return 'owner';
  // A Personal workspace is shared only by explicit membership; supervising its owner never opens it.
  if(isPersonalWorkspace(w))return member(w.id,staff)?'membership':null;
  if(member(w.id,staff))return 'membership';
  if(descendants(staff).has(w.owner_id))return 'team';
  if(governs(staff,w))return 'governance';
  return null;
 }
 const canViewWorkspace=(staff,w)=>!!workspaceReason(staff,w);
 const workspaceOverride=(staff,w)=>w?.kind==='ORGANIZATIONAL'&&globalWorkspaces(staff);
 function canManageWorkspace(staff,w,{deleted=false}={}){
  if(!active(staff)||!w||(w.deleted_at&&!deleted))return false;
  if(w.kind==='LEGACY')return canViewWorkspace(staff,w)&&(w.owner_id===staff||hooks.canStaff(staff,'tasks.workspace','delete'));
  if(w.kind==='PERSONAL')return w.owner_id===staff;
  return workspaceOverride(staff,w)||governs(staff,w)||(w.owner_id===staff&&hasCapability(staff,'workspace_manage',w));
 }
 // Deleting and restoring a workspace is for the person who created it (V5.6.4 owner policy), whatever their role.
 const canDeleteWorkspace=(staff,w)=>!!w&&!w.deleted_at&&creator(staff,w);
 const canRestoreWorkspace=(staff,w)=>!!w&&!!w.deleted_at&&creator(staff,w);
 // V5.6.8: archiving (which needs Workspace “Delete” in the role) also follows the workspace's own management authority.
 const canArchiveWorkspace=(staff,w)=>!!w&&!w.deleted_at&&!!hooks.canStaff(staff,'tasks.workspace','delete')&&canManageWorkspace(staff,w);
 function canCreateResource(staff,w){
  if(w?.deleted_at)return false;
  if(!governed(w))return !get('SELECT id FROM access_users LIMIT 1')||canViewWorkspace(staff,w);
  if(!canViewWorkspace(staff,w))return false;
  return w.owner_id===staff||governs(staff,w)||workspaceOverride(staff,w)||memberRole(w.id,staff)==='MEMBER';
 }
 function canCollaborateOutside(staff,w){
  if(w?.deleted_at)return false;
  if(!governed(w))return true;
  return w.kind==='PERSONAL'?w.owner_id===staff:hasCapability(staff,'collaborate_outside',w);
 }
 function checkCollaborator(staff,w,target,{existing=false,system=false}={}){
  if(!governed(w))return;
  requireActive(target);
  if(existing||system||member(w.id,target)||w.owner_id===target)return;
  if(!canCollaborateOutside(staff,w))fail('Inviting someone outside this workspace requires approved outside-collaboration authority. Request membership instead.',403);
 }
 // Override only the authority path; task-specific action/approval/closure logic remains in tasks.mjs.
 function taskReason(staff,t,involved){
  const w=wsById(t.workspace_id);if(!w||w.deleted_at)return null;
  if(!active(staff))return !governed(w)&&!get('SELECT id FROM access_users LIMIT 1')?undefined:null;
  // Existing task invitations remain record-specific; they never open a Personal workspace.
  if(involved)return 'involved';
  if(globalWorkspaces(staff))return 'organization';
  if(w.owner_id===staff)return 'owner';
  if(isPersonalWorkspace(w))return member(w.id,staff)?'membership':null;
  const reason=workspaceReason(staff,w);if(reason)return reason;
  if(t.pic_id&&descendants(staff).has(t.pic_id))return 'team';
  return w.kind==='LEGACY'?undefined:null;
 }
 function meetingReason(staff,m,participant,shared){
  const w=wsById(m.workspace_id);if(w?.deleted_at)return false;if(!governed(w))return undefined;
  if(!active(staff))return false;
  if(participant)return true;
  if(isPersonalWorkspace(w))return shared&&(m.share_scope==='SELECTED'||canViewWorkspace(staff,w));
  return shared;
 }
 const personalTaskHidden=(staff,t)=>{const w=t&&wsById(t.workspace_id);return !!w?.deleted_at||isPersonalWorkspace(w)&&!hooks.taskScope?.canSee(staff,t);};
 function groupContext(staff,b){
  const w=wsById(b.workspace_id);if(w?.deleted_at)return {allowed:false,admin:false,viewer:true};
  if(isPersonalWorkspace(w))return {allowed:canViewWorkspace(staff,w),admin:false,viewer:staff!==w.owner_id&&memberRole(w.id,staff)!=='MEMBER'};
  if(!governed(w))return null;
  const direct=!!get('SELECT 1 FROM tm_board_access WHERE board_id=? AND staff_id=?',b.id,staff);
  const allowed=b.owner_id===staff||member(w.id,staff)||direct||globalWorkspaces(staff);
  return {allowed,admin:w.kind==='ORGANIZATIONAL'&&b.visibility==='TEAM'&&globalWorkspaces(staff),viewer:memberRole(w.id,staff)==='VIEWER'};
 }
 const audit=(actor,action,{employee=null,workspace=null,before=null,after=null,reason='',approval=null}={})=>insert('org_audit',{actor_id:actor,action,employee_id:employee,workspace_id:workspace,before_json:JSON.stringify(before),after_json:JSON.stringify(after),reason,approval_id:approval,created_at:now()});
 const expected=d=>{if(d.expected_revision!==settings().revision)fail('Organizational governance changed. Refresh the preview before saving.',409);};
 const capabilities=input=>{if(!Array.isArray(input)||input.length>Object.keys(ORG_CAPABILITIES).length||input.some(x=>!Object.hasOwn(ORG_CAPABILITIES,x)))fail('Choose valid scoped capabilities.',422);return uniq(input).sort();};
 const requireReason=d=>str(d.reason,'Reason',2000,true);
 function assignPerson(staff,orgLevel,manager){
  run('INSERT INTO tm_profiles(staff_id,org_level,manager_id) VALUES(?,?,?) ON CONFLICT(staff_id) DO UPDATE SET org_level=excluded.org_level,manager_id=excluded.manager_id,version=version+1',staff,orgLevel,manager);
 }
 function validateTree(){
  const rows=tree().filter(p=>p.org_level),by=new Map(rows.map(p=>[p.staff_id,p]));
  for(const p of rows){
   if(!get('SELECT 1 FROM org_levels WHERE id=?',p.org_level))fail('Choose a configured organizational level.',422);
   if(p.org_level===1){if(p.manager_id)fail('Level 1 employees report to the organization root.',422);continue;}
   const m=by.get(p.manager_id);
   if(!m||!active(p.manager_id)||m.staff_id===p.staff_id||m.org_level>=p.org_level||(p.org_level===2&&m.org_level!==1)||(p.org_level>=3&&m.org_level<2))fail('The reporting manager must be active at an earlier valid level: Level 2 reports to Level 1; Level 3+ reports through Level 2.',422);
   const seen=new Set([p.staff_id]);for(let at=p.manager_id;at;at=by.get(at)?.manager_id){if(seen.has(at))fail('Reporting cycles are not allowed.',422);seen.add(at);}
  }
  if(settings().enabled&&!rows.some(p=>p.org_level===1&&active(p.staff_id)))fail('Keep at least one active Level 1 organization administrator.',409);
 }
 function ensureWorkspaceAuthority(w){
  if(w.kind!=='ORGANIZATIONAL')return;
  const g=w.governing_manager_id;
  if(!g||governor(g)!==g)fail('Choose an active Level 2 governing manager who reports to Level 1.',422);
  requireActive(w.owner_id);
  if(w.owner_id!==g){
   const grant=w.owner_grant_id&&get('SELECT * FROM org_grants WHERE id=?',w.owner_grant_id);
   if(governor(w.owner_id)!==g||!validGrant(grant)||grant.beneficiary_id!==w.owner_id||!parse(grant.capabilities_json,[]).includes('workspace_create'))fail(`Workspace ${w.name} needs a valid owner grant or a responsible Level 2 replacement.`,409);
  }
 }
 function affected(staffIds=[],grantId=null){
  const employees=new Set(staffIds);for(const staff of staffIds)for(const k of descendants(staff))employees.add(k);
  const linked=new Set(grantId?[grantId]:all("SELECT id FROM org_grants WHERE status='ACTIVE'").filter(g=>{const row=get('SELECT * FROM org_grants WHERE id=?',g.id);return employees.has(row.beneficiary_id)||employees.has(row.governing_manager_id);}).map(g=>g.id));
  let changed=true;while(changed){changed=false;for(const g of all("SELECT id,parent_grant_id FROM org_grants WHERE status='ACTIVE'"))if(linked.has(g.parent_grant_id)&&!linked.has(g.id)){linked.add(g.id);changed=true;}}
  const workspaces=all("SELECT id,name,owner_id,governing_manager_id,owner_grant_id,version FROM tm_workspaces WHERE kind='ORGANIZATIONAL' AND deleted_at IS NULL").filter(w=>employees.has(w.owner_id)||employees.has(w.governing_manager_id)||linked.has(w.owner_grant_id));
  const requests=all("SELECT id,kind,workspace_id,beneficiary_id,approver_id FROM org_requests WHERE status IN('PENDING','REVIEW')").filter(q=>employees.has(q.beneficiary_id)||employees.has(q.approver_id)||workspaces.some(w=>w.id===q.workspace_id));
  const memberships=all("SELECT m.workspace_id,m.staff_id FROM tm_members m JOIN tm_workspaces w ON w.id=m.workspace_id WHERE w.kind='ORGANIZATIONAL'").filter(m=>employees.has(m.staff_id));
  return {employees:[...employees],grants:[...linked],workspaces,memberships,requests};
 }
 // Impact previews and responses must not become an alternate workspace-list endpoint.
 function visibleImpact(actor,impact){
  const workspaces=impact.workspaces.filter(w=>canViewWorkspace(actor,wsById(w.id))),ids=new Set(workspaces.map(w=>w.id));
  return {...impact,employees:impact.employees.filter(x=>visibleEmployee(actor,x)),workspaces,
   memberships:impact.memberships.filter(m=>ids.has(m.workspace_id)),requests:impact.requests.filter(q=>!q.workspace_id||ids.has(q.workspace_id)),
   grants:impact.grants.filter(id=>{const g=get('SELECT * FROM org_grants WHERE id=?',id);return g&&(!g.workspace_id||ids.has(g.workspace_id))&&(globalWorkspaces(actor)||g.beneficiary_id===actor||descendants(actor).has(g.beneficiary_id));})};
 }
 function reconcile(actor,reason){
  for(const g of all("SELECT * FROM org_grants WHERE status='ACTIVE'"))if(!validGrant(g)){
   update('org_grants',g.id,{status:'SUSPENDED',version:g.version+1,updated_at:now()});audit(actor,'delegation.suspended',{employee:g.beneficiary_id,workspace:g.workspace_id,before:g,after:{status:'SUSPENDED'},reason});
  }
  for(const w of all("SELECT * FROM tm_workspaces WHERE kind='ORGANIZATIONAL' AND deleted_at IS NULL"))ensureWorkspaceAuthority(w);
  for(const q of all("SELECT * FROM org_requests WHERE status IN('PENDING','REVIEW')")){
   let next=null;try{next=approverFor(q.kind,parse(q.payload_json),q.requester_id);}catch{}
   if(q.approver_id!==next){update('org_requests',q.id,{approver_id:next,status:next?'PENDING':'REVIEW',version:q.version+1,updated_at:now()});audit(actor,'request.rerouted',{employee:q.beneficiary_id,workspace:q.workspace_id,before:{approver:q.approver_id},after:{approver:next},reason,approval:q.id});if(next)notify(next,get('SELECT * FROM org_requests WHERE id=?',q.id),'review','A governance request now needs your review.');}
  }
 }
 function replacementWorkspaces(d,actor,approval=null,impact=null){
  if(!Array.isArray(d.workspace_replacements||[])||(d.workspace_replacements||[]).some(x=>!x||typeof x!=='object'||Array.isArray(x)))fail('Provide valid workspace replacements.',422);
  if(impact&&(d.workspace_replacements||[]).some(x=>!impact.workspaces.some(w=>w.id===x.id)))fail('Workspace replacements must belong to the affected scope shown in the preview.',422);
  for(const change of d.workspace_replacements||[]){const old=ws(change.id);if(old.kind!=='ORGANIZATIONAL')fail('Only organizational workspaces need a governance replacement.',422);if(!isLevel1(actor)&&!governs(actor,old))fail('This workspace belongs to another management branch.',403);
   const next={...old,owner_id:requireActive(change.owner_id),governing_manager_id:requireActive(change.governing_manager_id),owner_grant_id:change.owner_grant_id||null};ensureWorkspaceAuthority(next);
   update('tm_workspaces',old.id,{owner_id:next.owner_id,governing_manager_id:next.governing_manager_id,owner_grant_id:next.owner_grant_id,version:old.version+1,updated_at:now()});
   activateMember(old.id,next.owner_id,actor,'MEMBER',approval);audit(actor,'workspace.governance',{workspace:old.id,before:old,after:next,reason:d.reason||'',approval});
  }
 }
 function structureChanges(d){
  const input=d.changes||[{staff_id:d.staff_id,level:d.level,manager_id:d.manager_id}];
  if(!Array.isArray(input)||!input.length||input.length>500||input.some(x=>!x||typeof x!=='object'||Array.isArray(x)))fail('Supply 1–500 reporting changes.',422);
  if(new Set(input.map(x=>x.staff_id)).size!==input.length)fail('Include each employee only once in a structural change.',422);
  return input.map(x=>({staff_id:requireActive(x.staff_id),level:x.level==null?null:integer(x.level,1,1000,'level'),manager_id:x.manager_id?requireActive(x.manager_id):null}));
 }
 function canChangeStructure(actor,changes){
  if(isLevel1(actor))return true;
  return governor(actor)===actor&&changes.every(x=>x.staff_id!==actor&&level(x.staff_id)>=3&&x.level>=3&&governor(x.staff_id)===actor&&governor(x.manager_id)===actor&&x.manager_id!==x.staff_id);
 }
 function saveStructure(d,actor,approval=null){
  const changes=structureChanges(d);if(!canChangeStructure(actor,changes))fail('This structural change needs the responsible Level 2 or a Level 1 administrator.',403);
  const reason=requireReason(d);expected(d);if(d.acknowledged!==true)fail('Review and acknowledge the affected scope before saving.',422);
  const impact=affected(changes.map(x=>x.staff_id)),before=changes.map(x=>person(x.staff_id));
  for(const x of changes)assignPerson(x.staff_id,x.level,x.manager_id);
  validateTree();replacementWorkspaces(d,actor,approval,impact);reconcile(actor,reason);
  for(let i=0;i<changes.length;i++)audit(actor,'employee.structure',{employee:changes[i].staff_id,before:before[i],after:person(changes[i].staff_id),reason,approval});
  bump();return {type:'org_structure',message:'Reporting structure saved. Existing tasks and approvals keep their responsible people.',impact:visibleImpact(actor,impact)};
 }
 function notify(staff,q,event,body){
  if(!staff||!active(staff))return;
  insert('tm_notifications',{staff_id:staff,kind:`organization_${event}`,org_request_id:q.id,title:`Organization: ${q.kind.toLowerCase()} ${event}`,body,actor_id:q.requester_id,created_at:now()});
 }
 function approverFor(kind,p,requester){
  if(kind==='MEMBERSHIP'){const w=ws(p.workspace_id);if(w.kind!=='ORGANIZATIONAL')fail('This request needs an organizational workspace.',422);return governor(w.governing_manager_id)===w.governing_manager_id?w.governing_manager_id:null;}
  if(kind==='DELEGATION')return governor(p.beneficiary_id);
  const changes=structureChanges(p),governors=uniq(changes.flatMap(x=>[governor(x.staff_id),governor(x.manager_id)]));
  if(changes.every(x=>x.level>=3&&level(x.staff_id)>=3)&&governors.length===1&&governors[0]!==requester)return governors[0];
  return all('SELECT staff_id FROM tm_profiles WHERE org_level=1 ORDER BY staff_id').map(x=>x.staff_id).find(x=>x!==requester&&active(x))||null;
 }
 const canDecide=(actor,q)=>{if(!['PENDING','REVIEW'].includes(q.status)||q.requester_id===actor)return false;try{decisionAuthority(actor,q);return true;}catch{return false;}};
 const requestVisible=(staff,q)=>!!q&&(!q.workspace_id||canViewWorkspace(staff,wsById(q.workspace_id))||q.requester_id===staff||q.beneficiary_id===staff)&&(q.requester_id===staff||q.beneficiary_id===staff||globalWorkspaces(staff)||isLevel1(staff)&&(!q.beneficiary_id||descendants(staff).has(q.beneficiary_id))||q.approver_id===staff);
 function notificationVisible(staff,q){if(typeof q==='string')q=get('SELECT * FROM org_requests WHERE id=?',q);if(!active(staff)||!q||q.workspace_id&&workspaceRemoved(q.workspace_id))return false;if(q.requester_id===staff||q.beneficiary_id===staff)return true;try{return q.status==='PENDING'&&q.approver_id===staff&&approverFor(q.kind,parse(q.payload_json),q.requester_id)===staff;}catch{return false;}}
 function makeRequest(kind,p,actor,{approve=false,approvalActor=null}={}){
  const approver=approverFor(kind,p,actor),key=p.request_key?`${actor}:${kind}:${str(p.request_key,'Request key',100,true)}`:null;
  const fingerprint=hash([kind,actor,p.workspace_id||null,p.beneficiary_id||null,p.template_id||null,p.parent_grant_id||null,p.capabilities||null,p.member_role||null,p.changes||null,...(p.workspace_replacements?.length?[p.workspace_replacements]:[])]);
  const existing=key?get('SELECT * FROM org_requests WHERE request_key=?',key):get("SELECT * FROM org_requests WHERE fingerprint=? AND status IN('PENDING','REVIEW')",fingerprint);
  if(existing&&existing.fingerprint!==fingerprint)fail('This request key belongs to another governance change.',409);
  if(existing)return {id:existing.id,type:'org_request',message:'Request already recorded.',unchanged:true,status:existing.status};
  const q={id:id('org-request','ORGREQ'),kind,workspace_id:p.workspace_id||null,beneficiary_id:p.beneficiary_id||null,requester_id:actor,approver_id:approver,payload_json:JSON.stringify(p),reason:str(p.reason,'Reason',2000,true),status:approver?'PENDING':'REVIEW',request_key:key,fingerprint,created_at:now(),updated_at:now()};insert('org_requests',q);
  audit(actor,'request.created',{employee:q.beneficiary_id,workspace:q.workspace_id,after:q,reason:q.reason,approval:q.id});
  if(approve)return decide({id:q.id,decision:'APPROVE',note:'Direct authorized approval'},approvalActor||actor,{administrative:true});
  if(approver)notify(approver,q,'review',`${person(actor).name} requested ${kind.toLowerCase()}. Review the scope before deciding.`);
  bump();return {id:q.id,type:'org_request',status:q.status,message:approver?'Request sent for approval. No access is active yet.':'No valid approver is configured. A Level 1 administrator must correct governance; no access is active.'};
 }
 function activateMember(wid,staff,actor,role,approval){
  requireActive(staff);
  run('INSERT INTO tm_members(workspace_id,staff_id,approved_by,approval_id,member_role,joined_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,staff_id) DO NOTHING',wid,staff,actor,approval||null,role,now());
 }
 const workspaceRemoved=wid=>!!wid&&!!wsById(wid)?.deleted_at;
 const creator=(actor,w)=>active(actor)&&w.created_by===actor;
 const ownerCanAdd=(actor,w,target)=>!w.deleted_at&&w.status==='ACTIVE'&&w.kind==='ORGANIZATIONAL'&&creator(actor,w)&&w.owner_id===actor&&hasCapability(actor,'membership_request',w)&&hasCapability(actor,'workspace_manage',w)&&active(target)&&!!level(target)&&inBranch(actor,target)&&governor(target)===w.governing_manager_id;
 function membershipRequest(d,actor){
  const w=ws(d.workspace_id),target=requireActive(d.beneficiary_id||actor),role=d.member_role||'MEMBER';
  if(!['MEMBER','VIEWER'].includes(role))fail('Choose Member or Viewer.',422);
  if(w.kind==='LEGACY')fail('Classify this legacy workspace before using governed membership approval.',409);
  if(w.status!=='ACTIVE')fail('Restore the workspace first.',409);
  if(w.kind==='PERSONAL'){
   if(w.owner_id!==actor)fail(canViewWorkspace(actor,w)?'Only the personal workspace owner can share it.':'Workspace not found.',canViewWorkspace(actor,w)?403:404);
   const existed=member(w.id,target);activateMember(w.id,target,actor,role,null);if(!existed){audit(actor,'personal.shared',{employee:target,workspace:w.id,after:{member_role:role},reason:requireReason(d)});bump();}
   return {id:w.id,type:'tm_workspace',message:existed?'This person already has membership.':isPersonalWorkspace(w)?'Member added. The workspace stays Personal: only you, its members and authorized Administration can open it.':'Member added.'};
  }
  const direct=canViewWorkspace(actor,w)&&(governs(actor,w)||globalWorkspaces(actor)||isLevel1(actor)&&descendants(actor).has(w.owner_id)||ownerCanAdd(actor,w,target));
  if(!direct){
   if(target===actor){if(!w.joinable&&!canViewWorkspace(actor,w))fail('Workspace not found.',404);}
   else if(!level(target)||!hasCapability(actor,'membership_request',w)||!inBranch(actor,target)||governor(target)!==w.governing_manager_id)fail('You can nominate only employees in your approved branch. Ask the governing manager for a cross-branch exception.',403);
  }
  if(member(w.id,target))return {id:w.id,type:'tm_workspace',message:'This person already has active membership.',unchanged:true};
  return makeRequest('MEMBERSHIP',{workspace_id:w.id,beneficiary_id:target,member_role:role,reason:requireReason(d),request_key:d.request_key},actor,{approve:direct});
 }
 function delegationPayload(d,actor){
  const target=requireActive(d.beneficiary_id),g=governor(target),template=get('SELECT * FROM org_templates WHERE id=? AND active=1',d.template_id||'OWNER');
  if(!template||level(target)<3||!g)fail('Delegation needs a configured Level 3+ employee and a valid Level 2 manager.',422);
  const caps=capabilities(d.capabilities||parse(template.capabilities_json,[]));
  if(!caps.length||!caps.every(k=>parse(template.capabilities_json,[]).includes(k)))fail('Choose capabilities from the approved template.',422);
  const w=d.workspace_id?ws(d.workspace_id):null;
  if(w&&(w.kind!=='ORGANIZATIONAL'||w.governing_manager_id!==g))fail('The delegation workspace must have the same responsible Level 2 manager.',422);
  let parent=null;
  if(!isLevel1(actor)&&actor!==g){
   if(target===actor||!inBranch(actor,target))fail('Delegation is only available for employees below you.',403);
   parent=get('SELECT * FROM org_grants WHERE id=?',d.parent_grant_id||'');
   if(!validGrant(parent)||parent.beneficiary_id!==actor||!parse(parent.capabilities_json,[]).includes('delegate_request')||!caps.every(k=>parse(parent.capabilities_json,[]).includes(k))||parent.governing_manager_id!==g||parent.workspace_id&&(parent.workspace_id!==w?.id))fail('The requested authority exceeds your active scoped delegation.',403);
  }
  return {beneficiary_id:target,template_id:template.id,title:template.name,capabilities:caps,branch_root_id:target,workspace_id:w?.id||null,governing_manager_id:g,parent_grant_id:parent?.id||null,reason:requireReason(d),request_key:d.request_key};
 }
 function decisionAuthority(actor,q){
  const current=approverFor(q.kind,parse(q.payload_json),q.requester_id);
  if(!current)fail('A valid responsible manager must be configured before approving.',409);
  if(current!==actor&&!globalWorkspaces(actor)&&!(isLevel1(actor)&&q.beneficiary_id&&descendants(actor).has(q.beneficiary_id)))fail('You are not the current responsible approver.',403);
 }
 function decide(d,actor,{administrative=false}={}){
  const q=get('SELECT * FROM org_requests WHERE id=?',str(d.id,'Request',60,true))||fail('Request not found.',404);
  if(!requestVisible(actor,q))fail('Request not found.',404);
  const decision=d.decision;if(!['APPROVE','REJECT'].includes(decision))fail('Choose Approve or Reject.',422);
  const ownerApproval=administrative&&q.kind==='MEMBERSHIP'&&q.requester_id===actor&&ownerCanAdd(actor,ws(q.workspace_id),q.beneficiary_id);
  if(!ownerApproval)decisionAuthority(actor,q);
  if(!administrative&&q.requester_id===actor)fail('You cannot approve your own request.',403);
  if(!['PENDING','REVIEW'].includes(q.status)){if(q.status===(decision==='APPROVE'?'APPROVED':'REJECTED'))return {id:q.id,type:'org_request',status:q.status,message:'This decision is already recorded.',unchanged:true};fail('This request has already been decided.',409);}
  if(d.expected_version!==undefined)version(q,d.expected_version);
  const p=parse(q.payload_json),note=str(d.note,'Decision note',2000,decision==='REJECT');
  if(decision==='APPROVE'){
   if(q.kind==='MEMBERSHIP'){
    const w=ws(q.workspace_id);if(w.kind!=='ORGANIZATIONAL'||w.status!=='ACTIVE')fail('The workspace is no longer eligible.',409);
    requireActive(q.beneficiary_id);
    if(!['MEMBER','VIEWER'].includes(p.member_role))fail('Invalid membership role.',422);
    // Recheck the lower-level inviter, scope and grant; a manager may approve cross-branch self-join requests.
    if(q.requester_id!==q.beneficiary_id&&!isLevel1(q.requester_id)&&!governs(q.requester_id,w)&&(!active(q.requester_id)||!hasCapability(q.requester_id,'membership_request',w)||!inBranch(q.requester_id,q.beneficiary_id)||governor(q.beneficiary_id)!==w.governing_manager_id))fail('The inviter’s authority changed. Submit a new membership request.',409);
    activateMember(w.id,q.beneficiary_id,actor,p.member_role,q.id);
    audit(actor,'membership.approved',{employee:q.beneficiary_id,workspace:w.id,after:{member_role:p.member_role},reason:note||q.reason,approval:q.id});
   }else if(q.kind==='DELEGATION'){
    const checked=delegationPayload({...p,reason:q.reason},q.requester_id);
    if(checked.governing_manager_id!==p.governing_manager_id)fail('The branch changed. Submit a new delegation request.',409);
    const grant={id:id('org-grant','GRANT'),beneficiary_id:p.beneficiary_id,template_id:p.template_id,title:p.title,capabilities_json:JSON.stringify(checked.capabilities),branch_root_id:p.beneficiary_id,workspace_id:p.workspace_id||null,governing_manager_id:checked.governing_manager_id,parent_grant_id:checked.parent_grant_id,request_id:q.id,status:'ACTIVE',granted_by:actor,created_at:now(),updated_at:now()};
    insert('org_grants',grant);audit(actor,'delegation.approved',{employee:p.beneficiary_id,workspace:p.workspace_id,after:grant,reason:note||q.reason,approval:q.id});
   }else{
    expected(d);if(d.acknowledged!==true)fail('Review and acknowledge the affected structure before approving.',422);
    if(!isLevel1(q.requester_id)&&governor(q.requester_id)!==q.requester_id&&structureChanges(p).some(x=>x.staff_id!==q.requester_id)&&!hasCapability(q.requester_id,'structure_request'))fail('The requester’s structural authority was revoked. Submit a new request.',409);
    if(!active(q.requester_id)||!structureChanges(p).every(x=>x.staff_id===q.requester_id||inBranch(q.requester_id,x.staff_id))&&!isLevel1(q.requester_id)&&governor(q.requester_id)!==q.requester_id)fail('The requester no longer has authority over the requested branch.',409);
    saveStructure({...p,expected_revision:d.expected_revision,acknowledged:true,reason:q.reason},actor,q.id);
   }
  }
  update('org_requests',q.id,{status:decision==='APPROVE'?'APPROVED':'REJECTED',approver_id:ownerApproval?actor:q.approver_id,decision_by:actor,decision_note:note,decided_at:now(),updated_at:now(),version:q.version+1});
  audit(actor,`request.${decision.toLowerCase()}`,{employee:q.beneficiary_id,workspace:q.workspace_id,before:{status:q.status},after:{status:decision},reason:note,approval:q.id});
  const done=get('SELECT * FROM org_requests WHERE id=?',q.id);
  for(const staff of uniq([q.requester_id,q.beneficiary_id]).filter(x=>x!==actor))notify(staff,done,decision==='APPROVE'?'approved':'rejected',`${q.kind.toLowerCase()} request ${decision==='APPROVE'?'approved':'rejected'}.${note?' '+note:''}`);
  bump();return {id:q.id,type:'org_request',status:done.status,message:`Request ${done.status.toLowerCase()}.`};
 }

 function saveWorkspace(d,actor){
  const old=d.id?ws(d.id):null,kind=old?.kind||(d.kind==='PUBLIC'?'PERSONAL':d.kind)||'PERSONAL';
  const visibility=old?.visibility||(d.kind==='PUBLIC'||kind==='ORGANIZATIONAL'?'PUBLIC':'PERSONAL');
  if(!['PERSONAL','ORGANIZATIONAL'].includes(kind))fail('Choose Personal or Organizational. Legacy workspaces use migration review.',422);
  if(old){if(!canViewWorkspace(actor,old))fail('Workspace not found.',404);version(old,d.expected_version);if(!canManageWorkspace(actor,old))fail('You cannot manage this workspace.',403);if(d.kind&&d.kind!==old.kind&&!(d.kind==='PUBLIC'&&old.kind==='PERSONAL'&&old.visibility==='PUBLIC'))fail('Workspace privacy classification cannot be changed through an ordinary edit.',403);}
  const owner=old?(d.owner_id||old.owner_id):kind==='PERSONAL'?actor:(d.owner_id||actor);
  if(kind==='PERSONAL'&&owner!==actor)fail('Only the owner can manage a personal workspace.',403);
  const governing=kind==='ORGANIZATIONAL'?(d.governing_manager_id||old?.governing_manager_id||governor(owner)):null;
  const grantId=kind==='ORGANIZATIONAL'&&owner!==governing?(d.owner_grant_id||old?.owner_grant_id||grants(owner).find(g=>parse(g.capabilities_json,[]).includes('workspace_create')&&(!g.workspace_id||g.workspace_id===d.origin_workspace_id))?.id||null):null;
  if(kind==='ORGANIZATIONAL'){
   if(!settings().enabled)fail('Initialize Organizational Structure and assign a Level 2 manager first.',409);
   if(!old&&!isLevel1(actor)&&actor!==governing&&(!hasCapability(actor,'workspace_create')||owner!==actor||governor(actor)!==governing))fail('An approved Owner capability is required to create a delegated organizational workspace.',403);
   if(old&&!isLevel1(actor)&&!governs(actor,old)&&(owner!==old.owner_id||governing!==old.governing_manager_id||grantId!==old.owner_grant_id))fail('Only the governing manager or a Level 1 administrator can change this workspace’s owner or governing manager.',403);
  }
  if(old&&kind==='ORGANIZATIONAL'&&(owner!==old.owner_id||governing!==old.governing_manager_id||grantId!==old.owner_grant_id)){expected(d);if(d.acknowledged!==true)fail('Preview and acknowledge the affected workspace governance before changing its owner or manager.',422);}
  const origin=d.origin_workspace_id===undefined?old?.origin_workspace_id||null:d.origin_workspace_id||null;
  const originChanged=!old||origin!==old.origin_workspace_id;
  if(old&&originChanged&&!isLevel1(actor)&&!governs(actor,old))fail('A governing manager must approve changes to workspace governance links.',403);
  if(origin&&originChanged){const related=ws(origin);if(origin===old?.id||related.kind!=='ORGANIZATIONAL'||related.governing_manager_id!==governing||!canViewWorkspace(actor,related))fail('Choose an authorized organizational workspace under the same governing manager.',422);}
  if(grantId){const g=get('SELECT * FROM org_grants WHERE id=?',grantId);if(g?.workspace_id&&g.workspace_id!==origin&&old?.owner_grant_id!==grantId)fail('This Owner grant is restricted to its approved originating workspace.',403);}
  const values={name:str(d.name??old?.name,'Workspace name',200,true),description:str(d.description??old?.description,'Description',5000),department:str(d.department??old?.department,'Department',150),owner_id:requireActive(owner),kind,visibility,governing_manager_id:governing,owner_grant_id:grantId,origin_workspace_id:origin,joinable:kind==='ORGANIZATIONAL'&&(d.joinable??old?.joinable)?1:0,color:d.color||old?.color||'BLUE',status:old?.status||'ACTIVE',version:old?old.version+1:0,updated_at:now()};
  if(!['BLUE','PURPLE','TEAL','ORANGE','PINK'].includes(values.color))fail('Choose a valid workspace color.',422);
  ensureWorkspaceAuthority({...old,...values});
  if(old&&Array.isArray(d.member_ids)){
   const before=all('SELECT staff_id FROM tm_members WHERE workspace_id=?',old.id).map(x=>x.staff_id).sort(),after=uniq([...d.member_ids,owner]).sort();
   if(JSON.stringify(before)!==JSON.stringify(after))fail('Use membership requests or the explicit member-removal action; a workspace edit cannot bypass approval.',403);
  }else if(!old&&d.member_ids?.some(x=>x!==owner))fail('Create the workspace first, then add or request members through approval.',403);
  if(get('SELECT 1 FROM tm_workspaces WHERE name=? COLLATE NOCASE AND id<>?',values.name,old?.id||''))fail('A workspace with this name already exists.',409);
  const key=old?.id||id('tm-workspace','WS');if(old)update('tm_workspaces',key,values);else insert('tm_workspaces',{id:key,...values,created_by:actor,created_at:now()});
  activateMember(key,owner,actor,'MEMBER',null);audit(actor,old?'workspace.updated':'workspace.created',{workspace:key,before:old,after:values,reason:d.reason||'Explicit workspace setup'});reconcile(actor,'Workspace governance changed');bump();
  return {id:key,type:'tm_workspace',message:`${visibility==='PERSONAL'?'Personal':'Public'} workspace saved. Membership and contents remain separate.`};
 }
 function removeWorkspace(d,actor,restore=false){
  const w=ws(d.id);
  if(!canViewWorkspace(actor,w)&&!creator(actor,w))fail('Workspace not found.',404);
  if(!creator(actor,w))fail('Only the user who created this workspace can delete or restore it.',403);
  version(w,d.expected_version);
  if(restore?!w.deleted_at:!!w.deleted_at)return {id:w.id,type:'tm_workspace',unchanged:true,message:restore?'Workspace already restored.':'Workspace already deleted.'};
  if(d.acknowledged!==true)fail('Confirm workspace deletion or restoration first.',422);
  // V5.6.8: an organizational workspace comes back only with valid governance; if its owner's authority lapsed while it was
  // deleted, its governing manager becomes the owner again (recorded in the audit).
  if(restore&&w.kind==='ORGANIZATIONAL'){
   try{ensureWorkspaceAuthority(w);}catch(e){
    if(!w.governing_manager_id||governor(w.governing_manager_id)!==w.governing_manager_id)fail('This workspace’s governing manager is no longer a valid Level 2 manager. Correct the reporting structure first, then restore it.',409);
    update('tm_workspaces',w.id,{owner_id:w.governing_manager_id,owner_grant_id:null});activateMember(w.id,w.governing_manager_id,actor,'MEMBER',null);
    audit(actor,'workspace.governance',{workspace:w.id,before:{owner_id:w.owner_id,owner_grant_id:w.owner_grant_id},after:{owner_id:w.governing_manager_id,owner_grant_id:null},reason:'Restored: the previous owner no longer had valid authority'});
   }
  }
  // A soft delete freezes work, retains history and never cascades to independently delegated workspaces.
  const change=restore?{status:w.deleted_from_status||'ACTIVE',deleted_at:null,deleted_by:null,deleted_from_status:null}:{status:'ARCHIVED',deleted_at:now(),deleted_by:actor,deleted_from_status:w.status};
  update('tm_workspaces',w.id,{...change,version:w.version+1,updated_at:now()});
  if(!restore)for(const q of all("SELECT * FROM org_requests WHERE workspace_id=? AND status IN('PENDING','REVIEW')",w.id)){
   update('org_requests',q.id,{status:'CANCELLED',decision_note:'Workspace deleted by its creator.',version:q.version+1,updated_at:now()});
   audit(actor,'request.cancelled',{workspace:w.id,approval:q.id,before:{status:q.status},after:{status:'CANCELLED'},reason:'Workspace deleted by its creator.'});
  }
  // V5.6.8: the people whose open work, requests or meetings are in the workspace, and its members, are told.
  const people=uniq([
   ...all("SELECT t.pic_id AS s FROM tm_tasks t WHERE t.workspace_id=?1 AND t.status NOT IN('COMPLETED','CANCELLED') UNION SELECT t.reviewer_id FROM tm_tasks t WHERE t.workspace_id=?1 AND t.status NOT IN('COMPLETED','CANCELLED') UNION SELECT t.assigned_by FROM tm_tasks t WHERE t.workspace_id=?1 AND t.status NOT IN('COMPLETED','CANCELLED') UNION SELECT a.staff_id FROM tm_assignees a JOIN tm_tasks t ON t.id=a.task_id WHERE t.workspace_id=?1 AND a.status<>'DECLINED' AND t.status NOT IN('COMPLETED','CANCELLED')",w.id).map(r=>r.s),
   ...all("SELECT requested_by AS s FROM tm_requests WHERE workspace_id=?1 AND status='PENDING' UNION SELECT manager_id FROM tm_requests WHERE workspace_id=?1 AND status='PENDING'",w.id).map(r=>r.s),
   ...all("SELECT a.staff_id AS s FROM tm_attendees a JOIN tm_meetings m ON m.id=a.meeting_id WHERE m.workspace_id=? AND m.status='SCHEDULED'",w.id).map(r=>r.s),
   ...all('SELECT staff_id AS s FROM tm_members WHERE workspace_id=?',w.id).map(r=>r.s)]).filter(x=>x!==actor&&active(x));
  const who=person(actor)?.name||actor;
  for(const staff of people)insert('tm_notifications',{staff_id:staff,kind:restore?'workspace_restored':'workspace_deleted',title:`Workspace ${restore?'restored':'deleted'}: ${w.name}`,body:restore?`${who} restored it. Its tasks, requests and meetings are available again.`:`${who} deleted it. Its tasks, requests and meetings are hidden until it is restored.`,actor_id:actor,created_at:now()});
  audit(actor,restore?'workspace.restored':'workspace.deleted',{workspace:w.id,before:{status:w.status,deleted_at:w.deleted_at},after:change,reason:d.reason||'Confirmed by workspace creator'});bump();
  return {id:w.id,type:'tm_workspace',message:restore?'Workspace restored. Previous memberships and work are retained.':'Workspace deleted. Its creator can restore it from My Workspaces.'};
 }
 function migrationPreview(actor){
  if(!isLevel1(actor)&&!(legacyAdmin(actor)&&!settings().enabled))fail('Only an organization administrator can review migration.',403);
  return {revision:settings().revision,initialized:!!settings().enabled,
   employees:all("SELECT l.id AS staff_id,l.name,p.nickname,p.manager_id,p.org_level,u.role_id,u.active FROM access_users u JOIN lookups l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE u.active=1 AND p.org_level IS NULL ORDER BY l.name").map(named),
   workspaces:all("SELECT w.*,(SELECT COUNT(*) FROM tm_members m WHERE m.workspace_id=w.id) AS member_count,(SELECT COUNT(*) FROM tm_tasks t WHERE t.workspace_id=w.id) AS task_count FROM tm_workspaces w WHERE kind='LEGACY' ORDER BY name").filter(w=>canViewWorkspace(actor,w)),
   policy:'No automatic level or privacy classification. Legacy memberships and direct task/meeting participation stay intact until an explicit, audited workspace cutover.'};
 }
 function classifyWorkspace(d,actor){
  const old=ws(d.id);if(!canViewWorkspace(actor,old))fail('Workspace not found.',404);version(old,d.expected_version);expected(d);if(old.kind!=='LEGACY')fail('This workspace is already classified. Automatic personal/organizational conversion is not supported.',409);
  if(d.acknowledged!==true)fail('Review and acknowledge the migration impact first.',422);const reason=requireReason(d);
  if(['PERSONAL','PUBLIC'].includes(d.kind)){
   if(actor!==old.owner_id)fail('Only the existing owner can classify and explicitly share a personal workspace.',403);
   if(!Array.isArray(d.shared_member_ids))fail('Explicitly select retained sharing when classifying a personal workspace.',422);
   const previous=all('SELECT staff_id FROM tm_members WHERE workspace_id=?',old.id).map(m=>m.staff_id);
   // Do not silently revoke legacy memberships on classification; owners can revoke them explicitly afterwards.
   if(previous.some(k=>k!==actor&&!d.shared_member_ids.includes(k)))fail('Preserve existing memberships during migration. Review and revoke specific sharing separately afterwards.',409);
   for(const k of d.shared_member_ids)if(!previous.includes(k))requireActive(k);
   update('tm_workspaces',old.id,{kind:'PERSONAL',visibility:d.kind==='PUBLIC'?'PUBLIC':'PERSONAL',governing_manager_id:null,version:old.version+1,updated_at:now()});
   for(const k of uniq([actor,...d.shared_member_ids]))if(!previous.includes(k))activateMember(old.id,k,actor,'MEMBER',null);
  }else if(d.kind==='ORGANIZATIONAL'){
   requireAdmin(actor);
   const owner=requireActive(d.owner_id),manager=requireActive(d.governing_manager_id||governor(owner));
   const grantId=owner===manager?null:d.owner_grant_id||grants(owner).find(g=>!g.workspace_id&&parse(g.capabilities_json,[]).includes('workspace_create'))?.id||null;
   const next={...old,kind:'ORGANIZATIONAL',owner_id:owner,governing_manager_id:manager,owner_grant_id:grantId};ensureWorkspaceAuthority(next);
   update('tm_workspaces',old.id,{kind:next.kind,visibility:'PUBLIC',owner_id:next.owner_id,governing_manager_id:next.governing_manager_id,owner_grant_id:next.owner_grant_id,joinable:d.joinable?1:0,version:old.version+1,updated_at:now()});activateMember(old.id,next.owner_id,actor,'MEMBER',null);
  }else fail('Explicitly classify this workspace as Personal or Organizational.',422);
  run('UPDATE tm_members SET approved_by=COALESCE(approved_by,?),joined_at=COALESCE(joined_at,?) WHERE workspace_id=?',actor,now(),old.id);
  audit(actor,'migration.workspace',{workspace:old.id,before:old,after:ws(old.id),reason});bump();return {id:old.id,type:'tm_workspace',message:'Workspace classified. Existing records, participants and memberships were preserved.'};
 }
 function guard(action,d,actor){
  if(!['tm.workspace.delete','tm.workspace.restore','org.workspace.delete','org.workspace.restore'].includes(action)){
   const wid=d.workspace_id||(/^tm\.workspace\.|^org\.workspace\./.test(action)?d.id:null);
   if(wid&&workspaceRemoved(wid))fail('This workspace was deleted. Its creator must restore it first.',409);
  }
  if(action.startsWith('org.')&&!canManageStructure(actor))fail('Organizational Structure Create permission is required for management actions.',403);
  if(!settings().enabled)return;
  if(action==='tm.profile.manager'||action==='tm.profile.save'&&d.manager_id!==undefined){const old=person(d.staff_id);if((old?.org_level||level(d.manager_id)||level(old?.manager_id))&&String(d.manager_id||'')!==String(old?.manager_id||''))fail('Use Organizational Structure with an impact preview to change governed reporting relationships.',403);}
  const target=action==='admin.user.disable'||action==='admin.user.save'&&(d.active===false||d.active===0)?get('SELECT staff_id FROM access_users WHERE id=?',d.id)?.staff_id:action==='tm.profile.save'&&(d.active===false||d.active===0)?d.staff_id:null;
  if(target){
   if(get('SELECT 1 FROM tm_profiles WHERE manager_id=? AND org_level IS NOT NULL AND active=1',target))fail('Reassign active reporting employees before deactivating their manager.',409);
   if(isLevel1(target)&&all('SELECT staff_id FROM tm_profiles WHERE org_level=1').filter(p=>active(p.staff_id)).length===1)fail('Keep at least one active Level 1 organization administrator.',409);
   if(affected([target]).workspaces.length)fail('Review this employee’s dependent organizational workspaces and assign valid replacements before deactivation.',409);
  }
 }
 function afterCommand(action,d,actor){
  if(settings().enabled&&['admin.user.disable','admin.user.save','tm.profile.save'].includes(action)){reconcile(actor,'Employee account/profile changed');bump();}
 }
 const canRemoveMembers=(actor,w)=>!!w&&!w.deleted_at&&active(actor)&&canViewWorkspace(actor,w)&&(w.owner_id===actor||creator(actor,w)&&canManageWorkspace(actor,w)||governs(actor,w)||workspaceOverride(actor,w));
 function removeMember(d,actor){
  const w=ws(d.workspace_id),target=str(d.beneficiary_id,'Employee',60,true);expected(d);
  if(!canViewWorkspace(actor,w))fail('Workspace not found.',404);
  if(!canRemoveMembers(actor,w))fail('Only an authorized workspace owner or governing manager can remove members.',403);
  if(target===w.owner_id)fail('Assign a valid replacement owner before removing the owner’s membership.',409);
  const old=get('SELECT * FROM tm_members WHERE workspace_id=? AND staff_id=?',w.id,target);if(!old)return {id:w.id,type:'tm_workspace',unchanged:true,message:'Membership already removed.'};
  const reason=requireReason(d);run('DELETE FROM tm_members WHERE workspace_id=? AND staff_id=?',w.id,target);
  audit(actor,'membership.revoked',{employee:target,workspace:w.id,before:old,reason});bump();
  return {id:w.id,type:'tm_workspace',message:'Member removed. Tasks, history and independently authorized participation are retained.'};
 }
 function workspaceAccess(staff,w){
  const approve=!w.deleted_at&&canViewWorkspace(staff,w)&&(governs(staff,w)||w.kind==='ORGANIZATIONAL'&&(globalWorkspaces(staff)||isLevel1(staff)&&descendants(staff).has(w.owner_id))),ownAdd=ownerCanAdd(staff,w,staff),personal=w.kind==='PERSONAL'&&w.owner_id===staff&&!w.deleted_at;
  const candidates=w.status==='ACTIVE'&&!w.deleted_at&&(approve||ownAdd||personal)?cached('logins','',()=>all("SELECT staff_id FROM access_users WHERE active=1")).filter(p=>active(p.staff_id)&&(approve||personal||ownerCanAdd(staff,w,p.staff_id))&&!member(w.id,p.staff_id)).map(p=>({id:p.staff_id,name:person(p.staff_id).name})):[];
  return {membership_revision:settings().revision,reason:workspaceReason(staff,w),can_manage:canManageWorkspace(staff,w),can_create:canCreateResource(staff,w),can_collaborate_outside:canCollaborateOutside(staff,w),can_approve_membership:approve,can_remove_members:canRemoveMembers(staff,w),can_add_members:approve||ownAdd||personal,member_candidates:candidates,can_archive:canArchiveWorkspace(staff,w),can_delete:canDeleteWorkspace(staff,w),can_restore:canRestoreWorkspace(staff,w),can_request_membership:!w.deleted_at&&w.kind==='ORGANIZATIONAL'&&hasCapability(staff,'membership_request',w),personal:isPersonalWorkspace(w)};
 }
 function workspaceDashboard(actor,state){
  if(!active(actor))return {has_management:false,people:[],my:[],managed:[],shared:[]};
  const managedPeople=tree().filter(p=>p.staff_id!==actor&&p.org_level&&active(p.staff_id)&&(globalWorkspaces(actor)||descendants(actor).has(p.staff_id)));
  const scope=new Set([actor,...managedPeople.map(p=>p.staff_id)]),full=new Set((state.tm_workspaces||[]).map(w=>w.id));
  const people=[person(actor),...managedPeople.map(p=>person(p.staff_id))].map(p=>({staff_id:p.staff_id,name:p.name,org_level:p.org_level,manager_id:scope.has(p.manager_id)?p.manager_id:null}));
  const my=[],managed=[],shared=[],tasks=state.tm_tasks||[],members=all('SELECT workspace_id,staff_id FROM tm_members');
  for(const w of all('SELECT * FROM tm_workspaces ORDER BY name COLLATE NOCASE')){
   const mine=w.created_by===actor||w.owner_id===actor;
   // Deleted rows are minimal recovery entries for their creator. Personal workspaces never enter hierarchy browsing.
   const management=!w.deleted_at&&!isPersonalWorkspace(w)&&scope.has(w.owner_id)&&w.owner_id!==actor;
   if(w.deleted_at?!canRestoreWorkspace(actor,w):!full.has(w.id))continue;
   const authorized=full.has(w.id),visibleMembers=members.filter(m=>m.workspace_id===w.id&&(authorized||scope.has(m.staff_id))).map(m=>m.staff_id);
   const row={id:w.id,name:w.name,kind:w.kind,visibility:w.visibility,status:w.status,color:w.color,version:w.version,owner_id:w.owner_id,created_by:w.created_by,deleted_at:w.deleted_at,reference_only:!authorized,
    description:authorized?w.description:'',department:authorized?w.department:'',org_access:authorized?workspaceAccess(actor,w):{can_archive:false,can_delete:canDeleteWorkspace(actor,w),can_restore:canRestoreWorkspace(actor,w)},
    member_ids:w.deleted_at?[]:visibleMembers,task_ids:tasks.filter(t=>t.workspace_id===w.id).map(t=>t.id)};
   if(mine)my.push(row);else if(management)managed.push(row);else shared.push(row);
  }
  return {has_management:managedPeople.length>0,people,my,managed,shared};
 }
 function visibleEmployee(actor,target){return globalWorkspaces(actor)||actor===target||inBranch(actor,target)||inBranch(target,actor);}
 function employee(actor,target){
  if(!visibleEmployee(actor,target))fail('Employee not found.',404);const p=person(target);if(!p)fail('Employee not found.',404);
  if(!canManageStructure(actor))return {...p,active:active(target)?1:0,actions:{},direct_reports:all('SELECT staff_id FROM tm_profiles WHERE manager_id=?',target).filter(x=>visibleEmployee(actor,x.staff_id)).map(x=>person(x.staff_id)),memberships:[],owned:[],grants:[]};
  const memberships=all('SELECT w.*,m.member_role FROM tm_workspaces w JOIN tm_members m ON m.workspace_id=w.id WHERE m.staff_id=?',target).filter(w=>canViewWorkspace(actor,w)).map(w=>({id:w.id,name:w.name,kind:w.kind,visibility:w.visibility,owner_id:w.owner_id,governing_manager_id:w.governing_manager_id,member_role:w.member_role}));
  const owned=all('SELECT * FROM tm_workspaces WHERE owner_id=?',target).filter(w=>canViewWorkspace(actor,w)).map(w=>({id:w.id,name:w.name,kind:w.kind,visibility:w.visibility,governing_manager_id:w.governing_manager_id}));
  return {...p,active:active(target)?1:0,actions:{change_structure:isLevel1(actor)||governor(actor)===actor&&level(target)>=3&&governor(target)===actor,request_structure:actor===target||inBranch(actor,target)&&hasCapability(actor,'structure_request'),delegate:level(target)>=3&&!!governor(target)&&(isLevel1(actor)||actor===governor(target)||target!==actor&&inBranch(actor,target)&&hasCapability(actor,'delegate_request'))},governing_manager_id:governor(target),direct_reports:all('SELECT staff_id FROM tm_profiles WHERE manager_id=?',target).filter(x=>visibleEmployee(actor,x.staff_id)).map(x=>person(x.staff_id)),memberships,owned,grants:all('SELECT * FROM org_grants WHERE beneficiary_id=? ORDER BY created_at DESC',target).filter(g=>!g.workspace_id||canViewWorkspace(actor,ws(g.workspace_id))).map(g=>({...g,capabilities:parse(g.capabilities_json,[]),effective:validGrant(g)}))};
 }
 function snapshot(actor){
  const p=person(actor),s=settings(),manage=canManageStructure(actor);
  return {enabled:!!s.enabled,revision:s.revision,me:{...p,can_manage_structure:manage,is_admin:isLevel1(actor),is_governor:governor(actor)===actor,governing_manager_id:governor(actor),can_initialize:!s.enabled&&legacyAdmin(actor)&&manage},
   levels:all('SELECT * FROM org_levels ORDER BY id'),templates:manage?all('SELECT * FROM org_templates ORDER BY name').map(t=>({...t,capabilities:parse(t.capabilities_json,[])})):[],capabilities:manage?ORG_CAPABILITIES:{},
   directory:all("SELECT u.staff_id,l.name,p.nickname FROM access_users u JOIN lookups l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=u.staff_id WHERE u.active=1 AND l.active=1 AND COALESCE(p.active,1)=1 ORDER BY l.name COLLATE NOCASE").filter(p=>manage||visibleEmployee(actor,p.staff_id)).map(named),
   grants:manage?grants(actor).map(g=>({...g,capabilities:parse(g.capabilities_json,[])})):[],pending:manage?all("SELECT * FROM org_requests WHERE status='PENDING' AND approver_id=?",actor).filter(q=>notificationVisible(actor,q)).length:0};
 }
 function query(actor,p={}){
  requireActive(actor);if(!hooks.canStaff(actor,'tasks.organization','view'))fail('Organizational Structure View permission is required.',403);
  if(!canManageStructure(actor)&&p.view&&!['people','employee'].includes(p.view))fail('Organizational Structure View is read-only. Create permission is required for management views.',403);
  const page=integer(p.page||1,1,100000,'page'),limit=integer(p.limit||50,1,200,'page size'),q=String(p.q||'').trim().toLowerCase();
  const paginate=rows=>({rows:rows.slice((page-1)*limit,page*limit),total:rows.length,page,limit,revision:settings().revision});
  if(p.view==='migration')return migrationPreview(actor);
  if(p.view==='employee')return employee(actor,p.staff_id);
  if(p.view==='requests')return paginate(all('SELECT * FROM org_requests ORDER BY created_at DESC,id DESC').filter(r=>requestVisible(actor,r)&&(!p.status||r.status===p.status)&&(!p.mine||r.approver_id===actor)&&(!q||`${r.id} ${r.kind} ${r.reason}`.toLowerCase().includes(q))).map(r=>({...r,payload:parse(r.payload_json),can_decide:canDecide(actor,r),can_cancel:r.requester_id===actor&&['PENDING','REVIEW'].includes(r.status)})));
  // V5.6.8: a deleted workspace's history stays readable by whoever may restore it (and its creator); details about the
  // people above you are not shown unless the entry is about you.
  const wsRow=key=>get('SELECT * FROM tm_workspaces WHERE id=?',key),auditWorkspace=w=>!!w&&(canViewWorkspace(actor,w)||!!w.deleted_at&&(creator(actor,w)||globalWorkspaces(actor)));
  if(p.view==='audit')return paginate(all('SELECT * FROM org_audit ORDER BY id DESC').filter(r=>(!r.workspace_id||auditWorkspace(wsRow(r.workspace_id)))&&(globalWorkspaces(actor)||r.actor_id===actor||r.employee_id&&(r.employee_id===actor||inBranch(actor,r.employee_id))||r.workspace_id&&(w=>!!w&&w.kind==='ORGANIZATIONAL'&&w.governing_manager_id===actor&&governor(actor)===actor)(wsRow(r.workspace_id)))&&(!p.employee||r.employee_id===p.employee)&&(!p.workspace||r.workspace_id===p.workspace)&&(!p.actor||r.actor_id===p.actor)&&(!p.action||r.action.includes(p.action))&&(!p.from||r.created_at.slice(0,10)>=p.from)&&(!p.to||r.created_at.slice(0,10)<=p.to)));
  if(p.view==='join')return paginate(all("SELECT id,name,governing_manager_id FROM tm_workspaces WHERE kind='ORGANIZATIONAL' AND status='ACTIVE' AND joinable=1 ORDER BY name").filter(w=>!member(w.id,actor)&&(!q||w.name.toLowerCase().includes(q))));
  if(p.view==='workspaces')return paginate(all('SELECT * FROM tm_workspaces ORDER BY name').filter(w=>canViewWorkspace(actor,w)&&(!q||w.name.toLowerCase().includes(q))).map(w=>({...w,org_access:workspaceAccess(actor,w)})));
  const rows=all("SELECT l.id AS staff_id,l.name,p.nickname,p.manager_id,p.org_level,p.position,p.department,CASE WHEN u.active=1 AND l.active=1 AND COALESCE(p.active,1)=1 THEN 1 ELSE 0 END AS active FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id JOIN access_users u ON u.staff_id=l.id WHERE l.kind='staff' ORDER BY COALESCE(p.org_level,1001),l.name").map(named);
  const permitted=new Set(rows.filter(r=>visibleEmployee(actor,r.staff_id)).map(r=>r.staff_id)),counts=new Map();for(const r of rows)if(permitted.has(r.staff_id))counts.set(r.manager_id,(counts.get(r.manager_id)||0)+1);
  const result=paginate(rows.filter(r=>permitted.has(r.staff_id)&&(!q||`${r.staff_id} ${r.name} ${r.department||''} ${r.position||''}`.toLowerCase().includes(q))&&(p.parent===undefined||(p.parent==='root'?!r.manager_id||!permitted.has(r.manager_id):r.manager_id===p.parent))));
  const owned=all('SELECT * FROM tm_workspaces').filter(w=>canViewWorkspace(actor,w)),titles=all("SELECT * FROM org_grants WHERE status='ACTIVE'").filter(g=>validGrant(g));
  result.rows=result.rows.map(r=>({...r,children:counts.get(r.staff_id)||0,governing_manager_id:governor(r.staff_id),titles:uniq(titles.filter(g=>g.beneficiary_id===r.staff_id).map(g=>g.title)),workspaces:owned.filter(w=>w.owner_id===r.staff_id).map(w=>({id:w.id,name:w.name}))}));return result;
 }
 function handle(action,d,actor){
  requireActive(actor);
  if(action==='org.initialize'){
   if(settings().enabled)fail('Organizational Structure is already initialized.',409);if(!legacyAdmin(actor))fail('An existing company Administrator must initialize organization governance.',403);expected(d);
   const initial=uniq(d.level1_ids||[]);if(!initial.length)fail('Select at least one organization administrator.',422);for(const staff of initial)requireActive(staff);
   for(const staff of initial){const before=person(staff);assignPerson(staff,1,null);audit(actor,'level1.assigned',{employee:staff,before,after:person(staff),reason:requireReason(d)});}
   run('UPDATE org_settings SET enabled=1,initialized_by=?,initialized_at=? WHERE id=1',actor,now());validateTree();bump();return {type:'org_structure',message:'Organization governance initialized. Review unmapped employees and legacy workspaces before cutover.'};
  }
  if(action==='org.level.save'){requireAdmin(actor);expected(d);const key=integer(d.level,1,1000,'level'),old=get('SELECT * FROM org_levels WHERE id=?',key),name=str(d.name,'Level name',100,true);run('INSERT INTO org_levels(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=version+1',key,name);audit(actor,'level.configured',{before:old,after:{id:key,name},reason:d.reason||''});bump();return {type:'org_structure',message:'Level label saved. A label does not grant capabilities.'};}
  if(action==='org.template.save'){requireAdmin(actor);expected(d);const key=d.id||id('org-template','TITLE'),old=d.id?get('SELECT * FROM org_templates WHERE id=?',d.id):null;if(d.id&&!old)fail('Template not found.',404);const values={name:str(d.name,'Title',100,true),capabilities_json:JSON.stringify(capabilities(d.capabilities)),active:d.active===false||d.active===0?0:1,version:old?old.version+1:0};if(old)update('org_templates',key,values);else insert('org_templates',{id:key,...values});audit(actor,'template.configured',{before:old,after:values,reason:d.reason||''});bump();return {id:key,type:'org_template',message:'Template saved. Existing approved grants retain their explicit capabilities.'};}
  if(action==='org.preview'){
   if(d.workspace_id){const w=ws(d.workspace_id);if(w.kind!=='ORGANIZATIONAL'||!canManageWorkspace(actor,w))fail('Workspace not found.',404);return {type:'org_preview',revision:settings().revision,impact:{employees:[w.owner_id,w.governing_manager_id],workspaces:[w],grants:w.owner_grant_id?[w.owner_grant_id]:[],memberships:all('SELECT staff_id,workspace_id FROM tm_members WHERE workspace_id=?',w.id),requests:all("SELECT id,kind FROM org_requests WHERE workspace_id=? AND status IN('PENDING','REVIEW')",w.id)},message:'Review workspace responsibility, members and pending approvals.'};}
   const targets=d.grant_id?[]:structureChanges(d).map(x=>x.staff_id);if(targets.some(x=>!isLevel1(actor)&&x!==actor&&(!inBranch(actor,x)||governor(actor)!==actor&&!hasCapability(actor,'structure_request'))))fail('This branch is outside your scope.',403);
   if(d.grant_id){const g=get('SELECT * FROM org_grants WHERE id=?',d.grant_id);if(!g||!isLevel1(actor)&&g.governing_manager_id!==actor)fail('Grant not found.',404);}
   return {type:'org_preview',revision:settings().revision,impact:visibleImpact(actor,affected(targets,d.grant_id)),message:'Review affected employees, workspaces, grants and requests. Memberships remain unless explicitly revoked.'};
  }
  if(action==='org.structure.save')return saveStructure(d,actor);
  if(action==='org.structure.request'){
   const changes=structureChanges(d);expected(d);if(!changes.every(x=>x.staff_id===actor||inBranch(actor,x.staff_id)))fail('You can request changes only for yourself or your approved reporting branch.',403);
   if(changes.some(x=>x.staff_id!==actor)&&!hasCapability(actor,'structure_request'))fail('A structural-request capability is required.',403);
   if(!isLevel1(actor)&&governor(actor)!==actor&&changes.some(x=>x.level<3))fail('Lower levels cannot request appointment to Level 1 or Level 2.',403);
   return makeRequest('STRUCTURE',{changes,workspace_replacements:d.workspace_replacements||[],reason:requireReason(d),request_key:d.request_key},actor);
  }
  if(action==='org.workspace.delete'||action==='org.workspace.restore')return removeWorkspace(d,actor,action.endsWith('.restore'));
  if(action==='org.workspace.save')return saveWorkspace(d,actor);
  if(action==='org.workspace.classify')return classifyWorkspace(d,actor);
  if(action==='org.membership.request')return membershipRequest(d,actor);
  if(action==='org.membership.remove')return removeMember(d,actor);
  if(action==='org.delegation.request'){const p=delegationPayload(d,actor);return makeRequest('DELEGATION',p,actor,{approve:isLevel1(actor)||actor===p.governing_manager_id});}
  if(action==='org.grant.revoke'){
   const g=get('SELECT * FROM org_grants WHERE id=?',d.id)||fail('Grant not found.',404);if(!isLevel1(actor)&&g.governing_manager_id!==actor)fail('Only the governing manager or Level 1 can revoke authority.',403);expected(d);if(!d.acknowledged)fail('Review the impact before revoking authority.',422);
   if(g.status==='REVOKED')return {unchanged:true,message:'Grant already revoked.'};
   const impact=affected([],g.id);
   update('org_grants',g.id,{status:'REVOKED',version:g.version+1,updated_at:now()});replacementWorkspaces(d,actor,null,impact);reconcile(actor,requireReason(d));audit(actor,'delegation.revoked',{employee:g.beneficiary_id,workspace:g.workspace_id,before:g,after:{status:'REVOKED'},reason:d.reason});bump();return {id:g.id,type:'org_grant',message:'Authority revoked. Dependent grants were re-evaluated and invalid grants suspended.'};
  }
  if(action==='org.request.decide')return decide(d,actor);
  if(action==='org.request.cancel'){const q=get('SELECT * FROM org_requests WHERE id=?',d.id);if(!q||q.requester_id!==actor)fail('Request not found.',404);if(q.status==='CANCELLED')return {unchanged:true,message:'Already cancelled.'};if(!['PENDING','REVIEW'].includes(q.status))fail('This request has already been decided.',409);update('org_requests',q.id,{status:'CANCELLED',version:q.version+1,updated_at:now()});audit(actor,'request.cancelled',{employee:q.beneficiary_id,workspace:q.workspace_id,before:{status:q.status},after:{status:'CANCELLED'},approval:q.id});bump();return {id:q.id,type:'org_request',message:'Request cancelled.'};}
  fail('Unknown organization action.',404);
 }
 return {batch,cached,canDeleteWorkspace,canRestoreWorkspace,canArchiveWorkspace,invalidate:()=>{treeStamp=-1;},settings,active,person,level,isLevel1,globalWorkspaces,governor,descendants,inBranch,grants,validGrant,hasCapability,governed,governs,workspaceReason,canViewWorkspace,canManageWorkspace,canCreateResource,canCollaborateOutside,workspaceAccess,workspaceOverride,checkCollaborator,taskReason,meetingReason,personalTaskHidden,groupContext,employee,query,snapshot,migrationPreview,requestVisible,notificationVisible,handle,guard,afterCommand,removeMember,saveWorkspace,membershipRequest,removeWorkspace,workspaceRemoved,workspaceDashboard};
}

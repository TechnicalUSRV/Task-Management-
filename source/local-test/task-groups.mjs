// Task Management · Groups (V5.4): customizable tables inside a workspace. Server side: every change is checked here
// (access to the group, role permissions, values, formulas, versions) whatever screen or request it came from.
// A Group's rows are its own records: choosing people or a status never creates tasks or starts task workflows.
import {COLUMN_TYPES,STATUS_COLORS,DEFAULT_STATUS_LABELS,GROUP_LIMITS,LEVELS,LEVEL_LABELS,groupLevel,groupCaps,cleanName,nameKey,columnNameError,cleanCell,emptyValue,
 statusLabels,cellText,convertValue,compileFormula,formulaDisplay,formulaDependents,prepareFormulas,computeRow,formulaRefs,cleanText,
 ruleAllows,visibleColumns,matchesFilter,sortKey,cleanFilters} from './group-domain.mjs';
import {writeXlsx,readXlsx,serialToDay} from './xlsx.mjs';
import {createGroupImport} from './group-import.mjs';
import {createHash} from 'node:crypto';
import {TASK_FILE_TYPES} from './task-domain.mjs';
import {contentMatches,cleanFileName} from './file-check.mjs';

const TYPES=Object.keys(COLUMN_TYPES);
const BASE64=/^[A-Za-z0-9+/]*={0,2}$/;
const parse=(json,fallback)=>{try{const v=JSON.parse(json);return v??fallback;}catch{return fallback;}};
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
// The instant a day starts in a time zone (for note date filters in the reader's own time zone).
const nextDay=d=>new Date(Date.parse(`${d}T12:00:00Z`)+86400000).toISOString().slice(0,10);
function startOfDay(day,zone){
 const guess=Date.parse(`${day}T00:00:00Z`);
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(guess));
 const v=k=>Number(parts.find(p=>p.type===k).value),shown=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'));
 let t=guess-(shown-guess);
 // Near a daylight-saving change the first guess can be an hour off; one more step settles it.
 const again=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
 if(again!==day)t+=again<day?3600000:-3600000;
 return new Date(t).toISOString();
}

export function createGroups(c){
 const {get,all,run,insert,update,id,fail,str,choice,integer,now,hooks,log,nameOf,isMember}=c;
 const failWith=(message,status,details)=>{try{fail(message,status);}catch(e){if(details)e.details=details;throw e;}};
 upgradeColumnTypes();
 // V5.6.9 (schema 15): companies created before the Attachment column type get it added to the list of column types the
 // database accepts. SQLite can't change that check in place, so the columns table is copied once, unchanged, into a
 // new table with the longer list (foreign keys are paused meanwhile so nothing that refers to the columns is touched).
 function upgradeColumnTypes(){
  const def=get("SELECT sql FROM sqlite_master WHERE type='table' AND name='tm_board_columns'")?.sql||'';
  if(def&&!def.includes("'ATTACHMENT'")){
   const next=def.replace(/'FORMULA'\s*\)/,"'FORMULA','ATTACHMENT')").replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?tm_board_columns"?/i,'CREATE TABLE tm_board_columns_v569');
   if(!next.includes("'ATTACHMENT'")||!next.startsWith('CREATE TABLE tm_board_columns_v569'))throw new Error('The Group columns table has an unexpected definition; it was not upgraded.');
   const indexes=all("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tm_board_columns' AND sql IS NOT NULL").map(r=>r.sql);
   c.db.exec('PRAGMA foreign_keys=OFF');
   try{
    c.db.exec('BEGIN IMMEDIATE');
    try{
     c.db.exec(next);
     c.db.exec('INSERT INTO tm_board_columns_v569 SELECT * FROM tm_board_columns');
     c.db.exec('DROP TABLE tm_board_columns');
     c.db.exec('ALTER TABLE tm_board_columns_v569 RENAME TO tm_board_columns');
     for(const sql of indexes)c.db.exec(sql);
     if(all('PRAGMA foreign_key_check').length)throw new Error('The Group columns upgrade left a broken reference; nothing was changed.');
     run('INSERT OR IGNORE INTO schema_version(version) VALUES(15)');
     c.db.exec('COMMIT');
    }catch(e){c.db.exec('ROLLBACK');throw e;}
   }finally{c.db.exec('PRAGMA foreign_keys=ON');}
  }else run('INSERT OR IGNORE INTO schema_version(version) VALUES(15)');
 }
 // Role permissions for Groups. `system` is set only while the sample data of a new local database is created (before
 // anyone has a login); requests from the Task Controlling Management, Telegram and the Mini App always use the signed-in person's role.
 let system=false;
 const can=(staff,action)=>system||!!hooks.canStaff(staff,'tasks.groups',action);
 const admin=staff=>can(staff,'approve');
 const columnsOf=boardId=>all('SELECT * FROM tm_board_columns WHERE board_id=? ORDER BY position,id',boardId).map(col=>({...col,settings:parse(col.settings_json,{})}));
 const rowsOf=boardId=>all('SELECT * FROM tm_board_rows WHERE board_id=? ORDER BY position,id',boardId).map(r=>({...r,values:parse(r.values_json,{})}));
 const adminFor=(b,staff)=>hooks.organization?.groupContext(staff,b)?.admin??admin(staff);
 const levelFor=(b,staff)=>{
  const context=hooks.organization?.groupContext(staff,b);if(context?.allowed===false)return 0;
  const named=get('SELECT level FROM tm_board_access WHERE board_id=? AND staff_id=?',b.id,staff)?.level||null;
  // Viewer limits inherited workspace rights; direct Group grants/ownership stay independent.
  const board=context?.viewer?{...b,workspace_level:'VIEW'}:b;
  return groupLevel(board,staff,{member:isMember(b.workspace_id,staff),level:named,admin:adminFor(b,staff)});
 };
 // Archived groups, and groups of an archived workspace, can be opened but not changed.
 const wsActive=b=>get('SELECT status FROM tm_workspaces WHERE id=?',b.workspace_id)?.status==='ACTIVE';
 const capsFor=(b,staff)=>{const wsArchived=!wsActive(b);return groupCaps(levelFor(b,staff),a=>can(staff,a),{admin:adminFor(b,staff)&&b.visibility==='TEAM',owner:b.owner_id===staff,archived:b.status==='ARCHIVED'||wsArchived,wsArchived});};
 // A group someone may not open is reported as not found, so its existence is not revealed.
 const openBoard=(key,staff)=>{
  const b=get('SELECT * FROM tm_boards WHERE id=?',str(key,'Group',60,true));
  if(!b)fail('Group not found.',404);
  const caps=capsFor(b,staff);if(!caps.view)fail('Group not found.',404);
  return {b,caps};
 };
 const need=(caps,cap,message)=>{if(!caps[cap])fail(message,403);};
 // ---------------------------------------------------------------- V5.5 who sees which rows and columns
 // A row or column with no access rule is visible to everyone who can open the group. A rule lists the people and/or
 // roles that may see it; the people who manage the group always see everything (they keep the rules). A cell is shown
 // only when both its row and its column are visible; a formula column only when every column it uses is visible.
 const roleOf=staff=>get('SELECT role_id FROM access_users WHERE staff_id=? AND active=1',staff)?.role_id||null;
 function rulesOf(boardId){
  const rows=new Map(),cols=new Map();
  for(const r of all('SELECT row_id,principal_type,principal_id FROM tm_board_row_access WHERE board_id=?',boardId)){if(!rows.has(r.row_id))rows.set(r.row_id,[]);rows.get(r.row_id).push({type:r.principal_type,id:r.principal_id});}
  for(const r of all('SELECT column_id,principal_type,principal_id FROM tm_board_column_access WHERE board_id=?',boardId)){if(!cols.has(r.column_id))cols.set(r.column_id,[]);cols.get(r.column_id).push({type:r.principal_type,id:r.principal_id});}
  return {rows,cols};
 }
 function sight(b,staff,caps,columns=columnsOf(b.id)){
  const rules=rulesOf(b.id),seeAll=!!caps.seeAll,role=roleOf(staff);
  const visible=seeAll?columns:visibleColumns(columns,col=>ruleAllows(rules.cols.get(col.id),staff,role));
  const ids=new Set(visible.map(c=>c.id));
  return {rules,seeAll,role,columns:visible,colIds:ids,all:columns,rowOk:rowId=>seeAll||ruleAllows(rules.rows.get(rowId),staff,role),
   restricted:rules.rows.size>0||rules.cols.size>0,hiddenColumns:columns.length-visible.length};
 }
 const archivedCheck=b=>{if(b.status==='ARCHIVED')fail('This group is archived. Restore it before changing it.',409);if(!wsActive(b))fail('This group’s workspace is archived. Restore the workspace before changing its groups.',409);};
 // Workspaces where someone may create groups: the ones they belong to or own. Group administrators (Groups · Approve)
 // may create groups in any active workspace. Editing workspaces in general (a Team Member permission) is not enough.
 const workspaceAccess=(w,staff)=>hooks.organization?.governed(w)?hooks.organization.canCreateResource(staff,w):isMember(w.id,staff)||w.owner_id===staff||admin(staff);
 // People who may be chosen in In Charge and Support cells: active members of the group's workspace (and its owner)
 // who can use Task Management. A Team group shared with selected people narrows this to them. Choosing someone
 // never gives them access to the group.
 function eligible(b){
  const rows=all(`SELECT l.id,l.name,COALESCE(p.department,'') AS department,COALESCE(p.position,'') AS position,u.id AS account
   FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id LEFT JOIN access_users u ON u.staff_id=l.id
   WHERE l.kind='staff' AND l.active=1 AND COALESCE(p.active,1)=1 AND (u.id IS NULL OR u.active=1)
    AND (l.id=? OR EXISTS(SELECT 1 FROM tm_members m WHERE m.workspace_id=? AND m.staff_id=l.id)) ORDER BY l.name COLLATE NOCASE`,b.owner_id,b.workspace_id)
   .filter(p=>!p.account||hooks.canStaff(p.id,'tasks.tasks','view'));
  const allowed=b.visibility==='TEAM'&&b.audience==='SELECTED'?new Set([b.owner_id,...all('SELECT staff_id FROM tm_board_access WHERE board_id=?',b.id).map(r=>r.staff_id)]):null;
  return rows.filter(p=>!allowed||allowed.has(p.id)).map(({account:_a,...p})=>p);
 }
 const eligibleSet=b=>new Set(eligible(b).map(p=>p.id));
 const touch=(b,actor)=>update('tm_boards',b.id,{updated_at:now()});
 const record=(actor,b,action,detail='')=>log(actor,'group',b.id,b.workspace_id,action,`${b.name}${detail?' · '+detail:''}`);

 // ---------------------------------------------------------------- the group itself
 function sharedInput(input,w,owner){
  if(input===undefined||input===null)return [];
  if(!Array.isArray(input)||input.length>GROUP_LIMITS.shared)fail(`Share with up to ${GROUP_LIMITS.shared} people.`);
  const out=new Map();
  for(const x of input){
   const staff=typeof x==='string'?x:x?.staff_id,level=typeof x==='string'?'EDIT':x?.level||'EDIT';
   if(typeof staff!=='string'||!staff)fail('Choose the people to share with.');
   choice(level,['VIEW','EDIT','MANAGE'],'access level');
   if(staff===owner)continue;
   const p=get("SELECT l.id,l.name FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id LEFT JOIN access_users u ON u.staff_id=l.id WHERE l.id=? AND l.kind='staff' AND l.active=1 AND COALESCE(p.active,1)=1 AND (u.id IS NULL OR u.active=1)",staff);
   if(!p)fail('Share only with active team members.');
   if(!isMember(w.id,staff))fail(`${p.name} isn’t a member of this workspace. Add them to the workspace first.`);
   out.set(staff,level);
  }
  return [...out].map(([staff_id,level])=>({staff_id,level}));
 }
 function saveBoard(d,actor){
  const old=d.id?openBoard(d.id,actor):null;
  if(old)c.version(old.b,d.expected_version);
  const b0=old?.b,w=c.workspace(b0?.workspace_id||d.workspace_id);
  if(w.status!=='ACTIVE')fail('Restore the workspace before changing its groups.');
  if(!old){
   if(!can(actor,'create'))fail('Your role can’t create groups.',403);if(!workspaceAccess(w,actor))fail('Join this workspace before creating a group in it.',403);
   if(get('SELECT COUNT(*) AS n FROM tm_boards WHERE workspace_id=?',w.id).n>=GROUP_LIMITS.groups)fail(`This workspace already has ${GROUP_LIMITS.groups} groups, the most it can hold. Delete archived groups that are no longer needed.`,409);
  }
  else archivedCheck(b0);
  const name=str(d.name??b0?.name,'Group name',GROUP_LIMITS.name,true),description=str(d.description??b0?.description??'','Description',GROUP_LIMITS.description);
  const visibility=choice(d.visibility??b0?.visibility??'PERSONAL',['PERSONAL','TEAM'],'visibility');
  const audience=visibility==='TEAM'?choice(d.audience??b0?.audience??'SELECTED',['WORKSPACE','SELECTED'],'sharing option'):'SELECTED';
  const workspace_level=choice(d.workspace_level??b0?.workspace_level??'EDIT',['VIEW','EDIT'],'workspace access level');
  const owner=b0?.owner_id||actor;
  const shared=visibility==='TEAM'?(d.shared===undefined&&old?all('SELECT staff_id,level FROM tm_board_access WHERE board_id=?',b0.id):sharedInput(d.shared,w,owner)):[];
  const at=now();
  if(old){
   const caps=old.caps,before=all('SELECT staff_id,level FROM tm_board_access WHERE board_id=? ORDER BY staff_id',b0.id);
   const renamed=name!==b0.name||description!==b0.description,sharing=audience!==b0.audience||workspace_level!==b0.workspace_level||!same(before,[...shared].sort((x,y)=>x.staff_id<y.staff_id?-1:1));
   if(renamed)need(caps,'rename','You can’t rename this group. Ask its owner for “Can manage” access.');
   if(visibility!==b0.visibility)need(caps,'visibility','Only the group’s owner can change whether it is personal or shared.');
   if(sharing&&visibility==='TEAM')need(caps,'share','You can’t change who can open this group. Ask its owner for “Can manage” access.');
   if(!renamed&&!sharing&&visibility===b0.visibility)return {id:b0.id,type:'tm_group',message:'Nothing was changed.',unchanged:true};
   update('tm_boards',b0.id,{name,description,visibility,audience,workspace_level,version:b0.version+1,updated_at:at});
   run('DELETE FROM tm_board_access WHERE board_id=?',b0.id);for(const s of shared)insert('tm_board_access',{board_id:b0.id,...s});
   const next={...b0,name};
   if(renamed)record(actor,next,'Group renamed',name!==b0.name?`was ${b0.name}`:'description changed');
   if(visibility!==b0.visibility||sharing)record(actor,next,'Group sharing changed',visibility==='PERSONAL'?'personal':audience==='WORKSPACE'?`whole workspace · ${LEVEL_LABELS[workspace_level].toLowerCase()}${shared.length?` · ${shared.length} named`:''}`:`${shared.length} ${shared.length===1?'person':'people'}`);
   return {id:b0.id,type:'tm_group',message:'Group saved.'};
  }
  const key=id('tm-board','GRP');
  insert('tm_boards',{id:key,workspace_id:w.id,name,description,visibility,audience,workspace_level,owner_id:owner,status:'ACTIVE',archived_at:null,archived_by:null,version:0,created_by:actor,created_at:at,updated_at:at});
  for(const s of shared)insert('tm_board_access',{board_id:key,...s});
  // A new group starts with one text column, “Item”, which can be renamed or removed like any other.
  insert('tm_board_columns',{id:id('tm-board-col','COL'),board_id:key,name:'Item',name_key:nameKey('Item'),type:'TEXT',position:1,settings_json:'{}',version:0,created_at:at,updated_at:at});
  record(actor,{id:key,workspace_id:w.id,name},'Group created',visibility==='PERSONAL'?'personal':'team');
  return {id:key,type:'tm_group',message:'Group created.'};
 }
 function archiveBoard(d,actor){
  const {b,caps}=openBoard(d.id,actor);c.version(b,d.expected_version);
  const status=choice(d.status,['ACTIVE','ARCHIVED'],'group status');
  if(!wsActive(b))fail('This group’s workspace is archived. Restore the workspace before archiving, restoring or deleting its groups.',409);
  need(caps,'archive','Only the group’s owner (or a group administrator) can archive or restore it.');
  if(b.status===status)return {id:b.id,type:'tm_group',message:status==='ARCHIVED'?'Already archived.':'Already active.',unchanged:true};
  update('tm_boards',b.id,{status,archived_at:status==='ARCHIVED'?now():null,archived_by:status==='ARCHIVED'?actor:null,version:b.version+1,updated_at:now()});
  record(actor,b,status==='ARCHIVED'?'Group archived':'Group restored');
  return {id:b.id,type:'tm_group',message:status==='ARCHIVED'?'Group archived. Its rows and columns are kept; restore it to use it again.':'Group restored.'};
 }
 function deleteBoard(d,actor){
  const {b,caps}=openBoard(d.id,actor);c.version(b,d.expected_version);
  if(!wsActive(b))fail('This group’s workspace is archived. Restore the workspace before archiving, restoring or deleting its groups.',409);
  need(caps,'archive','Only the group’s owner (or a group administrator) can delete it.');
  if(b.status!=='ARCHIVED')fail('Archive the group first. Only archived groups can be deleted permanently.',409);
  if(d.confirm!==true)fail('Confirm that the group, all its columns and all its rows are deleted permanently.',409);
  const rows=get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',b.id).n,cols=get('SELECT COUNT(*) AS n FROM tm_board_columns WHERE board_id=?',b.id).n;
  run('DELETE FROM tm_board_rows WHERE board_id=?',b.id);run('DELETE FROM tm_board_columns WHERE board_id=?',b.id);run('DELETE FROM tm_board_access WHERE board_id=?',b.id);run('DELETE FROM tm_boards WHERE id=?',b.id);
  record(actor,b,'Group deleted permanently',`${cols} column${cols===1?'':'s'} · ${rows} row${rows===1?'':'s'}`);
  return {id:b.id,type:'tm_group',message:`Group deleted with its ${cols} column${cols===1?'':'s'} and ${rows} row${rows===1?'':'s'}.`};
 }

 // ---------------------------------------------------------------- columns
 function cleanLabels(input,old=[]){
  if(!Array.isArray(input)||!input.length)fail('Add at least one status label.');
  if(input.length>GROUP_LIMITS.labels)fail(`Use up to ${GROUP_LIMITS.labels} labels.`);
  let next=Math.max(0,...old.map(l=>Number(/^L(\d+)$/.exec(l.id)?.[1]||0)))+1;const seen=new Set(),ids=new Set(),out=[];
  for(const l of input){
   const name=cleanName(l?.name);if(!name)fail('Give every label a name.');if(name.length>GROUP_LIMITS.label)fail(`Use at most ${GROUP_LIMITS.label} characters for a label.`);
   if(seen.has(nameKey(name)))fail(`Two labels are named “${name}”. Use a different name for each.`);seen.add(nameKey(name));
   if(typeof l.id==='string'&&l.id){if(ids.has(l.id))fail('Each label can be listed only once. Reload the group and try again.');ids.add(l.id);}
   const keep=typeof l.id==='string'&&old.some(o=>o.id===l.id);
   out.push({id:keep?l.id:`L${next++}`,name,color:Object.hasOwn(STATUS_COLORS,l.color)?l.color:'GRAY'});
  }
  return out;
 }
 const decimalsInput=v=>v===undefined||v===null||v===''?null:integer(v,0,6,'number of decimal places (0–6)');
 function columnSave(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'structure','You can’t change this group’s columns. Ask its owner for “Can manage” access.');
  const columns=columnsOf(b.id),old=d.id?columns.find(x=>x.id===d.id):null;
  if(d.id&&!old)fail('Column not found. Reload the group.',404);
  if(old)c.version(old,d.expected_version);
  if(!old&&columns.length>=GROUP_LIMITS.columns)fail(`A group can have up to ${GROUP_LIMITS.columns} columns.`);
  const name=cleanName(d.name??old?.name),nameError=columnNameError(name,columns,old?.id);if(nameError)fail(nameError,409);
  const type=choice(d.type??old?.type,TYPES,'column type'),s=d.settings&&typeof d.settings==='object'?d.settings:{},prev=old?.settings||{};
  const key=old?.id||id('tm-board-col','COL'),at=now(),settings={};
  if(['NUMBER','FORMULA'].includes(type))settings.decimals=decimalsInput(s.decimals!==undefined?s.decimals:prev.decimals);
  let replacements={};
  if(type==='STATUS'){
   const oldLabels=old?.type==='STATUS'?statusLabels(old):[];
   settings.labels=s.labels!==undefined?cleanLabels(s.labels,oldLabels):oldLabels.length?oldLabels:cleanLabels(DEFAULT_STATUS_LABELS.map(([n,color])=>({name:n,color})));
   // Removing a label that rows use needs a replacement label, or an explicit choice to clear those cells.
   if(old?.type==='STATUS'){
    const removed=oldLabels.filter(l=>!settings.labels.some(n=>n.id===l.id)),given=d.label_replacements&&typeof d.label_replacements==='object'?d.label_replacements:{};
    const rows=rowsOf(b.id),inUse=removed.map(l=>({id:l.id,name:l.name,count:rows.filter(r=>r.values[old.id]===l.id).length})).filter(l=>l.count);
    const missing=inUse.filter(l=>!Object.hasOwn(given,l.id));
    if(missing.length)failWith(`${missing.map(l=>`“${l.name}” is used in ${l.count} row${l.count===1?'':'s'}`).join('; ')}. Choose a replacement label, or confirm that those cells are cleared.`,409,{code:'labels_in_use',labels:missing});
    for(const l of inUse){const r=given[l.id];if(r!==null&&!settings.labels.some(n=>n.id===r))fail('Choose a replacement from the remaining labels.');replacements[l.id]=r;}
   }
  }
  let formula=null;
  if(type==='FORMULA'){
   const expression=s.expression??(old?.type==='FORMULA'?formulaDisplay(prev.expression,columns):'');
   formula=compileFormula(expression,[...columns.filter(x=>x.id!==key),{id:key,name,type:'FORMULA',settings:{}}],key);
   if(!formula.ok)failWith(formula.error,422,{code:'formula',error:formula.error});
   settings.expression=formula.canonical;
  }
  // A column that formulas use must stay a Number or Formula column until those formulas change.
  if(old&&old.type!==type&&!['NUMBER','FORMULA'].includes(type)){
   const deps=formulaDependents(columns,old.id);
   if(deps.length)failWith(`${deps.map(x=>`“${x.name}”`).join(', ')} ${deps.length===1?'uses':'use'} this column in ${deps.length===1?'its formula':'their formulas'}. Change ${deps.length===1?'that formula':'those formulas'} first.`,409,{code:'dependents',columns:deps.map(x=>({id:x.id,name:x.name}))});
  }
  // Changing the type keeps every value that fits the new type; the rest are cleared only after the person confirms.
  const writes=[];
  if(old&&old.type!==type){
   const rows=rowsOf(b.id),computed=old.type==='FORMULA'?(()=>{const p=prepareFormulas(columns);return new Map(rows.map(r=>[r.id,computeRow(r.values,columns,p)[old.id]]));})():null;
   const people=new Map(eligible(b).map(p=>[nameKey(p.name),p.id]));
   let labels=settings.labels||[];
   if(type==='STATUS'&&s.labels===undefined&&old.type!=='STATUS'){
    // Text (or other) values become labels of the same name.
    const names=new Map();
    for(const r of rows){const n=cleanName(cellText(old,computed?computed.get(r.id):r.values[old.id],nameOf));if(n&&n.length<=GROUP_LIMITS.label&&!names.has(nameKey(n))&&names.size<GROUP_LIMITS.labels)names.set(nameKey(n),n);}
    if(names.size){settings.labels=cleanLabels([...names.values()].map((n,i)=>({name:n,color:Object.keys(STATUS_COLORS)[i%9]})));labels=settings.labels;}
   }
   let lost=0;const examples=[];
   for(const r of rows){
    const value=computed?computed.get(r.id):r.values[old.id];
    // V5.6.9: files can't become another kind of value; changing an Attachment column's type removes them (after confirming).
    if(old.type==='ATTACHMENT'){if(!emptyValue(value)){lost++;if(examples.length<3)examples.push(cellText(old,value,nameOf));writes.push([r,undefined]);}continue;}
    if(type==='FORMULA'){if(!emptyValue(value)&&old.type!=='FORMULA'){lost++;if(examples.length<3)examples.push(cellText(old,value,nameOf));}if(Object.hasOwn(r.values,old.id))writes.push([r,undefined]);continue;}
    const v=computed&&value&&typeof value==='object'?{ok:false}:convertValue(old,{type,settings},value,{labels,nameOf,personByName:n=>people.get(nameKey(n))||null});
    if(!v.ok){lost++;if(examples.length<3)examples.push(cellText(old,value,nameOf)||String(value));writes.push([r,undefined]);}
    else if(!same(v.value,r.values[old.id]))writes.push([r,v.value]);
   }
   if(lost&&d.confirm_clear!==true)failWith(`${lost} row${lost===1?' has a value that':'s have values that'} can’t become ${COLUMN_TYPES[type]} (${examples.map(x=>`“${String(x).slice(0,30)}”`).join(', ')}${lost>examples.length?', …':''}). Confirm to change the type and clear ${lost===1?'it':'them'}.`,409,{code:'type_change',count:lost,examples});
  }
  const values={board_id:b.id,name,name_key:nameKey(name),type,settings_json:JSON.stringify(settings),updated_at:at};
  if(old)update('tm_board_columns',key,{...values,version:old.version+1});
  else{
   // A new column goes at the end, or right after the column named in `after`.
   const after=d.after?columns.find(x=>x.id===d.after):null,position=after?after.position+1:(columns.at(-1)?.position||0)+1;
   if(after)run('UPDATE tm_board_columns SET position=position+1 WHERE board_id=? AND position>=?',b.id,position);
   insert('tm_board_columns',{id:key,...values,position,version:0,created_at:at});
  }
  for(const [r,v] of writes){const next={...r.values};if(v===undefined||v===null)delete next[key];else next[key]=v;update('tm_board_rows',r.id,{values_json:JSON.stringify(next),version:r.version+1,updated_by:actor,updated_at:at});}
  if(old?.type==='ATTACHMENT'&&type!=='ATTACHMENT')run('DELETE FROM tm_board_files WHERE column_id=?',key);
  if(Object.keys(replacements).length)for(const r of rowsOf(b.id)){const v=r.values[key];if(Object.hasOwn(replacements,v)){const next={...r.values};if(replacements[v]===null)delete next[key];else next[key]=replacements[v];update('tm_board_rows',r.id,{values_json:JSON.stringify(next),version:r.version+1,updated_by:actor,updated_at:at});}}
  touch(b,actor);
  const what=!old?`added ${name} (${COLUMN_TYPES[type]})`:[old.name!==name&&`renamed ${old.name} → ${name}`,old.type!==type&&`${name}: ${COLUMN_TYPES[old.type]} → ${COLUMN_TYPES[type]}`,type==='FORMULA'&&prev.expression!==settings.expression&&`${name} formula ${formula.display}`,type==='STATUS'&&old.type==='STATUS'&&!same(prev.labels,settings.labels)&&`${name} labels`,['NUMBER','FORMULA'].includes(type)&&prev.decimals!==settings.decimals&&old.type===type&&`${name} decimals`].filter(Boolean).join(' · ')||`${name} settings`;
  record(actor,b,old?'Column changed':'Column added',what);
  return {id:key,type:'tm_group_column',message:old?'Column saved.':'Column added.'};
 }
 function columnMove(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'structure','You can’t reorder this group’s columns. Ask its owner for “Can manage” access.');
  const columns=columnsOf(b.id),order=Array.isArray(d.order)?d.order:null;
  if(!order||order.length!==columns.length||new Set(order).size!==order.length||order.some(x=>!columns.some(col=>col.id===x)))fail('The columns changed while you were moving them. Reload the group and try again.',409);
  order.forEach((key,i)=>run('UPDATE tm_board_columns SET position=? WHERE id=?',i+1,key));
  touch(b,actor);record(actor,b,'Columns reordered',order.map(x=>columns.find(col=>col.id===x).name).join(', '));
  return {id:b.id,type:'tm_group',message:'Columns reordered.'};
 }
 function columnDelete(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'deleteColumns','You can’t delete this group’s columns. Deleting a column needs “Can manage” access and the Delete permission for Groups.');
  const columns=columnsOf(b.id),col=columns.find(x=>x.id===d.id);if(!col)fail('Column not found. Reload the group.',404);
  c.version(col,d.expected_version);
  const deps=formulaDependents(columns,col.id);
  if(deps.length)failWith(`“${col.name}” is used by ${deps.map(x=>`“${x.name}”`).join(', ')}. Change or delete ${deps.length===1?'that formula':'those formulas'} first.`,409,{code:'dependents',columns:deps.map(x=>({id:x.id,name:x.name}))});
  if(columns.length===1)fail('A group needs at least one column. Add another column before deleting this one.',409);
  const rows=rowsOf(b.id),filled=rows.filter(r=>!emptyValue(r.values[col.id])).length;
  if(filled&&d.confirm!==true)failWith(`“${col.name}” has values in ${filled} row${filled===1?'':'s'}. Confirm to delete the column and its values.`,409,{code:'confirm_delete',count:filled});
  for(const r of rows)if(Object.hasOwn(r.values,col.id)){const next={...r.values};delete next[col.id];update('tm_board_rows',r.id,{values_json:JSON.stringify(next),version:r.version+1,updated_by:actor,updated_at:now()});}
  run('DELETE FROM tm_board_columns WHERE id=?',col.id);
  touch(b,actor);record(actor,b,'Column deleted',`${col.name} (${COLUMN_TYPES[col.type]})${filled?` · ${filled} value${filled===1?'':'s'} removed`:''}`);
  return {id:b.id,type:'tm_group',message:`Column “${col.name}” deleted.`};
 }

 // ---------------------------------------------------------------- rows
 // Checks the values typed for a row. Formula columns are always calculated here, never taken from the request.
 function cleanValues(b,columns,input,current={},cache=null){
  if(input===undefined||input===null)return {};
  if(typeof input!=='object'||Array.isArray(input))fail('Send the row values by column.');
  // cache: {people} kept across many rows (an import), so the people who can be chosen are looked up once.
  let people=cache?.people||null;const out={};
  for(const [key,value] of Object.entries(input)){
   // `columns` holds only the columns this person may see, so a hidden column is answered like a missing one.
   const col=columns.find(x=>x.id===key);if(!col)failWith('A column was deleted or changed. Reload the group.',409,{code:'column_missing',column:key});
   if(['IN_CHARGE','SUPPORT'].includes(col.type)&&!people){people=eligibleSet(b);if(cache)cache.people=people;}
   const r=cleanCell(col,value,{eligible:people,current:current[key]??null});
   if(!r.ok)failWith(`${col.name}: ${r.error}`,422,{code:'value',column:key,error:r.error});
   out[key]=r.value;
  }
  return out;
 }
 // A row as one person may see it: only the values of their visible columns (formula results computed from all the
 // columns, but only for formulas whose every input they can see), with its note count and, for the people who manage
 // the group, its access rule.
 const rowOut=(r,s,prepared,extra={})=>{
  const computed=computeRow(r.values,s.all,prepared),values={},results={};
  for(const c of s.columns){if(c.type==='FORMULA')results[c.id]=computed[c.id]??null;else if(Object.hasOwn(r.values,c.id))values[c.id]=r.values[c.id];}
  return {id:r.id,...(s.seeAll||!s.rules.rows.size?{position:r.position}:{}),version:r.version,values,computed:results,created_by:r.created_by,created_at:r.created_at,updated_by:r.updated_by,updated_at:r.updated_at,
   ...(s.seeAll?{access:s.rules.rows.get(r.id)||null}:{}),...extra};
 };
 function rowAdd(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'addRows','You can’t add records to this group.');
  if(get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',b.id).n>=GROUP_LIMITS.rows)fail(`A group can hold up to ${GROUP_LIMITS.rows.toLocaleString('en-US')} rows. Archive old rows into another group first.`);
  const all_=columnsOf(b.id),s=sight(b,actor,caps,all_),values=Object.fromEntries(Object.entries(cleanValues(b,s.columns,d.values)).filter(([,v])=>!emptyValue(v)));
  const after=d.after?get('SELECT * FROM tm_board_rows WHERE id=? AND board_id=?',d.after,b.id):null;
  if(d.after&&(!after||!s.rowOk(after.id)))fail('This row was deleted. Reload the group.',404);
  const position=after?after.position+1:(get('SELECT MAX(position) AS p FROM tm_board_rows WHERE board_id=?',b.id).p||0)+1;
  if(after)run('UPDATE tm_board_rows SET position=position+1 WHERE board_id=? AND position>=?',b.id,position);
  const key=id('tm-board-row','ROW'),at=now(),json=JSON.stringify(values);sizeCheck(b,json);
  insert('tm_board_rows',{id:key,board_id:b.id,position,values_json:json,version:0,created_by:actor,created_at:at,updated_by:actor,updated_at:at});
  // The activity names rows by their ID, never by their values (some people may not see every column).
  touch(b,actor);record(actor,b,'Row added',key);
  const r=get('SELECT * FROM tm_board_rows WHERE id=?',key);
  return {id:key,type:'tm_group_row',message:'Row added.',row:rowOut({...r,values},s,prepareFormulas(all_),{notes:0})};
 }
 // What a group stores is limited per row and per group (characters of the saved values), checked when rows grow.
 function sizeCheck(b,json,before=0){
  const n=x=>x.toLocaleString('en-US');
  if(json.length>GROUP_LIMITS.rowChars)fail(`This row is too large: ${n(json.length)} characters, and a row can hold up to ${n(GROUP_LIMITS.rowChars)} in all. Shorten some long texts.`,422);
  const total=get('SELECT COALESCE(SUM(LENGTH(values_json)),0) AS n FROM tm_board_rows WHERE board_id=?',b.id).n-before+json.length;
  if(total>GROUP_LIMITS.groupChars)fail(`This group is full: its rows can hold up to ${n(GROUP_LIMITS.groupChars)} characters in all. Shorten long texts, or move old rows to another group.`,422);
 }
 function rowUpdate(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'editRows','You can’t change records in this group.');
  const r0=get('SELECT * FROM tm_board_rows WHERE id=? AND board_id=?',str(d.id,'Row',60,true),b.id);
  const all_=columnsOf(b.id),s=sight(b,actor,caps,all_);
  if(!r0||!s.rowOk(r0.id))fail('This row was deleted. Reload the group.',404);
  const r={...r0,values:parse(r0.values_json,{})},columns=s.columns;
  // A column this person can't see is answered like a deleted one (before any value is compared).
  for(const key of Object.keys(d.values&&typeof d.values==='object'?d.values:{}))if(!s.colIds.has(key))failWith('A column was deleted or changed. Reload the group.',409,{code:'column_missing',column:key});
  // Conflicts: each changed cell must still hold the value the person saw (or the row its version), so nobody's
  // change is silently overwritten.
  if(d.expected_version!==undefined&&d.expected_version!==null)c.version(r,d.expected_version);
  else{
   const expected=d.expected&&typeof d.expected==='object'?d.expected:null;
   if(!expected)fail('Send the values you started from, so changes by others are not overwritten.',400);
   for(const key of Object.keys(d.values||{})){
    if(!Object.hasOwn(expected,key))fail('Send the values you started from, so changes by others are not overwritten.',400);
    const now_=r.values[key]??null,was=expected[key]===''?null:expected[key]??null;
    if(!same(now_,was)){const col=columns.find(x=>x.id===key);failWith(`Someone changed “${col?.name||'this cell'}” in this row to ${col?`“${cellText(col,now_,nameOf)||'empty'}”`:'another value'} while you were editing. Your change was not saved: check the new value and try again.`,409,{code:'cell_conflict',column:key,current:now_});}
   }
  }
  const changes=cleanValues(b,columns,d.values,r.values),next={...r.values};
  for(const [key,v] of Object.entries(changes)){if(emptyValue(v))delete next[key];else next[key]=v;}
  const notes=get('SELECT COUNT(*) AS n FROM tm_board_notes WHERE row_id=? AND deleted_at IS NULL',r.id).n;
  if(same(next,r.values))return {id:r.id,type:'tm_group_row',message:'No change.',unchanged:true,row:rowOut(r,s,prepareFormulas(all_),{notes})};
  const at=now(),json=JSON.stringify(next);if(json.length>r0.values_json.length)sizeCheck(b,json,r0.values_json.length);
  update('tm_board_rows',r.id,{values_json:json,version:r.version+1,updated_by:actor,updated_at:at});touch(b,actor);
  // V5.6.9: files taken out of an Attachment cell are deleted with it.
  for(const key of Object.keys(changes)){
   const col=columns.find(x=>x.id===key);if(col?.type!=='ATTACHMENT')continue;
   const kept=new Set((Array.isArray(next[key])?next[key]:[]).map(f=>f.id));
   for(const f of Array.isArray(r.values[key])?r.values[key]:[])if(!kept.has(f.id)){run('DELETE FROM tm_board_files WHERE id=? AND board_id=?',f.id,b.id);record(actor,b,'File removed',`${r.id} · ${col.name} · ${f.name}`);}
  }
  return {id:r.id,type:'tm_group_row',message:'Saved.',row:rowOut({...r,values:next,version:r.version+1,updated_by:actor,updated_at:at},s,prepareFormulas(all_),{notes})};
 }
 // ---------------------------------------------------------------- V5.6.9 files in Attachment columns
 // Anyone who can edit the group's records adds files to (and removes them from) the Attachment cells they can see. The
 // file is kept on the server; the cell keeps its name, size and type, so tables, exports and search show the names.
 function attachmentCell(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'editRows','You can’t change records in this group.');
  const all_=columnsOf(b.id),s=sight(b,actor,caps,all_);
  const r0=get('SELECT * FROM tm_board_rows WHERE id=? AND board_id=?',str(d.row_id,'Row',60,true),b.id);
  if(!r0||!s.rowOk(r0.id))fail('This row was deleted. Reload the group.',404);
  const col=s.columns.find(x=>x.id===d.column_id);
  if(!col)failWith('A column was deleted or changed. Reload the group.',409,{code:'column_missing',column:d.column_id});
  if(col.type!=='ATTACHMENT')fail('Files can be added only to Attachment columns.',409);
  const r={...r0,values:parse(r0.values_json,{})};
  return {b,s,all_,col,r,list:Array.isArray(r.values[col.id])?r.values[col.id]:[]};
 }
 const savedRow=(b,s,all_,r,next,actor,at)=>{
  update('tm_board_rows',r.id,{values_json:JSON.stringify(next),version:r.version+1,updated_by:actor,updated_at:at});touch(b,actor);
  const notes=get('SELECT COUNT(*) AS n FROM tm_board_notes WHERE row_id=? AND deleted_at IS NULL',r.id).n;
  return rowOut({...r,values:next,version:r.version+1,updated_by:actor,updated_at:at},s,prepareFormulas(all_),{notes});
 };
 function fileAdd(d,actor){
  const {b,s,all_,col,r,list}=attachmentCell(d,actor);
  const name=cleanFileName(str(d.name,'File name',160,true)),ext=name.includes('.')?name.split('.').pop().toLowerCase():'';
  if(!Object.hasOwn(TASK_FILE_TYPES,ext))fail('Attach an image (JPG, PNG, WebP, GIF, HEIC), a PDF, a Word, Excel or PowerPoint document, or a CSV, TXT or ZIP file.');
  const max=GROUP_LIMITS.fileBytes,size=`${max/1024/1024} MB`;
  if(typeof d.base64!=='string'||!d.base64.length||d.base64.length>Math.ceil(max*4/3)+8||!BASE64.test(d.base64))fail(`Choose a file between 1 byte and ${size}.`);
  const content=Buffer.from(d.base64,'base64');if(!content.length||content.length>max)fail(`Choose a file between 1 byte and ${size}.`);
  if(!contentMatches(ext,content))fail(`This file is not a real ${ext.toUpperCase()} file. Choose the original file.`);
  if(list.length>=GROUP_LIMITS.files)fail(`A cell can hold up to ${GROUP_LIMITS.files} files. Remove one first.`,409);
  const used=get('SELECT COALESCE(SUM(size),0) AS n FROM tm_board_files WHERE board_id=?',b.id).n;
  if(used+content.length>GROUP_LIMITS.groupFileBytes)fail(`This group’s files are full (${GROUP_LIMITS.groupFileBytes/1024/1024} MB in all). Remove files that are no longer needed.`,409);
  const key=id('tm-board-file','GFILE'),at=now(),meta={id:key,name,size:content.length,mime:TASK_FILE_TYPES[ext],by:actor,at};
  insert('tm_board_files',{id:key,board_id:b.id,row_id:r.id,column_id:col.id,name,mime:meta.mime,size:meta.size,content,uploaded_by:actor,created_at:at});
  const next={...r.values,[col.id]:[...list,meta]};sizeCheck(b,JSON.stringify(next),r.values_json.length);
  const row=savedRow(b,s,all_,r,next,actor,at);
  record(actor,b,'File attached',`${r.id} · ${col.name} · ${name}`);
  return {id:key,type:'tm_group_file',message:`${name} attached.`,row};
 }
 function fileRemove(d,actor){
  const {b,s,all_,col,r,list}=attachmentCell(d,actor);
  const f=list.find(x=>x.id===d.file_id);
  if(!f)fail('This file was already removed. Reload the group.',404);
  run('DELETE FROM tm_board_files WHERE id=? AND board_id=?',f.id,b.id);
  const rest=list.filter(x=>x.id!==f.id),next={...r.values};if(rest.length)next[col.id]=rest;else delete next[col.id];
  const row=savedRow(b,s,all_,r,next,actor,now());
  record(actor,b,'File removed',`${r.id} · ${col.name} · ${f.name}`);
  return {id:f.id,type:'tm_group_file',message:`${f.name} removed.`,row};
 }
 /** One file of an Attachment cell, for someone who may see that row and that column. */
 function file(key,staff,fileId){
  const {b,caps}=openBoard(key,staff),s=sight(b,staff,caps);
  const f=get('SELECT * FROM tm_board_files WHERE id=? AND board_id=?',String(fileId||'').slice(0,60),b.id);
  if(!f||!s.rowOk(f.row_id)||!s.colIds.has(f.column_id))fail('File not found.',404);
  return f;
 }
 function rowMove(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'editRows','You can’t reorder records in this group.');
  // Positions are among the rows this person can see; rows hidden from them keep their place relative to the others.
  const s=sight(b,actor,caps),rows=rowsOf(b.id),seen=rows.filter(x=>s.rowOk(x.id)),row=seen.find(x=>x.id===d.id);if(!row)fail('This row was deleted. Reload the group.',404);
  const to=integer(d.to,0,Math.max(0,seen.length-1),'row position'),order=seen.filter(x=>x.id!==row.id);order.splice(to,0,row);
  const anchor=order[to+1]||null,rest=rows.filter(x=>x.id!==row.id),at=anchor?rest.findIndex(x=>x.id===anchor.id):rest.length;
  rest.splice(at<0?rest.length:at,0,row);
  rest.forEach((x,i)=>{if(x.position!==i+1)run('UPDATE tm_board_rows SET position=? WHERE id=?',i+1,x.id);});
  touch(b,actor);
  return {id:row.id,type:'tm_group_row',message:'Row moved.'};
 }
 // V5.5: one row, the selected rows, or every row matching a search and filters. Every row is checked first (it still
 // exists, this person can see it, and it has not changed since they selected it); if any fails, nothing is deleted and
 // the reason is given. Notes on the deleted rows and their access rules go with them.
 function rowDelete(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'deleteRows','You can’t delete records in this group.');
  const s=sight(b,actor,caps);let targets;
  if(d.match&&typeof d.match==='object'){
   const items=matchingRows(b,actor,caps,s,d.match),ids=items.map(x=>x.r.id);
   if(!Number.isInteger(d.expected_count)||d.expected_count!==ids.length)failWith(`The rows matching your search and filters changed: ${ids.length} match now${Number.isInteger(d.expected_count)?`, ${d.expected_count} when you selected them`:''}. Nothing was deleted; check the list and try again.`,409,{code:'bulk_changed',count:ids.length});
   // The same number is not enough: the rows themselves (and their versions) must be the ones the person saw.
   if(typeof d.match_key!=='string'||d.match_key!==matchKey(items))failWith('Some of the rows matching your search and filters were added, changed or deleted since you selected them. Nothing was deleted; check the list and try again.',409,{code:'bulk_changed',count:ids.length});
   targets=items.map(({r})=>({id:r.id,version:r.version}));
  }else{
   const ids=Array.isArray(d.ids)?d.ids:[d.id];
   if(!ids.length||ids.length>GROUP_LIMITS.bulk||ids.some(x=>typeof x!=='string'||!x||x.length>60))fail(`Choose 1 to ${GROUP_LIMITS.bulk.toLocaleString('en-US')} rows to delete.`);
   const versions=d.expected&&typeof d.expected==='object'?d.expected:{};
   targets=[...new Set(ids)].map(id=>({id,version:ids.length===1&&Number.isInteger(d.expected_version)?d.expected_version:Number.isInteger(versions[id])?versions[id]:null}));
  }
  if(!targets.length)fail('No rows match, so nothing was deleted.',409);
  const missing=[],changed=[],found=[];
  for(const t of targets){
   const r=get('SELECT id,version FROM tm_board_rows WHERE id=? AND board_id=?',t.id,b.id);
   if(!r||!s.rowOk(r.id)){missing.push(t.id);continue;}
   if(t.version!==null&&r.version!==t.version){changed.push(t.id);continue;}
   found.push(r.id);
  }
  if(targets.length===1&&missing.length)fail('This row was already deleted.',404);
  if(targets.length===1&&changed.length)fail('This row changed. Refresh it before deleting it.',409);
  if(missing.length||changed.length)failWith(`${[missing.length&&`${missing.length} of the selected rows ${missing.length===1?'was':'were'} already deleted or ${missing.length===1?'is':'are'} no longer available to you`,changed.length&&`${changed.length} ${changed.length===1?'was':'were'} changed by someone since you selected ${changed.length===1?'it':'them'}`].filter(Boolean).join(', and ')}. Nothing was deleted: reload the group, check the selection and try again.`,409,{code:'bulk_conflict',missing,changed});
  for(let i=0;i<found.length;i+=400){const part=found.slice(i,i+400);run(`DELETE FROM tm_board_rows WHERE board_id=? AND id IN (${part.map(()=>'?').join(',')})`,b.id,...part);}
  c.hooks.groupRowsDeleted?.(b,found,actor);
  touch(b,actor);record(actor,b,found.length===1?'Row deleted':'Rows deleted',found.length===1?found[0]:`${found.length} rows`);
  return {id:b.id,type:'tm_group',deleted:found.length,message:found.length===1?'Row deleted.':`${found.length} rows deleted.`};
 }

 // ---------------------------------------------------------------- V5.5 access rules for rows and columns
 function principalsInput(b,input){
  if(input===null||input===undefined)return [];
  if(!Array.isArray(input)||input.length>GROUP_LIMITS.principals)fail(`Choose up to ${GROUP_LIMITS.principals} people or roles.`);
  const out=new Map();
  for(const p of input){
   const type=p?.type,key=p?.id;
   if(!['USER','ROLE'].includes(type)||typeof key!=='string'||!key)fail('Choose people or roles.');
   if(type==='ROLE'){if(!get('SELECT id FROM access_roles WHERE id=?',key))fail('A chosen role no longer exists. Reload and try again.',409);}
   // People must be able to open the group: access rules narrow the group's own sharing, they never widen it.
   else if(!get("SELECT 1 AS ok FROM lookups WHERE id=? AND kind='staff' AND active=1",key)||levelFor(b,key)<1)fail(`${nameOf(key)} can’t open this group. Share the group with them first.`,409);
   out.set(`${type}:${key}`,{type,id:key});
  }
  return [...out.values()];
 }
 const describe=list=>list.length?list.map(p=>p.type==='ROLE'?`role ${get('SELECT name FROM access_roles WHERE id=?',p.id)?.name||p.id}`:nameOf(p.id)).join(', '):'everyone in the group';
 function rowAccess(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'share','Only the people who manage this group can decide who sees its rows. Changing a cell does not include that.');
  const ids=Array.isArray(d.ids)?[...new Set(d.ids)]:[];if(!ids.length||ids.length>GROUP_LIMITS.bulk)fail('Choose the rows.');
  for(const key of ids)if(!get('SELECT 1 AS ok FROM tm_board_rows WHERE id=? AND board_id=?',key,b.id))fail('A chosen row was deleted. Reload the group.',404);
  const list=principalsInput(b,d.principals);
  for(const key of ids){run('DELETE FROM tm_board_row_access WHERE row_id=?',key);for(const p of list)insert('tm_board_row_access',{row_id:key,board_id:b.id,principal_type:p.type,principal_id:p.id});}
  touch(b,actor);record(actor,b,'Row access changed',`${ids.length} row${ids.length===1?'':'s'} · visible to ${describe(list)}`);
  return {id:b.id,type:'tm_group',message:list.length?`${ids.length===1?'The row is':`${ids.length} rows are`} now visible only to ${describe(list)} (and the people who manage the group).`:`${ids.length===1?'The row is':`${ids.length} rows are`} visible to everyone in the group again.`};
 }
 function columnAccess(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'share','Only the people who manage this group can decide who sees its columns.');
  const col=get('SELECT * FROM tm_board_columns WHERE id=? AND board_id=?',String(d.id||''),b.id);if(!col)fail('Column not found. Reload the group.',404);
  const list=principalsInput(b,d.principals);
  run('DELETE FROM tm_board_column_access WHERE column_id=?',col.id);for(const p of list)insert('tm_board_column_access',{column_id:col.id,board_id:b.id,principal_type:p.type,principal_id:p.id});
  const deps=formulaDependents(columnsOf(b.id),col.id);
  touch(b,actor);record(actor,b,'Column access changed',`${col.name} · visible to ${describe(list)}`);
  return {id:col.id,type:'tm_group_column',message:list.length?`“${col.name}” is now visible only to ${describe(list)} (and the people who manage the group).${deps.length?` Formulas that use it (${deps.map(x=>`“${x.name}”`).join(', ')}) are hidden from everyone else too.`:''}`:`“${col.name}” is visible to everyone in the group again.`};
 }

 // ---------------------------------------------------------------- V5.5 layouts: each person's own, and a shared default
 const viewOf=(boardId,staff)=>parse(get('SELECT view_json FROM tm_board_views WHERE board_id=? AND staff_id=?',boardId,staff)?.view_json,{});
 function cleanLayout(input,columns,{personal}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Send the layout.');
  const ids=new Set(columns.map(x=>x.id)),[lo,hi]=GROUP_LIMITS.width,out={};
  if(input.widths!==undefined){
   if(!input.widths||typeof input.widths!=='object'||Array.isArray(input.widths))fail('Send the column widths.');
   out.widths={};for(const [k,v] of Object.entries(input.widths))if(ids.has(k)&&Number.isFinite(Number(v)))out.widths[k]=Math.round(Math.max(lo,Math.min(hi,Number(v))));
  }
  if(input.order!==undefined){if(!Array.isArray(input.order))fail('Send the column order.');out.order=[...new Set(input.order.filter(x=>ids.has(x)))];}
  // V5.6.9: the width of the row-number column (the first column on the left).
  if(input.rownum!==undefined){const [a,z]=GROUP_LIMITS.rownumWidth;if(!Number.isFinite(Number(input.rownum)))fail('Send the column widths.');out.rownum=Math.round(Math.max(a,Math.min(z,Number(input.rownum))));}
  if(personal&&input.hidden_columns!==undefined){if(!Array.isArray(input.hidden_columns))fail('Send the hidden columns.');out.hidden_columns=[...new Set(input.hidden_columns.filter(x=>ids.has(x)))];}
  if(personal&&input.hidden_rows!==undefined){if(!Array.isArray(input.hidden_rows)||input.hidden_rows.length>GROUP_LIMITS.bulk)fail('Send the hidden rows.');out.hidden_rows=[...new Set(input.hidden_rows.filter(x=>typeof x==='string'&&x.length<=60))];}
  return out;
 }
 function viewSave(d,actor){
  const {b,caps}=openBoard(d.group_id,actor),s=sight(b,actor,caps);
  if(d.reset===true){run('DELETE FROM tm_board_views WHERE board_id=? AND staff_id=?',b.id,actor);return {id:b.id,type:'tm_group_view',message:'Your layout is back to the group’s default.'};}
  const next={...viewOf(b.id,actor),...cleanLayout(d.view,s.columns,{personal:true})};
  run('INSERT INTO tm_board_views(board_id,staff_id,view_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(board_id,staff_id) DO UPDATE SET view_json=excluded.view_json,updated_at=excluded.updated_at',b.id,actor,JSON.stringify(next),now());
  return {id:b.id,type:'tm_group_view',message:'Your layout is saved.'};
 }
 function layoutSave(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'structure','Only the people who manage this group can save its default layout for everyone.');
  const columns=columnsOf(b.id),layout=cleanLayout(d.layout,columns,{personal:false}),before=parse(b.layout_json,{});
  if(layout.order){const rest=columns.map(x=>x.id).filter(x=>!layout.order.includes(x));[...layout.order,...rest].forEach((key,i)=>run('UPDATE tm_board_columns SET position=? WHERE id=?',i+1,key));}
  update('tm_boards',b.id,{layout_json:JSON.stringify({...before,...(layout.widths?{widths:layout.widths}:{}),...(layout.rownum!==undefined?{rownum:layout.rownum}:{})}),updated_at:now()});
  record(actor,b,'Default layout saved',[layout.widths&&'column widths',layout.order&&'column order'].filter(Boolean).join(' and ')||'layout');
  return {id:b.id,type:'tm_group',message:'Saved as the default layout for everyone. People who arranged their own view keep it until they reset it.'};
 }

 // ---------------------------------------------------------------- V5.5 notes on rows
 // Notes are kept in order and never replaced. The author can edit or delete their own notes and the people who manage
 // the group can delete any note; the earlier text is kept in the note's history (seen by its author and the managers).
 const noteRow=(b,s,rowId)=>{const r=get('SELECT id FROM tm_board_rows WHERE id=? AND board_id=?',String(rowId||''),b.id);if(!r||!s.rowOk(r.id))fail('This row was deleted. Reload the group.',404);return r;};
 function noteAction(action,d,actor){
  const {b,caps}=openBoard(d.group_id,actor),s=sight(b,actor,caps);
  if(action==='tm.group.note.add'){
   archivedCheck(b);need(caps,'notes','You can read the notes of this group, but adding notes needs “Can edit records” access.');
   const row=noteRow(b,s,d.row_id),text=cleanText(d.body);if(!text.ok)fail(text.error.replace('in a cell','in a note'));if(!text.value)fail('Write the note first.');
   if(text.value.length>GROUP_LIMITS.note)fail(`Use at most ${GROUP_LIMITS.note.toLocaleString('en-US')} characters in a note.`);
   if(get('SELECT COUNT(*) AS n FROM tm_board_notes WHERE row_id=?',row.id).n>=GROUP_LIMITS.notesPerRow)fail('This row already has the most notes it can hold.',409);
   const key=id('tm-board-note','GNOTE');
   insert('tm_board_notes',{id:key,board_id:b.id,row_id:row.id,author_id:actor,body:text.value,created_at:now(),edited_at:null,deleted_at:null,deleted_by:null,version:0});
   return {id:key,type:'tm_group_note',message:'Note added.'};
  }
  const n=get('SELECT * FROM tm_board_notes WHERE id=? AND board_id=?',String(d.id||''),b.id);
  if(!n||!s.rowOk(n.row_id))fail('Note not found.',404);
  c.version(n,d.expected_version);
  if(n.deleted_at)fail('This note was deleted.',409);
  archivedCheck(b);
  if(action==='tm.group.note.edit'){
   if(n.author_id!==actor)fail('Only the person who wrote this note can edit it.',403);
   need(caps,'notes','You can read the notes of this group, but changing notes needs “Can edit records” access.');
   const text=cleanText(d.body);if(!text.ok)fail(text.error.replace('in a cell','in a note'));if(!text.value)fail('A note can’t be empty. Delete it instead.');
   if(text.value.length>GROUP_LIMITS.note)fail(`Use at most ${GROUP_LIMITS.note.toLocaleString('en-US')} characters in a note.`);
   if(text.value===n.body)return {id:n.id,type:'tm_group_note',message:'No change.',unchanged:true};
   insert('tm_board_note_revisions',{note_id:n.id,body:n.body,action:'EDIT',actor_id:actor,created_at:now()});
   update('tm_board_notes',n.id,{body:text.value,edited_at:now(),version:n.version+1});
   return {id:n.id,type:'tm_group_note',message:'Note saved. The earlier text is kept in its history.'};
  }
  if(action==='tm.group.note.delete'){
   if(!caps.share&&!(n.author_id===actor&&caps.notes))fail(n.author_id===actor?'You can read the notes of this group, but deleting notes needs “Can edit records” access.':'Only the person who wrote this note, or someone who manages the group, can delete it.',403);
   insert('tm_board_note_revisions',{note_id:n.id,body:n.body,action:'DELETE',actor_id:actor,created_at:now()});
   update('tm_board_notes',n.id,{body:'',deleted_at:now(),deleted_by:actor,version:n.version+1});
   return {id:n.id,type:'tm_group_note',message:'Note deleted. The deletion is kept in the row’s history.'};
  }
  fail('Unknown note action.',404);
 }

 function handle(action,d,actor){
  switch(action){
   case 'tm.group.save':return saveBoard(d,actor);
   case 'tm.group.archive':return archiveBoard(d,actor);
   case 'tm.group.delete':return deleteBoard(d,actor);
   case 'tm.group.column.save':return columnSave(d,actor);
   case 'tm.group.column.move':return columnMove(d,actor);
   case 'tm.group.column.delete':return columnDelete(d,actor);
   case 'tm.group.row.add':return rowAdd(d,actor);
   case 'tm.group.row.update':return rowUpdate(d,actor);
   case 'tm.group.row.move':return rowMove(d,actor);
   case 'tm.group.row.delete':return rowDelete(d,actor);
   case 'tm.group.row.access':return rowAccess(d,actor);
   case 'tm.group.file.add':return fileAdd(d,actor);
   case 'tm.group.file.remove':return fileRemove(d,actor);
   case 'tm.group.column.access':return columnAccess(d,actor);
   case 'tm.group.view.save':return viewSave(d,actor);
   case 'tm.group.layout.save':return layoutSave(d,actor);
   case 'tm.group.note.add':case 'tm.group.note.edit':case 'tm.group.note.delete':return noteAction(action,d,actor);
   case 'tm.group.import.upload':return imports.upload(d,actor);
   case 'tm.group.import.commit':return imports.commit(d,actor);
   default:fail('Unknown group action.',404);
  }
 }

 // ---------------------------------------------------------------- reading (never through commands, so nothing changes)
 // V5.5: rows are searched, filtered, sorted, totalled and paged here, over the rows and columns this person may see,
 // so a browser never receives a value it may not show (and never has to download a whole group to filter it).
 const noteCounts=boardId=>new Map(all('SELECT row_id,COUNT(*) AS n FROM tm_board_notes WHERE board_id=? AND deleted_at IS NULL GROUP BY row_id',boardId).map(r=>[r.row_id,r.n]));
 function matchingRows(b,staff,caps,s,p={}){
  const prepared=prepareFormulas(s.all),view=viewOf(b.id,staff),hiddenRows=new Set(p.hidden?[]:view.hidden_rows||[]);
  const q=String(p.q||'').trim().toLowerCase().slice(0,200),filters=cleanFilters(p.filters);
  if(filters===null)fail('Invalid filters.',400);
  const cols=s.columns,byId=new Map(cols.map(x=>[x.id,x]));
  const sort=p.sort&&byId.has(String(p.sort))?byId.get(String(p.sort)):null,desc=p.dir==='desc';
  // People's names are looked up once per search (a group can name the same people in thousands of cells).
  const names=new Map(),name=id=>{if(!names.has(id))names.set(id,nameOf(id));return names.get(id);};
  const needsText=!!q||filters.some(f=>byId.get(f.col)?.type==='TEXT')||!!sort&&!['NUMBER','FORMULA','STATUS'].includes(sort.type);
  const items=[];
  for(const r of rowsOf(b.id)){
   if(!s.rowOk(r.id)||hiddenRows.has(r.id))continue;
   const computed=computeRow(r.values,s.all,prepared),value=col=>col.type==='FORMULA'?computed[col.id]:r.values[col.id];
   const text=col=>needsText?cellText(col,value(col),name):'';
   if(q&&!cols.some(col=>text(col).toLowerCase().includes(q)))continue;
   if(!filters.every(f=>{const col=byId.get(f.col);return !col||matchesFilter(col,value(col),f,text(col));}))continue;
   items.push({r,computed,key:sort?sortKey(sort,value(sort),text(sort)):null});
  }
  if(sort){
   const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
   items.sort((a,x)=>{const u=a.key,v=x.key;if(u===null||v===null)return u===v?0:u===null?1:-1;const r=typeof u==='number'&&typeof v==='number'?u-v:collator.compare(String(u),String(v));return desc?-r:r;});
  }
  return items;
 }
 /** A fingerprint of a result (its rows and their versions), so “delete all matching” acts on exactly what was shown. */
 const matchKey=items=>createHash('sha256').update(items.map(({r})=>`${r.id}:${r.version}`).sort().join('|')).digest('base64url').slice(0,32);
 function totalsOf(items,s){
  const out={};
  for(const col of s.columns)if(col.type==='NUMBER'||col.type==='FORMULA'){
   let sum=0,errors=0,count=0;
   for(const {r,computed} of items){const v=col.type==='FORMULA'?computed[col.id]:r.values[col.id];if(v&&typeof v==='object')errors++;else if(typeof v==='number'){sum+=v;count++;}else if(typeof v==='boolean')count++;}
   out[col.id]={sum:Number(sum.toPrecision(15)),errors,count};
  }
  return out;
 }
 /** One page of rows (search, filters, sorting and paging done here), with totals of the whole result. */
 function query(key,staff,p={}){
  const {b,caps}=openBoard(key,staff),s=sight(b,staff,caps),items=matchingRows(b,staff,caps,s,p);
  const offset=Math.max(0,Math.min(Number.parseInt(p.offset,10)||0,1e6)),limit=Math.max(1,Math.min(GROUP_LIMITS.page,Number.parseInt(p.limit,10)||50));
  const prepared=prepareFormulas(s.all),counts=noteCounts(b.id),visibleRows=new Set(rowsOf(b.id).filter(r=>s.rowOk(r.id)).map(r=>r.id));
  const hiddenMine=(viewOf(b.id,staff).hidden_rows||[]).filter(id=>visibleRows.has(id)).length;
  return {group_id:b.id,version:b.version,total:items.length,all:visibleRows.size,hidden_mine:hiddenMine,match_key:matchKey(items),offset,limit,
   rows:items.slice(offset,offset+limit).map(({r})=>rowOut(r,s,prepared,{notes:counts.get(r.id)||0})),totals:totalsOf(items,s)};
 }
 /** A layout with only the columns and rows this person may see (it must not reveal the IDs of hidden ones). */
 function onlyVisible(layout,s){
  const out={...layout};
  if(layout.widths&&typeof layout.widths==='object')out.widths=Object.fromEntries(Object.entries(layout.widths).filter(([k])=>s.colIds.has(k)));
  if(Array.isArray(layout.order))out.order=layout.order.filter(k=>s.colIds.has(k));
  if(Array.isArray(layout.hidden_columns))out.hidden_columns=layout.hidden_columns.filter(k=>s.colIds.has(k));
  if(Array.isArray(layout.hidden_rows))out.hidden_rows=layout.hidden_rows.filter(k=>s.rowOk(k));
  return out;
 }
 /** One group: its columns as this person may see them, their own layout and the shared default, and the first page. */
 function read(key,staff,p={}){
  const {b,caps}=openBoard(key,staff),s=sight(b,staff,caps);
  const shared=all('SELECT a.staff_id,a.level,l.name FROM tm_board_access a JOIN lookups l ON l.id=a.staff_id WHERE a.board_id=? ORDER BY l.name COLLATE NOCASE',b.id);
  const columns=s.columns.map(col=>({id:col.id,name:col.name,type:col.type,position:col.position,version:col.version,settings:col.type==='FORMULA'?{...col.settings,display:formulaDisplay(col.settings.expression,s.all),refs:formulaRefs(col.settings.expression)}:col.settings,
   used_by:['NUMBER','FORMULA'].includes(col.type)?formulaDependents(s.all,col.id).map(x=>x.id).filter(x=>s.colIds.has(x)):[],...(s.seeAll?{access:s.rules.cols.get(col.id)||null}:{})}));
  // The activity names rows by ID and columns by name; with access rules in place it is shown to the managers only.
  const activity=s.seeAll||!s.restricted?all("SELECT action,detail,actor_id,created_at FROM tm_events WHERE entity_type='group' AND entity_id=? ORDER BY id DESC LIMIT 30",b.id).map(e=>({...e,actor:nameOf(e.actor_id)})):null;
  const roles=s.seeAll?all('SELECT id,name FROM access_roles ORDER BY name COLLATE NOCASE'):[],page=query(b.id,staff,{limit:50,...p});
  return {
   group:{...b,layout_json:undefined,level:caps.level,caps,owner_name:nameOf(b.owner_id),workspace_name:get('SELECT name FROM tm_workspaces WHERE id=?',b.workspace_id)?.name||'',workspace_status:get('SELECT status FROM tm_workspaces WHERE id=?',b.workspace_id)?.status||'ACTIVE',shared,
    restricted:s.restricted,hidden_columns:s.seeAll?0:s.hiddenColumns},
   columns,view:onlyVisible(viewOf(b.id,staff),s),layout:onlyVisible(parse(b.layout_json,{}),s),roles,activity,limits:GROUP_LIMITS,page,
   // A compact Google Sheets status for the toolbar (no spreadsheet details: those are for the people who manage it).
   sync:(()=>{const x=get('SELECT id,status,direction,last_success_at,last_run_at FROM tm_board_syncs WHERE board_id=?',b.id);return x?{status:x.status,direction:x.direction,last_success_at:x.last_success_at,last_run_at:x.last_run_at,conflicts:get("SELECT COUNT(*) AS n FROM tm_board_sync_conflicts WHERE sync_id=? AND status='OPEN'",x.id).n}:null;})(),
   // Earlier screens read `rows`: the first page (search and paging now happen on the server, see /api/tasks/group/rows).
   rows:page.rows,
  };
 }
 /** Notes on one row, newest or oldest first, optionally between two dates (days in the reader's time zone). */
 function notes(key,staff,p={}){
  const {b,caps}=openBoard(key,staff),s=sight(b,staff,caps),row=noteRow(b,s,p.row);
  const zone=c.zoneOf?c.zoneOf(staff):'Asia/Phnom_Penh',day=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):null;
  const from=day(p.from),to=day(p.to);
  if((p.from&&!from)||(p.to&&!to))fail('Enter valid dates (YYYY-MM-DD).',400);
  if(from&&to&&from>to)fail('The end date must be on or after the start date.',400);
  const where=['row_id=?'],args=[row.id];
  if(from){where.push('created_at>=?');args.push(startOfDay(from,zone));}
  if(to){where.push('created_at<?');args.push(startOfDay(nextDay(to),zone));}
  const order=p.order==='oldest'?'ASC':'DESC',offset=Math.max(0,Number.parseInt(p.offset,10)||0),limit=Math.max(1,Math.min(100,Number.parseInt(p.limit,10)||20));
  const total=get(`SELECT COUNT(*) AS n FROM tm_board_notes WHERE ${where.join(' AND ')}`,...args).n;
  const list=all(`SELECT n.*,(SELECT COUNT(*) FROM tm_board_note_revisions v WHERE v.note_id=n.id) AS revisions FROM tm_board_notes n WHERE ${where.join(' AND ')} ORDER BY created_at ${order},id ${order} LIMIT ? OFFSET ?`,...args,limit,offset);
  // The row is named by its first visible column (never by a column this person can't see).
  const first=s.columns.find(x=>x.type!=='FORMULA'),values=parse(get('SELECT values_json FROM tm_board_rows WHERE id=?',row.id).values_json,{});
  return {row:{id:row.id,title:first?cellText(first,values[first.id],nameOf).slice(0,120):''},zone,total,offset,limit,order:order==='ASC'?'oldest':'newest',can_add:!!caps.notes,
   notes:list.map(n=>({id:n.id,author_id:n.author_id,author:nameOf(n.author_id),body:n.deleted_at?'':n.body,created_at:n.created_at,edited_at:n.edited_at,deleted_at:n.deleted_at,deleted_by:n.deleted_by?nameOf(n.deleted_by):null,version:n.version,
    revisions:n.revisions,can_edit:!n.deleted_at&&n.author_id===staff&&!!caps.notes,can_delete:!n.deleted_at&&(n.author_id===staff||!!caps.share)&&b.status==='ACTIVE',can_history:n.revisions>0&&(n.author_id===staff||!!caps.seeAll)}))};
 }
 function noteHistory(key,staff,noteId){
  const {b,caps}=openBoard(key,staff),s=sight(b,staff,caps);
  const n=get('SELECT * FROM tm_board_notes WHERE id=? AND board_id=?',String(noteId||''),b.id);
  if(!n||!s.rowOk(n.row_id)||!(n.author_id===staff||caps.seeAll))fail('Note not found.',404);
  return {id:n.id,history:all('SELECT body,action,actor_id,created_at FROM tm_board_note_revisions WHERE note_id=? ORDER BY id',n.id).map(r=>({...r,actor:nameOf(r.actor_id)}))};
 }
 /** People who may be chosen in In Charge and Support cells, with search and paging. */
 function members(key,staff,{q='',offset=0,limit=50}={}){
  const {b}=openBoard(key,staff),words=nameKey(String(q).slice(0,100)).split(' ').filter(Boolean);
  // Job positions are shown (and searched) only for people whose role can see team details (Users · View), as elsewhere.
  const positions=!!hooks.canStaff(staff,'tasks.users','view');
  const list=eligible(b).map(p=>positions?p:{...p,position:''}).filter(p=>words.every(w=>nameKey(`${p.name} ${p.department} ${p.position}`).includes(w)));
  const start=Math.max(0,Number(offset)||0),size=Math.max(1,Math.min(100,Number(limit)||50));
  return {total:list.length,offset:start,items:list.slice(start,start+size)};
 }
 /** People who can open the group (for row and column access rules), for the people who manage it. */
 function audience(key,staff){
  const {b,caps}=openBoard(key,staff);need(caps,'share','Only the people who manage this group can see who can open it.');
  const people=all(`SELECT l.id,l.name FROM lookups l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.kind='staff' AND l.active=1 AND COALESCE(p.active,1)=1 ORDER BY l.name COLLATE NOCASE`).filter(x=>levelFor(b,x.id)>0);
  return {people,roles:all('SELECT id,name FROM access_roles ORDER BY name COLLATE NOCASE')};
 }
 /** V5.5: the group as an Excel workbook (Export permission): every row this person may see, the rows matching their
  *  search and filters, or the rows they selected; only the columns they may see; formula results as values. */
 function xlsx(key,staff,p={}){
  const {b,caps}=openBoard(key,staff);if(!caps.export)fail('Your role can’t export groups.',403);
  const s=sight(b,staff,caps),view=viewOf(b.id,staff),prepared=prepareFormulas(s.all);
  const scope=['all','filtered','selected'].includes(p.scope)?p.scope:'all';
  let items;
  if(scope==='filtered')items=matchingRows(b,staff,caps,s,p);
  else if(scope==='selected'){
   const ids=String(p.ids||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,GROUP_LIMITS.bulk);if(!ids.length)fail('Select the rows to export.',400);
   const wanted=new Set(ids),rows=rowsOf(b.id).filter(r=>wanted.has(r.id));
   if(rows.length!==wanted.size||rows.some(r=>!s.rowOk(r.id)))fail('Some selected rows were deleted or are no longer available to you. Reload the group and select them again.',409);
   items=rows.map(r=>({r,computed:computeRow(r.values,s.all,prepared)}));
  }else items=rowsOf(b.id).filter(r=>s.rowOk(r.id)).map(r=>({r,computed:computeRow(r.values,s.all,prepared)}));
  // Columns in this person's order; with only=view, without the columns they hid in their own view.
  const order=Array.isArray(view.order)?view.order:[],rank=id=>{const i=order.indexOf(id);return i<0?1e6:i;};
  let cols=[...s.columns].sort((x,y)=>rank(x.id)-rank(y.id)||x.position-y.position);
  if(p.columns==='view')cols=cols.filter(x=>!(view.hidden_columns||[]).includes(x.id));
  const kind=col=>col.type==='NUMBER'||col.type==='FORMULA'?'number':col.type==='DATE'?'date':'text';
  const value=(col,r,computed)=>{
   const v=col.type==='FORMULA'?computed[col.id]:r.values[col.id];
   if(emptyValue(v))return null;
   if(col.type==='NUMBER')return v;
   if(col.type==='FORMULA')return typeof v==='object'?{error:v.error}:v;
   if(col.type==='DATE')return v;
   return cellText(col,v,nameOf);
  };
  const buf=writeXlsx({sheets:[{name:b.name,columns:cols.map(col=>({header:col.name,type:kind(col),decimals:col.settings?.decimals??null})),rows:items.map(({r,computed})=>cols.map(col=>value(col,r,computed)))}]});
  record(staff,b,'Exported to Excel',`${items.length} row${items.length===1?'':'s'} · ${cols.length} column${cols.length===1?'':'s'}`);
  return {name:b.name,buffer:buf,rows:items.length};
 }
 /** For the group list: rows and columns each person may see in each group they may open. */
 function summaries(staff){
  const out=[];
  for(const b of all("SELECT * FROM tm_boards")){
   const caps=capsFor(b,staff);if(!caps.view)continue;
   const s=sight(b,staff,caps);
   const rows=s.seeAll||!s.rules.rows.size?get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',b.id).n:all('SELECT id FROM tm_board_rows WHERE board_id=?',b.id).filter(r=>s.rowOk(r.id)).length;
   out.push({board_id:b.id,rows,columns:s.columns.length});
  }
  return out;
 }
 function state(){
  return {tm_boards:all('SELECT id,workspace_id,name,description,visibility,audience,workspace_level,owner_id,status,archived_at,archived_by,version,created_by,created_at,updated_at FROM tm_boards ORDER BY name COLLATE NOCASE'),tm_board_access:all('SELECT * FROM tm_board_access')};
 }
 const asSystem=fn=>{system=true;try{return fn();}finally{system=false;}};
 const imports=createGroupImport({...c,openBoard,sight,columnsOf,rowsOf,eligible,cleanValues,sizeCheck,touch,record,need,archivedCheck,failWith,columnSave,levelFor});
 // For the Google Sheets connection (group-sync.mjs), which applies the same rules.
 const internals={columnsOf,rowsOf,rulesOf,capsFor,cleanValues,visibleColumns,sight};
 return {handle,read,query,notes,noteHistory,members,audience,xlsx,file,summaries,state,levelFor,eligible,asSystem,imports,internals};
}

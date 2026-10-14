// Isolated review/test data. Never called during normal startup or migration.
import {taskToday,addDays} from './task-domain.mjs';
export function organizationFixture(s){
 const ids={},cmd=(action,data,actor=ids.A)=>s.command(action,data,actor);
 s.access.bootstrap({staff_id:'STAFF-003',name:'A · Organization administrator',email:'a@review.test',password:'Review-organization-2026'});ids.A='STAFF-003';
 for(const [letter,role] of [['B','MANAGER'],['C','MEMBER'],['D','MEMBER'],['E','MEMBER'],['X','MANAGER'],['Y','MEMBER']]){
  const result=cmd('admin.user.save',{name:`${letter} · Review employee`,email:`${letter.toLowerCase()}@review.test`,role_id:`ROLE-${role}`,password:'Review-organization-2026',active:1,function_settings:{'tasks.organization':{create:'ALLOW'}}});ids[letter]=s.get('SELECT staff_id FROM access_users WHERE id=?',result.id).staff_id;
 }
 const rev=()=>s.organization.settings().revision;
 cmd('org.initialize',{expected_revision:rev(),level1_ids:[ids.A],reason:'Explicit isolated review mapping'});
 cmd('org.structure.save',{expected_revision:rev(),acknowledged:true,reason:'Review reporting relationships',changes:[['B',2,'A'],['C',3,'B'],['D',4,'C'],['E',5,'D'],['X',2,'A'],['Y',3,'X']].map(([x,level,m])=>({staff_id:ids[x],level,manager_id:ids[m]}))});
 const createWorkspace=(owner,name,kind='ORGANIZATIONAL',extra={})=>cmd('org.workspace.save',{name,kind,owner_id:owner,...extra},owner).id;
 const wsB=createWorkspace(ids.B,'Workspace B · Operations'),wsX=createWorkspace(ids.X,'Workspace X · Separate branch');
 const task=(actor,workspace_id,title,extra={})=>cmd('tm.task.save',{workspace_id,title,description:'Deliver the specified outcome',start_date:taskToday(),due_date:addDays(taskToday(),7),pic_id:actor,...extra},actor).id;
 return {ids,cmd,rev,createWorkspace,task,wsB,wsX,user:staff=>s.access.publicUser(s.access.accountFor(staff).id)};
}

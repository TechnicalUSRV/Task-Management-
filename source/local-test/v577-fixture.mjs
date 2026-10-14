// Synthetic hierarchy used only by V5.7.7 tests, never normal startup.
import {taskToday,addDays} from './task-domain.mjs';
export function visibilityFixture(s){
 const password='Visibility-test-2026',ids={};
 ids.R=s.access.bootstrap({name:'Admin R',password}).staff_id;
 const cmd=(a,d,who='R')=>s.command(a,d,ids[who]);
 for(const key of ['A','B','C','D','E','F','V']){
  const u=cmd('admin.user.save',{name:'Employee '+key,role_id:'ROLE-MEMBER',password});ids[key]=s.get('SELECT staff_id FROM access_users WHERE id=?',u.id).staff_id;
 }
 const rev=()=>s.organization.settings().revision;
 cmd('org.initialize',{level1_ids:[ids.R,ids.A,ids.C],expected_revision:rev(),reason:'Synthetic hierarchy'});
 cmd('org.structure.save',{changes:[['B',2,'A'],['D',2,'A'],['E',3,'B'],['F',4,'E'],['V',3,'D']].map(([key,level,parent])=>({staff_id:ids[key],level,manager_id:ids[parent]})),expected_revision:rev(),acknowledged:true,reason:'Synthetic reporting relationships'});
 const workspace=(who,name,kind='PUBLIC')=>cmd('tm.workspace.save',{name,kind},who).id;
 const task=(who,workspace_id,title,extra={})=>cmd('tm.task.save',{workspace_id,title,description:'Deliver the requested outcome',pic_id:ids[who],start_date:taskToday(),due_date:addDays(taskToday(),3),...extra},who).id;
 const pub=workspace('B','B Public'),personal=workspace('B','B Personal','PERSONAL'),deep=workspace('F','F Public');
 const pubTask=task('B',pub,'B public task'),privateTask=task('B',personal,'B private task'),deepTask=task('F',deep,'F public task');
 const grant=(who,settings)=>{const old=s.access.publicUser(s.access.accountFor(ids[who]).id);return cmd('admin.user.save',{...old,expected_version:old.version,function_settings:settings});};
 return {ids,password,cmd,rev,workspace,task,pub,personal,deep,pubTask,privateTask,deepTask,grant};
}

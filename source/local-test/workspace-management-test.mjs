import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {organizationFixture} from './organization-fixture.mjs';
let passed=0,failed=0;
const check=(name,fn)=>{const s=openStore();seedDemo(s);try{fn(s,organizationFixture(s));passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}finally{s.db.close();}};
const denied=fn=>assert.throws(fn,e=>[403,404,409,422].includes(e.status));
const owner=(f,staff=f.ids.C)=>{f.cmd('org.delegation.request',{beneficiary_id:staff,reason:'Approved Owner'},f.ids.B);return f.createWorkspace(staff,'Owner workspace '+staff,'ORGANIZATIONAL',{joinable:true});};
check('Creator identity is server-derived, immutable through edits and independent of ownership',(s,f)=>{
 const {ids:{A,B,C},cmd,rev}=f;owner(f);
 const id=cmd('org.workspace.save',{kind:'ORGANIZATIONAL',name:'Created for another owner',owner_id:C,created_by:C},B).id;
 let row=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);assert.equal(row.created_by,B);
 cmd('org.workspace.save',{id,name:row.name,expected_version:row.version,created_by:A},C);
 row=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);assert.equal(row.created_by,B);
 denied(()=>cmd('tm.workspace.delete',{id,expected_version:row.version,acknowledged:true},C));
 cmd('tm.workspace.delete',{id,expected_version:row.version,acknowledged:true},B);assert.equal(s.get('SELECT deleted_by FROM tm_workspaces WHERE id=?',id).deleted_by,B);
});
check('Approved Owner directly adds direct and deep descendants, recording their own approval once',(s,f)=>{
 const {ids:{C,D,E},cmd}=f,id=owner(f);
 for(const beneficiary_id of [D,E]){
  const result=cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id,member_role:'VIEWER',reason:'In my reporting branch',request_key:beneficiary_id},C);
  assert.equal(result.status,'APPROVED');const q=s.get('SELECT * FROM org_requests WHERE id=?',result.id);assert.equal(q.approver_id,C);assert.equal(q.decision_by,C);
  const m=s.get('SELECT * FROM tm_members WHERE workspace_id=? AND staff_id=?',id,beneficiary_id);assert.equal(m.approved_by,C);assert.equal(m.member_role,'VIEWER');
  cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id,reason:'Retry',request_key:beneficiary_id},C);assert.equal(s.get('SELECT COUNT(*) n FROM tm_members WHERE workspace_id=? AND staff_id=?',id,beneficiary_id).n,1);
 }
});
check('Noncreator Owner still requests approval; a client cannot forge a direct approval',(s,f)=>{
 const {ids:{B,C,D},cmd}=f;owner(f);
 const id=cmd('org.workspace.save',{name:'Manager created this',kind:'ORGANIZATIONAL',owner_id:C},B).id;
 const r=cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id:D,reason:'Owner nomination',approved:true,administrative:true,approver_id:C},C);
 assert.equal(r.status,'PENDING');denied(()=>cmd('org.request.decide',{id:r.id,decision:'APPROVE',administrative:true},C));assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',id,D));
 cmd('org.request.decide',{id:r.id,decision:'APPROVE'},B);assert.ok(s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',id,D));
});
check('Owner cannot add an ancestor, cross-branch employee, unmapped employee or inactive subordinate',(s,f)=>{
 const {ids:{A,B,C,D,Y},cmd}=f,id=owner(f);
 for(const beneficiary_id of [A,B,Y])denied(()=>cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id,reason:'Outside approved scope',approved:true},C));
 s.run('UPDATE tm_profiles SET active=0 WHERE staff_id=?',D);denied(()=>cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id:D,reason:'Inactive target'},C));
 const u=cmd('admin.user.save',{name:'Unmapped',email:'unmapped@scope.test',role_id:'ROLE-MEMBER',password:'Review-organization-2026',active:1},A).id,staff=s.get('SELECT staff_id FROM access_users WHERE id=?',u).staff_id;
 s.run('UPDATE tm_profiles SET manager_id=? WHERE staff_id=?',C,staff);denied(()=>cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id:staff,reason:'Unmapped target'},C));
});
check('Owner authority is rechecked after reporting changes and suspended delegation',(s,f)=>{
 const {ids:{A,B,C,D,X},cmd,rev}=f,id=owner(f);
 cmd('org.structure.save',{changes:[{staff_id:D,level:4,manager_id:X}],expected_revision:rev(),acknowledged:true,reason:'Move subtree to another branch'},A);
 denied(()=>cmd('tm.workspace.member.add',{workspace_id:id,beneficiary_id:D,reason:'Stale scope'},C));
 s.run("UPDATE org_grants SET status='SUSPENDED' WHERE beneficiary_id=?",C);
 const w=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);assert.equal(s.organization.workspaceAccess(C,w).can_add_members,false);
});
check('Creator can delete with open work; contents, time, requests, Groups and notifications disappear and restore safely',(s,f)=>{
 const {ids:{B,C,D},cmd,task,user}=f,id=owner(f),t=task(C,id,'Retained open task');
 const group=cmd('tm.group.save',{workspace_id:id,name:'Retained group',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT',shared:[]},C).id;
 const pending=cmd('org.membership.request',{workspace_id:id,reason:'Self join'},D).id;
 const before=s.scopedState(user(C));assert.ok(before.tm_tasks.some(x=>x.id===t));
 denied(()=>cmd('tm.workspace.delete',{id,expected_version:0},C));denied(()=>cmd('tm.workspace.delete',{id,expected_version:9,acknowledged:true},C));
 cmd('tm.workspace.delete',{id,expected_version:0,acknowledged:true},C);
 for(const staff of [B,C,D]){const state=s.scopedState(user(staff));assert.ok(!state.tm_workspaces.some(w=>w.id===id));assert.ok(!state.tm_tasks.some(x=>x.id===t));assert.ok(!state.tm_boards.some(x=>x.id===group));assert.ok(!state.tm_notifications.some(n=>n.task_id===t||n.org_request_id===pending));}
 assert.equal(s.get('SELECT status FROM org_requests WHERE id=?',pending).status,'CANCELLED');assert.ok(s.get('SELECT 1 FROM tm_tasks WHERE id=?',t));
 denied(()=>cmd('tm.workspace.archive',{id,expected_version:1,status:'ACTIVE'},C));denied(()=>cmd('tm.task.note',{id:t,note:'Deleted task'},C));denied(()=>cmd('tm.group.row.add',{group_id:group,values:{}},C));
 assert.ok(s.scopedState(user(C)).workspace_dashboard.my.find(w=>w.id===id).org_access.can_restore);
 cmd('tm.workspace.restore',{id,expected_version:1,acknowledged:true},C);assert.ok(s.scopedState(user(C)).tm_tasks.some(x=>x.id===t));assert.ok(s.scopedState(user(C)).tm_boards.some(x=>x.id===group));
});
check('Creator retains deletion rights after a governance transfer without gaining the new branch’s content',(s,f)=>{
 const {ids:{A,C,X},cmd,rev,task,user}=f,id=owner(f);
 const row=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);
 cmd('org.workspace.save',{id,expected_version:row.version,expected_revision:rev(),acknowledged:true,owner_id:X,governing_manager_id:X,reason:'Transfer workspace'},A);
 cmd('org.membership.remove',{workspace_id:id,beneficiary_id:C,expected_revision:rev(),reason:'Transferred membership'},X);
 const t=task(X,id,'Private to new branch');const state=s.scopedState(user(C));assert.ok(!state.tm_tasks.some(x=>x.id===t));assert.equal(state.workspace_dashboard.my.find(w=>w.id===id).reference_only,true);
 cmd('tm.workspace.delete',{id,expected_version:1,acknowledged:true},C);
});
check('Dashboard separates own, managed and shared workspaces without descendant personal metadata',(s,f)=>{
 const {ids:{A,B,C,D,E,Y},cmd,user,createWorkspace,wsB,wsX}=f,wsC=owner(f),wsD=owner(f,D),personal=createWorkspace(E,'Secret personal workspace','PERSONAL');
 const c=s.scopedState(user(C)).workspace_dashboard;assert.ok(c.my.some(w=>w.id===wsC));assert.ok(c.managed.some(w=>w.id===wsD));assert.ok(!c.managed.some(w=>w.id===wsX||w.id===personal));assert.equal(c.has_management,true);
 assert.equal(s.scopedState(user(E)).workspace_dashboard.has_management,false);
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:Y,reason:'Explicit cross-branch share'},B);
 assert.ok(s.scopedState(user(Y)).workspace_dashboard.shared.some(w=>w.id===wsB));
 const a=s.scopedState(user(A)).workspace_dashboard;assert.ok(a.managed.some(w=>w.id===wsC));assert.ok(!JSON.stringify(a).includes('Secret personal workspace'));
});
check('Management summaries expose only authorized task IDs and scoped members, with no Group or meeting access',(s,f)=>{
 const {ids:{B,C,D,E,Y},cmd,task,user}=f;owner(f);const id=owner(f,D);
 const visible=task(D,id,'Reporting task',{pic_id:E}),hidden=task(D,id,'Outside reporting task',{pic_id:Y});
 cmd('org.membership.request',{workspace_id:id,beneficiary_id:Y,reason:'Cross-branch member'},B);
 const group=cmd('tm.group.save',{workspace_id:id,name:'Owner group',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT',shared:[]},D).id;
 const state=s.scopedState(user(C)),row=state.workspace_dashboard.managed.find(w=>w.id===id);assert.equal(row.reference_only,true);assert.deepEqual(row.task_ids,[visible]);assert.ok(!row.member_ids.includes(Y));assert.ok(!state.tm_boards.some(b=>b.id===group));assert.ok(!state.tm_tasks.some(t=>t.id===hidden));assert.ok(!row.org_access.can_manage);
 const u=user(C);cmd('admin.user.save',{...u,expected_version:u.version,function_settings:{'tasks.tasks':{view:'DENY'}}},f.ids.A);
 assert.deepEqual(s.scopedState(user(C)).workspace_dashboard.managed.find(w=>w.id===id).task_ids,[]);
});
check('Deleting the origin does not remove independently delegated child workspaces',(s,f)=>{
 const {ids:{B,C},cmd,wsB,createWorkspace,user}=f;
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,reason:'Origin sharing'},B);cmd('org.delegation.request',{beneficiary_id:C,workspace_id:wsB,reason:'Independent delegated work'},B);
 const child=createWorkspace(C,'Independent child','ORGANIZATIONAL',{origin_workspace_id:wsB});
 cmd('tm.workspace.delete',{id:wsB,expected_version:0,acknowledged:true},B);assert.ok(s.scopedState(user(C)).tm_workspaces.some(w=>w.id===child));assert.equal(s.organization.grants(C).length,1);
});
const dir=mkdtempSync(path.join(tmpdir(),'sunny-creator-migration-'));let s;
try{
 const file=path.join(dir,'erp.sqlite');s=openStore(file);seedDemo(s);const f=organizationFixture(s),id=owner(f),legacy=s.get("SELECT id FROM tm_workspaces WHERE kind='LEGACY' LIMIT 1").id;
 s.run("DELETE FROM tm_events WHERE workspace_id=? AND action='Workspace created'",legacy);s.run('UPDATE tm_workspaces SET created_by=NULL WHERE id=?',legacy);s.run('UPDATE tm_workspaces SET created_by=NULL WHERE id=?',id);s.db.close();s=openStore(file);assert.equal(s.get('SELECT created_by FROM tm_workspaces WHERE id=?',id).created_by,f.ids.C);assert.equal(s.get('SELECT created_by FROM tm_workspaces WHERE id=?',legacy).created_by,null);
 s.db.close();s=openStore(file);assert.equal(s.get('SELECT created_by FROM tm_workspaces WHERE id=?',id).created_by,f.ids.C);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);passed++;console.log('PASS Creator migration restores recorded authorship, remains idempotent and never guesses legacy creators');
}catch(e){failed++;console.error(e);}finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}
console.log(`\n${passed} workspace management checks passed; ${failed} failed.`);if(failed)process.exitCode=1;

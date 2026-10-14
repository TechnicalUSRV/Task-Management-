import assert from 'node:assert/strict';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {organizationFixture} from './organization-fixture.mjs';

let passed=0,failed=0;
const check=(name,fn)=>{const s=openStore();seedDemo(s);try{fn(s,organizationFixture(s));passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n  '+e.message);}finally{s.db.close();}};
const denied=fn=>assert.throws(fn,e=>[403,409,422].includes(e.status));

check('Viewer membership grants read access to Groups without inheriting workspace editing; named grants remain independent',(s,f)=>{
 const {ids:{B,C},cmd,wsB,user}=f;
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,member_role:'VIEWER',reason:'Review only'},B);
 const id=cmd('tm.group.save',{workspace_id:wsB,name:'Viewer regression',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT',shared:[]},B).id;
 const b=s.get('SELECT * FROM tm_boards WHERE id=?',id);
 assert.equal(s.tasks.groups.levelFor(b,C),1);
 assert.equal(s.scopedState(user(C)).tm_boards.find(x=>x.id===id).level,1);
 denied(()=>cmd('tm.group.row.add',{group_id:id,values:{}},C));
 cmd('tm.group.save',{...b,expected_version:b.version,shared:[{staff_id:C,level:'EDIT'}]},B);
 assert.equal(s.tasks.groups.levelFor(s.get('SELECT * FROM tm_boards WHERE id=?',id),C),2);
 cmd('tm.group.row.add',{group_id:id,values:{}},C);
});

check('Delegated workspace remains editable after independent membership in its origin is removed',(s,f)=>{
 const {ids:{B,C},cmd,wsB,createWorkspace,rev}=f;
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,reason:'Origin access'},B);
 cmd('org.delegation.request',{beneficiary_id:C,workspace_id:wsB,reason:'Scoped owner'},B);
 const id=createWorkspace(C,'Independent workspace','ORGANIZATIONAL',{origin_workspace_id:wsB});
 cmd('org.membership.remove',{workspace_id:wsB,beneficiary_id:C,expected_revision:rev(),reason:'Keep separate membership'},B);
 const old=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);
 assert.ok(s.organization.canManageWorkspace(C,old));
 cmd('org.workspace.save',{id,expected_version:old.version,name:'Renamed independent workspace'},C);
 assert.equal(s.get('SELECT name FROM tm_workspaces WHERE id=?',id).name,'Renamed independent workspace');
});

check('Authorized governance transfer can explicitly clear obsolete originating-workspace metadata',(s,f)=>{
 const {ids:{A,B,C,X},cmd,wsB,createWorkspace,rev}=f;
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,reason:'Origin access'},B);
 cmd('org.delegation.request',{beneficiary_id:C,workspace_id:wsB,reason:'Scoped owner'},B);
 const id=createWorkspace(C,'Transfer workspace','ORGANIZATIONAL',{origin_workspace_id:wsB});
 const old=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);
 cmd('org.workspace.save',{id,expected_version:old.version,expected_revision:rev(),acknowledged:true,owner_id:X,governing_manager_id:X,origin_workspace_id:null,reason:'Transfer responsibility'},A);
 const after=s.get('SELECT * FROM tm_workspaces WHERE id=?',id);assert.equal(after.origin_workspace_id,null);assert.equal(after.governing_manager_id,X);
});

check('Structure approvals cannot carry hidden replacements outside their reviewed affected scope',(s,f)=>{
 const {ids:{A,B,D,C},cmd,wsB,rev}=f;
 denied(()=>cmd('org.structure.save',{changes:[{staff_id:D,level:4,manager_id:C}],expected_revision:rev(),acknowledged:true,reason:'Unrelated hidden replacement',workspace_replacements:[{id:wsB,owner_id:B,governing_manager_id:B}]},A));
});

check('Legacy reporting editor cannot attach unmapped employees to governed branches',(s,f)=>{
 const {ids:{A,C},cmd}=f;
 const account=cmd('admin.user.save',{name:'Unmapped employee',email:'unmapped@review.test',role_id:'ROLE-MEMBER',password:'Review-organization-2026',active:1},A).id;
 const staff=s.get('SELECT staff_id FROM access_users WHERE id=?',account).staff_id;
 denied(()=>cmd('tm.profile.manager',{staff_id:staff,manager_id:C},A));
 assert.equal(s.organization.person(staff).manager_id,null);
});

check('Unmapped legacy reporting links do not manufacture organizational task oversight',(s,f)=>{
 const {ids:{A,B,C},cmd,task,wsB}=f;
 const account=cmd('admin.user.save',{name:'Legacy unassigned employee',email:'legacy@review.test',role_id:'ROLE-MEMBER',password:'Review-organization-2026',active:1},A).id;
 const staff=s.get('SELECT staff_id FROM access_users WHERE id=?',account).staff_id;
 s.run('UPDATE tm_profiles SET manager_id=? WHERE staff_id=?',C,staff); // Existing legacy link, intentionally not mapped.
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:staff,reason:'Retained operational membership'},B);
 const id=task(B,wsB,'Unmapped accountable employee',{pic_id:staff});
 assert.equal(s.tasks.scope.canSee(C,s.get('SELECT * FROM tm_tasks WHERE id=?',id)),false);
});

check('Organization pickers include active company logins without Task access and exclude inactive accounts',(s,f)=>{
 const {ids:{A},cmd}=f;
 const role=cmd('admin.role.save',{name:'Organization only',permissions:{'tasks.organization':['view']}}).id;
 const account=cmd('admin.user.save',{name:'Organization coordinator',email:'coordinator@review.test',role_id:role,password:'Review-organization-2026',active:1},A).id;
 const staff=s.get('SELECT staff_id FROM access_users WHERE id=?',account).staff_id;
 assert.ok(s.organization.snapshot(A).directory?.some(p=>p.staff_id===staff));
 cmd('admin.user.disable',{id:account,expected_version:0,reason:'Inactive directory check'},A);
 assert.ok(!s.organization.snapshot(A).directory.some(p=>p.staff_id===staff));
 assert.equal(s.organization.query(A,{q:staff}).rows[0].active,0);
});

check('Employee controls are scoped to current responsibility and never offer delegation to oneself or an ancestor',(s,f)=>{
 const {ids:{A,B,C,D},cmd}=f;
 cmd('org.delegation.request',{beneficiary_id:C,reason:'Owner'},B);
 assert.equal(s.organization.employee(B,A).actions.change_structure,false);
 assert.equal(s.organization.employee(C,C).actions.delegate,false);
 assert.equal(s.organization.employee(C,D).actions.delegate,true);
 assert.equal(s.organization.employee(B,C).actions.change_structure,true);
});

check('Request-key replay rejects changed workspace replacements instead of silently accepting a different payload',(s,f)=>{
 const {ids:{C,D},cmd,rev}=f;
 const body={changes:[{staff_id:C,level:3,manager_id:s.organization.person(C).manager_id}],reason:'Same-key scope check',request_key:'structure-replay',workspace_replacements:[]};
 cmd('org.structure.request',{...body,expected_revision:rev()},C);
 denied(()=>cmd('org.structure.request',{...body,expected_revision:rev(),workspace_replacements:[{id:'different-workspace',owner_id:D}]},C));
});

console.log(`\n${passed} organization flow checks passed; ${failed} failed.`);
if(failed)process.exitCode=1;

import assert from 'node:assert/strict';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {organizationFixture} from './organization-fixture.mjs';
import {miniState} from './telegram-gateway.mjs';
import {authorizedRecords} from './erp-sources.mjs';
const s=openStore();seedDemo(s);
const {ids:{A,B,C,D,E,X,Y},cmd,rev,createWorkspace,task,wsB,wsX,user}=organizationFixture(s);
const state=staff=>s.scopedState(user(staff)),deny=(fn,status)=>assert.throws(fn,e=>status?e.status===status:!!e.status);
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
try{
 check('explicit initialization preserves legacy records; no titles or roles automatically become hierarchy levels',()=>{
  assert.ok(s.organization.migrationPreview(A).workspaces.length);assert.equal(s.organization.level(C),3);
  assert.ok(!s.organization.isLevel1(B));deny(()=>cmd('org.initialize',{level1_ids:[C],expected_revision:rev()},C),409);
  deny(()=>cmd('org.structure.save',{changes:[{staff_id:C,level:1}],expected_revision:rev(),acknowledged:true,reason:'Try promotion'},C),403);
  deny(()=>cmd('org.structure.save',{changes:[{staff_id:A,level:null}],expected_revision:rev(),acknowledged:true,reason:'Remove last administrator'}));assert.equal(s.organization.level(A),1);
 });
 check('Level 2 boundaries, levels and cycles are enforced by commands',()=>{
  deny(()=>cmd('org.structure.save',{changes:[{staff_id:Y,level:3,manager_id:B}],expected_revision:rev(),acknowledged:true,reason:'Other branch'},B),403);
  for(const manager_id of [C,D,'FOREIGN-EMPLOYEE'])deny(()=>cmd('org.structure.save',{changes:[{staff_id:C,level:3,manager_id}],expected_revision:rev(),acknowledged:true,reason:'Invalid parent'}));
  deny(()=>createWorkspace(C,'Unapproved delegated workspace'));assert.equal(s.organization.governor(C),B);
 });
 let grantC,grantD,wsC,wsD,personal,privateTask,workTask;
 check('explicit Owner grant enables a separate workspace without promotion or membership inheritance',()=>{
  cmd('org.delegation.request',{beneficiary_id:C,template_id:'OWNER',reason:'Manage delivery team'},B);
  grantC=s.organization.grants(C)[0];assert.ok(grantC);
  wsC=createWorkspace(C,'Workspace C · Delivery');assert.equal(s.organization.level(C),3);
  const w=s.get('SELECT * FROM tm_workspaces WHERE id=?',wsC);assert.equal(w.governing_manager_id,B);assert.equal(w.owner_id,C);
  assert.deepEqual(s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?',wsC).map(x=>x.staff_id),[C]);assert.notEqual(wsC,wsB);
 });
 check('lower delegation is pending until the derived Level 2 approves; repeats are idempotent',()=>{
  const request=cmd('org.delegation.request',{beneficiary_id:D,template_id:'OWNER',parent_grant_id:grantC.id,reason:'Separate dispatch workspace',request_key:'D-owner'},C);
  assert.equal(s.get('SELECT approver_id FROM org_requests WHERE id=?',request.id).approver_id,B);assert.equal(s.organization.grants(D).length,0);deny(()=>createWorkspace(D,'Too early'));
  deny(()=>cmd('org.request.decide',{id:request.id,decision:'APPROVE'},C),403);deny(()=>cmd('org.request.decide',{id:request.id,decision:'APPROVE'},X));
  cmd('org.request.decide',{id:request.id,decision:'APPROVE'},B);cmd('org.request.decide',{id:request.id,decision:'APPROVE'},B);
  assert.equal(s.organization.grants(D).length,1);grantD=s.organization.grants(D)[0];wsD=createWorkspace(D,'Workspace D · Dispatch');assert.equal(s.get('SELECT governing_manager_id FROM tm_workspaces WHERE id=?',wsD).governing_manager_id,B);
 });
 check('creator Owner membership is directly approved within scope; noncreator requests still require approval',()=>{
  const r=cmd('org.membership.request',{workspace_id:wsD,beneficiary_id:E,reason:'Dispatch work',approver_id:D,approved:true},D);
  assert.equal(s.get('SELECT status FROM org_requests WHERE id=?',r.id).status,'APPROVED');assert.ok(state(E).tm_workspaces.some(w=>w.id===wsD));
  assert.equal(s.get('SELECT approved_by FROM tm_members WHERE workspace_id=? AND staff_id=?',wsD,E).approved_by,D);
  assert.equal(cmd('org.membership.request',{workspace_id:wsD,beneficiary_id:E,reason:'Dispatch work'},D).unchanged,true);
  deny(()=>cmd('org.request.decide',{id:r.id,decision:'APPROVE'},D),403);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_members WHERE workspace_id=? AND staff_id=?',wsD,E).n,1);
  cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,reason:'Direct manager approval'},B);
  assert.equal(s.get('SELECT approved_by FROM tm_members WHERE workspace_id=? AND staff_id=?',wsB,C).approved_by,B);
  deny(()=>cmd('tm.workspace.save',{...s.get('SELECT * FROM tm_workspaces WHERE id=?',wsD),expected_version:0,member_ids:[D,E,Y]},D));
 });
 check('personal workspace privacy excludes hierarchy access; explicit Administration global view is honored',()=>{
  personal=createWorkspace(E,'Private E workspace','PERSONAL');privateTask=task(E,personal,'PRIVATE E TITLE');
  for(const staff of [B,C,D,X,Y]){
   const web=state(staff),phone=miniState(s,user(staff));assert.ok(!JSON.stringify(web).includes('PRIVATE E TITLE'));assert.ok(!web.tm_workspaces.some(w=>w.id===personal));assert.ok(!phone.tm_tasks.some(t=>t.id===privateTask));
   assert.ok(!s.tasks.scope.canSee(staff,s.get('SELECT * FROM tm_tasks WHERE id=?',privateTask)));
   deny(()=>cmd('tm.task.note',{id:privateTask,note:'Guessed ID'},staff),404);
  }
  assert.ok(authorizedRecords(s,user(A),['tasks','workspaces']).some(r=>r.id===privateTask));
  assert.ok(state(A).tm_workspaces.some(w=>w.id===personal));
 });
 check('PIC anchors management visibility; peers/other branches and supporters do not widen it',()=>{
  workTask=task(E,wsD,'Dispatch work');for(const staff of [A,B,C,D,E])assert.ok(state(staff).tm_tasks.some(t=>t.id===workTask));
  for(const staff of [X,Y])assert.ok(!state(staff).tm_tasks.some(t=>t.id===workTask));
  deny(()=>cmd('tm.task.progress',{id:workTask,progress:50},B),403);deny(()=>cmd('tm.task.close',{id:workTask},A),403);
  assert.equal(s.all('SELECT * FROM tm_notifications WHERE task_id=? AND staff_id IN(?,?,?)',workTask,A,B,C).length,0);
  const outside=task(C,wsC,'Outside participant',{pic_id:Y,supporter_ids:[E]});assert.ok(state(Y).tm_tasks.some(t=>t.id===outside));assert.ok(!state(D).tm_tasks.some(t=>t.id===outside));
  assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',wsC,Y));assert.ok(!state(Y).tm_workspaces.some(w=>w.id===wsC));
 });
 check('sharing a Personal workspace is owner-controlled and converts visibility to Public',()=>{
  deny(()=>cmd('org.membership.request',{workspace_id:personal,beneficiary_id:A,reason:'Admin tries sharing'},A),403);
  cmd('org.membership.request',{workspace_id:personal,beneficiary_id:Y,reason:'Owner shares'},E);
  assert.ok(state(Y).tm_tasks.some(t=>t.id===privateTask));assert.equal(s.get('SELECT visibility FROM tm_workspaces WHERE id=?',personal).visibility,'PUBLIC');
  cmd('org.membership.remove',{workspace_id:personal,beneficiary_id:Y,reason:'Owner revokes',expected_revision:rev()},E);assert.ok(!state(Y).tm_tasks.some(t=>t.id===privateTask));
 });
 check('rejected delegation gives no access; branch/scope extension and stale revision are rejected',()=>{
  const r=cmd('org.delegation.request',{beneficiary_id:E,parent_grant_id:grantD.id,reason:'Further owner'},D);cmd('org.request.decide',{id:r.id,decision:'REJECT',note:'Not required'},B);assert.equal(s.organization.grants(E).length,0);
  deny(()=>cmd('org.delegation.request',{beneficiary_id:Y,parent_grant_id:grantD.id,reason:'Other branch'},D),403);
  deny(()=>cmd('org.structure.save',{changes:[{staff_id:E,level:5,manager_id:D}],expected_revision:0,reason:'Stale preview',acknowledged:true}),409);
 });
 check('revocation requires replacement workspace owners, invalidates dependents and preserves task responsibility',()=>{
  const before=state(C).task_scope.revision,taskBefore=s.get('SELECT * FROM tm_tasks WHERE id=?',workTask);
  deny(()=>cmd('org.grant.revoke',{id:grantC.id,reason:'Revoke',expected_revision:rev(),acknowledged:true},B),409);assert.ok(s.organization.validGrant(s.get('SELECT * FROM org_grants WHERE id=?',grantC.id)));
  cmd('org.grant.revoke',{id:grantC.id,reason:'Retire delegated workspaces',expected_revision:rev(),acknowledged:true,workspace_replacements:[wsC,wsD].map(id=>({id,owner_id:B,governing_manager_id:B}))},B);
  assert.equal(s.get('SELECT status FROM org_grants WHERE id=?',grantD.id).status,'SUSPENDED');assert.equal(s.organization.grants(C).length,0);assert.notEqual(state(C).task_scope.revision,before);assert.deepEqual(s.get('SELECT * FROM tm_tasks WHERE id=?',workTask),taskBefore);
 });
 check('branch moves refresh task scope and reroute pending membership; old notification links cannot decide',()=>{
  const pending=cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:Y,reason:'Cross branch work'},B);assert.equal(pending.status,'APPROVED');
  cmd('org.workspace.save',{expected_revision:rev(),acknowledged:true,...s.get('SELECT * FROM tm_workspaces WHERE id=?',wsD),expected_version:s.get('SELECT version FROM tm_workspaces WHERE id=?',wsD).version,owner_id:X,governing_manager_id:X},A);
  cmd('org.membership.remove',{workspace_id:wsD,beneficiary_id:B,reason:'End old independent membership',expected_revision:rev()},X);
  const before=state(B).task_scope.revision;
  cmd('org.structure.save',{changes:[{staff_id:C,level:3,manager_id:X}],expected_revision:rev(),reason:'Transfer team',acknowledged:true},A);
  assert.notEqual(state(B).task_scope.revision,before);assert.ok(!state(B).tm_tasks.some(t=>t.id===workTask));assert.ok(state(X).tm_tasks.some(t=>t.id===workTask));
  assert.deepEqual(state(X).tm_tasks.map(t=>t.id),miniState(s,user(X)).tm_tasks.map(t=>t.id));
 });
 check('organization audit is append-only and titles have no implicit authority',()=>{
  assert.throws(()=>s.run('DELETE FROM org_audit'));assert.throws(()=>s.run("UPDATE org_audit SET reason='rewritten'"));
  cmd('org.template.save',{id:'OWNER',name:'Executive Director',capabilities:[],expected_revision:rev()},A);assert.equal(s.organization.isLevel1(C),false);assert.equal(s.organization.grants(C).length,0);
 });
 check('Level 1 assignment grants organizational viewing independently of job role, without adding task approval permissions',()=>{
  const u=s.get('SELECT * FROM access_users WHERE staff_id=?',E);
  cmd('admin.user.save',{id:u.id,expected_version:u.version,name:u.name||'E · Review employee',email:u.email,role_id:'ROLE-MEMBER',active:1,function_settings:{'tasks.tasks':{view:'DENY'},'tasks.meetings':{view:'DENY'}}},A);
  cmd('org.structure.save',{changes:[{staff_id:E,level:1,manager_id:null}],expected_revision:rev(),acknowledged:true,reason:'Assign organization administrator explicitly'},A);
  const permissions=s.access.permissions(user(E));
  assert.ok(permissions['tasks.tasks'].includes('view'));assert.ok(permissions['tasks.meetings'].includes('view'));
  assert.ok(!permissions['tasks.tasks'].includes('approve'));assert.ok(!permissions['admin.users']?.includes('create'));
  assert.ok(state(E).tm_tasks.some(t=>t.id===workTask));
  assert.equal(s.organization.globalWorkspaces(E),false);
  assert.ok(!state(E).tm_workspaces.some(w=>w.id===wsX));
 });
 console.log(`\n${checks} Organizational Structure checks passed.`);
}finally{s.db.close();}

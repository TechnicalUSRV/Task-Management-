import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {organizationFixture} from './organization-fixture.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'sunny-org-migration-')),file=path.join(dir,'erp.sqlite');
let s,checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
try{
 s=openStore(file);seedDemo(s);
 const before={tasks:s.all('SELECT * FROM tm_tasks ORDER BY id'),members:s.all('SELECT workspace_id,staff_id FROM tm_members ORDER BY workspace_id,staff_id'),profiles:s.all('SELECT staff_id,manager_id FROM tm_profiles ORDER BY staff_id'),workspaces:s.all('SELECT id,name,owner_id,version FROM tm_workspaces ORDER BY id')};
 // Reconstruct the pre-13 shape using the existing product's seeded records, not a new migration fixture schema.
 s.db.exec('PRAGMA foreign_keys=OFF; DROP INDEX org_profile_level; DROP INDEX org_workspace_governor; DROP INDEX org_workspace_creator;');
 for(const [table,columns] of [['tm_profiles',['org_level']],['tm_workspaces',['kind','governing_manager_id','origin_workspace_id','owner_grant_id','joinable','created_by','deleted_at','deleted_by','deleted_from_status']],['tm_members',['approved_by','approval_id','member_role','joined_at']],['tm_notifications',['org_request_id']]])for(const col of columns)s.db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
 for(const {name} of s.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'org_%'"))s.db.exec(`DROP TABLE ${name}`);
 s.run('DELETE FROM schema_version WHERE version>=13');s.db.close();s=openStore(file);
 check('schema-12 upgrade preserves task records, IDs, manager relationships, ownership and memberships without guessing levels/privacy',()=>{
  assert.deepEqual(s.all('SELECT * FROM tm_tasks ORDER BY id'),before.tasks);
  assert.deepEqual(s.all('SELECT workspace_id,staff_id FROM tm_members ORDER BY workspace_id,staff_id'),before.members);
  assert.deepEqual(s.all('SELECT staff_id,manager_id FROM tm_profiles ORDER BY staff_id'),before.profiles);
  assert.deepEqual(s.all('SELECT id,name,owner_id,version FROM tm_workspaces ORDER BY id'),before.workspaces);
  assert.equal(s.organization.settings().enabled,0);assert.equal(s.get('SELECT COUNT(*) n FROM tm_profiles WHERE org_level IS NOT NULL').n,0);
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_workspaces WHERE kind!='LEGACY'").n,0);assert.equal(s.get('SELECT COUNT(*) n FROM org_grants').n,0);
  assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 });
 s.db.close();s=openStore(file);
 check('reopening the migrated database is idempotent and keeps legacy sharing intact',()=>{
  assert.equal(s.get('SELECT COUNT(*) n FROM schema_version WHERE version=13').n,1);
  assert.deepEqual(s.all('SELECT * FROM tm_tasks ORDER BY id'),before.tasks);
  assert.deepEqual(s.all('SELECT workspace_id,staff_id FROM tm_members ORDER BY workspace_id,staff_id'),before.members);
 });
 const {ids:{A,B,C,D,E,X},cmd,rev}=organizationFixture(s);
 check('explicit legacy cutover keeps every existing record and membership and is audited',()=>{
  const w=s.get("SELECT * FROM tm_workspaces WHERE kind='LEGACY' ORDER BY id LIMIT 1");
  const members=s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?',w.id);
  cmd('org.workspace.classify',{id:w.id,expected_version:w.version,expected_revision:rev(),acknowledged:true,kind:'ORGANIZATIONAL',owner_id:B,governing_manager_id:B,reason:'Reviewed legacy mapping'},A);
  for(const m of members)assert.ok(s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',w.id,m.staff_id));
  assert.deepEqual(s.all('SELECT * FROM tm_tasks ORDER BY id'),before.tasks);
  assert.ok(s.get("SELECT 1 FROM org_audit WHERE action='migration.workspace' AND workspace_id=?",w.id));
 });
 check('personal legacy classification retains inactive historical memberships without granting them active access',()=>{
  const w=s.get("SELECT * FROM tm_workspaces WHERE kind='LEGACY' AND owner_id=? ORDER BY id LIMIT 1",A),members=s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?',w.id).map(m=>m.staff_id);
  assert.ok(members.some(id=>!s.organization.active(id)));
  cmd('org.workspace.classify',{id:w.id,kind:'PERSONAL',expected_version:w.version,expected_revision:rev(),acknowledged:true,shared_member_ids:members,reason:'Owner explicitly confirms retained legacy sharing'},A);
  assert.equal(s.get('SELECT kind FROM tm_workspaces WHERE id=?',w.id).kind,'PERSONAL');
  for(const id of members){assert.ok(s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',w.id,id));if(!s.organization.active(id))assert.equal(s.organization.canViewWorkspace(id,s.get('SELECT * FROM tm_workspaces WHERE id=?',w.id)),false);}
 });
 check('lower-level reporting changes wait for derived approval; stale previews and self/foreign approvals fail',()=>{
  cmd('org.delegation.request',{beneficiary_id:C,reason:'Reviewed owner'},B);
  const q=cmd('org.structure.request',{changes:[{staff_id:E,level:5,manager_id:C}],expected_revision:rev(),reason:'Direct coordination',request_key:'structure-review'},C);
  assert.equal(s.get('SELECT manager_id FROM tm_profiles WHERE staff_id=?',E).manager_id,D);
  assert.equal(s.get('SELECT approver_id FROM org_requests WHERE id=?',q.id).approver_id,B);
  assert.throws(()=>cmd('org.request.decide',{id:q.id,decision:'APPROVE',expected_revision:rev()},C),e=>e.status===403);
  assert.throws(()=>cmd('org.request.decide',{id:q.id,decision:'APPROVE',expected_revision:rev()},X),e=>e.status===404);
  assert.throws(()=>cmd('org.request.decide',{id:q.id,decision:'APPROVE',expected_revision:0},B),e=>e.status===409);
  cmd('org.request.decide',{id:q.id,decision:'APPROVE',expected_revision:rev(),acknowledged:true},B);
  assert.equal(s.get('SELECT manager_id FROM tm_profiles WHERE staff_id=?',E).manager_id,C);
  assert.ok(s.get("SELECT 1 FROM org_audit WHERE action='employee.structure' AND approval_id=?",q.id));
 });
 check('deactivating a mapped manager requires reassignment; legacy profile routes cannot replace governed relationships',()=>{
  const u=s.get('SELECT * FROM access_users WHERE staff_id=?',C);
  assert.throws(()=>cmd('admin.user.disable',{id:u.id,expected_version:u.version},A),e=>e.status===409);
  assert.throws(()=>cmd('tm.profile.manager',{staff_id:E,manager_id:X},A),e=>e.status===403);
  assert.equal(s.get('SELECT active FROM access_users WHERE id=?',u.id).active,1);
 });
 check('configured levels beyond five work, with paginated/searchable 1,000-employee branches and cached subtree lookup',()=>{
  cmd('org.level.save',{level:6,name:'Field coordinators',expected_revision:rev()},A);
  cmd('org.level.save',{level:7,name:'Field staff',expected_revision:rev()},A);
  const account=s.get('SELECT * FROM access_users WHERE staff_id=?',E),stamp=new Date().toISOString();
  s.db.exec('BEGIN');
  for(let i=0;i<1000;i++){
   const id=`SCALE-${String(i).padStart(4,'0')}`;
   s.run("INSERT INTO lookups(id,kind,name,active) VALUES(?,'staff',?,1)",id,`Scale employee ${i}`);
   s.run("INSERT INTO access_users(id,staff_id,email,role_id,password_hash,created_at,updated_at) VALUES(?,?,?,'ROLE-MEMBER',?,?,?)",`USER-${id}`,id,`${id}@scale.test`,account.password_hash,stamp,stamp);
   s.run('INSERT INTO tm_profiles(staff_id,manager_id,org_level) VALUES(?,?,?)',id,i===0?E:'SCALE-0000',i===0?6:7);
  }s.db.exec('COMMIT');
  const start=performance.now();
  const result=s.organization.query(A,{view:'people',limit:30,page:20,q:'Scale employee'});
  assert.equal(result.total,1000);assert.equal(result.rows.length,30);
  const last=s.organization.query(A,{view:'people',q:'SCALE-0999'});assert.equal(last.total,1);assert.equal(last.rows[0].manager_id,'SCALE-0000');
  assert.equal(s.organization.descendants('SCALE-0000').size,999);const subtree=s.organization.descendants('SCALE-0000');assert.equal(s.organization.descendants('SCALE-0000'),subtree);
  cmd('org.structure.save',{changes:[{staff_id:'SCALE-0999',level:7,manager_id:'SCALE-0000'}],expected_revision:rev(),acknowledged:true,reason:'Validate configured deeper level'},B);
  assert.equal(s.organization.governor('SCALE-0999'),B);
  console.log(`  Local 1,000-employee page/search/subtree + validated edit: ${Math.round(performance.now()-start)} ms (synthetic data, not a production load benchmark).`);
 });
 console.log(`\n${checks} Organizational migration/structure/scale checks passed.`);
}finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}

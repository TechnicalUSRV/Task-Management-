import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from './service.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(tmpdir(),'tcm-v577-upgrade-')),file=path.join(dir,'upgrade.sqlite');
copyFileSync(path.join(root,'fixtures/v576-workspace-privacy.sqlite'),file);
const before=JSON.parse(readFileSync(path.join(root,'fixtures/v576-workspace-privacy.json'),'utf8'));let s;
try{
 s=openStore(file);assert.equal(s.get('SELECT MAX(version) n FROM schema_version').n,19);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);assert.equal(s.get('PRAGMA integrity_check').integrity_check,'ok');
 for(const [key,sql] of Object.entries({accounts:'SELECT id,staff_id,username,password_hash,role_id FROM access_users',tasks:'SELECT * FROM tm_tasks',members:'SELECT * FROM tm_members',history:'SELECT * FROM tm_task_history',profiles:'SELECT * FROM tm_profiles',permissions:'SELECT * FROM access_permissions'}))assert.deepEqual(JSON.parse(JSON.stringify(s.all(sql))),before[key],key);
 assert.deepEqual(JSON.parse(JSON.stringify(s.all('SELECT * FROM org_audit WHERE id<=?',before.audit.at(-1).id))),before.audit);
 const personal=s.get('SELECT * FROM tm_workspaces WHERE id=?',before.privateWs),shared=s.get('SELECT * FROM tm_workspaces WHERE id=?',before.sharedWs);assert.equal(personal.visibility,'PERSONAL');assert.equal(shared.visibility,'PUBLIC');
 for(const old of before.workspaces){const current=s.get('SELECT * FROM tm_workspaces WHERE id=?',old.id);for(const [key,value] of Object.entries(old))assert.equal(current[key],key==='version'&&old.id===before.sharedWs?value+1:value,old.id+'.'+key);}
 const user=who=>s.access.publicUser(s.access.accountFor(before.ids[who]).id),state=who=>s.scopedState(user(who));
 assert.ok(!state('B').tm_workspaces.some(w=>w.id===before.privateWs));assert.ok(state('B').tm_workspaces.some(w=>w.id===before.sharedWs));assert.ok(state('Y').tm_workspaces.some(w=>w.id===before.sharedWs));
 assert.equal(s.access.can(user('B'),'tasks.organization','create'),false);assert.equal(s.access.can(user('A'),'tasks.organization','create'),true);
 assert.ok(s.access.login('B · Review employee','Review-organization-2026','test'));
 const after={workspaces:s.all('SELECT * FROM tm_workspaces'),audit:s.all('SELECT * FROM org_audit'),revision:s.organization.settings().revision};s.db.close();s=openStore(file);assert.deepEqual(s.all('SELECT * FROM tm_workspaces'),after.workspaces);assert.deepEqual(s.all('SELECT * FROM org_audit'),after.audit);assert.equal(s.organization.settings().revision,after.revision);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS V5.7.6 → V5.7.7 migration: all accounts/passwords, tasks, profiles, membership, permissions and prior audit preserved; existing sharing converts to Public, unshared Personal stays private; no automatic Create grants; login valid; reopen is idempotent.');
}finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}

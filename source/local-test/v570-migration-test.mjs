import assert from 'node:assert/strict';
import {copyFileSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'tcm-migration-')),file=path.join(dir,'old.sqlite');let s;
try{
 copyFileSync(new URL('./fixtures/v569-upgrade.sqlite',import.meta.url),file);
 const before=JSON.parse(readFileSync(new URL('./fixtures/v569-upgrade.json',import.meta.url),'utf8'));
 s=openStore(file);
 for(const table of ['tm_tasks','tm_timesheets','tm_workspaces','tm_assignees','tm_events']){
  for(const old of before[table]){const actual=s.all('SELECT * FROM '+table).find(r=>r.id===old.id&&r.task_id===old.task_id&&r.staff_id===old.staff_id);assert.ok(actual,`${table} row retained`);for(const [key,v] of Object.entries(old))assert.deepEqual(actual[key],v,`${table}.${key}`);}
 }
 for(const old of before.access_users){const next=s.get('SELECT * FROM access_users WHERE id=?',old.id);assert.equal(next.password_hash,old.password_hash);assert.equal(next.staff_id,old.staff_id);assert.equal(next.email,old.email);assert.ok(next.username);assert.equal(s.access.login(next.username,'Fixture-password-2026','upgrade').id,next.id);}
 const names=s.all('SELECT username_key FROM access_users');assert.equal(new Set(names.map(n=>n.username_key)).size,names.length);
 const content=s.get('SELECT content FROM tm_files WHERE id=?',before.tm_files[0].id).content;assert.equal(Buffer.from(content).toString(),'Keep exactly these bytes');
 assert.equal(s.all('PRAGMA foreign_key_check').length,0);assert.equal(s.get('SELECT MAX(version) n FROM schema_version').n,19);
 const auditCount=s.get("SELECT COUNT(*) n FROM access_audit WHERE action='Username migrated'").n;s.db.close();s=openStore(file);assert.equal(s.get("SELECT COUNT(*) n FROM access_audit WHERE action='Username migrated'").n,auditCount);
 assert.equal(s.get('SELECT COUNT(*) n FROM tm_timesheets').n,before.tm_timesheets.length);
 console.log('PASS real V5.6.9 fixture migration: IDs, passwords, tasks, time, attachments, memberships, history preserved; case collision resolved; reopen idempotent; foreign keys valid.');
}finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}

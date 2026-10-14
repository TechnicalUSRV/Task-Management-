import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
const dir=mkdtempSync(path.join(tmpdir(),'tcm-access-upgrade-')),file=path.join(dir,'upgrade.sqlite');let s;
try{
 copyFileSync(new URL('./fixtures/v570-access-upgrade.sqlite',import.meta.url),file);
 const before=JSON.parse(readFileSync(new URL('./fixtures/v570-access-upgrade.json',import.meta.url),'utf8'));
 // Keep this synthetic session current so this regression remains repeatable in future releases.
 const raw=new DatabaseSync(file),expires=new Date(Date.now()+3600000).toISOString();
 assert.equal(raw.prepare('SELECT MAX(version) n FROM schema_version').get().n,17);
 raw.prepare('UPDATE access_sessions SET expires_at=?').run(expires);raw.close();before.tables.access_sessions.forEach(r=>r.expires_at=expires);
 s=openStore(file);
 for(const [table,rows] of Object.entries(before.tables)){
  const actual=JSON.parse(JSON.stringify(s.all('SELECT * FROM '+table)));
  if(table==='tm_workspaces'){for(const row of actual){assert.equal(row.visibility,'PUBLIC');delete row.visibility;}}
  const expected=table==='org_settings'?rows.map(r=>({...r,revision:r.revision+1})):rows;
  assert.deepEqual(actual,expected,table+' prior data preserved');
 }
 assert.equal(s.access.resolve({headers:{cookie:`sunny_session=${before.token}`}}).id,before.admin.id);
 for(const u of before.tables.access_users)assert.equal(s.access.login(u.username,'Fixture-password-2026','upgrade').id,u.id);
 assert.equal(s.access.can(s.access.publicUser(before.member.id),'tasks.reports'),false);
 assert.equal(s.telegram.linkFor(7100571).staff_id,before.member.staff_id);
 for(const name of ['No email one','No email two'])s.command('admin.user.save',{name,password:'Fixture-password-2026',role_id:'ROLE-MEMBER'},before.admin.staff_id);
 assert.equal(s.get("SELECT COUNT(*) n FROM access_users WHERE email='' ").n,2);
 assert.throws(()=>s.command('admin.user.save',{name:'Duplicate existing contact',email:before.tables.access_users[0].email.toUpperCase(),password:'Fixture-password-2026',role_id:'ROLE-MEMBER'},before.admin.staff_id),e=>e.status===409);
 assert.equal(s.get('SELECT MAX(version) n FROM schema_version').n,19);assert.equal(s.get('PRAGMA foreign_keys').foreign_keys,1);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 const after=s.all('SELECT * FROM access_users');s.db.close();s=openStore(file);assert.deepEqual(s.all('SELECT * FROM access_users'),after);
 assert.equal(s.access.resolve({headers:{cookie:`sunny_session=${before.token}`}}).id,before.admin.id);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS V5.7.0 → V5.7.1 upgrade: all account/password/session/permission/company/staff/work/Telegram/organization rows unchanged; optional emails and duplicate validation work; restart idempotent.');
}finally{s?.db.close();rmSync(dir,{recursive:true,force:true});}

// Verify the branding upgrade cannot duplicate existing Google Sheets row identities.
// Google is simulated locally; no external service or credentials are used.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {createFakeGoogle} from './google-fake.mjs';
import {KEY_HEADER} from './group-sync.mjs';
const fake=await createFakeGoogle();Object.assign(process.env,fake.env,{GOOGLE_REQUESTS_PER_MINUTE:'1000'});
const folder=mkdtempSync(path.join(tmpdir(),'tcm-sync-')),s=openStore(path.join(folder,'test.sqlite'));
const u=s.access.bootstrap({company_name:'Sync Test',name:'Sync Owner',email:'sync@example.test',password:'Test-password-2026'}),A=u.staff_id;
const cmd=(a,d)=>s.command(a,d,A),redirectUri='http://127.0.0.1:4398/api/google/callback';
try{
 const w=cmd('tm.workspace.save',{name:'Sync workspace',owner_id:A,member_ids:[A]}).id;
 const g=cmd('tm.group.save',{workspace_id:w,name:'Sync regression',visibility:'TEAM',audience:'WORKSPACE'}).id;
 const col=s.get('SELECT id FROM tm_board_columns WHERE board_id=?',g).id;
 const row=cmd('tm.group.row.add',{group_id:g,values:{[col]:'Original item'}}).id;
 cmd('admin.integrations.save',{client_id:'local-test.apps.googleusercontent.com',client_secret:'local-test-only',interval_s:30});
 const conn=await s.sync.request(u,{action:'connect',group_id:g},{redirectUri});
 const response=await fetch(conn.url+'&auto=1',{redirect:'manual'}),loc=new URL(response.headers.get('location'));
 assert.equal((await s.sync.finishAuth({code:loc.searchParams.get('code'),state:loc.searchParams.get('state'),browser:conn.browser},redirectUri)).ok,true);
 const setup=await s.sync.request(u,{action:'setup',group_id:g,mode:'new',title:'Sync regression',direction:'TWO_WAY',columns:[{column_id:col}]},{redirectUri});
 await s.sync.request(u,{action:'resume',id:setup.id},{redirectUri});await s.sync.request(u,{action:'sync_now',id:setup.id},{redirectUri});
 const sid=s.get('SELECT spreadsheet_id FROM tm_board_syncs WHERE id=?',setup.id).spreadsheet_id;
 let grid=fake.api.values(sid),idx=grid[0].indexOf(KEY_HEADER);assert.ok(idx>=0);assert.equal(grid[1][idx],row);
 // Emulate an existing pre-upgrade workbook and edit a cell in it.
 fake.api.edit(sid,[[0,idx,'ERP Row ID'],[1,idx===0?1:0,'Updated in existing workbook']]);
 await s.sync.request(u,{action:'sync_now',id:setup.id},{redirectUri});
 assert.equal(s.get('SELECT COUNT(*) n FROM tm_board_rows WHERE board_id=?',g).n,1);
 assert.equal(s.tasks.groups.query(g,A,{}).rows[0].values[col],'Updated in existing workbook');
 assert.ok(!fake.api.values(sid)[0].includes(KEY_HEADER));
 const before=fake.api.get(sid).version;await s.sync.request(u,{action:'sync_now',id:setup.id},{redirectUri});assert.equal(fake.api.get(sid).version,before);
 console.log('PASS simulated Google Sheets: new branded header; existing row-ID header retained; two-way update preserved; no duplicate rows or sync loop.');
}finally{s.db.close();await fake.close();rmSync(folder,{recursive:true,force:true});}

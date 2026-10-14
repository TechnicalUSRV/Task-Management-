// V5.6.9: Groups — Attachment columns (upload, open, remove, privacy, limits), the upgrade that lets earlier companies
// use the new column type, the row-number column's width, and the "Expectation" label of task requests.
// Temporary company data only; nothing leaves this computer.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from './service.mjs';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {cleanCell,cellText,COLUMN_TYPES,GROUP_LIMITS} from './group-domain.mjs';

const folder=mkdtempSync(path.join(tmpdir(),'sunny-v569-'));
let checks=0,server;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const fails=(fn,pattern,status)=>assert.throws(fn,e=>(pattern.test(e.message)||assert.fail(`Unexpected message: ${e.message}`))&&(!status||e.status===status||assert.fail(`Expected ${status}, got ${e.status}: ${e.message}`)));
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==','base64').toString('base64');
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
const EXE=Buffer.from('MZ\x90\x00 a program','latin1').toString('base64');
try{
 await check('companies created before V5.6.9 are upgraded once to accept Attachment columns, keeping every column and its access rules',async()=>{
  const file=path.join(folder,'old.sqlite');
  let s=openStore(file);
  s.access.bootstrap({name:'Owner',email:'owner@example.test',password:'owner-password-1',company_name:'Old company'});
  const owner=s.get('SELECT staff_id FROM access_users').staff_id;
  const ws=s.command('tm.workspace.save',{name:'Ops',owner_id:owner,member_ids:[owner]},owner).id;
  const g=s.command('tm.group.save',{workspace_id:ws,name:'Register',visibility:'TEAM',audience:'WORKSPACE'},owner).id;
  const col=s.command('tm.group.column.save',{group_id:g,name:'Amount',type:'NUMBER'},owner).id;
  s.command('tm.group.column.access',{group_id:g,id:col,principals:[{type:'USER',id:owner}]},owner);
  s.db.close();
  // Put the V5.6.8 definition back (without ATTACHMENT), as an earlier company has it.
  const raw=new DatabaseSync(file);
  const def=raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tm_board_columns'").get().sql;
  const indexes=raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tm_board_columns' AND sql IS NOT NULL").all().map(r=>r.sql);
  raw.exec('PRAGMA foreign_keys=OFF;BEGIN');
  raw.exec(def.replace(",'ATTACHMENT')",")").replace(/^CREATE TABLE\s+"?tm_board_columns"?/,'CREATE TABLE old_cols'));
  raw.exec('INSERT INTO old_cols SELECT * FROM tm_board_columns;DROP TABLE tm_board_columns;ALTER TABLE old_cols RENAME TO tm_board_columns;');
  for(const sql of indexes)raw.exec(sql);
  raw.exec("DELETE FROM schema_version WHERE version=15;COMMIT;PRAGMA foreign_keys=ON");
  assert.ok(!raw.prepare("SELECT sql FROM sqlite_master WHERE name='tm_board_columns'").get().sql.includes('ATTACHMENT'));
  raw.close();
  s=openStore(file);
  assert.ok(s.get("SELECT sql FROM sqlite_master WHERE name='tm_board_columns'").sql.includes("'ATTACHMENT'"),'upgraded');
  assert.ok(s.get('SELECT 1 AS ok FROM schema_version WHERE version=15'));
  assert.equal(s.all('SELECT * FROM tm_board_columns WHERE board_id=?',g).length,2,'columns kept');
  assert.equal(s.all('SELECT * FROM tm_board_column_access WHERE column_id=?',col).length,1,'column access rules kept');
  assert.equal(s.all('PRAGMA foreign_key_check').length,0);
  assert.equal(s.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tm_board_columns'").length>=2,true,'indexes rebuilt');
  s.command('tm.group.column.save',{group_id:g,name:'Files',type:'ATTACHMENT'},owner);
  s.db.close();
  s=openStore(file);assert.equal(s.all("SELECT type FROM tm_board_columns WHERE board_id=? AND type='ATTACHMENT'",g).length,1,'reopening changes nothing');s.db.close();
 });

 const hub=openCompanies(path.join(folder,'hub'),{demo:true}),s=hub.primary;
 const cmd=(action,data,actor)=>s.command(action,data,actor);
 const OWNER='STAFF-003',EDITOR='STAFF-002',VIEWER='STAFF-001';
 s.access.bootstrap({staff_id:OWNER,name:'Vanna · Director',email:'vanna@example.test',password:'vanna-password-1'});
 cmd('admin.user.save',{staff_id:EDITOR,name:'Sophea · Sales',email:'sophea@example.test',role_id:'ROLE-MANAGER',password:'sophea-password-1',active:1},OWNER);
 cmd('admin.user.save',{staff_id:VIEWER,name:'Dara · Sales',email:'dara@example.test',role_id:'ROLE-MEMBER',password:'dara-password-12',active:1},OWNER);
 const ws=cmd('tm.workspace.save',{name:'V5.6.9 Files',owner_id:OWNER,member_ids:[OWNER,EDITOR,VIEWER]},OWNER).id;
 const g=cmd('tm.group.save',{workspace_id:ws,name:'Shipments',visibility:'TEAM',audience:'SELECTED',shared:[{staff_id:EDITOR,level:'EDIT'},{staff_id:VIEWER,level:'VIEW'}]},OWNER).id;
 const docs=cmd('tm.group.column.save',{group_id:g,name:'Documents',type:'ATTACHMENT'},OWNER).id;
 const row=cmd('tm.group.row.add',{group_id:g},OWNER).id;
 const via=(staff,action,data)=>{s.access.authorize(s.access.publicUser(s.access.accountFor(staff).id),action,data);return s.command(action,data,staff);};
 const cell=()=>JSON.parse(s.get('SELECT values_json FROM tm_board_rows WHERE id=?',row).values_json)[docs]||[];
 let photo,pdf;

 await check('Attachment is the eighth column type; files are uploaded into a cell, checked, and listed by name',async()=>{
  assert.deepEqual(Object.values(COLUMN_TYPES),['Text','Date','Number','Status','In Charge','Support','Formula','Attachment']);
  const r=via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'seal.png',base64:PNG});photo=r.id;
  assert.equal(r.row.values[docs].length,1);assert.equal(r.row.values[docs][0].name,'seal.png');assert.equal(r.row.values[docs][0].mime,'image/png');
  pdf=via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'C:\\scans\\invoice.pdf',base64:PDF}).id;
  assert.deepEqual(cell().map(f=>f.name),['seal.png','invoice.pdf'],'path parts are dropped from names');
  fails(()=>via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'invoice.pdf',base64:EXE}),/not a real PDF/,400);
  fails(()=>via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'tool.exe',base64:EXE}),/Attach an image/,400);
  fails(()=>via(VIEWER,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'seal.png',base64:PNG}),/can’t change records/,403);
  const text=s.all('SELECT id FROM tm_board_columns WHERE board_id=? AND type=?',g,'TEXT')[0].id;
  fails(()=>via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:text,name:'seal.png',base64:PNG}),/only to Attachment columns/,409);
  assert.equal(cellText({type:'ATTACHMENT'},cell()),'seal.png, invoice.pdf');
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE board_id=?',g).n,2);
  assert.match(s.get("SELECT detail FROM tm_events WHERE entity_type='group' AND action='File attached' ORDER BY id DESC LIMIT 1").detail,/Documents · invoice\.pdf/);
 });

 await check('files open for everyone who may see the row and column (images and PDF in the browser), and nobody else',async()=>{
  const port=4369,base=`http://127.0.0.1:${port}`;server=createLocalServer(s,port,hub);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const login=async(email,password)=>{const r=await fetch(`${base}/c/default/api/auth/login`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:s.get('SELECT username FROM access_users WHERE email=?',email).username,password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
  const dara=await login('dara@example.test','dara-password-12');
  const get=(cookie,file,inline='')=>fetch(`${base}/c/default/api/tasks/group/file?id=${g}&file=${file}${inline}`,{headers:{Cookie:cookie}});
  let r=await get(dara,pdf,'&inline=1');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/pdf');assert.match(r.headers.get('content-disposition'),/^inline;.*invoice\.pdf/);assert.match(await r.text(),/^%PDF-/);
  r=await get(dara,photo);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.match(r.headers.get('content-disposition'),/^attachment;/);
  // The column made visible to its owner only: its files are “not found” for others.
  cmd('tm.group.column.access',{group_id:g,id:docs,principals:[{type:'USER',id:OWNER}]},OWNER);
  assert.equal((await get(dara,pdf)).status,404);
  cmd('tm.group.column.access',{group_id:g,id:docs,principals:[]},OWNER);
  assert.equal((await get(dara,pdf)).status,200);
  assert.equal((await get(dara,'GFILE-999999')).status,404);
  r=await fetch(`${base}/c/default/api/tasks/group/file?id=${g}&file=${pdf}`);assert.equal(r.status,401,'signed out');
 });

 await check('a cell keeps or removes its files but never takes typed values; removing a file deletes it',async()=>{
  assert.equal(cleanCell({type:'ATTACHMENT'},'invoice.pdf',{current:cell()}).ok,false);
  assert.equal(cleanCell({type:'ATTACHMENT'},[{id:'GFILE-1',name:'x'}],{current:cell()}).ok,false,'only files already in the cell');
  fails(()=>via(EDITOR,'tm.group.row.update',{group_id:g,id:row,values:{[docs]:[...cell(),{id:'GFILE-999999',name:'x.pdf'}]},expected:{[docs]:cell()}}),/Upload button/,422);
  via(EDITOR,'tm.group.row.update',{group_id:g,id:row,values:{[docs]:[photo]},expected:{[docs]:cell()}});
  assert.deepEqual(cell().map(f=>f.id),[photo]);assert.ok(!s.get('SELECT 1 AS ok FROM tm_board_files WHERE id=?',pdf),'the removed file is deleted');
  const r=via(EDITOR,'tm.group.file.remove',{group_id:g,row_id:row,column_id:docs,file_id:photo});assert.equal(r.row.values[docs],undefined);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE board_id=?',g).n,0);
  fails(()=>via(EDITOR,'tm.group.file.remove',{group_id:g,row_id:row,column_id:docs,file_id:photo}),/already removed/,404);
 });

 await check('limits per cell and per file; deleting rows, columns or the group, or changing the column type (after confirming), deletes the files',async()=>{
  for(let i=0;i<GROUP_LIMITS.files;i++)via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:`p${i}.png`,base64:PNG});
  fails(()=>via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'one-more.png',base64:PNG}),/up to 20 files/,409);
  fails(()=>via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:docs,name:'big.pdf',base64:Buffer.alloc(GROUP_LIMITS.fileBytes+1,65).toString('base64')}),/between 1 byte and 30 MB/,400);
  const col=s.get('SELECT * FROM tm_board_columns WHERE id=?',docs);
  fails(()=>cmd('tm.group.column.save',{group_id:g,id:docs,expected_version:col.version,name:'Documents',type:'TEXT'},OWNER),/Confirm to change the type/,409);
  cmd('tm.group.column.save',{group_id:g,id:docs,expected_version:col.version,name:'Documents',type:'TEXT',confirm_clear:true},OWNER);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE board_id=?',g).n,0,'files go with the type change');
  const files2=cmd('tm.group.column.save',{group_id:g,name:'Photos',type:'ATTACHMENT'},OWNER).id;
  via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row,column_id:files2,name:'a.png',base64:PNG});
  const row2=cmd('tm.group.row.add',{group_id:g},OWNER).id;via(EDITOR,'tm.group.file.add',{group_id:g,row_id:row2,column_id:files2,name:'b.png',base64:PNG});
  cmd('tm.group.row.delete',{group_id:g,id:row2,expected_version:s.get('SELECT version FROM tm_board_rows WHERE id=?',row2).version},OWNER);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE row_id=?',row2).n,0,'with the row');
  cmd('tm.group.column.delete',{group_id:g,id:files2,expected_version:0,confirm:true},OWNER);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE board_id=?',g).n,0,'with the column');
  // A group deleted permanently (after archiving) takes its files with it.
  const g2=cmd('tm.group.save',{workspace_id:ws,name:'Temporary',visibility:'PERSONAL'},OWNER).id,c2=cmd('tm.group.column.save',{group_id:g2,name:'Scans',type:'ATTACHMENT'},OWNER).id,r2=cmd('tm.group.row.add',{group_id:g2},OWNER).id;
  cmd('tm.group.file.add',{group_id:g2,row_id:r2,column_id:c2,name:'scan.pdf',base64:PDF},OWNER);
  const ver=()=>s.get('SELECT version FROM tm_boards WHERE id=?',g2).version;
  cmd('tm.group.archive',{id:g2,status:'ARCHIVED',expected_version:ver()},OWNER);cmd('tm.group.delete',{id:g2,confirm:true,expected_version:ver()},OWNER);
  assert.equal(s.get('SELECT COUNT(*) AS n FROM tm_board_files WHERE board_id=?',g2).n,0,'with the group');
 });

 await check('the row-number column has its own width (my view, and the shared default); request details are called “Expectation”',async()=>{
  via(VIEWER,'tm.group.view.save',{group_id:g,view:{rownum:150}});
  assert.equal(s.tasks.groups.read(g,VIEWER).view.rownum,150);
  via(VIEWER,'tm.group.view.save',{group_id:g,view:{rownum:5000}});assert.equal(s.tasks.groups.read(g,VIEWER).view.rownum,GROUP_LIMITS.rownumWidth[1]);
  cmd('tm.group.layout.save',{group_id:g,layout:{rownum:90}},OWNER);assert.equal(s.tasks.groups.read(g,EDITOR).layout.rownum,90);
  fails(()=>cmd('tm.request.save',{title:'Pallets',manager_id:EDITOR,description:'x'.repeat(8001)},VIEWER),/^Expectation must be at most 8000 characters/,400);
 });
 console.log(`\n${checks} V5.6.9 checks passed (Group attachments and column widths, request Expectation). Temporary data only.`);
}finally{server?.close();rmSync(folder,{recursive:true,force:true});}

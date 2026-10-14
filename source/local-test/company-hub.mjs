import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,InputError} from './service.mjs';
import {seedDemo} from './seed.mjs';

export function openCompanies(dataDir,{demo=false}={}){
 mkdirSync(dataDir,{recursive:true});
 const registry=new DatabaseSync(path.join(dataDir,'companies.sqlite'));
 registry.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,name TEXT NOT NULL,filename TEXT NOT NULL,created_at TEXT NOT NULL);');
 const stores=new Map(),primary=openStore(path.join(dataDir,'erp.sqlite'));if(demo)seedDemo(primary);stores.set('default',primary);
 registry.prepare('INSERT OR IGNORE INTO companies VALUES(?,?,?,?)').run('default',primary.get('SELECT name FROM company WHERE id=1')?.name||'New company','erp.sqlite',new Date().toISOString());
 function get(id){const entry=registry.prepare('SELECT * FROM companies WHERE id=?').get(id);if(!entry)throw new InputError('Company not found.',404);if(!stores.has(id))stores.set(id,openStore(path.join(dataDir,entry.filename)));return stores.get(id);}
 function list(){return registry.prepare('SELECT id,name FROM companies ORDER BY created_at,id').all().map(c=>{try{return {...c,name:get(c.id).get('SELECT name FROM company WHERE id=1')?.name||c.name};}catch(e){console.error(`Company ${c.id} could not be opened: ${e.message}`);return {...c};}});}
 function create(d){
  const name=typeof d.name==='string'?d.name.trim():'';if(!name||name.length>200)throw new InputError('Enter a company name of up to 200 characters.');
  if(list().some(c=>c.name.toLowerCase()===name.toLowerCase()))throw new InputError('This company name already exists.',409);
  const key='company-'+randomUUID(),filename=`companies/${key}.sqlite`,target=path.join(dataDir,filename);let store;
  try{
   store=openStore(target);
   store.db.exec('BEGIN IMMEDIATE');
   store.insert('company',{id:1,name,address:'',currency:'USD'});
   const refs={staff:[['STAFF-001',String(d.admin_name||'Administrator')]],branch:[['BR-HQ','Head office']],material:[['SVC-001','Service','service']],contact_class:[['CC001','Business']],lead_class:[['LC001','New business']],opportunity_class:[['OC001','Business']],campaign_class:[['MC001','General']],partner:[['P001','Direct']]};
   for(const [kind,rows] of Object.entries(refs).filter(([kind])=>demo||kind==='staff'))for(const [id,name,unit=''] of rows)store.insert('lookups',{id,kind,name,unit,active:1});
   store.insert('sequences',{kind:'staff',value:1});if(demo)store.insert('approval_steps',{step:1,approver_id:'STAFF-001'});
   store.db.exec('COMMIT');
   store.access.bootstrap({staff_id:'STAFF-001',name:d.admin_name,email:d.admin_email,password:d.admin_password});
   registry.prepare('INSERT INTO companies VALUES(?,?,?,?)').run(key,name,filename,new Date().toISOString());stores.set(key,store);
   return {id:key,name,message:'Company created with its own records, accounts and roles.'};
  }catch(e){try{store?.db.close();}catch{}for(const suffix of ['','-wal','-shm'])rmSync(target+suffix,{force:true});throw e;}
 }
 return {primary,get,list,create,close(){for(const store of stores.values())store.db.close();registry.close();}};
}

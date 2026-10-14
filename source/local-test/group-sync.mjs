// V5.5 Groups ↔ Google Sheets. A group can be connected to one worksheet of a Google spreadsheet: Group → Sheets,
// Sheets → Group, or both ways. How it works:
//
//  • The person who connects it must manage the group (“Can manage”) and signs in to Google (OAuth 2.0 with PKCE).
//    Their refresh token is encrypted on the server (secret-box.mjs) and never reaches a browser. The sync acts for them,
//    and every change it makes is recorded as made by “Google Sheets sync” on their behalf.
//  • Rows are linked by a stable ID: the worksheet gets an “Task Controlling Management Row ID” column. Columns are linked by the header text in
//    row 1, so columns can be moved freely in the sheet. A header that disappears (renamed or deleted) stops the sync
//    with an explicit message instead of guessing.
//  • Each run compares three values per cell: the last synced value (kept in tm_board_sync_rows), the group's value and
//    the sheet's value. A value changed on one side is copied to the other. A cell changed on both sides since the last
//    sync becomes a conflict that someone resolves; neither side is overwritten silently. Because the last synced value
//    is updated after each copy, a change never bounces back and forth.
//  • Formula columns go to the sheet only (as values); a formula someone typed in the sheet is never overwritten.
//  • Nothing is deleted on the other side unless deletion is explicitly turned on for the connection.
//  • Only rows and columns everyone in the group may see are sent (rows and columns with access rules are left out
//    unless the person who connects explicitly includes them), and the sharing of the Google file is never changed.
//  • Before each run the connection is checked again: the person who connected it must still manage the group with an
//    active login, and Google access must still be valid. Otherwise the sync stops and says why.
//  • Changes are picked up by polling (the file's Drive version first, then the values), every 60 seconds by default
//    (configurable, at least 15). With a public HTTPS address, Google Drive change notifications trigger a sync at
//    once. Failed requests are retried with exponential backoff within Google's quotas.
import {randomBytes,randomUUID} from 'node:crypto';
import * as G from './google-api.mjs';
import {GROUP_LIMITS,nameKey,cleanName,cellText,statusLabels,emptyValue,tidy,parseNumber,computeRow,prepareFormulas,COLUMN_TYPES} from './group-domain.mjs';
import {serialToDay,colName} from './xlsx.mjs';
import {textDate} from './group-import.mjs';
import {hashToken} from './secret-box.mjs';

export const KEY_HEADER='Task Controlling Management Row ID';
const DIRECTIONS={TO_SHEETS:'Group → Google Sheets',FROM_SHEETS:'Google Sheets → Group',TWO_WAY:'Both ways'};
const parse=(json,fallback)=>{try{const v=JSON.parse(json);return v??fallback;}catch{return fallback;}};
const SYNCABLE=['TEXT','NUMBER','DATE','STATUS','IN_CHARGE','SUPPORT','FORMULA'];
const NO_DELETE='Your role can’t delete records in groups, so rows deleted in the sheet can’t be deleted in the group. Choose to keep deleted rows, or ask an administrator for Groups “Delete”.';
const FROM_SHEET_TYPES=['TEXT','NUMBER','DATE','STATUS','IN_CHARGE','SUPPORT'];

export function createGroupSync(c){
 const {db,get,all,run,insert,update,id,fail,str,now,groups,canStaff,nameOf,box,changed}=c;
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const running=new Set();
 const log=(staff,boardId,action,detail)=>{const b=get('SELECT workspace_id,name FROM tm_boards WHERE id=?',boardId);if(!b)return;insert('tm_events',{entity_type:'group',entity_id:boardId,workspace_id:b.workspace_id,action,detail:`${b.name}${detail?' · '+detail:''}`,actor_id:staff,created_at:now()});};

 // ---------------------------------------------------------------- configuration (Administration → Google Sheets)
 const config=()=>get('SELECT * FROM tm_google_config WHERE id=1')||{client_id:'',client_secret_enc:'',allow_existing:0,interval_s:60,push:0,version:0};
 function publicConfig(redirectUri){
  const cf=config();
  return {client_id:cf.client_id,secret_set:!!cf.client_secret_enc,allow_existing:!!cf.allow_existing,interval_s:cf.interval_s,push:!!cf.push,version:cf.version||0,redirect_uri:redirectUri,simulated:G.GOOGLE.simulated(),
   endpoints:{auth:G.GOOGLE.auth(),sheets:G.GOOGLE.sheets(),drive:G.GOOGLE.drive()},
   connections:all("SELECT s.id,s.board_id,b.name AS group_name,s.status,s.direction,s.last_success_at,s.spreadsheet_name,l.name AS connected_by FROM tm_board_syncs s JOIN tm_boards b ON b.id=s.board_id JOIN lookups l ON l.id=s.staff_id ORDER BY b.name")};
 }
 function saveConfig(d,actor){
  const old=get('SELECT * FROM tm_google_config WHERE id=1');
  if(old&&d.expected_version!==undefined&&d.expected_version!==old.version)fail('These settings changed. Reload them before saving again.',409);
  const clientId=str(d.client_id,'Client ID',300).trim();
  if(clientId&&!/^[\w.-]+$/.test(clientId))fail('Enter the OAuth client ID exactly as Google shows it (for example 1234-abc.apps.googleusercontent.com).');
  const secret=d.client_secret===undefined||d.client_secret===null||d.client_secret===''?(old?.client_secret_enc||''):box.seal(str(d.client_secret,'Client secret',300,true));
  const interval=Number(d.interval_s??old?.interval_s??60);if(!Number.isInteger(interval)||interval<15||interval>3600)fail('Check for changes every 15 to 3,600 seconds.');
  const values={client_id:clientId,client_secret_enc:d.clear_secret===true?'':secret,allow_existing:d.allow_existing===true?1:0,interval_s:interval,push:d.push===true?1:0,version:(old?.version||0)+1,updated_by:actor,updated_at:now()};
  if(old)update('tm_google_config',1,values);else insert('tm_google_config',{id:1,...values});
  run('UPDATE tm_board_syncs SET interval_s=? WHERE interval_s<?',interval,interval);
  insert('access_audit',{actor_id:actor,action:'Google Sheets connection settings saved',target_id:'GOOGLE',detail:`client ${clientId||'not set'} · secret ${values.client_secret_enc?'set':'not set'} · existing spreadsheets ${values.allow_existing?'allowed':'not allowed'} · every ${interval} s · notifications ${values.push?'on':'off'}`,created_at:now()});
  return {message:'Google Sheets settings saved.'};
 }
 const credentials=()=>{const cf=config();if(!cf.client_id||!cf.client_secret_enc)throw new G.GoogleError('Google Sheets is not set up yet. An administrator adds the OAuth client in Administration → Google Sheets.',{status:409,code:'not_configured'});return {clientId:cf.client_id,clientSecret:box.open(cf.client_secret_enc)};};

 // ---------------------------------------------------------------- Google accounts (OAuth with PKCE)
 const account=staff=>get('SELECT * FROM tm_google_accounts WHERE staff_id=?',staff);
 const publicAccount=staff=>{const a=account(staff);return a?{email:a.email,status:a.status,status_detail:a.status_detail,connected_at:a.connected_at,existing:a.scopes.includes(G.SCOPES.existing)}:null;};
 function startAuth(staff,redirectUri,{existing=false}={}){
  const {clientId}=credentials(),cf=config();
  if(existing&&!cf.allow_existing)fail('Connecting existing spreadsheets is turned off. An administrator can allow it in Administration → Google Sheets.',403);
  const state=randomBytes(24).toString('base64url'),browser=randomBytes(24).toString('base64url'),{verifier,challenge}=G.pkce();
  run('DELETE FROM tm_google_oauth_states WHERE created_at<?',new Date(Date.now()-15*60000).toISOString());
  insert('tm_google_oauth_states',{state,staff_id:staff,verifier_enc:box.seal(verifier),browser_hash:hashToken(browser),existing:existing?1:0,created_at:now()});
  return {url:G.authUrl({clientId,redirectUri,state,challenge,existing}),browser};
 }
 /** Google sends the person back here. The state is single-use, expires after 10 minutes and must come back to the same
  *  browser that started (a cookie set when it started), so nobody can attach their own Google account to someone else. */
 async function finishAuth({code,state,error,browser},redirectUri){
  const st=state?get('SELECT * FROM tm_google_oauth_states WHERE state=?',String(state).slice(0,100)):null;
  if(st)run('DELETE FROM tm_google_oauth_states WHERE state=?',st.state);
  if(!st||Date.parse(st.created_at)<Date.now()-10*60000)return {ok:false,message:'This sign-in link has expired or was already used. Start again from the group’s Google Sheets settings.'};
  if(!browser||hashToken(browser)!==st.browser_hash)return {ok:false,message:'Finish connecting Google in the same browser where you started.'};
  if(error)return {ok:false,message:error==='access_denied'?'Google access was not allowed, so nothing was connected.':`Google answered: ${String(error).slice(0,100)}`};
  const {clientId,clientSecret}=credentials();
  const t=await G.exchangeCode({code:String(code||''),verifier:box.open(st.verifier_enc),clientId,clientSecret,redirectUri});
  if(!t.refresh_token)return {ok:false,message:'Google did not grant offline access. Try again and allow access.'};
  const me=await G.userInfo(t.access_token).catch(()=>({}));
  tx(()=>{
   const old=account(st.staff_id);
   const values={email:String(me.email||'').slice(0,200),refresh_enc:box.seal(t.refresh_token),access_enc:box.seal(t.access_token),access_expires:new Date(Date.now()+(Number(t.expires_in)||3600)*1000).toISOString(),scopes:String(t.scope||G.SCOPES.base.join(' ')).slice(0,1000),connected_at:now(),status:'ACTIVE',status_detail:''};
   if(old)run('UPDATE tm_google_accounts SET email=?,refresh_enc=?,access_enc=?,access_expires=?,scopes=?,connected_at=?,status=?,status_detail=? WHERE staff_id=?',...Object.values(values),st.staff_id);
   else insert('tm_google_accounts',{staff_id:st.staff_id,...values});
   insert('access_audit',{actor_id:st.staff_id,action:'Google account connected',target_id:st.staff_id,detail:values.email||'(email not shared)',created_at:now()});
   // Connections that stopped because access was revoked can run again.
   run("UPDATE tm_board_syncs SET status='ACTIVE',status_detail='',failures=0,next_run_at=? WHERE staff_id=? AND status='ERROR' AND status_detail LIKE 'Google access%'",now(),st.staff_id);
  });
  changed?.();
  return {ok:true,email:me.email||''};
 }
 async function token(staff,{fresh=false}={}){
  const a=account(staff);
  if(!a||a.status!=='ACTIVE')throw new G.GoogleError('Google is not connected for the person who set up this sync. They connect Google again from the group’s settings.',{status:409,code:'revoked',revoked:true});
  if(!fresh&&a.access_enc&&a.access_expires&&Date.parse(a.access_expires)>Date.now()+60000)return box.open(a.access_enc);
  const {clientId,clientSecret}=credentials();
  try{
   const t=await G.refreshToken({refresh:box.open(a.refresh_enc),clientId,clientSecret,account:staff});
   run('UPDATE tm_google_accounts SET access_enc=?,access_expires=? WHERE staff_id=?',box.seal(t.access_token),new Date(Date.now()+(Number(t.expires_in)||3600)*1000).toISOString(),staff);
   return t.access_token;
  }catch(e){
   if(e.revoked)tx(()=>{run("UPDATE tm_google_accounts SET status='REVOKED',status_detail=?,access_enc=NULL WHERE staff_id=?",e.message,staff);insert('access_audit',{actor_id:staff,action:'Google access revoked',target_id:staff,detail:e.google||e.message,created_at:now()});});
   throw e;
  }
 }
 async function disconnectAccount(staff){
  const a=account(staff);if(!a)return {message:'Google was not connected.'};
  try{await G.revoke(box.open(a.refresh_enc));}catch{}
  tx(()=>{
   run('DELETE FROM tm_google_accounts WHERE staff_id=?',staff);
   run("UPDATE tm_board_syncs SET status='ERROR',status_detail='Google access was disconnected by the person who set up this sync. Connect Google again to continue.' WHERE staff_id=? AND status<>'PAUSED'",staff);
   insert('access_audit',{actor_id:staff,action:'Google account disconnected',target_id:staff,detail:a.email,created_at:now()});
  });
  changed?.();
  return {message:'Google is disconnected. Syncs you set up have stopped.'};
 }

 // ---------------------------------------------------------------- who may manage a connection, and what may be shared
 const manager=(boardId,staff)=>{const b=get('SELECT * FROM tm_boards WHERE id=?',String(boardId||''));if(!b)return null;const caps=groups.internals.capsFor(b,staff);return caps.share?{b,caps}:null;};
 const mustManage=(boardId,staff)=>{const r=manager(boardId,staff);if(!r)fail('Only people who manage this group can connect it to Google Sheets.',403);return r;};
 // Columns and rows that may go to the sheet: without explicit inclusion, only those everyone in the group can see.
 function shareable(sync,b){
  const cols=groups.internals.columnsOf(b.id),rules=groups.internals.rulesOf(b.id),include=!!sync.include_restricted;
  const openCol=col=>include||!rules.cols.has(col.id);
  // A formula is shared only if every column it uses is shared too.
  const vis=groups.internals.visibleColumns(cols,openCol);
  const mapping=parse(sync.mapping_json,[]),byId=new Map(vis.map(x=>[x.id,x]));
  const columns=mapping.map(m=>({...m,col:byId.get(m.column_id)})).filter(m=>m.col&&SYNCABLE.includes(m.col.type));
  const rows=groups.internals.rowsOf(b.id).filter(r=>include||!rules.rows.has(r.id));
  return {columns,rows,all:cols,excludedRows:include?0:rules.rows.size,excludedColumns:cols.length-vis.length,unmappedMissing:mapping.filter(m=>!byId.has(m.column_id))};
 }

 // ---------------------------------------------------------------- values on both sides, compared as text
 const people=b=>{
  const list=groups.eligible(b),byId=new Map(list.map(p=>[p.id,p])),byName=new Map(),byEmail=new Map();
  for(const p of list){const k=nameKey(p.name);if(!byName.has(k))byName.set(k,[]);byName.get(k).push(p);}
  for(const r of all("SELECT staff_id AS id,lower(email) AS email FROM tm_profiles WHERE email<>'' UNION SELECT staff_id,lower(email) FROM access_users"))if(byId.has(r.id)&&r.email&&!byEmail.has(r.email))byEmail.set(r.email,r.id);
  return text=>{const t=String(text).trim();if(byId.has(t))return t;const e=byEmail.get(t.toLowerCase());if(e)return e;const n=byName.get(nameKey(t))||[];return n.length===1?n[0].id:null;};
 };
 /** The group's value of a cell: {text} for comparing and {raw} for writing to the sheet. */
 function erpCell(col,row,computed){
  const v=col.type==='FORMULA'?computed[col.id]:row.values[col.id];
  if(emptyValue(v))return {text:'',raw:''};
  if(col.type==='FORMULA'){if(typeof v==='object')return {text:v.error,raw:v.error};if(typeof v==='boolean')return {text:v?'TRUE':'FALSE',raw:v};return {text:String(tidy(v)),raw:v};}
  if(col.type==='NUMBER')return {text:String(tidy(v)),raw:v};
  if(col.type==='DATE')return {text:String(v),raw:String(v)};
  const t=cellText(col,v,nameOf);return {text:t,raw:t};
 }
 /** The sheet's value of a cell as the same kind of text. */
 function sheetText(col,v){
  if(v===undefined||v===null||v==='')return '';
  if(typeof v==='boolean')return v?'TRUE':'FALSE';
  if(col.type==='DATE'){if(typeof v==='number')return serialToDay(v)||String(v);return textDate(v)||String(v).trim();}
  if(col.type==='NUMBER'||col.type==='FORMULA'){if(typeof v==='number')return String(tidy(v));const r=parseNumber(String(v));return r.ok&&r.value!==null?String(r.value):String(v).trim();}
  if(typeof v==='number')return String(tidy(v));
  return String(v).replace(/\r\n?/g,'\n').trimEnd();
 }
 /** A sheet value as a group value (or an error message). */
 function fromSheet(col,text,person){
  if(text==='')return {value:null};
  switch(col.type){
   case 'TEXT':return {value:text};
   case 'NUMBER':{const r=parseNumber(text);return r.ok?{value:r.value}:{error:`“${text.slice(0,40)}” is not a number`};}
   case 'DATE':return /^\d{4}-\d{2}-\d{2}$/.test(text)?{value:text}:{error:`“${text.slice(0,40)}” is not a date`};
   case 'STATUS':{const l=statusLabels(col).find(x=>nameKey(x.name)===nameKey(text));return l?{value:l.id}:{error:`“${text.slice(0,40)}” is not one of the labels of ${col.name}`};}
   case 'IN_CHARGE':{const p=person(text);return p?{value:p}:{error:`nobody who can be chosen in this group matches “${text.slice(0,40)}”`};}
   case 'SUPPORT':{const ids=[];for(const part of text.split(/[;,\n]/).map(x=>x.trim()).filter(Boolean)){const p=person(part);if(!p)return {error:`nobody who can be chosen in this group matches “${part.slice(0,40)}”`};ids.push(p);}return {value:[...new Set(ids)]};}
   default:return {error:`${COLUMN_TYPES[col.type]} columns are not changed from the sheet`};
  }
 }

 // ---------------------------------------------------------------- one run
 // Reads both sides, works out every change (plan), and, unless only previewing, applies it: group changes in one
 // transaction, sheet changes in batched requests, then the new “last synced” values.
 async function read(sync){
  const tk=await token(sync.staff_id);
  const meta=await G.getSpreadsheet(tk,sync.spreadsheet_id,sync.staff_id);
  const sheet=(meta.sheets||[]).map(x=>x.properties).find(p=>p.sheetId===sync.sheet_id);
  if(!sheet)throw new G.GoogleError('The connected worksheet was deleted from the spreadsheet (or renamed into another file). Choose a worksheet again.',{status:404,code:'sheet_missing'});
  const [values,formulas]=await Promise.all([G.getValues(tk,sync.spreadsheet_id,sheet.title,'UNFORMATTED_VALUE',sync.staff_id),G.getValues(tk,sync.spreadsheet_id,sheet.title,'FORMULA',sync.staff_id)]);
  return {tk,title:sheet.title,name:meta.properties?.title||sync.spreadsheet_name,grid:values.values||[],formulas:formulas.values||[]};
 }
 function plan(sync,b,sheet){
  const share=shareable(sync,b),direction=sync.direction,mapping=parse(sync.mapping_json,[]);
  const issues=[],warnings=[],person=people(b),prepared=prepareFormulas(share.all);
  // The sync acts for the person who set it up, so the sheet can do to the group only what their role allows in the Task Controlling Management:
  // change records (Update), add rows (Create) and delete rows (Delete).
  const caps=groups.internals.capsFor(b,sync.staff_id),who=nameOf(sync.staff_id);let notAdded=0,notDeleted=0;
  if(share.unmappedMissing.length)warnings.push(`${share.unmappedMissing.length} mapped column${share.unmappedMissing.length===1?' was':'s were'} deleted from the group or restricted, and ${share.unmappedMissing.length===1?'is':'are'} no longer synced.`);
  // Header row: where each mapped column is (by its header text), and the Task Controlling Management Row ID column.
  const header=(sheet.grid[0]||[]).map(v=>String(v??'').trim());
  const at=new Map();header.forEach((h,i)=>{if(!h)return;const k=nameKey(h);if(at.has(k))issues.push(`The sheet has two columns named “${h}”. Give each column a different name.`);else at.set(k,i);});
  let width=header.length;const headerWrites=[];
  const locate=(name,{create})=>{const k=nameKey(name);if(at.has(k))return at.get(k);if(!create)return -1;const i=width++;at.set(k,i);headerWrites.push([i,name]);return i;};
  const writesToSheet=direction!=='FROM_SHEETS',empty=sheet.grid.length<=1&&header.every(h=>!h);
  // Retain existing external row keys across the branding upgrade; never create a second identity column.
  const legacyKey=at.get(nameKey('ERP Row ID'));
  if(legacyKey!==undefined&&at.has(nameKey(KEY_HEADER)))issues.push('The sheet has two row ID columns. Keep one before syncing.');
  const keyCol=legacyKey??locate(KEY_HEADER,{create:true});
  const cols=[];
  for(const m of share.columns){
   // The group owns the header text when it writes to the sheet: a renamed group column renames the sheet header.
   let i=locate(m.header||m.col.name,{create:empty||!m.seen});
   if(i<0&&writesToSheet&&m.col.name!==m.header)i=locate(m.col.name,{create:false});
   if(i<0){issues.push(`The column “${m.header||m.col.name}” is missing in the sheet (renamed or deleted there). Rename it back in the sheet, or change the column mapping.`);continue;}
   if(writesToSheet&&m.header&&m.col.name!==m.header&&header[i]===m.header)headerWrites.push([i,m.col.name]);
   cols.push({...m,index:i,editable:m.col.type!=='FORMULA'&&m.from_sheet!==false&&direction!=='TO_SHEETS'&&caps.editRows});
  }
  if(issues.length)return {issues,warnings};
  const links=new Map(all('SELECT * FROM tm_board_sync_rows WHERE sync_id=?',sync.id).map(r=>[r.row_id,{...r,base:parse(r.base_json,{})}]));
  const erp=new Map(share.rows.map(r=>[r.id,r])),allRows=new Map(groups.internals.rowsOf(b.id).map(r=>[r.id,r]));
  const cellWrites=[],deleteSheetRows=[],erpUpdates=[],erpCreates=[],erpDeletes=[],conflicts=[],bases=new Map(),linkStates=new Map(),appends=[];
  let unknownIds=0,noIdRows=0;
  const seen=new Set();
  const formulaAt=(r,i)=>{const f=sheet.formulas[r]?.[i];return typeof f==='string'&&f.startsWith('=');};
  // Sheet rows (row 2 onward).
  for(let r=1;r<sheet.grid.length;r++){
   const line=sheet.grid[r]||[],rid=String(line[keyCol]??'').trim();
   const texts=Object.fromEntries(cols.map(m=>[m.column_id,sheetText(m.col,line[m.index])]));
   if(!rid){
    if(cols.every(m=>texts[m.column_id]===''))continue;
    // A row added in the sheet (or one whose ID was not written back last time: matched by its values).
    const waiting=[...links.values()].find(l=>l.state==='AWAITING_ID'&&!seen.has(l.row_id)&&cols.every(m=>(l.base[m.column_id]??'')===texts[m.column_id]));
    if(waiting){seen.add(waiting.row_id);cellWrites.push([r,keyCol,waiting.row_id]);linkStates.set(waiting.row_id,'LINKED');continue;}
    if(direction==='TO_SHEETS'){noIdRows++;continue;}
    if(!caps.addRows){notAdded++;continue;}
    const values={},problems=[];
    for(const m of cols){if(!m.editable)continue;const v=fromSheet(m.col,texts[m.column_id],person);if(v.error)problems.push(`${m.col.name}: ${v.error}`);else if(!emptyValue(v.value))values[m.column_id]=v.value;}
    if(problems.length){warnings.push(`Sheet row ${r+1} was not added to the group: ${problems.join('; ')}.`);continue;}
    erpCreates.push({sheetRow:r,values,base:Object.fromEntries(cols.map(m=>[m.column_id,texts[m.column_id]]))});
    continue;
   }
   seen.add(rid);
   const link=links.get(rid),row=erp.get(rid);
   if(!row){
    if(link?.state==='ERP_DELETED'||(link&&!allRows.has(rid))){if(sync.delete_mode==='PROPAGATE')deleteSheetRows.push(r);else linkStates.set(rid,'ERP_DELETED');continue;}
    if(allRows.has(rid)&&!sync.include_restricted){deleteSheetRows.push(r);linkStates.set(rid,'REMOVED');warnings.push('A row that now has an access rule was removed from the sheet (rows with access rules are not shared).');continue;}
    unknownIds++;continue;
   }
   if(link?.state==='SHEET_DELETED')linkStates.set(rid,'LINKED');
   const base=link?link.base:{},next={...base},computed=computeRow(row.values,share.all,prepared),changes={};
   for(const m of cols){
    const e=erpCell(m.col,row,computed),s=texts[m.column_id],b0=Object.hasOwn(base,m.column_id)?base[m.column_id]:undefined;
    if(e.text===s){next[m.column_id]=e.text;continue;}
    const toSheet=()=>{if(formulaAt(r,m.index)){conflicts.push({row:rid,column:m.column_id,base:b0??null,erp:e.text,sheet:s,reason:'The sheet has a formula in this cell, so it was not overwritten.'});return;}cellWrites.push([r,m.index,e.raw]);next[m.column_id]=e.text;};
    const toErp=()=>{const v=fromSheet(m.col,s,person);if(v.error){conflicts.push({row:rid,column:m.column_id,base:b0??null,erp:e.text,sheet:s,reason:`The sheet’s value can’t be used: ${v.error}.`});return;}changes[m.column_id]=v.value;next[m.column_id]=s;};
    if(!m.editable||direction==='TO_SHEETS')toSheet();
    else if(direction==='FROM_SHEETS')toErp();
    else if(b0===undefined)conflicts.push({row:rid,column:m.column_id,base:null,erp:e.text,sheet:s,reason:'This row was linked without an earlier synced value, and the two sides differ.'});
    else if(e.text===b0)toErp();
    else if(s===b0)toSheet();
    else conflicts.push({row:rid,column:m.column_id,base:b0,erp:e.text,sheet:s,reason:'Changed in both the group and the sheet since the last sync.'});
   }
   if(Object.keys(changes).length){
    erpUpdates.push({row,changes});
    // Formula results that depend on values coming from the sheet are written back in the same run.
    const merged={...row.values};for(const [k,v] of Object.entries(changes)){if(emptyValue(v))delete merged[k];else merged[k]=v;}
    const again=computeRow(merged,share.all,prepared);
    for(const m of cols)if(m.col.type==='FORMULA'){const e=erpCell(m.col,{values:merged},again);if(e.text!==texts[m.column_id]&&!formulaAt(r,m.index)){cellWrites.push([r,m.index,e.raw]);next[m.column_id]=e.text;}}
   }
   bases.set(rid,next);if(!link||link.state!=='LINKED')linkStates.set(rid,'LINKED');
  }
  // Group rows not (or no longer) in the sheet.
  for(const row of share.rows){
   if(seen.has(row.id))continue;
   const link=links.get(row.id);
   if(link&&link.state==='AWAITING_ID')continue;
   if(link&&['LINKED','SHEET_DELETED'].includes(link.state)&&direction!=='TO_SHEETS'){
    if(sync.delete_mode==='PROPAGATE'&&link.state==='LINKED'){if(caps.deleteRows){erpDeletes.push(row.id);continue;}notDeleted++;}
    if(link.state==='LINKED')linkStates.set(row.id,'SHEET_DELETED');
    continue;
   }
   if(!writesToSheet)continue;
   const computed=computeRow(row.values,share.all,prepared),cells=new Map(cols.map(m=>[m.index,erpCell(m.col,row,computed)]));
   appends.push({rowId:row.id,cells});bases.set(row.id,Object.fromEntries(cols.map(m=>[m.column_id,cells.get(m.index).text])));linkStates.set(row.id,'LINKED');
  }
  if(notAdded)warnings.push(`${notAdded} row${notAdded===1?'':'s'} added in the sheet ${notAdded===1?'was':'were'} not added to the group: ${who}’s role can’t add records to groups.`);
  if(notDeleted)warnings.push(`${notDeleted} row${notDeleted===1?'':'s'} deleted in the sheet ${notDeleted===1?'was':'were'} kept in the group: ${who}’s role can’t delete records in groups.`);
  if(noIdRows)warnings.push(`${noIdRows} sheet row${noIdRows===1?' has':'s have'} no Task Controlling Management Row ID and ${noIdRows===1?'was':'were'} left as ${noIdRows===1?'it is':'they are'} (this sync only writes to the sheet).`);
  if(unknownIds)warnings.push(`${unknownIds} sheet row${unknownIds===1?' has a Task Controlling Management Row ID that is':'s have Task Controlling Management Row IDs that are'} not in this group (copied rows?). ${unknownIds===1?'It was':'They were'} left as ${unknownIds===1?'it is':'they are'}.`);
  return {issues,warnings,keyCol,width,headerWrites,cols,cellWrites,appends,deleteSheetRows,erpUpdates,erpCreates,erpDeletes,conflicts,bases,linkStates,
   summary:{to_sheet:cellWrites.length+appends.length,new_in_sheet:appends.length,from_sheet:erpUpdates.reduce((n,u)=>n+Object.keys(u.changes).length,0),new_in_group:erpCreates.length,deleted_in_sheet:deleteSheetRows.length,deleted_in_group:erpDeletes.length,conflicts:conflicts.length,excluded_rows:share.excludedRows,excluded_columns:share.excludedColumns,rows:share.rows.length,columns:cols.map(m=>m.col.name)}};
 }
 // Appended rows are written below the last row in use; every cell write is one A1 range (batched).
 function sheetData(title,p,height,ids){
  const data=[];
  for(const [i,name] of p.headerWrites)data.push({range:G.sheetRange(title,`${colName(i)}1`),values:[[name]]});
  if(!p.headerWrites.some(([i])=>i===p.keyCol)&&height===0)data.push({range:G.sheetRange(title,`${colName(p.keyCol)}1`),values:[[KEY_HEADER]]});
  for(const [r,i,v] of p.cellWrites)data.push({range:G.sheetRange(title,`${colName(i)}${r+1}`),values:[[v]]});
  let next=Math.max(height,1);
  for(const a of p.appends){
   const width=Math.max(p.width,p.keyCol+1),line=Array.from({length:width},()=>null);
   line[p.keyCol]=a.rowId;for(const [i,cell] of a.cells)line[i]=cell.raw;
   data.push({range:G.sheetRange(title,`A${next+1}`),values:[line.map(v=>v===null?'':v)]});next++;
  }
  for(const x of ids)data.push({range:G.sheetRange(title,`${colName(p.keyCol)}${x.sheetRow+1}`),values:[[x.id]]});
  return data;
 }
 async function runSync(syncId,trigger='schedule',opts={}){
  const r=await runOnce(syncId,trigger,opts);
  // An access token Google no longer accepts is replaced once (a revoked sign-in then shows as such).
  if(r?.unauthorized){
   const sync=get('SELECT staff_id FROM tm_board_syncs WHERE id=?',syncId);
   try{await token(sync.staff_id,{fresh:true});}catch(e){const s2=get('SELECT * FROM tm_board_syncs WHERE id=?',syncId);return stop(s2,e.message);}
   return runOnce(syncId,trigger,{...opts,retried:true});
  }
  return r;
 }
 async function runOnce(syncId,trigger='schedule',{preview=false,retried=false}={}){
  if(running.has(syncId))return {skipped:'running'};
  running.add(syncId);const started=Date.now();
  try{
   let sync=get('SELECT * FROM tm_board_syncs WHERE id=?',syncId);if(!sync)return {skipped:'missing'};
   if(sync.status==='PAUSED'&&!preview)return {skipped:'paused'};
   const b=get('SELECT * FROM tm_boards WHERE id=?',sync.board_id);
   // The connection is checked again at every run: the person who set it up must still manage the group.
   if(!b||b.status!=='ACTIVE')return stop(sync,'The group is archived or deleted, so the sync stopped.');
   if(!manager(b.id,sync.staff_id))return stop(sync,`${nameOf(sync.staff_id)} can no longer manage this group (or their login is disabled), so the sync stopped. Someone who manages the group can connect it again.`);
   let tk,file=null;
   try{
    tk=await token(sync.staff_id);
    if(trigger==='schedule'&&!preview){
     // drive.file can only see spreadsheets this app created: for others the version can't be checked, so values are read.
     file=await G.fileVersion(tk,sync.spreadsheet_id,sync.staff_id).catch(e=>{if(e.code==='scope'||e.status===403||e.status===404)return null;throw e;});
     if(file?.trashed)throw new G.GoogleError('The spreadsheet is in the Google Drive trash. Restore it, or connect another spreadsheet.',{status:404,code:'trashed'});
     const boardChange=get('SELECT updated_at FROM tm_boards WHERE id=?',b.id).updated_at;
     if(file&&String(file.version)===sync.last_file_version&&boardChange===sync.last_board_change&&!get("SELECT 1 AS ok FROM tm_board_sync_conflicts WHERE sync_id=? AND status='RESOLVED' AND applied=0",sync.id)){
      run('UPDATE tm_board_syncs SET next_run_at=?,last_run_at=? WHERE id=?',new Date(Date.now()+sync.interval_s*1000).toISOString(),now(),sync.id);
      return {skipped:'unchanged'};
     }
    }
    const sheet=await read(sync),p=plan(sync,b,sheet);
    if(preview)return {preview:true,issues:p.issues,warnings:p.warnings,summary:p.summary,title:sheet.title,spreadsheet:sheet.name,conflicts:(p.conflicts||[]).slice(0,50)};
    if(p.issues.length)return stop(sync,p.issues.join(' '),{title:sheet.title});
    // 1. Group changes (rows changed or added from the sheet, rows deleted with deletion turned on), in one transaction.
    const created=[];
    if(p.erpUpdates.length||p.erpCreates.length||p.erpDeletes.length)tx(()=>{
     const cols=groups.internals.columnsOf(b.id),at=now();let position=get('SELECT MAX(position) AS p FROM tm_board_rows WHERE board_id=?',b.id).p||0;
     // The same size limits as in the Task Controlling Management: characters in one row, and in all the group's rows together.
     let stored=get('SELECT COALESCE(SUM(LENGTH(values_json)),0) AS n FROM tm_board_rows WHERE board_id=?',b.id).n;
     const tooLarge=(json,before=0)=>json.length>GROUP_LIMITS.rowChars?`the row would hold ${json.length.toLocaleString('en-US')} characters (a row holds up to ${GROUP_LIMITS.rowChars.toLocaleString('en-US')})`:stored-before+json.length>GROUP_LIMITS.groupChars?`the group would be over its size limit of ${GROUP_LIMITS.groupChars.toLocaleString('en-US')} characters`:null;
     for(const u of p.erpUpdates){
      const r0=get('SELECT * FROM tm_board_rows WHERE id=? AND board_id=?',u.row.id,b.id);if(!r0||r0.version!==u.row.version)continue;// changed meanwhile: next run
      const current=parse(r0.values_json,{});let changes;
      try{changes=groups.internals.cleanValues(b,cols,u.changes,current);}catch(e){if(!e.status)throw e;p.bases.delete(u.row.id);p.conflicts.push(...Object.keys(u.changes).map(k=>({row:u.row.id,column:k,base:null,erp:'',sheet:'',reason:e.message})));continue;}
      const next={...current};for(const [k,v] of Object.entries(changes)){if(emptyValue(v))delete next[k];else next[k]=v;}
      const json=JSON.stringify(next),why=json.length>r0.values_json.length?tooLarge(json,r0.values_json.length):null;
      if(why){p.bases.delete(u.row.id);p.conflicts.push(...Object.keys(u.changes).map(k=>({row:u.row.id,column:k,base:null,erp:'',sheet:'',reason:`The sheet’s change was not saved: ${why}.`})));continue;}
      stored+=json.length-r0.values_json.length;
      update('tm_board_rows',r0.id,{values_json:json,version:r0.version+1,updated_by:sync.staff_id,updated_at:at});
     }
     for(const x of p.erpCreates){
      if(get('SELECT COUNT(*) AS n FROM tm_board_rows WHERE board_id=?',b.id).n>=GROUP_LIMITS.rows){p.warnings.push('The group is full, so new sheet rows were not added.');break;}
      let values;try{values=groups.internals.cleanValues(b,cols,x.values);}catch(e){if(!e.status)throw e;p.warnings.push(`A new sheet row was not added: ${e.message}`);continue;}
      const json=JSON.stringify(Object.fromEntries(Object.entries(values).filter(([,v])=>!emptyValue(v)))),why=tooLarge(json);
      if(why){p.warnings.push(`Sheet row ${x.sheetRow+1} was not added to the group: ${why}.`);continue;}
      stored+=json.length;
      const key=id('tm-board-row','ROW');
      insert('tm_board_rows',{id:key,board_id:b.id,position:++position,values_json:json,version:0,created_by:sync.staff_id,created_at:at,updated_by:sync.staff_id,updated_at:at});
      run('INSERT OR REPLACE INTO tm_board_sync_rows(sync_id,row_id,state,base_json,updated_at) VALUES(?,?,?,?,?)',sync.id,key,'AWAITING_ID',JSON.stringify(x.base),at);
      created.push({id:key,sheetRow:x.sheetRow});
     }
     for(const rid of p.erpDeletes){run('DELETE FROM tm_board_rows WHERE id=? AND board_id=?',rid,b.id);run('DELETE FROM tm_board_sync_rows WHERE sync_id=? AND row_id=?',sync.id,rid);}
     update('tm_boards',b.id,{updated_at:at});
     log(sync.staff_id,b.id,'Google Sheets sync',`from the sheet: ${p.erpUpdates.length} row${p.erpUpdates.length===1?'':'s'} changed · ${created.length} added${p.erpDeletes.length?` · ${p.erpDeletes.length} deleted`:''} (on behalf of ${nameOf(sync.staff_id)})`);
    });
    // 2. Sheet changes: values (headers, cells, new rows, IDs of rows added in the sheet), then deletions bottom-up.
    const data=sheetData(sheet.title,p,sheet.grid.length,created);
    for(let i=0;i<data.length;i+=500)await G.writeValues(sheet.tk,sync.spreadsheet_id,data.slice(i,i+500),sync.staff_id);
    if(p.deleteSheetRows.length)await G.deleteRows(sheet.tk,sync.spreadsheet_id,sync.sheet_id,p.deleteSheetRows,sync.staff_id);
    const after=data.length||p.deleteSheetRows.length?await G.fileVersion(sheet.tk,sync.spreadsheet_id,sync.staff_id).catch(()=>null):file;
    // 3. What is now in sync on both sides, the conflicts found, and the run's record.
    const ms=Date.now()-started;
    tx(()=>{
     const at=now();
     for(const [rid,base] of p.bases)run('INSERT INTO tm_board_sync_rows(sync_id,row_id,state,base_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(sync_id,row_id) DO UPDATE SET base_json=excluded.base_json,state=excluded.state,updated_at=excluded.updated_at',sync.id,rid,p.linkStates.get(rid)==='SHEET_DELETED'?'SHEET_DELETED':'LINKED',JSON.stringify(base),at);
     for(const [rid,state] of p.linkStates){if(state==='REMOVED')run('DELETE FROM tm_board_sync_rows WHERE sync_id=? AND row_id=?',sync.id,rid);else if(!p.bases.has(rid))run('UPDATE tm_board_sync_rows SET state=?,updated_at=? WHERE sync_id=? AND row_id=?',state,at,sync.id,rid);}
     for(const x of created)run("UPDATE tm_board_sync_rows SET state='LINKED',updated_at=? WHERE sync_id=? AND row_id=?",at,sync.id,x.id);
     if(sync.delete_mode==='PROPAGATE')run("DELETE FROM tm_board_sync_rows WHERE sync_id=? AND state='ERP_DELETED'",sync.id);
     for(const k of p.conflicts){
      if(get("SELECT 1 AS ok FROM tm_board_sync_conflicts WHERE sync_id=? AND row_id=? AND column_id=? AND status='OPEN' AND COALESCE(erp_text,'')=? AND COALESCE(sheet_text,'')=?",sync.id,k.row,k.column,k.erp??'',k.sheet??''))continue;
      run("UPDATE tm_board_sync_conflicts SET status='RESOLVED',resolution='SUPERSEDED',resolved_at=?,applied=1 WHERE sync_id=? AND row_id=? AND column_id=? AND status='OPEN'",at,sync.id,k.row,k.column);
      insert('tm_board_sync_conflicts',{sync_id:sync.id,row_id:k.row,column_id:k.column,base_text:k.base,erp_text:k.erp,sheet_text:k.sheet,reason:k.reason,status:'OPEN',resolution:null,applied:0,created_at:at,resolved_by:null,resolved_at:null});
     }
     run("UPDATE tm_board_sync_conflicts SET applied=1 WHERE sync_id=? AND status='RESOLVED' AND applied=0",sync.id);
     // A conflict whose cell now matches on both sides is settled.
     for(const k of all("SELECT * FROM tm_board_sync_conflicts WHERE sync_id=? AND status='OPEN'",sync.id))if(!p.conflicts.some(x=>x.row===k.row_id&&x.column===k.column_id))run("UPDATE tm_board_sync_conflicts SET status='RESOLVED',resolution='SETTLED',resolved_at=?,applied=1 WHERE id=?",at,k.id);
     const s=p.summary,detail=[s.to_sheet&&`${s.to_sheet} cell${s.to_sheet===1?'':'s'} or rows to the sheet`,s.from_sheet&&`${s.from_sheet} from the sheet`,created.length&&`${created.length} new from the sheet`,s.deleted_in_sheet&&`${s.deleted_in_sheet} removed from the sheet`,s.deleted_in_group&&`${s.deleted_in_group} deleted in the group`,p.conflicts.length&&`${p.conflicts.length} conflict${p.conflicts.length===1?'':'s'}`,...p.warnings].filter(Boolean).join(' · ')||'No changes';
     insert('tm_board_sync_runs',{sync_id:sync.id,started_at:new Date(started).toISOString(),finished_at:at,trigger,outcome:'OK',to_sheet:s.to_sheet,from_sheet:s.from_sheet+created.length,created:created.length,conflicts:p.conflicts.length,detail:detail.slice(0,2000),duration_ms:ms});
     run('DELETE FROM tm_board_sync_runs WHERE sync_id=? AND id NOT IN (SELECT id FROM tm_board_sync_runs WHERE sync_id=? ORDER BY id DESC LIMIT 50)',sync.id,sync.id);
     update('tm_board_syncs',sync.id,{sheet_title:sheet.title,spreadsheet_name:sheet.name,status:'ACTIVE',status_detail:p.warnings.join(' ').slice(0,1000),failures:0,last_run_at:at,last_success_at:at,last_duration_ms:ms,
      last_file_version:after?String(after.version):null,last_board_change:get('SELECT updated_at FROM tm_boards WHERE id=?',b.id).updated_at,next_run_at:new Date(Date.now()+sync.interval_s*1000).toISOString(),
      mapping_json:JSON.stringify(parse(sync.mapping_json,[]).map(m=>{const x=p.cols.find(y=>y.column_id===m.column_id);return x?{...m,header:x.col.name,seen:true}:m;}))});
    });
    changed?.();
    return {ok:true,summary:p.summary,warnings:p.warnings,conflicts:p.conflicts.length,ms};
   }catch(e){
    if(!(e instanceof G.GoogleError)){if(e.status)return stop(sync,e.message);throw e;}
    if(e.code==='unauthorized'&&!retried){running.delete(syncId);return {unauthorized:true};}
    if(e.retry){
     const failures=(sync.failures||0)+1,wait=G.backoff(Math.min(failures,6))+sync.interval_s*1000*(failures>3?1:0);
     tx(()=>{update('tm_board_syncs',sync.id,{failures,next_run_at:new Date(Date.now()+wait).toISOString(),last_run_at:now(),status_detail:`${e.message} (attempt ${failures})`});insert('tm_board_sync_runs',{sync_id:sync.id,started_at:new Date(started).toISOString(),finished_at:now(),trigger,outcome:'RETRY',to_sheet:0,from_sheet:0,created:0,conflicts:0,detail:e.message,duration_ms:Date.now()-started});});
     changed?.();return {retry:true,error:e.message};
    }
    return stop(sync,e.message);
   }
  }finally{running.delete(syncId);}
 }
 // Stops a connection safely: nothing more is written until someone fixes the cause and resumes it.
 function stop(sync,why){
  tx(()=>{update('tm_board_syncs',sync.id,{status:'ERROR',status_detail:String(why).slice(0,1000),last_run_at:now(),next_run_at:null});insert('tm_board_sync_runs',{sync_id:sync.id,started_at:now(),finished_at:now(),trigger:'check',outcome:'STOPPED',to_sheet:0,from_sheet:0,created:0,conflicts:0,detail:String(why).slice(0,2000),duration_ms:0});log(sync.staff_id,sync.board_id,'Google Sheets sync stopped',String(why).slice(0,300));});
  changed?.();
  return {stopped:true,error:why};
 }

 // ---------------------------------------------------------------- setting up, changing and removing a connection
 function mappingInput(input,cols,direction){
  if(!Array.isArray(input)||!input.length)fail('Choose at least one column to sync.');
  const byId=new Map(cols.map(x=>[x.id,x])),seen=new Set(),out=[];
  for(const m of input){
   const col=byId.get(m?.column_id);if(!col)fail('A chosen column no longer exists. Reload the group.',409);
   if(!SYNCABLE.includes(col.type))fail(`${col.name} can’t be synced.`);
   if(seen.has(col.id))continue;seen.add(col.id);
   if([KEY_HEADER,'ERP Row ID'].some(h=>nameKey(col.name)===nameKey(h)))fail(`Rename the column “${col.name}”: that header is used for the row IDs.`,409);
   out.push({column_id:col.id,header:col.name,from_sheet:direction!=='TO_SHEETS'&&col.type!=='FORMULA'&&FROM_SHEET_TYPES.includes(col.type)&&m.from_sheet!==false,seen:false});
  }
  return out;
 }
 async function setup(user,d){
  const staff=user.staff_id,{b,caps}=mustManage(String(d.group_id||''),staff);
  const direction=['TO_SHEETS','FROM_SHEETS','TWO_WAY'].includes(d.direction)?d.direction:fail('Choose the direction of the sync.');
  const cols=groups.internals.columnsOf(b.id),mapping=mappingInput(d.columns,cols,direction);
  const deleteMode=d.delete_mode==='PROPAGATE'?'PROPAGATE':'KEEP';
  if(deleteMode==='PROPAGATE'&&direction!=='TO_SHEETS'&&!caps.deleteRows)fail(NO_DELETE,403);
  if(deleteMode==='PROPAGATE'&&d.confirm_delete!==true)fail('Confirm that deleting a row on one side deletes it on the other side too.',409);
  if(d.include_restricted===true&&d.confirm_restricted!==true)fail('Confirm that rows and columns with access rules are shared with everyone who can open the spreadsheet.',409);
  const tk=await token(staff),cf=config();
  let spreadsheetId,sheetId,name,title;
  if(d.mode==='existing'){
   if(!cf.allow_existing)fail('Connecting existing spreadsheets is turned off. An administrator can allow it in Administration → Google Sheets.',403);
   if(!account(staff)?.scopes.includes(G.SCOPES.existing))fail('Allow access to existing spreadsheets first: connect Google again and choose “Use an existing spreadsheet”.',409);
   const ref=G.parseSheetUrl(d.url);if(!ref)fail('Paste the address of the Google spreadsheet (it contains /spreadsheets/d/…).');
   const meta=await G.getSpreadsheet(tk,ref.spreadsheetId,staff),sheets=(meta.sheets||[]).map(x=>x.properties);
   const chosen=d.sheet_id!==undefined&&d.sheet_id!==null&&d.sheet_id!==''?sheets.find(x=>x.sheetId===Number(d.sheet_id)):ref.sheetId!==null?sheets.find(x=>x.sheetId===ref.sheetId):sheets[0];
   if(!chosen)fail('That worksheet is not in the spreadsheet. Choose one from the list.',404);
   spreadsheetId=ref.spreadsheetId;sheetId=chosen.sheetId;name=meta.properties?.title||'';title=chosen.title;
  }else{
   const created=await G.createSpreadsheet(tk,str(d.title??b.name,'Spreadsheet name',200,true),'Group',staff);
   spreadsheetId=created.spreadsheetId;sheetId=created.sheets?.[0]?.properties?.sheetId??0;name=created.properties?.title||b.name;title=created.sheets?.[0]?.properties?.title||'Group';
  }
  const existing=get('SELECT * FROM tm_board_syncs WHERE board_id=?',b.id);
  const key=existing?.id||id('tm-board-sync','SYNC'),at=now();
  tx(()=>{
   if(existing){run('DELETE FROM tm_board_sync_rows WHERE sync_id=?',key);run('DELETE FROM tm_board_sync_conflicts WHERE sync_id=?',key);}
   const values={board_id:b.id,staff_id:staff,spreadsheet_id:spreadsheetId,spreadsheet_name:name,sheet_id:sheetId,sheet_title:title,direction,mapping_json:JSON.stringify(mapping),include_restricted:d.include_restricted===true?1:0,delete_mode:deleteMode,
    status:'PAUSED',status_detail:'Check the preview, then start the sync.',interval_s:Math.max(cf.interval_s||60,Number(d.interval_s)||0)||60,next_run_at:null,last_run_at:null,last_success_at:null,last_duration_ms:null,last_file_version:null,last_board_change:null,failures:0,version:(existing?.version||0)+1,updated_at:at};
   if(existing)update('tm_board_syncs',key,values);else insert('tm_board_syncs',{id:key,...values,created_at:at});
   log(staff,b.id,'Google Sheets connected',`${name} · ${title} · ${DIRECTIONS[direction]}${deleteMode==='PROPAGATE'?' · deletions sync':''}${d.include_restricted===true?' · includes restricted rows and columns':''}`);
  });
  changed?.();
  return {id:key,message:'Connected. Check the preview, then start the sync.',preview:await runSync(key,'preview',{preview:true})};
 }
 function setStatus(user,d){
  const sync=get('SELECT * FROM tm_board_syncs WHERE id=?',String(d.id||''));if(!sync)fail('This Google Sheets connection was not found.',404);
  mustManage(sync.board_id,user.staff_id);
  const action=d.action;
  if(action==='pause'){tx(()=>{update('tm_board_syncs',sync.id,{status:'PAUSED',status_detail:`Paused by ${nameOf(user.staff_id)}.`,next_run_at:null});log(user.staff_id,sync.board_id,'Google Sheets sync paused','');});changed?.();return {message:'Sync paused. Nothing is copied until it is resumed.'};}
  if(action==='resume'){
   // Resuming makes the person who resumes it the one the sync acts for (they must have Google connected).
   if(!account(user.staff_id)||account(user.staff_id).status!=='ACTIVE')fail('Connect your Google account first: the sync will act on your behalf.',409);
   tx(()=>{update('tm_board_syncs',sync.id,{status:'ACTIVE',status_detail:'',staff_id:user.staff_id,failures:0,next_run_at:now()});log(user.staff_id,sync.board_id,'Google Sheets sync started',`on behalf of ${nameOf(user.staff_id)}`);});
   changed?.();return {message:'Sync started.'};
  }
  if(action==='disconnect'){
   tx(()=>{run('DELETE FROM tm_board_syncs WHERE id=?',sync.id);log(user.staff_id,sync.board_id,'Google Sheets disconnected',`${sync.spreadsheet_name} · the spreadsheet and the group keep their data`);});
   if(sync.channel_id)void token(sync.staff_id).then(tk=>G.stopChannel(tk,sync.channel_id,sync.channel_resource,sync.staff_id)).catch(()=>{});
   changed?.();return {message:'Disconnected. The spreadsheet and the group keep their data.'};
  }
  if(action==='settings'){
   const cols=groups.internals.columnsOf(sync.board_id),direction=['TO_SHEETS','FROM_SHEETS','TWO_WAY'].includes(d.direction)?d.direction:sync.direction;
   const mapping=d.columns?mappingInput(d.columns,cols,direction).map(m=>({...m,seen:parse(sync.mapping_json,[]).some(x=>x.column_id===m.column_id&&x.seen)})):parse(sync.mapping_json,[]);
   const deleteMode=d.delete_mode===undefined?sync.delete_mode:d.delete_mode==='PROPAGATE'?'PROPAGATE':'KEEP';
   if(deleteMode==='PROPAGATE'&&direction!=='TO_SHEETS'&&!groups.internals.capsFor(get('SELECT * FROM tm_boards WHERE id=?',sync.board_id),user.staff_id).deleteRows)fail(NO_DELETE,403);
   if(deleteMode==='PROPAGATE'&&sync.delete_mode!=='PROPAGATE'&&d.confirm_delete!==true)fail('Confirm that deleting a row on one side deletes it on the other side too.',409);
   const include=d.include_restricted===undefined?!!sync.include_restricted:d.include_restricted===true;
   if(include&&!sync.include_restricted&&d.confirm_restricted!==true)fail('Confirm that rows and columns with access rules are shared with everyone who can open the spreadsheet.',409);
   const interval=d.interval_s===undefined?sync.interval_s:Number(d.interval_s);if(!Number.isInteger(interval)||interval<Math.max(15,config().interval_s||15)||interval>3600)fail(`Check for changes every ${Math.max(15,config().interval_s||15)} to 3,600 seconds.`);
   tx(()=>{update('tm_board_syncs',sync.id,{direction,mapping_json:JSON.stringify(mapping),delete_mode:deleteMode,include_restricted:include?1:0,interval_s:interval,version:sync.version+1,updated_at:now(),next_run_at:sync.status==='ACTIVE'?now():null});log(user.staff_id,sync.board_id,'Google Sheets settings changed',`${DIRECTIONS[direction]} · ${mapping.length} column${mapping.length===1?'':'s'}${deleteMode==='PROPAGATE'?' · deletions sync':''}`);});
   changed?.();return {message:'Sync settings saved.'};
  }
  if(action==='resolve'){
   const k=get("SELECT * FROM tm_board_sync_conflicts WHERE id=? AND sync_id=? AND status='OPEN'",Number(d.conflict_id),sync.id);if(!k)fail('This conflict was already settled.',409);
   const side=d.keep==='SHEET'?'SHEET':d.keep==='GROUP'?'GROUP':fail('Choose which value to keep.');
   // Keeping one side sets the “last synced” value to the other side's value, so the next run copies the kept value.
   tx(()=>{
    const link=get('SELECT * FROM tm_board_sync_rows WHERE sync_id=? AND row_id=?',sync.id,k.row_id),base=parse(link?.base_json,{});
    base[k.column_id]=side==='GROUP'?(k.sheet_text??''):(k.erp_text??'');
    run('INSERT INTO tm_board_sync_rows(sync_id,row_id,state,base_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(sync_id,row_id) DO UPDATE SET base_json=excluded.base_json,updated_at=excluded.updated_at',sync.id,k.row_id,link?.state||'LINKED',JSON.stringify(base),now());
    run("UPDATE tm_board_sync_conflicts SET status='RESOLVED',resolution=?,resolved_by=?,resolved_at=?,applied=0 WHERE id=?",side,user.staff_id,now(),k.id);
    update('tm_board_syncs',sync.id,{next_run_at:now()});
    log(user.staff_id,sync.board_id,'Google Sheets conflict resolved',`kept the ${side==='GROUP'?'group':'sheet'} value`);
   });
   changed?.();return {message:`Kept the ${side==='GROUP'?'group’s':'sheet’s'} value. It is copied on the next sync.`};
  }
  fail('Unknown action.',404);
 }
 /** The connection of one group, for the people who manage it (no tokens, no secrets). */
 function describe(boardId,staff,redirectUri){
  const {b:board}=mustManage(boardId,staff),sync=get('SELECT * FROM tm_board_syncs WHERE board_id=?',boardId),cf=config(),columns=groups.internals.columnsOf(board.id);
  // Columns with access rules (and formulas that use them) are left out of the sheet unless restricted data is included.
  const rules=groups.internals.rulesOf(board.id),open=new Set(groups.internals.visibleColumns(columns,c=>!rules.cols.has(c.id)).map(c=>c.id));
  const base={configured:!!(cf.client_id&&cf.client_secret_enc),allow_existing:!!cf.allow_existing,default_interval:cf.interval_s||60,simulated:G.GOOGLE.simulated(),account:publicAccount(staff),redirect_uri:redirectUri,
   columns:columns.map(x=>({id:x.id,name:x.name,type:x.type,syncable:SYNCABLE.includes(x.type),from_sheet:FROM_SHEET_TYPES.includes(x.type),restricted:!open.has(x.id)})),directions:DIRECTIONS};
  if(!sync)return {...base,sync:null};
  const b=get('SELECT * FROM tm_boards WHERE id=?',boardId),share=shareable(sync,b);
  return {...base,sync:{id:sync.id,status:sync.status,status_detail:sync.status_detail,direction:sync.direction,spreadsheet_id:sync.spreadsheet_id,spreadsheet_name:sync.spreadsheet_name,sheet_title:sync.sheet_title,
   url:`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sync.spreadsheet_id)}/edit#gid=${sync.sheet_id}`,connected_by:nameOf(sync.staff_id),connected_by_me:sync.staff_id===staff,
   mapping:parse(sync.mapping_json,[]),include_restricted:!!sync.include_restricted,delete_mode:sync.delete_mode,interval_s:sync.interval_s,last_success_at:sync.last_success_at,last_run_at:sync.last_run_at,last_duration_ms:sync.last_duration_ms,next_run_at:sync.next_run_at,
   push:!!sync.channel_id&&Date.parse(sync.channel_expires||0)>Date.now(),excluded_rows:share.excludedRows,excluded_columns:share.excludedColumns,shared_rows:share.rows.length,shared_columns:share.columns.length,
   conflicts:all("SELECT k.id,k.row_id,k.column_id,k.base_text,k.erp_text,k.sheet_text,k.reason,k.created_at,c.name AS column FROM tm_board_sync_conflicts k LEFT JOIN tm_board_columns c ON c.id=k.column_id WHERE k.sync_id=? AND k.status='OPEN' ORDER BY k.id",sync.id),
   runs:all('SELECT started_at,finished_at,trigger,outcome,to_sheet,from_sheet,created,conflicts,detail,duration_ms FROM tm_board_sync_runs WHERE sync_id=? ORDER BY id DESC LIMIT 10',sync.id)}};
 }
 // A group's rows were deleted: their links are marked, so the sheet rows are removed (deletions on) or left (off).
 function rowsDeleted(b,ids){
  const sync=get('SELECT id FROM tm_board_syncs WHERE board_id=?',b.id);if(!sync)return;
  for(const rid of ids)run("UPDATE tm_board_sync_rows SET state='ERP_DELETED',updated_at=? WHERE sync_id=? AND row_id=?",now(),sync.id,rid);
 }

 // ---------------------------------------------------------------- the schedule and Google Drive change notifications
 async function tick({publicUrl='',notifyPath=''}={}){
  const cf=config();
  for(const sync of all("SELECT * FROM tm_board_syncs WHERE status='ACTIVE' AND (next_run_at IS NULL OR next_run_at<=?) ORDER BY next_run_at LIMIT 5",now())){
   try{await runSync(sync.id,'schedule');}catch(e){console.error?.(`Google Sheets sync ${sync.id}: ${e.message}`);}
  }
  // Notifications need a public https address (ERP_PUBLIC_URL). Channels last up to a day and are renewed an hour early.
  if(cf.push&&/^https:\/\//.test(publicUrl)){
   for(const sync of all("SELECT * FROM tm_board_syncs WHERE status='ACTIVE' AND (channel_expires IS NULL OR channel_expires<?) LIMIT 3",new Date(Date.now()+3600000).toISOString())){
    try{
     const tk=await token(sync.staff_id),channelId=randomUUID(),secret=randomBytes(24).toString('base64url'),expiration=Date.now()+86400000;
     const ch=await G.watchFile(tk,sync.spreadsheet_id,{channelId,address:publicUrl+notifyPath,secret,expiration},sync.staff_id);
     if(sync.channel_id)await G.stopChannel(tk,sync.channel_id,sync.channel_resource,sync.staff_id);
     update('tm_board_syncs',sync.id,{channel_id:channelId,channel_resource:ch.resourceId||'',channel_token_hash:hashToken(secret),channel_expires:new Date(Number(ch.expiration)||expiration).toISOString(),last_message_number:null});
    }catch(e){update('tm_board_syncs',sync.id,{channel_expires:new Date(Date.now()+3600000).toISOString()});}
   }
  }
 }
 /** A Drive change notification (POST from Google, no body). Unknown channels and wrong tokens are ignored; repeated or
  *  late messages (by message number) are ignored; a real change brings the next sync forward. */
 function notify(headers){
  const channel=String(headers['x-goog-channel-id']||''),tokenValue=String(headers['x-goog-channel-token']||''),state=String(headers['x-goog-resource-state']||''),n=Number(headers['x-goog-message-number']||0);
  const sync=channel?get('SELECT * FROM tm_board_syncs WHERE channel_id=?',channel):null;
  if(!sync||!sync.channel_token_hash||hashToken(tokenValue)!==sync.channel_token_hash)return {ignored:'unknown channel'};
  if(sync.last_message_number&&n&&n<=sync.last_message_number)return {ignored:'duplicate'};
  update('tm_board_syncs',sync.id,{last_message_number:n||sync.last_message_number});
  if(state==='sync')return {ignored:'channel started'};
  if(sync.status==='ACTIVE')update('tm_board_syncs',sync.id,{next_run_at:new Date(Date.now()+2000).toISOString()});
  return {queued:true};
 }

 // ---------------------------------------------------------------- requests from the screens (async: they may call Google)
 async function request(user,d,{redirectUri}){
  if(!d||typeof d!=='object')fail('Invalid request.');
  switch(d.action){
   case 'describe':return describe(String(d.group_id||''),user.staff_id,redirectUri);
   case 'connect':{mustManage(String(d.group_id||''),user.staff_id);return startAuth(user.staff_id,redirectUri,{existing:d.existing===true});}
   case 'disconnect_account':return disconnectAccount(user.staff_id);
   case 'sheets':{// the worksheets of an existing spreadsheet, to choose one
    mustManage(String(d.group_id||''),user.staff_id);const ref=G.parseSheetUrl(d.url);if(!ref)fail('Paste the address of the Google spreadsheet (it contains /spreadsheets/d/…).');
    const meta=await G.getSpreadsheet(await token(user.staff_id),ref.spreadsheetId,user.staff_id);
    return {name:meta.properties?.title||'',sheets:(meta.sheets||[]).map(x=>({id:x.properties.sheetId,title:x.properties.title})),selected:ref.sheetId};
   }
   case 'setup':return setup(user,d);
   case 'preview':{const sync=get('SELECT * FROM tm_board_syncs WHERE id=?',String(d.id||''));if(!sync)fail('Not found.',404);mustManage(sync.board_id,user.staff_id);return runSync(sync.id,'preview',{preview:true});}
   case 'sync_now':{
    const sync=get('SELECT * FROM tm_board_syncs WHERE id=?',String(d.id||''));if(!sync)fail('Not found.',404);mustManage(sync.board_id,user.staff_id);
    if(sync.status==='PAUSED')fail('The sync is paused. Start it first.',409);
    if(sync.status==='ERROR')update('tm_board_syncs',sync.id,{status:'ACTIVE',failures:0});
    const r=await runSync(sync.id,'manual');
    if(r.stopped)fail(r.error,409);if(r.retry)fail(r.error,503);if(r.skipped==='running')return {message:'A sync is already running.'};
    return {message:r.conflicts?`Synced, with ${r.conflicts} conflict${r.conflicts===1?'':'s'} to resolve.`:'Synced.',...r};
   }
   case 'pause':case 'resume':case 'disconnect':case 'settings':case 'resolve':return setStatus(user,d);
   default:fail('Unknown action.',404);
  }
 }
 return {request,finishAuth,notify,tick,runSync,rowsDeleted,publicConfig,saveConfig,describe};
}

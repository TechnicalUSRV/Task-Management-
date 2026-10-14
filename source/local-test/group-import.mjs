// V5.5 Groups · Import data from Excel. A workbook is uploaded once (and read safely, see xlsx.mjs); the person then
// chooses the worksheets, the header row of each, the rows and columns to import and where each column goes (an existing
// column or a new one). The server checks everything and shows what will happen (rows added, rows updated, rows skipped
// and the exact problems) before anything is saved; importing then saves it all in one transaction. Importing the same
// upload twice (for example after a lost connection) never adds the rows twice.
//
// Values: dates (Excel dates or written dates such as 2026-10-05 or 05/10/2026, day first), numbers (with thousands
// separators), text (leading zeros kept), status labels by name, and people by their staff ID, email or a name that
// matches exactly one person who can be chosen in the group (other names are asked about). Excel formulas are never
// calculated: their saved results are imported, and a formula without a saved result is reported. Group formula
// columns are always calculated by the group, so nothing is imported into them.
import {COLUMN_TYPES,GROUP_LIMITS,nameKey,cleanName,columnNameError,emptyValue,cellText,statusLabels,parseNumber,parseDay,tidy} from './group-domain.mjs';
import {readXlsx,serialToDay,colName,XlsxError,READ_LIMITS} from './xlsx.mjs';

const parse=(json,fallback)=>{try{const v=JSON.parse(json);return v??fallback;}catch{return fallback;}};
const IMPORTABLE=['TEXT','NUMBER','DATE','STATUS','IN_CHARGE','SUPPORT'];
const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const pad=n=>String(n).padStart(2,'0');
const ymd=(y,m,d)=>{const s=`${y}-${pad(m)}-${pad(d)}`;return parseDay(s).ok?s:null;};
/** A written date as YYYY-MM-DD (day first for 05/10/2026, as in Cambodia), or null. */
export function textDate(input){
 const s=String(input??'').trim();if(!s)return null;
 let m=/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);if(m)return ymd(m[1],m[2],m[3]);
 m=/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);if(m)return ymd(m[3],m[2],m[1]);
 m=/^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -,]*(\d{4})$/.exec(s);if(m&&MONTHS[m[2].slice(0,4).toLowerCase()]||m&&MONTHS[m[2].slice(0,3).toLowerCase()])return ymd(m[3],MONTHS[m[2].slice(0,4).toLowerCase()]||MONTHS[m[2].slice(0,3).toLowerCase()],m[1]);
 m=/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);if(m&&MONTHS[m[1].slice(0,3).toLowerCase()])return ymd(m[3],MONTHS[m[1].slice(0,3).toLowerCase()],m[2]);
 return null;
}
/** How a cell reads as text (for headers, previews and text columns). */
export function cellDisplay(cell){
 if(!cell)return '';
 if(cell.error)return cell.error;
 if(cell.missing)return '';
 if(cell.date)return cell.date;
 if(typeof cell.v==='boolean')return cell.v?'TRUE':'FALSE';
 if(typeof cell.v==='number')return String(tidy(cell.v));
 return cell.v===null||cell.v===undefined?'':String(cell.v);
}

export function createGroupImport(c){
 const {get,all,run,insert,update,id,fail,str,now,nameOf,openBoard,sight,columnsOf,rowsOf,eligible,cleanValues,touch,record,need,archivedCheck,failWith,columnSave}=c;
 const load=(key,staff)=>{
  const imp=get('SELECT * FROM tm_board_imports WHERE id=?',String(key||''));
  if(!imp||imp.staff_id!==staff)fail('This upload was not found. Upload the file again.',404);
  return imp;
 };
 const headersOf=(sheet,row)=>{
  const cells=sheet.rows[row-1]||[],width=Math.max(sheet.columns,cells.length),seen=new Map(),out=[];
  for(let i=0;i<width;i++){
   let name=cleanName(cellDisplay(cells[i])).replace(/[{}]/g,'').replace(/^[#=]+/,'').slice(0,GROUP_LIMITS.name).trim()||`Column ${colName(i)}`;
   const k=nameKey(name),n=(seen.get(k)||0)+1;seen.set(k,n);if(n>1)name=`${name.slice(0,GROUP_LIMITS.name-5)} (${n})`;
   out.push(name);
  }
  return out;
 };
 function summary(imp,sheets){
  return {id:imp.id,file_name:imp.file_name,file_size:imp.file_size,status:imp.status,result:parse(imp.result_json,null),
   sheets:sheets.map((s,i)=>({index:i,name:s.name,hidden:s.hidden,truncated:s.truncated,formulas_without_results:s.formulas_without_results,rows:s.rows.length,filled_rows:s.rows.filter(r=>r.some(x=>x&&cellDisplay(x)!=='')).length,columns:s.columns,
    preview:s.rows.slice(0,15).map(r=>Array.from({length:Math.min(s.columns,200)},(_,j)=>cellDisplay(r[j]).slice(0,60)))}))};
 }
 // ---------------------------------------------------------------- upload
 function upload(d,actor){
  const {b,caps}=openBoard(d.group_id,actor);archivedCheck(b);
  need(caps,'import','Importing needs “Can edit records” access to this group and a role that can add records.');
  const name=str(d.name,'File name',200,true).replaceAll('\\','/').split('/').pop();
  if(/\.(xls|xlsb|xlsm|csv|ods|numbers)$/i.test(name))fail(`“${name}” is not an Excel workbook (.xlsx). Open it in Excel (or another spreadsheet program) and save it as “Excel Workbook (*.xlsx)”.`,415);
  if(!/\.xlsx$/i.test(name))fail('Choose an Excel workbook (.xlsx).',415);
  if(typeof d.base64!=='string'||!d.base64||d.base64.length>Math.ceil(GROUP_LIMITS.importBytes*4/3)+8||!/^[A-Za-z0-9+/]*={0,2}$/.test(d.base64))fail(`Choose an .xlsx file of up to ${GROUP_LIMITS.importBytes/1048576} MB.`,413);
  const buf=Buffer.from(d.base64,'base64');if(!buf.length||buf.length>GROUP_LIMITS.importBytes)fail(`Choose an .xlsx file of up to ${GROUP_LIMITS.importBytes/1048576} MB.`,413);
  let sheets;try{sheets=readXlsx(buf);}catch(e){if(e instanceof XlsxError)fail(e.message,422);throw e;}
  // Uploads are kept for two days (an imported one keeps its result, so a repeated import is recognised).
  run("DELETE FROM tm_board_imports WHERE created_at<?",new Date(Date.now()-2*86400000).toISOString());
  const key=id('tm-board-import','IMP');
  insert('tm_board_imports',{id:key,board_id:b.id,staff_id:actor,file_name:name,file_size:buf.length,sheets_json:JSON.stringify(sheets),status:'UPLOADED',result_json:null,created_at:now(),imported_at:null});
  const imp=get('SELECT * FROM tm_board_imports WHERE id=?',key);
  return {id:key,type:'tm_group_import',message:`${name} is ready: ${sheets.length} worksheet${sheets.length===1?'':'s'}.`,import:summary(imp,sheets)};
 }
 function describe(key,staff){const imp=load(key,staff);openBoard(imp.board_id,staff);return summary(imp,parse(imp.sheets_json,[]));}

 // ---------------------------------------------------------------- the plan: what would happen (nothing is saved)
 function people(b){
  const list=eligible(b),byId=new Map(list.map(p=>[p.id,p])),byName=new Map(),byEmail=new Map();
  for(const p of list){const k=nameKey(p.name);if(!byName.has(k))byName.set(k,[]);byName.get(k).push(p);}
  for(const r of all("SELECT p.staff_id AS id,lower(p.email) AS email FROM tm_profiles p WHERE p.email<>'' UNION SELECT u.staff_id,lower(u.email) FROM access_users u"))if(byId.has(r.id)&&r.email&&!byEmail.has(r.email))byEmail.set(r.email,r.id);
  return {byId,byName,byEmail};
 }
 function evaluate(b,actor,caps,imp,input,{columns:real}={}){
  if(!input||typeof input!=='object'||!Array.isArray(input.sheets)||!input.sheets.length)fail('Choose at least one worksheet to import.');
  const sheets=parse(imp.sheets_json,[]);
  // The plan is checked for size and permission before any work on it: each worksheet at most once, no more columns
  // than a worksheet can have, and new columns only for people who manage the group (before their names are compared,
  // so the answer never depends on the names of columns this person can't see).
  const chosen=new Set();
  for(const sh of input.sheets){
   const i=Number(sh?.index);if(chosen.has(i))fail('Choose each worksheet once.');chosen.add(i);
   if(sh?.columns!==undefined&&(!Array.isArray(sh.columns)||sh.columns.length>READ_LIMITS.columns))fail(`Choose up to ${READ_LIMITS.columns} columns for each worksheet.`);
  }
  const wanted=input.sheets.flatMap(sh=>Array.isArray(sh?.columns)?sh.columns.filter(m=>m&&m.new&&!m.skip):[]);
  if(wanted.length&&!caps.structure)fail('Creating columns needs “Can manage” access to this group. Map every column to an existing one, or ask the group’s owner.',403);
  if(new Set(wanted.map(m=>nameKey(cleanName(typeof m.new?.name==='string'?m.new.name:'')))).size>GROUP_LIMITS.columns)fail(`A group can have up to ${GROUP_LIMITS.columns} columns.`,409);
  const s=sight(b,actor,caps,real||columnsOf(b.id)),visible=s.columns;
  const mode=input.mode==='update'?'update':'append',unmatched=input.unmatched==='skip'?'skip':'add',resolved=input.people&&typeof input.people==='object'?input.people:{};
  const crowd=people(b),createLabels=input.create_labels===true;
  // New columns proposed by any sheet, by name (the same name in two sheets is one new column).
  const proposed=new Map();
  for(const sh of input.sheets)for(const m of Array.isArray(sh?.columns)?sh.columns:[])if(m&&m.new&&!m.skip){
   const name=cleanName(m.new.name),type=m.new.type;
   if(!IMPORTABLE.includes(type))fail(`Choose a type for the new column “${name||'(no name)'}”: Text, Number, Date, Status, In Charge or Support.`);
   const err=columnNameError(name,[...s.all,...[...proposed.values()].filter(x=>nameKey(x.name)!==nameKey(name)).map(x=>({id:x.id,name:x.name}))]);
   if(err&&!(proposed.has(nameKey(name))&&proposed.get(nameKey(name)).type===type))fail(`New column “${name}”: ${err}`,409);
   if(proposed.has(nameKey(name))&&proposed.get(nameKey(name)).type!==type)fail(`Two worksheets create a column named “${name}” with different types. Use one type, or different names.`,409);
   if(!proposed.has(nameKey(name)))proposed.set(nameKey(name),{id:`new:${proposed.size}`,name,type,settings:{},labels:new Map()});
  }
  if(proposed.size&&!caps.structure)fail('Creating columns needs “Can manage” access to this group. Map every column to an existing one, or ask the group’s owner.',403);
  if(visible.length+proposed.size>GROUP_LIMITS.columns)fail(`A group can have up to ${GROUP_LIMITS.columns} columns; this import would make ${visible.length+proposed.size}.`,409);
  const target=key=>visible.find(x=>x.id===key);
  const results=[],ops=[],unresolved=new Map(),labelAdds=new Map();
  let rowsTotal=rowsOf(b.id).length;
  // Existing rows by key (update mode), among the rows this person may see.
  const keyIndex=new Map(),keyRows=col=>{
   if(keyIndex.has(col.id))return keyIndex.get(col.id);
   const map=new Map();for(const r of rowsOf(b.id)){if(!s.rowOk(r.id))continue;const k=cellText(col,r.values[col.id],nameOf).trim();if(!k)continue;if(!map.has(k))map.set(k,[]);map.get(k).push(r);}
   keyIndex.set(col.id,map);return map;
  };
  for(const sh of input.sheets){
   const index=Number(sh?.index);const sheet=sheets[index];if(!Number.isInteger(index)||!sheet)fail('A chosen worksheet is not in this file. Upload it again.');
   const headerRow=sh.header_row===undefined?1:Number(sh.header_row);
   if(!Number.isInteger(headerRow)||headerRow<1||headerRow>Math.max(1,sheet.rows.length))fail(`“${sheet.name}”: choose a header row between 1 and ${Math.max(1,sheet.rows.length)}.`);
   const header=headersOf(sheet,headerRow);
   const maps=(Array.isArray(sh.columns)?sh.columns:[]).filter(m=>m&&!m.skip&&(m.target||m.new));
   if(!maps.length)fail(`“${sheet.name}”: choose at least one column to import.`);
   const usedSource=new Set(),usedTarget=new Set(),plan=[];
   for(const m of maps){
    const source=Number(m.source);if(!Number.isInteger(source)||source<0||source>=Math.max(header.length,1))fail(`“${sheet.name}”: a chosen column is not in the worksheet.`);
    if(usedSource.has(source))fail(`“${sheet.name}”: the column “${header[source]}” is chosen twice.`);usedSource.add(source);
    let col;
    if(m.new)col=proposed.get(nameKey(cleanName(m.new.name)));
    else{col=target(String(m.target));if(!col)fail(`“${sheet.name}”: the column chosen for “${header[source]}” no longer exists or is not available to you. Choose again.`,409);if(col.type==='FORMULA')fail(`“${col.name}” is a formula column: the group calculates it, so nothing can be imported into it.`,409);if(col.type==='ATTACHMENT')fail(`“${col.name}” is an attachment column: upload its files in the table instead.`,409);}
    if(usedTarget.has(col.id))fail(`“${sheet.name}”: two columns go into “${col.name}”. Choose one.`);usedTarget.add(col.id);
    plan.push({source,col,header:header[source]});
   }
   // Which rows.
   const first=headerRow+1,last=sheet.rows.length;let numbers=[];
   if(Array.isArray(sh.rows)){numbers=[...new Set(sh.rows.map(Number))].filter(n=>Number.isInteger(n)&&n>=first&&n<=last).sort((x,y)=>x-y);if(!numbers.length)fail(`“${sheet.name}”: choose rows after the header row.`);}
   else if(sh.rows&&typeof sh.rows==='object'){const from=Math.max(first,Number(sh.rows.from)||first),to=Math.min(last,Number(sh.rows.to)||last);for(let n=from;n<=to;n++)numbers.push(n);}
   else for(let n=first;n<=last;n++)numbers.push(n);
   let key=null;
   if(mode==='update'){
    const k=sh.key&&typeof sh.key==='object'?sh.key:input.key;
    const kp=plan.find(p=>p.source===Number(k?.source));
    if(!kp||kp.col.id.startsWith('new:')||!['TEXT','NUMBER','DATE'].includes(kp.col.type))fail(`“${sheet.name}”: to update rows, choose a key column that identifies each row (an existing Text, Number or Date column, for example an order number).`);
    key=kp;
   }
   const res={index,name:sheet.name,header,header_row:headerRow,selected:numbers.length,add:0,update:0,skipped_blank:0,skipped_unmatched:0,failed:0,errors:[],warnings:[],sample:[]};
   const seenKeys=new Set();
   for(const n of numbers){
    const cells=sheet.rows[n-1]||[],values={},problems=[];let any=false;
    for(const p of plan){
     const cell=cells[p.source];if(!cell)continue;
     if(cell.missing){res.warnings.push({row:n,column:p.header,message:'This formula has no saved result, so it was left empty. Open and save the file in Excel, then upload it again.'});continue;}
     if(cell.error){res.warnings.push({row:n,column:p.header,message:`Excel shows the error ${cell.error} here, so it was left empty.`});continue;}
     const text=cellDisplay(cell);if(text==='')continue;any=true;
     const v=convert(p.col,cell,text,{crowd,resolved,unresolved,labelAdds,createLabels,b});
     if(v.error)problems.push({row:n,column:p.header,value:text.slice(0,80),message:v.error});else if(!emptyValue(v.value))values[p.col.id]=v.value;
    }
    if(!any){res.skipped_blank++;continue;}
    if(problems.length){res.failed++;if(res.errors.length<300)res.errors.push(...problems.slice(0,3));continue;}
    let existing=null;
    if(key){
     const k=values[key.col.id]===undefined?'':cellText(key.col,values[key.col.id],nameOf).trim();
     if(!k){res.failed++;if(res.errors.length<300)res.errors.push({row:n,column:key.header,value:'',message:'The key is empty, so this row can’t be matched.'});continue;}
     if(seenKeys.has(k)){res.failed++;if(res.errors.length<300)res.errors.push({row:n,column:key.header,value:k,message:'This key appears more than once in the file; only its first row is used.'});continue;}
     seenKeys.add(k);
     const found=keyRows(key.col).get(k)||[];
     if(found.length>1){res.failed++;if(res.errors.length<300)res.errors.push({row:n,column:key.header,value:k,message:`${found.length} rows in the group have this key, so it is not clear which one to update.`});continue;}
     existing=found[0]||null;
     if(!existing&&unmatched==='skip'){res.skipped_unmatched++;continue;}
    }
    if(existing){
     const changes=Object.fromEntries(Object.entries(values).filter(([k])=>k!==key.col.id));
     ops.push({kind:'update',row:existing,values:changes,sheet:index,line:n});res.update++;
     if(res.sample.length<8)res.sample.push({row:n,action:'update',target:existing.id,values:display(changes,plan)});
    }else{
     if(rowsTotal>=GROUP_LIMITS.rows){res.failed++;if(res.errors.length<300)res.errors.push({row:n,column:'',value:'',message:`The group would have more than ${GROUP_LIMITS.rows.toLocaleString('en-US')} rows.`});continue;}
     rowsTotal++;ops.push({kind:'add',values,sheet:index,line:n});res.add++;
     if(res.sample.length<8)res.sample.push({row:n,action:'add',values:display(values,plan)});
    }
   }
   if(sheet.truncated)res.warnings.unshift({row:null,column:'',message:`Only the first ${'20,000'} rows and 200 columns of this worksheet were read.`});
   results.push(res);
  }
  const newColumns=[...proposed.values()].map(x=>({name:x.name,type:x.type,labels:x.type==='STATUS'?[...x.labels.values()]:undefined}));
  const newLabels=[...labelAdds.entries()].filter(([k])=>!k.startsWith('new:')).map(([k,v])=>({column_id:k,column:visible.find(x=>x.id===k)?.name||'',labels:[...v.values()]}));
  if(newLabels.length&&!caps.structure)fail('Adding status labels needs “Can manage” access to this group.',403);
  const totals=results.reduce((t,r)=>({add:t.add+r.add,update:t.update+r.update,skipped:t.skipped+r.skipped_blank+r.skipped_unmatched,failed:t.failed+r.failed}),{add:0,update:0,skipped:0,failed:0});
  return {mode,unmatched,sheets:results,new_columns:newColumns,new_labels:newLabels,unresolved:[...unresolved.values()],totals,ops,proposed};
  function display(values,plan){const out={};for(const p of plan)if(values[p.col.id]!==undefined)out[p.col.name]=p.col.id.startsWith('new:')?String(Array.isArray(values[p.col.id])?values[p.col.id].map(nameOf).join(', '):['IN_CHARGE'].includes(p.col.type)?nameOf(values[p.col.id]):p.col.type==='STATUS'?(p.col.labels.get(values[p.col.id])||values[p.col.id]):values[p.col.id]):cellText(p.col,values[p.col.id],nameOf).slice(0,80)||String(values[p.col.id]).slice(0,80);return out;}
 }
 // One cell converted for one column (the group's own checks run again when the rows are saved).
 function convert(col,cell,text,{crowd,resolved,unresolved,labelAdds,createLabels,b}){
  switch(col.type){
   case 'TEXT':{if(text.length>GROUP_LIMITS.text)return {error:`Longer than ${GROUP_LIMITS.text.toLocaleString('en-US')} characters.`};return {value:text};}
   case 'NUMBER':{
    if(cell.date)return {error:'This is a date, not a number.'};
    if(typeof cell.v==='boolean')return {error:'This is TRUE/FALSE, not a number.'};
    const r=parseNumber(typeof cell.v==='number'?cell.v:text);return r.ok?{value:r.value}:{error:'Not a number. Use digits, an optional minus sign and a decimal point.'};
   }
   case 'DATE':{
    if(cell.date)return {value:cell.date};
    if(typeof cell.v==='number'){const d=serialToDay(cell.v);return d&&cell.v>=1&&cell.v<2958466?{value:d}:{error:'Not a date.'};}
    const d=textDate(text);return d?{value:d}:{error:'Not a date. Use a date such as 2026-10-05 or 05/10/2026 (day first).'};
   }
   case 'STATUS':{
    const name=cleanName(text);if(!name)return {value:null};
    if(name.length>GROUP_LIMITS.label)return {error:`Status labels can have at most ${GROUP_LIMITS.label} characters.`};
    if(col.id.startsWith('new:')){
     if(!col.labels.has(nameKey(name))){if(col.labels.size>=GROUP_LIMITS.labels)return {error:`A status column can have up to ${GROUP_LIMITS.labels} labels.`};col.labels.set(nameKey(name),name);}
     return {value:name};
    }
    const found=statusLabels(col).find(l=>nameKey(l.name)===nameKey(name));if(found)return {value:found.id};
    if(!createLabels)return {error:`“${name}” isn’t one of this column’s labels (${statusLabels(col).map(l=>l.name).join(', ')}). Choose “add missing labels” or correct the file.`};
    if(!labelAdds.has(col.id))labelAdds.set(col.id,new Map());const adds=labelAdds.get(col.id);
    if(statusLabels(col).length+adds.size>=GROUP_LIMITS.labels&&!adds.has(nameKey(name)))return {error:`A status column can have up to ${GROUP_LIMITS.labels} labels.`};
    adds.set(nameKey(name),name);return {value:`label:${name}`};
   }
   case 'IN_CHARGE':case 'SUPPORT':{
    const parts=col.type==='SUPPORT'?text.split(/[;,\n]/).map(x=>x.trim()).filter(Boolean):[text.trim()];
    if(col.type==='SUPPORT'&&parts.length>GROUP_LIMITS.people)return {error:`Up to ${GROUP_LIMITS.people} people.`};
    const ids=[];
    for(const part of parts){
     const r=person(part,crowd,resolved);
     if(r.id){ids.push(r.id);continue;}
     if(r.candidates){const k=nameKey(part);if(!unresolved.has(k))unresolved.set(k,{text:part,candidates:r.candidates});return {error:`More than one person is called “${part}”. Choose who is meant.`};}
     return {error:`Nobody who can be chosen in this group matches “${part}”. Use their name, Task Controlling Management email or staff ID.`};
    }
    return {value:col.type==='SUPPORT'?[...new Set(ids)]:ids[0]};
   }
   default:return {error:`${COLUMN_TYPES[col.type]||col.type} columns can’t be imported into.`};
  }
 }
 function person(text,crowd,resolved){
  const pick=resolved[text]??resolved[nameKey(text)];
  if(typeof pick==='string'&&crowd.byId.has(pick))return {id:pick};
  if(crowd.byId.has(text))return {id:text};
  const email=crowd.byEmail.get(text.toLowerCase());if(email)return {id:email};
  const named=crowd.byName.get(nameKey(text))||[];
  if(named.length===1)return {id:named[0].id};
  if(named.length>1)return {candidates:named.map(p=>({id:p.id,name:p.name,department:p.department||''}))};
  return {};
 }
 /** What importing with this plan would do, without saving anything (the import wizard's preview). */
 function preview(key,staff,input){
  const imp=load(key,staff),{b,caps}=openBoard(imp.board_id,staff);
  if(imp.status==='IMPORTED')return {import_id:imp.id,already:true,result:parse(imp.result_json,null)};
  const p=evaluate(b,staff,caps,imp,input);
  return {import_id:imp.id,mode:p.mode,unmatched:p.unmatched,sheets:p.sheets,new_columns:p.new_columns,new_labels:p.new_labels,unresolved:p.unresolved,totals:p.totals};
 }
 // ---------------------------------------------------------------- commit
 function commit(d,actor){
  const imp=load(d.import_id,actor),{b,caps}=openBoard(imp.board_id,actor);
  // A repeated request (a retry, a double click, a second tab) gets the first result; nothing is added twice.
  if(imp.status==='IMPORTED')return {id:imp.id,type:'tm_group_import',already:true,result:parse(imp.result_json,null),message:'This file was already imported. Nothing was added again.'};
  archivedCheck(b);need(caps,'import','Importing needs “Can edit records” access to this group and a role that can add records.');
  let plan=evaluate(b,actor,caps,imp,d.plan);
  if(plan.unresolved.length)failWith(`Choose who is meant for ${plan.unresolved.map(u=>`“${u.text}”`).join(', ')} before importing.`,409,{code:'people',unresolved:plan.unresolved});
  const expected=d.expected&&typeof d.expected==='object'?d.expected:null;
  if(!expected||expected.add!==plan.totals.add||expected.update!==plan.totals.update)failWith(`The group or the choices changed since the preview (now ${plan.totals.add} to add and ${plan.totals.update} to update). Check the preview again before importing.`,409,{code:'preview_changed',totals:plan.totals});
  if(plan.mode==='update'&&plan.totals.update&&d.confirm_update!==true)failWith(`Confirm that ${plan.totals.update} existing row${plan.totals.update===1?' is':'s are'} changed.`,409,{code:'confirm_update'});
  const created=[];
  // New columns first (and new labels for existing status columns), then the plan is worked out again with them.
  for(const x of plan.proposed.values()){
   const settings=x.type==='STATUS'?{labels:[...x.labels.values()].slice(0,GROUP_LIMITS.labels).map((name,i)=>({name,color:['GRAY','BLUE','GREEN','ORANGE','RED','PURPLE','TEAL','PINK','YELLOW'][i%9]}))}:{};
   if(x.type==='STATUS'&&!settings.labels.length)settings.labels=[{name:'Done',color:'GREEN'}];
   const r=columnSave({group_id:b.id,name:x.name,type:x.type,settings},actor);created.push({id:r.id,name:x.name,type:x.type});
  }
  for(const add of plan.new_labels){
   const col=columnsOf(b.id).find(x=>x.id===add.column_id);
   columnSave({group_id:b.id,id:col.id,expected_version:col.version,settings:{...col.settings,labels:[...statusLabels(col),...add.labels.map(name=>({name,color:'GRAY'}))]}},actor);
  }
  const renamed={...d.plan,create_labels:false,sheets:d.plan.sheets.map(sh=>({...sh,columns:(sh.columns||[]).map(m=>m&&m.new?{source:m.source,target:created.find(x=>nameKey(x.name)===nameKey(cleanName(m.new.name)))?.id}:m)}))};
  plan=evaluate(b,actor,{...caps},imp,renamed);
  // Every row is checked by the group's own rules as it is saved.
  const s=sight(b,actor,caps),at=now();let position=(get('SELECT MAX(position) AS p FROM tm_board_rows WHERE board_id=?',b.id).p||0),added=0,updated=0,unchanged=0;const failedLate=[];
  // The size limits of a row and of the whole group, counted as rows are saved.
  let size=get('SELECT COALESCE(SUM(LENGTH(values_json)),0) AS n FROM tm_board_rows WHERE board_id=?',b.id).n;
  const fits=(json,before=0)=>{
   if(json.length>GROUP_LIMITS.rowChars)throw Object.assign(new Error(`This row is too large (${json.length.toLocaleString('en-US')} characters; a row can hold ${GROUP_LIMITS.rowChars.toLocaleString('en-US')}).`),{status:422});
   if(size-before+json.length>GROUP_LIMITS.groupChars)throw Object.assign(new Error('The group is full (its rows can hold 10,000,000 characters in all).'),{status:422});
   size+=json.length-before;
  };
  const cache={};
  for(const op of plan.ops){
   try{
    if(op.kind==='add'){
     const values=Object.fromEntries(Object.entries(cleanValues(b,s.columns,op.values,{},cache)).filter(([,v])=>!emptyValue(v)));
     const json=JSON.stringify(values);fits(json);
     insert('tm_board_rows',{id:id('tm-board-row','ROW'),board_id:b.id,position:++position,values_json:json,version:0,created_by:actor,created_at:at,updated_by:actor,updated_at:at});added++;
    }else{
     const r0=get('SELECT * FROM tm_board_rows WHERE id=? AND board_id=?',op.row.id,b.id);if(!r0||!s.rowOk(r0.id))throw Object.assign(new Error('The row was deleted.'),{status:404});
     const current=parse(r0.values_json,{}),changes=cleanValues(b,s.columns,op.values,current,cache),next={...current};
     for(const [k,v] of Object.entries(changes)){if(emptyValue(v))delete next[k];else next[k]=v;}
     if(JSON.stringify(next)===r0.values_json){unchanged++;continue;}
     const json=JSON.stringify(next);fits(json,r0.values_json.length);
     update('tm_board_rows',r0.id,{values_json:json,version:r0.version+1,updated_by:actor,updated_at:at});updated++;
    }
   }catch(e){if(!e.status)throw e;failedLate.push({sheet:op.sheet,row:op.line,message:e.message});}
  }
  const result={file_name:imp.file_name,added,updated,unchanged,skipped:plan.totals.skipped,failed:plan.totals.failed+failedLate.length,created_columns:created,
   sheets:plan.sheets.map(r=>({name:r.name,add:r.add,update:r.update,skipped:r.skipped_blank+r.skipped_unmatched,failed:r.failed+failedLate.filter(f=>f.sheet===r.index).length,errors:[...r.errors,...failedLate.filter(f=>f.sheet===r.index).map(f=>({row:f.row,column:'',value:'',message:f.message}))].slice(0,300),warnings:r.warnings.slice(0,100)})),
   imported_at:at};
  update('tm_board_imports',imp.id,{status:'IMPORTED',result_json:JSON.stringify(result),imported_at:at,sheets_json:'[]'});
  touch(b,actor);record(actor,b,'Imported from Excel',`${imp.file_name} · ${added} added · ${updated} updated · ${result.skipped} skipped · ${result.failed} not imported`);
  const done=[`${added} row${added===1?'':'s'} added`,plan.mode==='update'&&`${updated} updated`,unchanged&&`${unchanged} already up to date`].filter(Boolean).join(', ');
  return {id:imp.id,type:'tm_group_import',result,message:`Imported: ${done}${result.failed?`; ${result.failed} not imported (see the list)`:''}.`};
 }
 return {upload,describe,preview,commit};
}

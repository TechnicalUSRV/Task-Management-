// Task Management · Groups (V5.4). A Group is a customizable table inside a workspace: its own columns, rows,
// sharing and formulas. Internally a Group is a "board" (tm_boards, tm_board_columns, tm_board_rows,
// tm_board_access), so it is never confused with team membership or a section of rows.
// This file holds the rules shared by the Task Controlling Management server, the Task Controlling Management screens and the Telegram Mini App: access levels,
// cell values and the formula language. The server is authoritative; screens use the same code for previews.

export const COLUMN_TYPES={TEXT:'Text',DATE:'Date',NUMBER:'Number',STATUS:'Status',IN_CHARGE:'In Charge',SUPPORT:'Support',FORMULA:'Formula',ATTACHMENT:'Attachment'};
export const COLUMN_HINTS={TEXT:'Words, notes and long text (Khmer and other languages work too)',DATE:'A calendar date',NUMBER:'Whole numbers or decimals, including 0 and negatives',
 STATUS:'One colored label per row',IN_CHARGE:'One team member per row',SUPPORT:'Several team members per row',FORMULA:'Calculated for each row from other columns in the same row',
 ATTACHMENT:'Files on each row: images, PDF, Word, Excel and other documents'};
export const STATUS_COLORS={GRAY:'Gray',BLUE:'Blue',GREEN:'Green',ORANGE:'Orange',RED:'Red',PURPLE:'Purple',TEAL:'Teal',PINK:'Pink',YELLOW:'Yellow'};
export const DEFAULT_STATUS_LABELS=[['Not Started','GRAY'],['In Progress','BLUE'],['On Hold','ORANGE'],['Done','GREEN']];
// rowChars/groupChars: the stored size of one row and of all rows of a group (characters of their saved values), so one
// group can't grow without bound (60 columns × 10,000 characters would otherwise allow 600,000 characters per row).
export const GROUP_LIMITS={columns:60,rows:5000,text:10000,name:80,description:2000,labels:40,label:40,people:50,formula:1000,shared:200,rowChars:100000,groupChars:10000000,groups:200,
 // V5.5: notes on rows, page sizes, people or roles in one access rule, rows in one bulk change, and Excel imports.
 note:4000,notesPerRow:2000,page:200,principals:100,bulk:5000,importBytes:5*1024*1024,width:[60,800],
 // V5.6.9: Attachment columns: files per cell, the size of one file, and all the files of one group; the row-number column's width.
 files:20,fileBytes:30*1024*1024,groupFileBytes:250*1024*1024,rownumWidth:[64,240]};
export const VISIBILITY={PERSONAL:'Personal',TEAM:'Team'};
export const LEVELS={VIEW:1,EDIT:2,MANAGE:3,OWNER:4};
export const LEVEL_LABELS={VIEW:'Can view',EDIT:'Can edit records',MANAGE:'Can manage',OWNER:'Owner'};
export const LEVEL_HINTS={VIEW:'Open the group and read its records',EDIT:'Also add, change and delete records',MANAGE:'Also change columns, formulas and sharing',OWNER:'Created the group; can also archive or delete it'};
export const levelKey=n=>Object.keys(LEVELS).find(k=>LEVELS[k]===n)||null;

// ------------------------------------------------------------------ access
/** Access one person has to a group: 0 (none) or a LEVELS value.
 *  member: they belong to the group's workspace; level: the level the group gives them by name (or null);
 *  admin: they may manage every Team group (Task Management · Groups → Approve).
 *  Personal groups are open to their owner only. Team groups are open to the people they are shared with (or the
 *  whole workspace) while those people still belong to the workspace. */
export function groupLevel(board,staff,{member=false,level=null,admin=false}={}){
 if(!board||!staff)return 0;
 if(board.owner_id===staff)return LEVELS.OWNER;
 if(board.visibility!=='TEAM')return 0;
 const own=member&&level?LEVELS[level]||0:0,everyone=member&&board.audience==='WORKSPACE'?LEVELS[board.workspace_level]||LEVELS.VIEW:0;
 return Math.max(own,everyone,admin?LEVELS.MANAGE:0);
}
/** What a person may do: their access to this group combined with their role's permissions for Groups
 *  (can(action) for view, create, update, delete, export). Access decides which groups and how far; the role decides
 *  which kinds of change. Changing structure (columns, formulas) and sharing needs “Can manage”. */
export function groupCaps(level,can,{admin=false,owner=false,archived=false,wsArchived=false}={}){
 const view=level>0&&can('view'),rows=view&&!archived&&level>=LEVELS.EDIT,manage=view&&!archived&&level>=LEVELS.MANAGE;
 return {level,view,addRows:rows&&can('create'),editRows:rows&&can('update'),deleteRows:rows&&can('delete'),
  structure:manage&&can('update'),deleteColumns:manage&&can('update')&&can('delete'),share:manage&&can('update'),rename:manage&&can('update'),
  visibility:view&&!archived&&(owner||admin)&&can('update'),archive:view&&!wsArchived&&(owner||admin)&&can('delete'),export:view&&can('export'),
  // V5.5: notes (people who can edit records), and seeing every row and column whatever its access rules (the people who
  // manage the group keep those rules, so they always see what they restrict).
  notes:rows&&can('update'),seeAll:view&&level>=LEVELS.MANAGE,import:rows&&can('create')};
}

// ------------------------------------------------------------------ V5.5 row and column access
/** Whether an access rule lets a person in: no rule means everyone who can open the group. principals: [{type:'USER'|'ROLE', id}]. */
export const ruleAllows=(principals,staff,role)=>!principals||!principals.length||principals.some(p=>(p.type==='USER'&&p.id===staff)||(p.type==='ROLE'&&!!role&&p.id===role));
/** The columns a person may see: those their column rules allow, and formula columns only when every column the formula
 *  uses (directly or through other formulas) is visible too, so a result can never reveal a hidden value. */
export function visibleColumns(columns,allowed){
 const byId=new Map(columns.map(c=>[c.id,c])),memo=new Map();
 const ok=(id,trail)=>{
  if(memo.has(id))return memo.get(id);
  const c=byId.get(id);if(!c)return true;// a deleted column is shown as #REF!, which reveals nothing
  if(!allowed(c)){memo.set(id,false);return false;}
  if(c.type!=='FORMULA'){memo.set(id,true);return true;}
  if(trail.has(id))return true;
  trail.add(id);const r=formulaRefs(c.settings?.expression).every(x=>ok(x,trail));trail.delete(id);
  memo.set(id,r);return r;
 };
 return columns.filter(c=>ok(c.id,new Set()));
}

// ------------------------------------------------------------------ V5.5 search, filters and sorting (done by the server)
/** Whether one row matches a filter on one column. value: the cell's stored value (or the formula result). */
export function matchesFilter(col,value,f,text){
 if(col.type==='NUMBER'||col.type==='FORMULA'){
  const has=v=>v!==undefined&&v!==null&&v!=='';
  if(typeof value!=='number')return !has(f.min)&&!has(f.max);
  return (!has(f.min)||value>=Number(f.min))&&(!has(f.max)||value<=Number(f.max));
 }
 if(col.type==='DATE'){if(!value)return !f.from&&!f.to;return (!f.from||value>=f.from)&&(!f.to||value<=f.to);}
 if(col.type==='STATUS'||col.type==='IN_CHARGE')return f.value===''||f.value===null?emptyValue(value):value===f.value;
 if(col.type==='SUPPORT')return f.value===''||f.value===null?emptyValue(value):Array.isArray(value)&&value.includes(f.value);
 return String(text??'').toLowerCase().includes(String(f.value||'').toLowerCase());
}
export function sortKey(col,value,text){
 if(emptyValue(value))return null;
 if(col.type==='NUMBER')return value;
 if(col.type==='FORMULA')return typeof value==='number'?value:typeof value==='boolean'?(value?1:0):null;
 if(col.type==='STATUS')return statusLabels(col).findIndex(l=>l.id===value);
 return text;
}
/** Checks a filter list sent by a screen: [{col, value?, min?, max?, from?, to?}] (at most 50). */
export function cleanFilters(input){
 if(input===undefined||input===null||input==='')return [];
 let list=input;if(typeof list==='string'){try{list=JSON.parse(list);}catch{return null;}}
 if(!Array.isArray(list)||list.length>50)return null;
 const str=v=>v===undefined||v===null?undefined:String(v).slice(0,200);
 return list.filter(f=>f&&typeof f==='object'&&typeof f.col==='string').map(f=>({col:f.col.slice(0,60),value:f.value===null?null:str(f.value),min:str(f.min),max:str(f.max),from:str(f.from),to:str(f.to)}));
}

// ------------------------------------------------------------------ names and values
export const cleanName=v=>String(v??'').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
// Names compare without letter case and without invisible characters (zero-width spaces, common in Khmer text), so two
// names that look the same are the same name.
export const nameKey=v=>cleanName(v).replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g,'').toLowerCase();
/** Column names: 1–80 characters, unique in the group (ignoring case), without braces (they mark names in formulas). */
export function columnNameError(name,columns=[],selfId=null){
 const n=cleanName(name);
 if(!n)return 'Enter a column name.';
 if(n.length>GROUP_LIMITS.name)return `Use at most ${GROUP_LIMITS.name} characters for a column name.`;
 if(/[{}]/.test(n))return 'Column names can’t contain { or } (they mark column names in formulas).';
 if(n.startsWith('#')||n.startsWith('='))return 'Column names can’t start with # or =.';
 if(columns.some(c=>c.id!==selfId&&nameKey(c.name)===nameKey(n)))return `This group already has a column named “${n}”. Column names must be unique so formulas know which one you mean.`;
 return null;
}
// Unambiguous pattern (no nested or overlapping repeats), so checking it takes time proportional to the input.
const NUMBER_TEXT=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** Numbers keep 15 significant digits (like a spreadsheet), so 0.1 + 0.2 is exactly 0.3. */
export const tidy=x=>x===0?0:Number(x.toPrecision(15));
export function parseNumber(input){
 if(input===null||input===undefined)return {ok:true,value:null};
 if(typeof input==='number')return Number.isFinite(input)&&Math.abs(input)<=1e15?{ok:true,value:tidy(input)}:{ok:false,error:'Enter a number between -1,000,000,000,000,000 and 1,000,000,000,000,000.'};
 const raw=String(input);
 if(raw.length>100)return {ok:false,error:'This number is too long. Enter at most 15 significant digits.'};
 const s=raw.replace(/[\s, ]/g,'');
 if(!s)return {ok:true,value:null};
 if(!NUMBER_TEXT.test(s))return {ok:false,error:`“${String(input).slice(0,40)}” isn’t a number. Use digits, an optional minus sign and a decimal point, for example -12.5.`};
 return parseNumber(Number(s));
}
const safeDay=s=>{const d=new Date(`${s}T12:00:00Z`);return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):'';};
export function parseDay(input){
 if(input===null||input===undefined||input==='')return {ok:true,value:null};
 const s=String(input).trim();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||safeDay(s)!==s||Number(s.slice(0,4))<1900||Number(s.slice(0,4))>2200)return {ok:false,error:'Enter a valid date (YYYY-MM-DD).'};
 return {ok:true,value:s};
}
export function cleanText(input){
 if(input===null||input===undefined)return {ok:true,value:null};
 if(typeof input!=='string'&&typeof input!=='number')return {ok:false,error:'Enter text.'};
 if(String(input).length>GROUP_LIMITS.text*2)return {ok:false,error:`Use at most ${GROUP_LIMITS.text.toLocaleString('en-US')} characters in a cell.`};
 const s=String(input).normalize('NFC').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trimEnd().replace(/^\n+/,'');
 if(s.length>GROUP_LIMITS.text)return {ok:false,error:`Use at most ${GROUP_LIMITS.text.toLocaleString('en-US')} characters in a cell.`};
 return {ok:true,value:s.trim()?s:null};
}
export const statusLabels=col=>Array.isArray(col?.settings?.labels)?col.settings.labels:[];
/** Checks a value typed for a cell. people: {eligible:Set of staff IDs that may be chosen now, current: value already
 *  in the cell (people already chosen stay, even if they are no longer available)}. */
export function cleanCell(col,input,{eligible=null,current=null}={}){
 const t=col.type;
 if(t==='FORMULA')return {ok:false,error:'Formula results are calculated for each row; they can’t be typed in.'};
 // V5.6.9: files are added by uploading them; a cell's value can only keep or remove the files it already has.
 if(t==='ATTACHMENT'){
  if(input===null||input===undefined||input===''||(Array.isArray(input)&&!input.length))return {ok:true,value:null};
  const had=Array.isArray(current)?current:[],key=x=>typeof x==='string'?x:x&&typeof x==='object'?x.id:null;
  if(!Array.isArray(input)||input.some(x=>!had.some(h=>h.id===key(x))))return {ok:false,error:'Add files with the Upload button in the cell.'};
  const ids=[...new Set(input.map(key))];
  return {ok:true,value:had.filter(h=>ids.includes(h.id))};
 }
 if(t==='TEXT')return cleanText(input);
 if(t==='NUMBER')return parseNumber(input);
 if(t==='DATE')return parseDay(input);
 if(t==='STATUS'){
  if(input===null||input===undefined||input==='')return {ok:true,value:null};
  const labels=statusLabels(col),found=labels.find(l=>l.id===input)||labels.find(l=>nameKey(l.name)===nameKey(input));
  return found?{ok:true,value:found.id}:{ok:false,error:`Choose one of this column’s labels: ${labels.map(l=>l.name).join(', ')}.`};
 }
 const allowed=staff=>typeof staff==='string'&&(!eligible||eligible.has(staff));
 if(t==='IN_CHARGE'){
  if(input===null||input===undefined||input==='')return {ok:true,value:null};
  if(typeof input!=='string')return {ok:false,error:'Choose one person.'};
  return input===current||allowed(input)?{ok:true,value:input}:{ok:false,error:'Choose an active member who can see this group.'};
 }
 if(t==='SUPPORT'){
  if(input===null||input===undefined||input==='')return {ok:true,value:null};
  if(!Array.isArray(input)||input.some(x=>typeof x!=='string'))return {ok:false,error:'Choose the supporting people.'};
  const list=[...new Set(input)],had=new Set(Array.isArray(current)?current:[]);
  if(list.length>GROUP_LIMITS.people)return {ok:false,error:`Choose up to ${GROUP_LIMITS.people} people.`};
  if(list.some(x=>!had.has(x)&&!allowed(x)))return {ok:false,error:'Choose active members who can see this group.'};
  return {ok:true,value:list.length?list:null};
 }
 return {ok:false,error:'Unknown column type.'};
}
export const emptyValue=v=>v===null||v===undefined||v===''||(Array.isArray(v)&&!v.length);

const DAY_FORMAT=new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
export const formatDay=v=>{if(!v)return '';const d=new Date(`${v}T12:00:00Z`);return Number.isFinite(d.getTime())?DAY_FORMAT.format(d):String(v);};
// Number formats are made once per number of decimals (making one is slow; searching a large group formats thousands).
const NUMBER_FORMATS=new Map();
const numberFormat=d=>{let f=NUMBER_FORMATS.get(d);if(!f){f=new Intl.NumberFormat('en-US',d===null?{maximumFractionDigits:6}:{minimumFractionDigits:d,maximumFractionDigits:d});NUMBER_FORMATS.set(d,f);}return f;};
export function formatNumber(n,decimals=null){
 if(typeof n!=='number'||!Number.isFinite(n))return '';
 const d=decimals===null||decimals===undefined?null:Math.max(0,Math.min(6,Number(decimals)));
 return numberFormat(d).format(d===null?n:roundTo(n,d));
}
/** A calculated value as text: numbers with the column's decimals, TRUE/FALSE, blank, or the error code. */
export const formatResult=(v,decimals=null)=>v===null||v===undefined?'':typeof v==='boolean'?(v?'TRUE':'FALSE'):typeof v==='object'?v.error:formatNumber(v,decimals);
/** A cell as plain text (search, sorting of text, CSV). nameOf(staffId) gives a person's name. */
export function cellText(col,value,nameOf=x=>x){
 if(emptyValue(value))return '';
 if(col.type==='FORMULA')return formatResult(value,col.settings?.decimals);
 if(col.type==='NUMBER')return formatNumber(value,col.settings?.decimals);
 if(col.type==='DATE')return String(value);
 if(col.type==='STATUS')return statusLabels(col).find(l=>l.id===value)?.name||'';
 if(col.type==='IN_CHARGE')return nameOf(value);
 if(col.type==='SUPPORT')return (Array.isArray(value)?value:[]).map(nameOf).join(', ');
 if(col.type==='ATTACHMENT')return (Array.isArray(value)?value:[]).map(f=>f?.name||'').filter(Boolean).join(', ');
 return String(value);
}

// ------------------------------------------------------------------ changing a column's type
/** Converts one existing value when a column changes type. Returns {ok,value} or {ok:false} when the value can't be
 *  kept (the person is then shown how many and asked to confirm clearing them). people: name → staff ID lookup. */
export function convertValue(from,to,value,{labels=[],nameOf=x=>x,personByName=()=>null}={}){
 if(emptyValue(value))return {ok:true,value:null};
 const text=from.type==='TEXT'?String(value):cellText(from,value,nameOf);
 switch(to.type){
  case 'TEXT':return {ok:true,value:text||null};
  case 'NUMBER':{if(from.type==='NUMBER'||from.type==='FORMULA')return typeof value==='number'?{ok:true,value}:typeof value==='boolean'?{ok:true,value:value?1:0}:{ok:false};const r=parseNumber(text);return r.ok?r:{ok:false};}
  case 'DATE':{const r=parseDay(from.type==='DATE'?value:text);return r.ok?r:{ok:false};}
  case 'STATUS':{const l=labels.find(x=>nameKey(x.name)===nameKey(text));return l?{ok:true,value:l.id}:{ok:false};}
  case 'IN_CHARGE':{
   if(from.type==='SUPPORT'){const list=Array.isArray(value)?value:[];return list.length===1?{ok:true,value:list[0]}:{ok:false};}
   const p=personByName(text);return p?{ok:true,value:p}:{ok:false};
  }
  case 'SUPPORT':{
   if(from.type==='IN_CHARGE')return {ok:true,value:[value]};
   const names=text.split(',').map(s=>s.trim()).filter(Boolean),ids=names.map(personByName);
   return ids.length&&ids.every(Boolean)?{ok:true,value:[...new Set(ids)]}:{ok:false};
  }
  default:return {ok:false};
 }
}

// ------------------------------------------------------------------ formulas
// A small spreadsheet-style language for values in the same row:
//   ={Quantity} * {Unit Price}      =SUM({Cost A}, {Cost B})      =IF({Quantity} > 0, {Subtotal} / {Quantity}, 0)
// Columns are named in braces; the saved formula stores stable column IDs ({#COL-000012}), so renaming or moving a
// column never breaks it. The parser below accepts only numbers, TRUE/FALSE, column references, + - * / ( ),
// comparisons (= <> > >= < <=) and six functions. Nothing is ever run as code.
export const FORMULA_FUNCTIONS={
 SUM:{min:1,max:255,usage:'SUM(value, value, …)',about:'Adds the values. Empty cells count as 0.',example:'=SUM({Cost A}, {Cost B}, {Cost C})'},
 AVERAGE:{min:1,max:255,usage:'AVERAGE(value, value, …)',about:'The average of the values that are not empty.',example:'=AVERAGE({Score 1}, {Score 2}, {Score 3})'},
 MIN:{min:1,max:255,usage:'MIN(value, value, …)',about:'The smallest value that is not empty.',example:'=MIN({Quote A}, {Quote B})'},
 MAX:{min:1,max:255,usage:'MAX(value, value, …)',about:'The largest value that is not empty.',example:'=MAX({Quote A}, {Quote B})'},
 ROUND:{min:1,max:2,usage:'ROUND(value, decimals)',about:'Rounds to the given number of decimal places (halves round away from zero).',example:'=ROUND({Subtotal} * 0.10, 2)'},
 IF:{min:2,max:3,usage:'IF(condition, value if true, value if false)',about:'Chooses a value. Only the chosen value is calculated.',example:'=IF({Quantity} > 0, {Subtotal} / {Quantity}, 0)'},
};
export const FORMULA_ERRORS={'#DIV/0!':'Division by zero (or AVERAGE of only empty cells).','#NUM!':'The result is too large or not a number.','#VALUE!':'A referenced column can no longer be used in a formula.','#REF!':'A referenced column no longer exists.','#CIRC!':'The formula depends on itself.','#N/A':'A Live Data value it uses is not available to you (the share was revoked or access ended).','#DUP!':'A Live Data value it uses matches several shared records.'};
export const FORMULA_RULES=[
 'Formulas work on one row at a time: {Column} is that column’s value in the same row. Other rows, other groups and cell addresses such as A1 are not supported.',
 'Formulas can use Number columns and other Formula columns. Text, Date, Status and people columns can’t be used.',
 'Empty cells count as 0 in calculations. If every cell a formula uses is empty, the result is empty.',
 'Results keep 15 significant digits, as in a spreadsheet. The column’s “decimal places” setting only changes how results are shown; use ROUND to round the value itself.',
 'Comparisons (= <> > >= < <=) give TRUE or FALSE; in calculations TRUE counts as 1 and FALSE as 0.',
 'An error in a cell a formula uses (for example #DIV/0!) is passed on to the result, and totals of a column with errors are not shown.',
];
const OPERATORS=['<>','<=','>=','=','<','>','+','-','*','/','(',')',','];
class FormulaError extends Error{}
const bad=m=>{throw new FormulaError(m);};
function tokenize(src){
 const tokens=[];let i=0;
 while(i<src.length){
  const ch=src[i];
  if(/\s/.test(ch)){i++;continue;}
  if(ch==='{'){
   const end=src.indexOf('}',i+1);if(end<0)bad('A column name is missing its closing brace }.');
   const name=src.slice(i+1,end);if(name.includes('{'))bad('A column name is missing its closing brace }.');
   if(!name.trim())bad('Put a column name inside the braces, for example {Quantity}.');
   tokens.push({t:'ref',v:name,start:i,end:end+1});i=end+1;continue;
  }
  if(ch==='}')bad('There is a } without a matching {.');
  const num=/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
  if(num){const v=Number(num[0]);if(!Number.isFinite(v))bad(`${num[0]} is too large.`);tokens.push({t:'num',v,raw:num[0]});i+=num[0].length;continue;}
  const word=/^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
  if(word){const up=word[0].toUpperCase();tokens.push(up==='TRUE'||up==='FALSE'?{t:'bool',v:up==='TRUE',raw:word[0]}:{t:'name',v:up,raw:word[0]});i+=word[0].length;continue;}
  const op=OPERATORS.find(o=>src.startsWith(o,i));
  if(op){tokens.push({t:'op',v:op});i+=op.length;continue;}
  if(ch==='"'||ch==='“'||ch==='”'||ch==='\'')bad('Text in quotes isn’t supported in formulas. Use numbers and column names.');
  if(ch==='^')bad('The ^ operator isn’t supported. Multiply instead, for example {Rate} * {Rate}.');
  if(ch==='%')bad('The % sign isn’t supported. Divide by 100 instead, for example {Rate} / 100.');
  if(ch==='&')bad('Joining text with & isn’t supported.');
  if(ch===';')bad('Separate the values in a function with commas, for example SUM({A}, {B}).');
  if(ch==='!'&&src[i+1]==='=')bad('Use <> for “not equal”.');
  if(ch==='='&&src[i+1]==='=')bad('Use a single = to compare values.');
  bad(`“${ch}” isn’t allowed in a formula.`);
 }
 return tokens;
}
const show=tk=>tk?(tk.t==='ref'?`{${tk.v}}`:tk.raw??String(tk.v)):'';
function parseTokens(tokens){
 let p=0;
 const peek=()=>tokens[p],isOp=v=>peek()?.t==='op'&&peek().v===v;
 const expr=depth=>{if(depth>40)bad('This formula is nested too deeply.');return comparison(depth);};
 const comparison=d=>{let a=additive(d);while(peek()?.t==='op'&&['=','<>','<','<=','>','>='].includes(peek().v)){const op=tokens[p++].v;a={k:'cmp',op,a,b:additive(d)};}return a;};
 const additive=d=>{let a=term(d);while(isOp('+')||isOp('-')){const op=tokens[p++].v;a={k:'bin',op,a,b:term(d)};}return a;};
 const term=d=>{let a=unary(d);while(isOp('*')||isOp('/')){const op=tokens[p++].v;a={k:'bin',op,a,b:unary(d)};}return a;};
 const unary=d=>{if(isOp('-')||isOp('+')){const op=tokens[p++].v;const a=unary(d+1);return op==='-'?{k:'neg',a}:a;}return primary(d);};
 const primary=d=>{
  const before=tokens[p-1],tk=tokens[p++];
  if(!tk)bad(before?`The formula ends after “${show(before)}”. Add a number, column or function.`:'Enter a formula, for example ={Quantity} * {Unit Price}.');
  if(tk.t==='num')return {k:'num',v:tk.v};
  if(tk.t==='bool')return {k:'bool',v:tk.v};
  if(tk.t==='ref')return {k:'ref',name:tk.v};
  if(tk.t==='name'){
   if(!isOp('('))bad(FORMULA_FUNCTIONS[tk.v]?`${tk.v} needs its values in brackets, for example ${FORMULA_FUNCTIONS[tk.v].usage}.`:`“${tk.raw}” isn’t a column or a function. Put column names in braces, for example {${tk.raw}}.`);
   const f=FORMULA_FUNCTIONS[tk.v];if(!f)bad(`${tk.v} isn’t supported. Use SUM, AVERAGE, MIN, MAX, ROUND or IF.`);
   p++;const args=[];
   if(!isOp(')')){do{if(isOp(',')||isOp(')'))bad(`A value is missing in ${tk.v}( ).`);args.push(expr(d+1));}while(isOp(',')&&++p);}
   if(!isOp(')'))bad(`${tk.v}( is missing its closing ).`);
   p++;
   if(args.length<f.min||args.length>f.max)bad(`${tk.v} takes ${f.min===f.max?f.min:`${f.min} to ${f.max===255?'many':f.max}`} value${f.max===1?'':'s'}: ${f.usage}.`);
   return {k:'fn',name:tk.v,args};
  }
  if(tk.v==='('){if(isOp(')'))bad('There is nothing between ( and ).');const e=expr(d+1);if(!isOp(')'))bad('A ( is missing its closing ).');p++;return e;}
  bad(before?`Expected a number, column or function after “${show(before)}”, not “${show(tk)}”.`:`A formula can’t start with “${show(tk)}”.`);
 };
 const ast=expr(0);
 if(p<tokens.length)bad(tokens[p].v===')'?'There is a ) without a matching (.':`Expected an operator such as + or * before “${show(tokens[p])}”.`);
 return ast;
}
const stripEquals=text=>{const s=String(text??'').trim();return s.startsWith('=')?s.slice(1):s;};
/** The column IDs a saved formula uses. */
export function formulaRefs(canonical){
 try{return [...new Set(tokenize(stripEquals(canonical)).filter(t=>t.t==='ref'&&t.v.startsWith('#')).map(t=>t.v.slice(1)))];}catch{return [];}
}
/** Checks a formula typed by a person (column names in braces; a leading = is optional) against the group's columns.
 *  Returns {ok:true, canonical, display, refs} or {ok:false, error}. selfId: the formula's own column (if saved). */
export function compileFormula(text,columns,selfId=null){
 try{
  const raw=String(text??'').trim();
  if(raw.length>GROUP_LIMITS.formula)bad(`Use at most ${GROUP_LIMITS.formula} characters in a formula.`);
  const src=stripEquals(raw);if(!src.trim())bad('Enter a formula, for example ={Quantity} * {Unit Price}.');
  const tokens=tokenize(src);if(tokens.length>400)bad('This formula is too long.');
  parseTokens(tokens);
  const byId=new Map(columns.map(c=>[c.id,c])),byName=new Map(columns.map(c=>[nameKey(c.name),c])),refs=[];
  let canonical='',at=0;
  for(const tk of tokens.filter(x=>x.t==='ref')){
   const col=tk.v.startsWith('#')?byId.get(tk.v.slice(1)):byName.get(nameKey(tk.v));
   if(!col)bad(`There’s no column named {${cleanName(tk.v)}}. Check the spelling, or insert the column from the list.`);
   if(col.id===selfId)bad(`A formula can’t use its own column ({${col.name}}).`);
   if(!['NUMBER','FORMULA'].includes(col.type))bad(`{${col.name}} is a ${COLUMN_TYPES[col.type]} column. Formulas can use Number and Formula columns only.`);
   if(!refs.includes(col.id))refs.push(col.id);
   canonical+=src.slice(at,tk.start)+`{#${col.id}}`;at=tk.end;
  }
  canonical='='+(canonical+src.slice(at)).trim();
  if(selfId){const loop=formulaCycle(columns,selfId,refs);if(loop)bad(`This would make a loop: ${loop.map(id=>byId.get(id)?.name||id).join(' → ')}. A formula can’t depend on itself.`);}
  return {ok:true,canonical,display:formulaDisplay(canonical,columns),refs};
 }catch(e){if(e instanceof FormulaError)return {ok:false,error:e.message};throw e;}
}
/** A saved formula with the columns' current names (so a renamed column shows its new name). */
export function formulaDisplay(canonical,columns){
 const src=stripEquals(canonical),byId=new Map(columns.map(c=>[c.id,c]));
 let out='',at=0;
 try{for(const tk of tokenize(src).filter(x=>x.t==='ref')){const c=tk.v.startsWith('#')?byId.get(tk.v.slice(1)):null;out+=src.slice(at,tk.start)+(c?`{${c.name}}`:tk.v.startsWith('#')?'{deleted column}':`{${tk.v}}`);at=tk.end;}}catch{return String(canonical??'');}
 return '='+out+src.slice(at);
}
/** A loop the formula of column selfId (using refs) would create, as a list of column IDs, or null. */
export function formulaCycle(columns,selfId,refs){
 const uses=new Map(columns.filter(c=>c.type==='FORMULA'&&c.id!==selfId).map(c=>[c.id,formulaRefs(c.settings?.expression)]));
 uses.set(selfId,refs);
 const done=new Set();
 const walk=(id,trail)=>{
  for(const r of uses.get(id)||[]){
   if(r===selfId)return [...trail,r];
   if(done.has(r)||trail.includes(r)||!uses.has(r))continue;
   const found=walk(r,[...trail,r]);if(found)return found;done.add(r);
  }
  return null;
 };
 return walk(selfId,[selfId]);
}
/** The formula columns that use a column directly (they must change before it is deleted or changes type). */
export const formulaDependents=(columns,colId)=>columns.filter(c=>c.type==='FORMULA'&&c.id!==colId&&formulaRefs(c.settings?.expression).includes(colId));

// Evaluation. Values are numbers, TRUE/FALSE, null (empty) or {error:'#DIV/0!'}.
const isError=v=>!!v&&typeof v==='object';
const asNumber=v=>v===null||v===undefined?0:typeof v==='boolean'?(v?1:0):v;
const finish=x=>Number.isFinite(x)&&Math.abs(x)<1e300?tidy(x):{error:'#NUM!'};
/** Rounds half away from zero at `digits` decimal places (negative digits round to tens, hundreds…). */
// Moves the decimal point by e places using the number's own digits (also for numbers written like 1.5e-7).
const shift=(n,e)=>{const [m,exp='0']=String(n).split('e');return Number(`${m}e${Number(exp)+e}`);};
export function roundTo(x,digits){
 const d=Math.max(-15,Math.min(15,Math.trunc(digits)));
 const r=Math.sign(x)*shift(Math.round(shift(Math.abs(x),d)),-d);
 return Number.isFinite(r)?tidy(r):tidy(Number(x.toFixed(Math.max(0,d))));
}
function evaluate(n,get){
 switch(n.k){
  case 'num':return n.v;
  case 'bool':return n.v;
  case 'ref':return get(n.id);
  case 'neg':{const a=evaluate(n.a,get);return isError(a)?a:finish(-asNumber(a));}
  case 'bin':{
   const a=evaluate(n.a,get);if(isError(a))return a;const b=evaluate(n.b,get);if(isError(b))return b;
   const x=asNumber(a),y=asNumber(b);
   if(n.op==='/'&&y===0)return {error:'#DIV/0!'};
   return finish(n.op==='+'?x+y:n.op==='-'?x-y:n.op==='*'?x*y:x/y);
  }
  case 'cmp':{
   const a=evaluate(n.a,get);if(isError(a))return a;const b=evaluate(n.b,get);if(isError(b))return b;
   const x=asNumber(a),y=asNumber(b);
   return n.op==='='?x===y:n.op==='<>'?x!==y:n.op==='<'?x<y:n.op==='<='?x<=y:n.op==='>'?x>y:x>=y;
  }
  case 'fn':{
   if(n.name==='IF'){
    const c=evaluate(n.args[0],get);if(isError(c))return c;
    if(asNumber(c)!==0)return evaluate(n.args[1],get);
    return n.args.length>2?evaluate(n.args[2],get):false;
   }
   const values=[];for(const arg of n.args){const v=evaluate(arg,get);if(isError(v))return v;values.push(v);}
   if(n.name==='ROUND'){const d=values.length>1?asNumber(values[1]):0;return values[0]===null?null:roundTo(asNumber(values[0]),d);}
   const present=values.filter(v=>v!==null).map(asNumber);
   if(n.name==='SUM')return finish(present.reduce((s,x)=>s+x,0));
   if(n.name==='AVERAGE')return present.length?finish(present.reduce((s,x)=>s+x,0)/present.length):{error:'#DIV/0!'};
   if(n.name==='MIN')return present.length?Math.min(...present):0;
   if(n.name==='MAX')return present.length?Math.max(...present):0;
   return {error:'#VALUE!'};
  }
  default:return {error:'#VALUE!'};
 }
}
/** Prepares the saved formulas of a group's columns for evaluation (once per request). */
export function prepareFormulas(columns){
 const byId=new Map(columns.map(c=>[c.id,c])),out=new Map();
 for(const c of columns){
  if(c.type!=='FORMULA')continue;
  try{
   const tokens=tokenize(stripEquals(c.settings?.expression||'')),ast=parseTokens(tokens);
   const bind=n=>{if(n.k==='ref'){const id=n.name.startsWith('#')?n.name.slice(1):null;n.id=id;}for(const k of ['a','b'])if(n[k])bind(n[k]);for(const x of n.args||[])bind(x);};
   bind(ast);
   const refs=formulaRefs(c.settings?.expression),broken=refs.find(id=>!byId.has(id))?'#REF!':refs.find(id=>!['NUMBER','FORMULA'].includes(byId.get(id).type))?'#VALUE!':null;
   out.set(c.id,broken?{error:broken,refs}:{ast,refs});
  }catch{out.set(c.id,{error:'#VALUE!',refs:[]});}
 }
 return out;
}
/** Every formula result of one row: {columnId: value}. values: the row's stored cells by column ID. */
export function computeRow(values,columns,prepared=prepareFormulas(columns)){
 const byId=new Map(columns.map(c=>[c.id,c])),out={},state=new Map();
 const get=id=>{
  const col=byId.get(id);
  if(!col)return {error:'#REF!'};
  if(col.type==='NUMBER'){const v=values?.[id];return typeof v==='number'&&Number.isFinite(v)?v:null;}
  if(col.type!=='FORMULA')return {error:'#VALUE!'};
  if(state.get(id)===2)return out[id];
  if(state.get(id)===1)return {error:'#CIRC!'};
  state.set(id,1);
  const f=prepared.get(id);let r;
  if(!f||f.error)r={error:f?.error||'#VALUE!'};
  else{const used=f.refs.map(get);r=f.refs.length&&used.every(v=>v===null)?null:evaluate(f.ast,get);}
  state.set(id,2);out[id]=r;return r;
 };
 for(const c of columns)if(c.type==='FORMULA')get(c.id);
 return out;
}
/** Checks and previews a formula before it is saved: the result for one row (or null). */
export function previewFormula(text,columns,selfId,values){
 const r=compileFormula(text,columns,selfId);if(!r.ok)return r;
 const draft=columns.some(c=>c.id===selfId)?columns.map(c=>c.id===selfId?{...c,type:'FORMULA',settings:{...c.settings,expression:r.canonical}}:c):[...columns,{id:selfId||'__draft__',name:'(new column)',type:'FORMULA',settings:{expression:r.canonical}}];
 const value=values?computeRow(values,draft)[selfId||'__draft__']:undefined;
 return {...r,value};
}

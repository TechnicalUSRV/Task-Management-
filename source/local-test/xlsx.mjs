// V5.5: genuine Excel workbooks (.xlsx, Office Open XML) for Group export and import, with no outside libraries.
//
// Writing: one worksheet with a bold, frozen header row, filters on the header, sensible column widths, real numbers,
// real dates (with a date format) and text that is always text (a value starting with "=" is stored as text and is
// never a formula). The file holds no hidden sheets and no document properties (no author, company or file paths).
//
// Reading: the cell values of each worksheet (shared strings, inline strings, numbers, booleans, errors and the saved
// results of formulas, which are never calculated or run here), with dates recognised from the cell's number format.
// The reader refuses files that are not .xlsx packages, that are too large or too complex, that expand far beyond their
// size (zip bombs) or whose XML declares a DOCTYPE or entities.
import {deflateRawSync,inflateRawSync,crc32 as zlibCrc32} from 'node:zlib';

// ------------------------------------------------------------------ zip
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
export function crc32(buf){
 if(typeof zlibCrc32==='function')return zlibCrc32(buf)>>>0;
 let c=0xffffffff;for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;
}
const DOS_DATE=(()=>{const d=new Date(Date.UTC(2026,0,1));return {time:0,date:((d.getUTCFullYear()-1980)<<9)|((d.getUTCMonth()+1)<<5)|d.getUTCDate()};})();
export function zip(entries){
 const locals=[],centrals=[];let offset=0;
 for(const {name,data} of entries){
  const raw=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8'),packed=deflateRawSync(raw,{level:6}),nameBuf=Buffer.from(name,'utf8'),crc=crc32(raw);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);
  local.writeUInt16LE(DOS_DATE.time,10);local.writeUInt16LE(DOS_DATE.date,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(raw.length,22);
  local.writeUInt16LE(nameBuf.length,26);local.writeUInt16LE(0,28);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);
  central.writeUInt16LE(DOS_DATE.time,12);central.writeUInt16LE(DOS_DATE.date,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(raw.length,24);
  central.writeUInt16LE(nameBuf.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);
  locals.push(local,nameBuf,packed);centrals.push(central,nameBuf);
  offset+=local.length+nameBuf.length+packed.length;
 }
 const dir=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,dir,end]);
}

export class XlsxError extends Error{constructor(message){super(message);this.status=422;}}
const refuse=m=>{throw new XlsxError(m);};
// chars: all the text read from the cells together. Shared strings let a small file repeat one long text in many cells,
// so this is what bounds the data an upload can produce (a group holds up to 10 million characters anyway).
export const READ_LIMITS={fileBytes:5*1024*1024,entries:2000,entryBytes:40*1024*1024,totalBytes:80*1024*1024,ratio:200,sheets:20,rows:20000,columns:200,cells:400000,text:32767,chars:10000000};

/** The files inside a zip, read lazily: {names, read(name) → Buffer|null}. Checks sizes before inflating anything. */
export function unzip(buf,limits=READ_LIMITS){
 if(!Buffer.isBuffer(buf)||buf.length<22)refuse('This is not an Excel workbook (.xlsx).');
 if(buf.length>limits.fileBytes)refuse(`The file is larger than ${Math.round(limits.fileBytes/1048576)} MB.`);
 let eocd=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}
 if(eocd<0)refuse('This is not an Excel workbook (.xlsx). Save it as “Excel Workbook (*.xlsx)” and try again.');
 const count=buf.readUInt16LE(eocd+10),size=buf.readUInt32LE(eocd+12),start=buf.readUInt32LE(eocd+16);
 if(count>limits.entries)refuse('This workbook has too many parts to be read safely.');
 if(start+size>buf.length)refuse('This workbook is damaged (its contents list is cut off).');
 const files=new Map();let total=0;
 for(let p=start,i=0;i<count;i++){
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)refuse('This workbook is damaged.');
  const method=buf.readUInt16LE(p+10),flags=buf.readUInt16LE(p+8),csize=buf.readUInt32LE(p+20),usize=buf.readUInt32LE(p+24),nlen=buf.readUInt16LE(p+28),xlen=buf.readUInt16LE(p+30),clen=buf.readUInt16LE(p+32),local=buf.readUInt32LE(p+42);
  const name=buf.subarray(p+46,p+46+nlen).toString('utf8');
  if(flags&1)refuse('This workbook is password-protected. Remove the password in Excel and try again.');
  if(usize>limits.entryBytes||(csize>0&&usize/csize>limits.ratio&&usize>1048576))refuse('This workbook expands to far more data than its file size suggests, so it is not read (it may be damaged or unsafe).');
  total+=usize;if(total>limits.totalBytes)refuse('This workbook holds too much data to import at once. Split it into smaller files.');
  files.set(name,{method,csize,usize,local});
  p+=46+nlen+xlen+clen;
 }
 const read=name=>{
  const f=files.get(name);if(!f)return null;
  if(f.local+30>buf.length||buf.readUInt32LE(f.local)!==0x04034b50)refuse('This workbook is damaged.');
  const at=f.local+30+buf.readUInt16LE(f.local+26)+buf.readUInt16LE(f.local+28),data=buf.subarray(at,at+f.csize);
  if(f.method===0)return Buffer.from(data);
  if(f.method!==8)refuse('This workbook uses a compression Excel does not normally use.');
  let out;try{out=inflateRawSync(data,{maxOutputLength:Math.max(f.usize,1)+1024});}catch{refuse('This workbook is damaged (a part could not be unpacked).');}
  if(out.length!==f.usize)refuse('This workbook is damaged (a part has the wrong size).');
  return out;
 };
 return {names:[...files.keys()],read};
}

// ------------------------------------------------------------------ XML helpers (no DOCTYPE, no entities, no external anything)
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Characters XML 1.0 can't hold are dropped (control characters other than tab, line feed and carriage return).
const xmlText=s=>esc(String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g,''));
const ENT={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const unesc=s=>s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,(m,e)=>e[0]==='#'?(()=>{const n=e[1]==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<0x110000?String.fromCodePoint(n):'';})():ENT[e]).replace(/_x([0-9A-Fa-f]{4})_/g,(m,h)=>String.fromCharCode(parseInt(h,16)));
function xmlOf(buf,name){
 const s=buf.toString('utf8');
 if(/<!DOCTYPE|<!ENTITY/i.test(s))refuse(`This workbook contains XML features that are not allowed (${name}). Save it again from Excel as a normal .xlsx file.`);
 return s;
}
const attr=(tag,name)=>{const m=new RegExp(`\\s${name}="([^"]*)"`).exec(tag);return m?unesc(m[1]):null;};
/** Every element `<tag …>…</tag>` or `<tag …/>` in order, as {open (the start tag), body}. Plain scanning, no regex backtracking. */
function* elements(s,tag,from=0,to=s.length){
 const open=`<${tag}`;let i=from;
 while(true){
  i=s.indexOf(open,i);if(i<0||i>=to)return;
  const c=s[i+open.length];if(c!==' '&&c!=='>'&&c!=='/'&&c!=='\t'&&c!=='\n'&&c!=='\r'){i+=open.length;continue;}
  const gt=s.indexOf('>',i);if(gt<0)return;
  const head=s.slice(i,gt+1);
  if(head.endsWith('/>')){yield {open:head,body:'',end:gt+1};i=gt+1;continue;}
  const close=s.indexOf(`</${tag}>`,gt);if(close<0)return;
  yield {open:head,body:s.slice(gt+1,close),end:close+tag.length+3};i=close+tag.length+3;
 }
}
const textOf=body=>{let out='';for(const t of elements(body,'t'))out+=unesc(t.body);return out;};
const colIndex=ref=>{let n=0;for(const ch of ref){const c=ch.charCodeAt(0);if(c<65||c>90)break;n=n*26+(c-64);}return n-1;};
export const colName=i=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};

// ------------------------------------------------------------------ dates
const EPOCH=Date.UTC(1899,11,30);
export const serialToDay=n=>{if(!Number.isFinite(n)||n<1||n>2958465)return null;const d=new Date(EPOCH+Math.floor(n)*86400000);return d.toISOString().slice(0,10);};
export const dayToSerial=day=>(Date.parse(`${day}T00:00:00Z`)-EPOCH)/86400000;
const BUILTIN_DATES=new Set([14,15,16,17,18,19,20,21,22,27,30,36,45,46,47,50,57]);
function isDateFormat(code){
 const plain=String(code||'').replace(/"[^"]*"/g,'').replace(/\[[^\]]*\]/g,'').replace(/\\./g,'');
 return /[dmyhs]/i.test(plain)&&!/^[#0.,%E+\-\s?/]*$/i.test(plain);
}

// ------------------------------------------------------------------ writing
const DEC_FMT=d=>d===0?'#,##0':`#,##0.${'0'.repeat(d)}`;
/**
 * sheets: [{name, columns:[{header, type:'text'|'number'|'date'|'bool', decimals}], rows:[[value…]]}]
 * Values: strings (always written as text), numbers, booleans, 'YYYY-MM-DD' strings in date columns, {error:'#DIV/0!'},
 * null (empty). Returns the workbook as a Buffer.
 */
export function writeXlsx({sheets}){
 const strings=[],index=new Map();
 const sst=s=>{let i=index.get(s);if(i===undefined){i=strings.length;strings.push(s);index.set(s,i);}return i;};
 // Styles: 0 normal, 1 header, 2 date, 3 text that starts like a formula (shown as text when edited), 4+d numbers with d decimals.
 const numFmts=[[164,'yyyy-mm-dd'],...[0,1,2,3,4,5,6].map(d=>[165+d,DEC_FMT(d)])];
 const xfs=['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>',
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>',
  ...[0,1,2,3,4,5,6].map(d=>`<xf numFmtId="${165+d}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`),
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'];
 const GENERAL_NUMBER=4+7;
 const sheetXml=sheet=>{
  const cols=sheet.columns,rows=sheet.rows,widths=cols.map(c=>Math.min(60,Math.max(8,String(c.header).length+2)));
  const out=[];
  const head=cols.map((c,i)=>`<c r="${colName(i)}1" t="s" s="1"><v>${sst(String(c.header))}</v></c>`).join('');
  out.push(`<row r="1" spans="1:${Math.max(1,cols.length)}">${head}</row>`);
  rows.forEach((row,ri)=>{
   const r=ri+2,cells=[];
   cols.forEach((c,ci)=>{
    const v=row[ci],ref=`${colName(ci)}${r}`;
    if(v===null||v===undefined||v===''||(Array.isArray(v)&&!v.length))return;
    if(typeof v==='object'&&v.error){cells.push(`<c r="${ref}" t="e"><v>${xmlText(v.error)}</v></c>`);widths[ci]=Math.max(widths[ci],v.error.length+2);return;}
    if(typeof v==='boolean'){cells.push(`<c r="${ref}" t="b"><v>${v?1:0}</v></c>`);return;}
    if(c.type==='date'&&typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)){cells.push(`<c r="${ref}" s="2"><v>${dayToSerial(v)}</v></c>`);widths[ci]=Math.max(widths[ci],12);return;}
    if(typeof v==='number'&&Number.isFinite(v)){
     const d=c.decimals===null||c.decimals===undefined?null:Math.max(0,Math.min(6,Number(c.decimals)));
     cells.push(`<c r="${ref}" s="${d===null?GENERAL_NUMBER:4+d}"><v>${v}</v></c>`);widths[ci]=Math.max(widths[ci],Math.min(24,String(v).length+4));return;
    }
    const s=String(v).slice(0,READ_LIMITS.text);
    cells.push(`<c r="${ref}" t="s"${/^[=+\-@\t\r]/.test(s)?' s="3"':''}><v>${sst(s)}</v></c>`);
    const longest=s.split('\n').reduce((m,l)=>Math.max(m,l.length),0);widths[ci]=Math.max(widths[ci],Math.min(60,longest+2));
   });
   out.push(`<row r="${r}" spans="1:${Math.max(1,cols.length)}">${cells.join('')}</row>`);
  });
  const last=`${colName(Math.max(0,cols.length-1))}${rows.length+1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols.length?`<cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`:''}<sheetData>${out.join('')}</sheetData>${cols.length?`<autoFilter ref="A1:${last}"/>`:''}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
 };
 const names=[];const safeName=n=>{let s=String(n||'Sheet').replace(/[\\/?*[\]:]/g,' ').replace(/^'+|'+$/g,'').trim().slice(0,31)||'Sheet';let k=s,i=2;while(names.includes(k.toLowerCase()))k=`${s.slice(0,28)} (${i++})`;names.push(k.toLowerCase());return k;};
 const list=sheets.map(s=>({...s,title:safeName(s.name)}));
 const parts=list.map((s,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s)}));
 const files=[
  {name:'[Content_Types].xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`},
  {name:'_rels/.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
  {name:'xl/workbook.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${list.map((s,i)=>`<sheet name="${xmlText(s.title)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
  {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${list.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${list.length+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`},
  ...parts,
 ];
 files.push({name:'xl/styles.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${numFmts.length}">${numFmts.map(([id,code])=>`<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA6B8"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`});
 files.push({name:'xl/sharedStrings.xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s=>`<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('')}</sst>`});
 return zip(files);
}

// ------------------------------------------------------------------ reading
/**
 * Reads every worksheet: [{name, hidden, rows:[[cell…]], truncated, formulas_without_results}], each cell
 * {v: string|number|boolean|null, date?:'YYYY-MM-DD', error?:'#N/A', formula?:true, missing?:true (a formula without a
 * saved result)}. Rows and columns are as in Excel (row 1 = rows[0], column A = index 0); empty trailing cells are trimmed.
 */
export function readXlsx(buf,limits=READ_LIMITS){
 const pkg=unzip(buf,limits);
 const part=name=>{const b=pkg.read(name);return b?xmlOf(b,name):null;};
 const book=part('xl/workbook.xml');if(!book)refuse('This is not an Excel workbook (.xlsx). Save it as “Excel Workbook (*.xlsx)” and try again.');
 const rels=new Map();for(const r of elements(part('xl/_rels/workbook.xml.rels')||'','Relationship'))rels.set(attr(r.open,'Id'),attr(r.open,'Target'));
 const strings=[];const sstXml=part('xl/sharedStrings.xml');
 if(sstXml)for(const si of elements(sstXml,'si')){strings.push(textOf(si.body).slice(0,limits.text));if(strings.length>limits.cells)refuse('This workbook has too much text to import at once.');}
 // Which cell styles show dates.
 const dateStyles=new Set(),styles=part('xl/styles.xml');
 if(styles){
  const custom=new Map();for(const f of elements(styles,'numFmt'))custom.set(Number(attr(f.open,'numFmtId')),attr(f.open,'formatCode'));
  const xfsBlock=[...elements(styles,'cellXfs')][0];
  if(xfsBlock){let i=0;for(const xf of elements(xfsBlock.body,'xf')){const id=Number(attr(xf.open,'numFmtId')||0);if(BUILTIN_DATES.has(id)||(custom.has(id)&&isDateFormat(custom.get(id))))dateStyles.add(i);i++;}}
 }
 const sheets=[],parts=new Set();let cells=0,chars=0;
 for(const s of elements(book,'sheet')){
  if(sheets.length>=limits.sheets)refuse(`This workbook has more than ${limits.sheets} worksheets. Remove the ones you don’t need and try again.`);
  const name=attr(s.open,'name')||`Sheet ${sheets.length+1}`,state=attr(s.open,'state')||'visible',rid=attr(s.open,'r:id');
  let target=rels.get(rid)||'';target=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
  // Each worksheet has its own part: a workbook pointing several sheets at one part (to multiply its rows) is refused.
  if(target&&parts.has(target))refuse('This workbook is damaged (two worksheets share the same data). Save it again from Excel as a normal .xlsx file.');
  if(target)parts.add(target);
  const xml=target?part(target):null;
  const sheet={name,hidden:state!=='visible',rows:[],truncated:false,formulas_without_results:0,columns:0};
  if(!xml){sheets.push(sheet);continue;}
  const data=[...elements(xml,'sheetData')][0];
  if(data)for(const row of elements(data.body,'row')){
   // Rows go down the sheet: a missing, repeated or smaller row number is taken as the next row, so the row limit
   // always applies to the rows actually read.
   const r=Math.max(Number(attr(row.open,'r'))||0,sheet.rows.length+1);
   if(r>limits.rows+1){sheet.truncated=true;break;}
   const out=[];
   for(const c of elements(row.body,'c')){
    const ref=attr(c.open,'r'),ci=ref?colIndex(ref):out.length;if(ci>=limits.columns){sheet.truncated=true;continue;}
    const t=attr(c.open,'t')||'n',st=Number(attr(c.open,'s')||0),formula=c.body.includes('<f');
    const vEl=[...elements(c.body,'v')][0],raw=vEl?unesc(vEl.body):null;
    let cell;
    if(t==='s')cell={v:raw===null?null:strings[Number(raw)]??''};
    else if(t==='inlineStr')cell={v:textOf(c.body).slice(0,limits.text)};
    else if(t==='str')cell={v:raw};
    else if(t==='b')cell={v:raw===null?null:raw==='1'};
    else if(t==='e')cell={v:null,error:raw||'#VALUE!'};
    else if(t==='d')cell={v:raw,date:raw?raw.slice(0,10):undefined};
    else{const n=raw===null||raw===''?null:Number(raw);cell={v:Number.isFinite(n)?n:null};if(cell.v!==null&&dateStyles.has(st)){const day=serialToDay(cell.v);if(day)cell.date=day;}}
    if(formula){cell.formula=true;if((raw===null||raw==='')&&t!=='inlineStr'){cell={v:null,formula:true,missing:true};sheet.formulas_without_results++;}}
    if(cell.v===null&&!cell.error&&!cell.missing)continue;
    if(typeof cell.v==='string'&&(chars+=cell.v.length)>limits.chars)refuse(`This workbook holds more than ${limits.chars.toLocaleString('en-US')} characters of text, more than a group can hold. Import it in smaller parts.`);
    while(out.length<ci)out.push(null);out[ci]=cell;
    if(++cells>limits.cells)refuse(`This workbook has more than ${limits.cells.toLocaleString('en-US')} filled cells. Import it in smaller parts.`);
   }
   while(sheet.rows.length<r-1)sheet.rows.push([]);
   sheet.rows.push(out);sheet.columns=Math.max(sheet.columns,out.length);
  }
  sheets.push(sheet);
 }
 if(!sheets.length)refuse('This workbook has no worksheets.');
 return sheets;
}

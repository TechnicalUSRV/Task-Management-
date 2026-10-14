// V5.5: a local stand-in for the parts of Google used by the Groups ↔ Google Sheets connection (OAuth 2.0 with PKCE,
// Sheets API v4 values and spreadsheets, Drive API v3 file version and change notifications). It exists so the
// connection can be tested (automatically and by hand) without Google credentials. It is NOT Google: results against
// it say nothing about Google's real limits, latency or behaviour. Start it with
//     node local-test/google-fake.mjs            (port 4610, or GOOGLE_FAKE_PORT)
// and start the Task Controlling Management with the GOOGLE_* addresses it prints. Open http://127.0.0.1:4610/ to see and edit its
// spreadsheets in a browser (a plain table, standing in for Google Sheets).
import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const b64url=b=>Buffer.from(b).toString('base64url');
const colIndex=ref=>{let n=0;for(const ch of ref){n=n*26+(ch.charCodeAt(0)-64);}return n-1;};
const colName=i=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};
/** "'My sheet'!C5" → {title:'My sheet', row:4, col:2}; "'My sheet'" → {title, row:0, col:0, whole:true}. */
export function parseRange(range){
 let title,rest='';
 if(range.startsWith("'")){let i=1,t='';while(i<range.length){if(range[i]==="'"){if(range[i+1]==="'"){t+="'";i+=2;continue;}i++;break;}t+=range[i++];}title=t;rest=range.slice(i);}
 else{const bang=range.indexOf('!');title=bang<0?range:range.slice(0,bang);rest=bang<0?'':range.slice(bang);}
 if(!rest)return {title,row:0,col:0,whole:true};
 const m=/^!([A-Z]+)(\d+)/.exec(rest);if(!m)return {title,row:0,col:0,whole:true};
 return {title,row:Number(m[2])-1,col:colIndex(m[1]),whole:false};
}

export function createFakeGoogle({port=0,host='127.0.0.1',accessSeconds=3600}={}){
 const state={spreadsheets:new Map(),codes:new Map(),tokens:new Map(),refresh:new Map(),channels:new Map(),failures:[],calls:[],accounts:{email:'tester@example.test'},nextSheetId:1000,notifications:[]};
 const sheetOf=(ss,title)=>ss.sheets.find(s=>s.title===title);
 const touch=ss=>{ss.version++;ss.modifiedTime=new Date().toISOString();for(const ch of state.channels.values())if(ch.fileId===ss.id&&!ch.stopped)notify(ch,'update');};
 async function notify(ch,resourceState){
  ch.n=(ch.n||0)+1;state.notifications.push({channel:ch.id,state:resourceState,n:ch.n});
  try{await fetch(ch.address,{method:'POST',headers:{'X-Goog-Channel-ID':ch.id,'X-Goog-Channel-Token':ch.token,'X-Goog-Resource-State':resourceState,'X-Goog-Message-Number':String(ch.n),'X-Goog-Resource-ID':ch.resourceId,'X-Goog-Channel-Expiration':new Date(ch.expiration).toUTCString()}});}catch{}
 }
 const api={
  /** A spreadsheet as tests see it: cells are plain values, or {f:'=A1*2', v:computed}. */
  create(title,sheetTitle='Sheet1',owner=state.accounts.email){const id=b64url(randomBytes(24)).slice(0,44);const ss={id,title,owner,version:1,modifiedTime:new Date().toISOString(),trashed:false,sheets:[{sheetId:0,title:sheetTitle,grid:[]}]};state.spreadsheets.set(id,ss);return ss;},
  get:id=>state.spreadsheets.get(id),
  sheet(id,which=0){const ss=state.spreadsheets.get(id);return typeof which==='number'?ss.sheets.find(s=>s.sheetId===which)||ss.sheets[which]:ss.sheets.find(s=>s.title===which);},
  /** What someone would see in Google Sheets: values (formulas shown as their results). */
  values(id,which=0){return api.sheet(id,which).grid.map(r=>(r||[]).map(c=>c&&typeof c==='object'?c.v:c));},
  /** A person editing the sheet: set cells (row and column from 0) and the file's version moves on. */
  edit(id,cells,which=0){const ss=state.spreadsheets.get(id),sh=api.sheet(id,which);for(const [r,c,v] of cells){while(sh.grid.length<=r)sh.grid.push([]);const row=sh.grid[r];while(row.length<=c)row.push(null);row[c]=v;}touch(ss);},
  insertRow(id,at,values,which=0){const sh=api.sheet(id,which);sh.grid.splice(at,0,values);touch(state.spreadsheets.get(id));},
  deleteRow(id,at,which=0){const sh=api.sheet(id,which);sh.grid.splice(at,1);touch(state.spreadsheets.get(id));},
  /** Moves a whole column (for example to test that columns are found by their header, not their position). */
  moveColumn(id,from,to,which=0){const sh=api.sheet(id,which),w=Math.max(...sh.grid.map(r=>r.length),from+1,to+1);for(const r of sh.grid){while(r.length<w)r.push(null);const [x]=r.splice(from,1);r.splice(to,0,x);}touch(state.spreadsheets.get(id));},
  failNext(count,status=429){for(let i=0;i<count;i++)state.failures.push(status);},
  revokeAll(){for(const t of state.refresh.values())t.revoked=true;for(const t of state.tokens.values())t.revoked=true;},
  expireAccess(){for(const t of state.tokens.values())t.expires=0;},
  state,
 };
 const tokenOf=req=>{const m=/^Bearer (.+)$/.exec(String(req.headers.authorization||''));const t=m?state.tokens.get(m[1]):null;return t&&!t.revoked&&t.expires>Date.now()?t:null;};
 const server=http.createServer(async(req,res)=>{
  const send=(status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(typeof body==='string'?body:JSON.stringify(body));};
  const fail=(status,message,reason)=>send(status,{error:{code:status,message,status:reason||(status===401?'UNAUTHENTICATED':status===403?'PERMISSION_DENIED':status===404?'NOT_FOUND':status===429?'RESOURCE_EXHAUSTED':'INTERNAL')}});
  try{
   const u=new URL(req.url,'http://fake.invalid'),chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');
   const form=Object.fromEntries(new URLSearchParams(raw));let body={};try{body=raw&&req.headers['content-type']?.includes('json')?JSON.parse(raw):{};}catch{}
   state.calls.push({method:req.method,path:u.pathname,at:Date.now()});
   // ---- a browser page standing in for Google Sheets (local demonstration only)
   if(req.method==='GET'&&u.pathname==='/'){
    const list=[...state.spreadsheets.values()].map(ss=>`<li><a href="/sheet/${ss.id}">${esc(ss.title)}</a> · version ${ss.version}</li>`).join('')||'<li>No spreadsheets yet. Connect a group in the Task Controlling Management first.</li>';
    return send(200,page('Simulated Google Sheets',`<p class="note">This is a <b>local stand-in for Google</b>, used to test the Task Controlling Management’s Google Sheets connection without a Google account. It is not Google.</p><ul>${list}</ul>`),'text/html; charset=utf-8');
   }
   if(req.method==='GET'&&u.pathname.startsWith('/sheet/')){
    const ss=state.spreadsheets.get(u.pathname.slice(7));if(!ss)return send(404,'Not found','text/plain');
    const sh=ss.sheets[0],w=Math.max(4,...sh.grid.map(r=>r.length)),h=Math.max(sh.grid.length+3,6);
    let rows='';for(let r=0;r<h;r++){rows+=`<tr><th>${r+1}</th>`;for(let c=0;c<w;c++){const v=sh.grid[r]?.[c];const shown=v&&typeof v==='object'?v.f:v??'';rows+=`<td><form method="post" action="/sheet/${ss.id}/edit"><input type="hidden" name="r" value="${r}"><input type="hidden" name="c" value="${c}"><input name="v" value="${esc(shown)}" aria-label="${colName(c)}${r+1}"></form></td>`;}rows+='</tr>';}
    return send(200,page(ss.title,`<p class="note">Local stand-in for Google Sheets · version ${ss.version} · press Enter in a cell to save it · <a href="/sheet/${ss.id}">reload</a> · <a href="/">all spreadsheets</a></p><table><tr><th></th>${Array.from({length:w},(_,c)=>`<th>${colName(c)}</th>`).join('')}</tr>${rows}</table>`),'text/html; charset=utf-8');
   }
   if(req.method==='POST'&&/^\/sheet\/[^/]+\/edit$/.test(u.pathname)){
    const id=u.pathname.split('/')[2],v=form.v===''?null:/^-?\d+(\.\d+)?$/.test(form.v)?Number(form.v):form.v;
    api.edit(id,[[Number(form.r),Number(form.c),v]]);res.writeHead(303,{Location:`/sheet/${id}`});return res.end();
   }
   // ---- OAuth 2.0
   if(req.method==='GET'&&u.pathname==='/o/oauth2/v2/auth'){
    const q=Object.fromEntries(u.searchParams);
    if(!q.client_id||!q.redirect_uri||q.response_type!=='code'||q.code_challenge_method!=='S256'||!q.code_challenge)return send(400,'invalid_request','text/plain');
    const code=b64url(randomBytes(18));state.codes.set(code,{...q,at:Date.now()});
    const allow=`${q.redirect_uri}?${new URLSearchParams({code,state:q.state,scope:q.scope})}`,deny=`${q.redirect_uri}?${new URLSearchParams({error:'access_denied',state:q.state})}`;
    if(u.searchParams.get('auto')==='1'||process.env.GOOGLE_FAKE_AUTO_ALLOW==='1'){res.writeHead(302,{Location:allow});return res.end();}
    return send(200,page('Sign in · Simulated Google',`<p class="note">Local stand-in for Google’s consent screen. Nothing here reaches Google.</p><p><b>Task Controlling Management</b> wants to:</p><ul>${String(q.scope).split(' ').map(s=>`<li>${esc(s)}</li>`).join('')}</ul><p>Account: ${esc(state.accounts.email)}</p><p><a class="btn" id="allow" href="${esc(allow)}">Allow</a> <a href="${esc(deny)}">Cancel</a></p>`),'text/html; charset=utf-8');
   }
   if(req.method==='POST'&&u.pathname==='/token'){
    if(form.grant_type==='authorization_code'){
     const c=state.codes.get(form.code);state.codes.delete(form.code);
     if(!c||c.redirect_uri!==form.redirect_uri||c.client_id!==form.client_id)return send(400,{error:'invalid_grant',error_description:'Bad code or redirect URI.'});
     if(b64url(createHash('sha256').update(String(form.code_verifier||'')).digest())!==c.code_challenge)return send(400,{error:'invalid_grant',error_description:'PKCE verification failed.'});
     const access=b64url(randomBytes(24)),refresh=b64url(randomBytes(24));
     state.tokens.set(access,{email:state.accounts.email,scope:c.scope,expires:Date.now()+accessSeconds*1000});state.refresh.set(refresh,{email:state.accounts.email,scope:c.scope});
     return send(200,{access_token:access,expires_in:accessSeconds,refresh_token:refresh,scope:c.scope,token_type:'Bearer'});
    }
    if(form.grant_type==='refresh_token'){
     const r=state.refresh.get(form.refresh_token);if(!r||r.revoked)return send(400,{error:'invalid_grant',error_description:'Token has been expired or revoked.'});
     const access=b64url(randomBytes(24));state.tokens.set(access,{email:r.email,scope:r.scope,expires:Date.now()+accessSeconds*1000});
     return send(200,{access_token:access,expires_in:accessSeconds,scope:r.scope,token_type:'Bearer'});
    }
    return send(400,{error:'unsupported_grant_type'});
   }
   if(req.method==='POST'&&u.pathname==='/revoke'){const t=u.searchParams.get('token');const r=state.refresh.get(t)||state.tokens.get(t);if(r)r.revoked=true;return send(200,{});}
   // ---- the APIs (Bearer token required; injected failures first)
   if(state.failures.length&&/^\/(v4|drive|v1)/.test(u.pathname)){const status=state.failures.shift();return fail(status,status===429?'Quota exceeded for quota metric.':'Backend error');}
   const tk=tokenOf(req);
   if(/^\/(v4|drive|v1)/.test(u.pathname)&&!tk)return fail(401,'Request had invalid authentication credentials.');
   if(req.method==='GET'&&u.pathname==='/v1/userinfo')return send(200,{email:tk.email,email_verified:true,sub:'fake-'+tk.email});
   let m;
   if(req.method==='POST'&&u.pathname==='/v4/spreadsheets'){
    const ss=api.create(body.properties?.title||'Untitled spreadsheet',body.sheets?.[0]?.properties?.title||'Sheet1',tk.email);
    return send(200,{spreadsheetId:ss.id,properties:{title:ss.title},sheets:ss.sheets.map(s=>({properties:{sheetId:s.sheetId,title:s.title,index:0}}))});
   }
   if((m=/^\/v4\/spreadsheets\/([^/:]+)$/.exec(u.pathname))&&req.method==='GET'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss||ss.trashed)return fail(404,'Requested entity was not found.');
    if(ss.owner!==tk.email&&!tk.scope.includes('auth/spreadsheets'))return fail(403,'The caller does not have permission');
    return send(200,{spreadsheetId:ss.id,properties:{title:ss.title},sheets:ss.sheets.map((s,i)=>({properties:{sheetId:s.sheetId,title:s.title,index:i}}))});
   }
   if((m=/^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(u.pathname))&&req.method==='POST'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss)return fail(404,'Requested entity was not found.');
    for(const r of body.requests||[]){
     if(r.addSheet){ss.sheets.push({sheetId:state.nextSheetId++,title:r.addSheet.properties.title,grid:[]});}
     if(r.deleteDimension){const g=r.deleteDimension.range,sh=ss.sheets.find(s=>s.sheetId===g.sheetId);if(!sh)return fail(400,'No grid with id');if(g.dimension==='ROWS')sh.grid.splice(g.startIndex,g.endIndex-g.startIndex);}
    }
    touch(ss);return send(200,{spreadsheetId:ss.id,replies:[]});
   }
   if((m=/^\/v4\/spreadsheets\/([^/:]+)\/values\/(.+)$/.exec(u.pathname))&&req.method==='GET'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss)return fail(404,'Requested entity was not found.');
    const range=parseRange(decodeURIComponent(m[2])),sh=sheetOf(ss,range.title);if(!sh)return fail(400,`Unable to parse range: ${range.title}`);
    const formula=u.searchParams.get('valueRenderOption')==='FORMULA';
    // Like Google: trailing empty cells and rows are left out.
    const rows=sh.grid.map(r=>{const out=(r||[]).map(c=>c===null||c===undefined?'':c&&typeof c==='object'?(formula?c.f:c.v):c);while(out.length&&out.at(-1)==='')out.pop();return out;});
    while(rows.length&&!rows.at(-1).length)rows.pop();
    return send(200,{range:`'${range.title}'!A1:${colName(Math.max(0,...rows.map(r=>r.length))-1||0)}${rows.length||1}`,majorDimension:'ROWS',...(rows.length?{values:rows}:{})});
   }
   if((m=/^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/.exec(u.pathname))&&req.method==='POST'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss)return fail(404,'Requested entity was not found.');
    if(body.valueInputOption!=='RAW')return fail(400,'This stand-in accepts RAW values only.');
    for(const d of body.data||[]){const range=parseRange(d.range),sh=sheetOf(ss,range.title);if(!sh)return fail(400,`Unable to parse range: ${range.title}`);
     (d.values||[]).forEach((line,i)=>{const r=range.row+i;while(sh.grid.length<=r)sh.grid.push([]);const row=sh.grid[r];line.forEach((v,j)=>{const c=range.col+j;while(row.length<=c)row.push(null);if(v!==null)row[c]=v===''?null:v;});});}
    touch(ss);return send(200,{spreadsheetId:ss.id,totalUpdatedCells:(body.data||[]).reduce((n,d)=>n+(d.values||[]).flat().length,0)});
   }
   if((m=/^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))&&req.method==='GET'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss)return fail(404,'File not found.');
    if(ss.owner!==tk.email)return fail(404,'File not found.');// drive.file: only files this app created
    return send(200,{id:ss.id,name:ss.title,version:String(ss.version),modifiedTime:ss.modifiedTime,trashed:ss.trashed});
   }
   if((m=/^\/drive\/v3\/files\/([^/]+)\/watch$/.exec(u.pathname))&&req.method==='POST'){
    const ss=state.spreadsheets.get(decodeURIComponent(m[1]));if(!ss)return fail(404,'File not found.');
    if(body.type!=='web_hook'||!/^https:\/\//.test(body.address||'')&&!/^http:\/\/127\.0\.0\.1/.test(body.address||''))return fail(400,'Invalid address');
    const ch={id:body.id,token:body.token,address:body.address,fileId:ss.id,resourceId:b64url(randomBytes(9)),expiration:Math.min(Number(body.expiration)||Date.now()+3600000,Date.now()+86400000),n:0};
    state.channels.set(ch.id,ch);setTimeout(()=>void notify(ch,'sync'),10);
    return send(200,{kind:'api#channel',id:ch.id,resourceId:ch.resourceId,resourceUri:`/drive/v3/files/${ss.id}`,expiration:String(ch.expiration)});
   }
   if(u.pathname==='/drive/v3/channels/stop'&&req.method==='POST'){const ch=state.channels.get(body.id);if(ch)ch.stopped=true;res.writeHead(204);return res.end();}
   return fail(404,'Not found');
  }catch(e){send(500,{error:{code:500,message:e.message}});}
 });
 return new Promise(resolve=>server.listen(port,host,()=>{
  const base=`http://${host}:${server.address().port}`;
  resolve({server,base,api,env:{GOOGLE_OAUTH_AUTH_URL:`${base}/o/oauth2/v2/auth`,GOOGLE_OAUTH_TOKEN_URL:`${base}/token`,GOOGLE_OAUTH_REVOKE_URL:`${base}/revoke`,GOOGLE_USERINFO_URL:`${base}/v1/userinfo`,GOOGLE_SHEETS_API:`${base}/v4`,GOOGLE_DRIVE_API:`${base}/drive/v3`},close:()=>new Promise(r=>server.close(()=>r()))});
 }));
}
const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const page=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#1f2937}.note{background:#fff7e6;border:1px solid #f0c36d;padding:8px 12px;border-radius:8px}table{border-collapse:collapse}td,th{border:1px solid #d1d5db;padding:0}th{background:#f3f4f6;padding:4px 8px;font-weight:600}td input{border:0;padding:6px 8px;width:150px;font:inherit}.btn{background:#1a73e8;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const fake=await createFakeGoogle({port:Number(process.env.GOOGLE_FAKE_PORT||4610)});
 console.log(`Simulated Google (local stand-in, not Google) at ${fake.base}\nStart the Task Controlling Management with:\n${Object.entries(fake.env).map(([k,v])=>`  ${k}=${v}`).join('\n')}\nIn Administration → Google Sheets, enter any client ID and secret (for example local-test / local-secret).`);
}

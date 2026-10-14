// V5.5: the small part of Google's public APIs the Groups ↔ Google Sheets connection uses: OAuth 2.0 (authorization code
// with PKCE, refresh, revoke), the Sheets API v4 (spreadsheets and values) and the Drive API v3 (a file's version, and
// change notifications). Only official endpoints are called. Every address can be changed with an environment
// variable, so the automated tests and the local demonstration run against a local stand-in (google-fake.mjs) and
// never reach Google.
//
// Quotas (https://developers.google.com/workspace/sheets/api/limits): 300 requests per minute per project and 60 per
// minute per user, for reads and for writes. Requests here are spaced per Google account (at most 50 a minute), and a
// 429 or 5xx answer is retried with exponential backoff (1, 2, 4, 8… seconds plus up to 1 s of random delay, at most
// 64 s), as Google recommends.
import {randomBytes,createHash} from 'node:crypto';

export const GOOGLE={
 auth:()=>process.env.GOOGLE_OAUTH_AUTH_URL||'https://accounts.google.com/o/oauth2/v2/auth',
 token:()=>process.env.GOOGLE_OAUTH_TOKEN_URL||'https://oauth2.googleapis.com/token',
 revoke:()=>process.env.GOOGLE_OAUTH_REVOKE_URL||'https://oauth2.googleapis.com/revoke',
 userinfo:()=>process.env.GOOGLE_USERINFO_URL||'https://openidconnect.googleapis.com/v1/userinfo',
 sheets:()=>process.env.GOOGLE_SHEETS_API||'https://sheets.googleapis.com/v4',
 drive:()=>process.env.GOOGLE_DRIVE_API||'https://www.googleapis.com/drive/v3',
 simulated:()=>!!process.env.GOOGLE_OAUTH_AUTH_URL&&/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.GOOGLE_OAUTH_AUTH_URL),
};
// drive.file (non-sensitive): spreadsheets this app creates. spreadsheets (sensitive): any spreadsheet the person can
// open, needed only to connect an existing spreadsheet by its address. openid email: which Google account connected.
export const SCOPES={base:['openid','email','https://www.googleapis.com/auth/drive.file'],existing:'https://www.googleapis.com/auth/spreadsheets'};

export class GoogleError extends Error{
 constructor(message,{status=502,code='google',retry=false,revoked=false,google=null}={}){super(message);this.status=status;this.code=code;this.retry=retry;this.revoked=revoked;this.google=google;}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const pkce=()=>{const verifier=randomBytes(48).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};};

/** The address that asks the person to allow access (authorization code flow with PKCE, offline access for a refresh token). */
export function authUrl({clientId,redirectUri,state,challenge,existing=false,email=''}){
 const u=new URL(GOOGLE.auth());
 u.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:[...SCOPES.base,...(existing?[SCOPES.existing]:[])].join(' '),
  access_type:'offline',prompt:'consent',include_granted_scopes:'true',state,code_challenge:challenge,code_challenge_method:'S256',...(email?{login_hint:email}:{})}).toString();
 return u.toString();
}

// Requests per Google account in the last minute (kept in memory; one Task Controlling Management process). GOOGLE_REQUESTS_PER_MINUTE can lower
// it (or raise it for the local stand-in in the automated tests); Google's own limit is 60 per minute per user.
const recent=new Map();
const perMinute=()=>Math.max(1,Number(process.env.GOOGLE_REQUESTS_PER_MINUTE)||50);
async function pace(account){
 if(!account)return;
 const now=Date.now(),list=(recent.get(account)||[]).filter(t=>now-t<60000);
 // (The wait does not keep the process alive by itself: the Task Controlling Management's server does.)
 if(list.length>=perMinute()){await new Promise(r=>setTimeout(r,60000-(now-list[0])+50).unref?.());return pace(account);}
 list.push(now);recent.set(account,list);
}
/** One request with retries: 429 and 5xx (and network errors) are retried up to `tries` times with backoff. */
export async function call(url,{method='GET',token,body,form,account,tries=5,timeout=30000}={}){
 for(let attempt=0;;attempt++){
  await pace(account);
  let r,text;
  try{
   const headers={Accept:'application/json'};
   if(token)headers.Authorization=`Bearer ${token}`;
   let payload;
   if(form){headers['Content-Type']='application/x-www-form-urlencoded';payload=new URLSearchParams(form).toString();}
   else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
   r=await fetch(url,{method,headers,body:payload,signal:AbortSignal.timeout(timeout)});
   text=await r.text();
  }catch(e){
   if(attempt+1<tries){await sleep(backoff(attempt));continue;}
   throw new GoogleError(`Google could not be reached (${e.cause?.code||e.name||'network error'}). The sync will try again.`,{status:503,code:'network',retry:true});
  }
  let data=null;try{data=text?JSON.parse(text):null;}catch{data=null;}
  if(r.ok)return data??{};
  const reason=data?.error?.status||data?.error?.errors?.[0]?.reason||(typeof data?.error==='string'?data.error:'')||'';
  const message=data?.error?.message||data?.error_description||`HTTP ${r.status}`;
  if((r.status===429||r.status>=500)&&attempt+1<tries){await sleep(backoff(attempt,r.headers.get('retry-after')));continue;}
  if(r.status===429)throw new GoogleError('Google’s request limit was reached. The sync will try again in a minute.',{status:429,code:'quota',retry:true,google:message});
  if(r.status>=500)throw new GoogleError('Google is not answering properly right now. The sync will try again.',{status:503,code:'unavailable',retry:true,google:message});
  if(r.status===400&&reason==='invalid_grant')throw new GoogleError('Google access was revoked or has expired. Connect Google again.',{status:401,code:'revoked',revoked:true,google:message});
  if(r.status===401)throw new GoogleError('Google did not accept the sign-in. Connect Google again.',{status:401,code:'unauthorized',revoked:true,google:message});
  if(r.status===403)throw new GoogleError(/insufficient|scope/i.test(message+reason)?'This Google connection does not allow that (missing permission). Connect Google again and allow access.':'Google refused access to this spreadsheet. Check that the connected Google account can still edit it.',{status:403,code:/insufficient|scope/i.test(message+reason)?'scope':'forbidden',google:message});
  if(r.status===404)throw new GoogleError('The spreadsheet (or the worksheet) was not found. It may have been deleted, or the connected Google account lost access to it.',{status:404,code:'not_found',google:message});
  throw new GoogleError(`Google answered: ${message}`,{status:502,code:'google',google:message});
 }
}
export const backoff=(attempt,retryAfter=null)=>{
 const after=Number(retryAfter);if(Number.isFinite(after)&&after>0&&after<120)return after*1000;
 return Math.min(2**attempt*1000+Math.floor(Math.random()*1000),64000);
};

// ---------------------------------------------------------------- OAuth
export const exchangeCode=({code,verifier,clientId,clientSecret,redirectUri})=>call(GOOGLE.token(),{method:'POST',form:{code,code_verifier:verifier,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code'},tries:2});
export const refreshToken=({refresh,clientId,clientSecret,account})=>call(GOOGLE.token(),{method:'POST',form:{refresh_token:refresh,client_id:clientId,client_secret:clientSecret,grant_type:'refresh_token'},account,tries:3});
export const userInfo=token=>call(GOOGLE.userinfo(),{token,tries:2});
export const revoke=token=>call(`${GOOGLE.revoke()}?token=${encodeURIComponent(token)}`,{method:'POST',form:{},tries:1}).catch(()=>null);

// ---------------------------------------------------------------- Sheets and Drive
const enc=encodeURIComponent;
/** A whole worksheet range in A1 notation; sheet titles are always quoted (quotes doubled), as the API requires. */
export const sheetRange=(title,range='')=>`'${String(title).replaceAll("'","''")}'${range?'!'+range:''}`;
export const createSpreadsheet=(token,title,sheetTitle,account)=>call(`${GOOGLE.sheets()}/spreadsheets`,{method:'POST',token,account,body:{properties:{title},sheets:[{properties:{title:sheetTitle}}]}});
export const getSpreadsheet=(token,id,account)=>call(`${GOOGLE.sheets()}/spreadsheets/${enc(id)}?fields=${enc('spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties)')}`,{token,account});
export const addSheet=(token,id,title,account)=>call(`${GOOGLE.sheets()}/spreadsheets/${enc(id)}:batchUpdate`,{method:'POST',token,account,body:{requests:[{addSheet:{properties:{title}}}]}});
/** Values of one worksheet. render: UNFORMATTED_VALUE (numbers as numbers, dates as serial numbers) or FORMULA. */
export const getValues=(token,id,title,render,account)=>call(`${GOOGLE.sheets()}/spreadsheets/${enc(id)}/values/${enc(sheetRange(title))}?majorDimension=ROWS&valueRenderOption=${render}${render==='FORMULA'?'':'&dateTimeRenderOption=SERIAL_NUMBER'}`,{token,account});
/** Writes cells; RAW keeps text as text (a value starting with “=” is never turned into a formula). */
export const writeValues=(token,id,data,account)=>data.length?call(`${GOOGLE.sheets()}/spreadsheets/${enc(id)}/values:batchUpdate`,{method:'POST',token,account,body:{valueInputOption:'RAW',data}}):Promise.resolve({});
export const deleteRows=(token,id,sheetId,rowIndexes,account)=>{
 if(!rowIndexes.length)return Promise.resolve({});
 // Bottom-up, so the row numbers of the remaining deletions stay valid.
 const requests=[...rowIndexes].sort((a,b)=>b-a).map(i=>({deleteDimension:{range:{sheetId,dimension:'ROWS',startIndex:i,endIndex:i+1}}}));
 return call(`${GOOGLE.sheets()}/spreadsheets/${enc(id)}:batchUpdate`,{method:'POST',token,account,body:{requests}});
};
export const fileVersion=(token,id,account)=>call(`${GOOGLE.drive()}/files/${enc(id)}?fields=id,name,version,modifiedTime,trashed&supportsAllDrives=true`,{token,account,tries:3});
export const watchFile=(token,id,{channelId,address,secret,expiration},account)=>call(`${GOOGLE.drive()}/files/${enc(id)}/watch?supportsAllDrives=true`,{method:'POST',token,account,body:{id:channelId,type:'web_hook',address,token:secret,expiration:String(expiration)}});
export const stopChannel=(token,channelId,resourceId,account)=>call(`${GOOGLE.drive()}/channels/stop`,{method:'POST',token,account,body:{id:channelId,resourceId},tries:2}).catch(()=>null);

/** Spreadsheet ID and worksheet (gid) from an address such as https://docs.google.com/spreadsheets/d/<id>/edit#gid=0. */
export function parseSheetUrl(input){
 const s=String(input||'').trim();
 const m=/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,100})/.exec(s)||/^([a-zA-Z0-9-_]{20,100})$/.exec(s);
 if(!m)return null;
 const gid=/[#&?]gid=(\d+)/.exec(s);
 return {spreadsheetId:m[1],sheetId:gid?Number(gid[1]):null};
}

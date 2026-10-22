import { getLanguage, getLanguageRevision, receiveLanguage } from './i18n';
// Every request and download keeps the company in its URL. Separate tabs cannot
// silently send a write to whichever company was selected most recently.
export const currentCompany=()=>typeof window==='undefined'?'default':/^\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(window.location.pathname)?.[1]||'default';
// Where the API is: VITE_API_BASE_URL at build time (see .env.example), for example https://tasks-api.example.com.
// Empty (the default) means the origin that served this page: Django serving the built app, or the Vite dev server,
// which proxies /c/<company>/api to Django. The browser never talks to the database, only to this API.
export const API_BASE=(import.meta.env?.VITE_API_BASE_URL||'').trim().replace(/\/+$/,'');
export const apiPath=(path:string)=>path.startsWith('/api/')?`${API_BASE}/c/${currentCompany()}${path}`:path;
// A separate API origin needs the session cookie sent along (the API answers only origins it trusts).
export const apiFetch=async(url:string,options?:RequestInit)=>{
  const revision=getLanguageRevision(), headers=new Headers(options?.headers); headers.set('X-App-Language',getLanguage());
  const response=await fetch(apiPath(url),{credentials:API_BASE?'include':'same-origin',...options,headers});
  receiveLanguage(response,revision); return response;
};
export const openCompany=(id:string)=>{window.location.href=`/c/${encodeURIComponent(id)}/`;};

/** crypto.randomUUID() requires a secure context (HTTPS or localhost).  Office LAN
 *  addresses like http://192.168.x.x are insecure, so the call throws.  This helper
 *  falls back to crypto.getRandomValues(), which works everywhere. */
export const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* insecure context */ }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

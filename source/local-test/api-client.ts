// Every request and download keeps the company in its URL. Separate tabs cannot
// silently send a write to whichever company was selected most recently.
export const currentCompany=()=>typeof window==='undefined'?'default':/^\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(window.location.pathname)?.[1]||'default';
// Where the API is: VITE_API_BASE_URL at build time (see .env.example), for example https://tasks-api.example.com.
// Empty (the default) means the origin that served this page: Django serving the built app, or the Vite dev server,
// which proxies /c/<company>/api to Django. The browser never talks to the database, only to this API.
export const API_BASE=(import.meta.env?.VITE_API_BASE_URL||'').trim().replace(/\/+$/,'');
export const apiPath=(path:string)=>path.startsWith('/api/')?`${API_BASE}/c/${currentCompany()}${path}`:path;
// A separate API origin needs the session cookie sent along (the API answers only origins it trusts).
export const apiFetch=(url:string,options?:RequestInit)=>fetch(apiPath(url),{credentials:API_BASE?'include':'same-origin',...options});
export const openCompany=(id:string)=>{window.location.href=`/c/${encodeURIComponent(id)}/`;};

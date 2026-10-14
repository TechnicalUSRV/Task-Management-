// Every request and download keeps the company in its URL. Separate tabs cannot
// silently send a write to whichever company was selected most recently.
export const currentCompany=()=>typeof window==='undefined'?'default':/^\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(window.location.pathname)?.[1]||'default';
export const apiPath=(path:string)=>path.startsWith('/api/')?`/c/${currentCompany()}${path}`:path;
export const apiFetch=(url:string,options?:RequestInit)=>fetch(apiPath(url),options);
export const openCompany=(id:string)=>{window.location.href=`/c/${encodeURIComponent(id)}/`;};

import { uiText, useLanguage } from "./i18n";
import {apiFetch} from './api-client';
import {useEffect,useState} from 'react';
import type {Row} from './components';

/**
 * Loads a server-computed report. While a new version loads, the previous report
 * stays on screen (marked as loading) so the layout does not jump.
 */
export function useServerReport(url:string,refreshKey:unknown){
 const language=useLanguage();
 const [report,setReport]=useState<Row>({rows:[],columns:[],totals:{},groups:[],title:uiText("Loading report…")}),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{
  const controller=new AbortController();setError('');setLoading(true);
  void apiFetch(url,{signal:controller.signal}).then(async r=>{const d=await r.json() as Row;if(!r.ok){if(r.status===401)window.dispatchEvent(new Event('session-expired'));throw new Error(d.error||uiText("Unable to load report."));}setReport(d);setLoading(false);})
   .catch(e=>{if(e.name!=='AbortError'){setError(e.message);setLoading(false);setReport({rows:[],columns:[],totals:{},groups:[],title:uiText("Report unavailable")});}});
  return()=>controller.abort();
 },[url,refreshKey,language]);
 return {report,error,loading};
}

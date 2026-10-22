import { uiText, useLanguage } from "./i18n";
type Props={frequency:string;value:any;due:string;disabled?:boolean;onChange:(v:any)=>void};
export function RecurrenceFields({frequency,value,due,disabled,onChange}:Props){
  useLanguage();
 let r:any={};try{r=typeof value==='string'?JSON.parse(value):value||{};}catch{}
 if(!frequency)return null;
 const set=(patch:any)=>onChange({...r,...patch});
 const days=r.weekdays||[new Date((due||'2000-01-01')+'T12:00:00Z').getUTCDay()];
 return <div className="span-2 stack-sm recurrence-fields"><label className="field"><span className="field-label">{uiText("Repeat every")}</span><input className="input" aria-label={uiText("Repeat interval")} type="number" min="1" max="365" value={r.interval??1} disabled={disabled} onChange={e=>set({interval:Number(e.target.value)})}/><small>{frequency==='MONTHLY'?uiText("month(s)"):frequency==='WEEKLY'?uiText("week(s)"):frequency==='WEEKDAYS'?uiText("working day(s)"):uiText("day(s)")}</small></label>
 {frequency==='WEEKLY'&&<fieldset disabled={disabled}><legend className="field-label">{uiText("On weekdays")}</legend><div className="row">{[uiText("Sun"),uiText("Mon"),uiText("Tue"),uiText("Wed"),uiText("Thu"),uiText("Fri"),uiText("Sat")].map((day,i)=><label key={day} className="check-row"><input type="checkbox" checked={days.includes(i)} onChange={e=>set({weekdays:e.target.checked?[...days,i]:days.filter((n:number)=>n!==i)})}/>{day}</label>)}</div></fieldset>}
 {frequency==='MONTHLY'&&<label className="field"><span className="field-label">{uiText("Day of month")}</span><input className="input" aria-label={uiText("Day of month")} type="number" min="1" max="31" disabled={disabled} value={r.month_day??Number(due?.slice(8)||1)} onChange={e=>set({month_day:Number(e.target.value)})}/><small>{uiText("Shorter months use their last day.")}</small></label>}
 <p className="muted small">{uiText("The next task is created when this occurrence is closed. Past dates are skipped; a series creates each next occurrence once.")}</p></div>;
}

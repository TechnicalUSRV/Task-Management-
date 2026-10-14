type Props={frequency:string;value:any;due:string;disabled?:boolean;onChange:(v:any)=>void};
export function RecurrenceFields({frequency,value,due,disabled,onChange}:Props){
 let r:any={};try{r=typeof value==='string'?JSON.parse(value):value||{};}catch{}
 if(!frequency)return null;
 const set=(patch:any)=>onChange({...r,...patch});
 const days=r.weekdays||[new Date((due||'2000-01-01')+'T12:00:00Z').getUTCDay()];
 return <div className="span-2 stack-sm recurrence-fields"><label className="field"><span className="field-label">Repeat every</span><input className="input" aria-label="Repeat interval" type="number" min="1" max="365" value={r.interval??1} disabled={disabled} onChange={e=>set({interval:Number(e.target.value)})}/><small>{frequency==='MONTHLY'?'month(s)':frequency==='WEEKLY'?'week(s)':frequency==='WEEKDAYS'?'working day(s)':'day(s)'}</small></label>
 {frequency==='WEEKLY'&&<fieldset disabled={disabled}><legend className="field-label">On weekdays</legend><div className="row">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,i)=><label key={day} className="check-row"><input type="checkbox" checked={days.includes(i)} onChange={e=>set({weekdays:e.target.checked?[...days,i]:days.filter((n:number)=>n!==i)})}/>{day}</label>)}</div></fieldset>}
 {frequency==='MONTHLY'&&<label className="field"><span className="field-label">Day of month</span><input className="input" aria-label="Day of month" type="number" min="1" max="31" disabled={disabled} value={r.month_day??Number(due?.slice(8)||1)} onChange={e=>set({month_day:Number(e.target.value)})}/><small>Shorter months use their last day.</small></label>}
 <p className="muted small">The next task is created when this occurrence is closed. Past dates are skipped; a series creates each next occurrence once.</p></div>;
}

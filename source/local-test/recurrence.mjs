const add=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const weekday=d=>new Date(d+'T12:00:00Z').getUTCDay();
const diff=(a,b)=>Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/86400000);
const week=d=>add(d,-((weekday(d)+6)%7));
export function normalizeRule(frequency,value,anchor) {
 if(!frequency)return {};
 if(!['DAILY','WEEKDAYS','WEEKLY','MONTHLY'].includes(frequency))throw new Error('Choose a repeat frequency.');
 let r=value||{};if(typeof r==='string'){try{r=JSON.parse(r);}catch{throw new Error('Invalid repeat schedule.');}}
 if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('Invalid repeat schedule.');
 const interval=Number(r.interval??1);if(!Number.isInteger(interval)||interval<1||interval>365)throw new Error('Repeat interval must be a whole number from 1 to 365.');
 const out={interval,anchor:r.anchor||anchor};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(out.anchor)||new Date(out.anchor+'T12:00:00Z').toISOString().slice(0,10)!==out.anchor)throw new Error('Invalid repeat anchor.');
 if(frequency==='WEEKLY'){
  const days=r.weekdays??[weekday(anchor)];if(!Array.isArray(days)||!days.length||days.some(x=>!Number.isInteger(x)||x<0||x>6))throw new Error('Select at least one weekday.');
  out.weekdays=[...new Set(days)].sort();
 }
 if(frequency==='MONTHLY'){
  out.month_day=Number(r.month_day??anchor.slice(8));if(!Number.isInteger(out.month_day)||out.month_day<1||out.month_day>31)throw new Error('Month day must be from 1 to 31.');
 }
 return out;
}
export function scheduledNext(frequency,from,anchorDay,value) {
 const r=normalizeRule(frequency,value,from);if(!frequency)return null;
 if(frequency==='DAILY')return add(from,r.interval);
 if(frequency==='WEEKDAYS'){let d=from,n=0;while(n<r.interval){d=add(d,1);if(![0,6].includes(weekday(d)))n++;}return d;}
 if(frequency==='WEEKLY'){
  for(let i=1;i<=7*r.interval+7;i++){const d=add(from,i),weeks=Math.floor(diff(week(d),week(r.anchor))/7);if(weeks>=0&&weeks%r.interval===0&&r.weekdays.includes(weekday(d)))return d;}
 }
 if(frequency==='MONTHLY'){
  const [y,m]=from.split('-').map(Number),[ay,am]=r.anchor.split('-').map(Number),origin=ay*12+am-1;
  for(let i=0;i<=r.interval+1;i++){const idx=y*12+m-1+i;if((idx-origin)%r.interval)continue;const yy=Math.floor(idx/12),mm=idx%12+1,last=new Date(Date.UTC(yy,mm,0)).getUTCDate(),d=`${yy}-${String(mm).padStart(2,'0')}-${String(Math.min(r.month_day||anchorDay,last)).padStart(2,'0')}`;if(d>from)return d;}
 }
 throw new Error('Unable to calculate next occurrence.');
}

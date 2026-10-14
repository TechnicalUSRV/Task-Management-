const add=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export function timeRange(mode,anchor,from=anchor,to=anchor){
 if(mode==='rolling')return {from:add(anchor,-7),to:anchor}; // eight inclusive calendar dates
 if(mode==='week'){const day=new Date(anchor+'T12:00:00Z').getUTCDay(),start=add(anchor,-((day+6)%7));return {from:start,to:add(start,6)};}
 if(mode==='month'){const [y,m]=anchor.split('-').map(Number);return {from:anchor.slice(0,7)+'-01',to:new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10)};}
 return {from,to};
}
export function rangeDays({from,to},max=31){if(!from||!to||to<from)return [];const n=Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000)+1;return n>max?[]:Array.from({length:n},(_,i)=>add(from,i));}

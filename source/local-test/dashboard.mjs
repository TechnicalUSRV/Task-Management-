import {ERP_MODULES} from './erp-registry.mjs';
import {dataCatalog,authorizedRecords,filterRecords,validateFilters} from './erp-sources.mjs';
import {allowed} from './access-catalog.mjs';

// Widget data and drill-down filters are produced together, so charts and
// destination records always use the same selection and permission boundary.
export function buildDashboard(store,user,input={}){
 store.access.requirePermission(user,'dashboard');
 const filters=validateFilters(input),sources=dataCatalog(store,user),sourceIds=new Set(sources.map(s=>s.id)),permissions=store.access.permissions(user);
 const records=filterRecords(authorizedRecords(store,user,[...sourceIds]),filters),widgets=[];
 for(const module of ERP_MODULES){
  if(!store.access.moduleEnabled(module.id)||filters.modules.length&&!filters.modules.includes(module.id))continue;
  const definitions=module.widgets.length?module.widgets:module.sources.map(source=>({id:module.id+'-'+source,kind:'kpi',title:sources.find(s=>s.id===source)?.label,source,metric:'count'}));
  for(const widget of definitions){
   if(!sourceIds.has(widget.source))continue;
   let rows=records.filter(r=>r.source===widget.source);
   if(widget.status)rows=rows.filter(r=>widget.status.includes(r.status));
   if(widget.exclude)rows=rows.filter(r=>!widget.exclude.includes(r.status));
   if(widget.assignee==='current')rows=rows.filter(r=>r.assignee===user.staff_id&&allowed(permissions,r.resource,'approve'));
   const statuses=[...new Set(rows.map(r=>r.status))];
   // For empty counts retain the defined statuses, not an unfiltered list.
   const drill={...filters,sources:[widget.source],statuses:widget.status?(filters.statuses.length?widget.status.filter(s=>filters.statuses.includes(s)):widget.status):((widget.exclude)?statuses:filters.statuses),...(widget.assignee==='current'?{assignees:[user.staff_id]}:{})};
   if((widget.exclude||widget.status)&&!rows.length)drill.statuses=['__NONE__'];
   if(widget.assignee==='current'){drill.categories=[...new Set(rows.map(r=>r.category))];if(!drill.categories.length)drill.categories=['__NONE__'];}
   const base={...widget,module:module.id,module_label:module.label,count:rows.length,dateLabel:sources.find(s=>s.id===widget.source).dateLabel,drill};
   if(widget.kind==='kpi')widgets.push({...base,value:widget.metric==='amount'?rows.reduce((n,r)=>n+(r.amount_cents||0),0):widget.metric==='minutes'?rows.reduce((n,r)=>n+(r.minutes||0),0):rows.length});
   else if(widget.kind==='bar')widgets.push({...base,bars:[...new Set(rows.map(r=>r[widget.group]))].sort().map(label=>({label:label||'Unspecified',value:rows.filter(r=>r[widget.group]===label).length,drill:{...drill,[widget.group==='category'?'categories':'statuses']:[label]}}))});
   else widgets.push({...base,rows:rows.sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')).slice(0,widget.limit||5)});
  }
 }
 const scoped=store.access.filterState(store.state(),user),notifications=scoped.ops_notifications.filter(n=>!n.read_at&&!n.resolved_at).map(n=>({...n,target:{type:'operations',id:n.request_id}})).slice(0,8);
 const sourceResource={contact:'crm.contacts',lead:'crm.leads',opportunity:'crm.opportunities',quotation:'crm.quotations',account:'crm.accounts',activity:'crm.activities',campaign:'crm.campaigns'};
 const recent=[...scoped.events.filter(e=>sourceResource[e.entity_type]).map(e=>({...e,target:{type:e.entity_type,id:e.entity_id}})),...scoped.tm_events.map(e=>({...e,target:{type:{task:'tm_task',meeting:'tm_meeting',timesheet:'tm_time',workspace:'tm_workspace',user:'tm_profile'}[e.entity_type],id:e.entity_id}})),...scoped.ops_events.map(e=>({...e,target:{type:'operations',id:e.entity_id}}))].filter(e=>e.target.type).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,8);
 return {generated_at:new Date().toISOString(),widgets,notifications,recent,filters,modules:ERP_MODULES.filter(m=>sources.some(s=>s.module===m.id)).map(m=>({id:m.id,label:m.label})),sources,summary:{sources:sources.length,modules:new Set(sources.map(s=>s.module)).size,records:records.length}};
}

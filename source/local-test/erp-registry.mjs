// One registration point for Task Controlling Management functions, dashboard contributors and report sources.
// New modules register descriptors here and row providers in erp-sources.mjs.
const BASE_FUNCTIONS=[
 ['dashboard','Dashboard',['view']],
 ['crm.contacts','CRM · Contacts',['view','create','update']],
 ['crm.campaigns','CRM · Campaigns',['view','create','update']],
 ['crm.leads','CRM · Leads',['view','create','update']],
 ['crm.opportunities','CRM · Opportunities',['view','create','update']],
 ['crm.quotations','CRM · Quotations',['view','create','update','approve','export']],
 ['crm.accounts','CRM · Business Accounts',['view','update']],
 ['crm.activities','CRM · Activities',['view','create','update']],
 ['crm.documents','CRM · Document links',['view','create']],
 ['tasks.organization','Task Management · Organizational Structure',['view','create']],
 ['tasks.workspace','Task Management · Workspace',['view','create','update','delete']],
 ['tasks.users','Task Management · Users',['view','create','update']],
 ['tasks.tasks','Task Management · Tasks',['view','create','update','approve']],
 // V5.5: see every task of the company (for example an executive director). Without it people see the tasks they are
 // on and, through reporting lines, the tasks of the people who report to them. Seeing never grants changing.
 ['tasks.company','Task Management · All company tasks',['view']],
 // V5.4 Groups: Approve = group administrator (can open and manage every Team group); Delete covers rows, columns and archiving.
 ['tasks.groups','Task Management · Groups',['view','create','update','delete','approve','export']],
 ['tasks.timesheets','Task Management · Timesheets',['view','create','update','delete']],
 ['tasks.meetings','Task Management · Meetings',['view','create','update']],
 ['tasks.reports','Task Management · Reports',['view','export']],
 ['ops.quotation','Operations · Quotation',['view','create','update','approve','export']],
 ['ops.po','Operations · Purchase Order',['view','create','update','approve','export']],
 ['ops.job','Operations · Job File',['view','create','update','approve','export']],
 ['ops.dn','Operations · Debit Note',['view','create','update','approve','export']],
 ['ops.pr','Operations · Payment Request',['view','create','update','approve','export']],
 ['ops.finance','Operations · Finance registers',['view','update','approve']],
 ['ops.legacy','Operations · Earlier sales handoffs',['view','create','update']],
 ['reports.crm','Reports · CRM',['view','export']],
 ['reports.operations','Reports · Operations',['view','export']],
 ['settings','Company settings',['view','update']],
 ['admin.roles','Administration · Roles & permissions',['view','create','update','delete']],
 ['admin.workspaces','Administration · All workspaces (Administrator role only)',['view']],
 ['admin.users','Administration · User accounts',['view','create','update','delete']],
];

BASE_FUNCTIONS.push(['reports.central','Reports · Custom Task Controlling Management reports',['view','export']],['admin.modules','Administration · Company modules',['view','update']],['admin.companies','Administration · Company creation',['view','create']],['admin.telegram','Administration · Telegram connection',['view','update']],['admin.integrations','Administration · Google Sheets connection',['view','update']]);
for(const [key,,actions] of BASE_FUNCTIONS)if(['crm.contacts','crm.leads','crm.opportunities','crm.accounts','crm.activities','crm.documents','crm.campaigns','tasks.workspace','tasks.users','tasks.tasks','tasks.timesheets','tasks.meetings','ops.finance','admin.users'].includes(key)&&!actions.includes('export'))actions.push('export');
const specs=[['dashboard','Dashboard',true,[]],['crm','CRM',false,[]],['tasks','Task Management',false,[]],['ops','Operations',false,['crm']],['finance','Finance',false,['ops']],['reports','Report',false,[]],['admin','Administration',true,[]],['system','Company settings',true,[]]];
const area=r=>r==='dashboard'?'dashboard':r==='settings'?'system':r==='ops.finance'?'finance':r.split('.')[0];
export const ERP_MODULES=specs.map(([id,label,required,dependencies])=>({id,label,required,dependencies,functions:BASE_FUNCTIONS.filter(([key])=>area(key)===id).map(([key,label,actions])=>({key,label,actions})),sources:[],widgets:[]}));
const contribute=(id,sources,widgets)=>Object.assign(ERP_MODULES.find(m=>m.id===id),{sources,widgets});
contribute('crm',['contacts','leads','opportunities','quotations','accounts','campaigns','crm_activities','documents'],[
 {id:'crm-pipeline',kind:'kpi',title:'Open pipeline',source:'opportunities',metric:'amount',status:['OPEN'],format:'money'},
 {id:'crm-customers',kind:'kpi',title:'Active customers',source:'accounts',metric:'count',status:['ACTIVE']},
 {id:'crm-stages',kind:'bar',title:'Sales by stage',source:'opportunities',group:'status'},
 {id:'crm-followups',kind:'list',title:'CRM follow-ups',source:'crm_activities',status:['OPEN'],sort:'date',limit:5}
]);
contribute('tasks',['workspaces','staff','tasks','timesheets','meetings'],[
 {id:'task-open',kind:'kpi',title:'Open tasks',source:'tasks',metric:'count',exclude:['COMPLETED','CANCELLED']},
 {id:'time-recorded',kind:'kpi',title:'Time recorded',source:'timesheets',metric:'minutes',format:'duration'},
 {id:'task-stages',kind:'bar',title:'Task progress',source:'tasks',group:'status'},
 {id:'team-work',kind:'list',title:'Tasks needing attention',source:'tasks',exclude:['COMPLETED','CANCELLED'],sort:'date',limit:5},
 {id:'team-meetings',kind:'list',title:'Meeting schedule',source:'meetings',status:['SCHEDULED'],sort:'date',limit:5}
]);
contribute('ops',['ops_requests','shipments'],[
 {id:'ops-approval',kind:'kpi',title:'Requests awaiting approval',source:'ops_requests',metric:'count',status:['SUBMITTED']},
 {id:'ops-shipment',kind:'bar',title:'Shipment stages',source:'shipments',group:'status'},
 {id:'ops-inbox',kind:'list',title:'My approval inbox',source:'ops_requests',status:['SUBMITTED'],assignee:'current',limit:6}
]);
contribute('finance',['receivables','payables'],[
 {id:'finance-ar',kind:'kpi',title:'Outstanding receivables',source:'receivables',metric:'amount',format:'money'},
 {id:'finance-ap',kind:'kpi',title:'Outstanding payables',source:'payables',metric:'amount',format:'money'}
]);
contribute('admin',['users'],[
 {id:'admin-active',kind:'kpi',title:'Active user accounts',source:'users',metric:'count',status:['ACTIVE']},
 {id:'admin-roles',kind:'bar',title:'People by role',source:'users',group:'category'}
]);
export const FUNCTIONS=ERP_MODULES.flatMap(m=>m.functions.map(f=>({...f,module:m.id,module_label:m.label})));
export const resourceModule=key=>FUNCTIONS.find(f=>f.key===key)?.module;
export const moduleForSource=id=>ERP_MODULES.find(m=>m.sources.includes(id))?.id;
export function catalogFor(enabled){return ERP_MODULES.map(m=>({...m,enabled:enabled(m.id)}));}

export const ACTION_LABELS={view:'View',create:'Create',update:'Update',delete:'Delete / archive',approve:'Approve',export:'Export'};
import {FUNCTIONS} from './erp-registry.mjs';
export const RESOURCES=FUNCTIONS.map(f=>[f.key,f.label,f.actions]);
export const OPS_RESOURCE={QUOTATION:'ops.quotation',PO:'ops.po',JOB:'ops.job',DN:'ops.dn',PR:'ops.pr'};
export function allowed(permissions,resource,action='view'){return permissions?.[resource]?.includes(action)||false;}
export function roleDefaults(kind){return Object.fromEntries(RESOURCES.map(([r,,actions])=>[r,
 kind==='ADMIN'?actions:kind==='VIEWER'?(r.startsWith('admin.')||r==='settings'||r==='tasks.company'?[]:['view']):
 r.startsWith('admin.')||r==='settings'?[]:
 // V5.5: company-wide task visibility is given deliberately (Administrators have it; add it to an executive's role).
 r==='tasks.company'?[]:
 r==='tasks.organization'?['view']:
 // Groups: team members may delete rows in groups they can edit; only administrators manage every team group.
 r==='tasks.groups'?actions.filter(a=>a!=='approve'):
 kind==='MEMBER'?(r==='ops.finance'?['view']:actions.filter(a=>!['approve','delete'].includes(a))):actions]));}

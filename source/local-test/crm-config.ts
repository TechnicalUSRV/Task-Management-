import { uiText, dynamicLabels } from "./i18n";
// Shared record-type configuration (kept separate from the app shell to avoid import cycles).
export const TABLES: Record<string, string> = { contact: 'contacts', campaign: 'campaigns', lead: 'leads', opportunity: 'opportunities', quotation: 'quotations', account: 'accounts', activity: 'activities', order: 'orders', operations: 'ops_requests' };
/** CRM record types: [type, label, route slug]. */
export const CRM_TYPES: [string, string, string][] = [dynamicLabels(['contact', "Contacts", 'contacts'], { 1: () => uiText("Contacts") }), dynamicLabels(['lead', "Leads", 'leads'], { 1: () => uiText("Leads") }), dynamicLabels(['opportunity', "Opportunities", 'opportunities'], { 1: () => uiText("Opportunities") }), dynamicLabels(['quotation', "Sales quotations", 'quotations'], { 1: () => uiText("Sales quotations") }), dynamicLabels(['account', "Business Accounts", 'accounts'], { 1: () => uiText("Business Accounts") }), dynamicLabels(['campaign', "Campaigns", 'campaigns'], { 1: () => uiText("Campaigns") })];
export const crmSlug = (type: string) => CRM_TYPES.find(([t]) => t === type)?.[2] || type;
export const crmType = (slug: string) => CRM_TYPES.find(([, , s]) => s === slug)?.[0];

// Shared record-type configuration (kept separate from the app shell to avoid import cycles).
export const TABLES: Record<string, string> = { contact: 'contacts', campaign: 'campaigns', lead: 'leads', opportunity: 'opportunities', quotation: 'quotations', account: 'accounts', activity: 'activities', order: 'orders', operations: 'ops_requests' };
/** CRM record types: [type, label, route slug]. */
export const CRM_TYPES: [string, string, string][] = [['contact', 'Contacts', 'contacts'], ['lead', 'Leads', 'leads'], ['opportunity', 'Opportunities', 'opportunities'], ['quotation', 'Sales quotations', 'quotations'], ['account', 'Business Accounts', 'accounts'], ['campaign', 'Campaigns', 'campaigns']];
export const crmSlug = (type: string) => CRM_TYPES.find(([t]) => t === type)?.[2] || type;
export const crmType = (slug: string) => CRM_TYPES.find(([, , s]) => s === slug)?.[0];

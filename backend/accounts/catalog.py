"""Function permissions, ported from erp-registry.mjs / access-catalog.mjs (V5.7.7).

Keys, labels and actions are unchanged so saved role permissions and the existing permission matrix UI keep
working. CRM, Operations and Finance functions stay in the catalog (their modules are switched off in this
deployment), which keeps permission data valid if they are migrated later.
"""

_BASE = [
    ('dashboard', 'Dashboard', ['view']),
    ('crm.contacts', 'CRM · Contacts', ['view', 'create', 'update']),
    ('crm.campaigns', 'CRM · Campaigns', ['view', 'create', 'update']),
    ('crm.leads', 'CRM · Leads', ['view', 'create', 'update']),
    ('crm.opportunities', 'CRM · Opportunities', ['view', 'create', 'update']),
    ('crm.quotations', 'CRM · Quotations', ['view', 'create', 'update', 'approve', 'export']),
    ('crm.accounts', 'CRM · Business Accounts', ['view', 'update']),
    ('crm.activities', 'CRM · Activities', ['view', 'create', 'update']),
    ('crm.documents', 'CRM · Document links', ['view', 'create']),
    ('tasks.organization', 'Task Management · Organizational Structure', ['view', 'create']),
    ('tasks.workspace', 'Task Management · Workspace', ['view', 'create', 'update', 'delete']),
    ('tasks.users', 'Task Management · Users', ['view', 'create', 'update']),
    ('tasks.tasks', 'Task Management · Tasks', ['view', 'create', 'update', 'approve']),
    ('tasks.company', 'Task Management · All company tasks', ['view']),
    ('tasks.groups', 'Task Management · Groups', ['view', 'create', 'update', 'delete', 'approve', 'export']),
    ('tasks.timesheets', 'Task Management · Timesheets', ['view', 'create', 'update', 'delete']),
    ('tasks.meetings', 'Task Management · Meetings', ['view', 'create', 'update']),
    ('tasks.reports', 'Task Management · Reports', ['view', 'export']),
    ('ops.quotation', 'Operations · Quotation', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.po', 'Operations · Purchase Order', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.job', 'Operations · Job File', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.dn', 'Operations · Debit Note', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.pr', 'Operations · Payment Request', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.finance', 'Operations · Finance registers', ['view', 'update', 'approve']),
    ('ops.legacy', 'Operations · Earlier sales handoffs', ['view', 'create', 'update']),
    ('reports.crm', 'Reports · CRM', ['view', 'export']),
    ('reports.operations', 'Reports · Operations', ['view', 'export']),
    ('settings', 'Company settings', ['view', 'update']),
    ('admin.roles', 'Administration · Roles & permissions', ['view', 'create', 'update', 'delete']),
    ('admin.workspaces', 'Administration · All workspaces (Administrator role only)', ['view']),
    ('admin.users', 'Administration · User accounts', ['view', 'create', 'update', 'delete']),
    ('reports.central', 'Reports · Custom Task Controlling Management reports', ['view', 'export']),
    ('admin.modules', 'Administration · Company modules', ['view', 'update']),
    ('admin.companies', 'Administration · Company creation', ['view', 'create']),
    ('admin.telegram', 'Administration · Telegram connection', ['view', 'update']),
    ('admin.integrations', 'Administration · Google Sheets connection', ['view', 'update']),
]
_EXPORTABLE = {'crm.contacts', 'crm.leads', 'crm.opportunities', 'crm.accounts', 'crm.activities', 'crm.documents',
               'crm.campaigns', 'tasks.workspace', 'tasks.users', 'tasks.tasks', 'tasks.timesheets', 'tasks.meetings',
               'ops.finance', 'admin.users'}

RESOURCES = [(key, label, actions + (['export'] if key in _EXPORTABLE and 'export' not in actions else []))
             for key, label, actions in _BASE]
CATALOG = {key: actions for key, _, actions in RESOURCES}
LABELS = {key: label for key, label, _ in RESOURCES}
ACTION_LABELS = {'view': 'View', 'create': 'Create', 'update': 'Update', 'delete': 'Delete / archive',
                 'approve': 'Approve', 'export': 'Export'}

# (id, label, required, dependencies)
MODULES = [
    ('dashboard', 'Dashboard', True, []),
    ('crm', 'CRM', False, []),
    ('tasks', 'Task Management', False, []),
    ('ops', 'Operations', False, ['crm']),
    ('finance', 'Finance', False, ['ops']),
    ('reports', 'Report', False, []),
    ('admin', 'Administration', True, []),
    ('system', 'Company settings', True, []),
]
# Decision A (Stage 1): this deployment runs Task Management only.
DEFAULT_MODULES = {'dashboard': True, 'crm': False, 'tasks': True, 'ops': False, 'finance': False,
                   'reports': True, 'admin': True, 'system': True}


def resource_module(resource):
    if resource == 'dashboard':
        return 'dashboard'
    if resource == 'settings':
        return 'system'
    if resource == 'ops.finance':
        return 'finance'
    return resource.split('.')[0]


def role_defaults(kind):
    """Starter permissions for the four built-in roles (access-catalog.mjs roleDefaults)."""
    out = {}
    for resource, _, actions in RESOURCES:
        if kind == 'ADMIN':
            granted = list(actions)
        elif kind == 'VIEWER':
            granted = [] if resource.startswith('admin.') or resource in ('settings', 'tasks.company') else ['view']
        elif resource.startswith('admin.') or resource == 'settings':
            granted = []
        elif resource == 'tasks.company':
            granted = []
        elif resource == 'tasks.organization':
            granted = ['view']
        elif resource == 'tasks.groups':
            granted = [a for a in actions if a != 'approve']
        elif kind == 'MEMBER':
            granted = ['view'] if resource == 'ops.finance' else [a for a in actions if a not in ('approve', 'delete')]
        else:
            granted = list(actions)
        out[resource] = granted
    return out


BUILT_IN_ROLES = [
    ('ROLE-ADMIN', 'Administrator', 'ADMIN'),
    ('ROLE-MANAGER', 'Manager', 'MANAGER'),
    ('ROLE-MEMBER', 'Team Member', 'MEMBER'),
    ('ROLE-VIEWER', 'Viewer', 'VIEWER'),
]
ADMIN_ROLE = 'ROLE-ADMIN'

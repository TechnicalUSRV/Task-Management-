"""Function permissions, ported from erp-registry.mjs / access-catalog.mjs (V5.7.7).

Keys, labels and actions are unchanged so saved role permissions and the existing permission matrix UI keep
working. CRM, Operations and Finance functions stay in the catalog (their modules are switched off in this
deployment), which keeps permission data valid if they are migrated later.
"""
from core.i18n import msg as _message

_BASE = [
    ('dashboard', _message('Dashboard'), ['view']),
    ('crm.contacts', 'CRM · Contacts', ['view', 'create', 'update']),
    ('crm.campaigns', 'CRM · Campaigns', ['view', 'create', 'update']),
    ('crm.leads', 'CRM · Leads', ['view', 'create', 'update']),
    ('crm.opportunities', 'CRM · Opportunities', ['view', 'create', 'update']),
    ('crm.quotations', 'CRM · Quotations', ['view', 'create', 'update', 'approve', 'export']),
    ('crm.accounts', _message('CRM · Business Accounts'), ['view', 'update']),
    ('crm.activities', 'CRM · Activities', ['view', 'create', 'update']),
    ('crm.documents', _message('CRM · Document links'), ['view', 'create']),
    ('tasks.organization', _message('Task Management · Organizational Structure'), ['view', 'create']),
    ('tasks.workspace', _message('Task Management · Workspace'), ['view', 'create', 'update', 'delete']),
    ('tasks.users', _message('Task Management · Users'), ['view', 'create', 'update']),
    ('tasks.tasks', _message('Task Management · Tasks'), ['view', 'create', 'update', 'approve']),
    ('tasks.company', _message('Task Management · All company tasks'), ['view']),
    ('tasks.groups', _message('Task Management · Groups'), ['view', 'create', 'update', 'delete', 'approve', 'export']),
    ('tasks.timesheets', _message('Task Management · Timesheets'), ['view', 'create', 'update', 'delete']),
    ('tasks.meetings', _message('Task Management · Meetings'), ['view', 'create', 'update']),
    ('tasks.reports', _message('Task Management · Reports'), ['view', 'export']),
    ('ops.quotation', 'Operations · Quotation', ['view', 'create', 'update', 'approve', 'export']),
    ('ops.po', _message('Operations · Purchase Order'), ['view', 'create', 'update', 'approve', 'export']),
    ('ops.job', _message('Operations · Job File'), ['view', 'create', 'update', 'approve', 'export']),
    ('ops.dn', _message('Operations · Debit Note'), ['view', 'create', 'update', 'approve', 'export']),
    ('ops.pr', _message('Operations · Payment Request'), ['view', 'create', 'update', 'approve', 'export']),
    ('ops.finance', _message('Operations · Finance registers'), ['view', 'update', 'approve']),
    ('ops.legacy', _message('Operations · Earlier sales handoffs'), ['view', 'create', 'update']),
    ('reports.crm', 'Reports · CRM', ['view', 'export']),
    ('reports.operations', 'Reports · Operations', ['view', 'export']),
    ('settings', _message('Company settings'), ['view', 'update']),
    ('admin.roles', 'Administration · Roles & permissions', ['view', 'create', 'update', 'delete']),
    ('admin.workspaces', _message('Administration · All workspaces (Administrator role only)'), ['view']),
    ('admin.users', _message('Administration · User accounts'), ['view', 'create', 'update', 'delete']),
    ('reports.central', _message('Reports · Custom Task Controlling Management reports'), ['view', 'export']),
    ('admin.modules', _message('Administration · Company modules'), ['view', 'update']),
    ('admin.companies', _message('Administration · Company creation'), ['view', 'create']),
    ('admin.telegram', _message('Administration · Telegram connection'), ['view', 'update']),
    ('admin.integrations', _message('Administration · Google Sheets connection'), ['view', 'update']),
]
_EXPORTABLE = {'crm.contacts', 'crm.leads', 'crm.opportunities', 'crm.accounts', 'crm.activities', 'crm.documents',
               'crm.campaigns', 'tasks.workspace', 'tasks.users', 'tasks.tasks', 'tasks.timesheets', 'tasks.meetings',
               'ops.finance', 'admin.users'}

_AREA_ORDER = ['dashboard', 'crm', 'tasks', 'ops', 'finance', 'reports', 'admin', 'system']


def _area(key):
    return 'dashboard' if key == 'dashboard' else 'system' if key == 'settings' else 'finance' if key == 'ops.finance' else key.split('.')[0]


# Grouped by module, as erp-registry.mjs FUNCTIONS lists them (this order is the permission screens' and the seed's).
RESOURCES = sorted([(key, label, actions + (['export'] if key in _EXPORTABLE and 'export' not in actions else []))
                    for key, label, actions in _BASE], key=lambda r: _AREA_ORDER.index(_area(r[0])))
CATALOG = {key: actions for key, _, actions in RESOURCES}
LABELS = {key: label for key, label, _ in RESOURCES}
ACTION_LABELS = {'view': _message('View'), 'create': 'Create', 'update': 'Update', 'delete': 'Delete / archive',
                 'approve': _message('Approve'), 'export': _message('Export')}

# (id, label, required, dependencies)
MODULES = [
    ('dashboard', _message('Dashboard'), True, []),
    ('crm', 'CRM', False, []),
    ('tasks', _message('Task Management'), False, []),
    ('ops', _message('Operations'), False, ['crm']),
    ('finance', _message('Finance'), False, ['ops']),
    ('reports', _message('Report'), False, []),
    ('admin', _message('Administration'), True, []),
    ('system', _message('Company settings'), True, []),
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
    ('ROLE-ADMIN', _message('Administrator'), 'ADMIN'),
    ('ROLE-MANAGER', _message('Manager'), 'MANAGER'),
    ('ROLE-MEMBER', _message('Team Member'), 'MEMBER'),
    ('ROLE-VIEWER', _message('Viewer'), 'VIEWER'),
]
ADMIN_ROLE = 'ROLE-ADMIN'


# ---------------------------------------------------------------- the module catalog the screens receive (erp-registry.mjs)
# Report sources and dashboard widgets each module contributes. CRM, Operations and Finance keep their descriptors so the
# catalog is identical to V5.7.7; their modules are off in this deployment.
_CONTRIBUTIONS = {
    'crm': (['contacts', 'leads', 'opportunities', 'quotations', 'accounts', 'campaigns', 'crm_activities', 'documents'], [
        {'id': 'crm-pipeline', 'kind': 'kpi', 'title': _message('Open pipeline'), 'source': 'opportunities', 'metric': 'amount', 'status': ['OPEN'], 'format': 'money'},
        {'id': 'crm-customers', 'kind': 'kpi', 'title': _message('Active customers'), 'source': 'accounts', 'metric': 'count', 'status': ['ACTIVE']},
        {'id': 'crm-stages', 'kind': 'bar', 'title': _message('Sales by stage'), 'source': 'opportunities', 'group': 'status'},
        {'id': 'crm-followups', 'kind': 'list', 'title': _message('CRM follow-ups'), 'source': 'crm_activities', 'status': ['OPEN'], 'sort': 'date', 'limit': 5}]),
    'tasks': (['workspaces', 'staff', 'tasks', 'timesheets', 'meetings'], [
        {'id': 'task-open', 'kind': 'kpi', 'title': _message('Open tasks'), 'source': 'tasks', 'metric': 'count', 'exclude': ['COMPLETED', 'CANCELLED']},
        {'id': 'time-recorded', 'kind': 'kpi', 'title': _message('Time recorded'), 'source': 'timesheets', 'metric': 'minutes', 'format': 'duration'},
        {'id': 'task-stages', 'kind': 'bar', 'title': _message('Task progress'), 'source': 'tasks', 'group': 'status'},
        {'id': 'team-work', 'kind': 'list', 'title': _message('Tasks needing attention'), 'source': 'tasks', 'exclude': ['COMPLETED', 'CANCELLED'], 'sort': 'date', 'limit': 5},
        {'id': 'team-meetings', 'kind': 'list', 'title': _message('Meeting schedule'), 'source': 'meetings', 'status': ['SCHEDULED'], 'sort': 'date', 'limit': 5}]),
    'ops': (['ops_requests', 'shipments'], [
        {'id': 'ops-approval', 'kind': 'kpi', 'title': _message('Requests awaiting approval'), 'source': 'ops_requests', 'metric': 'count', 'status': ['SUBMITTED']},
        {'id': 'ops-shipment', 'kind': 'bar', 'title': _message('Shipment stages'), 'source': 'shipments', 'group': 'status'},
        {'id': 'ops-inbox', 'kind': 'list', 'title': _message('My approval inbox'), 'source': 'ops_requests', 'status': ['SUBMITTED'], 'assignee': 'current', 'limit': 6}]),
    'finance': (['receivables', 'payables'], [
        {'id': 'finance-ar', 'kind': 'kpi', 'title': _message('Outstanding receivables'), 'source': 'receivables', 'metric': 'amount', 'format': 'money'},
        {'id': 'finance-ap', 'kind': 'kpi', 'title': _message('Outstanding payables'), 'source': 'payables', 'metric': 'amount', 'format': 'money'}]),
    'admin': (['users'], [
        {'id': 'admin-active', 'kind': 'kpi', 'title': _message('Active user accounts'), 'source': 'users', 'metric': 'count', 'status': ['ACTIVE']},
        {'id': 'admin-roles', 'kind': 'bar', 'title': _message('People by role'), 'source': 'users', 'group': 'category'}]),
}
ERP_MODULES = [{'id': mid, 'label': label, 'required': required, 'dependencies': deps,
                'functions': [{'key': key, 'label': flabel, 'actions': actions} for key, flabel, actions in RESOURCES if resource_module(key) == mid],
                'sources': _CONTRIBUTIONS.get(mid, ([], []))[0], 'widgets': _CONTRIBUTIONS.get(mid, ([], []))[1]}
               for mid, label, required, deps in MODULES]
MODULE_ORDER = {m[0]: i for i, m in enumerate(MODULES)}


def module_for_source(source):
    return next((m['id'] for m in ERP_MODULES if source in m['sources']), None)


def catalog_for(enabled, hidden=()):
    """erp-registry.mjs catalogFor(): every module with its functions, sources, widgets and whether it is on.

    `hidden`: functions this deployment does not offer (they are left out of the permission screens)."""
    return [{**m, 'functions': [f for f in m['functions'] if f['key'] not in hidden], 'enabled': bool(enabled(m['id']))} for m in ERP_MODULES]

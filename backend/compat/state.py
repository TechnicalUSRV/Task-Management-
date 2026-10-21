"""GET /api/state — the whole application state as one signed-in person may see it (V5.7.7 store.state() filtered by
access.filterState()). The React app and the Telegram Mini App build every screen from it.

Rows keep the V5.7.7 column names and value forms (ISO timestamps, 'YYYY-MM-DD' dates, 0/1 flags) and are read with
plain SQL on the same table names, so SQL Server and SQLite give identical results. CRM and Operations sections are
present but empty (their modules are off in this deployment), exactly as V5.7.7 sends them to people without access.
"""
import json
from datetime import date, datetime, timezone as dt_timezone

from django.db import connection

from accounts import services as access
from accounts.catalog import ADMIN_ROLE, MODULE_ORDER, RESOURCES, catalog_for
from accounts.models import User
from core.validation import iso
from organization.governance import Governance, display_name
from tasks.scope import TaskScope

APP_VERSION = 'Task Controlling Management V5.7.7'
APP_BUILD = '2026-10-14 · Django'
CRM_TABLES = ['contacts', 'campaigns', 'leads', 'opportunities', 'opportunity_lines', 'quotations', 'quote_revisions', 'approvals', 'accounts',
              'activities', 'documents', 'orders', 'shipments', 'invoices', 'payments']
OPS_TABLES = ['ops_requests', 'ops_approvals', 'ops_notifications', 'ops_jobs', 'ops_debit_notes', 'ops_postings', 'ops_ap', 'ops_settlements',
              'ops_closings', 'ops_files', 'ops_revisions', 'ops_events']
COA_RULES = '[{"contains":"duty","category":"TAX"},{"contains":"customs tax","category":"TAX"},{"contains":"disbursement","category":"CASH_DISBURSEMENT"}]'
# Columns as V5.7.7 sends them (its table order), and the order rows come in.
TABLES = {
    'tm_workspaces': ('id,name,description,department,owner_id,color,status,version,created_at,updated_at,kind,governing_manager_id,'
                      'origin_workspace_id,owner_grant_id,joinable,created_by,deleted_at,deleted_by,deleted_from_status,visibility', 'id'),
    'tm_members': ('workspace_id,staff_id,approved_by,approval_id,member_role,joined_at', 'id'),
    'tm_task_members': ('task_id,staff_id,permission,granted_by,created_at', 'id'),
    'tm_tasks': ('visibility,governing_manager_id,id,workspace_id,activity_id,contact_id,related_type,related_id,title,description,start_date,due_date,status,priority,progress,'
                 'estimate_minutes,reason,created_by,completed_at,version,creation_key,created_at,updated_at,pic_id,reviewer_id,department,'
                 'department_note,accepted_at,declined_at,declined_reason,stuck_at,stuck_by,stuck_reason,submitted_to,submitted_by,submitted_at,'
                 'submit_note,closed_by,request_id,source,reviewer_status,reviewer_responded_at,reviewer_note,recurrence,recurrence_until,series_id,'
                 'next_task_id,scheduled_due,series_anchor,assigned_by,reminder_days,recurrence_rule', 'id'),
    'tm_timesheets': ('id,task_id,workspace_id,activity,staff_id,work_date,minutes,notes,version,created_at,updated_at', 'id'),
    'tm_meetings': ('id,workspace_id,task_id,activity_id,contact_id,title,agenda,organizer_id,start_at,end_at,location,url,status,minutes_notes,'
                    'reason,version,creation_key,created_at,updated_at,share_scope,reminder_offsets,created_by', 'id'),
    'tm_attendees': ('meeting_id,staff_id', 'id'),
    'tm_events': ('id,entity_type,entity_id,workspace_id,action,detail,actor_id,created_at', 'id'),
    'tm_requests': ('visibility,governing_manager_id,id,workspace_id,title,description,department,department_note,priority,proposed_due_date,requested_by,manager_id,status,'
                    'decision_note,decided_by,decided_at,task_id,source,version,creation_key,created_at,updated_at,doer', 'id'),
    'tm_due_requests': ('id,task_id,requested_by,decide_by,current_due_date,proposed_due_date,reason,status,decision_note,decided_by,decided_at,'
                        'source,version,created_at,updated_at', 'id'),
    'tm_change_requests': ('id,task_id,kind,requested_by,requester_side,approver_id,status,changes_json,payload_json,note,base_version,'
                           'decision_note,decided_by,decided_at,source,decision_source,version,created_at,updated_at', 'id'),
    'tm_meeting_changes': ('id,meeting_id,requested_by,approver_id,base_version,payload_json,source,status,note,decision_note,decided_by,'
                           'decided_at,created_at,version', 'id'),
    'tm_meeting_shares': ('meeting_id,staff_id', 'id'),
    'tm_meeting_followers': ('meeting_id,staff_id,created_at', 'id'),
    'tm_assignees': ('task_id,staff_id,status,invited_by,responded_at,response_note', 'task_id,id'),
    'tm_task_history': ('id,task_id,kind,from_status,to_status,progress,stuck,due_date,note,actor_id,source,created_at', 'id'),
    'tm_checklist': ('id,task_id,position,title,done,done_by,done_at,created_by,created_at', 'task_id,position'),
    'tm_files': ('id,task_id,name,mime,size,uploaded_by,source,created_at', 'task_id,created_at,id'),
}


def value(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, datetime):
        return iso(v if v.tzinfo else v.replace(tzinfo=dt_timezone.utc))
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, memoryview):
        return bytes(v)
    return v


def query(sql, *args):
    with connection.cursor() as c:
        c.execute(sql, args)
        names = [col[0] for col in c.description]
        return [{n: value(v) for n, v in zip(names, r)} for r in c.fetchall()]


def query_first(n, sql, *args):
    """query() for at most n rows, read by the database (SQL Server TOP, SQLite LIMIT) instead of fetching every row."""
    n = int(n)
    sql = sql.replace('SELECT ', f'SELECT TOP {n} ', 1) if connection.vendor == 'microsoft' else f'{sql} LIMIT {n}'
    return query(sql, *args)


def table(name):
    cols, order = TABLES[name]
    return query(f'SELECT {cols} FROM {name} ORDER BY {order}')


def company_row():
    found = query('SELECT id,name,address,phone,email,tax_id,currency,timezone FROM company WHERE id=1')
    return found[0] if found else None


def lookups():
    from core.company import lookups as all_lookups
    return all_lookups()


def ops_settings(approval_steps):
    fallback = [s['approver_id'] for s in sorted(approval_steps, key=lambda s: -s['step'])[:1]]
    return {'id': 1, 'holidays_json': '[]', 'finance_ids_json': '[]', 'coa_rules_json': COA_RULES, 'version': 0, 'holidays': [],
            'finance_ids': fallback, 'coa_rules': json.loads(COA_RULES)}


def full_state():
    """store.state(): everything, before filtering for a person."""
    steps = query('SELECT step,approver_id FROM approval_steps ORDER BY step')
    s = {'company': company_row(), 'app_version': APP_VERSION, 'app_build': APP_BUILD, 'lookups': lookups()}
    for t in CRM_TABLES:
        s[t] = []
    s['approval_steps'] = steps
    s.update({'won_sales': [], 'accepted_sales': [], 'events': []})
    for t in OPS_TABLES:
        s[t] = []
    s['ops_settings'] = ops_settings(steps)
    for name in TABLES:
        s[name] = table(name)
    s['staff_photos'] = query('SELECT staff_id,version FROM staff_photos WHERE size>0 ORDER BY staff_id')
    s['tm_profiles'] = query("SELECT l.id AS staff_id,l.name,COALESCE(p.email,'') AS email,COALESCE(p.phone,'') AS phone,"
                             "COALESCE(p.position,'') AS position,COALESCE(p.department,'') AS department,COALESCE(p.active,1) AS active,"
                             "COALESCE(p.version,0) AS version,p.manager_id,COALESCE(p.timezone,'') AS timezone,p.org_level,"
                             "COALESCE(p.nickname,'') AS nickname FROM staff l LEFT JOIN tm_profiles p ON p.staff_id=l.id")
    s['tm_profiles'].sort(key=lambda p: p['name'])   # V5.7.7 reads them through its staff-name index
    from groups.service import GroupService
    s.update(GroupService.state())
    return s


def task_people(gov):
    """access.taskPeople(): active logins with Task Management, by name."""
    found = query(
        "SELECT u.id,u.staff_id,u.role_id,l.name,COALESCE(p.department,'') AS department,COALESCE(p.position,'') AS position,"
        "CASE WHEN EXISTS(SELECT 1 FROM access_audit a WHERE a.target_id=u.id AND (a.action LIKE 'Signed in%%' OR "
        "(a.action='User account created' AND a.actor_id=u.staff_id))) OR EXISTS(SELECT 1 FROM tg_links k WHERE k.staff_id=u.staff_id) "
        "THEN 1 ELSE 0 END AS signed_in,"
        "CASE WHEN EXISTS(SELECT 1 FROM tg_links k WHERE k.staff_id=u.staff_id) THEN 1 ELSE 0 END AS telegram "
        "FROM access_users u JOIN staff l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=u.staff_id "
        "WHERE u.active=%s AND l.active=%s AND COALESCE(p.active,%s)=%s", True, True, True, True)
    found.sort(key=lambda u: (u['name'].lower(), u['id']))
    users = {u.id: u for u in User.objects.select_related('role').filter(id__in=[f['id'] for f in found])}
    everyone = access.permissions_for_many(users.values())
    out = []
    for f in found:
        perms = everyone[f['id']]
        if gov.operational_access(f['staff_id']) and access.can(users[f['id']], 'tasks.tasks', 'view', perms):
            out.append({'staff_id': f['staff_id'], 'name': f['name'], 'department': f['department'], 'position': f['position'],
                        'signed_in': bool(f['signed_in']), 'telegram': bool(f['telegram']),
                        'approver': access.can(users[f['id']], 'tasks.tasks', 'approve', perms)})
    return out


def group_part(s, out, user, gov, v):
    """Groups: only the groups this person may open (their own, or Team groups shared with them or with their whole
    workspace), with their access level. Rows are read separately, one group at a time (GET /api/tasks/group)."""
    empty = {'tm_boards': [], 'tm_board_access': [], 'tm_board_summaries': [], 'tm_group_workspaces': []}
    if not v('tasks.groups') or s.get('tm_boards') is None:   # an empty list still counts (V5.7.7: `s.tm_boards` is [])
        return empty
    from groups.service import GroupService
    from tasks.services import TaskService
    groups = GroupService(TaskService(gov)).remember_lookups()
    staff, admin = user.staff_id, v('tasks.groups', 'approve')
    member = {m['workspace_id'] for m in s['tm_members'] if m['staff_id'] == staff}
    boards = []
    for b in s['tm_boards']:
        level = groups.level_for(b, staff)
        if level > 0:
            context = gov.group_context(staff, b)
            boards.append({**b, 'level': level, 'admin': bool(context['admin'] if context is not None else admin) and b['visibility'] == 'TEAM'})
    ids = {b['id'] for b in boards}
    # Rows and columns each person may see in each group (access rules apply to the counts too).
    summaries = groups.summaries(staff, [{**b, 'layout_json': '{}'} for b in sorted(s['tm_boards'], key=lambda b: b['id']) if b['id'] in ids])
    # Active workspaces where this person may create groups (member, owner or group administrator; governed workspaces
    # follow the organization's rules). The screens combine it with the role's Create permission.
    workspaces = [w['id'] for w in out['tm_workspaces'] if w['status'] == 'ACTIVE' and (
        gov.can_create_resource(staff, gov.ws_by_id(w['id'])) if gov.governed(gov.ws_by_id(w['id']))
        else w['id'] in member or w.get('owner_id') == staff or admin)]
    return {'tm_boards': boards, 'tm_board_access': [a for a in s['tm_board_access'] if a['board_id'] in ids],
            'tm_board_summaries': summaries, 'tm_group_workspaces': workspaces}


def filter_state(s, user, gov=None):
    """access.filterState(state, user)."""
    gov = gov or Governance()
    gov.preload_people()
    perms = access.permissions(user)

    def v(resource, action='view'):
        return action in perms.get(resource, [])
    out = {**s, 'auth': {'user': access.public_user(user), 'permissions': perms}, 'erp_catalog': catalog_for(access.module_enabled, access.hidden_functions()),
           'erp_module_settings': sorted(query('SELECT module_id,enabled,version FROM erp_module_settings'),
                                         key=lambda m: MODULE_ORDER.get(m['module_id'], 99))}
    task_any = any(r.startswith('tasks.') and v(r) for r in perms)
    scope = TaskScope(gov)
    sc = scope.filter_state(s, user.staff_id, permissions=perms) if task_any else None

    def T(k):
        return sc[k] if sc is not None and k in sc else s.get(k, [])
    out['tm_calendar_tasks'] = T('tm_calendar_tasks') if v('tasks.tasks') else []
    out['tm_meeting_changes'] = T('tm_meeting_changes') if v('tasks.meetings') else []
    out['tm_workspaces'], out['tm_members'], out['tm_workspace_refs'] = T('tm_workspaces'), T('tm_members'), T('tm_workspace_refs')
    out['organization'] = ((gov.snapshot(user.staff_id) if v('tasks.organization') else {'enabled': bool(gov.settings()['enabled'])})
                           if task_any else None)
    options = [*T('tm_tasks'), *((sc or {}).get('tm_task_refs', []) if v('tasks.timesheets') and sc else [])]
    out['tm_task_options'] = ([{'id': t['id'], 'title': t['title'], 'workspace_id': t['workspace_id'], 'status': t['status']} for t in options]
                              if v('tasks.timesheets') or v('tasks.meetings') else [])
    out['tm_assignment_options'] = T('tm_assignees') if v('tasks.timesheets') else []
    out['tm_notifications'], out['tm_people'], out['tm_calendar_notes'] = [], [], []
    out['task_scope'] = sc['task_scope'] if sc else {'company': False, 'team': [], 'involved': 0}
    from tasks.services import TaskService
    service = TaskService(gov)
    out['my_timezone'] = service.zone_of(user.staff_id)
    theme = query('SELECT sidebar_theme FROM tm_profiles WHERE staff_id=%s', user.staff_id)
    out['my_sidebar_theme'] = (theme[0]['sidebar_theme'] if theme else '') or ''
    out.update(group_part(s, out, user, gov, v))
    if not task_any:
        for k in [k for k in s if k.startswith('tm_')]:
            out[k] = []
    else:
        if not v('tasks.workspace'):
            out['tm_workspaces'] = [{'id': w['id'], 'name': w['name'], 'status': w['status'], 'department': w['department'], 'kind': w['kind'],
                                     'visibility': w['visibility'], 'org_access': w.get('org_access')} for w in out['tm_workspaces']]
            if not v('tasks.tasks') and not v('tasks.meetings'):
                out['tm_members'] = []
        if not v('tasks.users'):
            out['tm_profiles'] = [{**p, 'email': '', 'phone': '', 'position': ''} for p in s['tm_profiles']]
        elif not access.profile_manager(user):
            out['tm_profiles'] = [p if p['staff_id'] == user.staff_id else {**p, 'email': '', 'phone': ''} for p in s['tm_profiles']]
        if not v('tasks.tasks'):
            for k in ('tm_tasks', 'tm_assignees', 'tm_task_history', 'tm_due_requests', 'tm_change_requests', 'tm_requests', 'tm_checklist', 'tm_files', 'tm_task_members'):
                out[k] = []
        else:
            for k in ('tm_tasks', 'tm_assignees', 'tm_task_history', 'tm_checklist', 'tm_files', 'tm_change_requests', 'tm_due_requests', 'tm_task_members'):
                out[k] = T(k)
            out['tm_requests'] = T('tm_requests') if sc is not None else [q for q in s['tm_requests'] if user.staff_id in (q['requested_by'], q['manager_id'])]
            people = task_people(gov)
            out['tm_people'] = people if v('tasks.users') else [{**p, 'position': ''} for p in people]
        out['tm_timesheets'] = T('tm_timesheets') if v('tasks.timesheets') else []
        if not v('tasks.meetings'):
            out['tm_meetings'], out['tm_attendees'], out['tm_meeting_shares'], out['tm_meeting_followers'] = [], [], [], []
        else:
            for k in ('tm_meetings', 'tm_attendees', 'tm_meeting_shares', 'tm_meeting_followers'):
                out[k] = T(k)
        if v('tasks.tasks') or v('tasks.meetings'):
            out['tm_calendar_notes'] = query('SELECT id,staff_id,title,body,all_day,day,start_at,end_at,reminder_offsets,done,version,created_at,'
                                             'updated_at FROM tm_calendar_notes WHERE staff_id=%s', user.staff_id)
            out['tm_calendar_notes'].sort(key=lambda n: (n['day'], '' if n['start_at'] is None else n['start_at'], n['id']))
            task_ids, meeting_ids = {t['id'] for t in out['tm_tasks']}, {m['id'] for m in out['tm_meetings']}
            request_ids, note_ids = {q['id'] for q in out['tm_requests']}, {n['id'] for n in out['tm_calendar_notes']}
            notes = query_first(150, 'SELECT id,staff_id,kind,task_id,request_id,due_request_id,title,body,actor_id,created_at,read_at,meeting_id,note_id,'
                          'org_request_id FROM tm_notifications WHERE staff_id=%s ORDER BY id DESC', user.staff_id)
            out['tm_notifications'] = [n for n in notes if (not n['task_id'] or n['task_id'] in task_ids) and (not n['meeting_id'] or n['meeting_id'] in meeting_ids)
                                       and (not n['request_id'] or n['request_id'] in request_ids) and (not n['note_id'] or n['note_id'] in note_ids)
                                       and (not n['org_request_id'] or (v('tasks.organization') and gov.notification_visible(user.staff_id, n['org_request_id'])))][:100]
        visible_requests = {q['id'] for q in out.get('tm_requests') or []}
        profiles = access.profile_manager(user)
        kinds = {'task': 'tasks.tasks', 'request': 'tasks.tasks', 'meeting': 'tasks.meetings', 'timesheet': 'tasks.timesheets',
                 'workspace': 'tasks.workspace', 'user': 'tasks.users'}
        out['tm_events'] = [e for e in T('tm_events') if v(kinds.get(e['entity_type'], '')) and (e['entity_type'] != 'request' or e['entity_id'] in visible_requests)
                            and (e['entity_type'] != 'user' or profiles or e['entity_id'] == user.staff_id)]
    out['workspace_dashboard'] = gov.workspace_dashboard(user.staff_id, out) if v('tasks.workspace') else None
    # Calendar "Under My Management": the people below this person on any reporting line, with their organizational
    # titles. Only names and titles; their events are taken from the already-filtered tasks and meetings above.
    out['management_people'] = gov.management_people(user.staff_id) if task_any and (v('tasks.tasks') or v('tasks.meetings')) else []
    out['workspace_setup'] = (gov.workspace_setup(user.staff_id) if task_any and v('tasks.workspace') and gov.settings()['enabled']
                              else {'managers': [], 'primary_manager_id': None, 'subordinates': []})
    if sc is not None:
        out['task_scope']['employee_filters'] = scope.employee_filters(out, user.staff_id)
    out['events'] = [e for e in s['events'] if e['entity_type'] == 'company' and v('settings')]
    admin_view = v('admin.roles') or v('admin.users')
    out['access_roles'] = query('SELECT id,name,description,protected,version,created_at,updated_at FROM access_roles ORDER BY created_at,id') if admin_view else []
    out['access_permissions'] = (query('SELECT role_id,resource,action FROM access_permissions WHERE role_id<>%s ORDER BY id', ADMIN_ROLE)
                                 + [{'role_id': ADMIN_ROLE, 'resource': r, 'action': a} for r, _, actions in RESOURCES for a in actions]) if admin_view else []
    nicknames = {p['staff_id']: p['nickname'] or '' for p in s['tm_profiles']}
    out['lookups'] = [({**l, 'username': l['name'], 'nickname': nicknames.get(l['id'], ''), 'name': display_name(l['name'], nicknames.get(l['id']))}
                       if l['kind'] == 'staff' else l) for l in out['lookups']]
    out['tm_people'] = [{**p, 'username': p['name'], 'nickname': nicknames.get(p['staff_id'], ''), 'name': display_name(p['name'], nicknames.get(p['staff_id']))}
                        for p in out.get('tm_people') or []]
    out['tm_profiles'] = [{**p, 'username': p['name'], 'name': display_name(p['name'], p['nickname'])} for p in out.get('tm_profiles') or []]
    out['access_users'] = query("SELECT u.id,u.staff_id,u.email,u.username,u.role_id,u.active,u.version,u.created_at,u.updated_at,l.name,"
                                "COALESCE(p.position,'') AS position,COALESCE(p.department,'') AS department FROM access_users u "
                                "JOIN staff l ON l.id=u.staff_id LEFT JOIN tm_profiles p ON p.staff_id=u.staff_id ORDER BY u.id") if v('admin.users') else []
    out['access_audit'] = query_first(200, 'SELECT id,actor_id,action,target_id,detail,created_at FROM access_audit ORDER BY id DESC') if admin_view else []
    out['access_user_permissions'] = query('SELECT user_id,resource,action,effect FROM access_user_permissions ORDER BY id') if v('admin.users') else []
    out['operational_access'] = gov.operational_access(user.staff_id)
    if not out['operational_access']:
        for key in list(out):
            if key.startswith('tm_') or key in CRM_TABLES + OPS_TABLES + ['staff_photos']:
                out[key] = []
        out['lookups'] = []
        out['management_people'] = []
        out['organization'] = {'enabled': bool(gov.settings()['enabled']), 'restricted': True}
        out['workspace_dashboard'] = None
        out['workspace_setup'] = {'managers': [], 'subordinates': []}
        out['task_scope'] = {'company': False, 'team': [], 'involved': 0, 'revision': 'unmapped'}
    return out


def scoped_state(user, gov=None):
    """store.scopedState(user): what reports, the dashboard and the Mini App read."""
    gov = gov or Governance()
    return filter_state(full_state(), user, gov)

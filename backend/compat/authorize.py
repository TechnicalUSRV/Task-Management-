"""Function-permission check for every command — access.mjs authorize() (V5.7.7).

This decides which function permission a command needs. Record-level rules (task roles, workspace authority,
hierarchy) are applied afterwards by the domain services. CRM, Operations and Google Sheets commands are not available
in this deployment (Stage 1 decision A); they are refused here.
"""
import re

from accounts import services as access
from accounts.catalog import ADMIN_ROLE
from accounts.models import User
from core.errors import fail

ID_KEYS = ('id', 'task_id', 'activity_id', 'meeting_id', 'request_id', 'workspace_id')
TASK_WORK = re.compile(r'^tm\.(task\.(accept|decline|progress|stuck|resume|submit|pass|return|close|cancel|reopen|note|handover|remind|reminders)'
                       r'|change\.(decide|withdraw)|due\.(request|decide|withdraw)|check\.(add|toggle|rename|move|remove)|file\.(add|remove)'
                       r'|request\.(save|withdraw|decide|forward)|notification\.read)$')
CRM_RESOURCES = {'CONTACT': 'crm.contacts', 'LEAD': 'crm.leads', 'OPPORTUNITY': 'crm.opportunities', 'ACCOUNT': 'crm.accounts',
                 'OPERATIONS': 'ops.job'}


def _crm_links(user, d):
    """Links to CRM/Operations records need those functions; their modules are off, so such links are refused."""
    if d.get('activity_id'):
        access.require_permission(user, 'crm.activities', 'update')
    if d.get('related_type'):
        access.require_permission(user, CRM_RESOURCES.get(d['related_type'], 'crm.contacts'), 'view')


def authorize(user, action, d):
    if user is None:
        fail('Sign in to continue.', 401)
    if not isinstance(action, str) or not isinstance(d, dict):
        fail('Invalid command.')
    for k in ID_KEYS:
        if isinstance(d.get(k), str) and d[k] != d[k].strip():
            d[k] = d[k].strip()
    if re.match(r'^(tm|me|org|tg)\.', action):
        for k, v in d.items():
            if v is None or v == '':
                continue
            if (k == 'id' or k.endswith('_id')) and not isinstance(v, str) and not (
                    k == 'id' and action == 'tm.notification.read' and isinstance(v, int) and not isinstance(v, bool)):
                fail('This request names a record in an invalid way.')
            if k.endswith('_ids') and (not isinstance(v, list) or any(not isinstance(x, str) for x in v)):
                fail('This request lists records in an invalid way.')
    if action.startswith('org.'):
        access.require_permission(user, 'tasks.organization', 'create')
        if action == 'org.workspace.save':
            access.require_permission(user, 'tasks.workspace', 'update' if d.get('id') else 'create')
        if re.match(r'^org\.workspace\.(delete|restore)$', action):
            access.require_permission(user, 'tasks.workspace', 'view')
        return
    if re.match(r'^tm\.workspace\.(delete|restore|member\.(add|remove))$', action):
        access.require_permission(user, 'tasks.workspace', 'view')
        return

    resource = verb = None
    if action == 'admin.role.save':
        resource, verb = 'admin.roles', 'update' if d.get('id') else 'create'
    elif action == 'admin.modules.save':
        resource, verb = 'admin.modules', 'update'
    elif action == 'admin.role.delete':
        resource, verb = 'admin.roles', 'delete'
    elif action == 'admin.user.save':
        resource, verb = 'admin.users', 'update' if d.get('id') else 'create'
        if d.get('id') and (d.get('active') is False or d.get('active') == 0):
            access.require_permission(user, 'admin.users', 'delete')
    elif action == 'admin.user.disable':
        resource, verb = 'admin.users', 'delete'
    elif re.match(r'^me\.(profile\.save|photo\.(save|remove)|sessions\.end)$', action):
        return
    elif TASK_WORK.match(action):
        resource, verb = 'tasks.tasks', 'view'
    elif action == 'tm.profile.photo':
        resource, verb = 'tasks.users', 'update'
        if d.get('staff_id') != user.staff_id and not access.profile_manager(user):
            fail('Only managers and administrators can change other people’s photos.', 403)
    elif action == 'tm.profile.manager':
        resource, verb = 'admin.users', 'update'
    elif re.match(r'^tm\.calnote\.(save|delete)$', action):
        if not access.can(user, 'tasks.tasks') and not access.can(user, 'tasks.meetings'):
            fail('Your account does not include the calendar (Task Management · Tasks or Meetings).', 403)
        return
    elif action in ('tm.meeting.decide', 'tm.meeting.withdraw', 'tm.meeting.follow'):
        resource, verb = 'tasks.meetings', 'view'
    elif action == 'tm.task.save' and d.get('id'):
        resource, verb = 'tasks.tasks', 'view'
        _crm_links(user, d)
    elif re.match(r'^tm\.(workspace\.(save|archive)|profile\.save|task\.save|time\.(save|delete)|meeting\.save)$', action):
        area = action.split('.')[1]
        resource = 'tasks.' + {'workspace': 'workspace', 'profile': 'users', 'task': 'tasks', 'time': 'timesheets', 'meeting': 'meetings'}[area]
        verb = ('delete' if action.endswith(('.archive', '.delete')) else
                'update' if (d.get('id') or (area == 'profile' and d.get('staff_id'))) else 'create')
        if area == 'profile':
            _authorize_profile(user, d)
        _crm_links(user, d)
    elif action in ('settings.save', 'lookup.save'):
        resource, verb = 'settings', 'update'
    elif re.match(r'^admin\.telegram\.(save|group|unlink)$', action):
        resource, verb = 'admin.telegram', 'update'
    elif re.match(r'^tg\.link\.(code|unlink|notify)$', action):
        resource, verb = 'tasks.tasks', 'view'
    if not resource:
        fail('This action is not available.', 403)
    access.require_permission(user, resource, verb)
    if action in ('admin.user.save', 'admin.user.disable'):
        _no_escalation(user, d)


def _authorize_profile(user, d):
    from organization.models import Profile
    from core.models import Staff
    staff_id = d.get('staff_id')
    if 'manager_id' in d:
        current = Profile.objects.filter(staff_id=str(staff_id or '')).values_list('manager_id', flat=True).first()
        if str(d.get('manager_id') or '') != str(current or ''):
            access.require_permission(user, 'admin.users', 'update')
    if staff_id != user.staff_id:
        if not access.profile_manager(user):
            fail('Only managers and administrators can change other people’s team profiles.' if staff_id else
                 'Only managers and administrators can add team members.', 403)
        if staff_id and isinstance(staff_id, str):
            person = Staff.objects.filter(id=staff_id).first()
            if person:
                profile = Profile.objects.filter(staff_id=staff_id).first()
                email = profile.email if profile else ''
                if (str(d.get('name') or '').strip() != person.name or str(d.get('email') or '').strip().lower() != email.lower()) \
                        and not access.can(user, 'admin.users', 'update'):
                    fail('Only administrators (User accounts “Update”) can change someone’s name or team email.', 403)
    if staff_id and staff_id != user.staff_id and d.get('active') is not None:
        wanted = 0 if d['active'] in (False, 0, '0') else 1
        profile = Profile.objects.filter(staff_id=str(staff_id)).first()
        current = 1 if (profile is None or profile.active) else 0
        if wanted != current and not access.can(user, 'tasks.tasks', 'approve'):
            fail('Only managers and administrators (Task Management “Approve”) can make someone inactive or active again.', 403)


def _no_escalation(user, d):
    """Nobody manages or assigns a role with greater access than their own; Administrator accounts need an Administrator."""
    existing = User.objects.filter(id=d['id']).values('id', 'role_id').first() if d.get('id') else None
    perms = access.permissions(user)

    def manageable(role_id, settings):
        if role_id == ADMIN_ROLE:
            return user.role_id == ADMIN_ROLE
        if user.role_id == ADMIN_ROLE or access.can(user, 'admin.roles', 'update', perms):
            return True
        hidden = access.hidden_functions()
        return all(access.can(user, r, a, perms) for r, actions in access.effective(role_id, settings).items() if r not in hidden for a in actions)
    previous = access.user_settings(User.objects.get(id=existing['id'])) if existing else {}
    proposed = access.normalize_settings(d.get('function_settings'))
    proposed = previous if proposed is None else proposed
    if (existing and not manageable(existing['role_id'], previous)) or (d.get('role_id') and not manageable(d['role_id'], proposed)):
        fail('You cannot manage or assign a role with greater access than your own. Administrator accounts require an Administrator.', 403)

"""One Task policy for state, direct URLs, reports, notifications and document delivery."""
from core.i18n import msg as _message
from django.utils import timezone
from core.errors import fail
from organization.governance import is_personal_workspace
from .models import Task, TaskAssignee, TaskMember

VISIBILITIES = ('PERSONAL', 'PUBLIC', 'ORGANIZATIONAL')


def member_permissions(gov, staff):
    return gov._cached('task-members', staff, lambda: dict(TaskMember.objects.filter(staff_id=staff).values_list('task_id', 'permission')))


def manager_options(gov, workspace):
    if not workspace or workspace['kind'] != 'ORGANIZATIONAL':
        return []
    viewers = gov.scope_viewers(workspace)
    candidates = set(gov.responsible_options(workspace['owner_id'])) | {workspace.get('governing_manager_id'), workspace['owner_id']}
    return [{'id': m, 'name': gov.person(m)['name']} for m in sorted(candidates - {None})
            if gov.active(m) and gov.level(m) == 2 and (viewers is None or m in viewers)]


def management_reason(gov, staff, task, w=None):
    w = w or gov.ws_by_id(task['workspace_id'])
    if not w or w.get('deleted_at') or not gov.operational_access(staff) or task.get('visibility') == 'PERSONAL':
        return None
    if gov.global_workspaces(staff):
        return 'organization'
    if is_personal_workspace(w):
        return None
    viewers = gov.scope_viewers(w)
    if viewers is not None and staff not in viewers:
        return None  # chosen Workspace scope takes precedence over the old governor/PIC line
    manager = task.get('governing_manager_id')
    if task.get('visibility') == 'ORGANIZATIONAL':
        manager = manager or w.get('governing_manager_id')
        if not manager or not gov.active(manager) or gov.level(manager) != 2:
            return None
        return 'governance' if staff == manager or staff in gov.primary_upline(manager) else None
    if gov.manages_workspace(staff, w) or gov.governs(staff, w):
        return 'governance' if gov.governs(staff, w) else 'team'
    if viewers is None and gov.can_view_workspace(staff, w) and task.get('pic_id') in gov.descendants(staff):
        return 'team'
    return None


def visibility_reason(gov, staff, task, involved):
    w = gov.ws_by_id(task['workspace_id'])
    if not w or w.get('deleted_at') or not gov.operational_access(staff):
        return None
    if task.get('visibility', 'PUBLIC') == 'PERSONAL':
        return 'involved' if task['created_by'] == staff else 'organization' if gov.global_workspaces(staff) else None
    if involved:
        return 'involved'
    if gov.global_workspaces(staff):
        return 'organization'
    if task['id'] in member_permissions(gov, staff):
        return 'shared'
    return management_reason(gov, staff, task, w)


def validate_manager(gov, actor, data, old, workspace, visibility):
    value = data.get('governing_manager_id', (old or {}).get('governing_manager_id')) or None
    if visibility != 'ORGANIZATIONAL':
        return None
    options = [m['id'] for m in manager_options(gov, workspace)]
    if not value:
        value = workspace.get('governing_manager_id') if workspace.get('governing_manager_id') in options else options[0] if len(options) == 1 else None
    if value not in options:
        fail(_message('Choose an authorized Level 2 manager for this Task.'), 422)
    if old and value != old.get('governing_manager_id') and not can_manage_members(gov, actor, old):
        # Existing records without a specific scope retain their Workspace governor.
        if old.get('governing_manager_id') or value != workspace.get('governing_manager_id'):
            fail(_message('Only the Task owner or authorized Administration can change its management scope.'), 403)
    return value


def can_manage_members(gov, actor, task):
    return gov.operational_access(actor) and (task['created_by'] == actor or gov.global_workspaces(actor))


def validate_visibility(gov, actor, data, old, workspace):
    value = data.get('visibility', (old or {}).get('visibility', 'PUBLIC'))
    if value not in VISIBILITIES:
        fail(_message('Choose Personal, Public or Organizational task visibility.'), 422)
    if old and value != old.get('visibility', 'PUBLIC'):
        if not can_manage_members(gov, actor, old):
            fail(_message('Only the Task owner or authorized Administration can change its visibility.'), 403)
        if value == 'PERSONAL' and TaskMember.objects.filter(task_id=old['id']).exists():
            fail(_message('Remove explicit shares before changing to owner-only visibility.'), 409)
        if value == 'PERSONAL' and (
                any(old.get(field) and old.get(field) != old['created_by']
                    for field in ('pic_id', 'reviewer_id', 'assigned_by'))
                or TaskAssignee.objects.filter(task_id=old['id']).exclude(staff_id=old['created_by']).exists()):
            fail(_message('Personal Tasks can only contain the owner. Remove other responsible people first.'), 409)
    if value == 'ORGANIZATIONAL' and (workspace['kind'] != 'ORGANIZATIONAL' or not workspace.get('governing_manager_id')):
        fail(_message('Organizational tasks require a Workspace with an authorized governing manager.'), 422)
    return value


def save_members(service, data, actor, source):
    task = service.task(data.get('id'))
    if not service.scope.can_see(actor, task):
        service.hidden()
    if not can_manage_members(service.gov, actor, task):
        fail(_message('Only the Task owner or authorized Administration can manage sharing.'), 403)
    service.check_version(task, data.get('expected_version'))
    if task.get('visibility') == 'PERSONAL':
        fail(_message('Change this Task to Public or Organizational before sharing it.'), 409)
    if service.pending_change(task['id']):
        fail(_message('Resolve the pending Task change before changing sharing.'), 409)
    entries = data.get('members')
    if not isinstance(entries, list) or len(entries) > 50:
        fail(_message('Choose up to 50 Task members.'), 422)
    chosen = {}
    w = service.workspace(task['workspace_id'])
    for entry in entries:
        if not isinstance(entry, dict) or entry.get('permission') not in ('VIEWER', 'CONTRIBUTOR'):
            fail(_message('Choose Viewer or Contributor for each Task member.'), 422)
        staff = service.assignable(entry.get('staff_id'))
        service.gov.require_operational(staff)
        if staff in chosen:
            fail(_message('Include each Task member once.'), 422)
        service.gov.check_collaborator(actor, w, staff, existing=TaskMember.objects.filter(task_id=task['id'], staff_id=staff).exists())
        chosen[staff] = entry['permission']
    before = list(TaskMember.objects.filter(task_id=task['id']).values('staff_id', 'permission'))
    TaskMember.objects.filter(task_id=task['id']).exclude(staff_id__in=chosen).delete()
    for staff, permission in chosen.items():
        TaskMember.objects.update_or_create(task_id=task['id'], staff_id=staff,
            defaults={'permission': permission, 'granted_by_id': actor, 'created_at': timezone.now()})
    Task.objects.filter(id=task['id']).update(version=task['version'] + 1, updated_at=timezone.now())
    service.gov.invalidate()
    import json
    service.history(task, 'sharing', task, actor, source, json.dumps({'before': before, 'after': entries}))
    service.log(actor, 'task', task['id'], task['workspace_id'], _message('Task sharing updated'))
    return {'id': task['id'], 'type': 'tm_task', 'message': _message('Task sharing saved. Responsible roles are unchanged.')}

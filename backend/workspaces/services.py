"""Workspace commands from tasks.mjs (V5.7.7): routing to governance, the legacy (ungoverned) save, and archiving.

Routing is unchanged: a governed workspace — or any new workspace once Organizational Structure is initialized, or one
created as PERSONAL / PUBLIC / ORGANIZATIONAL — is saved by organization governance. Otherwise the original V5.4 rules
apply: owners and workspace managers (Workspace Delete) change owner and members; members may edit the details.
"""
from django.utils import timezone

from accounts import services as access
from audit.services import log
from core import hooks
from core.errors import fail
from core.rows import row
from core.services import active_staff, next_id
from core.validation import choice, text
from organization.models import Profile

from .models import COLORS, Workspace, WorkspaceMember

NOT_FOUND = 'Task Management record not found.'


def find_workspace(key):
    w = Workspace.objects.filter(id=text(key, 'Record ID', 60, True)).first()
    if not w:
        fail(NOT_FOUND, 404)
    return row(w)


def active_profile(staff_id):
    """tasks.mjs profile(): an active staff member whose team profile (if any) is active."""
    active_staff(staff_id)
    p = Profile.objects.filter(staff_id=staff_id).first()
    if p and not p.active:
        fail('Choose an active team member.')
    return p


def chosen_people(values):
    if not isinstance(values, list) or not values or len(values) > 100:
        fail('Choose 1–100 people.')
    ids = list(dict.fromkeys(values))
    for key in ids:
        active_profile(key)
    return ids


def is_member(wid, staff):
    return WorkspaceMember.objects.filter(workspace_id=wid, staff_id=staff).exists()


def save(gov, d, actor):
    """tm.workspace.save"""
    if d.get('id'):
        routed = gov.governed(find_workspace(d['id']))
    else:
        routed = gov.settings()['enabled'] or d.get('kind') in ('PERSONAL', 'PUBLIC', 'ORGANIZATIONAL')
    if routed:
        return gov.save_workspace(d, actor)
    return save_legacy(gov, d, actor)


def save_legacy(gov, d, actor):
    old = find_workspace(d['id']) if d.get('id') else None
    if old and d.get('expected_version') != old['version']:
        fail('This record changed. Refresh it before saving again.', 409)
    if d.get('member_ids') is not None and not isinstance(d.get('member_ids'), list):
        fail('Select workspace members.')
    owner = active_staff(d.get('owner_id')).id
    members = chosen_people(list(dict.fromkeys([*(d.get('member_ids') or []), owner])))
    if old:
        if not gov.can_view_workspace(actor, old):
            fail(NOT_FOUND, 404)
        manager = old['owner_id'] == actor or access.can_staff(actor, 'tasks.workspace', 'delete')
        if not manager and not is_member(old['id'], actor):
            fail('Only members of this workspace, its owner and workspace managers can change it.', 403)
        if not manager:
            current = {old['owner_id'], *WorkspaceMember.objects.filter(workspace_id=old['id']).values_list('staff_id', flat=True)}
            if owner != old['owner_id'] or set(members) != current:
                fail('Only the workspace’s owner or a workspace manager can change its owner or members.', 403)
    key = old['id'] if old else None
    if old:
        for staff in WorkspaceMember.objects.filter(workspace_id=key).exclude(staff_id__in=members).values_list('staff_id', flat=True):
            if any(open_work(key, staff) for open_work in hooks.MEMBER_OPEN_WORK):
                fail('Reassign open work before removing this workspace member.')
    name = text(d.get('name'), 'Workspace name', 200, True)
    values = {'name': name, 'description': text(d.get('description'), 'Description', 5000),
              'department': text(d.get('department'), 'Department', 150), 'owner_id': owner,
              'color': choice(d.get('color') or 'BLUE', COLORS, 'workspace color'),
              'status': (old or {}).get('status') or 'ACTIVE', 'version': old['version'] + 1 if old else 0,
              'updated_at': timezone.now()}
    if any(n.lower() == name.lower() for n in Workspace.objects.exclude(id=key or '').values_list('name', flat=True)):
        fail('A workspace with this name already exists. Choose a different name.', 409)
    if old:
        Workspace.objects.filter(id=key).update(**values)
    else:
        key = next_id('tm-workspace', 'WS')
        Workspace.objects.create(id=key, created_by_id=actor, created_at=timezone.now(), **values)
    WorkspaceMember.objects.filter(workspace_id=key).delete()
    WorkspaceMember.objects.bulk_create(WorkspaceMember(workspace_id=key, staff_id=s) for s in members)
    gov.invalidate()
    log(actor, 'workspace', key, key, 'Workspace updated' if old else 'Workspace created', name)
    return {'id': key, 'type': 'tm_workspace'}


def archive(gov, d, actor):
    """tm.workspace.archive — needs Workspace Delete (checked by authorize) and, when governed, management authority."""
    w = find_workspace(d.get('id'))
    if not gov.can_view_workspace(actor, w):
        fail(NOT_FOUND, 404)
    if gov.governed(w) and not gov.can_manage_workspace(actor, w):
        fail('Workspace management authority is required.', 403)
    if d.get('expected_version') != w['version']:
        fail('This record changed. Refresh it before saving again.', 409)
    status = choice(d.get('status'), ['ACTIVE', 'ARCHIVED'], 'workspace status')
    if status == 'ARCHIVED' and any(open_work(w['id']) for open_work in hooks.WORKSPACE_OPEN_WORK):
        fail('Complete or cancel open tasks and meetings before archiving this workspace.')
    Workspace.objects.filter(id=w['id']).update(status=status, version=w['version'] + 1, updated_at=timezone.now())
    gov.invalidate()
    log(actor, 'workspace', w['id'], w['id'], f'Workspace {status.lower()}')
    return {'id': w['id'], 'type': 'tm_workspace'}


def handle(gov, action, d, actor):
    if action in ('tm.workspace.delete', 'tm.workspace.restore'):
        return gov.remove_workspace(d, actor, action.endswith('.restore'))
    if action == 'tm.workspace.member.remove':
        return gov.remove_member(d, actor)
    if action == 'tm.workspace.member.add':
        return gov.membership_request(d, actor)
    if action == 'tm.workspace.save':
        return save(gov, d, actor)
    if action == 'tm.workspace.archive':
        return archive(gov, d, actor)
    fail('Unknown Task Management action.', 404)



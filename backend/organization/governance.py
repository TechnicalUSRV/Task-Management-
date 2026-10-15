"""Organizational Structure governance — a rule-by-rule port of organization.mjs (V5.7.7).

One company-local authority service. It never trusts employee, role or approver identifiers supplied by the client
as proof of identity. Every mutation runs inside the command transaction; `expected_revision` is a compare-and-swap on
org_settings.revision for governance edits.

Rows are handled as plain dicts with V5.7.7 column names (see core.rows), so each rule reads like the original.
A Governance instance memoizes reads; every write in this module calls `invalidate()`.
"""
import hashlib
import json

from django.utils import timezone

from accounts import services as access
from accounts.models import User
from core import hooks
from core.errors import fail
from core.models import Staff
from core.rows import row, rows
from core.services import active_staff, next_id
from core.validation import integer, iso, text
from notifications.models import Notification
from workspaces.models import COLORS, Workspace, WorkspaceMember

from .models import CAPABILITIES, OrgAudit, OrgGrant, OrgLevel, OrgRequest, OrgSettings, OrgTemplate, Profile


# ---------------------------------------------------------------- small helpers (organization.mjs top)
def jtext(value):
    """JSON.stringify: compact, key order preserved, None -> 'null'."""
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def parse(value, fallback=None):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {} if fallback is None else fallback


def jhash(value):
    return hashlib.sha256(jtext(value).encode('utf-8')).hexdigest()


def uniq(values):
    out = []
    for v in values:
        if v and v not in out:
            out.append(v)
    return out


def display_name(name, nickname):
    return f'{name} ({nickname})' if nickname else name


def is_personal_workspace(w):
    """workspace-privacy.mjs isPersonalWorkspace."""
    if not w:
        return False
    visibility = w.get('visibility') or ('PERSONAL' if w.get('kind') == 'PERSONAL' else 'PUBLIC')
    return visibility == 'PERSONAL'


def now():
    return timezone.now()


class Governance:
    def __init__(self):
        self._memo = {}

    # ------------------------------------------------------------ memo
    def invalidate(self):
        self._memo = {}

    def _cached(self, kind, key, fn):
        bucket = self._memo.setdefault(kind, {})
        if key not in bucket:
            bucket[key] = fn()
        return bucket[key]

    # ------------------------------------------------------------ reads
    def settings(self):
        return self._cached('settings', '', lambda: row(OrgSettings.objects.get_or_create(id=1)[0]))

    def bump(self):
        from django.db.models import F
        OrgSettings.objects.filter(id=1).update(revision=F('revision') + 1)
        self.invalidate()

    def ws_by_id(self, key):
        if not key:
            return None
        return self._cached('ws', key, lambda: row(Workspace.objects.filter(id=key).first()))

    def ws(self, key):
        w = Workspace.objects.filter(id=text(key, 'Workspace', 60, True)).first()
        if not w:
            fail('Workspace not found.', 404)
        return row(w)

    def member_role(self, wid, staff):
        roles = self._cached('roles', wid, lambda: dict(
            WorkspaceMember.objects.filter(workspace_id=wid).values_list('staff_id', 'member_role')))
        return roles.get(staff)

    def active(self, staff):
        return self._cached('active', staff, lambda: access.staff_is_active(staff))

    def require_active(self, staff):
        active_staff(staff)
        if not self.active(staff):
            fail('Choose an active employee with a company login.', 422)
        return staff

    def person(self, staff):
        def load():
            s = Staff.objects.filter(id=staff).first() if staff else None
            if not s:
                return None
            p = Profile.objects.filter(staff_id=staff).first()
            nickname = p.nickname if p else None
            # Key order as V5.7.7 builds it (audit snapshots keep it): the row, then username.
            return {'staff_id': s.id, 'name': display_name(s.name, nickname), 'nickname': nickname,
                    'org_level': p.org_level_id if p else None, 'manager_id': p.manager_id if p else None,
                    'active': (1 if p.active else 0) if p else 1, 'department': p.department if p else None,
                    'position': p.position if p else None, 'username': s.name}
        return self._cached('person', staff, load)

    def level(self, staff):
        p = self.person(staff)
        return p['org_level'] if p and p['org_level'] else None

    def is_level1(self, staff):
        return self.active(staff) and self.level(staff) == 1

    def legacy_admin(self, staff):
        return self._cached('administration-role', staff, lambda: User.objects.filter(
            staff_id=staff, active=True).values_list('role_id', flat=True).first() == access.ADMIN_ROLE)

    def can_staff(self, staff, resource, action='view'):
        return self._cached('can', (staff, resource, action), lambda: access.can_staff(staff, resource, action))

    def require_admin(self, staff):
        if not self.is_level1(staff):
            fail('An organization administrator (Level 1) must approve this action.', 403)

    @staticmethod
    def governed(w):
        return bool(w) and w['kind'] != 'LEGACY'

    def member(self, wid, staff):
        return self.active(staff) and bool(self.member_role(wid, staff))

    # ------------------------------------------------------------ reporting tree
    def tree(self):
        def load():
            # V5.7.7 reads tm_profiles in insertion order; profiles are created with their staff record, so staff_id order.
            data = list(Profile.objects.order_by('staff_id').values_list('staff_id', 'manager_id', 'org_level_id'))
            parents = {s: m for s, m, _ in data}
            children = {}
            for s, m, _ in data:
                if m:
                    children.setdefault(m, []).append(s)
            return {'rows': [{'staff_id': s, 'manager_id': m, 'org_level': lv} for s, m, lv in data],
                    'parents': parents, 'children': children, 'subtrees': {}}
        return self._cached('tree', '', load)

    def descendants(self, staff):
        t = self.tree()
        if staff in t['subtrees']:
            return t['subtrees'][staff]
        # A dict keeps V5.7.7's Set order (breadth first), which impact previews list.
        out, queue, at = {}, list(t['children'].get(staff, [])), 0
        while at < len(queue):
            k = queue[at]
            at += 1
            if k == staff or k in out:
                continue
            out[k] = True
            queue.extend(t['children'].get(k, []))
        t['subtrees'][staff] = out
        return out

    def in_branch(self, root, staff):
        return root == staff or staff in self.descendants(root)

    def governor(self, staff):
        def find():
            parents, seen, at = self.tree()['parents'], set(), staff
            while at and at not in seen:
                seen.add(at)
                if self.level(at) == 2 and self.active(at):
                    p = self.person(at)
                    return at if p['manager_id'] and self.is_level1(p['manager_id']) else None
                at = parents.get(at)
            return None
        return self._cached('governor', staff, find)

    def governs(self, staff, w):
        return w['kind'] == 'ORGANIZATIONAL' and w['governing_manager_id'] == staff and self.governor(staff) == staff

    # ------------------------------------------------------------ delegated authority
    def grant_row(self, key):
        return row(OrgGrant.objects.filter(id=key).first()) if key else None

    def valid_grant(self, g, seen=None):
        seen = set() if seen is None else seen
        if (not g or g['status'] != 'ACTIVE' or g['id'] in seen or not self.active(g['beneficiary_id'])
                or (self.level(g['beneficiary_id']) or 0) < 3
                or self.governor(g['beneficiary_id']) != g['governing_manager_id']
                or not self.in_branch(g['branch_root_id'], g['beneficiary_id'])):
            return False
        seen.add(g['id'])
        if g['workspace_id']:
            w = self.ws_by_id(g['workspace_id'])
            if not w or w['kind'] != 'ORGANIZATIONAL' or w['governing_manager_id'] != g['governing_manager_id']:
                return False
        if g['parent_grant_id']:
            p = self.grant_row(g['parent_grant_id'])
            if (not self.valid_grant(p, seen) or not self.in_branch(p['branch_root_id'], g['beneficiary_id'])
                    or not all(k in parse(p['capabilities_json'], []) for k in parse(g['capabilities_json'], []))):
                return False
        return True

    def grants(self, staff):
        return self._cached('grants', staff, lambda: [
            g for g in rows(OrgGrant.objects.filter(beneficiary_id=staff, status='ACTIVE')) if self.valid_grant(g)])

    def has_capability(self, staff, cap, w=None):
        if self.is_level1(staff):
            return not w or w['kind'] != 'PERSONAL'
        if w and self.governs(staff, w):
            return True
        if not w and self.governor(staff) == staff:
            return True
        for g in self.grants(staff):
            if cap not in parse(g['capabilities_json'], []):
                continue
            if not w or (w['kind'] == 'ORGANIZATIONAL' and w['governing_manager_id'] == g['governing_manager_id'] and
                         (not g['workspace_id'] or g['workspace_id'] == w['id'] or g['id'] == w['owner_grant_id'])):
                return True
        return False

    def global_workspaces(self, staff):
        return self.legacy_admin(staff) and self.can_staff(staff, 'admin.workspaces', 'view')

    def can_manage_structure(self, staff):
        return self.can_staff(staff, 'tasks.organization', 'create')

    # ------------------------------------------------------------ workspace authority
    def workspace_reason(self, staff, w):
        if not w or w['deleted_at'] or not self.active(staff):
            return None
        if self.global_workspaces(staff):
            return 'organization'
        if w['owner_id'] == staff:
            return 'owner'
        if is_personal_workspace(w):
            return None
        if self.member(w['id'], staff):
            return 'membership'
        if w['owner_id'] in self.descendants(staff):
            return 'team'
        if self.governs(staff, w):
            return 'governance'
        return None

    def can_view_workspace(self, staff, w):
        return bool(self.workspace_reason(staff, w))

    def workspace_override(self, staff, w):
        return bool(w) and w['kind'] == 'ORGANIZATIONAL' and self.global_workspaces(staff)

    def can_manage_workspace(self, staff, w, deleted=False):
        if not self.active(staff) or not w or (w['deleted_at'] and not deleted):
            return False
        if w['kind'] == 'LEGACY':
            return self.can_view_workspace(staff, w) and (w['owner_id'] == staff or self.can_staff(staff, 'tasks.workspace', 'delete'))
        if w['kind'] == 'PERSONAL':
            return w['owner_id'] == staff
        return (self.workspace_override(staff, w) or self.governs(staff, w) or
                (w['owner_id'] == staff and self.has_capability(staff, 'workspace_manage', w)))

    def creator(self, actor, w):
        return self.active(actor) and w['created_by'] == actor

    def can_delete_workspace(self, staff, w):
        return bool(w) and not w['deleted_at'] and self.creator(staff, w)

    def can_restore_workspace(self, staff, w):
        return bool(w) and bool(w['deleted_at']) and self.creator(staff, w)

    def can_archive_workspace(self, staff, w):
        return (bool(w) and not w['deleted_at'] and self.can_staff(staff, 'tasks.workspace', 'delete')
                and self.can_manage_workspace(staff, w))

    def can_create_resource(self, staff, w):
        if w and w['deleted_at']:
            return False
        if not self.governed(w):
            return not User.objects.exists() or self.can_view_workspace(staff, w)
        if not self.can_view_workspace(staff, w):
            return False
        return (w['owner_id'] == staff or self.governs(staff, w) or self.workspace_override(staff, w)
                or self.member_role(w['id'], staff) == 'MEMBER')

    def can_collaborate_outside(self, staff, w):
        if w and w['deleted_at']:
            return False
        if not self.governed(w):
            return True
        return w['owner_id'] == staff if w['kind'] == 'PERSONAL' else self.has_capability(staff, 'collaborate_outside', w)

    def check_collaborator(self, staff, w, target, existing=False, system=False):
        if not self.governed(w):
            return
        self.require_active(target)
        if existing or system or self.member(w['id'], target) or w['owner_id'] == target:
            return
        if not self.can_collaborate_outside(staff, w):
            fail('Inviting someone outside this workspace requires approved outside-collaboration authority. Request membership instead.', 403)

    # Task and meeting authority paths (task-specific actions stay in the tasks app).
    def task_reason(self, staff, t, involved):
        """'involved' | 'organization' | 'owner' | workspace reason | 'team' | None; NOTSET means: use the legacy rule."""
        w = self.ws_by_id(t['workspace_id'])
        if not w or w['deleted_at']:
            return None
        if not self.active(staff):
            return NOTSET if not self.governed(w) and not User.objects.exists() else None
        if involved:
            return 'involved'
        if self.global_workspaces(staff):
            return 'organization'
        if w['owner_id'] == staff:
            return 'owner'
        if is_personal_workspace(w):
            return None
        reason = self.workspace_reason(staff, w)
        if reason:
            return reason
        if t.get('pic_id') and t['pic_id'] in self.descendants(staff):
            return 'team'
        return NOTSET if w['kind'] == 'LEGACY' else None

    def meeting_reason(self, staff, m, participant, shared):
        w = self.ws_by_id(m['workspace_id'])
        if w and w['deleted_at']:
            return False
        if not self.governed(w):
            return NOTSET
        if not self.active(staff):
            return False
        if participant:
            return True
        if is_personal_workspace(w):
            return shared and (m.get('share_scope') == 'SELECTED' or self.can_view_workspace(staff, w))
        return shared

    def workspace_removed(self, wid):
        return bool(wid) and bool((self.ws_by_id(wid) or {}).get('deleted_at'))

    # ------------------------------------------------------------ audit, revision and requests
    def audit(self, actor, action, employee=None, workspace=None, before=None, after=None, reason='', approval=None):
        OrgAudit.objects.create(actor_id=actor, action=action, employee_id=employee, workspace_id=workspace,
                                before_json=jtext(before), after_json=jtext(after), reason=reason or '',
                                approval_id=approval, created_at=now())

    def expected(self, d):
        if d.get('expected_revision') != self.settings()['revision']:
            fail('Organizational governance changed. Refresh the preview before saving.', 409)

    @staticmethod
    def capabilities(value):
        if not isinstance(value, list) or len(value) > len(CAPABILITIES) or any(x not in CAPABILITIES for x in value):
            fail('Choose valid scoped capabilities.', 422)
        return sorted(uniq(value))

    @staticmethod
    def require_reason(d):
        return text(d.get('reason'), 'Reason', 2000, True)

    def assign_person(self, staff, org_level, manager):
        if manager and manager == staff:
            # V5.7.7 stores the change and validateTree() then refuses it with this message; here the database's own
            # check (tm_profile_not_own_manager) would refuse it first, so the same answer is given before writing.
            fail('The reporting manager must be active at an earlier valid level: Level 2 reports to Level 1; Level 3+ reports through Level 2.', 422)
        updated = Profile.objects.filter(staff_id=staff).first()
        if updated:
            Profile.objects.filter(staff_id=staff).update(org_level_id=org_level, manager_id=manager, version=updated.version + 1)
        else:
            Profile.objects.create(staff_id=staff, org_level_id=org_level, manager_id=manager)
        self.invalidate()

    def validate_tree(self):
        data = [p for p in self.tree()['rows'] if p['org_level']]
        by = {p['staff_id']: p for p in data}
        levels = set(OrgLevel.objects.values_list('id', flat=True))
        for p in data:
            if p['org_level'] not in levels:
                fail('Choose a configured organizational level.', 422)
            if p['org_level'] == 1:
                if p['manager_id']:
                    fail('Level 1 employees report to the organization root.', 422)
                continue
            m = by.get(p['manager_id'])
            if (not m or not self.active(p['manager_id']) or m['staff_id'] == p['staff_id'] or m['org_level'] >= p['org_level']
                    or (p['org_level'] == 2 and m['org_level'] != 1) or (p['org_level'] >= 3 and m['org_level'] < 2)):
                fail('The reporting manager must be active at an earlier valid level: Level 2 reports to Level 1; Level 3+ reports through Level 2.', 422)
            seen, at = {p['staff_id']}, p['manager_id']
            while at:
                if at in seen:
                    fail('Reporting cycles are not allowed.', 422)
                seen.add(at)
                at = (by.get(at) or {}).get('manager_id')
        if self.settings()['enabled'] and not any(p['org_level'] == 1 and self.active(p['staff_id']) for p in data):
            fail('Keep at least one active Level 1 organization administrator.', 409)

    def ensure_workspace_authority(self, w):
        if w['kind'] != 'ORGANIZATIONAL':
            return
        g = w['governing_manager_id']
        if not g or self.governor(g) != g:
            fail('Choose an active Level 2 governing manager who reports to Level 1.', 422)
        self.require_active(w['owner_id'])
        if w['owner_id'] != g:
            grant = self.grant_row(w['owner_grant_id']) if w.get('owner_grant_id') else None
            if (self.governor(w['owner_id']) != g or not self.valid_grant(grant) or grant['beneficiary_id'] != w['owner_id']
                    or 'workspace_create' not in parse(grant['capabilities_json'], [])):
                fail(f"Workspace {w['name']} needs a valid owner grant or a responsible Level 2 replacement.", 409)

    def affected(self, staff_ids=(), grant_id=None):
        # Ordered like V5.7.7 (insertion-ordered Sets; rows in the order they were created, which their ids follow).
        employees = dict.fromkeys(staff_ids)
        for staff in staff_ids:
            employees.update(dict.fromkeys(self.descendants(staff)))
        active_grants = rows(OrgGrant.objects.filter(status='ACTIVE').order_by('id'))
        if grant_id:
            linked = {grant_id: True}
        else:
            linked = dict.fromkeys(g['id'] for g in active_grants if g['beneficiary_id'] in employees or g['governing_manager_id'] in employees)
        changed = True
        while changed:
            changed = False
            for g in active_grants:
                if g['parent_grant_id'] in linked and g['id'] not in linked:
                    linked[g['id']] = True
                    changed = True
        workspaces = [{k: w[k] for k in ('id', 'name', 'owner_id', 'governing_manager_id', 'owner_grant_id', 'version')}
                      for w in rows(Workspace.objects.filter(kind='ORGANIZATIONAL', deleted_at__isnull=True).order_by('id'))
                      if w['owner_id'] in employees or w['governing_manager_id'] in employees or w['owner_grant_id'] in linked]
        wids = {w['id'] for w in workspaces}
        requests = [{k: q[k] for k in ('id', 'kind', 'workspace_id', 'beneficiary_id', 'approver_id')}
                    for q in rows(OrgRequest.objects.filter(status__in=['PENDING', 'REVIEW']).order_by('id'))
                    if q['beneficiary_id'] in employees or q['approver_id'] in employees or q['workspace_id'] in wids]
        memberships = [{'workspace_id': w, 'staff_id': s} for w, s in WorkspaceMember.objects.filter(
            workspace__kind='ORGANIZATIONAL').order_by('id').values_list('workspace_id', 'staff_id') if s in employees]
        return {'employees': list(employees), 'grants': list(linked), 'workspaces': workspaces,
                'memberships': memberships, 'requests': requests}

    def visible_impact(self, actor, impact):
        workspaces = [w for w in impact['workspaces'] if self.can_view_workspace(actor, self.ws_by_id(w['id']))]
        ids = {w['id'] for w in workspaces}

        def grant_ok(key):
            g = self.grant_row(key)
            return bool(g) and (not g['workspace_id'] or g['workspace_id'] in ids) and (
                self.global_workspaces(actor) or g['beneficiary_id'] == actor or g['beneficiary_id'] in self.descendants(actor))
        return {**impact,
                'employees': [x for x in impact['employees'] if self.visible_employee(actor, x)],
                'workspaces': workspaces,
                'memberships': [m for m in impact['memberships'] if m['workspace_id'] in ids],
                'requests': [q for q in impact['requests'] if not q['workspace_id'] or q['workspace_id'] in ids],
                'grants': [k for k in impact['grants'] if grant_ok(k)]}

    def reconcile(self, actor, reason):
        for g in rows(OrgGrant.objects.filter(status='ACTIVE')):
            if not self.valid_grant(g):
                OrgGrant.objects.filter(id=g['id']).update(status='SUSPENDED', version=g['version'] + 1, updated_at=now())
                self.audit(actor, 'delegation.suspended', employee=g['beneficiary_id'], workspace=g['workspace_id'],
                           before=g, after={'status': 'SUSPENDED'}, reason=reason)
                self.invalidate()
        for w in rows(Workspace.objects.filter(kind='ORGANIZATIONAL', deleted_at__isnull=True)):
            self.ensure_workspace_authority(w)
        for q in rows(OrgRequest.objects.filter(status__in=['PENDING', 'REVIEW'])):
            try:
                following = self.approver_for(q['kind'], parse(q['payload_json']), q['requester_id'])
            except Exception:  # noqa: BLE001 — an invalid payload simply has no approver (V5.7.7 behavior)
                following = None
            if q['approver_id'] != following:
                OrgRequest.objects.filter(id=q['id']).update(approver_id=following, status='PENDING' if following else 'REVIEW',
                                                             version=q['version'] + 1, updated_at=now())
                self.audit(actor, 'request.rerouted', employee=q['beneficiary_id'], workspace=q['workspace_id'],
                           before={'approver': q['approver_id']}, after={'approver': following}, reason=reason, approval=q['id'])
                if following:
                    self.notify(following, row(OrgRequest.objects.get(id=q['id'])), 'review', 'A governance request now needs your review.')

    def replacement_workspaces(self, d, actor, approval=None, impact=None):
        replacements = d.get('workspace_replacements') or []
        if not isinstance(replacements, list) or any(not isinstance(x, dict) for x in replacements):
            fail('Provide valid workspace replacements.', 422)
        if impact and any(not any(w['id'] == x.get('id') for w in impact['workspaces']) for x in replacements):
            fail('Workspace replacements must belong to the affected scope shown in the preview.', 422)
        for change in replacements:
            old = self.ws(change.get('id'))
            if old['kind'] != 'ORGANIZATIONAL':
                fail('Only organizational workspaces need a governance replacement.', 422)
            if not self.is_level1(actor) and not self.governs(actor, old):
                fail('This workspace belongs to another management branch.', 403)
            following = {**old, 'owner_id': self.require_active(change.get('owner_id')),
                         'governing_manager_id': self.require_active(change.get('governing_manager_id')),
                         'owner_grant_id': change.get('owner_grant_id') or None}
            self.ensure_workspace_authority(following)
            Workspace.objects.filter(id=old['id']).update(owner_id=following['owner_id'], governing_manager_id=following['governing_manager_id'],
                                                          owner_grant_id=following['owner_grant_id'], version=old['version'] + 1, updated_at=now())
            self.invalidate()
            self.activate_member(old['id'], following['owner_id'], actor, 'MEMBER', approval)
            self.audit(actor, 'workspace.governance', workspace=old['id'], before=old, after=following, reason=d.get('reason') or '', approval=approval)

    # ------------------------------------------------------------ reporting structure
    def structure_changes(self, d):
        value = d.get('changes') or [{'staff_id': d.get('staff_id'), 'level': d.get('level'), 'manager_id': d.get('manager_id')}]
        if not isinstance(value, list) or not value or len(value) > 500 or any(not isinstance(x, dict) for x in value):
            fail('Supply 1–500 reporting changes.', 422)
        if len({str(x.get('staff_id')) for x in value}) != len(value):
            fail('Include each employee only once in a structural change.', 422)
        return [{'staff_id': self.require_active(x.get('staff_id')),
                 'level': None if x.get('level') is None else integer(x.get('level'), 1, 1000, 'level'),
                 'manager_id': self.require_active(x['manager_id']) if x.get('manager_id') else None} for x in value]

    def can_change_structure(self, actor, changes):
        if self.is_level1(actor):
            return True
        return self.governor(actor) == actor and all(
            x['staff_id'] != actor and (self.level(x['staff_id']) or 0) >= 3 and (x['level'] or 0) >= 3
            and self.governor(x['staff_id']) == actor and self.governor(x['manager_id']) == actor
            and x['manager_id'] != x['staff_id'] for x in changes)

    def save_structure(self, d, actor, approval=None):
        changes = self.structure_changes(d)
        if not self.can_change_structure(actor, changes):
            fail('This structural change needs the responsible Level 2 or a Level 1 administrator.', 403)
        reason = self.require_reason(d)
        self.expected(d)
        if d.get('acknowledged') is not True:
            fail('Review and acknowledge the affected scope before saving.', 422)
        impact = self.affected([x['staff_id'] for x in changes])
        before = [self.person(x['staff_id']) for x in changes]
        for x in changes:
            self.assign_person(x['staff_id'], x['level'], x['manager_id'])
        self.validate_tree()
        self.replacement_workspaces(d, actor, approval, impact)
        self.reconcile(actor, reason)
        for i, x in enumerate(changes):
            self.audit(actor, 'employee.structure', employee=x['staff_id'], before=before[i], after=self.person(x['staff_id']),
                       reason=reason, approval=approval)
        self.bump()
        return {'type': 'org_structure', 'message': 'Reporting structure saved. Existing tasks and approvals keep their responsible people.',
                'impact': self.visible_impact(actor, impact)}

    # ------------------------------------------------------------ requests and approvals
    def notify(self, staff, q, event, body):
        if not staff or not self.active(staff):
            return
        Notification.objects.create(staff_id=staff, kind=f'organization_{event}', org_request_id=q['id'],
                                    title=f"Organization: {q['kind'].lower()} {event}", body=body,
                                    actor_id=q['requester_id'], created_at=now())

    def approver_for(self, kind, p, requester):
        if kind == 'MEMBERSHIP':
            w = self.ws(p.get('workspace_id'))
            if w['kind'] != 'ORGANIZATIONAL':
                fail('This request needs an organizational workspace.', 422)
            g = w['governing_manager_id']
            return g if self.governor(g) == g else None
        if kind == 'DELEGATION':
            return self.governor(p.get('beneficiary_id'))
        changes = self.structure_changes(p)
        governors = uniq([g for x in changes for g in (self.governor(x['staff_id']), self.governor(x['manager_id']))])
        if (all((x['level'] or 0) >= 3 and (self.level(x['staff_id']) or 0) >= 3 for x in changes)
                and len(governors) == 1 and governors[0] != requester):
            return governors[0]
        for staff in Profile.objects.filter(org_level_id=1).order_by('staff_id').values_list('staff_id', flat=True):
            if staff != requester and self.active(staff):
                return staff
        return None

    def can_decide(self, actor, q):
        if q['status'] not in ('PENDING', 'REVIEW') or q['requester_id'] == actor:
            return False
        try:
            self.decision_authority(actor, q)
            return True
        except Exception:  # noqa: BLE001
            return False

    def request_visible(self, staff, q):
        if not q:
            return False
        workspace_ok = (not q['workspace_id'] or self.can_view_workspace(staff, self.ws_by_id(q['workspace_id']))
                        or q['requester_id'] == staff or q['beneficiary_id'] == staff)
        party = (q['requester_id'] == staff or q['beneficiary_id'] == staff or self.global_workspaces(staff)
                 or (self.is_level1(staff) and (not q['beneficiary_id'] or q['beneficiary_id'] in self.descendants(staff)))
                 or q['approver_id'] == staff)
        return workspace_ok and party

    def notification_visible(self, staff, q):
        if isinstance(q, str):
            q = row(OrgRequest.objects.filter(id=q).first())
        if not self.active(staff) or not q or (q['workspace_id'] and self.workspace_removed(q['workspace_id'])):
            return False
        if q['requester_id'] == staff or q['beneficiary_id'] == staff:
            return True
        try:
            return (q['status'] == 'PENDING' and q['approver_id'] == staff and
                    self.approver_for(q['kind'], parse(q['payload_json']), q['requester_id']) == staff)
        except Exception:  # noqa: BLE001
            return False

    @staticmethod
    def request_key(d):
        """V5.7.7 copies d.request_key into the stored payload; JSON.stringify leaves it out when it was not sent."""
        return {'request_key': d['request_key']} if 'request_key' in d else {}

    def make_request(self, kind, p, actor, approve=False, approval_actor=None):
        approver = self.approver_for(kind, p, actor)
        key = f"{actor}:{kind}:{text(p.get('request_key'), 'Request key', 100, True)}" if p.get('request_key') else None
        def js_or_null(v):   # JavaScript `value || null`
            return None if v is None or v is False or (not isinstance(v, (list, dict)) and v in ('', 0)) else v
        parts = [kind, actor, *(js_or_null(p.get(k)) for k in ('workspace_id', 'beneficiary_id', 'template_id', 'parent_grant_id', 'capabilities',
                                                              'member_role', 'changes'))]
        if p.get('workspace_replacements'):
            parts.append(p['workspace_replacements'])
        fingerprint = jhash(parts)
        existing = (OrgRequest.objects.filter(request_key=key).first() if key else
                    OrgRequest.objects.filter(fingerprint=fingerprint, status__in=['PENDING', 'REVIEW']).first())
        if existing and existing.fingerprint != fingerprint:
            fail('This request key belongs to another governance change.', 409)
        if existing:
            return {'id': existing.id, 'type': 'org_request', 'message': 'Request already recorded.', 'unchanged': True, 'status': existing.status}
        at = now()
        created = OrgRequest.objects.create(id=next_id('org-request', 'ORGREQ'), kind=kind, workspace_id=p.get('workspace_id') or None,
                                            beneficiary_id=p.get('beneficiary_id') or None, requester_id=actor, approver_id=approver,
                                            payload_json=jtext(p), reason=text(p.get('reason'), 'Reason', 2000, True),
                                            status='PENDING' if approver else 'REVIEW', request_key=key, fingerprint=fingerprint,
                                            created_at=at, updated_at=at)
        q = row(created)
        # The audit snapshot is the request as V5.7.7 inserts it (without the columns that only get defaults).
        snapshot = {k: q[k] for k in ('id', 'kind', 'workspace_id', 'beneficiary_id', 'requester_id', 'approver_id', 'payload_json', 'reason',
                                      'status', 'request_key', 'fingerprint', 'created_at', 'updated_at')}
        self.audit(actor, 'request.created', employee=q['beneficiary_id'], workspace=q['workspace_id'], after=snapshot, reason=q['reason'],
                   approval=q['id'])
        if approve:
            return self.decide({'id': q['id'], 'decision': 'APPROVE', 'note': 'Direct authorized approval'}, approval_actor or actor, administrative=True)
        if approver:
            self.notify(approver, q, 'review', f"{self.person(actor)['name']} requested {kind.lower()}. Review the scope before deciding.")
        self.bump()
        return {'id': q['id'], 'type': 'org_request', 'status': q['status'],
                'message': 'Request sent for approval. No access is active yet.' if approver else
                'No valid approver is configured. A Level 1 administrator must correct governance; no access is active.'}

    def activate_member(self, wid, staff, actor, role, approval):
        self.require_active(staff)
        if not WorkspaceMember.objects.filter(workspace_id=wid, staff_id=staff).exists():
            WorkspaceMember.objects.create(workspace_id=wid, staff_id=staff, approved_by_id=actor, approval_id=approval or None,
                                           member_role=role, joined_at=now())
        self.invalidate()

    def owner_can_add(self, actor, w, target):
        return (not w['deleted_at'] and w['status'] == 'ACTIVE' and w['kind'] == 'ORGANIZATIONAL' and self.creator(actor, w)
                and w['owner_id'] == actor and self.has_capability(actor, 'membership_request', w)
                and self.has_capability(actor, 'workspace_manage', w) and self.active(target) and bool(self.level(target))
                and self.in_branch(actor, target) and self.governor(target) == w['governing_manager_id'])

    def membership_request(self, d, actor):
        w = self.ws(d.get('workspace_id'))
        target = self.require_active(d.get('beneficiary_id') or actor)
        role = d.get('member_role') or 'MEMBER'
        if role not in ('MEMBER', 'VIEWER'):
            fail('Choose Member or Viewer.', 422)
        if w['kind'] == 'LEGACY':
            fail('Classify this legacy workspace before using governed membership approval.', 409)
        if w['status'] != 'ACTIVE':
            fail('Restore the workspace first.', 409)
        if w['kind'] == 'PERSONAL':
            if w['owner_id'] != actor:
                visible = self.can_view_workspace(actor, w)
                fail('Only the personal workspace owner can share it.' if visible else 'Workspace not found.', 403 if visible else 404)
            existed = self.member(w['id'], target)
            reason = None if existed else self.require_reason(d)
            self.activate_member(w['id'], target, actor, role, None)
            if not existed:
                self.audit(actor, 'personal.shared', employee=target, workspace=w['id'], after={'member_role': role}, reason=reason)
                self.bump()
            return {'id': w['id'], 'type': 'tm_workspace', 'message': 'This person already has membership.' if existed else
                    'Member added. The workspace is now Public and visible to the owner’s reporting managers.'}
        direct = self.can_view_workspace(actor, w) and (
            self.governs(actor, w) or self.global_workspaces(actor)
            or (self.is_level1(actor) and w['owner_id'] in self.descendants(actor)) or self.owner_can_add(actor, w, target))
        if not direct:
            if target == actor:
                if not w['joinable'] and not self.can_view_workspace(actor, w):
                    fail('Workspace not found.', 404)
            elif (not self.level(target) or not self.has_capability(actor, 'membership_request', w)
                  or not self.in_branch(actor, target) or self.governor(target) != w['governing_manager_id']):
                fail('You can nominate only employees in your approved branch. Ask the governing manager for a cross-branch exception.', 403)
        if self.member(w['id'], target):
            return {'id': w['id'], 'type': 'tm_workspace', 'message': 'This person already has active membership.', 'unchanged': True}
        return self.make_request('MEMBERSHIP', {'workspace_id': w['id'], 'beneficiary_id': target, 'member_role': role,
                                                'reason': self.require_reason(d), **self.request_key(d)},
                                 actor, approve=direct)

    def delegation_payload(self, d, actor):
        target = self.require_active(d.get('beneficiary_id'))
        g = self.governor(target)
        template = row(OrgTemplate.objects.filter(id=d.get('template_id') or 'OWNER', active=True).first())
        if not template or (self.level(target) or 0) < 3 or not g:
            fail('Delegation needs a configured Level 3+ employee and a valid Level 2 manager.', 422)
        allowed = parse(template['capabilities_json'], [])
        caps = self.capabilities(d['capabilities'] if d.get('capabilities') else allowed)
        if not caps or not all(k in allowed for k in caps):
            fail('Choose capabilities from the approved template.', 422)
        w = self.ws(d['workspace_id']) if d.get('workspace_id') else None
        if w and (w['kind'] != 'ORGANIZATIONAL' or w['governing_manager_id'] != g):
            fail('The delegation workspace must have the same responsible Level 2 manager.', 422)
        parent = None
        if not self.is_level1(actor) and actor != g:
            if target == actor or not self.in_branch(actor, target):
                fail('Delegation is only available for employees below you.', 403)
            parent = self.grant_row(d.get('parent_grant_id') or '')
            if (not self.valid_grant(parent) or parent['beneficiary_id'] != actor
                    or 'delegate_request' not in parse(parent['capabilities_json'], [])
                    or not all(k in parse(parent['capabilities_json'], []) for k in caps)
                    or parent['governing_manager_id'] != g or (parent['workspace_id'] and parent['workspace_id'] != (w or {}).get('id'))):
                fail('The requested authority exceeds your active scoped delegation.', 403)
        return {'beneficiary_id': target, 'template_id': template['id'], 'title': template['name'], 'capabilities': caps,
                'branch_root_id': target, 'workspace_id': w['id'] if w else None, 'governing_manager_id': g,
                'parent_grant_id': parent['id'] if parent else None, 'reason': self.require_reason(d), **self.request_key(d)}

    def decision_authority(self, actor, q):
        current = self.approver_for(q['kind'], parse(q['payload_json']), q['requester_id'])
        if not current:
            fail('A valid responsible manager must be configured before approving.', 409)
        if (current != actor and not self.global_workspaces(actor)
                and not (self.is_level1(actor) and q['beneficiary_id'] and q['beneficiary_id'] in self.descendants(actor))):
            fail('You are not the current responsible approver.', 403)

    def decide(self, d, actor, administrative=False):
        q = row(OrgRequest.objects.filter(id=text(d.get('id'), 'Request', 60, True)).first())
        if not q or not self.request_visible(actor, q):
            fail('Request not found.', 404)
        decision = d.get('decision')
        if decision not in ('APPROVE', 'REJECT'):
            fail('Choose Approve or Reject.', 422)
        owner_approval = (administrative and q['kind'] == 'MEMBERSHIP' and q['requester_id'] == actor
                          and self.owner_can_add(actor, self.ws(q['workspace_id']), q['beneficiary_id']))
        if not owner_approval:
            self.decision_authority(actor, q)
        if not administrative and q['requester_id'] == actor:
            fail('You cannot approve your own request.', 403)
        if q['status'] not in ('PENDING', 'REVIEW'):
            if q['status'] == ('APPROVED' if decision == 'APPROVE' else 'REJECTED'):
                return {'id': q['id'], 'type': 'org_request', 'status': q['status'], 'message': 'This decision is already recorded.', 'unchanged': True}
            fail('This request has already been decided.', 409)
        if d.get('expected_version') is not None and d['expected_version'] != q['version']:
            fail('This record changed. Refresh it before saving again.', 409)
        p = parse(q['payload_json'])
        note = text(d.get('note'), 'Decision note', 2000, decision == 'REJECT')
        if decision == 'APPROVE':
            if q['kind'] == 'MEMBERSHIP':
                w = self.ws(q['workspace_id'])
                if w['kind'] != 'ORGANIZATIONAL' or w['status'] != 'ACTIVE':
                    fail('The workspace is no longer eligible.', 409)
                self.require_active(q['beneficiary_id'])
                if p.get('member_role') not in ('MEMBER', 'VIEWER'):
                    fail('Invalid membership role.', 422)
                r = q['requester_id']
                if (r != q['beneficiary_id'] and not self.is_level1(r) and not self.governs(r, w)
                        and (not self.active(r) or not self.has_capability(r, 'membership_request', w)
                             or not self.in_branch(r, q['beneficiary_id']) or self.governor(q['beneficiary_id']) != w['governing_manager_id'])):
                    fail('The inviter’s authority changed. Submit a new membership request.', 409)
                self.activate_member(w['id'], q['beneficiary_id'], actor, p['member_role'], q['id'])
                self.audit(actor, 'membership.approved', employee=q['beneficiary_id'], workspace=w['id'],
                           after={'member_role': p['member_role']}, reason=note or q['reason'], approval=q['id'])
            elif q['kind'] == 'DELEGATION':
                checked = self.delegation_payload({**p, 'reason': q['reason']}, q['requester_id'])
                if checked['governing_manager_id'] != p.get('governing_manager_id'):
                    fail('The branch changed. Submit a new delegation request.', 409)
                moment = now()
                at = iso(moment)
                grant = {'id': next_id('org-grant', 'GRANT'), 'beneficiary_id': p['beneficiary_id'], 'template_id': p.get('template_id'),
                         'title': p['title'], 'capabilities_json': jtext(checked['capabilities']), 'branch_root_id': p['beneficiary_id'],
                         'workspace_id': p.get('workspace_id') or None, 'governing_manager_id': checked['governing_manager_id'],
                         'parent_grant_id': checked['parent_grant_id'], 'request_id': q['id'], 'status': 'ACTIVE', 'granted_by': actor,
                         'created_at': at, 'updated_at': at}
                OrgGrant.objects.create(**{**{('granted_by_id' if k == 'granted_by' else k): v for k, v in grant.items()},
                                           'created_at': moment, 'updated_at': moment})
                self.invalidate()
                self.audit(actor, 'delegation.approved', employee=p['beneficiary_id'], workspace=p.get('workspace_id'),
                           after=grant, reason=note or q['reason'], approval=q['id'])
            else:
                self.expected(d)
                if d.get('acknowledged') is not True:
                    fail('Review and acknowledge the affected structure before approving.', 422)
                r = q['requester_id']
                changes = self.structure_changes(p)
                if (not self.is_level1(r) and self.governor(r) != r and any(x['staff_id'] != r for x in changes)
                        and not self.has_capability(r, 'structure_request')):
                    fail('The requester’s structural authority was revoked. Submit a new request.', 409)
                if (not self.active(r) or not all(x['staff_id'] == r or self.in_branch(r, x['staff_id']) for x in changes)
                        and not self.is_level1(r) and self.governor(r) != r):
                    fail('The requester no longer has authority over the requested branch.', 409)
                self.save_structure({**p, 'expected_revision': d.get('expected_revision'), 'acknowledged': True, 'reason': q['reason']}, actor, q['id'])
        status = 'APPROVED' if decision == 'APPROVE' else 'REJECTED'
        OrgRequest.objects.filter(id=q['id']).update(status=status, approver_id=actor if owner_approval else q['approver_id'],
                                                     decision_by_id=actor, decision_note=note, decided_at=now(), updated_at=now(),
                                                     version=q['version'] + 1)
        self.audit(actor, f'request.{decision.lower()}', employee=q['beneficiary_id'], workspace=q['workspace_id'],
                   before={'status': q['status']}, after={'status': decision}, reason=note, approval=q['id'])
        done = row(OrgRequest.objects.get(id=q['id']))
        for staff in uniq([q['requester_id'], q['beneficiary_id']]):
            if staff != actor:
                word = 'approved' if decision == 'APPROVE' else 'rejected'
                self.notify(staff, done, word, f"{q['kind'].lower()} request {word}.{' ' + note if note else ''}")
        self.bump()
        return {'id': q['id'], 'type': 'org_request', 'status': done['status'], 'message': f"Request {done['status'].lower()}."}

    # ------------------------------------------------------------ workspaces
    def save_workspace(self, d, actor):
        old = self.ws(d['id']) if d.get('id') else None
        kind = old['kind'] if old else ('PERSONAL' if d.get('kind') == 'PUBLIC' else d.get('kind')) or 'PERSONAL'
        visibility = old['visibility'] if old else ('PUBLIC' if d.get('kind') == 'PUBLIC' or kind == 'ORGANIZATIONAL' else 'PERSONAL')
        if kind not in ('PERSONAL', 'ORGANIZATIONAL'):
            fail('Choose Personal or Organizational. Legacy workspaces use migration review.', 422)
        if old:
            if not self.can_view_workspace(actor, old):
                fail('Workspace not found.', 404)
            if d.get('expected_version') != old['version']:
                fail('This record changed. Refresh it before saving again.', 409)
            if not self.can_manage_workspace(actor, old):
                fail('You cannot manage this workspace.', 403)
            if d.get('kind') and d['kind'] != old['kind'] and not (d['kind'] == 'PUBLIC' and old['kind'] == 'PERSONAL' and old['visibility'] == 'PUBLIC'):
                fail('Workspace privacy classification cannot be changed through an ordinary edit.', 403)
        owner = (d.get('owner_id') or old['owner_id']) if old else (actor if kind == 'PERSONAL' else d.get('owner_id') or actor)
        if kind == 'PERSONAL' and owner != actor:
            fail('Only the owner can manage a personal workspace.', 403)
        governing = (d.get('governing_manager_id') or (old or {}).get('governing_manager_id') or self.governor(owner)) if kind == 'ORGANIZATIONAL' else None
        grant_id = None
        if kind == 'ORGANIZATIONAL' and owner != governing:
            grant_id = d.get('owner_grant_id') or (old or {}).get('owner_grant_id')
            if not grant_id:
                grant_id = next((g['id'] for g in self.grants(owner) if 'workspace_create' in parse(g['capabilities_json'], [])
                                 and (not g['workspace_id'] or g['workspace_id'] == d.get('origin_workspace_id'))), None)
        if kind == 'ORGANIZATIONAL':
            if not self.settings()['enabled']:
                fail('Initialize Organizational Structure and assign a Level 2 manager first.', 409)
            if (not old and not self.is_level1(actor) and actor != governing and
                    (not self.has_capability(actor, 'workspace_create') or owner != actor or self.governor(actor) != governing)):
                fail('An approved Owner capability is required to create a delegated organizational workspace.', 403)
            if (old and not self.is_level1(actor) and not self.governs(actor, old)
                    and (owner != old['owner_id'] or governing != old['governing_manager_id'] or grant_id != old['owner_grant_id'])):
                fail('Only the governing manager or a Level 1 administrator can change this workspace’s owner or governing manager.', 403)
        if old and kind == 'ORGANIZATIONAL' and (owner != old['owner_id'] or governing != old['governing_manager_id'] or grant_id != old['owner_grant_id']):
            self.expected(d)
            if d.get('acknowledged') is not True:
                fail('Preview and acknowledge the affected workspace governance before changing its owner or manager.', 422)
        if 'origin_workspace_id' not in d:
            origin = (old or {}).get('origin_workspace_id')
        else:
            origin = d.get('origin_workspace_id') or None
        origin_changed = not old or origin != old['origin_workspace_id']
        if old and origin_changed and not self.is_level1(actor) and not self.governs(actor, old):
            fail('A governing manager must approve changes to workspace governance links.', 403)
        if origin and origin_changed:
            related = self.ws(origin)
            if (origin == (old or {}).get('id') or related['kind'] != 'ORGANIZATIONAL' or related['governing_manager_id'] != governing
                    or not self.can_view_workspace(actor, related)):
                fail('Choose an authorized organizational workspace under the same governing manager.', 422)
        if grant_id:
            g = self.grant_row(grant_id)
            if g and g['workspace_id'] and g['workspace_id'] != origin and (old or {}).get('owner_grant_id') != grant_id:
                fail('This Owner grant is restricted to its approved originating workspace.', 403)
        joinable = (d['joinable'] if d.get('joinable') is not None else (old or {}).get('joinable'))
        values = {
            'name': text(d.get('name', (old or {}).get('name')), 'Workspace name', 200, True),
            'description': text(d.get('description', (old or {}).get('description')), 'Description', 5000),
            'department': text(d.get('department', (old or {}).get('department')), 'Department', 150),
            'owner_id': self.require_active(owner), 'kind': kind, 'visibility': visibility,
            'governing_manager_id': governing, 'owner_grant_id': grant_id, 'origin_workspace_id': origin,
            'joinable': 1 if kind == 'ORGANIZATIONAL' and joinable else 0,
            'color': d.get('color') or (old or {}).get('color') or 'BLUE',
            'status': (old or {}).get('status') or 'ACTIVE', 'version': old['version'] + 1 if old else 0, 'updated_at': iso(now()),
        }
        if values['color'] not in COLORS:
            fail('Choose a valid workspace color.', 422)
        self.ensure_workspace_authority({**(old or {}), **values})
        if old and isinstance(d.get('member_ids'), list):
            before = sorted(WorkspaceMember.objects.filter(workspace_id=old['id']).values_list('staff_id', flat=True))
            after = sorted(uniq([*d['member_ids'], owner]))
            if before != after:
                fail('Use membership requests or the explicit member-removal action; a workspace edit cannot bypass approval.', 403)
        elif not old and any(x != owner for x in (d.get('member_ids') or [])):
            fail('Create the workspace first, then add or request members through approval.', 403)
        if any(n.lower() == values['name'].lower() for n in Workspace.objects.exclude(id=(old or {}).get('id', '')).values_list('name', flat=True)):
            fail('A workspace with this name already exists.', 409)
        key = old['id'] if old else next_id('tm-workspace', 'WS')
        fields = {'name': values['name'], 'description': values['description'], 'department': values['department'],
                  'owner_id': values['owner_id'], 'kind': kind, 'visibility': visibility, 'governing_manager_id': governing,
                  'owner_grant_id': grant_id, 'origin_workspace_id': origin, 'joinable': bool(values['joinable']),
                  'color': values['color'], 'status': values['status'], 'version': values['version'], 'updated_at': now()}
        if old:
            Workspace.objects.filter(id=key).update(**fields)
        else:
            Workspace.objects.create(id=key, created_by_id=actor, created_at=now(), **fields)
        self.invalidate()
        self.activate_member(key, owner, actor, 'MEMBER', None)
        self.audit(actor, 'workspace.updated' if old else 'workspace.created', workspace=key, before=old, after=values,
                   reason=d.get('reason') or 'Explicit workspace setup')
        self.reconcile(actor, 'Workspace governance changed')
        self.bump()
        return {'id': key, 'type': 'tm_workspace',
                'message': f"{'Personal' if visibility == 'PERSONAL' else 'Public'} workspace saved. Membership and contents remain separate."}

    def remove_workspace(self, d, actor, restore=False):
        w = self.ws(d.get('id'))
        if not self.can_view_workspace(actor, w) and not self.creator(actor, w):
            fail('Workspace not found.', 404)
        if not self.creator(actor, w):
            fail('Only the user who created this workspace can delete or restore it.', 403)
        if d.get('expected_version') != w['version']:
            fail('This record changed. Refresh it before saving again.', 409)
        if (not w['deleted_at']) if restore else bool(w['deleted_at']):
            return {'id': w['id'], 'type': 'tm_workspace', 'unchanged': True,
                    'message': 'Workspace already restored.' if restore else 'Workspace already deleted.'}
        if d.get('acknowledged') is not True:
            fail('Confirm workspace deletion or restoration first.', 422)
        if restore and w['kind'] == 'ORGANIZATIONAL':
            try:
                self.ensure_workspace_authority(w)
            except Exception:  # noqa: BLE001 — repair below, exactly as V5.6.8
                g = w['governing_manager_id']
                if not g or self.governor(g) != g:
                    fail('This workspace’s governing manager is no longer a valid Level 2 manager. Correct the reporting structure first, then restore it.', 409)
                Workspace.objects.filter(id=w['id']).update(owner_id=g, owner_grant_id=None)
                self.invalidate()
                self.activate_member(w['id'], g, actor, 'MEMBER', None)
                self.audit(actor, 'workspace.governance', workspace=w['id'], before={'owner_id': w['owner_id'], 'owner_grant_id': w['owner_grant_id']},
                           after={'owner_id': g, 'owner_grant_id': None}, reason='Restored: the previous owner no longer had valid authority')
        at = now()
        if restore:
            change = {'status': w['deleted_from_status'] or 'ACTIVE', 'deleted_at': None, 'deleted_by_id': None, 'deleted_from_status': None}
            change_row = {'status': change['status'], 'deleted_at': None, 'deleted_by': None, 'deleted_from_status': None}
        else:
            change = {'status': 'ARCHIVED', 'deleted_at': at, 'deleted_by_id': actor, 'deleted_from_status': w['status']}
            change_row = {'status': 'ARCHIVED', 'deleted_at': iso(at), 'deleted_by': actor, 'deleted_from_status': w['status']}
        Workspace.objects.filter(id=w['id']).update(**change, version=w['version'] + 1, updated_at=at)
        self.invalidate()
        if not restore:
            for q in rows(OrgRequest.objects.filter(workspace_id=w['id'], status__in=['PENDING', 'REVIEW'])):
                OrgRequest.objects.filter(id=q['id']).update(status='CANCELLED', decision_note='Workspace deleted by its creator.',
                                                             version=q['version'] + 1, updated_at=at)
                self.audit(actor, 'request.cancelled', workspace=w['id'], approval=q['id'], before={'status': q['status']},
                           after={'status': 'CANCELLED'}, reason='Workspace deleted by its creator.')
        # The people whose open work, requests or meetings are in the workspace, and its members, are told (V5.6.8).
        involved = []
        for collect in hooks.WORKSPACE_PEOPLE:
            involved.extend(collect(w['id']))
        involved.extend(WorkspaceMember.objects.filter(workspace_id=w['id']).values_list('staff_id', flat=True))
        who = (self.person(actor) or {}).get('name') or actor
        for staff in uniq(involved):
            if staff == actor or not self.active(staff):
                continue
            Notification.objects.create(
                staff_id=staff, kind='workspace_restored' if restore else 'workspace_deleted', actor_id=actor, created_at=at,
                title=f"Workspace {'restored' if restore else 'deleted'}: {w['name']}",
                body=(f'{who} restored it. Its tasks, requests and meetings are available again.' if restore else
                      f'{who} deleted it. Its tasks, requests and meetings are hidden until it is restored.'))
        self.audit(actor, 'workspace.restored' if restore else 'workspace.deleted', workspace=w['id'],
                   before={'status': w['status'], 'deleted_at': w['deleted_at']}, after=change_row,
                   reason=d.get('reason') or 'Confirmed by workspace creator')
        self.bump()
        return {'id': w['id'], 'type': 'tm_workspace', 'message': 'Workspace restored. Previous memberships and work are retained.' if restore
                else 'Workspace deleted. Its creator can restore it from My Workspaces.'}

    def migration_preview(self, actor):
        if not self.is_level1(actor) and not (self.legacy_admin(actor) and not self.settings()['enabled']):
            fail('Only an organization administrator can review migration.', 403)
        employees = []
        for u in User.objects.filter(active=True).select_related('staff').order_by('staff__name'):
            p = Profile.objects.filter(staff_id=u.staff_id).first()
            if p and p.org_level_id is not None:
                continue
            nickname = p.nickname if p else ''
            employees.append({'staff_id': u.staff_id, 'username': u.staff.name, 'name': display_name(u.staff.name, nickname),
                              'nickname': nickname, 'manager_id': p.manager_id if p else None, 'org_level': None,
                              'role_id': u.role_id, 'active': 1})
        workspaces = []
        for w in rows(Workspace.objects.filter(kind='LEGACY').order_by('name')):
            if self.can_view_workspace(actor, w):
                w['member_count'] = WorkspaceMember.objects.filter(workspace_id=w['id']).count()
                w['task_count'] = sum(count(w['id']) for count in hooks.WORKSPACE_TASK_COUNT)
                workspaces.append(w)
        s = self.settings()
        return {'revision': s['revision'], 'initialized': bool(s['enabled']), 'employees': employees, 'workspaces': workspaces,
                'policy': 'No automatic level or privacy classification. Legacy memberships and direct task/meeting participation stay intact until an explicit, audited workspace cutover.'}

    def classify_workspace(self, d, actor):
        old = self.ws(d.get('id'))
        if not self.can_view_workspace(actor, old):
            fail('Workspace not found.', 404)
        if d.get('expected_version') != old['version']:
            fail('This record changed. Refresh it before saving again.', 409)
        self.expected(d)
        if old['kind'] != 'LEGACY':
            fail('This workspace is already classified. Automatic personal/organizational conversion is not supported.', 409)
        if d.get('acknowledged') is not True:
            fail('Review and acknowledge the migration impact first.', 422)
        reason = self.require_reason(d)
        at = now()
        if d.get('kind') in ('PERSONAL', 'PUBLIC'):
            if actor != old['owner_id']:
                fail('Only the existing owner can classify and explicitly share a personal workspace.', 403)
            shared = d.get('shared_member_ids')
            if not isinstance(shared, list):
                fail('Explicitly select retained sharing when classifying a personal workspace.', 422)
            previous = list(WorkspaceMember.objects.filter(workspace_id=old['id']).values_list('staff_id', flat=True))
            if any(k != actor and k not in shared for k in previous):
                fail('Preserve existing memberships during migration. Review and revoke specific sharing separately afterwards.', 409)
            for k in shared:
                if k not in previous:
                    self.require_active(k)
            public = d['kind'] == 'PUBLIC' or any(k != actor for k in previous) or any(k != actor for k in shared)
            Workspace.objects.filter(id=old['id']).update(kind='PERSONAL', visibility='PUBLIC' if public else 'PERSONAL',
                                                          governing_manager_id=None, version=old['version'] + 1, updated_at=at)
            self.invalidate()
            for k in uniq([actor, *shared]):
                if k not in previous:
                    self.activate_member(old['id'], k, actor, 'MEMBER', None)
        elif d.get('kind') == 'ORGANIZATIONAL':
            self.require_admin(actor)
            owner = self.require_active(d.get('owner_id'))
            manager = self.require_active(d.get('governing_manager_id') or self.governor(owner))
            grant_id = None if owner == manager else (d.get('owner_grant_id') or next(
                (g['id'] for g in self.grants(owner) if not g['workspace_id'] and 'workspace_create' in parse(g['capabilities_json'], [])), None))
            following = {**old, 'kind': 'ORGANIZATIONAL', 'owner_id': owner, 'governing_manager_id': manager, 'owner_grant_id': grant_id}
            self.ensure_workspace_authority(following)
            Workspace.objects.filter(id=old['id']).update(kind='ORGANIZATIONAL', visibility='PUBLIC', owner_id=owner, governing_manager_id=manager,
                                                          owner_grant_id=grant_id, joinable=bool(d.get('joinable')),
                                                          version=old['version'] + 1, updated_at=at)
            self.invalidate()
            self.activate_member(old['id'], owner, actor, 'MEMBER', None)
        else:
            fail('Explicitly classify this workspace as Personal or Organizational.', 422)
        WorkspaceMember.objects.filter(workspace_id=old['id'], approved_by__isnull=True).update(approved_by_id=actor)
        WorkspaceMember.objects.filter(workspace_id=old['id'], joined_at__isnull=True).update(joined_at=at)
        self.invalidate()
        self.audit(actor, 'migration.workspace', workspace=old['id'], before=old, after=self.ws(old['id']), reason=reason)
        self.bump()
        return {'id': old['id'], 'type': 'tm_workspace', 'message': 'Workspace classified. Existing records, participants and memberships were preserved.'}

    # ------------------------------------------------------------ command guard (runs before every command)
    def guard(self, action, d, actor):
        if action not in ('tm.workspace.delete', 'tm.workspace.restore', 'org.workspace.delete', 'org.workspace.restore'):
            wid = d.get('workspace_id') or (d.get('id') if action.startswith(('tm.workspace.', 'org.workspace.')) else None)
            if isinstance(wid, str) and wid and self.workspace_removed(wid):
                fail('This workspace was deleted. Its creator must restore it first.', 409)
        if action.startswith('org.') and not self.can_manage_structure(actor):
            fail('Organizational Structure Create permission is required for management actions.', 403)
        if not self.settings()['enabled']:
            return
        if action == 'tm.profile.manager' or (action == 'tm.profile.save' and 'manager_id' in d):
            old = self.person(d.get('staff_id'))
            if ((old and old['org_level']) or self.level(d.get('manager_id')) or self.level((old or {}).get('manager_id'))) and \
                    str(d.get('manager_id') or '') != str((old or {}).get('manager_id') or ''):
                fail('Use Organizational Structure with an impact preview to change governed reporting relationships.', 403)
        target = None
        deactivating = d.get('active') is False or d.get('active') == 0
        if action == 'admin.user.disable' or (action == 'admin.user.save' and deactivating):
            target = User.objects.filter(id=d.get('id')).values_list('staff_id', flat=True).first()
        elif action == 'tm.profile.save' and deactivating:
            target = d.get('staff_id')
        if target:
            if Profile.objects.filter(manager_id=target, org_level__isnull=False, active=True).exists():
                fail('Reassign active reporting employees before deactivating their manager.', 409)
            level1 = [s for s in Profile.objects.filter(org_level_id=1).values_list('staff_id', flat=True) if self.active(s)]
            if self.is_level1(target) and len(level1) == 1:
                fail('Keep at least one active Level 1 organization administrator.', 409)
            if self.affected([target])['workspaces']:
                fail('Review this employee’s dependent organizational workspaces and assign valid replacements before deactivation.', 409)

    def after_command(self, action, d, actor):
        if self.settings()['enabled'] and action in ('admin.user.disable', 'admin.user.save', 'tm.profile.save'):
            self.invalidate()
            self.reconcile(actor, 'Employee account/profile changed')
            self.bump()

    # ------------------------------------------------------------ member removal
    def can_remove_members(self, actor, w):
        return (bool(w) and not w['deleted_at'] and self.active(actor) and self.can_view_workspace(actor, w) and
                (w['owner_id'] == actor or (self.creator(actor, w) and self.can_manage_workspace(actor, w))
                 or self.governs(actor, w) or self.workspace_override(actor, w)))

    def remove_member(self, d, actor):
        w = self.ws(d.get('workspace_id'))
        target = text(d.get('beneficiary_id'), 'Employee', 60, True)
        self.expected(d)
        if not self.can_view_workspace(actor, w):
            fail('Workspace not found.', 404)
        if not self.can_remove_members(actor, w):
            fail('Only an authorized workspace owner or governing manager can remove members.', 403)
        if target == w['owner_id']:
            fail('Assign a valid replacement owner before removing the owner’s membership.', 409)
        old = row(WorkspaceMember.objects.filter(workspace_id=w['id'], staff_id=target).first())
        if not old:
            return {'id': w['id'], 'type': 'tm_workspace', 'unchanged': True, 'message': 'Membership already removed.'}
        reason = self.require_reason(d)
        WorkspaceMember.objects.filter(workspace_id=w['id'], staff_id=target).delete()
        self.invalidate()
        old.pop('id', None)
        self.audit(actor, 'membership.revoked', employee=target, workspace=w['id'], before=old, reason=reason)
        self.bump()
        return {'id': w['id'], 'type': 'tm_workspace', 'message': 'Member removed. Tasks, history and independently authorized participation are retained.'}

    # ------------------------------------------------------------ what the frontend receives
    def workspace_access(self, staff, w):
        approve = (not w['deleted_at'] and self.can_view_workspace(staff, w) and (
            self.governs(staff, w) or (w['kind'] == 'ORGANIZATIONAL' and (
                self.global_workspaces(staff) or (self.is_level1(staff) and w['owner_id'] in self.descendants(staff))))))
        own_add = self.owner_can_add(staff, w, staff)
        personal = w['kind'] == 'PERSONAL' and w['owner_id'] == staff and not w['deleted_at']
        candidates = []
        if w['status'] == 'ACTIVE' and not w['deleted_at'] and (approve or own_add or personal):
            logins = self._cached('logins', '', lambda: list(User.objects.filter(active=True).values_list('staff_id', flat=True)))
            for s in logins:
                if self.active(s) and (approve or personal or self.owner_can_add(staff, w, s)) and not self.member(w['id'], s):
                    candidates.append({'id': s, 'name': self.person(s)['name']})
        return {'membership_revision': self.settings()['revision'], 'reason': self.workspace_reason(staff, w),
                'can_manage': self.can_manage_workspace(staff, w), 'can_create': self.can_create_resource(staff, w),
                'can_collaborate_outside': self.can_collaborate_outside(staff, w), 'can_approve_membership': approve,
                'can_remove_members': self.can_remove_members(staff, w), 'can_add_members': approve or own_add or personal,
                'member_candidates': candidates, 'can_archive': self.can_archive_workspace(staff, w),
                'can_delete': self.can_delete_workspace(staff, w), 'can_restore': self.can_restore_workspace(staff, w),
                'can_request_membership': not w['deleted_at'] and w['kind'] == 'ORGANIZATIONAL' and self.has_capability(staff, 'membership_request', w),
                'personal': is_personal_workspace(w)}

    def workspace_dashboard(self, actor, state):
        if not self.active(actor):
            return {'has_management': False, 'people': [], 'my': [], 'managed': [], 'shared': []}
        managed_people = [p for p in self.tree()['rows'] if p['staff_id'] != actor and p['org_level'] and self.active(p['staff_id'])
                          and (self.global_workspaces(actor) or p['staff_id'] in self.descendants(actor))]
        scope = {actor, *(p['staff_id'] for p in managed_people)}
        full = {w['id'] for w in state.get('tm_workspaces', [])}
        people = []
        for p in [self.person(actor), *(self.person(m['staff_id']) for m in managed_people)]:
            people.append({'staff_id': p['staff_id'], 'name': p['name'], 'org_level': p['org_level'],
                           'manager_id': p['manager_id'] if p['manager_id'] in scope else None})
        my, managed, shared = [], [], []
        tasks = state.get('tm_tasks', [])
        members = list(WorkspaceMember.objects.values_list('workspace_id', 'staff_id'))
        for w in sorted(rows(Workspace.objects.all()), key=lambda x: x['name'].lower()):
            mine = w['created_by'] == actor or w['owner_id'] == actor
            management = not w['deleted_at'] and not is_personal_workspace(w) and w['owner_id'] in scope and w['owner_id'] != actor
            if (not self.can_restore_workspace(actor, w)) if w['deleted_at'] else (w['id'] not in full):
                continue
            authorized = w['id'] in full
            visible_members = [s for wid, s in members if wid == w['id'] and (authorized or s in scope)]
            entry = {'id': w['id'], 'name': w['name'], 'kind': w['kind'], 'visibility': w['visibility'], 'status': w['status'],
                     'color': w['color'], 'version': w['version'], 'owner_id': w['owner_id'], 'created_by': w['created_by'],
                     'deleted_at': w['deleted_at'], 'reference_only': not authorized,
                     'description': w['description'] if authorized else '', 'department': w['department'] if authorized else '',
                     'org_access': self.workspace_access(actor, w) if authorized else {
                         'can_archive': False, 'can_delete': self.can_delete_workspace(actor, w), 'can_restore': self.can_restore_workspace(actor, w)},
                     'member_ids': [] if w['deleted_at'] else visible_members,
                     'task_ids': [t['id'] for t in tasks if t['workspace_id'] == w['id']]}
            (my if mine else managed if management else shared).append(entry)
        return {'has_management': bool(managed_people), 'people': people, 'my': my, 'managed': managed, 'shared': shared}

    def visible_employee(self, actor, target):
        return self.global_workspaces(actor) or actor == target or self.in_branch(actor, target) or self.in_branch(target, actor)

    def _direct_reports(self, actor, target):
        return [self.person(s) for s in Profile.objects.filter(manager_id=target).values_list('staff_id', flat=True)
                if self.visible_employee(actor, s)]

    def employee(self, actor, target):
        if not self.visible_employee(actor, target):
            fail('Employee not found.', 404)
        p = self.person(target)
        if not p:
            fail('Employee not found.', 404)
        if not self.can_manage_structure(actor):
            return {**p, 'active': 1 if self.active(target) else 0, 'actions': {}, 'direct_reports': self._direct_reports(actor, target),
                    'memberships': [], 'owned': [], 'grants': []}
        memberships = []
        for m in WorkspaceMember.objects.filter(staff_id=target).select_related('workspace'):
            w = row(m.workspace)
            if self.can_view_workspace(actor, w):
                memberships.append({'id': w['id'], 'name': w['name'], 'kind': w['kind'], 'visibility': w['visibility'],
                                    'owner_id': w['owner_id'], 'governing_manager_id': w['governing_manager_id'], 'member_role': m.member_role})
        owned = [{'id': w['id'], 'name': w['name'], 'kind': w['kind'], 'visibility': w['visibility'], 'governing_manager_id': w['governing_manager_id']}
                 for w in rows(Workspace.objects.filter(owner_id=target)) if self.can_view_workspace(actor, w)]
        level = self.level(target) or 0
        actions = {
            'change_structure': self.is_level1(actor) or (self.governor(actor) == actor and level >= 3 and self.governor(target) == actor),
            'request_structure': actor == target or (self.in_branch(actor, target) and self.has_capability(actor, 'structure_request')),
            'delegate': level >= 3 and bool(self.governor(target)) and (
                self.is_level1(actor) or actor == self.governor(target)
                or (target != actor and self.in_branch(actor, target) and self.has_capability(actor, 'delegate_request'))),
        }
        grants = [{**g, 'capabilities': parse(g['capabilities_json'], []), 'effective': self.valid_grant(g)}
                  for g in rows(OrgGrant.objects.filter(beneficiary_id=target).order_by('-created_at'))
                  if not g['workspace_id'] or self.can_view_workspace(actor, self.ws(g['workspace_id']))]
        return {**p, 'active': 1 if self.active(target) else 0, 'actions': actions, 'governing_manager_id': self.governor(target),
                'direct_reports': self._direct_reports(actor, target), 'memberships': memberships, 'owned': owned, 'grants': grants}

    def directory(self, actor, manage):
        out = []
        for u in User.objects.filter(active=True, staff__active=True).select_related('staff').order_by('staff__name'):
            p = Profile.objects.filter(staff_id=u.staff_id).first()
            if p and not p.active:
                continue
            if manage or self.visible_employee(actor, u.staff_id):
                nickname = p.nickname if p else ''
                out.append({'staff_id': u.staff_id, 'username': u.staff.name, 'name': display_name(u.staff.name, nickname), 'nickname': nickname})
        return sorted(out, key=lambda x: x['username'].lower())

    def snapshot(self, actor):
        p, s, manage = self.person(actor), self.settings(), self.can_manage_structure(actor)
        return {
            'enabled': bool(s['enabled']), 'revision': s['revision'],
            'me': {**p, 'can_manage_structure': manage, 'is_admin': self.is_level1(actor), 'is_governor': self.governor(actor) == actor,
                   'governing_manager_id': self.governor(actor), 'can_initialize': not s['enabled'] and self.legacy_admin(actor) and manage},
            'levels': rows(OrgLevel.objects.order_by('id')),
            'templates': [{**t, 'capabilities': parse(t['capabilities_json'], [])} for t in rows(OrgTemplate.objects.order_by('name'))] if manage else [],
            'capabilities': CAPABILITIES if manage else {},
            'directory': self.directory(actor, manage),
            'grants': [{**g, 'capabilities': parse(g['capabilities_json'], [])} for g in self.grants(actor)] if manage else [],
            'pending': sum(1 for q in rows(OrgRequest.objects.filter(status='PENDING', approver_id=actor)) if self.notification_visible(actor, q)) if manage else 0,
        }

    def query(self, actor, p):
        self.require_active(actor)
        if not self.can_staff(actor, 'tasks.organization', 'view'):
            fail('Organizational Structure View permission is required.', 403)
        view = p.get('view')
        if not self.can_manage_structure(actor) and view and view not in ('people', 'employee'):
            fail('Organizational Structure View is read-only. Create permission is required for management views.', 403)
        page = integer(p.get('page') or 1, 1, 100000, 'page')
        limit = integer(p.get('limit') or 50, 1, 200, 'page size')
        q = str(p.get('q') or '').strip().lower()

        def paginate(items):
            return {'rows': items[(page - 1) * limit: page * limit], 'total': len(items), 'page': page, 'limit': limit,
                    'revision': self.settings()['revision']}
        if view == 'migration':
            return self.migration_preview(actor)
        if view == 'employee':
            return self.employee(actor, p.get('staff_id'))
        if view == 'requests':
            out = []
            for r in rows(OrgRequest.objects.order_by('-created_at', '-id')):
                if (self.request_visible(actor, r) and (not p.get('status') or r['status'] == p['status'])
                        and (not p.get('mine') or r['approver_id'] == actor)
                        and (not q or q in f"{r['id']} {r['kind']} {r['reason']}".lower())):
                    out.append({**r, 'payload': parse(r['payload_json']), 'can_decide': self.can_decide(actor, r),
                                'can_cancel': r['requester_id'] == actor and r['status'] in ('PENDING', 'REVIEW')})
            return paginate(out)
        if view == 'audit':
            def audit_workspace(w):
                return bool(w) and (self.can_view_workspace(actor, w) or (bool(w['deleted_at']) and (self.creator(actor, w) or self.global_workspaces(actor))))

            def governs_row(w):
                return bool(w) and w['kind'] == 'ORGANIZATIONAL' and w['governing_manager_id'] == actor and self.governor(actor) == actor
            out = []
            for r in rows(OrgAudit.objects.order_by('-id')):
                w = self.ws_by_id(r['workspace_id']) if r['workspace_id'] else None
                if r['workspace_id'] and not audit_workspace(w):
                    continue
                if not (self.global_workspaces(actor) or r['actor_id'] == actor
                        or (r['employee_id'] and (r['employee_id'] == actor or self.in_branch(actor, r['employee_id'])))
                        or (r['workspace_id'] and governs_row(w))):
                    continue
                day = r['created_at'][:10]
                if ((p.get('employee') and r['employee_id'] != p['employee']) or (p.get('workspace') and r['workspace_id'] != p['workspace'])
                        or (p.get('actor') and r['actor_id'] != p['actor']) or (p.get('action') and p['action'] not in r['action'])
                        or (p.get('from') and day < p['from']) or (p.get('to') and day > p['to'])):
                    continue
                out.append(r)
            return paginate(out)
        if view == 'join':
            return paginate([{'id': w.id, 'name': w.name, 'governing_manager_id': w.governing_manager_id}
                             for w in Workspace.objects.filter(kind='ORGANIZATIONAL', status='ACTIVE', joinable=True).order_by('name')
                             if not self.member(w.id, actor) and (not q or q in w.name.lower())])
        if view == 'workspaces':
            return paginate([{**w, 'org_access': self.workspace_access(actor, w)} for w in rows(Workspace.objects.order_by('name'))
                             if self.can_view_workspace(actor, w) and (not q or q in w['name'].lower())])
        # People (tree / table)
        people = []
        for u in User.objects.select_related('staff').all():
            s = u.staff
            pr = Profile.objects.filter(staff_id=s.id).first()
            nickname = pr.nickname if pr else ''
            people.append({'staff_id': s.id, 'username': s.name, 'name': display_name(s.name, nickname), 'nickname': nickname,
                           'manager_id': pr.manager_id if pr else None, 'org_level': pr.org_level_id if pr else None,
                           'position': pr.position if pr else None, 'department': pr.department if pr else None,
                           'active': 1 if u.active and s.active and (not pr or pr.active) else 0})
        people.sort(key=lambda r: (r['org_level'] if r['org_level'] is not None else 1001, r['username']))
        permitted = {r['staff_id'] for r in people if self.visible_employee(actor, r['staff_id'])}
        counts = {}
        for r in people:
            if r['staff_id'] in permitted:
                counts[r['manager_id']] = counts.get(r['manager_id'], 0) + 1
        parent = p.get('parent')
        selected = [r for r in people if r['staff_id'] in permitted
                    and (not q or q in f"{r['staff_id']} {r['name']} {r['department'] or ''} {r['position'] or ''}".lower())
                    and (parent is None or ((not r['manager_id'] or r['manager_id'] not in permitted) if parent == 'root' else r['manager_id'] == parent))]
        result = paginate(selected)
        owned = [w for w in rows(Workspace.objects.all()) if self.can_view_workspace(actor, w)]
        titles = [g for g in rows(OrgGrant.objects.filter(status='ACTIVE')) if self.valid_grant(g)]
        result['rows'] = [{**r, 'children': counts.get(r['staff_id'], 0), 'governing_manager_id': self.governor(r['staff_id']),
                           'titles': uniq([g['title'] for g in titles if g['beneficiary_id'] == r['staff_id']]),
                           'workspaces': [{'id': w['id'], 'name': w['name']} for w in owned if w['owner_id'] == r['staff_id']]}
                          for r in result['rows']]
        return result

    # ------------------------------------------------------------ org.* commands
    def handle(self, action, d, actor):
        self.require_active(actor)
        if action == 'org.initialize':
            if self.settings()['enabled']:
                fail('Organizational Structure is already initialized.', 409)
            if not self.legacy_admin(actor):
                fail('An existing company Administrator must initialize organization governance.', 403)
            self.expected(d)
            initial = uniq(d.get('level1_ids') or [])
            if not initial:
                fail('Select at least one organization administrator.', 422)
            for staff in initial:
                self.require_active(staff)
            reason = self.require_reason(d)
            for staff in initial:
                before = self.person(staff)
                self.assign_person(staff, 1, None)
                self.audit(actor, 'level1.assigned', employee=staff, before=before, after=self.person(staff), reason=reason)
            OrgSettings.objects.filter(id=1).update(enabled=True, initialized_by_id=actor, initialized_at=now())
            self.invalidate()
            self.validate_tree()
            self.bump()
            return {'type': 'org_structure', 'message': 'Organization governance initialized. Review unmapped employees and legacy workspaces before cutover.'}
        if action == 'org.level.save':
            self.require_admin(actor)
            self.expected(d)
            key = integer(d.get('level'), 1, 1000, 'level')
            old = row(OrgLevel.objects.filter(id=key).first())
            name = text(d.get('name'), 'Level name', 100, True)
            if old:
                OrgLevel.objects.filter(id=key).update(name=name, version=old['version'] + 1)
            else:
                OrgLevel.objects.create(id=key, name=name)
            self.audit(actor, 'level.configured', before=old, after={'id': key, 'name': name}, reason=d.get('reason') or '')
            self.bump()
            return {'type': 'org_structure', 'message': 'Level label saved. A label does not grant capabilities.'}
        if action == 'org.template.save':
            self.require_admin(actor)
            self.expected(d)
            old = row(OrgTemplate.objects.filter(id=d['id']).first()) if d.get('id') else None
            if d.get('id') and not old:
                fail('Template not found.', 404)
            key = d.get('id') or next_id('org-template', 'TITLE')
            values = {'name': text(d.get('name'), 'Title', 100, True), 'capabilities_json': jtext(self.capabilities(d.get('capabilities'))),
                      'active': 0 if d.get('active') is False or d.get('active') == 0 else 1, 'version': old['version'] + 1 if old else 0}
            if old:
                OrgTemplate.objects.filter(id=key).update(**{**values, 'active': bool(values['active'])})
            else:
                OrgTemplate.objects.create(id=key, **{**values, 'active': bool(values['active'])})
            self.audit(actor, 'template.configured', before=old, after=values, reason=d.get('reason') or '')
            self.bump()
            return {'id': key, 'type': 'org_template', 'message': 'Template saved. Existing approved grants retain their explicit capabilities.'}
        if action == 'org.preview':
            if d.get('workspace_id'):
                w = self.ws(d['workspace_id'])
                if w['kind'] != 'ORGANIZATIONAL' or not self.can_manage_workspace(actor, w):
                    fail('Workspace not found.', 404)
                return {'type': 'org_preview', 'revision': self.settings()['revision'], 'message': 'Review workspace responsibility, members and pending approvals.',
                        'impact': {'employees': [w['owner_id'], w['governing_manager_id']], 'workspaces': [w],
                                   'grants': [w['owner_grant_id']] if w['owner_grant_id'] else [],
                                   'memberships': [{'staff_id': s, 'workspace_id': w['id']} for s in WorkspaceMember.objects.filter(workspace_id=w['id']).values_list('staff_id', flat=True)],
                                   'requests': [{'id': i, 'kind': k} for i, k in OrgRequest.objects.filter(workspace_id=w['id'], status__in=['PENDING', 'REVIEW']).values_list('id', 'kind')]}}
            targets = [] if d.get('grant_id') else [x['staff_id'] for x in self.structure_changes(d)]
            for x in targets:
                if (not self.is_level1(actor) and x != actor and (not self.in_branch(actor, x) or
                                                                   (self.governor(actor) != actor and not self.has_capability(actor, 'structure_request')))):
                    fail('This branch is outside your scope.', 403)
            if d.get('grant_id'):
                g = self.grant_row(d['grant_id'])
                if not g or (not self.is_level1(actor) and g['governing_manager_id'] != actor):
                    fail('Grant not found.', 404)
            return {'type': 'org_preview', 'revision': self.settings()['revision'],
                    'impact': self.visible_impact(actor, self.affected(targets, d.get('grant_id'))),
                    'message': 'Review affected employees, workspaces, grants and requests. Memberships remain unless explicitly revoked.'}
        if action == 'org.structure.save':
            return self.save_structure(d, actor)
        if action == 'org.structure.request':
            changes = self.structure_changes(d)
            self.expected(d)
            if not all(x['staff_id'] == actor or self.in_branch(actor, x['staff_id']) for x in changes):
                fail('You can request changes only for yourself or your approved reporting branch.', 403)
            if any(x['staff_id'] != actor for x in changes) and not self.has_capability(actor, 'structure_request'):
                fail('A structural-request capability is required.', 403)
            if not self.is_level1(actor) and self.governor(actor) != actor and any((x['level'] or 0) < 3 for x in changes):
                fail('Lower levels cannot request appointment to Level 1 or Level 2.', 403)
            return self.make_request('STRUCTURE', {'changes': changes, 'workspace_replacements': d.get('workspace_replacements') or [],
                                                   'reason': self.require_reason(d), **self.request_key(d)}, actor)
        if action in ('org.workspace.delete', 'org.workspace.restore'):
            return self.remove_workspace(d, actor, action.endswith('.restore'))
        if action == 'org.workspace.save':
            return self.save_workspace(d, actor)
        if action == 'org.workspace.classify':
            return self.classify_workspace(d, actor)
        if action == 'org.membership.request':
            return self.membership_request(d, actor)
        if action == 'org.membership.remove':
            return self.remove_member(d, actor)
        if action == 'org.delegation.request':
            p = self.delegation_payload(d, actor)
            return self.make_request('DELEGATION', p, actor, approve=self.is_level1(actor) or actor == p['governing_manager_id'])
        if action == 'org.grant.revoke':
            g = self.grant_row(d.get('id'))
            if not g:
                fail('Grant not found.', 404)
            if not self.is_level1(actor) and g['governing_manager_id'] != actor:
                fail('Only the governing manager or Level 1 can revoke authority.', 403)
            self.expected(d)
            if not d.get('acknowledged'):
                fail('Review the impact before revoking authority.', 422)
            if g['status'] == 'REVOKED':
                return {'unchanged': True, 'message': 'Grant already revoked.'}
            impact = self.affected([], g['id'])
            OrgGrant.objects.filter(id=g['id']).update(status='REVOKED', version=g['version'] + 1, updated_at=now())
            self.invalidate()
            self.replacement_workspaces(d, actor, None, impact)
            reason = self.require_reason(d)
            self.reconcile(actor, reason)
            self.audit(actor, 'delegation.revoked', employee=g['beneficiary_id'], workspace=g['workspace_id'], before=g,
                       after={'status': 'REVOKED'}, reason=d.get('reason'))
            self.bump()
            return {'id': g['id'], 'type': 'org_grant', 'message': 'Authority revoked. Dependent grants were re-evaluated and invalid grants suspended.'}
        if action == 'org.request.decide':
            return self.decide(d, actor)
        if action == 'org.request.cancel':
            q = row(OrgRequest.objects.filter(id=d.get('id')).first()) if isinstance(d.get('id'), str) else None
            if not q or q['requester_id'] != actor:
                fail('Request not found.', 404)
            if q['status'] == 'CANCELLED':
                return {'unchanged': True, 'message': 'Already cancelled.'}
            if q['status'] not in ('PENDING', 'REVIEW'):
                fail('This request has already been decided.', 409)
            OrgRequest.objects.filter(id=q['id']).update(status='CANCELLED', version=q['version'] + 1, updated_at=now())
            self.audit(actor, 'request.cancelled', employee=q['beneficiary_id'], workspace=q['workspace_id'],
                       before={'status': q['status']}, after={'status': 'CANCELLED'}, approval=q['id'])
            self.bump()
            return {'id': q['id'], 'type': 'org_request', 'message': 'Request cancelled.'}
        fail('Unknown organization action.', 404)


class _NotSet:
    """V5.7.7 returns `undefined` from some authority checks to mean "use the legacy (non-governed) rule"."""

    def __bool__(self):
        return False

    def __repr__(self):
        return 'NOTSET'


NOTSET = _NotSet()

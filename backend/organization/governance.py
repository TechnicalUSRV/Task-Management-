"""Organizational Structure governance — a rule-by-rule port of organization.mjs (V5.7.7).

One company-local authority service. It never trusts employee, role or approver identifiers supplied by the client
as proof of identity. Every mutation runs inside the command transaction; `expected_revision` is a compare-and-swap on
org_settings.revision for governance edits.

Rows are handled as plain dicts with V5.7.7 column names (see core.rows), so each rule reads like the original.
A Governance instance memoizes reads; every write in this module calls `invalidate()`.
"""
from core.i18n import msg as _message
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

from .models import CAPABILITIES, OrgAudit, OrgGrant, OrgLevel, OrgRequest, OrgSettings, OrgTemplate, Profile, ReportingLine

MAX_ADDITIONAL_MANAGERS = 10
MAX_RESPONSIBLE_MANAGERS = 10


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
        w = Workspace.objects.filter(id=text(key, _message('Workspace'), 60, True)).first()
        if not w:
            fail(_message('Workspace not found.'), 404)
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
            fail(_message('Choose an active employee with a company login.'), 422)
        return staff

    def preload_people(self):
        """Fill the person/active memo for everyone in three queries (screens that list people would otherwise ask per person)."""
        if self._memo.get('people_loaded'):
            return
        profiles = {p.staff_id: p for p in Profile.objects.all()}
        logins = set(User.objects.filter(active=True, staff__active=True).values_list('staff_id', flat=True))
        persons, actives = self._memo.setdefault('person', {}), self._memo.setdefault('active', {})
        for s in Staff.objects.all():
            persons.setdefault(s.id, self._person_row(s, profiles.get(s.id)))
            p = profiles.get(s.id)
            actives.setdefault(s.id, s.id in logins and not (p is not None and not p.active))
        spaces = self._memo.setdefault('ws', {})
        for w in rows(Workspace.objects.all()):
            spaces.setdefault(w['id'], w)
        self._memo['people_loaded'] = True

    @staticmethod
    def _person_row(s, p):
        nickname = p.nickname if p else None
        # Key order as V5.7.7 builds it (audit snapshots keep it): the row, then username.
        return {'staff_id': s.id, 'name': display_name(s.name, nickname), 'nickname': nickname,
                'org_level': p.org_level_id if p else None, 'manager_id': p.manager_id if p else None,
                'active': (1 if p.active else 0) if p else 1, 'department': p.department if p else None,
                'position': p.position if p else None, 'username': s.name}

    def person(self, staff):
        def load():
            s = Staff.objects.filter(id=staff).first() if staff else None
            if not s:
                return None
            return self._person_row(s, Profile.objects.filter(staff_id=staff).first())
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
            fail(_message('An organization administrator (Level 1) must approve this action.'), 403)

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

    # ------------------------------------------------------------ additional reporting lines (several managers)
    # The primary line (tm_profiles.manager_id) keeps every V5.7.7 rule above: levels, the Level 2 governor, structural
    # approvals and the default workspace visibility. Additional lines are used for the responsible-manager choices of a
    # workspace, for "Under My Management" and for the directory; they never widen visibility on their own.
    def extra_lines(self):
        def load():
            out = {}
            for s, m in ReportingLine.objects.order_by('id').values_list('staff_id', 'manager_id'):
                out.setdefault(s, []).append(m)
            return out
        return self._cached('lines', '', load)

    def additional_managers(self, staff):
        return list(self.extra_lines().get(staff, []))

    def managers_of(self, staff):
        """An employee's managers: the primary manager first, then active additional managers."""
        primary = self.tree()['parents'].get(staff)
        return uniq([primary, *(m for m in self.additional_managers(staff) if self.active(m))])

    def upline(self, staff):
        """Everyone above an employee on any reporting line, nearest first (a dict keeps the order)."""
        def walk():
            out, queue = {}, list(self.managers_of(staff))
            while queue:
                m = queue.pop(0)
                if not m or m == staff or m in out:
                    continue
                out[m] = True
                queue.extend(self.managers_of(m))
            return out
        return self._cached('upline', staff, walk)

    def primary_upline(self, staff):
        parents, out = self.tree()['parents'], {}
        at = parents.get(staff)
        while at and at not in out and at != staff:
            out[at] = True
            at = parents.get(at)
        return out

    def all_reports(self, staff):
        """Everyone below a manager on any reporting line (primary or additional)."""
        def walk():
            below = {}
            for s, m in self.tree()['parents'].items():
                if m:
                    below.setdefault(m, []).append(s)
            for s, managers in self.extra_lines().items():
                for m in managers:
                    if self.active(m):
                        below.setdefault(m, []).append(s)
            out, queue = {}, list(below.get(staff, []))
            while queue:
                s = queue.pop(0)
                if s == staff or s in out:
                    continue
                out[s] = True
                queue.extend(below.get(s, []))
            return out
        return self._cached('all-reports', staff, walk)

    # ------------------------------------------------------------ responsible managers (a workspace's management scope)
    def scope_rows(self):
        from workspaces.models import WorkspaceManager

        def load():
            out = {}
            for w, m in WorkspaceManager.objects.order_by('id').values_list('workspace_id', 'manager_id'):
                out.setdefault(w, []).append(m)
            return out
        return self._cached('scopes', '', load)

    def stored_scope(self, w):
        return list(self.scope_rows().get(w['id'], [])) if w else []

    def effective_scope(self, w):
        """The selected managers who are still active and still above the owner on a reporting line."""
        up = self.upline(w['owner_id'])
        return [m for m in self.stored_scope(w) if m in up and self.active(m)]

    def scope_viewers(self, w):
        """Who sees a workspace through management: None means no explicit scope (the original primary-line rule).

        With selected managers S: each selected manager, the people above them on their primary line, and the managers
        between the owner and a selected manager. A manager of the owner on another line who is not selected (and not
        below a selected manager) gets nothing from the shared subordinate.

        Once an owner has chosen managers, the choice stands even if every chosen manager later leaves or stops being
        above the owner: nobody then sees the workspace through management (owner, members, governance and authorized
        Administration still do) until the owner chooses again. It never falls back to the primary line, which could open
        the workspace to a manager the owner deliberately left out."""
        def build():
            if not self.stored_scope(w):
                return None
            scope = self.effective_scope(w)
            if not scope:
                return set()
            up = self.upline(w['owner_id'])
            out = set()
            for s in scope:
                out.add(s)
                out.update(self.primary_upline(s))
                out.update(m for m in up if s in self.upline(m))
            return out
        return self._cached('scope-viewers', w['id'], build)

    def manages_workspace(self, staff, w):
        viewers = self.scope_viewers(w)
        if viewers is None:
            return w['owner_id'] in self.descendants(staff)
        return staff in viewers

    def responsible_options(self, owner):
        """Managers an owner may choose as responsible for a workspace: everyone above them on any line, with a login."""
        return [m for m in self.upline(owner) if self.active(m)]

    def set_scope(self, w, managers, actor, reason='', approval=None):
        from workspaces.models import WorkspaceManager
        before = self.stored_scope(w)
        if before == managers:
            return False
        WorkspaceManager.objects.filter(workspace_id=w['id']).delete()
        at = now()
        WorkspaceManager.objects.bulk_create(WorkspaceManager(workspace_id=w['id'], manager_id=m, created_by_id=actor, created_at=at) for m in managers)
        self.invalidate()
        self.audit(actor, 'workspace.management_scope', workspace=w['id'], before={'managers': before}, after={'managers': managers},
                   reason=reason or _message('Responsible managers changed'), approval=approval)
        return True

    def scope_input(self, value, owner):
        if not isinstance(value, list) or len(value) > MAX_RESPONSIBLE_MANAGERS or any(not isinstance(x, str) for x in value):
            fail(_message('Choose up to {p0} responsible managers.', p0=MAX_RESPONSIBLE_MANAGERS), 422)
        chosen = uniq(value)
        allowed = set(self.responsible_options(owner))
        if any(m not in allowed for m in chosen):
            fail(_message('Choose responsible managers from the owner’s own reporting lines.'), 422)
        return chosen

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

    def operational_access(self, staff):
        """Unmapped accounts keep sign-in/navigation, but no business records. Administration can onboard."""
        return self.active(staff) and (bool(self.level(staff)) or self.legacy_admin(staff))

    def require_operational(self, staff):
        if not self.operational_access(staff):
            fail(_message('Your account is not mapped to the Organizational Structure. Ask an administrator to assign your level.'), 403)

    def global_workspaces(self, staff):
        return self.legacy_admin(staff) and self.can_staff(staff, 'admin.workspaces', 'view')

    def can_manage_structure(self, staff):
        return self.can_staff(staff, 'tasks.organization', 'create')

    # ------------------------------------------------------------ workspace authority
    def workspace_reason(self, staff, w):
        if not w or w['deleted_at'] or not self.operational_access(staff):
            return None
        if self.global_workspaces(staff):
            return 'organization'
        if w['owner_id'] == staff:
            return 'owner'
        if is_personal_workspace(w):
            # A Personal workspace is shared only by explicit membership; supervising its owner never opens it.
            return 'membership' if self.member(w['id'], staff) else None
        if self.member(w['id'], staff):
            return 'membership'
        if self.manages_workspace(staff, w):
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

    def group_context(self, staff, b):
        """organization.mjs groupContext(): who may open a Group of a governed or personal workspace.

        None for legacy workspaces (the group's own sharing decides). `allowed` False hides the group; `admin` lets
        authorized Administration manage Team groups of organizational workspaces; `viewer` limits inherited workspace
        rights to viewing (direct grants and ownership stay independent)."""
        from groups.models import BoardAccess
        if not self.operational_access(staff):
            return {'allowed': False, 'admin': False, 'viewer': True}
        w = self.ws_by_id(b['workspace_id'])
        if w and w['deleted_at']:
            return {'allowed': False, 'admin': False, 'viewer': True}
        if is_personal_workspace(w):
            # Members of a shared Personal workspace use its groups as their membership role allows (Viewer: view only).
            return {'allowed': self.can_view_workspace(staff, w), 'admin': False,
                    'viewer': staff != w['owner_id'] and self.member_role(w['id'], staff) != 'MEMBER'}
        if not self.governed(w):
            return None
        direct = BoardAccess.objects.filter(board_id=b['id'], staff_id=staff).exists()
        allowed = b['owner_id'] == staff or self.member(w['id'], staff) or direct or self.global_workspaces(staff)
        return {'allowed': bool(allowed), 'admin': w['kind'] == 'ORGANIZATIONAL' and b['visibility'] == 'TEAM' and bool(self.global_workspaces(staff)),
                'viewer': self.member_role(w['id'], staff) == 'VIEWER'}

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
            fail(_message('Inviting someone outside this workspace requires approved outside-collaboration authority. Request membership instead.'), 403)

    # Task and meeting authority paths (task-specific actions stay in the tasks app).
    def task_reason(self, staff, t, involved):
        from tasks.policy import visibility_reason
        return visibility_reason(self, staff, t, involved)

    def meeting_reason(self, staff, m, participant, shared):
        if not self.operational_access(staff):
            return False
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
            fail(_message('Organizational governance changed. Refresh the preview before saving.'), 409)

    @staticmethod
    def capabilities(value):
        if not isinstance(value, list) or len(value) > len(CAPABILITIES) or any(x not in CAPABILITIES for x in value):
            fail(_message('Choose valid scoped capabilities.'), 422)
        return sorted(uniq(value))

    @staticmethod
    def require_reason(d):
        return text(d.get('reason'), _message('Reason'), 2000, True)

    def assign_person(self, staff, org_level, manager):
        if manager and manager == staff:
            # V5.7.7 stores the change and validateTree() then refuses it with this message; here the database's own
            # check (tm_profile_not_own_manager) would refuse it first, so the same answer is given before writing.
            fail(_message('The reporting manager must be active at an earlier valid level: Level 2 reports to Level 1; Level 3+ reports through Level 2.'), 422)
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
                fail(_message('Choose a configured organizational level.'), 422)
            if p['org_level'] == 1:
                if p['manager_id']:
                    fail(_message('Level 1 employees report to the organization root.'), 422)
                continue
            m = by.get(p['manager_id'])
            if (not m or not self.active(p['manager_id']) or m['staff_id'] == p['staff_id'] or m['org_level'] >= p['org_level']
                    or (p['org_level'] == 2 and m['org_level'] != 1) or (p['org_level'] >= 3 and m['org_level'] < 2)):
                fail(_message('The reporting manager must be active at an earlier valid level: Level 2 reports to Level 1; Level 3+ reports through Level 2.'), 422)
            seen, at = {p['staff_id']}, p['manager_id']
            while at:
                if at in seen:
                    fail(_message('Reporting cycles are not allowed.'), 422)
                seen.add(at)
                at = (by.get(at) or {}).get('manager_id')
        if self.settings()['enabled'] and not any(p['org_level'] == 1 and self.active(p['staff_id']) for p in data):
            fail(_message('Keep at least one active Level 1 organization administrator.'), 409)

    def ensure_workspace_authority(self, w):
        if w['kind'] != 'ORGANIZATIONAL':
            return
        g = w['governing_manager_id']
        if not g or self.governor(g) != g:
            fail(_message('Choose an active Level 2 governing manager who reports to Level 1.'), 422)
        self.require_active(w['owner_id'])
        if w['owner_id'] != g:
            grant = self.grant_row(w['owner_grant_id']) if w.get('owner_grant_id') else None
            if (self.governor(w['owner_id']) != g or not self.valid_grant(grant) or grant['beneficiary_id'] != w['owner_id']
                    or 'workspace_create' not in parse(grant['capabilities_json'], [])):
                fail(_message('Workspace {p0} needs a valid owner grant or a responsible Level 2 replacement.', p0=w['name']), 409)

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
                    self.notify(following, row(OrgRequest.objects.get(id=q['id'])), 'review', _message('A governance request now needs your review.'))

    def replacement_workspaces(self, d, actor, approval=None, impact=None):
        replacements = d.get('workspace_replacements') or []
        if not isinstance(replacements, list) or any(not isinstance(x, dict) for x in replacements):
            fail(_message('Provide valid workspace replacements.'), 422)
        if impact and any(not any(w['id'] == x.get('id') for w in impact['workspaces']) for x in replacements):
            fail(_message('Workspace replacements must belong to the affected scope shown in the preview.'), 422)
        for change in replacements:
            old = self.ws(change.get('id'))
            if old['kind'] != 'ORGANIZATIONAL':
                fail(_message('Only organizational workspaces need a governance replacement.'), 422)
            if not self.is_level1(actor) and not self.governs(actor, old):
                fail(_message('This workspace belongs to another management branch.'), 403)
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
            fail(_message('Supply 1–500 reporting changes.'), 422)
        if len({str(x.get('staff_id')) for x in value}) != len(value):
            fail(_message('Include each employee only once in a structural change.'), 422)
        out = []
        for x in value:
            change = {'staff_id': self.require_active(x.get('staff_id')),
                      'level': None if x.get('level') is None else integer(x.get('level'), 1, 1000, _message('level')),
                      'manager_id': self.require_active(x['manager_id']) if x.get('manager_id') else None}
            # Additional reporting managers: optional; when the key is left out, the existing additional lines stay.
            if x.get('additional_manager_ids') is not None:
                extra = x['additional_manager_ids']
                if (not isinstance(extra, list) or len(extra) > MAX_ADDITIONAL_MANAGERS
                        or any(not isinstance(m, str) or not m for m in extra)):
                    fail(_message('Choose up to {p0} additional reporting managers.', p0=MAX_ADDITIONAL_MANAGERS), 422)
                change['additional_manager_ids'] = [self.require_active(m) for m in uniq(extra) if m != change['manager_id']]
                if change['staff_id'] in change['additional_manager_ids']:
                    fail(_message('An employee cannot report to themselves.'), 422)
            out.append(change)
        return out

    def set_lines(self, staff, managers, actor, reason, approval=None):
        before = self.additional_managers(staff)
        if before == managers:
            return
        ReportingLine.objects.filter(staff_id=staff).delete()
        at = now()
        ReportingLine.objects.bulk_create(ReportingLine(staff_id=staff, manager_id=m, created_by_id=actor, created_at=at) for m in managers)
        self.invalidate()
        self.audit(actor, 'employee.reporting_lines', employee=staff, before={'additional_manager_ids': before},
                   after={'additional_manager_ids': managers}, reason=reason, approval=approval)

    def validate_lines(self):
        """Additional managers follow the same level rules as the primary manager, and no line may form a cycle."""
        for staff, managers in self.extra_lines().items():
            mine = self.level(staff)
            for m in managers:
                if not self.active(m):
                    continue   # a line to a deactivated manager is ignored everywhere until it is removed
                theirs = self.level(m)
                if (not mine or not theirs or theirs >= mine or (mine == 2 and theirs != 1) or (mine >= 3 and theirs < 2)
                        or m == self.tree()['parents'].get(staff)):
                    fail(_message('Each additional reporting manager must be active at an earlier valid level (Level 2 reports to Level 1; Level 3+ reports through Level 2) and differ from the primary manager.'), 422)
        # Any cycle in the combined graph passes through someone with an additional line (the primary tree has none).
        for staff in self.extra_lines():
            seen, queue = set(), list(self.managers_of(staff))
            while queue:
                m = queue.pop()
                if m == staff:
                    fail(_message('Reporting cycles are not allowed.'), 422)
                if not m or m in seen:
                    continue
                seen.add(m)
                queue.extend(self.managers_of(m))

    def can_change_structure(self, actor, changes):
        if self.is_level1(actor):
            return True
        return self.governor(actor) == actor and all(
            x['staff_id'] != actor and (self.level(x['staff_id']) or 0) >= 3 and (x['level'] or 0) >= 3
            and self.governor(x['staff_id']) == actor and self.governor(x['manager_id']) == actor
            and all(self.governor(m) == actor for m in x.get('additional_manager_ids') or [])
            and x['manager_id'] != x['staff_id'] for x in changes)

    def save_structure(self, d, actor, approval=None):
        changes = self.structure_changes(d)
        if not self.can_change_structure(actor, changes):
            fail(_message('This structural change needs the responsible Level 2 or a Level 1 administrator.'), 403)
        reason = self.require_reason(d)
        self.expected(d)
        if d.get('acknowledged') is not True:
            fail(_message('Review and acknowledge the affected scope before saving.'), 422)
        impact = self.affected([x['staff_id'] for x in changes])
        before = [self.person(x['staff_id']) for x in changes]
        for x in changes:
            self.assign_person(x['staff_id'], x['level'], x['manager_id'])
        for x in changes:
            if 'additional_manager_ids' in x:
                self.set_lines(x['staff_id'], x['additional_manager_ids'], actor, reason, approval)
            elif x['manager_id'] in self.additional_managers(x['staff_id']):
                # The new primary manager no longer needs an additional line as well.
                self.set_lines(x['staff_id'], [m for m in self.additional_managers(x['staff_id']) if m != x['manager_id']], actor, reason, approval)
        self.validate_tree()
        self.validate_lines()
        self.replacement_workspaces(d, actor, approval, impact)
        self.reconcile(actor, reason)
        for i, x in enumerate(changes):
            self.audit(actor, 'employee.structure', employee=x['staff_id'], before=before[i], after=self.person(x['staff_id']),
                       reason=reason, approval=approval)
        self.bump()
        return {'type': 'org_structure', 'message': _message('Reporting structure saved. Existing tasks and approvals keep their responsible people.'),
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
                fail(_message('This request needs an organizational workspace.'), 422)
            g = w['governing_manager_id']
            return g if self.governor(g) == g else None
        if kind == 'DELEGATION':
            return self.governor(p.get('beneficiary_id'))
        changes = self.structure_changes(p)
        governors = uniq([g for x in changes for g in (self.governor(x['staff_id']), self.governor(x['manager_id']),
                                                       *(self.governor(m) for m in x.get('additional_manager_ids') or []))])
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
        key = f"{actor}:{kind}:{text(p.get('request_key'), _message('Request key'), 100, True)}" if p.get('request_key') else None
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
            fail(_message('This request key belongs to another governance change.'), 409)
        if existing:
            return {'id': existing.id, 'type': 'org_request', 'message': _message('Request already recorded.'), 'unchanged': True, 'status': existing.status}
        at = now()
        created = OrgRequest.objects.create(id=next_id('org-request', 'ORGREQ'), kind=kind, workspace_id=p.get('workspace_id') or None,
                                            beneficiary_id=p.get('beneficiary_id') or None, requester_id=actor, approver_id=approver,
                                            payload_json=jtext(p), reason=text(p.get('reason'), _message('Reason'), 2000, True),
                                            status='PENDING' if approver else 'REVIEW', request_key=key, fingerprint=fingerprint,
                                            created_at=at, updated_at=at)
        q = row(created)
        # The audit snapshot is the request as V5.7.7 inserts it (without the columns that only get defaults).
        snapshot = {k: q[k] for k in ('id', 'kind', 'workspace_id', 'beneficiary_id', 'requester_id', 'approver_id', 'payload_json', 'reason',
                                      'status', 'request_key', 'fingerprint', 'created_at', 'updated_at')}
        self.audit(actor, 'request.created', employee=q['beneficiary_id'], workspace=q['workspace_id'], after=snapshot, reason=q['reason'],
                   approval=q['id'])
        if approve:
            return self.decide({'id': q['id'], 'decision': 'APPROVE', 'note': _message('Direct authorized approval')}, approval_actor or actor, administrative=True)
        if approver:
            self.notify(approver, q, 'review', _message('{p0} requested {p1}. Review the scope before deciding.', p0=self.person(actor)['name'], p1=kind.lower()))
        self.bump()
        return {'id': q['id'], 'type': 'org_request', 'status': q['status'],
                'message': _message('Request sent for approval. No access is active yet.') if approver else
                _message('No valid approver is configured. A Level 1 administrator must correct governance; no access is active.')}

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
            fail(_message('Choose Member or Viewer.'), 422)
        if w['kind'] == 'LEGACY':
            fail(_message('Classify this legacy workspace before using governed membership approval.'), 409)
        if w['status'] != 'ACTIVE':
            fail(_message('Restore the workspace first.'), 409)
        if w['kind'] == 'PERSONAL':
            if w['owner_id'] != actor:
                visible = self.can_view_workspace(actor, w)
                fail(_message('Only the personal workspace owner can share it.') if visible else _message('Workspace not found.'), 403 if visible else 404)
            existed = self.member(w['id'], target)
            reason = None if existed else self.require_reason(d)
            self.activate_member(w['id'], target, actor, role, None)
            if not existed:
                self.audit(actor, 'personal.shared', employee=target, workspace=w['id'], after={'member_role': role}, reason=reason)
                self.bump()
            stays = (_message('Member added. The workspace stays Personal: only you, its members and authorized Administration can open it.')
                     if is_personal_workspace(w) else _message('Member added.'))
            return {'id': w['id'], 'type': 'tm_workspace', 'message': _message('This person already has membership.') if existed else stays}
        direct = self.can_view_workspace(actor, w) and (
            self.governs(actor, w) or self.global_workspaces(actor)
            or (self.is_level1(actor) and w['owner_id'] in self.descendants(actor)) or self.owner_can_add(actor, w, target))
        if not direct:
            if target == actor:
                if not w['joinable'] and not self.can_view_workspace(actor, w):
                    fail(_message('Workspace not found.'), 404)
            elif (not self.level(target) or not self.has_capability(actor, 'membership_request', w)
                  or not self.in_branch(actor, target) or self.governor(target) != w['governing_manager_id']):
                fail(_message('You can nominate only employees in your approved branch. Ask the governing manager for a cross-branch exception.'), 403)
        if self.member(w['id'], target):
            return {'id': w['id'], 'type': 'tm_workspace', 'message': _message('This person already has active membership.'), 'unchanged': True}
        return self.make_request('MEMBERSHIP', {'workspace_id': w['id'], 'beneficiary_id': target, 'member_role': role,
                                                'reason': self.require_reason(d), **self.request_key(d)},
                                 actor, approve=direct)

    def delegation_payload(self, d, actor):
        target = self.require_active(d.get('beneficiary_id'))
        g = self.governor(target)
        template = row(OrgTemplate.objects.filter(id=d.get('template_id') or 'OWNER', active=True).first())
        if not template or (self.level(target) or 0) < 3 or not g:
            fail(_message('Delegation needs a configured Level 3+ employee and a valid Level 2 manager.'), 422)
        allowed = parse(template['capabilities_json'], [])
        caps = self.capabilities(d['capabilities'] if d.get('capabilities') else allowed)
        if not caps or not all(k in allowed for k in caps):
            fail(_message('Choose capabilities from the approved template.'), 422)
        w = self.ws(d['workspace_id']) if d.get('workspace_id') else None
        if w and (w['kind'] != 'ORGANIZATIONAL' or w['governing_manager_id'] != g):
            fail(_message('The delegation workspace must have the same responsible Level 2 manager.'), 422)
        parent = None
        if not self.is_level1(actor) and actor != g:
            if target == actor or not self.in_branch(actor, target):
                fail(_message('Delegation is only available for employees below you.'), 403)
            parent = self.grant_row(d.get('parent_grant_id') or '')
            if (not self.valid_grant(parent) or parent['beneficiary_id'] != actor
                    or 'delegate_request' not in parse(parent['capabilities_json'], [])
                    or not all(k in parse(parent['capabilities_json'], []) for k in caps)
                    or parent['governing_manager_id'] != g or (parent['workspace_id'] and parent['workspace_id'] != (w or {}).get('id'))):
                fail(_message('The requested authority exceeds your active scoped delegation.'), 403)
        return {'beneficiary_id': target, 'template_id': template['id'], 'title': template['name'], 'capabilities': caps,
                'branch_root_id': target, 'workspace_id': w['id'] if w else None, 'governing_manager_id': g,
                'parent_grant_id': parent['id'] if parent else None, 'reason': self.require_reason(d), **self.request_key(d)}

    def decision_authority(self, actor, q):
        current = self.approver_for(q['kind'], parse(q['payload_json']), q['requester_id'])
        if not current:
            fail(_message('A valid responsible manager must be configured before approving.'), 409)
        if (current != actor and not self.global_workspaces(actor)
                and not (self.is_level1(actor) and q['beneficiary_id'] and q['beneficiary_id'] in self.descendants(actor))):
            fail(_message('You are not the current responsible approver.'), 403)

    def decide(self, d, actor, administrative=False):
        q = row(OrgRequest.objects.filter(id=text(d.get('id'), _message('Request'), 60, True)).first())
        if not q or not self.request_visible(actor, q):
            fail(_message('Request not found.'), 404)
        decision = d.get('decision')
        if decision not in ('APPROVE', 'REJECT'):
            fail(_message('Choose Approve or Reject.'), 422)
        owner_approval = (administrative and q['kind'] == 'MEMBERSHIP' and q['requester_id'] == actor
                          and self.owner_can_add(actor, self.ws(q['workspace_id']), q['beneficiary_id']))
        if not owner_approval:
            self.decision_authority(actor, q)
        if not administrative and q['requester_id'] == actor:
            fail(_message('You cannot approve your own request.'), 403)
        if q['status'] not in ('PENDING', 'REVIEW'):
            if q['status'] == ('APPROVED' if decision == 'APPROVE' else 'REJECTED'):
                return {'id': q['id'], 'type': 'org_request', 'status': q['status'], 'message': _message('This decision is already recorded.'), 'unchanged': True}
            fail(_message('This request has already been decided.'), 409)
        if d.get('expected_version') is not None and d['expected_version'] != q['version']:
            fail(_message('This record changed. Refresh it before saving again.'), 409)
        p = parse(q['payload_json'])
        note = text(d.get('note'), _message('Decision note'), 2000, decision == 'REJECT')
        if decision == 'APPROVE':
            if q['kind'] == 'MEMBERSHIP':
                w = self.ws(q['workspace_id'])
                if w['kind'] != 'ORGANIZATIONAL' or w['status'] != 'ACTIVE':
                    fail(_message('The workspace is no longer eligible.'), 409)
                self.require_active(q['beneficiary_id'])
                if p.get('member_role') not in ('MEMBER', 'VIEWER'):
                    fail(_message('Invalid membership role.'), 422)
                r = q['requester_id']
                if (r != q['beneficiary_id'] and not self.is_level1(r) and not self.governs(r, w)
                        and (not self.active(r) or not self.has_capability(r, 'membership_request', w)
                             or not self.in_branch(r, q['beneficiary_id']) or self.governor(q['beneficiary_id']) != w['governing_manager_id'])):
                    fail(_message('The inviter’s authority changed. Submit a new membership request.'), 409)
                self.activate_member(w['id'], q['beneficiary_id'], actor, p['member_role'], q['id'])
                self.audit(actor, 'membership.approved', employee=q['beneficiary_id'], workspace=w['id'],
                           after={'member_role': p['member_role']}, reason=note or q['reason'], approval=q['id'])
            elif q['kind'] == 'DELEGATION':
                checked = self.delegation_payload({**p, 'reason': q['reason']}, q['requester_id'])
                if checked['governing_manager_id'] != p.get('governing_manager_id'):
                    fail(_message('The branch changed. Submit a new delegation request.'), 409)
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
                    fail(_message('Review and acknowledge the affected structure before approving.'), 422)
                r = q['requester_id']
                changes = self.structure_changes(p)
                if (not self.is_level1(r) and self.governor(r) != r and any(x['staff_id'] != r for x in changes)
                        and not self.has_capability(r, 'structure_request')):
                    fail(_message('The requester’s structural authority was revoked. Submit a new request.'), 409)
                if (not self.active(r) or not all(x['staff_id'] == r or self.in_branch(r, x['staff_id']) for x in changes)
                        and not self.is_level1(r) and self.governor(r) != r):
                    fail(_message('The requester no longer has authority over the requested branch.'), 409)
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
                self.notify(staff, done, word, _message('{p0} request {p1}.{p2}', p0=q['kind'].lower(), p1=word, p2=' ' + note if note else ''))
        self.bump()
        return {'id': q['id'], 'type': 'org_request', 'status': done['status'], 'message': _message('Request {p0}.', p0=done['status'].lower())}

    # ------------------------------------------------------------ workspaces
    def save_workspace(self, d, actor):
        old = self.ws(d['id']) if d.get('id') else None
        kind = old['kind'] if old else ('PERSONAL' if d.get('kind') == 'PUBLIC' else d.get('kind')) or 'PERSONAL'
        visibility = old['visibility'] if old else ('PUBLIC' if d.get('kind') == 'PUBLIC' or kind == 'ORGANIZATIONAL' else 'PERSONAL')
        if kind not in ('PERSONAL', 'ORGANIZATIONAL'):
            fail(_message('Choose Personal or Organizational. Legacy workspaces use migration review.'), 422)
        if old:
            if not self.can_view_workspace(actor, old):
                fail(_message('Workspace not found.'), 404)
            if d.get('expected_version') != old['version']:
                fail(_message('This record changed. Refresh it before saving again.'), 409)
            if not self.can_manage_workspace(actor, old):
                fail(_message('You cannot manage this workspace.'), 403)
            if d.get('kind') and d['kind'] != old['kind'] and not (d['kind'] == 'PUBLIC' and old['kind'] == 'PERSONAL' and old['visibility'] == 'PUBLIC'):
                fail(_message('Workspace privacy classification cannot be changed through an ordinary edit.'), 403)
            # The only visibility change: the owner explicitly makes a Personal workspace Public (never the reverse here).
            wanted = d.get('visibility')
            if wanted not in (None, old['visibility']):
                if not (wanted == 'PUBLIC' and old['kind'] == 'PERSONAL' and old['owner_id'] == actor):
                    fail(_message('Only the owner can make a Personal workspace Public. Public workspaces cannot be made Personal here.'), 403)
                if d.get('acknowledged') is not True:
                    fail(_message('Confirm that the workspace’s responsible managers will be able to see it before making it Public.'), 422)
                visibility = 'PUBLIC'
        owner = (d.get('owner_id') or old['owner_id']) if old else (actor if kind == 'PERSONAL' else d.get('owner_id') or actor)
        if kind == 'PERSONAL' and owner != actor:
            fail(_message('Only the owner can manage a personal workspace.'), 403)
        governing = (d.get('governing_manager_id') or (old or {}).get('governing_manager_id') or self.governor(owner)) if kind == 'ORGANIZATIONAL' else None
        grant_id = None
        if kind == 'ORGANIZATIONAL' and owner != governing:
            grant_id = d.get('owner_grant_id') or (old or {}).get('owner_grant_id')
            if not grant_id:
                grant_id = next((g['id'] for g in self.grants(owner) if 'workspace_create' in parse(g['capabilities_json'], [])
                                 and (not g['workspace_id'] or g['workspace_id'] == d.get('origin_workspace_id'))), None)
        if kind == 'ORGANIZATIONAL':
            if not self.settings()['enabled']:
                fail(_message('Initialize Organizational Structure and assign a Level 2 manager first.'), 409)
            if (not old and not self.is_level1(actor) and actor != governing and
                    (not self.has_capability(actor, 'workspace_create') or owner != actor or self.governor(actor) != governing)):
                fail(_message('An approved Owner capability is required to create a delegated organizational workspace.'), 403)
            if (old and not self.is_level1(actor) and not self.governs(actor, old)
                    and (owner != old['owner_id'] or governing != old['governing_manager_id'] or grant_id != old['owner_grant_id'])):
                fail(_message('Only the governing manager or a Level 1 administrator can change this workspace’s owner or governing manager.'), 403)
        if old and kind == 'ORGANIZATIONAL' and (owner != old['owner_id'] or governing != old['governing_manager_id'] or grant_id != old['owner_grant_id']):
            self.expected(d)
            if d.get('acknowledged') is not True:
                fail(_message('Preview and acknowledge the affected workspace governance before changing its owner or manager.'), 422)
        if 'origin_workspace_id' not in d:
            origin = (old or {}).get('origin_workspace_id')
        else:
            origin = d.get('origin_workspace_id') or None
        origin_changed = not old or origin != old['origin_workspace_id']
        if old and origin_changed and not self.is_level1(actor) and not self.governs(actor, old):
            fail(_message('A governing manager must approve changes to workspace governance links.'), 403)
        if origin and origin_changed:
            related = self.ws(origin)
            if (origin == (old or {}).get('id') or related['kind'] != 'ORGANIZATIONAL' or related['governing_manager_id'] != governing
                    or not self.can_view_workspace(actor, related)):
                fail(_message('Choose an authorized organizational workspace under the same governing manager.'), 422)
        if grant_id:
            g = self.grant_row(grant_id)
            if g and g['workspace_id'] and g['workspace_id'] != origin and (old or {}).get('owner_grant_id') != grant_id:
                fail(_message('This Owner grant is restricted to its approved originating workspace.'), 403)
        joinable = (d['joinable'] if d.get('joinable') is not None else (old or {}).get('joinable'))
        values = {
            'name': text(d.get('name', (old or {}).get('name')), _message('Workspace name'), 200, True),
            'description': text(d.get('description', (old or {}).get('description')), _message('Description'), 5000),
            'department': text(d.get('department', (old or {}).get('department')), _message('Department'), 150),
            'owner_id': self.require_active(owner), 'kind': kind, 'visibility': visibility,
            'governing_manager_id': governing, 'owner_grant_id': grant_id, 'origin_workspace_id': origin,
            'joinable': 1 if kind == 'ORGANIZATIONAL' and joinable else 0,
            'color': d.get('color') or (old or {}).get('color') or 'BLUE',
            'status': (old or {}).get('status') or 'ACTIVE', 'version': old['version'] + 1 if old else 0, 'updated_at': iso(now()),
        }
        if values['color'] not in COLORS:
            fail(_message('Choose a valid workspace color.'), 422)
        self.ensure_workspace_authority({**(old or {}), **values})
        if old and isinstance(d.get('member_ids'), list):
            before = sorted(WorkspaceMember.objects.filter(workspace_id=old['id']).values_list('staff_id', flat=True))
            after = sorted(uniq([*d['member_ids'], owner]))
            if before != after:
                fail(_message('Use membership requests or the explicit member-removal action; a workspace edit cannot bypass approval.'), 403)
        initial = []
        if not old and d.get('member_ids') is not None:
            # Members chosen while creating a workspace go through the normal membership path right after it exists
            # (direct for the owner's own approved branch, an approval request otherwise), so nothing bypasses approval.
            if (not isinstance(d['member_ids'], list) or len(d['member_ids']) > 100
                    or any(not isinstance(x, str) for x in d['member_ids'])):
                fail(_message('Choose up to 100 members.'), 422)
            initial = [x for x in uniq(d['member_ids']) if x != owner]
            if initial and owner != actor:
                fail('Create the workspace first, then add or request members through approval.', 403)
        # Responsible managers (management scope): who supervises this workspace's work. Only for workspaces managers
        # can see (Public or Organizational); chosen from the owner's own reporting lines.
        scope = None
        if 'manager_ids' in d and d['manager_ids'] is not None:
            if visibility != 'PUBLIC':
                fail(_message('Responsible managers apply to Public and Organizational workspaces. A Personal workspace stays private.'), 422)
            if old and not self.can_manage_workspace(actor, old):
                fail(_message('You cannot manage this workspace.'), 403)
            scope = self.scope_input(d['manager_ids'], owner)
        if any(n.lower() == values['name'].lower() for n in Workspace.objects.exclude(id=(old or {}).get('id', '')).values_list('name', flat=True)):
            fail(_message('A workspace with this name already exists.'), 409)
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
                   reason=d.get('reason') or _message('Explicit workspace setup'))
        if scope is not None:
            self.set_scope({'id': key}, scope, actor, d.get('reason') or _message('Responsible managers chosen'))
        self.reconcile(actor, _message('Workspace governance changed'))
        pending = 0
        for staff in initial:
            r = self.membership_request({'workspace_id': key, 'beneficiary_id': staff, 'member_role': 'MEMBER',
                                         'reason': d.get('reason') or _message('Selected when the workspace was created')}, actor)
            pending += 1 if r.get('type') == 'org_request' and r.get('status') in ('PENDING', 'REVIEW') else 0
        self.bump()
        message = _message('{p0} workspace saved. Membership and contents remain separate.', p0='Personal' if visibility == 'PERSONAL' else 'Public')
        if pending:
            message += _message(' {p0} {p1} the responsible manager’s approval.', p0=pending, p1='membership needs' if pending == 1 else 'memberships need')
        return {'id': key, 'type': 'tm_workspace', 'message': message}

    def remove_workspace(self, d, actor, restore=False):
        w = self.ws(d.get('id'))
        if not self.can_view_workspace(actor, w) and not self.creator(actor, w):
            fail(_message('Workspace not found.'), 404)
        if not self.creator(actor, w):
            fail(_message('Only the user who created this workspace can delete or restore it.'), 403)
        if d.get('expected_version') != w['version']:
            fail(_message('This record changed. Refresh it before saving again.'), 409)
        if (not w['deleted_at']) if restore else bool(w['deleted_at']):
            return {'id': w['id'], 'type': 'tm_workspace', 'unchanged': True,
                    'message': _message('Workspace already restored.') if restore else _message('Workspace already deleted.')}
        if d.get('acknowledged') is not True:
            fail(_message('Confirm workspace deletion or restoration first.'), 422)
        if restore and w['kind'] == 'ORGANIZATIONAL':
            try:
                self.ensure_workspace_authority(w)
            except Exception:  # noqa: BLE001 — repair below, exactly as V5.6.8
                g = w['governing_manager_id']
                if not g or self.governor(g) != g:
                    fail(_message('This workspace’s governing manager is no longer a valid Level 2 manager. Correct the reporting structure first, then restore it.'), 409)
                Workspace.objects.filter(id=w['id']).update(owner_id=g, owner_grant_id=None)
                self.invalidate()
                self.activate_member(w['id'], g, actor, 'MEMBER', None)
                self.audit(actor, 'workspace.governance', workspace=w['id'], before={'owner_id': w['owner_id'], 'owner_grant_id': w['owner_grant_id']},
                           after={'owner_id': g, 'owner_grant_id': None}, reason=_message('Restored: the previous owner no longer had valid authority'))
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
                OrgRequest.objects.filter(id=q['id']).update(status='CANCELLED', decision_note=_message('Workspace deleted by its creator.'),
                                                             version=q['version'] + 1, updated_at=at)
                self.audit(actor, 'request.cancelled', workspace=w['id'], approval=q['id'], before={'status': q['status']},
                           after={'status': 'CANCELLED'}, reason=_message('Workspace deleted by its creator.'))
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
                title=_message('Workspace {p0}: {p1}', p0='restored' if restore else 'deleted', p1=w['name']),
                body=(_message('{p0} restored it. Its tasks, requests and meetings are available again.', p0=who) if restore else
                      _message('{p0} deleted it. Its tasks, requests and meetings are hidden until it is restored.', p0=who)))
        self.audit(actor, 'workspace.restored' if restore else 'workspace.deleted', workspace=w['id'],
                   before={'status': w['status'], 'deleted_at': w['deleted_at']}, after=change_row,
                   reason=d.get('reason') or _message('Confirmed by workspace creator'))
        self.bump()
        return {'id': w['id'], 'type': 'tm_workspace', 'message': _message('Workspace restored. Previous memberships and work are retained.') if restore
                else _message('Workspace deleted. Its creator can restore it from My Workspaces.')}

    def migration_preview(self, actor):
        if not self.is_level1(actor) and not (self.legacy_admin(actor) and not self.settings()['enabled']):
            fail(_message('Only an organization administrator can review migration.'), 403)
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
                'policy': _message('No automatic level or privacy classification. Legacy memberships and direct task/meeting participation stay intact until an explicit, audited workspace cutover.')}

    def classify_workspace(self, d, actor):
        old = self.ws(d.get('id'))
        if not self.can_view_workspace(actor, old):
            fail(_message('Workspace not found.'), 404)
        if d.get('expected_version') != old['version']:
            fail(_message('This record changed. Refresh it before saving again.'), 409)
        self.expected(d)
        if old['kind'] != 'LEGACY':
            fail(_message('This workspace is already classified. Automatic personal/organizational conversion is not supported.'), 409)
        if d.get('acknowledged') is not True:
            fail(_message('Review and acknowledge the migration impact first.'), 422)
        reason = self.require_reason(d)
        at = now()
        if d.get('kind') in ('PERSONAL', 'PUBLIC'):
            if actor != old['owner_id']:
                fail(_message('Only the existing owner can classify and explicitly share a personal workspace.'), 403)
            shared = d.get('shared_member_ids')
            if not isinstance(shared, list):
                fail(_message('Explicitly select retained sharing when classifying a personal workspace.'), 422)
            previous = list(WorkspaceMember.objects.filter(workspace_id=old['id']).values_list('staff_id', flat=True))
            if any(k != actor and k not in shared for k in previous):
                fail(_message('Preserve existing memberships during migration. Review and revoke specific sharing separately afterwards.'), 409)
            for k in shared:
                if k not in previous:
                    self.require_active(k)
            # Retained or explicitly shared members no longer force Public: the owner's choice decides.
            public = d['kind'] == 'PUBLIC'
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
            fail(_message('Explicitly classify this workspace as Personal or Organizational.'), 422)
        WorkspaceMember.objects.filter(workspace_id=old['id'], approved_by__isnull=True).update(approved_by_id=actor)
        WorkspaceMember.objects.filter(workspace_id=old['id'], joined_at__isnull=True).update(joined_at=at)
        self.invalidate()
        self.audit(actor, 'migration.workspace', workspace=old['id'], before=old, after=self.ws(old['id']), reason=reason)
        self.bump()
        return {'id': old['id'], 'type': 'tm_workspace', 'message': _message('Workspace classified. Existing records, participants and memberships were preserved.')}

    # ------------------------------------------------------------ command guard (runs before every command)
    def guard(self, action, d, actor):
        if action.startswith('tm.') or (action.startswith('org.') and not self.can_manage_structure(actor)):
            self.require_operational(actor)
        if action not in ('tm.workspace.delete', 'tm.workspace.restore', 'org.workspace.delete', 'org.workspace.restore'):
            wid = d.get('workspace_id') or (d.get('id') if action.startswith(('tm.workspace.', 'org.workspace.')) else None)
            if isinstance(wid, str) and wid and self.workspace_removed(wid):
                fail(_message('This workspace was deleted. Its creator must restore it first.'), 409)
        if action.startswith('org.') and not self.can_manage_structure(actor):
            fail(_message('Organizational Structure Create permission is required for management actions.'), 403)
        if not self.settings()['enabled']:
            return
        if action == 'tm.profile.manager' or (action == 'tm.profile.save' and 'manager_id' in d):
            old = self.person(d.get('staff_id'))
            if ((old and old['org_level']) or self.level(d.get('manager_id')) or self.level((old or {}).get('manager_id'))) and \
                    str(d.get('manager_id') or '') != str((old or {}).get('manager_id') or ''):
                fail(_message('Use Organizational Structure with an impact preview to change governed reporting relationships.'), 403)
        target = None
        deactivating = d.get('active') is False or d.get('active') == 0
        if action == 'admin.user.disable' or (action == 'admin.user.save' and deactivating):
            target = User.objects.filter(id=d.get('id')).values_list('staff_id', flat=True).first()
        elif action == 'tm.profile.save' and deactivating:
            target = d.get('staff_id')
        if target:
            if Profile.objects.filter(manager_id=target, org_level__isnull=False, active=True).exists():
                fail(_message('Reassign active reporting employees before deactivating their manager.'), 409)
            level1 = [s for s in Profile.objects.filter(org_level_id=1).values_list('staff_id', flat=True) if self.active(s)]
            if self.is_level1(target) and len(level1) == 1:
                fail(_message('Keep at least one active Level 1 organization administrator.'), 409)
            if self.affected([target])['workspaces']:
                fail(_message('Review this employee’s dependent organizational workspaces and assign valid replacements before deactivation.'), 409)

    def after_command(self, action, d, actor):
        if self.settings()['enabled'] and action in ('admin.user.disable', 'admin.user.save', 'tm.profile.save'):
            self.invalidate()
            self.reconcile(actor, _message('Employee account/profile changed'))
            self.bump()

    # ------------------------------------------------------------ member removal
    def can_remove_members(self, actor, w):
        return (bool(w) and not w['deleted_at'] and self.active(actor) and self.can_view_workspace(actor, w) and
                (w['owner_id'] == actor or (self.creator(actor, w) and self.can_manage_workspace(actor, w))
                 or self.governs(actor, w) or self.workspace_override(actor, w)))

    def remove_member(self, d, actor):
        w = self.ws(d.get('workspace_id'))
        target = text(d.get('beneficiary_id'), _message('Employee'), 60, True)
        self.expected(d)
        if not self.can_view_workspace(actor, w):
            fail(_message('Workspace not found.'), 404)
        if not self.can_remove_members(actor, w):
            fail(_message('Only an authorized workspace owner or governing manager can remove members.'), 403)
        if target == w['owner_id']:
            fail(_message('Assign a valid replacement owner before removing the owner’s membership.'), 409)
        old = row(WorkspaceMember.objects.filter(workspace_id=w['id'], staff_id=target).first())
        if not old:
            return {'id': w['id'], 'type': 'tm_workspace', 'unchanged': True, 'message': _message('Membership already removed.')}
        reason = self.require_reason(d)
        WorkspaceMember.objects.filter(workspace_id=w['id'], staff_id=target).delete()
        self.invalidate()
        old.pop('id', None)
        self.audit(actor, 'membership.revoked', employee=target, workspace=w['id'], before=old, reason=reason)
        self.bump()
        return {'id': w['id'], 'type': 'tm_workspace', 'message': _message('Member removed. Tasks, history and independently authorized participation are retained.')}

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
                'personal': is_personal_workspace(w),
                # Responsible managers: shown to the people who can open the workspace; changed by its managers.
                'manager_ids': self.stored_scope(w),
                'can_set_managers': not w['deleted_at'] and not is_personal_workspace(w) and self.can_manage_workspace(staff, w),
                'can_make_public': not w['deleted_at'] and is_personal_workspace(w) and w['kind'] == 'PERSONAL' and w['owner_id'] == staff,
                'manager_options': ([{'id': m, 'name': (self.person(m) or {}).get('name') or m} for m in self.responsible_options(w['owner_id'])]
                                    if not w['deleted_at'] and (self.can_manage_workspace(staff, w)) else [])}

    def workspace_dashboard(self, actor, state):
        if not self.active(actor):
            return {'has_management': False, 'people': [], 'my': [], 'managed': [], 'shared': []}
        managed_people = [p for p in self.tree()['rows'] if p['staff_id'] != actor and p['org_level'] and self.active(p['staff_id'])
                          and (self.global_workspaces(actor) or p['staff_id'] in self.descendants(actor) or p['staff_id'] in self.all_reports(actor))]
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
            management = (not w['deleted_at'] and not is_personal_workspace(w) and w['owner_id'] != actor
                          and (w['owner_id'] in scope or self.workspace_reason(actor, w) == 'team'))
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
        return (self.global_workspaces(actor) or actor == target or self.in_branch(actor, target) or self.in_branch(target, actor)
                or target in self.all_reports(actor) or actor in self.all_reports(target))

    def management_people(self, actor):
        """Under My Management: the active employees below this person on any reporting line (everyone for authorized
        Administration), with their configured organizational title. Listing someone grants nothing: each screen still
        shows only the records this person may already see."""
        if not self.active(actor):
            return []
        self.preload_people()
        levels = dict(OrgLevel.objects.values_list('id', 'name'))
        below = set(self.all_reports(actor)) | set(self.descendants(actor))
        if self.global_workspaces(actor):
            below = {s for s in self.tree()['parents']} - {actor}
        out = []
        for s in below:
            p = self.person(s)
            if not p or not self.active(s):
                continue
            out.append({'staff_id': s, 'name': p['name'], 'org_level': p['org_level'],
                        'title': levels.get(p['org_level']) or _message('Not mapped in Organizational Structure'),
                        'direct': s in self.tree()['children'].get(actor, []) or actor in self.additional_managers(s)})
        return sorted(out, key=lambda x: (x['org_level'] or 1001, x['name'].lower()))

    def workspace_setup(self, actor):
        """What the workspace form offers this person: their responsible-manager choices and, for an Organizational
        workspace they own, the employees of their approved branch they may add directly."""
        if not self.active(actor):
            return {'managers': [], 'primary_manager_id': None, 'subordinates': []}
        levels = dict(OrgLevel.objects.values_list('id', 'name'))
        managers = [{'id': m, 'name': (self.person(m) or {}).get('name') or m, 'title': levels.get(self.level(m)) or '',
                     'direct': m in self.managers_of(actor)} for m in self.responsible_options(actor)]
        g = self.governor(actor)
        caps = any({'membership_request', 'workspace_manage', 'workspace_create'} <= set(parse(x['capabilities_json'], []))
                   for x in self.grants(actor))
        subordinates = []
        if g and (self.governor(actor) == actor or self.is_level1(actor) or caps):
            for s in self.descendants(actor):
                if self.active(s) and self.level(s) and self.governor(s) == g:
                    subordinates.append({'id': s, 'name': (self.person(s) or {}).get('name') or s})
        return {'managers': managers, 'primary_manager_id': self.tree()['parents'].get(actor), 'subordinates': subordinates}

    def _direct_reports(self, actor, target):
        return [self.person(s) for s in Profile.objects.filter(manager_id=target).values_list('staff_id', flat=True)
                if self.visible_employee(actor, s)]

    def employee(self, actor, target):
        if not self.visible_employee(actor, target):
            fail(_message('Employee not found.'), 404)
        p = self.person(target)
        if not p:
            fail(_message('Employee not found.'), 404)
        lines = [m for m in self.additional_managers(target) if self.visible_employee(actor, m)]
        if not self.can_manage_structure(actor):
            return {**p, 'active': 1 if self.active(target) else 0, 'actions': {}, 'direct_reports': self._direct_reports(actor, target),
                    'additional_manager_ids': lines, 'memberships': [], 'owned': [], 'grants': []}
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
                'additional_manager_ids': lines, 'direct_reports': self._direct_reports(actor, target), 'memberships': memberships,
                'owned': owned, 'grants': grants}

    def directory(self, actor, manage):
        self.preload_people()
        profiles = {p.staff_id: p for p in Profile.objects.all()}
        out = []
        for u in User.objects.filter(active=True, staff__active=True).select_related('staff').order_by('staff__name'):
            p = profiles.get(u.staff_id)
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
            fail(_message('Organizational Structure View permission is required.'), 403)
        view = p.get('view')
        if not self.can_manage_structure(actor) and view and view not in ('people', 'employee'):
            fail(_message('Organizational Structure View is read-only. Create permission is required for management views.'), 403)
        page = integer(p.get('page') or 1, 1, 100000, _message('page'))
        limit = integer(p.get('limit') or 50, 1, 200, _message('page size'))
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
                           'additional_manager_ids': [m for m in self.additional_managers(r['staff_id']) if m in permitted],
                           'titles': uniq([g['title'] for g in titles if g['beneficiary_id'] == r['staff_id']]),
                           'workspaces': [{'id': w['id'], 'name': w['name']} for w in owned if w['owner_id'] == r['staff_id']]}
                          for r in result['rows']]
        return result

    # ------------------------------------------------------------ org.* commands
    def handle(self, action, d, actor):
        self.require_active(actor)
        if action == 'org.initialize':
            if self.settings()['enabled']:
                fail(_message('Organizational Structure is already initialized.'), 409)
            if not self.legacy_admin(actor):
                fail(_message('An existing company Administrator must initialize organization governance.'), 403)
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
            return {'type': 'org_structure', 'message': _message('Organization governance initialized. Review unmapped employees and legacy workspaces before cutover.')}
        if action == 'org.level.save':
            self.require_admin(actor)
            self.expected(d)
            key = integer(d.get('level'), 1, 1000, _message('level'))
            old = row(OrgLevel.objects.filter(id=key).first())
            name = text(d.get('name'), _message('Level name'), 100, True)
            if old:
                OrgLevel.objects.filter(id=key).update(name=name, version=old['version'] + 1)
            else:
                OrgLevel.objects.create(id=key, name=name)
            self.audit(actor, 'level.configured', before=old, after={'id': key, 'name': name}, reason=d.get('reason') or '')
            self.bump()
            return {'type': 'org_structure', 'message': _message('Level label saved. A label does not grant capabilities.')}
        if action == 'org.template.save':
            self.require_admin(actor)
            self.expected(d)
            old = row(OrgTemplate.objects.filter(id=d['id']).first()) if d.get('id') else None
            if d.get('id') and not old:
                fail(_message('Template not found.'), 404)
            key = d.get('id') or next_id('org-template', 'TITLE')
            values = {'name': text(d.get('name'), _message('Title'), 100, True), 'capabilities_json': jtext(self.capabilities(d.get('capabilities'))),
                      'active': 0 if d.get('active') is False or d.get('active') == 0 else 1, 'version': old['version'] + 1 if old else 0}
            if old:
                OrgTemplate.objects.filter(id=key).update(**{**values, 'active': bool(values['active'])})
            else:
                OrgTemplate.objects.create(id=key, **{**values, 'active': bool(values['active'])})
            self.audit(actor, 'template.configured', before=old, after=values, reason=d.get('reason') or '')
            self.bump()
            return {'id': key, 'type': 'org_template', 'message': _message('Template saved. Existing approved grants retain their explicit capabilities.')}
        if action == 'org.preview':
            if d.get('workspace_id'):
                w = self.ws(d['workspace_id'])
                if w['kind'] != 'ORGANIZATIONAL' or not self.can_manage_workspace(actor, w):
                    fail(_message('Workspace not found.'), 404)
                return {'type': 'org_preview', 'revision': self.settings()['revision'], 'message': _message('Review workspace responsibility, members and pending approvals.'),
                        'impact': {'employees': [w['owner_id'], w['governing_manager_id']], 'workspaces': [w],
                                   'grants': [w['owner_grant_id']] if w['owner_grant_id'] else [],
                                   'memberships': [{'staff_id': s, 'workspace_id': w['id']} for s in WorkspaceMember.objects.filter(workspace_id=w['id']).values_list('staff_id', flat=True)],
                                   'requests': [{'id': i, 'kind': k} for i, k in OrgRequest.objects.filter(workspace_id=w['id'], status__in=['PENDING', 'REVIEW']).values_list('id', 'kind')]}}
            targets = [] if d.get('grant_id') else [x['staff_id'] for x in self.structure_changes(d)]
            for x in targets:
                if (not self.is_level1(actor) and x != actor and (not self.in_branch(actor, x) or
                                                                   (self.governor(actor) != actor and not self.has_capability(actor, 'structure_request')))):
                    fail(_message('This branch is outside your scope.'), 403)
            if d.get('grant_id'):
                g = self.grant_row(d['grant_id'])
                if not g or (not self.is_level1(actor) and g['governing_manager_id'] != actor):
                    fail(_message('Grant not found.'), 404)
            return {'type': 'org_preview', 'revision': self.settings()['revision'],
                    'impact': self.visible_impact(actor, self.affected(targets, d.get('grant_id'))),
                    'message': _message('Review affected employees, workspaces, grants and requests. Memberships remain unless explicitly revoked.')}
        if action == 'org.structure.save':
            return self.save_structure(d, actor)
        if action == 'org.structure.request':
            changes = self.structure_changes(d)
            self.expected(d)
            if not all(x['staff_id'] == actor or self.in_branch(actor, x['staff_id']) for x in changes):
                fail(_message('You can request changes only for yourself or your approved reporting branch.'), 403)
            if any(x['staff_id'] != actor for x in changes) and not self.has_capability(actor, 'structure_request'):
                fail(_message('A structural-request capability is required.'), 403)
            if not self.is_level1(actor) and self.governor(actor) != actor and any((x['level'] or 0) < 3 for x in changes):
                fail(_message('Lower levels cannot request appointment to Level 1 or Level 2.'), 403)
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
                fail(_message('Grant not found.'), 404)
            if not self.is_level1(actor) and g['governing_manager_id'] != actor:
                fail(_message('Only the governing manager or Level 1 can revoke authority.'), 403)
            self.expected(d)
            if not d.get('acknowledged'):
                fail(_message('Review the impact before revoking authority.'), 422)
            if g['status'] == 'REVOKED':
                return {'unchanged': True, 'message': _message('Grant already revoked.')}
            impact = self.affected([], g['id'])
            OrgGrant.objects.filter(id=g['id']).update(status='REVOKED', version=g['version'] + 1, updated_at=now())
            self.invalidate()
            self.replacement_workspaces(d, actor, None, impact)
            reason = self.require_reason(d)
            self.reconcile(actor, reason)
            self.audit(actor, 'delegation.revoked', employee=g['beneficiary_id'], workspace=g['workspace_id'], before=g,
                       after={'status': 'REVOKED'}, reason=d.get('reason'))
            self.bump()
            return {'id': g['id'], 'type': 'org_grant', 'message': _message('Authority revoked. Dependent grants were re-evaluated and invalid grants suspended.')}
        if action == 'org.request.decide':
            return self.decide(d, actor)
        if action == 'org.request.cancel':
            q = row(OrgRequest.objects.filter(id=d.get('id')).first()) if isinstance(d.get('id'), str) else None
            if not q or q['requester_id'] != actor:
                fail(_message('Request not found.'), 404)
            if q['status'] == 'CANCELLED':
                return {'unchanged': True, 'message': _message('Already cancelled.')}
            if q['status'] not in ('PENDING', 'REVIEW'):
                fail(_message('This request has already been decided.'), 409)
            OrgRequest.objects.filter(id=q['id']).update(status='CANCELLED', version=q['version'] + 1, updated_at=now())
            self.audit(actor, 'request.cancelled', employee=q['beneficiary_id'], workspace=q['workspace_id'],
                       before={'status': q['status']}, after={'status': 'CANCELLED'}, approval=q['id'])
            self.bump()
            return {'id': q['id'], 'type': 'org_request', 'message': _message('Request cancelled.')}
        fail(_message('Unknown organization action.'), 404)


class _NotSet:
    """V5.7.7 returns `undefined` from some authority checks to mean "use the legacy (non-governed) rule"."""

    def __bool__(self):
        return False

    def __repr__(self):
        return 'NOTSET'


NOTSET = _NotSet()

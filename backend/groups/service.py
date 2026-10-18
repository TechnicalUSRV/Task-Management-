"""Task Management · Groups — the server rules of task-groups.mjs (V5.7.7), on the Django models.

Every change is checked here (access to the group, role permissions, values, formulas, versions) whatever screen or
request it came from. A Group's rows are its own records: choosing people or a status never creates tasks or starts task
workflows. A group someone may not open is answered as "not found", so its existence is not revealed.

Commands arrive through compat.commands.run (one transaction under the write lock, as V5.7.7's BEGIN IMMEDIATE); reads
(GET /api/tasks/group…) never change anything except the activity entry an Excel export writes, as in V5.7.7.
"""
import base64
import hashlib
import re
from datetime import datetime, timedelta
from functools import cmp_to_key
from zoneinfo import ZoneInfo

from django.db import connection
from django.db.models import Count, F, Max, Sum
from django.db.models.functions import Length
from django.utils import timezone

from accounts.models import Role, User
from audit.models import ActivityEvent
from core.errors import fail
from core.models import Staff
from core.rows import insert, row, update
from core.services import next_id
from core.validation import choice, integer, iso, text
from organization.models import Profile
from tasks import domain as task_domain
from tasks.filecheck import clean_file_name, content_matches
from workspaces.models import Workspace

from . import domain as dm
from . import js
from .models import (Board, BoardAccess, BoardColumn, BoardColumnAccess, BoardFile, BoardImport, BoardNote, BoardNoteRevision, BoardRow,
                     BoardRowAccess, BoardView)

L = dm.GROUP_LIMITS
TYPES = list(dm.COLUMN_TYPES)
BOARD_FIELDS = ('id', 'workspace_id', 'name', 'description', 'visibility', 'audience', 'workspace_level', 'owner_id', 'status', 'archived_at',
                'archived_by', 'version', 'created_by', 'created_at', 'updated_at')


def fail_with(message, status, details=None):
    fail(message, status, details)


def is_int(v):
    """Number.isInteger(v) for JSON values."""
    return js.is_number(v) and float(v).is_integer()


def nocase(name):
    """SQLite COLLATE NOCASE: ASCII letters compare without case."""
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in name or '')


def plural(n, one, many=None):
    return one if n == 1 else (many or one + 's')


def sql(query, *args):
    with connection.cursor() as c:
        c.execute(query, args)
        names = [col[0] for col in c.description]
        return [dict(zip(names, r)) for r in c.fetchall()]


def _start_of_day(day, zone):
    y, m, d = (int(x) for x in day.split('-'))
    return datetime(y, m, d, tzinfo=ZoneInfo(zone)).astimezone(ZoneInfo('UTC'))


def _next_day(day):
    y, m, d = (int(x) for x in day.split('-'))
    return (datetime(y, m, d) + timedelta(days=1)).strftime('%Y-%m-%d')


# A collator for sorting text as V5.7.7's Intl.Collator(undefined, {numeric: true, sensitivity: 'base'}) does: numbers in
# text by value, letters without case or accents.
def _collation_key(s):
    import unicodedata
    out = []
    for part in re.findall(r'[0-9]+|[^0-9]', s):
        if part.isdigit():
            out.append((1, int(part), ''))
            continue
        base = ''.join(ch for ch in unicodedata.normalize('NFD', part) if not ('̀' <= ch <= 'ͯ')).casefold()
        out.append((0 if not base.isalnum() else 2, 0, base))
    return out


def _collate(a, b):
    ka, kb = _collation_key(a), _collation_key(b)
    return (ka > kb) - (ka < kb)


class GroupService:
    def __init__(self, tasks):
        """tasks: a tasks.services.TaskService (its governance, names, membership, versions and activity log)."""
        self.tasks = tasks
        self.gov = tasks.gov
        self._names = {}
        from .imports import GroupImport
        self.imports = GroupImport(self)

    def remember_lookups(self):
        """For one read-only pass (building the state): someone's permissions, role, workspace memberships and each
        workspace's status are read once instead of once per group. Never used while a command is changing data."""
        can, role_of, ws_active, is_member = self.can, self.role_of, self.ws_active, self.is_member
        memo = {}

        def once(key, read):
            if key not in memo:
                memo[key] = read()
            return memo[key]
        self.can = lambda staff, action: once(('can', staff, action), lambda: can(staff, action))
        self.role_of = lambda staff: once(('role', staff), lambda: role_of(staff))
        self.ws_active = lambda b: once(('ws', b['workspace_id']), lambda: ws_active(b))
        self.is_member = lambda wid, staff: once(('member', wid, staff), lambda: is_member(wid, staff))
        return self

    # ------------------------------------------------------------ small helpers
    def can(self, staff, action):
        return bool(self.gov.can_staff(staff, 'tasks.groups', action))

    def admin(self, staff):
        return self.can(staff, 'approve')

    def name_of(self, staff):
        if staff not in self._names:
            self._names[staff] = self.tasks.name_of(staff)
        return self._names[staff]

    def is_member(self, wid, staff):
        return self.tasks.is_member(wid, staff)

    @staticmethod
    def now():
        return timezone.now()

    @staticmethod
    def board_row(key):
        b = Board.objects.filter(id=key).first()
        return row(b) if b else None

    @staticmethod
    def columns_of(board_id):
        return [{**row(c), 'settings': js.loads(c.settings_json, {})} for c in BoardColumn.objects.filter(board_id=board_id).order_by('position', 'id')]

    @staticmethod
    def rows_of(board_id):
        return [{**row(r), 'values': js.loads(r.values_json, {})} for r in BoardRow.objects.filter(board_id=board_id).order_by('position', 'id')]

    def admin_for(self, b, staff):
        context = self.gov.group_context(staff, b)
        return context['admin'] if context is not None else self.admin(staff)

    def level_for(self, b, staff):
        context = self.gov.group_context(staff, b)
        if context is not None and context['allowed'] is False:
            return 0
        named = BoardAccess.objects.filter(board_id=b['id'], staff_id=staff).values_list('level', flat=True).first()
        board = {**b, 'workspace_level': 'VIEW'} if context and context.get('viewer') else b
        return dm.group_level(board, staff, member=self.is_member(b['workspace_id'], staff), level=named, admin=self.admin_for(b, staff))

    @staticmethod
    def ws_active(b):
        return Workspace.objects.filter(id=b['workspace_id']).values_list('status', flat=True).first() == 'ACTIVE'

    def caps_for(self, b, staff):
        ws_archived = not self.ws_active(b)
        return dm.group_caps(self.level_for(b, staff), lambda a: self.can(staff, a), admin=self.admin_for(b, staff) and b['visibility'] == 'TEAM',
                             owner=b['owner_id'] == staff, archived=b['status'] == 'ARCHIVED' or ws_archived, ws_archived=ws_archived)

    def open_board(self, key, staff):
        b = self.board_row(text(key, 'Group', 60, True))
        if not b:
            fail('Group not found.', 404)
        caps = self.caps_for(b, staff)
        if not caps['view']:
            fail('Group not found.', 404)
        return b, caps

    @staticmethod
    def need(caps, cap, message):
        if not caps[cap]:
            fail(message, 403)

    # ------------------------------------------------------------ who sees which rows and columns
    @staticmethod
    def role_of(staff):
        return User.objects.filter(staff_id=staff, active=True).values_list('role_id', flat=True).first()

    @staticmethod
    def rules_of(board_id):
        rows, cols = {}, {}
        for r in BoardRowAccess.objects.filter(board_id=board_id).order_by('id').values('row_id', 'principal_type', 'principal_id'):
            rows.setdefault(r['row_id'], []).append({'type': r['principal_type'], 'id': r['principal_id']})
        for r in BoardColumnAccess.objects.filter(board_id=board_id).order_by('id').values('column_id', 'principal_type', 'principal_id'):
            cols.setdefault(r['column_id'], []).append({'type': r['principal_type'], 'id': r['principal_id']})
        return {'rows': rows, 'cols': cols}

    def sight(self, b, staff, caps, columns=None):
        columns = self.columns_of(b['id']) if columns is None else columns
        rules, see_all, role = self.rules_of(b['id']), bool(caps.get('seeAll')), self.role_of(staff)
        visible = columns if see_all else dm.visible_columns(columns, lambda c: dm.rule_allows(rules['cols'].get(c['id']), staff, role))
        ids = {c['id'] for c in visible}
        return {'rules': rules, 'seeAll': see_all, 'role': role, 'columns': visible, 'colIds': ids, 'all': columns,
                'rowOk': lambda row_id: see_all or dm.rule_allows(rules['rows'].get(row_id), staff, role),
                'restricted': bool(rules['rows']) or bool(rules['cols']), 'hiddenColumns': len(columns) - len(visible)}

    def archived_check(self, b):
        if b['status'] == 'ARCHIVED':
            fail('This group is archived. Restore it before changing it.', 409)
        if not self.ws_active(b):
            fail('This group’s workspace is archived. Restore the workspace before changing its groups.', 409)

    def workspace_access(self, w, staff):
        """Workspaces where someone may create groups: the ones they belong to or own (governed workspaces follow the
        organization's rules); group administrators (Groups · Approve) may create groups in any active workspace."""
        if self.gov.governed(w):
            return self.gov.can_create_resource(staff, w)
        return self.is_member(w['id'], staff) or w['owner_id'] == staff or self.admin(staff)

    def eligible(self, b):
        """People who may be chosen in In Charge and Support cells: active members of the group's workspace (and its owner)
        who can use Task Management. A Team group shared with selected people narrows this to them."""
        found = sql("SELECT l.id,l.name,COALESCE(p.department,'') AS department,COALESCE(p.position,'') AS position,u.id AS account "
                    "FROM staff l LEFT JOIN tm_profiles p ON p.staff_id=l.id LEFT JOIN access_users u ON u.staff_id=l.id "
                    "WHERE l.active=%s AND COALESCE(p.active,%s)=%s AND (u.id IS NULL OR u.active=%s) "
                    "AND (l.id=%s OR EXISTS(SELECT 1 FROM tm_members m WHERE m.workspace_id=%s AND m.staff_id=l.id))",
                    True, True, True, True, b['owner_id'], b['workspace_id'])
        found.sort(key=lambda p: nocase(p['name']))
        found = [p for p in found if not p['account'] or self.gov.can_staff(p['id'], 'tasks.tasks', 'view')]
        allowed = None
        if b['visibility'] == 'TEAM' and b['audience'] == 'SELECTED':
            allowed = {b['owner_id'], *BoardAccess.objects.filter(board_id=b['id']).values_list('staff_id', flat=True)}
        return [{'id': p['id'], 'name': p['name'], 'department': p['department'], 'position': p['position']}
                for p in found if allowed is None or p['id'] in allowed]

    def eligible_set(self, b):
        return {p['id'] for p in self.eligible(b)}

    def touch(self, b):
        Board.objects.filter(id=b['id']).update(updated_at=self.now())

    def record(self, actor, b, action, detail=''):
        self.tasks.log(actor, 'group', b['id'], b['workspace_id'], action, f"{b['name']}{' · ' + detail if detail else ''}")

    # ------------------------------------------------------------ the group itself
    def shared_input(self, value, w, owner):
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > L['shared']:
            fail(f"Share with up to {L['shared']} people.")
        out = {}
        for x in value:
            staff = x if isinstance(x, str) else x.get('staff_id') if isinstance(x, dict) else None
            level = 'EDIT' if isinstance(x, str) else ((x.get('level') if isinstance(x, dict) else None) or 'EDIT')
            if not isinstance(staff, str) or not staff:
                fail('Choose the people to share with.')
            choice(level, ['VIEW', 'EDIT', 'MANAGE'], 'access level')
            if staff == owner:
                continue
            p = sql("SELECT l.id,l.name FROM staff l LEFT JOIN tm_profiles p ON p.staff_id=l.id LEFT JOIN access_users u ON u.staff_id=l.id "
                    "WHERE l.id=%s AND l.active=%s AND COALESCE(p.active,%s)=%s AND (u.id IS NULL OR u.active=%s)", staff, True, True, True, True)
            if not p:
                fail('Share only with active team members.')
            if not self.is_member(w['id'], staff):
                fail(f"{p[0]['name']} isn’t a member of this workspace. Add them to the workspace first.")
            out[staff] = level
        return [{'staff_id': s, 'level': lv} for s, lv in out.items()]

    @staticmethod
    def access_of(board_id):
        return [{'staff_id': s, 'level': lv} for s, lv in BoardAccess.objects.filter(board_id=board_id).order_by('staff_id').values_list('staff_id', 'level')]

    def save_board(self, d, actor):
        old = self.open_board(d['id'], actor) if d.get('id') else None
        if old:
            self.tasks.check_version(old[0], d.get('expected_version'))
        b0 = old[0] if old else None
        w = self.tasks.workspace(b0['workspace_id'] if b0 else d.get('workspace_id'))
        if w['status'] != 'ACTIVE':
            fail('Restore the workspace before changing its groups.')
        if not old:
            if not self.can(actor, 'create'):
                fail('Your role can’t create groups.', 403)
            if not self.workspace_access(w, actor):
                fail('Join this workspace before creating a group in it.', 403)
            if Board.objects.filter(workspace_id=w['id']).count() >= L['groups']:
                fail(f"This workspace already has {L['groups']} groups, the most it can hold. Delete archived groups that are no longer needed.", 409)
        else:
            self.archived_check(b0)

        def given(key, fallback):
            return d[key] if d.get(key) is not None else fallback
        name = text(given('name', b0['name'] if b0 else None), 'Group name', L['name'], True)
        description = text(given('description', b0['description'] if b0 else ''), 'Description', L['description'])
        visibility = choice(given('visibility', b0['visibility'] if b0 else 'PERSONAL'), ['PERSONAL', 'TEAM'], 'visibility')
        audience = choice(given('audience', b0['audience'] if b0 else 'SELECTED'), ['WORKSPACE', 'SELECTED'], 'sharing option') if visibility == 'TEAM' else 'SELECTED'
        workspace_level = choice(given('workspace_level', b0['workspace_level'] if b0 else 'EDIT'), ['VIEW', 'EDIT'], 'workspace access level')
        owner = b0['owner_id'] if b0 else actor
        if visibility == 'TEAM':
            shared = ([{'staff_id': s, 'level': lv} for s, lv in BoardAccess.objects.filter(board_id=b0['id']).order_by('id').values_list('staff_id', 'level')]
                      if 'shared' not in d and old else self.shared_input(d.get('shared'), w, owner))
        else:
            shared = []
        at = self.now()
        if old:
            caps, before = old[1], self.access_of(b0['id'])
            renamed = name != b0['name'] or description != b0['description']
            sharing = (audience != b0['audience'] or workspace_level != b0['workspace_level']
                       or not js.same(before, sorted(shared, key=lambda x: x['staff_id'])))
            if renamed:
                self.need(caps, 'rename', 'You can’t rename this group. Ask its owner for “Can manage” access.')
            if visibility != b0['visibility']:
                self.need(caps, 'visibility', 'Only the group’s owner can change whether it is personal or shared.')
            if sharing and visibility == 'TEAM':
                self.need(caps, 'share', 'You can’t change who can open this group. Ask its owner for “Can manage” access.')
            if not renamed and not sharing and visibility == b0['visibility']:
                return {'id': b0['id'], 'type': 'tm_group', 'message': 'Nothing was changed.', 'unchanged': True}
            update(Board, b0['id'], {'name': name, 'description': description, 'visibility': visibility, 'audience': audience,
                                     'workspace_level': workspace_level, 'version': b0['version'] + 1, 'updated_at': at})
            BoardAccess.objects.filter(board_id=b0['id']).delete()
            for s in shared:
                BoardAccess.objects.create(board_id=b0['id'], staff_id=s['staff_id'], level=s['level'])
            nxt = {**b0, 'name': name}
            if renamed:
                self.record(actor, nxt, 'Group renamed', f"was {b0['name']}" if name != b0['name'] else 'description changed')
            if visibility != b0['visibility'] or sharing:
                if visibility == 'PERSONAL':
                    how = 'personal'
                elif audience == 'WORKSPACE':
                    how = f"whole workspace · {dm.LEVEL_LABELS[workspace_level].lower()}{f' · {len(shared)} named' if shared else ''}"
                else:
                    how = f"{len(shared)} {plural(len(shared), 'person', 'people')}"
                self.record(actor, nxt, 'Group sharing changed', how)
            return {'id': b0['id'], 'type': 'tm_group', 'message': 'Group saved.'}
        key = next_id('tm-board', 'GRP')
        insert(Board, {'id': key, 'workspace_id': w['id'], 'name': name, 'description': description, 'visibility': visibility, 'audience': audience,
                       'workspace_level': workspace_level, 'owner_id': owner, 'status': 'ACTIVE', 'archived_at': None, 'archived_by': None,
                       'version': 0, 'created_by': actor, 'created_at': at, 'updated_at': at, 'layout_json': '{}'})
        for s in shared:
            BoardAccess.objects.create(board_id=key, staff_id=s['staff_id'], level=s['level'])
        # A new group starts with one text column, “Item”, which can be renamed or removed like any other.
        insert(BoardColumn, {'id': next_id('tm-board-col', 'COL'), 'board_id': key, 'name': 'Item', 'name_key': dm.name_key('Item'), 'type': 'TEXT',
                             'position': 1, 'settings_json': '{}', 'version': 0, 'created_at': at, 'updated_at': at})
        self.record(actor, {'id': key, 'workspace_id': w['id'], 'name': name}, 'Group created', 'personal' if visibility == 'PERSONAL' else 'team')
        return {'id': key, 'type': 'tm_group', 'message': 'Group created.'}

    def archive_board(self, d, actor):
        b, caps = self.open_board(d.get('id'), actor)
        self.tasks.check_version(b, d.get('expected_version'))
        status = choice(d.get('status'), ['ACTIVE', 'ARCHIVED'], 'group status')
        if not self.ws_active(b):
            fail('This group’s workspace is archived. Restore the workspace before archiving, restoring or deleting its groups.', 409)
        self.need(caps, 'archive', 'Only the group’s owner (or a group administrator) can archive or restore it.')
        if b['status'] == status:
            return {'id': b['id'], 'type': 'tm_group', 'message': 'Already archived.' if status == 'ARCHIVED' else 'Already active.', 'unchanged': True}
        archived = status == 'ARCHIVED'
        update(Board, b['id'], {'status': status, 'archived_at': self.now() if archived else None, 'archived_by': actor if archived else None,
                                'version': b['version'] + 1, 'updated_at': self.now()})
        self.record(actor, b, 'Group archived' if archived else 'Group restored')
        return {'id': b['id'], 'type': 'tm_group',
                'message': 'Group archived. Its rows and columns are kept; restore it to use it again.' if archived else 'Group restored.'}

    def delete_board(self, d, actor):
        b, caps = self.open_board(d.get('id'), actor)
        self.tasks.check_version(b, d.get('expected_version'))
        if not self.ws_active(b):
            fail('This group’s workspace is archived. Restore the workspace before archiving, restoring or deleting its groups.', 409)
        self.need(caps, 'archive', 'Only the group’s owner (or a group administrator) can delete it.')
        if b['status'] != 'ARCHIVED':
            fail('Archive the group first. Only archived groups can be deleted permanently.', 409)
        if d.get('confirm') is not True:
            fail('Confirm that the group, all its columns and all its rows are deleted permanently.', 409)
        rows, cols = BoardRow.objects.filter(board_id=b['id']).count(), BoardColumn.objects.filter(board_id=b['id']).count()
        # Everything that belongs to the group goes with it (rows, columns and, through them, notes, files, access rules,
        # layouts and imports), as V5.7.7's ON DELETE CASCADE does.
        Board.objects.filter(id=b['id']).delete()
        self.record(actor, b, 'Group deleted permanently', f"{cols} {plural(cols, 'column')} · {rows} {plural(rows, 'row')}")
        return {'id': b['id'], 'type': 'tm_group', 'message': f"Group deleted with its {cols} {plural(cols, 'column')} and {rows} {plural(rows, 'row')}."}

    # ------------------------------------------------------------ columns
    @staticmethod
    def clean_labels(value, old=()):
        if not isinstance(value, list) or not value:
            fail('Add at least one status label.')
        if len(value) > L['labels']:
            fail(f"Use up to {L['labels']} labels.")
        numbers = [int(m.group(1)) for m in (re.match(r'^L([0-9]+)$', str(o.get('id', ''))) for o in old) if m]
        nxt = max([0, *numbers]) + 1
        seen, ids, out = set(), set(), []
        for item in value:
            item = item if isinstance(item, dict) else {}
            name = dm.clean_name(item.get('name'))
            if not name:
                fail('Give every label a name.')
            if js.length(name) > L['label']:
                fail(f"Use at most {L['label']} characters for a label.")
            if dm.name_key(name) in seen:
                fail(f'Two labels are named “{name}”. Use a different name for each.')
            seen.add(dm.name_key(name))
            label_id = item.get('id')
            if isinstance(label_id, str) and label_id:
                if label_id in ids:
                    fail('Each label can be listed only once. Reload the group and try again.')
                ids.add(label_id)
            keep = isinstance(label_id, str) and bool(label_id) and any(o.get('id') == label_id for o in old)
            color = item.get('color')
            out.append({'id': label_id if keep else f'L{nxt}', 'name': name, 'color': color if isinstance(color, str) and color in dm.STATUS_COLORS else 'GRAY'})
            if not keep:
                nxt += 1
        return out

    @staticmethod
    def decimals_input(v):
        return None if v is None or v == '' else integer(v, 0, 6, 'number of decimal places (0–6)')

    def column_save(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'structure', 'You can’t change this group’s columns. Ask its owner for “Can manage” access.')
        columns = self.columns_of(b['id'])
        old = next((x for x in columns if x['id'] == d.get('id')), None) if d.get('id') else None
        if d.get('id') and not old:
            fail('Column not found. Reload the group.', 404)
        if old:
            self.tasks.check_version(old, d.get('expected_version'))
        if not old and len(columns) >= L['columns']:
            fail(f"A group can have up to {L['columns']} columns.")
        name = dm.clean_name(d['name'] if d.get('name') is not None else (old['name'] if old else None))
        error = dm.column_name_error(name, columns, old['id'] if old else None)
        if error:
            fail(error, 409)
        col_type = choice(d['type'] if d.get('type') is not None else (old['type'] if old else None), TYPES, 'column type')
        s = d['settings'] if isinstance(d.get('settings'), dict) else {}
        prev = old['settings'] if old else {}
        key, at, settings = old['id'] if old else next_id('tm-board-col', 'COL'), self.now(), {}
        if col_type in ('NUMBER', 'FORMULA'):
            settings['decimals'] = self.decimals_input(s['decimals'] if 'decimals' in s else prev.get('decimals'))
            from .presentation import number_settings
            settings.update(number_settings(s, prev))
        replacements = {}
        if col_type == 'STATUS':
            old_labels = dm.status_labels(old) if old and old['type'] == 'STATUS' else []
            if 'labels' in s:
                settings['labels'] = self.clean_labels(s['labels'], old_labels)
            else:
                settings['labels'] = old_labels if old_labels else self.clean_labels([{'name': n, 'color': c} for n, c in dm.DEFAULT_STATUS_LABELS])
            # Removing a label that rows use needs a replacement label, or an explicit choice to clear those cells.
            if old and old['type'] == 'STATUS':
                removed = [l for l in old_labels if not any(n['id'] == l.get('id') for n in settings['labels'])]
                given = d['label_replacements'] if isinstance(d.get('label_replacements'), dict) else {}
                rows = self.rows_of(b['id'])
                in_use = [{'id': l['id'], 'name': l['name'], 'count': sum(1 for r in rows if r['values'].get(old['id']) == l['id'])} for l in removed]
                in_use = [l for l in in_use if l['count']]
                missing = [l for l in in_use if l['id'] not in given]
                if missing:
                    fail_with('; '.join(f"“{l['name']}” is used in {l['count']} {plural(l['count'], 'row')}" for l in missing)
                              + '. Choose a replacement label, or confirm that those cells are cleared.', 409, {'code': 'labels_in_use', 'labels': missing})
                for l in in_use:
                    r = given[l['id']]
                    if r is not None and not any(n['id'] == r for n in settings['labels']):
                        fail('Choose a replacement from the remaining labels.')
                    replacements[l['id']] = r
        formula = None
        if col_type == 'FORMULA':
            expression = s['expression'] if s.get('expression') is not None else (
                dm.formula_display(prev.get('expression'), columns) if old and old['type'] == 'FORMULA' else '')
            formula = dm.compile_formula(expression, [*[x for x in columns if x['id'] != key], {'id': key, 'name': name, 'type': 'FORMULA', 'settings': {}}], key)
            if not formula['ok']:
                fail_with(formula['error'], 422, {'code': 'formula', 'error': formula['error']})
            settings['expression'] = formula['canonical']
        # A column that formulas use must stay a Number or Formula column until those formulas change.
        if old and old['type'] != col_type and col_type not in ('NUMBER', 'FORMULA'):
            deps = dm.formula_dependents(columns, old['id'])
            if deps:
                fail_with(f"{', '.join('“' + x['name'] + '”' for x in deps)} {'uses' if len(deps) == 1 else 'use'} this column in "
                          f"{'its formula' if len(deps) == 1 else 'their formulas'}. Change {'that formula' if len(deps) == 1 else 'those formulas'} first.",
                          409, {'code': 'dependents', 'columns': [{'id': x['id'], 'name': x['name']} for x in deps]})
        # Changing the type keeps every value that fits the new type; the rest are cleared only after the person confirms.
        writes = []
        if old and old['type'] != col_type:
            rows = self.rows_of(b['id'])
            computed = None
            if old['type'] == 'FORMULA':
                prepared = dm.prepare_formulas(columns)
                computed = {r['id']: dm.compute_row(r['values'], columns, prepared).get(old['id']) for r in rows}
            people = {dm.name_key(p['name']): p['id'] for p in self.eligible(b)}   # as new Map(): the last of equal names wins
            labels = settings.get('labels') or []
            if col_type == 'STATUS' and 'labels' not in s and old['type'] != 'STATUS':
                # Text (or other) values become labels of the same name.
                names = {}
                for r in rows:
                    n = dm.clean_name(dm.cell_text(old, computed.get(r['id']) if computed is not None else r['values'].get(old['id']), self.name_of))
                    if n and js.length(n) <= L['label'] and dm.name_key(n) not in names and len(names) < L['labels']:
                        names[dm.name_key(n)] = n
                if names:
                    colors = list(dm.STATUS_COLORS)
                    settings['labels'] = self.clean_labels([{'name': n, 'color': colors[i % 9]} for i, n in enumerate(names.values())])
                    labels = settings['labels']
            lost, examples = 0, []
            for r in rows:
                value = computed.get(r['id']) if computed is not None else r['values'].get(old['id'])
                # V5.6.9: files can't become another kind of value; changing an Attachment column's type removes them.
                if old['type'] == 'ATTACHMENT':
                    if not dm.empty_value(value):
                        lost += 1
                        if len(examples) < 3:
                            examples.append(dm.cell_text(old, value, self.name_of))
                        writes.append((r, None))
                    continue
                if col_type == 'FORMULA':
                    if not dm.empty_value(value) and old['type'] != 'FORMULA':
                        lost += 1
                        if len(examples) < 3:
                            examples.append(dm.cell_text(old, value, self.name_of))
                    if old['id'] in r['values']:
                        writes.append((r, None))
                    continue
                if computed is not None and isinstance(value, dict):
                    v = {'ok': False}
                else:
                    v = dm.convert_value(old, {'type': col_type, 'settings': settings}, value, labels=labels, name_of=self.name_of,
                                         person_by_name=lambda n: people.get(dm.name_key(n)))
                if not v['ok']:
                    lost += 1
                    if len(examples) < 3:
                        examples.append(dm.cell_text(old, value, self.name_of) or js.to_js_string(value))
                    writes.append((r, None))
                elif not js.same(v['value'], r['values'].get(old['id'])):
                    writes.append((r, v['value']))
            if lost and d.get('confirm_clear') is not True:
                shown = ', '.join('“' + js.to_js_string(x)[:30] + '”' for x in examples)
                fail_with(f"{lost} {'row has a value that' if lost == 1 else 'rows have values that'} can’t become {dm.COLUMN_TYPES[col_type]} "
                          f"({shown}{', …' if lost > len(examples) else ''}). Confirm to change the type and clear {'it' if lost == 1 else 'them'}.",
                          409, {'code': 'type_change', 'count': lost, 'examples': examples})
        values = {'board_id': b['id'], 'name': name, 'name_key': dm.name_key(name), 'type': col_type, 'settings_json': js.dumps(settings), 'updated_at': at}
        if old:
            update(BoardColumn, key, {**values, 'version': old['version'] + 1})
        else:
            # A new column goes at the end, or right after the column named in `after`.
            after = next((x for x in columns if x['id'] == d.get('after')), None) if d.get('after') else None
            position = after['position'] + 1 if after else (columns[-1]['position'] if columns else 0) + 1
            if after:
                BoardColumn.objects.filter(board_id=b['id'], position__gte=position).update(position=F('position') + 1)
            insert(BoardColumn, {'id': key, **values, 'position': position, 'version': 0, 'created_at': at})
        for r, v in writes:
            nxt = dict(r['values'])
            if v is None:
                nxt.pop(key, None)
            else:
                nxt[key] = v
            update(BoardRow, r['id'], {'values_json': js.dumps(nxt), 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': at})
        if old and old['type'] == 'ATTACHMENT' and col_type != 'ATTACHMENT':
            BoardFile.objects.filter(column_id=key).delete()
        if replacements:
            for r in self.rows_of(b['id']):
                v = r['values'].get(key)
                if isinstance(v, str) and v in replacements:
                    nxt = dict(r['values'])
                    if replacements[v] is None:
                        nxt.pop(key, None)
                    else:
                        nxt[key] = replacements[v]
                    update(BoardRow, r['id'], {'values_json': js.dumps(nxt), 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': at})
        self.touch(b)
        if not old:
            what = f"added {name} ({dm.COLUMN_TYPES[col_type]})"
        else:
            parts = [old['name'] != name and f"renamed {old['name']} → {name}",
                     old['type'] != col_type and f"{name}: {dm.COLUMN_TYPES[old['type']]} → {dm.COLUMN_TYPES[col_type]}",
                     col_type == 'FORMULA' and prev.get('expression') != settings.get('expression') and f"{name} formula {formula['display']}",
                     col_type == 'STATUS' and old['type'] == 'STATUS' and not js.same(prev.get('labels'), settings.get('labels')) and f'{name} labels',
                     col_type in ('NUMBER', 'FORMULA') and prev.get('decimals') != settings.get('decimals') and old['type'] == col_type and f'{name} decimals']
            what = ' · '.join(p for p in parts if p) or f'{name} settings'
        self.record(actor, b, 'Column changed' if old else 'Column added', what)
        return {'id': key, 'type': 'tm_group_column', 'message': 'Column saved.' if old else 'Column added.'}

    def column_move(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'structure', 'You can’t reorder this group’s columns. Ask its owner for “Can manage” access.')
        columns = self.columns_of(b['id'])
        order = d.get('order') if isinstance(d.get('order'), list) else None
        ids = [c['id'] for c in columns]
        if (not order or len(order) != len(columns) or len({js.dumps(x) for x in order}) != len(order) or any(x not in ids for x in order)):
            fail('The columns changed while you were moving them. Reload the group and try again.', 409)
        for i, key in enumerate(order):
            BoardColumn.objects.filter(id=key).update(position=i + 1)
        self.touch(b)
        self.record(actor, b, 'Columns reordered', ', '.join(next(c['name'] for c in columns if c['id'] == x) for x in order))
        return {'id': b['id'], 'type': 'tm_group', 'message': 'Columns reordered.'}

    def column_delete(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'deleteColumns', 'You can’t delete this group’s columns. Deleting a column needs “Can manage” access and the Delete permission for Groups.')
        columns = self.columns_of(b['id'])
        col = next((x for x in columns if x['id'] == d.get('id')), None)
        if not col:
            fail('Column not found. Reload the group.', 404)
        self.tasks.check_version(col, d.get('expected_version'))
        deps = dm.formula_dependents(columns, col['id'])
        if deps:
            fail_with(f"“{col['name']}” is used by {', '.join('“' + x['name'] + '”' for x in deps)}. Change or delete {'that formula' if len(deps) == 1 else 'those formulas'} first.",
                      409, {'code': 'dependents', 'columns': [{'id': x['id'], 'name': x['name']} for x in deps]})
        if len(columns) == 1:
            fail('A group needs at least one column. Add another column before deleting this one.', 409)
        rows = self.rows_of(b['id'])
        filled = sum(1 for r in rows if not dm.empty_value(r['values'].get(col['id'])))
        if filled and d.get('confirm') is not True:
            fail_with(f"“{col['name']}” has values in {filled} {plural(filled, 'row')}. Confirm to delete the column and its values.", 409,
                      {'code': 'confirm_delete', 'count': filled})
        for r in rows:
            if col['id'] in r['values']:
                nxt = dict(r['values'])
                del nxt[col['id']]
                update(BoardRow, r['id'], {'values_json': js.dumps(nxt), 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': self.now()})
        BoardColumn.objects.filter(id=col['id']).delete()
        self.touch(b)
        self.record(actor, b, 'Column deleted', f"{col['name']} ({dm.COLUMN_TYPES[col['type']]})"
                    + (f" · {filled} {plural(filled, 'value')} removed" if filled else ''))
        return {'id': b['id'], 'type': 'tm_group', 'message': f"Column “{col['name']}” deleted."}

    # ------------------------------------------------------------ rows
    def clean_values(self, b, columns, value, current=None, cache=None):
        """Checks the values typed for a row. Formula columns are always calculated here, never taken from the request."""
        if value is None:
            return {}
        if not isinstance(value, dict):
            fail('Send the row values by column.')
        current = current or {}
        people = cache.get('people') if cache is not None else None
        out = {}
        for key, v in value.items():
            # `columns` holds only the columns this person may see, so a hidden column is answered like a missing one.
            col = next((x for x in columns if x['id'] == key), None)
            if not col:
                fail_with('A column was deleted or changed. Reload the group.', 409, {'code': 'column_missing', 'column': key})
            if col['type'] in ('IN_CHARGE', 'SUPPORT') and people is None:
                people = self.eligible_set(b)
                if cache is not None:
                    cache['people'] = people
            r = dm.clean_cell(col, v, eligible=people, current=current.get(key))
            if not r['ok']:
                fail_with(f"{col['name']}: {r['error']}", 422, {'code': 'value', 'column': key, 'error': r['error']})
            out[key] = r['value']
        return out

    @staticmethod
    def row_out(r, s, prepared, extra=None):
        """A row as one person may see it: only the values of their visible columns (formula results computed from all the
        columns, but only for formulas whose every input they can see), with its note count and, for the people who manage
        the group, its access rule."""
        computed = dm.compute_row(r['values'], s['all'], prepared)
        values, results = {}, {}
        for c in s['columns']:
            if c['type'] == 'FORMULA':
                results[c['id']] = computed.get(c['id'])
            elif c['id'] in r['values']:
                values[c['id']] = r['values'][c['id']]
        out = {'id': r['id']}
        if s['seeAll'] or not s['rules']['rows']:
            out['position'] = r['position']
        out.update({'version': r['version'], 'values': values, 'computed': results, 'created_by': r['created_by'], 'created_at': r['created_at'],
                    'updated_by': r['updated_by'], 'updated_at': r['updated_at']})
        if s['seeAll']:
            out['access'] = s['rules']['rows'].get(r['id']) or None
        from .models import BoardCellStyle
        styles = {x.column_id: {'text_color': x.text_color, 'background_color': x.background_color}
                  for x in BoardCellStyle.objects.filter(row_id=r['id'], column_id__in=s['colIds'])}
        if styles:
            out['styles'] = styles
        out.update(extra or {})
        return out

    @staticmethod
    def stored_size(board_id):
        return BoardRow.objects.filter(board_id=board_id).aggregate(n=Sum(Length('values_json')))['n'] or 0

    def size_check(self, b, data, before=0):
        """What a group stores is limited per row and per group (characters of the saved values), checked when rows grow."""
        n = js.length(data)
        if n > L['rowChars']:
            fail(f"This row is too large: {js.locale(n)} characters, and a row can hold up to {js.locale(L['rowChars'])} in all. Shorten some long texts.", 422)
        total = self.stored_size(b['id']) - before + n
        if total > L['groupChars']:
            fail(f"This group is full: its rows can hold up to {js.locale(L['groupChars'])} characters in all. Shorten long texts, or move old rows to another group.", 422)

    @staticmethod
    def note_count(row_id):
        return BoardNote.objects.filter(row_id=row_id, deleted_at__isnull=True).count()

    def fresh_row(self, key):
        r = BoardRow.objects.filter(id=key).first()
        return {**row(r), 'values': js.loads(r.values_json, {})} if r else None

    def row_add(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'addRows', 'You can’t add records to this group.')
        if BoardRow.objects.filter(board_id=b['id']).count() >= L['rows']:
            fail(f"A group can hold up to {js.locale(L['rows'])} rows. Archive old rows into another group first.")
        all_ = self.columns_of(b['id'])
        s = self.sight(b, actor, caps, all_)
        values = {k: v for k, v in self.clean_values(b, s['columns'], d.get('values')).items() if not dm.empty_value(v)}
        after = None
        if d.get('after'):
            found = BoardRow.objects.filter(id=d['after'], board_id=b['id']).first()
            after = row(found) if found else None
            if not after or not s['rowOk'](after['id']):
                fail('This row was deleted. Reload the group.', 404)
        position = after['position'] + 1 if after else (BoardRow.objects.filter(board_id=b['id']).aggregate(p=Max('position'))['p'] or 0) + 1
        if after:
            BoardRow.objects.filter(board_id=b['id'], position__gte=position).update(position=F('position') + 1)
        key, at, data = next_id('tm-board-row', 'ROW'), self.now(), js.dumps(values)
        self.size_check(b, data)
        insert(BoardRow, {'id': key, 'board_id': b['id'], 'position': position, 'values_json': data, 'version': 0, 'created_by': actor,
                          'created_at': at, 'updated_by': actor, 'updated_at': at})
        # The activity names rows by their ID, never by their values (some people may not see every column).
        self.touch(b)
        self.record(actor, b, 'Row added', key)
        r = self.fresh_row(key)
        return {'id': key, 'type': 'tm_group_row', 'message': 'Row added.', 'row': self.row_out({**r, 'values': values}, s, dm.prepare_formulas(all_), {'notes': 0})}

    def row_update(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'editRows', 'You can’t change records in this group.')
        found = BoardRow.objects.filter(id=text(d.get('id'), 'Row', 60, True), board_id=b['id']).first()
        all_ = self.columns_of(b['id'])
        s = self.sight(b, actor, caps, all_)
        if not found or not s['rowOk'](found.id):
            fail('This row was deleted. Reload the group.', 404)
        r = {**row(found), 'values': js.loads(found.values_json, {})}
        columns = s['columns']
        values = d.get('values') if isinstance(d.get('values'), dict) else {}
        # A column this person can't see is answered like a deleted one (before any value is compared).
        for key in values:
            if key not in s['colIds']:
                fail_with('A column was deleted or changed. Reload the group.', 409, {'code': 'column_missing', 'column': key})
        # Conflicts: each changed cell must still hold the value the person saw (or the row its version), so nobody's
        # change is silently overwritten.
        if d.get('expected_version') is not None:
            self.tasks.check_version(r, d.get('expected_version'))
        else:
            expected = d.get('expected') if isinstance(d.get('expected'), dict) else None
            if expected is None:
                fail('Send the values you started from, so changes by others are not overwritten.', 400)
            for key in values:
                if key not in expected:
                    fail('Send the values you started from, so changes by others are not overwritten.', 400)
                now_value = r['values'].get(key)
                was = None if expected[key] == '' else expected[key]
                if not js.same(now_value, was):
                    col = next((x for x in columns if x['id'] == key), None)
                    shown = f"“{dm.cell_text(col, now_value, self.name_of) or 'empty'}”" if col else 'another value'
                    fail_with(f"Someone changed “{(col or {}).get('name') or 'this cell'}” in this row to {shown} while you were editing. "
                              'Your change was not saved: check the new value and try again.', 409, {'code': 'cell_conflict', 'column': key, 'current': now_value})
        changes = self.clean_values(b, columns, d.get('values'), r['values'])
        nxt = dict(r['values'])
        for key, v in changes.items():
            if dm.empty_value(v):
                nxt.pop(key, None)
            else:
                nxt[key] = v
        notes = self.note_count(r['id'])
        if js.same(nxt, r['values']):
            return {'id': r['id'], 'type': 'tm_group_row', 'message': 'No change.', 'unchanged': True,
                    'row': self.row_out(r, s, dm.prepare_formulas(all_), {'notes': notes})}
        at, data = self.now(), js.dumps(nxt)
        if js.length(data) > js.length(found.values_json):
            self.size_check(b, data, js.length(found.values_json))
        update(BoardRow, r['id'], {'values_json': data, 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': at})
        self.touch(b)
        # V5.6.9: files taken out of an Attachment cell are deleted with it.
        for key in changes:
            col = next((x for x in columns if x['id'] == key), None)
            if not col or col['type'] != 'ATTACHMENT':
                continue
            kept = {f.get('id') for f in (nxt.get(key) if isinstance(nxt.get(key), list) else [])}
            for f in (r['values'].get(key) if isinstance(r['values'].get(key), list) else []):
                if f.get('id') not in kept:
                    BoardFile.objects.filter(id=f.get('id'), board_id=b['id']).delete()
                    self.record(actor, b, 'File removed', f"{r['id']} · {col['name']} · {f.get('name')}")
        return {'id': r['id'], 'type': 'tm_group_row', 'message': 'Saved.',
                'row': self.row_out({**r, 'values': nxt, 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': iso(at)}, s,
                                    dm.prepare_formulas(all_), {'notes': notes})}

    # ------------------------------------------------------------ V5.6.9 files in Attachment columns
    def attachment_cell(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'editRows', 'You can’t change records in this group.')
        all_ = self.columns_of(b['id'])
        s = self.sight(b, actor, caps, all_)
        found = BoardRow.objects.filter(id=text(d.get('row_id'), 'Row', 60, True), board_id=b['id']).first()
        if not found or not s['rowOk'](found.id):
            fail('This row was deleted. Reload the group.', 404)
        col = next((x for x in s['columns'] if x['id'] == d.get('column_id')), None)
        if not col:
            fail_with('A column was deleted or changed. Reload the group.', 409, {'code': 'column_missing', 'column': d.get('column_id')})
        if col['type'] != 'ATTACHMENT':
            fail('Files can be added only to Attachment columns.', 409)
        r = {**row(found), 'values': js.loads(found.values_json, {})}
        current = r['values'].get(col['id'])
        return b, s, all_, col, r, (current if isinstance(current, list) else [])

    def saved_row(self, b, s, all_, r, nxt, actor, at):
        update(BoardRow, r['id'], {'values_json': js.dumps(nxt), 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': at})
        self.touch(b)
        return self.row_out({**r, 'values': nxt, 'version': r['version'] + 1, 'updated_by': actor, 'updated_at': iso(at)}, s,
                            dm.prepare_formulas(all_), {'notes': self.note_count(r['id'])})

    def file_add(self, d, actor):
        b, s, all_, col, r, files = self.attachment_cell(d, actor)
        name = clean_file_name(text(d.get('name'), 'File name', 160, True))
        ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
        if ext not in task_domain.TASK_FILE_TYPES:
            fail('Attach an image (JPG, PNG, WebP, GIF, HEIC), a PDF, a Word, Excel or PowerPoint document, or a CSV, TXT or ZIP file.')
        maximum = L['fileBytes']
        content = self.tasks.decode(d.get('base64'), maximum, f'Choose a file between 1 byte and {maximum // 1024 // 1024} MB.')
        if not content_matches(ext, content):
            fail(f'This file is not a real {ext.upper()} file. Choose the original file.')
        if len(files) >= L['files']:
            fail(f"A cell can hold up to {L['files']} files. Remove one first.", 409)
        used = BoardFile.objects.filter(board_id=b['id']).aggregate(n=Sum('size'))['n'] or 0
        if used + len(content) > L['groupFileBytes']:
            fail(f"This group’s files are full ({L['groupFileBytes'] // 1024 // 1024} MB in all). Remove files that are no longer needed.", 409)
        key, at = next_id('tm-board-file', 'GFILE'), self.now()
        meta = {'id': key, 'name': name, 'size': len(content), 'mime': task_domain.TASK_FILE_TYPES[ext], 'by': actor, 'at': iso(at)}
        insert(BoardFile, {'id': key, 'board_id': b['id'], 'row_id': r['id'], 'column_id': col['id'], 'name': name, 'mime': meta['mime'], 'size': meta['size'],
                           'content': content, 'uploaded_by': actor, 'created_at': at})
        nxt = {**r['values'], col['id']: [*files, meta]}
        self.size_check(b, js.dumps(nxt), js.length(r['values_json']))
        out = self.saved_row(b, s, all_, r, nxt, actor, at)
        self.record(actor, b, 'File attached', f"{r['id']} · {col['name']} · {name}")
        return {'id': key, 'type': 'tm_group_file', 'message': f'{name} attached.', 'row': out}

    def file_remove(self, d, actor):
        b, s, all_, col, r, files = self.attachment_cell(d, actor)
        f = next((x for x in files if x.get('id') == d.get('file_id')), None)
        if not f:
            fail('This file was already removed. Reload the group.', 404)
        BoardFile.objects.filter(id=f['id'], board_id=b['id']).delete()
        rest = [x for x in files if x.get('id') != f['id']]
        nxt = dict(r['values'])
        if rest:
            nxt[col['id']] = rest
        else:
            nxt.pop(col['id'], None)
        out = self.saved_row(b, s, all_, r, nxt, actor, self.now())
        self.record(actor, b, 'File removed', f"{r['id']} · {col['name']} · {f.get('name')}")
        return {'id': f['id'], 'type': 'tm_group_file', 'message': f"{f.get('name')} removed.", 'row': out}

    def file(self, key, staff, file_id, metadata_only=False):
        """One file of an Attachment cell, for someone who may see that row and that column."""
        b, caps = self.open_board(key, staff)
        s = self.sight(b, staff, caps)
        query = BoardFile.objects.filter(id=str(file_id or '')[:60], board_id=b['id'])
        f = (query.defer('content') if metadata_only else query).first()
        if not f or not s['rowOk'](f.row_id) or f.column_id not in s['colIds']:
            fail('File not found.', 404)
        return f

    def row_move(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'editRows', 'You can’t reorder records in this group.')
        # Positions are among the rows this person can see; rows hidden from them keep their place relative to the others.
        s, rows = self.sight(b, actor, caps), self.rows_of(b['id'])
        seen = [x for x in rows if s['rowOk'](x['id'])]
        moving = next((x for x in seen if x['id'] == d.get('id')), None)
        if not moving:
            fail('This row was deleted. Reload the group.', 404)
        to = integer(d.get('to'), 0, max(0, len(seen) - 1), 'row position')
        order = [x for x in seen if x['id'] != moving['id']]
        order.insert(to, moving)
        anchor = order[to + 1] if to + 1 < len(order) else None
        rest = [x for x in rows if x['id'] != moving['id']]
        at = next((i for i, x in enumerate(rest) if x['id'] == anchor['id']), -1) if anchor else len(rest)
        rest.insert(len(rest) if at < 0 else at, moving)
        for i, x in enumerate(rest):
            if x['position'] != i + 1:
                BoardRow.objects.filter(id=x['id']).update(position=i + 1)
        self.touch(b)
        return {'id': moving['id'], 'type': 'tm_group_row', 'message': 'Row moved.'}

    def row_delete(self, d, actor):
        """One row, the selected rows, or every row matching a search and filters. Every row is checked first (it still
        exists, this person can see it, and it has not changed since they selected it); if any fails, nothing is deleted."""
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'deleteRows', 'You can’t delete records in this group.')
        s = self.sight(b, actor, caps)
        if isinstance(d.get('match'), dict):
            items = self.matching_rows(b, actor, caps, s, d['match'])
            expected = d.get('expected_count')
            if not is_int(expected) or expected != len(items):
                fail_with(f"The rows matching your search and filters changed: {len(items)} match now"
                          f"{f', {js.num_str(expected)} when you selected them' if is_int(expected) else ''}. Nothing was deleted; check the list and try again.",
                          409, {'code': 'bulk_changed', 'count': len(items)})
            # The same number is not enough: the rows themselves (and their versions) must be the ones the person saw.
            if not isinstance(d.get('match_key'), str) or d['match_key'] != self.match_key(items):
                fail_with('Some of the rows matching your search and filters were added, changed or deleted since you selected them. '
                          'Nothing was deleted; check the list and try again.', 409, {'code': 'bulk_changed', 'count': len(items)})
            targets = [{'id': x['r']['id'], 'version': x['r']['version']} for x in items]
        else:
            ids = d['ids'] if isinstance(d.get('ids'), list) else [d.get('id')]
            if not ids or len(ids) > L['bulk'] or any(not isinstance(x, str) or not x or len(x) > 60 for x in ids):
                fail(f"Choose 1 to {js.locale(L['bulk'])} rows to delete.")
            versions = d['expected'] if isinstance(d.get('expected'), dict) else {}
            targets = []
            for key in dict.fromkeys(ids):
                if len(ids) == 1 and is_int(d.get('expected_version')):
                    version = d['expected_version']
                elif is_int(versions.get(key)):
                    version = versions[key]
                else:
                    version = None
                targets.append({'id': key, 'version': version})
        if not targets:
            fail('No rows match, so nothing was deleted.', 409)
        missing, changed, found = [], [], []
        current = dict(BoardRow.objects.filter(board_id=b['id'], id__in=[t['id'] for t in targets]).values_list('id', 'version'))
        for t in targets:
            if t['id'] not in current or not s['rowOk'](t['id']):
                missing.append(t['id'])
                continue
            if t['version'] is not None and current[t['id']] != t['version']:
                changed.append(t['id'])
                continue
            found.append(t['id'])
        if len(targets) == 1 and missing:
            fail('This row was already deleted.', 404)
        if len(targets) == 1 and changed:
            fail('This row changed. Refresh it before deleting it.', 409)
        if missing or changed:
            parts = []
            if missing:
                n = len(missing)
                parts.append(f"{n} of the selected rows {'was' if n == 1 else 'were'} already deleted or {'is' if n == 1 else 'are'} no longer available to you")
            if changed:
                n = len(changed)
                parts.append(f"{n} {'was' if n == 1 else 'were'} changed by someone since you selected {'it' if n == 1 else 'them'}")
            fail_with(f"{', and '.join(parts)}. Nothing was deleted: reload the group, check the selection and try again.", 409,
                      {'code': 'bulk_conflict', 'missing': missing, 'changed': changed})
        for i in range(0, len(found), 400):
            BoardRow.objects.filter(board_id=b['id'], id__in=found[i:i + 400]).delete()
        self.touch(b)
        self.record(actor, b, 'Row deleted' if len(found) == 1 else 'Rows deleted', found[0] if len(found) == 1 else f'{len(found)} rows')
        return {'id': b['id'], 'type': 'tm_group', 'deleted': len(found), 'message': 'Row deleted.' if len(found) == 1 else f'{len(found)} rows deleted.'}

    # ------------------------------------------------------------ V5.5 access rules for rows and columns
    def principals_input(self, b, value):
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > L['principals']:
            fail(f"Choose up to {L['principals']} people or roles.")
        out = {}
        for p in value:
            kind = p.get('type') if isinstance(p, dict) else None
            key = p.get('id') if isinstance(p, dict) else None
            if kind not in ('USER', 'ROLE') or not isinstance(key, str) or not key:
                fail('Choose people or roles.')
            if kind == 'ROLE':
                if not Role.objects.filter(id=key).exists():
                    fail('A chosen role no longer exists. Reload and try again.', 409)
            # People must be able to open the group: access rules narrow the group's own sharing, they never widen it.
            elif not Staff.objects.filter(id=key, active=True).exists() or self.level_for(b, key) < 1:
                fail(f'{self.name_of(key)} can’t open this group. Share the group with them first.', 409)
            out[f'{kind}:{key}'] = {'type': kind, 'id': key}
        return list(out.values())

    def describe(self, people):
        if not people:
            return 'everyone in the group'
        names = []
        for p in people:
            if p['type'] == 'ROLE':
                names.append('role ' + (Role.objects.filter(id=p['id']).values_list('name', flat=True).first() or p['id']))
            else:
                names.append(self.name_of(p['id']))
        return ', '.join(names)

    def row_access(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'share', 'Only the people who manage this group can decide who sees its rows. Changing a cell does not include that.')
        ids = list(dict.fromkeys(d['ids'])) if isinstance(d.get('ids'), list) else []
        if not ids or len(ids) > L['bulk']:
            fail('Choose the rows.')
        for key in ids:
            if not BoardRow.objects.filter(id=key, board_id=b['id']).exists():
                fail('A chosen row was deleted. Reload the group.', 404)
        people = self.principals_input(b, d.get('principals'))
        for key in ids:
            BoardRowAccess.objects.filter(row_id=key).delete()
            for p in people:
                BoardRowAccess.objects.create(row_id=key, board_id=b['id'], principal_type=p['type'], principal_id=p['id'])
        self.touch(b)
        n = len(ids)
        self.record(actor, b, 'Row access changed', f"{n} {plural(n, 'row')} · visible to {self.describe(people)}")
        subject = 'The row is' if n == 1 else f'{n} rows are'
        return {'id': b['id'], 'type': 'tm_group', 'message': f'{subject} now visible only to {self.describe(people)} (and the people who manage the group).'
                if people else f'{subject} visible to everyone in the group again.'}

    def column_access(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'share', 'Only the people who manage this group can decide who sees its columns.')
        col = BoardColumn.objects.filter(id=js.to_js_string(d.get('id') or ''), board_id=b['id']).first()
        if not col:
            fail('Column not found. Reload the group.', 404)
        people = self.principals_input(b, d.get('principals'))
        BoardColumnAccess.objects.filter(column_id=col.id).delete()
        for p in people:
            BoardColumnAccess.objects.create(column_id=col.id, board_id=b['id'], principal_type=p['type'], principal_id=p['id'])
        deps = dm.formula_dependents(self.columns_of(b['id']), col.id)
        self.touch(b)
        self.record(actor, b, 'Column access changed', f'{col.name} · visible to {self.describe(people)}')
        if people:
            uses = f" Formulas that use it ({', '.join('“' + x['name'] + '”' for x in deps)}) are hidden from everyone else too." if deps else ''
            message = f'“{col.name}” is now visible only to {self.describe(people)} (and the people who manage the group).{uses}'
        else:
            message = f'“{col.name}” is visible to everyone in the group again.'
        return {'id': col.id, 'type': 'tm_group_column', 'message': message}

    # ------------------------------------------------------------ V5.5 layouts: each person's own, and a shared default
    @staticmethod
    def view_of(board_id, staff):
        return js.loads(BoardView.objects.filter(board_id=board_id, staff_id=staff).values_list('view_json', flat=True).first(), {})

    @staticmethod
    def clean_layout(value, columns, personal):
        if not isinstance(value, dict):
            fail('Send the layout.')
        ids, (lo, hi), out = {c['id'] for c in columns}, L['width'], {}

        def width(v, a, z):
            return int(dm._js_round(max(a, min(z, float(js.number(v))))))
        if 'widths' in value:
            if not isinstance(value['widths'], dict):
                fail('Send the column widths.')
            out['widths'] = {}
            for k, v in value['widths'].items():
                n = js.number(v)
                if k in ids and js.is_number(n) and n == n and n not in (float('inf'), float('-inf')):
                    out['widths'][k] = width(v, lo, hi)
        if 'order' in value:
            if not isinstance(value['order'], list):
                fail('Send the column order.')
            out['order'] = list(dict.fromkeys(x for x in value['order'] if isinstance(x, str) and x in ids))
        # V5.6.9: the width of the row-number column (the first column on the left).
        if 'rownum' in value:
            a, z = L['rownumWidth']
            n = js.number(value['rownum'])
            if not js.is_number(n) or n != n or n in (float('inf'), float('-inf')):
                fail('Send the column widths.')
            out['rownum'] = width(value['rownum'], a, z)
        if personal and 'hidden_columns' in value:
            if not isinstance(value['hidden_columns'], list):
                fail('Send the hidden columns.')
            out['hidden_columns'] = list(dict.fromkeys(x for x in value['hidden_columns'] if isinstance(x, str) and x in ids))
        if personal and 'hidden_rows' in value:
            if not isinstance(value['hidden_rows'], list) or len(value['hidden_rows']) > L['bulk']:
                fail('Send the hidden rows.')
            out['hidden_rows'] = list(dict.fromkeys(x for x in value['hidden_rows'] if isinstance(x, str) and js.length(x) <= 60))
        return out

    def view_save(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        s = self.sight(b, actor, caps)
        if d.get('reset') is True:
            BoardView.objects.filter(board_id=b['id'], staff_id=actor).delete()
            return {'id': b['id'], 'type': 'tm_group_view', 'message': 'Your layout is back to the group’s default.'}
        nxt = {**self.view_of(b['id'], actor), **self.clean_layout(d.get('view'), s['columns'], True)}
        updated = BoardView.objects.filter(board_id=b['id'], staff_id=actor).update(view_json=js.dumps(nxt), updated_at=self.now())
        if not updated:
            BoardView.objects.create(board_id=b['id'], staff_id=actor, view_json=js.dumps(nxt), updated_at=self.now())
        return {'id': b['id'], 'type': 'tm_group_view', 'message': 'Your layout is saved.'}

    def layout_save(self, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        self.archived_check(b)
        self.need(caps, 'structure', 'Only the people who manage this group can save its default layout for everyone.')
        columns = self.columns_of(b['id'])
        layout, before = self.clean_layout(d.get('layout'), columns, False), js.loads(b['layout_json'], {})
        if 'order' in layout:
            rest = [c['id'] for c in columns if c['id'] not in layout['order']]
            for i, key in enumerate([*layout['order'], *rest]):
                BoardColumn.objects.filter(id=key).update(position=i + 1)
        merged = {**before, **({'widths': layout['widths']} if 'widths' in layout else {}), **({'rownum': layout['rownum']} if 'rownum' in layout else {})}
        update(Board, b['id'], {'layout_json': js.dumps(merged), 'updated_at': self.now()})
        what = ' and '.join(x for x in ['widths' in layout and 'column widths', 'order' in layout and 'column order'] if x) or 'layout'
        self.record(actor, b, 'Default layout saved', what)
        return {'id': b['id'], 'type': 'tm_group',
                'message': 'Saved as the default layout for everyone. People who arranged their own view keep it until they reset it.'}

    # ------------------------------------------------------------ V5.5 notes on rows
    @staticmethod
    def note_row(b, s, row_id):
        found = BoardRow.objects.filter(id=js.to_js_string(row_id or ''), board_id=b['id']).values_list('id', flat=True).first()
        if not found or not s['rowOk'](found):
            fail('This row was deleted. Reload the group.', 404)
        return found

    def note_action(self, action, d, actor):
        b, caps = self.open_board(d.get('group_id'), actor)
        s = self.sight(b, actor, caps)
        if action == 'tm.group.note.add':
            self.archived_check(b)
            self.need(caps, 'notes', 'You can read the notes of this group, but adding notes needs “Can edit records” access.')
            row_id = self.note_row(b, s, d.get('row_id'))
            t = dm.clean_text(d.get('body'))
            if not t['ok']:
                fail(t['error'].replace('in a cell', 'in a note', 1))
            if not t['value']:
                fail('Write the note first.')
            if js.length(t['value']) > L['note']:
                fail(f"Use at most {js.locale(L['note'])} characters in a note.")
            if BoardNote.objects.filter(row_id=row_id).count() >= L['notesPerRow']:
                fail('This row already has the most notes it can hold.', 409)
            key = next_id('tm-board-note', 'GNOTE')
            insert(BoardNote, {'id': key, 'board_id': b['id'], 'row_id': row_id, 'author_id': actor, 'body': t['value'], 'created_at': self.now(),
                               'edited_at': None, 'deleted_at': None, 'deleted_by': None, 'version': 0})
            return {'id': key, 'type': 'tm_group_note', 'message': 'Note added.'}
        found = BoardNote.objects.filter(id=js.to_js_string(d.get('id') or ''), board_id=b['id']).first()
        n = row(found) if found else None
        if not n or not s['rowOk'](n['row_id']):
            fail('Note not found.', 404)
        self.tasks.check_version(n, d.get('expected_version'))
        if n['deleted_at']:
            fail('This note was deleted.', 409)
        self.archived_check(b)
        if action == 'tm.group.note.edit':
            if n['author_id'] != actor:
                fail('Only the person who wrote this note can edit it.', 403)
            self.need(caps, 'notes', 'You can read the notes of this group, but changing notes needs “Can edit records” access.')
            t = dm.clean_text(d.get('body'))
            if not t['ok']:
                fail(t['error'].replace('in a cell', 'in a note', 1))
            if not t['value']:
                fail('A note can’t be empty. Delete it instead.')
            if js.length(t['value']) > L['note']:
                fail(f"Use at most {js.locale(L['note'])} characters in a note.")
            if t['value'] == n['body']:
                return {'id': n['id'], 'type': 'tm_group_note', 'message': 'No change.', 'unchanged': True}
            BoardNoteRevision.objects.create(note_id=n['id'], body=n['body'], action='EDIT', actor_id=actor, created_at=self.now())
            update(BoardNote, n['id'], {'body': t['value'], 'edited_at': self.now(), 'version': n['version'] + 1})
            return {'id': n['id'], 'type': 'tm_group_note', 'message': 'Note saved. The earlier text is kept in its history.'}
        if action == 'tm.group.note.delete':
            if not caps['share'] and not (n['author_id'] == actor and caps['notes']):
                fail('You can read the notes of this group, but deleting notes needs “Can edit records” access.' if n['author_id'] == actor
                     else 'Only the person who wrote this note, or someone who manages the group, can delete it.', 403)
            BoardNoteRevision.objects.create(note_id=n['id'], body=n['body'], action='DELETE', actor_id=actor, created_at=self.now())
            update(BoardNote, n['id'], {'body': '', 'deleted_at': self.now(), 'deleted_by': actor, 'version': n['version'] + 1})
            return {'id': n['id'], 'type': 'tm_group_note', 'message': 'Note deleted. The deletion is kept in the row’s history.'}
        fail('Unknown note action.', 404)

    # ------------------------------------------------------------ commands
    def handle(self, action, d, actor):
        if action == 'tm.group.cell.format':
            from .presentation import style_cell
            return style_cell(self, d, actor)
        if action.startswith('tm.group.data-share.') or action == 'tm.group.import.internal':
            from .sharing import DataSharing
            sharing = DataSharing(self)
            return sharing.stage(d, actor) if action.endswith('.internal') else sharing.save(d, actor)
        if action == 'tm.group.delivery.create':
            from .delivery import enqueue
            return enqueue(self, d, actor)
        handlers = {
            'tm.group.save': self.save_board, 'tm.group.archive': self.archive_board, 'tm.group.delete': self.delete_board,
            'tm.group.column.save': self.column_save, 'tm.group.column.move': self.column_move, 'tm.group.column.delete': self.column_delete,
            'tm.group.row.add': self.row_add, 'tm.group.row.update': self.row_update, 'tm.group.row.move': self.row_move,
            'tm.group.row.delete': self.row_delete, 'tm.group.row.access': self.row_access, 'tm.group.file.add': self.file_add,
            'tm.group.file.remove': self.file_remove, 'tm.group.column.access': self.column_access, 'tm.group.view.save': self.view_save,
            'tm.group.layout.save': self.layout_save, 'tm.group.import.upload': self.imports.upload, 'tm.group.import.commit': self.imports.commit,
        }
        if action in ('tm.group.note.add', 'tm.group.note.edit', 'tm.group.note.delete'):
            return self.note_action(action, d, actor)
        handler = handlers.get(action)
        if not handler:
            fail('Unknown group action.', 404)
        return handler(d, actor)

    # ------------------------------------------------------------ reading (never through commands, so nothing changes)
    @staticmethod
    def note_counts(board_id):
        return dict(BoardNote.objects.filter(board_id=board_id, deleted_at__isnull=True).values('row_id').annotate(n=Count('id')).values_list('row_id', 'n'))

    def matching_rows(self, b, staff, caps, s, p=None):
        """Rows are searched, filtered and sorted here, over the rows and columns this person may see, so a browser never
        receives a value it may not show."""
        p = p or {}
        prepared, view = dm.prepare_formulas(s['all']), self.view_of(b['id'], staff)
        hidden_rows = set() if p.get('hidden') else set(view.get('hidden_rows') or [])
        q = js.trim(js.to_js_string(p.get('q') or '')).lower()[:200]
        filters = dm.clean_filters(p.get('filters', dm.UNDEF))
        if filters is None:
            fail('Invalid filters.', 400)
        cols = s['columns']
        by_id = {c['id']: c for c in cols}
        sort_col = by_id.get(js.to_js_string(p['sort'])) if p.get('sort') else None
        desc = p.get('dir') == 'desc'
        names = {}

        def name(key):
            if key not in names:
                names[key] = self.name_of(key)
            return names[key]
        needs_text = bool(q) or any((by_id.get(f['col']) or {}).get('type') == 'TEXT' for f in filters) or bool(sort_col and sort_col['type'] not in ('NUMBER', 'FORMULA', 'STATUS'))
        items = []
        for r in self.rows_of(b['id']):
            if not s['rowOk'](r['id']) or r['id'] in hidden_rows:
                continue
            computed = dm.compute_row(r['values'], s['all'], prepared)

            def value(col):
                return computed.get(col['id']) if col['type'] == 'FORMULA' else r['values'].get(col['id'])

            def cell_text(col):
                return dm.cell_text(col, value(col), name) if needs_text else ''
            if q and not any(q in cell_text(col).lower() for col in cols):
                continue
            if not all(not by_id.get(f['col']) or dm.matches_filter(by_id[f['col']], value(by_id[f['col']]), f, cell_text(by_id[f['col']])) for f in filters):
                continue
            items.append({'r': r, 'computed': computed, 'key': dm.sort_key(sort_col, value(sort_col), cell_text(sort_col)) if sort_col else None})
        if sort_col:
            def compare(a, x):
                u, v = a['key'], x['key']
                if u is None or v is None:
                    return 0 if u is v else 1 if u is None else -1
                if js.is_number(u) and js.is_number(v):
                    r = (u > v) - (u < v)
                else:
                    r = _collate(js.to_js_string(u), js.to_js_string(v))
                return -r if desc else r
            items.sort(key=cmp_to_key(compare))
        return items

    @staticmethod
    def match_key(items):
        """A fingerprint of a result (its rows and their versions), so “delete all matching” acts on exactly what was shown."""
        digest = hashlib.sha256('|'.join(sorted(f"{x['r']['id']}:{x['r']['version']}" for x in items)).encode()).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip('=')[:32]

    @staticmethod
    def totals_of(items, s):
        out = {}
        for col in s['columns']:
            if col['type'] not in ('NUMBER', 'FORMULA'):
                continue
            total, errors, count = 0.0, 0, 0
            for x in items:
                v = x['computed'].get(col['id']) if col['type'] == 'FORMULA' else x['r']['values'].get(col['id'])
                if isinstance(v, dict):
                    errors += 1
                elif js.is_number(v):
                    total += float(v)
                    count += 1
                elif isinstance(v, bool):
                    count += 1
            out[col['id']] = {'sum': js.num(float(f'{total:.15g}')), 'errors': errors, 'count': count}
        return out

    def query(self, key, staff, p=None):
        """One page of rows (search, filters, sorting and paging done here), with totals of the whole result."""
        p = p or {}
        b, caps = self.open_board(key, staff)
        s = self.sight(b, staff, caps)
        items = self.matching_rows(b, staff, caps, s, p)
        offset = max(0, min(js.parse_int(p.get('offset')) or 0, 1000000))
        limit = max(1, min(L['page'], js.parse_int(p.get('limit')) or 50))
        prepared, counts = dm.prepare_formulas(s['all']), self.note_counts(b['id'])
        visible = {r['id'] for r in self.rows_of(b['id']) if s['rowOk'](r['id'])}
        hidden_mine = sum(1 for x in (self.view_of(b['id'], staff).get('hidden_rows') or []) if x in visible)
        return {'group_id': b['id'], 'version': b['version'], 'total': len(items), 'all': len(visible), 'hidden_mine': hidden_mine,
                'match_key': self.match_key(items), 'offset': offset, 'limit': limit,
                'rows': [self.row_out(x['r'], s, prepared, {'notes': counts.get(x['r']['id'], 0)}) for x in items[offset:offset + limit]],
                'totals': self.totals_of(items, s)}

    @staticmethod
    def only_visible(layout, s):
        """A layout with only the columns and rows this person may see (it must not reveal the IDs of hidden ones)."""
        out = dict(layout)
        if isinstance(layout.get('widths'), dict):
            out['widths'] = {k: v for k, v in layout['widths'].items() if k in s['colIds']}
        if isinstance(layout.get('order'), list):
            out['order'] = [k for k in layout['order'] if k in s['colIds']]
        if isinstance(layout.get('hidden_columns'), list):
            out['hidden_columns'] = [k for k in layout['hidden_columns'] if k in s['colIds']]
        if isinstance(layout.get('hidden_rows'), list):
            out['hidden_rows'] = [k for k in layout['hidden_rows'] if s['rowOk'](k)]
        return out

    def read(self, key, staff, p=None):
        """One group: its columns as this person may see them, their own layout and the shared default, and the first page."""
        p = p or {}
        b, caps = self.open_board(key, staff)
        s = self.sight(b, staff, caps)
        shared = sql('SELECT a.staff_id,a.level,l.name FROM tm_board_access a JOIN staff l ON l.id=a.staff_id WHERE a.board_id=%s', b['id'])
        shared.sort(key=lambda x: nocase(x['name']))
        columns = []
        for col in s['columns']:
            settings = col['settings']
            if col['type'] == 'FORMULA':
                settings = {**settings, 'display': dm.formula_display(settings.get('expression'), s['all']), 'refs': dm.formula_refs(settings.get('expression'))}
            out = {'id': col['id'], 'name': col['name'], 'type': col['type'], 'position': col['position'], 'version': col['version'], 'settings': settings,
                   'used_by': [x['id'] for x in dm.formula_dependents(s['all'], col['id']) if x['id'] in s['colIds']] if col['type'] in ('NUMBER', 'FORMULA') else []}
            if s['seeAll']:
                out['access'] = s['rules']['cols'].get(col['id']) or None
            columns.append(out)
        # The activity names rows by ID and columns by name; with access rules in place it is shown to the managers only.
        activity = None
        if s['seeAll'] or not s['restricted']:
            activity = [{'action': e['action'], 'detail': e['detail'], 'actor_id': e['actor_id'], 'created_at': iso(e['created_at']),
                         'actor': self.name_of(e['actor_id'])}
                        for e in ActivityEvent.objects.filter(entity_type='group', entity_id=b['id']).order_by('-id')
                        .values('action', 'detail', 'actor_id', 'created_at')[:30]]
        roles = sorted(Role.objects.values('id', 'name'), key=lambda r: nocase(r['name'])) if s['seeAll'] else []
        page = self.query(b['id'], staff, {'limit': 50, **p})
        w = Workspace.objects.filter(id=b['workspace_id']).values('name', 'status').first() or {}
        group = {k: b[k] for k in BOARD_FIELDS}
        group.update({'level': caps['level'], 'caps': caps, 'owner_name': self.name_of(b['owner_id']), 'workspace_name': w.get('name') or '',
                      'workspace_status': w.get('status') or 'ACTIVE', 'shared': shared, 'restricted': s['restricted'],
                      'hidden_columns': 0 if s['seeAll'] else s['hiddenColumns']})
        return {'group': group, 'columns': columns, 'view': self.only_visible(self.view_of(b['id'], staff), s),
                'layout': self.only_visible(js.loads(b['layout_json'], {}), s), 'roles': roles, 'activity': activity, 'limits': dm.GROUP_LIMITS,
                'page': page,
                # The Google Sheets connection is not part of this deployment, so no group has one.
                'sync': None,
                # Earlier screens read `rows`: the first page (search and paging happen on the server, see /api/tasks/group/rows).
                'rows': page['rows']}

    def notes(self, key, staff, p=None):
        """Notes on one row, newest or oldest first, optionally between two dates (days in the reader's time zone)."""
        p = p or {}
        b, caps = self.open_board(key, staff)
        s = self.sight(b, staff, caps)
        row_id = self.note_row(b, s, p.get('row'))
        zone = self.tasks.zone_of(staff)

        def day(v):
            v = js.to_js_string(v or '')
            return v if re.match(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', v) else None
        frm, to = day(p.get('from')), day(p.get('to'))
        if (p.get('from') and not frm) or (p.get('to') and not to):
            fail('Enter valid dates (YYYY-MM-DD).', 400)
        if frm and to and frm > to:
            fail('The end date must be on or after the start date.', 400)
        try:
            notes = BoardNote.objects.filter(row_id=row_id)
            if frm:
                notes = notes.filter(created_at__gte=_start_of_day(frm, zone))
            if to:
                notes = notes.filter(created_at__lt=_start_of_day(_next_day(to), zone))
        except ValueError:
            fail('Enter valid dates (YYYY-MM-DD).', 400)
        order = 'ASC' if p.get('order') == 'oldest' else 'DESC'
        offset = max(0, js.parse_int(p.get('offset')) or 0)
        limit = max(1, min(100, js.parse_int(p.get('limit')) or 20))
        total = notes.count()
        sign = '' if order == 'ASC' else '-'
        page = list(notes.annotate(revision_count=Count('revisions')).order_by(sign + 'created_at', sign + 'id')[offset:offset + limit])
        # The row is named by its first visible column (never by a column this person can't see).
        first = next((x for x in s['columns'] if x['type'] != 'FORMULA'), None)
        values = js.loads(BoardRow.objects.filter(id=row_id).values_list('values_json', flat=True).first(), {})
        title = dm.cell_text(first, values.get(first['id']), self.name_of)[:120] if first else ''
        out = []
        for n in page:
            out.append({'id': n.id, 'author_id': n.author_id, 'author': self.name_of(n.author_id), 'body': '' if n.deleted_at else n.body,
                        'created_at': iso(n.created_at), 'edited_at': iso(n.edited_at), 'deleted_at': iso(n.deleted_at),
                        'deleted_by': self.name_of(n.deleted_by_id) if n.deleted_by_id else None, 'version': n.version, 'revisions': n.revision_count,
                        'can_edit': not n.deleted_at and n.author_id == staff and caps['notes'],
                        'can_delete': not n.deleted_at and (n.author_id == staff or caps['share']) and b['status'] == 'ACTIVE',
                        'can_history': n.revision_count > 0 and (n.author_id == staff or caps['seeAll'])})
        return {'row': {'id': row_id, 'title': title}, 'zone': zone, 'total': total, 'offset': offset, 'limit': limit,
                'order': 'oldest' if order == 'ASC' else 'newest', 'can_add': caps['notes'], 'notes': out}

    def note_history(self, key, staff, note_id):
        b, caps = self.open_board(key, staff)
        s = self.sight(b, staff, caps)
        n = BoardNote.objects.filter(id=js.to_js_string(note_id or ''), board_id=b['id']).first()
        if not n or not s['rowOk'](n.row_id) or not (n.author_id == staff or caps['seeAll']):
            fail('Note not found.', 404)
        history = [{'body': r.body, 'action': r.action, 'actor_id': r.actor_id, 'created_at': iso(r.created_at), 'actor': self.name_of(r.actor_id)}
                   for r in BoardNoteRevision.objects.filter(note_id=n.id).order_by('id')]
        return {'id': n.id, 'history': history}

    def members(self, key, staff, q='', offset=0, limit=50):
        """People who may be chosen in In Charge and Support cells, with search and paging."""
        b, _ = self.open_board(key, staff)
        words = [w for w in dm.name_key(js.to_js_string(q or '')[:100]).split(' ') if w]
        # Job positions are shown (and searched) only for people whose role can see team details (Users · View), as elsewhere.
        positions = bool(self.gov.can_staff(staff, 'tasks.users', 'view'))
        people = [p if positions else {**p, 'position': ''} for p in self.eligible(b)]
        people = [p for p in people if all(w in dm.name_key(f"{p['name']} {p['department']} {p['position']}") for w in words)]

        def number(v, fallback):
            n = js.number(v) if v is not None else 0
            return int(n) if js.is_number(n) and n == n and n not in (float('inf'), float('-inf')) and n else fallback
        start = max(0, number(offset, 0))
        size = max(1, min(100, number(limit, 50)))
        return {'total': len(people), 'offset': start, 'items': people[start:start + size]}

    def audience(self, key, staff):
        """People who can open the group (for row and column access rules), for the people who manage it."""
        b, caps = self.open_board(key, staff)
        self.need(caps, 'share', 'Only the people who manage this group can see who can open it.')
        found = sql("SELECT l.id,l.name FROM staff l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.active=%s AND COALESCE(p.active,%s)=%s",
                    True, True, True)
        found.sort(key=lambda x: nocase(x['name']))
        return {'people': [{'id': x['id'], 'name': x['name']} for x in found if self.level_for(b, x['id']) > 0],
                'roles': sorted(Role.objects.values('id', 'name'), key=lambda r: nocase(r['name']))}

    def xlsx(self, key, staff, p=None):
        """The group as an Excel workbook (Export permission): every row this person may see, the rows matching their
        search and filters, or the rows they selected; only the columns they may see; formula results as values."""
        from .xlsx import write_xlsx
        p = p or {}
        b, caps = self.open_board(key, staff)
        if not caps['export']:
            fail('Your role can’t export groups.', 403)
        s, view = self.sight(b, staff, caps), self.view_of(b['id'], staff)
        prepared = dm.prepare_formulas(s['all'])
        scope = p.get('scope') if p.get('scope') in ('all', 'filtered', 'selected') else 'all'
        if scope == 'filtered':
            items = self.matching_rows(b, staff, caps, s, p)
        elif scope == 'selected':
            ids = [js.trim(x) for x in js.to_js_string(p.get('ids') or '').split(',') if js.trim(x)][:L['bulk']]
            if not ids:
                fail('Select the rows to export.', 400)
            wanted = set(ids)
            rows = [r for r in self.rows_of(b['id']) if r['id'] in wanted]
            if len(rows) != len(wanted) or any(not s['rowOk'](r['id']) for r in rows):
                fail('Some selected rows were deleted or are no longer available to you. Reload the group and select them again.', 409)
            items = [{'r': r, 'computed': dm.compute_row(r['values'], s['all'], prepared)} for r in rows]
        else:
            items = [{'r': r, 'computed': dm.compute_row(r['values'], s['all'], prepared)} for r in self.rows_of(b['id']) if s['rowOk'](r['id'])]
        # Columns in this person's order; with columns=view, without the columns they hid in their own view.
        order = view.get('order') if isinstance(view.get('order'), list) else []

        def rank(col_id):
            return order.index(col_id) if col_id in order else 1000000
        cols = sorted(s['columns'], key=lambda c: (rank(c['id']), c['position']))
        if p.get('columns') == 'view':
            cols = [c for c in cols if c['id'] not in (view.get('hidden_columns') or [])]

        def kind(col):
            return 'number' if col['type'] in ('NUMBER', 'FORMULA') else 'date' if col['type'] == 'DATE' else 'text'

        def value(col, r, computed):
            v = computed.get(col['id']) if col['type'] == 'FORMULA' else r['values'].get(col['id'])
            if dm.empty_value(v):
                return None
            if col['type'] in ('NUMBER', 'DATE'):
                return v
            if col['type'] == 'FORMULA':
                return {'error': v.get('error')} if isinstance(v, dict) else v
            return dm.cell_text(col, v, self.name_of)
        buf = write_xlsx([{'name': b['name'], 'columns': [{'header': c['name'], 'type': kind(c), 'decimals': (c.get('settings') or {}).get('decimals')} for c in cols],
                           'rows': [[value(c, x['r'], x['computed']) for c in cols] for x in items]}])
        n, m = len(items), len(cols)
        self.record(staff, b, 'Exported to Excel', f"{n} {plural(n, 'row')} · {m} {plural(m, 'column')}")
        return {'name': b['name'], 'buffer': buf, 'rows': n}

    def summaries(self, staff, boards=None):
        """For the group list: rows and columns each person may see in each group they may open."""
        out = []
        for b in boards if boards is not None else [row(x) for x in Board.objects.order_by('id')]:
            caps = self.caps_for(b, staff)
            if not caps['view']:
                continue
            s = self.sight(b, staff, caps)
            if s['seeAll'] or not s['rules']['rows']:
                rows = BoardRow.objects.filter(board_id=b['id']).count()
            else:
                rows = sum(1 for r in BoardRow.objects.filter(board_id=b['id']).values_list('id', flat=True) if s['rowOk'](r))
            out.append({'board_id': b['id'], 'rows': rows, 'columns': len(s['columns'])})
        return out

    @staticmethod
    def state():
        boards = [{k: row(b)[k] for k in BOARD_FIELDS} for b in Board.objects.order_by('id')]
        boards.sort(key=lambda b: nocase(b['name']))
        access = [{'board_id': a['board_id'], 'staff_id': a['staff_id'], 'level': a['level']}
                  for a in BoardAccess.objects.order_by('id').values('board_id', 'staff_id', 'level')]
        return {'tm_boards': boards, 'tm_board_access': access}

"""Task Management commands — a function-by-function port of tasks.mjs (V5.7.7).

Every rule, message and HTTP status is kept. Rows are plain dicts with V5.7.7 column names (core.rows), dates are
'YYYY-MM-DD' strings and timestamps ISO strings, so the logic reads like the original. One TaskService instance is
created per command, inside the command's database transaction; any failure rolls the whole command back.
"""
from core.i18n import msg as _message
import base64
import binascii
import json
import re
from datetime import datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo, available_timezones

from django.db.models import Count, Max, Q, Sum
from django.utils import timezone

from accounts.models import AccessAudit, User
from audit.services import log as audit_log
from core.errors import InputError, fail
from core.models import Company, Staff
from core.rows import insert, row, rows, update
from core.services import active_staff, next_id
from core.validation import choice, date_text, integer, iso, js_length, js_number, text
from notifications.models import Notification
from organization.governance import jtext, parse
from organization.models import Profile, StaffPhoto
from timesheets.models import TimeEntry
from workspaces.models import Workspace, WorkspaceMember

from . import domain as dm
from .filecheck import clean_file_name, content_matches
from .models import (ChecklistItem, DueDateRequest, Task, TaskAssignee, TaskChangeRequest, TaskFile, TaskHistory,
                     TaskReminderSent, TaskRequest)
from .recurrence import RuleError, normalize_rule, scheduled_next
from .scope import TaskScope

SOURCES = ['WEB', 'TELEGRAM', 'MINIAPP']
DEFAULT_ZONE = 'Asia/Phnom_Penh'
ZONES = available_timezones() | {'UTC', DEFAULT_ZONE}
SIDEBAR_THEMES = ['blue', 'graphite', 'light', 'red', 'teal']
MAX_FILE, MAX_PHOTO, MAX_FILES, MAX_CHECKS = 30 * 1024 * 1024, 2 * 1024 * 1024, 30, 50
BASE64 = re.compile(r'^[A-Za-z0-9+/]*={0,2}$')
NOT_FOUND = _message('Task Management record not found.')
FIELD_LABELS = {'visibility': _message('Task visibility'), 'governing_manager_id': _message('Governing manager'), 'title': _message('Title'), 'description': _message('Expectation'), 'progress': _message('Progress'), 'start_date': _message('Start date'),
                'due_date': _message('Due date'), 'priority': _message('Priority'), 'estimate_minutes': _message('Estimated effort'),
                'pic_id': _message('Person in charge'), 'supporters': _message('Supporting people'), 'reviewer_id': _message('Reviewer'),
                'department': _message('Department'), 'department_note': _message('Department note'), 'recurrence': _message('Repeat'),
                'recurrence_rule': _message('Repeat schedule'), 'recurrence_until': _message('Repeat until'), 'related': _message('Related record'),
                'status': _message('Status')}
CHANGE_WORD = {'UPDATE': _message('change details'), 'COMPLETE': 'complete', 'CANCEL': 'cancel'}
CLEARED = {'stuck_at': None, 'stuck_by': None, 'stuck_reason': ''}
UNSUBMITTED = {'submitted_to': None, 'submitted_by': None, 'submitted_at': None, 'submit_note': ''}
REMINDER_ERROR = _message('Choose up to five reminders, each 1 to 90 days before the due date.')
MISSING = object()


def now():
    return iso(timezone.now())


def clip(value, n):
    s = str('' if value is None else value)
    return s[:n - 1] + '…' if js_length(s) > n else s


def nn(value, fallback):
    """JavaScript `value ?? fallback`."""
    return fallback if value is None else value


def js_falsy(value):
    """JavaScript `!value` for values that arrive as JSON."""
    return value is None or value is False or value == '' or (isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0)


def js_string(value):
    """JavaScript String(value) for JSON values."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, list):
        return ','.join('' if v is None else js_string(v) for v in value)
    if isinstance(value, dict):
        return '[object Object]'
    return str(value)


def flag(value):
    return value is True or value == 1


def move_series(d):
    return flag(d.get('move_series'))


def same_value(a, b):
    if isinstance(a, list) or isinstance(b, list):
        return jtext(sorted(a or [])) == jtext(sorted(b or []))
    return str(nn(a, '')) == str(nn(b, ''))


class TaskService:
    def __init__(self, governance):
        self.gov = governance
        self.scope = TaskScope(governance)
        self.quiet = None

    # ============================================================ small helpers
    def find(self, model, key):
        found = model.objects.filter(pk=text(key, _message('Record ID'), 60, True)).first()
        if not found:
            fail(NOT_FOUND, 404)
        return row(found, exclude=('content',))

    def task(self, key):
        return self.find(Task, key)

    def workspace(self, key):
        return self.find(Workspace, key)

    def active_workspace(self, key):
        w = self.workspace(key)
        if w['status'] != 'ACTIVE':
            fail(_message('Restore the workspace before changing its work.'))
        return w

    @staticmethod
    def hidden():
        fail(NOT_FOUND, 404)

    @staticmethod
    def check_version(record, expected):
        if isinstance(expected, bool) or expected != record['version']:
            fail(_message('This record changed. Refresh it before saving again.'), 409)

    @staticmethod
    def lookup(staff_id):
        return active_staff(staff_id).id

    def profile(self, staff):
        self.lookup(staff)
        p = Profile.objects.filter(staff_id=staff).first()
        if p and not p.active:
            fail(_message('Choose an active team member.'))
        return p

    @staticmethod
    def is_member(wid, staff):
        return WorkspaceMember.objects.filter(workspace_id=wid, staff_id=staff).exists()

    def name_of(self, staff):
        s = Staff.objects.filter(id=staff).first() if staff else None
        if not s:
            return staff or ''
        nickname = Profile.objects.filter(staff_id=staff).values_list('nickname', flat=True).first()
        return s.name + (f' ({nickname})' if nickname else '')

    @staticmethod
    def canonical_name(staff):
        return Staff.objects.filter(id=staff).values_list('name', flat=True).first() or staff or ''

    @staticmethod
    def account_of(staff):
        return User.objects.filter(staff_id=staff).values('id', 'active').first()

    def can_staff(self, staff, resource, action='view'):
        return self.gov.can_staff(staff, resource, action)

    def assignable(self, value):
        key = self.lookup(value)
        self.gov.require_operational(key)
        self.profile(key)
        a = self.account_of(key)
        if a and not a['active']:
            fail(_message('{p0}’s login is disabled. Choose someone else.', p0=self.name_of(key)))
        if a and not self.can_staff(key, 'tasks.tasks', 'view'):
            fail(_message('{p0} can’t open Task Management. Ask an administrator to add it to their role, or choose someone else.', p0=self.name_of(key)))
        return key

    def zone_of(self, staff):
        own = Profile.objects.filter(staff_id=staff).values_list('timezone', flat=True).first() if staff else ''
        return own or Company.objects.filter(id=1).values_list('timezone', flat=True).first() or DEFAULT_ZONE

    @staticmethod
    def zone_input(value, label=_message('Time zone')):
        zone = text(value, label, 64)
        if zone and zone not in ZONES:
            fail(_message('Choose a valid {p0} (for example Asia/Phnom_Penh).', p0=label.lower()))
        return zone

    def log(self, actor, entity, key, wid, action, detail=''):
        audit_log(actor, entity, key, wid, action, detail)

    @staticmethod
    def duration(value, maximum=600000):
        try:
            n = dm.parse_duration(value or '0:00')
        except ValueError as e:
            fail(str(e))
        if n > maximum:
            fail(_message('Duration is too large.'))
        return n

    # ------------------------------------------------------------ workspace membership (legacy workspaces)
    def can_add_members(self, wid, actor):
        if not actor or self.is_member(wid, actor):
            return True
        if Workspace.objects.filter(id=wid, owner_id=actor).exists():
            return True
        return self.can_staff(actor, 'tasks.workspace', 'delete') or self.can_staff(actor, 'tasks.tasks', 'approve')

    def ensure_member(self, wid, staff, actor, why, system=False, authority=None):
        w = row(Workspace.objects.get(id=wid))
        if self.gov.governed(w):
            self.gov.check_collaborator(authority or actor, w, staff, system=system)
            return
        if not staff or self.is_member(wid, staff):
            return
        if not system and not self.can_add_members(wid, actor) and not (authority and authority != actor and self.is_member(wid, authority)):
            if staff == actor:
                fail(_message('You aren’t a member of the workspace “{p0}”. Ask its owner to add you, or ask a member for a task instead.', p0=w["name"]), 403)
            fail(_message('{p0} isn’t a member of this workspace, and only its members can add people to it. Choose members of the workspace, or ask its owner to add {p1}.', p0=self.name_of(staff), p1=self.name_of(staff)), 403)
        WorkspaceMember.objects.create(workspace_id=wid, staff_id=staff)
        self.gov.invalidate()
        self.log(actor, 'workspace', wid, wid, _message('Workspace member added'), f'{self.name_of(staff)} · {why}')

    # ============================================================ workflow helpers
    def assignee_rows(self, task_id):
        return list(TaskAssignee.objects.filter(task_id=task_id).order_by('id').values(
            'staff_id', 'status', 'invited_by', 'invited_at', 'responded_at', 'response_note'))

    def _assignee_dicts(self, task_id):
        out = []
        for a in self.assignee_rows(task_id):
            out.append({'staff_id': a['staff_id'], 'status': a['status'], 'invited_by': a['invited_by'],
                        'invited_at': iso(a['invited_at']), 'responded_at': iso(a['responded_at']), 'response_note': a['response_note']})
        return out

    def support_rows(self, t):
        return [a for a in self._assignee_dicts(t['id']) if a['staff_id'] != t.get('pic_id')]

    def supporters_of(self, t):
        return [a['staff_id'] for a in self.support_rows(t) if a['status'] != 'DECLINED']

    def can_approve(self, staff):
        return self.can_staff(staff, 'tasks.tasks', 'approve')

    def roles_for(self, t, actor):
        """Tasks “Approve” counts only on tasks the person is directly involved in (V5.5)."""
        return dm.task_roles(t, actor, self.support_rows(t), can_approve=self.can_approve(actor) and self.scope.is_involved(actor, t))

    def pending_due(self, task_id):
        return row(DueDateRequest.objects.filter(task_id=task_id, status='PENDING').first())

    def pending_change(self, task_id):
        return row(TaskChangeRequest.objects.filter(task_id=task_id, status='PENDING').first())

    def waiting_on(self, t):
        if t['status'] not in dm.OPEN_TASK_STATUSES:
            return []
        out = []
        if not t.get('accepted_at') and not t.get('declined_at') and t['status'] in ('NOT_STARTED', 'IN_PROGRESS'):
            out.append({'staff_id': t['pic_id'], 'role': 'pic'})
        out += [{'staff_id': a['staff_id'], 'role': 'supporter'} for a in self.support_rows(t) if a['status'] == 'PENDING']
        if t.get('reviewer_id') and (t.get('reviewer_status') or 'ACCEPTED') == 'PENDING':
            out.append({'staff_id': t['reviewer_id'], 'role': 'reviewer'})
        return out

    def guard(self, verb, t, roles, opts=None):
        from .models import TaskMember
        if verb in ('note', 'file') and t['status'] != 'CANCELLED' and t.get('visibility') != 'PERSONAL' and TaskMember.objects.filter(
                task_id=t['id'], staff_id=roles['staff'], permission='CONTRIBUTOR').exists():
            return
        block = dm.task_block(verb, {**t, 'due_request': self.pending_due(t['id']), 'waiting': self.waiting_on(t),
                                     'change_request': self.pending_change(t['id'])}, roles, opts)
        if block:
            fail(block['message'], block['status'])

    def history(self, t, kind, before, actor, source, note=''):
        TaskHistory.objects.create(task_id=t['id'], kind=kind, from_status=before['status'] if before else None, to_status=t['status'],
                                   progress=t['progress'], stuck=bool(t.get('stuck_at')), due_date=t['due_date'], note=note or '',
                                   actor_id=actor, source=source, created_at=timezone.now())

    def notify(self, ids, kind, actor, title, body='', task=None, request=None, due=None):
        seen = []
        for staff in ids:
            if not staff or staff in seen:
                continue
            seen.append(staff)
            if staff == actor or staff == self.quiet:
                continue
            Notification.objects.create(staff_id=staff, kind=kind, task_id=(task or {}).get('id'), request_id=(request or {}).get('id'),
                                        due_request_id=(due or {}).get('id'), title=title, body=body, actor_id=actor,
                                        created_at=timezone.now())

    @staticmethod
    def active_reviewer(t):
        return None if (t.get('reviewer_status') or 'ACCEPTED') == 'DECLINED' else t.get('reviewer_id')

    def everyone(self, t):
        return [t.get('pic_id'), *self.supporters_of(t), self.active_reviewer(t), dm.assigner_of(t)]

    def on_task(self, t, staff):
        return staff if staff and staff in self.everyone(t) else None

    # ------------------------------------------------------------ two-party approval
    def reachable(self, staff):
        if not staff or not Staff.objects.filter(id=staff, active=True).exists():
            return False
        if Profile.objects.filter(staff_id=staff, active=False).exists():
            return False
        a = self.account_of(staff)
        return (bool(a['active']) and self.can_staff(staff, 'tasks.tasks', 'view')) if a else True

    def calendar_reachable(self, staff):
        if not staff or not Staff.objects.filter(id=staff, active=True).exists():
            return False
        if Profile.objects.filter(staff_id=staff, active=False).exists():
            return False
        a = self.account_of(staff)
        return (bool(a['active']) and (self.can_staff(staff, 'tasks.tasks', 'view') or self.can_staff(staff, 'tasks.meetings', 'view'))) if a else True

    @staticmethod
    def _approver_candidates():
        """Active staff with an active login, by name (case-insensitive) then ID, as V5.7.7 orders them."""
        found = User.objects.filter(staff__active=True, active=True).values_list('staff_id', 'staff__name')
        return [sid for sid, _ in sorted(found, key=lambda x: (x[1].lower(), x[0]))]

    def approver_for(self, t, actor, edit=False):
        if not (dm.edit_approval_target(t, actor) if edit else dm.approval_target(t, actor)):
            return None
        if actor == t['pic_id']:
            for c in (dm.assigner_of(t), self.active_reviewer(t), t['created_by']):
                if c and c != t['pic_id'] and self.reachable(c):
                    return c
            for r in self._approver_candidates():
                if r != t['pic_id'] and self.reachable(r) and self.can_staff(r, 'tasks.tasks', 'approve') and self.scope.can_see(r, t):
                    return r
            fail(_message('{p0} can’t approve changes any more, and nobody else can decide for them. Ask an administrator to give someone Task Management “Approve”.', p0=self.name_of(dm.assigner_of(t))), 409)
        if not self.reachable(t['pic_id']):
            fail(_message('The other responsible party is unavailable. Restore their access or resolve responsibility before requesting a change.'), 409)
        return t['pic_id']

    def progress_approver(self, t, actor):
        if not dm.two_sided(t) or t['status'] not in dm.OPEN_TASK_STATUSES:
            return None
        if actor != t['pic_id'] and actor not in self.supporters_of(t):
            return self.approver_for(t, actor)
        for c in (dm.assigner_of(t), self.active_reviewer(t), t['created_by']):
            if c and c != t['pic_id'] and c != actor and self.reachable(c):
                return c
        for r in self._approver_candidates():
            if r != t['pic_id'] and r != actor and self.reachable(r) and self.can_staff(r, 'tasks.tasks', 'approve') and self.scope.can_see(r, t):
                return r
        fail(_message('{p0} can’t approve progress any more, and nobody else can decide for them. Ask an administrator to give someone Task Management “Approve”.', p0=self.name_of(dm.assigner_of(t))), 409)

    def shown(self, field, v):
        if v is None or v == '' or (isinstance(v, list) and not v):
            return _message('Nobody') if field == 'supporters' else '—'
        if field in ('start_date', 'due_date', 'recurrence_until'):
            return dm.human(v)
        if field == 'priority':
            return v[0] + v[1:].lower()
        if field == 'estimate_minutes':
            return f'{dm.format_minutes(v)} h'
        if field == 'progress':
            return f'{v}%'
        if field == 'recurrence':
            return dm.RECURRENCE.get(v, v)
        if field in ('pic_id', 'reviewer_id'):
            return self.name_of(v)
        if field == 'supporters':
            return ', '.join(self.name_of(x) for x in v)
        return clip(v, 300)

    def change(self, field, before, after, before_text=None, after_text=None):
        return {'field': field, 'label': FIELD_LABELS.get(field, field), 'from': before, 'to': after,
                'from_text': before_text if before_text is not None else self.shown(field, before),
                'to_text': after_text if after_text is not None else self.shown(field, after)}

    @staticmethod
    def change_summary(kind, changes):
        if kind == 'COMPLETE':
            return _message('mark it completed')
        if kind == 'CANCEL':
            return _message('cancel it')
        return ' · '.join(f"{c['label'].lower()} changed" if c['field'] in ('description', 'department_note')
                          else f"{c['label'].lower()} {c['from_text']} → {c['to_text']}" for c in changes)

    def request_change(self, t, kind, actor, source, approver, changes=(), payload=None, note='', quiet=False):
        pending = self.pending_change(t['id'])
        if pending:
            fail(_message('You already asked for a change to this task. Wait for the answer, or withdraw it first.') if pending['requested_by'] == actor
                 else _message('{p0}’s change to this task is waiting for {p1}. Wait for the answer first.', p0=self.name_of(pending['requested_by']), p1=self.name_of(pending['approver_id'])), 409)
        key, at = next_id('tm-change', 'CHG'), timezone.now()
        side = 'PIC' if actor == t['pic_id'] else 'ASSIGNER'
        summary = self.change_summary(kind, list(changes))
        TaskChangeRequest.objects.create(id=key, task_id=t['id'], kind=kind, requested_by_id=actor, requester_side=side, approver_id=approver,
                                         status='PENDING', changes_json=jtext(list(changes)), payload_json=jtext(payload or {}), note=note,
                                         base_version=t['version'], decision_note='', source=source, version=0, created_at=at, updated_at=at)
        asked = 'approve: ' + summary if kind == 'UPDATE' else summary
        if not quiet:
            self.history(t, 'change_request', t, actor, source, _message('Asked {p0} to {p1}{p2}', p0=self.name_of(approver), p1=asked, p2=' · ' + note if note else ''))
            self.notify([approver], 'change_request', actor, _message('Approval needed: {p0}', p0=t['title']),
                        _message('{p0} asks to {p1}{p2} · approve or reject', p0=self.name_of(actor), p1='change ' + summary if kind == 'UPDATE' else summary, p2=' · ' + note if note else ''),
                        task=t)
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Change requested'),
                 _message('{p0} · {p1} · to {p2}{p3}', p0=t['title'], p1=CHANGE_WORD[kind], p2=self.name_of(approver), p3=' · ' + note if note else ''))
        return key

    def settle_change(self, cr, status, actor, source, note=''):
        TaskChangeRequest.objects.filter(id=cr['id']).update(status=status, decided_by_id=actor, decided_at=timezone.now(), decision_note=note,
                                                             decision_source=source, version=cr['version'] + 1, updated_at=timezone.now())
        payload = parse(cr.get('payload_json') or '{}', {})
        if status != 'APPROVED' and isinstance(payload, dict) and payload.get('due_request_id'):
            q = row(DueDateRequest.objects.filter(id=payload['due_request_id']).first())
            t = row(Task.objects.filter(id=cr['task_id']).first())
            if q and q['status'] == 'APPROVED' and t:
                why = (_message('{p0} rejected the new date{p1}', p0=self.name_of(actor), p1=': ' + note if note else '') if status == 'REJECTED'
                       else _message('The change was withdrawn') if status == 'WITHDRAWN' else note or _message('The change could no longer apply'))
                DueDateRequest.objects.filter(id=q['id']).update(status='DECLINED', decision_note=clip(why, 1000), decided_by_id=actor,
                                                                 decided_at=timezone.now(), version=q['version'] + 1, updated_at=timezone.now())
                self.notify([q['requested_by']], 'due_declined', actor, _message('New due date not applied: {p0}', p0=t['title']), why, task=t, due=q)

    def end_due_requests(self, t, status, why, actor, requester=None):
        qs = DueDateRequest.objects.filter(task_id=t['id'], status='PENDING')
        if requester:
            qs = qs.filter(requested_by_id=requester)
        for q in rows(qs):
            DueDateRequest.objects.filter(id=q['id']).update(status=status, decision_note=why, decided_by_id=actor if status == 'DECLINED' else None,
                                                             decided_at=timezone.now(), version=q['version'] + 1, updated_at=timezone.now())
            self.notify([q['requested_by'] if status == 'DECLINED' else q['decide_by']], 'due_declined' if status == 'DECLINED' else 'task_updated',
                        actor, f"{_message('Due date request declined') if status == 'DECLINED' else _message('Due date request withdrawn')}: {t['title']}", why, task=t, due=q)

    def task_input(self, t):
        """A task as the edit form sends it, so an approved change can be applied on top of the task as it is now."""
        return {'governing_manager_id': t.get('governing_manager_id'), 'visibility': t.get('visibility', 'PUBLIC'), 'workspace_id': t['workspace_id'], 'title': t['title'], 'description': t['description'], 'start_date': t['start_date'],
                'due_date': t['due_date'], 'priority': t['priority'], 'estimate': dm.format_minutes(t['estimate_minutes']),
                'pic_id': t['pic_id'], 'supporter_ids': self.supporters_of(t), 'reviewer_id': t['reviewer_id'], 'department': t['department'],
                'department_note': t['department_note'], 'recurrence': t.get('recurrence') or '', 'recurrence_rule': t.get('recurrence_rule') or '{}',
                'recurrence_until': t.get('recurrence_until') or None, 'related_type': t.get('related_type') or '', 'related_id': t.get('related_id') or ''}

    def current_value(self, t, field):
        if field == 'supporters':
            return self.supporters_of(t)
        if field == 'related':
            return f"{t.get('related_type') or ''}:{t.get('related_id') or ''}"
        return t.get(field)

    @staticmethod
    def reminder_input(value):
        if not isinstance(value, list) or len(value) > 5:
            fail(REMINDER_ERROR)
        for n in value:
            f = js_number(n)
            if isinstance(f, float) and (f != f or not f.is_integer()):
                fail(REMINDER_ERROR)
            if f < 1 or f > 90:
                fail(REMINDER_ERROR)
        return dm.reminder_days(value)

    @staticmethod
    def confirm_reviewer(t, roles, at):
        return {'reviewer_status': 'ACCEPTED', 'reviewer_responded_at': at, 'reviewer_note': ''} if roles['reviewerStatus'] == 'PENDING' else {}

    @staticmethod
    def confirm_support(t, roles, actor, at):
        if roles['supportStatus'] == 'PENDING':
            TaskAssignee.objects.filter(task_id=t['id'], staff_id=actor).update(status='ACCEPTED', responded_at=at, response_note='')

    def save_row(self, t, changes):
        """Apply column changes to a task row; returns the new row (as the original builds `next`)."""
        update(Task, t['id'], changes)
        return {**t, **changes}

    @staticmethod
    def relation(related_type, related_id):
        if not related_type:
            return {'related_type': '', 'related_id': None, 'contact_id': None}
        fail(_message('Links to CRM and Operations records are not available in this installation.'), 403)

    # ============================================================ create / edit a task
    def save_task(self, d, actor, source, opts=None):
        opts = opts or {}
        old = self.task(d['id']) if d.get('id') else None
        if old:
            self.check_version(old, d.get('expected_version'))
        creation_key = None
        if not old:
            creation_key = opts.get('creationKey') or (f"{actor}:{text(d['request_key'], _message('Creation key'), 100, True)}" if d.get('request_key') else None)
        if creation_key:
            duplicate = row(Task.objects.filter(creation_key=creation_key).first())
            if duplicate:
                if duplicate['workspace_id'] != d.get('workspace_id'):
                    fail(_message('Creation key already belongs to another workspace.'))
                return {'id': duplicate['id'], 'type': 'tm_task', 'message': _message('Task already created.')}
        w = self.active_workspace(old['workspace_id'] if old else d.get('workspace_id'))
        from .policy import validate_visibility, validate_manager
        visibility = validate_visibility(self.gov, actor, d, old, w)
        key = old['id'] if old else next_id('tm-task', 'TASK')
        if not old and not self.gov.can_create_resource(actor, w) and not (
                opts.get('requestId') and self.gov.can_create_resource(opts.get('memberAuthority'), w)):
            fail(_message('Join this workspace before creating work in it.'), 403)
        pic = d['pic_id'] if 'pic_id' in d else MISSING
        supporters = d['supporter_ids'] if 'supporter_ids' in d else MISSING
        if pic is MISSING and isinstance(d.get('assignee_ids'), list):
            pic = d['assignee_ids'][0] if d['assignee_ids'] else MISSING
            supporters = d['assignee_ids'][1:]
        if old and pic in (MISSING, None, ''):
            pic = old['pic_id']
        previous = self._assignee_dicts(old['id']) if old else []
        prev_by = {r['staff_id']: r for r in previous}
        previous_support = [r for r in previous if r['staff_id'] != old['pic_id']] if old else []
        previous_active = [r['staff_id'] for r in previous_support if r['status'] != 'DECLINED']
        if old and supporters is MISSING:
            supporters = previous_active
        if pic is MISSING or js_falsy(pic):
            fail(_message('Choose the person in charge.'))
        pic = self.lookup(pic) if isinstance(pic, str) and old and pic == old['pic_id'] else self.assignable(pic)
        if supporters is not MISSING and supporters is not None and not isinstance(supporters, list):
            fail('Select the supporting people.')
        supporters = list(dict.fromkeys(s for s in ([] if supporters in (MISSING, None) else supporters) if s and s != pic))
        if len(supporters) > 50:
            fail(_message('Choose up to 50 supporting people.'))
        for s in supporters:
            if s not in previous_active:
                self.assignable(s)
        reviewer = d.get('reviewer_id') or (old or {}).get('reviewer_id') or actor
        reviewer = self.lookup(reviewer) if reviewer == (old or {}).get('reviewer_id') or reviewer == actor else self.assignable(reviewer)
        known = [old['pic_id'], old['reviewer_id'], old['created_by'], *(r['staff_id'] for r in previous)] if old else []
        for target in [pic, *supporters, reviewer]:
            self.gov.check_collaborator(opts.get('memberAuthority') or actor, w, target, existing=bool(old) and target in known)
        if (old or {}).get('activity_id') or (not old and d.get('activity_id')):
            fail(_message('Links to CRM activities are not available in this installation.'), 403)
        rel = self.relation(d.get('related_type'), d.get('related_id'))
        start, due = date_text(d.get('start_date'), _message('Start date')), date_text(d.get('due_date'), _message('Due date'))
        if due < start:
            fail(_message('Due date cannot be before start date.'))
        if d.get('recurrence') is None:
            recurrence = (old.get('recurrence') or '') if old else ''
        else:
            recurrence = choice(js_string(d['recurrence']), list(dm.RECURRENCE), _message('repeat option'))
        try:
            rule = d['recurrence_rule'] if d.get('recurrence_rule') is not None else (old or {}).get('recurrence_rule')
            if move_series(d):
                rule = json.loads(rule) if isinstance(rule, str) else (rule or {})
                rule = {**rule, 'anchor': due}
            recurrence_rule = jtext(normalize_rule(recurrence, rule, due))
        except (RuleError, ValueError, TypeError) as e:
            fail(str(e))
        if not recurrence:
            until = None
        elif 'recurrence_until' not in d:
            until = (old or {}).get('recurrence_until') or None
        else:
            until = date_text(d['recurrence_until'], _message('Repeat until')) if d['recurrence_until'] else None
        if until and until < due:
            fail(_message('“Repeat until” must be on or after the due date.'))
        description = d['expectation'] if 'description' not in d and 'expectation' in d else d.get('description')
        values = {'workspace_id': w['id'], 'activity_id': None, **rel, 'title': text(d.get('title'), _message('Task title'), 300, True),
                  'description': text(description, _message('Expectation'), 8000, not old), 'start_date': start, 'due_date': due,
                  'priority': choice(d.get('priority') or 'MEDIUM', ['HIGH', 'MEDIUM', 'LOW'], _message('priority')),
                  'estimate_minutes': self.duration(d.get('estimate')), 'pic_id': pic, 'reviewer_id': reviewer,
                  'department': (old['department'] if old else (w['department'] or '')) if d.get('department') is None else text(d['department'], _message('Department'), 150),
                  'department_note': text(nn(d.get('department_note'), (old or {}).get('department_note') or ''), _message('Department note'), 2000),
                  'recurrence': recurrence, 'recurrence_rule': recurrence_rule, 'recurrence_until': until}
        values['visibility'] = visibility
        values['governing_manager_id'] = validate_manager(self.gov, actor, d, old, w, visibility)
        if visibility == 'PERSONAL' and ({pic, reviewer, *supporters} - {actor if not old else old['created_by']}):
            fail(_message('Personal tasks are owner only. Choose Public or Organizational before adding participants.'), 422)
        reviewer_changed = not old or reviewer != old['reviewer_id']
        reviewer_self = reviewer == actor or opts.get('reviewerAccepted') == reviewer
        reviewer_values = ({'reviewer_status': 'ACCEPTED' if reviewer_self else 'PENDING', 'reviewer_responded_at': now() if reviewer_self else None,
                            'reviewer_note': ''} if reviewer_changed else {})
        roles = None
        if not old:
            if d.get('status') in ('IN_REVIEW', 'CANCELLED'):
                fail(_message('New tasks start as Not started, In progress or Completed.'))
            status = choice(d.get('status') or 'NOT_STARTED', ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'], _message('starting status'))
            if status != 'NOT_STARTED' and pic != actor:
                fail(_message('Only the person in charge can start or complete a task. Create it as Not started; they can accept it and record progress.'), 403)
            progress = 100 if status == 'COMPLETED' else 0 if status == 'NOT_STARTED' else integer(d.get('progress') or 0, 0, 99, _message('progress (0–99 until completed)'))
            accepted = pic == actor or opts.get('accepted')
            plan = {'scheduled_due': due, 'series_anchor': int(due[8:10])} if recurrence else {}
            reminders = [1] if d.get('reminder_days') is None else self.reminder_input(d['reminder_days'])
            stamp = now()
            t = {'id': key, **values, **reviewer_values, **plan, 'status': status, 'progress': progress, 'reason': '',
                 'completed_at': stamp if status == 'COMPLETED' else None, 'closed_by': actor if status == 'COMPLETED' else None,
                 'accepted_at': stamp if accepted else None, 'request_id': opts.get('requestId'), 'source': source, 'version': 0,
                 'creation_key': creation_key, 'created_by': actor, 'created_at': stamp, 'updated_at': stamp,
                 'assigned_by': opts['assignedBy'] if opts.get('assignedBy') and opts['assignedBy'] != pic else actor,
                 'reminder_days': jtext(reminders)}
            insert(Task, t)
            t = self.task(key)
            self.history(t, 'create', None, actor, source, _message('From task request {p0}', p0=opts['requestId']) if opts.get('requestId')
                         else _message('Repeats {p0}', p0=dm.RECURRENCE_SHORT[recurrence]) if recurrence else '')
            message = _message('Task created.')
        else:
            if d.get('status') not in (None, '') and d['status'] != old['status']:
                fail(_message('Use the task actions (accept, submit, close and so on) to change its status.'), 409)
            if d.get('progress') not in (None, ''):
                if js_number(d['progress']) != old['progress']:
                    fail(_message('Use “Update progress” to change progress.'), 409)
            roles = self.roles_for(old, actor)
            if not opts.get('applying'):
                self.guard('edit', old, roles)

            def changed(k):
                return str(nn(values.get(k), '')) != str(nn(old.get(k), ''))
            approver = None if opts.get('applying') else self.approver_for(old, actor, edit=True)
            if not opts.get('applying') and not approver:
                if not any(changed(k) for k in values) and same_value(supporters, previous_active):
                    return {'id': key, 'type': 'tm_task', 'unchanged': True, 'message': _message('Nothing was changed.')}
                # A one-sided task still asks another responsible party (its reviewer, creator, or the new reviewer or
                # person in charge) to approve a detail change. Approval is about distinct people, not roles: when the
                # person editing holds every one of those roles, nobody else has to agree, so the change is saved
                # directly (after the usual checks below) instead of waiting for a self-approval that can never come.
                others = [who for who in dict.fromkeys((old['reviewer_id'], old['created_by'], values['reviewer_id'], values['pic_id']))
                          if who and who != actor]
                for who in others:
                    account = self.account_of(who) if who else None
                    if self.reachable(who) and account and account['active'] and self.can_staff(who, 'tasks.tasks', 'view'):
                        approver = who
                        break
                if others and not approver:
                    fail(_message('Choose another active reviewer or person in charge to approve this change. The task remains unchanged until approved.'), 409)
            if approver:
                diff, payload = [], {}

                def put(field, before, after, keys):
                    diff.append(self.change(field, before, after))
                    payload.update(keys)
                for field in ('visibility', 'governing_manager_id', 'title', 'description', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department',
                              'department_note', 'recurrence', 'recurrence_rule', 'recurrence_until'):
                    if changed(field):
                        put(field, old.get(field), values.get(field), {field: nn(values.get(field), '' if field == 'recurrence' else None)})
                if values['estimate_minutes'] != old['estimate_minutes']:
                    put('estimate_minutes', old['estimate_minutes'], values['estimate_minutes'], {'estimate': dm.format_minutes(values['estimate_minutes'])})
                if not same_value(supporters, previous_active):
                    put('supporters', previous_active, supporters, {'supporter_ids': supporters})
                before_rel = f"{old.get('related_type') or ''}:{old.get('related_id') or ''}"
                after_rel = f"{values['related_type']}:{values['related_id'] or ''}"
                if after_rel != before_rel:
                    put('related', before_rel, after_rel, {'related_type': values['related_type'], 'related_id': values['related_id']})
                if not diff:
                    return {'id': key, 'type': 'tm_task', 'message': _message('Nothing was changed.'), 'unchanged': True}
                if move_series(d):
                    payload['move_series'] = True
                note = text(d.get('change_note'), _message('Reason for the change'), 1000)
                change_id = self.request_change(old, 'UPDATE', actor, source, approver, diff, payload, note)
                return {'id': key, 'type': 'tm_task', 'change_id': change_id,
                        'message': _message('Sent to {p0} for approval. Nothing changes until they approve.', p0=self.name_of(approver))}
            if not roles['isGovernor'] and not opts.get('applying'):
                locked = [k for k in ('title', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department', 'workspace_id',
                                      'recurrence', 'recurrence_rule', 'recurrence_until') if changed(k)]
                if locked:
                    fail(_message('Only the task’s manager can change its title, dates, priority, department, repeat, person in charge or reviewer. Ask for a new due date instead.'), 403)
            extra = dict(reviewer_values) if reviewer_changed else self.confirm_reviewer(old, roles, now())
            if changed('pic_id'):
                if old['status'] == 'IN_REVIEW':
                    fail(_message('Return or close the review before changing the person in charge.'), 409)
                extra.update({'accepted_at': (old['accepted_at'] or now()) if pic == actor else None, 'declined_at': None, 'declined_reason': ''})
            if changed('reviewer_id') and old['status'] == 'IN_REVIEW' and old['submitted_to'] == old['reviewer_id']:
                extra['submitted_to'] = reviewer
            if recurrence:
                if (not old.get('recurrence') or changed('recurrence') or changed('recurrence_rule') or move_series(d)
                        or (not old.get('scheduled_due') and not changed('due_date'))):
                    extra.update({'scheduled_due': due, 'series_anchor': int(due[8:10])})
                elif changed('due_date') and not old.get('scheduled_due'):
                    extra.update({'scheduled_due': old['due_date'], 'series_anchor': old.get('series_anchor') or int(old['due_date'][8:10])})
            t = {**old, **values, **extra, 'version': old['version'] + 1, 'updated_at': now()}
            update(Task, key, {k: v for k, v in t.items() if k != 'id'})
            diff = []
            for field in ('visibility', 'governing_manager_id', 'title', 'description', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department', 'department_note',
                          'recurrence', 'recurrence_rule', 'recurrence_until'):
                if changed(field):
                    diff.append(self.change(field, old.get(field), values.get(field)))
            if values['estimate_minutes'] != old['estimate_minutes']:
                diff.append(self.change('estimate_minutes', old['estimate_minutes'], values['estimate_minutes']))
            if not same_value(supporters, previous_active):
                diff.append(self.change('supporters', previous_active, supporters))
            before_rel = f"{old.get('related_type') or ''}:{old.get('related_id') or ''}"
            after_rel = f"{values['related_type']}:{values['related_id'] or ''}"
            if after_rel != before_rel:
                diff.append(self.change('related', before_rel, after_rel, f"{old['related_type']} {old['related_id']}" if old.get('related_id') else '—',
                                        f"{values['related_type']} {values['related_id']}" if values.get('related_id') else '—'))
            summary = clip(self.change_summary('UPDATE', diff), 1800)
            approved = _message(' · approved by {p0}', p0=self.name_of(opts['approvedBy'])) if opts.get('approvedBy') else ''
            self.history(t, 'edit', old, actor, source, f"{'Changed ' + summary if summary else _message('Details saved')}{approved}")
            if changed('pic_id'):
                tail = ('' if t.get('accepted_at') else _message(' · please accept or reject') if t['status'] in dm.OPEN_TASK_STATUSES
                        else _message(' · the task is {p0}; you are asked to accept it if it is reopened', p0=dm.TASK_STATUS[t['status']].lower()))
                self.notify([pic], 'task_assigned', actor, _message('New task: {p0}', p0=t['title']),
                            _message('{p0} made you the person in charge · due {p1}{p2}', p0=self.name_of(actor), p1=dm.human(due), p2=tail), task=t)
                self.notify([old['pic_id']], 'task_updated', actor, f"Reassigned: {t['title']}", _message('{p0} is now the person in charge', p0=self.name_of(pic)), task=t)
            if changed('due_date'):
                self.notify([pic, *supporters], 'task_updated', actor, _message('New due date: {p0}', p0=t['title']),
                            _message('{p0} changed the due date from {p1} to {p2}', p0=self.name_of(actor), p1=dm.human(old['due_date']), p2=dm.human(due)), task=t)
            message = _message('Task saved.')
        # Assignee rows: the person in charge, then supporting people (each with their answer).
        stamp, assignee_rows, invited, pic_prev = now(), [], [], prev_by.get(pic)
        assignee_rows.append({'task_id': key, 'staff_id': pic, 'status': 'ACCEPTED', 'invited_by': (pic_prev or {}).get('invited_by') or actor,
                              'invited_at': (pic_prev or {}).get('invited_at') or stamp, 'responded_at': None, 'response_note': ''})
        for s in supporters:
            p = prev_by.get(s)
            if p and old and s != old['pic_id'] and p['status'] != 'DECLINED':
                assignee_rows.append({'task_id': key, **p})
                continue
            accepted = s == actor or bool(old and s == old['pic_id'] and old.get('accepted_at') and not old.get('declined_at'))
            assignee_rows.append({'task_id': key, 'staff_id': s, 'status': 'ACCEPTED' if accepted else 'PENDING', 'invited_by': actor,
                                  'invited_at': stamp, 'responded_at': stamp if accepted else None, 'response_note': ''})
            if not accepted:
                invited.append(s)
        for p in previous_support:
            if p['status'] == 'DECLINED' and p['staff_id'] not in supporters and p['staff_id'] != pic:
                assignee_rows.append({'task_id': key, **p})
        TaskAssignee.objects.filter(task_id=key).delete()
        for r in assignee_rows:
            insert(TaskAssignee, r)
        if old:
            for s in previous_active:
                if s != pic and s not in supporters:
                    self.end_due_requests(t, 'WITHDRAWN', _message('{p0} no longer supports this task', p0=self.name_of(s)), actor, requester=s)
        if not self.gov.governed(w):
            for s in [pic, *supporters]:
                self.ensure_member(w['id'], s, actor, _message('chosen for a task'), authority=opts.get('memberAuthority'))
        if not old:
            if not opts.get('quietPic'):
                self.notify([pic], 'task_assigned', actor, _message('New task: {p0}', p0=t['title']),
                            _message('{p0} made you the person in charge · due {p1}{p2}', p0=self.name_of(actor), p1=dm.human(due), p2='' if t.get('accepted_at') else ' · please accept or reject'), task=t)
            steps = d['steps'] if isinstance(d.get('steps'), list) else d.get('checklist')
            if isinstance(steps, list):
                items = [x for x in (text(x, _message('Step'), 300) for x in steps) if x]
                if len(items) > MAX_CHECKS:
                    fail(_message('A task can have up to {p0} steps.', p0=MAX_CHECKS))
                for i, title in enumerate(items):
                    ChecklistItem.objects.create(id=next_id('tm-check', 'CHK'), task_id=key, position=i + 1, title=title, done=False,
                                                 created_by_id=actor, created_at=stamp)
        if not old and t['status'] == 'COMPLETED' and t.get('recurrence'):
            following = self.schedule_next(t, actor, source)
            message += _message(' The next one is due {p0}.', p0=dm.human(following['due_date'])) if following else ''
        open_text = (_message(' · please accept or reject') if t['status'] in dm.OPEN_TASK_STATUSES
                     else _message(' · the task is {p0}; you can answer if it is reopened', p0=dm.TASK_STATUS[t['status']].lower()))
        self.notify(invited, 'task_supporting', actor, _message('Support request: {p0}', p0=t['title']),
                    _message('{p0} asked you to support {p1} · due {p2}{p3}', p0=self.name_of(actor), p1='them' if pic == actor else self.name_of(pic), p2=dm.human(due), p3=open_text), task=t)
        if reviewer_changed and t.get('reviewer_status') == 'PENDING' and reviewer != pic:
            self.notify([reviewer], 'task_reviewer', actor, _message('Review request: {p0}', p0=t['title']),
                        _message('{p0} asked you to review this task · {p1} is in charge · due {p2} · please accept or reject', p0=self.name_of(actor), p1=self.name_of(pic), p2=dm.human(due)), task=t)
        self.log(actor, 'task', key, w['id'], _message('Task updated') if old else _message('Task created'),
                 _message('{p0} · {p1} · {p2}% · in charge {p3}', p0=t['title'], p1=dm.TASK_STATUS[t['status']], p2=t['progress'], p3=self.name_of(pic)))
        return {'id': key, 'type': 'tm_task', 'message': message}

    # ============================================================ accept / reject
    def respond(self, verb, t, roles, d, actor, source):
        role = choice(d['role'], ['pic', 'supporter', 'reviewer'], _message('role')) if d.get('role') else None
        answer = dm.answer_roles(verb, t, roles, role)
        targets, block = answer['roles'], answer['block']
        if not targets:
            mine = [v for k, v in (('pic', roles['picState']), ('supporter', roles['supportStatus']), ('reviewer', roles['reviewerStatus']))
                    if v and (not role or k == role)]
            if verb == 'accept' and mine and all(s == 'ACCEPTED' for s in mine):
                return {'id': t['id'], 'type': 'tm_task', 'message': _message('You already accepted this task.'), 'unchanged': True}
            if verb == 'decline' and mine and all(s == 'DECLINED' for s in mine):
                return {'id': t['id'], 'type': 'tm_task', 'message': _message('You already rejected this task.'), 'unchanged': True}
            fail(block['message'], block['status'])
        at, who = now(), self.name_of(actor)
        note = text(nn(d.get('note'), d.get('reason')), _message('Reason for rejecting'), 1000, True) if verb == 'decline' else ''
        support_row = next((a for a in self.support_rows(t) if a['staff_id'] == actor), None)
        changes, messages, tells, closing = {}, [], [], None
        for r in targets:
            if r == 'pic':
                if verb == 'accept':
                    changes.update({'accepted_at': at, 'declined_at': None, 'declined_reason': '',
                                    'status': 'IN_PROGRESS' if t['status'] == 'NOT_STARTED' else t['status']})
                    messages.append(_message('Task accepted. It is now in progress.'))
                    tells.append(([self.active_reviewer(t), dm.assigner_of(t)], 'task_accepted', f"Accepted: {t['title']}", _message('{p0} accepted the task', p0=who)))
                else:
                    changes.update({'declined_at': at, 'declined_reason': note})
                    messages.append(_message('Task rejected. Its manager has been told.'))
                    tells.append(([self.active_reviewer(t), dm.assigner_of(t)], 'task_declined', f"Rejected: {t['title']}", f'{who}: {note}'))
            elif r == 'reviewer':
                if verb == 'accept':
                    changes.update({'reviewer_status': 'ACCEPTED', 'reviewer_responded_at': at, 'reviewer_note': ''})
                    messages.append(_message('You are the reviewer of this task.'))
                    tells.append(([dm.assigner_of(t)], 'review_accepted', _message('Reviewer confirmed: {p0}', p0=t['title']), _message('{p0} will review the task', p0=who)))
                else:
                    changes.update({'reviewer_status': 'DECLINED', 'reviewer_responded_at': at, 'reviewer_note': note})
                    c = self.pending_change(t['id'])
                    if t['status'] == 'IN_REVIEW' and t.get('submitted_to') == actor:
                        if c and c['kind'] == 'COMPLETE' and c['requester_side'] == 'PIC' and c['approver_id'] != actor:
                            changes['submitted_to'] = c['approver_id']
                            tells.append(([c['approver_id']], 'task_submitted', _message('Approval needed: {p0}', p0=t['title']),
                                          _message('{p0} asks to complete the task · {p1} is no longer reviewing it', p0=self.name_of(t['submitted_by']), p1=who)))
                        else:
                            changes.update({'status': 'IN_PROGRESS', **UNSUBMITTED})
                    if c and c['approver_id'] == actor:
                        closing = c
                    messages.append(_message('You are no longer the reviewer. The people on the task have been told.'))
                    tells.append(([dm.assigner_of(t), t['pic_id'], t.get('submitted_by') if t['status'] == 'IN_REVIEW' else None], 'review_declined',
                                  _message('Review rejected: {p0}', p0=t['title']), f'{who}: {note}'))
            else:
                TaskAssignee.objects.filter(task_id=t['id'], staff_id=actor).update(status='ACCEPTED' if verb == 'accept' else 'DECLINED',
                                                                                    responded_at=at, response_note=note)
                inviter = self.on_task(t, (support_row or {}).get('invited_by')) or dm.assigner_of(t)
                if verb == 'accept':
                    messages.append(_message('You are supporting this task.'))
                    tells.append(([inviter], 'support_accepted', f"Supporting: {t['title']}", _message('{p0} accepted to support the task', p0=who)))
                else:
                    messages.append(_message('You are no longer supporting this task. The people on it have been told.'))
                    tells.append(([inviter, t['pic_id'], self.active_reviewer(t)], 'support_declined', _message('Support rejected: {p0}', p0=t['title']), f'{who}: {note}'))
        following = t
        if changes:
            following = self.save_row(t, {**changes, 'version': t['version'] + 1, 'updated_at': at})
        kinds = {'pic': verb, 'supporter': 'support_accept' if verb == 'accept' else 'support_decline',
                 'reviewer': 'review_accept' if verb == 'accept' else 'review_decline'}
        for r in targets:
            self.history(following, kinds[r], t, actor, source, note)
        if 'reviewer' in targets and verb == 'decline':
            decider = dm.due_decider(following)
            for q in rows(DueDateRequest.objects.filter(task_id=t['id'], status='PENDING', decide_by_id=actor)):
                if decider and decider != actor:
                    DueDateRequest.objects.filter(id=q['id']).update(decide_by_id=decider, version=q['version'] + 1, updated_at=timezone.now())
                    self.notify([decider], 'due_new', actor, _message('New due date requested: {p0}', p0=t['title']),
                                _message('{p0} asks to move it from {p1} to {p2}: {p3} · {p4} is no longer the reviewer', p0=self.name_of(q['requested_by']), p1=dm.human(q['current_due_date']), p2=dm.human(q['proposed_due_date']), p3=q['reason'], p4=who),
                                task=following, due=q)
        if closing:
            self.settle_change(closing, 'CLOSED', actor, source, _message('{p0} is no longer the reviewer', p0=who))
            self.notify([closing['requested_by']], 'change_rejected', actor, _message('Change closed: {p0}', p0=t['title']),
                        _message('{p0} is no longer the reviewer, so your request was closed. Ask again if it is still needed.', p0=who), task=following)
        for ids, kind, title, body in tells:
            self.notify(ids, kind, actor, title, body, task=following)
        labels = {'pic': _message('person in charge'), 'supporter': _message('supporting person'), 'reviewer': 'reviewer'}
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Task accepted') if verb == 'accept' else _message('Task rejected'),
                 _message('{p0} · as {p1}{p2}', p0=t['title'], p1=' and '.join(labels[r] for r in targets), p2=' · ' + note if note else ''))
        return {'id': t['id'], 'type': 'tm_task', 'message': ' '.join(messages)}

    # ============================================================ workflow actions
    def flow(self, verb, d, actor, source, opts=None):
        opts = opts or {}
        t = self.task(d.get('id'))
        applying = opts.get('applying')
        if not applying and d.get('expected_version') is not None:
            self.check_version(t, d['expected_version'])
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)

        def done(message):
            return {'id': t['id'], 'type': 'tm_task', 'message': message, 'unchanged': True}
        if verb in ('accept', 'decline'):
            return self.respond(verb, t, roles, d, actor, source)
        is_open = t['status'] in dm.OPEN_TASK_STATUSES
        if verb == 'stuck' and (roles['isPic'] or roles['isSupporter']) and t.get('stuck_at') and is_open:
            return done(_message('This task is already marked as stuck.'))
        if verb == 'submit' and t['status'] == 'IN_REVIEW' and t.get('submitted_by') == actor:
            return done(_message('This task is already waiting for review.'))
        if verb == 'close' and t['status'] == 'COMPLETED' and (roles['isPic'] or t.get('closed_by') == actor):
            return done(_message('This task is already closed.'))
        if verb == 'cancel' and t['status'] == 'CANCELLED' and (roles['isGovernor'] or roles['isPic']):
            return done(_message('This task is already cancelled.'))
        if verb == 'reopen' and is_open and (roles['isGovernor'] or roles['isPic']):
            return done(_message('This task is already open.'))
        if verb == 'resume' and not t.get('stuck_at') and is_open and (roles['isPic'] or roles['isSupporter'] or roles['isGovernor']):
            return done(_message('This task is not marked as stuck.'))
        if verb == 'note' and isinstance(d.get('note'), str) and d['note'].strip() and TaskHistory.objects.filter(
                task_id=t['id'], kind='note', actor_id=actor, note=d['note'].strip(), created_at__gt=timezone.now() - timedelta(seconds=15)).exists():
            return done(_message('Comment added.'))
        if not applying:
            self.guard(verb, t, roles)
        cr = self.pending_change(t['id'])
        completion = cr if cr and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC' else None
        if not applying and verb == 'reopen' and dm.reopen_needs_approval(t, actor):
            approver = self.approver_for(t, actor, edit=True)
            if approver:
                note = text(nn(d.get('note'), d.get('reason')), _message('Reason for reopening'), 2000, True)
                change_id = self.request_change(t, 'UPDATE', actor, source, approver,
                                                [self.change('status', t['status'], 'REOPENED', dm.task_state_label(t), _message('Reopened'))],
                                                {'reopen': {'note': note}}, note)
                return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                        'message': _message('Sent to {p0} for approval. The task stays {p1} until they approve.', p0=self.name_of(approver), p1=dm.TASK_STATUS[t['status']].lower())}
        if not applying and (verb == 'cancel' or (verb == 'close' and t['status'] != 'IN_REVIEW' and not roles['isPic'])):
            approver = self.approver_for(t, actor)
            if approver:
                cancel = verb == 'cancel'
                note = text(nn(d.get('note'), d.get('reason')), _message('Cancellation reason') if cancel else _message('Closing note'), 1000 if cancel else 2000, cancel)
                change_id = self.request_change(
                    t, 'CANCEL' if cancel else 'COMPLETE', actor, source, approver,
                    [self.change('status', t['status'], 'CANCELLED' if cancel else 'COMPLETED', f"{dm.task_state_label(t)} · {t['progress']}%",
                                 _message('Cancelled') if cancel else 'Completed · 100%')],
                    {'reason': note, 'keep_series': flag(d.get('keep_series'))} if cancel else {'note': note}, note)
                return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                        'message': _message('Sent to {p0} for approval. The task stays open until they approve.', p0=self.name_of(approver))}
        at, changes = now(), {}

        def note_text(label, required, maximum=2000):
            return text(nn(d.get('note'), d.get('reason')), label, maximum, required)
        note, message, tell, kind, title, body, settle, ask_approval, also = '', '', [], '', '', '', None, None, []
        who = self.name_of(actor)
        approved_by = _message(' · approved by {p0}', p0=self.name_of(opts.get('approvedBy'))) if applying else ''
        if verb != 'note':
            changes.update(self.confirm_reviewer(t, roles, at))
            if verb in ('progress', 'stuck', 'resume', 'submit'):
                self.confirm_support(t, roles, actor, at)
        if verb == 'progress':
            if d.get('progress') in (None, ''):
                fail(_message('Enter the progress (0–99%).'))
            progress = integer(d['progress'], 0, 99, _message('progress: 0–99% (close or submit the task when the work is finished)'))
            note = note_text(_message('Progress note'), False)
            if progress == t['progress'] and t['status'] == 'IN_PROGRESS' and not note:
                return done(_message('Progress is already {p0}%.', p0=progress))
            if not applying and progress != t['progress']:
                approver = self.progress_approver(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('progress', t['progress'], progress)],
                                                    {'progress': progress, 'note': note}, note)
                    return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                            'message': _message('Sent to {p0} for approval. Progress stays {p1}% until they approve.', p0=self.name_of(approver), p1=t['progress'])}
            changes.update({'progress': progress, 'status': 'IN_PROGRESS' if t['status'] == 'NOT_STARTED' else t['status']})
            if roles['isPic'] and not t.get('accepted_at'):
                changes.update({'accepted_at': at, 'declined_at': None, 'declined_reason': ''})
            message = _message('Progress updated to {p0}%.', p0=progress)
            if note and not roles['isPic']:
                tell, kind, title, body = [t['pic_id']], 'task_progress', _message('Progress {p0}%: {p1}', p0=progress, p1=t['title']), f'{who}: {note}'
        elif verb == 'stuck':
            note = note_text(_message('What is blocking the task'), True, 1000)
            changes.update({'stuck_at': at, 'stuck_by': actor, 'stuck_reason': note})
            if roles['isPic'] and not t.get('accepted_at'):
                changes['accepted_at'] = at
            message = _message('Task marked as stuck. The people involved have been told.')
            tell, kind, title, body = self.everyone(t), 'task_stuck', f"Stuck: {t['title']}", f'{who}: {note}'
        elif verb == 'resume':
            note = note_text(_message('Note'), False)
            changes.update(CLEARED)
            message = _message('Task resumed.')
            tell, kind, title, body = self.everyone(t), 'task_resumed', f"Resumed: {t['title']}", f'{who}: {note}' if note else _message('{p0} resumed the work', p0=who)
        elif verb == 'submit':
            note = note_text(_message('Note for the reviewer'), False)
            to, approver = t['pic_id'], None
            if roles['isPic']:
                path = dm.completion_path(t)
                approver = (self.approver_for(t, actor) or path['approver']) if dm.two_sided(t) else path['approver']
                to = path['review'] if path['review'] and path['review'] != approver else approver
                if dm.two_sided(t):
                    ask_approval = approver
            changes.update({'status': 'IN_REVIEW', 'submitted_to': to, 'submitted_by': actor, 'submitted_at': at, 'submit_note': note, **CLEARED})
            if not t.get('accepted_at'):
                changes['accepted_at'] = at
            final = bool(ask_approval) and to == approver
            if ask_approval:
                message = (_message('Sent to {p0} to approve completing it.', p0=self.name_of(approver)) if final else
                           _message('Submitted to {p0} for review. {p1} then approves completing it.', p0=self.name_of(to), p1=self.name_of(approver)))
            else:
                message = _message('Submitted to {p0} for review.', p0=self.name_of(to))
            tell, kind = [to], 'task_submitted'
            title = f"{_message('Approval needed') if final else _message('Review requested')}: {t['title']}"
            body = f"{who} {_message('asks to complete the task') if final else _message('submitted the task to you')}{': ' + note if note else ''}"
        elif verb == 'pass':
            note = note_text(_message('Note for the approver'), False)
            approver = (completion or {}).get('approver_id') or dm.completion_path(t)['approver']
            changes['submitted_to'] = approver
            message = _message('Passed to {p0} to approve completing it.', p0=self.name_of(approver))
            tell, kind, title = [approver], 'task_submitted', _message('Approval needed: {p0}', p0=t['title'])
            body = _message('{p0} reviewed the work{p1} · {p2} asks to complete the task', p0=who, p1=': ' + note if note else '', p2=self.name_of(t['submitted_by']))
            also.append(([t['submitted_by']], 'task_passed', f"Reviewed: {t['title']}",
                         _message('{p0} passed your work to {p1} for approval{p2}', p0=who, p1=self.name_of(approver), p2=': ' + note if note else '')))
        elif verb == 'return':
            note = note_text(_message('What still needs to be done'), True)
            changes.update({'status': 'IN_PROGRESS', **UNSUBMITTED})
            if completion:
                settle = (completion, 'REJECTED', note)
            message = _message('Returned to {p0}.', p0=self.name_of(t['submitted_by']))
            tell, kind, title, body = [t['submitted_by'], t['pic_id'], t['submitted_to']], 'task_returned', f"Returned: {t['title']}", f'{who}: {note}'
        elif verb == 'close':
            note = note_text(_message('Closing note'), False)
            changes.update({'status': 'COMPLETED', 'progress': 100, 'completed_at': at, 'closed_by': actor,
                            'accepted_at': t.get('accepted_at') or at, **CLEARED, **UNSUBMITTED})
            if completion:
                settle = (completion, 'APPROVED', note)
            message = _message('Completion approved. The task is completed.') if applying or completion else _message('Task closed as completed.')
            tell, kind, title = [*self.everyone(t), t.get('submitted_by'), t.get('submitted_to')], 'task_closed', f"Completed: {t['title']}"
            body = f"{who} {_message('approved completing the task') if completion else _message('closed the task')}{approved_by}{': ' + note if note else ''}"
        elif verb == 'cancel':
            note = note_text(_message('Cancellation reason'), True, 1000)
            changes.update({'status': 'CANCELLED', 'reason': note, 'closed_by': actor, **CLEARED, **UNSUBMITTED})
            message = _message('Cancellation approved. The task is cancelled.') if applying else _message('Task cancelled.')
            tell, kind, title, body = self.everyone(t), 'task_cancelled', f"Cancelled: {t['title']}", f'{who}: {note}{approved_by}'
        elif verb == 'reopen':
            note = note_text(_message('Reason for reopening'), True)
            changes.update({'status': 'IN_PROGRESS' if t.get('accepted_at') else 'NOT_STARTED',
                            'progress': min(t['progress'], 99) if t.get('accepted_at') else 0, 'completed_at': None, 'closed_by': None, 'reason': ''})
            message = _message('Task reopened.')
            tell, kind, title, body = self.everyone(t), 'task_reopened', f"Reopened: {t['title']}", f'{who}: {note}'
        elif verb == 'note':
            note = text(d.get('note'), _message('Comment'), 2000, True)
            message = _message('Comment added.')
            tell, kind, title, body = [*self.everyone(t), t.get('submitted_to')], 'task_note', _message('Comment on {p0}', p0=t['title']), f'{who}: {note}'
        following = t if verb == 'note' else self.save_row(t, {**changes, 'version': t['version'] + 1, 'updated_at': at})
        history_note = ' · '.join(x for x in (note, _message('approved by {p0}', p0=self.name_of(opts.get('approvedBy')))) if x) if applying else note
        self.history(following, verb, t, actor, source, history_note)
        if settle:
            self.settle_change(settle[0], settle[1], actor, source, settle[2])
        if verb in ('close', 'cancel'):
            self.end_due_requests(following, 'DECLINED', _message('The task was completed') if verb == 'close' else _message('The task was cancelled'), actor)
        if ask_approval:
            self.request_change(following, 'COMPLETE', actor, source, ask_approval,
                                [self.change('status', t['status'], 'COMPLETED', f"{dm.task_state_label(t)} · {t['progress']}%", 'Completed · 100%')],
                                {'note': note}, note, quiet=True)
        next_task = None
        if t.get('recurrence') and not t.get('next_task_id') and (verb == 'close' or (verb == 'cancel' and flag(d.get('keep_series')))):
            next_task = self.schedule_next(following, actor, source)
            message += _message(' The next one is due {p0}.', p0=dm.human(next_task['due_date'])) if next_task else _message(' That was the last one in this series.')
        elif verb == 'cancel' and t.get('recurrence') and not t.get('next_task_id'):
            message += _message(' The series stops here.')
        if kind:
            self.notify(tell, kind, actor, title, body, task=following)
        for ids, k, ti, bo in also:
            self.notify(ids, k, actor, ti, bo, task=following)
        self.log(actor, 'task', t['id'], t['workspace_id'], dm.FLOW_LABELS[verb],
                 f"{t['title']}{' · ' + note if note else ''}{' · ' + str(following['progress']) + '%' if verb == 'progress' else ''}{approved_by}")
        result = {'id': t['id'], 'type': 'tm_task', 'message': message}
        if next_task:
            result['next_id'] = next_task['id']
        return result

    # ------------------------------------------------------------ repeating tasks
    def _ok_assignable(self, staff):
        try:
            self.assignable(staff)
            return True
        except InputError:
            return False

    def schedule_next(self, t, actor, source):
        rule = t.get('recurrence')
        if not rule:
            return None
        base = t.get('scheduled_due') or t['due_date']
        anchor = t.get('series_anchor') or int(base[8:10])
        today = dm.task_today()
        due = scheduled_next(rule, base, anchor, t.get('recurrence_rule'))
        i = 0
        while due and due < today and i < 3700000:
            due = scheduled_next(rule, due, anchor, t.get('recurrence_rule'))
            i += 1
        if not due or (t.get('recurrence_until') and due > t['recurrence_until']):
            return None
        start = dm.add_days(due, -max(0, dm.days_between(t['start_date'], base)))
        if start < today:
            start = today
        reviewer_kept = (t.get('reviewer_status') or 'ACCEPTED') != 'DECLINED' and self._ok_assignable(t['reviewer_id'])
        reviewer = t['reviewer_id'] if reviewer_kept else t['created_by'] if self._ok_assignable(t['created_by']) else actor
        pic_kept = self._ok_assignable(t['pic_id'])
        pic = t['pic_id'] if pic_kept else reviewer
        previous = self._assignee_dicts(t['id'])
        key, stamp = next_id('tm-task', 'TASK'), now()
        n = {'id': key, 'governing_manager_id': t.get('governing_manager_id'), 'visibility': t.get('visibility', 'PUBLIC'), 'workspace_id': t['workspace_id'], 'activity_id': None, 'contact_id': t.get('contact_id'), 'related_type': t.get('related_type') or '',
             'related_id': t.get('related_id'), 'title': t['title'], 'description': t['description'], 'start_date': start, 'due_date': due,
             'status': 'NOT_STARTED', 'priority': t['priority'], 'progress': 0, 'estimate_minutes': t['estimate_minutes'], 'reason': '',
             'created_by': t['created_by'], 'completed_at': None, 'version': 0, 'creation_key': f"series:{t.get('series_id') or t['id']}:{due}",
             'created_at': stamp, 'updated_at': stamp, 'pic_id': pic, 'reviewer_id': reviewer, 'department': t['department'],
             'department_note': t['department_note'],
             'accepted_at': stamp if (pic_kept and t.get('accepted_at') and not t.get('declined_at')) or pic == actor else None,
             'declined_at': None, 'declined_reason': '', **CLEARED, **UNSUBMITTED, 'closed_by': None, 'request_id': None, 'source': source,
             'reviewer_status': (t.get('reviewer_status') or 'ACCEPTED') if reviewer_kept else 'ACCEPTED',
             'reviewer_responded_at': (t.get('reviewer_responded_at') or None) if reviewer_kept else stamp, 'reviewer_note': '',
             'recurrence': rule, 'recurrence_rule': t.get('recurrence_rule') or '{}', 'recurrence_until': t.get('recurrence_until') or None,
             'series_id': t.get('series_id') or t['id'], 'next_task_id': None, 'scheduled_due': due, 'series_anchor': anchor,
             'assigned_by': t.get('assigned_by') or t['created_by'], 'reminder_days': t.get('reminder_days') or '[1]'}
        insert(Task, n)
        pic_row = next((a for a in previous if a['staff_id'] == t['pic_id']), None)
        insert(TaskAssignee, {'task_id': key, 'staff_id': pic, 'status': 'ACCEPTED',
                              'invited_by': ((pic_row or {}).get('invited_by') or t['created_by']) if pic_kept else actor,
                              'invited_at': ((pic_row or {}).get('invited_at') or stamp) if pic_kept else stamp, 'responded_at': None, 'response_note': ''})
        for a in previous:
            if a['staff_id'] not in (t['pic_id'], pic) and a['status'] != 'DECLINED' and self._ok_assignable(a['staff_id']):
                insert(TaskAssignee, {'task_id': key, **a})
        if pic != t['pic_id']:
            self.ensure_member(n['workspace_id'], pic, actor, _message('put in charge of a task'), system=True)
        for i, title in enumerate(ChecklistItem.objects.filter(task_id=t['id']).order_by('position').values_list('title', flat=True)):
            ChecklistItem.objects.create(id=next_id('tm-check', 'CHK'), task_id=key, position=i + 1, title=title, done=False,
                                         created_by_id=actor, created_at=stamp)
        Task.objects.filter(id=t['id']).update(next_task_id=key)
        n = self.task(key)
        self.history(n, 'create', None, actor, source,
                     _message('Repeats {p0} · follows {p1}', p0=dm.RECURRENCE_SHORT[rule], p1=t['id']) + ('' if pic_kept else _message(' · {p0} can no longer be given tasks', p0=self.name_of(t['pic_id']))))
        self.notify([n['pic_id']], 'task_repeat', actor, _message('Next up: {p0}', p0=n['title']),
                    _message('Repeats {p0} · due {p1}{p2}', p0=dm.RECURRENCE_SHORT[rule], p1=dm.human(due), p2='' if n.get('accepted_at') else ' · please accept or reject'), task=n)
        self.log(actor, 'task', key, n['workspace_id'], _message('Repeating task created'), _message('{p0} · due {p1} · follows {p2}', p0=n['title'], p1=due, p2=t['id']))
        return n

    # ------------------------------------------------------------ hand over, reminders
    def handover(self, d, actor, source, opts=None):
        opts = opts or {}
        t = self.task(d.get('id'))
        applying = opts.get('applying')
        if not applying and d.get('expected_version') is not None:
            self.check_version(t, d['expected_version'])
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        if not applying:
            self.guard('handover', t, roles)
        if not d.get('to_id'):
            fail(_message('Choose who should take charge.'))
        to = self.assignable(d['to_id'])
        asked = self.pending_change(t['id'])
        if not applying and asked and asked['requested_by'] == actor:
            payload = parse(asked.get('payload_json') or '{}', {})
            if isinstance(payload, dict) and (payload.get('handover') or {}).get('to_id') == to:
                return {'id': t['id'], 'type': 'tm_task', 'change_id': asked['id'],
                        'message': _message('You already asked to hand this task over to {p0}. Wait for the answer.', p0=self.name_of(to)), 'unchanged': True}
        if to == t['pic_id']:
            fail(_message('Choose someone other than the current person in charge.'))
        self.gov.check_collaborator(actor, self.workspace(t['workspace_id']), to, existing=self.scope.is_involved(to, t))
        note, keep, at = text(d.get('note'), _message('Note'), 1000), flag(d.get('keep')), now()
        approver = None if applying else self.approver_for(t, actor)
        if approver:
            change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('pic_id', t['pic_id'], to)],
                                            {'handover': {'to_id': to, 'keep': keep, 'note': note}}, note)
            return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                    'message': _message('Sent to {p0} for approval. You stay in charge until they approve.', p0=self.name_of(approver))}
        others = [a for a in self._assignee_dicts(t['id']) if a['staff_id'] not in (to, t['pic_id'])]
        TaskAssignee.objects.filter(task_id=t['id']).delete()
        insert(TaskAssignee, {'task_id': t['id'], 'staff_id': to, 'status': 'ACCEPTED', 'invited_by': actor, 'invited_at': at, 'responded_at': None, 'response_note': ''})
        if keep:
            insert(TaskAssignee, {'task_id': t['id'], 'staff_id': t['pic_id'], 'status': 'ACCEPTED', 'invited_by': actor, 'invited_at': at,
                                  'responded_at': at, 'response_note': ''})
        for a in others:
            insert(TaskAssignee, {'task_id': t['id'], **a})
        changes = {'pic_id': to, 'accepted_at': None, 'declined_at': None, 'declined_reason': '', **self.confirm_reviewer(t, roles, at)}
        following = self.save_row(t, {**changes, 'version': t['version'] + 1, 'updated_at': at})
        self.ensure_member(t['workspace_id'], to, actor, _message('given a task by hand-over'))
        approved = _message(' · approved by {p0}', p0=self.name_of(opts.get('approvedBy'))) if applying else ''
        self.history(following, 'handover', t, actor, source, f"{self.name_of(t['pic_id'])} → {self.name_of(to)}{': ' + note if note else ''}{approved}")
        self.notify([to], 'task_assigned', actor, _message('Handed over to you: {p0}', p0=t['title']),
                    _message('{p0} asks you to take charge · due {p1}{p2} · please accept or reject', p0=self.name_of(actor), p1=dm.human(t['due_date']), p2=' · ' + note if note else ''), task=following)
        self.notify([self.active_reviewer(t), dm.assigner_of(t)], 'task_updated', actor, _message('Handed over: {p0}', p0=t['title']),
                    f"{self.name_of(actor)} → {self.name_of(to)}{': ' + note if note else ''}", task=following)
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Task handed over'), f"{t['title']} · {self.name_of(t['pic_id'])} → {self.name_of(to)}")
        return {'id': t['id'], 'type': 'tm_task', 'message': _message('Handed over to {p0}. They are asked to accept it.', p0=self.name_of(to))}

    def remind(self, d, actor, source):
        t = self.task(d.get('id'))
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('remind', t, roles)
        last = TaskHistory.objects.filter(task_id=t['id'], kind='remind').order_by('-id').values_list('created_at', flat=True).first()
        if last and timezone.now() - last < timedelta(minutes=30):
            fail(_message('A reminder was sent less than 30 minutes ago. Please wait a little before sending another.'), 409)
        waiting = [w for w in self.waiting_on(t) if w['staff_id'] != actor]
        who = self.name_of(actor)
        asks = {'pic': _message('to take charge of'), 'supporter': _message('to support'), 'reviewer': _message('to review')}
        for w in waiting:
            self.notify([w['staff_id']], 'task_reminder', actor, f"Reminder: {t['title']}",
                        _message('{p0} is waiting for your answer {p1} this task · due {p2} · please accept or reject', p0=who, p1=asks[w['role']], p2=dm.human(t['due_date'])), task=t)
        names = ', '.join(self.name_of(w['staff_id']) for w in waiting)
        self.history(t, 'remind', t, actor, source, _message('Reminded {p0}', p0=names))
        return {'id': t['id'], 'type': 'tm_task', 'message': _message('Reminder sent to {p0}.', p0=names)}

    def set_reminders(self, d, actor, source):
        t = self.task(d.get('id'))
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('reminders', t, roles)
        chosen = self.reminder_input(d.get('reminder_days'))
        if jtext(chosen) == jtext(dm.reminder_days(t.get('reminder_days'))):
            return {'id': t['id'], 'type': 'tm_task', 'message': _message('Reminders unchanged.'), 'unchanged': True}
        Task.objects.filter(id=t['id']).update(reminder_days=jtext(chosen))
        self.history(t, 'reminders', t, actor, source, dm.reminder_text(chosen))
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Reminders changed'), f"{t['title']} · {dm.reminder_text(chosen)}")
        return {'id': t['id'], 'type': 'tm_task',
                'message': _message('Reminders set: {p0}.', p0=dm.reminder_text(chosen)) if chosen else _message('Deadline reminders are off for this task.')}

    # ------------------------------------------------------------ deciding a change request
    def change_action(self, action, d, actor, source):
        cr = self.find(TaskChangeRequest, d.get('id'))
        t = self.task(cr['task_id'])
        summary = self.change_summary(cr['kind'], parse(cr.get('changes_json') or '[]', []))
        asked = _message('change {p0}', p0=summary) if cr['kind'] == 'UPDATE' else summary
        if action == 'tm.change.withdraw':
            if cr['requested_by'] != actor:
                fail(_message('Only the person who asked for this change can withdraw it.'), 403)
            if cr['status'] == 'WITHDRAWN':
                return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': _message('This request was already withdrawn.'), 'unchanged': True}
            if cr['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            self.active_workspace(t['workspace_id'])
            note = text(d.get('note'), _message('Note'), 1000)
            self.settle_change(cr, 'WITHDRAWN', actor, source, note)
            following = t
            back = cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC' and t['status'] == 'IN_REVIEW'
            if back:
                following = self.save_row(t, {'status': 'IN_PROGRESS', **UNSUBMITTED, 'version': t['version'] + 1, 'updated_at': now()})
            self.history(following, 'change_withdrawn', t, actor, source, _message('Withdrew the request to {p0}{p1}', p0=asked, p1=' · ' + note if note else ''))
            self.notify([cr['approver_id'], t.get('submitted_to') if back else None], 'change_withdrawn', actor, _message('Request withdrawn: {p0}', p0=t['title']),
                        _message('{p0} withdrew the request to {p1}', p0=self.name_of(actor), p1=asked), task=following)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('Change request withdrawn'), f"{t['title']} · {CHANGE_WORD[cr['kind']]}")
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'],
                    'message': _message('Completion request withdrawn. The task is back in progress.') if back else _message('Request withdrawn. Nothing was changed.')}
        if action != 'tm.change.decide':
            fail(_message('Unknown change request action.'), 404)
        decision = choice(d.get('decision'), ['APPROVE', 'REJECT'], _message('decision'))
        if (cr['status'] == 'APPROVED' and decision == 'APPROVE') or (cr['status'] == 'REJECTED' and decision == 'REJECT'):
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': _message('This request was already decided.'), 'unchanged': True}
        if cr['status'] != 'PENDING':
            fail(_message('This request was withdrawn.') if cr['status'] == 'WITHDRAWN' else _message('This request has already been decided.'), 409)
        if d.get('expected_version') is not None:
            self.check_version(cr, d['expected_version'])
        self.active_workspace(t['workspace_id'])
        if actor != cr['approver_id']:
            listed = parse(cr.get('changes_json') or '[]', [])
            progress_only = cr['kind'] == 'UPDATE' and isinstance(listed, list) and bool(listed) and all(x.get('field') == 'progress' for x in listed)
            if self.reachable(cr['approver_id']):
                substitute = None
            elif progress_only:
                substitute = self.progress_approver(t, cr['requested_by'])
            else:
                substitute = self.approver_for(t, cr['requested_by'], edit=cr['kind'] == 'UPDATE')
            if substitute != actor:
                fail(_message('Only {p0} can approve or reject this request.', p0=self.name_of(cr['approver_id'])), 403)
            TaskChangeRequest.objects.filter(id=cr['id']).update(approver_id=actor, updated_at=timezone.now())
            if t['status'] == 'IN_REVIEW' and t.get('submitted_to') == cr['approver_id']:
                Task.objects.filter(id=t['id']).update(submitted_to_id=actor)
            cr['approver_id'] = actor
        if cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC':
            result = self.flow('close' if decision == 'APPROVE' else 'return', {'id': t['id'], 'note': d.get('note')}, actor, source)
            return {**result, 'change_id': cr['id']}
        if decision == 'REJECT':
            note = text(nn(d.get('note'), d.get('reason')), _message('Reason for rejecting'), 1000, True)
            self.settle_change(cr, 'REJECTED', actor, source, note)
            self.history(t, 'change_rejected', t, actor, source, _message('Rejected {p0}’s request to {p1}: {p2}', p0=self.name_of(cr['requested_by']), p1=asked, p2=note))
            self.notify([cr['requested_by']], 'change_rejected', actor, _message('Request rejected: {p0}', p0=t['title']),
                        _message('{p0} rejected your request to {p1}: {p2}', p0=self.name_of(actor), p1=asked, p2=note), task=t)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('Change rejected'), f"{t['title']} · {CHANGE_WORD[cr['kind']]} · {note}")
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': _message('Request rejected. The task is unchanged.')}
        note = text(d.get('note'), _message('Note'), 1000)
        changes = parse(cr.get('changes_json') or '[]', [])
        payload = parse(cr.get('payload_json') or '{}', {})
        if t['status'] not in dm.OPEN_TASK_STATUSES and not (cr['kind'] == 'UPDATE' and t['version'] == cr['base_version']):
            self.settle_change(cr, 'CLOSED', actor, source, _message('The task was already closed'))
            # As in V5.7.7 the refusal rolls the whole command back, so the request itself stays pending.
            fail(_message('This task is already closed, so the change can no longer apply. The request was closed.'), 409)
        stale = [c for c in changes if not same_value(self.current_value(t, c['field']), c['from'])] if cr['kind'] == 'UPDATE' else []
        if stale:
            why = _message('Out of date: {p0} changed after it was asked', p0=', '.join(c['label'].lower() for c in stale))
            self.settle_change(cr, 'CLOSED', actor, source, why)
            self.history(t, 'change_closed', t, actor, source, _message('{p0}’s request to {p1} · {p2}', p0=self.name_of(cr['requested_by']), p1=asked, p2=why))
            self.notify([cr['requested_by']], 'change_rejected', actor, _message('Request closed: {p0}', p0=t['title']),
                        _message('{p0}. Nothing was changed; ask again if it is still needed.', p0=why), task=t)
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'closed': True,
                    'message': _message('{p0}. The request was closed and nothing was changed; {p1} can ask again.', p0=why, p1=self.name_of(cr['requested_by']))}
        self.quiet = actor
        try:
            applying = {'applying': cr, 'approvedBy': actor}
            if cr['kind'] == 'UPDATE' and payload.get('reopen'):
                self.flow('reopen', {'id': t['id'], 'note': payload['reopen'].get('note') or cr['note']}, cr['requested_by'], source, applying)
            elif cr['kind'] == 'UPDATE' and payload.get('handover'):
                h = payload['handover']
                self.handover({'id': t['id'], 'to_id': h.get('to_id'), 'keep': h.get('keep'), 'note': h.get('note')}, cr['requested_by'], source, applying)
            elif cr['kind'] == 'UPDATE' and 'progress' in payload:
                self.flow('progress', {'id': t['id'], 'progress': payload['progress'], 'note': payload.get('note') or ''}, cr['requested_by'], source, applying)
            elif cr['kind'] == 'UPDATE':
                fields = {k: v for k, v in payload.items() if k not in ('handover', 'reopen', 'due_request_id')}
                self.save_task({**self.task_input(t), **fields, 'id': t['id'], 'expected_version': t['version']}, cr['requested_by'], source, applying)
            elif cr['kind'] == 'CANCEL':
                self.flow('cancel', {'id': t['id'], 'reason': payload.get('reason') or cr['note'], 'keep_series': payload.get('keep_series')},
                          cr['requested_by'], source, applying)
            else:
                self.flow('close', {'id': t['id'], 'note': payload.get('note') or cr['note']}, cr['requested_by'], source, applying)
        finally:
            self.quiet = None
        self.settle_change(cr, 'APPROVED', actor, source, note)
        self.notify([cr['requested_by']], 'change_approved', actor, _message('Request approved: {p0}', p0=t['title']),
                    _message('{p0} approved your request to {p1}{p2}', p0=self.name_of(actor), p1=asked, p2=': ' + note if note else ''), task=t)
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Change approved'), _message('{p0} · {p1} · asked by {p2}', p0=t['title'], p1=CHANGE_WORD[cr['kind']], p2=self.name_of(cr['requested_by'])))
        message = (_message('Approved. The task is cancelled.') if cr['kind'] == 'CANCEL' else _message('Approved. The task is completed.') if cr['kind'] == 'COMPLETE'
                   else _message('Approved. The task is reopened.') if payload.get('reopen') else _message('Approved. Progress is now {p0}%.', p0=payload['progress']) if 'progress' in payload
                   else _message('Approved. The change is applied.'))
        return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': message}

    # ------------------------------------------------------------ Steps of Work (checklist)
    def step_count(self, task_id):
        agg = ChecklistItem.objects.filter(task_id=task_id).aggregate(n=Count('id'), done=Count('id', filter=Q(done=True)))
        return {'n': agg['n'] or 0, 'done': agg['done'] or 0}

    def renumber(self, task_id):
        for i, key in enumerate(ChecklistItem.objects.filter(task_id=task_id).order_by('position', 'created_at', 'id').values_list('id', flat=True)):
            ChecklistItem.objects.filter(id=key).update(position=i + 1)

    def checklist(self, action, d, actor, source):
        if action == 'tm.check.add':
            t = self.task(d.get('task_id'))
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            self.guard('checklist', t, roles)
            title = text(d.get('title'), _message('Step'), 300, True)
            twin = ChecklistItem.objects.filter(task_id=t['id'], title=title, created_by_id=actor,
                                                created_at__gt=timezone.now() - timedelta(seconds=15)).values_list('id', flat=True).first()
            if twin:
                return {'id': twin, 'type': 'tm_check', 'message': _message('Step added.'), 'unchanged': True}
            if ChecklistItem.objects.filter(task_id=t['id']).count() >= MAX_CHECKS:
                fail(_message('A task can have up to {p0} steps.', p0=MAX_CHECKS))
            key = next_id('tm-check', 'CHK')
            position = (ChecklistItem.objects.filter(task_id=t['id']).aggregate(p=Max('position'))['p'] or 0) + 1
            ChecklistItem.objects.create(id=key, task_id=t['id'], position=position, title=title, done=False, created_by_id=actor, created_at=timezone.now())
            self.after_checklist(t, roles, actor, source, _message('Added step “{p0}”', p0=title))
            return {'id': key, 'type': 'tm_check', 'message': _message('Step added.')}
        item = self.find(ChecklistItem, d.get('id'))
        t = self.task(item['task_id'])
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('checklist', t, roles)
        if action == 'tm.check.toggle':
            done = flag(d.get('done'))
            if bool(item['done']) == done:
                return {'id': item['id'], 'type': 'tm_check', 'message': _message('This step is already completed.') if done else _message('This step is already open.'), 'unchanged': True}
            ChecklistItem.objects.filter(id=item['id']).update(done=done, done_by_id=actor if done else None, done_at=timezone.now() if done else None)
            c = self.step_count(t['id'])
            following = self.after_checklist(t, roles, actor, source, f"{_message('Completed') if done else _message('Reopened')} step “{item['title']}”")
            if done:
                self.notify([dm.assigner_of(t)], 'step_completed', actor, _message('Step completed: {p0}', p0=t['title']),
                            _message('{p0} completed “{p1}” · {p2} of {p3} steps completed', p0=self.name_of(actor), p1=clip(item['title'], 120), p2=c['done'], p3=c['n']), task=following)
            return {'id': item['id'], 'type': 'tm_check',
                    'message': _message('Step completed ({p0} of {p1}).', p0=c['done'], p1=c['n']) if done else _message('Step reopened ({p0} of {p1} completed).', p0=c['done'], p1=c['n'])}
        if action == 'tm.check.rename':
            title = text(d.get('title'), _message('Step'), 300, True)
            if title == item['title']:
                return {'id': item['id'], 'type': 'tm_check', 'message': _message('No change.'), 'unchanged': True}
            ChecklistItem.objects.filter(id=item['id']).update(title=title)
            self.after_checklist(t, roles, actor, source, _message('Renamed step “{p0}” to “{p1}”', p0=item['title'], p1=title))
            return {'id': item['id'], 'type': 'tm_check', 'message': _message('Step renamed.')}
        if action == 'tm.check.move':
            order = list(ChecklistItem.objects.filter(task_id=t['id']).order_by('position', 'created_at', 'id').values_list('id', flat=True))
            start = order.index(item['id'])
            if d.get('direction') == 'up':
                to = start - 1
            elif d.get('direction') == 'down':
                to = start + 1
            else:
                to = integer(d.get('position'), 1, len(order), _message('step position')) - 1
            if to < 0 or to >= len(order) or to == start:
                return {'id': item['id'], 'type': 'tm_check', 'message': _message('The step is already there.'), 'unchanged': True}
            order.pop(start)
            order.insert(to, item['id'])
            for i, key in enumerate(order):
                ChecklistItem.objects.filter(id=key).update(position=i + 1)
            self.after_checklist(t, roles, actor, source, _message('Moved step “{p0}” to position {p1}', p0=item['title'], p1=to + 1))
            return {'id': item['id'], 'type': 'tm_check', 'message': _message('Step moved to position {p0}.', p0=to + 1)}
        if action == 'tm.check.remove':
            ChecklistItem.objects.filter(id=item['id']).delete()
            self.renumber(t['id'])
            self.after_checklist(t, roles, actor, source, _message('Removed step “{p0}”', p0=item['title']))
            return {'id': t['id'], 'type': 'tm_task', 'message': _message('Step removed.')}
        fail(_message('Unknown step action.'), 404)

    def after_checklist(self, t, roles, actor, source, note):
        c, at = self.step_count(t['id']), now()
        changes = dict(self.confirm_reviewer(t, roles, at))
        self.confirm_support(t, roles, actor, at)
        if (roles['isPic'] or roles['isSupporter']) and t['status'] == 'NOT_STARTED' and c['done'] > 0:
            changes['status'] = 'IN_PROGRESS'
            if roles['isPic'] and not t.get('accepted_at'):
                changes.update({'accepted_at': at, 'declined_at': None, 'declined_reason': ''})
        following = t
        if changes:
            following = self.save_row(t, {**changes, 'version': t['version'] + 1, 'updated_at': at})
        self.history(following, 'checklist', t, actor, source, _message('{p0} · {p1} of {p2} steps completed', p0=note, p1=c['done'], p2=c['n']))
        self.log(actor, 'task', t['id'], t['workspace_id'], _message('Steps of work updated'), f"{t['title']} · {note}")
        return following

    # ------------------------------------------------------------ files and photos
    @staticmethod
    def decode(value, maximum, message):
        if not isinstance(value, str) or not value or len(value) > -(-maximum * 4 // 3) + 8 or not BASE64.match(value):
            fail(message)
        # Decoded as Node's Buffer.from(value, 'base64') does: padding optional, a dangling last character ignored.
        body = value.rstrip('=')
        if len(body) % 4 == 1:
            body = body[:-1]
        try:
            content = base64.b64decode(body + '=' * (-len(body) % 4))
        except (binascii.Error, ValueError):
            fail(message)
        if not content or len(content) > maximum:
            fail(message)
        return content

    def files(self, action, d, actor, source):
        if action == 'tm.file.add':
            t = self.task(d.get('task_id'))
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            self.guard('file', t, roles)
            name = clean_file_name(text(d.get('name'), _message('File name'), 160, True))
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ext not in dm.TASK_FILE_TYPES:
                fail(_message('Attach a PDF, image (JPG, PNG, WebP, GIF, HEIC), Word, Excel, PowerPoint, CSV, TXT or ZIP file.'))
            content = self.decode(d.get('base64'), MAX_FILE, _message('Choose a file between 1 byte and 30 MB.'))
            if not content_matches(ext, content):
                fail(_message('This file is not a real {p0} file. Choose the original file.', p0=ext.upper()))
            if TaskFile.objects.filter(task_id=t['id']).count() >= MAX_FILES:
                fail(_message('A task can have up to {p0} files. Remove one first.', p0=MAX_FILES))
            key = next_id('tm-file', 'FILE')
            TaskFile.objects.create(id=key, task_id=t['id'], name=name, mime=dm.TASK_FILE_TYPES[ext], size=len(content), content=content,
                                    uploaded_by_id=actor, source=source, created_at=timezone.now())
            self.history(t, 'file', t, actor, source, name)
            self.notify([t['pic_id'], self.active_reviewer(t), dm.assigner_of(t)], 'task_file', actor, _message('File added: {p0}', p0=t['title']),
                        _message('{p0} attached {p1}', p0=self.name_of(actor), p1=name), task=t)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('File attached'), f"{t['title']} · {name}")
            return {'id': key, 'type': 'tm_file', 'task_id': t['id'], 'message': f'{name} attached.'}
        if action == 'tm.file.remove':
            f = self.find(TaskFile, d.get('id'))
            t = self.task(f['task_id'])
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            if f['uploaded_by'] != actor and not roles['isGovernor']:
                fail(_message('Only the person who added this file or the task’s manager can remove it.'), 403)
            if t['status'] not in dm.OPEN_TASK_STATUSES:
                fail(_message('This task is closed, so its files are kept. Reopen it first to remove a file.'), 409)
            TaskFile.objects.filter(id=f['id']).delete()
            self.history(t, 'file_removed', t, actor, source, f['name'])
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('File removed'), f"{t['title']} · {f['name']}")
            return {'id': t['id'], 'type': 'tm_task', 'message': f"{f['name']} removed."}
        fail(_message('Unknown file action.'), 404)

    def set_photo(self, staff, value, actor):
        b = self.decode(value, MAX_PHOTO, _message('Choose a JPEG, PNG or WebP photo up to 2 MB.'))
        if b[:3] == b'\xff\xd8\xff':
            mime = 'image/jpeg'
        elif b[:8] == b'\x89PNG\r\n\x1a\n':
            mime = 'image/png'
        elif b[:4] == b'RIFF' and b[8:12] == b'WEBP':
            mime = 'image/webp'
        else:
            fail(_message('Choose a JPEG, PNG or WebP photo up to 2 MB.'))
        old = StaffPhoto.objects.filter(staff_id=staff).first()
        if old:
            StaffPhoto.objects.filter(staff_id=staff).update(mime=mime, size=len(b), content=b, version=old.version + 1,
                                                             updated_by_id=actor, updated_at=timezone.now())
        else:
            StaffPhoto.objects.create(staff_id=staff, mime=mime, size=len(b), content=b, version=1, updated_by_id=actor, updated_at=timezone.now())

    @staticmethod
    def remove_photo(staff, actor):
        old = StaffPhoto.objects.filter(staff_id=staff, size__gt=0).first()
        if not old:
            return 0
        StaffPhoto.objects.filter(staff_id=staff).update(mime='', size=0, content=b'', version=old.version + 1, updated_by_id=actor, updated_at=timezone.now())
        return 1

    def _profile_upsert(self, staff, **fields):
        p = Profile.objects.filter(staff_id=staff).first()
        if p:
            Profile.objects.filter(staff_id=staff).update(**fields)
        else:
            Profile.objects.create(staff_id=staff, **fields)

    def me(self, action, d, actor):
        if action == 'me.profile.save':
            if 'name' in d and text(d['name'], _message('Display name'), 200, True) != self.canonical_name(actor):
                fail(_message('Your display name comes from your username. Ask an administrator to change it.'), 403)
            if 'nickname' in d:
                nickname = text(d['nickname'], _message('Nickname'), 80)
                p = Profile.objects.filter(staff_id=actor).first()
                self._profile_upsert(actor, nickname=nickname, **({'version': p.version + 1} if p else {}))
                self.log(actor, 'user', actor, None, _message('Nickname changed'), nickname)
                return {'id': actor, 'type': 'me', 'message': _message('Your nickname is saved.')}
            if 'sidebar_theme' in d:
                theme = '' if d['sidebar_theme'] in ('', 'blue') else choice(d['sidebar_theme'], SIDEBAR_THEMES, _message('Sidebar colour'))
                before = Profile.objects.filter(staff_id=actor).values_list('sidebar_theme', flat=True).first() or ''
                if theme != before:
                    self._profile_upsert(actor, sidebar_theme=theme)
                if 'name' not in d and 'timezone' not in d:
                    return {'id': actor, 'type': 'me', 'message': _message('Your sidebar colour is saved.') if theme != before else _message('Your sidebar colour is unchanged.'),
                            **({} if theme != before else {'unchanged': True})}
            if 'timezone' in d:
                zone = self.zone_input(d['timezone'])
                before = Profile.objects.filter(staff_id=actor).values_list('timezone', flat=True).first() or ''
                zone_changed = False
                if zone != before:
                    self._profile_upsert(actor, timezone=zone)
                    self.log(actor, 'user', actor, None, _message('Time zone changed'), f"{before or _message('company time zone')} → {zone or _message('company time zone')}")
                    zone_changed = True
                if 'name' not in d:
                    return {'id': actor, 'type': 'me', 'message': _message('Your time zone is saved.') if zone_changed else _message('Your time zone is unchanged.'),
                            **({} if zone_changed else {'unchanged': True})}
            return {'id': actor, 'type': 'me', 'message': _message('Your profile is unchanged.'), 'unchanged': True}
        if action == 'me.photo.save':
            self.set_photo(actor, d.get('base64'), actor)
            self.log(actor, 'user', actor, None, _message('Profile photo changed'), self.name_of(actor))
            return {'id': actor, 'type': 'me', 'message': _message('Your photo is saved.')}
        if action == 'me.photo.remove':
            n = self.remove_photo(actor, actor)
            if n:
                self.log(actor, 'user', actor, None, _message('Profile photo removed'), self.name_of(actor))
            return {'id': actor, 'type': 'me', 'message': _message('Your photo is removed.') if n else _message('You have no photo.')}
        fail(_message('Unknown profile action.'), 404)

    # ------------------------------------------------------------ task requests (anyone can ask anyone)
    def receiver_for(self, staff, requester):
        if not staff:
            fail(_message('Choose the person you are asking.'))
        m = self.assignable(staff)
        if m == requester:
            fail(_message('Choose someone else. You can’t send a request to yourself.'))
        if not self.account_of(m):
            fail(_message('{p0} has no Task Controlling Management login, so they can’t answer requests. Choose someone who uses the Task Controlling Management.', p0=self.name_of(m)))
        return m

    def request(self, action, d, actor, source):
        if action == 'tm.request.save':
            old = self.find(TaskRequest, d['id']) if d.get('id') else None
            if old:
                self.check_version(old, d.get('expected_version'))
                if old['requested_by'] != actor:
                    fail(_message('Only the person who made this request can change it.'), 403)
                if old['status'] != 'PENDING':
                    fail(_message('This request has already been decided.'), 409)
            creation_key = f"{actor}:{text(d['request_key'], _message('Creation key'), 100, True)}" if not old and d.get('request_key') else None
            if creation_key:
                duplicate = TaskRequest.objects.filter(creation_key=creation_key).values_list('id', flat=True).first()
                if duplicate:
                    return {'id': duplicate, 'type': 'tm_request', 'message': _message('Request already sent.')}
            receiver = self.receiver_for(d.get('manager_id'), actor)
            wid = self.active_workspace(d['workspace_id'])['id'] if d.get('workspace_id') else None
            if (not old or old['manager_id'] != receiver) and TaskRequest.objects.filter(requested_by_id=actor, manager_id=receiver, status='PENDING').count() >= 20:
                fail(_message('You already have 20 requests waiting for {p0}. Wait for answers, or withdraw some first.', p0=self.name_of(receiver)), 429)
            if wid:
                w = self.workspace(wid)
                if not old and not self.gov.can_create_resource(actor, w):
                    fail(_message('Join this workspace before requesting work in it.'), 403)
                self.gov.check_collaborator(actor, w, receiver, existing=bool(old) and old['manager_id'] == receiver and old['workspace_id'] == wid)
            proposed = date_text(d['proposed_due_date'], _message('Proposed due date')) if d.get('proposed_due_date') else None
            if proposed and proposed < dm.task_today() and proposed != (old or {}).get('proposed_due_date'):
                fail(_message('Choose a “needed by” date from today on.'))
            doer = ((old or {}).get('doer') or 'REQUESTER') if d.get('doer') in (None, '') else choice(d['doer'], ['RECEIVER', 'REQUESTER', 'DECIDE'], _message('option for who does the work'))
            key = old['id'] if old else next_id('tm-request', 'REQ')
            visibility = d.get('visibility', (old or {}).get('visibility', 'PUBLIC'))
            if visibility not in ('PUBLIC', 'ORGANIZATIONAL'):
                fail(_message('Requests involve another person. Choose Public or Organizational.'), 422)
            if visibility == 'ORGANIZATIONAL' and (not wid or self.workspace(wid)['kind'] != 'ORGANIZATIONAL'):
                fail(_message('Choose an Organizational Workspace for this request.'), 422)
            from .policy import validate_manager
            manager_scope = validate_manager(self.gov, actor, {**({'governing_manager_id': old.get('governing_manager_id')} if old else {}), **d}, None, self.workspace(wid) if wid else None, visibility)
            values = {'governing_manager_id': manager_scope, 'visibility': visibility, 'workspace_id': wid, 'title': text(d.get('title'), _message('Request title'), 300, True),
                      'description': text(d.get('description'), _message('Expectation'), 8000, not old),
                      'department': text(nn(d.get('department'), ''), _message('Department'), 150),
                      'department_note': text(nn(d.get('department_note'), ''), _message('Department note'), 2000),
                      'priority': choice(d.get('priority') or 'MEDIUM', ['HIGH', 'MEDIUM', 'LOW'], _message('priority')), 'proposed_due_date': proposed,
                      'manager_id': receiver, 'doer': doer, 'version': old['version'] + 1 if old else 0, 'updated_at': now()}
            if old:
                update(TaskRequest, key, values)
            else:
                insert(TaskRequest, {'id': key, **values, 'requested_by': actor, 'status': 'PENDING', 'source': source,
                                     'creation_key': creation_key, 'created_at': now()})
            q = self.find(TaskRequest, key)
            ask = _message('asks you to do this task') if doer == 'RECEIVER' else _message('asks to take on this task') if doer == 'REQUESTER' else _message('asks for this task')
            if not old or old['manager_id'] != receiver:
                self.notify([receiver], 'request_new', actor, _message('Task request: {p0}', p0=q['title']),
                            f"{self.name_of(actor)} {ask}{_message(' · needed by ') + dm.human(proposed) if proposed else ''}", request=q)
            self.log(actor, 'request', key, wid, _message('Task request updated') if old else _message('Task requested'), _message('{p0} · to {p1}', p0=q['title'], p1=self.name_of(receiver)))
            return {'id': key, 'type': 'tm_request', 'message': _message('Request updated.') if old else _message('Request sent to {p0}.', p0=self.name_of(receiver))}
        q = self.find(TaskRequest, d.get('id'))
        if not self.scope.can_see_request(actor, q):
            fail(NOT_FOUND, 404)
        if action == 'tm.request.withdraw':
            if q['requested_by'] != actor:
                fail(_message('Only the person who made this request can withdraw it.'), 403)
            if q['status'] == 'WITHDRAWN':
                return {'id': q['id'], 'type': 'tm_request', 'message': _message('This request was already withdrawn.'), 'unchanged': True}
            if q['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            update(TaskRequest, q['id'], {'status': 'WITHDRAWN', 'decision_note': text(d.get('note'), _message('Note'), 1000), 'version': q['version'] + 1, 'updated_at': now()})
            self.notify([q['manager_id']], 'request_withdrawn', actor, _message('Request withdrawn: {p0}', p0=q['title']), _message('{p0} withdrew the request', p0=self.name_of(actor)), request=q)
            self.log(actor, 'request', q['id'], q['workspace_id'], _message('Task request withdrawn'), q['title'])
            return {'id': q['id'], 'type': 'tm_request', 'message': _message('Request withdrawn.')}
        if action == 'tm.request.forward':
            if q['manager_id'] != actor:
                fail(_message('Only the person this request was sent to can pass it on.'), 403)
            if q['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            if d.get('manager_id') and d['manager_id'] == q['requested_by']:
                fail(_message('{p0} asked for this task. To give it back, decline it with a note instead.', p0=self.name_of(q['requested_by'])))
            receiver = self.receiver_for(d.get('manager_id'), q['requested_by'])
            if receiver == actor:
                fail(_message('Choose someone else to pass it to.'))
            if q['workspace_id']:
                w = self.workspace(q['workspace_id'])
                if w['status'] != 'ACTIVE':
                    fail(_message('Restore the workspace before changing its work.'))
                self.gov.check_collaborator(actor, w, receiver)
            note = text(d.get('note'), _message('Note'), 1000)
            update(TaskRequest, q['id'], {'manager_id': receiver, 'version': q['version'] + 1, 'updated_at': now()})
            self.notify([receiver], 'request_new', actor, _message('Task request: {p0}', p0=q['title']),
                        _message('{p0} passed on a request from {p1}{p2}', p0=self.name_of(actor), p1=self.name_of(q['requested_by']), p2=': ' + note if note else ''), request=q)
            self.notify([q['requested_by']], 'request_forwarded', actor, _message('Request passed on: {p0}', p0=q['title']),
                        _message('{p0} passed your request to {p1}', p0=self.name_of(actor), p1=self.name_of(receiver)), request=q)
            self.log(actor, 'request', q['id'], q['workspace_id'], _message('Task request passed on'), _message('{p0} · to {p1}', p0=q['title'], p1=self.name_of(receiver)))
            return {'id': q['id'], 'type': 'tm_request', 'message': _message('Request passed to {p0}.', p0=self.name_of(receiver))}
        if action == 'tm.request.decide':
            decision = choice(d.get('decision'), ['APPROVE', 'DECLINE'], _message('decision'))
            if q['manager_id'] != actor:
                fail(_message('Only the person this request was sent to can decide it.'), 403)
            if q['status'] == 'APPROVED' and decision == 'APPROVE':
                return {'id': q['task_id'], 'type': 'tm_task', 'message': _message('This request was already accepted.'), 'unchanged': True}
            if q['status'] == 'DECLINED' and decision == 'DECLINE':
                return {'id': q['id'], 'type': 'tm_request', 'message': _message('This request was already declined.'), 'unchanged': True}
            if q['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            if decision == 'DECLINE':
                note = text(d.get('note'), _message('Reason for declining'), 1000, True)
                update(TaskRequest, q['id'], {'status': 'DECLINED', 'decision_note': note, 'decided_by': actor, 'decided_at': now(),
                                              'version': q['version'] + 1, 'updated_at': now()})
                self.notify([q['requested_by']], 'request_declined', actor, _message('Request declined: {p0}', p0=q['title']), f'{self.name_of(actor)}: {note}', request=q)
                self.log(actor, 'request', q['id'], q['workspace_id'], _message('Task request declined'), f"{q['title']} · {note}")
                return {'id': q['id'], 'type': 'tm_request', 'message': _message('Request declined. The requester has been told.')}
            wid = d.get('workspace_id') or q['workspace_id']
            if not wid:
                fail(_message('Choose the workspace for this task.'))
            doer = q.get('doer') or 'REQUESTER'
            pic = d.get('pic_id') or (actor if doer == 'RECEIVER' else q['requested_by'] if doer == 'REQUESTER' else None)
            if not pic:
                fail(_message('Choose the person in charge of this task.'))
            reviewer = d.get('reviewer_id') or (q['requested_by'] if doer == 'RECEIVER' else actor)
            due = d.get('due_date') or q['proposed_due_date']
            if not due:
                fail(_message('Choose a due date for this task.'))
            due_day = date_text(due, _message('Due date'))
            start = d.get('start_date') or (dm.task_today() if dm.task_today() <= due_day else due_day)
            requester_does = pic == q['requested_by'] and doer == 'REQUESTER'
            if d.get('visibility', q.get('visibility', 'PUBLIC')) not in ('PUBLIC', 'ORGANIZATIONAL'):
                fail(_message('Task requests must remain visible to their responsible participants.'), 422)
            created = self.save_task(
                {'governing_manager_id': d.get('governing_manager_id', q.get('governing_manager_id')), 'visibility': d.get('visibility', q.get('visibility', 'PUBLIC')), 'workspace_id': wid, 'title': d.get('title') or q['title'], 'description': nn(d.get('description'), q['description']),
                 'start_date': start, 'due_date': due_day, 'priority': d.get('priority') or q['priority'], 'estimate': d.get('estimate') or '0:00',
                 'pic_id': pic, 'supporter_ids': d.get('supporter_ids') or [], 'reviewer_id': reviewer,
                 'department': nn(d.get('department'), q['department'] or None), 'department_note': nn(d.get('department_note'), q['department_note']),
                 'recurrence': d.get('recurrence'), **({'recurrence_until': d['recurrence_until']} if 'recurrence_until' in d else {}),
                 'checklist': d.get('checklist')},
                actor, source, {'creationKey': 'request:' + q['id'], 'requestId': q['id'], 'accepted': requester_does, 'quietPic': requester_does,
                                'memberAuthority': q['requested_by'],
                                'reviewerAccepted': reviewer if doer == 'RECEIVER' and reviewer == q['requested_by'] else None,
                                'assignedBy': q['requested_by'] if pic == actor else actor})
            note = text(d.get('note'), _message('Note'), 1000)
            update(TaskRequest, q['id'], {'status': 'APPROVED', 'task_id': created['id'], 'decision_note': note, 'decided_by': actor, 'decided_at': now(),
                                          'version': q['version'] + 1, 'updated_at': now()})
            who = _message('you are in charge') if pic == q['requested_by'] else _message('{p0} will do it', p0=self.name_of(actor)) if pic == actor else _message('in charge: ') + self.name_of(pic)
            self.notify([q['requested_by']], 'request_approved', actor, _message('Request accepted: {p0}', p0=q['title']),
                        _message('{p0} accepted it as {p1} · {p2} · due {p3}{p4}', p0=self.name_of(actor), p1=created['id'], p2=who, p3=dm.human(due_day), p4=' · ' + note if note else ''),
                        request=q, task={'id': created['id']})
            self.log(actor, 'request', q['id'], wid, _message('Task request accepted'), f"{q['title']} · {created['id']}")
            return {'id': created['id'], 'type': 'tm_task', 'message': _message('Request accepted as {p0}.', p0=created['id'])}
        fail(_message('Unknown task request action.'), 404)

    # ------------------------------------------------------------ due date change requests
    def due_request(self, action, d, actor, source):
        if action == 'tm.due.request':
            t = self.task(d.get('task_id'))
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            self.guard('due', t, roles)
            proposed = date_text(d.get('proposed_due_date'), _message('New due date'))
            if proposed < t['start_date']:
                fail(_message('The new due date cannot be before the start date.'))
            if proposed == t['due_date']:
                fail(_message('Choose a date that differs from the current due date.'))
            reason = text(d.get('reason'), _message('Reason'), 1000, True)
            if roles['isPic'] and dm.two_sided(t):
                approver = self.approver_for(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('due_date', t['due_date'], proposed)],
                                                    {'due_date': proposed}, reason)
                    return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                            'message': _message('Sent to {p0} for approval. The due date stays {p1} until they approve.', p0=self.name_of(approver), p1=dm.human(t['due_date']))}
            decider, key = dm.due_decider(t), next_id('tm-due', 'DUE')
            self.confirm_support(t, roles, actor, now())
            insert(DueDateRequest, {'id': key, 'task_id': t['id'], 'requested_by': actor, 'decide_by': decider, 'current_due_date': t['due_date'],
                                    'proposed_due_date': proposed, 'reason': reason, 'status': 'PENDING', 'source': source,
                                    'created_at': now(), 'updated_at': now()})
            self.history(t, 'due_request', t, actor, source, f"{t['due_date']} → {proposed}: {reason}")
            q = self.find(DueDateRequest, key)
            self.notify([decider], 'due_new', actor, _message('New due date requested: {p0}', p0=t['title']),
                        _message('{p0} asks to move it from {p1} to {p2}: {p3}', p0=self.name_of(actor), p1=dm.human(t['due_date']), p2=dm.human(proposed), p3=reason), task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('New due date requested'), f"{t['due_date']} → {proposed} · {reason}")
            return {'id': key, 'type': 'tm_due_request', 'message': _message('Request sent to {p0}.', p0=self.name_of(decider))}
        q = self.find(DueDateRequest, d.get('id'))
        t = self.task(q['task_id'])
        if action == 'tm.due.withdraw':
            if q['requested_by'] != actor:
                fail(_message('Only the person who asked can withdraw this request.'), 403)
            if q['status'] == 'WITHDRAWN':
                return {'id': q['id'], 'type': 'tm_due_request', 'message': _message('Already withdrawn.'), 'unchanged': True}
            if q['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            update(DueDateRequest, q['id'], {'status': 'WITHDRAWN', 'version': q['version'] + 1, 'updated_at': now()})
            self.history(t, 'due_withdrawn', t, actor, source, f"{q['current_due_date']} → {q['proposed_due_date']} withdrawn")
            self.notify([q['decide_by']], 'task_updated', actor, _message('Due date request withdrawn: {p0}', p0=t['title']),
                        _message('{p0} withdrew the request to move it to {p1}', p0=self.name_of(actor), p1=dm.human(q['proposed_due_date'])), task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('Due date request withdrawn'), f"{q['current_due_date']} → {q['proposed_due_date']}")
            return {'id': q['id'], 'type': 'tm_due_request', 'message': _message('Due date request withdrawn.')}
        if action == 'tm.due.decide':
            decision = choice(d.get('decision'), ['APPROVE', 'DECLINE'], _message('decision'))
            if q['decide_by'] != actor and dm.due_decider(t) != actor and not (self.can_approve(actor) and self.scope.is_involved(actor, t)):
                fail(_message('Only the task’s reviewer or a task approver on this task can decide this request.'), 403)
            if (q['status'] == 'APPROVED' and decision == 'APPROVE') or (q['status'] == 'DECLINED' and decision == 'DECLINE'):
                return {'id': q['id'], 'type': 'tm_due_request', 'message': _message('This request was already decided.'), 'unchanged': True}
            if q['status'] != 'PENDING':
                fail(_message('This request has already been decided.'), 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            self.active_workspace(t['workspace_id'])
            note = text(d.get('note'), _message('Reason for declining') if decision == 'DECLINE' else _message('Note'), 1000, decision == 'DECLINE')
            update(DueDateRequest, q['id'], {'status': 'APPROVED' if decision == 'APPROVE' else 'DECLINED', 'decision_note': note, 'decided_by': actor,
                                             'decided_at': now(), 'version': q['version'] + 1, 'updated_at': now()})
            confirm = self.confirm_reviewer(t, self.roles_for(t, actor), now())
            if decision == 'APPROVE':
                if t['status'] not in dm.OPEN_TASK_STATUSES:
                    fail(_message('This task is closed, so its due date can no longer change.'), 409)
                if q['proposed_due_date'] < t['start_date']:
                    fail(_message('The new due date is before the task’s start date.'), 409)
                approver = self.approver_for(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('due_date', t['due_date'], q['proposed_due_date'])],
                                                    {'due_date': q['proposed_due_date'], 'due_request_id': q['id']},
                                                    f"{self.name_of(q['requested_by'])} asked: {q['reason']}")
                    update(DueDateRequest, q['id'], {'decision_note': ' · '.join(x for x in (note, _message('sent to {p0} for approval', p0=self.name_of(approver))) if x)})
                    self.notify([q['requested_by']], 'due_approved', actor, _message('New due date agreed: {p0}', p0=t['title']),
                                _message('{p0} agreed to {p1}; {p2} approves it before it applies', p0=self.name_of(actor), p1=dm.human(q['proposed_due_date']), p2=self.name_of(approver)), task=t, due=q)
                    self.log(actor, 'task', t['id'], t['workspace_id'], _message('Due date change agreed'),
                             _message('{p0} → {p1} · sent to {p2}', p0=t['due_date'], p1=q['proposed_due_date'], p2=self.name_of(approver)))
                    return {'id': q['id'], 'type': 'tm_due_request', 'change_id': change_id,
                            'message': _message('Agreed. {p0} approves the new date before it applies.', p0=self.name_of(approver))}
                plan = ({'scheduled_due': t['due_date'], 'series_anchor': t.get('series_anchor') or int(t['due_date'][8:10])}
                        if t.get('recurrence') and not t.get('scheduled_due') else {})
                following = self.save_row(t, {**confirm, **plan, 'due_date': q['proposed_due_date'], 'version': t['version'] + 1, 'updated_at': now()})
                self.history(following, 'due_change', t, actor, source, f"{t['due_date']} → {following['due_date']}{': ' + note if note else ''}")
                self.notify([q['requested_by'], t['pic_id'], *self.supporters_of(t)], 'due_approved', actor, _message('Due date moved: {p0}', p0=t['title']),
                            _message('{p0} approved {p1} (was {p2})', p0=self.name_of(actor), p1=dm.human(following['due_date']), p2=dm.human(t['due_date'])), task=following, due=q)
                self.log(actor, 'task', t['id'], t['workspace_id'], _message('Due date change approved'), f"{t['due_date']} → {following['due_date']}")
                return {'id': q['id'], 'type': 'tm_due_request', 'message': _message('Due date changed to {p0}.', p0=following['due_date'])}
            if confirm:
                self.save_row(t, {**confirm, 'version': t['version'] + 1, 'updated_at': now()})
            self.history(t, 'due_declined', t, actor, source, f"{q['proposed_due_date']} declined: {note}")
            self.notify([q['requested_by']], 'due_declined', actor, _message('Due date request declined: {p0}', p0=t['title']), f'{self.name_of(actor)}: {note}', task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], _message('Due date change declined'), note)
            return {'id': q['id'], 'type': 'tm_due_request', 'message': _message('Due date request declined.')}
        fail(_message('Unknown due date action.'), 404)

    # ------------------------------------------------------------ deadline reminders (worker, every few minutes)
    def due_reminders(self, at=None):
        at = at or datetime.now(dt_timezone.utc)
        today = dm.local_day(at)
        if at.astimezone(dm.CAMBODIA).hour < 7:
            return 0
        sent = 0

        def send(t, staff, key, kind, title, body):
            nonlocal sent
            if not staff or TaskReminderSent.objects.filter(task_id=t['id'], staff_id=staff, kind=key, due_date=t['due_date']).exists():
                return
            TaskReminderSent.objects.create(task_id=t['id'], staff_id=staff, kind=key, due_date=t['due_date'], created_at=timezone.now())
            Notification.objects.create(staff_id=staff, kind=kind, task_id=t['id'], title=title, body=body, actor_id=None, created_at=timezone.now())
            sent += 1
        # Same order as V5.7.7 (its query walks the workspace, status and due date index).
        for t in rows(Task.objects.filter(workspace__status='ACTIVE', status__in=dm.OPEN_TASK_STATUSES, due_date__lte=dm.add_days(today, 90))
                      .order_by('workspace_id', 'status', 'due_date', 'id')):
            days = dm.days_between(today, t['due_date'])
            if days >= 1:
                chosen = [x for x in dm.reminder_days(t.get('reminder_days')) if x >= days]
                if not chosen:
                    continue
                n = chosen[-1]
                key = 'task_due_soon' if n == 1 else f'due_in_{n}'
                when = _message('Due tomorrow') if days == 1 else _message('Due in {p0} days', p0=days)
                workers = [x for x in [None if t.get('declined_at') else t['pic_id'], *self.supporters_of(t)] if x]
                state = (_message('{p0}% done', p0=t['progress']) + (_message(' · waiting for review') if t['status'] == 'IN_REVIEW' else _message(' · stuck') if t.get('stuck_at')
                                                     else _message(' · not accepted yet') if not t.get('accepted_at') else ''))
                for s in dict.fromkeys(workers):
                    send(t, s, key, 'task_due_soon', _message('{p0}: {p1}', p0=when, p1=t['title']), _message('{p0} · {p1}', p0=dm.human(t['due_date']), p1=state))
                for s in dict.fromkeys([dm.assigner_of(t), self.active_reviewer(t)]):
                    if s and s not in workers:
                        send(t, s, key, 'task_due_soon', _message('{p0}: {p1}', p0=when, p1=t['title']), _message('{p0} · {p1} is in charge · {p2}', p0=dm.human(t['due_date']), p1=self.name_of(t['pic_id']), p2=state))
            elif days < 0:
                body = (_message('It was due {p0} ({p1} day ago) · {p2}% done', p0=dm.human(t['due_date']), p1=-days, p2=t['progress']) if days == -1
                        else _message('It was due {p0} ({p1} days ago) · {p2}% done', p0=dm.human(t['due_date']), p1=-days, p2=t['progress']))
                for s in dict.fromkeys([None if t.get('declined_at') else t['pic_id'], dm.assigner_of(t), dm.due_decider(t)]):
                    send(t, s, 'task_overdue', 'task_overdue', _message('Overdue: {p0}', p0=t['title']), body)
        return sent

    # ------------------------------------------------------------ reporting lines and team profiles
    def set_manager(self, staff_input, manager_input, actor):
        key = self.lookup(staff_input)
        manager = None if manager_input in (None, '') else self.lookup(manager_input)
        current = Profile.objects.filter(staff_id=key).values_list('manager_id', flat=True).first()
        if current == manager:
            return False
        if not self.can_staff(actor, 'admin.users', 'update'):
            fail(_message('Changing reporting lines needs Administration · User accounts “Update”.'), 403)
        if manager == key:
            fail(_message('{p0} can’t report to themselves. Choose someone else as their manager.', p0=self.name_of(key)), 422)
        if manager:
            if Profile.objects.filter(staff_id=manager, active=False).exists():
                fail(_message('Choose an active team member as the manager.'))
            if key in self.scope.managers(manager):
                fail(_message('{p0} already reports to {p1} (directly or through others), so {p2} can’t report to {p3}.', p0=self.name_of(manager), p1=self.name_of(key), p2=self.name_of(key), p3=self.name_of(manager)), 422)
        p = Profile.objects.filter(staff_id=key).first()
        self._profile_upsert(key, manager_id=manager, **({'version': p.version + 1} if p else {}))
        self.gov.invalidate()
        self.log(actor, 'user', key, None, _message('Reporting line changed'),
                 _message('{p0} reports to {p1}{p2}', p0=self.name_of(key), p1=self.name_of(manager) if manager else 'nobody', p2=f' (was {self.name_of(current)})' if current else ''))
        return True

    def save_profile(self, d, actor):
        old = row(Profile.objects.filter(staff_id=d['staff_id']).first()) if d.get('staff_id') else None
        if old:
            self.check_version(old, d.get('expected_version'))
        key = self.lookup(d['staff_id']) if d.get('staff_id') else next_id('staff', 'STAFF')
        canonical = User.objects.filter(staff_id=key).values_list('username', flat=True).first() if d.get('staff_id') else None
        if canonical and 'name' in d and d['name'] != canonical:
            fail(_message('Change usernames in Administration → User accounts.'), 403)
        name = canonical or text(d.get('name'), _message('Full name'), 200, True)
        email = text(d.get('email'), _message('Email'), 200).lower()
        if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            fail(_message('Enter a valid email address.'))
        if Staff.objects.filter(name=name).exclude(id=key).exists():
            fail(_message('Another team member already uses this name. Add a detail, such as the department, to tell them apart.'), 409)
        active = 0 if d.get('active') is False or d.get('active') == 0 else 1
        if not active and (
                TaskAssignee.objects.filter(staff_id=key).exclude(status='DECLINED').exclude(task__status__in=['COMPLETED', 'CANCELLED']).exists()
                or self._has_scheduled_meeting(key) or TaskRequest.objects.filter(manager_id=key, status='PENDING').exists()):
            fail(_message('Reassign open tasks, scheduled meetings and task requests waiting for this team member before making them inactive.'))
        values = {'email': email, 'phone': text(d.get('phone'), _message('Phone'), 50), 'position': text(d.get('position'), _message('Position'), 150),
                  'department': text(d.get('department'), _message('Department'), 150), 'active': active,
                  'version': old['version'] + 1 if old else 0,
                  'timezone': (old or {}).get('timezone') or '' if 'timezone' not in d else self.zone_input(d['timezone'])}
        previous_name = self.canonical_name(key) if d.get('staff_id') else ''
        if not d.get('staff_id'):
            Staff.objects.create(id=key, name=name, active=True)
        else:
            Staff.objects.filter(id=key).update(name=name)
        self._profile_upsert(key, email=values['email'], phone=values['phone'], position=values['position'], department=values['department'],
                             active=bool(values['active']), version=values['version'], timezone=values['timezone'])
        identity = [x for x in (
            old and previous_name != name and _message('name {p0} → {p1}', p0=previous_name, p1=name),
            old and (old.get('email') or '') != email and _message('team email {p0} → {p1}', p0=old.get('email') or '—', p1=email or '—'),
            old and nn(old.get('active'), 1) != active and (_message('made active') if active else _message('made inactive')),
            not d.get('staff_id') and _message('team member {p0} added', p0=name)) if x]
        if identity:
            account = self.account_of(key)
            AccessAudit.objects.create(actor_id=actor, action=_message('Team profile changed'), target_id=(account or {}).get('id') or key,
                                       detail=f"{name} · {' · '.join(identity)}", created_at=timezone.now())
        if 'manager_id' in d:
            self.set_manager(key, d['manager_id'], actor)
        self.log(actor, 'user', key, None, _message('Team profile saved'), name)
        return {'id': key, 'type': 'tm_user'}

    @staticmethod
    def _has_scheduled_meeting(staff):
        from meetings.models import MeetingAttendee
        return MeetingAttendee.objects.filter(staff_id=staff, meeting__status='SCHEDULED').exists()

    # ------------------------------------------------------------ time entries
    def save_time(self, d, actor):
        old = self.find(TimeEntry, d['id']) if d.get('id') else None
        task_id = old['task_id'] if old else d.get('task_id')
        t = self.task(task_id) if task_id else None
        staff = self.lookup((old or {}).get('staff_id') or d.get('staff_id') or actor)
        wid = (t or {}).get('workspace_id') or (old['workspace_id'] if old else d.get('workspace_id')) or None
        if not t and wid and not self.gov.can_view_workspace(actor, self.workspace(wid)):
            self.hidden()
        if not t and staff != actor:
            fail(_message('Only the owner can change an independent time entry.'), 403)
        if staff != actor and not self.scope.is_involved(actor, t):
            fail(_message('You can view this task but not change it, so you can’t record or change other people’s time on it. Ask someone on the task.'), 403)
        if old:
            self.check_version(old, d.get('expected_version'))
        if wid:
            self.active_workspace(wid)
        self.profile(staff)
        if t and not TaskAssignee.objects.filter(task_id=t['id'], staff_id=staff).exclude(status='DECLINED').exists():
            fail(_message('Log time for someone assigned to this task (the person in charge or a supporting person).'))
        if t and t['status'] == 'CANCELLED':
            fail(_message('Time cannot be added or revised on a cancelled task.'))
        day = date_text(d.get('work_date'), _message('Work date'))
        if day > dm.task_today():
            fail(_message('Time entries cannot be in the future.'))
        minutes = self.duration(d.get('duration'), 1440)
        if not minutes:
            fail(_message('Time must be at least one minute.'))
        if t and TimeEntry.objects.filter(task_id=t['id'], staff_id=staff, work_date=day).exclude(id=(old or {}).get('id') or '').exists():
            fail(_message('This person already has time recorded for this task on that date. Open that entry to change it.'), 409)
        day_total = TimeEntry.objects.filter(staff_id=staff, work_date=day).exclude(id=(old or {}).get('id') or '').aggregate(n=Sum('minutes'))['n'] or 0
        if day_total + minutes > 1440:
            fail(_message('Total logged time for one person cannot exceed 24 hours in a day.'))
        key = old['id'] if old else next_id('tm-time', 'TIME')
        values = {'task_id': (t or {}).get('id'), 'workspace_id': wid, 'activity': '' if t else text(nn(d.get('activity'), (old or {}).get('activity')), _message('Activity'), 300, True),
                  'staff_id': staff, 'work_date': day, 'minutes': minutes, 'notes': text(d.get('notes'), _message('Time entry notes'), 2000),
                  'version': old['version'] + 1 if old else 0, 'updated_at': now()}
        if old:
            update(TimeEntry, key, values)
        else:
            insert(TimeEntry, {'id': key, **values, 'created_at': now()})
        self.log(actor, 'timesheet', key, wid, _message('Time entry updated') if old else _message('Time logged'),
                 f"{(t or {}).get('id') or values['activity']} · {staff} · {day} · {minutes} minutes")
        return {'id': key, 'type': 'tm_time'}

    def delete_time(self, d, actor):
        entry = self.find(TimeEntry, d.get('id'))
        t = self.task(entry['task_id']) if entry['task_id'] else None
        if entry['staff_id'] != actor and not self.scope.is_involved(actor, t):
            fail(_message('You can view this task but not change it, so you can’t remove other people’s time on it. Ask someone on the task.'), 403)
        self.check_version(entry, d.get('expected_version'))
        if (t or {}).get('workspace_id') or entry['workspace_id']:
            self.active_workspace((t or {}).get('workspace_id') or entry['workspace_id'])
        reason = text(d.get('reason'), _message('Deletion reason'), 1000, True)
        TimeEntry.objects.filter(id=entry['id']).delete()
        self.log(actor, 'timesheet', entry['id'], (t or {}).get('workspace_id') or entry['workspace_id'], _message('Time entry deleted'),
                 f"{entry['task_id']} · {entry['staff_id']} · {entry['work_date']} · {entry['minutes']} minutes · {reason}")
        return {'message': _message('Time entry removed; deletion retained in history.')}

    # ------------------------------------------------------------ notifications
    def read_notification(self, d, actor, source):
        telegram = source != 'WEB'
        if d.get('all') is True:
            qs = Notification.objects.filter(staff_id=actor, read_at__isnull=True)
            if telegram:
                qs = qs.exclude(kind='telegram_connected')
            n = qs.update(read_at=timezone.now())
            return {'message': _message('{p0} notification{p1} marked as read.', p0=n, p1='' if n == 1 else 's') if n else _message('No unread notifications.')}
        n = Notification.objects.filter(id=integer(d.get('id'), 1, 9007199254740991, _message('notification'))).first()
        if not n or n.staff_id != actor:
            fail(_message('Notification not found.'), 404)
        if telegram and n.kind == 'telegram_connected':
            return {'message': _message('Open the Task Controlling Management to review this notice.'), 'unchanged': True}
        if not n.read_at:
            Notification.objects.filter(id=n.id).update(read_at=timezone.now())
        return {'message': _message('Marked as read.')}

    # ============================================================ dispatcher
    def task_for(self, action, d):
        def via(model, key):
            if key is None:
                return None
            return model.objects.filter(pk=str(key)).values_list('task_id', flat=True).first()
        if action == 'tm.task.save' or action.startswith('tm.task.'):
            return d.get('id') or None
        if action in ('tm.check.add', 'tm.file.add', 'tm.due.request'):
            return d.get('task_id') or None
        if action.startswith('tm.check.'):
            return via(ChecklistItem, d.get('id'))
        if action == 'tm.file.remove':
            return via(TaskFile, d.get('id'))
        if action.startswith('tm.due.'):
            return via(DueDateRequest, d.get('id'))
        if action.startswith('tm.change.'):
            return via(TaskChangeRequest, d.get('id'))
        if action == 'tm.time.save':
            return via(TimeEntry, d['id']) if d.get('id') else d.get('task_id') or None
        if action == 'tm.time.delete':
            return via(TimeEntry, d.get('id'))
        if action == 'tm.meeting.save':
            return d.get('task_id') or None
        return None

    def handle(self, action, d, actor, meta=None):
        source = (meta or {}).get('source') if (meta or {}).get('source') in SOURCES else 'WEB'
        for k in ('id', 'task_id'):
            if isinstance(d.get(k), str) and d[k] != d[k].strip():
                d = {**d, k: d[k].strip()}
        tid = self.task_for(action, d)
        if tid is not None:
            t = row(Task.objects.filter(id=str(tid)).first())
            if t and not self.scope.can_see(actor, t):
                self.hidden()
        if action == 'tm.profile.manager':
            if not self.can_staff(actor, 'admin.users', 'update'):
                fail(_message('Changing reporting lines needs Administration · User accounts “Update”.'), 403)
            changed = self.set_manager(d.get('staff_id'), d.get('manager_id'), actor)
            return {'id': d.get('staff_id'), 'type': 'tm_user', 'message': _message('Reporting line saved.') if changed else _message('Reporting line unchanged.'),
                    **({} if changed else {'unchanged': True})}
        if action.startswith('me.'):
            return self.me(action, d, actor)
        if action == 'tm.profile.photo':
            staff = self.lookup(d.get('staff_id'))
            if d.get('remove') is True:
                n = self.remove_photo(staff, actor)
                if n:
                    self.log(actor, 'user', staff, None, _message('Profile photo removed'), self.name_of(staff))
                return {'id': staff, 'type': 'tm_user', 'message': _message('Photo removed.') if n else _message('There was no photo.')}
            self.set_photo(staff, d.get('base64'), actor)
            self.log(actor, 'user', staff, None, _message('Profile photo changed'), self.name_of(staff))
            return {'id': staff, 'type': 'tm_user', 'message': _message('Photo saved.')}
        if action == 'tm.profile.save':
            return self.save_profile(d, actor)
        if action.startswith('tm.workspace.'):
            from workspaces import services as workspaces
            return workspaces.handle(self.gov, action, d, actor)
        if action == 'tm.task.members.save':
            from .policy import save_members
            return save_members(self, d, actor, source)
        if action == 'tm.task.delivery.create':
            from groups.delivery import enqueue_task
            return enqueue_task(self, d, actor)
        if action == 'tm.task.save':
            return self.save_task(d, actor, source)
        if action == 'tm.task.handover':
            return self.handover(d, actor, source)
        if action == 'tm.task.remind':
            return self.remind(d, actor, source)
        if action == 'tm.task.reminders':
            return self.set_reminders(d, actor, source)
        verb = re.fullmatch(r'tm\.task\.(accept|decline|progress|stuck|resume|submit|pass|return|close|cancel|reopen|note)', action)
        if verb:
            return self.flow(verb.group(1), d, actor, source)
        if action in ('tm.change.decide', 'tm.change.withdraw'):
            return self.change_action(action, d, actor, source)
        if action.startswith('tm.check.'):
            return self.checklist(action, d, actor, source)
        if action.startswith('tm.file.'):
            return self.files(action, d, actor, source)
        if action.startswith('tm.request.'):
            return self.request(action, d, actor, source)
        if action.startswith('tm.due.'):
            return self.due_request(action, d, actor, source)
        if action == 'tm.notification.read':
            return self.read_notification(d, actor, source)
        if action == 'tm.time.save':
            return self.save_time(d, actor)
        if action == 'tm.time.delete':
            return self.delete_time(d, actor)
        if action.startswith('tm.meeting.') or action.startswith('tm.calnote.'):
            from meetings.services import MeetingService
            return MeetingService(self).handle(action, d, actor, source)
        if action.startswith('tm.group.'):
            from groups.service import GroupService
            return GroupService(self).handle(action, d, actor)
        fail(_message('Unknown Task Management action.'), 404)


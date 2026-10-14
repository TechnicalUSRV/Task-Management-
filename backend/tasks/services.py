"""Task Management commands — a function-by-function port of tasks.mjs (V5.7.7).

Every rule, message and HTTP status is kept. Rows are plain dicts with V5.7.7 column names (core.rows), dates are
'YYYY-MM-DD' strings and timestamps ISO strings, so the logic reads like the original. One TaskService instance is
created per command, inside the command's database transaction; any failure rolls the whole command back.
"""
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
NOT_FOUND = 'Task Management record not found.'
FIELD_LABELS = {'title': 'Title', 'description': 'Expectation', 'progress': 'Progress', 'start_date': 'Start date',
                'due_date': 'Due date', 'priority': 'Priority', 'estimate_minutes': 'Estimated effort',
                'pic_id': 'Person in charge', 'supporters': 'Supporting people', 'reviewer_id': 'Reviewer',
                'department': 'Department', 'department_note': 'Department note', 'recurrence': 'Repeat',
                'recurrence_rule': 'Repeat schedule', 'recurrence_until': 'Repeat until', 'related': 'Related record',
                'status': 'Status'}
CHANGE_WORD = {'UPDATE': 'change details', 'COMPLETE': 'complete', 'CANCEL': 'cancel'}
CLEARED = {'stuck_at': None, 'stuck_by': None, 'stuck_reason': ''}
UNSUBMITTED = {'submitted_to': None, 'submitted_by': None, 'submitted_at': None, 'submit_note': ''}
REMINDER_ERROR = 'Choose up to five reminders, each 1 to 90 days before the due date.'
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
        found = model.objects.filter(pk=text(key, 'Record ID', 60, True)).first()
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
            fail('Restore the workspace before changing its work.')
        return w

    @staticmethod
    def hidden():
        fail(NOT_FOUND, 404)

    @staticmethod
    def check_version(record, expected):
        if isinstance(expected, bool) or expected != record['version']:
            fail('This record changed. Refresh it before saving again.', 409)

    @staticmethod
    def lookup(staff_id):
        return active_staff(staff_id).id

    def profile(self, staff):
        self.lookup(staff)
        p = Profile.objects.filter(staff_id=staff).first()
        if p and not p.active:
            fail('Choose an active team member.')
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
        self.profile(key)
        a = self.account_of(key)
        if a and not a['active']:
            fail(f'{self.name_of(key)}’s login is disabled. Choose someone else.')
        if a and not self.can_staff(key, 'tasks.tasks', 'view'):
            fail(f'{self.name_of(key)} can’t open Task Management. Ask an administrator to add it to their role, or choose someone else.')
        return key

    def zone_of(self, staff):
        own = Profile.objects.filter(staff_id=staff).values_list('timezone', flat=True).first() if staff else ''
        return own or Company.objects.filter(id=1).values_list('timezone', flat=True).first() or DEFAULT_ZONE

    @staticmethod
    def zone_input(value, label='Time zone'):
        zone = text(value, label, 64)
        if zone and zone not in ZONES:
            fail(f'Choose a valid {label.lower()} (for example Asia/Phnom_Penh).')
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
            fail('Duration is too large.')
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
                fail(f'You aren’t a member of the workspace “{w["name"]}”. Ask its owner to add you, or ask a member for a task instead.', 403)
            fail(f'{self.name_of(staff)} isn’t a member of this workspace, and only its members can add people to it. '
                 f'Choose members of the workspace, or ask its owner to add {self.name_of(staff)}.', 403)
        WorkspaceMember.objects.create(workspace_id=wid, staff_id=staff)
        self.gov.invalidate()
        self.log(actor, 'workspace', wid, wid, 'Workspace member added', f'{self.name_of(staff)} · {why}')

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
            fail(f'{self.name_of(dm.assigner_of(t))} can’t approve changes any more, and nobody else can decide for them. '
                 'Ask an administrator to give someone Task Management “Approve”.', 409)
        if not self.reachable(t['pic_id']):
            fail('The other responsible party is unavailable. Restore their access or resolve responsibility before requesting a change.', 409)
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
        fail(f'{self.name_of(dm.assigner_of(t))} can’t approve progress any more, and nobody else can decide for them. '
             'Ask an administrator to give someone Task Management “Approve”.', 409)

    def shown(self, field, v):
        if v is None or v == '' or (isinstance(v, list) and not v):
            return 'Nobody' if field == 'supporters' else '—'
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
            return 'mark it completed'
        if kind == 'CANCEL':
            return 'cancel it'
        return ' · '.join(f"{c['label'].lower()} changed" if c['field'] in ('description', 'department_note')
                          else f"{c['label'].lower()} {c['from_text']} → {c['to_text']}" for c in changes)

    def request_change(self, t, kind, actor, source, approver, changes=(), payload=None, note='', quiet=False):
        pending = self.pending_change(t['id'])
        if pending:
            fail('You already asked for a change to this task. Wait for the answer, or withdraw it first.' if pending['requested_by'] == actor
                 else f"{self.name_of(pending['requested_by'])}’s change to this task is waiting for {self.name_of(pending['approver_id'])}. Wait for the answer first.", 409)
        key, at = next_id('tm-change', 'CHG'), timezone.now()
        side = 'PIC' if actor == t['pic_id'] else 'ASSIGNER'
        summary = self.change_summary(kind, list(changes))
        TaskChangeRequest.objects.create(id=key, task_id=t['id'], kind=kind, requested_by_id=actor, requester_side=side, approver_id=approver,
                                         status='PENDING', changes_json=jtext(list(changes)), payload_json=jtext(payload or {}), note=note,
                                         base_version=t['version'], decision_note='', source=source, version=0, created_at=at, updated_at=at)
        asked = 'approve: ' + summary if kind == 'UPDATE' else summary
        if not quiet:
            self.history(t, 'change_request', t, actor, source, f"Asked {self.name_of(approver)} to {asked}{' · ' + note if note else ''}")
            self.notify([approver], 'change_request', actor, f"Approval needed: {t['title']}",
                        f"{self.name_of(actor)} asks to {'change ' + summary if kind == 'UPDATE' else summary}{' · ' + note if note else ''} · approve or reject",
                        task=t)
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Change requested',
                 f"{t['title']} · {CHANGE_WORD[kind]} · to {self.name_of(approver)}{' · ' + note if note else ''}")
        return key

    def settle_change(self, cr, status, actor, source, note=''):
        TaskChangeRequest.objects.filter(id=cr['id']).update(status=status, decided_by_id=actor, decided_at=timezone.now(), decision_note=note,
                                                             decision_source=source, version=cr['version'] + 1, updated_at=timezone.now())
        payload = parse(cr.get('payload_json') or '{}', {})
        if status != 'APPROVED' and isinstance(payload, dict) and payload.get('due_request_id'):
            q = row(DueDateRequest.objects.filter(id=payload['due_request_id']).first())
            t = row(Task.objects.filter(id=cr['task_id']).first())
            if q and q['status'] == 'APPROVED' and t:
                why = (f"{self.name_of(actor)} rejected the new date{': ' + note if note else ''}" if status == 'REJECTED'
                       else 'The change was withdrawn' if status == 'WITHDRAWN' else note or 'The change could no longer apply')
                DueDateRequest.objects.filter(id=q['id']).update(status='DECLINED', decision_note=clip(why, 1000), decided_by_id=actor,
                                                                 decided_at=timezone.now(), version=q['version'] + 1, updated_at=timezone.now())
                self.notify([q['requested_by']], 'due_declined', actor, f"New due date not applied: {t['title']}", why, task=t, due=q)

    def end_due_requests(self, t, status, why, actor, requester=None):
        qs = DueDateRequest.objects.filter(task_id=t['id'], status='PENDING')
        if requester:
            qs = qs.filter(requested_by_id=requester)
        for q in rows(qs):
            DueDateRequest.objects.filter(id=q['id']).update(status=status, decision_note=why, decided_by_id=actor if status == 'DECLINED' else None,
                                                             decided_at=timezone.now(), version=q['version'] + 1, updated_at=timezone.now())
            self.notify([q['requested_by'] if status == 'DECLINED' else q['decide_by']], 'due_declined' if status == 'DECLINED' else 'task_updated',
                        actor, f"{'Due date request declined' if status == 'DECLINED' else 'Due date request withdrawn'}: {t['title']}", why, task=t, due=q)

    def task_input(self, t):
        """A task as the edit form sends it, so an approved change can be applied on top of the task as it is now."""
        return {'workspace_id': t['workspace_id'], 'title': t['title'], 'description': t['description'], 'start_date': t['start_date'],
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
        fail('Links to CRM and Operations records are not available in this installation.', 403)

    # ============================================================ create / edit a task
    def save_task(self, d, actor, source, opts=None):
        opts = opts or {}
        old = self.task(d['id']) if d.get('id') else None
        if old:
            self.check_version(old, d.get('expected_version'))
        creation_key = None
        if not old:
            creation_key = opts.get('creationKey') or (f"{actor}:{text(d['request_key'], 'Creation key', 100, True)}" if d.get('request_key') else None)
        if creation_key:
            duplicate = row(Task.objects.filter(creation_key=creation_key).first())
            if duplicate:
                if duplicate['workspace_id'] != d.get('workspace_id'):
                    fail('Creation key already belongs to another workspace.')
                return {'id': duplicate['id'], 'type': 'tm_task', 'message': 'Task already created.'}
        w = self.active_workspace(old['workspace_id'] if old else d.get('workspace_id'))
        key = old['id'] if old else next_id('tm-task', 'TASK')
        if not old and not self.gov.can_create_resource(actor, w) and not (
                opts.get('requestId') and self.gov.can_create_resource(opts.get('memberAuthority'), w)):
            fail('Join this workspace before creating work in it.', 403)
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
            fail('Choose the person in charge.')
        pic = self.lookup(pic) if isinstance(pic, str) and old and pic == old['pic_id'] else self.assignable(pic)
        if supporters is not MISSING and supporters is not None and not isinstance(supporters, list):
            fail('Select the supporting people.')
        supporters = list(dict.fromkeys(s for s in ([] if supporters in (MISSING, None) else supporters) if s and s != pic))
        if len(supporters) > 50:
            fail('Choose up to 50 supporting people.')
        for s in supporters:
            if s not in previous_active:
                self.assignable(s)
        reviewer = d.get('reviewer_id') or (old or {}).get('reviewer_id') or actor
        reviewer = self.lookup(reviewer) if reviewer == (old or {}).get('reviewer_id') or reviewer == actor else self.assignable(reviewer)
        known = [old['pic_id'], old['reviewer_id'], old['created_by'], *(r['staff_id'] for r in previous)] if old else []
        for target in [pic, *supporters, reviewer]:
            self.gov.check_collaborator(opts.get('memberAuthority') or actor, w, target, existing=bool(old) and target in known)
        if (old or {}).get('activity_id') or (not old and d.get('activity_id')):
            fail('Links to CRM activities are not available in this installation.', 403)
        rel = self.relation(d.get('related_type'), d.get('related_id'))
        start, due = date_text(d.get('start_date'), 'Start date'), date_text(d.get('due_date'), 'Due date')
        if due < start:
            fail('Due date cannot be before start date.')
        if d.get('recurrence') is None:
            recurrence = (old.get('recurrence') or '') if old else ''
        else:
            recurrence = choice(js_string(d['recurrence']), list(dm.RECURRENCE), 'repeat option')
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
            until = date_text(d['recurrence_until'], 'Repeat until') if d['recurrence_until'] else None
        if until and until < due:
            fail('“Repeat until” must be on or after the due date.')
        description = d['expectation'] if 'description' not in d and 'expectation' in d else d.get('description')
        values = {'workspace_id': w['id'], 'activity_id': None, **rel, 'title': text(d.get('title'), 'Task title', 300, True),
                  'description': text(description, 'Expectation', 8000, not old), 'start_date': start, 'due_date': due,
                  'priority': choice(d.get('priority') or 'MEDIUM', ['HIGH', 'MEDIUM', 'LOW'], 'priority'),
                  'estimate_minutes': self.duration(d.get('estimate')), 'pic_id': pic, 'reviewer_id': reviewer,
                  'department': (old['department'] if old else (w['department'] or '')) if d.get('department') is None else text(d['department'], 'Department', 150),
                  'department_note': text(nn(d.get('department_note'), (old or {}).get('department_note') or ''), 'Department note', 2000),
                  'recurrence': recurrence, 'recurrence_rule': recurrence_rule, 'recurrence_until': until}
        reviewer_changed = not old or reviewer != old['reviewer_id']
        reviewer_self = reviewer == actor or opts.get('reviewerAccepted') == reviewer
        reviewer_values = ({'reviewer_status': 'ACCEPTED' if reviewer_self else 'PENDING', 'reviewer_responded_at': now() if reviewer_self else None,
                            'reviewer_note': ''} if reviewer_changed else {})
        roles = None
        if not old:
            if d.get('status') in ('IN_REVIEW', 'CANCELLED'):
                fail('New tasks start as Not started, In progress or Completed.')
            status = choice(d.get('status') or 'NOT_STARTED', ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'], 'starting status')
            if status != 'NOT_STARTED' and pic != actor:
                fail('Only the person in charge can start or complete a task. Create it as Not started; they can accept it and record progress.', 403)
            progress = 100 if status == 'COMPLETED' else 0 if status == 'NOT_STARTED' else integer(d.get('progress') or 0, 0, 99, 'progress (0–99 until completed)')
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
            self.history(t, 'create', None, actor, source, f"From task request {opts['requestId']}" if opts.get('requestId')
                         else f'Repeats {dm.RECURRENCE_SHORT[recurrence]}' if recurrence else '')
            message = 'Task created.'
        else:
            if d.get('status') not in (None, '') and d['status'] != old['status']:
                fail('Use the task actions (accept, submit, close and so on) to change its status.', 409)
            if d.get('progress') not in (None, ''):
                if js_number(d['progress']) != old['progress']:
                    fail('Use “Update progress” to change progress.', 409)
            roles = self.roles_for(old, actor)
            if not opts.get('applying'):
                self.guard('edit', old, roles)

            def changed(k):
                return str(nn(values.get(k), '')) != str(nn(old.get(k), ''))
            approver = None if opts.get('applying') else self.approver_for(old, actor, edit=True)
            if not opts.get('applying') and not approver:
                if not any(changed(k) for k in values) and same_value(supporters, previous_active):
                    return {'id': key, 'type': 'tm_task', 'unchanged': True, 'message': 'Nothing was changed.'}
                # A personal task still needs a second responsible party for a detail modification.
                for who in (old['reviewer_id'], old['created_by'], values['reviewer_id'], values['pic_id']):
                    account = self.account_of(who) if who else None
                    if who and who != actor and self.reachable(who) and account and account['active'] and self.can_staff(who, 'tasks.tasks', 'view'):
                        approver = who
                        break
                if not approver:
                    fail('Choose another active reviewer or person in charge to approve this change. The task remains unchanged until approved.', 409)
            if approver:
                diff, payload = [], {}

                def put(field, before, after, keys):
                    diff.append(self.change(field, before, after))
                    payload.update(keys)
                for field in ('title', 'description', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department',
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
                    return {'id': key, 'type': 'tm_task', 'message': 'Nothing was changed.', 'unchanged': True}
                if move_series(d):
                    payload['move_series'] = True
                note = text(d.get('change_note'), 'Reason for the change', 1000)
                change_id = self.request_change(old, 'UPDATE', actor, source, approver, diff, payload, note)
                return {'id': key, 'type': 'tm_task', 'change_id': change_id,
                        'message': f'Sent to {self.name_of(approver)} for approval. Nothing changes until they approve.'}
            if not roles['isGovernor'] and not opts.get('applying'):
                locked = [k for k in ('title', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department', 'workspace_id',
                                      'recurrence', 'recurrence_rule', 'recurrence_until') if changed(k)]
                if locked:
                    fail('Only the task’s manager can change its title, dates, priority, department, repeat, person in charge or reviewer. Ask for a new due date instead.', 403)
            extra = dict(reviewer_values) if reviewer_changed else self.confirm_reviewer(old, roles, now())
            if changed('pic_id'):
                if old['status'] == 'IN_REVIEW':
                    fail('Return or close the review before changing the person in charge.', 409)
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
            for field in ('title', 'description', 'start_date', 'due_date', 'priority', 'pic_id', 'reviewer_id', 'department', 'department_note',
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
            approved = f" · approved by {self.name_of(opts['approvedBy'])}" if opts.get('approvedBy') else ''
            self.history(t, 'edit', old, actor, source, f"{'Changed ' + summary if summary else 'Details saved'}{approved}")
            if changed('pic_id'):
                tail = ('' if t.get('accepted_at') else ' · please accept or reject' if t['status'] in dm.OPEN_TASK_STATUSES
                        else f" · the task is {dm.TASK_STATUS[t['status']].lower()}; you are asked to accept it if it is reopened")
                self.notify([pic], 'task_assigned', actor, f"New task: {t['title']}",
                            f'{self.name_of(actor)} made you the person in charge · due {dm.human(due)}{tail}', task=t)
                self.notify([old['pic_id']], 'task_updated', actor, f"Reassigned: {t['title']}", f'{self.name_of(pic)} is now the person in charge', task=t)
            if changed('due_date'):
                self.notify([pic, *supporters], 'task_updated', actor, f"New due date: {t['title']}",
                            f"{self.name_of(actor)} changed the due date from {dm.human(old['due_date'])} to {dm.human(due)}", task=t)
            message = 'Task saved.'
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
                    self.end_due_requests(t, 'WITHDRAWN', f'{self.name_of(s)} no longer supports this task', actor, requester=s)
        if not self.gov.governed(w):
            for s in [pic, *supporters]:
                self.ensure_member(w['id'], s, actor, 'chosen for a task', authority=opts.get('memberAuthority'))
        if not old:
            if not opts.get('quietPic'):
                self.notify([pic], 'task_assigned', actor, f"New task: {t['title']}",
                            f"{self.name_of(actor)} made you the person in charge · due {dm.human(due)}{'' if t.get('accepted_at') else ' · please accept or reject'}", task=t)
            steps = d['steps'] if isinstance(d.get('steps'), list) else d.get('checklist')
            if isinstance(steps, list):
                items = [x for x in (text(x, 'Step', 300) for x in steps) if x]
                if len(items) > MAX_CHECKS:
                    fail(f'A task can have up to {MAX_CHECKS} steps.')
                for i, title in enumerate(items):
                    ChecklistItem.objects.create(id=next_id('tm-check', 'CHK'), task_id=key, position=i + 1, title=title, done=False,
                                                 created_by_id=actor, created_at=stamp)
        if not old and t['status'] == 'COMPLETED' and t.get('recurrence'):
            following = self.schedule_next(t, actor, source)
            message += f" The next one is due {dm.human(following['due_date'])}." if following else ''
        open_text = (' · please accept or reject' if t['status'] in dm.OPEN_TASK_STATUSES
                     else f" · the task is {dm.TASK_STATUS[t['status']].lower()}; you can answer if it is reopened")
        self.notify(invited, 'task_supporting', actor, f"Support request: {t['title']}",
                    f"{self.name_of(actor)} asked you to support {'them' if pic == actor else self.name_of(pic)} · due {dm.human(due)}{open_text}", task=t)
        if reviewer_changed and t.get('reviewer_status') == 'PENDING' and reviewer != pic:
            self.notify([reviewer], 'task_reviewer', actor, f"Review request: {t['title']}",
                        f'{self.name_of(actor)} asked you to review this task · {self.name_of(pic)} is in charge · due {dm.human(due)} · please accept or reject', task=t)
        self.log(actor, 'task', key, w['id'], 'Task updated' if old else 'Task created',
                 f"{t['title']} · {dm.TASK_STATUS[t['status']]} · {t['progress']}% · in charge {self.name_of(pic)}")
        return {'id': key, 'type': 'tm_task', 'message': message}

    # ============================================================ accept / reject
    def respond(self, verb, t, roles, d, actor, source):
        role = choice(d['role'], ['pic', 'supporter', 'reviewer'], 'role') if d.get('role') else None
        answer = dm.answer_roles(verb, t, roles, role)
        targets, block = answer['roles'], answer['block']
        if not targets:
            mine = [v for k, v in (('pic', roles['picState']), ('supporter', roles['supportStatus']), ('reviewer', roles['reviewerStatus']))
                    if v and (not role or k == role)]
            if verb == 'accept' and mine and all(s == 'ACCEPTED' for s in mine):
                return {'id': t['id'], 'type': 'tm_task', 'message': 'You already accepted this task.', 'unchanged': True}
            if verb == 'decline' and mine and all(s == 'DECLINED' for s in mine):
                return {'id': t['id'], 'type': 'tm_task', 'message': 'You already rejected this task.', 'unchanged': True}
            fail(block['message'], block['status'])
        at, who = now(), self.name_of(actor)
        note = text(nn(d.get('note'), d.get('reason')), 'Reason for rejecting', 1000, True) if verb == 'decline' else ''
        support_row = next((a for a in self.support_rows(t) if a['staff_id'] == actor), None)
        changes, messages, tells, closing = {}, [], [], None
        for r in targets:
            if r == 'pic':
                if verb == 'accept':
                    changes.update({'accepted_at': at, 'declined_at': None, 'declined_reason': '',
                                    'status': 'IN_PROGRESS' if t['status'] == 'NOT_STARTED' else t['status']})
                    messages.append('Task accepted. It is now in progress.')
                    tells.append(([self.active_reviewer(t), dm.assigner_of(t)], 'task_accepted', f"Accepted: {t['title']}", f'{who} accepted the task'))
                else:
                    changes.update({'declined_at': at, 'declined_reason': note})
                    messages.append('Task rejected. Its manager has been told.')
                    tells.append(([self.active_reviewer(t), dm.assigner_of(t)], 'task_declined', f"Rejected: {t['title']}", f'{who}: {note}'))
            elif r == 'reviewer':
                if verb == 'accept':
                    changes.update({'reviewer_status': 'ACCEPTED', 'reviewer_responded_at': at, 'reviewer_note': ''})
                    messages.append('You are the reviewer of this task.')
                    tells.append(([dm.assigner_of(t)], 'review_accepted', f"Reviewer confirmed: {t['title']}", f'{who} will review the task'))
                else:
                    changes.update({'reviewer_status': 'DECLINED', 'reviewer_responded_at': at, 'reviewer_note': note})
                    c = self.pending_change(t['id'])
                    if t['status'] == 'IN_REVIEW' and t.get('submitted_to') == actor:
                        if c and c['kind'] == 'COMPLETE' and c['requester_side'] == 'PIC' and c['approver_id'] != actor:
                            changes['submitted_to'] = c['approver_id']
                            tells.append(([c['approver_id']], 'task_submitted', f"Approval needed: {t['title']}",
                                          f"{self.name_of(t['submitted_by'])} asks to complete the task · {who} is no longer reviewing it"))
                        else:
                            changes.update({'status': 'IN_PROGRESS', **UNSUBMITTED})
                    if c and c['approver_id'] == actor:
                        closing = c
                    messages.append('You are no longer the reviewer. The people on the task have been told.')
                    tells.append(([dm.assigner_of(t), t['pic_id'], t.get('submitted_by') if t['status'] == 'IN_REVIEW' else None], 'review_declined',
                                  f"Review rejected: {t['title']}", f'{who}: {note}'))
            else:
                TaskAssignee.objects.filter(task_id=t['id'], staff_id=actor).update(status='ACCEPTED' if verb == 'accept' else 'DECLINED',
                                                                                    responded_at=at, response_note=note)
                inviter = self.on_task(t, (support_row or {}).get('invited_by')) or dm.assigner_of(t)
                if verb == 'accept':
                    messages.append('You are supporting this task.')
                    tells.append(([inviter], 'support_accepted', f"Supporting: {t['title']}", f'{who} accepted to support the task'))
                else:
                    messages.append('You are no longer supporting this task. The people on it have been told.')
                    tells.append(([inviter, t['pic_id'], self.active_reviewer(t)], 'support_declined', f"Support rejected: {t['title']}", f'{who}: {note}'))
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
                    self.notify([decider], 'due_new', actor, f"New due date requested: {t['title']}",
                                f"{self.name_of(q['requested_by'])} asks to move it from {dm.human(q['current_due_date'])} to {dm.human(q['proposed_due_date'])}: {q['reason']} · {who} is no longer the reviewer",
                                task=following, due=q)
        if closing:
            self.settle_change(closing, 'CLOSED', actor, source, f'{who} is no longer the reviewer')
            self.notify([closing['requested_by']], 'change_rejected', actor, f"Change closed: {t['title']}",
                        f'{who} is no longer the reviewer, so your request was closed. Ask again if it is still needed.', task=following)
        for ids, kind, title, body in tells:
            self.notify(ids, kind, actor, title, body, task=following)
        labels = {'pic': 'person in charge', 'supporter': 'supporting person', 'reviewer': 'reviewer'}
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Task accepted' if verb == 'accept' else 'Task rejected',
                 f"{t['title']} · as {' and '.join(labels[r] for r in targets)}{' · ' + note if note else ''}")
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
            return done('This task is already marked as stuck.')
        if verb == 'submit' and t['status'] == 'IN_REVIEW' and t.get('submitted_by') == actor:
            return done('This task is already waiting for review.')
        if verb == 'close' and t['status'] == 'COMPLETED' and (roles['isPic'] or t.get('closed_by') == actor):
            return done('This task is already closed.')
        if verb == 'cancel' and t['status'] == 'CANCELLED' and (roles['isGovernor'] or roles['isPic']):
            return done('This task is already cancelled.')
        if verb == 'reopen' and is_open and (roles['isGovernor'] or roles['isPic']):
            return done('This task is already open.')
        if verb == 'resume' and not t.get('stuck_at') and is_open and (roles['isPic'] or roles['isSupporter'] or roles['isGovernor']):
            return done('This task is not marked as stuck.')
        if verb == 'note' and isinstance(d.get('note'), str) and d['note'].strip() and TaskHistory.objects.filter(
                task_id=t['id'], kind='note', actor_id=actor, note=d['note'].strip(), created_at__gt=timezone.now() - timedelta(seconds=15)).exists():
            return done('Comment added.')
        if not applying:
            self.guard(verb, t, roles)
        cr = self.pending_change(t['id'])
        completion = cr if cr and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC' else None
        if not applying and verb == 'reopen' and dm.reopen_needs_approval(t, actor):
            approver = self.approver_for(t, actor, edit=True)
            if approver:
                note = text(nn(d.get('note'), d.get('reason')), 'Reason for reopening', 2000, True)
                change_id = self.request_change(t, 'UPDATE', actor, source, approver,
                                                [self.change('status', t['status'], 'REOPENED', dm.task_state_label(t), 'Reopened')],
                                                {'reopen': {'note': note}}, note)
                return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                        'message': f"Sent to {self.name_of(approver)} for approval. The task stays {dm.TASK_STATUS[t['status']].lower()} until they approve."}
        if not applying and (verb == 'cancel' or (verb == 'close' and t['status'] != 'IN_REVIEW' and not roles['isPic'])):
            approver = self.approver_for(t, actor)
            if approver:
                cancel = verb == 'cancel'
                note = text(nn(d.get('note'), d.get('reason')), 'Cancellation reason' if cancel else 'Closing note', 1000 if cancel else 2000, cancel)
                change_id = self.request_change(
                    t, 'CANCEL' if cancel else 'COMPLETE', actor, source, approver,
                    [self.change('status', t['status'], 'CANCELLED' if cancel else 'COMPLETED', f"{dm.task_state_label(t)} · {t['progress']}%",
                                 'Cancelled' if cancel else 'Completed · 100%')],
                    {'reason': note, 'keep_series': flag(d.get('keep_series'))} if cancel else {'note': note}, note)
                return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                        'message': f'Sent to {self.name_of(approver)} for approval. The task stays open until they approve.'}
        at, changes = now(), {}

        def note_text(label, required, maximum=2000):
            return text(nn(d.get('note'), d.get('reason')), label, maximum, required)
        note, message, tell, kind, title, body, settle, ask_approval, also = '', '', [], '', '', '', None, None, []
        who = self.name_of(actor)
        approved_by = f" · approved by {self.name_of(opts.get('approvedBy'))}" if applying else ''
        if verb != 'note':
            changes.update(self.confirm_reviewer(t, roles, at))
            if verb in ('progress', 'stuck', 'resume', 'submit'):
                self.confirm_support(t, roles, actor, at)
        if verb == 'progress':
            if d.get('progress') in (None, ''):
                fail('Enter the progress (0–99%).')
            progress = integer(d['progress'], 0, 99, 'progress: 0–99% (close or submit the task when the work is finished)')
            note = note_text('Progress note', False)
            if progress == t['progress'] and t['status'] == 'IN_PROGRESS' and not note:
                return done(f'Progress is already {progress}%.')
            if not applying and progress != t['progress']:
                approver = self.progress_approver(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('progress', t['progress'], progress)],
                                                    {'progress': progress, 'note': note}, note)
                    return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                            'message': f"Sent to {self.name_of(approver)} for approval. Progress stays {t['progress']}% until they approve."}
            changes.update({'progress': progress, 'status': 'IN_PROGRESS' if t['status'] == 'NOT_STARTED' else t['status']})
            if roles['isPic'] and not t.get('accepted_at'):
                changes.update({'accepted_at': at, 'declined_at': None, 'declined_reason': ''})
            message = f'Progress updated to {progress}%.'
            if note and not roles['isPic']:
                tell, kind, title, body = [t['pic_id']], 'task_progress', f"Progress {progress}%: {t['title']}", f'{who}: {note}'
        elif verb == 'stuck':
            note = note_text('What is blocking the task', True, 1000)
            changes.update({'stuck_at': at, 'stuck_by': actor, 'stuck_reason': note})
            if roles['isPic'] and not t.get('accepted_at'):
                changes['accepted_at'] = at
            message = 'Task marked as stuck. The people involved have been told.'
            tell, kind, title, body = self.everyone(t), 'task_stuck', f"Stuck: {t['title']}", f'{who}: {note}'
        elif verb == 'resume':
            note = note_text('Note', False)
            changes.update(CLEARED)
            message = 'Task resumed.'
            tell, kind, title, body = self.everyone(t), 'task_resumed', f"Resumed: {t['title']}", f'{who}: {note}' if note else f'{who} resumed the work'
        elif verb == 'submit':
            note = note_text('Note for the reviewer', False)
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
                message = (f'Sent to {self.name_of(approver)} to approve completing it.' if final else
                           f'Submitted to {self.name_of(to)} for review. {self.name_of(approver)} then approves completing it.')
            else:
                message = f'Submitted to {self.name_of(to)} for review.'
            tell, kind = [to], 'task_submitted'
            title = f"{'Approval needed' if final else 'Review requested'}: {t['title']}"
            body = f"{who} {'asks to complete the task' if final else 'submitted the task to you'}{': ' + note if note else ''}"
        elif verb == 'pass':
            note = note_text('Note for the approver', False)
            approver = (completion or {}).get('approver_id') or dm.completion_path(t)['approver']
            changes['submitted_to'] = approver
            message = f'Passed to {self.name_of(approver)} to approve completing it.'
            tell, kind, title = [approver], 'task_submitted', f"Approval needed: {t['title']}"
            body = f"{who} reviewed the work{': ' + note if note else ''} · {self.name_of(t['submitted_by'])} asks to complete the task"
            also.append(([t['submitted_by']], 'task_passed', f"Reviewed: {t['title']}",
                         f"{who} passed your work to {self.name_of(approver)} for approval{': ' + note if note else ''}"))
        elif verb == 'return':
            note = note_text('What still needs to be done', True)
            changes.update({'status': 'IN_PROGRESS', **UNSUBMITTED})
            if completion:
                settle = (completion, 'REJECTED', note)
            message = f"Returned to {self.name_of(t['submitted_by'])}."
            tell, kind, title, body = [t['submitted_by'], t['pic_id'], t['submitted_to']], 'task_returned', f"Returned: {t['title']}", f'{who}: {note}'
        elif verb == 'close':
            note = note_text('Closing note', False)
            changes.update({'status': 'COMPLETED', 'progress': 100, 'completed_at': at, 'closed_by': actor,
                            'accepted_at': t.get('accepted_at') or at, **CLEARED, **UNSUBMITTED})
            if completion:
                settle = (completion, 'APPROVED', note)
            message = 'Completion approved. The task is completed.' if applying or completion else 'Task closed as completed.'
            tell, kind, title = [*self.everyone(t), t.get('submitted_by'), t.get('submitted_to')], 'task_closed', f"Completed: {t['title']}"
            body = f"{who} {'approved completing the task' if completion else 'closed the task'}{approved_by}{': ' + note if note else ''}"
        elif verb == 'cancel':
            note = note_text('Cancellation reason', True, 1000)
            changes.update({'status': 'CANCELLED', 'reason': note, 'closed_by': actor, **CLEARED, **UNSUBMITTED})
            message = 'Cancellation approved. The task is cancelled.' if applying else 'Task cancelled.'
            tell, kind, title, body = self.everyone(t), 'task_cancelled', f"Cancelled: {t['title']}", f'{who}: {note}{approved_by}'
        elif verb == 'reopen':
            note = note_text('Reason for reopening', True)
            changes.update({'status': 'IN_PROGRESS' if t.get('accepted_at') else 'NOT_STARTED',
                            'progress': min(t['progress'], 99) if t.get('accepted_at') else 0, 'completed_at': None, 'closed_by': None, 'reason': ''})
            message = 'Task reopened.'
            tell, kind, title, body = self.everyone(t), 'task_reopened', f"Reopened: {t['title']}", f'{who}: {note}'
        elif verb == 'note':
            note = text(d.get('note'), 'Comment', 2000, True)
            message = 'Comment added.'
            tell, kind, title, body = [*self.everyone(t), t.get('submitted_to')], 'task_note', f"Comment on {t['title']}", f'{who}: {note}'
        following = t if verb == 'note' else self.save_row(t, {**changes, 'version': t['version'] + 1, 'updated_at': at})
        history_note = ' · '.join(x for x in (note, f"approved by {self.name_of(opts.get('approvedBy'))}") if x) if applying else note
        self.history(following, verb, t, actor, source, history_note)
        if settle:
            self.settle_change(settle[0], settle[1], actor, source, settle[2])
        if verb in ('close', 'cancel'):
            self.end_due_requests(following, 'DECLINED', 'The task was completed' if verb == 'close' else 'The task was cancelled', actor)
        if ask_approval:
            self.request_change(following, 'COMPLETE', actor, source, ask_approval,
                                [self.change('status', t['status'], 'COMPLETED', f"{dm.task_state_label(t)} · {t['progress']}%", 'Completed · 100%')],
                                {'note': note}, note, quiet=True)
        next_task = None
        if t.get('recurrence') and not t.get('next_task_id') and (verb == 'close' or (verb == 'cancel' and flag(d.get('keep_series')))):
            next_task = self.schedule_next(following, actor, source)
            message += f" The next one is due {dm.human(next_task['due_date'])}." if next_task else ' That was the last one in this series.'
        elif verb == 'cancel' and t.get('recurrence') and not t.get('next_task_id'):
            message += ' The series stops here.'
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
        n = {'id': key, 'workspace_id': t['workspace_id'], 'activity_id': None, 'contact_id': t.get('contact_id'), 'related_type': t.get('related_type') or '',
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
            self.ensure_member(n['workspace_id'], pic, actor, 'put in charge of a task', system=True)
        for i, title in enumerate(ChecklistItem.objects.filter(task_id=t['id']).order_by('position').values_list('title', flat=True)):
            ChecklistItem.objects.create(id=next_id('tm-check', 'CHK'), task_id=key, position=i + 1, title=title, done=False,
                                         created_by_id=actor, created_at=stamp)
        Task.objects.filter(id=t['id']).update(next_task_id=key)
        n = self.task(key)
        self.history(n, 'create', None, actor, source,
                     f"Repeats {dm.RECURRENCE_SHORT[rule]} · follows {t['id']}" + ('' if pic_kept else f" · {self.name_of(t['pic_id'])} can no longer be given tasks"))
        self.notify([n['pic_id']], 'task_repeat', actor, f"Next up: {n['title']}",
                    f"Repeats {dm.RECURRENCE_SHORT[rule]} · due {dm.human(due)}{'' if n.get('accepted_at') else ' · please accept or reject'}", task=n)
        self.log(actor, 'task', key, n['workspace_id'], 'Repeating task created', f"{n['title']} · due {due} · follows {t['id']}")
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
            fail('Choose who should take charge.')
        to = self.assignable(d['to_id'])
        asked = self.pending_change(t['id'])
        if not applying and asked and asked['requested_by'] == actor:
            payload = parse(asked.get('payload_json') or '{}', {})
            if isinstance(payload, dict) and (payload.get('handover') or {}).get('to_id') == to:
                return {'id': t['id'], 'type': 'tm_task', 'change_id': asked['id'],
                        'message': f'You already asked to hand this task over to {self.name_of(to)}. Wait for the answer.', 'unchanged': True}
        if to == t['pic_id']:
            fail('Choose someone other than the current person in charge.')
        self.gov.check_collaborator(actor, self.workspace(t['workspace_id']), to, existing=self.scope.is_involved(to, t))
        note, keep, at = text(d.get('note'), 'Note', 1000), flag(d.get('keep')), now()
        approver = None if applying else self.approver_for(t, actor)
        if approver:
            change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('pic_id', t['pic_id'], to)],
                                            {'handover': {'to_id': to, 'keep': keep, 'note': note}}, note)
            return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                    'message': f'Sent to {self.name_of(approver)} for approval. You stay in charge until they approve.'}
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
        self.ensure_member(t['workspace_id'], to, actor, 'given a task by hand-over')
        approved = f" · approved by {self.name_of(opts.get('approvedBy'))}" if applying else ''
        self.history(following, 'handover', t, actor, source, f"{self.name_of(t['pic_id'])} → {self.name_of(to)}{': ' + note if note else ''}{approved}")
        self.notify([to], 'task_assigned', actor, f"Handed over to you: {t['title']}",
                    f"{self.name_of(actor)} asks you to take charge · due {dm.human(t['due_date'])}{' · ' + note if note else ''} · please accept or reject", task=following)
        self.notify([self.active_reviewer(t), dm.assigner_of(t)], 'task_updated', actor, f"Handed over: {t['title']}",
                    f"{self.name_of(actor)} → {self.name_of(to)}{': ' + note if note else ''}", task=following)
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Task handed over', f"{t['title']} · {self.name_of(t['pic_id'])} → {self.name_of(to)}")
        return {'id': t['id'], 'type': 'tm_task', 'message': f'Handed over to {self.name_of(to)}. They are asked to accept it.'}

    def remind(self, d, actor, source):
        t = self.task(d.get('id'))
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('remind', t, roles)
        last = TaskHistory.objects.filter(task_id=t['id'], kind='remind').order_by('-id').values_list('created_at', flat=True).first()
        if last and timezone.now() - last < timedelta(minutes=30):
            fail('A reminder was sent less than 30 minutes ago. Please wait a little before sending another.', 409)
        waiting = [w for w in self.waiting_on(t) if w['staff_id'] != actor]
        who = self.name_of(actor)
        asks = {'pic': 'to take charge of', 'supporter': 'to support', 'reviewer': 'to review'}
        for w in waiting:
            self.notify([w['staff_id']], 'task_reminder', actor, f"Reminder: {t['title']}",
                        f"{who} is waiting for your answer {asks[w['role']]} this task · due {dm.human(t['due_date'])} · please accept or reject", task=t)
        names = ', '.join(self.name_of(w['staff_id']) for w in waiting)
        self.history(t, 'remind', t, actor, source, f'Reminded {names}')
        return {'id': t['id'], 'type': 'tm_task', 'message': f'Reminder sent to {names}.'}

    def set_reminders(self, d, actor, source):
        t = self.task(d.get('id'))
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('reminders', t, roles)
        chosen = self.reminder_input(d.get('reminder_days'))
        if jtext(chosen) == jtext(dm.reminder_days(t.get('reminder_days'))):
            return {'id': t['id'], 'type': 'tm_task', 'message': 'Reminders unchanged.', 'unchanged': True}
        Task.objects.filter(id=t['id']).update(reminder_days=jtext(chosen))
        self.history(t, 'reminders', t, actor, source, dm.reminder_text(chosen))
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Reminders changed', f"{t['title']} · {dm.reminder_text(chosen)}")
        return {'id': t['id'], 'type': 'tm_task',
                'message': f'Reminders set: {dm.reminder_text(chosen)}.' if chosen else 'Deadline reminders are off for this task.'}

    # ------------------------------------------------------------ deciding a change request
    def change_action(self, action, d, actor, source):
        cr = self.find(TaskChangeRequest, d.get('id'))
        t = self.task(cr['task_id'])
        summary = self.change_summary(cr['kind'], parse(cr.get('changes_json') or '[]', []))
        asked = f'change {summary}' if cr['kind'] == 'UPDATE' else summary
        if action == 'tm.change.withdraw':
            if cr['requested_by'] != actor:
                fail('Only the person who asked for this change can withdraw it.', 403)
            if cr['status'] == 'WITHDRAWN':
                return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': 'This request was already withdrawn.', 'unchanged': True}
            if cr['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            self.active_workspace(t['workspace_id'])
            note = text(d.get('note'), 'Note', 1000)
            self.settle_change(cr, 'WITHDRAWN', actor, source, note)
            following = t
            back = cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC' and t['status'] == 'IN_REVIEW'
            if back:
                following = self.save_row(t, {'status': 'IN_PROGRESS', **UNSUBMITTED, 'version': t['version'] + 1, 'updated_at': now()})
            self.history(following, 'change_withdrawn', t, actor, source, f"Withdrew the request to {asked}{' · ' + note if note else ''}")
            self.notify([cr['approver_id'], t.get('submitted_to') if back else None], 'change_withdrawn', actor, f"Request withdrawn: {t['title']}",
                        f'{self.name_of(actor)} withdrew the request to {asked}', task=following)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'Change request withdrawn', f"{t['title']} · {CHANGE_WORD[cr['kind']]}")
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'],
                    'message': 'Completion request withdrawn. The task is back in progress.' if back else 'Request withdrawn. Nothing was changed.'}
        if action != 'tm.change.decide':
            fail('Unknown change request action.', 404)
        decision = choice(d.get('decision'), ['APPROVE', 'REJECT'], 'decision')
        if (cr['status'] == 'APPROVED' and decision == 'APPROVE') or (cr['status'] == 'REJECTED' and decision == 'REJECT'):
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': 'This request was already decided.', 'unchanged': True}
        if cr['status'] != 'PENDING':
            fail('This request was withdrawn.' if cr['status'] == 'WITHDRAWN' else 'This request has already been decided.', 409)
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
                fail(f"Only {self.name_of(cr['approver_id'])} can approve or reject this request.", 403)
            TaskChangeRequest.objects.filter(id=cr['id']).update(approver_id=actor, updated_at=timezone.now())
            if t['status'] == 'IN_REVIEW' and t.get('submitted_to') == cr['approver_id']:
                Task.objects.filter(id=t['id']).update(submitted_to_id=actor)
            cr['approver_id'] = actor
        if cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC':
            result = self.flow('close' if decision == 'APPROVE' else 'return', {'id': t['id'], 'note': d.get('note')}, actor, source)
            return {**result, 'change_id': cr['id']}
        if decision == 'REJECT':
            note = text(nn(d.get('note'), d.get('reason')), 'Reason for rejecting', 1000, True)
            self.settle_change(cr, 'REJECTED', actor, source, note)
            self.history(t, 'change_rejected', t, actor, source, f"Rejected {self.name_of(cr['requested_by'])}’s request to {asked}: {note}")
            self.notify([cr['requested_by']], 'change_rejected', actor, f"Request rejected: {t['title']}",
                        f'{self.name_of(actor)} rejected your request to {asked}: {note}', task=t)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'Change rejected', f"{t['title']} · {CHANGE_WORD[cr['kind']]} · {note}")
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'message': 'Request rejected. The task is unchanged.'}
        note = text(d.get('note'), 'Note', 1000)
        changes = parse(cr.get('changes_json') or '[]', [])
        payload = parse(cr.get('payload_json') or '{}', {})
        if t['status'] not in dm.OPEN_TASK_STATUSES and not (cr['kind'] == 'UPDATE' and t['version'] == cr['base_version']):
            self.settle_change(cr, 'CLOSED', actor, source, 'The task was already closed')
            # As in V5.7.7 the refusal rolls the whole command back, so the request itself stays pending.
            fail('This task is already closed, so the change can no longer apply. The request was closed.', 409)
        stale = [c for c in changes if not same_value(self.current_value(t, c['field']), c['from'])] if cr['kind'] == 'UPDATE' else []
        if stale:
            why = f"Out of date: {', '.join(c['label'].lower() for c in stale)} changed after it was asked"
            self.settle_change(cr, 'CLOSED', actor, source, why)
            self.history(t, 'change_closed', t, actor, source, f"{self.name_of(cr['requested_by'])}’s request to {asked} · {why}")
            self.notify([cr['requested_by']], 'change_rejected', actor, f"Request closed: {t['title']}",
                        f'{why}. Nothing was changed; ask again if it is still needed.', task=t)
            return {'id': cr['id'], 'type': 'tm_change', 'task_id': t['id'], 'closed': True,
                    'message': f"{why}. The request was closed and nothing was changed; {self.name_of(cr['requested_by'])} can ask again."}
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
        self.notify([cr['requested_by']], 'change_approved', actor, f"Request approved: {t['title']}",
                    f"{self.name_of(actor)} approved your request to {asked}{': ' + note if note else ''}", task=t)
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Change approved', f"{t['title']} · {CHANGE_WORD[cr['kind']]} · asked by {self.name_of(cr['requested_by'])}")
        message = ('Approved. The task is cancelled.' if cr['kind'] == 'CANCEL' else 'Approved. The task is completed.' if cr['kind'] == 'COMPLETE'
                   else 'Approved. The task is reopened.' if payload.get('reopen') else f"Approved. Progress is now {payload['progress']}%." if 'progress' in payload
                   else 'Approved. The change is applied.')
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
            title = text(d.get('title'), 'Step', 300, True)
            twin = ChecklistItem.objects.filter(task_id=t['id'], title=title, created_by_id=actor,
                                                created_at__gt=timezone.now() - timedelta(seconds=15)).values_list('id', flat=True).first()
            if twin:
                return {'id': twin, 'type': 'tm_check', 'message': 'Step added.', 'unchanged': True}
            if ChecklistItem.objects.filter(task_id=t['id']).count() >= MAX_CHECKS:
                fail(f'A task can have up to {MAX_CHECKS} steps.')
            key = next_id('tm-check', 'CHK')
            position = (ChecklistItem.objects.filter(task_id=t['id']).aggregate(p=Max('position'))['p'] or 0) + 1
            ChecklistItem.objects.create(id=key, task_id=t['id'], position=position, title=title, done=False, created_by_id=actor, created_at=timezone.now())
            self.after_checklist(t, roles, actor, source, f'Added step “{title}”')
            return {'id': key, 'type': 'tm_check', 'message': 'Step added.'}
        item = self.find(ChecklistItem, d.get('id'))
        t = self.task(item['task_id'])
        self.active_workspace(t['workspace_id'])
        roles = self.roles_for(t, actor)
        self.guard('checklist', t, roles)
        if action == 'tm.check.toggle':
            done = flag(d.get('done'))
            if bool(item['done']) == done:
                return {'id': item['id'], 'type': 'tm_check', 'message': 'This step is already completed.' if done else 'This step is already open.', 'unchanged': True}
            ChecklistItem.objects.filter(id=item['id']).update(done=done, done_by_id=actor if done else None, done_at=timezone.now() if done else None)
            c = self.step_count(t['id'])
            following = self.after_checklist(t, roles, actor, source, f"{'Completed' if done else 'Reopened'} step “{item['title']}”")
            if done:
                self.notify([dm.assigner_of(t)], 'step_completed', actor, f"Step completed: {t['title']}",
                            f"{self.name_of(actor)} completed “{clip(item['title'], 120)}” · {c['done']} of {c['n']} steps completed", task=following)
            return {'id': item['id'], 'type': 'tm_check',
                    'message': f"Step completed ({c['done']} of {c['n']})." if done else f"Step reopened ({c['done']} of {c['n']} completed)."}
        if action == 'tm.check.rename':
            title = text(d.get('title'), 'Step', 300, True)
            if title == item['title']:
                return {'id': item['id'], 'type': 'tm_check', 'message': 'No change.', 'unchanged': True}
            ChecklistItem.objects.filter(id=item['id']).update(title=title)
            self.after_checklist(t, roles, actor, source, f"Renamed step “{item['title']}” to “{title}”")
            return {'id': item['id'], 'type': 'tm_check', 'message': 'Step renamed.'}
        if action == 'tm.check.move':
            order = list(ChecklistItem.objects.filter(task_id=t['id']).order_by('position', 'created_at', 'id').values_list('id', flat=True))
            start = order.index(item['id'])
            if d.get('direction') == 'up':
                to = start - 1
            elif d.get('direction') == 'down':
                to = start + 1
            else:
                to = integer(d.get('position'), 1, len(order), 'step position') - 1
            if to < 0 or to >= len(order) or to == start:
                return {'id': item['id'], 'type': 'tm_check', 'message': 'The step is already there.', 'unchanged': True}
            order.pop(start)
            order.insert(to, item['id'])
            for i, key in enumerate(order):
                ChecklistItem.objects.filter(id=key).update(position=i + 1)
            self.after_checklist(t, roles, actor, source, f"Moved step “{item['title']}” to position {to + 1}")
            return {'id': item['id'], 'type': 'tm_check', 'message': f'Step moved to position {to + 1}.'}
        if action == 'tm.check.remove':
            ChecklistItem.objects.filter(id=item['id']).delete()
            self.renumber(t['id'])
            self.after_checklist(t, roles, actor, source, f"Removed step “{item['title']}”")
            return {'id': t['id'], 'type': 'tm_task', 'message': 'Step removed.'}
        fail('Unknown step action.', 404)

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
        self.history(following, 'checklist', t, actor, source, f"{note} · {c['done']} of {c['n']} steps completed")
        self.log(actor, 'task', t['id'], t['workspace_id'], 'Steps of work updated', f"{t['title']} · {note}")
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
            name = clean_file_name(text(d.get('name'), 'File name', 160, True))
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ext not in dm.TASK_FILE_TYPES:
                fail('Attach a PDF, image (JPG, PNG, WebP, GIF, HEIC), Word, Excel, PowerPoint, CSV, TXT or ZIP file.')
            content = self.decode(d.get('base64'), MAX_FILE, 'Choose a file between 1 byte and 30 MB.')
            if not content_matches(ext, content):
                fail(f'This file is not a real {ext.upper()} file. Choose the original file.')
            if TaskFile.objects.filter(task_id=t['id']).count() >= MAX_FILES:
                fail(f'A task can have up to {MAX_FILES} files. Remove one first.')
            key = next_id('tm-file', 'FILE')
            TaskFile.objects.create(id=key, task_id=t['id'], name=name, mime=dm.TASK_FILE_TYPES[ext], size=len(content), content=content,
                                    uploaded_by_id=actor, source=source, created_at=timezone.now())
            self.history(t, 'file', t, actor, source, name)
            self.notify([t['pic_id'], self.active_reviewer(t), dm.assigner_of(t)], 'task_file', actor, f"File added: {t['title']}",
                        f'{self.name_of(actor)} attached {name}', task=t)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'File attached', f"{t['title']} · {name}")
            return {'id': key, 'type': 'tm_file', 'task_id': t['id'], 'message': f'{name} attached.'}
        if action == 'tm.file.remove':
            f = self.find(TaskFile, d.get('id'))
            t = self.task(f['task_id'])
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            if f['uploaded_by'] != actor and not roles['isGovernor']:
                fail('Only the person who added this file or the task’s manager can remove it.', 403)
            if t['status'] not in dm.OPEN_TASK_STATUSES:
                fail('This task is closed, so its files are kept. Reopen it first to remove a file.', 409)
            TaskFile.objects.filter(id=f['id']).delete()
            self.history(t, 'file_removed', t, actor, source, f['name'])
            self.log(actor, 'task', t['id'], t['workspace_id'], 'File removed', f"{t['title']} · {f['name']}")
            return {'id': t['id'], 'type': 'tm_task', 'message': f"{f['name']} removed."}
        fail('Unknown file action.', 404)

    def set_photo(self, staff, value, actor):
        b = self.decode(value, MAX_PHOTO, 'Choose a JPEG, PNG or WebP photo up to 2 MB.')
        if b[:3] == b'\xff\xd8\xff':
            mime = 'image/jpeg'
        elif b[:8] == b'\x89PNG\r\n\x1a\n':
            mime = 'image/png'
        elif b[:4] == b'RIFF' and b[8:12] == b'WEBP':
            mime = 'image/webp'
        else:
            fail('Choose a JPEG, PNG or WebP photo up to 2 MB.')
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
            if 'name' in d and text(d['name'], 'Display name', 200, True) != self.canonical_name(actor):
                fail('Your display name comes from your username. Ask an administrator to change it.', 403)
            if 'nickname' in d:
                nickname = text(d['nickname'], 'Nickname', 80)
                p = Profile.objects.filter(staff_id=actor).first()
                self._profile_upsert(actor, nickname=nickname, **({'version': p.version + 1} if p else {}))
                self.log(actor, 'user', actor, None, 'Nickname changed', nickname)
                return {'id': actor, 'type': 'me', 'message': 'Your nickname is saved.'}
            if 'sidebar_theme' in d:
                theme = '' if d['sidebar_theme'] in ('', 'blue') else choice(d['sidebar_theme'], SIDEBAR_THEMES, 'Sidebar colour')
                before = Profile.objects.filter(staff_id=actor).values_list('sidebar_theme', flat=True).first() or ''
                if theme != before:
                    self._profile_upsert(actor, sidebar_theme=theme)
                if 'name' not in d and 'timezone' not in d:
                    return {'id': actor, 'type': 'me', 'message': 'Your sidebar colour is saved.' if theme != before else 'Your sidebar colour is unchanged.',
                            **({} if theme != before else {'unchanged': True})}
            if 'timezone' in d:
                zone = self.zone_input(d['timezone'])
                before = Profile.objects.filter(staff_id=actor).values_list('timezone', flat=True).first() or ''
                zone_changed = False
                if zone != before:
                    self._profile_upsert(actor, timezone=zone)
                    self.log(actor, 'user', actor, None, 'Time zone changed', f"{before or 'company time zone'} → {zone or 'company time zone'}")
                    zone_changed = True
                if 'name' not in d:
                    return {'id': actor, 'type': 'me', 'message': 'Your time zone is saved.' if zone_changed else 'Your time zone is unchanged.',
                            **({} if zone_changed else {'unchanged': True})}
            return {'id': actor, 'type': 'me', 'message': 'Your profile is unchanged.', 'unchanged': True}
        if action == 'me.photo.save':
            self.set_photo(actor, d.get('base64'), actor)
            self.log(actor, 'user', actor, None, 'Profile photo changed', self.name_of(actor))
            return {'id': actor, 'type': 'me', 'message': 'Your photo is saved.'}
        if action == 'me.photo.remove':
            n = self.remove_photo(actor, actor)
            if n:
                self.log(actor, 'user', actor, None, 'Profile photo removed', self.name_of(actor))
            return {'id': actor, 'type': 'me', 'message': 'Your photo is removed.' if n else 'You have no photo.'}
        fail('Unknown profile action.', 404)

    # ------------------------------------------------------------ task requests (anyone can ask anyone)
    def receiver_for(self, staff, requester):
        if not staff:
            fail('Choose the person you are asking.')
        m = self.assignable(staff)
        if m == requester:
            fail('Choose someone else. You can’t send a request to yourself.')
        if not self.account_of(m):
            fail(f'{self.name_of(m)} has no Task Controlling Management login, so they can’t answer requests. Choose someone who uses the Task Controlling Management.')
        return m

    def request(self, action, d, actor, source):
        if action == 'tm.request.save':
            old = self.find(TaskRequest, d['id']) if d.get('id') else None
            if old:
                self.check_version(old, d.get('expected_version'))
                if old['requested_by'] != actor:
                    fail('Only the person who made this request can change it.', 403)
                if old['status'] != 'PENDING':
                    fail('This request has already been decided.', 409)
            creation_key = f"{actor}:{text(d['request_key'], 'Creation key', 100, True)}" if not old and d.get('request_key') else None
            if creation_key:
                duplicate = TaskRequest.objects.filter(creation_key=creation_key).values_list('id', flat=True).first()
                if duplicate:
                    return {'id': duplicate, 'type': 'tm_request', 'message': 'Request already sent.'}
            receiver = self.receiver_for(d.get('manager_id'), actor)
            wid = self.active_workspace(d['workspace_id'])['id'] if d.get('workspace_id') else None
            if (not old or old['manager_id'] != receiver) and TaskRequest.objects.filter(requested_by_id=actor, manager_id=receiver, status='PENDING').count() >= 20:
                fail(f'You already have 20 requests waiting for {self.name_of(receiver)}. Wait for answers, or withdraw some first.', 429)
            if wid:
                w = self.workspace(wid)
                if not old and not self.gov.can_create_resource(actor, w):
                    fail('Join this workspace before requesting work in it.', 403)
                self.gov.check_collaborator(actor, w, receiver, existing=bool(old) and old['manager_id'] == receiver and old['workspace_id'] == wid)
            proposed = date_text(d['proposed_due_date'], 'Proposed due date') if d.get('proposed_due_date') else None
            if proposed and proposed < dm.task_today() and proposed != (old or {}).get('proposed_due_date'):
                fail('Choose a “needed by” date from today on.')
            doer = ((old or {}).get('doer') or 'REQUESTER') if d.get('doer') in (None, '') else choice(d['doer'], ['RECEIVER', 'REQUESTER', 'DECIDE'], 'option for who does the work')
            key = old['id'] if old else next_id('tm-request', 'REQ')
            values = {'workspace_id': wid, 'title': text(d.get('title'), 'Request title', 300, True),
                      'description': text(d.get('description'), 'Expectation', 8000, not old),
                      'department': text(nn(d.get('department'), ''), 'Department', 150),
                      'department_note': text(nn(d.get('department_note'), ''), 'Department note', 2000),
                      'priority': choice(d.get('priority') or 'MEDIUM', ['HIGH', 'MEDIUM', 'LOW'], 'priority'), 'proposed_due_date': proposed,
                      'manager_id': receiver, 'doer': doer, 'version': old['version'] + 1 if old else 0, 'updated_at': now()}
            if old:
                update(TaskRequest, key, values)
            else:
                insert(TaskRequest, {'id': key, **values, 'requested_by': actor, 'status': 'PENDING', 'source': source,
                                     'creation_key': creation_key, 'created_at': now()})
            q = self.find(TaskRequest, key)
            ask = 'asks you to do this task' if doer == 'RECEIVER' else 'asks to take on this task' if doer == 'REQUESTER' else 'asks for this task'
            if not old or old['manager_id'] != receiver:
                self.notify([receiver], 'request_new', actor, f"Task request: {q['title']}",
                            f"{self.name_of(actor)} {ask}{' · needed by ' + dm.human(proposed) if proposed else ''}", request=q)
            self.log(actor, 'request', key, wid, 'Task request updated' if old else 'Task requested', f"{q['title']} · to {self.name_of(receiver)}")
            return {'id': key, 'type': 'tm_request', 'message': 'Request updated.' if old else f'Request sent to {self.name_of(receiver)}.'}
        q = self.find(TaskRequest, d.get('id'))
        if not self.scope.can_see_request(actor, q):
            fail(NOT_FOUND, 404)
        if action == 'tm.request.withdraw':
            if q['requested_by'] != actor:
                fail('Only the person who made this request can withdraw it.', 403)
            if q['status'] == 'WITHDRAWN':
                return {'id': q['id'], 'type': 'tm_request', 'message': 'This request was already withdrawn.', 'unchanged': True}
            if q['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            update(TaskRequest, q['id'], {'status': 'WITHDRAWN', 'decision_note': text(d.get('note'), 'Note', 1000), 'version': q['version'] + 1, 'updated_at': now()})
            self.notify([q['manager_id']], 'request_withdrawn', actor, f"Request withdrawn: {q['title']}", f'{self.name_of(actor)} withdrew the request', request=q)
            self.log(actor, 'request', q['id'], q['workspace_id'], 'Task request withdrawn', q['title'])
            return {'id': q['id'], 'type': 'tm_request', 'message': 'Request withdrawn.'}
        if action == 'tm.request.forward':
            if q['manager_id'] != actor:
                fail('Only the person this request was sent to can pass it on.', 403)
            if q['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            if d.get('manager_id') and d['manager_id'] == q['requested_by']:
                fail(f"{self.name_of(q['requested_by'])} asked for this task. To give it back, decline it with a note instead.")
            receiver = self.receiver_for(d.get('manager_id'), q['requested_by'])
            if receiver == actor:
                fail('Choose someone else to pass it to.')
            if q['workspace_id']:
                w = self.workspace(q['workspace_id'])
                if w['status'] != 'ACTIVE':
                    fail('Restore the workspace before changing its work.')
                self.gov.check_collaborator(actor, w, receiver)
            note = text(d.get('note'), 'Note', 1000)
            update(TaskRequest, q['id'], {'manager_id': receiver, 'version': q['version'] + 1, 'updated_at': now()})
            self.notify([receiver], 'request_new', actor, f"Task request: {q['title']}",
                        f"{self.name_of(actor)} passed on a request from {self.name_of(q['requested_by'])}{': ' + note if note else ''}", request=q)
            self.notify([q['requested_by']], 'request_forwarded', actor, f"Request passed on: {q['title']}",
                        f'{self.name_of(actor)} passed your request to {self.name_of(receiver)}', request=q)
            self.log(actor, 'request', q['id'], q['workspace_id'], 'Task request passed on', f"{q['title']} · to {self.name_of(receiver)}")
            return {'id': q['id'], 'type': 'tm_request', 'message': f'Request passed to {self.name_of(receiver)}.'}
        if action == 'tm.request.decide':
            decision = choice(d.get('decision'), ['APPROVE', 'DECLINE'], 'decision')
            if q['manager_id'] != actor:
                fail('Only the person this request was sent to can decide it.', 403)
            if q['status'] == 'APPROVED' and decision == 'APPROVE':
                return {'id': q['task_id'], 'type': 'tm_task', 'message': 'This request was already accepted.', 'unchanged': True}
            if q['status'] == 'DECLINED' and decision == 'DECLINE':
                return {'id': q['id'], 'type': 'tm_request', 'message': 'This request was already declined.', 'unchanged': True}
            if q['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            if decision == 'DECLINE':
                note = text(d.get('note'), 'Reason for declining', 1000, True)
                update(TaskRequest, q['id'], {'status': 'DECLINED', 'decision_note': note, 'decided_by': actor, 'decided_at': now(),
                                              'version': q['version'] + 1, 'updated_at': now()})
                self.notify([q['requested_by']], 'request_declined', actor, f"Request declined: {q['title']}", f'{self.name_of(actor)}: {note}', request=q)
                self.log(actor, 'request', q['id'], q['workspace_id'], 'Task request declined', f"{q['title']} · {note}")
                return {'id': q['id'], 'type': 'tm_request', 'message': 'Request declined. The requester has been told.'}
            wid = d.get('workspace_id') or q['workspace_id']
            if not wid:
                fail('Choose the workspace for this task.')
            doer = q.get('doer') or 'REQUESTER'
            pic = d.get('pic_id') or (actor if doer == 'RECEIVER' else q['requested_by'] if doer == 'REQUESTER' else None)
            if not pic:
                fail('Choose the person in charge of this task.')
            reviewer = d.get('reviewer_id') or (q['requested_by'] if doer == 'RECEIVER' else actor)
            due = d.get('due_date') or q['proposed_due_date']
            if not due:
                fail('Choose a due date for this task.')
            due_day = date_text(due, 'Due date')
            start = d.get('start_date') or (dm.task_today() if dm.task_today() <= due_day else due_day)
            requester_does = pic == q['requested_by'] and doer == 'REQUESTER'
            created = self.save_task(
                {'workspace_id': wid, 'title': d.get('title') or q['title'], 'description': nn(d.get('description'), q['description']),
                 'start_date': start, 'due_date': due_day, 'priority': d.get('priority') or q['priority'], 'estimate': d.get('estimate') or '0:00',
                 'pic_id': pic, 'supporter_ids': d.get('supporter_ids') or [], 'reviewer_id': reviewer,
                 'department': nn(d.get('department'), q['department'] or None), 'department_note': nn(d.get('department_note'), q['department_note']),
                 'recurrence': d.get('recurrence'), **({'recurrence_until': d['recurrence_until']} if 'recurrence_until' in d else {}),
                 'checklist': d.get('checklist')},
                actor, source, {'creationKey': 'request:' + q['id'], 'requestId': q['id'], 'accepted': requester_does, 'quietPic': requester_does,
                                'memberAuthority': q['requested_by'],
                                'reviewerAccepted': reviewer if doer == 'RECEIVER' and reviewer == q['requested_by'] else None,
                                'assignedBy': q['requested_by'] if pic == actor else actor})
            note = text(d.get('note'), 'Note', 1000)
            update(TaskRequest, q['id'], {'status': 'APPROVED', 'task_id': created['id'], 'decision_note': note, 'decided_by': actor, 'decided_at': now(),
                                          'version': q['version'] + 1, 'updated_at': now()})
            who = 'you are in charge' if pic == q['requested_by'] else f'{self.name_of(actor)} will do it' if pic == actor else 'in charge: ' + self.name_of(pic)
            self.notify([q['requested_by']], 'request_approved', actor, f"Request accepted: {q['title']}",
                        f"{self.name_of(actor)} accepted it as {created['id']} · {who} · due {dm.human(due_day)}{' · ' + note if note else ''}",
                        request=q, task={'id': created['id']})
            self.log(actor, 'request', q['id'], wid, 'Task request accepted', f"{q['title']} · {created['id']}")
            return {'id': created['id'], 'type': 'tm_task', 'message': f"Request accepted as {created['id']}."}
        fail('Unknown task request action.', 404)

    # ------------------------------------------------------------ due date change requests
    def due_request(self, action, d, actor, source):
        if action == 'tm.due.request':
            t = self.task(d.get('task_id'))
            self.active_workspace(t['workspace_id'])
            roles = self.roles_for(t, actor)
            self.guard('due', t, roles)
            proposed = date_text(d.get('proposed_due_date'), 'New due date')
            if proposed < t['start_date']:
                fail('The new due date cannot be before the start date.')
            if proposed == t['due_date']:
                fail('Choose a date that differs from the current due date.')
            reason = text(d.get('reason'), 'Reason', 1000, True)
            if roles['isPic'] and dm.two_sided(t):
                approver = self.approver_for(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('due_date', t['due_date'], proposed)],
                                                    {'due_date': proposed}, reason)
                    return {'id': t['id'], 'type': 'tm_task', 'change_id': change_id,
                            'message': f"Sent to {self.name_of(approver)} for approval. The due date stays {dm.human(t['due_date'])} until they approve."}
            decider, key = dm.due_decider(t), next_id('tm-due', 'DUE')
            self.confirm_support(t, roles, actor, now())
            insert(DueDateRequest, {'id': key, 'task_id': t['id'], 'requested_by': actor, 'decide_by': decider, 'current_due_date': t['due_date'],
                                    'proposed_due_date': proposed, 'reason': reason, 'status': 'PENDING', 'source': source,
                                    'created_at': now(), 'updated_at': now()})
            self.history(t, 'due_request', t, actor, source, f"{t['due_date']} → {proposed}: {reason}")
            q = self.find(DueDateRequest, key)
            self.notify([decider], 'due_new', actor, f"New due date requested: {t['title']}",
                        f"{self.name_of(actor)} asks to move it from {dm.human(t['due_date'])} to {dm.human(proposed)}: {reason}", task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'New due date requested', f"{t['due_date']} → {proposed} · {reason}")
            return {'id': key, 'type': 'tm_due_request', 'message': f'Request sent to {self.name_of(decider)}.'}
        q = self.find(DueDateRequest, d.get('id'))
        t = self.task(q['task_id'])
        if action == 'tm.due.withdraw':
            if q['requested_by'] != actor:
                fail('Only the person who asked can withdraw this request.', 403)
            if q['status'] == 'WITHDRAWN':
                return {'id': q['id'], 'type': 'tm_due_request', 'message': 'Already withdrawn.', 'unchanged': True}
            if q['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            update(DueDateRequest, q['id'], {'status': 'WITHDRAWN', 'version': q['version'] + 1, 'updated_at': now()})
            self.history(t, 'due_withdrawn', t, actor, source, f"{q['current_due_date']} → {q['proposed_due_date']} withdrawn")
            self.notify([q['decide_by']], 'task_updated', actor, f"Due date request withdrawn: {t['title']}",
                        f"{self.name_of(actor)} withdrew the request to move it to {dm.human(q['proposed_due_date'])}", task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'Due date request withdrawn', f"{q['current_due_date']} → {q['proposed_due_date']}")
            return {'id': q['id'], 'type': 'tm_due_request', 'message': 'Due date request withdrawn.'}
        if action == 'tm.due.decide':
            decision = choice(d.get('decision'), ['APPROVE', 'DECLINE'], 'decision')
            if q['decide_by'] != actor and dm.due_decider(t) != actor and not (self.can_approve(actor) and self.scope.is_involved(actor, t)):
                fail('Only the task’s reviewer or a task approver on this task can decide this request.', 403)
            if (q['status'] == 'APPROVED' and decision == 'APPROVE') or (q['status'] == 'DECLINED' and decision == 'DECLINE'):
                return {'id': q['id'], 'type': 'tm_due_request', 'message': 'This request was already decided.', 'unchanged': True}
            if q['status'] != 'PENDING':
                fail('This request has already been decided.', 409)
            if d.get('expected_version') is not None:
                self.check_version(q, d['expected_version'])
            self.active_workspace(t['workspace_id'])
            note = text(d.get('note'), 'Reason for declining' if decision == 'DECLINE' else 'Note', 1000, decision == 'DECLINE')
            update(DueDateRequest, q['id'], {'status': 'APPROVED' if decision == 'APPROVE' else 'DECLINED', 'decision_note': note, 'decided_by': actor,
                                             'decided_at': now(), 'version': q['version'] + 1, 'updated_at': now()})
            confirm = self.confirm_reviewer(t, self.roles_for(t, actor), now())
            if decision == 'APPROVE':
                if t['status'] not in dm.OPEN_TASK_STATUSES:
                    fail('This task is closed, so its due date can no longer change.', 409)
                if q['proposed_due_date'] < t['start_date']:
                    fail('The new due date is before the task’s start date.', 409)
                approver = self.approver_for(t, actor)
                if approver:
                    change_id = self.request_change(t, 'UPDATE', actor, source, approver, [self.change('due_date', t['due_date'], q['proposed_due_date'])],
                                                    {'due_date': q['proposed_due_date'], 'due_request_id': q['id']},
                                                    f"{self.name_of(q['requested_by'])} asked: {q['reason']}")
                    update(DueDateRequest, q['id'], {'decision_note': ' · '.join(x for x in (note, f'sent to {self.name_of(approver)} for approval') if x)})
                    self.notify([q['requested_by']], 'due_approved', actor, f"New due date agreed: {t['title']}",
                                f"{self.name_of(actor)} agreed to {dm.human(q['proposed_due_date'])}; {self.name_of(approver)} approves it before it applies", task=t, due=q)
                    self.log(actor, 'task', t['id'], t['workspace_id'], 'Due date change agreed',
                             f"{t['due_date']} → {q['proposed_due_date']} · sent to {self.name_of(approver)}")
                    return {'id': q['id'], 'type': 'tm_due_request', 'change_id': change_id,
                            'message': f'Agreed. {self.name_of(approver)} approves the new date before it applies.'}
                plan = ({'scheduled_due': t['due_date'], 'series_anchor': t.get('series_anchor') or int(t['due_date'][8:10])}
                        if t.get('recurrence') and not t.get('scheduled_due') else {})
                following = self.save_row(t, {**confirm, **plan, 'due_date': q['proposed_due_date'], 'version': t['version'] + 1, 'updated_at': now()})
                self.history(following, 'due_change', t, actor, source, f"{t['due_date']} → {following['due_date']}{': ' + note if note else ''}")
                self.notify([q['requested_by'], t['pic_id'], *self.supporters_of(t)], 'due_approved', actor, f"Due date moved: {t['title']}",
                            f"{self.name_of(actor)} approved {dm.human(following['due_date'])} (was {dm.human(t['due_date'])})", task=following, due=q)
                self.log(actor, 'task', t['id'], t['workspace_id'], 'Due date change approved', f"{t['due_date']} → {following['due_date']}")
                return {'id': q['id'], 'type': 'tm_due_request', 'message': f"Due date changed to {following['due_date']}."}
            if confirm:
                self.save_row(t, {**confirm, 'version': t['version'] + 1, 'updated_at': now()})
            self.history(t, 'due_declined', t, actor, source, f"{q['proposed_due_date']} declined: {note}")
            self.notify([q['requested_by']], 'due_declined', actor, f"Due date request declined: {t['title']}", f'{self.name_of(actor)}: {note}', task=t, due=q)
            self.log(actor, 'task', t['id'], t['workspace_id'], 'Due date change declined', note)
            return {'id': q['id'], 'type': 'tm_due_request', 'message': 'Due date request declined.'}
        fail('Unknown due date action.', 404)

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
                when = 'Due tomorrow' if days == 1 else f'Due in {days} days'
                workers = [x for x in [None if t.get('declined_at') else t['pic_id'], *self.supporters_of(t)] if x]
                state = (f"{t['progress']}% done" + (' · waiting for review' if t['status'] == 'IN_REVIEW' else ' · stuck' if t.get('stuck_at')
                                                     else ' · not accepted yet' if not t.get('accepted_at') else ''))
                for s in dict.fromkeys(workers):
                    send(t, s, key, 'task_due_soon', f"{when}: {t['title']}", f"{dm.human(t['due_date'])} · {state}")
                for s in dict.fromkeys([dm.assigner_of(t), self.active_reviewer(t)]):
                    if s and s not in workers:
                        send(t, s, key, 'task_due_soon', f"{when}: {t['title']}", f"{dm.human(t['due_date'])} · {self.name_of(t['pic_id'])} is in charge · {state}")
            elif days < 0:
                body = f"It was due {dm.human(t['due_date'])} ({-days} day{'' if days == -1 else 's'} ago) · {t['progress']}% done"
                for s in dict.fromkeys([None if t.get('declined_at') else t['pic_id'], dm.assigner_of(t), dm.due_decider(t)]):
                    send(t, s, 'task_overdue', 'task_overdue', f"Overdue: {t['title']}", body)
        return sent

    # ------------------------------------------------------------ reporting lines and team profiles
    def set_manager(self, staff_input, manager_input, actor):
        key = self.lookup(staff_input)
        manager = None if manager_input in (None, '') else self.lookup(manager_input)
        current = Profile.objects.filter(staff_id=key).values_list('manager_id', flat=True).first()
        if current == manager:
            return False
        if not self.can_staff(actor, 'admin.users', 'update'):
            fail('Changing reporting lines needs Administration · User accounts “Update”.', 403)
        if manager == key:
            fail(f'{self.name_of(key)} can’t report to themselves. Choose someone else as their manager.', 422)
        if manager:
            if Profile.objects.filter(staff_id=manager, active=False).exists():
                fail('Choose an active team member as the manager.')
            if key in self.scope.managers(manager):
                fail(f'{self.name_of(manager)} already reports to {self.name_of(key)} (directly or through others), so {self.name_of(key)} can’t report to {self.name_of(manager)}.', 422)
        p = Profile.objects.filter(staff_id=key).first()
        self._profile_upsert(key, manager_id=manager, **({'version': p.version + 1} if p else {}))
        self.gov.invalidate()
        self.log(actor, 'user', key, None, 'Reporting line changed',
                 f"{self.name_of(key)} reports to {self.name_of(manager) if manager else 'nobody'}{f' (was {self.name_of(current)})' if current else ''}")
        return True

    def save_profile(self, d, actor):
        old = row(Profile.objects.filter(staff_id=d['staff_id']).first()) if d.get('staff_id') else None
        if old:
            self.check_version(old, d.get('expected_version'))
        key = self.lookup(d['staff_id']) if d.get('staff_id') else next_id('staff', 'STAFF')
        canonical = User.objects.filter(staff_id=key).values_list('username', flat=True).first() if d.get('staff_id') else None
        if canonical and 'name' in d and d['name'] != canonical:
            fail('Change usernames in Administration → User accounts.', 403)
        name = canonical or text(d.get('name'), 'Full name', 200, True)
        email = text(d.get('email'), 'Email', 200).lower()
        if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            fail('Enter a valid email address.')
        if Staff.objects.filter(name=name).exclude(id=key).exists():
            fail('Another team member already uses this name. Add a detail, such as the department, to tell them apart.', 409)
        active = 0 if d.get('active') is False or d.get('active') == 0 else 1
        if not active and (
                TaskAssignee.objects.filter(staff_id=key).exclude(status='DECLINED').exclude(task__status__in=['COMPLETED', 'CANCELLED']).exists()
                or self._has_scheduled_meeting(key) or TaskRequest.objects.filter(manager_id=key, status='PENDING').exists()):
            fail('Reassign open tasks, scheduled meetings and task requests waiting for this team member before making them inactive.')
        values = {'email': email, 'phone': text(d.get('phone'), 'Phone', 50), 'position': text(d.get('position'), 'Position', 150),
                  'department': text(d.get('department'), 'Department', 150), 'active': active,
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
            old and previous_name != name and f'name {previous_name} → {name}',
            old and (old.get('email') or '') != email and f"team email {old.get('email') or '—'} → {email or '—'}",
            old and nn(old.get('active'), 1) != active and ('made active' if active else 'made inactive'),
            not d.get('staff_id') and f'team member {name} added') if x]
        if identity:
            account = self.account_of(key)
            AccessAudit.objects.create(actor_id=actor, action='Team profile changed', target_id=(account or {}).get('id') or key,
                                       detail=f"{name} · {' · '.join(identity)}", created_at=timezone.now())
        if 'manager_id' in d:
            self.set_manager(key, d['manager_id'], actor)
        self.log(actor, 'user', key, None, 'Team profile saved', name)
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
            fail('Only the owner can change an independent time entry.', 403)
        if staff != actor and not self.scope.is_involved(actor, t):
            fail('You can view this task but not change it, so you can’t record or change other people’s time on it. Ask someone on the task.', 403)
        if old:
            self.check_version(old, d.get('expected_version'))
        if wid:
            self.active_workspace(wid)
        self.profile(staff)
        if t and not TaskAssignee.objects.filter(task_id=t['id'], staff_id=staff).exclude(status='DECLINED').exists():
            fail('Log time for someone assigned to this task (the person in charge or a supporting person).')
        if t and t['status'] == 'CANCELLED':
            fail('Time cannot be added or revised on a cancelled task.')
        day = date_text(d.get('work_date'), 'Work date')
        if day > dm.task_today():
            fail('Time entries cannot be in the future.')
        minutes = self.duration(d.get('duration'), 1440)
        if not minutes:
            fail('Time must be at least one minute.')
        if t and TimeEntry.objects.filter(task_id=t['id'], staff_id=staff, work_date=day).exclude(id=(old or {}).get('id') or '').exists():
            fail('This person already has time recorded for this task on that date. Open that entry to change it.', 409)
        day_total = TimeEntry.objects.filter(staff_id=staff, work_date=day).exclude(id=(old or {}).get('id') or '').aggregate(n=Sum('minutes'))['n'] or 0
        if day_total + minutes > 1440:
            fail('Total logged time for one person cannot exceed 24 hours in a day.')
        key = old['id'] if old else next_id('tm-time', 'TIME')
        values = {'task_id': (t or {}).get('id'), 'workspace_id': wid, 'activity': '' if t else text(nn(d.get('activity'), (old or {}).get('activity')), 'Activity', 300, True),
                  'staff_id': staff, 'work_date': day, 'minutes': minutes, 'notes': text(d.get('notes'), 'Time entry notes', 2000),
                  'version': old['version'] + 1 if old else 0, 'updated_at': now()}
        if old:
            update(TimeEntry, key, values)
        else:
            insert(TimeEntry, {'id': key, **values, 'created_at': now()})
        self.log(actor, 'timesheet', key, wid, 'Time entry updated' if old else 'Time logged',
                 f"{(t or {}).get('id') or values['activity']} · {staff} · {day} · {minutes} minutes")
        return {'id': key, 'type': 'tm_time'}

    def delete_time(self, d, actor):
        entry = self.find(TimeEntry, d.get('id'))
        t = self.task(entry['task_id']) if entry['task_id'] else None
        if entry['staff_id'] != actor and not self.scope.is_involved(actor, t):
            fail('You can view this task but not change it, so you can’t remove other people’s time on it. Ask someone on the task.', 403)
        self.check_version(entry, d.get('expected_version'))
        if (t or {}).get('workspace_id') or entry['workspace_id']:
            self.active_workspace((t or {}).get('workspace_id') or entry['workspace_id'])
        reason = text(d.get('reason'), 'Deletion reason', 1000, True)
        TimeEntry.objects.filter(id=entry['id']).delete()
        self.log(actor, 'timesheet', entry['id'], (t or {}).get('workspace_id') or entry['workspace_id'], 'Time entry deleted',
                 f"{entry['task_id']} · {entry['staff_id']} · {entry['work_date']} · {entry['minutes']} minutes · {reason}")
        return {'message': 'Time entry removed; deletion retained in history.'}

    # ------------------------------------------------------------ notifications
    def read_notification(self, d, actor, source):
        telegram = source != 'WEB'
        if d.get('all') is True:
            qs = Notification.objects.filter(staff_id=actor, read_at__isnull=True)
            if telegram:
                qs = qs.exclude(kind='telegram_connected')
            n = qs.update(read_at=timezone.now())
            return {'message': f"{n} notification{'' if n == 1 else 's'} marked as read." if n else 'No unread notifications.'}
        n = Notification.objects.filter(id=integer(d.get('id'), 1, 9007199254740991, 'notification')).first()
        if not n or n.staff_id != actor:
            fail('Notification not found.', 404)
        if telegram and n.kind == 'telegram_connected':
            return {'message': 'Open the Task Controlling Management to review this notice.', 'unchanged': True}
        if not n.read_at:
            Notification.objects.filter(id=n.id).update(read_at=timezone.now())
        return {'message': 'Marked as read.'}

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
                fail('Changing reporting lines needs Administration · User accounts “Update”.', 403)
            changed = self.set_manager(d.get('staff_id'), d.get('manager_id'), actor)
            return {'id': d.get('staff_id'), 'type': 'tm_user', 'message': 'Reporting line saved.' if changed else 'Reporting line unchanged.',
                    **({} if changed else {'unchanged': True})}
        if action.startswith('me.'):
            return self.me(action, d, actor)
        if action == 'tm.profile.photo':
            staff = self.lookup(d.get('staff_id'))
            if d.get('remove') is True:
                n = self.remove_photo(staff, actor)
                if n:
                    self.log(actor, 'user', staff, None, 'Profile photo removed', self.name_of(staff))
                return {'id': staff, 'type': 'tm_user', 'message': 'Photo removed.' if n else 'There was no photo.'}
            self.set_photo(staff, d.get('base64'), actor)
            self.log(actor, 'user', staff, None, 'Profile photo changed', self.name_of(staff))
            return {'id': staff, 'type': 'tm_user', 'message': 'Photo saved.'}
        if action == 'tm.profile.save':
            return self.save_profile(d, actor)
        if action.startswith('tm.workspace.'):
            from workspaces import services as workspaces
            return workspaces.handle(self.gov, action, d, actor)
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
            fail('Groups are not available in this installation.', 403)
        fail('Unknown Task Management action.', 404)


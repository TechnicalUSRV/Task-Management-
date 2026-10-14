"""Runs one parity scenario against the Django backend (the counterpart of v577_driver.mjs).

Commands go through compat.commands.run — the same authorization and transaction path as POST /api/command — and the
database is read back with plain SQL using the V5.7.7 table and column names, exactly as the Node driver reads its own.
"""
import json
import re
from datetime import date, datetime
from pathlib import Path

from django.db import connection, transaction

from accounts import services as access
from accounts.models import User
from compat.commands import run
from core.errors import InputError
from organization.governance import Governance
from tasks import domain as dm
from meetings.services import MeetingService
from tasks.services import TaskService

SPEC = json.loads((Path(__file__).parent / 'dump.json').read_text())
VERSIONED = {'tm_tasks', 'tm_workspaces', 'tm_requests', 'tm_due_requests', 'tm_change_requests', 'tm_timesheets', 'tm_meetings',
             'tm_meeting_changes', 'access_users', 'tm_calendar_notes'}


def _one(sql, *args):
    with connection.cursor() as c:
        c.execute(sql, args)
        found = c.fetchone()
    return found[0] if found else None


class Scenario:
    def __init__(self):
        self.results = []

    def lookup(self, kind, args):
        if kind == 'today':
            return dm.add_days(dm.task_today(), int(args[0])) if args else dm.task_today()
        if kind == 'version':
            if args[0] == 'tm_profiles':
                return _one('SELECT version FROM tm_profiles WHERE staff_id=%s', args[1])
            if args[0] not in VERSIONED:
                raise ValueError('version of ' + args[0])
            return _one(f'SELECT version FROM {args[0]} WHERE id=%s', args[1])
        if kind == 'approver':
            return _one('SELECT approver_id FROM tm_change_requests WHERE id=%s', args[0])
        if kind == 'staff':
            return _one('SELECT id FROM staff WHERE name=%s', args[0])
        if kind == 'user':
            return _one('SELECT id FROM access_users WHERE username=%s', args[0])
        if kind == 'notification':
            return _one('SELECT id FROM tm_notifications WHERE kind=%s AND staff_id=%s ORDER BY id DESC LIMIT 1', args[0], args[1])
        if kind == 'file':
            return _one('SELECT id FROM tm_files WHERE task_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        if kind == 'step':
            return _one('SELECT id FROM tm_checklist WHERE position=%s AND task_id=%s', int(args[0]), args[1])
        if kind == 'next':
            return _one('SELECT next_task_id FROM tm_tasks WHERE id=%s', args[0])
        if kind == 'due':
            return _one('SELECT id FROM tm_due_requests WHERE task_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        if kind == 'mchange':
            return _one('SELECT id FROM tm_meeting_changes WHERE meeting_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        if kind == 'change':
            return _one('SELECT id FROM tm_change_requests WHERE task_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        raise ValueError('Unknown placeholder ' + kind)

    def one(self, inner):
        m = re.match(r'^(\d+)\.(.+)$', inner)
        if m:
            value = (self.results[int(m.group(1))] if int(m.group(1)) < len(self.results) else {}).get('result')
            for key in m.group(2).split('.'):
                value = value.get(key) if isinstance(value, dict) else None
            return value
        parts = inner.split(':')
        kind, args = parts.pop(0), []
        while parts:
            a = parts.pop(0)
            if a.startswith('@'):
                args.append(self.one(':'.join([a[1:], *parts])))
                break
            args.append(a)
        return self.lookup(kind, args)

    def resolve(self, value):
        if isinstance(value, list):
            return [self.resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: self.resolve(v) for k, v in value.items()}
        if not isinstance(value, str) or '${' not in value:
            return value
        whole = re.fullmatch(r'\$\{([^}]*)\}', value)
        if whole:
            return self.one(whole.group(1))
        return re.sub(r'\$\{([^}]*)\}', lambda m: _js_string(self.one(m.group(1))), value)

    def step(self, step):
        try:
            if 'bootstrap' in step:
                return {'ok': True, 'result': access.bootstrap(self.resolve(step['bootstrap']))}
            if 'reminders' in step:
                at = datetime.fromisoformat(self.resolve(step['reminders']).replace('Z', '+00:00'))
                with transaction.atomic():
                    n = TaskService(Governance()).due_reminders(at)
                return {'ok': True, 'result': n}
            if 'event_reminders' in step:
                at = datetime.fromisoformat(self.resolve(step['event_reminders']).replace('Z', '+00:00'))
                with transaction.atomic():
                    n = MeetingService(TaskService(Governance())).event_reminders(at)
                return {'ok': True, 'result': n}
            actor = self.resolve(step['as'])
            data = self.resolve(step.get('data') or {})
            user = User.objects.select_related('staff', 'role').filter(staff_id=actor).first() if isinstance(actor, str) else None
            return {'ok': True, 'result': run(user, step['do'], data, step.get('source') or 'WEB')}
        except InputError as e:
            return {'ok': False, 'status': e.status, 'message': e.message}

    def play(self, scenario):
        for step in scenario['steps']:
            self.results.append(self.step(step))
        return {'steps': json.loads(json.dumps(self.results, default=str)), 'dump': dump()}


def _js_string(value):
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value)


def _masked(column, value):
    if any(column.endswith(m) for m in SPEC['masked']):
        return None if value is None else '<t>'
    if isinstance(value, bytes):
        return value.decode()
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def dump():
    out = {}
    with connection.cursor() as c:
        for table, t in SPEC['tables'].items():
            c.execute(f"SELECT {','.join(t['cols'])} FROM {table} ORDER BY {t.get('py_order', t['order'])}")
            out[table] = [{col: _masked(col, v) for col, v in zip(t['cols'], r)} for r in c.fetchall()]
    return out

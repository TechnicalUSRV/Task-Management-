"""Runs one parity scenario against the Django backend (the counterpart of v577_driver.mjs).

Commands go through compat.commands.run — the same authorization and transaction path as POST /api/command — and the
database is read back with plain SQL using the V5.7.7 table and column names, exactly as the Node driver reads its own.
"""
import base64
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


APP = 'https://tasks.example.test/tg/'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='


class RecordedTelegram:
    """Stands in for the Telegram Bot API (the counterpart of the recording fetch in v577_driver.mjs)."""

    def __init__(self):
        self.calls, self.fail_next, self.message_id = [], {}, 100

    def call(self, method, params, timeout=15):
        from telegram.bot import TelegramError
        params = json.loads(json.dumps(params, ensure_ascii=False))
        if method != 'getMe':
            self.calls.append({'method': method, 'params': params})
        fail = self.fail_next.pop(method, None)
        if fail:
            p = fail.get('parameters') or {}
            raise TelegramError(fail.get('description'), fail.get('code'), p.get('retry_after'), p.get('migrate_to_chat_id'))
        if method == 'getMe':
            return {'id': 999, 'is_bot': True, 'first_name': 'Sunny', 'username': 'sunny_test_bot'}
        if method in ('sendMessage', 'sendDocument'):
            self.message_id += 1
            return {'message_id': self.message_id, 'chat': {'id': int(params['chat_id'])}}
        if method == 'getFile':
            return {'file_id': params['file_id'], 'file_unique_id': 'u', 'file_size': 12, 'file_path': 'documents/' + params['file_id']}
        return True

    def download(self, file_path):
        name = file_path.split('/')[-1]
        return base64.b64decode(PNG) if name.startswith('IMG') else ('file:' + name).encode()

    def upload(self, method, chat, field, file, extra):
        params = {'chat_id': str(chat), **{k: v if isinstance(v, str) else json.dumps(v) for k, v in extra.items() if v is not None},
                  field: {'name': file['name'], 'type': file['mime'], 'size': len(file['content'])}}
        return self.call(method, params)

    def transport(self):
        return {'call': self.call, 'download': self.download, 'upload': self.upload}


class Scenario:
    def __init__(self):
        self.results = []
        self.telegram, self.bot = RecordedTelegram(), None

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
        if kind == 'orgrev':
            return _one('SELECT revision FROM org_settings WHERE id=1')
        if kind == 'grant':
            return _one('SELECT id FROM org_grants WHERE beneficiary_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        if kind == 'orgreq':
            return _one('SELECT id FROM org_requests WHERE requester_id=%s ORDER BY created_at DESC, id DESC LIMIT 1', args[0])
        if kind == 'ws':
            return _one('SELECT id FROM tm_workspaces WHERE name=%s', args[0])
        if kind == 'sent':
            return self.telegram.message_id
        if kind == 'card':
            return _one('SELECT message_id FROM tg_sessions WHERE tg_user_id=%s', int(args[0]))
        if kind == 'task':
            return _one('SELECT id FROM tm_tasks WHERE title=%s ORDER BY id DESC LIMIT 1', args[0])
        if kind == 'request':
            return _one('SELECT id FROM tm_requests WHERE title=%s ORDER BY id DESC LIMIT 1', args[0])
        if kind == 'month':
            return dm.task_today()[:7]
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
            if 'telegram_bot' in step:
                from telegram.bot import Bot
                from telegram.models import TelegramSettings
                TelegramSettings.objects.filter(id=1).update(enabled=True, bot_token=step['telegram_bot'])
                self.telegram.calls = []
                self.bot = Bot(step['telegram_bot'], app_url=lambda: APP, transport=self.telegram.transport())
                self.bot.connect()
                return {'ok': True, 'result': self.telegram.calls}
            if 'tg_fail' in step:
                self.telegram.fail_next[step['tg_fail']['method']] = step['tg_fail']
                return {'ok': True, 'result': None}
            if 'tg' in step:
                self.telegram.calls = []
                self.bot.handle_update(self.resolve(step['tg']))
                return {'ok': True, 'result': self.telegram.calls}
            if 'tg_flush' in step:
                if step['tg_flush'].get('digest'):
                    from telegram.models import TelegramSettings
                    hour = datetime.now(dm.CAMBODIA).hour
                    TelegramSettings.objects.filter(id=1).update(digest_hour=hour, last_digest_date='')
                self.telegram.calls = []
                self.bot.flush()
                return {'ok': True, 'result': self.telegram.calls}
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
            if 'read' in step:
                return {'ok': True, 'result': json.loads(json.dumps(self.read(step), default=str))}
            actor = self.resolve(step['as'])
            data = self.resolve(step.get('data') or {})
            user = User.objects.select_related('staff', 'role').filter(staff_id=actor).first() if isinstance(actor, str) else None
            return {'ok': True, 'result': run(user, step['do'], data, step.get('source') or 'WEB')}
        except InputError as e:
            return {'ok': False, 'status': e.status, 'message': e.message}
        except Exception as e:  # noqa: BLE001 - an error the bot does not handle itself (V5.7.7 logs it and goes on)
            if not any(k in step for k in ('tg', 'tg_flush', 'telegram_bot')):
                raise
            return {'ok': False, 'status': 500, 'message': str(e)}

    def read(self, step):
        from compat import reports
        from compat.state import filter_state, full_state, scoped_state
        actor = self.resolve(step['as'])
        user = User.objects.select_related('staff', 'role').filter(staff_id=actor, active=True).first()
        if user is None:
            raise InputError('Sign in to continue.', 401)
        data = self.resolve(step.get('input') or {})
        kind = step['read']
        if kind == 'state':
            return filter_state(full_state(), user)
        if kind == 'report':
            return reports.build_task_report(scoped_state(user), data)
        if kind == 'dashboard':
            return reports.build_dashboard(user, data)
        if kind == 'erp':
            return reports.build_erp_report(user, data, bool(step.get('exporting')))
        if kind == 'options':
            return reports.report_options(user)
        if kind == 'source':
            return reports.source_records(user, data)
        if kind == 'mini':
            return reports.mini_state(user, '')
        if kind == 'org':
            return Governance().query(user.staff_id, data)
        raise ValueError(kind)

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

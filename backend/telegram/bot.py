"""The Telegram bot — a port of telegram-bot.mjs (V5.7.7).

The bot is another screen for Task Management: it reads and writes through the same services, permissions
(authorize) and workflow rules as the web app and keeps no task data of its own. It long-polls Telegram for updates,
answers commands and buttons, delivers notifications (with a durable delivery record each), and sends the morning
summary. `python manage.py run_workers` runs it next to the reminder workers.
"""
from core.i18n import msg as _message, text as _translate, render, language, notification_text, staff_language
import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone
from urllib.parse import quote

from django.db import close_old_connections
from django.db.models import Q
from django.utils import timezone

from accounts import services as access
from compat.commands import run as run_command
from compat.reports import enriched_tasks, month_bounds, monthly_task_rows
from compat.state import query
from core.errors import InputError
from core.rows import row, rows
from core.validation import iso
from notifications.models import Notification, NotificationDelivery
from organization.governance import Governance, is_personal_workspace
from tasks import domain as dm
from tasks.models import ChecklistItem, DueDateRequest, Task, TaskAssignee, TaskChangeRequest, TaskFile, TaskRequest
from tasks.scope import TaskScope
from workspaces.models import Workspace

from . import services as tg
from .models import TelegramLink, TelegramSettings

log = logging.getLogger(__name__)
TELEGRAM_API = os.environ.get('TELEGRAM_API_BASE', 'https://api.telegram.org')
OPEN = dm.OPEN_TASK_STATUSES
ICON = {'Awaiting acceptance': '🆕', 'Accepted': '⚪', 'Not started': '⚪', 'In progress': '🔵', 'In review': '🟣', 'Completed': '✅',
        'Cancelled': '✖️', 'Stuck': '🔴', 'Rejected': '🟠'}
NOTE_ICON = {'task_assigned': '🆕', 'task_supporting': '🤝', 'task_reviewer': '🔎', 'task_accepted': '👍', 'task_declined': '🟠', 'task_progress': '📈',
             'task_stuck': '🔴', 'task_resumed': '▶️', 'task_submitted': '📤', 'task_returned': '↩️', 'task_closed': '✅', 'task_cancelled': '✖️',
             'task_reopened': '🔁', 'task_note': '💬', 'task_updated': '✏️', 'step_completed': '☑️', 'meeting_reminder': '📅', 'note_reminder': '📝',
             'meeting_invited': '📅', 'meeting_updated': '📅', 'meeting_cancelled': '✖️', 'support_accepted': '🤝', 'support_declined': '🟠',
             'review_accepted': '🔎', 'review_declined': '🟠', 'task_reminder': '🔔', 'task_repeat': '🔁', 'task_file': '📎', 'task_due_soon': '⏰',
             'task_overdue': '⚠️', 'request_new': '🙋', 'request_approved': '✅', 'request_declined': '🟠', 'request_forwarded': '👥',
             'request_withdrawn': '🗑', 'due_new': '📅', 'due_approved': '📅', 'due_declined': '📅', 'change_request': '🟡', 'change_approved': '✅',
             'change_rejected': '↩️', 'change_withdrawn': '🗑', 'task_passed': '➡️'}
ANSWER_KINDS = ['task_assigned', 'task_supporting', 'task_reviewer', 'task_reminder', 'task_repeat']
PER_PAGE, PEOPLE_PAGE, MAX_FILE = 8, 12, 30 * 1024 * 1024
TASK_ID = re.compile(r'\b([A-Z]{2,8}-\d{6,12})\b')
PRIVATE_COMMANDS = [('menu', _message('Main menu')), ('answer', _message('Tasks waiting for your answer')), ('mytasks', _message('Tasks you are in charge of')),
                    ('supporting', _message('Tasks you support')), ('review', _message('Work waiting for your decision')), ('requests', _message('Your task requests')),
                    ('newtask', _message('Create a task')), ('request', _message('Ask someone for a task')), ('report', _message('Monthly task report')), ('task', _message('Open a task by its ID')),
                    ('help', _message('How to use this bot')), ('unlink', _message('Disconnect this Telegram account'))]
GROUP_COMMANDS = [('connect', _message('Link this group to a workspace (administrators and workspace owners)')),
                  ('disconnect', _message('Disconnect this group')), ('help', _message('How to use the bot here'))]
LIST_TITLES = {'my': ('📋', _message('Tasks you are in charge of'), _message('You have no open tasks in charge.')),
               'sup': ('🤝', _message('Tasks you are supporting'), _message('You are not supporting any open tasks.')),
               'rev': ('🔎', _message('Submitted to you for review'), _message('Nothing is waiting for your review.')),
               'ans': ('🆕', _message('Waiting for your answer'), _message('Nothing is waiting for your answer. 🎉')),
               'ws': ('🗂', _message('Open tasks'), _message('There are no open tasks in this workspace.'))}
QUESTIONS = {'decline': (_message('why are you rejecting this? The people on the task will see your reason.'), _message('Reason')),
             'stuck': (_message('what is blocking this task?'), _message('What is blocking it')),
             'return': (_message('what still needs to be done? This goes back to the person who submitted it.'), _message('What is missing')),
             'note': (_message('send your comment.'), _message('Comment')),
             'submit': (_message('add a note for the person who checks or approves it, or send /skip.'), _message('Note (optional)')),
             'cancel': (_message('why are you cancelling this task? Everyone on it will see your reason.'), _message('Reason'))}
NOT_ALLOWED = _message('Only Task Controlling Management administrators or the workspace owner can link this group to a workspace.')
NOTIFY_MAX_AGE = 6 * 3600
RETRY_AFTER = [30, 120, 600, 1800]
DAYS = [_message('Mon'), _message('Tue'), _message('Wed'), _message('Thu'), _message('Fri'), _message('Sat'), _message('Sun')]
MONTHS = [_message('Jan'), _message('Feb'), _message('Mar'), _message('Apr'), _message('May'), _message('Jun'), _message('Jul'), _message('Aug'), _message('Sep'), _message('Oct'), _message('Nov'), _message('Dec')]


class TelegramError(Exception):
    def __init__(self, message, code=None, retry_after=None, migrate_to=None, too_large=False):
        super().__init__(message)
        self.code, self.retry_after, self.migrate_to, self.too_large = code, retry_after, migrate_to, too_large


# ---------------------------------------------------------------- text helpers (JavaScript string semantics)
def _bot_message(source, **params):
    return _translate(source, params)


def js_len(s):
    return len(s.encode('utf-16-le')) // 2


def js_slice(s, n):
    return s.encode('utf-16-le')[:2 * n].decode('utf-16-le', errors='ignore')


def esc(v):
    return str('' if v is None else render(v)).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def clip(v, n):
    s = re.sub(r'\s+', ' ', str('' if v is None else render(v))).strip()
    return js_slice(s, n - 1) + '…' if js_len(s) > n else s


def clip2(t):
    return js_slice(t, 3990) + '…' if js_len(t) > 4000 else t


def fmt_day(d):
    if not d:
        return '—'
    x = datetime.fromisoformat(d[:10])
    return f'{render(DAYS[x.weekday()])} {x.day} {render(MONTHS[x.month - 1])}'


def rel_day(d):
    n = dm.days_between(dm.task_today(), d)
    return _bot_message('today') if n == 0 else _bot_message('tomorrow') if n == 1 else _bot_message('yesterday') if n == -1 else _bot_message('in {p0} days', p0=n) if n > 0 else _bot_message('{p0} days ago', p0=-n)


def js_round(x):
    return int(math.floor(x + 0.5))


def bar(p):
    n = max(0, min(10, js_round((p or 0) / 10)))
    return '▰' * n + '▱' * (10 - n)


def button(text, data):
    return {'text': render(text), 'callback_data': data}


def chunk(items, per=2):
    return [items[i:i + per] for i in range(0, len(items), per)]


def strip_tags(text):
    return re.sub(r'<[^>]+>', '', text)


def link_help(app):
    return (_bot_message('To use me, connect this Telegram account to your Task Controlling Management login. You only do this once:\n\n• In the Task Controlling Management, click your name (top right) → <b>Connect Telegram</b>, then tap <b>Open Telegram</b> (or scan the QR code with your phone).\n• Or send me <code>/link CODE</code> with the code shown there.')
            + (_bot_message('\n• Or tap <b>Sign in with your Task Controlling Management account</b> below and use your Task Controlling Management username and password.')
               if app else '') + _bot_message('\n\nYour personal link does not expire. It works once, and only for you.'))


def parse_command(text, bot_username):
    m = re.match(r'^/([a-zA-Z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$', str(text or '').strip())
    if not m:
        return None
    if m.group(2) and bot_username and m.group(2).lower() != bot_username.lower():
        return {'other': True}
    return {'cmd': m.group(1).lower(), 'args': (m.group(3) or '').strip(), 'addressed': bool(m.group(2))}


def parse_day(value):
    """2026-10-05, 5/10/2026 or 5-10 (day first, as written in Cambodia), today, tomorrow or +3."""
    t, today = str(value or '').strip().lower(), dm.task_today()

    def ok(v):
        try:
            return v if datetime.fromisoformat(v).strftime('%Y-%m-%d') == v else None
        except ValueError:
            return None
    if t == 'today':
        return today
    if t == 'tomorrow':
        return dm.add_days(today, 1)
    m = re.match(r'^\+(\d{1,3})(?:\s*d(?:ays?)?)?$', t)
    if m:
        return dm.add_days(today, int(m.group(1)))
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', t)
    if m:
        return ok(f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}')
    m = re.match(r'^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$', t)
    if m:
        y = int(('20' + m.group(3)) if m.group(3) and len(m.group(3)) == 2 else m.group(3)) if m.group(3) else int(today[:4])
        v = ok(f'{y:04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}')
        if v and not m.group(3) and v < dm.add_days(today, -31):
            v = ok(f'{y + 1:04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}')
        return v
    return None


def current_month():
    return dm.task_today()[:7]


def shift_month(month, n):
    y, m = (int(x) for x in month.split('-'))
    i = y * 12 + (m - 1) + n
    return f'{i // 12}-{i % 12 + 1:02d}'


def live(qs, field='workspace'):
    """V5.6.8: work in a deleted workspace is hidden everywhere in the bot."""
    return qs.exclude(**{f'{field}__deleted_at__isnull': False})


class Context(dict):
    __getattr__ = dict.get

    def __setattr__(self, key, value):
        self[key] = value


# ---------------------------------------------------------------- HTTP transport to the Bot API
def http_transport(api_base, token):
    def call(method, params, timeout=15):
        body = json.dumps(params, ensure_ascii=False).encode()
        req = urllib.request.Request(f'{api_base}/bot{token}/{method}', data=body, headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise TelegramError(str(getattr(e, 'reason', e)))
        try:
            answer = json.loads(raw)
        except ValueError:
            raise TelegramError(_bot_message('Telegram answered with HTTP {p0}.', p0=status), status)
        if not answer.get('ok'):
            p = answer.get('parameters') or {}
            raise TelegramError(answer.get('description') or _bot_message('Telegram error {p0}', p0=status), answer.get('error_code') or status,
                                p.get('retry_after'), p.get('migrate_to_chat_id'))
        return answer.get('result')

    def download(file_path):
        try:
            with urllib.request.urlopen(f'{api_base}/file/bot{token}/{file_path}', timeout=60) as res:
                chunks, size = [], 0
                while True:
                    part = res.read(65536)
                    if not part:
                        break
                    size += len(part)
                    if size > MAX_FILE:
                        raise TelegramError(_bot_message('too large'), too_large=True)
                    chunks.append(part)
                return b''.join(chunks)
        except urllib.error.HTTPError as e:
            raise TelegramError(_bot_message('Telegram answered with HTTP {p0}.', p0=e.code))

    def upload(method, chat, field, file, extra):
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in {'chat_id': str(chat), **{k: v if isinstance(v, str) else json.dumps(v) for k, v in extra.items() if v is not None}}.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{quote(file["name"])}"\r\n'
                     f'Content-Type: {file["mime"]}\r\n\r\n'.encode() + bytes(file['content']) + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        req = urllib.request.Request(f'{api_base}/bot{token}/{method}', data=b''.join(parts),
                                     headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                answer = json.loads(res.read())
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read(65536))
            except (ValueError, OSError):
                payload = {}
            raise TelegramError(_bot_message('Telegram answered with HTTP {p0}.', p0=e.code), e.code, (payload.get('parameters') or {}).get('retry_after'))
        if not answer.get('ok'):
            raise TelegramError(answer.get('description') or _bot_message('Telegram error'), answer.get('error_code'), (answer.get('parameters') or {}).get('retry_after'))
        return answer.get('result')
    return {'call': call, 'download': download, 'upload': upload}


class Bot:
    def __init__(self, token, api_base=TELEGRAM_API, app_url=lambda: '', transport=None, poll_timeout=25, outbox_seconds=2.5):
        self.token, self.api_base, self.app_url = token, api_base, app_url
        self.transport = transport or http_transport(api_base, token)
        self.poll_timeout, self.outbox_seconds = poll_timeout, outbox_seconds
        self.stopped = threading.Event()
        self.me, self.menu_for, self.flushing = None, None, threading.Lock()
        self.link_failures, self.names = {}, {}
        self.private_menus, self.menu_retries = {}, {}
        self.threads = []

    # ------------------------------------------------------------ Telegram API
    def api(self, method, params=None, timeout=15):
        return self.transport['call'](method, params or {}, timeout)

    def call(self, method, params):
        try:
            return self.api(method, params)
        except TelegramError as e:
            if e.code == 429 and e.retry_after and e.retry_after <= 30 and not self.stopped.is_set():
                time.sleep(e.retry_after)
                return self.api(method, params)
            if e.migrate_to and params.get('chat_id'):
                tg.migrate_group(params['chat_id'], e.migrate_to)
                return self.api(method, {**params, 'chat_id': e.migrate_to})
            raise

    @staticmethod
    def html(text, extra=None):
        return {'text': clip2(render(text)), 'parse_mode': 'HTML', 'link_preview_options': {'is_disabled': True}, **(extra or {})}

    def send(self, ctx_or_chat, view, extra=None):
        extra = extra or {}
        ctx = ctx_or_chat if isinstance(ctx_or_chat, dict) else None
        chat = ctx['chatId'] if ctx else ctx_or_chat
        params = {'chat_id': chat, **self.html(view['text']), **({'reply_markup': {'inline_keyboard': view['keyboard']}} if view.get('keyboard') is not None else {}),
                  **({'message_thread_id': ctx['threadId']} if ctx and ctx.get('threadId') else {}), **extra}
        if ctx and ctx.get('isGroup') and ctx.get('messageId') and not ctx.get('callbackMessage') and not extra.get('reply_parameters'):
            params['reply_parameters'] = {'message_id': ctx['messageId'], 'allow_sending_without_reply': True}
        return self.call('sendMessage', params)

    def say(self, ctx, text, keyboard=None):
        return self.send(ctx, {'text': text, 'keyboard': keyboard})

    def show(self, ctx, view):
        target = ctx.get('editId') or (ctx.get('callbackMessage') or {}).get('message_id')
        if target:
            try:
                self.call('editMessageText', {'chat_id': ctx['chatId'], 'message_id': target, **self.html(view['text']),
                                              'reply_markup': {'inline_keyboard': view.get('keyboard') or []}})
                return target
            except TelegramError as e:
                if re.search('not modified', str(e), re.I):
                    return target
        return self.send(ctx, view)['message_id']

    def answer(self, ctx, text='', alert=False):
        if not ctx.get('callbackId') or ctx.get('answered'):
            return
        ctx['answered'] = True
        try:
            self.call('answerCallbackQuery', {'callback_query_id': ctx['callbackId'], **({'text': clip(text, 190), 'show_alert': alert} if text else {})})
        except TelegramError:
            pass

    def remove(self, chat, message):
        if message:
            try:
                self.call('deleteMessage', {'chat_id': chat, 'message_id': message})
            except TelegramError:
                pass

    def sign_in(self):
        app = self.app_url()
        return [[{'text': _bot_message('🔐 Sign in with your Task Controlling Management account'), 'web_app': {'url': app}}]] if app else None

    # ------------------------------------------------------------ identity and access
    def context(self, chat, sender, **extra):
        is_group, is_private = chat.get('type') in ('group', 'supergroup'), chat.get('type') == 'private'
        link = tg.touch(sender, chat['id'], is_private) if sender and not sender.get('is_bot') else None
        user, problem = None, None
        if link:
            user = access.account_for(link['staff_id'])
            if not user:
                problem = 'disabled'
            elif not access.can(user, 'tasks.tasks'):
                problem = 'no_access'
        group = tg.seen_group(chat) if is_group else None
        ctx = Context(chat=chat, chatId=chat['id'], **{'from': sender}, isGroup=is_group, isPrivate=is_private, link=link, user=user,
                      staff=user.staff_id if user else None, problem=problem, group=group, workspace=(group or {}).get('workspace_id'), **extra)
        ctx['can'] = lambda r, a='view': bool(user) and access.can(user, r, a)
        return ctx

    @staticmethod
    def mention(sender):
        return f"@{esc(sender['username'])}" if sender.get('username') else f'<a href="tg://user?id={int(sender["id"])}">{esc(sender.get("first_name") or "there")}</a>'

    def need_user(self, ctx):
        w = row(Workspace.objects.filter(id=ctx['workspace']).first()) if ctx.get('workspace') else None
        if ctx['isGroup'] and is_personal_workspace(w):
            self.say(ctx, _bot_message('Personal workspace records are available only in your private bot chat or Mini App.'))
            return False
        if ctx.get('user') and not ctx.get('problem'):
            if not Governance().operational_access(ctx['staff']):
                self.say(ctx, _bot_message('Your account is not mapped to the Organizational Structure. Ask an administrator to assign your level.'))
                return False
            return True
        message = ((link_help(self.app_url()) if ctx['isPrivate'] else _bot_message('Connect your Telegram account to the Task Controlling Management first: open a private chat with me and send /start.')) if not ctx.get('link') else _bot_message('Your Task Controlling Management account is disabled. Ask an administrator for help.')
                   if ctx['problem'] == 'disabled' else _bot_message('Your Task Controlling Management role does not include Task Management.'))
        if ctx.get('callbackId'):
            self.answer(ctx, strip_tags(message), True)
        else:
            self.say(ctx, message, self.sign_in() if not ctx.get('link') and ctx['isPrivate'] else None)
        return False

    def perform(self, ctx, action, data):
        try:
            return {'ok': True, 'result': run_command(ctx['user'], action, data, 'TELEGRAM')}
        except InputError as e:
            return {'ok': False, 'error': e.message, 'status': e.status}
        except Exception as e:   # noqa: BLE001
            log.exception('Telegram action failed')
            tg.log('error', ctx['chatId'], f'{action}: {e}')
            return {'ok': False, 'error': _bot_message('Something went wrong, so nothing was changed. Please try again.')}

    # ------------------------------------------------------------ reading tasks
    def name_of(self, staff):
        if not staff:
            return '—'
        if staff not in self.names:
            found = query("SELECT l.name,p.nickname FROM staff l LEFT JOIN tm_profiles p ON p.staff_id=l.id WHERE l.id=%s", staff)
            self.names[staff] = (found[0]['name'] + (f" ({found[0]['nickname']})" if found[0]['nickname'] else '')) if found else staff
        return self.names[staff]

    def short(self, staff):
        return clip(self.name_of(staff).split(' · ')[0], 24)

    @staticmethod
    def change_text(cr):
        try:
            listed = json.loads(cr.get('changes_json') or '[]')
        except ValueError:
            listed = []
        if cr['kind'] == 'COMPLETE':
            return _bot_message('complete the task')
        if cr['kind'] == 'CANCEL':
            return _bot_message('cancel the task')
        return 'change ' + '; '.join(_bot_message('the {p0}', p0=c['label'].lower()) if c['field'] in ('description', 'department_note')
                                     else f"{c['label'].lower()} {c['from_text']} → {c['to_text']}" for c in listed)

    @staticmethod
    def enrich(listed):
        if not listed:
            return []
        ids = [t['id'] for t in listed]
        return enriched_tasks({
            'tm_tasks': listed, 'tm_workspaces': list(Workspace.objects.order_by('id').values('id', 'name', 'department', 'status')),
            'tm_assignees': [{**a, 'responded_at': iso(a['responded_at'])} for a in TaskAssignee.objects.filter(task_id__in=ids).order_by('id')
                             .values('task_id', 'staff_id', 'status', 'invited_by', 'responded_at', 'response_note')],
            'tm_timesheets': [],
            'tm_due_requests': rows(DueDateRequest.objects.filter(status='PENDING', task_id__in=ids).order_by('id')),
            'tm_change_requests': rows(TaskChangeRequest.objects.filter(status='PENDING', task_id__in=ids).order_by('id')),
            'tm_checklist': [{'task_id': c['task_id'], 'done': 1 if c['done'] else 0} for c in ChecklistItem.objects.filter(task_id__in=ids).values('task_id', 'done')],
            'tm_files': list(TaskFile.objects.filter(task_id__in=ids).values('task_id'))})

    def load_task(self, key):
        found = row(Task.objects.filter(id=key).first()) if isinstance(key, str) and re.fullmatch(r'[A-Z]+-\d{1,12}', key) else None
        return self.enrich([found])[0] if found else None

    def scope(self):
        return TaskScope(Governance())

    def can_see(self, ctx, t):
        if not t or not ctx['can']('tasks.tasks'):
            return False
        sc = self.scope()
        return (t['workspace_id'] == ctx['workspace'] and sc.is_involved(ctx['staff'], t)) if ctx['isGroup'] else sc.can_see(ctx['staff'], t)

    def actions_for(self, ctx, t):
        return dm.task_actions(t, ctx['staff'], ctx['can']('tasks.tasks', 'approve') and self.scope().is_involved(ctx['staff'], t))

    def task_view(self, ctx, t, note=''):
        state, allowed, is_open = dm.task_state_label(t), self.actions_for(ctx, t)['allowed'], t['status'] in OPEN
        lines = [f"{ICON.get(state, '•')} <b>{esc(t['title'])}</b>",
                 f"<code>{esc(t['id'])}</code> · {esc(t['workspace'])}{(' · 🔁 repeats ' + dm.RECURRENCE_SHORT[t['recurrence']]) if t['recurrence'] else ''}",
                 f"<b>{esc(state)}</b> · {t['progress']}% {bar(t['progress'])}",
                 _bot_message('👤 In charge: <b>{p0}</b>{p1}{p2}', p0=esc(self.name_of(t['pic_id'])), p1=' (you)' if t['pic_id'] == ctx['staff'] else '', p2=' ⏳' if is_open and t['pic_state'] == 'PENDING' else '')]
        active = [a for a in t['support'] if a['status'] != 'DECLINED']
        if active:
            lines.append('🤝 Supporting: ' + ', '.join(f"{esc(self.name_of(a['staff_id']))}{' ⏳' if a['status'] == 'PENDING' else ''}" for a in active))
        if t['declined_supporters']:
            lines.append(_bot_message('✖️ Rejected supporting: ') + '; '.join(
                f"{esc(self.name_of(a['staff_id']))}{self.quoted(a['response_note'])}"
                for a in t['declined_supporters']))
        if t.get('reviewer_id') and t['reviewer_id'] != t['pic_id']:
            status = (' ⏳' if t['reviewer_status'] == 'PENDING' else
                      (' — ✖️ rejected' + (f" (“{esc(clip(t['reviewer_note'], 80))}”)" if t.get('reviewer_note') else '')) if t['reviewer_status'] == 'DECLINED' else '')
            lines.append(f"🔎 Reviewer: {esc(self.name_of(t['reviewer_id']))}{status}")
        if t['waiting']:
            lines.append(_bot_message('⏳ Waiting for {p0} to accept', p0=', '.join(esc(self.short(w['staff_id'])) for w in t['waiting'])))
        lines.append(_bot_message('📅 Due {p0} ({p1}){p2} · {p3} priority', p0=fmt_day(t['due_date']), p1=rel_day(t['due_date']), p2=' · ⚠️ <b>overdue</b>' if t['overdue'] else '', p3=t['priority'].lower()))
        if t['check_total'] or t['file_count']:
            lines.append(' · '.join(x for x in (_bot_message('☑️ Steps {p0} of {p1} completed', p0=t['check_done'], p1=t['check_total']) if t['check_total'] else '',
                                                f"📎 {t['file_count']} file{'' if t['file_count'] == 1 else 's'}" if t['file_count'] else '') if x))
        if t['department'] or t.get('department_note'):
            lines.append(f"🏢 {esc(t['department'] or _bot_message('Department'))}{(' — ' + esc(clip(t['department_note'], 300))) if t.get('department_note') else ''}")
        if t['stuck']:
            lines.append(_bot_message('⛔ <b>Stuck</b> since {p0}: {p1}', p0=fmt_day(dm.local_day(t['stuck_at'])), p1=esc(t['stuck_reason'])))
        if t['declined']:
            lines.append(_bot_message('🟠 Rejected by {p0}: {p1}', p0=esc(self.name_of(t['pic_id'])), p1=esc(t['declined_reason'])))
        if t['status'] == 'IN_REVIEW':
            lines.append(_bot_message('📤 Submitted by {p0} to <b>{p1}</b>{p2}', p0=esc(self.name_of(t['submitted_by'])), p1=esc(self.name_of(t['submitted_to'])), p2=(': ' + esc(clip(t['submit_note'], 300))) if t.get('submit_note') else ''))
        if t['due_request']:
            lines.append(_bot_message('⏳ New due date requested: {p0} (by {p1})', p0=fmt_day(t['due_request']['proposed_due_date']), p1=esc(self.name_of(t['due_request']['requested_by']))))
        cr = t['change_request']
        completion = bool(cr) and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC'
        if cr:
            lines.append(_bot_message('🟡 <b>Waiting for {p0}{p1} to approve</b>: {p2} asks to {p3}{p4}', p0=esc(self.name_of(cr['approver_id'])), p1=' (you)' if cr['approver_id'] == ctx['staff'] else '', p2=esc(self.name_of(cr['requested_by'])), p3=esc(self.change_text(cr)), p4=(' — “' + esc(clip(cr['note'], 200)) + '”') if cr.get('note') else ''))
        elif t['approval']:
            lines.append(_bot_message('🤝 Changes need both sides: {p0} and {p1}', p0=esc(self.short(t['pic_id'])), p1=esc(self.short(t['assigned_by']))))
        if t['description']:
            lines += ['', f"🎯 <b>Expectation:</b> {esc(clip(t['description'], 600))}"]
        if note:
            lines += ['', note]
        k, key = [], t['id']

        def can(v):
            return self.group_allows(v, t) if ctx['isGroup'] else v in allowed
        reply = [b for b, ok in ((button(_bot_message('✅ Accept'), f't:acc:{key}'), can('accept')), (button(_bot_message('✖️ Reject'), f't:dec:{key}'), can('decline'))) if ok]
        if reply:
            k.append(reply)
        work = []
        if can('progress'):
            work.append(button(_bot_message('▶️ Start / progress') if t['status'] == 'NOT_STARTED' else _bot_message('📈 Progress'), f't:prg:{key}'))
        if can('resume'):
            work.append(button(_bot_message('▶️ Resume'), f't:res:{key}'))
        elif can('stuck'):
            work.append(button(_bot_message('⛔ Stuck'), f't:stk:{key}'))
        if work:
            k.append(work)
        pic, final_approver = t['pic_id'] == ctx['staff'], dm.completion_approver(t) == ctx['staff'] and t['status'] == 'IN_REVIEW'
        finish = []
        if can('submit'):
            finish.append(button(_bot_message('📤 Submit for approval') if pic and dm.two_sided(t) else _bot_message('📤 Send to reviewer') if t['status'] == 'IN_REVIEW' else _bot_message('📤 Submit'), f't:sub:{key}'))
        if can('pass'):
            finish.append(button(_bot_message('➡️ Pass for approval'), f't:pas:{key}'))
        if can('close'):
            finish.append(button(_bot_message('✔️ Approve completion') if final_approver and completion else _bot_message('✔️ Ask to complete') if dm.approval_target(t, ctx['staff']) else _bot_message('✔️ Close'),
                                 f't:cls:{key}'))
        if can('return'):
            finish.append(button(_bot_message('↩️ Return'), f't:ret:{key}'))
        if finish:
            k.append(finish)
        more = [b for b, ok in ((button(_bot_message('💬 Comment'), f't:note:{key}'), can('note')), (button(_bot_message('📅 New due date'), f't:due:{key}'), can('due'))) if ok]
        if more:
            k.append(more)
        extras = []
        if t['check_total'] or can('checklist'):
            extras.append(button(f"☑️ Steps{(' ' + str(t['check_done']) + '/' + str(t['check_total'])) if t['check_total'] else ''}", f't:ck:{key}'))
        if t['file_count'] or can('file'):
            extras.append(button(f"📎 Files{(' (' + str(t['file_count']) + ')') if t['file_count'] else ''}", f't:fl:{key}'))
        if extras:
            k.append(extras)
        if cr and not completion and not ctx['isGroup']:
            if cr['approver_id'] == ctx['staff']:
                k.append([button(_bot_message('✅ Approve change'), f"c:ok:{cr['id']}"), button(_bot_message('↩️ Reject'), f"c:no:{cr['id']}")])
            elif cr['requested_by'] == ctx['staff']:
                k.append([button(_bot_message('🗑 Withdraw request'), f"c:wd:{cr['id']}")])
        elif cr and completion and cr['requested_by'] == ctx['staff'] and not ctx['isGroup']:
            k.append([button(_bot_message('🗑 Take back completion request'), f"c:wd:{cr['id']}")])
        if ctx['isPrivate']:
            manage = []
            if can('handover'):
                manage.append(button(_bot_message('🔁 Hand over'), f't:ho:{key}'))
            if can('remind'):
                manage.append(button(_bot_message('🔔 Remind'), f't:rm:{key}'))
            if can('cancel'):
                manage.append(button(_bot_message('✖️ Ask to cancel') if dm.approval_target(t, ctx['staff']) else _bot_message('✖️ Cancel task'), f't:can:{key}'))
            if manage:
                k.append(manage)
        nav = [button(_bot_message('🔄 Refresh'), f't:v:{key}')]
        app = self.app_url()
        if ctx['isPrivate'] and app:
            nav.append({'text': _bot_message('📱 Open in app'), 'web_app': {'url': f"{app}?task={quote(key, safe='')}"}})
        if ctx['isGroup'] and (self.me or {}).get('username'):
            nav.append({'text': _bot_message('🔒 Open privately'), 'url': f"https://t.me/{self.me['username']}?start=task_{key}"})
        k.append(nav)
        return {'text': '\n'.join(lines), 'keyboard': k}

    @staticmethod
    def quoted(note):
        return f' (“{esc(clip(note, 80))}”)' if note else ''

    @staticmethod
    def group_allows(v, t):
        is_open, working, waiting = t['status'] in OPEN, t['status'] in ('NOT_STARTED', 'IN_PROGRESS'), len(t.get('waiting') or []) > 0
        return {'accept': waiting or (working and bool(t.get('declined_at'))), 'decline': waiting, 'progress': working and not t['awaiting'],
                'stuck': working and not t['stuck'] and not t['awaiting'], 'resume': is_open and t['stuck'], 'submit': working and not t['awaiting'],
                'close': is_open and not t['awaiting'], 'return': t['status'] == 'IN_REVIEW', 'note': is_open, 'due': is_open and not t['due_request'],
                'checklist': is_open and t['check_total'] > 0, 'file': t['status'] != 'CANCELLED'}.get(v, False)

    # ------------------------------------------------------------ task lists
    def answer_q(self, me):
        pending = TaskAssignee.objects.filter(staff_id=me, status='PENDING').values('task_id')
        return (Q(status__in=OPEN) & ((Q(pic_id=me) & Q(accepted_at__isnull=True) & Q(declined_at__isnull=True) & ~Q(status='IN_REVIEW'))
                                      | (Q(id__in=pending) & ~Q(pic_id=me)) | (Q(reviewer_id=me) & Q(reviewer_status='PENDING'))))

    def list_query(self, kind, ctx):
        me = ctx['staff']

        def scoped(qs):
            qs = qs.filter(workspace_id=ctx['workspace']) if ctx['isGroup'] else qs
            return live(qs)
        if kind == 'my':
            return scoped(Task.objects.filter(pic_id=me, status__in=OPEN)).order_by('due_date', 'id')
        if kind == 'sup':
            mine = TaskAssignee.objects.filter(staff_id=me).exclude(status='DECLINED').values('task_id')
            return scoped(Task.objects.filter(id__in=mine, status__in=OPEN).exclude(pic_id=me)).order_by('due_date', 'id')
        if kind == 'rev':
            return scoped(Task.objects.filter(status='IN_REVIEW', submitted_to_id=me)).order_by('submitted_at', 'id')
        if kind == 'ans':
            return scoped(Task.objects.filter(self.answer_q(me))).order_by('due_date', 'id')
        return Task.objects.filter(workspace_id=ctx['workspace'], status__in=OPEN).order_by('due_date', 'id')

    @staticmethod
    def role_note(t, staff):
        if t['pic_id'] == staff and t['pic_state'] == 'PENDING':
            return _bot_message('asked to take charge')
        if any(a['staff_id'] == staff and a['status'] == 'PENDING' for a in t['support']):
            return _bot_message('asked to support')
        if t.get('reviewer_id') == staff and t['reviewer_status'] == 'PENDING':
            return _bot_message('asked to review')
        return ''

    def list_view(self, ctx, kind, page=0):
        found = self.enrich([t for t in rows(self.list_query(kind, ctx)) if self.can_see(ctx, t)])
        part = found[page * PER_PAGE:page * PER_PAGE + PER_PAGE]
        icon, title, empty = render(LIST_TITLES[kind])
        ws_name = Workspace.objects.filter(id=ctx['workspace']).values_list('name', flat=True).first() if ctx['isGroup'] else ''
        head = f"{icon} <b>{title}{(' · ' + esc(ws_name)) if ws_name else ''}</b>"
        if not found:
            return {'text': f'{head}\n\n{empty}', 'keyboard': [[button(_bot_message('🏠 Menu'), 'm:home')]] if ctx['isPrivate'] else []}
        lines = [_bot_message('{p0}. {p1} <b>{p2}</b>\n    {p3}{p4}due {p5}{p6} · {p7}%', p0=page * PER_PAGE + i + 1, p1=ICON.get(dm.task_state_label(t), '•'), p2=esc(clip(t['title'], 60)), p3=(esc(self.role_note(t, ctx['staff'])) + ' · ') if kind == 'ans' else '', p4=(esc(self.short(t['pic_id'])) + ' · ') if kind in ('sup', 'ws', 'ans') else '', p5=fmt_day(t['due_date']), p6=' ⚠️' if t['overdue'] else '', p7=t['progress'])
                 for i, t in enumerate(part)]
        k = [[button(f"{page * PER_PAGE + i + 1}. {clip(t['title'], 40)}", f"t:v:{t['id']}")] for i, t in enumerate(part)]
        pager = []
        if page > 0:
            pager.append(button(_bot_message('◀ Previous'), f'm:{kind}:{page - 1}'))
        if len(found) > (page + 1) * PER_PAGE:
            pager.append(button(_bot_message('Next ▶'), f'm:{kind}:{page + 1}'))
        if pager:
            k.append(pager)
        if ctx['isPrivate']:
            k.append([button(_bot_message('🏠 Menu'), 'm:home')])
        return {'text': f"{head} ({len(found)})\n\n" + '\n'.join(lines), 'keyboard': k}

    def counts(self, staff):
        scope = self.scope()
        if not scope.gov.operational_access(staff):
            return dict.fromkeys(('my', 'overdue', 'sup', 'rev', 'answer'), 0)
        visible = [t['id'] for t in rows(Task.objects.filter(id__in=scope.involved_ids(staff))) if scope.can_see(staff, t)]
        tasks = Task.objects.filter(id__in=visible)
        today = dm.task_today()
        mine = TaskAssignee.objects.filter(staff_id=staff).exclude(status='DECLINED').values('task_id')
        return {'my': live(tasks.filter(pic_id=staff, status__in=OPEN)).count(),
                'overdue': live(tasks.filter(pic_id=staff, status__in=OPEN, due_date__lt=today)).count(),
                'sup': live(tasks.filter(id__in=mine, status__in=OPEN).exclude(pic_id=staff)).count(),
                'rev': live(tasks.filter(status='IN_REVIEW', submitted_to_id=staff)).count()
                + TaskRequest.objects.filter(status='PENDING', manager_id=staff).filter(Q(workspace__isnull=True) | Q(workspace__deleted_at__isnull=True)).count()
                + live(DueDateRequest.objects.filter(task_id__in=visible, status='PENDING', decide_by_id=staff, task__status__in=OPEN), 'task__workspace').count()
                + live(TaskChangeRequest.objects.filter(task_id__in=visible, status='PENDING', approver_id=staff).exclude(kind='COMPLETE', requester_side='PIC'), 'task__workspace').count(),
                'answer': live(tasks.filter(self.answer_q(staff))).count()}

    def menu_view(self, ctx, intro=''):
        c = self.counts(ctx['staff'])
        company = query('SELECT name FROM company WHERE id=1')
        company = (company[0]['name'] if company else None) or _bot_message('Task Controlling Management')
        lines = [intro or f"👋 <b>Hi, {esc(self.name_of(ctx['staff']).split(' · ')[0])}</b>", _bot_message('{p0} · Task Management', p0=esc(company)), '',
                 _bot_message('🆕 Waiting for your answer: <b>{p0}</b>', p0=c['answer']),
                 _bot_message('📋 In charge: <b>{p0}</b> open{p1}', p0=c['my'], p1=(' (⚠️ ' + str(c['overdue']) + ' overdue)') if c['overdue'] else ''),
                 f"🤝 Supporting: <b>{c['sup']}</b>", _bot_message('🔎 Waiting for your decision: <b>{p0}</b>', p0=c['rev'])]
        k = [[button(_bot_message('🆕 To answer ({p0})', p0=c['answer']), 'm:ans:0'), button(_bot_message('🔎 To review ({p0})', p0=c['rev']), 'm:rev')],
             [button(_bot_message('📋 My tasks ({p0})', p0=c['my']), 'm:my:0'), button(f"🤝 Supporting ({c['sup']})", 'm:sup:0')]]
        create = []
        if ctx['can']('tasks.tasks', 'create'):
            create.append(button(_bot_message('➕ New task'), 'm:new'))
        create.append(button(_bot_message('📨 Request a task'), 'm:ask'))
        k.append(create)
        k.append([button(_bot_message('🙋 My requests'), 'm:req'), button(_bot_message('📊 Monthly report'), f'rep:me:{current_month()}')])
        app = self.app_url()
        if app:
            k.append([{'text': _bot_message('📱 Open the task app'), 'web_app': {'url': app}}])
        return {'text': '\n'.join(lines), 'keyboard': k}

    def review_view(self, ctx):
        staff = ctx['staff']
        tasks = self.enrich(rows(live(Task.objects.filter(status='IN_REVIEW', submitted_to_id=staff)).order_by('submitted_at', 'id')))
        requests = rows(TaskRequest.objects.filter(status='PENDING', manager_id=staff).filter(Q(workspace__isnull=True) | Q(workspace__deleted_at__isnull=True))
                        .order_by('created_at', 'id'))
        dues = [{**row(d), 'title': d.task.title} for d in live(DueDateRequest.objects.filter(status='PENDING', decide_by_id=staff, task__status__in=OPEN),
                                                                 'task__workspace').select_related('task').order_by('created_at', 'id')]
        changes = [{**row(c), 'title': c.task.title} for c in live(TaskChangeRequest.objects.filter(status='PENDING', approver_id=staff)
                                                                   .exclude(kind='COMPLETE', requester_side='PIC'), 'task__workspace')
                   .select_related('task').order_by('created_at', 'id')]
        lines, k = [_bot_message('🔎 <b>Waiting for your decision</b>')], []
        if not tasks and not requests and not dues and not changes:
            lines += ['', _bot_message('Nothing is waiting for you. 🎉')]
        if changes:
            lines += ['', _bot_message('<b>Changes to approve ({p0})</b>', p0=len(changes))]
            for c in changes[:8]:
                lines.append(_bot_message('• {p0}: {p1} asks to {p2}', p0=esc(clip(c['title'], 50)), p1=esc(self.short(c['requested_by'])), p2=esc(clip(self.change_text(c), 90))))
                k.append([button(f"🟡 {clip(c['title'], 40)}", f"t:v:{c['task_id']}")])
        if tasks:
            lines += ['', _bot_message('<b>Tasks to review ({p0})</b>', p0=len(tasks))]
            for t in tasks[:8]:
                lines.append(_bot_message('• {p0} — from {p1}', p0=esc(clip(t['title'], 60)), p1=esc(self.short(t['submitted_by']))))
                k.append([button(f"📤 {clip(t['title'], 40)}", f"t:v:{t['id']}")])
        if requests:
            lines += ['', _bot_message('<b>Task requests ({p0})</b>', p0=len(requests))]
            for q in requests[:8]:
                lines.append(_bot_message('• {p0} — from {p1}', p0=esc(clip(q['title'], 60)), p1=esc(self.short(q['requested_by']))))
                k.append([button(f"🙋 {clip(q['title'], 40)}", f"r:v:{q['id']}")])
        if dues:
            lines += ['', _bot_message('<b>Due date requests ({p0})</b>', p0=len(dues))]
            for d in dues[:8]:
                lines.append(f"• {esc(clip(d['title'], 50))}: {fmt_day(d['current_due_date'])} → {fmt_day(d['proposed_due_date'])}")
                k.append([button(f"📅 {clip(d['title'], 40)}", f"d:v:{d['id']}")])
        if ctx['isPrivate']:
            k.append([button(_bot_message('🏠 Menu'), 'm:home')])
        return {'text': '\n'.join(lines), 'keyboard': k}

    def doer_text(self, q):
        doer = q.get('doer') or 'REQUESTER'
        return (_bot_message('{p0} does it', p0=self.name_of(q['manager_id'])) if doer == 'RECEIVER' else _bot_message('decided when accepted') if doer == 'DECIDE'
                else _bot_message('{p0} does it', p0=self.name_of(q['requested_by'])))

    def my_requests_view(self, ctx):
        listed = rows(TaskRequest.objects.filter(requested_by_id=ctx['staff']).order_by('-created_at', '-id')[:10])
        lines = [_bot_message('🙋 <b>Your task requests</b>')]
        if not listed:
            lines += ['', _bot_message('You have not requested any tasks yet.')]
        for q in listed:
            lines.append(f"• {esc(clip(q['title'], 60))} — {_bot_message('Accepted') if q['status'] == 'APPROVED' else dm.REQUEST_STATUS[q['status']]}"
                         f"{(' (with ' + esc(self.short(q['manager_id'])) + ')') if q['status'] == 'PENDING' else ''}")
        k = [[button(f"{'⏳' if q['status'] == 'PENDING' else '✅' if q['status'] == 'APPROVED' else '•'} {clip(q['title'], 40)}", f"r:v:{q['id']}")] for q in listed]
        k += [[button(_bot_message('📨 Request a task'), 'm:ask')], [button(_bot_message('🏠 Menu'), 'm:home')]]
        return {'text': '\n'.join(lines), 'keyboard': k}

    def request_view(self, ctx, q, note=''):
        status = ((f"✅ Accepted{(_bot_message(' as <code>') + esc(q['task_id']) + '</code>') if q.get('task_id') else ''}") if q['status'] == 'APPROVED'
                  else f"🟠 Declined{(': ' + esc(q['decision_note'])) if q.get('decision_note') else ''}" if q['status'] == 'DECLINED'
                  else '🗑 Withdrawn' if q['status'] == 'WITHDRAWN' else _bot_message('⏳ Waiting for an answer'))
        ws = Workspace.objects.filter(id=q['workspace_id']).values_list('name', flat=True).first() if q.get('workspace_id') else ''
        lines = [_bot_message('🙋 <b>Task request</b> <code>{p0}</code>', p0=esc(q['id'])), f"<b>{esc(q['title'])}</b>",
                 _bot_message('From <b>{p0}</b> · asked: <b>{p1}</b>', p0=esc(self.name_of(q['requested_by'])), p1=esc(self.name_of(q['manager_id']))),
                 _bot_message('Who does it: {p0}', p0=esc(self.doer_text(q))), f"Workspace: {esc(ws or _bot_message('decided when accepted'))} · {q['priority'].lower()} priority",
                 _bot_message('Needed by: {p0}', p0=fmt_day(q['proposed_due_date']) if q.get('proposed_due_date') else 'not set')]
        if q.get('department') or q.get('department_note'):
            lines.append(f"🏢 {esc(q['department'] or _bot_message('Department'))}{(' — ' + esc(clip(q['department_note'], 300))) if q.get('department_note') else ''}")
        lines.append(status)
        if q.get('description'):
            lines += ['', f"🎯 <b>Expectation:</b> {esc(clip(q['description'], 600))}"]
        if note:
            lines += ['', note]
        k = []
        if q['status'] == 'PENDING' and q['manager_id'] == ctx['staff']:
            k += [[button(_bot_message('✅ Accept') if q.get('doer') == 'RECEIVER' else _bot_message('✅ Approve'), f"r:ok:{q['id']}"), button(_bot_message('↩️ Decline'), f"r:no:{q['id']}")],
                  [button(_bot_message('👥 Pass to someone else'), f"r:fw:{q['id']}")]]
        if q['status'] == 'PENDING' and q['requested_by'] == ctx['staff']:
            k.append([button(_bot_message('🗑 Withdraw request'), f"r:wd:{q['id']}")])
        if q.get('task_id'):
            k.append([button(_bot_message('👁 View task'), f"t:v:{q['task_id']}")])
        k.append([button(_bot_message('🔄 Refresh'), f"r:v:{q['id']}")])
        return {'text': '\n'.join(lines), 'keyboard': k}

    def due_view(self, ctx, d, note=''):
        t = self.load_task(d['task_id'])
        status = {'PENDING': _bot_message('⏳ Waiting for a decision'), 'APPROVED': '✅ Approved',
                  'DECLINED': f"🟠 Declined{(': ' + esc(d['decision_note'])) if d.get('decision_note') else ''}", 'WITHDRAWN': '🗑 Withdrawn'}[d['status']]
        lines = [_bot_message('📅 <b>New due date requested</b>'), f"<code>{esc(d['task_id'])}</code> · {esc((t or {}).get('title') or '')}",
                 _bot_message('{p0} asks to move it from <b>{p1}</b> to <b>{p2}</b>.', p0=esc(self.name_of(d['requested_by'])), p1=fmt_day(d['current_due_date']), p2=fmt_day(d['proposed_due_date'])),
                 f"Reason: {esc(d['reason'])}", status]
        if note:
            lines += ['', note]
        k = []
        if d['status'] == 'PENDING' and (d['decide_by'] == ctx['staff'] or ctx['can']('tasks.tasks', 'approve')):
            k.append([button(_bot_message('✅ Approve'), f"d:ok:{d['id']}"), button(_bot_message('↩️ Decline'), f"d:no:{d['id']}")])
        k.append([button(_bot_message('👁 View task'), f"t:v:{d['task_id']}")])
        return {'text': '\n'.join(lines), 'keyboard': k}

    def report_view(self, ctx, scope_kind, month, category=''):
        from compat.state import full_state
        b, f = month_bounds(month), {'month': month}
        if scope_kind == 'me':
            f['user'] = ctx['staff']
        elif scope_kind == 'ws':
            f['workspace'] = ctx['workspace']
        full = full_state()
        sc = self.scope().filter_state(full, ctx['staff'], meetings=False)
        mine = [t for t in sc['tm_tasks'] if t['access_reason'] == 'involved'] if scope_kind == 'ws' else sc['tm_tasks']
        ids = {t['id'] for t in mine}
        state = {**full, 'tm_tasks': mine, **{k: [x for x in full[k] if x['task_id'] in ids] for k in
                                              ('tm_task_history', 'tm_assignees', 'tm_checklist', 'tm_due_requests', 'tm_change_requests', 'tm_timesheets')},
                 'lookups': query("SELECT id,name,'staff' AS kind FROM staff ORDER BY id")}
        _, found, summary = monthly_task_rows(state, f)
        ws_name = Workspace.objects.filter(id=ctx['workspace']).values_list('name', flat=True).first() if scope_kind == 'ws' else None
        label = (_bot_message('Your tasks') if scope_kind == 'me' else _bot_message('Your tasks in {p0}', p0=esc(ws_name or 'this workspace')) if scope_kind == 'ws'
                 else _bot_message('Whole company') if sc['task_scope']['company'] else _bot_message('Your tasks and your team’s'))
        running = month == current_month()
        lines = [_bot_message('📊 <b>Monthly task report · {p0}</b>', p0=esc(b['label'])), f"{label}{_bot_message(' · so far this month') if running else ''}", '']
        cats = [('completed', '✅', _bot_message('Completed')), ('in_progress', '🔵', _bot_message('In progress')), ('stuck', '🔴', _bot_message('Stuck')), ('overdue', '⚠️', _bot_message('Overdue'))]
        if not category:
            lines += [f'{icon} {name}: <b>{summary[key]}</b>' for key, icon, name in cats]
        else:
            _, icon, name = next(c for c in cats if c[0] == category)
            listed = [r for r in found if r['category'] == category]
            lines.append(f'{icon} <b>{name} ({len(listed)})</b>')
            if not listed:
                lines.append('None.')
            lines += [f"• <b>{esc(clip(r['title'], 55))}</b> — {esc(self.short(r['pic_id']))}\n    {esc(clip(r['detail'], 90))}" for r in listed[:15]]
            if len(listed) > 15:
                lines.append(_bot_message('…and {p0} more. Open the task app or the Task Controlling Management for the full list.', p0=len(listed) - 15))
        k = [[button(f'{icon} {summary[key]}', f'rep:{scope_kind}:{month}:{key}') for key, icon, _ in cats]]
        nav = [button(f"◀ {month_bounds(shift_month(month, -1))['label'].split(' ')[0][:3]}", f'rep:{scope_kind}:{shift_month(month, -1)}')]
        if not running:
            nav.append(button(f"{month_bounds(shift_month(month, 1))['label'].split(' ')[0][:3]} ▶", f'rep:{scope_kind}:{shift_month(month, 1)}'))
        if category:
            nav.append(button(_bot_message('↩ Summary'), f'rep:{scope_kind}:{month}'))
        k.append(nav)
        if ctx['isPrivate'] and ctx['can']('tasks.reports'):
            k.append([button(_bot_message('🏢 Whole company') if self.scope().company_wide(ctx['staff']) else _bot_message('👥 With my team'), f'rep:all:{month}') if scope_kind == 'me'
                      else button(_bot_message('👤 Only my tasks'), f'rep:me:{month}')])
        if ctx['isPrivate']:
            k.append([button(_bot_message('🏠 Menu'), 'm:home')])
        return {'text': '\n'.join(lines), 'keyboard': k}

    def checklist_view(self, ctx, t, note=''):
        items = rows(ChecklistItem.objects.filter(task_id=t['id']).order_by('position', 'id'))
        can = self.group_allows('checklist', t) if ctx['isGroup'] else 'checklist' in self.actions_for(ctx, t)['allowed']
        lines = [_bot_message('☑️ <b>Steps of work</b> · {p0}', p0=esc(t['title'])), _bot_message('{p0} of {p1} completed', p0=len([i for i in items if i['done']]), p1=len(items)), '']
        lines += [f"{'✅' if i['done'] else '⬜'} {n + 1}. {esc(i['title'])}" for n, i in enumerate(items)]
        if not items:
            lines.append(_bot_message('No steps yet.'))
        if can and items:
            lines += ['', _bot_message('Tap a step to complete it (or reopen it). Steps never change the task’s progress.')]
        if note:
            lines += ['', note]
        k = chunk([button(f"{'✅' if i['done'] else '⬜'} {n + 1}. {clip(i['title'], 24)}", f"k:t:{i['id']}") for n, i in enumerate(items[:30])], 2) if can else []
        foot = []
        if can and ctx['isPrivate']:
            foot.append(button(_bot_message('➕ Add a step'), f"k:add:{t['id']}"))
        foot.append(button(_bot_message('↩ Back to the task'), f"t:v:{t['id']}"))
        k.append(foot)
        return {'text': '\n'.join(lines), 'keyboard': k}

    def files_view(self, ctx, t, note=''):
        files = list(TaskFile.objects.filter(task_id=t['id']).order_by('created_at', 'id').values('id', 'name', 'size', 'uploaded_by_id'))
        lines = [f"📎 <b>Files</b> · {esc(t['title'])}", '']
        lines += [f"{n + 1}. {esc(f['name'])} — {max(1, math.ceil(f['size'] / 1024))} KB · {esc(self.short(f['uploaded_by_id']))}" for n, f in enumerate(files)]
        if not files:
            lines.append(_bot_message('No files yet.'))
        can_add = self.group_allows('file', t) if ctx['isGroup'] else 'file' in self.actions_for(ctx, t)['allowed']
        if can_add:
            lines += ['', _bot_message('To add a photo or document, tap “Attach a file” and send it (up to 30 MB).') if ctx['isPrivate']
                      else _bot_message('To add a photo or document, reply to the task’s message with it (up to 30 MB).')]
        if note:
            lines += ['', note]
        k = [[button(f"⬇️ {n + 1}. {clip(f['name'], 34)}", f"a:g:{f['id']}")] for n, f in enumerate(files[:20])] if ctx['isPrivate'] else []
        foot = []
        if can_add and ctx['isPrivate']:
            foot.append(button(_bot_message('📎 Attach a file'), f"a:add:{t['id']}"))
        foot.append(button(_bot_message('↩ Back to the task'), f"t:v:{t['id']}"))
        k.append(foot)
        if ctx['isGroup'] and files and (self.me or {}).get('username'):
            k.append([{'text': _bot_message('🔒 Get the files privately'), 'url': f"https://t.me/{self.me['username']}?start=task_{t['id']}"}])
        return {'text': '\n'.join(lines), 'keyboard': k}

    # ------------------------------------------------------------ people pickers
    def people(self):
        from compat.state import task_people
        return task_people(Governance())

    def people_rows(self, ctx, prefix, page, exclude=(), selected=(), data=''):
        found = [p for p in self.people() if p['staff_id'] not in exclude]
        found.sort(key=lambda p: 0 if p['staff_id'] == ctx['staff'] else 1)
        pages = max(1, math.ceil(len(found) / PEOPLE_PAGE))
        try:
            p = int(float(page)) if page not in (None, '') else 0
        except (TypeError, ValueError):
            p = 0
        p = min(max(0, p), pages - 1)

        def label(x):
            return (('✅ ' if x['staff_id'] in selected else '') + (f"🙋 Me ({clip(x['name'].split(' · ')[0], 16)})" if x['staff_id'] == ctx['staff'] else clip(x['name'], 28)))
        out = chunk([button(label(x), f"{prefix}{x['staff_id']}") for x in found[p * PEOPLE_PAGE:(p + 1) * PEOPLE_PAGE]], 2)
        if pages > 1:
            nav = []
            if p > 0:
                nav.append(button(_bot_message('◀ Previous'), f'{data}{p - 1}'))
            nav.append(button(_bot_message('{p0} of {p1}', p0=p + 1, p1=pages), 'x:page'))
            if p < pages - 1:
                nav.append(button(_bot_message('Next ▶'), f'{data}{p + 1}'))
            out.append(nav)
        return out, len(found)

    # ------------------------------------------------------------ conversations (multi-step forms)
    def prompt(self, ctx, flow, step, data, question, placeholder):
        text = (f"{self.mention(ctx['from'])}, {question}" if ctx['isGroup'] else _bot_message('{p0}{p1}\n\n<i>Send /cancel to stop.</i>', p0=question[:1].upper(), p1=question[1:]))
        extra = {'reply_markup': {'force_reply': True, 'selective': True, 'input_field_placeholder': clip(placeholder, 64)}}
        if ctx['isGroup'] and ctx.get('messageId') and not ctx.get('callbackMessage'):
            extra['reply_parameters'] = {'message_id': ctx['messageId'], 'allow_sending_without_reply': True}
        m = self.send(ctx, {'text': text}, extra)
        tg.session.set(ctx['chatId'], ctx['from']['id'], flow, step, data, {'prompt_id': m['message_id'], 'message_id': data.get('card')})

    def workspaces_for(self, ctx):
        gov = Governance()
        mine = list(Workspace.objects.filter(members__staff_id=ctx['staff'], status='ACTIVE').order_by('name').values('id', 'name'))
        allowed = [w for w in rows(Workspace.objects.filter(status='ACTIVE').order_by('name')) if gov.can_create_resource(ctx['staff'], w)]
        ids = {w['id'] for w in allowed}
        return [w for w in mine if w['id'] in ids] if mine else allowed

    @staticmethod
    def next_step(d):
        if d.get('sub'):
            return d['sub']
        if d['kind'] == 'request':
            if not d.get('manager_id'):
                return 'manager'
            if not d.get('doer'):
                return 'doer'
            if 'workspace_id' not in d:
                return 'workspace'
            if 'due_date' not in d:
                return 'due'
            return 'confirm'
        if not d.get('workspace_id'):
            return 'workspace'
        if not d.get('pic_id'):
            return 'pic'
        if not d.get('due_date'):
            return 'due'
        return 'confirm'

    def doer_choice(self, doer, d):
        first = self.name_of(d.get('manager_id')).split(' · ')[0]
        return {'RECEIVER': _bot_message('{p0} does it', p0=first), 'REQUESTER': _bot_message('I do it (asking to take it on)'), 'DECIDE': _bot_message('{p0} decides who does it', p0=first)}[doer]

    def flow_view(self, ctx, d):
        step = self.next_step(d)
        ws = Workspace.objects.filter(id=d['workspace_id']).values_list('name', flat=True).first() if d.get('workspace_id') else ''
        title = (_bot_message('➕ <b>New task</b>') if d['kind'] == 'newtask' else _bot_message('📨 <b>Request a task</b>') if d['kind'] == 'request'
                 else _bot_message('✅ <b>Accept task request</b>') if d.get('doer') == 'RECEIVER' else _bot_message('✅ <b>Approve task request</b>'))
        summary = [title, f"<b>{esc(d.get('title'))}</b>"]
        if d['kind'] == 'request' and d.get('manager_id'):
            summary.append(f"Asking: {esc(self.name_of(d['manager_id']))}")
        if d['kind'] == 'request' and d.get('doer'):
            summary.append(_bot_message('Who does it: {p0}', p0=esc(self.doer_choice(d['doer'], d))))
        if ws:
            summary.append(f'Workspace: {esc(ws)}')
        if d.get('pic_id'):
            summary.append(_bot_message('In charge: {p0}', p0=esc(self.name_of(d['pic_id']))))
        if d['kind'] == 'approve':
            summary.append(f"Reviewer: {esc(self.name_of(d['requester'] if d.get('doer') == 'RECEIVER' else ctx['staff']))}")
        if d.get('supporter_ids'):
            summary.append(f"Supporting: {esc(', '.join(self.name_of(x) for x in d['supporter_ids']))}")
        if d.get('due_date'):
            summary.append(f"Due: {fmt_day(d['due_date'])} ({rel_day(d['due_date'])})")
        if d['kind'] != 'approve':
            summary.append(f"Priority: {(d.get('priority') or 'MEDIUM').lower()}")
        if d.get('department_note'):
            summary.append(_bot_message('🏢 Department note: {p0}', p0=esc(clip(d['department_note'], 200))))
        if d.get('description'):
            summary.append(f"📝 {esc(clip(d['description'], 300))}")
        cancel, pages = [button(_bot_message('✖️ Cancel'), 'f:x')], d.get('pages') or {}
        if step == 'workspace':
            question = _bot_message('Which workspace is it for? (optional)') if d['kind'] == 'request' else _bot_message('Which workspace is it for?')
            out = chunk([button(clip(w['name'], 30), f"f:ws:{w['id']}") for w in self.workspaces_for(ctx)[:20]], 2)
            if d['kind'] == 'request':
                out.append([button(_bot_message('Skip — decided when accepted'), 'f:ws:-')])
            out.append(cancel)
            return {'text': '\n'.join([*summary, '', f'<b>{question}</b>']), 'keyboard': out}
        if step == 'pic':
            out, _ = self.people_rows(ctx, 'f:pic:', pages.get('pic'), data='f:pg:pic:')
            out.append(cancel)
            return {'text': '\n'.join([*summary, '', _bot_message('<b>Who is in charge?</b> Everyone who uses Task Management is listed; they are asked to accept.')]), 'keyboard': out}
        if step == 'manager':
            out, count = self.people_rows(ctx, 'f:mgr:', pages.get('mgr'), exclude=[ctx['staff']], data='f:pg:mgr:')
            if not count:
                return {'text': '\n'.join([*summary, '', _bot_message('Nobody else uses Task Management yet. Ask an administrator to add people.')]), 'keyboard': [cancel]}
            out.append(cancel)
            return {'text': '\n'.join([*summary, '', _bot_message('<b>Who are you asking?</b>')]), 'keyboard': out}
        if step == 'doer':
            return {'text': '\n'.join([*summary, '', _bot_message('<b>Who should do it?</b>')]),
                    'keyboard': [[button(f"👤 {clip(self.doer_choice('RECEIVER', d), 40)}", 'f:doer:RECEIVER')],
                                 [button(_bot_message('🙋 Me — I am asking to take it on'), 'f:doer:REQUESTER')],
                                 [button(f"🤔 {clip(self.doer_choice('DECIDE', d), 40)}", 'f:doer:DECIDE')], cancel]}
        if step == 'due':
            out = [[button(_bot_message('Today'), 'f:due:0'), button(_bot_message('Tomorrow'), 'f:due:1')], [button(_bot_message('In 3 days'), 'f:due:3'), button(_bot_message('In a week'), 'f:due:7')],
                   [button(_bot_message('In 2 weeks'), 'f:due:14'), button(_bot_message('Other date…'), 'f:due:other')]]
            if d['kind'] == 'request':
                out.append([button(_bot_message('No date — decided when accepted'), 'f:due:-')])
            out.append(cancel)
            return {'text': '\n'.join([*summary, '', f"<b>{_bot_message('When do you need it?') if d['kind'] == 'request' else _bot_message('When is it due?')}</b>"]), 'keyboard': out}
        if step == 'supporters':
            out, _ = self.people_rows(ctx, 'f:sup:', pages.get('sup'), exclude=[d.get('pic_id')], selected=d.get('supporter_ids') or [], data='f:pg:sup:')
            out.append([button(_bot_message('Done'), 'f:sup:done')])
            return {'text': '\n'.join([*summary, '', _bot_message('<b>Who is supporting?</b> Tap to select, then Done. They are asked to accept.')]), 'keyboard': out}
        if step == 'priority':
            return {'text': '\n'.join([*summary, '', '<b>Priority?</b>']),
                    'keyboard': [[button(_bot_message('🔴 High'), 'f:pri:HIGH'), button(_bot_message('🟡 Medium'), 'f:pri:MEDIUM'), button(_bot_message('🟢 Low'), 'f:pri:LOW')]]}
        n = len(d.get('supporter_ids') or [])
        if d['kind'] == 'newtask':
            out = [[button(_bot_message('✅ Create task'), 'f:ok')], [button(f'🤝 Supporting ({n})', 'f:edit:supporters'), button(_bot_message('⚡ Priority'), 'f:edit:priority')],
                   [button(_bot_message('🎯 Expectation'), 'f:text:description'), button(_bot_message('🏢 Department note'), 'f:text:department_note')]]
        elif d['kind'] == 'request':
            out = [[button(_bot_message('📨 Send request'), 'f:ok')], [button(_bot_message('🎯 Expectation'), 'f:text:description'), button(_bot_message('🏢 Department note'), 'f:text:department_note')],
                   [button(_bot_message('⚡ Priority'), 'f:edit:priority'), button(_bot_message('👤 Who does it'), 'f:edit:doer')]]
        else:
            out = [[button(_bot_message('✅ Accept and create the task') if d.get('doer') == 'RECEIVER' else _bot_message('✅ Approve and create the task'), 'f:ok')],
                   [button(_bot_message('👤 Person in charge'), 'f:edit:pic'), button(_bot_message('📅 Due date'), 'f:edit:due')], [button(f'🤝 Supporting ({n})', 'f:edit:supporters')]]
        out.append(cancel)
        return {'text': '\n'.join([*summary, '', _bot_message('Check the details, then confirm.')]), 'keyboard': out}

    def start_flow(self, ctx, kind, seed=None):
        if not self.need_user(ctx):
            return
        if kind == 'newtask' and not ctx['can']('tasks.tasks', 'create'):
            return self.reply(ctx, _bot_message('Your Task Controlling Management role cannot create tasks. You can still ask someone for a task with /request.'))
        if ctx['isGroup'] and not ctx['workspace'] and kind == 'newtask':
            return self.reply(ctx, _bot_message('Link this group to a workspace first: an administrator can send /connect here.'))
        d = {'kind': kind, 'supporter_ids': [], 'priority': 'MEDIUM', 'description': '', 'department_note': '', 'pages': {}, **(seed or {})}
        if ctx['isGroup'] and ctx['workspace'] and kind != 'approve':
            d['workspace_id'] = ctx['workspace']
        if kind != 'approve' and not d.get('title'):
            return self.prompt(ctx, 'flow', 'title', d, _bot_message('what is the task? Reply with a short title.') if kind == 'newtask'
                               else _bot_message('what do you need? Reply with a short title for your request.'), _bot_message('Task title') if kind == 'newtask' else _bot_message('Request title'))
        if kind == 'newtask' and not d.get('workspace_id'):
            listed = self.workspaces_for(ctx)
            if len(listed) == 1:
                d['workspace_id'] = listed[0]['id']
        view = self.flow_view(ctx, d)
        ctx['editId'] = d.get('card') or None
        d['card'] = self.show(ctx, view)
        tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': d['card']})

    def reply(self, ctx, text):
        if ctx.get('callbackId'):
            return self.answer(ctx, text, True)
        return self.say(ctx, text)

    def on_flow_button(self, ctx, parts):
        what, value, extra = (parts + [None, None, None])[:3]
        s = tg.session.get(ctx['chatId'], ctx['from']['id'])
        if not s or s['flow'] != 'flow' or (s['data'].get('card') and s['data']['card'] != ctx['callbackMessage']['message_id']):
            return self.answer(ctx, _bot_message('This form belongs to someone else or has expired. Start again with /newtask or /request.'), True)
        if not self.need_user(ctx):
            return
        d = s['data']
        d['pages'] = d.get('pages') or {}

        def person(key):
            return any(p['staff_id'] == key for p in self.people())
        if what == 'x':
            tg.session.clear(ctx['chatId'], ctx['from']['id'])
            self.show(ctx, {'text': f"{_bot_message('Answer') if d['kind'] == 'approve' else _bot_message('Form')} cancelled.", 'keyboard': []})
            return self.answer(ctx, 'Cancelled.')
        if what == 'pg' and value in ('pic', 'sup', 'mgr'):
            try:
                d['pages'][value] = max(0, int(float(extra or 0)))
            except ValueError:
                d['pages'][value] = 0
        elif what == 'ws':
            if value == '-':
                d['workspace_id'] = None
            elif any(w['id'] == value for w in self.workspaces_for(ctx)):
                d['workspace_id'] = value
        elif what == 'pic' and person(value):
            d['pic_id'] = value
            d['supporter_ids'] = [x for x in d.get('supporter_ids') or [] if x != value]
            d['sub'] = None
        elif what == 'mgr' and person(value) and value != ctx['staff']:
            d['manager_id'], d['sub'] = value, None
        elif what == 'doer' and value in ('RECEIVER', 'REQUESTER', 'DECIDE'):
            d['doer'], d['sub'] = value, None
        elif what == 'due' and not re.fullmatch(r'\d{1,3}|-|other', value or ''):
            return self.answer(ctx)
        elif what == 'due':
            if value == 'other':
                tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': d.get('card')})
                self.answer(ctx)
                return self.prompt(ctx, 'flow', 'due_date', d, _bot_message('send the due date, for example 2026-10-05 or 5/10.'), _bot_message('YYYY-MM-DD or day/month'))
            d['due_date'] = None if value == '-' else dm.add_days(dm.task_today(), int(value))
            d['sub'] = None
        elif what == 'sup':
            if value == 'done':
                d['sub'] = None
            elif person(value) and value != d.get('pic_id'):
                d['supporter_ids'] = [x for x in d['supporter_ids'] if x != value] if value in d['supporter_ids'] else [*d['supporter_ids'], value]
        elif what == 'pri' and value in ('HIGH', 'MEDIUM', 'LOW'):
            d['priority'], d['sub'] = value, None
        elif what == 'edit' and value in ('supporters', 'priority', 'pic', 'due', 'doer'):
            d['sub'] = value
        elif what == 'text' and value in ('description', 'department_note'):
            tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': d.get('card')})
            self.answer(ctx)
            if value == 'description':
                question = (_bot_message('send the expectation: the result you expect, and how you’ll know it is done (up to a few paragraphs).') if d['kind'] == 'request'
                            else _bot_message('send the details (up to a few paragraphs).'))
                return self.prompt(ctx, 'flow', value, d, question, _bot_message('Expectation') if d['kind'] == 'request' else _bot_message('Details'))
            return self.prompt(ctx, 'flow', value, d, _bot_message('send the department note — which department or team this is for and anything they should know.'), _bot_message('Department note'))
        elif what == 'ok':
            return self.finish_flow(ctx, d)
        tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': d.get('card')})
        self.show(ctx, self.flow_view(ctx, d))
        self.answer(ctx)

    def finish_flow(self, ctx, d):
        if d['kind'] in ('newtask', 'request') and not str(d.get('description') or '').strip():
            self.answer(ctx)
            return self.prompt(ctx, 'flow', 'description', d, _bot_message('send the expected result before creating this task.'), 'Expectation (required)')
        if d['kind'] == 'newtask':
            today = dm.task_today()
            start = today if today <= d['due_date'] else d['due_date']
            r = self.perform(ctx, 'tm.task.save', {'workspace_id': d['workspace_id'], 'title': d['title'], 'description': d['description'],
                                                   'department_note': d['department_note'], 'priority': d['priority'], 'start_date': start,
                                                   'due_date': d['due_date'], 'pic_id': d['pic_id'], 'supporter_ids': d['supporter_ids'],
                                                   'request_key': f"tg:{ctx['chatId']}:{d.get('card')}"})
        elif d['kind'] == 'request':
            r = self.perform(ctx, 'tm.request.save', {'title': d['title'], 'description': d['description'], 'department_note': d['department_note'],
                                                      'priority': d['priority'], 'manager_id': d.get('manager_id'), 'doer': d.get('doer'),
                                                      'workspace_id': d.get('workspace_id') or None, 'proposed_due_date': d.get('due_date') or None,
                                                      'request_key': f"tg:{ctx['chatId']}:{d.get('card')}"})
        else:
            r = self.perform(ctx, 'tm.request.decide', {'id': d['request_id'], 'decision': 'APPROVE', 'workspace_id': d.get('workspace_id'),
                                                        'pic_id': d.get('pic_id'), 'supporter_ids': d.get('supporter_ids'), 'due_date': d.get('due_date')})
        if not r['ok']:
            return self.answer(ctx, r['error'], True)
        tg.session.clear(ctx['chatId'], ctx['from']['id'])
        self.answer(ctx, r['result'].get('message') or 'Done.')
        if r['result'].get('type') == 'tm_request':
            q = row(TaskRequest.objects.get(id=r['result']['id']))
            return self.show(ctx, self.request_view(ctx, q, f"✅ {esc(r['result'].get('message'))}"))
        t = self.load_task(r['result']['id'])
        if t:
            return self.show(ctx, self.task_view(ctx, t, f"✅ {esc(r['result'].get('message'))}"))

    def outcome(self, r):
        return f"✅ {esc(r['result'].get('message'))}" if r['ok'] else f"⚠️ {esc(r['error'])}"

    def on_answer(self, ctx, s, text):
        d, value = s['data'], None if text is None else str(text).strip()
        self.remove(ctx['chatId'], s.get('prompt_id'))
        if s['flow'] == 'flow':
            if s['step'] == 'title':
                if not value:
                    return self.prompt(ctx, 'flow', 'title', d, _bot_message('please send a title.'), _bot_message('Title'))
                d['title'] = clip(value, 300)
                ctx['editId'] = None
                return self.start_flow(ctx, d['kind'], d)
            if s['step'] == 'due_date':
                day = parse_day(value) if value else None
                if not day:
                    return self.prompt(ctx, 'flow', 'due_date', d, _bot_message('I could not read that date. Send it like 2026-10-05 or 5/10.'), 'YYYY-MM-DD')
                if day < dm.task_today():
                    return self.prompt(ctx, 'flow', 'due_date', d, _bot_message('that date has passed. Send a date from today onward.'), 'YYYY-MM-DD')
                d['due_date'], d['sub'] = day, None
            if s['step'] == 'description':
                d['description'] = js_slice(value, 8000) if value else ''
            if s['step'] == 'department_note':
                d['department_note'] = js_slice(value, 2000) if value else ''
            tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': d.get('card')})
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.flow_view(ctx, d))
        if s['flow'] == 'attach':
            if value is None:
                tg.session.clear(ctx['chatId'], ctx['from']['id'])
                return self.say(ctx, _bot_message('OK, no file was attached.'))
            return self.prompt(ctx, 'attach', 'file', d, _bot_message('send the photo or document itself (as a file or photo), or send /cancel.'), _bot_message('Photo or document'))
        tg.session.clear(ctx['chatId'], ctx['from']['id'])
        if s['flow'] == 'check':
            t = self.load_task(d.get('id'))
            if not self.can_see(ctx, t):
                return self.say(ctx, _bot_message('That task is no longer available.'))
            if not value:
                return self.prompt(ctx, 'check', 'x', d, _bot_message('send the step, for example “Photograph the seal”.'), _bot_message('Step'))
            r = self.perform(ctx, 'tm.check.add', {'task_id': t['id'], 'title': clip(value, 300)})
            fresh = self.load_task(t['id'])
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.checklist_view(ctx, fresh or t, self.outcome(r)))
        if s['flow'] == 'task':
            t = self.load_task(d.get('id'))
            if not self.can_see(ctx, t):
                return self.say(ctx, _bot_message('That task is no longer available.'))
            if d['verb'] == 'progress':
                n = js_int(value)
                if n is None or n < 0 or n > 99:
                    return self.prompt(ctx, 'task', 'x', d, _bot_message('send a whole number from 0 to 99. (Use Close or Submit when the work is finished.)'), '0–99')
                r = self.perform(ctx, 'tm.task.progress', {'id': t['id'], 'progress': n})
            elif d['verb'] == 'due':
                if not d.get('date'):
                    day = parse_day(value) if value else None
                    if not day:
                        return self.prompt(ctx, 'task', 'x', d, _bot_message('I could not read that date. Send it like 2026-10-05 or 5/10.'), 'YYYY-MM-DD')
                    d['date'] = day
                    return self.prompt(ctx, 'task', 'x', d, _bot_message('why do you need {p0}? The person who approves it will see this reason.', p0=fmt_day(day)), _bot_message('Reason'))
                if not value:
                    return self.prompt(ctx, 'task', 'x', d, _bot_message('please give a short reason.'), _bot_message('Reason'))
                r = self.perform(ctx, 'tm.due.request', {'task_id': t['id'], 'proposed_due_date': d['date'], 'reason': value})
            else:
                if d['verb'] in ('decline', 'stuck', 'return', 'note', 'cancel') and not value:
                    return self.prompt(ctx, 'task', 'x', d, _bot_message('this needs a short note. Please reply with it.'), _bot_message('Note'))
                r = self.perform(ctx, 'tm.task.' + d['verb'], {'id': t['id'], 'note': value or ''})
            fresh = self.load_task(t['id'])
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.task_view(ctx, fresh, self.outcome(r)) if fresh else {'text': self.outcome(r)})
        if s['flow'] == 'request':
            if not value:
                return self.prompt(ctx, 'request', 'x', d, _bot_message('please reply with a short reason.'), _bot_message('Reason'))
            r = self.perform(ctx, 'tm.request.decide', {'id': d['id'], 'decision': 'DECLINE', 'note': value})
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.request_view(ctx, row(TaskRequest.objects.get(id=d['id'])), self.outcome(r)))
        if s['flow'] == 'change':
            if not value:
                return self.prompt(ctx, 'change', 'x', d, _bot_message('please reply with a short reason.'), _bot_message('Reason'))
            r = self.perform(ctx, 'tm.change.decide', {'id': d['id'], 'decision': 'REJECT', 'note': value})
            task_id = TaskChangeRequest.objects.filter(id=d['id']).values_list('task_id', flat=True).first()
            t = self.load_task(task_id) if task_id else None
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.task_view(ctx, t, self.outcome(r)) if t else {'text': self.outcome(r)})
        if s['flow'] == 'due':
            if not value:
                return self.prompt(ctx, 'due', 'x', d, _bot_message('please reply with a short reason.'), _bot_message('Reason'))
            r = self.perform(ctx, 'tm.due.decide', {'id': d['id'], 'decision': 'DECLINE', 'note': value})
            ctx['editId'] = d.get('card')
            return self.show(ctx, self.due_view(ctx, row(DueDateRequest.objects.get(id=d['id'])), self.outcome(r)))

    def on_media(self, ctx, m):
        import base64
        session = tg.session.get(ctx['chatId'], m['from']['id'])
        task_id = (session['data'].get('id') if session and session['flow'] == 'attach' and
                   (not ctx['isGroup'] or (m.get('reply_to_message') or {}).get('message_id') == session.get('prompt_id')) else None)
        replied = m.get('reply_to_message') or {}
        if not task_id and (replied.get('from') or {}).get('id') and replied['from']['id'] == (self.me or {}).get('id'):
            found = TASK_ID.search(str(replied.get('text') or replied.get('caption') or ''))
            task_id = found.group(1) if found else None
        if not task_id:
            if ctx['isPrivate'] and ctx.get('link'):
                self.say(ctx, _bot_message('To add this to a task, open the task, tap 📎 Files → Attach a file, and send it again. You can also reply to a task’s message with the file.'))
            return
        if not self.need_user(ctx):
            return
        t = self.load_task(task_id)
        if not self.can_see(ctx, t):
            return self.say(ctx, _bot_message('That task is not available to you.'))
        if m.get('document'):
            file_id, name, size = m['document']['file_id'], m['document'].get('file_name') or 'document', m['document'].get('file_size') or 0
        else:
            sizes = sorted(m['photo'], key=lambda p: p.get('file_size') or 0)
            fitting = [p for p in sizes if (p.get('file_size') or 0) <= MAX_FILE]
            best = fitting[-1] if fitting else sizes[0]
            file_id, size = best['file_id'], best.get('file_size') or 0
            name = f"photo-{re.sub(r'[-:T]', '', datetime.now(dt_timezone.utc).strftime('%Y-%m-%dT%H:%M'))}.jpg"
        too_big = _bot_message('⚠️ That file is larger than 30 MB. Send a smaller file, or add it in the Task Controlling Management.')
        if size > 20 * 1024 * 1024 and self.api_base == 'https://api.telegram.org':
            return self.say(ctx, _bot_message('Files over 20 MB must be uploaded from the Telegram Mini App or web system (up to 30 MB per file).'))
        if size > MAX_FILE:
            return self.say(ctx, too_big)
        try:
            f = self.call('getFile', {'file_id': file_id})
            if (f.get('file_size') or 0) > MAX_FILE:
                return self.say(ctx, too_big)
            content = self.transport['download'](f['file_path'])
        except TelegramError as e:
            if e.too_large:
                return self.say(ctx, too_big)
            tg.log('warn', ctx['chatId'], _bot_message('File download: {p0}', p0=e))
            return self.say(ctx, _bot_message('⚠️ I could not get that file from Telegram. Please try again.'))
        r = self.perform(ctx, 'tm.file.add', {'task_id': t['id'], 'name': name, 'base64': base64.b64encode(content).decode()})
        if session and session['flow'] == 'attach':
            tg.session.clear(ctx['chatId'], m['from']['id'])
            self.remove(ctx['chatId'], session.get('prompt_id'))
        return self.send(ctx, self.files_view(ctx, self.load_task(t['id']) or t, self.outcome(r)))

    # ------------------------------------------------------------ buttons
    def on_task_button(self, ctx, parts):
        verb, key, extra, more = (parts + [None, None, None, None])[:4]
        if not self.need_user(ctx):
            return
        t = self.load_task(key)
        if not t:
            return self.answer(ctx, _bot_message('This task no longer exists.'), True)
        if not self.can_see(ctx, t):
            return self.answer(ctx, _bot_message('This task belongs to another workspace.'), True)
        card = ctx['callbackMessage']['message_id']

        def act(action, data):
            r = self.perform(ctx, action, data)
            self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
            fresh = self.load_task(t['id'])
            if fresh:
                self.show(ctx, self.task_view(ctx, fresh, f"✅ {esc(r['result'].get('message'))}" if r['ok'] else ''))
        if verb == 'v':
            self.show(ctx, self.task_view(ctx, t))
            return self.answer(ctx)
        simple = {'acc': 'tm.task.accept', 'res': 'tm.task.resume', 'rm': 'tm.task.remind', 'pas': 'tm.task.pass', 'cls!': 'tm.task.close'}
        if verb in simple:
            return act(simple[verb], {'id': key})
        if verb == 'p':
            n = js_int(extra)
            if n is None or n < 0 or n > 99:
                return self.answer(ctx, _bot_message('Choose a value from the list.'))
            return act('tm.task.progress', {'id': key, 'progress': n})
        if verb == 'ck':
            self.show(ctx, self.checklist_view(ctx, t))
            return self.answer(ctx)
        if verb == 'fl':
            self.show(ctx, self.files_view(ctx, t))
            return self.answer(ctx)
        if verb == 'prg':
            k = [[button(f'{n}%', f't:p:{key}:{n}') for n in (10, 25, 50)], [*(button(f'{n}%', f't:p:{key}:{n}') for n in (75, 90)), button(_bot_message('Other…'), f't:po:{key}')],
                 [button(_bot_message('↩ Back'), f't:v:{key}')]]
            self.show(ctx, {'text': self.task_view(ctx, t)['text'] + _bot_message('\n\n📈 <b>How far along is it?</b>'), 'keyboard': k})
            return self.answer(ctx)
        if verb == 'po':
            self.answer(ctx)
            return self.prompt(ctx, 'task', 'x', {'verb': 'progress', 'id': key, 'card': card}, _bot_message('send the progress as a number from 0 to 99.'), '0–99')
        actions = self.actions_for(ctx, t)
        allowed, roles = actions['allowed'], actions['roles']

        def blocked(v):
            b = dm.task_block(v, t, roles)
            return (b or {}).get('message') or _bot_message('This action is not available.')
        if verb == 'cls':
            if 'close' not in allowed:
                return self.answer(ctx, blocked('close'), True)
            other = dm.approval_target(t, ctx['staff'])
            asking = other and t['status'] != 'IN_REVIEW'
            question = (_bot_message('✔️ <b>Ask {p0} to approve completing this task?</b> It stays open until they approve.', p0=esc(self.name_of(other))) if asking
                        else _bot_message('✔️ <b>Approve completing this task?</b>') if (t['change_request'] or {}).get('kind') == 'COMPLETE' else _bot_message('✔️ <b>Close this task as completed?</b>'))
            self.show(ctx, {'text': self.task_view(ctx, t)['text'] + '\n\n' + question,
                            'keyboard': [[button(_bot_message('✔️ Yes, ask') if asking else _bot_message('✔️ Yes, complete it'), f't:cls!:{key}'), button(_bot_message('↩ Back'), f't:v:{key}')]]})
            return self.answer(ctx)
        if verb in ('ho', 'hop', 'hp', 'hx'):
            if 'handover' not in allowed:
                return self.answer(ctx, blocked('handover'), True)
            if verb == 'hx':
                r = self.perform(ctx, 'tm.task.handover', {'id': key, 'to_id': extra, 'keep': more == '1'})
                self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
                return self.show(ctx, self.task_view(ctx, self.load_task(key) or t, self.outcome(r)))
            if verb == 'hp':
                if not any(p['staff_id'] == extra for p in self.people()):
                    return self.answer(ctx, _bot_message('Choose someone from the list.'))
                self.show(ctx, {'text': _bot_message('{p0}\n\n🔁 <b>Hand this task over to {p1}?</b> They are asked to accept it.', p0=self.task_view(ctx, t)['text'], p1=esc(self.name_of(extra))),
                                'keyboard': [[button(_bot_message('🔁 Hand over'), f't:hx:{key}:{extra}:0')], [button(_bot_message('🤝 Hand over, and keep me as supporting'), f't:hx:{key}:{extra}:1')],
                                             [button(_bot_message('↩ Back'), f't:ho:{key}')]]})
                return self.answer(ctx)
            listed, _ = self.people_rows(ctx, f't:hp:{key}:', extra if verb == 'hop' else 0, exclude=[t['pic_id']], data=f't:hop:{key}:')
            listed.append([button(_bot_message('↩ Back'), f't:v:{key}')])
            self.show(ctx, {'text': _bot_message('{p0}\n\n🔁 <b>Who should take charge?</b>', p0=self.task_view(ctx, t)['text']), 'keyboard': listed})
            return self.answer(ctx)
        action = {'dec': 'decline', 'stk': 'stuck', 'ret': 'return', 'note': 'note', 'sub': 'submit', 'due': 'due', 'can': 'cancel'}.get(verb)
        if not action:
            return self.answer(ctx, _bot_message('This button is no longer available.'))
        if action not in allowed:
            return self.answer(ctx, blocked(action), True)
        self.answer(ctx)
        if action == 'due':
            return self.prompt(ctx, 'task', 'x', {'verb': 'due', 'id': key, 'card': card},
                               _bot_message('what due date do you need instead of {p0}? For example 2026-10-05 or 5/10.', p0=fmt_day(t['due_date'])), _bot_message('YYYY-MM-DD or day/month'))
        question, placeholder = render(QUESTIONS[action])
        return self.prompt(ctx, 'task', 'x', {'verb': action, 'id': key, 'card': card}, question, placeholder)

    def on_check_button(self, ctx, parts):
        verb, key = (parts + [None, None])[:2]
        if not self.need_user(ctx):
            return
        if verb == 'add':
            t = self.load_task(key)
            if not self.can_see(ctx, t):
                return self.answer(ctx, _bot_message('This task is not available to you.'), True)
            actions = self.actions_for(ctx, t)
            if 'checklist' not in actions['allowed']:
                return self.answer(ctx, (dm.task_block('checklist', t, actions['roles']) or {}).get('message') or _bot_message('You cannot change this checklist.'), True)
            self.answer(ctx)
            return self.prompt(ctx, 'check', 'x', {'id': key, 'card': ctx['callbackMessage']['message_id']}, _bot_message('send the new step.'), _bot_message('Step'))
        item = row(ChecklistItem.objects.filter(id=key).first()) if isinstance(key, str) else None
        t = self.load_task(item['task_id']) if item else None
        if not item or not self.can_see(ctx, t):
            return self.answer(ctx, _bot_message('This step is no longer available.'), True)
        r = self.perform(ctx, 'tm.check.toggle', {'id': key, 'done': not item['done']})
        self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
        return self.show(ctx, self.checklist_view(ctx, self.load_task(t['id']) or t))

    def on_file_button(self, ctx, parts):
        verb, key = (parts + [None, None])[:2]
        if not self.need_user(ctx):
            return
        if verb == 'add':
            t = self.load_task(key)
            if not self.can_see(ctx, t):
                return self.answer(ctx, _bot_message('This task is not available to you.'), True)
            actions = self.actions_for(ctx, t)
            if 'file' not in actions['allowed']:
                return self.answer(ctx, (dm.task_block('file', t, actions['roles']) or {}).get('message') or _bot_message('You cannot add files to this task.'), True)
            self.answer(ctx)
            return self.prompt(ctx, 'attach', 'file', {'id': key, 'card': ctx['callbackMessage']['message_id']},
                               _bot_message('send the photo or document for “{p0}” (up to 30 MB).', p0=clip(t['title'], 60)), _bot_message('Photo or document'))
        if verb == 'g':
            if not ctx['isPrivate']:
                return self.answer(ctx, _bot_message('Open the task in a private chat with me to get its files.'), True)
            f = TaskFile.objects.filter(id=key).first() if isinstance(key, str) else None
            t = self.load_task(f.task_id) if f else None
            if not f or not self.can_see(ctx, t):
                return self.answer(ctx, _bot_message('This file is no longer available.'), True)
            self.answer(ctx, 'Sending…')
            try:
                self.transport['upload']('sendDocument', ctx['chatId'], 'document', {'content': bytes(f.content), 'mime': f.mime, 'name': f.name},
                                         {'caption': f"{f.name} · {t['id']}"})
            except TelegramError as e:
                tg.log('warn', ctx['chatId'], _bot_message('Send file: {p0}', p0=e))
                self.say(ctx, _bot_message('⚠️ I could not send that file. Please try again, or open it in the Task Controlling Management.'))
            return
        return self.answer(ctx)

    def on_request_button(self, ctx, parts):
        verb, key, extra = (parts + [None, None, None])[:3]
        if not self.need_user(ctx):
            return
        q = row(TaskRequest.objects.filter(id=key).first()) if isinstance(key, str) else None
        if not q or not self.scope().can_see_request(ctx['staff'], q):
            return self.answer(ctx, _bot_message('This request is not available to you.'), True)
        if ctx['isGroup'] and q['workspace_id'] != ctx['workspace']:
            return self.answer(ctx, _bot_message('Open this request in a private chat with me.'), True)
        card = ctx['callbackMessage']['message_id']

        def fresh():
            return row(TaskRequest.objects.get(id=key))
        if verb == 'v':
            self.show(ctx, self.request_view(ctx, q))
            return self.answer(ctx)
        if verb == 'wd':
            r = self.perform(ctx, 'tm.request.withdraw', {'id': key})
            self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
            return self.show(ctx, self.request_view(ctx, fresh()))
        if q['manager_id'] != ctx['staff']:
            return self.answer(ctx, _bot_message('Only the person this request was sent to can answer it.'), True)
        if q['status'] != 'PENDING':
            self.show(ctx, self.request_view(ctx, q))
            return self.answer(ctx, _bot_message('This request has already been answered.'), True)
        if verb == 'no':
            self.answer(ctx)
            return self.prompt(ctx, 'request', 'x', {'id': key, 'card': card}, _bot_message('why are you declining this request? The requester will see this.'), _bot_message('Reason'))
        if verb in ('fw', 'fp'):
            listed, count = self.people_rows(ctx, f'r:to:{key}:', extra if verb == 'fp' else 0, exclude=[ctx['staff'], q['requested_by']], data=f'r:fp:{key}:')
            if not count:
                return self.answer(ctx, _bot_message('There is nobody else to pass it to.'), True)
            listed.append([button(_bot_message('↩ Back'), f'r:v:{key}')])
            self.show(ctx, {'text': self.request_view(ctx, q)['text'] + _bot_message('\n\n👥 <b>Pass it to whom?</b>'), 'keyboard': listed})
            return self.answer(ctx)
        if verb == 'to':
            r = self.perform(ctx, 'tm.request.forward', {'id': key, 'manager_id': extra})
            self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
            return self.show(ctx, self.request_view(ctx, fresh()))
        if verb == 'ok':
            doer = q.get('doer') or 'REQUESTER'
            d = {'kind': 'approve', 'request_id': q['id'], 'requester': q['requested_by'], 'doer': doer, 'title': q['title'], 'workspace_id': q['workspace_id'] or None,
                 'pic_id': ctx['staff'] if doer == 'RECEIVER' else q['requested_by'] if doer == 'REQUESTER' else None,
                 'due_date': q['proposed_due_date'] if q.get('proposed_due_date') and q['proposed_due_date'] >= dm.task_today() else None,
                 'supporter_ids': [], 'pages': {}, 'card': card}
            if not d['workspace_id']:
                listed = self.workspaces_for(ctx)
                if len(listed) == 1:
                    d['workspace_id'] = listed[0]['id']
            tg.session.set(ctx['chatId'], ctx['from']['id'], 'flow', 'buttons', d, {'message_id': card})
            self.show(ctx, self.flow_view(ctx, d))
            return self.answer(ctx)
        return self.answer(ctx)

    def on_due_button(self, ctx, parts):
        verb, key = (parts + [None, None])[:2]
        if not self.need_user(ctx):
            return
        d = row(DueDateRequest.objects.filter(id=key).first()) if isinstance(key, str) else None
        t = self.load_task(d['task_id']) if d else None
        if not d or not self.can_see(ctx, t):
            return self.answer(ctx, _bot_message('This request is not available to you.'), True)
        if verb == 'v':
            self.show(ctx, self.due_view(ctx, d))
            return self.answer(ctx)
        if verb == 'ok':
            r = self.perform(ctx, 'tm.due.decide', {'id': key, 'decision': 'APPROVE'})
            self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
            return self.show(ctx, self.due_view(ctx, row(DueDateRequest.objects.get(id=key))))
        if verb == 'no':
            if d['decide_by'] != ctx['staff'] and not ctx['can']('tasks.tasks', 'approve'):
                return self.answer(ctx, _bot_message('Only the task’s reviewer or a task approver can decide this request.'), True)
            self.answer(ctx)
            return self.prompt(ctx, 'due', 'x', {'id': key, 'card': ctx['callbackMessage']['message_id']}, _bot_message('why are you declining the new date?'), _bot_message('Reason'))
        return self.answer(ctx)

    def on_change_button(self, ctx, parts):
        verb, key = (parts + [None, None])[:2]
        if not self.need_user(ctx):
            return
        c = row(TaskChangeRequest.objects.filter(id=key).first()) if isinstance(key, str) else None
        t = self.load_task(c['task_id']) if c else None
        if not c or not self.can_see(ctx, t) or (c['approver_id'] != ctx['staff'] and c['requested_by'] != ctx['staff']):
            return self.answer(ctx, _bot_message('This request is not available to you.'), True)
        if ctx['isGroup']:
            return self.answer(ctx, _bot_message('Open the task in a private chat with me to decide changes.'), True)
        card = ctx['callbackMessage']['message_id']
        if c['status'] != 'PENDING':
            self.show(ctx, self.task_view(ctx, t))
            return self.answer(ctx, _bot_message('This request has already been decided.'), True)
        if verb in ('wd', 'ok'):
            r = (self.perform(ctx, 'tm.change.withdraw', {'id': key}) if verb == 'wd'
                 else self.perform(ctx, 'tm.change.decide', {'id': key, 'decision': 'APPROVE'}))
            self.answer(ctx, r['result'].get('message') if r['ok'] else r['error'], not r['ok'])
            return self.show(ctx, self.task_view(ctx, self.load_task(c['task_id']) or t, self.outcome(r)))
        if verb == 'no':
            if c['approver_id'] != ctx['staff']:
                return self.answer(ctx, _bot_message('Only {p0} can reject this request.', p0=self.name_of(c['approver_id'])), True)
            self.answer(ctx)
            return self.prompt(ctx, 'change', 'x', {'id': key, 'card': card}, _bot_message('why are you rejecting this change? The person who asked will see your reason.'), _bot_message('Reason'))
        return self.answer(ctx)

    def on_menu_button(self, ctx, parts):
        what, page = (parts + [None, None])[:2]
        if not self.need_user(ctx):
            return
        p = max(0, js_int(page) or 0) if page not in (None, '') else 0
        if what == 'home':
            self.show(ctx, self.menu_view(ctx))
            return self.answer(ctx)
        if what in ('my', 'sup', 'ws', 'ans'):
            if what == 'ws' and not ctx['workspace']:
                return self.answer(ctx, _bot_message('This group is not linked to a workspace.'), True)
            self.show(ctx, self.list_view(ctx, what, p))
            return self.answer(ctx)
        if what == 'rev':
            self.show(ctx, self.review_view(ctx))
            return self.answer(ctx)
        if what == 'req':
            self.show(ctx, self.my_requests_view(ctx))
            return self.answer(ctx)
        if what in ('new', 'ask'):
            self.answer(ctx)
            ctx['callbackMessage'] = None
            return self.start_flow(ctx, 'newtask' if what == 'new' else 'request')
        return self.answer(ctx)

    def on_report_button(self, ctx, parts):
        scope_kind, month, category = (parts + [None, None, None])[:3]
        if not self.need_user(ctx):
            return
        if scope_kind not in ('me', 'all', 'ws') or not re.fullmatch(r'\d{4}-\d{2}', month or ''):
            return self.answer(ctx)
        if scope_kind == 'all' and not ctx['can']('tasks.reports'):
            return self.answer(ctx, _bot_message('Your role cannot view company-wide task reports.'), True)
        if scope_kind == 'ws' and not ctx['workspace']:
            return self.answer(ctx, _bot_message('This group is not linked to a workspace.'), True)
        if month > current_month():
            return self.answer(ctx, _bot_message('That month has not started yet.'))
        if category and category not in ('completed', 'in_progress', 'stuck', 'overdue'):
            return self.answer(ctx)
        try:
            self.show(ctx, self.report_view(ctx, scope_kind, month, category or ''))
        except InputError as e:
            return self.answer(ctx, e.message, True)
        return self.answer(ctx)

    def linkable_workspaces(self, ctx):
        gov = Governance()
        return [w for w in rows(Workspace.objects.filter(status='ACTIVE').order_by('name'))
                if not is_personal_workspace(w) and gov.can_manage_workspace(ctx['staff'], w)
                and (ctx['can']('admin.telegram', 'update') or (ctx['can']('tasks.workspace', 'update') and w['owner_id'] == ctx['staff']))]

    def on_group_button(self, ctx, parts):
        what, key = (parts + [None, None])[:2]
        if not ctx['isGroup']:
            return self.answer(ctx)
        if not self.need_user(ctx):
            return
        allowed = self.linkable_workspaces(ctx)
        if what == 'ws' and not any(w['id'] == key for w in allowed):
            return self.answer(ctx, NOT_ALLOWED, True)
        if what == 'off' and not (ctx['can']('admin.telegram', 'update') or any(w['id'] == ctx['workspace'] for w in allowed)):
            return self.answer(ctx, NOT_ALLOWED, True)
        if what == 'ws':
            w = tg.link_group(Governance(), ctx['chatId'], key, ctx['staff'])
            if not w:
                return self.answer(ctx, _bot_message('Choose an active workspace.'), True)
            self.show(ctx, {'text': _bot_message('✅ This group is now linked to <b>{p0}</b>.\n\nTask updates for this workspace will be posted here. Members who connected their Telegram to the Task Controlling Management can use /tasks, /mytasks, /newtask and /report.', p0=esc(w['name'])),
                            'keyboard': [[button(_bot_message('🗂 Open tasks'), 'm:ws:0')]]})
            return self.answer(ctx, _bot_message('Group linked.'))
        if what == 'off':
            tg.unlink_group(ctx['chatId'], ctx['staff'])
            self.show(ctx, {'text': _bot_message('This group is no longer linked to a workspace.'), 'keyboard': []})
            return self.answer(ctx, _bot_message('Group unlinked.'))
        return self.answer(ctx)

    # ------------------------------------------------------------ commands
    def link(self, ctx, code):
        if not ctx['isPrivate']:
            return self.say(ctx, _bot_message('For your security, connect your account in a private chat with me, not in a group.'))
        key, f = str(ctx['from']['id']), self.link_failures.get(str(ctx['from']['id']))
        now = time.monotonic()
        if f and f['count'] >= 5 and now - f['at'] < 900:
            return self.say(ctx, _bot_message('Too many incorrect codes. Please wait 15 minutes and try again with the link from the Task Controlling Management.'))
        r = tg.redeem(code, ctx['from'], ctx['chatId'])
        if r.get('error'):
            self.link_failures[key] = {'count': (f['count'] if f and now - f['at'] < 900 else 0) + 1, 'at': now}
            return self.say(ctx, f"⚠️ {r['error']}", self.sign_in())
        self.link_failures.pop(key, None)
        fresh = self.context(ctx['chat'], ctx['from'])
        if not fresh['user']:
            return self.say(ctx, _bot_message('✅ Connected. Your Task Controlling Management role does not include Task Management yet, so ask an administrator for access.'))
        return self.send(fresh, self.menu_view(fresh, _bot_message('✅ <b>Connected!</b> This Telegram account now works as <b>{p0}</b> in the Task Controlling Management.', p0=esc(r['name']))))

    def help_text(self, ctx):
        if ctx['isGroup']:
            return (_bot_message('<b>Task Management in this group</b>\n\n')
                    + '\n'.join(f'/{c} – {render(d)}' for c, d in GROUP_COMMANDS)
                    + _bot_message('\n\nOpen the bot in a private chat or use the Mini App to view and update Tasks, reports and attachments. Task information follows each employee’s permissions.'))
        return (_bot_message('<b>What I can do</b>\n\n') + '\n'.join(f'/{c} – {render(d)}' for c, d in PRIVATE_COMMANDS) + _bot_message('\n\nTap the buttons under a task to accept or reject it, update progress, tick its checklist, mark it stuck, submit it for review, close or cancel it, or hand it over. To attach a photo or document, reply to a task’s message with it. Everything you do here is saved in the Task Controlling Management straight away.'))

    def on_command(self, ctx, cmd, args):
        if cmd == 'start':
            if args.startswith('link_'):
                return self.link(ctx, args[5:])
            if not ctx.get('link') and ctx['isPrivate']:
                return self.say(ctx, _bot_message('👋 <b>Welcome!</b> I help your team manage Task Controlling Management tasks from Telegram.\n\n{p0}', p0=link_help(self.app_url())), self.sign_in())
            if args.startswith('task_'):
                if not self.need_user(ctx):
                    return
                t = self.load_task(args[5:])
                return self.send(ctx, self.task_view(ctx, t)) if self.can_see(ctx, t) else self.say(ctx, _bot_message('That task was not found, or you cannot view it.'))
            if ctx['isGroup']:
                return self.say(ctx, self.help_text(ctx))
            if not self.need_user(ctx):
                return
            return self.send(ctx, self.menu_view(ctx))
        if cmd == 'link':
            if not args:
                return self.say(ctx, _bot_message('Send /link followed by the code from the Task Controlling Management, for example <code>/link ABCD2345</code>.'))
            return self.link(ctx, args)
        if cmd == 'help':
            return self.say(ctx, self.help_text(ctx))
        if cmd == 'unlink':
            if not ctx['isPrivate']:
                return self.say(ctx, _bot_message('Send /unlink in a private chat with me.'))
            if not ctx.get('link'):
                return self.say(ctx, _bot_message('This Telegram account is not connected to the Task Controlling Management.'))
            return self.say(ctx, _bot_message('Disconnect this Telegram account from the Task Controlling Management? You will stop receiving task messages here.'),
                            [[button(_bot_message('Disconnect'), 'u:yes'), button(_bot_message('Keep connected'), 'u:no')]])
        if cmd in ('connect', 'disconnect'):
            if not ctx['isGroup']:
                return self.say(ctx, _bot_message('Use this command in a group chat after adding me to it.'))
            if not self.need_user(ctx):
                return
            listed = self.linkable_workspaces(ctx)
            if cmd == 'disconnect':
                if not ctx['workspace']:
                    return self.say(ctx, _bot_message('This group is not linked to a workspace.'))
                if not (ctx['can']('admin.telegram', 'update') or any(w['id'] == ctx['workspace'] for w in listed)):
                    return self.say(ctx, NOT_ALLOWED)
                return self.say(ctx, _bot_message('Unlink this group from its workspace?'), [[button(_bot_message('Unlink'), 'g:off:-'), button(_bot_message('Keep'), 'x:')]])
            if not listed:
                return self.say(ctx, _bot_message('Only Task Controlling Management administrators or the workspace owner can link this group, and you do not own an active workspace.')
                                if ctx['can']('tasks.workspace', 'update') else NOT_ALLOWED)
            return self.say(ctx, _bot_message('Which workspace should this group follow?'), chunk([button(clip(w['name'], 30), f"g:ws:{w['id']}") for w in listed[:20]], 2))
        if not self.need_user(ctx):
            return
        if cmd == 'menu':
            return self.send(ctx, self.menu_view(ctx)) if ctx['isPrivate'] else self.say(ctx, self.help_text(ctx))
        if cmd == 'answer':
            return self.send(ctx, self.list_view(ctx, 'ans'))
        if cmd == 'mytasks':
            return self.send(ctx, self.list_view(ctx, 'my'))
        if cmd == 'supporting':
            return self.send(ctx, self.list_view(ctx, 'sup'))
        if cmd == 'tasks':
            if ctx['isPrivate']:
                return self.send(ctx, self.list_view(ctx, 'my'))
            if not ctx['workspace']:
                return self.say(ctx, self.help_text(ctx))
            return self.send(ctx, self.list_view(ctx, 'ws'))
        if cmd == 'review':
            return self.send(ctx, self.review_view(ctx) if ctx['isPrivate'] else self.list_view(ctx, 'rev'))
        if cmd == 'requests':
            return self.send(ctx, self.my_requests_view(ctx)) if ctx['isPrivate'] else self.say(ctx, _bot_message('Open your requests in a private chat with me: /requests'))
        if cmd in ('newtask', 'request'):
            return self.start_flow(ctx, cmd, {'title': clip(args, 300)} if args else {})
        if cmd == 'task':
            t = self.load_task(args.upper())
            return (self.send(ctx, self.task_view(ctx, t)) if self.can_see(ctx, t) else
                    self.say(ctx, _bot_message('Send /task followed by a task ID, for example <code>/task TASK-000012</code>. The task must be one you can view.')))
        if cmd == 'report':
            month = args if re.fullmatch(r'\d{4}-\d{2}', args) else current_month()
            if month > current_month():
                return self.say(ctx, _bot_message('That month has not started yet.'))
            try:
                return self.send(ctx, self.report_view(ctx, ('ws' if ctx['workspace'] else 'me') if ctx['isGroup'] else 'me', month))
            except InputError as e:
                return self.say(ctx, esc(e.message))
        if cmd == 'app':
            app = self.app_url()
            if not ctx['isPrivate'] or not app:
                return self.say(ctx, _bot_message('Open the task app from a private chat with me.') if app else _bot_message('The task app has not been set up yet. Ask an administrator.'))
            return self.say(ctx, _bot_message('Open the task app:'), [[{'text': _bot_message('📱 Open the task app'), 'web_app': {'url': app}}]])
        if ctx['isPrivate']:
            return self.say(ctx, _bot_message('I did not recognise that command. Send /help to see what I can do.'))

    # ------------------------------------------------------------ updates
    def handle_update(self, u):
        event = u.get('callback_query') or u.get('message') or u.get('my_chat_member') or {}
        link = tg.link_for((event.get('from') or {}).get('id'))
        with language(staff_language(link['staff_id']) if link else 'en'):
            return self._handle_update(u)

    def _handle_update(self, u):
        if u.get('my_chat_member'):
            m = u['my_chat_member']
            status = (m.get('new_chat_member') or {}).get('status')
            if (m.get('chat') or {}).get('type') not in ('group', 'supergroup'):
                return
            present = status in ('member', 'administrator', 'creator')
            g = tg.seen_group(m['chat'], present)
            if present and (m.get('old_chat_member') or {}).get('status') not in ('member', 'administrator', 'creator'):
                try:
                    self.send(m['chat']['id'], {'text': _bot_message('👋 Hello! I connect this group to the Task Controlling Management’s Task Management.\n\n')
                                                        + (_bot_message('This group is already linked to a workspace.') if g.get('workspace_id') else
                                                           _bot_message('An Task Controlling Management administrator can link this group to a workspace with /connect.'))
                                                        + _bot_message('\nEveryone who wants to use the buttons should first connect their Telegram in a private chat with me (send me /start).')})
                except TelegramError:
                    pass
            return
        if u.get('callback_query'):
            q = u['callback_query']
            msg = q.get('message')
            if not (msg or {}).get('chat'):
                try:
                    return self.call('answerCallbackQuery', {'callback_query_id': q['id'], 'text': _bot_message('This message is too old. Send /menu to start again.')})
                except TelegramError:
                    return None
            ctx = self.context(msg['chat'], q['from'], callbackId=q['id'], messageId=msg['message_id'], callbackMessage=msg,
                               threadId=msg.get('message_thread_id') if msg.get('is_topic_message') else None)
            kind, *parts = str(q.get('data') or '').split(':')
            if ctx['isGroup'] and kind not in ('g', 'u', 'x'):
                return self.answer(ctx, _bot_message('For Task privacy, open a private chat with me or use the Mini App.'), True)
            try:
                handlers = {'t': self.on_task_button, 'k': self.on_check_button, 'a': self.on_file_button, 'r': self.on_request_button, 'd': self.on_due_button,
                            'c': self.on_change_button, 'm': self.on_menu_button, 'f': self.on_flow_button, 'rep': self.on_report_button, 'g': self.on_group_button}
                if kind in handlers:
                    handlers[kind](ctx, parts)
                elif kind == 'u':
                    if parts[:1] == ['yes'] and ctx.get('link'):
                        try:
                            from compat.commands import run as command
                            command(access.account_for(ctx['link']['staff_id']) or _NoUser(ctx['link']['staff_id']), 'tg.link.unlink', {}, 'TELEGRAM')
                        except Exception:   # noqa: BLE001
                            TelegramLink.objects.filter(tg_user_id=ctx['from']['id']).delete()
                        self.show(ctx, {'text': _bot_message('Disconnected. Send /start whenever you want to connect again.'), 'keyboard': []})
                    else:
                        self.show(ctx, {'text': _bot_message('Still connected.') if ctx.get('link') else _bot_message('This Telegram account is not connected.'), 'keyboard': []})
                elif kind == 'x' and parts[:1] != ['page']:
                    self.show(ctx, {'text': 'OK.', 'keyboard': []})
            finally:
                self.answer(ctx)
            return
        m = u.get('message')
        if not (m or {}).get('chat') or m['chat'].get('type') not in ('private', 'group', 'supergroup') or not m.get('from') or m['from'].get('is_bot'):
            return
        if m.get('migrate_to_chat_id'):
            tg.migrate_group(m['chat']['id'], m['migrate_to_chat_id'])
            return
        ctx = self.context(m['chat'], m['from'], messageId=m.get('message_id'), threadId=m.get('message_thread_id') if m.get('is_topic_message') else None)
        if ctx['isGroup']:
            text_value = m.get('text') or ''
            group_command = parse_command(text_value, (self.me or {}).get('username')) if text_value.startswith('/') else None
            if not group_command or group_command.get('cmd') not in ('connect', 'disconnect', 'help', 'start') or (group_command.get('args') or '').startswith('task_'):
                if group_command and not group_command.get('other'):
                    return self.say(ctx, _bot_message('For Task privacy, open a private chat with me or use the Mini App.'))
                return
        if m.get('document') or (isinstance(m.get('photo'), list) and m['photo']):
            return self.on_media(ctx, m)
        text = m['text'] if isinstance(m.get('text'), str) else ''
        command = parse_command(text, (self.me or {}).get('username')) if text.startswith('/') else None
        if (command or {}).get('other'):
            return
        session = tg.session.get(ctx['chatId'], m['from']['id'])
        if session and session.get('prompt_id') and (not command or command['cmd'] in ('skip', 'cancel')):
            if ctx['isGroup'] and (m.get('reply_to_message') or {}).get('message_id') != session['prompt_id']:
                return
            if (command or {}).get('cmd') == 'cancel':
                tg.session.clear(ctx['chatId'], m['from']['id'])
                self.remove(ctx['chatId'], session['prompt_id'])
                return self.say(ctx, 'Cancelled.')
            return self.on_answer(ctx, session, None if (command or {}).get('cmd') == 'skip' else text)
        if command:
            if session and command['cmd'] not in ('skip', 'cancel'):
                tg.session.clear(ctx['chatId'], m['from']['id'])
            if command['cmd'] in ('cancel', 'skip'):
                return self.say(ctx, _bot_message('There is nothing to cancel.')) if ctx['isPrivate'] else None
            return self.on_command(ctx, command['cmd'], command['args'])
        if ctx['isPrivate']:
            if not ctx.get('link') and re.fullmatch(r'[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}', text.strip()):
                return self.link(ctx, tg.normalize_code(text))
            if not ctx.get('link'):
                return self.say(ctx, link_help(self.app_url()), self.sign_in())
            if not self.need_user(ctx):
                return
            return self.send(ctx, self.menu_view(ctx, _bot_message('Use the buttons below, or send /help to see all commands.')))

    # ------------------------------------------------------------ notifications to Telegram
    @staticmethod
    def delivery(nid, status, reason, attempts, next_at=None):
        NotificationDelivery.objects.update_or_create(notification_id=nid, channel='TELEGRAM', defaults={
            'status': status, 'reason': str(reason or '')[:300], 'attempts': attempts, 'next_at': next_at, 'updated_at': timezone.now()})

    def ineligible(self, n):
        if n['kind'] == 'telegram_connected':
            return _bot_message('Shown in the Task Controlling Management only')
        if datetime.fromisoformat(n['created_at'].replace('Z', '+00:00')).timestamp() <= time.time() - NOTIFY_MAX_AGE:
            return _bot_message('Older than 6 hours when Telegram was ready')
        link = tg.link_for_staff(n['staff_id'])
        if not link:
            return _bot_message('Telegram is not connected')
        if not link['notify']:
            return _bot_message('Telegram notifications are turned off')
        if not link['chat_id']:
            return _bot_message('The bot cannot message this person (blocked or never started)')
        user = access.account_for(n['staff_id'])
        if not user:
            return _bot_message('The login is disabled')
        if not access.can(user, 'tasks.tasks') and not access.can(user, 'tasks.meetings'):
            return _bot_message('The role no longer includes Task Management')
        gov = Governance()
        if not gov.operational_access(n['staff_id']):
            return _bot_message('Account is not mapped to the Organizational Structure')
        if n.get('org_request_id') and (not access.can(user, 'tasks.organization') or not gov.notification_visible(n['staff_id'], n['org_request_id'])):
            return _bot_message('Organization request no longer requires or permits this recipient')
        sc = TaskScope(gov)
        if n.get('task_id'):
            t = row(Task.objects.filter(id=n['task_id']).first())
            if not t:
                return _bot_message('The task no longer exists')
            if not access.can(user, 'tasks.tasks'):
                return _bot_message('The role no longer includes Tasks')
            if not sc.can_see(n['staff_id'], t) or not sc.is_involved(n['staff_id'], t):
                return _bot_message('No longer on this task')
        if n.get('meeting_id'):
            from meetings.models import Meeting
            m = row(Meeting.objects.filter(id=n['meeting_id']).first())
            if not m:
                return _bot_message('The meeting no longer exists')
            if m['status'] == 'CANCELLED' and n['kind'] != 'meeting_cancelled':
                return _bot_message('The meeting was cancelled')
            if not sc.can_see_meeting(n['staff_id'], m):
                return _bot_message('No longer invited to this meeting')
        if n.get('note_id'):
            from meetings.models import CalendarNote
            owner = CalendarNote.objects.filter(id=n['note_id']).values_list('staff_id', flat=True).first()
            if not owner or owner != n['staff_id']:
                return _bot_message('The note was deleted')
        if n.get('request_id') and not n.get('task_id'):
            q = row(TaskRequest.objects.filter(id=n['request_id']).first())
            if not q or (q['requested_by'] != n['staff_id'] and q['manager_id'] != n['staff_id']):
                return _bot_message('No longer part of this request')
            if not sc.can_see_request(n['staff_id'], q):
                return _bot_message('The workspace was deleted')
        return None

    def attempt(self, n, attempts):
        why = self.ineligible(n)
        if why:
            return self.delivery(n['id'], 'SKIPPED', why, attempts)
        self.delivery(n['id'], 'PENDING', _bot_message('Sending'), attempts + 1)
        try:
            self.deliver(n)
            self.delivery(n['id'], 'SENT', '', attempts + 1)
        except TelegramError as e:
            retry = attempts + 1 <= len(RETRY_AFTER) and e.code != 403
            self.delivery(n['id'], 'FAILED', _bot_message('The person blocked the bot') if e.code == 403 else str(e), attempts + 1,
                          timezone.now() + timedelta(seconds=RETRY_AFTER[attempts]) if retry else None)
            tg.log('error', None, _bot_message('Notification {p0}: {p1}{p2}', p0=n['id'], p1=e, p2=' (will retry)' if retry else ''))

    def deliver(self, n):
        preferred = staff_language(n['staff_id'])
        with language(preferred):
            return self._deliver(notification_text(n, preferred))

    def _deliver(self, n):
        link = tg.link_for_staff(n['staff_id'])
        user = access.account_for(n['staff_id'])
        ctx = Context(chatId=link['chat_id'], isPrivate=True, isGroup=False, staff=n['staff_id'], user=user)
        ctx['can'] = lambda r, a='view': access.can(user, r, a)
        k = []
        if n.get('task_id'):
            t = self.load_task(n['task_id'])
            allowed = self.actions_for(ctx, t)['allowed'] if t else []
            if t and n['kind'] in ANSWER_KINDS and 'accept' in allowed:
                k.append([button(_bot_message('✅ Accept'), f"t:acc:{t['id']}"), *([button(_bot_message('✖️ Reject'), f"t:dec:{t['id']}")] if 'decline' in allowed else [])])
            if t and n['kind'] == 'task_submitted' and 'close' in allowed:
                k.append([button(_bot_message('✔️ Approve completion') if (t['change_request'] or {}).get('kind') == 'COMPLETE' else _bot_message('✔️ Close'), f"t:cls:{t['id']}"),
                          button(_bot_message('↩️ Return'), f"t:ret:{t['id']}")])
            elif t and n['kind'] == 'task_submitted' and 'pass' in allowed:
                k.append([button(_bot_message('➡️ Pass for approval'), f"t:pas:{t['id']}"), button(_bot_message('↩️ Return'), f"t:ret:{t['id']}")])
            if t and n['kind'] in ('task_due_soon', 'task_overdue') and 'progress' in allowed:
                k.append([button(_bot_message('📈 Update progress'), f"t:prg:{t['id']}")])
            if n['kind'] == 'due_new' and n.get('due_request_id'):
                k.append([button(_bot_message('✅ Approve date'), f"d:ok:{n['due_request_id']}"), button(_bot_message('↩️ Decline'), f"d:no:{n['due_request_id']}")])
            cr = (t or {}).get('change_request')
            if cr and n['kind'] == 'change_request' and cr['approver_id'] == n['staff_id']:
                k.append([button(_bot_message('✅ Approve change'), f"c:ok:{cr['id']}"), button(_bot_message('↩️ Reject'), f"c:no:{cr['id']}")])
            k.append([button(_bot_message('👁 View task'), f"t:v:{n['task_id']}")])
        elif n.get('request_id'):
            q = row(TaskRequest.objects.filter(id=n['request_id']).first())
            if q and n['kind'] == 'request_new' and q['status'] == 'PENDING' and q['manager_id'] == n['staff_id']:
                k.append([button(_bot_message('✅ Accept') if q.get('doer') == 'RECEIVER' else _bot_message('✅ Approve'), f"r:ok:{q['id']}"), button(_bot_message('↩️ Decline'), f"r:no:{q['id']}")])
            k.append([button(_bot_message('👁 View request'), f"r:v:{n['request_id']}")])
        app = self.app_url()
        if app and n.get('org_request_id'):
            k.append([{'text': _bot_message('Review organization request'), 'web_app': {'url': f"{app}?org_request={quote(n['org_request_id'], safe='')}"}}])
        if app and ctx['can']('tasks.tasks') and (n.get('note_id') or (n.get('meeting_id') and ctx['can']('tasks.meetings'))):
            target = n.get('meeting_id') or n.get('note_id')
            k.append([{'text': _bot_message('📅 Open in the calendar'), 'web_app': {'url': f"{app}?{'meeting' if n.get('meeting_id') else 'note'}={quote(target, safe='')}"}}])
        try:
            self.send(ctx, {'text': f"{NOTE_ICON.get(n['kind'], '🔔')} <b>{esc(n['title'])}</b>\n{esc(n['body'])}", 'keyboard': k})
        except TelegramError as e:
            if e.code == 403:
                TelegramLink.objects.filter(tg_user_id=link['tg_user_id']).update(chat_id=None)
                tg.log('warn', link['chat_id'], _bot_message('{p0} blocked the bot; messages paused until they message it again.', p0=self.name_of(n['staff_id'])))
            raise

    def flush(self):
        if self.stopped.is_set() or not self.me or not self.flushing.acquire(blocking=False):
            return
        try:
            self.names.clear()
            s = tg.settings()
            cursor = s['last_notification_id']
            if cursor < 0:
                cursor = Notification.objects.order_by('-id').values_list('id', flat=True).first() or 0
                TelegramSettings.objects.filter(id=1).update(last_notification_id=cursor)
            NotificationDelivery.objects.filter(channel='TELEGRAM', status='PENDING', updated_at__lt=timezone.now() - timedelta(minutes=2)).update(
                status='SKIPPED', reason=_bot_message('Interrupted while sending; not repeated so it can never arrive twice'), next_at=None, updated_at=timezone.now())
            delivered = NotificationDelivery.objects.filter(channel='TELEGRAM').values('notification_id')
            for n in rows(Notification.objects.filter(id__gt=cursor).exclude(id__in=delivered).order_by('id')[:25]):
                if self.stopped.is_set():
                    break
                try:
                    self.attempt(n, 0)
                except Exception as e:   # noqa: BLE001
                    tg.log('error', None, _bot_message('Notification {p0}: {p1}', p0=n['id'], p1=e))
                TelegramSettings.objects.filter(id=1, last_notification_id__lt=n['id']).update(last_notification_id=n['id'])
            due = (NotificationDelivery.objects.filter(channel='TELEGRAM', status='FAILED', next_at__isnull=False, next_at__lte=timezone.now())
                   .select_related('notification').order_by('next_at')[:10])
            for d in due:
                if self.stopped.is_set():
                    break
                n = row(d.notification)
                try:
                    self.attempt(n, d.attempts)
                except Exception as e:   # noqa: BLE001
                    tg.log('error', None, _bot_message('Notification {p0}: {p1}', p0=n['id'], p1=e))
            self.digest(s)
        except Exception as e:   # noqa: BLE001
            if not self.stopped.is_set():
                log.exception('Telegram outbox failed')
                tg.log('error', None, str(e))
        finally:
            self.flushing.release()

    def digest(self, s):
        today = dm.task_today()
        hour = datetime.now(dt_timezone.utc).astimezone(dm.CAMBODIA).hour
        if s['digest_hour'] < 0 or hour != s['digest_hour'] or s['last_digest_date'] == today:
            return
        TelegramSettings.objects.filter(id=1).update(last_digest_date=today)
        for link in rows(TelegramLink.objects.filter(notify=True, chat_id__isnull=False).order_by('tg_user_id')):
            with language(staff_language(link['staff_id'])):
                self._digest_person(link, today)

    def _digest_person(self, link, today):
        if self.stopped.is_set():
            return
        user = access.account_for(link['staff_id'])
        scope = TaskScope(Governance())
        if not user or not access.can(user, 'tasks.tasks') or not scope.gov.operational_access(link['staff_id']):
            return
        mine_ids = TaskAssignee.objects.filter(staff_id=link['staff_id']).exclude(status='DECLINED').values('task_id')
        mine = self.enrich([t for t in rows(live(Task.objects.filter(id__in=mine_ids, status__in=OPEN, due_date__lte=today)).order_by('due_date', 'id'))
                            if scope.can_see(link['staff_id'], t)])
        c = self.counts(link['staff_id'])
        due_today, late = [t for t in mine if t['due_date'] == today], [t for t in mine if t['due_date'] < today]
        if not mine and not c['rev'] and not c['answer']:
            return
        lines = [_bot_message('☀️ <b>Good morning, {p0}</b>', p0=esc(self.name_of(link['staff_id']).split(' · ')[0])), _bot_message('Your tasks for {p0}:', p0=fmt_day(today)), '']
        if late:
            lines.append(f'⚠️ Overdue: <b>{len(late)}</b>')
        if due_today:
            lines.append(_bot_message('📅 Due today: <b>{p0}</b>', p0=len(due_today)))
        if c['answer']:
            lines.append(_bot_message('🆕 Waiting for your answer: <b>{p0}</b>', p0=c['answer']))
        if c['rev']:
            lines.append(_bot_message('🔎 Waiting for your decision: <b>{p0}</b>', p0=c['rev']))
        lines += [f"• {esc(clip(t['title'], 60))} — {'overdue' if t['due_date'] < today else _bot_message('due today')}" for t in mine[:5]]
        try:
            self.send(link['chat_id'], {'text': '\n'.join(lines), 'keyboard': [[button(_bot_message('🆕 To answer'), 'm:ans:0'), button(_bot_message('📋 My tasks'), 'm:my:0')],
                                                                               [button(_bot_message('🔎 To review'), 'm:rev')]]}, {'disable_notification': False})
        except TelegramError as e:
            if e.code == 403:
                TelegramLink.objects.filter(tg_user_id=link['tg_user_id']).update(chat_id=None)

    # ------------------------------------------------------------ lifecycle
    def configure(self):
        for method, params in (('deleteWebhook', {'drop_pending_updates': False}),):
            try:
                self.call(method, params)
            except TelegramError:
                pass
        for commands, scope, label in ((PRIVATE_COMMANDS, 'all_private_chats', _bot_message('Commands')), (GROUP_COMMANDS, 'all_group_chats', _bot_message('Group commands'))):
            try:
                self.call('setMyCommands', {'commands': [{'command': c, 'description': render(d, 'en')} for c, d in commands], 'scope': {'type': scope}})
            except TelegramError as e:
                tg.log('warn', None, f'{label}: {e}')
        self.refresh_menu()

    def refresh_menu(self):
        from accounts.models import User
        app = self.app_url()
        def menu(locale):
            return {'type': 'web_app', 'text': render(_message('Tasks'), locale), 'web_app': {'url': app}} if app else {'type': 'commands'}
        if app != self.menu_for:
            try:
                self.call('setChatMenuButton', {'menu_button': menu('en')})
                self.menu_for = app
            except TelegramError as e:
                tg.log('warn', None, _bot_message('Menu button: {p0}', p0=e))
        # Account preferences take precedence over Telegram's device language.
        # The supervisor refreshes this cache; preference requests do not call Telegram.
        preferences = dict(User.objects.filter(active=True).values_list('staff_id', 'language'))
        live_chats = set()
        for staff, chat in TelegramLink.objects.filter(chat_id__gt=0).values_list('staff_id', 'chat_id'):
            if staff not in preferences:
                continue
            live_chats.add(chat)
            locale = preferences[staff]
            if self.private_menus.get(chat) == (locale, app) or self.menu_retries.get(chat, 0) > time.monotonic():
                continue
            try:
                self.call('setMyCommands', {'commands': [{'command': c, 'description': render(d, locale)} for c, d in PRIVATE_COMMANDS],
                                            'scope': {'type': 'chat', 'chat_id': chat}})
                self.call('setChatMenuButton', {'chat_id': chat, 'menu_button': menu(locale)})
                self.private_menus[chat] = (locale, app)
                self.menu_retries.pop(chat, None)
            except TelegramError:
                self.menu_retries[chat] = time.monotonic() + 60
        self.private_menus = {chat: value for chat, value in self.private_menus.items() if chat in live_chats}
        self.menu_retries = {chat: value for chat, value in self.menu_retries.items() if chat in live_chats}

    def connect(self):
        """getMe and configure (one attempt). Returns False when the token was rejected."""
        self.me = self.api('getMe')
        TelegramSettings.objects.filter(id=1).update(bot_id=self.me['id'], bot_username=self.me.get('username') or '', bot_name=self.me.get('first_name') or '')
        self.configure()
        tg.set_status('ONLINE', _bot_message('Connected as @{p0}', p0=self.me.get('username')))
        tg.log('info', None, _bot_message('Connected as @{p0}', p0=self.me.get('username')))
        return True

    def run(self):
        backoff = 1
        while not self.stopped.is_set():
            close_old_connections()
            try:
                self.connect()
                break
            except TelegramError as e:
                if e.code in (401, 404):
                    tg.set_status('ERROR', _bot_message('Telegram rejected the bot token. Check it in Administration → Telegram.'))
                    tg.log('error', None, _bot_message('Bot token rejected'))
                    return
                tg.set_status('RECONNECTING', _bot_message('Cannot reach Telegram: {p0}', p0=e))
                self.stopped.wait(backoff)
                backoff = min(backoff * 2, 60)
        outbox = threading.Thread(target=self._outbox, name='telegram-outbox', daemon=True)
        outbox.start()
        backoff = 1
        while not self.stopped.is_set():
            close_old_connections()
            try:
                s = tg.settings()
                updates = self.api('getUpdates', {'offset': s['last_update_id'] + 1, 'timeout': self.poll_timeout,
                                                  'allowed_updates': ['message', 'callback_query', 'my_chat_member']}, self.poll_timeout + 10)
                if backoff > 1:
                    tg.set_status('ONLINE', _bot_message('Connected as @{p0}', p0=self.me.get('username')))
                backoff = 1
                for u in updates:
                    if self.stopped.is_set():
                        break
                    self.names.clear()
                    try:
                        self.handle_update(u)
                    except Exception as e:   # noqa: BLE001
                        log.exception('Telegram update failed')
                        tg.log('error', None, f"Update {u.get('update_id')}: {e}")
                    TelegramSettings.objects.filter(id=1, last_update_id__lt=u['update_id']).update(last_update_id=u['update_id'])
            except TelegramError as e:
                if self.stopped.is_set():
                    break
                if e.code == 401:
                    tg.set_status('ERROR', _bot_message('Telegram rejected the bot token. Check it in Administration → Telegram.'))
                    break
                if e.code == 409:
                    try:
                        self.api('deleteWebhook', {'drop_pending_updates': False})
                    except TelegramError:
                        pass
                    tg.set_status('RECONNECTING', _bot_message('Another program is using this bot token (only one Task Controlling Management should run a bot). Retrying…'))
                else:
                    tg.set_status('RECONNECTING', _bot_message('Connection to Telegram lost: {p0}', p0=e))
                self.stopped.wait(backoff)
                backoff = min(backoff * 2, 60)

    def _outbox(self):
        while not self.stopped.wait(self.outbox_seconds):
            close_old_connections()
            self.flush()

    def start(self):
        thread = threading.Thread(target=self.run, name='telegram-bot', daemon=True)
        thread.start()
        self.threads.append(thread)
        return self

    def stop(self):
        self.stopped.set()


class _NoUser:
    """Stand-in so tg.link.unlink can run for an account that is no longer active (authorize then refuses, as in V5.7.7)."""
    def __init__(self, staff_id):
        self.staff_id = staff_id


def js_int(value):
    """Number(value) when it is a whole number, else None."""
    from core.validation import js_number
    n = js_number(value)
    if isinstance(n, float):
        if n != n or not n.is_integer():
            return None
        n = int(n)
    return n


class Runtime:
    """Starts, restarts and stops the company bot as Administration → Telegram changes (every few seconds)."""

    def __init__(self, app_url=lambda: '', api_base=TELEGRAM_API, every=4):
        self.app_url, self.api_base, self.every = app_url, api_base, every
        self.bot, self.stopped = None, threading.Event()

    def supervise(self):
        close_old_connections()
        s = tg.settings()
        want = bool(s['enabled']) and bool(s['bot_token'])
        if want and (not self.bot or self.bot.token != s['bot_token']):
            if self.bot:
                self.bot.stop()
            self.bot = Bot(s['bot_token'], self.api_base, self.app_url).start()
        elif not want and self.bot:
            self.bot.stop()
            self.bot = None
            tg.set_status('OFF', '')
        elif want and self.bot and self.bot.me:
            self.bot.refresh_menu()

    def run(self):
        while not self.stopped.is_set():
            try:
                self.supervise()
            except Exception:   # noqa: BLE001
                log.exception('Telegram supervisor failed')
            self.stopped.wait(self.every)
        if self.bot:
            self.bot.stop()


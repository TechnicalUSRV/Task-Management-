"""The Telegram Mini App gateway — a port of telegram-gateway.mjs (V5.7.7).

Served by Django under /c/<company>/tg/ (the page) and /c/<company>/tg/api/... (its API). People are identified by
Telegram's signed launch data (initData, checked with the company's bot token) and then act as their linked login:
same permissions, same workflow, same database. Photos and files use a short signed media token instead, because
<img> tags and links cannot carry the launch data.
"""
import base64
import hashlib
import hmac
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import parse_qsl

from django.conf import settings as conf
from django.core.exceptions import RequestDataTooBig
from django.db import transaction
from django.http import HttpResponse

from accounts import services as access
from compat import commands, reports
from core.errors import InputError
from core.services import change_seq
from organization.governance import Governance
from tasks.domain import PREVIEW_TYPES

from . import services as telegram

MINI_APP_ACTIONS = re.compile(
    r'^(org\.(preview|structure\.(save|request)|workspace\.(save|classify|delete|restore)|membership\.(request|remove)|delegation\.request|'
    r'request\.(decide|cancel))|tm\.(workspace\.(delete|restore|member\.(add|remove))|task\.(save|accept|decline|progress|stuck|resume|submit|pass|'
    r'return|close|cancel|reopen|note|handover|remind|reminders)|change\.(decide|withdraw)|request\.(save|withdraw|forward|decide)|'
    r'due\.(request|decide|withdraw)|check\.(add|toggle|rename|move|remove)|file\.(add|remove)|notification\.read|meeting\.(save|follow|decide|withdraw)|'
    r'time\.(save|delete)|calnote\.(save|delete))|me\.(profile\.save|photo\.(save|remove))|tg\.link\.(notify|unlink))$')
CSP = ("default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'")
MEDIA_HOURS = 12
INIT_MAX_AGE = 8 * 3600
GENERIC = 'Unable to complete this operation. Nothing was changed.'


class GatewayError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


# ---------------------------------------------------------------- launch data and media tokens
def _secret(token):
    return hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()


def _check_string(pairs):
    return '\n'.join(f'{k}={v}' for k, v in sorted(pairs, key=lambda p: p[0].encode('utf-16-be')))


def validate_init_data(raw, bot_token, max_age=86400, now=None):
    """https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app — None when not valid."""
    if not isinstance(raw, str) or not raw or len(raw) > 8192 or not bot_token:
        return None
    params = parse_qsl(raw, keep_blank_values=True)
    given = next((v for k, v in params if k == 'hash'), None)
    if not given or not re.fullmatch(r'[a-f0-9]{64}', given):
        return None
    expected = hmac.new(_secret(bot_token), _check_string([(k, v) for k, v in params if k != 'hash']).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(given, expected):
        return None
    first = lambda key: next((v for k, v in params if k == key), None)
    try:
        auth_date = float(first('auth_date'))
    except (TypeError, ValueError):
        return None
    age = (now if now is not None else time.time()) - auth_date
    if auth_date != auth_date or age > max_age or age < -300:
        return None
    try:
        user = json.loads(first('user') or 'null')
    except ValueError:
        return None
    if not isinstance(user, dict) or not isinstance(user.get('id'), int) or isinstance(user.get('id'), bool) \
            or abs(user['id']) > 9007199254740991 or user.get('is_bot'):
        return None
    return {'user': user, 'authDate': auth_date, 'startParam': first('start_param') or '', 'chatType': first('chat_type') or ''}


def sign_init_data(fields, bot_token):
    """Signed launch data as Telegram builds it (tests and local previews)."""
    pairs = [(k, json.dumps(v, separators=(',', ':')) if isinstance(v, (dict, list)) else str(v)) for k, v in fields.items()]
    digest = hmac.new(_secret(bot_token), _check_string(pairs).encode(), hashlib.sha256).hexdigest()
    from urllib.parse import urlencode
    return urlencode([*pairs, ('hash', digest)])


def _media_key(token):
    return hmac.new(b'SunnyMediaAccess', token.encode(), hashlib.sha256).digest()


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def media_token(company, tg_user, bot_token, now=None, bind=''):
    exp = int((now if now is not None else time.time())) + MEDIA_HOURS * 3600
    message = f"{company}.{tg_user}.{exp}{'.' + bind if bind else ''}"
    return f'{exp}.{tg_user}.{_b64url(hmac.new(_media_key(bot_token), message.encode(), hashlib.sha256).digest())}'


def check_media_token(value, company, bot_token, now=None, bind=''):
    m = re.fullmatch(r'(\d{9,12})\.(\d{1,20})\.([A-Za-z0-9_-]{43})', str(value or ''))
    if not m or not bot_token:
        return None
    if int(m.group(1)) < (now if now is not None else time.time()):
        return None
    b = bind(int(m.group(2))) if callable(bind) else bind
    if b is None:
        return None
    message = f"{company}.{m.group(2)}.{m.group(1)}{'.' + b if b else ''}"
    expected = _b64url(hmac.new(_media_key(bot_token), message.encode(), hashlib.sha256).digest())
    return int(m.group(2)) if hmac.compare_digest(expected, m.group(3)) else None


# ---------------------------------------------------------------- per-process limits (as V5.7.7)
class Window:
    def __init__(self):
        self.hits, self.lock = {}, threading.Lock()

    def limited(self, key, maximum, window_ms):
        now = time.monotonic() * 1000
        with self.lock:
            h = self.hits.get(key)
            if not h or now - h[0] > window_ms:
                self.hits[key] = [now, 1]
                return False
            h[1] += 1
            return h[1] > maximum


hits = Window()
failures = {}


def _failed(key):
    f = failures.get(key)
    now = time.monotonic() * 1000
    fresh = f and now - f[0] < 15 * 60000
    failures[key] = [f[0] if fresh else now, (f[1] if fresh else 0) + 1]


def _blocked(key, maximum):
    f = failures.get(key)
    return bool(f) and f[1] >= maximum and time.monotonic() * 1000 - f[0] < 15 * 60000


# ---------------------------------------------------------------- responses
def send(status, body, content_type='application/json; charset=utf-8', cache='no-store', extra=None):
    payload = body if isinstance(body, (bytes, str)) else json.dumps(body, ensure_ascii=False, separators=(',', ':'))
    response = HttpResponse(payload, status=status, content_type=content_type)
    response['Cache-Control'] = cache
    response['X-Content-Type-Options'] = 'nosniff'
    response['Referrer-Policy'] = 'no-referrer'
    response['Content-Security-Policy'] = CSP
    for k, v in (extra or {}).items():
        response[k] = v
    return response


def frontend_dir():
    return Path(getattr(conf, 'FRONTEND_DIR', ''))


def page(request):
    """GET /c/<company>/tg/ — the Mini App page."""
    if not getattr(request, 'company_scoped', False):
        return send(404, {'error': 'Not found.'})
    try:
        body = (frontend_dir() / 'tg.html').read_bytes()
    except OSError:
        return send(503, {'error': 'The Mini App has not been built. Run npm run build.'})
    return send(200, body, 'text/html; charset=utf-8')


def to_page(request):
    from django.http import HttpResponsePermanentRedirect
    if not getattr(request, 'company_scoped', False):
        return send(404, {'error': 'Not found.'})
    query = request.META.get('QUERY_STRING')
    response = HttpResponsePermanentRedirect(f'/c/{request.company_id}/tg/' + (f'?{query}' if query else ''))
    response.status_code = 308
    return response


def _body(request):
    if not str(request.headers.get('Content-Type', '')).startswith('application/json'):
        raise GatewayError(415, 'JSON is required.')
    try:
        raw = request.body
    except RequestDataTooBig:
        raise GatewayError(413, 'Request too large.')
    try:
        body = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        raise GatewayError(400, 'Invalid JSON.')
    if not isinstance(body, dict):
        raise GatewayError(400, 'Invalid request.')
    return body


def api(request, rest):
    """Every /c/<company>/tg/api/<rest> request."""
    try:
        return _api(request, '/api/' + rest)
    except GatewayError as e:
        return send(e.status, {'error': e.message, **({'code': e.code} if e.code else {})})
    except InputError as e:
        return send(e.status, {'error': e.message})
    except Exception:   # noqa: BLE001 — never show internal errors to the Telegram app
        import logging
        logging.getLogger(__name__).exception('Mini App request failed')
        return send(500, {'error': GENERIC})


def _api(request, rest):
    if not getattr(request, 'company_scoped', False):
        raise GatewayError(404, 'Not found.')
    company = request.company_id
    s = telegram.settings()
    if not s['enabled'] or not s['bot_token']:
        raise GatewayError(503, 'Telegram is turned off for this company.', 'off')
    if request.method == 'GET' and rest in ('/api/photo', '/api/file', '/api/file-preview'):
        return _media(request, rest, company, s)
    raw = re.sub(r'^tma ', '', str(request.headers.get('Authorization', '')))
    init = validate_init_data(raw, s['bot_token'], max_age=INIT_MAX_AGE)
    if not init:
        if validate_init_data(raw, s['bot_token']):
            raise GatewayError(401, 'This session has expired. Close the app and open it again from the bot.', 'expired')
        raise GatewayError(401, 'Open this app from the company bot in Telegram.', 'auth')
    tg_user = init['user']
    if hits.limited(f"{company}:{tg_user['id']}", 180, 60000):
        raise GatewayError(429, 'Too many requests. Wait a moment and try again.')
    private_chat = tg_user['id'] if init['chatType'] in ('sender', '') else None
    if rest == '/api/link' and request.method == 'POST':
        key = f"{company}:{tg_user['id']}"
        if _blocked(key, 5):
            raise GatewayError(429, 'Too many incorrect codes. Wait 15 minutes and create a new code in the Task Controlling Management.')
        body = _body(request)
        result = telegram.redeem(body.get('code'), tg_user, private_chat)
        if result.get('error'):
            _failed(key)
            raise GatewayError(400, result['error'], 'code')
        failures.pop(key, None)
        return send(200, {'ok': True, 'name': result['name']})
    if rest == '/api/login' and request.method == 'POST':
        key = f"{company}:{tg_user['id']}:login"
        if _blocked(key, 10):
            raise GatewayError(429, 'Too many unsuccessful sign-ins. Wait 15 minutes and try again.')
        body = _body(request)
        try:
            signed = access.login_or_fail(body.get('username'), body.get('password'), f"telegram:{tg_user['id']}")
        except InputError as e:
            if e.status == 401:
                _failed(key)
            raise
        failures.pop(key, None)
        result = telegram.connect_signed_in(signed['staff_id'], tg_user, private_chat)
        if result.get('error'):
            raise GatewayError(403, result['error'], 'disabled')
        return send(200, {'ok': True, 'name': result['name']})
    link = telegram.link_for(tg_user['id'])
    if not link:
        raise GatewayError(403, 'Connect your Telegram account to the Task Controlling Management first.', 'not_linked')
    user = access.account_for(link['staff_id'])
    if not user:
        raise GatewayError(403, 'Your Task Controlling Management account is disabled. Ask an administrator for help.', 'disabled')
    if not access.can(user, 'tasks.tasks'):
        raise GatewayError(403, 'Your Task Controlling Management role does not include Task Management.', 'no_access')
    if rest == '/api/changes' and request.method == 'GET':
        return send(200, {'seq': change_seq()})
    with transaction.atomic():
        telegram.touch(tg_user, None, False)
    if rest == '/api/organization' and request.method == 'GET':
        access.require_permission(user, 'tasks.organization')
        return send(200, Governance().query(user.staff_id, request.GET.dict()))
    if rest == '/api/state' and request.method == 'GET':
        token = media_token(company, tg_user['id'], s['bot_token'], bind=link['linked_at'] or '')
        return send(200, {**reports.mini_state(user, token), 'company_context': {'id': company}})
    if rest == '/api/command' and request.method == 'POST':
        body = _body(request)
        if not isinstance(body.get('action'), str) or not MINI_APP_ACTIONS.match(body['action']):
            raise GatewayError(403, 'This action is not available in the Telegram app.')
        result = commands.run(user, body['action'], body['data'] if 'data' in body else {}, 'MINIAPP')
        return send(200, {'ok': True, 'result': result})
    if rest == '/api/report' and request.method == 'GET':
        report, scope = request.GET.get('report') or 'monthly', request.GET.get('scope') or 'me'
        if report not in reports.MONTHLY_REPORTS:
            raise GatewayError(400, 'Unknown report.')
        f = {'report': report}
        if request.GET.get('month'):
            f['month'] = request.GET['month']
        if scope == 'me':
            f['user'] = user.staff_id
        elif scope == 'all':
            if not access.can(user, 'tasks.reports'):
                raise GatewayError(403, 'Your role cannot view company-wide task reports.')
            for k in ('workspace', 'department'):
                if request.GET.get(k):
                    f[k] = str(request.GET[k])[:200]
        else:
            raise GatewayError(400, 'Unknown report scope.')
        from compat.state import scoped_state
        return send(200, reports.build_task_report(scoped_state(user), f))
    raise GatewayError(404, 'Not found.')


def _media(request, rest, company, s):
    def bind(tg_user):
        link = telegram.link_for(tg_user)
        return (link['linked_at'] or '') if link else None
    tg_user = check_media_token(request.GET.get('t'), company, s['bot_token'], bind=bind)
    link = telegram.link_for(tg_user) if tg_user else None
    user = access.account_for(link['staff_id']) if link else None
    if not user or not access.can(user, 'tasks.tasks'):
        raise GatewayError(403, 'This link has expired. Open the task again in the app.', 'media')
    headers = {'Content-Security-Policy': "default-src 'none'; sandbox"}
    if rest == '/api/photo':
        from organization.models import StaffPhoto
        photo = StaffPhoto.objects.filter(staff_id=str(request.GET.get('staff') or '')[:60], size__gt=0).first()
        if not photo:
            raise GatewayError(404, 'Photo not found.')
        cache = 'private, max-age=86400' if request.GET.get('v') == str(photo.version) else 'no-store'
        return send(200, bytes(photo.content), photo.mime, cache, headers)
    from compat.views import task_file_preview, task_file_response
    try:
        if rest == '/api/file-preview':
            # The in-app preview of a Word, Excel, PowerPoint, CSV or text file: the same access check as the download.
            return send(200, task_file_preview(link['staff_id'], request.GET.get('id')))
        response = task_file_response(link['staff_id'], request.GET.get('id'), request.GET.get('inline') == '1', {'Referrer-Policy': 'no-referrer'})
    except InputError as e:
        raise GatewayError(e.status, e.message)
    return response


__all__ = ['page', 'to_page', 'api', 'validate_init_data', 'sign_init_data', 'media_token', 'check_media_token', 'PREVIEW_TYPES']

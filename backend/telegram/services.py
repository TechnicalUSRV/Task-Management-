"""Store-side Telegram data for the company — a port of telegram.mjs (V5.7.7).

Bot settings, which Telegram account uses which login, groups linked to workspaces and short conversation steps.
The bot runtime (telegram/bot.py) and the Mini App gateway (telegram/gateway.py) use these functions.
"""
from core.i18n import msg as _message
import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone as dt_timezone
from urllib.parse import urlsplit

from django.db import transaction
from django.db.models import Count
from django.utils import timezone

from accounts.models import AccessAudit, User
from core.errors import fail
from core.models import Staff
from core.rows import row, rows
from core.services import active_staff, changed
from core.validation import integer, iso, text
from notifications.models import Notification, NotificationDelivery
from organization.governance import is_personal_workspace
from workspaces.models import Workspace

from .models import TelegramGroup, TelegramLink, TelegramLinkCode, TelegramLog, TelegramSession, TelegramSettings
from .sealed import seal, unseal

CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
NEVER = datetime(9999, 12, 31, 23, 59, 59, 999000, tzinfo=dt_timezone.utc)
TOKEN_PATTERN = re.compile(r'^\d{5,16}:[A-Za-z0-9_-]{20,80}$')


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def normalize_code(value):
    return re.sub(r'[^A-Z0-9]', '', str(value or '').upper())


def now():
    return timezone.now()


def settings():
    """The settings row, with the bot token readable (it is stored encrypted, see sealed.py)."""
    s, _ = TelegramSettings.objects.get_or_create(id=1)
    out = row(s)
    out['bot_token'] = unseal(out['bot_token'])
    return out


def audit(actor, action, detail=''):
    AccessAudit.objects.create(actor_id=actor or None, action=action, target_id='TELEGRAM', detail=detail, created_at=now())


def name_of(staff):
    return Staff.objects.filter(id=staff).values_list('name', flat=True).first() or staff


def log(level, chat, message):
    TelegramLog.objects.create(level=level, chat_id=chat, message=str(message)[:1000], created_at=now())
    keep = list(TelegramLog.objects.order_by('-id').values_list('id', flat=True)[300:301])
    if keep:
        TelegramLog.objects.filter(id__lte=keep[0]).delete()


def mini_app_base(value):
    raw = text(value, _message('Mini App address'), 300)
    if not raw:
        return ''
    try:
        u = urlsplit(raw)
        host, port = u.hostname, u.port
    except ValueError:
        fail(_message('Enter the public HTTPS address of the Mini App gateway, for example https://tasks.example.com'))
    if not u.scheme or not host:
        fail(_message('Enter the public HTTPS address of the Mini App gateway, for example https://tasks.example.com'))
    if u.scheme.lower() != 'https' or u.username or u.password or u.query or u.fragment or (u.path and u.path != '/'):
        fail(_message('The Mini App address must be an https:// address with no path, for example https://tasks.example.com (Telegram only opens Mini Apps over HTTPS).'))
    return f"https://{host.encode('idna').decode().lower()}{f':{port}' if port and port != 443 else ''}"


def app_url(s=None):
    """The Mini App address the bot and the web app hand out (V5.7.7 effectiveMiniAppUrl): the shared public address when
    one is configured, otherwise the Mini App address saved in Administration → Telegram, or '' when neither is set."""
    from urllib.parse import quote as encode
    from django.conf import settings as conf
    s = s or settings()
    company = encode(conf.COMPANY_ID, safe="-_.!~*'()")
    if conf.PUBLIC_URL:
        return f'{conf.PUBLIC_URL}/c/{company}/tg/'
    return f"{s['mini_app_url']}/c/{company}/tg/" if s['mini_app_url'] else ''


def link_info(code, s, created):
    return {'code': code, 'link': f"https://t.me/{s['bot_username']}?start=link_{code}", 'bot_username': s['bot_username'],
            'created_at': iso(created) if isinstance(created, datetime) else created}


def unlink_account(staff, actor, why):
    """Run when a password changes, an account is disabled or someone signs out everywhere (access.mjs unlinkTelegram)."""
    if not staff:
        return
    n = TelegramLink.objects.filter(staff_id=staff).delete()[0]
    TelegramLinkCode.objects.filter(staff_id=staff).delete()
    if n:
        AccessAudit.objects.create(actor_id=actor or None, action=_message('Telegram account disconnected'), target_id=staff,
                                   detail=f'{name_of(staff)} · {why}', created_at=now())


def handle(gov, action, d, actor):
    if action == 'admin.telegram.save':
        old = settings()
        if isinstance(d.get('expected_version'), bool) or d.get('expected_version') != old['version']:
            fail(_message('This record changed. Refresh it before saving again.'), 409)
        token = old['bot_token']
        if d.get('clear_token') is True:
            token = ''
        elif isinstance(d.get('bot_token'), str) and d['bot_token'].strip():
            token = d['bot_token'].strip()
            if not TOKEN_PATTERN.match(token):
                fail(_message('Paste the bot token exactly as @BotFather shows it: numbers, a colon, then letters and numbers.'))
        enabled = 1 if d.get('enabled') is True or d.get('enabled') == 1 else 0
        if enabled and not token:
            fail(_message('Add the bot token before turning Telegram on.'))
        hour = old['digest_hour'] if 'digest_hour' not in d else integer(d['digest_hour'], -1, 23, _message('daily reminder time'))
        changed_token = token != old['bot_token']
        values = {'enabled': bool(enabled), 'bot_token': seal(token),
                  'mini_app_url': old['mini_app_url'] if 'mini_app_url' not in d else mini_app_base(d['mini_app_url']),
                  'digest_hour': hour, 'group_updates': not (d.get('group_updates') is False or d.get('group_updates') == 0),
                  'status': 'OFF' if not enabled else 'STARTING' if changed_token or old['status'] == 'OFF' else old['status'],
                  'status_detail': '' if not enabled else _message('Connecting to Telegram…') if changed_token else old['status_detail'],
                  'version': old['version'] + 1, 'updated_at': now()}
        if changed_token:
            values.update({'bot_id': None, 'bot_username': '', 'bot_name': '', 'last_update_id': 0, 'last_notification_id': -1, 'last_history_id': -1})
        TelegramSettings.objects.filter(id=1).update(**values)
        audit(actor, _message('Telegram settings updated'),
              _message('{p0}{p1} · Mini App {p2} · reminders {p3}', p0='On' if enabled else 'Off', p1=' · bot token changed' if changed_token else '', p2=values['mini_app_url'] or 'not set', p3='off' if hour < 0 else str(hour) + ':00'))
        return {'message': _message('Telegram settings saved. The bot connects within a few seconds.') if enabled else _message('Telegram settings saved. The bot is off.')}
    if action == 'admin.telegram.group':
        try:
            chat = int(d.get('chat_id')) if not isinstance(d.get('chat_id'), bool) else None
        except (TypeError, ValueError):
            chat = None
        g = row(TelegramGroup.objects.filter(chat_id=chat).first()) if chat is not None and abs(chat) <= 9007199254740991 else None
        if not g:
            fail(_message('Telegram group not found.'), 404)
        if 'expected_version' in d and (isinstance(d['expected_version'], bool) or d['expected_version'] != g['version']):
            fail(_message('This record changed. Refresh it before saving again.'), 409)
        workspace = None
        if d.get('workspace_id'):
            w = row(Workspace.objects.filter(id=text(d['workspace_id'], _message('Workspace'), 60, True)).first())
            if not w:
                fail(_message('Workspace not found.'), 404)
            if w['status'] != 'ACTIVE':
                fail(_message('Choose an active workspace.'))
            if gov.governed(w) and (not gov.can_manage_workspace(actor, w) or is_personal_workspace(w)):
                fail(_message('Personal or unauthorized workspaces cannot be linked to a Telegram group.'), 403)
            workspace = w['id']
        TelegramGroup.objects.filter(chat_id=g['chat_id']).update(
            workspace_id=workspace, notify=not (d.get('notify') is False or d.get('notify') == 0), linked_by_id=actor if workspace else None,
            linked_at=now() if workspace else None, version=g['version'] + 1)
        audit(actor, _message('Telegram group linked') if workspace else _message('Telegram group unlinked'), f"{g['title']} ({g['chat_id']}){' → ' + workspace if workspace else ''}")
        return {'message': _message('Group linked to the workspace.') if workspace else _message('Group unlinked.')}
    if action == 'admin.telegram.unlink':
        staff = active_staff(d.get('staff_id')).id
        link = TelegramLink.objects.filter(staff_id=staff).first()
        if not link:
            return {'message': _message('This person is not connected to Telegram.')}
        TelegramLink.objects.filter(staff_id=staff).delete()
        audit(actor, _message('Telegram account disconnected'), _message('{p0} · Telegram user {p1}', p0=name_of(staff), p1=link.tg_user_id))
        return {'message': _message('{p0} is no longer connected to Telegram.', p0=name_of(staff))}
    if action == 'tg.link.code':
        s = settings()
        if not s['enabled'] or not s['bot_username']:
            fail(_message('Telegram is not connected yet. Ask an administrator to connect the company bot in Administration → Telegram.'), 409)
        current = None if d.get('renew') is True else (TelegramLinkCode.objects.filter(staff_id=actor, code__isnull=False, expires_at__gt=now())
                                                         .order_by('-created_at').first())
        if current:
            return {'message': _message('Your connect link is ready.'), **link_info(current.code, s, current.created_at)}
        TelegramLinkCode.objects.filter(expires_at__lt=now()).delete()
        TelegramLinkCode.objects.filter(staff_id=actor).delete()
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        created = now()
        TelegramLinkCode.objects.create(code_hash=digest(code), staff_id=actor, expires_at=NEVER, created_at=created, code=code)
        if d.get('renew') is True:
            audit(actor, _message('Telegram connect link replaced'), name_of(actor))
        return {'message': _message('New connect link created. The previous one no longer works.') if d.get('renew') is True
                else _message('Your connect link is ready. It works once and does not expire.'), **link_info(code, s, created)}
    if action == 'tg.link.unlink':
        n = TelegramLink.objects.filter(staff_id=actor).delete()[0]
        TelegramLinkCode.objects.filter(staff_id=actor).delete()
        if n:
            audit(actor, _message('Telegram account disconnected'), name_of(actor))
        return {'message': _message('Telegram disconnected from your account.') if n else _message('Your account is not connected to Telegram.')}
    if action == 'tg.link.notify':
        link = TelegramLink.objects.filter(staff_id=actor).first()
        if not link:
            fail(_message('Connect Telegram first.'), 409)
        off = d.get('notify') is False or d.get('notify') == 0
        TelegramLink.objects.filter(tg_user_id=link.tg_user_id).update(notify=not off)
        return {'message': _message('Telegram messages turned off. You can still use the bot.') if off else _message('Telegram messages turned on.')}
    fail(_message('Unknown Telegram action.'), 404)


# ---------------------------------------------------------------- used by the bot and the Mini App gateway
def redeem(value, sender, chat_id):
    """A connect link code links one Telegram account to the login that created it. Returns {'staff'} or {'error'}."""
    code = normalize_code(value)
    if len(code) != 8:
        return {'error': _message('That link code is not valid. Open the Task Controlling Management → your name (top right) → Connect Telegram to see your personal link.')}
    with transaction.atomic():
        found = TelegramLinkCode.objects.select_for_update().filter(code_hash=digest(code)).first()
        if not found or found.expires_at < now():
            return {'error': _message('That link code is not valid: it may be mistyped, already used or replaced by a newer link. Open the Task Controlling Management → your name (top right) → Connect Telegram to see your current link.')}
        TelegramLinkCode.objects.filter(code_hash=found.code_hash).delete()
        result = attach(found.staff_id, sender, chat_id, _message('connect link'))
        if result.get('staff'):
            changed()
    return result


def attach(staff, sender, chat_id, how):
    if not User.objects.filter(staff_id=staff, active=True).exists():
        return {'error': _message('This Task Controlling Management account is disabled. Ask an administrator for help.')}
    TelegramLink.objects.filter(tg_user_id=sender['id']).delete()
    TelegramLink.objects.filter(staff_id=staff).delete()
    TelegramLinkCode.objects.filter(staff_id=staff).delete()
    username, first = str(sender.get('username') or '')[:64], str(sender.get('first_name') or '')[:128]
    TelegramLink.objects.create(tg_user_id=sender['id'], staff_id=staff, chat_id=chat_id, username=username, first_name=first, notify=True,
                                linked_at=now(), last_seen_at=now())
    audit(staff, _message('Telegram account connected'),
          _message('{p0} · Telegram user {p1}{p2} · {p3}', p0=name_of(staff), p1=sender['id'], p2=' (@' + str(sender['username']) + ')' if sender.get('username') else '', p3=how))
    who = '@' + username if sender.get('username') else str(sender.get('first_name') or _message('A Telegram account'))[:128]
    Notification.objects.create(
        staff_id=staff, kind='telegram_connected', title=_message('Telegram connected'), actor_id=staff, created_at=now(),
        body=_message('{p0} now uses your Task Controlling Management account in Telegram ({p1}). If this was not you, open your name → My profile → Telegram and disconnect it.', p0=who, p1='with your connect link' if how == 'connect link' else 'signed in with your Task Controlling Management password'))
    return {'staff': staff, 'name': name_of(staff)}


def connect_signed_in(staff, sender, chat_id):
    with transaction.atomic():
        result = attach(staff, sender, chat_id, _message('signed in with the Task Controlling Management password in the Telegram app'))
        if result.get('staff'):
            changed()
    return result


def link_for(tg_user):
    return row(TelegramLink.objects.filter(tg_user_id=tg_user).first())


def link_for_staff(staff):
    return row(TelegramLink.objects.filter(staff_id=staff).first())


def touch(sender, chat_id, private):
    link = link_for(sender['id'])
    if not link:
        return None
    changes = {'username': str(sender.get('username') or '')[:64], 'first_name': str(sender.get('first_name') or '')[:128], 'last_seen_at': now()}
    if private and chat_id is not None:
        changes['chat_id'] = chat_id
    TelegramLink.objects.filter(tg_user_id=sender['id']).update(**changes)
    return {**link, 'chat_id': chat_id if private else link['chat_id']}


def seen_group(chat, active=True):
    title = str(chat.get('title') or _message('Telegram group'))[:200]
    if TelegramGroup.objects.filter(chat_id=chat['id']).exists():
        TelegramGroup.objects.filter(chat_id=chat['id']).update(title=title, type=chat.get('type') or 'group', active=bool(active), seen_at=now())
    else:
        TelegramGroup.objects.create(chat_id=chat['id'], title=title, type=chat.get('type') or 'group', active=bool(active), seen_at=now())
    return row(TelegramGroup.objects.get(chat_id=chat['id']))


def link_group(gov, chat_id, workspace, actor):
    w = row(Workspace.objects.filter(id=workspace, status='ACTIVE').first())
    if not w or (gov.governed(w) and (not gov.can_manage_workspace(actor, w) or is_personal_workspace(w))):
        return None
    g = TelegramGroup.objects.filter(chat_id=chat_id).first()
    TelegramGroup.objects.filter(chat_id=chat_id).update(workspace_id=w['id'], linked_by_id=actor, linked_at=now(), active=True,
                                                         version=(g.version + 1) if g else 1)
    audit(actor, _message('Telegram group linked'), f"{g.title if g else chat_id} → {w['name']}")
    changed()
    return w


def unlink_group(chat_id, actor):
    g = TelegramGroup.objects.filter(chat_id=chat_id).first()
    TelegramGroup.objects.filter(chat_id=chat_id).update(workspace_id=None, linked_by_id=None, linked_at=None, version=(g.version + 1) if g else 1)
    audit(actor, _message('Telegram group unlinked'), str(chat_id))
    changed()


def migrate_group(old, new):
    if TelegramGroup.objects.filter(chat_id=new).exists():
        TelegramGroup.objects.filter(chat_id=old).delete()
    else:
        g = TelegramGroup.objects.filter(chat_id=old).first()
        if g:
            values = {f.attname: getattr(g, f.attname) for f in TelegramGroup._meta.concrete_fields if f.attname != 'chat_id'}
            g.delete()
            TelegramGroup.objects.create(chat_id=new, **values)
    TelegramSession.objects.filter(chat_id=old).delete()


class Sessions:
    @staticmethod
    def get(chat, user):
        s = TelegramSession.objects.filter(chat_id=chat, tg_user_id=user).first()
        if not s:
            return None
        if s.expires_at < now():
            s.delete()
            return None
        try:
            data = json.loads(s.data)
        except ValueError:
            data = {}
        return {'chat_id': s.chat_id, 'tg_user_id': s.tg_user_id, 'flow': s.flow, 'step': s.step, 'data': data,
                'message_id': s.message_id, 'prompt_id': s.prompt_id, 'expires_at': iso(s.expires_at)}

    @staticmethod
    def set(chat, user, flow, step, data=None, ids=None):
        ids = ids or {}
        TelegramSession.objects.update_or_create(chat_id=chat, tg_user_id=user, defaults={
            'flow': flow, 'step': step, 'data': json.dumps(data or {}, separators=(',', ':'), ensure_ascii=False),
            'message_id': ids.get('message_id'), 'prompt_id': ids.get('prompt_id'), 'expires_at': now() + timedelta(minutes=20)})

    @staticmethod
    def clear(chat, user):
        TelegramSession.objects.filter(chat_id=chat, tg_user_id=user).delete()


session = Sessions()


def set_status(status, detail=''):
    old = settings()
    detail = str(detail)[:500]
    TelegramSettings.objects.filter(id=1).update(status=status, status_detail=detail, checked_at=now())
    if old['status'] != status or old['status_detail'] != detail:
        changed()


# ---------------------------------------------------------------- what the screens receive (part of /api/state)
def info(gov, user, can_admin, app_url, shared=False):
    s = settings()
    link = link_for_staff(user.staff_id)
    has_app = bool(app_url) and (shared or bool(s['mini_app_url']))
    code = None
    if not link and s['enabled'] and s['bot_username']:
        code = TelegramLinkCode.objects.filter(staff_id=user.staff_id, code__isnull=False, expires_at__gt=now()).order_by('-created_at').first()
    out = {'telegram': {'enabled': bool(s['enabled']), 'status': s['status'], 'bot_username': s['bot_username'],
                        'app_url': app_url if s['enabled'] and has_app else '',
                        'link': {'username': link['username'], 'first_name': link['first_name'], 'linked_at': link['linked_at'],
                                 'notify': bool(link['notify'])} if link else None,
                        'connect': link_info(code.code, s, code.created_at) if code else None}}
    if can_admin:
        since = now() - timedelta(days=7)
        links = [{'staff_id': k.staff_id, 'name': k.staff.name, 'username': k.username, 'first_name': k.first_name, 'notify': 1 if k.notify else 0,
                  'linked_at': iso(k.linked_at), 'last_seen_at': iso(k.last_seen_at)}
                 for k in TelegramLink.objects.select_related('staff').order_by('staff__name')]
        groups = []
        for g in TelegramGroup.objects.select_related('workspace').order_by('-active', 'title'):
            if g.workspace_id and not gov.can_view_workspace(user.staff_id, row(g.workspace)):
                continue
            groups.append({'chat_id': str(g.chat_id), 'title': g.title, 'type': g.type, 'workspace_id': g.workspace_id,
                           'workspace': g.workspace.name if g.workspace else None, 'notify': 1 if g.notify else 0, 'active': 1 if g.active else 0,
                           'linked_at': iso(g.linked_at), 'seen_at': iso(g.seen_at), 'version': g.version})
        recent = (NotificationDelivery.objects.filter(channel='TELEGRAM').select_related('notification', 'notification__staff')
                  .order_by('-updated_at', '-notification_id')[:30])
        out['telegram_admin'] = {
            'settings': {'enabled': bool(s['enabled']), 'token_set': bool(s['bot_token']), 'token_hint': '…' + s['bot_token'][-4:] if s['bot_token'] else '',
                         'bot_username': s['bot_username'], 'bot_name': s['bot_name'], 'mini_app_url': s['mini_app_url'],
                         'app_url': app_url if has_app else '', 'shared': shared, 'digest_hour': s['digest_hour'],
                         'group_updates': bool(s['group_updates']), 'status': s['status'], 'status_detail': s['status_detail'],
                         'checked_at': s['checked_at'], 'version': s['version']},
            'links': links, 'groups': groups,
            'log': rows(TelegramLog.objects.order_by('-id')[:30]),
            'deliveries': {'since': iso(since),
                           'summary': [{'status': r['status'], 'n': r['n']} for r in NotificationDelivery.objects.filter(channel='TELEGRAM', updated_at__gt=since)
                                       .values('status').annotate(n=Count('notification_id')).order_by('status')],
                           'recent': [{'notification_id': d.notification_id, 'status': d.status, 'reason': d.reason, 'attempts': d.attempts,
                                       'updated_at': iso(d.updated_at), 'kind': d.notification.kind, 'name': d.notification.staff.name} for d in recent]},
        }
    return out

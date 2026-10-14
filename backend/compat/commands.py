"""The V5.7.7 command bus: POST /api/command {action, data}.

Each command runs in one database transaction (V5.7.7: BEGIN IMMEDIATE … COMMIT): the acting staff member must be
active, organization governance checks it first (guard), the domain service applies it, governance reconciles
afterwards, and the shared change counter advances so open clients reload. Any failure rolls everything back.
"""
import threading
import time

from django.db import IntegrityError, transaction

from accounts import services as access
from core.errors import fail
from core.services import active_staff, changed
from organization.governance import Governance
from workspaces import services as workspaces

SOURCES = ('WEB', 'TELEGRAM', 'MINIAPP')


def apply(gov, action, d, actor, user, meta):
    if action.startswith('org.'):
        return gov.handle(action, d, actor)
    if action == 'admin.integrations.save':
        fail('This action is not available.', 403)
    if action.startswith('admin.telegram.') or action.startswith('tg.'):
        fail('Telegram is connected in a later step of this migration.', 501)
    if action == 'admin.user.save':
        return access.save_user(d, actor)
    if action == 'admin.user.disable':
        return access.disable_user(d, actor)
    if action == 'admin.role.save':
        return access.save_role(d, actor)
    if action == 'admin.role.delete':
        return access.delete_role(d, actor)
    if action == 'admin.modules.save':
        return access.save_modules(d, actor)
    if action == 'me.sessions.end':
        count = access.sign_out_everywhere(user, telegram=d.get('telegram') is True)
        return {'message': f"Signed out of {count} session{'' if count == 1 else 's'}{' and Telegram' if d.get('telegram') is True else ''}."}
    if action.startswith('tm.workspace.'):
        return workspaces.handle(gov, action, d, actor)
    fail('Unknown Task Management action.', 404)


def run(user, action, data, source='WEB'):
    """Authorize and run one command for a signed-in account; returns the command's result."""
    if not isinstance(data, dict):
        fail('A record object is required.')
    from .authorize import authorize
    authorize(user, action, data)
    meta = {'source': source if source in SOURCES else 'WEB'}
    actor = user.staff_id
    try:
        with transaction.atomic():
            active_staff(actor)
            gov = Governance()
            gov.guard(action, data, actor)
            result = apply(gov, action, data, actor, user, meta)
            gov.after_command(action, data, actor)
            changed()
            return result
    except IntegrityError as error:
        message = str(error).lower()
        if 'unique' in message or 'duplicate' in message:
            fail('This ID or linked record already exists.', 409)
        if 'foreign key' in message or 'reference constraint' in message:
            fail('A related record is missing or still in use.', 409)
        raise


class RateLimiter:
    """V5.6.8: a burst of up to 120 changes, then about five a second, per signed-in person (per server process)."""

    def __init__(self, burst=120, per_ms=0.005):
        self.burst, self.per_ms, self.buckets, self.lock = burst, per_ms, {}, threading.Lock()

    def limited(self, key):
        with self.lock:
            now = time.monotonic() * 1000
            tokens, at = self.buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - at) * self.per_ms)
            if tokens < 1:
                self.buckets[key] = (tokens, now)
                return True
            self.buckets[key] = (tokens - 1, now)
            if len(self.buckets) > 5000:
                for k, (_, seen) in list(self.buckets.items()):
                    if now - seen > 600000:
                        del self.buckets[k]
            return False


limiter = RateLimiter()

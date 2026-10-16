"""Accounts, roles, permissions and sessions — ported from access.mjs / identity.mjs (V5.7.7).

Rules kept exactly:
  * Function permissions = role permissions, adjusted by individual ALLOW/DENY settings (DENY wins), and only for
    enabled modules. A row grants nothing unless View is effective.
  * The protected Administrator role always has every function and cannot carry individual overrides.
  * `admin.workspaces` (global Workspace visibility) exists only for the Administrator role.
  * At least one active Administrator must remain.
  * Usernames are unique case-insensitively after NFKC normalization and whitespace collapsing.
  * Failed sign-ins are limited per address+username (10), per username (20) and per address (50) in 15 minutes.
  * Sessions last 8 hours; changing role/username/email/password/permissions or disabling an account ends them.
"""
import hashlib
import json
import re
import secrets
import unicodedata
from datetime import timedelta

from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone

from core import hooks
from core.errors import fail
from core.models import Company, ModuleSetting, Staff
from core.services import active_staff, next_id
from core.validation import iso, text
from organization.models import OrgSettings, Profile

from .catalog import (ADMIN_ROLE, BUILT_IN_ROLES, CATALOG, DEFAULT_MODULES, LABELS, MODULES, RESOURCES,
                      resource_module, role_defaults)
from .models import AccessAudit, AccessSession, LoginAttempt, Role, RolePermission, User, UserPermissionOverride

SESSION_SECONDS = 8 * 3600
ATTEMPT_WINDOW = timedelta(minutes=15)
LIMITS = (('pair', 10), ('account', 20), ('address', 50))
# Verifying against this when the username does not exist keeps response timing the same as a wrong password.
_DUMMY_HASH = make_password('unused-password-for-timing-only')


# ---------------------------------------------------------------- identity helpers
def clean_username(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', '' if value is None else str(value)).strip())


def username_key(value):
    return clean_username(value).lower()


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def audit(actor_staff_id, action, target_id, detail=''):
    AccessAudit.objects.create(actor_id=actor_staff_id or None, action=action, target_id=target_id, detail=detail,
                               created_at=timezone.now())


def public_user(user):
    """The account as the frontend receives it (same fields as V5.7.7 publicUser)."""
    if user is None:
        return None
    return {'id': user.id, 'staff_id': user.staff_id, 'email': user.email, 'username': user.username,
            'role_id': user.role_id, 'active': 1 if user.active else 0, 'version': user.version,
            'created_at': iso(user.created_at), 'updated_at': iso(user.updated_at),
            'name': user.staff.name, 'role_name': user.role.name}


# ---------------------------------------------------------------- setup of a new database
def ensure_defaults():
    """Built-in roles and module switches on an empty database (V5.7.7 creates them on first start)."""
    with transaction.atomic():
        for module_id, _, _, _ in MODULES:
            ModuleSetting.objects.get_or_create(module_id=module_id, defaults={'enabled': DEFAULT_MODULES[module_id]})
        if not Role.objects.exists():
            now = timezone.now()
            for key, name, kind in BUILT_IN_ROLES:
                description = ('Full system access. At least one active administrator is required.' if kind == 'ADMIN'
                               else f'Starting {name.lower()} permissions; customize as needed.')
                role = Role.objects.create(id=key, name=name, description=description, protected=kind == 'ADMIN',
                                           created_at=now, updated_at=now)
                RolePermission.objects.bulk_create(
                    RolePermission(role=role, resource=resource, action=action)
                    for resource, actions in role_defaults(kind).items() for action in actions)
        OrgSettings.objects.get_or_create(id=1)


# ---------------------------------------------------------------- permissions
def enabled_modules():
    return set(ModuleSetting.objects.filter(enabled=True).values_list('module_id', flat=True))


def module_enabled(key):
    return key in enabled_modules()


def role_permissions(role_id):
    if role_id == ADMIN_ROLE:
        return role_defaults('ADMIN')
    out = {resource: [] for resource, _, _ in RESOURCES}
    for resource, action in RolePermission.objects.filter(role_id=role_id).values_list('resource', 'action'):
        if resource in out:
            out[resource].append(action)
    return out


def user_settings(user):
    out = {}
    for resource, action, effect in UserPermissionOverride.objects.filter(user=user).values_list('resource', 'action', 'effect'):
        out.setdefault(resource, {})[action] = effect
    return out


def effective(role_id, settings=None, modules=None):
    return _effective(role_permissions(role_id), settings or {}, enabled_modules() if modules is None else modules)


def _effective(base, settings, modules):
    out = {}
    for resource, _, actions in RESOURCES:
        if resource_module(resource) not in modules:
            out[resource] = []
            continue

        def yes(action):
            setting = settings.get(resource, {}).get(action)
            if setting == 'DENY':
                return False
            if setting == 'ALLOW':
                return True
            return action in base.get(resource, [])
        out[resource] = [a for a in actions if yes(a)] if yes('view') else []
    return out


def _org_settings():
    return OrgSettings.objects.filter(id=1).first()


def is_level1(staff_id):
    """Organization administrator: an active employee with a login at Level 1 (organization.mjs isLevel1)."""
    return (staff_is_active(staff_id) and
            Profile.objects.filter(staff_id=staff_id, org_level_id=1).exists())


def staff_is_active(staff_id):
    """organization.mjs active(): an active login, an active staff record and an active (or missing) team profile."""
    if not staff_id:
        return False
    if not User.objects.filter(staff_id=staff_id, active=True, staff__active=True).exists():
        return False
    return not Profile.objects.filter(staff_id=staff_id, active=False).exists()


def permissions(user):
    """Effective function permissions for an account, including the Organizational Structure adjustments."""
    return permissions_for_many([user])[user.id]


def permissions_for_many(users):
    """permissions() for several accounts with a fixed number of queries (the people list needs everyone's)."""
    users = list(users)
    modules = enabled_modules()
    role_ids = {u.role_id for u in users if u.role_id != ADMIN_ROLE}
    by_role = {r: {resource: [] for resource, _, _ in RESOURCES} for r in role_ids}
    for role_id, resource, action in RolePermission.objects.filter(role_id__in=role_ids).values_list('role_id', 'resource', 'action'):
        if resource in by_role[role_id]:
            by_role[role_id][resource].append(action)
    prefs_by_user = {u.id: {} for u in users}
    for user_id, resource, action, effect in UserPermissionOverride.objects.filter(
            user_id__in=[u.id for u in users if u.role_id != ADMIN_ROLE]).values_list('user_id', 'resource', 'action', 'effect'):
        prefs_by_user[user_id].setdefault(resource, {})[action] = effect
    settings = _org_settings()
    org_enabled = bool(settings and settings.enabled)
    level1 = level1_staff({u.staff_id for u in users}) if 'tasks' in modules else set()
    return {u.id: _permissions(u, prefs_by_user[u.id], modules, by_role.get(u.role_id), org_enabled, u.staff_id in level1) for u in users}


def level1_staff(staff_ids):
    """Which of these people are organization administrators (is_level1), in two queries."""
    level1 = set(Profile.objects.filter(staff_id__in=staff_ids, org_level_id=1).values_list('staff_id', flat=True))
    if not level1:
        return set()
    active = set(User.objects.filter(staff_id__in=level1, active=True, staff__active=True).values_list('staff_id', flat=True))
    inactive_profile = set(Profile.objects.filter(staff_id__in=active, active=False).values_list('staff_id', flat=True))
    return active - inactive_profile


def _permissions(user, prefs, modules, role_perms, org_enabled, is_admin_level1):
    if user.role_id == ADMIN_ROLE:
        prefs, role_perms = {}, role_defaults('ADMIN')
    out = _effective(role_perms or {}, prefs, modules)
    if 'tasks' in modules and 'view' in out.get('tasks.tasks', []) and org_enabled:
        for action in ('view', 'create'):
            if prefs.get('tasks.workspace', {}).get(action) != 'DENY' and action not in out['tasks.workspace']:
                out['tasks.workspace'].append(action)
    # Organization authority never grants platform administration or task approval/closure actions.
    if 'tasks' in modules and is_admin_level1:
        for resource in ('tasks.workspace', 'tasks.groups', 'tasks.reports'):
            out[resource] = list(CATALOG.get(resource, []))
        for resource in ('tasks.tasks', 'tasks.meetings', 'tasks.timesheets'):
            if 'view' not in out[resource]:
                out[resource] = ['view']
    if user.role_id != ADMIN_ROLE:
        out['admin.workspaces'] = []
    # Functions switched off in this deployment (settings.HIDDEN_FUNCTIONS; by default the Google Sheets connection).
    for resource in hidden_functions():
        if resource in out:
            out[resource] = []
    return out


def hidden_functions():
    from django.conf import settings
    return getattr(settings, 'HIDDEN_FUNCTIONS', ())


def can(user, resource, action='view', perms=None):
    if user is None:
        return False
    perms = perms if perms is not None else permissions(user)
    return action in perms.get(resource, [])


def account_for(staff_id):
    return User.objects.select_related('staff', 'role').filter(staff_id=staff_id, active=True).first()


def can_staff(staff_id, resource, action='view'):
    user = account_for(staff_id)
    return bool(user) and can(user, resource, action)


def require_permission(user, resource, action='view'):
    if user is None:
        fail('Sign in to continue.', 401)
    if not can(user, resource, action):
        fail(f'Your account does not allow {action} for {LABELS.get(resource, resource)}.', 403)


def profile_manager(user):
    """People who manage other people's team profiles (V5.6.8)."""
    perms = permissions(user)
    return can(user, 'tasks.users', 'update', perms) and (can(user, 'admin.users', 'update', perms) or
                                                          can(user, 'tasks.tasks', 'approve', perms))


# ---------------------------------------------------------------- validation
def check_password_policy(value):
    if not isinstance(value, str) or len(value) < 10 or len(value) > 200:
        fail('Use a password between 10 and 200 characters.')
    return value


def email_address(value):
    email = text(value, 'Contact email', 200).lower()
    if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        fail('Enter a valid email address.')
    return email


def normalize_settings(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        fail('Provide valid Function Settings.')
    out = {}
    for resource, settings in value.items():
        if resource not in CATALOG or not isinstance(settings, dict):
            fail('Unknown function in user settings.')
        for action, effect in settings.items():
            if action not in CATALOG[resource] or effect not in ('ALLOW', 'DENY', 'INHERIT'):
                fail('Invalid function setting.')
            if effect != 'INHERIT':
                out.setdefault(resource, {})[action] = effect
    return out


def check_version(record, expected):
    if expected != record.version:
        fail('This record changed. Refresh it before saving again.', 409)


def _keep_last_admin(old, next_role, next_active):
    if old.role_id == ADMIN_ROLE and old.active and (not next_active or next_role != ADMIN_ROLE):
        others = (User.objects.select_for_update().filter(role_id=ADMIN_ROLE, active=True).exclude(id=old.id))
        if not others.exists():
            fail('Keep at least one active Administrator account.', 409)


def _end_sessions(user):
    return AccessSession.objects.filter(user=user).delete()[0]


def _unlink_telegram(staff_id, actor, why):
    for unlink in hooks.TELEGRAM_UNLINK:
        unlink(staff_id, actor, why)


# ---------------------------------------------------------------- user accounts
def _get_role(key):
    role = Role.objects.filter(id=text(key, 'Role', 60, True)).first()
    if not role:
        fail('Role not found.', 404)
    return role


def save_user(d, actor):
    """admin.user.save (also used by first-administrator setup)."""
    old = None
    if d.get('id'):
        old = User.objects.select_for_update().select_related('staff').filter(id=d['id']).first()
        if not old:
            fail('User not found.', 404)
        check_version(old, d.get('expected_version'))
    role = _get_role(d.get('role_id'))
    email = email_address(d.get('email'))
    active = not (d.get('active') is False or d.get('active') == 0)
    function_settings = normalize_settings(d.get('function_settings'))
    if role.id == ADMIN_ROLE and function_settings:
        fail('Administrator access is protected. Use another role for individual overrides.')
    if old:
        _keep_last_admin(old, role.id, active)
    if email and User.objects.filter(email=email).exclude(id=old.id if old else '').exists():
        fail('An account with this email already exists.', 409)
    raw_name = d.get('username', d.get('name', old.username if old else None))
    name = text(clean_username(raw_name) if raw_name is not None else None, 'Username', 200, True)
    key_name = username_key(name)
    if old:
        staff_id = old.staff_id
    elif d.get('staff_id'):
        staff_id = active_staff(d['staff_id']).id
    else:
        staff_id = next_id('staff', 'STAFF')
    if not old and User.objects.filter(staff_id=staff_id).exists():
        fail('This staff member already has a login account.', 409)
    if Staff.objects.filter(name=name).exclude(id=staff_id).exists():
        fail('Another staff member already uses this name. Add a detail, such as the department, to tell them apart.', 409)
    if old and staff_id == actor and name != old.username:
        fail('Ask another administrator to change your username.', 403)
    if User.objects.filter(username_key=key_name).exclude(id=old.id if old else '').exists():
        fail('This username is already in use. Choose a unique username.', 409)
    password = d.get('password')
    if password:
        password_hash = make_password(check_password_policy(password))
    elif old:
        password_hash = old.password
    else:
        password_hash = make_password(check_password_policy(password))

    now = timezone.now()
    if not old and not d.get('staff_id'):
        Staff.objects.create(id=staff_id, name=name, active=True)
    else:
        Staff.objects.filter(id=staff_id).update(name=name)
    if old:
        user = old
        user.version = old.version + 1
    else:
        user = User(id=next_id('access-user', 'USER'), created_at=now, version=0)
    previous = {'role_id': old.role_id, 'username': old.username, 'email': old.email} if old else None
    user.staff_id, user.email, user.username, user.username_key = staff_id, email, name, key_name
    user.role, user.password, user.active, user.updated_at = role, password_hash, active, now
    user.save()

    if function_settings is not None or role.id == ADMIN_ROLE:
        UserPermissionOverride.objects.filter(user=user).delete()
        UserPermissionOverride.objects.bulk_create(
            UserPermissionOverride(user=user, resource=resource, action=action, effect=effect)
            for resource, settings in (function_settings or {}).items() for action, effect in settings.items())

    team = Profile.objects.filter(staff_id=staff_id).first()
    team_email = team.email if team and team.email and (not old or team.email != old.email) else email
    if old:
        position = d.get('position', team.position if team else '')
        department = d.get('department', team.department if team else '')
    else:
        position = d.get('position') or (team.position if team else '')
        department = d.get('department') or (team.department if team else '')
    position, department = text(position, 'Position', 150), text(department, 'Department', 150)
    if team:
        Profile.objects.filter(staff_id=staff_id).update(email=team_email, position=position, department=department,
                                                         version=team.version + 1)
    else:
        Profile.objects.create(staff_id=staff_id, email=team_email, position=position, department=department)

    if old and (previous['role_id'] != role.id or previous['username'] != name or previous['email'] != email
                or password or not active or function_settings is not None):
        _end_sessions(user)
    if old and (password or not active):
        _unlink_telegram(staff_id, actor, 'password changed' if password else 'account disabled')
    settings_note = f' · Function Settings: {json.dumps(function_settings, separators=(",", ":"))}' if function_settings is not None else ''
    audit(actor, 'User account updated' if old else 'User account created', user.id,
          f"{name} · {email} · {role.name} · {'active' if active else 'disabled'}{settings_note}")
    return {'id': user.id, 'type': 'admin_user'}


def disable_user(d, actor):
    old = User.objects.select_for_update().filter(id=d.get('id')).first()
    if not old:
        fail('User not found.', 404)
    check_version(old, d.get('expected_version'))
    _keep_last_admin(old, old.role_id, False)
    reason = text(d.get('reason'), 'Reason', 1000, True)
    User.objects.filter(id=old.id).update(active=False, version=old.version + 1, updated_at=timezone.now())
    _end_sessions(old)
    _unlink_telegram(old.staff_id, actor, 'account disabled')
    audit(actor, 'User account disabled', old.id, reason)
    return {'message': 'Account disabled. Staff records and history are preserved.'}


# ---------------------------------------------------------------- roles and modules
def save_role(d, actor):
    old = None
    if d.get('id'):
        old = Role.objects.select_for_update().filter(id=d['id']).first()
        if not old:
            fail('Role not found.', 404)
        check_version(old, d.get('expected_version'))
        if old.protected:
            fail('The Administrator role is protected. Create a custom role to change its permissions.')
    name = text(d.get('name'), 'Role name', 150, True)
    description = text(d.get('description'), 'Description', 2000)
    key = old.id if old else next_id('access-role', 'ROLE')
    if any(r.lower() == name.lower() for r in Role.objects.exclude(id=key).values_list('name', flat=True)):
        fail('A role with this name already exists. Choose a different name.', 409)
    matrix = d.get('permissions')
    if not isinstance(matrix, dict):
        fail('Provide a permission matrix.')
    rows = []
    for resource, actions in matrix.items():
        if resource not in CATALOG or not isinstance(actions, list):
            fail('Invalid permission row.')
        unique = list(dict.fromkeys(actions))
        if unique and 'view' not in unique:
            fail('View permission is required before granting actions in a row.')
        for action in unique:
            if action not in CATALOG[resource]:
                fail('This permission is not supported for the selected function.')
            rows.append((resource, action))
    now = timezone.now()
    if old:
        Role.objects.filter(id=key).update(name=name, description=description, version=old.version + 1, updated_at=now)
    else:
        Role.objects.create(id=key, name=name, description=description, protected=False, created_at=now, updated_at=now)
    RolePermission.objects.filter(role_id=key).delete()
    RolePermission.objects.bulk_create(RolePermission(role_id=key, resource=r, action=a) for r, a in rows)
    audit(actor, 'Role and permissions updated' if old else 'Role created', key,
          json.dumps({'name': name, 'permissions': matrix}, separators=(',', ':'), ensure_ascii=False))
    return {'id': key, 'type': 'admin_role'}


def delete_role(d, actor):
    old = _get_role(d.get('id'))
    check_version(old, d.get('expected_version'))
    if old.protected:
        fail('The Administrator role cannot be deleted.')
    if User.objects.filter(role=old).exists():
        fail('Reassign every account using this role before deleting it.')
    old.delete()
    audit(actor, 'Role deleted', old.id, old.name)
    return {'message': 'Role deleted.'}


def save_modules(d, actor):
    chosen = d.get('modules')
    if not isinstance(chosen, dict):
        fail('Select company modules.')
    known = {m[0] for m in MODULES}
    if any(key not in known for key in chosen):
        fail('Unknown Task Controlling Management module.')
    versions = d.get('versions') or {}
    for module_id, label, required, dependencies in MODULES:
        value = chosen.get(module_id)
        if not isinstance(value, bool):
            fail('Set every module to enabled or disabled.')
        if required and not value:
            fail(f'{label} must stay enabled.')
        if value and any(not chosen.get(dep) for dep in dependencies):
            fail(f'Enable dependencies before enabling {label}: {", ".join(dependencies)}.')
        row = ModuleSetting.objects.select_for_update().get(module_id=module_id)
        if versions.get(module_id) != row.version:
            fail('This record changed. Refresh it before saving again.', 409)
    for module_id, *_ in MODULES:
        row = ModuleSetting.objects.get(module_id=module_id)
        ModuleSetting.objects.filter(module_id=module_id).update(enabled=chosen[module_id], version=row.version + 1)
    audit(actor, 'Company modules configured', 'MODULES', json.dumps(chosen, separators=(',', ':')))
    return {'message': 'Company modules updated. Existing data and saved permissions are preserved.'}


# ---------------------------------------------------------------- first administrator, sign-in and sessions
def bootstrap(d):
    """First-time setup: creates the company record and the first Administrator. Refused once any account exists."""
    with transaction.atomic():
        ensure_defaults()
        if User.objects.select_for_update().exists():
            fail('An administrator already exists. Sign in instead.', 409)
        if d.get('staff_id'):
            staff_id = active_staff(d['staff_id']).id
        else:
            if Staff.objects.exists():
                fail('Choose the staff identity for the first administrator.')
            staff_id = next_id('staff', 'STAFF')
            raw = d.get('username', d.get('name'))
            Staff.objects.create(id=staff_id, name=text(clean_username(raw) if raw is not None else None, 'Username', 200, True))
        if not Company.objects.filter(id=1).exists():
            Company.objects.create(id=1, name=text(d.get('company_name'), 'Company name', 200) or 'Task Controlling Management')
        result = save_user({**d, 'staff_id': staff_id, 'role_id': ADMIN_ROLE, 'active': 1}, staff_id)
        return public_user(User.objects.select_related('staff', 'role').get(id=result['id']))


def _attempt_open(attempt, now):
    return attempt is not None and now - attempt.window_start < ATTEMPT_WINDOW


def login(username, password, ip):
    now = timezone.now()
    normalized = username_key(username)[:200] if isinstance(username, str) else ''
    keys = {'pair': digest(f'{ip}:{normalized}'), 'account': digest(f'account:{normalized}'), 'address': digest(f'address:{ip}')}
    with transaction.atomic():
        for name, maximum in LIMITS:
            attempt = LoginAttempt.objects.filter(key=keys[name]).first()
            if _attempt_open(attempt, now) and attempt.failures >= maximum:
                fail('Too many unsuccessful attempts. Try again in 15 minutes.', 429)
        user = User.objects.select_related('staff', 'role').filter(username_key=normalized).first()
        supplied = password if isinstance(password, str) and len(password) <= 200 else ''
        verified = check_password(supplied, user.password if user else _DUMMY_HASH,
                                  setter=(lambda raw: _upgrade_hash(user, raw)) if user else None)
        if not user or not user.active or not verified:
            for key in (keys['pair'], keys['account'], keys['address']):
                attempt = LoginAttempt.objects.select_for_update().filter(key=key).first()
                if _attempt_open(attempt, now):
                    LoginAttempt.objects.filter(key=key).update(failures=attempt.failures + 1)
                elif attempt:
                    LoginAttempt.objects.filter(key=key).update(failures=1, window_start=now)
                else:
                    LoginAttempt.objects.create(key=key, failures=1, window_start=now)
            # Returning (not raising) commits the failure counters; login_or_fail then refuses the request.
            return None
        LoginAttempt.objects.filter(key__in=[keys['pair'], keys['account']]).delete()
        audit(user.staff_id, 'Signed in', user.id)
        return public_user(user)


def login_or_fail(username, password, ip):
    user = login(username, password, ip)
    if user is None:
        fail('Username or password is incorrect, or the account is disabled.', 401)
    return user


def _upgrade_hash(user, raw):
    """Re-hash a V5.7.x scrypt password with Django's default after a successful sign-in."""
    User.objects.filter(id=user.id).update(password=make_password(raw))


def start_session(user_id):
    now = timezone.now()
    AccessSession.objects.filter(expires_at__lt=now).delete()
    token = secrets.token_hex(32)
    AccessSession.objects.create(token_hash=digest(token), user_id=user_id,
                                 expires_at=now + timedelta(seconds=SESSION_SECONDS), created_at=now)
    return token


TOKEN = re.compile(r'^[a-f0-9]{64}$')


def token_from(request):
    token = request.COOKIES.get(getattr(request, 'session_cookie_name', 'sunny_session'), '')
    return token if TOKEN.match(token) else None


def resolve(request):
    token = token_from(request)
    if not token:
        return None
    session = (AccessSession.objects.select_related('user__staff', 'user__role')
               .filter(token_hash=digest(token), expires_at__gt=timezone.now()).first())
    if not session or not session.user.active:
        return None
    return session.user


def logout(request):
    token = token_from(request)
    if token:
        AccessSession.objects.filter(token_hash=digest(token)).delete()


def sign_out_everywhere(user, telegram=False):
    count = _end_sessions(user)
    if telegram:
        _unlink_telegram(user.staff_id, user.staff_id, 'signed out everywhere')
    audit(user.staff_id, 'Signed out of all devices', user.id, 'including Telegram' if telegram else '')
    return count


def status(request):
    user = resolve(request)
    setup = not User.objects.exists()
    company = Company.objects.filter(id=1).first()
    return {
        'setup_required': setup,
        'company_setup_required': setup and company is None,
        'user': public_user(user) if user else None,
        'company_name': company.name if company else 'Task Controlling Management',
        'staff': list(Staff.objects.filter(active=True).values('id', 'name')) if setup else [],
    }

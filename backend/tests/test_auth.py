"""Sign-in, setup and session behavior carried over from V5.7.7 (access.mjs, server.mjs)."""
import pytest
from django.utils import timezone

from accounts import services
from accounts.hashers import from_v57
from accounts.models import AccessSession, User
from core.models import Staff

from .conftest import ADMIN, Api

# Produced by V5.7.7's own code: scryptSync('Correct-horse-2026', salt, 64) stored as scrypt:<salt>:<hex>.
NODE_HASH = ('scrypt:ffe2512f66ba6de4d20cac61f96a7b31:0b2705e142dac01b24d276be4fa60a67c19a4f1cdca176900b208e64fa334ab2'
             'be6bd19f7a4119ee0b2470dc0b76ea34c8da2d1bc3722f6f60c0df7ef767f5bf')


def test_empty_installation_requires_setup(api):
    body = api.get('/api/auth/status').json()
    assert body['setup_required'] is True and body['company_setup_required'] is True
    assert body['user'] is None and body['company_id'] == 'default'


def test_setup_creates_first_administrator_with_company_cookie(api):
    response = api.post('/api/auth/setup', ADMIN)
    assert response.status_code == 200
    user = response.json()['user']
    assert user['role_id'] == 'ROLE-ADMIN' and user['username'] == 'Admin User' and user['staff_id'] == 'STAFF-000001'
    cookie = response.cookies['sunny_session_default']
    assert cookie['httponly'] and cookie['samesite'] == 'Strict' and cookie['path'] == '/c/default/'
    assert cookie['max-age'] == 28800
    status = api.get('/api/auth/status').json()
    assert status['setup_required'] is False and status['user']['id'] == user['id']
    assert status['company_name'] == 'Example Co'
    again = api.post('/api/auth/setup', {**ADMIN, 'username': 'Second'})
    assert again.status_code == 409 and again.json()['error'] == 'An administrator already exists. Sign in instead.'


def test_setup_is_refused_from_another_computer(db):
    response = Api(address='192.168.1.50').post('/api/auth/setup', ADMIN)
    assert response.status_code == 403
    assert not User.objects.exists()


def test_login_is_case_and_space_insensitive_and_wrong_password_is_refused(admin_api):
    other = Api()
    bad = other.post('/api/auth/login', {'username': 'Admin User', 'password': 'wrong-password-123'})
    assert bad.status_code == 401
    assert bad.json() == {'error': 'Username or password is incorrect, or the account is disabled.'}
    good = other.post('/api/auth/login', {'username': '  admin   USER ', 'password': ADMIN['password']})
    assert good.status_code == 200 and good.json()['user']['username'] == 'Admin User'
    assert other.get('/api/changes').status_code == 200


def test_failed_sign_ins_are_limited_per_address_and_username(admin_api):
    other = Api(address='10.0.0.7')
    for _ in range(10):
        assert other.post('/api/auth/login', {'username': 'Admin User', 'password': 'wrong-password-123'}).status_code == 401
    blocked = other.post('/api/auth/login', {'username': 'Admin User', 'password': ADMIN['password']})
    assert blocked.status_code == 429
    # A different address is not blocked yet (per-account limit is 20).
    assert Api(address='10.0.0.8').post('/api/auth/login', {'username': 'Admin User', 'password': ADMIN['password']}).status_code == 200


def test_logout_ends_the_session(admin_api):
    assert admin_api.get('/api/changes').status_code == 200
    assert admin_api.post('/api/auth/logout').status_code == 200
    response = admin_api.get('/api/changes')
    assert response.status_code == 401 and response.json() == {'error': 'Sign in to continue.'}


def test_expired_sessions_are_rejected(admin_api):
    AccessSession.objects.update(expires_at=timezone.now())
    assert admin_api.get('/api/changes').status_code == 401


def test_writes_require_the_apps_own_origin_and_json(admin_api):
    assert admin_api.post('/api/auth/logout', origin=None).status_code == 403
    assert admin_api.post('/api/auth/logout', origin='https://evil.example').status_code == 403
    assert admin_api.post('/api/auth/login', {'username': 'x'}, content_type='text/plain').status_code == 415


def test_other_company_ids_are_not_found(api):
    response = api.client.get('/c/company-other/api/auth/status')
    assert response.status_code == 404 and response.json() == {'error': 'Company not found.'}


def test_existing_v57_password_hashes_sign_in_and_are_upgraded(admin_api):
    user = User.objects.get(username='Admin User')
    User.objects.filter(id=user.id).update(password=from_v57(NODE_HASH))
    response = Api().post('/api/auth/login', {'username': 'Admin User', 'password': 'Correct-horse-2026'})
    assert response.status_code == 200
    assert not User.objects.get(id=user.id).password.startswith('node_scrypt$')


def test_last_active_administrator_cannot_be_demoted_or_disabled(admin_api):
    user = User.objects.get(username='Admin User')
    with pytest.raises(Exception) as error:
        from django.db import transaction
        with transaction.atomic():
            services.save_user({'id': user.id, 'expected_version': user.version, 'role_id': 'ROLE-VIEWER',
                                'username': 'Admin User'}, user.staff_id)
    assert getattr(error.value, 'status', None) == 409


def test_usernames_are_unique_and_role_changes_end_sessions(admin_api):
    from django.db import transaction
    admin = User.objects.get(username='Admin User')
    with transaction.atomic():
        created = services.save_user({'username': 'Sok Dara', 'password': 'Member-password-1', 'role_id': 'ROLE-MEMBER'},
                                     admin.staff_id)
    with pytest.raises(Exception) as duplicate:
        with transaction.atomic():
            services.save_user({'username': 'SOK  dara', 'password': 'Member-password-1', 'role_id': 'ROLE-MEMBER'},
                               admin.staff_id)
    assert duplicate.value.status == 409
    member = Api()
    assert member.post('/api/auth/login', {'username': 'Sok Dara', 'password': 'Member-password-1'}).status_code == 200
    user = User.objects.get(id=created['id'])
    with transaction.atomic():
        services.save_user({'id': user.id, 'expected_version': user.version, 'username': 'Sok Dara', 'role_id': 'ROLE-VIEWER'},
                           admin.staff_id)
    assert member.get('/api/changes').status_code == 401
    assert Staff.objects.get(id=user.staff_id).name == 'Sok Dara'

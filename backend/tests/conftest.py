import json

import pytest
from django.test import Client

ORIGIN = 'http://127.0.0.1:8000'
BASE = '/c/default'


class Api:
    """A browser-like client: same-origin Origin header, JSON bodies, company-scoped URLs and its own cookies."""

    def __init__(self, address='127.0.0.1'):
        self.client = Client(REMOTE_ADDR=address, HTTP_HOST='127.0.0.1:8000')

    def get(self, path, **extra):
        return self.client.get(BASE + path, **extra)

    def post(self, path, data=None, origin=ORIGIN, content_type='application/json', **extra):
        headers = {'HTTP_ORIGIN': origin} if origin else {}
        return self.client.post(BASE + path, data=json.dumps(data if data is not None else {}),
                                content_type=content_type, **headers, **extra)

    def command(self, action, data=None):
        return self.post('/api/command', {'action': action, 'data': data or {}})


ADMIN = {'username': 'Admin User', 'password': 'Admin-password-2026', 'email': 'admin@example.test',
         'company_name': 'Example Co'}


@pytest.fixture(autouse=True)
def migration_reference_data(request):
    """Transaction tests flush data-migration rows; restore the real migration seeds.

    This does not map any user or relax access rules. Tests that create an
    operational employee must still assign their organizational level explicitly.
    """
    if (request.node.get_closest_marker('django_db') or
            {'db', 'transactional_db'}.intersection(request.fixturenames)):
        request.getfixturevalue('db')
        from importlib import import_module
        from django.apps import apps
        for migration in ('accounts.migrations.0002_seed_defaults',
                          'organization.migrations.0004_seed_owner_template'):
            import_module(migration).seed(apps, None)


@pytest.fixture
def api(db):
    return Api()


@pytest.fixture
def admin_api(db):
    client = Api()
    response = client.post('/api/auth/setup', ADMIN)
    assert response.status_code == 200, response.content
    client.user = response.json()['user']
    return client


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    """Each test starts with full command allowances (the limiter is per process, like V5.7.7)."""
    from compat.commands import limiter
    limiter.buckets.clear()
    yield

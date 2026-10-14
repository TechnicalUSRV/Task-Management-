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

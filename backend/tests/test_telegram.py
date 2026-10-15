"""Telegram: settings, connect links and the Mini App gateway (launch data, media tokens, state, commands, reports)."""
import base64
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from telegram.gateway import check_media_token, media_token, sign_init_data, validate_init_data
from tests.conftest import Api

TOKEN = '123456789:AAEhBOweik9ai_k4Mn-WQs8xa1bq6fGwhQo'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='


def launch(user_id, first='Dara', age=0, token=TOKEN, chat_type='sender'):
    return sign_init_data({'auth_date': int(time.time()) - age, 'user': {'id': user_id, 'first_name': first}, 'chat_type': chat_type,
                           'query_id': 'AAHdF6IQAAAAAN0XohDhrOrc'}, token)


class MiniApp:
    def __init__(self, init):
        self.api, self.init = Api(), init

    def get(self, path):
        return self.api.client.get('/c/default/tg/api' + path, HTTP_AUTHORIZATION='tma ' + self.init)

    def post(self, path, body):
        return self.api.client.post('/c/default/tg/api' + path, data=json.dumps(body), content_type='application/json',
                                    HTTP_AUTHORIZATION='tma ' + self.init)


@pytest.fixture
def connected(admin_api):
    from telegram.models import TelegramSettings
    r = admin_api.command('admin.telegram.save', {'expected_version': 0, 'enabled': True, 'bot_token': TOKEN})
    assert r.status_code == 200, r.json()
    TelegramSettings.objects.filter(id=1).update(bot_username='sunny_test_bot', status='ON')
    created = admin_api.command('admin.user.save', {'name': 'Dara Member', 'role_id': 'ROLE-MEMBER', 'password': 'Dara-password-2026'}).json()['result']
    from accounts.models import User
    return admin_api, {'staff_id': User.objects.get(id=created['id']).staff_id}


def test_launch_data_is_checked_with_the_bot_token():
    init = launch(42)
    assert validate_init_data(init, TOKEN)['user']['id'] == 42
    assert validate_init_data(init, '987654321:' + 'x' * 35) is None
    assert validate_init_data(init.replace('Dara', 'Mara'), TOKEN) is None
    assert validate_init_data(launch(42, age=10 * 3600), TOKEN, max_age=8 * 3600) is None
    assert validate_init_data(launch(42, age=10 * 3600), TOKEN) is not None
    token = media_token('default', 42, TOKEN, bind='2026-10-15T00:00:00.000Z')
    assert check_media_token(token, 'default', TOKEN, bind='2026-10-15T00:00:00.000Z') == 42
    assert check_media_token(token, 'default', TOKEN, bind='2026-10-16T00:00:00.000Z') is None
    assert check_media_token(token, 'other', TOKEN, bind='2026-10-15T00:00:00.000Z') is None


@pytest.mark.skipif(not shutil.which('node') or not (Path(__file__).parent.parent.parent / 'source/local-test/telegram-gateway.mjs').exists(),
                    reason='Node.js and the V5.7.7 sources are needed')
def test_launch_data_and_media_tokens_match_v577():
    source = Path(__file__).parent.parent.parent / 'source/local-test/telegram-gateway.mjs'
    now = int(time.time())
    script = f"""
import {{signInitData,validateInitData,mediaToken,checkMediaToken}} from {json.dumps(source.as_uri())};
const init=signInitData({{auth_date:{now},user:{{id:77,first_name:'Sophea ក',username:'s_77'}},chat_type:'private',start_param:'x y'}},{json.dumps(TOKEN)});
console.log(JSON.stringify({{init,media:mediaToken('default',77,{json.dumps(TOKEN)},{now}*1000,'2026-10-15T00:00:00.000Z'),
 check:validateInitData(process.argv[1],{json.dumps(TOKEN)})?.user?.id??null,
 media_ok:checkMediaToken(process.argv[2],'default',{json.dumps(TOKEN)},Date.now(),'bind')}}));
"""
    ours = sign_init_data({'auth_date': now, 'user': {'id': 88, 'first_name': 'Dara'}, 'chat_type': 'sender'}, TOKEN)
    out = subprocess.run(['node', '--input-type=module', '--no-warnings', '-e', script, ours, media_token('default', 88, TOKEN, bind='bind')],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    theirs = json.loads(out.stdout)
    assert validate_init_data(theirs['init'], TOKEN)['user']['username'] == 's_77'
    assert theirs['check'] == 88 and theirs['media_ok'] == 88
    assert theirs['media'] == media_token('default', 77, TOKEN, now=now, bind='2026-10-15T00:00:00.000Z')


def test_mini_app_connect_state_command_and_report(connected):
    admin, member = connected
    dara = Api()
    assert dara.post('/api/auth/login', {'username': 'Dara Member', 'password': 'Dara-password-2026'}).status_code == 200
    code = dara.command('tg.link.code', {}).json()['result']
    assert code['link'] == f"https://t.me/sunny_test_bot?start=link_{code['code']}"
    app = MiniApp(launch(5550001))
    assert app.get('/state').json()['code'] == 'not_linked'
    assert app.post('/link', {'code': 'WRONG123'}).json()['code'] == 'code'
    linked = app.post('/link', {'code': code['code']})
    assert linked.status_code == 200 and linked.json() == {'ok': True, 'name': 'Dara Member'}
    assert app.post('/link', {'code': code['code']}).status_code == 400   # works once
    state = app.get('/state').json()
    assert state['auth']['user']['name'] == 'Dara Member' and state['company_context'] == {'id': 'default'}
    assert state['telegram'] == {'bot_username': 'sunny_test_bot', 'link': {'notify': True}}
    assert all(k.startswith('tasks.') for k in state['auth']['permissions'])
    ws = admin.command('tm.workspace.save', {'name': 'Field', 'owner_id': admin.user['staff_id'], 'member_ids': [member['staff_id']]}).json()['result']['id']
    from tasks.domain import add_days, task_today
    created = app.post('/command', {'action': 'tm.task.save', 'data': {'workspace_id': ws, 'title': 'Check the pump', 'description': 'Weekly check.',
                                                                         'start_date': task_today(), 'due_date': add_days(task_today(), 2), 'pic_id': member['staff_id'], 'status': 'IN_PROGRESS'}})
    assert created.status_code == 200, created.json()
    from tasks.models import Task, TaskHistory
    task = Task.objects.get(id=created.json()['result']['id'])
    assert task.source == 'MINIAPP' and TaskHistory.objects.get(task=task).source == 'MINIAPP'
    assert app.post('/command', {'action': 'admin.user.save', 'data': {}}).json() == {'error': 'This action is not available in the Telegram app.'}
    file = app.post('/command', {'action': 'tm.file.add', 'data': {'task_id': task.id, 'name': 'pump.png', 'base64': PNG}}).json()['result']
    token = app.get('/state').json()['media_token']
    got = app.api.client.get(f"/c/default/tg/api/file?t={token}&id={file['id']}&inline=1")
    assert got.status_code == 200 and got['Content-Type'] == 'image/png' and got.content == base64.b64decode(PNG)
    assert app.api.client.get(f"/c/default/tg/api/file?t=bad&id={file['id']}").json()['code'] == 'media'
    report = app.get('/report?report=monthly&scope=me').json()
    assert report['id'] == 'monthly' and report['rows'][0]['id'] == task.id
    assert app.get('/report?report=monthly&scope=all').status_code == 200
    assert app.get('/report?report=monthly&scope=team').json() == {'error': 'Unknown report scope.'}
    assert app.get('/changes').json()['seq'] >= 1
    # Signing out everywhere (with Telegram) ends the connection and its media links at once.
    assert dara.command('me.sessions.end', {'telegram': True}).status_code == 200
    assert app.get('/state').json()['code'] == 'not_linked'
    assert app.api.client.get(f"/c/default/tg/api/file?t={token}&id={file['id']}").status_code == 403


def test_mini_app_sign_in_and_expired_launch_data(connected):
    app = MiniApp(launch(5550002))
    assert app.post('/login', {'username': 'Dara Member', 'password': 'wrong-password-1'}).status_code == 401
    assert app.post('/login', {'username': 'Dara Member', 'password': 'Dara-password-2026'}).json() == {'ok': True, 'name': 'Dara Member'}
    from notifications.models import Notification
    assert Notification.objects.filter(kind='telegram_connected').count() == 1
    old = MiniApp(launch(5550002, age=9 * 3600))
    assert old.get('/state').json()['code'] == 'expired'
    assert MiniApp('nonsense').get('/state').json()['code'] == 'auth'
    assert Api().client.get('/tg/api/state').status_code == 404   # only under /c/<company>/tg/


def test_telegram_off_and_mini_app_page(admin_api, settings, tmp_path):
    assert MiniApp(launch(1)).get('/state').json() == {'error': 'Telegram is turned off for this company.', 'code': 'off'}
    settings.FRONTEND_DIR = tmp_path
    client = Api().client
    assert client.get('/c/default/tg/').status_code == 503
    (tmp_path / 'tg.html').write_text('<html>mini</html>')
    page = client.get('/c/default/tg/')
    assert page.status_code == 200 and b'mini' in page.content and 'telegram.org' in page['Content-Security-Policy']
    moved = client.get('/c/default/tg?x=1')
    assert moved.status_code == 308 and moved['Location'] == '/c/default/tg/?x=1'

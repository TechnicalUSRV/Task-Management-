"""Language changes never alter permissions or employee content."""
import concurrent.futures
from collections import Counter
import json
from pathlib import Path
import pytest
from django.utils import timezone
from accounts.models import User
from core.i18n import catalog, current_language, language, msg, notification_text, render, text
from notifications.models import Notification
from tests.conftest import Api, ADMIN
from tests.test_telegram import connected, MiniApp, launch, TOKEN


def test_default_fallback_and_opaque_parameters():
    assert current_language() == 'en'
    assert text('Save') == 'Save'
    for locale, expected in [('km', 'រក្សាទុក'), ('zh-CN', '保存')]:
        with language(locale):
            assert text('Save') == expected
            assert text('A future untranslated label') == 'A future untranslated label'
            assert render(msg('New task: {p0}', p0='Save កិច្ចការ 中文 <b>')) .endswith('Save កិច្ចការ 中文 <b>')
            assert render({'title': 'Save', 'description': 'New Task'}) == {'title': 'Save', 'description': 'New Task'}
    assert current_language() == 'en'
    with language('unsupported'):
        assert current_language() == 'en'


def test_thread_context_never_leaks_between_employees():
    def work(locale):
        with language(locale):
            return current_language(), text('Save')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        assert list(pool.map(work, ['km','zh-CN','en'])) == [('km','រក្សាទុក'),('zh-CN','保存'),('en','Save')]
    assert current_language() == 'en'


def test_catalog_placeholders_are_safe():
    import re
    source = json.loads((Path(__file__).resolve().parents[2]/'translations/en.json').read_text())
    for locale in ('km', 'zh-CN'):
        for key, value in catalog(locale).items():
            assert value and isinstance(value, str)
            assert Counter(re.findall(r'\{\w+\}', key)) == Counter(re.findall(r'\{\w+\}', value)), (locale, key)


def test_missing_placeholder_in_translation_falls_back(monkeypatch):
    from core import i18n
    monkeypatch.setattr(i18n, 'catalog', lambda locale: {'Hello {name}': 'សួស្តី'})
    assert i18n.text('Hello {name}', {'name': 'Save'}, 'km') == 'Hello Save'


def test_repeated_placeholder_falls_back(monkeypatch):
    from core import i18n
    monkeypatch.setattr(i18n, 'catalog', lambda locale: {'Hello {name}': 'សួស្តី {name} {name}'})
    assert i18n.text('Hello {name}', {'name': 'Save'}, 'km') == 'Hello Save'


def test_join_preserves_nested_recipient_language():
    from core.i18n import join_messages
    value = join_messages(' / ', [msg('Save'), msg('Delete')])
    assert render(value, 'zh-CN') == '保存 / 删除'
    assert str(value) == 'Save / Delete'


def test_protocol_headers_remain_canonical(admin_api):
    from telegram.gateway import CSP
    assert type(CSP) is str
    for locale in ('en', 'km', 'zh-CN'):
        admin_api.post('/api/me/language', {'language': locale})
        response = admin_api.get('/api/state')
        assert response.status_code == 200
        assert response['X-Account-Language'] == locale
        assert admin_api.post('/api/me/language', {'language': locale}, origin='https://other.invalid').status_code == 403


@pytest.mark.parametrize('locale,word', [('en','Language saved.'),('km','បានរក្សាទុកភាសា។'),('zh-CN','语言已保存。')])
def test_account_language_survives_refresh_and_sign_in(admin_api, locale, word):
    before = admin_api.get('/api/state').json()
    version = User.objects.get(pk=admin_api.user['id']).version
    saved = admin_api.post('/api/me/language', {'language':locale})
    assert saved.status_code == 200 and saved.json() == {'language':locale,'message':word}
    assert saved['X-Account-Language'] == locale
    after = admin_api.get('/api/state', HTTP_X_APP_LANGUAGE='en').json()
    assert after['auth']['user']['language'] == locale
    assert after['auth']['permissions'] == before['auth']['permissions']
    assert User.objects.get(pk=admin_api.user['id']).version == version
    other = Api()
    signed = other.post('/api/auth/login', {'username':ADMIN['username'],'password':ADMIN['password']})
    assert signed.status_code == 200 and signed.json()['user']['language'] == locale
    assert signed['Content-Language'] == locale
    assert other.get('/api/auth/status').json()['user']['language'] == locale


def test_preference_endpoint_is_own_account_only(admin_api):
    assert Api().post('/api/me/language', {'language':'km'}).status_code == 401
    assert admin_api.post('/api/me/language', {'language':'km'}, origin='https://other.invalid').status_code == 403
    for data in ({'language':'fr'}, {'language':None},{'language':'km','user_id':'someone-else'},{}):
        assert admin_api.post('/api/me/language', data).status_code == 400
    assert User.objects.get(pk=admin_api.user['id']).language == 'en'


def test_website_and_mini_app_share_one_account_preference(connected):
    admin, member = connected
    web = Api()
    assert web.post('/api/auth/login', {'username':'Dara Member','password':'Dara-password-2026'}).status_code == 200
    app = MiniApp(launch(6000001))
    assert app.post('/login', {'username':'Dara Member','password':'Dara-password-2026'}).status_code == 200
    assert web.post('/api/me/language', {'language':'km'}).status_code == 200
    mini = app.get('/state')
    assert mini.json()['auth']['user']['language'] == 'km'
    assert mini['X-Account-Language'] == 'km'
    assert app.post('/language', {'language':'zh-CN'}).json()['message'] == '语言已保存。'
    assert web.get('/api/me/language').json()['language'] == 'zh-CN'
    assert MiniApp(launch(6000001)).get('/state').json()['auth']['user']['language'] == 'zh-CN'
    assert app.post('/language', {'language':'km', 'staff_id':admin.user['staff_id']}).status_code == 400
    assert User.objects.get(pk=admin.user['id']).language == 'en'


def test_unmapped_employee_can_change_language_without_gaining_scope(connected):
    _, member=connected
    from organization.models import Profile
    Profile.objects.filter(staff_id=member['staff_id']).update(org_level_id=None)
    app=MiniApp(launch(6000002))
    app.post('/login', {'username':'Dara Member','password':'Dara-password-2026'})
    before=app.get('/state').json()
    assert app.post('/language', {'language':'km'}).status_code==200
    after=app.get('/state').json()
    assert after['operational_access'] == before['operational_access'] == False
    assert after['tm_tasks'] == before['tm_tasks'] == []
    assert after['auth']['permissions'] == before['auth']['permissions']


def test_persisted_notification_uses_recipient_language_and_preserves_content(connected):
    admin,member=connected
    title='Save / ភាសាខ្មែរ / 中文 <tag>'
    n=Notification.objects.create(staff_id=member['staff_id'], kind='task_assigned', title=msg('New task: {p0}',p0=title),body='Employee wrote: Save',created_at=timezone.now())
    n.refresh_from_db()
    original=n.title
    record={'title':n.title,'body':n.body,'translation':n.translation}
    assert original=='New task: '+title
    for locale in ('km','zh-CN'):
        value=notification_text(record,locale)
        assert value['title']==text('New task: {p0}',{'p0':title},locale)
        assert value['title']!=original
        assert value['body']=='Employee wrote: Save'
    assert notification_text({'title':'Save','body':'User text'},'km')['title']=='Save'


def test_bot_uses_recipient_language_at_send_time(connected):
    from telegram.bot import Bot
    from core.rows import row
    admin,member=connected
    app=MiniApp(launch(6000003))
    app.post('/login',{'username':'Dara Member','password':'Dara-password-2026'})
    # Ensure private chat is available without contacting Telegram.
    from telegram.models import TelegramLink
    TelegramLink.objects.filter(staff_id=member['staff_id']).update(chat_id=6000003)
    n=Notification.objects.create(staff_id=member['staff_id'],kind='test',title=msg('New task: {p0}',p0='Save <one>'),body='Original body',created_at=timezone.now())
    calls=[]
    bot=Bot(TOKEN,transport={'call':lambda method,params,timeout:calls.append((method,params)) or {'message_id':1}})
    for locale in ('km','zh-CN'):
        User.objects.filter(staff_id=member['staff_id']).update(language=locale)
        bot.deliver(row(n))
        output=calls[-1][1]['text']
        assert text('New task: {p0}',{'p0':'Save &lt;one&gt;'},locale) in output
        assert 'Original body' in output
    assert current_language()=='en'


def test_private_bot_menus_follow_account_and_cache(connected):
    from telegram.bot import Bot, PRIVATE_COMMANDS, TelegramError
    from telegram.models import TelegramLink
    _, member = connected
    app = MiniApp(launch(6000010))
    assert app.post('/login', {'username': 'Dara Member', 'password': 'Dara-password-2026'}).status_code == 200
    TelegramLink.objects.filter(staff_id=member['staff_id']).update(chat_id=6000010)
    calls = []
    bot = Bot(TOKEN, app_url=lambda: 'https://example.test/c/default/tg/',
              transport={'call': lambda method, params, timeout: calls.append((method, params)) or True})
    for locale in ('en', 'km', 'zh-CN'):
        User.objects.filter(staff_id=member['staff_id']).update(language=locale)
        bot.refresh_menu()
        commands = next(p for method, p in reversed(calls) if method == 'setMyCommands')
        assert commands['scope'] == {'type': 'chat', 'chat_id': 6000010}
        assert [c['command'] for c in commands['commands']] == [c for c, _ in PRIVATE_COMMANDS]
        assert commands['commands'][0]['description'] == render(PRIVATE_COMMANDS[0][1], locale)
        assert calls[-1][1]['menu_button']['text'] == text('Tasks', locale=locale)
        count = len(calls)
        bot.refresh_menu()
        assert len(calls) == count
    # A transport failure does not mark the new preference as installed or busy-loop.
    User.objects.filter(staff_id=member['staff_id']).update(language='en')
    def fail(method, params, timeout):
        calls.append((method, params))
        raise TelegramError('Temporary failure', code=500)
    bot.transport = {'call': fail}
    bot.refresh_menu()
    assert bot.private_menus[6000010][0] == 'zh-CN'
    count = len(calls)
    bot.refresh_menu()
    assert len(calls) == count

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
            tags = lambda source: Counter(re.findall(r'</?(?:b|i|u|s|code|pre|a)(?:\s+[^>]*)?>', source))
            assert tags(key) == tags(value), (locale, key, 'HTML markup changed')


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


def test_dates_and_reminder_offsets_stay_lazy_until_delivery():
    from core.i18n import pack, unpack
    from tasks import domain as dm
    from meetings.services import offset_text
    values = [dm.human('2026-10-23'), dm.at_text('2026-10-23T04:00:00Z', 'Asia/Phnom_Penh'),
              dm.month_label('2026-10'), dm.reminder_text([7, 1]),
              *[offset_text(n) for n in (0, 1, 5, 60, 120, 1440, 2880)]]
    assert list(map(str, values)) == ['Fri, 23 Oct 2026', 'Fri 23 Oct, 11:00', 'October 2026',
                                    '7 and 1 days before the due date', 'at the start',
                                    '1 minute before', '5 minutes before', '1 hour before',
                                    '2 hours before', '1 day before', '2 days before']
    for locale in ('km', 'zh-CN'):
        for value in values:
            restored = unpack(json.loads(json.dumps(pack(value))))
            assert render(restored, locale) != str(value)
            assert render(restored, locale) == render(value, locale)
        assert ' and ' not in render(values[3], locale)


def test_scheduled_task_and_meeting_reminders_preserve_recipient_language(connected):
    from datetime import datetime, timedelta, timezone as tz
    from core.rows import row
    from meetings.models import Meeting, MeetingAttendee, CalendarNote
    from meetings.services import MeetingService
    from organization.governance import Governance
    from tasks.services import TaskService
    from tasks import domain as dm
    admin, member = connected
    me, other = admin.user['staff_id'], member['staff_id']
    ws = admin.command('tm.workspace.save', {'name': 'Reminders', 'owner_id': me,
                                            'member_ids': [other]}).json()['result']['id']
    at = datetime.now(tz.utc).replace(hour=4, minute=0, second=0, microsecond=0)
    title = 'Save · កិច្ចការ · 中文 <keep>'
    response = admin.command('tm.task.save', {'workspace_id': ws, 'title': title,
        'start_date': dm.task_today(), 'due_date': dm.add_days(dm.local_day(at), 1),
        'pic_id': other, 'description': 'Keep employee wording', 'reminder_days': [1]})
    assert response.status_code == 200, response.json()
    task = response.json()['result']['id']
    tasks = TaskService(Governance())
    assert tasks.due_reminders(at) >= 1
    assert tasks.due_reminders(at) == 0
    start = at + timedelta(minutes=5)
    meeting = Meeting.objects.create(id='language-meeting', workspace_id=ws, organizer_id=me,
        title=title, start_at=start, end_at=start + timedelta(hours=1), status='SCHEDULED',
        reminder_offsets='[5]', created_at=at, updated_at=at, location='Save room', url='https://example.test')
    MeetingAttendee.objects.create(meeting=meeting, staff_id=other)
    CalendarNote.objects.create(id='language-note', staff_id=other, title=title, body='Save user note',
        all_day=False, day=start.date(), start_at=start, end_at=start + timedelta(hours=1),
        reminder_offsets='[5]', created_at=at, updated_at=at)
    meetings = MeetingService(tasks)
    assert meetings.event_reminders(at) == 3
    assert meetings.event_reminders(at) == 0
    notices = Notification.objects.filter(kind__in=['task_due_soon', 'meeting_reminder', 'note_reminder'])
    assert notices.filter(task_id=task).exists()
    for notice in notices:
        assert {'title', 'body'} <= notice.translation.keys()
        for locale in ('km', 'zh-CN'):
            output = notification_text(row(notice), locale)
            assert title in output['title']
            assert output['title'] != notice.title
            assert output['body'] != notice.body
            assert 'Fri' not in output['body']
            if notice.kind == 'meeting_reminder':
                assert 'Save room' in output['body'] and 'online' not in output['body']
            if notice.kind == 'note_reminder':
                assert 'Save user note' in output['body']


@pytest.mark.parametrize('locale', ['km', 'zh-CN'])
def test_validation_errors_translate_code_owned_field_labels(admin_api, locale):
    assert admin_api.post('/api/me/language', {'language': locale}).status_code == 200
    response = admin_api.command('tm.workspace.save', {'name': '', 'owner_id': admin_api.user['staff_id']})
    assert response.status_code == 400
    expected = text('{p0} is required.', {'p0': msg('Workspace name')}, locale)
    assert response.json()['error'] == expected
    assert 'Workspace name' not in expected
    # The label translates; a submitted name that happens to match a UI key does not.
    result = admin_api.command('tm.workspace.save', {'name': 'Save', 'owner_id': admin_api.user['staff_id']})
    assert result.status_code == 200, result.json()
    from workspaces.models import Workspace
    assert Workspace.objects.get(pk=result.json()['result']['id']).name == 'Save'


def test_translated_bot_connection_help_preserves_commands_and_paragraphs():
    from telegram.bot import link_help
    for locale in ('en', 'km', 'zh-CN'):
        with language(locale):
            output = link_help(True)
            assert '<code>/link CODE</code>' in output
            assert '\n\n' in output and r'\n' not in output
            assert output.count('<b>') == output.count('</b>') == 3
            if locale == 'en':
                assert 'username and password' in output and 'email and password' not in output
            else:
                assert 'To use me' not in output and 'Your personal link' not in output

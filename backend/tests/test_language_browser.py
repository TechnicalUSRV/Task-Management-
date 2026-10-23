"""Real Django/React language evidence; signed Mini App launch, no live Telegram calls."""
import json
from pathlib import Path
from urllib.parse import quote
import pytest
from playwright.sync_api import expect
from accounts.models import User
from core.i18n import text
from tasks.domain import task_today, add_days
from tests.conftest import ADMIN
from tests.test_browser_acceptance import browser
from tests.test_telegram import connected, launch, MiniApp

EVIDENCE = Path(__file__).resolve().parents[2] / 'docs/language-support/screenshots'
TITLE = 'Warehouse check · ពិនិត្យឃ្លាំង · 仓库检查'


def capture(page, name):
    page.evaluate('document.fonts.ready')
    locale = page.locator('html').get_attribute('lang')
    if locale in ('km', 'zh-CN'):
        family = 'Noto Sans Khmer Variable' if locale == 'km' else 'Noto Sans SC Variable'
        assert family in page.locator('body').evaluate('(el) => getComputedStyle(el).fontFamily')
        faces = page.evaluate("""family => document.fonts.load('16px "' + family + '"').then(faces => faces.length)""", family)
        assert faces > 0
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2')
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(EVIDENCE / (name + '.png')), full_page=True, animations='disabled')


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('locale', ['en', 'km', 'zh-CN'])
def test_web_and_mini_app_language(live_server, browser, connected, settings, locale):
    admin, _ = connected
    settings.TRUSTED_ORIGINS = [*settings.TRUSTED_ORIGINS, live_server.url]
    me = admin.user['staff_id']
    workspace = admin.command('tm.workspace.save', {'name': 'Operations · ប្រតិបត្តិការ · 运营', 'owner_id': me, 'member_ids': []})
    assert workspace.status_code == 200, workspace.content
    wid = workspace.json()['result']['id']
    task = admin.command('tm.task.save', {'workspace_id': wid, 'title': TITLE, 'description': 'Employee content: Save / រក្សាទុក / 保存',
                                         'pic_id': me, 'start_date': task_today(), 'due_date': add_days(task_today(), 5)})
    assert task.status_code == 200, task.content
    init = launch(7000001)
    assert MiniApp(init).post('/login', ADMIN).status_code == 200
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(live_server.url + '/TaskManagement')
    page.get_by_role('textbox', name='Username').fill(ADMIN['username'])
    page.locator('input[type=password]').fill(ADMIN['password'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.locator('.user-trigger').click()
    page.get_by_role('menuitem', name='My profile').click()
    nickname = page.get_by_role('textbox', name='Nickname')
    nickname.fill('Unsaved · មិនទាន់រក្សាទុក · 未保存')
    nickname = page.locator('[id=' + json.dumps(nickname.get_attribute('id')) + ']')
    selector = page.locator('.language-setting select')
    selector.select_option(locale)
    expect(page.locator('html')).to_have_attribute('lang', locale)
    expect(selector).to_be_enabled()
    assert nickname.input_value() == 'Unsaved · មិនទាន់រក្សាទុក · 未保存'
    assert User.objects.get(pk=admin.user['id']).language == locale
    capture(page, locale + '-web-profile')
    page.keyboard.press('Escape')
    page.goto(live_server.url + '/TaskManagement#/tasks/tasks')
    page.get_by_text(TITLE, exact=True).first.wait_for()
    capture(page, locale + '-web-tasks')
    page.get_by_role('button', name=text('New task', locale=locale), exact=True).first.click()
    page.get_by_role('dialog').wait_for()
    capture(page, locale + '-web-task-form')

    mobile = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    mobile.set_default_timeout(15000)
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    bridge = 'window.Telegram={WebApp:{initData:' + json.dumps(init) + ',platform:"android",colorScheme:"light",ready(){},expand(){},onEvent(){},offEvent(){},isVersionAtLeast(){return false}}};'
    mobile.route('https://telegram.org/js/telegram-web-app.js*', lambda route: route.fulfill(status=200, content_type='application/javascript', body=bridge))
    mobile.goto(live_server.url + '/c/default/tg/#tgWebAppData=' + quote(init))
    expect(mobile.locator('html')).to_have_attribute('lang', locale)
    mobile.get_by_role('button', name=text('My profile and settings', locale=locale)).wait_for()
    if locale == 'km':
        # Chromium may omit Khmer ICU data: the app must still localize date words.
        heading = mobile.locator('.hero-text > p.hint').last.inner_text()
        import re
        assert not re.search(r'\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', heading)
    capture(mobile, locale + '-mini-home')
    mobile.get_by_role('button', name=text('My profile and settings', locale=locale)).click()
    mobile.locator('.language-setting select').wait_for()
    capture(mobile, locale + '-mini-settings')
    next_locale = {'en': 'km', 'km': 'zh-CN', 'zh-CN': 'en'}[locale]
    mobile.locator('.language-setting select').select_option(next_locale)
    expect(mobile.locator('html')).to_have_attribute('lang', next_locale)
    expect(mobile.locator('.language-setting select')).to_be_enabled()
    assert User.objects.get(pk=admin.user['id']).language == next_locale
    page.reload()
    expect(page.locator('html')).to_have_attribute('lang', next_locale)
    assert errors == []
    page.close()
    mobile.close()

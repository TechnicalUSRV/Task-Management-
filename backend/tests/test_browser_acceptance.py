"""The acceptance flow in a real browser: the built React app, served by Django, used the way people use it.

Create the administrator → create a user → create a workspace with that user → create a task for them → edit it
(sent for approval) → the user signs in, accepts the task and approves the change → the stored rows match.
Needs the built frontend (npm run build in source/) and Python Playwright with Chromium; skipped otherwise.
"""
import pytest
from django.conf import settings

playwright = pytest.importorskip('playwright.sync_api')
pytestmark = pytest.mark.skipif(not (settings.FRONTEND_DIR / 'index.html').exists(), reason='Build the frontend first (npm run build).')

ADMIN, ADMIN_PASSWORD = 'Vanna Admin', 'Admin-password-2026'
MEMBER, MEMBER_PASSWORD = 'Dara Member', 'Dara-password-2026'


@pytest.fixture
def browser(monkeypatch):
    # Playwright's sync API keeps an event loop in this thread; the test's own database reads are still synchronous.
    monkeypatch.setenv('DJANGO_ALLOW_ASYNC_UNSAFE', 'true')
    with playwright.sync_playwright() as pw:
        try:
            b = pw.chromium.launch(args=['--no-sandbox'])
        except Exception as e:   # noqa: BLE001
            pytest.skip(f'Chromium is not available: {e}')
        yield b
        b.close()


def open_page(browser, url):
    page = browser.new_context(viewport={'width': 1440, 'height': 960}).new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    return page, errors


def sign_in(browser, base, user, password):
    page, errors = open_page(browser, base)
    page.get_by_role('heading', name='Sign in').wait_for()
    page.get_by_role('textbox', name='Username').fill(user)
    page.locator('input[type=password]').fill(password)
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('link', name='Task Management').wait_for()
    return page, errors


def toast(page, text):
    page.locator('[data-sonner-toast]').filter(has_text=text).first.wait_for()


def test_people_workspace_and_task_through_the_app(live_server, browser, settings):
    from accounts.models import User
    from tasks.models import Task, TaskChangeRequest
    from workspaces.models import Workspace, WorkspaceMember
    settings.TRUSTED_ORIGINS = [*settings.TRUSTED_ORIGINS, live_server.url]
    base = live_server.url + '/TaskManagement'

    page, errors = open_page(browser, base)
    assert page.request.get(live_server.url + '/c/default/').status == 404
    page.get_by_role('heading', name='Create the administrator').wait_for()
    page.get_by_role('textbox', name='Username').fill(ADMIN)
    page.locator('input[type=password]').nth(0).fill(ADMIN_PASSWORD)
    page.locator('input[type=password]').nth(1).fill(ADMIN_PASSWORD)
    page.get_by_role('button', name='Create administrator & sign in').click()
    page.get_by_role('link', name='Administration').click()

    page.get_by_role('button', name='Create user').click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('textbox', name='Username').fill(MEMBER)
    dialog.get_by_role('textbox', name='Position').fill('Stock controller')
    dialog.get_by_role('textbox', name='Department').fill('Warehouse')
    dialog.locator('input[type=password]').fill(MEMBER_PASSWORD)
    dialog.get_by_role('button', name='Create account').click()
    toast(page, 'Saved')

    page.get_by_role('link', name='Task Management').click()
    page.get_by_role('button', name='New workspace').click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('textbox', name='Workspace name').fill('Warehouse')
    dialog.get_by_role('textbox', name='Department').fill('Operations')
    dialog.get_by_role('button', name='Add a member').click()
    page.get_by_role('option', name=MEMBER).first.click()
    dialog.get_by_role('button', name='Create workspace').click()
    toast(page, 'Saved')

    page.get_by_role('button', name='View tasks').click()
    page.get_by_role('button', name='New task').first.click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('textbox', name='Task title').fill('Count the main store')
    dialog.get_by_role('textbox', name='Expectation').fill('Every shelf counted and reconciled with the system.')
    dialog.get_by_role('button', name='Vanna Admin (you)').first.click()
    page.get_by_role('option', name=MEMBER).first.click()
    dialog.get_by_role('button', name='Create task').click()
    toast(page, 'Task created.')
    page.get_by_role('button', name='Edit details').click()
    edit = page.get_by_role('dialog').last
    edit.get_by_role('textbox', name='Task title').fill('Count the main store, aisles 1 to 8')
    edit.get_by_role('button', name='Send for approval').click()
    toast(page, 'Sent to Dara Member for approval')

    member, member_errors = sign_in(browser, base, MEMBER, MEMBER_PASSWORD)
    member.get_by_role('link', name='Task Management').click()
    member.get_by_role('link', name='Tasks').click()
    member.get_by_text('Count the main store').first.click()
    member.get_by_role('dialog').get_by_role('button', name='Accept').first.click()
    toast(member, 'Task accepted')
    member.get_by_role('dialog').get_by_role('button', name='Approve').first.click()
    member.get_by_role('alertdialog').get_by_role('button', name='Approve').click()
    toast(member, 'Approved. The change is applied.')

    dara = User.objects.get(username=MEMBER)
    ws = Workspace.objects.get(name='Warehouse')
    assert set(WorkspaceMember.objects.filter(workspace=ws).values_list('staff_id', flat=True)) == {dara.staff_id, ws.owner_id}
    task = Task.objects.get(workspace=ws)
    assert (task.title, task.status, task.pic_id) == ('Count the main store, aisles 1 to 8', 'IN_PROGRESS', dara.staff_id)
    assert TaskChangeRequest.objects.get(task=task).status == 'APPROVED'
    assert errors == [] and member_errors == []

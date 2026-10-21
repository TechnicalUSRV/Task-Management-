"""Task approval counts distinct people, not roles.

A task one person runs alone (creator = person in charge = reviewer) changes directly, with its history; a task with
another responsible person keeps the two-party approval, and a change is never applied without the other person's
approval when that person is required (also when they are unavailable). The same command API serves the web app and
the Telegram Mini App.
"""
import pytest

from accounts.models import User
from tasks.domain import add_days, task_today
from tasks.models import Task, TaskChangeRequest, TaskHistory
from tests.conftest import Api
from tests.test_groups_and_previews import login, ok


@pytest.fixture
def people(admin_api):
    def user(name):
        r = admin_api.command('admin.user.save', {'name': name, 'role_id': 'ROLE-MEMBER', 'password': name.split()[0] + '-password-2026'})
        assert r.status_code == 200, r.json()
        staff = User.objects.get(id=r.json()['result']['id']).staff_id
        from organization.models import Profile
        Profile.objects.filter(staff_id=staff).update(org_level_id=3)  # operational fixture, explicitly mapped
        return staff
    ids = {'a': user('Anan Single'), 'b': user('Bopha Other')}
    ws = ok(admin_api.command('tm.workspace.save', {'name': 'Approvals', 'owner_id': admin_api.user['staff_id'], 'member_ids': list(ids.values())}))['result']['id']
    clients = {'a': login('Anan Single', 'Anan-password-2026'), 'b': login('Bopha Other', 'Bopha-password-2026')}
    return admin_api, ids, clients, ws


def new_task(client, ws, pic, reviewer=None, title='Prepare the stock report'):
    data = {'workspace_id': ws, 'title': title, 'description': 'The report is complete.', 'start_date': task_today(),
            'due_date': add_days(task_today(), 5), 'pic_id': pic}
    if reviewer:
        data['reviewer_id'] = reviewer
    return ok(client.command('tm.task.save', data))['result']['id']


def edit(client, task, **changes):
    t = Task.objects.get(id=task)
    data = {'id': task, 'expected_version': t.version, 'workspace_id': t.workspace_id, 'title': t.title, 'description': t.description,
            'start_date': str(t.start_date), 'due_date': str(t.due_date), 'pic_id': t.pic_id, 'reviewer_id': t.reviewer_id, **changes}
    return client.command('tm.task.save', data)


def test_one_person_holding_every_role_edits_and_closes_without_self_approval(people):
    _, ids, c, ws = people
    a = c['a']
    task = new_task(a, ws, ids['a'])
    t = Task.objects.get(id=task)
    assert (t.created_by_id, t.pic_id, t.reviewer_id) == (ids['a'], ids['a'], ids['a'])
    before = t.version
    # Title and expectation are saved at once: no pending change, no "remains unchanged until approved".
    r = ok(edit(a, task, title='Prepare the monthly stock report', description='All branches are counted.'))['result']
    assert r['message'] == 'Task saved.' and 'change_id' not in r
    t = Task.objects.get(id=task)
    assert (t.title, t.description, t.version) == ('Prepare the monthly stock report', 'All branches are counted.', before + 1)
    assert not TaskChangeRequest.objects.filter(task_id=task).exists()
    # The history keeps who changed what.
    h = TaskHistory.objects.filter(task_id=task, kind='edit').order_by('-id').first()
    assert h.actor_id == ids['a'] and 'title' in h.note.lower()
    # Progress, completion and cancelling are direct too (they were already; checked so nothing regresses).
    assert ok(a.command('tm.task.progress', {'id': task, 'progress': 40, 'expected_version': Task.objects.get(id=task).version}))
    assert Task.objects.get(id=task).progress == 40
    assert ok(a.command('tm.task.close', {'id': task, 'expected_version': Task.objects.get(id=task).version}))
    assert Task.objects.get(id=task).status == 'COMPLETED'
    other = new_task(a, ws, ids['a'], title='Second solo task')
    assert ok(a.command('tm.task.cancel', {'id': other, 'reason': 'Not needed', 'expected_version': Task.objects.get(id=other).version}))
    assert Task.objects.get(id=other).status == 'CANCELLED'
    assert not TaskChangeRequest.objects.filter(task_id__in=[task, other]).exists()


def test_tasks_with_another_responsible_person_still_need_their_approval(people):
    _, ids, c, ws = people
    a, b = c['a'], c['b']
    # A assigns the task to B; once B accepts, either side's change waits for the other.
    task = new_task(a, ws, ids['b'], title='Deliver to the north branch')
    ok(b.command('tm.task.accept', {'id': task, 'expected_version': Task.objects.get(id=task).version}))
    r = ok(edit(a, task, title='Deliver to the south branch'))['result']
    assert r.get('change_id') and 'Nothing changes until they approve' in r['message']
    assert Task.objects.get(id=task).title == 'Deliver to the north branch'
    cr = TaskChangeRequest.objects.get(id=r['change_id'])
    assert (cr.approver_id, cr.status) == (ids['b'], 'PENDING')
    # A personal task with another person as its reviewer: the reviewer approves detail changes.
    reviewed = new_task(a, ws, ids['a'], reviewer=ids['b'], title='Reviewed by Bopha')
    r = ok(edit(a, reviewed, title='Reviewed by Bopha, renamed'))['result']
    assert r.get('change_id') and TaskChangeRequest.objects.get(id=r['change_id']).approver_id == ids['b']
    assert Task.objects.get(id=reviewed).title == 'Reviewed by Bopha'


def test_a_required_approver_who_is_unavailable_still_blocks_the_change(people):
    admin, ids, c, ws = people
    a = c['a']
    reviewed = new_task(a, ws, ids['a'], reviewer=ids['b'], title='Needs Bopha')
    user = User.objects.get(staff_id=ids['b'])
    ok(admin.command('admin.user.disable', {'id': user.id, 'expected_version': user.version, 'reason': 'Left the team'}))
    r = edit(a, reviewed, title='Changed without Bopha')
    assert r.status_code == 409 and 'remains unchanged until approved' in r.json()['error']
    assert Task.objects.get(id=reviewed).title == 'Needs Bopha'
    assert not TaskChangeRequest.objects.filter(task_id=reviewed).exists()


def test_the_mini_app_applies_the_same_rule(people):
    from telegram.models import TelegramSettings
    from tests.test_telegram import TOKEN, MiniApp, launch
    admin, ids, c, ws = people
    assert admin.command('admin.telegram.save', {'expected_version': 0, 'enabled': True, 'bot_token': TOKEN}).status_code == 200
    TelegramSettings.objects.filter(id=1).update(bot_username='sunny_test_bot', status='ON')
    code = ok(c['a'].command('tg.link.code', {}))['result']['code']
    app = MiniApp(launch(5550101, 'Anan'))
    assert app.post('/link', {'code': code}).status_code == 200
    task = new_task(c['a'], ws, ids['a'], title='Solo from the phone')
    t = Task.objects.get(id=task)
    r = app.post('/command', {'action': 'tm.task.save', 'data': {'id': task, 'expected_version': t.version, 'workspace_id': ws, 'title': 'Solo, renamed on the phone',
                                                                 'description': t.description, 'start_date': str(t.start_date), 'due_date': str(t.due_date),
                                                                 'pic_id': ids['a'], 'reviewer_id': ids['a']}})
    assert r.status_code == 200, r.content
    assert Task.objects.get(id=task).title == 'Solo, renamed on the phone'
    assert not TaskChangeRequest.objects.filter(task_id=task).exists()

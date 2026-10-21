"""REST resource endpoints: the same permissions and record scope as the app state; IDs outside the scope are not found."""
from accounts.models import User

from .conftest import Api

PASSWORD = 'Member-password-2026'


def member(admin_api, name, role='ROLE-MEMBER'):
    r = admin_api.command('admin.user.save', {'username': name, 'password': PASSWORD, 'role_id': role, 'active': 1}).json()['result']
    staff = User.objects.get(id=r['id']).staff_id
    from organization.models import Profile
    Profile.objects.filter(staff_id=staff).update(org_level_id=3)
    client = Api()
    assert client.post('/api/auth/login', {'username': name, 'password': PASSWORD}).status_code == 200
    return staff, client


def test_resources_follow_permissions_and_scope(admin_api):
    dara, dara_api = member(admin_api, 'Dara Member')
    kosal, kosal_api = member(admin_api, 'Kosal Member')
    neary, neary_api = member(admin_api, 'Neary Viewer', 'ROLE-VIEWER')
    me = admin_api.user['staff_id']
    ws = admin_api.command('tm.workspace.save', {'name': 'Warehouse', 'owner_id': me, 'member_ids': [me, dara]}).json()['result']['id']
    task = admin_api.command('tm.task.save', {'workspace_id': ws, 'title': 'Count the main store', 'description': 'Every shelf counted.',
                                              'start_date': '2026-10-15', 'due_date': '2026-10-20', 'pic_id': dara}).json()['result']['id']

    index = dara_api.get('/api/v1/').json()
    assert 'tasks' in index['resources'] and index['resources']['tasks'] == '/c/default/api/v1/tasks/'

    mine = dara_api.get('/api/v1/tasks/').json()
    assert mine['count'] == 1 and mine['results'][0]['id'] == task
    detail = dara_api.get(f'/api/v1/tasks/{task}/').json()
    assert detail['title'] == 'Count the main store' and [a['staff_id'] for a in detail['assignees']] == [dara]
    assert dara_api.get('/api/v1/tasks/?status=AWAITING').json()['count'] == 0
    assert dara_api.get('/api/v1/tasks/?q=main+store').json()['count'] == 1
    assert dara_api.get(f'/api/v1/task-history/?task_id={task}').json()['count'] >= 1

    # Kosal is not on the task or in the workspace: the ID is "not found", lists are empty.
    assert kosal_api.get(f'/api/v1/tasks/{task}/').status_code == 404
    assert kosal_api.get('/api/v1/tasks/').json()['count'] == 0
    assert kosal_api.get(f'/api/v1/task-history/?task_id={task}').json()['count'] == 0
    assert kosal_api.get(f'/api/v1/workspaces/{ws}/').status_code in (403, 404)

    ws_detail = admin_api.get(f'/api/v1/workspaces/{ws}/').json()
    assert sorted(ws_detail['member_ids']) == sorted([me, dara])
    assert admin_api.get('/api/v1/users/?q=dara').json()['results'][0]['staff_id'] == dara

    # Paging and validation.
    page = admin_api.get('/api/v1/users/?page_size=2&page=2').json()
    assert (page['count'], page['page'], page['page_size'], len(page['results'])) == (4, 2, 2, 2)
    assert admin_api.get('/api/v1/users/?page_size=500').status_code == 400
    assert admin_api.get('/api/v1/nothing/').status_code == 404

    # Without sign-in, nothing.
    assert Api().get('/api/v1/tasks/').status_code == 401
    assert neary_api.get('/api/v1/timesheets/').status_code in (200, 403)
    # Read-only: writes are refused here (changes go through /api/command).
    assert dara_api.post(f'/api/v1/tasks/{task}/', {'title': 'Renamed'}).status_code == 405

"""Several reporting managers and explicitly selected responsible managers (requirement 2), through the HTTP API.

Structure:  R = Level 1 (Administrator role);  B, C = Level 2, both report to R;  A = Level 3, reports to B (primary)
and to C (additional line);  D = Level 3 under C;  E = Level 4 under A.

Checked for every rule: the workspace list (/api/state), direct IDs (/api/v1), tasks, reports, the Mini App state,
Groups and the Organizational Structure screens. Existing workspaces keep their previous visibility (no broadening when
a second manager is added), and a manager who is not selected gets nothing from supervising the owner.
"""
import pytest

from accounts.models import User
from core.rows import row
from organization.governance import Governance
from organization.models import OrgAudit, OrgSettings, ReportingLine
from tasks.domain import add_days, task_today
from workspaces.models import Workspace, WorkspaceManager, WorkspaceMember

from .conftest import Api

PASSWORD = 'Scope-test-2026'


def rev():
    return OrgSettings.objects.get(id=1).revision


class Org:
    def __init__(self):
        self.clients, self.ids = {}, {}
        root = Api()
        r = root.post('/api/auth/setup', {'username': 'Admin R', 'password': PASSWORD, 'company_name': 'Scope Co'})
        assert r.status_code == 200, r.content
        self.clients['R'], self.ids['R'] = root, r.json()['user']['staff_id']
        for key in 'ABCDE':
            result = self.ok('R', 'admin.user.save', {'name': f'Person {key}', 'role_id': 'ROLE-MEMBER', 'password': PASSWORD})
            self.ids[key] = User.objects.get(id=result['id']).staff_id
            client = Api()
            assert client.post('/api/auth/login', {'username': f'Person {key}', 'password': PASSWORD}).status_code == 200
            self.clients[key] = client
        self.ok('R', 'org.initialize', {'level1_ids': [self.ids['R']], 'expected_revision': rev(), 'reason': 'Synthetic structure'})
        changes = [('B', 2, 'R'), ('C', 2, 'R'), ('A', 3, 'B'), ('D', 3, 'C'), ('E', 4, 'A')]
        self.ok('R', 'org.structure.save', {'changes': [{'staff_id': self.ids[k], 'level': lv, 'manager_id': self.ids[m]} for k, lv, m in changes],
                                            'expected_revision': rev(), 'acknowledged': True, 'reason': 'Primary reporting lines'})
        # A workspace A owned before A gained a second manager: it must keep exactly its previous visibility.
        self.before = self.ok('A', 'tm.workspace.save', {'name': 'A before', 'kind': 'PUBLIC'})['id']
        self.ok('R', 'org.structure.save', {'changes': [{'staff_id': self.ids['A'], 'level': 3, 'manager_id': self.ids['B'],
                                                         'additional_manager_ids': [self.ids['C']]}],
                                            'expected_revision': rev(), 'acknowledged': True, 'reason': 'A also reports to C'})

    def cmd(self, who, action, data):
        return self.clients[who].command(action, data)

    def ok(self, who, action, data):
        response = self.cmd(who, action, data)
        assert response.status_code == 200, (action, response.json())
        return response.json()['result']

    def sees(self, who, wid):
        return Governance().can_view_workspace(self.ids[who], row(Workspace.objects.get(id=wid)))

    def state(self, who):
        r = self.clients[who].get('/api/state')
        assert r.status_code == 200
        return r.json()

    def task(self, who, ws, title, pic=None):
        return self.ok(who, 'tm.task.save', {'workspace_id': ws, 'title': title, 'description': 'Deliver it.', 'start_date': task_today(),
                                             'due_date': add_days(task_today(), 4), 'pic_id': pic or self.ids[who]})['id']


@pytest.fixture
def org(db):
    return Org()


def test_one_employee_can_report_to_two_managers_with_an_audited_change(org):
    assert list(ReportingLine.objects.filter(staff_id=org.ids['A']).values_list('manager_id', flat=True)) == [org.ids['C']]
    audit = OrgAudit.objects.filter(action='employee.reporting_lines', employee_id=org.ids['A']).get()
    assert audit.actor_id == org.ids['R'] and org.ids['C'] in audit.after_json
    g = Governance()
    assert g.managers_of(org.ids['A']) == [org.ids['B'], org.ids['C']]
    # The primary line still decides governance: A's Level 2 governor is B.
    assert g.governor(org.ids['A']) == org.ids['B']
    people = org.clients['R'].get('/api/organization?view=people&limit=200').json()['rows']
    assert next(p for p in people if p['staff_id'] == org.ids['A'])['additional_manager_ids'] == [org.ids['C']]
    employee = org.clients['C'].get(f"/api/organization?view=employee&staff_id={org.ids['A']}").json()
    assert employee['additional_manager_ids'] == [org.ids['C']]


def test_invalid_additional_lines_are_refused(org):
    def change(extra, staff='A', level=3, manager='B'):
        return org.cmd('R', 'org.structure.save', {'changes': [{'staff_id': org.ids[staff], 'level': level, 'manager_id': org.ids[manager],
                                                                'additional_manager_ids': [org.ids[x] for x in extra]}],
                                                   'expected_revision': rev(), 'acknowledged': True, 'reason': 'Check'})
    assert change(['E']).status_code == 422          # someone below A
    assert change(['D']).status_code == 422          # same level (Level 3 must report through Level 2)
    assert change(['A']).status_code == 422          # themselves
    assert change(['C'], staff='B', level=2, manager='R').status_code == 422   # Level 2 reports to Level 1 only
    assert list(ReportingLine.objects.filter(staff_id=org.ids['A']).values_list('manager_id', flat=True)) == [org.ids['C']]


def test_existing_workspaces_are_not_widened_by_a_new_reporting_line(org):
    # Before: only the owner's primary line (B, then R by role). Adding C as a manager does not give C access.
    assert org.sees('B', org.before) and not org.sees('C', org.before) and not org.sees('D', org.before)
    assert WorkspaceManager.objects.filter(workspace_id=org.before).count() == 0


@pytest.mark.parametrize('chosen, b, c', [('B', True, False), ('C', False, True), ('BC', True, True)])
def test_responsible_managers_decide_who_manages_a_public_workspace(org, chosen, b, c):
    ws = org.ok('A', 'tm.workspace.save', {'name': f'A for {chosen}', 'kind': 'PUBLIC', 'manager_ids': [org.ids[x] for x in chosen]})['id']
    assert org.sees('B', ws) is b and org.sees('C', ws) is c
    assert org.sees('R', ws) and org.sees('A', ws) and not org.sees('D', ws) and not org.sees('E', ws)
    assert OrgAudit.objects.filter(action='workspace.management_scope', workspace_id=ws).exists()
    # Tasks in it follow the workspace: the same answer through the state, direct IDs, reports and the Mini App.
    task = org.task('A', ws, f'A works for {chosen}')
    for who, allowed in (('B', b), ('C', c), ('D', False)):
        state = org.state(who)
        assert any(w['id'] == ws for w in state['tm_workspaces']) is allowed, who
        assert any(t['id'] == task for t in state['tm_tasks']) is allowed, who
        detail = org.clients[who].get(f'/api/v1/tasks/{task}/')
        assert detail.status_code == (200 if allowed else 404), (who, detail.status_code)
        report = org.clients[who].get('/api/tasks/report?report=tasks')
        assert report.status_code == 200 and (task in report.content.decode()) is allowed, who


def test_a_manager_who_is_not_selected_cannot_reach_the_work_through_the_shared_employee(org):
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A under C', 'kind': 'PUBLIC', 'manager_ids': [org.ids['C']]})['id']
    task = org.task('A', ws, 'Work under C')
    # B supervises A on the primary line, but the workspace falls under C: B is not told it exists.
    assert org.clients['B'].get(f'/api/v1/workspaces/{ws}/').status_code == 404
    assert org.cmd('B', 'tm.workspace.member.add', {'workspace_id': ws, 'beneficiary_id': org.ids['B'], 'reason': 'Probe'}).status_code == 404
    assert org.cmd('B', 'tm.task.note', {'id': task, 'note': 'Probe'}).status_code == 404
    assert not any(t['id'] == task for t in org.state('B')['tm_tasks'])
    # A task A runs in someone else's unscoped workspace is still visible to A's primary manager, as before.
    other = org.ok('B', 'tm.workspace.save', {'name': 'B team', 'kind': 'PUBLIC'})['id']
    org.ok('B', 'tm.workspace.member.add', {'workspace_id': other, 'beneficiary_id': org.ids['A'], 'reason': 'Team'})
    elsewhere = org.task('A', other, 'Work in B team')
    assert any(t['id'] == elsewhere for t in org.state('B')['tm_tasks'])
    assert not any(t['id'] == elsewhere for t in org.state('C')['tm_tasks'])


def test_responsible_managers_come_from_the_owners_own_reporting_lines(org):
    r = org.cmd('A', 'tm.workspace.save', {'name': 'A wrong', 'kind': 'PUBLIC', 'manager_ids': [org.ids['D']]})
    assert r.status_code == 422 and 'reporting lines' in r.json()['error']
    assert org.cmd('A', 'tm.workspace.save', {'name': 'A personal', 'kind': 'PERSONAL', 'manager_ids': [org.ids['B']]}).status_code == 422
    setup = org.state('A')['workspace_setup']
    assert {m['id'] for m in setup['managers']} == {org.ids['B'], org.ids['C'], org.ids['R']}
    assert setup['primary_manager_id'] == org.ids['B']
    # The scope can be changed later only by someone who manages the workspace, and the change is audited.
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A changes', 'kind': 'PUBLIC', 'manager_ids': [org.ids['B']]})['id']
    w = Workspace.objects.get(id=ws)
    assert org.cmd('B', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'manager_ids': [org.ids['B'], org.ids['C']]}).status_code == 403
    org.ok('A', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'manager_ids': [org.ids['C']]})
    assert not org.sees('B', ws) and org.sees('C', ws)
    assert OrgAudit.objects.filter(action='workspace.management_scope', workspace_id=ws).count() == 2


def test_a_delegated_owner_chooses_the_management_scope_and_branch_members(org):
    org.ok('R', 'org.delegation.request', {'beneficiary_id': org.ids['A'], 'template_id': 'OWNER', 'reason': 'A runs a unit'})
    setup = org.state('A')['workspace_setup']
    assert [s['id'] for s in setup['subordinates']] == [org.ids['E']]
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A unit', 'kind': 'ORGANIZATIONAL', 'owner_id': org.ids['A'],
                                           'manager_ids': [org.ids['B']], 'member_ids': [org.ids['E']]})['id']
    w = Workspace.objects.get(id=ws)
    assert (w.kind, w.visibility, w.owner_id, w.governing_manager_id, w.created_by_id) == ('ORGANIZATIONAL', 'PUBLIC', org.ids['A'], org.ids['B'], org.ids['A'])
    # Creator, owner, responsible manager, members and reporting lines stay separate concepts.
    assert set(WorkspaceMember.objects.filter(workspace_id=ws).values_list('staff_id', flat=True)) == {org.ids['A'], org.ids['E']}
    assert list(WorkspaceManager.objects.filter(workspace_id=ws).values_list('manager_id', flat=True)) == [org.ids['B']]
    assert org.sees('E', ws) and org.sees('B', ws) and not org.sees('C', ws) and not org.sees('D', ws)
    # Someone outside A's branch cannot be added directly at creation.
    r = org.cmd('A', 'tm.workspace.save', {'name': 'A unit 2', 'kind': 'ORGANIZATIONAL', 'owner_id': org.ids['A'], 'member_ids': [org.ids['D']]})
    assert r.status_code == 403
    assert not Workspace.objects.filter(name='A unit 2').exists()


def test_personal_workspaces_stay_personal_and_private_to_their_members(org):
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A private', 'kind': 'PERSONAL'})['id']
    org.ok('A', 'tm.workspace.member.add', {'workspace_id': ws, 'beneficiary_id': org.ids['D'], 'member_role': 'MEMBER', 'reason': 'Work together'})
    assert Workspace.objects.get(id=ws).visibility == 'PERSONAL'
    task = org.task('A', ws, 'Private work')
    shared = org.task('D', ws, 'Shared private work')
    for who, allowed in (('D', True), ('B', False), ('C', False), ('E', False), ('R', True)):
        assert org.sees(who, ws) is allowed, who
        assert any(t['id'] == task for t in org.state(who)['tm_tasks']) is allowed, who
    assert any(t['id'] == shared for t in org.state('A')['tm_tasks'])
    # Groups: a member uses the workspace's team groups; A's managers are told they do not exist.
    group = org.ok('A', 'tm.group.save', {'workspace_id': ws, 'name': 'Private plan', 'visibility': 'TEAM', 'audience': 'WORKSPACE', 'workspace_level': 'EDIT'})['id']
    assert org.clients['D'].get(f'/api/tasks/group?id={group}').status_code == 200
    assert org.clients['B'].get(f'/api/tasks/group?id={group}').status_code == 404
    # Becoming Public is the owner's explicit, acknowledged and audited action; it cannot be undone by an ordinary edit.
    w = Workspace.objects.get(id=ws)
    assert org.cmd('D', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'visibility': 'PUBLIC', 'acknowledged': True}).status_code == 403
    assert org.cmd('A', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'visibility': 'PUBLIC'}).status_code == 422
    org.ok('A', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'visibility': 'PUBLIC', 'acknowledged': True,
                                      'manager_ids': [org.ids['C']]})
    assert Workspace.objects.get(id=ws).visibility == 'PUBLIC'
    assert OrgAudit.objects.filter(workspace_id=ws, action='workspace.public').exists()
    assert org.sees('C', ws) and not org.sees('B', ws)
    w = Workspace.objects.get(id=ws)
    assert org.cmd('A', 'tm.workspace.save', {'id': ws, 'expected_version': w.version, 'name': w.name, 'visibility': 'PERSONAL', 'acknowledged': True}).status_code == 403


def test_the_mini_app_state_follows_the_same_scope(org):
    from telegram.models import TelegramSettings
    from tests.test_telegram import TOKEN, MiniApp, launch
    assert org.cmd('R', 'admin.telegram.save', {'expected_version': 0, 'enabled': True, 'bot_token': TOKEN}).status_code == 200
    TelegramSettings.objects.filter(id=1).update(bot_username='sunny_test_bot', status='ON')
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A for C on the phone', 'kind': 'PUBLIC', 'manager_ids': [org.ids['C']]})['id']
    task = org.task('A', ws, 'Phone check')
    apps = {}
    for i, who in enumerate('BC'):
        code = org.ok(who, 'tg.link.code', {})['code']
        apps[who] = MiniApp(launch(5550200 + i, who))
        assert apps[who].post('/link', {'code': code}).status_code == 200
    seen = {who: [t['id'] for t in app.get('/state').json()['tm_tasks']] for who, app in apps.items()}
    assert task in seen['C'] and task not in seen['B']


def test_under_my_management_lists_people_on_every_line_with_their_titles(org):
    org.ok('R', 'org.level.save', {'level': 2, 'name': 'Department Manager', 'expected_revision': rev(), 'reason': 'Titles'})
    org.ok('R', 'org.level.save', {'level': 3, 'name': 'Team Leader', 'expected_revision': rev(), 'reason': 'Titles'})
    b = {p['staff_id']: p for p in org.state('B')['management_people']}
    c = {p['staff_id']: p for p in org.state('C')['management_people']}
    assert set(b) == {org.ids['A'], org.ids['E']}
    assert set(c) == {org.ids['A'], org.ids['D'], org.ids['E']}
    assert c[org.ids['A']]['title'] == 'Team Leader' and c[org.ids['A']]['direct'] is True
    assert org.state('E')['management_people'] == []
    assert org.ids['A'] in {p['staff_id'] for p in org.state('R')['management_people']}


def test_under_my_management_never_brings_private_events_to_the_managers_browser(org):
    """The calendar filter only narrows what the manager already receives: authorized tasks and meetings, never notes."""
    from tasks.domain import add_days as plus
    tomorrow = plus(task_today(), 1)
    under_c = org.ok('A', 'tm.workspace.save', {'name': 'A calendar under C', 'kind': 'PUBLIC', 'manager_ids': [org.ids['C']]})['id']
    under_b = org.ok('A', 'tm.workspace.save', {'name': 'A calendar under B', 'kind': 'PUBLIC', 'manager_ids': [org.ids['B']]})['id']
    seen_task = org.task('A', under_c, 'Deadline C may see')
    hidden_task = org.task('A', under_b, 'Deadline only B sees')
    meeting = org.ok('A', 'tm.meeting.save', {'workspace_id': under_b, 'title': 'A and E private meeting', 'attendee_ids': [org.ids['E']],
                                              'start_at': f'{tomorrow}T02:00:00.000Z', 'end_at': f'{tomorrow}T03:00:00.000Z'})['id']
    org.ok('A', 'tm.calnote.save', {'title': 'A personal note', 'day': tomorrow})
    state = org.state('C')
    assert any(p['staff_id'] == org.ids['A'] for p in state['management_people'])
    task_ids = {t['id'] for t in state['tm_tasks']}
    assert seen_task in task_ids and hidden_task not in task_ids
    assert meeting not in {m['id'] for m in state['tm_meetings']}
    assert all(n['staff_id'] == org.ids['C'] for n in state['tm_calendar_notes'])
    assert 'A personal note' not in org.clients['C'].get('/api/state').content.decode()
    # Someone without anyone under them gets no management list at all.
    assert org.state('D')['management_people'] == []


def test_a_chosen_scope_never_falls_back_to_the_primary_line_when_the_chosen_manager_leaves_it(org):
    # A chose C only. When C stops being A's manager, the workspace must not reopen to B (whom A deliberately left out):
    # nobody sees it through management until A chooses again. Owner, Administration and members keep their access.
    ws = org.ok('A', 'tm.workspace.save', {'name': 'A chose C', 'kind': 'PUBLIC', 'manager_ids': [org.ids['C']]})['id']
    task = org.task('A', ws, 'Still private to the chosen scope')
    assert org.sees('C', ws) and not org.sees('B', ws)
    org.ok('R', 'org.structure.save', {'changes': [{'staff_id': org.ids['A'], 'level': 3, 'manager_id': org.ids['B'], 'additional_manager_ids': []}],
                                        'expected_revision': rev(), 'acknowledged': True, 'reason': 'A no longer reports to C'})
    assert WorkspaceManager.objects.filter(workspace_id=ws).exists()   # the owner's choice is kept on record
    assert not org.sees('C', ws) and not org.sees('B', ws) and not org.sees('D', ws)
    assert org.sees('A', ws) and org.sees('R', ws)
    for who in 'BC':
        assert not any(t['id'] == task for t in org.state(who)['tm_tasks']), who
        assert org.clients[who].get(f'/api/v1/tasks/{task}/').status_code == 404, who
    # The owner chooses again (only managers still above them are offered).
    access = next(w for w in org.state('A')['tm_workspaces'] if w['id'] == ws)['org_access']
    assert [m['id'] for m in access['manager_options']] == [org.ids['B'], org.ids['R']]
    version = Workspace.objects.get(id=ws).version
    org.ok('A', 'tm.workspace.save', {'id': ws, 'expected_version': version, 'name': 'A chose C', 'kind': 'PUBLIC', 'manager_ids': [org.ids['B']]})
    assert org.sees('B', ws) and not org.sees('C', ws)

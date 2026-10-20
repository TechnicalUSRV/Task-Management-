"""Workspace privacy and Organizational Structure governance — scenarios from V5.7.7's v577-access-test.mjs,
workspace-management-test.mjs and organization-test.mjs, run through the HTTP command API.

Hierarchy (same as v577-fixture.mjs):  R, A, C = Level 1;  A → B (L2) → E (L3) → F (L4);  A → D (L2) → V (L3).
Task-visibility checks that need tasks and /api/state are added with the tasks slice.
"""
import pytest
from django.db import DatabaseError, transaction

from accounts.models import User
from core.rows import row
from notifications.models import Notification
from organization.governance import Governance
from organization.models import OrgAudit, OrgRequest, OrgSettings
from workspaces.models import Workspace, WorkspaceMember

from .conftest import Api

PASSWORD = 'Visibility-test-2026'


def rev():
    return OrgSettings.objects.get(id=1).revision


class World:
    def __init__(self):
        self.clients, self.ids = {}, {}
        root = Api()
        r = root.post('/api/auth/setup', {'username': 'Admin R', 'password': PASSWORD, 'company_name': 'Test Co'})
        assert r.status_code == 200, r.content
        self.clients['R'], self.ids['R'] = root, r.json()['user']['staff_id']
        for key in 'ABCDEFV':
            result = self.ok('R', 'admin.user.save', {'name': f'Employee {key}', 'role_id': 'ROLE-MEMBER', 'password': PASSWORD})
            self.ids[key] = User.objects.get(id=result['id']).staff_id
        for key in 'ABCDEFV':
            self.login(key)
        self.ok('R', 'org.initialize', {'level1_ids': [self.ids[k] for k in 'RAC'], 'expected_revision': rev(), 'reason': 'Synthetic hierarchy'})
        changes = [('B', 2, 'A'), ('D', 2, 'A'), ('E', 3, 'B'), ('F', 4, 'E'), ('V', 3, 'D')]
        self.ok('R', 'org.structure.save', {'changes': [{'staff_id': self.ids[k], 'level': lv, 'manager_id': self.ids[m]} for k, lv, m in changes],
                                            'expected_revision': rev(), 'acknowledged': True, 'reason': 'Synthetic reporting relationships'})
        self.pub = self.ok('B', 'tm.workspace.save', {'name': 'B Public', 'kind': 'PUBLIC'})['id']
        self.personal = self.ok('B', 'tm.workspace.save', {'name': 'B Personal', 'kind': 'PERSONAL'})['id']
        self.deep = self.ok('F', 'tm.workspace.save', {'name': 'F Public', 'kind': 'PUBLIC'})['id']

    def login(self, key):
        client = Api()
        name = 'Admin R' if key == 'R' else f'Employee {key}'
        assert client.post('/api/auth/login', {'username': name, 'password': PASSWORD}).status_code == 200
        self.clients[key] = client

    def cmd(self, who, action, data):
        return self.clients[who].command(action, data)

    def ok(self, who, action, data):
        response = self.cmd(who, action, data)
        assert response.status_code == 200, (action, response.json())
        return response.json()['result']

    def grant(self, who, settings):
        user = User.objects.get(staff_id=self.ids[who])
        self.ok('R', 'admin.user.save', {'id': user.id, 'expected_version': user.version, 'username': user.username,
                                         'role_id': user.role_id, 'function_settings': settings})
        self.login(who)  # permission changes end the old session, as in V5.7.7

    def sees(self, who, wid):
        return Governance().can_view_workspace(self.ids[who], row(Workspace.objects.get(id=wid)))


@pytest.fixture
def world(db):
    return World()


def test_public_workspaces_follow_the_owners_real_reporting_line(world):
    for who in 'ABE':
        assert world.sees(who, world.deep)
    assert world.sees('A', world.pub) and not world.sees('A', world.personal)
    for who in 'CDV':
        for wid in (world.pub, world.personal, world.deep):
            assert not world.sees(who, wid), (who, wid)


def test_new_public_workspace_is_classified_personal_kind_with_public_visibility(world):
    w = Workspace.objects.get(id=world.pub)
    assert (w.kind, w.visibility, w.created_by_id) == ('PERSONAL', 'PUBLIC', world.ids['B'])
    assert Workspace.objects.get(id=world.personal).visibility == 'PERSONAL'
    assert WorkspaceMember.objects.filter(workspace_id=world.personal, staff_id=world.ids['B']).exists()


def test_administrator_role_sees_personal_workspaces_and_custom_global_grants_do_not(world):
    world.ok('R', 'org.structure.save', {'changes': [{'staff_id': world.ids['R'], 'level': 3, 'manager_id': world.ids['B']}],
                                         'expected_revision': rev(), 'acknowledged': True, 'reason': 'Administrator at a lower level'})
    world.grant('C', {'admin.workspaces': {'view': 'ALLOW'}})
    assert world.sees('R', world.personal)
    assert not world.sees('C', world.personal) and not world.sees('C', world.pub)


def test_guessed_ids_on_hidden_workspaces_answer_not_found(world):
    for who in 'ACD':
        r = world.cmd(who, 'tm.workspace.member.remove', {'workspace_id': world.personal, 'beneficiary_id': world.ids['B'],
                                                          'expected_revision': rev(), 'reason': 'Probe'})
        assert r.status_code == 404, (who, r.json())


def test_failed_member_addition_rolls_back_conversion_membership_and_audit(world):
    audits = OrgAudit.objects.count()
    r = world.cmd('B', 'tm.workspace.member.add', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'], 'reason': ''})
    assert r.status_code == 400
    assert Workspace.objects.get(id=world.personal).visibility == 'PERSONAL'
    assert not WorkspaceMember.objects.filter(workspace_id=world.personal, staff_id=world.ids['D']).exists()
    assert OrgAudit.objects.count() == audits


def test_adding_a_member_keeps_a_personal_workspace_personal(world):
    # Changed rule (requirement 2.5): adding a member no longer converts Personal to Public. Only the explicitly added
    # member gains access; the owner's managers do not, and authorized Administration keeps its exception.
    world.ok('B', 'tm.workspace.member.add', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'],
                                              'member_role': 'VIEWER', 'reason': 'Share with sibling'})
    w = Workspace.objects.get(id=world.personal)
    assert w.visibility == 'PERSONAL' and w.kind == 'PERSONAL'
    assert not OrgAudit.objects.filter(workspace_id=world.personal, action='workspace.public').exists()
    assert OrgAudit.objects.filter(workspace_id=world.personal, action='personal.shared', employee_id=world.ids['D']).exists()
    assert WorkspaceMember.objects.get(workspace_id=world.personal, staff_id=world.ids['D']).member_role == 'VIEWER'
    assert world.sees('D', world.personal) and world.sees('R', world.personal)
    assert not world.sees('A', world.personal) and not world.sees('C', world.personal) and not world.sees('E', world.personal)


def test_the_database_no_longer_converts_personal_to_public_on_membership_writes(world):
    revision = rev()
    WorkspaceMember.objects.create(workspace_id=world.personal, staff_id=world.ids['E'])
    assert Workspace.objects.get(id=world.personal).visibility == 'PERSONAL'
    assert not OrgAudit.objects.filter(workspace_id=world.personal, action='workspace.public').exists()
    assert rev() == revision


def test_member_removal_keeps_personal_and_needs_current_revision(world):
    world.ok('B', 'tm.workspace.member.add', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'], 'reason': 'Share'})
    stale = world.cmd('B', 'tm.workspace.member.remove', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'],
                                                          'expected_revision': -1, 'reason': 'Stale'})
    assert stale.status_code == 409
    world.ok('B', 'tm.workspace.member.remove', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'],
                                                 'expected_revision': rev(), 'reason': 'Membership no longer needed'})
    assert OrgAudit.objects.filter(action='membership.revoked', workspace_id=world.personal).exists()
    assert Workspace.objects.get(id=world.personal).visibility == 'PERSONAL'
    assert not world.sees('D', world.personal) and not world.sees('A', world.personal)


def test_owner_cannot_be_removed_and_legacy_creator_with_delete_can_remove(world):
    world.ok('B', 'tm.workspace.member.add', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'], 'reason': 'Share'})
    owner = world.cmd('B', 'tm.workspace.member.remove', {'workspace_id': world.personal, 'beneficiary_id': world.ids['B'],
                                                          'expected_revision': rev(), 'reason': 'Remove owner'})
    assert owner.status_code == 409
    legacy = world.ok('B', 'tm.workspace.save', {'name': 'Legacy creator test', 'kind': 'PUBLIC'})['id']
    Workspace.objects.filter(id=legacy).update(kind='LEGACY')
    world.ok('B', 'tm.workspace.save', {'id': legacy, 'name': 'Legacy creator test', 'owner_id': world.ids['E'],
                                        'member_ids': [world.ids['B'], world.ids['E'], world.ids['D']], 'expected_version': 0})
    world.grant('B', {'tasks.workspace': {'delete': 'ALLOW'}})
    denied = world.cmd('D', 'tm.workspace.member.remove', {'workspace_id': legacy, 'beneficiary_id': world.ids['B'],
                                                           'expected_revision': rev(), 'reason': 'Member probe'})
    assert denied.status_code == 403
    world.ok('B', 'tm.workspace.member.remove', {'workspace_id': legacy, 'beneficiary_id': world.ids['D'],
                                                 'expected_revision': rev(), 'reason': 'Authorized creator removal'})
    assert not WorkspaceMember.objects.filter(workspace_id=legacy, staff_id=world.ids['D']).exists()
    assert WorkspaceMember.objects.filter(workspace_id=legacy, staff_id=world.ids['E']).exists()


ORG_COMMANDS = ['org.structure.save', 'org.structure.request', 'org.preview', 'org.level.save', 'org.template.save',
                'org.delegation.request', 'org.grant.revoke', 'org.request.decide', 'org.request.cancel', 'org.membership.remove',
                'org.workspace.save', 'org.workspace.classify', 'org.workspace.delete', 'org.initialize']


def test_organizational_structure_view_is_read_only(world):
    a = world.clients['A']
    tree = a.get('/api/organization?view=people')
    assert tree.status_code == 200
    staff = [x['staff_id'] for x in tree.json()['rows']]
    assert world.ids['B'] in staff and world.ids['C'] not in staff
    employee = a.get(f"/api/organization?view=employee&staff_id={world.ids['B']}")
    assert employee.status_code == 200 and employee.json()['actions'] == {}
    for view in ('workspaces', 'requests', 'audit', 'migration', 'join'):
        assert a.get(f'/api/organization?view={view}').status_code == 403, view
    for action in ORG_COMMANDS:
        assert world.cmd('A', action, {}).status_code == 403, action


def test_create_permission_does_not_expose_another_branch(world):
    legacy = world.ok('B', 'tm.workspace.save', {'name': 'Legacy creator test', 'kind': 'PUBLIC'})['id']
    Workspace.objects.filter(id=legacy).update(kind='LEGACY')
    world.grant('C', {'tasks.organization': {'create': 'ALLOW'}})
    c = world.clients['C']
    migration = c.get('/api/organization?view=migration')
    assert migration.status_code == 200 and 'Legacy creator test' not in migration.content.decode()
    preview = world.cmd('C', 'org.preview', {'changes': [{'staff_id': world.ids['B'], 'level': 2, 'manager_id': world.ids['A']}]})
    assert preview.status_code == 200 and preview.json()['result']['impact']['workspaces'] == []
    audit = c.get('/api/organization?view=audit')
    assert audit.status_code == 200 and 'B Personal' not in audit.content.decode()


def test_create_permission_still_requires_authority_and_revision(world):
    world.grant('B', {'tasks.organization': {'create': 'ALLOW'}})
    assert world.clients['B'].get('/api/organization?view=workspaces').status_code == 200
    change = [{'staff_id': world.ids['F'], 'level': 4, 'manager_id': world.ids['E']}]
    assert world.cmd('B', 'org.preview', {'changes': change}).status_code == 200
    stale = world.cmd('B', 'org.structure.save', {'changes': change, 'expected_revision': rev() - 1, 'acknowledged': True, 'reason': 'Old'})
    assert stale.status_code == 409
    world.ok('B', 'org.structure.save', {'changes': change, 'expected_revision': rev(), 'acknowledged': True, 'reason': 'No-op'})
    outside = world.cmd('B', 'org.structure.save', {'changes': [{'staff_id': world.ids['C'], 'level': 3, 'manager_id': world.ids['B']}],
                                                    'expected_revision': rev(), 'acknowledged': True, 'reason': 'Outside authority'})
    assert outside.status_code == 403


def test_structure_rules_reject_cycles_and_invalid_levels(world):
    bad = world.cmd('R', 'org.structure.save', {'changes': [{'staff_id': world.ids['B'], 'level': 2, 'manager_id': world.ids['E']}],
                                                'expected_revision': rev(), 'acknowledged': True, 'reason': 'Invalid'})
    assert bad.status_code == 422
    unacknowledged = world.cmd('R', 'org.structure.save', {'changes': [{'staff_id': world.ids['F'], 'level': 4, 'manager_id': world.ids['E']}],
                                                           'expected_revision': rev(), 'reason': 'Missing acknowledgement'})
    assert unacknowledged.status_code == 422


def test_organization_audit_is_append_only_in_the_database(world):
    entry = OrgAudit.objects.first()
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            OrgAudit.objects.filter(id=entry.id).update(reason='rewritten')
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            OrgAudit.objects.filter(id=entry.id).delete()


def test_governed_membership_request_waits_for_the_level2_approver(world):
    org = world.ok('B', 'tm.workspace.save', {'name': 'B Organizational', 'kind': 'ORGANIZATIONAL', 'joinable': True})['id']
    w = Workspace.objects.get(id=org)
    assert (w.kind, w.governing_manager_id, w.visibility) == ('ORGANIZATIONAL', world.ids['B'], 'PUBLIC')
    pending = world.ok('E', 'tm.workspace.member.add', {'workspace_id': org, 'reason': 'Please add me', 'request_key': 'join-1'})
    q = OrgRequest.objects.get(id=pending['id'])
    assert (q.status, q.approver_id) == ('PENDING', world.ids['B'])
    assert not WorkspaceMember.objects.filter(workspace_id=org, staff_id=world.ids['E']).exists()
    assert Notification.objects.filter(staff_id=world.ids['B'], org_request_id=q.id).exists()
    again = world.ok('E', 'tm.workspace.member.add', {'workspace_id': org, 'reason': 'Please add me', 'request_key': 'join-1'})
    assert again['unchanged'] is True and again['id'] == q.id
    assert world.cmd('E', 'org.request.decide', {'id': q.id, 'decision': 'APPROVE'}).status_code == 403
    world.grant('B', {'tasks.organization': {'create': 'ALLOW'}})
    world.ok('B', 'org.request.decide', {'id': q.id, 'decision': 'APPROVE', 'note': 'Welcome'})
    assert WorkspaceMember.objects.filter(workspace_id=org, staff_id=world.ids['E'], approval_id=q.id).exists()
    assert OrgRequest.objects.get(id=q.id).status == 'APPROVED'


def test_delete_and_restore_are_for_the_creator_and_block_other_commands(world):
    world.ok('B', 'tm.workspace.member.add', {'workspace_id': world.personal, 'beneficiary_id': world.ids['D'], 'reason': 'Share'})
    w = Workspace.objects.get(id=world.personal)
    # The workspace stays Personal: B's manager A is told it does not exist; member D sees it but did not create it.
    assert world.cmd('A', 'tm.workspace.delete', {'id': w.id, 'expected_version': w.version, 'acknowledged': True}).status_code == 404
    assert world.cmd('D', 'tm.workspace.delete', {'id': w.id, 'expected_version': w.version, 'acknowledged': True}).status_code == 403
    world.ok('B', 'tm.workspace.delete', {'id': w.id, 'expected_version': w.version, 'acknowledged': True})
    w = Workspace.objects.get(id=world.personal)
    assert w.deleted_at is not None and w.status == 'ARCHIVED' and w.deleted_from_status == 'ACTIVE'
    assert Notification.objects.filter(staff_id=world.ids['D'], kind='workspace_deleted').exists()
    blocked = world.cmd('B', 'tm.workspace.member.add', {'workspace_id': w.id, 'beneficiary_id': world.ids['E'], 'reason': 'x'})
    assert blocked.status_code == 409
    world.ok('B', 'tm.workspace.restore', {'id': w.id, 'expected_version': w.version, 'acknowledged': True})
    w = Workspace.objects.get(id=world.personal)
    assert w.deleted_at is None and w.status == 'ACTIVE'
    assert WorkspaceMember.objects.filter(workspace_id=w.id, staff_id=world.ids['D']).exists()


def test_manager_cannot_assign_a_role_with_more_access_than_their_own(world):
    world.grant('A', {'admin.users': {'view': 'ALLOW', 'create': 'ALLOW', 'update': 'ALLOW'}})
    r = world.cmd('A', 'admin.user.save', {'name': 'Escalated', 'role_id': 'ROLE-ADMIN', 'password': PASSWORD})
    assert r.status_code == 403
    assert world.cmd('A', 'admin.user.save', {'name': 'New Member', 'role_id': 'ROLE-MEMBER', 'password': PASSWORD}).status_code == 200


@pytest.mark.django_db
def test_legacy_workspaces_before_organizational_structure_is_initialized():
    admin = Api()
    admin_staff = admin.post('/api/auth/setup', {'username': 'Admin', 'password': PASSWORD}).json()['user']['staff_id']
    member = admin.command('admin.user.save', {'name': 'Member M', 'role_id': 'ROLE-MEMBER', 'password': PASSWORD}).json()['result']
    other = admin.command('admin.user.save', {'name': 'Member N', 'role_id': 'ROLE-MEMBER', 'password': PASSWORD}).json()['result']
    m_staff, n_staff = (User.objects.get(id=x['id']).staff_id for x in (member, other))
    created = admin.command('tm.workspace.save', {'name': 'Operations', 'owner_id': admin_staff, 'member_ids': [m_staff]})
    assert created.status_code == 200, created.json()
    w = Workspace.objects.get(id=created.json()['result']['id'])
    assert (w.kind, w.visibility) == ('LEGACY', 'PUBLIC')
    assert set(WorkspaceMember.objects.filter(workspace_id=w.id).values_list('staff_id', flat=True)) == {admin_staff, m_staff}
    duplicate = admin.command('tm.workspace.save', {'name': 'operations', 'owner_id': admin_staff})
    assert duplicate.status_code == 409
    n = Api()
    assert n.post('/api/auth/login', {'username': 'Member N', 'password': PASSWORD}).status_code == 200
    hidden = n.command('tm.workspace.save', {'id': w.id, 'name': 'Renamed', 'owner_id': admin_staff, 'member_ids': [m_staff], 'expected_version': 0})
    assert hidden.status_code == 404
    m = Api()
    assert m.post('/api/auth/login', {'username': 'Member M', 'password': PASSWORD}).status_code == 200
    add = m.command('tm.workspace.save', {'id': w.id, 'name': 'Operations', 'owner_id': admin_staff, 'member_ids': [m_staff, n_staff], 'expected_version': 0})
    assert add.status_code == 403
    rename = m.command('tm.workspace.save', {'id': w.id, 'name': 'Operations HQ', 'owner_id': admin_staff, 'member_ids': [m_staff], 'expected_version': 0})
    assert rename.status_code == 200, rename.json()

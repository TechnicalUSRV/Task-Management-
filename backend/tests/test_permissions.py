"""Function permission resolution (access.mjs effective/permissions)."""
from django.db import transaction

from accounts import services
from accounts.models import User, UserPermissionOverride
from core.models import ModuleSetting
from organization.models import OrgSettings, Profile


def make_user(admin, name, role):
    with transaction.atomic():
        result = services.save_user({'username': name, 'password': 'Password-1234', 'role_id': role}, admin.staff_id)
    return User.objects.get(id=result['id'])


def test_default_modules_switch_off_crm_operations_and_finance(db):
    enabled = services.enabled_modules()
    assert {'tasks', 'admin', 'dashboard', 'system', 'reports'} <= enabled
    assert not {'crm', 'ops', 'finance'} & enabled


def test_administrator_has_every_enabled_function_and_global_workspaces(admin_api):
    admin = User.objects.get(username='Admin User')
    perms = services.permissions(admin)
    assert perms['tasks.tasks'] == ['view', 'create', 'update', 'approve', 'export']
    assert perms['admin.workspaces'] == ['view']
    assert perms['crm.contacts'] == []  # CRM module is off


def test_overrides_deny_wins_and_view_is_required(admin_api):
    admin = User.objects.get(username='Admin User')
    member = make_user(admin, 'Member One', 'ROLE-MEMBER')
    assert services.can(member, 'tasks.tasks', 'create')
    assert not services.can(member, 'tasks.company')
    UserPermissionOverride.objects.create(user=member, resource='tasks.tasks', action='create', effect='DENY')
    UserPermissionOverride.objects.create(user=member, resource='tasks.company', action='view', effect='ALLOW')
    assert not services.can(member, 'tasks.tasks', 'create')
    assert services.can(member, 'tasks.company')
    UserPermissionOverride.objects.create(user=member, resource='tasks.meetings', action='view', effect='DENY')
    assert services.permissions(member)['tasks.meetings'] == []


def test_global_workspace_visibility_is_reserved_to_the_administrator_role(admin_api):
    admin = User.objects.get(username='Admin User')
    member = make_user(admin, 'Member Two', 'ROLE-MANAGER')
    UserPermissionOverride.objects.create(user=member, resource='admin.workspaces', action='view', effect='ALLOW')
    assert services.permissions(member)['admin.workspaces'] == []


def test_disabled_module_removes_its_functions(admin_api):
    admin = User.objects.get(username='Admin User')
    ModuleSetting.objects.filter(module_id='tasks').update(enabled=False)
    assert services.permissions(admin)['tasks.tasks'] == []


def test_organization_enabled_gives_task_users_workspace_view_and_create(admin_api):
    admin = User.objects.get(username='Admin User')
    viewer = make_user(admin, 'Viewer One', 'ROLE-VIEWER')
    assert services.permissions(viewer)['tasks.workspace'] == ['view']
    OrgSettings.objects.filter(id=1).update(enabled=True)
    assert services.permissions(viewer)['tasks.workspace'] == ['view', 'create']


def test_level1_gets_task_management_functions_but_not_administration(admin_api):
    admin = User.objects.get(username='Admin User')
    viewer = make_user(admin, 'Level One', 'ROLE-VIEWER')
    Profile.objects.filter(staff_id=viewer.staff_id).update(org_level_id=1)
    perms = services.permissions(viewer)
    assert 'delete' in perms['tasks.workspace'] and 'export' in perms['tasks.reports']
    assert perms['tasks.tasks'] == ['view'] and perms['admin.users'] == []


def test_role_matrix_requires_view_and_known_actions(admin_api):
    import pytest
    admin = User.objects.get(username='Admin User')
    with pytest.raises(Exception) as missing_view:
        with transaction.atomic():
            services.save_role({'name': 'Coordinators', 'permissions': {'tasks.tasks': ['create']}}, admin.staff_id)
    assert str(missing_view.value) == 'View permission is required before granting actions in a row.'
    with transaction.atomic():
        result = services.save_role({'name': 'Coordinators', 'permissions': {'tasks.tasks': ['view', 'create']}}, admin.staff_id)
    assert result['id'].startswith('ROLE-')
    with pytest.raises(Exception) as duplicate:
        with transaction.atomic():
            services.save_role({'name': 'coordinators', 'permissions': {}}, admin.staff_id)
    assert duplicate.value.status == 409

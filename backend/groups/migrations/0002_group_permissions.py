"""Groups are offered again: roles receive their Group permissions once, exactly as V5.7.7 does when Groups first appear
(access.mjs, schema 11).

While Groups were hidden (Stage 1 decision A) the role screens did not show them, so a role saved in that time lost its
Group rows. For every role except Administrator that can view tasks and has no Group permission at all: the starter roles
get their default Group permissions, other roles may view groups shared with them. Roles that already have a Group
permission are left exactly as they are. Only rows are added; nothing is changed or removed.
"""
from django.db import migrations

from accounts.catalog import role_defaults

STARTER = {'ROLE-MANAGER': 'MANAGER', 'ROLE-MEMBER': 'MEMBER', 'ROLE-VIEWER': 'VIEWER'}


def grant(apps, schema_editor):
    Role = apps.get_model('accounts', 'Role')
    RolePermission = apps.get_model('accounts', 'RolePermission')
    for role_id in Role.objects.exclude(id='ROLE-ADMIN').order_by('id').values_list('id', flat=True):
        if not RolePermission.objects.filter(role_id=role_id, resource='tasks.tasks', action='view').exists():
            continue
        if RolePermission.objects.filter(role_id=role_id, resource='tasks.groups').exists():
            continue
        actions = role_defaults(STARTER[role_id])['tasks.groups'] if role_id in STARTER else ['view']
        RolePermission.objects.bulk_create([RolePermission(role_id=role_id, resource='tasks.groups', action=a) for a in actions])


class Migration(migrations.Migration):
    dependencies = [
        ('groups', '0001_initial'),
        ('accounts', '0002_seed_defaults'),
    ]
    operations = [migrations.RunPython(grant, migrations.RunPython.noop)]

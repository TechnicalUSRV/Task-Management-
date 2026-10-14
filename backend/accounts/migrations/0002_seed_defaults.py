"""Records V5.7.7 creates on first start: module switches, the four built-in roles with their starter permissions,
organization levels 1–5, and the single-row settings. Idempotent; never touches existing rows."""
from django.db import migrations
from django.utils import timezone

from accounts.catalog import BUILT_IN_ROLES, DEFAULT_MODULES, MODULES, role_defaults

LEVELS = [(1, 'Organization administrators'), (2, 'Workspace managers'), (3, 'Employees'), (4, 'Delegated team'),
          (5, 'Team members')]


def seed(apps, schema_editor):
    ModuleSetting = apps.get_model('core', 'ModuleSetting')
    ChangeCounter = apps.get_model('core', 'ChangeCounter')
    Role = apps.get_model('accounts', 'Role')
    RolePermission = apps.get_model('accounts', 'RolePermission')
    OrgLevel = apps.get_model('organization', 'OrgLevel')
    OrgSettings = apps.get_model('organization', 'OrgSettings')
    for module_id, *_ in MODULES:
        ModuleSetting.objects.get_or_create(module_id=module_id, defaults={'enabled': DEFAULT_MODULES[module_id]})
    ChangeCounter.objects.get_or_create(id=1, defaults={'seq': 0})
    OrgSettings.objects.get_or_create(id=1)
    for level_id, name in LEVELS:
        OrgLevel.objects.get_or_create(id=level_id, defaults={'name': name})
    if not Role.objects.exists():
        now = timezone.now()
        for key, name, kind in BUILT_IN_ROLES:
            description = ('Full system access. At least one active administrator is required.' if kind == 'ADMIN'
                           else f'Starting {name.lower()} permissions; customize as needed.')
            Role.objects.create(id=key, name=name, description=description, protected=kind == 'ADMIN',
                                created_at=now, updated_at=now)
            RolePermission.objects.bulk_create(RolePermission(role_id=key, resource=resource, action=action)
                                               for resource, actions in role_defaults(kind).items() for action in actions)


class Migration(migrations.Migration):
    dependencies = [
        ('accounts', '0001_initial'),
        ('core', '0001_initial'),
        ('organization', '0001_initial'),
    ]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]

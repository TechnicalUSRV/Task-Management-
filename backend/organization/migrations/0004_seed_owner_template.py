import json

from django.db import migrations

CAPABILITIES = ['workspace_create', 'workspace_manage', 'membership_request', 'delegate_request', 'structure_request',
                'collaborate_outside']


def seed(apps, schema_editor):
    OrgTemplate = apps.get_model('organization', 'OrgTemplate')
    OrgTemplate.objects.get_or_create(id='OWNER', defaults={'name': 'Owner', 'capabilities_json': json.dumps(CAPABILITIES, separators=(',', ':'))})


class Migration(migrations.Migration):
    dependencies = [('organization', '0003_orgaudit_workspace_orggrant_beneficiary_and_more')]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]

from django.db import migrations


def start_at_one(apps, schema_editor):
    """V5.7.7 starts every database at organization revision 1 (its workspace-privacy migration counts once)."""
    OrgSettings = apps.get_model('organization', 'OrgSettings')
    found, created = OrgSettings.objects.get_or_create(id=1, defaults={'revision': 1})
    if not created and found.revision == 0:
        OrgSettings.objects.filter(id=1).update(revision=1)


class Migration(migrations.Migration):
    dependencies = [('organization', '0005_staffphoto')]
    operations = [migrations.RunPython(start_at_one, migrations.RunPython.noop)]

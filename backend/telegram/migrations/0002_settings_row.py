from django.db import migrations


def create(apps, schema_editor):
    apps.get_model('telegram', 'TelegramSettings').objects.get_or_create(id=1)


class Migration(migrations.Migration):
    dependencies = [('telegram', '0001_initial')]
    operations = [migrations.RunPython(create, migrations.RunPython.noop)]

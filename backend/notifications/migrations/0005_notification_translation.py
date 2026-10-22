from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('notifications', '0004_notification_due_request_notification_meeting_id_and_more')]
    operations = [migrations.AddField(model_name='notification', name='translation', field=models.JSONField(default=dict, blank=True))]

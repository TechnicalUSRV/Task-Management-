from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('accounts', '0002_seed_defaults')]
    operations = [migrations.AddField(
        model_name='user', name='language',
        field=models.CharField(max_length=5, default='en', choices=[('en', 'English'), ('km', 'ភាសាខ្មែរ'), ('zh-CN', '简体中文')]),
    )]

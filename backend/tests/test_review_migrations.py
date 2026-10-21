"""Upgrade populated upstream schema in a separate in-memory SQLite process."""
import os
from pathlib import Path
import subprocess
import sys


def test_review_migrations_preserve_task_files_history_members_and_delivery():
    script = r'''
import django
django.setup()
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
executor = MigrationExecutor(connection)
latest = executor.loader.graph.leaf_nodes()
baseline = [(a, '0002_task_visibility_taskrequest_visibility_taskmember' if a == 'tasks'
             else '0005_deliverypart_remove_boarddelivery_tm_delivery_status_and_more' if a == 'groups' else n)
            for a, n in latest]
executor.migrate(baseline)
apps = executor.loader.project_state(baseline).apps
now = timezone.now()
apps.get_model('core','Staff').objects.create(id='S-1',name='Synthetic employee')
apps.get_model('workspaces','Workspace').objects.create(id='W-1',name='Existing room',owner_id='S-1',created_at=now,updated_at=now)
apps.get_model('tasks','Task').objects.create(id='T-1',workspace_id='W-1',title='Keep original',start_date=now.date(),due_date=now.date(),
    status='NOT_STARTED',priority='MEDIUM',progress=0,created_by_id='S-1',pic_id='S-1',created_at=now,updated_at=now,visibility='PERSONAL')
apps.get_model('tasks','TaskFile').objects.create(id='F-1',task_id='T-1',name='proof.txt',mime='text/plain',size=8,content=b'original',uploaded_by_id='S-1',created_at=now)
apps.get_model('tasks','TaskMember').objects.create(task_id='T-1',staff_id='S-1',granted_by_id='S-1',permission='VIEWER',created_at=now)
apps.get_model('tasks','TaskHistory').objects.create(task_id='T-1',kind='created',to_status='NOT_STARTED',progress=0,due_date=now.date(),actor_id='S-1',created_at=now)
apps.get_model('groups','BoardDelivery').objects.create(id='D-1',task_id='T-1',staff_id='S-1',request_key='one',row_id_snapshot='',column_id_snapshot='',
    file_ids_json='["F-1"]',mode='SEPARATE',telegram_user_id=777,telegram_linked_at=now,status='READY',created_at=now,updated_at=now)
executor = MigrationExecutor(connection)
executor.migrate(latest)
from tasks.models import Task,TaskFile,TaskHistory,TaskMember
from groups.models import BoardDelivery
t=Task.objects.get(id='T-1')
assert t.title=='Keep original' and t.visibility=='PERSONAL' and t.governing_manager_id is None
assert bytes(TaskFile.objects.get(id='F-1').content)==b'original'
assert TaskHistory.objects.filter(task_id='T-1').count()==1
assert TaskMember.objects.get(task_id='T-1').permission=='VIEWER'
job=BoardDelivery.objects.get(id='D-1')
assert job.status=='READY' and job.retry_at is None
print('Populated upstream schema upgraded; original records preserved.')
'''
    result = subprocess.run([sys.executable,'-c',script],cwd=Path(__file__).resolve().parents[1],
        env={**os.environ,'DJANGO_SETTINGS_MODULE':'config.settings_test'},capture_output=True,text=True,timeout=60)
    assert result.returncode==0, result.stdout + result.stderr

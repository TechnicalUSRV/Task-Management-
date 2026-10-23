"""Exercise additive language migrations against existing account/notification rows."""
import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone


@pytest.mark.django_db(transaction=True)
def test_language_migrations_preserve_existing_accounts_and_notifications(admin_api):
    from accounts.models import User
    from notifications.models import Notification
    original = User.objects.get(pk=admin_api.user['id'])
    preserved = {field: getattr(original, field) for field in
                 ('username', 'email', 'password', 'staff_id', 'role_id', 'active', 'version')}
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes()
    before = [node for node in latest if node[0] not in ('accounts', 'notifications')]
    before += [('accounts', '0002_seed_defaults'),
               ('notifications', '0004_notification_due_request_notification_meeting_id_and_more')]
    try:
        executor.migrate(before)
        old_apps = executor.loader.project_state(before).apps
        old_user = old_apps.get_model('accounts', 'User').objects.get(pk=original.pk)
        assert not hasattr(old_user, 'language')
        legacy = old_apps.get_model('notifications', 'Notification').objects.create(
            staff_id=old_user.staff_id, kind='legacy', title='Save · រក្សាទុក · 保存',
            body='Employee wording must remain literal', created_at=timezone.now())
        executor = MigrationExecutor(connection)
        executor.migrate(latest)
        restored = User.objects.get(pk=original.pk)
        assert restored.language == 'en'
        assert {field: getattr(restored, field) for field in preserved} == preserved
        notice = Notification.objects.get(pk=legacy.pk)
        assert notice.translation == {}
        assert notice.title == legacy.title and notice.body == legacy.body
        restored.language = 'km'
        restored.save(update_fields=['language'])
        restored.refresh_from_db()
        assert restored.language == 'km'
    finally:
        # Keep the shared test schema current even if a preservation assertion fails.
        MigrationExecutor(connection).migrate(latest)

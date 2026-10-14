"""In-app notifications (V5.7.7 tm_notifications) and their delivery to outside channels (Telegram)."""
from django.db import models

from core.models import Staff


class Notification(models.Model):
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='notifications')
    kind = models.CharField(max_length=60)
    title = models.TextField()
    body = models.TextField(blank=True, default='')
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField()
    read_at = models.DateTimeField(null=True, blank=True)
    org_request = models.ForeignKey('organization.OrgRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    task = models.ForeignKey('tasks.Task', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    request = models.ForeignKey('tasks.TaskRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    due_request = models.ForeignKey('tasks.DueDateRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    # Meetings and personal calendar notes are referenced by ID only (notes can be deleted by their owner).
    meeting_id = models.CharField(max_length=60, null=True, blank=True)
    note_id = models.CharField(max_length=60, null=True, blank=True)

    class Meta:
        db_table = 'tm_notifications'
        indexes = [models.Index(fields=['staff', 'read_at', 'id'], name='tm_notification_staff'),
                   models.Index(fields=['meeting_id'], name='tm_notification_meeting')]


class NotificationDelivery(models.Model):
    """What happened to a notification on an outside channel (sent, skipped with a reason, or failed after retries)."""
    notification = models.ForeignKey(Notification, on_delete=models.PROTECT, related_name='deliveries')
    channel = models.CharField(max_length=20)
    status = models.CharField(max_length=10)
    reason = models.TextField(blank=True, default='')
    attempts = models.IntegerField(default=0)
    next_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_notification_deliveries'
        constraints = [models.UniqueConstraint(fields=['notification', 'channel'], name='tm_delivery_once'),
                       models.CheckConstraint(condition=models.Q(status__in=['PENDING', 'SENT', 'SKIPPED', 'FAILED']), name='tm_delivery_status_valid')]
        indexes = [models.Index(fields=['channel', 'status', 'next_at'], name='tm_delivery_retry')]

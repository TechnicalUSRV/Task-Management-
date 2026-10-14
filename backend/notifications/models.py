"""In-app notifications (V5.7.7 tm_notifications). Links to tasks, requests and meetings are added with those apps."""
from django.db import models

from core.models import Staff


class Notification(models.Model):
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='notifications')
    kind = models.CharField(max_length=60)
    title = models.CharField(max_length=500)
    body = models.TextField(blank=True, default='')
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField()
    read_at = models.DateTimeField(null=True, blank=True)
    org_request = models.ForeignKey('organization.OrgRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')

    class Meta:
        db_table = 'tm_notifications'
        indexes = [models.Index(fields=['staff', 'read_at', 'id'], name='tm_notification_staff')]

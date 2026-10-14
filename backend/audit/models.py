"""Task Management activity log (V5.7.7 tm_events): who changed which workspace, task, meeting, time entry or user."""
from django.db import models

from core.models import Staff


class ActivityEvent(models.Model):
    entity_type = models.CharField(max_length=30)
    entity_id = models.CharField(max_length=60)
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    action = models.CharField(max_length=200)
    detail = models.TextField(blank=True, default='')
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_events'
        indexes = [
            models.Index(fields=['entity_type', 'entity_id', 'id'], name='tm_event_entity'),
            models.Index(fields=['entity_id'], name='tm_event_entity_id'),
            models.Index(fields=['workspace', 'id'], name='tm_event_workspace'),
        ]

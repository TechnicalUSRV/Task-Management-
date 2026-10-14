"""Time entries (V5.7.7 tm_timesheets). Since V5.7.0 an entry may be independent of any task (an activity)."""
from django.db import models
from django.db.models import Q

from core.models import Staff


class TimeEntry(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    task = models.ForeignKey('tasks.Task', on_delete=models.PROTECT, null=True, blank=True, related_name='time_entries')
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    activity = models.CharField(max_length=300, blank=True, default='')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='time_entries')
    work_date = models.DateField()
    minutes = models.IntegerField()
    notes = models.TextField(blank=True, default='')
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_timesheets'
        constraints = [
            models.CheckConstraint(condition=Q(minutes__gte=1, minutes__lte=1440), name='tm_time_minutes_range'),
            # One entry per person, task and day. Filtered so independent entries (no task) are not limited to one:
            # SQL Server unique constraints treat NULLs as equal, unlike SQLite.
            models.UniqueConstraint(fields=['task', 'staff', 'work_date'], condition=Q(task__isnull=False), name='tm_time_once_per_day'),
        ]
        indexes = [models.Index(fields=['staff', 'work_date'], name='tm_time_date'),
                   models.Index(fields=['task'], name='tm_time_task')]

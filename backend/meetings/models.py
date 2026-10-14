"""Meetings, their people and approvals, and personal calendar notes (V5.7.7 tm_meetings and related tables)."""
from django.db import models
from django.db.models import F, Q

from core.models import Staff


class Meeting(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, related_name='meetings')
    task = models.ForeignKey('tasks.Task', on_delete=models.PROTECT, null=True, blank=True, related_name='meetings')
    activity_id = models.CharField(max_length=60, null=True, blank=True, unique=True)
    contact_id = models.CharField(max_length=60, null=True, blank=True)
    title = models.CharField(max_length=300)
    agenda = models.TextField(blank=True, default='')
    organizer = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='organized_meetings')
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    location = models.CharField(max_length=500, blank=True, default='')
    url = models.TextField(blank=True, default='')
    status = models.CharField(max_length=10)
    minutes_notes = models.TextField(blank=True, default='')
    reason = models.TextField(blank=True, default='')
    version = models.IntegerField(default=0)
    creation_key = models.CharField(max_length=200, null=True, blank=True, unique=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    share_scope = models.CharField(max_length=15, default='PARTICIPANTS')
    reminder_offsets = models.CharField(max_length=100, default='[]')
    created_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='created_by')

    class Meta:
        db_table = 'tm_meetings'
        constraints = [
            models.CheckConstraint(condition=Q(status__in=['SCHEDULED', 'COMPLETED', 'CANCELLED']), name='tm_meeting_status_valid'),
            models.CheckConstraint(condition=Q(share_scope__in=['PARTICIPANTS', 'WORKSPACE', 'COMPANY', 'SELECTED']), name='tm_meeting_share_valid'),
        ]
        indexes = [models.Index(fields=['start_at', 'end_at', 'status'], name='tm_meeting_dates'),
                   models.Index(fields=['workspace', 'status'], name='tm_meeting_workspace')]


class MeetingAttendee(models.Model):
    meeting = models.ForeignKey(Meeting, on_delete=models.PROTECT, related_name='attendees')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='meeting_attendance')

    class Meta:
        db_table = 'tm_attendees'
        constraints = [models.UniqueConstraint(fields=['meeting', 'staff'], name='tm_attendee_unique')]
        indexes = [models.Index(fields=['staff'], name='tm_attendee_staff')]


class MeetingShare(models.Model):
    meeting = models.ForeignKey(Meeting, on_delete=models.PROTECT, related_name='shares')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')

    class Meta:
        db_table = 'tm_meeting_shares'
        constraints = [models.UniqueConstraint(fields=['meeting', 'staff'], name='tm_meeting_share_unique')]
        indexes = [models.Index(fields=['staff'], name='tm_meeting_share_staff')]


class MeetingFollower(models.Model):
    meeting = models.ForeignKey(Meeting, on_delete=models.PROTECT, related_name='followers')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_meeting_followers'
        constraints = [models.UniqueConstraint(fields=['meeting', 'staff'], name='tm_meeting_follower_unique')]


class MeetingChange(models.Model):
    """A meeting edit waiting for another participant's approval (V5.7.0)."""
    id = models.CharField(max_length=60, primary_key=True)
    meeting = models.ForeignKey(Meeting, on_delete=models.PROTECT, related_name='changes')
    requested_by = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+', db_column='requested_by')
    approver = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    base_version = models.IntegerField()
    payload_json = models.TextField()
    source = models.CharField(max_length=10)
    status = models.CharField(max_length=10, default='PENDING')
    note = models.TextField(blank=True, default='')
    decision_note = models.TextField(blank=True, default='')
    decided_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='decided_by')
    decided_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField()
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'tm_meeting_changes'
        constraints = [
            models.CheckConstraint(condition=Q(status__in=['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']), name='tm_meeting_change_status'),
            models.CheckConstraint(condition=~Q(requested_by=F('approver')), name='tm_meeting_change_two_people'),
            models.UniqueConstraint(fields=['meeting'], condition=Q(status='PENDING'), name='tm_meeting_pending'),
        ]


class CalendarNote(models.Model):
    """A personal calendar note; visible to and changed by its owner only."""
    id = models.CharField(max_length=60, primary_key=True)
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='calendar_notes')
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True, default='')
    all_day = models.BooleanField(default=True)
    day = models.DateField()
    start_at = models.DateTimeField(null=True, blank=True)
    end_at = models.DateTimeField(null=True, blank=True)
    reminder_offsets = models.CharField(max_length=100, default='[]')
    done = models.BooleanField(default=False)
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_calendar_notes'
        indexes = [models.Index(fields=['staff', 'day'], name='tm_calendar_note_owner')]


class EventReminderSent(models.Model):
    """Meeting and note reminders already sent (one per person, offset and start time)."""
    kind = models.CharField(max_length=10)
    ref_id = models.CharField(max_length=60)
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    offset_min = models.IntegerField()
    start_at = models.DateTimeField()
    notification = models.ForeignKey('notifications.Notification', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_event_reminders'
        constraints = [models.UniqueConstraint(fields=['kind', 'ref_id', 'staff', 'offset_min', 'start_at'], name='tm_event_reminder_once'),
                       models.CheckConstraint(condition=Q(kind__in=['MEETING', 'NOTE']), name='tm_event_reminder_kind')]

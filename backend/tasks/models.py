"""Tasks and their workflow records (V5.7.7 tm_tasks and related tables), with V5.7.7 column names.

CRM links (activity_id, contact_id, related_type/related_id) are kept as plain columns so a later CRM migration can
attach them; the CRM module is switched off in this deployment, so new links are refused by the permission check.
Small settings lists (reminder_days, recurrence_rule) and approval snapshots (changes_json/payload_json) are stored
as validated JSON text, exactly as V5.7.7 sends them to the clients.
"""
from django.db import models
from django.db.models import Q

from core.models import Staff
from workspaces.models import Workspace

STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'CANCELLED']
PRIORITIES = ['HIGH', 'MEDIUM', 'LOW']
ANSWERS = ['PENDING', 'ACCEPTED', 'DECLINED']
REPEATS = ['', 'DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY']
SOURCES = ['WEB', 'TELEGRAM', 'MINIAPP', 'MIGRATION']


def person(related, column, null=True):
    return models.ForeignKey(Staff, on_delete=models.PROTECT, null=null, blank=null, related_name=related, db_column=column)


class Task(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    workspace = models.ForeignKey(Workspace, on_delete=models.PROTECT, related_name='tasks')
    activity_id = models.CharField(max_length=60, null=True, blank=True, unique=True)
    contact_id = models.CharField(max_length=60, null=True, blank=True)
    related_type = models.CharField(max_length=20, blank=True, default='')
    related_id = models.CharField(max_length=60, null=True, blank=True)
    visibility = models.CharField(max_length=16, default='PUBLIC', db_default='PUBLIC')
    governing_manager = person('+', 'governing_manager_id')
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default='')
    start_date = models.DateField()
    due_date = models.DateField()
    status = models.CharField(max_length=12)
    priority = models.CharField(max_length=6)
    progress = models.SmallIntegerField()
    estimate_minutes = models.IntegerField(default=0)
    reason = models.TextField(blank=True, default='')
    created_by = person('+', 'created_by', null=False)
    completed_at = models.DateTimeField(null=True, blank=True)
    version = models.IntegerField(default=0)
    creation_key = models.CharField(max_length=200, null=True, blank=True, unique=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    pic = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='tasks_in_charge')
    reviewer = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='tasks_reviewing')
    department = models.CharField(max_length=150, blank=True, default='')
    department_note = models.TextField(blank=True, default='')
    accepted_at = models.DateTimeField(null=True, blank=True)
    declined_at = models.DateTimeField(null=True, blank=True)
    declined_reason = models.TextField(blank=True, default='')
    stuck_at = models.DateTimeField(null=True, blank=True)
    stuck_by = person('+', 'stuck_by')
    stuck_reason = models.TextField(blank=True, default='')
    submitted_to = person('+', 'submitted_to')
    submitted_by = person('+', 'submitted_by')
    submitted_at = models.DateTimeField(null=True, blank=True)
    submit_note = models.TextField(blank=True, default='')
    closed_by = person('+', 'closed_by')
    request = models.ForeignKey('TaskRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    source = models.CharField(max_length=10, default='WEB')
    reviewer_status = models.CharField(max_length=10, default='ACCEPTED')
    reviewer_responded_at = models.DateTimeField(null=True, blank=True)
    reviewer_note = models.TextField(blank=True, default='')
    recurrence = models.CharField(max_length=10, blank=True, default='')
    recurrence_until = models.DateField(null=True, blank=True)
    series_id = models.CharField(max_length=60, null=True, blank=True)
    next_task_id = models.CharField(max_length=60, null=True, blank=True)
    scheduled_due = models.DateField(null=True, blank=True)
    series_anchor = models.SmallIntegerField(null=True, blank=True)
    assigned_by = person('+', 'assigned_by')
    reminder_days = models.CharField(max_length=100, default='[1]')
    recurrence_rule = models.CharField(max_length=500, default='{}')

    class Meta:
        db_table = 'tm_tasks'
        constraints = [
            models.CheckConstraint(condition=Q(status__in=STATUSES), name='tm_task_status_valid'),
            models.CheckConstraint(condition=Q(priority__in=PRIORITIES), name='tm_task_priority_valid'),
            models.CheckConstraint(condition=Q(progress__gte=0, progress__lte=100), name='tm_task_progress_range'),
            models.CheckConstraint(condition=Q(estimate_minutes__gte=0), name='tm_task_estimate_positive'),
            models.CheckConstraint(condition=~Q(status='COMPLETED') | Q(progress=100), name='tm_task_completed_progress'),
            models.CheckConstraint(condition=~Q(status='NOT_STARTED') | Q(progress=0), name='tm_task_not_started_progress'),
            models.CheckConstraint(condition=Q(reviewer_status__in=ANSWERS), name='tm_task_reviewer_status_valid'),
            models.CheckConstraint(condition=Q(recurrence__in=REPEATS), name='tm_task_recurrence_valid'),
            models.UniqueConstraint(fields=['series_id', 'scheduled_due'], name='tm_series_due_unique',
                                    condition=Q(series_id__isnull=False, scheduled_due__isnull=False)),
        ]
        indexes = [
            models.Index(fields=['workspace', 'status', 'due_date'], name='tm_task_dates'),
            models.Index(fields=['pic', 'status'], name='tm_task_pic'),
            models.Index(fields=['submitted_to', 'status'], name='tm_task_review'),
            models.Index(fields=['request'], name='tm_task_request'),
            models.Index(fields=['reviewer', 'reviewer_status'], name='tm_task_reviewer'),
            models.Index(fields=['series_id'], name='tm_task_series'),
            models.Index(fields=['assigned_by', 'status'], name='tm_task_assigner'),
            models.Index(fields=['created_by', 'status'], name='tm_task_creator'),
            models.Index(fields=['status', 'due_date'], name='tm_task_status_due'),
        ]


class TaskAssignee(models.Model):
    """The person in charge (first row) and supporting people, each with their answer (`tm_assignees`)."""
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='assignees')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='task_assignments')
    status = models.CharField(max_length=10, default='ACCEPTED')
    invited_by = person('+', 'invited_by')
    invited_at = models.DateTimeField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    response_note = models.TextField(blank=True, default='')

    class Meta:
        db_table = 'tm_assignees'
        constraints = [models.UniqueConstraint(fields=['task', 'staff'], name='tm_assignee_unique'),
                       models.CheckConstraint(condition=Q(status__in=ANSWERS), name='tm_assignee_status_valid')]
        indexes = [models.Index(fields=['staff', 'status'], name='tm_assignee_status')]


class TaskHistory(models.Model):
    """Every workflow step of a task, used for the audit trail and the monthly reports (`tm_task_history`)."""
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='history')
    kind = models.CharField(max_length=40)
    from_status = models.CharField(max_length=12, null=True, blank=True)
    to_status = models.CharField(max_length=12)
    progress = models.SmallIntegerField()
    stuck = models.BooleanField(default=False)
    due_date = models.DateField()
    note = models.TextField(blank=True, default='')
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    source = models.CharField(max_length=10, default='WEB')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_task_history'
        indexes = [models.Index(fields=['task', 'id'], name='tm_history_task'),
                   models.Index(fields=['kind', 'created_at'], name='tm_history_kind')]


class ChecklistItem(models.Model):
    """Steps of Work (`tm_checklist`)."""
    id = models.CharField(max_length=60, primary_key=True)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='checklist')
    position = models.IntegerField()
    title = models.CharField(max_length=300)
    done = models.BooleanField(default=False)
    done_by = person('+', 'done_by')
    done_at = models.DateTimeField(null=True, blank=True)
    created_by = person('+', 'created_by', null=False)
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_checklist'
        indexes = [models.Index(fields=['task', 'position'], name='tm_checklist_task')]


class TaskFile(models.Model):
    """Task attachments, up to 30 MB each, stored in the database like V5.7.7 (`tm_files`)."""
    id = models.CharField(max_length=60, primary_key=True)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='files')
    name = models.CharField(max_length=160)
    mime = models.CharField(max_length=120)
    size = models.IntegerField()
    content = models.BinaryField()
    uploaded_by = person('+', 'uploaded_by', null=False)
    source = models.CharField(max_length=10, default='WEB')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_files'
        indexes = [models.Index(fields=['task'], name='tm_file_task')]


class TaskRequest(models.Model):
    """A task asked of someone (`tm_requests`)."""
    id = models.CharField(max_length=60, primary_key=True)
    workspace = models.ForeignKey(Workspace, on_delete=models.PROTECT, null=True, blank=True, related_name='task_requests')
    visibility = models.CharField(max_length=16, default='PUBLIC', db_default='PUBLIC')
    governing_manager = person('+', 'governing_manager_id')
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default='')
    department = models.CharField(max_length=150, blank=True, default='')
    department_note = models.TextField(blank=True, default='')
    priority = models.CharField(max_length=6)
    proposed_due_date = models.DateField(null=True, blank=True)
    requested_by = person('+', 'requested_by', null=False)
    manager = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='received_task_requests')
    status = models.CharField(max_length=10)
    decision_note = models.TextField(blank=True, default='')
    decided_by = person('+', 'decided_by')
    decided_at = models.DateTimeField(null=True, blank=True)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    source = models.CharField(max_length=10, default='WEB')
    version = models.IntegerField(default=0)
    creation_key = models.CharField(max_length=200, null=True, blank=True, unique=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    doer = models.CharField(max_length=10, default='REQUESTER')

    class Meta:
        db_table = 'tm_requests'
        constraints = [
            models.CheckConstraint(condition=Q(priority__in=PRIORITIES), name='tm_request_priority_valid'),
            models.CheckConstraint(condition=Q(status__in=['PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN']), name='tm_request_status_valid'),
            models.CheckConstraint(condition=Q(doer__in=['RECEIVER', 'REQUESTER', 'DECIDE']), name='tm_request_doer_valid'),
        ]
        indexes = [models.Index(fields=['manager', 'status'], name='tm_request_manager'),
                   models.Index(fields=['requested_by', 'status'], name='tm_request_requester')]


class DueDateRequest(models.Model):
    """A supporting person's request for a new due date (`tm_due_requests`)."""
    id = models.CharField(max_length=60, primary_key=True)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='due_requests')
    requested_by = person('+', 'requested_by', null=False)
    decide_by = person('+', 'decide_by', null=False)
    current_due_date = models.DateField()
    proposed_due_date = models.DateField()
    reason = models.TextField()
    status = models.CharField(max_length=10)
    decision_note = models.TextField(blank=True, default='')
    decided_by = person('+', 'decided_by')
    decided_at = models.DateTimeField(null=True, blank=True)
    source = models.CharField(max_length=10, default='WEB')
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_due_requests'
        constraints = [models.CheckConstraint(condition=Q(status__in=['PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN']), name='tm_due_status_valid')]
        indexes = [models.Index(fields=['task', 'status'], name='tm_due_task'),
                   models.Index(fields=['decide_by', 'status'], name='tm_due_decider')]


class TaskChangeRequest(models.Model):
    """Two-party approval: a change asked by one side of a task and decided by the other (`tm_change_requests`)."""
    id = models.CharField(max_length=60, primary_key=True)
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='change_requests')
    kind = models.CharField(max_length=10)
    requested_by = person('+', 'requested_by', null=False)
    requester_side = models.CharField(max_length=10)
    approver = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    status = models.CharField(max_length=10)
    changes_json = models.TextField(default='[]')
    payload_json = models.TextField(default='{}')
    note = models.TextField(blank=True, default='')
    base_version = models.IntegerField()
    decision_note = models.TextField(blank=True, default='')
    decided_by = person('+', 'decided_by')
    decided_at = models.DateTimeField(null=True, blank=True)
    source = models.CharField(max_length=10, default='WEB')
    decision_source = models.CharField(max_length=10, null=True, blank=True)
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_change_requests'
        constraints = [
            models.CheckConstraint(condition=Q(kind__in=['UPDATE', 'COMPLETE', 'CANCEL']), name='tm_change_kind_valid'),
            models.CheckConstraint(condition=Q(requester_side__in=['PIC', 'ASSIGNER']), name='tm_change_side_valid'),
            models.CheckConstraint(condition=Q(status__in=['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CLOSED']), name='tm_change_status_valid'),
            # One change waits for approval per task.
            models.UniqueConstraint(fields=['task'], condition=Q(status='PENDING'), name='tm_change_one_pending'),
        ]
        indexes = [models.Index(fields=['task', 'status'], name='tm_change_task'),
                   models.Index(fields=['approver', 'status'], name='tm_change_approver')]


class TaskReminderSent(models.Model):
    """Deadline reminders already sent, so each is sent once (`tm_reminders`)."""
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='+')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    kind = models.CharField(max_length=30)
    due_date = models.DateField()
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_reminders'
        constraints = [models.UniqueConstraint(fields=['task', 'staff', 'kind', 'due_date'], name='tm_reminder_once')]



class TaskMember(models.Model):
    """Explicit sharing; never changes responsible roles or Workspace membership."""
    task = models.ForeignKey(Task, on_delete=models.PROTECT, related_name='members')
    staff = person('+', 'staff_id', null=False)
    permission = models.CharField(max_length=16, default='VIEWER')
    granted_by = person('+', 'granted_by', null=False)
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_task_members'
        constraints = [models.UniqueConstraint(fields=['task', 'staff'], name='tm_task_member_unique'),
                       models.CheckConstraint(condition=Q(permission__in=['VIEWER', 'CONTRIBUTOR']), name='tm_task_member_permission')]

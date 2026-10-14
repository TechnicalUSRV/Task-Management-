"""Employee profiles, reporting lines and Organizational Structure settings (V5.7.7 tm_profiles, org_*)."""
from django.db import models

from core.models import Staff


class OrgSettings(models.Model):
    """Whether Organizational Structure governance is initialized, and its revision (bumped by structural changes)."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    enabled = models.BooleanField(default=False)
    revision = models.BigIntegerField(default=0)
    initialized_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='initialized_by')
    initialized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'org_settings'
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name='org_settings_single_row')]


class OrgLevel(models.Model):
    """Configurable organization levels (1 = organization administrators, 2 = workspace managers, …)."""
    id = models.PositiveSmallIntegerField(primary_key=True)
    name = models.CharField(max_length=150)
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'org_levels'
        constraints = [models.CheckConstraint(condition=models.Q(id__gte=1, id__lte=1000), name='org_level_range')]


class Profile(models.Model):
    """Team profile for a staff member. `manager` is the reporting line that drives task visibility."""
    staff = models.OneToOneField(Staff, on_delete=models.PROTECT, primary_key=True, related_name='profile')
    email = models.CharField(max_length=200, blank=True, default='')
    phone = models.CharField(max_length=50, blank=True, default='')
    position = models.CharField(max_length=150, blank=True, default='')
    department = models.CharField(max_length=150, blank=True, default='')
    active = models.BooleanField(default=True)
    version = models.IntegerField(default=0)
    manager = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='direct_reports')
    timezone = models.CharField(max_length=60, blank=True, default='')
    sidebar_theme = models.CharField(max_length=40, blank=True, default='')
    nickname = models.CharField(max_length=100, blank=True, default='')
    org_level = models.ForeignKey(OrgLevel, on_delete=models.PROTECT, null=True, blank=True, db_column='org_level',
                                  related_name='profiles')

    class Meta:
        db_table = 'tm_profiles'
        indexes = [
            models.Index(fields=['manager'], name='tm_profile_manager'),
            models.Index(fields=['org_level', 'manager'], name='org_profile_level'),
            models.Index(fields=['active'], name='tm_profile_active'),
        ]
        constraints = [
            models.CheckConstraint(condition=~models.Q(manager=models.F('staff')), name='tm_profile_not_own_manager'),
        ]


CAPABILITIES = {
    'workspace_create': 'Create delegated workspaces',
    'workspace_manage': 'Manage owned workspaces',
    'membership_request': 'Request workspace membership',
    'delegate_request': 'Request further delegation',
    'structure_request': 'Request reporting changes',
    'collaborate_outside': 'Invite outside task/meeting participants',
}
REQUEST_KINDS = ['MEMBERSHIP', 'DELEGATION', 'STRUCTURE']
REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVIEW']
GRANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED']


class OrgTemplate(models.Model):
    """Owner title templates with the capabilities a delegation may include (`org_templates`)."""
    id = models.CharField(max_length=60, primary_key=True)
    name = models.CharField(max_length=100)
    capabilities_json = models.TextField()
    active = models.BooleanField(default=True)
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'org_templates'


class OrgRequest(models.Model):
    """Membership, delegation and reporting-structure requests awaiting a derived approver (`org_requests`)."""
    id = models.CharField(max_length=60, primary_key=True)
    kind = models.CharField(max_length=12)
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='org_requests')
    beneficiary = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    requester = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    approver = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    payload_json = models.TextField()
    reason = models.TextField()
    status = models.CharField(max_length=10, default='PENDING')
    decision_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='decision_by')
    decision_note = models.TextField(blank=True, default='')
    request_key = models.CharField(max_length=300, null=True, blank=True, unique=True)
    fingerprint = models.CharField(max_length=64)
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    decided_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'org_requests'
        constraints = [
            models.CheckConstraint(condition=models.Q(kind__in=REQUEST_KINDS), name='org_request_kind_valid'),
            models.CheckConstraint(condition=models.Q(status__in=REQUEST_STATUSES), name='org_request_status_valid'),
        ]
        indexes = [
            models.Index(fields=['approver', 'status'], name='org_request_approver'),
            models.Index(fields=['workspace', 'status'], name='org_request_workspace'),
            models.Index(fields=['fingerprint', 'status'], name='org_request_fingerprint'),
        ]


class OrgGrant(models.Model):
    """Approved, branch-scoped delegated authority (`org_grants`)."""
    id = models.CharField(max_length=60, primary_key=True)
    beneficiary = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='org_grants')
    template = models.ForeignKey(OrgTemplate, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    title = models.CharField(max_length=100)
    capabilities_json = models.TextField()
    branch_root = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='scoped_grants')
    governing_manager = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    parent_grant = models.ForeignKey('self', on_delete=models.PROTECT, null=True, blank=True, related_name='children')
    request = models.ForeignKey(OrgRequest, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    status = models.CharField(max_length=10, default='ACTIVE')
    granted_by = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+', db_column='granted_by')
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'org_grants'
        constraints = [models.CheckConstraint(condition=models.Q(status__in=GRANT_STATUSES), name='org_grant_status_valid')]
        indexes = [
            models.Index(fields=['beneficiary', 'status'], name='org_grant_beneficiary'),
            models.Index(fields=['parent_grant'], name='org_grant_parent'),
        ]


class OrgAudit(models.Model):
    """Append-only governance history. Database triggers (migration) refuse UPDATE and DELETE (`org_audit`)."""
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    action = models.CharField(max_length=60)
    employee = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    before_json = models.TextField()
    after_json = models.TextField()
    reason = models.TextField(blank=True, default='')
    approval = models.ForeignKey(OrgRequest, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'org_audit'
        indexes = [
            models.Index(fields=['employee', 'created_at'], name='org_audit_employee'),
            models.Index(fields=['workspace', 'created_at'], name='org_audit_workspace'),
        ]

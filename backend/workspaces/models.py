"""Workspaces and their members (V5.7.7 tm_workspaces, tm_members).

Privacy (V5.7.7, schema 19): `visibility` PERSONAL = owner and the Administrator role only; PUBLIC = owner, members,
the owner's real reporting managers and authorized Administration. `kind` keeps the governance model (LEGACY,
PERSONAL, ORGANIZATIONAL). Adding a non-owner member converts PERSONAL to PUBLIC atomically — enforced by database
triggers created in migration 0003, so every writer obeys it. Workspaces are never hard-deleted.
"""
from django.db import models
from django.db.models import Q

from core.models import Staff

KINDS = ['LEGACY', 'ORGANIZATIONAL', 'PERSONAL']
VISIBILITIES = ['PERSONAL', 'PUBLIC']
STATUSES = ['ACTIVE', 'ARCHIVED']
COLORS = ['BLUE', 'PURPLE', 'TEAL', 'ORANGE', 'PINK']
MEMBER_ROLES = ['MEMBER', 'VIEWER']


class Workspace(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default='')
    department = models.CharField(max_length=150, blank=True, default='')
    owner = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='owned_workspaces')
    color = models.CharField(max_length=20, default='BLUE')
    status = models.CharField(max_length=10, default='ACTIVE')
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    kind = models.CharField(max_length=20, default='LEGACY')
    governing_manager = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='governed_workspaces')
    origin_workspace = models.ForeignKey('self', on_delete=models.PROTECT, null=True, blank=True, related_name='derived_workspaces')
    owner_grant = models.ForeignKey('organization.OrgGrant', on_delete=models.PROTECT, null=True, blank=True, related_name='owned_workspaces')
    joinable = models.BooleanField(default=False)
    created_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='created_by')
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='deleted_by')
    deleted_from_status = models.CharField(max_length=10, null=True, blank=True)
    visibility = models.CharField(max_length=10, default='PUBLIC')

    class Meta:
        db_table = 'tm_workspaces'
        constraints = [
            # Case-insensitive on SQL Server (CI collation), as V5.7.7's COLLATE NOCASE; the service checks it too.
            models.UniqueConstraint(fields=['name'], name='tm_workspace_name_unique'),
            models.CheckConstraint(condition=Q(status__in=STATUSES), name='tm_workspace_status_valid'),
            models.CheckConstraint(condition=Q(kind__in=KINDS), name='tm_workspace_kind_valid'),
            models.CheckConstraint(condition=Q(visibility__in=VISIBILITIES), name='tm_workspace_visibility_valid'),
        ]
        indexes = [
            models.Index(fields=['owner', 'status'], name='tm_workspace_owner'),
            models.Index(fields=['governing_manager', 'kind'], name='org_workspace_governor'),
            models.Index(fields=['created_by', 'deleted_at'], name='org_workspace_creator'),
            models.Index(fields=['visibility', 'status'], name='tm_workspace_visibility'),
        ]


class WorkspaceMember(models.Model):
    workspace = models.ForeignKey(Workspace, on_delete=models.PROTECT, related_name='members')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='workspace_memberships')
    approved_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='approved_by')
    approval = models.ForeignKey('organization.OrgRequest', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    member_role = models.CharField(max_length=10, default='MEMBER')
    joined_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'tm_members'
        constraints = [
            models.UniqueConstraint(fields=['workspace', 'staff'], name='tm_member_unique'),
            models.CheckConstraint(condition=Q(member_role__in=MEMBER_ROLES), name='tm_member_role_valid'),
        ]
        indexes = [models.Index(fields=['staff'], name='tm_member_staff')]

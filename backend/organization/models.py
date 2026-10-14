"""Employee profiles, reporting lines and Organizational Structure settings (V5.7.7 tm_profiles, org_*)."""
from django.db import models

from core.models import Staff


class OrgSettings(models.Model):
    """Whether Organizational Structure governance is initialized, and its revision (bumped by structural changes)."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    enabled = models.BooleanField(default=False)
    revision = models.BigIntegerField(default=0)
    initialized_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
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

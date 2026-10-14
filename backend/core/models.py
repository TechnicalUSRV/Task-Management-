"""Company-wide records. Table names follow the V5.7.7 SQLite schema where a direct equivalent exists (see docs)."""
from django.db import models


class Company(models.Model):
    """The single company of this deployment (V5.7.7 `company`, one row with id=1)."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    name = models.CharField(max_length=200)
    address = models.CharField(max_length=500, blank=True, default='')
    phone = models.CharField(max_length=50, blank=True, default='')
    email = models.CharField(max_length=200, blank=True, default='')
    tax_id = models.CharField(max_length=100, blank=True, default='')
    currency = models.CharField(max_length=3, default='USD')

    class Meta:
        db_table = 'company'
        constraints = [
            models.CheckConstraint(condition=models.Q(id=1), name='company_single_row'),
            models.CheckConstraint(condition=models.Q(currency__in=['USD', 'KHR']), name='company_currency_valid'),
        ]


class Staff(models.Model):
    """An employee identity (V5.7.7 `lookups` rows with kind='staff'). Accounts, tasks and history point here."""
    id = models.CharField(max_length=60, primary_key=True)
    name = models.CharField(max_length=200)
    active = models.BooleanField(default=True)

    class Meta:
        db_table = 'staff'
        constraints = [models.UniqueConstraint(fields=['name'], name='staff_name_unique')]
        indexes = [models.Index(fields=['active'], name='staff_active')]

    def __str__(self):
        return self.name


class Sequence(models.Model):
    """Counters behind readable IDs such as STAFF-000001 and TASK-000123 (V5.7.7 `sequences`)."""
    kind = models.CharField(max_length=60, primary_key=True)
    value = models.BigIntegerField()

    class Meta:
        db_table = 'sequences'


class ModuleSetting(models.Model):
    """Company modules that can be switched on or off (V5.7.7 `erp_module_settings`)."""
    module_id = models.CharField(max_length=40, primary_key=True)
    enabled = models.BooleanField()
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'erp_module_settings'


class ChangeCounter(models.Model):
    """Advances on every committed change; open clients poll it (/api/changes) to know when to reload.

    V5.7.7 kept this counter in process memory. A database row lets several Django workers share it.
    """
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    seq = models.BigIntegerField(default=0)

    class Meta:
        db_table = 'change_counter'
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name='change_counter_single_row')]

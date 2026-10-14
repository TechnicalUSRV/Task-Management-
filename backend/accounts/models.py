"""Sign-in accounts, roles and function permissions (V5.7.7 access_* tables)."""
from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models
from django.db.models import Q

from core.models import Staff

EFFECTS = [('ALLOW', 'Allow'), ('DENY', 'Deny')]


class Role(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    name = models.CharField(max_length=150)
    description = models.CharField(max_length=2000, blank=True, default='')
    protected = models.BooleanField(default=False)
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'access_roles'
        # Case-insensitive uniqueness comes from SQL Server's default CI collation (V5.7.7: COLLATE NOCASE); the
        # service also checks it explicitly so SQLite tests behave the same.
        constraints = [models.UniqueConstraint(fields=['name'], name='access_role_name_unique')]


class RolePermission(models.Model):
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name='permissions')
    resource = models.CharField(max_length=60)
    action = models.CharField(max_length=20)

    class Meta:
        db_table = 'access_permissions'
        constraints = [models.UniqueConstraint(fields=['role', 'resource', 'action'], name='access_permission_unique')]


class UserManager(BaseUserManager):
    use_in_migrations = True


class User(AbstractBaseUser):
    """A login account linked to exactly one staff identity (V5.7.7 `access_users`)."""
    id = models.CharField(max_length=60, primary_key=True)
    # Wider than Django's default 128: an imported V5.7.x scrypt hash is 173 characters.
    password = models.CharField(max_length=256)
    staff = models.OneToOneField(Staff, on_delete=models.PROTECT, related_name='account')
    username = models.CharField(max_length=200)
    username_key = models.CharField(max_length=200, unique=True)
    email = models.CharField(max_length=200, blank=True, default='')
    role = models.ForeignKey(Role, on_delete=models.PROTECT, related_name='users')
    active = models.BooleanField(default=True)
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    USERNAME_FIELD = 'username_key'
    REQUIRED_FIELDS = []
    objects = UserManager()

    class Meta:
        db_table = 'access_users'
        constraints = [
            # Contact email is optional; supplied addresses stay unique (V5.7.1 migration 18).
            models.UniqueConstraint(fields=['email'], condition=~Q(email=''), name='access_contact_email_unique'),
        ]
        indexes = [models.Index(fields=['role', 'active'], name='access_user_role_active')]

    @property
    def is_active(self):
        return self.active

    @property
    def staff_id_value(self):
        return self.staff_id


class UserPermissionOverride(models.Model):
    """Individual ALLOW/DENY settings that adjust a user's role permissions (`access_user_permissions`)."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='overrides')
    resource = models.CharField(max_length=60)
    action = models.CharField(max_length=20)
    effect = models.CharField(max_length=5, choices=EFFECTS)

    class Meta:
        db_table = 'access_user_permissions'
        constraints = [
            models.UniqueConstraint(fields=['user', 'resource', 'action'], name='access_user_permission_unique'),
            models.CheckConstraint(condition=Q(effect__in=['ALLOW', 'DENY']), name='access_user_permission_effect'),
        ]


class AccessSession(models.Model):
    """A signed-in browser. Only the SHA-256 of the cookie token is stored."""
    token_hash = models.CharField(max_length=64, primary_key=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sessions')
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'access_sessions'
        indexes = [models.Index(fields=['user'], name='access_session_user'),
                   models.Index(fields=['expires_at'], name='access_session_expiry')]


class LoginAttempt(models.Model):
    """Failed sign-in counters per address+username, per username and per address (15-minute windows)."""
    key = models.CharField(max_length=64, primary_key=True)
    failures = models.IntegerField()
    window_start = models.DateTimeField()

    class Meta:
        db_table = 'access_attempts'


class AccessAudit(models.Model):
    """Account, role, permission and sign-in history (`access_audit`)."""
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    action = models.CharField(max_length=200)
    target_id = models.CharField(max_length=60)
    detail = models.TextField(blank=True, default='')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'access_audit'
        indexes = [models.Index(fields=['target_id', 'action'], name='access_audit_target')]

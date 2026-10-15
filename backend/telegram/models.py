"""Telegram connection (V5.7.7 telegram.sql). Telegram is another way into Task Management: task data stays in the task
tables; these hold only the bot settings, which Telegram account uses which login, linked groups and short conversation
steps. Telegram user and chat IDs exceed 32 bits, so they are BIGINT.
"""
from django.db import models
from django.db.models import Q

from core.models import Staff


class TelegramSettings(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    enabled = models.BooleanField(default=False)
    bot_token = models.CharField(max_length=400, blank=True, default='')   # encrypted, see sealed.py
    bot_id = models.BigIntegerField(null=True, blank=True)
    bot_username = models.CharField(max_length=100, blank=True, default='')
    bot_name = models.CharField(max_length=200, blank=True, default='')
    mini_app_url = models.CharField(max_length=300, blank=True, default='')
    digest_hour = models.SmallIntegerField(default=8)
    group_updates = models.BooleanField(default=True)
    last_update_id = models.BigIntegerField(default=0)
    last_notification_id = models.BigIntegerField(default=-1)
    last_history_id = models.BigIntegerField(default=-1)
    last_digest_date = models.CharField(max_length=10, blank=True, default='')
    status = models.CharField(max_length=20, default='OFF')
    status_detail = models.CharField(max_length=500, blank=True, default='')
    checked_at = models.DateTimeField(null=True, blank=True)
    version = models.IntegerField(default=0)
    updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'tg_settings'
        constraints = [models.CheckConstraint(condition=Q(id=1), name='tg_settings_single_row'),
                       models.CheckConstraint(condition=Q(digest_hour__gte=-1, digest_hour__lte=23), name='tg_digest_hour_range')]


class TelegramLink(models.Model):
    tg_user_id = models.BigIntegerField(primary_key=True)
    staff = models.OneToOneField(Staff, on_delete=models.PROTECT, related_name='telegram_link')
    chat_id = models.BigIntegerField(null=True, blank=True)
    username = models.CharField(max_length=64, blank=True, default='')
    first_name = models.CharField(max_length=128, blank=True, default='')
    notify = models.BooleanField(default=True)
    linked_at = models.DateTimeField()
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'tg_links'


class TelegramLinkCode(models.Model):
    """A personal connect link: works once, until used or replaced (V5.3: it does not expire)."""
    code_hash = models.CharField(max_length=64, primary_key=True)
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField()
    code = models.CharField(max_length=16, null=True, blank=True)

    class Meta:
        db_table = 'tg_link_codes'
        indexes = [models.Index(fields=['expires_at'], name='tg_code_expiry'), models.Index(fields=['staff'], name='tg_code_staff')]


class TelegramGroup(models.Model):
    chat_id = models.BigIntegerField(primary_key=True)
    title = models.CharField(max_length=200, blank=True, default='')
    type = models.CharField(max_length=20, default='group')
    workspace = models.ForeignKey('workspaces.Workspace', on_delete=models.PROTECT, null=True, blank=True, related_name='+')
    notify = models.BooleanField(default=True)
    active = models.BooleanField(default=True)
    linked_by = models.ForeignKey(Staff, on_delete=models.PROTECT, null=True, blank=True, related_name='+', db_column='linked_by')
    linked_at = models.DateTimeField(null=True, blank=True)
    seen_at = models.DateTimeField()
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'tg_groups'
        indexes = [models.Index(fields=['workspace', 'active'], name='tg_group_workspace')]


class TelegramSession(models.Model):
    """A short conversation step with the bot (20 minutes)."""
    chat_id = models.BigIntegerField()
    tg_user_id = models.BigIntegerField()
    flow = models.CharField(max_length=40)
    step = models.CharField(max_length=40)
    data = models.TextField(default='{}')
    message_id = models.BigIntegerField(null=True, blank=True)
    prompt_id = models.BigIntegerField(null=True, blank=True)
    expires_at = models.DateTimeField()

    class Meta:
        db_table = 'tg_sessions'
        constraints = [models.UniqueConstraint(fields=['chat_id', 'tg_user_id'], name='tg_session_unique')]


class TelegramLog(models.Model):
    level = models.CharField(max_length=10)
    chat_id = models.BigIntegerField(null=True, blank=True)
    message = models.CharField(max_length=1000)
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tg_log'

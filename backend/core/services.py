"""Small shared services: readable IDs, the change counter and the company record."""
from core.i18n import msg as _message
from django.db import IntegrityError, connection, transaction
from django.db.models import F

from .errors import fail
from .models import ChangeCounter, Company, Sequence, Staff


def next_id(kind, prefix):
    """The next readable ID for `kind`, e.g. next_id('staff', 'STAFF') -> 'STAFF-000001' (same format as V5.7.7).

    Must run inside a transaction; the row update locks the counter until commit, so concurrent requests never
    receive the same number.
    """
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError('next_id must be called inside a transaction')
    updated = Sequence.objects.filter(kind=kind).update(value=F('value') + 1)
    if not updated:
        try:
            with transaction.atomic():
                Sequence.objects.create(kind=kind, value=1)
        except IntegrityError:
            Sequence.objects.filter(kind=kind).update(value=F('value') + 1)
    value = Sequence.objects.get(kind=kind).value
    return f'{prefix}-{value:06d}'


WRITE_LOCK = 'task-management-writes'


def write_lock(timeout_ms=15000):
    """One change at a time, as in V5.7.7 (SQLite BEGIN IMMEDIATE): workflow rules read and then write several rows.

    On SQL Server this takes an exclusive application lock owned by the current transaction (sp_getapplock), so two
    commands — from two browser tabs, the Telegram bot and the reminder worker, or several server processes — never
    interleave; it is released at commit or rollback. Reads (the app state) do not take it. SQLite serializes writers itself.
    """
    if not transaction.get_connection().in_atomic_block:
        raise RuntimeError('write_lock must be taken inside a transaction')
    if connection.vendor != 'microsoft':
        return
    with connection.cursor() as c:
        c.execute("SET NOCOUNT ON; DECLARE @r int; EXEC @r = sp_getapplock @Resource = %s, @LockMode = 'Exclusive', "
                  "@LockOwner = 'Transaction', @LockTimeout = %s; SELECT @r", [WRITE_LOCK, int(timeout_ms)])
        result = c.fetchone()
    if result is None or result[0] < 0:
        fail(_message('The system is busy with other changes. Please try again in a moment.'), 503)


def changed():
    """Advance the change counter (call inside the command's transaction)."""
    if not ChangeCounter.objects.filter(id=1).update(seq=F('seq') + 1):
        ChangeCounter.objects.get_or_create(id=1, defaults={'seq': 1})


def change_seq():
    row = ChangeCounter.objects.filter(id=1).values_list('seq', flat=True).first()
    return row or 0


def company():
    return Company.objects.filter(id=1).first()


def active_staff(staff_id, message=_message('Choose an active person.')):
    """V5.7.7 lookup(id, 'staff'): an active staff member or a 400 with the standard message."""
    if not isinstance(staff_id, str):
        fail(message)
    person = Staff.objects.filter(id=staff_id, active=True).first()
    if not person:
        fail(message)
    return person

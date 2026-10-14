"""Small shared services: readable IDs, the change counter and the company record."""
from django.db import IntegrityError, transaction
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


def changed():
    """Advance the change counter (call inside the command's transaction)."""
    if not ChangeCounter.objects.filter(id=1).update(seq=F('seq') + 1):
        ChangeCounter.objects.get_or_create(id=1, defaults={'seq': 1})


def change_seq():
    row = ChangeCounter.objects.filter(id=1).values_list('seq', flat=True).first()
    return row or 0


def company():
    return Company.objects.filter(id=1).first()


def active_staff(staff_id, message='Choose an active person.'):
    """V5.7.7 lookup(id, 'staff'): an active staff member or a 400 with the standard message."""
    if not isinstance(staff_id, str):
        fail(message)
    person = Staff.objects.filter(id=staff_id, active=True).first()
    if not person:
        fail(message)
    return person

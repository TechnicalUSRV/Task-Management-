"""Company settings commands from service.mjs (V5.7.7): settings.save and lookup.save.

The Company settings page (Administration → Company settings) edits the company details and time zone, the approval
chain and the reference lists. Staff references are the `staff` table; the other kinds live in `reference_items`.
"""
from core.i18n import msg as _message
import re
from zoneinfo import available_timezones

from django.utils import timezone

from accounts.models import AccessAudit, User

from .errors import fail
from .models import REFERENCE_KINDS, ApprovalStep, Company, ReferenceItem, Staff
from .services import active_staff, next_id
from .validation import choice, text

ZONES = available_timezones() | {'UTC', 'Asia/Phnom_Penh'}
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')


def save_settings(d, actor):
    approvers = d.get('approvers')
    if not isinstance(approvers, list) or not approvers or len(approvers) > 5 or len(set(map(repr, approvers))) != len(approvers):
        fail('Select 1–5 different approvers.')
    for a in approvers:
        active_staff(a)
    email = text(d.get('email'), 'Email', 200)
    if email and not EMAIL.match(email):
        fail(_message('Enter a valid company email address.'))
    current = Company.objects.filter(id=1).first()
    zone = (current.timezone if current else '') if 'timezone' not in d else text(d['timezone'], 'Company time zone', 64)
    if zone and zone not in ZONES:
        fail(_message('Choose a valid company time zone (for example Asia/Phnom_Penh).'))
    values = {'name': text(d.get('name'), 'Company name', 200, True), 'address': text(d.get('address'), 'Address'),
              'phone': text(d.get('phone'), 'Phone', 50), 'email': email, 'tax_id': text(d.get('tax_id'), 'Tax ID', 50), 'timezone': zone}
    Company.objects.filter(id=1).update(**values)
    ApprovalStep.objects.all().delete()
    for i, a in enumerate(approvers):
        ApprovalStep.objects.create(step=i + 1, approver_id=a)
    AccessAudit.objects.create(actor_id=actor, action=_message('Company and future approval chain updated'), target_id='1',
                               detail=values['name'], created_at=timezone.now())
    return {'message': _message('Settings saved. Submitted requests keep their original approval chain.')}


def save_lookup(d, actor):
    kind = choice(d.get('kind'), ['staff', *REFERENCE_KINDS], _message('lookup type'))
    staff = kind == 'staff'
    key = d.get('id') or (next_id('staff', 'STAFF') if staff else next_id('reference', 'REF'))
    if d.get('id'):
        exists = Staff.objects.filter(id=key).exists() if staff else ReferenceItem.objects.filter(id=key, kind=kind).exists()
        if not exists:
            fail(_message('Lookup not found.'), 404)
    name, unit = text(d.get('name'), 'Name', 200, True), text(d.get('unit'), 'Unit', 30)
    account_name = User.objects.filter(staff_id=key).values_list('username', flat=True).first() if staff else None
    if account_name and name != account_name:
        fail(_message('Display names come from usernames. Use Administration → User accounts to manage another user’s username.'), 403)
    taken = (Staff.objects.filter(name=name).exclude(id=key) if staff
             else ReferenceItem.objects.filter(kind=kind, name=name).exclude(id=key)).exists()
    if taken:
        fail(_message('“{p0}” is already used for another {p1} reference.', p0=name, p1=kind.replace("_", " ")), 409)
    if staff:
        if d.get('id'):
            Staff.objects.filter(id=key).update(name=name, active=True)
        else:
            Staff.objects.create(id=key, name=name, active=True)
    elif d.get('id'):
        ReferenceItem.objects.filter(id=key).update(name=name, unit=unit, active=True)
    else:
        ReferenceItem.objects.create(id=key, kind=kind, name=name, unit=unit, active=True)
    return {'message': _message('Reference saved.')}


def lookups():
    """The `lookups` list the frontend reads: staff first, then the other reference lists (V5.7.7 shape)."""
    out = [{'id': s['id'], 'kind': 'staff', 'name': s['name'], 'unit': '', 'active': 1 if s['active'] else 0}
           for s in Staff.objects.order_by('id').values('id', 'name', 'active')]
    out += [{'id': r['id'], 'kind': r['kind'], 'name': r['name'], 'unit': r['unit'], 'active': 1 if r['active'] else 0}
            for r in ReferenceItem.objects.order_by('id').values('id', 'kind', 'name', 'unit', 'active')]
    return out

"""Meetings, meeting change approvals, following a shared meeting, personal calendar notes and their reminders.

A port of the meeting and calendar parts of tasks.mjs and of meeting-workflow.mjs (V5.7.7). It works through the
TaskService of the same command (same governance, scope and helpers), so a meeting command behaves exactly like the
original inside one transaction.
"""
from core.i18n import msg as _message, join_messages
import json
import re
from datetime import datetime, timedelta, timezone as dt_timezone
from urllib.parse import quote, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from accounts.models import User
from core.errors import InputError, fail
from core.rows import insert, row, update
from core.services import active_staff, next_id
from core.validation import choice, date_text, iso, text
from notifications.models import Notification
from organization.governance import is_personal_workspace, jtext
from tasks import domain as dm
from tasks.models import Task

from .models import CalendarNote, EventReminderSent, Meeting, MeetingAttendee, MeetingChange, MeetingFollower, MeetingShare

MAX_OFFSET = 30 * 1440
INSTANT = re.compile(r'T.*(Z|[+-]\d{2}:\d{2})$')


def instant(value, label):
    """V5.7.7 instant(): an ISO date-time with a time zone. Kept in the form browsers send (…T09:00:00.000Z)."""
    s = text(value, label, 40, True)
    try:
        moment = datetime.fromisoformat(s.replace('Z', '+00:00')) if INSTANT.search(s) else None
    except ValueError:
        moment = None
    if moment is None or moment.tzinfo is None:
        fail(_message('Enter a valid {p0} with a timezone.', p0=label))
    date_text(s[:10], label)
    return iso(moment)


def ms(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def offsets_input(value, label=_message('Reminders')):
    if value is None or value == '':
        return []
    if isinstance(value, str) and re.match(r'^\s*\[', value):
        try:
            value = json.loads(value)
        except ValueError:
            fail(_message('{p0}: choose up to five reminders.', p0=label))
    if not isinstance(value, list) or len(value) > 5:
        fail(_message('{p0}: choose up to five reminders.', p0=label))
    from core.validation import js_number
    numbers = list(dict.fromkeys(js_number(n) for n in value))
    for n in numbers:
        if isinstance(n, float) and (n != n or not n.is_integer()) or n < 0 or n > MAX_OFFSET:
            fail(_message('{p0}: each reminder is 0 minutes to 30 days before the start.', p0=label))
    return sorted((int(n) for n in numbers), reverse=True)


def offset_text(n):
    if n == 0:
        return _message('at the start')
    if n % 1440 == 0:
        return _message('{p0} day before', p0=n // 1440) if n == 1440 else _message('{p0} days before', p0=n // 1440)
    if n % 60 == 0:
        return _message('{p0} hour before', p0=n // 60) if n == 60 else _message('{p0} hours before', p0=n // 60)
    return _message('{p0} minute before', p0=n) if n == 1 else _message('{p0} minutes before', p0=n)


def zone_label(zone):
    return 'UTC' if zone == 'UTC' else _message('{p0} time', p0=zone.split('/')[-1].replace('_', ' '))


def past_offsets(start, offsets):
    now = timezone.now().timestamp() * 1000
    return [n for n in offsets if ms(start) - n * 60000 < now - 60000]


def meeting_url(value):
    """new URL(value).href for http(s) meeting links, without credentials (WHATWG serialization of common URLs)."""
    try:
        parts = urlsplit(value)
        host = parts.hostname
        port = parts.port
    except ValueError:
        fail(_message('Enter a complete meeting URL.'))
    if not parts.scheme or not re.fullmatch(r'[A-Za-z][A-Za-z0-9+.-]*', parts.scheme):
        fail(_message('Enter a complete meeting URL.'))
    scheme = parts.scheme.lower()
    if scheme in ('http', 'https') and not host:
        fail(_message('Enter a complete meeting URL.'))
    if scheme not in ('http', 'https') or parts.username or parts.password:
        fail(_message('Use an http or https meeting URL without credentials.'))
    try:
        host = host.encode('idna').decode('ascii').lower()
    except UnicodeError:
        fail(_message('Enter a complete meeting URL.'))
    netloc = host + (f':{port}' if port and port != {'http': 80, 'https': 443}[scheme] else '')
    safe = "/:@!$&'()*+,;=-._~%"
    path = quote(parts.path or '/', safe=safe)
    query = quote(parts.query, safe=safe + '?')
    fragment = quote(parts.fragment, safe=safe + '?#')
    href = urlunsplit((scheme, netloc, path, query, fragment))
    if '?' in value and not parts.query:
        href = href.split('#')[0] + '?' + (('#' + fragment) if '#' in value else '')
    if '#' in value and not parts.fragment:
        href += '#'
    return href


class MeetingService:
    def __init__(self, tasks):
        self.t = tasks
        self.gov, self.scope = tasks.gov, tasks.scope

    # ------------------------------------------------------------ helpers
    def is_participant(self, m, staff):
        return m['organizer_id'] == staff or m.get('created_by') == staff or MeetingAttendee.objects.filter(meeting_id=m['id'], staff_id=staff).exists()

    def attendees_of(self, key, ordered=False):
        qs = MeetingAttendee.objects.filter(meeting_id=key)
        return list(qs.order_by('staff_id' if ordered else 'id').values_list('staff_id', flat=True))

    def shares_of(self, key):
        return list(MeetingShare.objects.filter(meeting_id=key).order_by('id').values_list('staff_id', flat=True))

    def followers_of(self, key):
        return list(MeetingFollower.objects.filter(meeting_id=key).order_by('id').values_list('staff_id', flat=True))

    def people(self, values, wid, actor, known=()):
        if not isinstance(values, list) or not values or len(values) > 100:
            fail('Choose 1–100 people.')
        ids = list(dict.fromkeys(values))
        for key in ids:
            self.t.profile(key)
            if wid and key not in known:
                self.t.ensure_member(wid, key, actor, _message('invited to a meeting'))
        return ids

    def when(self, start, staff):
        zone = self.t.zone_of(staff)
        return _message('{p0} ({p1})', p0=dm.at_text(start, zone), p1=zone_label(zone))

    def tell(self, staff_ids, kind, actor, title, body, meeting_id):
        for staff in dict.fromkeys(x for x in staff_ids if x and x != actor):
            Notification.objects.create(staff_id=staff, kind=kind, meeting_id=meeting_id, title=title, body=body, actor_id=actor,
                                        created_at=timezone.now())

    # ------------------------------------------------------------ saveMeeting
    def save(self, d, actor, source):
        old = self.t.find(Meeting, d['id']) if d.get('id') else None
        if old:
            if not self.scope.can_see_meeting(actor, old):
                self.t.hidden()
            self.t.check_version(old, d.get('expected_version'))
            if not self.is_participant(old, actor):
                fail(_message('Only the organizer and the attendees can change this meeting. It is shared with you to view.'), 403)
        manager = not old or self.is_participant(old, actor)
        creation_key = f"{actor}:{text(d['request_key'], 'Creation key', 100, True)}" if not old and d.get('request_key') else None
        if creation_key:
            duplicate = Meeting.objects.filter(creation_key=creation_key).values('id', 'workspace_id').first()
            if duplicate:
                if duplicate['workspace_id'] != d.get('workspace_id'):
                    fail(_message('Creation key already belongs to another workspace.'))
                return {'id': duplicate['id'], 'type': 'tm_meeting'}
        w = self.t.active_workspace(old['workspace_id'] if old else d.get('workspace_id'))
        key = old['id'] if old else next_id('tm-meeting', 'MEET')
        if not old and not self.gov.can_create_resource(actor, w):
            fail(_message('Join this workspace before scheduling a meeting in it.'), 403)
        if (old or {}).get('activity_id') or d.get('activity_id'):
            fail(_message('Links to CRM activities are not available in this installation.'), 403)
        task = self.t.task(d['task_id']) if d.get('task_id') else None
        if not task and (old or {}).get('task_id'):
            linked = row(Task.objects.filter(id=old['task_id']).first())
            if linked and ('task_id' not in d or not self.scope.can_see(actor, linked)):
                task = linked
        if task and task['id'] != (old or {}).get('task_id') and not self.scope.can_see(actor, task):
            self.t.hidden()
        if task and task['workspace_id'] != w['id']:
            fail(_message('Choose a task from the same workspace.'))
        if d.get('attendee_ids') not in (None, False, '', 0) and not isinstance(d['attendee_ids'], list):
            fail('Select meeting attendees.')
        status0 = choice(d.get('status') or 'SCHEDULED', ['SCHEDULED', 'COMPLETED', 'CANCELLED'], _message('meeting status'))
        known = self.attendees_of(old['id']) if old and not (status0 == 'SCHEDULED' and old['status'] != 'SCHEDULED') else []
        organizer = self.t.lookup((d.get('organizer_id') if d.get('organizer_id') is not None else old['organizer_id']) if old
                                  else (d.get('organizer_id') or actor))
        listed = d.get('attendee_ids')
        chosen = listed if listed not in (None, False, '', 0) else (self.attendees_of(old['id']) if old else [])
        attendees = self.people(list(dict.fromkeys([*chosen, organizer])), w['id'], actor, known)
        start, end = instant(d.get('start_at'), _message('Meeting start')), instant(d.get('end_at'), _message('Meeting end'))
        if end <= start:
            fail(_message('Meeting end must be after its start.'))
        if ms(end) - ms(start) > 7 * 86400000:
            fail(_message('Meetings cannot last longer than seven days.'))
        status = choice(d.get('status') or 'SCHEDULED', ['SCHEDULED', 'COMPLETED', 'CANCELLED'], _message('meeting status'))
        now_ms = timezone.now().timestamp() * 1000
        if status == 'SCHEDULED' and (not old or old['start_at'] != start or old['status'] != 'SCHEDULED') and ms(start) < now_ms - 5 * 60000:
            fail(_message('Choose a start time that is still ahead.'))
        if status == 'SCHEDULED':
            for staff in attendees:
                if MeetingAttendee.objects.filter(staff_id=staff, meeting__status='SCHEDULED', meeting__start_at__lt=parse(end),
                                                  meeting__end_at__gt=parse(start)).exclude(meeting_id=key).exists():
                    fail(_message('{p0} already has a scheduled meeting during this time.', p0=self.t.name_of(staff)))
        url = text(d.get('url'), 'Meeting URL', 2000)
        if url:
            url = meeting_url(url)
        if d.get('share_scope') is None:
            share = 'SELECTED' if (old or {}).get('share_scope') == 'SELECTED' else 'PARTICIPANTS'
        else:
            share = choice(d['share_scope'], ['PARTICIPANTS', 'SELECTED'], _message('sharing option'))
        share_ids = []
        if share == 'SELECTED':
            chosen_shares = self.shares_of(key) if 'share_ids' not in d else d['share_ids']
            if not isinstance(chosen_shares, list) or len(chosen_shares) > 100:
                fail(_message('Choose up to 100 people to share the meeting with.'))
            share_ids = [x for x in dict.fromkeys(chosen_shares) if x not in attendees]
            for x in share_ids:
                self.t.lookup(x)
            if not share_ids:
                fail(_message('Choose the people to share this meeting with, or keep it visible to its participants only.'))
        if self.gov.governed(w):
            if share == 'COMPANY' and is_personal_workspace(w):
                fail(_message('A personal workspace meeting can be shared with named people, not the whole company.'), 403)
            if share == 'COMPANY' and share != (old or {}).get('share_scope') and not self.gov.can_collaborate_outside(actor, w):
                fail(_message('Company sharing requires outside-collaboration authority.'), 403)
            previous = set(self.shares_of(old['id'])) if old else set()
            for target in share_ids:
                self.gov.check_collaborator(actor, w, target, existing=target in previous)
        if 'reminder_offsets' not in d:
            offsets = json.loads(old['reminder_offsets'] or '[]') if old else []
        else:
            offsets = offsets_input(d['reminder_offsets'])
        if old and not manager:
            before = set(self.attendees_of(old['id']))
            share_before = self.shares_of(old['id'])

            def same(a, b):
                return str('' if a is None else a) == str('' if b is None else b)
            from tasks.services import same_value
            moved = (not same(organizer, old['organizer_id']) or len(attendees) != len(before) or any(x not in before for x in attendees)
                     or not same(start, old['start_at']) or not same(end, old['end_at'])
                     or not same(text(d.get('title'), 'Meeting title', 300, True), old['title'])
                     or not same(text(d.get('agenda'), 'Agenda', 8000), old['agenda']) or not same(text(d.get('location'), 'Location', 500), old['location'])
                     or not same(url, old['url']) or share != old['share_scope'] or not same_value(share_ids, share_before if share == 'SELECTED' else [])
                     or not same((task or {}).get('id'), old['task_id']) or status == 'CANCELLED' or (status == 'SCHEDULED' and old['status'] != 'SCHEDULED'))
            if moved:
                also = _message(' or {p0}', p0=self.t.name_of(old['created_by'])) if old.get('created_by') and old['created_by'] != old['organizer_id'] else ''
                fail(_message('Only {p0} (the organizer){p1} can change this meeting’s time, people or details, or cancel it. You can complete it with notes or change its reminders.', p0=self.t.name_of(old['organizer_id']), p1=also), 403)
        timing = not old or old['start_at'] != start or old['reminder_offsets'] != jtext(offsets) or old['status'] != status
        if status == 'SCHEDULED' and timing:
            late = past_offsets(start, offsets)
            if late:
                fail(_message('The reminder {p0} would already be in the past. Choose a shorter reminder, or none.', p0=join_messages(_message(' and '), (offset_text(n) for n in late))), 422)
        values = {'workspace_id': w['id'], 'task_id': (task or {}).get('id'), 'activity_id': None, 'contact_id': (task or {}).get('contact_id'),
                  'title': text(d.get('title'), 'Meeting title', 300, True), 'agenda': text(d.get('agenda'), 'Agenda', 8000), 'organizer_id': organizer,
                  'start_at': start, 'end_at': end, 'location': text(d.get('location'), 'Location', 500), 'url': url, 'status': status,
                  'minutes_notes': text(d.get('minutes_notes'), 'Meeting notes / decisions', 8000),
                  'reason': text(d.get('reason'), 'Cancellation reason', 1000, status == 'CANCELLED'), 'share_scope': share,
                  'reminder_offsets': jtext(offsets), 'version': old['version'] + 1 if old else 0, 'updated_at': iso(timezone.now())}
        if old:
            update(Meeting, key, values)
        else:
            insert(Meeting, {'id': key, **values, 'creation_key': creation_key, 'created_by': actor, 'created_at': iso(timezone.now())})
        before = self.attendees_of(key) if old else []
        MeetingAttendee.objects.filter(meeting_id=key).delete()
        for staff in attendees:
            MeetingAttendee.objects.create(meeting_id=key, staff_id=staff)
        MeetingShare.objects.filter(meeting_id=key).delete()
        for staff in share_ids:
            MeetingShare.objects.create(meeting_id=key, staff_id=staff)
        current = {**values, 'id': key}
        for f in self.followers_of(key):
            if not self.scope.can_see_meeting(f, current):
                MeetingFollower.objects.filter(meeting_id=key, staff_id=f).delete()
        title = values['title']
        invited = [x for x in attendees if x not in before]
        if status == 'SCHEDULED':
            for staff in invited:
                self.tell([staff], 'meeting_invited', actor, f'Meeting: {title}',
                          _message('{p0} invited you · {p1}{p2}', p0=self.t.name_of(actor), p1=self.when(start, staff), p2=' · ' + values['location'] if values['location'] else ''), key)
        followers = self.followers_of(key) if old else []
        if old and status == 'SCHEDULED' and (old['start_at'] != start or old['end_at'] != end):
            for staff in dict.fromkeys([*[x for x in attendees if x in before], *followers]):
                self.tell([staff], 'meeting_updated', actor, _message('Meeting moved: {p0}', p0=title), _message('{p0} moved it to {p1}', p0=self.t.name_of(actor), p1=self.when(start, staff)), key)
        if old and old['status'] != 'CANCELLED' and status == 'CANCELLED':
            self.tell([*attendees, *followers], 'meeting_cancelled', actor, _message('Meeting cancelled: {p0}', p0=title), f"{self.t.name_of(actor)}: {values['reason']}", key)
        if old and old['status'] == 'SCHEDULED':
            for staff in before:
                if staff not in attendees and staff != actor:
                    Notification.objects.create(staff_id=staff, kind='meeting_updated', meeting_id=None, title=_message('Removed from a meeting: {p0}', p0=title),
                                                body=_message('{p0} took you off this meeting ({p1}).', p0=self.t.name_of(actor), p1=dm.at_text(start, self.t.zone_of(staff))),
                                                actor_id=actor, created_at=timezone.now())
        shared = {'WORKSPACE': _message('the workspace'), 'COMPANY': _message('the company'), 'SELECTED': f'{len(share_ids)} people'}
        self.t.log(actor, 'meeting', key, w['id'], _message('Meeting updated') if old else _message('Meeting scheduled'),
                   f"{title} · {status}{_message(' · shared with ') + shared[share] if share != 'PARTICIPANTS' else ''}")
        return {'id': key, 'type': 'tm_meeting'}

    # ------------------------------------------------------------ following a shared meeting
    def follow(self, d, actor):
        m = self.t.find(Meeting, d.get('id'))
        if not self.scope.can_see_meeting(actor, m):
            self.t.hidden()
        on = d.get('follow') is True or d.get('follow') == 1
        if self.is_participant(m, actor):
            return {'id': m['id'], 'type': 'tm_meeting', 'message': _message('You get this meeting’s reminders as a participant.'), 'unchanged': True}
        was = MeetingFollower.objects.filter(meeting_id=m['id'], staff_id=actor).exists()
        if was == on:
            return {'id': m['id'], 'type': 'tm_meeting', 'message': _message('You already get its reminders.') if on else _message('You don’t get its reminders.'), 'unchanged': True}
        if on:
            MeetingFollower.objects.create(meeting_id=m['id'], staff_id=actor, created_at=timezone.now())
        else:
            MeetingFollower.objects.filter(meeting_id=m['id'], staff_id=actor).delete()
        return {'id': m['id'], 'type': 'tm_meeting',
                'message': _message('You will get this meeting’s reminders.') if on else _message('You will no longer get this meeting’s reminders.')}

    # ------------------------------------------------------------ personal calendar notes
    def note_moment(self, day, staff):
        """09:00 on the note's day in its owner's time zone (computed exactly as V5.7.7 does)."""
        zone = ZoneInfo(self.t.zone_of(staff))
        guess = datetime.fromisoformat(f'{day}T09:00:00+00:00')
        shown = guess.astimezone(zone).replace(tzinfo=dt_timezone.utc, second=0, microsecond=0)
        return iso(guess - (shown - guess))

    def calendar_note(self, action, d, actor):
        old = row(CalendarNote.objects.filter(id=str(d['id'])).first()) if d.get('id') else None
        if d.get('id') and (not old or old['staff_id'] != actor):
            self.t.hidden()
        if action == 'tm.calnote.delete':
            if not old:
                self.t.hidden()
            self.t.check_version(old, d.get('expected_version'))
            CalendarNote.objects.filter(id=old['id']).delete()
            EventReminderSent.objects.filter(kind='NOTE', ref_id=old['id']).delete()
            return {'id': old['id'], 'type': 'tm_calnote', 'message': _message('Note deleted.')}
        if old:
            self.t.check_version(old, d.get('expected_version'))
        all_day = (bool(old['all_day']) if old else True) if 'all_day' not in d else (d['all_day'] is True or d['all_day'] == 1)
        start = end = None
        if all_day:
            day = date_text(d.get('day'), _message('Date'))
        else:
            start = instant(d.get('start_at'), _message('Start'))
            end = instant(d['end_at'], _message('End')) if d.get('end_at') else None
            if end and end < start:
                fail(_message('The end must be after the start.'))
            day = datetime.fromisoformat(start.replace('Z', '+00:00')).astimezone(ZoneInfo(self.t.zone_of(actor))).strftime('%Y-%m-%d')
        offsets = (json.loads(old['reminder_offsets'] or '[]') if old else []) if 'reminder_offsets' not in d else offsets_input(d['reminder_offsets'])
        done = 1 if d.get('done') is True or d.get('done') == 1 else 0
        moment = self.note_moment(day, actor) if all_day else start
        timing = (not old or old['day'] != day or old['start_at'] != start or old['reminder_offsets'] != jtext(offsets)
                  or old['all_day'] != (1 if all_day else 0))
        if not done and timing:
            late = past_offsets(moment, offsets)
            if late:
                fail(_message('The reminder {p0} would already be in the past. Choose a shorter reminder, or none.', p0=join_messages(_message(' and '), (offset_text(n) for n in late))), 422)
        key = old['id'] if old else next_id('tm-calnote', 'NOTE')
        values = {'title': text(d.get('title'), 'Title', 200, True), 'body': text(d.get('body'), 'Note', 4000), 'all_day': 1 if all_day else 0, 'day': day,
                  'start_at': start, 'end_at': end, 'reminder_offsets': jtext(offsets), 'done': done, 'version': old['version'] + 1 if old else 0,
                  'updated_at': iso(timezone.now())}
        if old:
            update(CalendarNote, key, values)
        else:
            insert(CalendarNote, {'id': key, 'staff_id': actor, **values, 'created_at': iso(timezone.now())})
        return {'id': key, 'type': 'tm_calnote', 'message': _message('Note saved.') if old else _message('Note added to your calendar.')}

    # ------------------------------------------------------------ meeting change approvals (meeting-workflow.mjs)
    def active_reviewer(self, who):
        return bool(self.gov.can_staff(who, 'tasks.meetings', 'view')) and User.objects.filter(staff_id=who, active=True).exists()

    def eligible(self, m, who):
        return self.is_participant(m, who) and self.active_reviewer(who)

    def meeting(self, key):
        found = row(Meeting.objects.filter(id=key).first()) if isinstance(key, str) else None
        if not found:
            fail(_message('Meeting not found.'), 404)
        return found

    def workflow_tell(self, m, who, actor, title):
        Notification.objects.create(staff_id=who, kind='meeting_change', meeting_id=m['id'], title=title, body=m['title'], actor_id=actor,
                                    created_at=timezone.now())

    def request(self, d, actor, source):
        if not d.get('id'):
            return self.save(d, actor, source)
        m = self.meeting(d['id'])
        if not self.scope.can_see_meeting(actor, m):
            fail(_message('Meeting not found.'), 404)
        if not self.eligible(m, actor) or not self.gov.can_staff(actor, 'tasks.meetings', 'update'):
            fail(_message('Only authorized participants can request meeting changes.'), 403)
        self.t.check_version(m, d.get('expected_version'))
        if MeetingChange.objects.filter(meeting_id=m['id'], status='PENDING').exists():
            fail(_message('Decide or withdraw the pending meeting change first.'), 409)
        # Validate every field, conflicts, memberships and linked-record rights without keeping any side effect.
        preview = None
        try:
            with transaction.atomic():
                self.save(d, actor, source)
                preview = {**self.meeting(m['id']), 'attendee_ids': self.attendees_of(m['id']), 'share_ids': self.shares_of(m['id'])}
                raise _Preview()
        except _Preview:
            pass
        finally:
            self.gov.invalidate()
        changes = [{'field': k, 'from': m.get(k), 'to': v} for k, v in preview.items()
                   if k not in ('version', 'updated_at', 'attendee_ids', 'share_ids') and jtext(v) != jtext(m.get(k))]
        for field, before in (('attendee_ids', self.attendees_of(m['id'])), ('share_ids', self.shares_of(m['id']))):
            before, after = sorted(before), sorted(preview[field])
            if jtext(before) != jtext(after):
                changes.append({'field': field, 'from': before, 'to': after})
        if not changes:
            return {'id': m['id'], 'type': 'tm_meeting', 'unchanged': True, 'message': _message('Nothing was changed.')}
        candidates = [x for x in [m['organizer_id'], m['created_by'], *self.attendees_of(m['id'], ordered=True), *preview['attendee_ids']]
                      if x != actor and self.active_reviewer(x)]
        approver = d.get('approver_id') or (candidates[0] if candidates else None)
        if not approver or approver not in candidates:
            fail(_message('Invite another active participant to approve this change. The meeting remains unchanged until they approve.'), 409)
        key = next_id('tm-meeting-change', 'MCHANGE')
        MeetingChange.objects.create(id=key, meeting_id=m['id'], requested_by_id=actor, approver_id=approver, base_version=m['version'],
                                     payload_json=jtext({'data': d, 'changes': changes}), source=source,
                                     note=text(d.get('change_note'), 'Reason for change', 1000), created_at=timezone.now())
        self.t.log(actor, 'meeting', m['id'], m['workspace_id'], _message('Meeting change requested'), jtext({'request': key, 'approver': approver, 'changes': changes}))
        self.workflow_tell(m, approver, actor, _message('Meeting change awaiting your approval: {p0}', p0=m['title']))
        return {'id': m['id'], 'type': 'tm_meeting', 'change_id': key,
                'message': _message('Sent to {p0} for approval. The meeting stays unchanged until approved.', p0=self.t.name_of(approver))}

    def decide(self, action, d, actor, source):
        q = row(MeetingChange.objects.filter(id=str(d.get('id') or '')).first())
        if not q:
            fail(_message('Change request not found.'), 404)
        m = self.meeting(q['meeting_id'])
        if not self.scope.can_see_meeting(actor, m) or actor not in (q['requested_by'], q['approver_id']):
            fail(_message('Change request not found.'), 404)
        withdrawing = action == 'tm.meeting.withdraw'
        if (q['requested_by'] != actor) if withdrawing else (q['approver_id'] != actor or q['requested_by'] == actor):
            fail(_message('Only the other designated party can decide this request.'), 403)
        if q['status'] != 'PENDING':
            fail(_message('This request has already been decided.'), 409)
        self.t.check_version(q, d.get('expected_version'))
        if not withdrawing and d.get('decision') not in ('APPROVE', 'REJECT'):
            fail(_message('Choose Approve or Reject.'))
        status = 'WITHDRAWN' if withdrawing else 'APPROVED' if d['decision'] == 'APPROVE' else 'REJECTED'
        note = text(d.get('note'), 'Decision note', 1000, status == 'REJECTED')
        if status == 'APPROVED':
            data = json.loads(q['payload_json'])['data']
            invited = actor in (data.get('attendee_ids') or []) or data.get('organizer_id') == actor
            if (not self.active_reviewer(actor) or not (self.is_participant(m, actor) or invited) or not self.eligible(m, q['requested_by'])
                    or not self.gov.can_staff(q['requested_by'], 'tasks.meetings', 'update')):
                fail(_message('A responsible participant no longer has authority. Withdraw and submit a new request.'), 409)
            if m['version'] != q['base_version']:
                fail(_message('The meeting changed since this request. Withdraw and request the change again.'), 409)
            self.save({**data, 'expected_version': m['version']}, q['requested_by'], source)
        MeetingChange.objects.filter(id=q['id']).update(status=status, decision_note=note, decided_by_id=actor, decided_at=timezone.now(),
                                                        version=q['version'] + 1)
        self.t.log(actor, 'meeting', m['id'], m['workspace_id'], _message('Meeting change {p0}', p0=status.lower()), jtext({'request': q['id'], 'note': note, 'source': source}))
        self.workflow_tell(m, q['approver_id'] if withdrawing else q['requested_by'], actor, _message('Meeting change {p0}: {p1}', p0=status.lower(), p1=m['title']))
        return {'id': m['id'], 'type': 'tm_meeting', 'message': _message('Approved change applied.') if status == 'APPROVED' else _message('The meeting remains unchanged.')}

    # ------------------------------------------------------------ meeting and note reminders (worker, every minute)
    def event_reminders(self, now=None):
        now = now or datetime.now(dt_timezone.utc)
        now_ms = now.timestamp() * 1000
        sent = 0

        def remind(kind, ref, staff, offset, start_at, title, body):
            nonlocal sent
            moment = parse(start_at)
            if EventReminderSent.objects.filter(kind=kind, ref_id=ref, staff_id=staff, offset_min=offset, start_at=moment).exists():
                return
            n = Notification.objects.create(staff_id=staff, kind='meeting_reminder' if kind == 'MEETING' else 'note_reminder',
                                            meeting_id=ref if kind == 'MEETING' else None, note_id=ref if kind == 'NOTE' else None,
                                            title=title, body=body, actor_id=None, created_at=now)
            EventReminderSent.objects.create(kind=kind, ref_id=ref, staff_id=staff, offset_min=offset, start_at=moment, notification=n, created_at=now)
            sent += 1
        meetings = (Meeting.objects.filter(status='SCHEDULED', workspace__status='ACTIVE', start_at__gt=now - timedelta(minutes=5),
                                           start_at__lte=now + timedelta(minutes=MAX_OFFSET)).exclude(reminder_offsets='[]')
                    .order_by('start_at', 'end_at', 'status', 'id'))
        for m in (row(x) for x in meetings):
            offsets, start_ms = json.loads(m['reminder_offsets'] or '[]'), ms(m['start_at'])
            due = [n for n in offsets if start_ms - n * 60000 <= now_ms]
            if not due:
                continue
            n = min(due)
            people = [m['organizer_id'], *self.attendees_of(m['id']), *self.followers_of(m['id'])]
            for staff in dict.fromkeys(people):
                if not self.t.calendar_reachable(staff) or not self.scope.can_see_meeting(staff, m):
                    continue
                zone = self.t.zone_of(staff)
                title = (_message('Starting now: {p0}', p0=m['title']) if n == 0
                         else _message('Reminder: {p0}', p0=m['title']))
                body = _message('{p0} ({p1}){p2}{p3}', p0=dm.at_text(m['start_at'], zone), p1=zone_label(zone),
                                p2=' · ' + m['location'] if m['location'] else '',
                                p3=_message(' · online') if m['url'] else '')
                remind('MEETING', m['id'], staff, n, m['start_at'], title, body)
        since = (now - timedelta(days=2)).strftime('%Y-%m-%d')
        for x in (row(n) for n in CalendarNote.objects.filter(done=False, day__gte=since).exclude(reminder_offsets='[]').order_by('id')):
            start_at = self.note_moment(x['day'], x['staff_id']) if x['all_day'] else x['start_at']
            start_ms = ms(start_at)
            if start_ms <= now_ms - 300000 or not self.t.calendar_reachable(x['staff_id']):
                continue
            due = [n for n in json.loads(x['reminder_offsets'] or '[]') if start_ms - n * 60000 <= now_ms]
            if not due:
                continue
            n, zone = min(due), self.t.zone_of(x['staff_id'])
            from tasks.services import clip
            moment = dm.human(x['day']) if x['all_day'] else self.when(start_at, x['staff_id'])
            body = _message('{p0}{p1}', p0=moment, p1=' · ' + clip(x['body'], 200) if x['body'] else '')
            remind('NOTE', x['id'], x['staff_id'], n, start_at, _message('Reminder: {p0}', p0=x['title']), body)
        return sent

    # ------------------------------------------------------------ dispatcher
    def handle(self, action, d, actor, source):
        if action == 'tm.meeting.save':
            return self.request(d, actor, source)
        if action in ('tm.meeting.decide', 'tm.meeting.withdraw'):
            return self.decide(action, d, actor, source)
        if action == 'tm.meeting.follow':
            return self.follow(d, actor)
        if action in ('tm.calnote.save', 'tm.calnote.delete'):
            return self.calendar_note(action, d, actor)
        fail(_message('Unknown Task Management action.'), 404)


class _Preview(Exception):
    """Rolls back a meeting change preview (V5.7.7: SAVEPOINT … ROLLBACK TO)."""


def parse(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


__all__ = ['MeetingService', 'InputError', 'active_staff']

"""Task rules shared by every client — a direct port of task-domain.mjs (V5.7.7).

The React app and the Telegram Mini App import task-domain.mjs to decide which buttons to show; the server must apply
exactly the same rules, so this module mirrors it function by function. Tasks are plain dict rows with V5.7.7 column
names; dates are 'YYYY-MM-DD' strings and timestamps ISO strings, compared as text exactly as the original does.
"""
from core.i18n import msg as _message
import json
import re
from datetime import date, datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

from core.validation import js_number

CAMBODIA = ZoneInfo('Asia/Phnom_Penh')
TASK_STATUS = {'NOT_STARTED': _message('Not started'), 'IN_PROGRESS': _message('In progress'), 'IN_REVIEW': _message('In review'),
               'COMPLETED': _message('Completed'), 'CANCELLED': _message('Cancelled')}
OPEN_TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW']
TASK_COLORS = {'BLUE': '#346be6', 'PURPLE': '#8257ce', 'TEAL': '#178c8e', 'ORANGE': '#bc751b', 'PINK': '#c34483'}
RECURRENCE = {'': _message('Does not repeat'), 'DAILY': _message('Every day'), 'WEEKDAYS': _message('Every weekday (Mon–Fri)'), 'WEEKLY': _message('Every week'),
              'MONTHLY': _message('Every month')}
RECURRENCE_SHORT = {'DAILY': _message('daily'), 'WEEKDAYS': _message('on weekdays'), 'WEEKLY': _message('weekly'), 'MONTHLY': _message('monthly')}
TASK_FILE_TYPES = {
    'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    'gif': 'image/gif', 'heic': 'image/heic',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xls': 'application/vnd.ms-excel',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc': 'application/msword',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'csv': 'text/csv',
    'txt': 'text/plain', 'zip': 'application/zip',
}
PREVIEW_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
FLOW_LABELS = {'accept': _message('Task accepted'), 'decline': _message('Task rejected'), 'progress': _message('Progress updated'), 'stuck': _message('Marked as stuck'),
               'resume': _message('Work resumed'), 'submit': _message('Submitted for review'), 'pass': _message('Passed on for approval'),
               'return': _message('Returned for more work'), 'close': _message('Task closed'), 'cancel': _message('Task cancelled'), 'reopen': _message('Task reopened'),
               'note': _message('Comment added')}


# ---------------------------------------------------------------- days and durations (Cambodia calendar)
def local_day(value):
    """The calendar day of an instant in Cambodia (localDay)."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt_timezone.utc)
    return value.astimezone(CAMBODIA).strftime('%Y-%m-%d')


def task_today():
    return local_day(datetime.now(dt_timezone.utc))


def add_days(day, n):
    return (date.fromisoformat(day) + timedelta(days=n)).isoformat()


def days_between(start, end):
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def weekday_js(day):
    """JavaScript getUTCDay(): 0 = Sunday … 6 = Saturday."""
    return (date.fromisoformat(day).weekday() + 1) % 7


def format_minutes(m):
    m = int(m or 0)
    return f'{m // 60}:{m % 60:02d}'


def parse_duration(value):
    v = str('' if value is None else value).strip()
    match = re.fullmatch(r'(\d{1,4}):([0-5]\d)', v)
    if not match:
        raise ValueError(_message('Use duration H:MM, for example 1:30 for 90 minutes.'))
    return int(match.group(1)) * 60 + int(match.group(2))


_MONTHS = [_message('Jan'), _message('Feb'), _message('Mar'), _message('Apr'), _message('May'), _message('Jun'), _message('Jul'), _message('Aug'), _message('Sep'), _message('Oct'), _message('Nov'), _message('Dec')]
_DAYS = [_message('Mon'), _message('Tue'), _message('Wed'), _message('Thu'), _message('Fri'), _message('Sat'), _message('Sun')]


def human(day):
    """'Mon, 5 Oct 2026' — the en-GB date V5.7.7 writes into notifications and history."""
    if not day:
        return ''
    d = date.fromisoformat(day[:10])
    return _message('{p0}, {p1} {p2} {p3}', p0=_DAYS[d.weekday()], p1=d.day, p2=_MONTHS[d.month - 1], p3=d.year)


def at_text(iso_value, zone):
    """'Thu 15 Oct, 09:05' in the given time zone (meeting and note reminders)."""
    moment = datetime.fromisoformat(iso_value.replace('Z', '+00:00')).astimezone(ZoneInfo(zone))
    return _message('{p0} {p1} {p2}, {p3}', p0=_DAYS[moment.weekday()], p1=moment.day, p2=_MONTHS[moment.month - 1], p3=moment.strftime('%H:%M'))


def month_label(month):
    names = [_message('January'), _message('February'), _message('March'), _message('April'), _message('May'), _message('June'), _message('July'), _message('August'), _message('September'), _message('October'),
             _message('November'), _message('December')]
    y, m = month.split('-')
    return _message('{p0} {p1}', p0=names[int(m) - 1], p1=y)


# ---------------------------------------------------------------- people and two-party approval
def assigner_of(t):
    return t.get('assigned_by') or t.get('created_by')


def active_reviewer_of(t):
    return t['reviewer_id'] if t.get('reviewer_id') and (t.get('reviewer_status') or 'ACCEPTED') != 'DECLINED' else None


def two_sided(t):
    return bool(t.get('pic_id')) and t['pic_id'] != assigner_of(t)


def needs_approval(t):
    return t['status'] in OPEN_TASK_STATUSES and two_sided(t) and bool(t.get('accepted_at')) and not t.get('declined_at')


def completion_path(t):
    reviewer, assigner = active_reviewer_of(t), assigner_of(t)
    if two_sided(t):
        return {'review': reviewer if reviewer and reviewer != t['pic_id'] and reviewer != assigner else None, 'approver': assigner}
    return {'review': None, 'approver': reviewer if reviewer and reviewer != t.get('pic_id') else None}


def reminder_days(value):
    if value is None or value == '':
        return [1]
    items = value
    if isinstance(value, str):
        try:
            items = json.loads(value)
        except ValueError:
            return [1]
    if not isinstance(items, list):
        return [1]
    out = set()
    for x in items:
        n = js_number(x)
        if isinstance(n, float) and (n != n or not n.is_integer()):
            continue
        if 1 <= n <= 90:
            out.add(int(n))
    return sorted(out, reverse=True)[:5]


def reminder_text(days):
    d = reminder_days(days)
    if not d:
        return _message('No reminders')
    parts = [str(n) for n in d]
    joined = _message('{p0} and {p1}', p0=', '.join(parts[:-1]), p1=parts[-1]) if len(parts) > 1 else parts[0]
    return (_message('{p0} day before the due date', p0=joined) if d == [1]
            else _message('{p0} days before the due date', p0=joined))


def task_roles(t, staff, support=None, can_approve=False):
    support = t.get('support', []) if support is None else support
    rows = [{'staff_id': x, 'status': 'ACCEPTED'} if isinstance(x, str) else x for x in (support or [])]
    is_pic = bool(staff) and t.get('pic_id') == staff
    mine = next((x for x in rows if x['staff_id'] == staff), None) if not is_pic and staff else None
    support_status = (mine.get('status') or 'ACCEPTED') if mine else None
    is_supporter = support_status in ('PENDING', 'ACCEPTED')
    reviewer_status = (t.get('reviewer_status') or 'ACCEPTED') if staff and t.get('reviewer_id') == staff else None
    is_reviewer = reviewer_status in ('PENDING', 'ACCEPTED')
    is_creator = bool(staff) and t.get('created_by') == staff
    pic_state = ('DECLINED' if t.get('declined_at') else 'ACCEPTED' if t.get('accepted_at') else 'PENDING') if is_pic else None
    is_assigner = bool(staff) and assigner_of(t) == staff
    to_answer = [n for n, ok in (('pic', pic_state == 'PENDING'), ('supporter', support_status == 'PENDING'),
                                 ('reviewer', reviewer_status == 'PENDING')) if ok]
    rejected = [n for n, ok in (('pic', pic_state == 'DECLINED'), ('supporter', support_status == 'DECLINED'),
                                ('reviewer', reviewer_status == 'DECLINED')) if ok]
    is_governor = is_creator or is_reviewer or is_assigner or bool(can_approve)
    side = 'PIC' if is_pic else 'ASSIGNER' if is_governor else None
    return {'staff': staff, 'isPic': is_pic, 'isSupporter': is_supporter, 'isReviewer': is_reviewer, 'isCreator': is_creator,
            'isAssigner': is_assigner, 'isGovernor': is_governor, 'side': side,
            'isSubmittedTo': t['status'] == 'IN_REVIEW' and bool(staff) and t.get('submitted_to') == staff,
            'canApprove': bool(can_approve), 'picState': pic_state, 'supportStatus': support_status,
            'reviewerStatus': reviewer_status, 'toAnswer': to_answer, 'rejected': rejected}


def _deny(message):
    return {'status': 403, 'message': message}


def _conflict(message):
    return {'status': 409, 'message': message}


def answer_roles(verb, t, r, role=None):
    is_open, working, roles, why = t['status'] in OPEN_TASK_STATUSES, t['status'] in ('NOT_STARTED', 'IN_PROGRESS'), [], None
    states = {'pic': r['picState'], 'supporter': r['supportStatus'], 'reviewer': r['reviewerStatus']}
    for name in ('pic', 'supporter', 'reviewer'):
        state = states[name]
        if not state or (role and role != name):
            continue
        if verb == 'accept' and state == 'ACCEPTED':
            why = why or _conflict(_message('You already accepted this task.'))
            continue
        if verb == 'decline' and state != 'PENDING':
            why = why or _conflict(_message('You already rejected this task.') if state == 'DECLINED' else
                                   _message('You already accepted this task. Ask its manager if you can no longer do it.'))
            continue
        if name == 'pic' and not working:
            why = why or _conflict(_message('This task is waiting for review.') if is_open else _message('This task is closed.'))
            continue
        if not is_open:
            why = why or _conflict(_message('This task is closed.'))
            continue
        roles.append(name)
    block = None if roles else (why or _deny(_message('Only people asked to work on or review this task can {p0} it.', p0='accept' if verb == 'accept' else 'reject')))
    return {'roles': roles, 'block': block}


def task_block(verb, t, r, opts=None):
    """None when allowed, otherwise {'status', 'message'} — the server-side rule for every task button."""
    opts = opts or {}
    is_open = t['status'] in OPEN_TASK_STATUSES
    working = t['status'] in ('NOT_STARTED', 'IN_PROGRESS')
    worker = r['isPic'] or r['isSupporter']
    declined_by_me = r['isPic'] and bool(t.get('declined_at'))
    cr = t.get('change_request')
    path, two, sided = completion_path(t), needs_approval(t), two_sided(t)

    def waiting_change():
        return _conflict(_message('A change to this task is already waiting for approval. Wait for the answer, or withdraw it.'))
    completion_asked = bool(cr) and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC'
    approver = cr['approver_id'] if completion_asked else path['approver']

    if verb == 'close':
        if not is_open:
            return _conflict(_message('This task is already closed.'))
        if r['isPic']:
            if declined_by_me:
                return _conflict(_message('You rejected this task. Accept it first to continue.'))
            if not sided:
                return None
            return _conflict(_message('This task is waiting for approval.') if t['status'] == 'IN_REVIEW' and t.get('submitted_to') != t['pic_id']
                             else _message('Submit it for approval: the task is completed once it is approved.'))
        if t['status'] == 'IN_REVIEW':
            if r['isSubmittedTo']:
                return None if not approver or r['staff'] == approver else _conflict(_message('Pass it on for approval: someone else makes the completion final.'))
            if r['staff'] == approver and completion_asked:
                return None
            return (_conflict(_message('The person in charge is checking work a supporting person submitted. Try again once they submit or return it.'))
                    if t.get('submitted_to') == t.get('pic_id') else _deny(_message('Only the person who approves this task can complete it.')))
        if r['side'] == 'ASSIGNER' and two:
            return waiting_change() if cr else None
        return _deny(_message('Only the person in charge, or the person who approves the task, can complete it.'))
    if verb == 'pass':
        if t['status'] != 'IN_REVIEW':
            return _conflict(_message('This task is not waiting for review.'))
        if not r['isSubmittedTo']:
            return _deny(_message('Only the person reviewing this task can pass it on.'))
        if r['isPic']:
            return _conflict(_message('Submit the task for approval instead.'))
        return None if approver and approver != r['staff'] else _conflict(_message('You make the final decision on this task: complete it or return it.'))
    if verb == 'return':
        if t['status'] != 'IN_REVIEW':
            return _conflict(_message('This task is not waiting for review.'))
        if r['isSubmittedTo'] or (r['staff'] == approver and completion_asked):
            return None
        return _deny(_message('Only the person this task was submitted to can return it.'))
    if verb == 'reminders':
        if not is_open:
            return _conflict(_message('This task is closed.'))
        return None if r['isPic'] or r['isGovernor'] else _deny(_message('Only the person in charge or the task’s assigner can change its reminders.'))
    if verb in ('accept', 'decline'):
        return answer_roles(verb, t, r, opts.get('role'))['block']
    if verb in ('progress', 'stuck'):
        if verb == 'progress' and not worker and r['side'] == 'ASSIGNER' and two:
            if not working:
                return _conflict(_message('This task is waiting for review.') if t['status'] == 'IN_REVIEW' else _message('This task is closed.'))
            return waiting_change() if cr else None
        if not worker:
            return _deny(_message('Only the person in charge or a supporting person can {p0}.', p0='mark this task as stuck' if verb == 'stuck' else 'update progress'))
        if not working:
            return _conflict(_message('This task is waiting for review. It must be returned before more work is recorded.') if t['status'] == 'IN_REVIEW' else _message('This task is closed.'))
        if declined_by_me:
            return _conflict(_message('You rejected this task. Accept it first to continue.'))
        if not r['isPic'] and not t.get('accepted_at'):
            return _conflict(_message('The person in charge must accept this task first.'))
        if verb == 'stuck' and t.get('stuck_at'):
            return _conflict(_message('This task is already marked as stuck.'))
        return None
    if verb == 'resume':
        if not (worker or r['isGovernor']):
            return _deny(_message('Only people working on this task or its manager can resume it.'))
        if not t.get('stuck_at'):
            return _conflict(_message('This task is not marked as stuck.'))
        return None
    if verb == 'submit':
        if r['isPic']:
            if declined_by_me:
                return _conflict(_message('You rejected this task. Accept it first to continue.'))
            if t['status'] == 'IN_REVIEW' and t.get('submitted_to') != t['pic_id']:
                return _conflict(_message('This task is already waiting for review.'))
            if not is_open:
                return _conflict(_message('This task is closed.'))
            if not approver and not path['review']:
                return _conflict(_message('Nobody else needs to approve this task, so you can close it yourself.'))
            return waiting_change() if cr else None
        if r['isSupporter']:
            if not t.get('accepted_at') or t.get('declined_at'):
                return _conflict(_message('The person in charge must accept this task first.'))
            if t['status'] == 'IN_REVIEW':
                return _conflict(_message('This task is already waiting for review.'))
            if t['status'] != 'IN_PROGRESS':
                return _conflict(_message('The task must be in progress before it is submitted.') if is_open else _message('This task is closed.'))
            return None
        return _deny(_message('Only the person in charge or a supporting person can submit this task.'))
    if verb == 'cancel':
        if not is_open:
            return _conflict(_message('This task is already closed.'))
        if r['isPic'] and sided and (not t.get('accepted_at') or t.get('declined_at')):
            return _conflict(_message('You rejected this task. Its assigner decides what happens next.') if t.get('declined_at') else
                             _message('You have not accepted this task yet: reject it instead, with a reason.'))
        if not (r['isGovernor'] or r['isPic']):
            return _deny(_message('Only the person in charge, the reviewer or the person who assigned the task can cancel it.'))
        return waiting_change() if cr else None
    if verb == 'reopen':
        if is_open:
            return _conflict(_message('This task is already open.'))
        if not (r['isGovernor'] or r['isPic']):
            return _deny(_message('Only the person in charge or the task’s manager can reopen it.'))
        return waiting_change() if cr else None
    if verb == 'edit':
        if not (r['isGovernor'] or r['isPic']):
            return _deny(_message('Only the task’s manager or the person in charge can edit this task.'))
        return waiting_change() if cr else None
    if verb == 'note':
        return None if worker or r['isGovernor'] or r['isSubmittedTo'] else _deny(_message('Only people working on this task or its manager can comment.'))
    if verb == 'due':
        if not worker:
            return _deny(_message('Only the person in charge or a supporting person can ask for a new due date.'))
        if not is_open:
            return _conflict(_message('This task is closed.'))
        if r['isPic'] and sided:
            return waiting_change() if cr else None
        if r['isGovernor']:
            return _conflict(_message('You manage this task, so you can change its due date directly.'))
        if cr:
            return waiting_change()
        if t.get('due_request'):
            return _conflict(_message('A due date request for this task is already waiting for a decision.'))
        return None
    if verb == 'handover':
        if not r['isPic']:
            return _deny(_message('Only the person in charge can hand this task over.'))
        if not working:
            return _conflict(_message('Return or close the review before handing the task over.') if t['status'] == 'IN_REVIEW' else _message('This task is closed.'))
        return waiting_change() if cr else None
    if verb == 'remind':
        if not (r['isGovernor'] or r['isPic']):
            return _deny(_message('Only the person in charge or the task’s manager can send a reminder.'))
        if not is_open:
            return _conflict(_message('This task is closed.'))
        if not any(x['staff_id'] != r['staff'] for x in (t.get('waiting') or [])):
            return _conflict(_message('Nobody on this task is waiting to answer.'))
        return None
    if verb == 'checklist':
        if not is_open:
            return _conflict(_message('This task is closed.'))
        if r['isGovernor'] and not worker:
            return None
        if not worker:
            return _deny(_message('Only people working on this task or its manager can change the checklist.'))
        if declined_by_me:
            return _conflict(_message('You rejected this task. Accept it first to continue.'))
        if not r['isPic'] and not t.get('accepted_at') and not r['isGovernor']:
            return _conflict(_message('The person in charge must accept this task first.'))
        return None
    if verb == 'file':
        if t['status'] == 'CANCELLED':
            return _conflict(_message('This task is cancelled.'))
        return None if worker or r['isGovernor'] or r['isSubmittedTo'] else _deny(_message('Only people on this task or its manager can add files.'))
    return _deny(_message('This task action is not available.'))


def approval_target(t, staff):
    if not staff or t['status'] not in OPEN_TASK_STATUSES or not two_sided(t):
        return None
    if staff == t['pic_id']:
        return assigner_of(t)
    return t['pic_id']


def edit_approval_target(t, staff):
    if t['status'] in OPEN_TASK_STATUSES:
        return approval_target(t, staff)
    if not staff or not two_sided(t):
        return None
    return assigner_of(t) if staff == t['pic_id'] else t['pic_id']


def reopen_needs_approval(t, staff):
    return edit_approval_target(t, staff) if t['status'] not in OPEN_TASK_STATUSES else None


def task_state_label(t):
    if t['status'] == 'IN_REVIEW':
        return _message('In review')
    if t['status'] not in OPEN_TASK_STATUSES:
        return TASK_STATUS[t['status']]
    if t.get('declined_at'):
        return _message('Rejected')
    if t.get('stuck_at'):
        return _message('Stuck')
    if t['status'] == 'NOT_STARTED':
        return _message('Accepted') if t.get('accepted_at') else _message('Awaiting acceptance')
    return TASK_STATUS[t['status']]


def due_decider(t):
    return t['reviewer_id'] if t.get('reviewer_id') and (t.get('reviewer_status') or 'ACCEPTED') != 'DECLINED' else t.get('created_by')


TASK_VERBS = ['accept', 'decline', 'progress', 'stuck', 'resume', 'submit', 'pass', 'return', 'close', 'cancel', 'reopen', 'note', 'due', 'edit',
              'handover', 'remind', 'reminders', 'checklist', 'file']


def task_actions(t, staff, can_approve=False):
    """taskActions(): the verbs this person may use on an (enriched) task, as the screens and the bot show them."""
    support = t.get('support') or t.get('supporters') or []
    r = task_roles(t, staff, support, can_approve)
    allowed = [v for v in TASK_VERBS if not task_block(v, t, r)]
    if r['isPic'] and t['status'] == 'NOT_STARTED' and (not t.get('accepted_at') or t.get('declined_at')):
        allowed = [v for v in allowed if v in ('accept', 'decline', 'edit', 'note', 'cancel', 'handover', 'file', 'reminders')]
    elif r['supportStatus'] == 'PENDING' and not r['isGovernor']:
        allowed = [v for v in allowed if v in ('accept', 'decline', 'note', 'file')]
    return {'roles': r, 'allowed': allowed, 'approval': needs_approval(t), 'path': completion_path(t)}


def completion_approver(t):
    cr = t.get('change_request')
    if cr and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC':
        return cr['approver_id']
    return completion_path(t)['approver']


REQUEST_STATUS = {'PENDING': _message('Waiting for answer'), 'APPROVED': _message('Accepted'), 'DECLINED': _message('Declined'), 'WITHDRAWN': _message('Withdrawn')}

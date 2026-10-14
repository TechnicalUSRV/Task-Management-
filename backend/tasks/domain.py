"""Task rules shared by every client — a direct port of task-domain.mjs (V5.7.7).

The React app and the Telegram Mini App import task-domain.mjs to decide which buttons to show; the server must apply
exactly the same rules, so this module mirrors it function by function. Tasks are plain dict rows with V5.7.7 column
names; dates are 'YYYY-MM-DD' strings and timestamps ISO strings, compared as text exactly as the original does.
"""
import json
import re
from datetime import date, datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

from core.validation import js_number

CAMBODIA = ZoneInfo('Asia/Phnom_Penh')
TASK_STATUS = {'NOT_STARTED': 'Not started', 'IN_PROGRESS': 'In progress', 'IN_REVIEW': 'In review',
               'COMPLETED': 'Completed', 'CANCELLED': 'Cancelled'}
OPEN_TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW']
TASK_COLORS = {'BLUE': '#346be6', 'PURPLE': '#8257ce', 'TEAL': '#178c8e', 'ORANGE': '#bc751b', 'PINK': '#c34483'}
RECURRENCE = {'': 'Does not repeat', 'DAILY': 'Every day', 'WEEKDAYS': 'Every weekday (Mon–Fri)', 'WEEKLY': 'Every week',
              'MONTHLY': 'Every month'}
RECURRENCE_SHORT = {'DAILY': 'daily', 'WEEKDAYS': 'on weekdays', 'WEEKLY': 'weekly', 'MONTHLY': 'monthly'}
TASK_FILE_TYPES = {
    'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    'gif': 'image/gif', 'heic': 'image/heic',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xls': 'application/vnd.ms-excel',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc': 'application/msword',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'csv': 'text/csv',
    'txt': 'text/plain', 'zip': 'application/zip',
}
PREVIEW_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
FLOW_LABELS = {'accept': 'Task accepted', 'decline': 'Task rejected', 'progress': 'Progress updated', 'stuck': 'Marked as stuck',
               'resume': 'Work resumed', 'submit': 'Submitted for review', 'pass': 'Passed on for approval',
               'return': 'Returned for more work', 'close': 'Task closed', 'cancel': 'Task cancelled', 'reopen': 'Task reopened',
               'note': 'Comment added'}


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
        raise ValueError('Use duration H:MM, for example 1:30 for 90 minutes.')
    return int(match.group(1)) * 60 + int(match.group(2))


_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']


def human(day):
    """'Mon, 5 Oct 2026' — the en-GB date V5.7.7 writes into notifications and history."""
    if not day:
        return ''
    d = date.fromisoformat(day[:10])
    return f'{_DAYS[d.weekday()]}, {d.day} {_MONTHS[d.month - 1]} {d.year}'


def at_text(iso_value, zone):
    """'Thu 15 Oct, 09:05' in the given time zone (meeting and note reminders)."""
    moment = datetime.fromisoformat(iso_value.replace('Z', '+00:00')).astimezone(ZoneInfo(zone))
    return f'{_DAYS[moment.weekday()]} {moment.day} {_MONTHS[moment.month - 1]}, {moment.strftime("%H:%M")}'


def month_label(month):
    names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
             'November', 'December']
    y, m = month.split('-')
    return f'{names[int(m) - 1]} {y}'


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
        return 'No reminders'
    parts = [str(n) for n in d]
    joined = ', '.join(parts[:-1]) + ' and ' + parts[-1] if len(parts) > 1 else parts[0]
    return f"{joined} day{'' if len(d) == 1 and d[0] == 1 else 's'} before the due date"


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
            why = why or _conflict('You already accepted this task.')
            continue
        if verb == 'decline' and state != 'PENDING':
            why = why or _conflict('You already rejected this task.' if state == 'DECLINED' else
                                   'You already accepted this task. Ask its manager if you can no longer do it.')
            continue
        if name == 'pic' and not working:
            why = why or _conflict('This task is waiting for review.' if is_open else 'This task is closed.')
            continue
        if not is_open:
            why = why or _conflict('This task is closed.')
            continue
        roles.append(name)
    block = None if roles else (why or _deny(f"Only people asked to work on or review this task can {'accept' if verb == 'accept' else 'reject'} it."))
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
        return _conflict('A change to this task is already waiting for approval. Wait for the answer, or withdraw it.')
    completion_asked = bool(cr) and cr['kind'] == 'COMPLETE' and cr['requester_side'] == 'PIC'
    approver = cr['approver_id'] if completion_asked else path['approver']

    if verb == 'close':
        if not is_open:
            return _conflict('This task is already closed.')
        if r['isPic']:
            if declined_by_me:
                return _conflict('You rejected this task. Accept it first to continue.')
            if not sided:
                return None
            return _conflict('This task is waiting for approval.' if t['status'] == 'IN_REVIEW' and t.get('submitted_to') != t['pic_id']
                             else 'Submit it for approval: the task is completed once it is approved.')
        if t['status'] == 'IN_REVIEW':
            if r['isSubmittedTo']:
                return None if not approver or r['staff'] == approver else _conflict('Pass it on for approval: someone else makes the completion final.')
            if r['staff'] == approver and completion_asked:
                return None
            return (_conflict('The person in charge is checking work a supporting person submitted. Try again once they submit or return it.')
                    if t.get('submitted_to') == t.get('pic_id') else _deny('Only the person who approves this task can complete it.'))
        if r['side'] == 'ASSIGNER' and two:
            return waiting_change() if cr else None
        return _deny('Only the person in charge, or the person who approves the task, can complete it.')
    if verb == 'pass':
        if t['status'] != 'IN_REVIEW':
            return _conflict('This task is not waiting for review.')
        if not r['isSubmittedTo']:
            return _deny('Only the person reviewing this task can pass it on.')
        if r['isPic']:
            return _conflict('Submit the task for approval instead.')
        return None if approver and approver != r['staff'] else _conflict('You make the final decision on this task: complete it or return it.')
    if verb == 'return':
        if t['status'] != 'IN_REVIEW':
            return _conflict('This task is not waiting for review.')
        if r['isSubmittedTo'] or (r['staff'] == approver and completion_asked):
            return None
        return _deny('Only the person this task was submitted to can return it.')
    if verb == 'reminders':
        if not is_open:
            return _conflict('This task is closed.')
        return None if r['isPic'] or r['isGovernor'] else _deny('Only the person in charge or the task’s assigner can change its reminders.')
    if verb in ('accept', 'decline'):
        return answer_roles(verb, t, r, opts.get('role'))['block']
    if verb in ('progress', 'stuck'):
        if verb == 'progress' and not worker and r['side'] == 'ASSIGNER' and two:
            if not working:
                return _conflict('This task is waiting for review.' if t['status'] == 'IN_REVIEW' else 'This task is closed.')
            return waiting_change() if cr else None
        if not worker:
            return _deny(f"Only the person in charge or a supporting person can {'mark this task as stuck' if verb == 'stuck' else 'update progress'}.")
        if not working:
            return _conflict('This task is waiting for review. It must be returned before more work is recorded.' if t['status'] == 'IN_REVIEW' else 'This task is closed.')
        if declined_by_me:
            return _conflict('You rejected this task. Accept it first to continue.')
        if not r['isPic'] and not t.get('accepted_at'):
            return _conflict('The person in charge must accept this task first.')
        if verb == 'stuck' and t.get('stuck_at'):
            return _conflict('This task is already marked as stuck.')
        return None
    if verb == 'resume':
        if not (worker or r['isGovernor']):
            return _deny('Only people working on this task or its manager can resume it.')
        if not t.get('stuck_at'):
            return _conflict('This task is not marked as stuck.')
        return None
    if verb == 'submit':
        if r['isPic']:
            if declined_by_me:
                return _conflict('You rejected this task. Accept it first to continue.')
            if t['status'] == 'IN_REVIEW' and t.get('submitted_to') != t['pic_id']:
                return _conflict('This task is already waiting for review.')
            if not is_open:
                return _conflict('This task is closed.')
            if not approver and not path['review']:
                return _conflict('Nobody else needs to approve this task, so you can close it yourself.')
            return waiting_change() if cr else None
        if r['isSupporter']:
            if not t.get('accepted_at') or t.get('declined_at'):
                return _conflict('The person in charge must accept this task first.')
            if t['status'] == 'IN_REVIEW':
                return _conflict('This task is already waiting for review.')
            if t['status'] != 'IN_PROGRESS':
                return _conflict('The task must be in progress before it is submitted.' if is_open else 'This task is closed.')
            return None
        return _deny('Only the person in charge or a supporting person can submit this task.')
    if verb == 'cancel':
        if not is_open:
            return _conflict('This task is already closed.')
        if r['isPic'] and sided and (not t.get('accepted_at') or t.get('declined_at')):
            return _conflict('You rejected this task. Its assigner decides what happens next.' if t.get('declined_at') else
                             'You have not accepted this task yet: reject it instead, with a reason.')
        if not (r['isGovernor'] or r['isPic']):
            return _deny('Only the person in charge, the reviewer or the person who assigned the task can cancel it.')
        return waiting_change() if cr else None
    if verb == 'reopen':
        if is_open:
            return _conflict('This task is already open.')
        if not (r['isGovernor'] or r['isPic']):
            return _deny('Only the person in charge or the task’s manager can reopen it.')
        return waiting_change() if cr else None
    if verb == 'edit':
        if not (r['isGovernor'] or r['isPic']):
            return _deny('Only the task’s manager or the person in charge can edit this task.')
        return waiting_change() if cr else None
    if verb == 'note':
        return None if worker or r['isGovernor'] or r['isSubmittedTo'] else _deny('Only people working on this task or its manager can comment.')
    if verb == 'due':
        if not worker:
            return _deny('Only the person in charge or a supporting person can ask for a new due date.')
        if not is_open:
            return _conflict('This task is closed.')
        if r['isPic'] and sided:
            return waiting_change() if cr else None
        if r['isGovernor']:
            return _conflict('You manage this task, so you can change its due date directly.')
        if cr:
            return waiting_change()
        if t.get('due_request'):
            return _conflict('A due date request for this task is already waiting for a decision.')
        return None
    if verb == 'handover':
        if not r['isPic']:
            return _deny('Only the person in charge can hand this task over.')
        if not working:
            return _conflict('Return or close the review before handing the task over.' if t['status'] == 'IN_REVIEW' else 'This task is closed.')
        return waiting_change() if cr else None
    if verb == 'remind':
        if not (r['isGovernor'] or r['isPic']):
            return _deny('Only the person in charge or the task’s manager can send a reminder.')
        if not is_open:
            return _conflict('This task is closed.')
        if not any(x['staff_id'] != r['staff'] for x in (t.get('waiting') or [])):
            return _conflict('Nobody on this task is waiting to answer.')
        return None
    if verb == 'checklist':
        if not is_open:
            return _conflict('This task is closed.')
        if r['isGovernor'] and not worker:
            return None
        if not worker:
            return _deny('Only people working on this task or its manager can change the checklist.')
        if declined_by_me:
            return _conflict('You rejected this task. Accept it first to continue.')
        if not r['isPic'] and not t.get('accepted_at') and not r['isGovernor']:
            return _conflict('The person in charge must accept this task first.')
        return None
    if verb == 'file':
        if t['status'] == 'CANCELLED':
            return _conflict('This task is cancelled.')
        return None if worker or r['isGovernor'] or r['isSubmittedTo'] else _deny('Only people on this task or its manager can add files.')
    return _deny('This task action is not available.')


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
        return 'In review'
    if t['status'] not in OPEN_TASK_STATUSES:
        return TASK_STATUS[t['status']]
    if t.get('declined_at'):
        return 'Rejected'
    if t.get('stuck_at'):
        return 'Stuck'
    if t['status'] == 'NOT_STARTED':
        return 'Accepted' if t.get('accepted_at') else 'Awaiting acceptance'
    return TASK_STATUS[t['status']]


def due_decider(t):
    return t['reviewer_id'] if t.get('reviewer_id') and (t.get('reviewer_status') or 'ACCEPTED') != 'DECLINED' else t.get('created_by')

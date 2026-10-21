"""Task reports, the dashboard, custom reports and the Mini App state — ports of buildTaskReport (task-domain.mjs),
reports.mjs (CSV), task-reports.mjs (print page), dashboard.mjs, erp-sources.mjs and miniState (telegram-gateway.mjs).

Every report reads the person's scoped state (compat.state.scoped_state), so permissions and the Task Visibility Scope
apply to reports, the dashboard and exports exactly as to the screens.
"""
import html
import json
import re
from datetime import date, datetime, timedelta, timezone as dt_timezone

from django.db import connection

from accounts import services as access
from accounts.catalog import ERP_MODULES, module_for_source
from core.errors import InputError
from core.validation import iso
from tasks import domain as dm

UNDEFINED = object()   # JavaScript `undefined`: the key is left out of the JSON


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if v is not UNDEFINED}
    if isinstance(value, list):
        return [None if v is UNDEFINED else strip(v) for v in value]
    return value


def report_error(message):
    return InputError(message, 400)


def now_iso():
    return iso(datetime.now(dt_timezone.utc))


def ms_of(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def iso_of(ms):
    return iso(datetime.fromtimestamp(ms / 1000, tz=dt_timezone.utc))


def day_of_ms(ms):
    return dm.local_day(datetime.fromtimestamp(ms / 1000, tz=dt_timezone.utc))


def valid_day(v):
    if not isinstance(v, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', v):
        return False
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------- enriched tasks (task-domain.mjs enrichedTasks)
def enriched_tasks(s):
    workspaces = {w['id']: w for w in [*(s.get('tm_workspace_refs') or []), *s['tm_workspaces']]}
    rows, minutes, today = {}, {}, dm.task_today()
    for a in s['tm_assignees']:
        rows.setdefault(a['task_id'], []).append(a)
    for e in s.get('tm_timesheets') or []:
        minutes[e.get('task_id')] = minutes.get(e.get('task_id'), 0) + e['minutes']
    pending_due = {r['task_id']: r for r in s.get('tm_due_requests') or [] if r['status'] == 'PENDING'}
    pending_change = {r['task_id']: r for r in s.get('tm_change_requests') or [] if r['status'] == 'PENDING'}
    checks, files = {}, {}
    for c in s.get('tm_checklist') or []:
        x = checks.setdefault(c['task_id'], [0, 0])
        x[0] += 1
        if c['done']:
            x[1] += 1
    for f in s.get('tm_files') or []:
        files[f['task_id']] = files.get(f['task_id'], 0) + 1
    out = []
    for t in s['tm_tasks']:
        listed = rows.get(t['id'], [])
        pic = t.get('pic_id') or (listed[0]['staff_id'] if listed else None)
        is_open = t['status'] in dm.OPEN_TASK_STATUSES
        w = workspaces.get(t['workspace_id'])
        support = [{'staff_id': a['staff_id'], 'status': a.get('status') or 'ACCEPTED', 'responded_at': a.get('responded_at') or None,
                    'response_note': a.get('response_note') or '', 'invited_by': a.get('invited_by') or None} for a in listed if a['staff_id'] != pic]
        supporters = [a['staff_id'] for a in support if a['status'] != 'DECLINED']
        reviewer_status = t.get('reviewer_status') or 'ACCEPTED'
        pic_state = 'DECLINED' if t.get('declined_at') else 'ACCEPTED' if t.get('accepted_at') else 'PENDING'
        check_total, check_done = checks.get(t['id'], [0, 0])
        waiting = [] if not is_open else [
            *([{'staff_id': pic, 'role': 'pic'}] if pic and pic_state == 'PENDING' and t['status'] in ('NOT_STARTED', 'IN_PROGRESS') else []),
            *[{'staff_id': a['staff_id'], 'role': 'supporter'} for a in support if a['status'] == 'PENDING'],
            *([{'staff_id': t['reviewer_id'], 'role': 'reviewer'}] if t.get('reviewer_id') and reviewer_status == 'PENDING' else [])]
        e = {**t, 'pic_id': pic, 'assigned_by': t.get('assigned_by') or t['created_by'], 'workspace': (w or {}).get('name') or '',
             'workspace_department': (w or {}).get('department') or '', 'department': t.get('department') or (w or {}).get('department') or '',
             'assignees': [pic, *supporters] if pic else supporters, 'supporters': supporters, 'support': support,
             'declined_supporters': [a for a in support if a['status'] == 'DECLINED'], 'reviewer_status': reviewer_status, 'pic_state': pic_state,
             'waiting': waiting, 'logged_minutes': minutes.get(t['id'], 0), 'check_total': check_total, 'check_done': check_done,
             'file_count': files.get(t['id'], 0), 'recurrence': t.get('recurrence') or '', 'overdue': is_open and t['due_date'] < today,
             'stuck': is_open and bool(t.get('stuck_at')), 'declined': is_open and bool(t.get('declined_at')),
             'awaiting': t['status'] == 'NOT_STARTED' and not t.get('accepted_at') and not t.get('declined_at'),
             'due_request': pending_due.get(t['id']) if is_open else None, 'change_request': pending_change.get(t['id']),
             'reminder_days': dm.reminder_days(t.get('reminder_days'))}
        e['approval'] = dm.needs_approval(e)
        out.append(e)
    return out


# ---------------------------------------------------------------- monthly reports
def month_bounds(month=None):
    month = month or dm.task_today()[:7]
    if not isinstance(month, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month):
        raise report_error('Choose a valid month (YYYY-MM).')
    y, m = (int(x) for x in month.split('-'))
    following = f'{y + 1}-01' if m == 12 else f'{y}-{m + 1:02d}'
    return {'month': month, 'start': ms_of(f'{month}-01T00:00:00+07:00'), 'end': ms_of(f'{following}-01T00:00:00+07:00'),
            'firstDay': f'{month}-01', 'lastDay': dm.add_days(f'{following}-01', -1), 'label': dm.month_label(month)}


def task_timeline(t, history):
    line = [{'at': ms_of(h['created_at']), 'kind': h['kind'], 'status': h.get('to_status') or t['status'], 'stuck': bool(h.get('stuck')),
             'progress': t['progress'] if h.get('progress') is None else h['progress'], 'due_date': h.get('due_date') or t['due_date'],
             'note': h.get('note') or ''} for h in history]
    if line:
        return line
    done = t['status'] in ('COMPLETED', 'CANCELLED')
    out = [{'at': ms_of(t['created_at']), 'kind': 'create', 'status': 'IN_PROGRESS' if done else t['status'], 'stuck': not done and bool(t.get('stuck_at')),
            'progress': 0 if done else t['progress'], 'due_date': t['due_date'], 'note': ''}]
    if done:
        out.append({'at': ms_of(t.get('completed_at') or t['updated_at']), 'kind': 'close' if t['status'] == 'COMPLETED' else 'cancel',
                    'status': t['status'], 'stuck': False, 'progress': t['progress'], 'due_date': t['due_date'], 'note': ''})
    return out


def state_at(line, ms):
    found = None
    for e in line:
        if e['at'] < ms:
            found = e
        else:
            break
    return found


def classify_month(t, line, b, now_ms):
    cutoff = min(b['end'], now_ms)
    end = state_at(line, cutoff)
    if not end:
        return None
    cutoff_day = dm.add_days(b['lastDay'], 1) if cutoff == b['end'] else day_of_ms(cutoff)
    out = {'status': end['status'], 'stuck': end['stuck'], 'progress': end['progress'], 'due_date': end['due_date'], 'completed': None,
           'inProgress': False, 'stuckInfo': None, 'overdue': None}
    completed_at = None
    i = 0
    while i < len(line) and line[i]['at'] < cutoff:
        e = line[i]
        if e['at'] >= b['start'] and e['status'] == 'COMPLETED' and (line[i - 1]['status'] if i > 0 else None) != 'COMPLETED':
            completed_at = e
        i += 1
    if end['status'] == 'COMPLETED' and completed_at:
        day = day_of_ms(completed_at['at'])
        out['completed'] = {'at': iso_of(completed_at['at']), 'day': day, 'late': day > completed_at['due_date'], 'due_date': completed_at['due_date']}
    out['inProgress'] = end['status'] in ('IN_PROGRESS', 'IN_REVIEW') and not end['stuck']
    run, found = None, None
    i = 0
    while i < len(line) and line[i]['at'] < cutoff:
        e = line[i]
        run = (run or e) if e['stuck'] and e['status'] in dm.OPEN_TASK_STATUSES else None
        following = line[i + 1]['at'] if i + 1 < len(line) else float('inf')
        if run and following > b['start']:
            found = run
        i += 1
    if found:
        out['stuckInfo'] = {'since': iso_of(found['at']), 'reason': found['note'], 'still': bool(end['stuck']) and end['status'] in dm.OPEN_TASK_STATUSES}
    if end['status'] in dm.OPEN_TASK_STATUSES and end['due_date'] < cutoff_day:
        out['overdue'] = {'days': dm.days_between(end['due_date'], cutoff_day), 'late_completion': False}
    elif out['completed'] and out['completed']['late']:
        out['overdue'] = {'days': dm.days_between(out['completed']['due_date'], out['completed']['day']), 'late_completion': True}
    return out


MONTHLY_REPORTS = {'monthly': 'Monthly task summary', 'monthly_completed': 'Monthly completed tasks', 'monthly_progress': 'Monthly tasks in progress',
                   'monthly_stuck': 'Monthly stuck tasks', 'monthly_overdue': 'Monthly overdue tasks'}
MONTHLY_CATEGORIES = [('completed', 'Completed', 'monthly_completed'), ('in_progress', 'In progress', 'monthly_progress'),
                      ('stuck', 'Stuck', 'monthly_stuck'), ('overdue', 'Overdue', 'monthly_overdue')]
MONTHLY_COLUMNS = {
    'monthly': [['group', 'Category'], ['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                ['status', 'Status'], ['due_date', 'Due'], ['detail', 'Details']],
    'monthly_completed': [['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                          ['supporters', 'Supporting'], ['due_date', 'Due'], ['completed_on', 'Completed'], ['on_time', 'On time']],
    'monthly_progress': [['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                         ['supporters', 'Supporting'], ['status', 'Status'], ['progress', 'Progress %'], ['due_date', 'Due']],
    'monthly_stuck': [['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                      ['stuck_since', 'Stuck since'], ['stuck_reason', 'Blocker'], ['still_stuck', 'Still stuck']],
    'monthly_overdue': [['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                        ['due_date', 'Due'], ['status', 'Status'], ['days_overdue', 'Days overdue'], ['overdue_kind', 'Result']],
}
TASK_REPORTS = {**MONTHLY_REPORTS, 'tasks': 'Task register', 'workload': 'Workload by user', 'time': 'Timesheet detail',
                'workspace': 'Workspace performance', 'meetings': 'Meeting register'}


def namer(s):
    names = {}
    for l in s['lookups']:
        names.setdefault(l['id'], l['name'])
    return lambda key: names.get(key) or key or '—'


def monthly_task_rows(s, f):
    b = month_bounds(f.get('month') or dm.task_today()[:7])
    name, history = namer(s), {}
    for h in s.get('tm_task_history') or []:
        history.setdefault(h['task_id'], []).append(h)
    for lst in history.values():
        lst.sort(key=lambda h: h['id'])
    tasks = [t for t in enriched_tasks(s) if (not f.get('workspace') or t['workspace_id'] == f['workspace']) and (not f.get('user') or f['user'] in t['assignees'])
             and (not f.get('pic') or t['pic_id'] == f['pic']) and (not f.get('department') or t['department'] == f['department'])]
    rows, summary = [], {'completed': 0, 'in_progress': 0, 'stuck': 0, 'overdue': 0}
    now_ms = ms_of(f['now']) if f.get('now') else int(datetime.now(dt_timezone.utc).timestamp() * 1000)
    for t in tasks:
        c = classify_month(t, task_timeline(t, history.get(t['id'], [])), b, now_ms)
        if not c:
            continue
        base = {'id': t['id'], 'title': t['title'], 'workspace': t['workspace'], 'workspace_id': t['workspace_id'], 'department': t['department'],
                'department_note': t.get('department_note') or '', 'pic_id': t['pic_id'], 'pic': name(t['pic_id']),
                'supporters': ', '.join(name(x) for x in t['supporters']), 'reviewer': name(t['reviewer_id']) if t.get('reviewer_id') else '',
                'due_date': c['due_date'], 'status': dm.TASK_STATUS.get(c['status'], c['status']), 'progress': c['progress'], 'priority': t['priority']}
        if c['completed']:
            summary['completed'] += 1
            late = c['completed']['late']
            rows.append({**base, 'category': 'completed', 'group': 'Completed', 'completed_on': c['completed']['day'], 'on_time': 'Late' if late else 'On time',
                         'detail': f"Completed {c['completed']['day']}{' (after the due date)' if late else ''}"})
        if c['inProgress']:
            summary['in_progress'] += 1
            rows.append({**base, 'category': 'in_progress', 'group': 'In progress',
                         'detail': f"{c['progress']}% complete{' · waiting for review' if c['status'] == 'IN_REVIEW' else ''}"})
        if c['stuckInfo']:
            summary['stuck'] += 1
            info, since = c['stuckInfo'], dm.local_day(c['stuckInfo']['since'])
            rows.append({**base, 'category': 'stuck', 'group': 'Stuck', 'stuck_since': since, 'stuck_reason': info['reason'],
                         'still_stuck': 'Yes' if info['still'] else 'No',
                         'detail': f"Stuck since {since}{': ' + info['reason'] if info['reason'] else ''}{'' if info['still'] else ' (resolved)'}"})
        if c['overdue']:
            summary['overdue'] += 1
            days, late = c['overdue']['days'], c['overdue']['late_completion']
            rows.append({**base, 'category': 'overdue', 'group': 'Overdue', 'days_overdue': days, 'overdue_kind': 'Completed late' if late else 'Still open',
                         'detail': f"Completed {days} day{'' if days == 1 else 's'} late" if late else f"{days} day{'' if days == 1 else 's'} past due"})
    return b, rows, summary


def build_task_report(s, f=None):
    f = dict(f or {})
    report = f.get('report') or 'tasks'
    if report not in TASK_REPORTS:
        raise report_error('Unknown task report.')
    for key in ('from', 'to'):
        if f.get(key) and not valid_day(f[key]):
            raise report_error('Enter valid report dates.')
    if f.get('from') and f.get('to') and f['from'] > f['to']:
        raise report_error('The report end date must be on or after its start date.')
    name = namer(s)
    company = s.get('company') or {}
    if report in MONTHLY_REPORTS:
        b, rows, summary = monthly_task_rows(s, f)
        category = next((c[0] for c in MONTHLY_CATEGORIES if c[2] == report), None)
        order = {'completed': 0, 'in_progress': 1, 'stuck': 2, 'overdue': 3}
        listed = sorted([r for r in rows if r['category'] == category] if category else rows,
                        key=lambda r: (order[r['category']], str(r['due_date']), r['id']))
        return {'id': report, 'title': f"{TASK_REPORTS[report]} · {b['label']}", 'company': company.get('name'), 'currency': company.get('currency'),
                'columns': MONTHLY_COLUMNS[report], 'rows': listed, 'totals': {}, 'summary': summary, 'month': b['month'], 'month_label': b['label'],
                'groups': [], 'filters': {**f, 'month': b['month']}, 'generated_at': now_iso()}
    tasks = [t for t in enriched_tasks(s) if (not f.get('workspace') or t['workspace_id'] == f['workspace'])
             and (not f.get('user') or f['user'] in t['assignees']) and (not f.get('department') or t['department'] == f['department'])]

    def period(d):
        return (not f.get('from') or d >= f['from']) and (not f.get('to') or d <= f['to'])
    workspaces = {w['id']: w for w in s['tm_workspaces']}
    if report == 'tasks':
        rows = [{**t, 'group': t['workspace'], 'pic': name(t['pic_id']), 'supporting': ', '.join(name(x) for x in t['supporters']),
                 'assigned_to': ', '.join(name(x) for x in t['assignees']), 'status': dm.TASK_STATUS[t['status']], 'state': dm.task_state_label(t),
                 'logged': dm.format_minutes(t['logged_minutes']), 'estimate': dm.format_minutes(t['estimate_minutes']), 'overdue': 'Yes' if t['overdue'] else 'No'}
                for t in tasks if period(t['due_date']) and (not f.get('status') or t['status'] == f['status'])]
        columns = [['id', 'Task'], ['title', 'Title'], ['workspace', 'Workspace'], ['department', 'Department'], ['pic', 'Person in charge'],
                   ['supporting', 'Supporting'], ['start_date', 'Start'], ['due_date', 'Due'], ['status', 'Status'], ['state', 'Workflow state'],
                   ['priority', 'Priority'], ['progress', 'Progress %'], ['estimate', 'Estimated H:MM'], ['logged', 'Logged H:MM'], ['overdue', 'Overdue']]
    elif report == 'time':
        by_id = {t['id']: t for t in s['tm_tasks']}
        options = {t['id']: t for t in s.get('tm_task_options') or []}
        rows = []
        for e in s['tm_timesheets']:
            if not period(e['work_date']) or (f.get('user') and e['staff_id'] != f['user']):
                continue
            t = by_id.get(e['task_id']) or options.get(e['task_id']) or {'workspace_id': e.get('workspace_id') or '', 'title': e.get('activity') or 'Independent work'}
            w = workspaces.get(t['workspace_id'])
            r = {**e, 'workspace_id': t['workspace_id'], 'group': name(e['staff_id']), 'user': name(e['staff_id']), 'task': t['title'],
                 'workspace': w['name'] if w else UNDEFINED, 'duration': dm.format_minutes(e['minutes'])}
            if not f.get('workspace') or r['workspace_id'] == f['workspace']:
                rows.append(r)
        columns = [['work_date', 'Date'], ['user', 'User'], ['task_id', 'Task'], ['task', 'Title'], ['workspace', 'Workspace'], ['duration', 'H:MM'],
                   ['minutes', 'Minutes'], ['notes', 'Notes']]
    elif report == 'workload':
        scope = s.get('task_scope')
        limit = None
        if scope and not scope.get('company'):
            me = ((s.get('auth') or {}).get('user') or {}).get('staff_id')
            limit = {*(x for t in tasks for x in t['assignees']), *(e['staff_id'] for e in s['tm_timesheets']), *(scope.get('team') or []), *([me] if me else [])}
        rows = []
        by_id = {t['id']: t for t in s['tm_tasks']}
        for p in s['tm_profiles']:
            if (limit is not None and p['staff_id'] not in limit) or (f.get('user') and p['staff_id'] != f['user']):
                continue
            own = [t for t in tasks if p['staff_id'] in t['assignees'] and period(t['due_date'])]
            entries = [e for e in s['tm_timesheets'] if e['staff_id'] == p['staff_id'] and period(e['work_date'])
                       and (not f.get('workspace') or (e.get('workspace_id') or (by_id.get(e['task_id']) or {}).get('workspace_id')) == f['workspace'])]
            total = sum(e['minutes'] for e in entries)
            rows.append({'id': p['staff_id'], 'group': 'Team', 'user': name(p['staff_id']), 'tasks': len(own), 'in_charge': len([t for t in own if t['pic_id'] == p['staff_id']]),
                         'open': len([t for t in own if t['status'] not in ('COMPLETED', 'CANCELLED')]), 'completed': len([t for t in own if t['status'] == 'COMPLETED']),
                         'stuck': len([t for t in own if t['stuck']]), 'overdue': len([t for t in own if t['overdue']]), 'minutes': total, 'logged': dm.format_minutes(total)})
        columns = [['user', 'User'], ['tasks', 'Assigned tasks'], ['in_charge', 'In charge'], ['open', 'Open'], ['completed', 'Completed'], ['stuck', 'Stuck'],
                   ['overdue', 'Overdue'], ['logged', 'Logged H:MM']]
    elif report == 'workspace':
        rows = []
        for w in s['tm_workspaces']:
            if f.get('workspace') and w['id'] != f['workspace']:
                continue
            own = [t for t in tasks if t['workspace_id'] == w['id'] and period(t['due_date'])]
            eligible = [t for t in own if t['status'] != 'CANCELLED']
            ids = {t['id'] for t in own}
            total = sum(e['minutes'] for e in s['tm_timesheets'] if e['task_id'] in ids and period(e['work_date']) and (not f.get('user') or e['staff_id'] == f['user']))
            rows.append({'id': w['id'], 'group': 'Workspaces', 'workspace': w['name'], 'department': w['department'], 'owner': name(w['owner_id']),
                         'status': w['status'], 'tasks': len(own), 'completed': len([t for t in own if t['status'] == 'COMPLETED']),
                         'overdue': len([t for t in own if t['overdue']]),
                         'progress': js_round(sum(t['progress'] for t in eligible) / len(eligible)) if eligible else 0, 'minutes': total,
                         'logged': dm.format_minutes(total)})
        columns = [['workspace', 'Workspace'], ['department', 'Department'], ['owner', 'Owner'], ['status', 'Status'], ['tasks', 'Tasks'],
                   ['completed', 'Completed'], ['overdue', 'Overdue'], ['progress', 'Progress %'], ['logged', 'Logged H:MM']]
    else:
        rows = []
        for m in s['tm_meetings']:
            if f.get('workspace') and m['workspace_id'] != f['workspace']:
                continue
            if f.get('user') and not any(a['meeting_id'] == m['id'] and a['staff_id'] == f['user'] for a in s['tm_attendees']):
                continue
            if not period(dm.local_day(m['start_at'])) or (f.get('status') and m['status'] != f['status']):
                continue
            w = workspaces.get(m['workspace_id'])
            rows.append({**m, 'group': 'Meetings', 'workspace': w['name'] if w else UNDEFINED, 'organizer': name(m['organizer_id']),
                         'date': dm.local_day(m['start_at']), 'attendees': ', '.join(name(a['staff_id']) for a in s['tm_attendees'] if a['meeting_id'] == m['id'])})
        columns = [['id', 'Meeting'], ['title', 'Subject'], ['workspace', 'Workspace'], ['date', 'Date (Cambodia)'], ['start_at', 'Start UTC'],
                   ['end_at', 'End UTC'], ['status', 'Status'], ['organizer', 'Organizer'], ['attendees', 'Attendees'], ['minutes_notes', 'Meeting notes']]
    total = sum(int(js_number_or_zero(r.get('minutes'))) for r in rows)
    return strip({'id': report, 'title': TASK_REPORTS[report], 'company': company.get('name'), 'currency': company.get('currency'), 'columns': columns,
                  'rows': rows, 'totals': {'minutes': total}, 'groups': [], 'filters': f, 'generated_at': now_iso()})


def js_round(x):
    """Math.round: halves round up."""
    import math
    return int(math.floor(x + 0.5))


def js_number_or_zero(v):
    from core.validation import js_number
    n = js_number(v)
    return 0 if isinstance(n, float) and n != n else n


# ---------------------------------------------------------------- CSV and print pages
def report_value(row, key, currency):
    if key.endswith('_cents'):
        amount = (js_number_or_zero(row.get(key)) or 0) / 100
        return ('-' if amount < 0 else '') + {'USD': '$', 'KHR': 'KHR '}.get(currency, (currency or '') + ' ') + f'{abs(amount):,.2f}'
    value = row.get(key)
    return js_text(value)


def js_text(value):
    if value is None or value is UNDEFINED:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (list, dict)):
        return ','.join(js_text(v) for v in value) if isinstance(value, list) else '[object Object]'
    return str(value)


def report_csv(r):
    def cell(x):
        text = js_text(x)
        if text[:1] in ('=', '+', '-', '@', '\t', '\r'):
            text = "'" + text
        return '"' + text.replace('"', '""') + '"'
    lines = [[c[1] for c in r['columns']], *[[report_value(row, key, r.get('currency')) for key, _ in r['columns']] for row in r['rows']]]
    return '﻿' + '\r\n'.join(','.join(cell(x) for x in line) for line in lines)


def esc(value):
    return html.escape(js_text(value), quote=True).replace('&#x27;', '&#39;')


def task_report_html(r):
    head = ''.join(f'<th>{esc(label)}</th>' for _, label in r['columns'])
    body = ''.join('<tr>' + ''.join(f'<td>{esc(row.get(k))}</td>' for k, _ in r['columns']) + '</tr>' for row in r['rows'])
    minutes = (r.get('totals') or {}).get('minutes')
    filters = json.dumps(r['filters'], separators=(',', ':'), ensure_ascii=False)
    return ('<!doctype html><html lang="en"><meta charset="utf-8"><title>' + esc(r['title']) + '</title><style>body{font:13px Arial,sans-serif;color:#18283f;'
            'margin:30px}h1{font-size:24px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ddd;padding:8px;'
            'vertical-align:top}th{background:#edf2f9}p,small{color:#546477}button{padding:10px}@media print{button{display:none}@page{size:landscape;'
            'margin:12mm}}</style><button id="print">Print / Save as PDF</button><h1>' + esc(r['company']) + ' · ' + esc(r['title']) + '</h1><p>Filters: '
            + esc(filters) + '</p><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table><p>' + str(len(r['rows'])) + ' rows'
            + (f' · {dm.format_minutes(minutes)} logged (H:MM)' if minutes else '') + '</p><small>Dates use Cambodia time; meeting timestamps labeled UTC '
            'use UTC. Shared assignments count once for each assignee. Generated ' + esc(r['generated_at']) + '.</small><script src="/print.js"></script></html>')


# ---------------------------------------------------------------- data sources for the dashboard and custom reports (erp-sources.mjs)
OPS_RESOURCES = ['ops.quotation', 'ops.po', 'ops.job', 'ops.dn', 'ops.pr']
SOURCES = [
    ('contacts', 'CRM · Contacts', 'Created date', ['crm.contacts']), ('leads', 'CRM · Leads', 'Created date', ['crm.leads']),
    ('opportunities', 'CRM · Opportunities', 'Expected close date', ['crm.opportunities']), ('quotations', 'CRM · Quotations', 'Created date', ['crm.quotations']),
    ('accounts', 'CRM · Business Accounts', 'Customer since', ['crm.accounts']), ('campaigns', 'CRM · Campaigns', 'Start date', ['crm.campaigns']),
    ('crm_activities', 'CRM · Activities', 'Activity start', ['crm.activities']), ('documents', 'CRM · Document links', 'Created date', ['crm.documents']),
    ('workspaces', 'Tasks · Workspaces', 'Created date', ['tasks.workspace']), ('staff', 'Tasks · Employee profiles', 'No date field', ['tasks.users']),
    ('tasks', 'Tasks · Task register', 'Due date', ['tasks.tasks']), ('timesheets', 'Tasks · Time entries', 'Work date', ['tasks.timesheets']),
    ('meetings', 'Tasks · Meetings', 'Meeting start', ['tasks.meetings']), ('ops_requests', 'Operations · Requests', 'Document date', OPS_RESOURCES),
    ('shipments', 'Operations · Shipments', 'ETA or issue date', ['ops.job']), ('receivables', 'Finance · Receivables', 'Debit Note date', ['ops.finance']),
    ('payables', 'Finance · Payables', 'Debit Note date', ['ops.finance']), ('users', 'Administration · User accounts', 'Created date', ['admin.users']),
]
SOURCE_BY_ID = {x[0]: {'id': x[0], 'label': x[1], 'dateLabel': x[2], 'resources': x[3]} for x in SOURCES}
FIELD_DEFS = {'id': 'Record', 'title': 'Title / description', 'client': 'Client', 'account_id': 'Business Account', 'opportunity': 'Opportunity',
              'users': 'User / owner / assignee', 'department': 'Department', 'date': 'Date', 'status': 'Status', 'category': 'Category',
              'amount_cents': 'Amount / balance', 'minutes': 'Time (H:MM)', 'notes': 'Notes / details'}
OPEN_TARGET = {'contact': 'crm.contacts', 'lead': 'crm.leads', 'opportunity': 'crm.opportunities', 'quotation': 'crm.quotations', 'campaign': 'crm.campaigns',
               'account': 'crm.accounts', 'activity': 'crm.activities', 'tm_workspace': 'tasks.workspace', 'tm_profile': 'tasks.users', 'tm_task': 'tasks.tasks',
               'tm_time': 'tasks.timesheets', 'tm_meeting': 'tasks.meetings', 'admin_user': 'admin.users'}


def allowed(perms, resource, action='view'):
    return action in (perms or {}).get(resource, [])


def unique(values):
    return list(dict.fromkeys(v for v in values if v))


class Context:
    def __init__(self, s):
        self.names = {}
        for l in s['lookups']:
            self.names[l['id']] = l['name']
        self.profiles = {p['staff_id']: p for p in s['tm_profiles']}

    def departments(self, ids):
        return unique((self.profiles.get(i) or {}).get('department') for i in ids)

    @staticmethod
    def date(value):
        return (value if len(value) == 10 else dm.local_day(value)) if value else ''

    def row(self, key, title, contact, user_ids, values=None):
        ids = unique(user_ids)
        return {'id': key, 'title': title, 'client_id': contact or '', 'client': '', 'account_id': '', 'account': '', 'opportunity_ids': [], 'opportunity': '',
                'user_ids': ids, 'users': ', '.join(self.names.get(i) or i for i in ids), 'departments': self.departments(ids),
                'department': ', '.join(self.departments(ids)), 'date': '', 'status': '', 'category': '', 'amount_cents': None, 'minutes': None, 'notes': '',
                **(values or {})}


def opportunity(t):
    related = (t or {}).get('related_type') == 'OPPORTUNITY'
    return ([t['related_id']] if related else []), (t['related_id'] if related else '')


def read_source(key, s, c):
    go = lambda kind, ident, **extra: {'type': kind, 'id': ident, **extra}
    workspaces = {w['id']: w for w in s['tm_workspaces']}
    if key == 'workspaces':
        return [c.row(r['id'], r['name'], None, [r['owner_id']], {'date': c.date(r['created_at']), 'status': r['status'],
                                                                 'departments': [r['department']] if r['department'] else [], 'department': r['department'],
                                                                 'notes': r['description'], 'target': go('tm_workspace', r['id']), 'resource': 'tasks.workspace'})
                for r in s['tm_workspaces']]
    if key == 'staff':
        return [c.row(r['staff_id'], r['name'], None, [r['staff_id']], {'status': 'ACTIVE' if r['active'] else 'INACTIVE', 'category': r['position'],
                                                                       'notes': ' · '.join(x for x in (r['email'], r['phone']) if x),
                                                                       'target': go('tm_profile', r['staff_id']), 'resource': 'tasks.users'})
                for r in s['tm_profiles']]
    if key == 'tasks':
        out = []
        for r in s['tm_tasks']:
            people = [a['staff_id'] for a in s['tm_assignees'] if a['task_id'] == r['id']]
            department = r['department'] or (workspaces.get(r['workspace_id']) or {}).get('department', UNDEFINED)
            departments = unique([None if department is UNDEFINED else department, *c.departments(people)])
            ids, opp = opportunity(r)
            out.append(c.row(r['id'], r['title'], r.get('contact_id'), people, {
                'date': r['due_date'], 'status': r['status'], 'category': r['priority'], 'departments': departments, 'department': ', '.join(departments),
                'opportunity_ids': ids, 'opportunity': opp,
                'notes': '\n'.join(x for x in (r['description'], r['department_note'] and 'Department note: ' + r['department_note'],
                                               r.get('stuck_at') and 'Stuck: ' + r['stuck_reason']) if x),
                'progress': r['progress'], 'assignee': r['pic_id'], 'target': go('tm_task', r['id']), 'resource': 'tasks.tasks'}))
        return out
    if key == 'timesheets':
        by_id = {t['id']: t for t in s['tm_tasks']}
        refs = {t['id']: t for t in s.get('tm_task_refs') or []}
        out = []
        for r in s['tm_timesheets']:
            t = by_id.get(r['task_id']) or refs.get(r['task_id']) or {'id': r['task_id'], 'title': r['task_id']}
            department = (workspaces.get(t.get('workspace_id')) or {}).get('department')
            departments = unique([*c.departments([r['staff_id']]), department])
            ids, opp = opportunity(t)
            out.append(c.row(r['id'], t['title'], t.get('contact_id'), [r['staff_id']], {
                'date': r['work_date'], 'status': t.get('status', UNDEFINED), 'minutes': r['minutes'], 'departments': departments,
                'department': ', '.join(departments), 'opportunity_ids': ids, 'opportunity': opp, 'notes': r['notes'], 'target': go('tm_time', r['id']),
                'resource': 'tasks.timesheets'}))
        return out
    if key == 'meetings':
        by_id = {t['id']: t for t in s['tm_tasks']}
        out = []
        for r in s['tm_meetings']:
            ids, opp = opportunity(by_id.get(r.get('task_id')))
            out.append(c.row(r['id'], r['title'], r.get('contact_id'), [a['staff_id'] for a in s['tm_attendees'] if a['meeting_id'] == r['id']], {
                'date': c.date(r['start_at']), 'status': r['status'], 'opportunity_ids': ids, 'opportunity': opp,
                'notes': '\n'.join(x for x in (r['agenda'], r['minutes_notes']) if x), 'target': go('tm_meeting', r['id']), 'resource': 'tasks.meetings'}))
        return out
    if key == 'users':
        roles = {r['id']: r['name'] for r in s.get('access_roles') or []}
        return [c.row(r['id'], r['name'], None, [r['staff_id']], {'date': c.date(r['created_at']), 'status': 'ACTIVE' if r['active'] else 'DISABLED',
                                                                  'category': roles.get(r['role_id']) or r['role_id'], 'notes': r['email'],
                                                                  'target': go('admin_user', r['id']), 'resource': 'admin.users'})
                for r in s.get('access_users') or []]
    return []   # CRM, Operations and Finance: their modules are off, so their tables are empty


def data_catalog(perms):
    return [{'id': d['id'], 'label': d['label'], 'module': module_for_source(d['id']), 'dateLabel': d['dateLabel'],
             'canExport': all(allowed(perms, r, 'export') for r in d['resources'] if allowed(perms, r))}
            for d in SOURCE_BY_ID.values() if any(allowed(perms, r) for r in d['resources'])]


def can_open(target, perms):
    if not target:
        return False
    if target['type'] == 'operations':
        return allowed(perms, target.get('resource'))
    return allowed(perms, OPEN_TARGET.get(target['type']))


def authorized_records(user, ids, exporting=False, gov=None):
    from compat.state import full_state, filter_state, query
    from organization.governance import Governance
    from tasks.scope import TaskScope
    gov = gov or Governance()
    perms = access.permissions(user)
    s = filter_state(full_state(), user, gov)
    sc = TaskScope(gov).filter_state(s, user.staff_id)
    for k in ('tm_tasks', 'tm_assignees', 'tm_timesheets', 'tm_meetings', 'tm_attendees', 'tm_task_refs'):
        s[k] = sc.get(k) or []
    s['access_users'] = (query('SELECT u.id,u.staff_id,u.email,u.role_id,u.active,u.created_at,l.name FROM access_users u JOIN staff l ON l.id=u.staff_id ORDER BY u.id')
                         if allowed(perms, 'admin.users') else [])
    s['access_roles'] = query('SELECT id,name FROM access_roles ORDER BY created_at,id')
    c, rows = Context(s), []
    for key in ids:
        d = SOURCE_BY_ID.get(key)
        if not d:
            raise InputError('Unknown report data source: ' + str(key), 400)
        visible = [r for r in d['resources'] if allowed(perms, r)]
        if not visible:
            raise InputError('Your account cannot view ' + d['label'] + '.', 403)
        if exporting and any(not allowed(perms, r, 'export') for r in visible):
            raise InputError('Export permission is required for ' + d['label'] + '.', 403)
        for r in read_source(key, s, c):
            if not allowed(perms, r['resource']):
                continue
            rows.append({**r, 'source': key, 'source_label': d['label'], 'module': module_for_source(key), 'date_label': d['dateLabel'],
                         'can_open': can_open(r.get('target'), perms)})
    return rows, s


def validate_filters(f=None):
    f = f or {}
    if not isinstance(f, dict):
        raise InputError('Invalid filters.', 400)
    out = {}
    for key in ('sources', 'clients', 'accounts', 'opportunities', 'users', 'statuses', 'departments', 'modules', 'fields', 'categories', 'assignees'):
        value = f.get(key)
        value = [] if value is None else value
        if not isinstance(value, list) or len(value) > 100 or any(not isinstance(v, str) or len(v) > 200 for v in value):
            raise InputError('Invalid ' + key + ' selection.', 400)
        out[key] = list(dict.fromkeys(value))
    for key in ('from', 'to'):
        v = f.get(key) or ''
        if v and not valid_day(v):
            raise InputError('Enter valid report dates.', 400)
        out[key] = v
    if out['from'] and out['to'] and out['from'] > out['to']:
        raise InputError('End date must be on or after start date.', 400)
    out['search'] = js_text(f.get('search') or '')[:200]
    return out


def filter_records(rows, f):
    def any_of(values, value):
        return not values or value in values

    def some(values, listed):
        return not values or any(v in values for v in listed)
    search = f['search'].lower()
    return [r for r in rows if any_of(f['clients'], r['client_id']) and any_of(f['accounts'], r['account_id']) and some(f['opportunities'], r['opportunity_ids'])
            and some(f['users'], r['user_ids']) and any_of(f['statuses'], r.get('status')) and some(f['departments'], r['departments'])
            and any_of(f['modules'], r['module']) and any_of(f.get('categories') or [], r.get('category')) and any_of(f.get('assignees') or [], r.get('assignee'))
            and (not f['from'] or (r['date'] or '') >= f['from']) and (not f['to'] or (r['date'] and r['date'] <= f['to']))
            and (not search or search in ' '.join(js_text(x) for x in (r['id'], r['title'], r['client'], r['notes'])).lower())]


def js_sorted(values):
    """Array.prototype.sort() on strings (undefined last)."""
    present = [v for v in values if v is not None and v is not UNDEFINED]
    return sorted(present, key=js_text) + [v for v in values if v is None or v is UNDEFINED]


def build_dashboard(user, filters_input=None):
    from compat.state import full_state, filter_state
    from organization.governance import Governance
    access.require_permission(user, 'dashboard')
    gov = Governance()
    filters = validate_filters(filters_input)
    perms = access.permissions(user)
    sources = data_catalog(perms)
    source_ids = [x['id'] for x in sources]
    records, _ = authorized_records(user, source_ids, gov=gov)
    records = filter_records(records, filters)
    widgets = []
    for module in ERP_MODULES:
        if not access.module_enabled(module['id']) or (filters['modules'] and module['id'] not in filters['modules']):
            continue
        definitions = module['widgets'] or [{'id': module['id'] + '-' + src, 'kind': 'kpi', 'title': next((x['label'] for x in sources if x['id'] == src), UNDEFINED),
                                             'source': src, 'metric': 'count'} for src in module['sources']]
        for widget in definitions:
            if widget['source'] not in source_ids:
                continue
            rows = [r for r in records if r['source'] == widget['source']]
            if widget.get('status'):
                rows = [r for r in rows if r.get('status') in widget['status']]
            if widget.get('exclude'):
                rows = [r for r in rows if r.get('status') not in widget['exclude']]
            if widget.get('assignee') == 'current':
                rows = [r for r in rows if r.get('assignee') == user.staff_id and allowed(perms, r['resource'], 'approve')]
            statuses = list(dict.fromkeys(r.get('status') for r in rows))
            if widget.get('status'):
                drill_status = [x for x in widget['status'] if x in filters['statuses']] if filters['statuses'] else widget['status']
            else:
                drill_status = statuses if widget.get('exclude') else filters['statuses']
            drill = {**filters, 'sources': [widget['source']], 'statuses': drill_status,
                     **({'assignees': [user.staff_id]} if widget.get('assignee') == 'current' else {})}
            if (widget.get('exclude') or widget.get('status')) and not rows:
                drill['statuses'] = ['__NONE__']
            if widget.get('assignee') == 'current':
                drill['categories'] = list(dict.fromkeys(r.get('category') for r in rows)) or ['__NONE__']
            base = {**widget, 'module': module['id'], 'module_label': module['label'], 'count': len(rows),
                    'dateLabel': next(x['dateLabel'] for x in sources if x['id'] == widget['source']), 'drill': drill}
            if widget['kind'] == 'kpi':
                metric = widget.get('metric')
                value = (sum(r.get('amount_cents') or 0 for r in rows) if metric == 'amount' else sum(r.get('minutes') or 0 for r in rows)
                         if metric == 'minutes' else len(rows))
                widgets.append({**base, 'value': value})
            elif widget['kind'] == 'bar':
                group = widget['group']
                labels = js_sorted(list(dict.fromkeys(r.get(group, UNDEFINED) for r in rows)))
                widgets.append({**base, 'bars': [{'label': label or 'Unspecified', 'value': len([r for r in rows if r.get(group, UNDEFINED) == label]),
                                                  'drill': {**drill, ('categories' if group == 'category' else 'statuses'): [label]}} for label in labels]})
            else:
                ordered = sorted(rows, key=lambda r: r.get('date') or '9999')
                widgets.append({**base, 'rows': ordered[:widget.get('limit') or 5]})
    scoped = filter_state(full_state(), user, gov)
    targets = {'task': 'tm_task', 'meeting': 'tm_meeting', 'timesheet': 'tm_time', 'workspace': 'tm_workspace', 'user': 'tm_profile'}
    recent = [{**e, 'target': {'type': targets[e['entity_type']], 'id': e['entity_id']}} for e in scoped['tm_events'] if e['entity_type'] in targets]
    recent = sorted(recent, key=lambda e: e['created_at'], reverse=True)[:8]
    modules = [{'id': m['id'], 'label': m['label']} for m in ERP_MODULES if any(x['module'] == m['id'] for x in sources)]
    return strip({'generated_at': now_iso(), 'widgets': widgets, 'notifications': [], 'recent': recent, 'filters': filters, 'modules': modules,
                  'sources': sources, 'summary': {'sources': len(sources), 'modules': len({x['module'] for x in sources}), 'records': len(records)}})


def build_erp_report(user, input_=None, exporting=False):
    from core.services import company
    input_ = input_ or {}
    access.require_permission(user, 'reports.central', 'export' if exporting else 'view')
    filters = validate_filters(input_)
    available = data_catalog(access.permissions(user))
    ids = filters['sources'] or [x['id'] for x in available]
    if not ids:
        raise InputError('Your role has no report data sources.', 403)
    rows, _ = authorized_records(user, ids, exporting)
    rows = filter_records(rows, filters)
    rows.sort(key=lambda r: r['id'])
    rows.sort(key=lambda r: js_text(r['date']), reverse=True)
    rows.sort(key=lambda r: r['source'])
    if len(rows) > 5000:
        raise InputError('More than 5,000 rows match. Narrow your filters before generating this report.', 400)
    fields = filters['fields'] or ['id', 'title', 'client', 'date', 'status', 'amount_cents']
    if any(k not in FIELD_DEFS for k in fields):
        raise InputError('Unknown report column.', 400)
    sections = []
    for key in ids:
        listed = [r for r in rows if r['source'] == key]
        sections.append({'id': key, 'title': SOURCE_BY_ID[key]['label'], 'dateLabel': SOURCE_BY_ID[key]['dateLabel'], 'rows': listed,
                         'total_cents': sum(r.get('amount_cents') or 0 for r in listed) if any(r.get('amount_cents') is not None for r in listed) else None,
                         'total_minutes': sum(r.get('minutes') or 0 for r in listed) if any(r.get('minutes') is not None for r in listed) else None})
    current = company()
    return strip({'id': 'custom-erp', 'title': js_text(input_.get('title') or 'Custom Task Controlling Management report')[:160],
                  'company': current.name if current else None, 'currency': current.currency if current else None, 'generated_at': now_iso(),
                  'filters': filters, 'columns': [[k, FIELD_DEFS[k]] for k in fields], 'sections': sections, 'rows': rows, 'totals': {}, 'groups': [],
                  'source_count': len(sections)})


def report_options(user):
    from compat.state import lookups
    access.require_permission(user, 'reports.central')
    sources = data_catalog(access.permissions(user))
    rows, _ = authorized_records(user, [x['id'] for x in sources])

    def pair(key, label):
        found = {}
        for r in rows:
            if r.get(key):
                found[r[key]] = {'id': r[key], 'label': r.get(label) or r[key]}
        return list(found.values())
    names = {l['id']: l['name'] for l in lookups()}

    def flat(key, label):
        values = sorted({v for r in rows for v in (r.get(key) or []) if v})
        return [{'id': v, 'label': label(v)} for v in values]
    return {'sources': sources, 'fields': FIELD_DEFS, 'clients': pair('client_id', 'client'), 'accounts': pair('account_id', 'account'),
            'opportunities': flat('opportunity_ids', lambda v: v), 'users': flat('user_ids', lambda v: names.get(v) or v),
            'departments': flat('departments', lambda v: v),
            'statuses': [{'id': v, 'label': v} for v in sorted({r.get('status') for r in rows if r.get('status') and r.get('status') is not UNDEFINED})],
            'modules': [{'id': m['id'], 'label': m['label']} for m in ERP_MODULES if any(x['module'] == m['id'] for x in sources)]}


def display_value(row, key, currency):
    if key == 'amount_cents':
        return '—' if row.get(key) is None else report_value(row, key, currency)
    if key == 'minutes':
        return '—' if row.get(key) is None else dm.format_minutes(row[key])
    return js_text(row.get(key))


def source_records(user, input_=None):
    f = validate_filters(input_)
    if len(f['sources']) != 1:
        raise InputError('Choose one data source.', 400)
    rows, _ = authorized_records(user, f['sources'])
    rows = filter_records(rows, f)
    d = SOURCE_BY_ID[f['sources'][0]]
    return strip({'source': d['id'], 'title': d['label'], 'dateLabel': d['dateLabel'], 'filters': f, 'rows': rows, 'total': len(rows)})


# ---------------------------------------------------------------- the Telegram Mini App state (telegram-gateway.mjs miniState)
def mini_state(user, media='', gov=None):
    from compat.state import full_state, filter_state
    from core.services import change_seq
    from organization.governance import Governance
    from telegram import services as telegram
    gov = gov or Governance()
    s = filter_state(full_state(), user, gov)
    tasks = {t['id'] for t in s['tm_tasks']}
    history = [h for h in s.get('tm_task_history') or [] if h['task_id'] in tasks]
    per, kept = {}, []
    for h in reversed(history):
        n = per.get(h['task_id'], 0)
        if n < 60:
            per[h['task_id']] = n + 1
            kept.append(h)
    kept.reverse()
    link = telegram.link_for_staff(user.staff_id)
    me = access.public_user(user)
    return {
        **{k: s.get(k, []) for k in ('tm_boards', 'tm_board_access', 'tm_board_summaries', 'tm_group_workspaces')},
        'operational_access': s['operational_access'], 'tm_task_members': s.get('tm_task_members', []),
        'management_people': s.get('management_people', []),
        'company': {'name': (s['company'] or {}).get('name')}, 'app_version': s['app_version'], 'today': now_iso(), 'media_token': media,
        'auth': {'user': {'staff_id': user.staff_id, 'name': me['name'], 'username': me['username'], 'role_name': me['role_name'], 'email': me['email']},
                 'permissions': {k: v for k, v in s['auth']['permissions'].items() if k.startswith('tasks.')}},
        'lookups': [{'id': l['id'], 'name': l['name'], 'username': l.get('username'), 'nickname': l.get('nickname'), 'kind': 'staff', 'active': l['active']}
                    for l in s['lookups'] if l['kind'] == 'staff'],
        'tm_workspaces': s['tm_workspaces'], 'tm_workspace_refs': s['tm_workspace_refs'], 'tm_members': s['tm_members'], 'organization': s['organization'],
        'workspace_dashboard': s['workspace_dashboard'], 'tm_tasks': s['tm_tasks'], 'tm_assignees': s['tm_assignees'], 'tm_timesheets': s['tm_timesheets'],
        'tm_calendar_tasks': s['tm_calendar_tasks'], 'tm_meeting_changes': s['tm_meeting_changes'], 'tm_requests': s['tm_requests'],
        'tm_due_requests': s['tm_due_requests'], 'tm_change_requests': [c for c in s.get('tm_change_requests') or [] if c['task_id'] in tasks],
        'tm_task_history': kept, 'tm_notifications': [n for n in s['tm_notifications'] if n['kind'] != 'telegram_connected'],
        'tm_profiles': [{'staff_id': p['staff_id'], 'name': p['name'], 'nickname': p['nickname'], 'username': p['username'], 'department': p['department'] or '',
                         'position': p['position'] or '', 'active': p['active'], 'manager_id': p['manager_id'], 'org_level': p['org_level']} for p in s['tm_profiles']],
        'tm_people': s['tm_people'], 'tm_checklist': [c for c in s.get('tm_checklist') or [] if c['task_id'] in tasks],
        'tm_files': [f for f in s.get('tm_files') or [] if f['task_id'] in tasks], 'staff_photos': s.get('staff_photos') or [],
        'telegram': {'bot_username': telegram.settings()['bot_username'], 'link': {'notify': bool(link['notify'])} if link else None},
        'task_scope': s['task_scope'], 'my_timezone': s['my_timezone'],
        'tm_meetings': [{k: v for k, v in m.items() if k != 'creation_key'} for m in s.get('tm_meetings') or []], 'tm_attendees': s.get('tm_attendees') or [],
        'tm_meeting_shares': s.get('tm_meeting_shares') or [], 'tm_meeting_followers': s.get('tm_meeting_followers') or [],
        'tm_calendar_notes': s.get('tm_calendar_notes') or [], 'change_seq': change_seq(),
    }


__all__ = ['build_task_report', 'report_csv', 'task_report_html', 'build_dashboard', 'build_erp_report', 'report_options', 'source_records',
           'display_value', 'mini_state', 'enriched_tasks', 'timedelta', 'connection']

"""Task Visibility Scope — port of task-scope.mjs (V5.5–V5.7.7). One rule for who may see which task and meeting,
used by the web app, the Telegram bot, the Mini App, reports, the calendar, exports and every task command.

 - Everyone sees the tasks they are directly involved in (person in charge, supporting person, reviewer, assigner,
   creator, or the person a decision is currently waiting for).
 - A manager also sees the tasks whose person in charge reports to them, directly or indirectly. Supporting someone,
   or having looked at a task, never widens this.
 - "Task Management · All company tasks" (tasks.company, View) sees every task of the company.
 - Organizational Structure governance (workspace privacy, membership, Level 1) overrides the authority path.
 - Seeing a task never subscribes anyone to its notifications and never grants editing, approval or closing.
"""
import hashlib
import json
import uuid

from django.db.models import Q

from organization.governance import NOTSET, is_personal_workspace
from organization.models import Profile

from .models import DueDateRequest, Task, TaskAssignee, TaskChangeRequest

SCOPE_REASONS = {'involved': 'You are on this task', 'team': 'Someone in your reporting line is in charge',
                 'company': 'Company-wide task access', 'organization': 'Organization administrator',
                 'membership': 'Workspace member', 'owner': 'Workspace owner', 'governance': 'Workspace governance'}


def reports_under(staff, links):
    children = {}
    for s, m in links:
        if m and s != m:
            children.setdefault(m, []).append(s)
    out, queue = {}, list(children.get(staff, []))   # a dict keeps the order people were reached in (a JavaScript Set)
    while queue:
        s = queue.pop(0)
        if s == staff or s in out:
            continue
        out[s] = True
        queue.extend(children.get(s, []))
    return out.keys()


def managers_of(staff, links):
    up = {s: m for s, m in links if m and s != m}
    out, at = [], up.get(staff)
    while at and at not in out and at != staff:
        out.append(at)
        at = up.get(at)
    return out


def task_reason(t, staff, involved, team, company):
    if t['id'] in involved:
        return 'involved'
    if t.get('pic_id') and t['pic_id'] in team:
        return 'team'
    if company:
        return 'company'
    return None


class TaskScope:
    def __init__(self, governance):
        self.gov = governance
        self.instance = str(uuid.uuid4())

    # ------------------------------------------------------------ basics
    def links(self):
        return list(Profile.objects.filter(manager__isnull=False).order_by('staff_id').values_list('staff_id', 'manager_id'))

    def company_wide(self, staff):
        return bool(staff) and (self.gov.can_staff(staff, 'tasks.company', 'view') or self.gov.global_workspaces(staff))

    def team(self, staff):
        return reports_under(staff, self.links())

    def managers(self, staff):
        return managers_of(staff, self.links())

    def involved_ids(self, staff):
        ids = set(Task.objects.filter(Q(pic_id=staff) | Q(created_by_id=staff) | Q(assigned_by_id=staff) | Q(reviewer_id=staff)
                                      | Q(submitted_to_id=staff)).values_list('id', flat=True))
        ids |= set(TaskAssignee.objects.filter(staff_id=staff).values_list('task_id', flat=True))
        ids |= set(TaskChangeRequest.objects.filter(approver_id=staff, status='PENDING').values_list('task_id', flat=True))
        ids |= set(DueDateRequest.objects.filter(decide_by_id=staff, status='PENDING').values_list('task_id', flat=True))
        return ids

    def is_involved(self, staff, t):
        if not staff or not t:
            return False
        if staff in (t.get('pic_id'), t.get('created_by'), t.get('assigned_by'), t.get('reviewer_id'), t.get('submitted_to')):
            return True
        return (TaskAssignee.objects.filter(task_id=t['id'], staff_id=staff).exists()
                or TaskChangeRequest.objects.filter(task_id=t['id'], approver_id=staff, status='PENDING').exists()
                or DueDateRequest.objects.filter(task_id=t['id'], decide_by_id=staff, status='PENDING').exists())

    def reason(self, staff, t):
        if not staff or not t:
            return None
        direct = self.is_involved(staff, t)
        org = self.gov.task_reason(staff, t, direct)
        if org is not NOTSET:
            return org
        if direct:
            return 'involved'
        if t.get('pic_id') and t['pic_id'] in self.team(staff):
            return 'team'
        return 'company' if self.company_wide(staff) else None

    def can_see(self, staff, t):
        return bool(self.reason(staff, t))

    def can_see_request(self, staff, q):
        if not staff or not q or self.gov.workspace_removed(q.get('workspace_id')):
            return False
        if q['requested_by'] == staff or q['manager_id'] == staff:
            return True
        if q.get('task_id'):
            from core.rows import row
            return self.can_see(staff, row(Task.objects.filter(id=q['task_id']).first()))
        return False

    def context(self, staff):
        return {'staff': staff, 'company': self.company_wide(staff), 'team': self.team(staff), 'involved': self.involved_ids(staff)}

    # ------------------------------------------------------------ meetings
    def can_see_meeting(self, staff, m):
        from meetings.models import MeetingAttendee, MeetingChange, MeetingShare
        if not staff or not m:
            return False
        participant = (m['organizer_id'] == staff or m.get('created_by') == staff
                       or MeetingAttendee.objects.filter(meeting_id=m['id'], staff_id=staff).exists()
                       or MeetingChange.objects.filter(meeting_id=m['id'], approver_id=staff, status='PENDING').exists())
        scope = m.get('share_scope') or 'PARTICIPANTS'
        shared = (self.gov.can_staff(staff, 'tasks.meetings', 'view') and scope == 'SELECTED'
                  and MeetingShare.objects.filter(meeting_id=m['id'], staff_id=staff).exists())
        org = self.gov.meeting_reason(staff, m, participant, shared)
        return (participant or shared) if org is NOTSET else bool(org)

    def personal_task_hidden(self, staff, t):
        w = self.gov.ws_by_id(t['workspace_id']) if t else None
        return bool((w or {}).get('deleted_at')) or (is_personal_workspace(w) and not self.can_see(staff, t))

    # ------------------------------------------------------------ one person's view of the whole state
    def employee_filters(self, s, staff):
        def ordered(values):
            return sorted({v for v in values if v})
        task_ids = {t['id'] for t in s.get('tm_tasks', [])}
        meeting_ids = {m['id'] for m in s.get('tm_meetings', [])}
        tasks = ordered([t['pic_id'] for t in s.get('tm_tasks', [])] +
                        [a['staff_id'] for a in s.get('tm_assignees', []) if a['task_id'] in task_ids and a['status'] != 'DECLINED'])
        time = ordered(e['staff_id'] for e in s.get('tm_timesheets', []))
        meetings = ordered(a['staff_id'] for a in s.get('tm_attendees', []) if a['meeting_id'] in meeting_ids)
        scope = s.get('task_scope') or {}
        workload = (ordered(p['staff_id'] for p in s.get('tm_profiles', [])) if scope.get('company')
                    else ordered(tasks + time + list(scope.get('team') or []) + [staff]))
        return {'tasks': tasks, 'time': time, 'meetings': meetings, 'workload': workload, 'workspace': ordered(tasks + time)}

    def filter_state(self, s, staff, meetings=True, permissions=None):
        permissions = permissions or {}
        gov, ctx, out = self.gov, self.context(staff), {}
        visible = {}
        for t in s.get('tm_tasks', []):
            org = gov.task_reason(staff, t, t['id'] in ctx['involved'])
            r = task_reason(t, staff, ctx['involved'], ctx['team'], ctx['company']) if org is NOTSET else org
            if r:
                visible[t['id']] = r
        mine_on = {(a['task_id']) for a in s.get('tm_assignees', []) if a['staff_id'] == staff and a['status'] != 'DECLINED'}
        out['tm_tasks'] = [{**t, 'access_reason': visible[t['id']],
                            'calendar_visible': staff in (t.get('pic_id'), t.get('created_by'), t.get('assigned_by'), t.get('reviewer_id')) or t['id'] in mine_on}
                           for t in s.get('tm_tasks', []) if t['id'] in visible]
        out['tm_calendar_tasks'] = [t for t in out['tm_tasks'] if t['calendar_visible']]
        for table in ('tm_assignees', 'tm_task_history', 'tm_checklist', 'tm_files', 'tm_change_requests', 'tm_due_requests'):
            if table in s:
                out[table] = [r for r in s[table] if r['task_id'] in visible]
        if 'tm_timesheets' in s:
            by_id = {t['id']: t for t in s.get('tm_tasks', [])}
            out['tm_timesheets'] = [e for e in s['tm_timesheets'] if e.get('task_id') in visible or
                                    (e['staff_id'] == staff and not (e.get('task_id') and self.personal_task_hidden(staff, by_id.get(e['task_id']))))]
            own = {e['task_id'] for e in out['tm_timesheets'] if e.get('task_id') and e['task_id'] not in visible}
            out['tm_task_refs'] = [{'id': t['id'], 'title': t['title'], 'workspace_id': t['workspace_id'], 'status': t['status']}
                                   for t in s.get('tm_tasks', []) if t['id'] in own]
        else:
            out['tm_task_refs'] = []
        if meetings and 'tm_meetings' in s:
            attendees = {}
            for a in s.get('tm_attendees', []):
                attendees.setdefault(a['meeting_id'], set()).add(a['staff_id'])
            shares = {x['meeting_id'] for x in s.get('tm_meeting_shares', []) if x['staff_id'] == staff}
            meetings_view = gov.can_staff(staff, 'tasks.meetings', 'view')
            pending = {q['meeting_id'] for q in s.get('tm_meeting_changes', []) if q['approver_id'] == staff and q['status'] == 'PENDING'}

            def see(m):
                participant = (m['organizer_id'] == staff or m.get('created_by') == staff or staff in attendees.get(m['id'], set())
                               or m['id'] in pending)
                shared = meetings_view and m.get('share_scope') == 'SELECTED' and m['id'] in shares
                org = gov.meeting_reason(staff, m, participant, shared)
                return (participant or shared) if org is NOTSET else bool(org)
            out['tm_meetings'] = [({**m, 'task_id': None, 'contact_id': None} if m.get('task_id') and m['task_id'] not in visible else m)
                                  for m in s['tm_meetings'] if see(m)]
            ids = {m['id'] for m in out['tm_meetings']}
            out['tm_attendees'] = [a for a in s.get('tm_attendees', []) if a['meeting_id'] in ids]
            out['tm_meeting_changes'] = [x for x in s.get('tm_meeting_changes', []) if x['meeting_id'] in ids and staff in (x['requested_by'], x['approver_id'])]
            if 'tm_meeting_shares' in s:
                out['tm_meeting_shares'] = [x for x in s['tm_meeting_shares'] if x['meeting_id'] in ids]
            if 'tm_meeting_followers' in s:
                out['tm_meeting_followers'] = [x for x in s['tm_meeting_followers'] if x['staff_id'] == staff and x['meeting_id'] in ids]
        if 'tm_requests' in s:
            out['tm_requests'] = [q for q in s['tm_requests'] if not gov.workspace_removed(q.get('workspace_id')) and
                                  (q['requested_by'] == staff or q['manager_id'] == staff or (q.get('task_id') and q['task_id'] in visible))]
        out['tm_workspaces'] = [{**w, 'org_access': gov.workspace_access(staff, w)} for w in s.get('tm_workspaces', [])
                                if gov.can_view_workspace(staff, w)]
        workspace_ids = {w['id'] for w in out['tm_workspaces']}
        out['tm_members'] = [m for m in s.get('tm_members', []) if m['workspace_id'] in workspace_ids]
        record_workspaces = {r['workspace_id'] for r in out['tm_tasks'] + out.get('tm_meetings', []) + out.get('tm_task_refs', []) + out.get('tm_requests', [])}
        out['tm_workspace_refs'] = [{'id': w['id'], 'name': w['name'], 'kind': w['kind'], 'visibility': w['visibility'], 'reference_only': True,
                                     'org_access': {'can_create': False, 'can_collaborate_outside': bool(gov.can_collaborate_outside(staff, w))}}
                                    for w in s.get('tm_workspaces', []) if w['id'] not in workspace_ids and w['id'] in record_workspaces]
        if 'tm_events' in s:
            meeting_ids = {m['id'] for m in out.get('tm_meetings', s.get('tm_meetings', []))}
            entries = {e['id'] for e in out.get('tm_timesheets', [])}
            requests = {q['id'] for q in out.get('tm_requests', [])}

            def keep(e):
                kind = e['entity_type']
                if kind == 'task':
                    return e['entity_id'] in visible
                if kind == 'meeting':
                    return e['entity_id'] in meeting_ids
                if kind == 'timesheet':
                    return e['entity_id'] in entries
                if kind == 'request' and 'tm_requests' in s:
                    return e['entity_id'] in requests
                return not e.get('workspace_id') or e['workspace_id'] in workspace_ids
            import re
            pattern = re.compile(r'TASK-\d+')
            out['tm_events'] = [({**e, 'detail': pattern.sub(lambda m: m.group(0) if m.group(0) in visible else 'a task', e['detail'] or '')}
                                 if e['entity_type'] != 'task' and pattern.search(e.get('detail') or '') else e)
                                for e in s['tm_events'] if keep(e)]
        permission_key = [[r, sorted(a)] for r, a in sorted(permissions.items())]
        revision = hashlib.sha256(json.dumps([
            self.instance, staff, ctx['company'], sorted(ctx['team']), sorted(visible), sorted(e['id'] for e in out.get('tm_timesheets', [])),
            sorted(m['id'] for m in out.get('tm_meetings', [])), sorted(q['id'] for q in out.get('tm_requests', [])), permission_key,
            gov.settings()['revision']], separators=(',', ':')).encode()).hexdigest()
        company_all = ctx['company'] and (not gov.settings()['enabled'] or gov.global_workspaces(staff) or
                                          not any(w.get('kind') and w['kind'] != 'LEGACY' and not w.get('deleted_at') for w in s.get('tm_workspaces', [])))
        out['task_scope'] = {'company': bool(company_all), 'company_legacy': bool(ctx['company'] and not company_all),
                             'team': list(ctx['team']), 'involved': len(ctx['involved']), 'revision': revision}
        return out

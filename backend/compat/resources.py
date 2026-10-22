"""REST resource endpoints (Stage 1, decision B): /api/v1/<resource>/ and /api/v1/<resource>/<id>/.

They read exactly what the signed-in person may see: each request builds the same permission- and scope-filtered state
as /api/state (compat.state.filter_state), so a record outside the person's scope is "not found" whatever ID is put in
the URL. Changes still go through POST /api/command, which applies the workflow rules, approvals and audit history.

List responses: {"count", "page", "page_size", "results"}; `?page=` (from 1) and `?page_size=` (1–200, default 50),
`?q=` searches the main text fields, and each resource accepts a few exact-match filters (listed in RESOURCES).
"""
from core.i18n import msg as _message
from django.http import JsonResponse
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts import services as access
from core.errors import fail
from core.validation import integer
from organization.governance import Governance

from .state import filter_state, full_state

FILE_FIELDS = ('id', 'task_id', 'name', 'mime', 'size', 'uploaded_by', 'source', 'created_at')

# resource: (state key, id field, permission needed, exact filters, searched fields)
RESOURCES = {
    'users': ('tm_profiles', 'staff_id', 'tasks.tasks', ('active', 'department', 'manager_id', 'org_level'),
              ('name', 'username', 'nickname', 'position', 'department')),
    'workspaces': ('tm_workspaces', 'id', 'tasks.workspace', ('status', 'kind', 'visibility', 'owner_id'), ('name', 'department', 'description')),
    'tasks': ('tm_tasks', 'id', 'tasks.tasks', ('status', 'workspace_id', 'pic_id', 'reviewer_id', 'priority', 'assigned_by'),
              ('id', 'title', 'description', 'department')),
    'task-history': ('tm_task_history', 'id', 'tasks.tasks', ('task_id', 'actor_id', 'action', 'source'), ('note',)),
    'requests': ('tm_requests', 'id', 'tasks.tasks', ('status', 'manager_id', 'requested_by', 'workspace_id'), ('id', 'title', 'description')),
    'meetings': ('tm_meetings', 'id', 'tasks.meetings', ('status', 'organizer_id', 'workspace_id', 'task_id'), ('id', 'title', 'agenda', 'location')),
    'timesheets': ('tm_timesheets', 'id', 'tasks.timesheets', ('staff_id', 'task_id', 'workspace_id', 'work_date'), ('activity', 'notes')),
    'notifications': ('tm_notifications', 'id', None, ('kind', 'task_id', 'meeting_id'), ('title', 'body')),
}


def visible_state(user):
    return filter_state(full_state(), user, Governance())


def text_of(value):
    return '' if value is None else str(value).lower()


def task_detail(s, t):
    key = t['id']
    return {**t,
            'assignees': [a for a in s.get('tm_assignees', []) if a['task_id'] == key],
            'checklist': [c for c in s.get('tm_checklist', []) if c['task_id'] == key],
            'files': [{k: f.get(k) for k in FILE_FIELDS} for f in s.get('tm_files', []) if f['task_id'] == key],
            'pending_changes': [c for c in s.get('tm_change_requests', []) if c['task_id'] == key and c['status'] == 'PENDING'],
            'pending_due_dates': [d for d in s.get('tm_due_requests', []) if d['task_id'] == key and d['status'] == 'PENDING']}


def workspace_detail(s, w):
    return {**w, 'member_ids': [m['staff_id'] for m in s.get('tm_members', []) if m['workspace_id'] == w['id']]}


def meeting_detail(s, m):
    return {**m, 'attendees': [a for a in s.get('tm_attendees', []) if a['meeting_id'] == m['id']]}


DETAIL = {'tasks': task_detail, 'workspaces': workspace_detail, 'meetings': meeting_detail}


def require(user, resource):
    needed = RESOURCES[resource][2]
    if needed and not access.can(user, needed):
        fail(_message('You do not have permission to view this.'), 403)


class IndexView(APIView):
    def get(self, request):
        base = f'/c/{request.company_id}/api/v1/'
        return Response({'resources': {name: base + name + '/' for name, spec in RESOURCES.items()
                                       if not spec[2] or access.can(request.user, spec[2])},
                         'organization': base + 'organization/' if access.can(request.user, 'tasks.organization') else None,
                         'changes': _message('POST /api/command {"action", "data"} — the same commands and rules as the app')})


class ListView(APIView):
    def get(self, request, resource):
        if resource not in RESOURCES:
            return JsonResponse({'error': _message('Route not found.')}, status=404)
        require(request.user, resource)
        key, _, _, filters, searched = RESOURCES[resource]
        s = visible_state(request.user)
        found = s.get(key) or []
        p = request.query_params
        for f in filters:
            if f in p:
                want = p[f]
                found = [r for r in found if text_of(r.get(f)) == want.lower() or (want == '' and r.get(f) in (None, ''))]
        q = p.get('q', '').strip().lower()
        if q:
            found = [r for r in found if any(q in text_of(r.get(f)) for f in searched)]
        page = integer(p.get('page') or 1, 1, 1_000_000, 'page')
        size = integer(p.get('page_size') or 50, 1, 200, _message('page size'))
        part = found[(page - 1) * size:page * size]
        if resource == 'workspaces':
            part = [workspace_detail(s, w) for w in part]
        return Response({'count': len(found), 'page': page, 'page_size': size, 'results': part})


class DetailView(APIView):
    def get(self, request, resource, key):
        if resource not in RESOURCES:
            return JsonResponse({'error': _message('Route not found.')}, status=404)
        require(request.user, resource)
        state_key, id_field = RESOURCES[resource][0], RESOURCES[resource][1]
        s = visible_state(request.user)
        found = next((r for r in s.get(state_key) or [] if str(r.get(id_field)) == key), None)
        if found is None:
            fail(_message('Not found.'), 404)
        return Response(DETAIL[resource](s, found) if resource in DETAIL else found)


class OrganizationView(APIView):
    def get(self, request):
        access.require_permission(request.user, 'tasks.organization')
        return Response(Governance().query(request.user.staff_id, request.query_params.dict()))

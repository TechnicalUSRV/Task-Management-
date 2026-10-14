"""V5.7.7 endpoints used by the existing React app (paths and response shapes unchanged)."""
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts import services as access
from accounts.authentication import check_origin
from accounts.views import require_json
from core.errors import fail
from organization.governance import Governance

from . import commands


class CommandView(APIView):
    def post(self, request):
        check_origin(request)
        body = require_json(request)
        user = request.user
        if commands.limiter.limited(f'{request.company_id}:{user.id}'):
            fail('Too many changes in a short time. Wait a moment and try again.', 429)
        result = commands.run(user, body.get('action'), body.get('data') if 'data' in body else {})
        return Response({'ok': True, 'result': result})


class OrganizationView(APIView):
    def get(self, request):
        access.require_permission(request.user, 'tasks.organization')
        return Response(Governance().query(request.user.staff_id, request.query_params.dict()))


# ---------------------------------------------------------------- the state every screen is built from
def telegram_part(request, user, gov):
    from django.conf import settings as conf
    from telegram import services as telegram
    can_tasks, can_admin = access.can(user, 'tasks.tasks'), access.can(user, 'admin.telegram')
    if not (can_tasks or can_admin):
        return {}
    s = telegram.settings()
    public = conf.PUBLIC_URL
    company = request.company_id
    app_url = f'{public}/c/{company}/tg/' if public else (f"{s['mini_app_url']}/c/{company}/tg/" if s['mini_app_url'] else '')
    out = telegram.info(gov, user, can_admin, app_url, bool(public))
    if out.get('telegram_admin'):
        host = request.get_host()
        out['telegram_admin']['gateway'] = {'port': request.get_port(), 'local_url': f'{request.scheme}://{host}', 'path': f'/c/{company}/tg/',
                                            'running': True, 'shared_url': public}
    return out


class StateView(APIView):
    def get(self, request):
        from accounts.views import companies_list
        from core.services import change_seq
        from .state import full_state, filter_state
        from django.conf import settings as conf
        user, gov = request.user, Governance()
        body = {**filter_state(full_state(), user, gov), **telegram_part(request, user, gov)}
        if conf.PUBLIC_URL and (access.can(user, 'admin.telegram') or access.can(user, 'admin.users')):
            body['sharing'] = {'url': conf.PUBLIC_URL}
        body.update({'company_context': {'id': request.company_id}, 'companies': companies_list(), 'change_seq': change_seq()})
        return Response(body)


# ---------------------------------------------------------------- photos and task files
def binary(content, mime, headers):
    from django.http import HttpResponse
    response = HttpResponse(bytes(content), content_type=mime)
    for k, v in headers.items():
        response[k] = v
    return response


def attachment_name(name):
    from urllib.parse import quote
    return quote(name, safe="!*()~-_.").replace("'", '%27')


class PhotoView(APIView):
    def get(self, request):
        from organization.models import StaffPhoto
        photo = StaffPhoto.objects.filter(staff_id=str(request.query_params.get('staff') or '')[:60], size__gt=0).first()
        if not photo:
            fail('Photo not found.', 404)
        cache = 'private, max-age=31536000, immutable' if request.query_params.get('v') == str(photo.version) else 'no-store'
        return binary(photo.content, photo.mime, {'Cache-Control': cache, 'Content-Security-Policy': "default-src 'none'; sandbox"})


def task_file_response(staff, file_id, inline_wanted, extra=None):
    from tasks.domain import PREVIEW_TYPES
    from tasks.models import Task, TaskFile
    from tasks.scope import TaskScope
    from core.rows import row
    f = TaskFile.objects.filter(id=str(file_id or '')[:60]).first()
    t = row(Task.objects.filter(id=f.task_id).first()) if f else None
    if not f or not TaskScope(Governance()).can_see(staff, t):
        fail('File not found.', 404)
    inline = inline_wanted and f.mime in PREVIEW_TYPES
    return binary(f.content, f.mime if inline else 'application/octet-stream', {
        'Content-Disposition': f"{'inline' if inline else 'attachment'}; filename=\"task-file\"; filename*=UTF-8''{attachment_name(f.name)}",
        'Cache-Control': 'private, no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox", **(extra or {})})


class TaskFileView(APIView):
    def get(self, request):
        access.require_permission(request.user, 'tasks.tasks')
        return task_file_response(request.user.staff_id, request.query_params.get('id'), request.query_params.get('inline') == '1')


# ---------------------------------------------------------------- task reports, dashboard and custom reports
TASK_REPORT_NEEDS = {'tasks': ['tasks.tasks', 'tasks.timesheets'], 'time': ['tasks.timesheets'], 'meetings': ['tasks.meetings'],
                     'workload': ['tasks.tasks', 'tasks.timesheets'], 'workspace': ['tasks.workspace', 'tasks.tasks', 'tasks.timesheets'],
                     'monthly': ['tasks.tasks'], 'monthly_completed': ['tasks.tasks'], 'monthly_progress': ['tasks.tasks'],
                     'monthly_stuck': ['tasks.tasks'], 'monthly_overdue': ['tasks.tasks']}


def text_response(body, mime, filename=None):
    from django.http import HttpResponse
    response = HttpResponse(body, content_type=mime)
    if filename:
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response


class TaskReportView(APIView):
    kind = 'json'

    def get(self, request):
        from . import reports
        from .state import scoped_state
        user = request.user
        action = 'view' if self.kind == 'json' else 'export'
        access.require_permission(user, 'tasks.reports', action)
        report_id = request.query_params.get('report') or 'tasks'
        if report_id not in TASK_REPORT_NEEDS:
            fail('Unknown task report.', 400)
        for resource in TASK_REPORT_NEEDS[report_id]:
            access.require_permission(user, resource, action)
        report = reports.build_task_report(scoped_state(user), request.query_params.dict())
        if self.kind == 'csv':
            return text_response(reports.report_csv(report), 'text/csv; charset=utf-8', f"Tasks-{report['id']}.csv")
        if self.kind == 'print':
            return text_response(reports.task_report_html(report), 'text/html; charset=utf-8')
        return Response(report)


def parse_filters(request):
    import json
    try:
        filters = json.loads(request.query_params.get('filters') or '{}')
    except ValueError:
        fail('Invalid filters.')
    if not isinstance(filters, dict):
        fail('Invalid filters.')
    return filters


class DashboardView(APIView):
    def get(self, request):
        from . import reports
        return Response(reports.build_dashboard(request.user, parse_filters(request)))


class SourceRecordsView(APIView):
    def get(self, request):
        from . import reports
        return Response(reports.source_records(request.user, parse_filters(request)))


class ReportOptionsView(APIView):
    def get(self, request):
        from . import reports
        return Response(reports.report_options(request.user))


class ERPReportView(APIView):
    kind = 'json'

    def post(self, request):
        from . import reports
        check_origin(request)
        body = require_json(request)
        report = reports.build_erp_report(request.user, body, self.kind != 'json')
        if self.kind == 'csv':
            columns = [['source_label', 'Data source'], *report['columns']]
            table = {**report, 'columns': [[f'column{i}', label] for i, (_, label) in enumerate(columns)],
                     'rows': [{f'column{i}': reports.display_value(row, key, report['currency']) for i, (key, _) in enumerate(columns)} for row in report['rows']]}
            return text_response(reports.report_csv(table), 'text/csv; charset=utf-8', 'Sunny-Task Controlling Management-Report.csv')
        return Response(report)


class JourneyView(APIView):
    """CRM customer journeys: the CRM module is off in this deployment, so this answers as V5.7.7 does without CRM access."""
    def get(self, request):
        access.require_permission(request.user, 'crm.contacts')
        fail('Route not found.', 404)


def print_script(request):
    from django.http import HttpResponse
    return HttpResponse("document.getElementById('print').addEventListener('click',()=>window.print());", content_type='application/javascript; charset=utf-8')

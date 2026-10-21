"""URL map. Every path also works under /c/<company>/ (core.middleware.CompanyScopeMiddleware)."""
from django.http import JsonResponse
from django.urls import path, re_path

from accounts import views as auth
from compat import resources
from compat import views as compat
from groups import views as groups
from telegram import gateway

urlpatterns = [
    path('api/auth/setup', auth.SetupView.as_view()),
    path('api/auth/login', auth.LoginView.as_view()),
    path('api/auth/logout', auth.LogoutView.as_view()),
    path('api/auth/status', auth.StatusView.as_view()),
    path('api/version', auth.VersionView.as_view()),
    path('api/companies', auth.CompaniesView.as_view()),
    path('api/changes', auth.ChangesView.as_view()),
    path('api/command', compat.CommandView.as_view()),
    path('api/organization', compat.OrganizationView.as_view()),
    path('api/state', compat.StateView.as_view()),
    path('api/photo', compat.PhotoView.as_view()),
    path('api/tasks/delivery', compat.TaskDeliveryView.as_view()),
    path('api/tasks/file', compat.TaskFileView.as_view()),
    path('api/tasks/file/preview', compat.TaskFilePreviewView.as_view()),
    # Groups (V5.4–V5.6.9): reads; every change goes through /api/command.
    path('api/tasks/group', groups.GroupReadView.as_view(kind='group')),
    path('api/tasks/group/rows', groups.GroupReadView.as_view(kind='rows')),
    path('api/tasks/group/notes', groups.GroupReadView.as_view(kind='notes')),
    path('api/tasks/group/note-history', groups.GroupReadView.as_view(kind='note-history')),
    path('api/tasks/group/members', groups.GroupReadView.as_view(kind='members')),
    path('api/tasks/group/audience', groups.GroupReadView.as_view(kind='audience')),
    path('api/tasks/group/shares', groups.GroupReadView.as_view(kind='shares')),
    path('api/tasks/group/import-sources', groups.GroupReadView.as_view(kind='import-sources')),
    path('api/tasks/group/import-source', groups.GroupReadView.as_view(kind='import-source')),
    path('api/tasks/group/delivery', groups.GroupReadView.as_view(kind='delivery')),
    path('api/tasks/group/live-shares', groups.GroupReadView.as_view(kind='live-shares')),
    path('api/tasks/group/live-sources', groups.GroupReadView.as_view(kind='live-sources')),
    path('api/tasks/group/live', groups.GroupReadView.as_view(kind='live')),
    path('api/tasks/group/live-history', groups.GroupReadView.as_view(kind='live-history')),
    path('api/tasks/group/import', groups.GroupReadView.as_view(kind='import')),
    path('api/tasks/group/import/preview', groups.ImportPreviewView.as_view()),
    path('api/tasks/group/file', groups.GroupReadView.as_view(kind='file')),
    path('api/tasks/group/file/preview', groups.GroupReadView.as_view(kind='file-preview')),
    path('api/tasks/group.xlsx', groups.GroupReadView.as_view(kind='xlsx')),
    path('api/google', groups.GoogleView.as_view()),
    path('api/tasks/report', compat.TaskReportView.as_view()),
    path('api/tasks/report.csv', compat.TaskReportView.as_view(kind='csv')),
    path('api/tasks/report.print', compat.TaskReportView.as_view(kind='print')),
    path('api/erp/dashboard', compat.DashboardView.as_view()),
    path('api/erp/source', compat.SourceRecordsView.as_view()),
    path('api/erp/report-options', compat.ReportOptionsView.as_view()),
    path('api/erp/report', compat.ERPReportView.as_view()),
    path('api/erp/report.export', compat.ERPReportView.as_view(kind='export')),
    path('api/erp/report.csv', compat.ERPReportView.as_view(kind='csv')),
    path('api/journey', compat.JourneyView.as_view()),
    # REST resources (read): the same permissions and record scope as /api/state; changes go through /api/command.
    path('api/v1/', resources.IndexView.as_view()),
    path('api/v1/organization/', resources.OrganizationView.as_view()),
    path('api/v1/<str:resource>/', resources.ListView.as_view()),
    path('api/v1/<str:resource>/<str:key>/', resources.DetailView.as_view()),
    path('print.js', compat.print_script),
    # The Telegram Mini App (only under /c/<company>/tg/, as in V5.7.7).
    path('tg', gateway.to_page),
    path('tg/', gateway.page),
    re_path(r'^tg/(?P<rest>api/.*)$', lambda request, rest: gateway.api(request, rest[4:])),
    # Everything else that is not the API is the built React app.
    re_path(r'^(?!api/).*$', compat.frontend),
]


def not_found(request, exception=None):
    return JsonResponse({'error': 'Route not found.'}, status=404)


handler404 = not_found

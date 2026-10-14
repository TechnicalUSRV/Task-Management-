"""URL map. Every path also works under /c/<company>/ (core.middleware.CompanyScopeMiddleware)."""
from django.http import JsonResponse
from django.urls import path

from accounts import views as auth
from compat import views as compat

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
]


def not_found(request, exception=None):
    return JsonResponse({'error': 'Route not found.'}, status=404)


handler404 = not_found

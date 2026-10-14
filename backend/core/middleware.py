"""Company-scoped URLs.

V5.7.7 serves every company under /c/<companyId>/… and keeps a separate session cookie per company. This deployment
has one company (settings.COMPANY_ID, normally 'default'); the same URL forms keep working, and any other company
ID is answered as "Company not found.", exactly as before.
"""
import re

from django.conf import settings
from django.http import JsonResponse

SCOPED = re.compile(r'^/c/([a-zA-Z0-9_-]{1,80})(/.*)$')


class CompanyScopeMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        match = SCOPED.match(request.path_info)
        if match:
            company_id, rest = match.groups()
            if company_id != settings.COMPANY_ID:
                return JsonResponse({'error': 'Company not found.'}, status=404)
            request.company_id = company_id
            request.company_scoped = True
            request.path_info = rest
        else:
            request.company_id = settings.COMPANY_ID
            request.company_scoped = False
        # Same cookie names and paths as V5.7.7, so browsers keep one session per company URL.
        request.session_cookie_name = f'sunny_session_{request.company_id}' if request.company_scoped else 'sunny_session'
        request.session_cookie_path = f'/c/{request.company_id}/' if request.company_scoped else '/'
        return self.get_response(request)


CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class SecurityHeadersMiddleware:
    """The headers V5.7.7 sends with every response (a view may set its own, for example for files or the Mini App)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('Cross-Origin-Resource-Policy', 'same-origin')
        response.headers.setdefault('Content-Security-Policy', CSP)
        return response

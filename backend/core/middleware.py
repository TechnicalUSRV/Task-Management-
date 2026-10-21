"""Company-scoped URLs.

V5.7.7 serves every company under /c/<companyId>/… and keeps a separate session cookie per company. This deployment
has one company (settings.COMPANY_ID, normally 'default'). Company-scoped API and Telegram URLs remain active;
the retired /c/<companyId>/ homepage returns 404. The office page is /TaskManagement.
Any other company ID is answered as "Company not found.", exactly as before.
"""
import re

from django.conf import settings
from django.http import HttpResponse, JsonResponse

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
            if rest == '/':
                return JsonResponse({'error': 'Page not found.'}, status=404)
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


CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class SecurityHeadersMiddleware:
    """The headers V5.7.7 sends with every response (a view may set its own, for example for files or the Mini App)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('Cross-Origin-Resource-Policy', settings.CROSS_ORIGIN_RESOURCE_POLICY)
        response.headers.setdefault('Content-Security-Policy', CSP)
        return response


class TrustedOriginCorsMiddleware:
    """Lets the React app call the API from another trusted origin (VITE_API_BASE_URL) with its session cookie.

    Only origins listed in DJANGO_TRUSTED_ORIGINS are answered, never "*". The normal setup needs none of this: Django
    serves the built app itself, and the Vite dev server proxies /c/<company>/api to Django, so the browser sees one origin.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        origin = request.headers.get('Origin', '')
        trusted = origin and origin in settings.TRUSTED_ORIGINS and origin != f'{request.scheme}://{request.get_host()}'
        if trusted and request.method == 'OPTIONS' and request.headers.get('Access-Control-Request-Method'):
            response = HttpResponse(status=204)
            response['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
            response['Access-Control-Max-Age'] = '600'
        else:
            response = self.get_response(request)
        if trusted:
            response['Access-Control-Allow-Origin'] = origin
            response['Access-Control-Allow-Credentials'] = 'true'
            response['Access-Control-Expose-Headers'] = 'Content-Disposition'
            response['Vary'] = ', '.join(x for x in (response.get('Vary'), 'Origin') if x)
        return response

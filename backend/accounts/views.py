"""Sign-in endpoints with the V5.7.7 contract (paths, JSON shapes, cookie names and messages are unchanged).

These four endpoints are reachable without a session by design (they are how a session starts). Every other API
requires a signed-in account.
"""
from core.i18n import msg as _message
import ipaddress

from django.conf import settings
from django.db import transaction
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.errors import InputError, fail
from core.services import change_seq, company

from . import services
from .authentication import check_origin

APP_VERSION = _message('Task Controlling Management V5.7.7')
APP_BUILD = '2026-10-14 · Django'


def require_json(request):
    if not str(request.headers.get('Content-Type', '')).startswith('application/json'):
        fail(_message('JSON is required.'), 415)
    body = request.data
    if not isinstance(body, dict):
        fail(_message('Invalid request.'))
    return body


def client_address(request):
    return request.META.get('REMOTE_ADDR', '')


def set_session_cookie(response, request, token):
    response.set_cookie(request.session_cookie_name, token, max_age=services.SESSION_SECONDS if token else 0,
                        path=request.session_cookie_path, httponly=True, samesite=_message('Strict'),
                        secure=settings.SESSION_COOKIE_SECURE_FLAG)


def companies_list():
    current = company()
    return [{'id': settings.COMPANY_ID, 'name': current.name if current else _message('New company')}]


class PublicView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]


class SetupView(PublicView):
    def post(self, request):
        check_origin(request)
        body = require_json(request)
        address = client_address(request)
        local = address and ipaddress.ip_address(address).is_loopback
        if not local and not getattr(settings, 'ALLOW_REMOTE_SETUP', False):
            fail('Create the first administrator on the computer that runs the Task Controlling Management, then sign in from other computers.', 403)
        user = services.bootstrap(body)
        token = services.start_session(user['id'])
        from core.i18n import activate
        activate(user['language'])
        request._request.language_account = True
        response = Response({'ok': True, 'user': user})
        set_session_cookie(response, request, token)
        return response


class LoginView(PublicView):
    def post(self, request):
        check_origin(request)
        body = require_json(request)
        user = services.login_or_fail(body.get('username'), body.get('password'), client_address(request))
        with transaction.atomic():
            token = services.start_session(user['id'])
        from core.i18n import activate
        activate(user['language'])
        request._request.language_account = True
        response = Response({'ok': True, 'user': user})
        set_session_cookie(response, request, token)
        return response


class LogoutView(PublicView):
    def post(self, request):
        check_origin(request)
        require_json(request)
        services.logout(request._request)
        response = Response({'ok': True})
        set_session_cookie(response, request, '')
        return response


class StatusView(PublicView):
    def get(self, request):
        return Response({**services.status(request._request), 'company_id': request.company_id,
                         'companies': companies_list()})


class VersionView(PublicView):
    def get(self, request):
        return Response({'version': APP_VERSION, 'build': APP_BUILD})


class CompaniesView(PublicView):
    def get(self, request):
        return Response(companies_list())

    def post(self, request):
        check_origin(request)
        user = services.resolve(request._request)
        services.require_permission(user, 'admin.companies', 'create')
        raise InputError(_message('This installation runs one company. Additional companies are not available.'), 403)


class LanguageView(APIView):
    def get(self, request):
        return Response({'language': request.user.language})

    def post(self, request):
        check_origin(request)
        from .language import save_language
        return Response(save_language(request.user, require_json(request)))


class ChangesView(APIView):
    def get(self, request):
        return Response({'seq': change_seq()})

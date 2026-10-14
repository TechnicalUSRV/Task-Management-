"""Cookie session authentication for DRF, with the V5.7.7 Origin check on every state-changing request."""
from django.conf import settings
from rest_framework.authentication import BaseAuthentication

from core.errors import InputError

from . import services

SAFE = {'GET', 'HEAD', 'OPTIONS'}


def check_origin(request):
    """Writes must come from the app's own page (V5.7.7 server.mjs); a missing or foreign Origin is refused."""
    if request.method in SAFE:
        return
    origin = request.headers.get('Origin', '')
    own = f'{request.scheme}://{request.get_host()}'
    if not origin or (origin != own and origin not in settings.TRUSTED_ORIGINS):
        raise InputError('This local action requires the app’s own page.', 403)


class SessionTokenAuthentication(BaseAuthentication):
    def authenticate(self, request):
        user = services.resolve(request._request)
        if user is None:
            return None
        return (user, None)

    def authenticate_header(self, request):
        return 'Session'

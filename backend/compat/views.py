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

"""Groups endpoints with the V5.7.7 paths and response shapes the React screens use.

GET  /api/tasks/group                one group: its columns as this person may see them, layouts and the first page of rows
GET  /api/tasks/group/rows           a page of rows (search, filters, sorting and paging done on the server)
GET  /api/tasks/group/notes          notes on one row;  /note-history: the earlier text of one note
GET  /api/tasks/group/members        people who may be chosen in In Charge and Support cells
GET  /api/tasks/group/audience       people who can open the group (for access rules), for the people who manage it
GET  /api/tasks/group/import         one uploaded Excel workbook
GET  /api/tasks/group/file           a file in an Attachment cell (inline=1 for images and PDFs)
GET  /api/tasks/group/file/preview   what the in-app preview shows for that file
GET  /api/tasks/group.xlsx           the group as an Excel workbook (Export permission)
POST /api/tasks/group/import/preview what an Excel import would do, without saving anything
POST /api/google                     the Google Sheets panel of a group's settings (not part of this deployment)

Changes go through POST /api/command (tm.group.*). The role permission for Groups is checked here; the group's own
sharing, row and column rules are checked by groups.service, which answers "not found" for groups a person may not open.
"""
from django.db import transaction
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts import services as access
from accounts.authentication import check_origin
from accounts.views import require_json
from compat.views import attachment_name, binary
from core.errors import fail
from organization.governance import Governance
from tasks.services import TaskService

from .service import GroupService


def service():
    return GroupService(TaskService(Governance()))


class GroupReadView(APIView):
    kind = 'group'

    def get(self, request):
        user = request.user
        access.require_permission(user, 'tasks.groups', 'export' if self.kind == 'xlsx' else 'view')
        groups, staff = service(), user.staff_id
        key, p = str(request.query_params.get('id') or '')[:60], request.query_params.dict()
        if self.kind in ('shares', 'import-sources', 'import-source'):
            from .sharing import DataSharing
            sharing = DataSharing(groups)
            return Response(sharing.describe(key, staff) if self.kind == 'shares' else sharing.sources(key, staff) if self.kind == 'import-sources' else sharing.browse(key, p.get('source'), staff))
        if self.kind == 'delivery':
            from .delivery import status
            return Response(status(groups, key, staff, p.get('delivery')))
        if self.kind == 'group':
            return Response(groups.read(key, staff, p))
        if self.kind == 'rows':
            return Response(groups.query(key, staff, p))
        if self.kind == 'notes':
            return Response(groups.notes(key, staff, p))
        if self.kind == 'note-history':
            return Response(groups.note_history(key, staff, p.get('note')))
        if self.kind == 'members':
            return Response(groups.members(key, staff, request.query_params.get('q') or '', request.query_params.get('offset'),
                                           request.query_params.get('limit')))
        if self.kind == 'audience':
            return Response(groups.audience(key, staff))
        if self.kind == 'import':
            return Response(groups.imports.describe(p.get('import'), staff))
        if self.kind == 'file':
            from tasks.preview import INLINE_TYPES
            f = groups.file(key, staff, request.query_params.get('file'))
            inline = request.query_params.get('inline') == '1' and f.mime in INLINE_TYPES
            headers = {'Content-Disposition': f"{'inline' if inline else 'attachment'}; filename=\"group-file\"; filename*=UTF-8''{attachment_name(f.name)}",
                       'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
                       'Content-Security-Policy': "default-src 'none'; sandbox"}
            return binary(f.content, f.mime if inline else 'application/octet-stream', headers)
        if self.kind == 'file-preview':
            from tasks.preview import describe
            f = groups.file(key, staff, request.query_params.get('file'))
            return Response(describe(f.name, f.mime, f.size, bytes(f.content)))
        if self.kind == 'xlsx':
            with transaction.atomic():   # the export is recorded in the group's activity
                file = groups.xlsx(key, staff, p)
            import re
            name = re.sub(r'[\\/:*?"<>|]+', '-', file['name']) + '.xlsx'
            return binary(file['buffer'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                          {'Content-Disposition': f"attachment; filename=\"group.xlsx\"; filename*=UTF-8''{attachment_name(name)}"})
        fail('Route not found.', 404)


class ImportPreviewView(APIView):
    """What an Excel import would do (rows added, updated, skipped and every problem), without saving anything."""
    def post(self, request):
        check_origin(request)
        body = require_json(request)
        access.require_permission(request.user, 'tasks.groups', 'create')
        return Response(service().imports.preview(body.get('import_id'), request.user.staff_id, body.get('plan')))


DIRECTIONS = {'TO_SHEETS': 'Group → Google Sheets', 'FROM_SHEETS': 'Google Sheets → Group', 'TWO_WAY': 'Both ways'}


class GoogleView(APIView):
    """The Google Sheets panel in a group's settings. The connection is not part of this deployment (Stage 1 decision A),
    so the panel shows V5.7.7's “Google Sheets isn’t set up yet” state and every other action is refused."""
    def post(self, request):
        check_origin(request)
        body = require_json(request)
        user = request.user
        access.require_permission(user, 'tasks.groups', 'view')
        if body.get('action') != 'describe':
            fail('This action is not available.', 403)
        groups = service()
        b = groups.board_row(str(body.get('group_id') or ''))
        if not b or not groups.caps_for(b, user.staff_id)['share']:
            fail('Only people who manage this group can connect it to Google Sheets.', 403)
        return Response({'ok': True, 'result': {'configured': False, 'allow_existing': False, 'default_interval': 60, 'simulated': False, 'account': None,
                                                'columns': [], 'directions': DIRECTIONS, 'sync': None}})

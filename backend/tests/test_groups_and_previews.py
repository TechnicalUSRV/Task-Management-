"""Groups over HTTP and the in-app attachment preview: permissions, URL tampering, hidden functions, Mini App media
tokens, Office/CSV/text extraction, unsafe documents, and the Group permissions migration."""
import base64
import io
import json
import zipfile

import pytest
from django.db import transaction

from accounts.models import Role, RolePermission, User
from tests.conftest import Api
from tests.test_telegram import TOKEN, MiniApp, launch

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='
PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def b64(data):
    return base64.b64encode(data).decode()


def package(parts):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, text)
    return buf.getvalue()


def docx(body=None, doctype=False):
    body = body or (f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Stock count</w:t></w:r></w:p>'
                    f'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold </w:t></w:r><w:r><w:t>and plain</w:t></w:r></w:p>'
                    f'<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>A list item</w:t></w:r></w:p>'
                    f'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc></w:tr>'
                    f'<w:tr><w:tc><w:p><w:r><w:t>Rice</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                    f'<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>')
    head = '<?xml version="1.0"?>' + ('<!DOCTYPE x [<!ENTITY a "aaaa">]>' if doctype else '')
    return package({'[Content_Types].xml': '<Types/>', 'word/document.xml': f'{head}<w:document xmlns:w="{W_NS}"><w:body>{body}</w:body></w:document>'})


def pptx():
    p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
    a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    slide = (f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><p:cSld><p:spTree>'
             f'<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:txBody></p:sp>'
             f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Count stock</a:t></a:r></a:p></p:txBody></p:sp>'
             '</p:spTree></p:cSld></p:sld>')
    return package({'ppt/presentation.xml': f'<p:presentation xmlns:p="{p}" xmlns:r="{r}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
                    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
                    'ppt/slides/slide1.xml': slide})


def xlsx():
    from groups.xlsx import write_xlsx
    return write_xlsx([{'name': 'Stock', 'columns': [{'header': 'Item', 'type': 'text'}, {'header': 'Qty', 'type': 'number', 'decimals': 0},
                                                     {'header': 'Date', 'type': 'date'}],
                        'rows': [['Rice', 12, '2026-10-05'], ['=cmd', 1.5, None]]}])


def login(name, password):
    client = Api()
    assert client.post('/api/auth/login', {'username': name, 'password': password}).status_code == 200
    return client


@pytest.fixture
def team(admin_api):
    def user(name, role):
        r = admin_api.command('admin.user.save', {'name': name, 'role_id': role, 'password': name.split()[0] + '-password-2026'})
        assert r.status_code == 200, r.json()
        return User.objects.get(id=r.json()['result']['id']).staff_id
    ids = {'dara': user('Dara Member', 'ROLE-MEMBER'), 'kosal': user('Kosal Member', 'ROLE-MEMBER'), 'neary': user('Neary Viewer', 'ROLE-VIEWER')}
    ws = admin_api.command('tm.workspace.save', {'name': 'Ops', 'owner_id': admin_api.user['staff_id'], 'member_ids': [ids['dara'], ids['kosal']]})
    assert ws.status_code == 200, ws.json()
    clients = {'dara': login('Dara Member', 'Dara-password-2026'), 'kosal': login('Kosal Member', 'Kosal-password-2026'),
               'neary': login('Neary Viewer', 'Neary-password-2026')}
    return admin_api, ids, clients, ws.json()['result']['id']


def ok(response):
    assert response.status_code == 200, response.content[:500]
    return response.json()


def test_groups_are_back_with_their_permissions_and_sharing(team, settings):
    admin, ids, c, ws = team
    dara, kosal, neary = c['dara'], c['kosal'], c['neary']
    # Groups are visible again: the function is in each person's permissions and the role screens.
    state = ok(dara.get('/api/state'))
    assert state['auth']['permissions']['tasks.groups'] == ['view', 'create', 'update', 'delete', 'export']
    assert any(f['key'] == 'tasks.groups' for m in state['erp_catalog'] for f in m['functions'])
    assert state['tm_group_workspaces'] == [ws]
    personal = ok(dara.command('tm.group.save', {'workspace_id': ws, 'name': 'Dara private'}))['result']['id']
    team_group = ok(dara.command('tm.group.save', {'workspace_id': ws, 'name': 'Team list', 'visibility': 'TEAM', 'audience': 'SELECTED',
                                                   'shared': [{'staff_id': ids['kosal'], 'level': 'VIEW'}]}))['result']['id']
    columns = ok(dara.get(f'/api/tasks/group?id={team_group}'))['columns']
    item = columns[0]['id']
    files = ok(dara.command('tm.group.column.save', {'group_id': team_group, 'name': 'Files', 'type': 'ATTACHMENT'}))['result']['id']
    row = ok(dara.command('tm.group.row.add', {'group_id': team_group, 'values': {item: 'Rice'}}))['result']['id']
    added = ok(dara.command('tm.group.file.add', {'group_id': team_group, 'row_id': row, 'column_id': files, 'name': 'shelf.png', 'base64': PNG}))['result']['id']
    # The owner sees both; a person a group is shared with sees it read-only; anyone else is told it does not exist.
    assert [b['id'] for b in ok(dara.get('/api/state'))['tm_boards']] == [personal, team_group]
    assert [b['id'] for b in ok(kosal.get('/api/state'))['tm_boards']] == [team_group]
    assert ok(neary.get('/api/state'))['tm_boards'] == []
    assert kosal.get(f'/api/tasks/group?id={personal}').json() == {'error': 'Group not found.'}
    assert neary.get(f'/api/tasks/group?id={team_group}').status_code == 404
    assert ok(kosal.get(f'/api/tasks/group?id={team_group}'))['group']['caps']['addRows'] is False
    assert kosal.command('tm.group.row.add', {'group_id': team_group, 'values': {item: 'Oil'}}).status_code == 403
    assert kosal.command('tm.group.row.add', {'group_id': personal, 'values': {}}).json() == {'error': 'Group not found.'}
    assert neary.command('tm.group.save', {'workspace_id': ws, 'name': 'Viewer'}).status_code == 403
    assert Api().get(f'/api/tasks/group?id={team_group}').status_code == 401
    # Files: only through a group and row the person may open, whatever IDs are put in the address.
    got = kosal.get(f'/api/tasks/group/file?id={team_group}&file={added}&inline=1')
    assert got.status_code == 200 and got['Content-Type'] == 'image/png' and got['Content-Disposition'].startswith('inline')
    assert got['Content-Security-Policy'] == "default-src 'none'; sandbox"
    assert kosal.get(f'/api/tasks/group/file?id={personal}&file={added}').status_code == 404
    assert neary.get(f'/api/tasks/group/file?id={team_group}&file={added}').status_code == 404
    download = kosal.get(f'/api/tasks/group/file?id={team_group}&file={added}')
    assert download['Content-Type'] == 'application/octet-stream' and download['Content-Disposition'].startswith('attachment')
    assert ok(kosal.get(f'/api/tasks/group/file/preview?id={team_group}&file={added}')) == {'name': 'shelf.png', 'mime': 'image/png', 'size': 70, 'view': 'image'}
    assert neary.get(f'/api/tasks/group/file/preview?id={team_group}&file={added}').status_code == 404
    # Excel export, the Google Sheets panel (not part of this deployment) and the other reads.
    export = dara.get(f'/api/tasks/group.xlsx?id={team_group}')
    assert export.status_code == 200 and export['Content-Disposition'].endswith("Team%20list.xlsx")
    from groups.xlsx import read_xlsx
    assert read_xlsx(export.content)[0]['rows'][1][0] == {'v': 'Rice'}
    google = ok(dara.post('/api/google', {'action': 'describe', 'group_id': team_group}))
    assert google['result']['configured'] is False and google['result']['sync'] is None
    assert kosal.post('/api/google', {'action': 'describe', 'group_id': team_group}).status_code == 403
    assert dara.post('/api/google', {'action': 'connect', 'group_id': team_group}).status_code == 403
    assert ok(dara.get(f'/api/tasks/group/members?id={team_group}&q=kos'))['items'][0]['name'] == 'Kosal Member'
    assert kosal.get(f'/api/tasks/group/audience?id={team_group}').status_code == 403
    # Switching Groups off again (HIDDEN_FUNCTIONS) removes them everywhere, on the server.
    settings.HIDDEN_FUNCTIONS = ('tasks.groups', 'admin.integrations')
    assert ok(dara.get('/api/state'))['tm_boards'] == []
    assert dara.get(f'/api/tasks/group?id={team_group}').status_code == 403
    assert dara.command('tm.group.row.add', {'group_id': team_group, 'values': {}}).status_code == 403


def test_task_attachments_preview_follows_task_visibility(team):
    admin, ids, c, ws = team
    dara, kosal, neary = c['dara'], c['kosal'], c['neary']
    from tasks.domain import add_days, task_today
    task = ok(dara.command('tm.task.save', {'workspace_id': ws, 'title': 'Count the stock', 'description': 'Monthly count.', 'start_date': task_today(),
                                            'due_date': add_days(task_today(), 3), 'pic_id': ids['dara']}))['result']['id']
    uploads = {'report.pdf': PDF, 'notes.docx': docx(), 'stock.xlsx': xlsx(), 'plan.pptx': pptx(), 'list.csv': 'Item;Qty\r\nRice;12\r\n"Oil; extra";3\r\n'.encode(),
               'readme.txt': 'Line one\r\nស្តុក\n'.encode(), 'archive.zip': package({'a.txt': 'x'}), 'photo.png': base64.b64decode(PNG),
               'unsafe.docx': docx(doctype=True)}
    file_ids = {}
    for name, data in uploads.items():
        file_ids[name] = ok(dara.command('tm.file.add', {'task_id': task, 'name': name, 'base64': b64(data)}))['result']['id']

    def preview(client, name):
        return client.get(f'/api/tasks/file/preview?id={file_ids[name]}')
    pdf = dara.get(f"/api/tasks/file?id={file_ids['report.pdf']}&inline=1")
    assert pdf['Content-Type'] == 'application/pdf' and pdf['Content-Disposition'].startswith('inline') and pdf.content == PDF
    assert pdf['Content-Security-Policy'] == "default-src 'none'; sandbox" and pdf['X-Content-Type-Options'] == 'nosniff'
    assert dara.get(f"/api/tasks/file?id={file_ids['notes.docx']}&inline=1")['Content-Type'] == 'application/octet-stream'
    assert ok(preview(dara, 'report.pdf'))['view'] == 'pdf'
    assert ok(preview(dara, 'photo.png'))['view'] == 'image'
    doc = ok(preview(dara, 'notes.docx'))
    assert doc['kind'] == 'document'
    assert doc['blocks'][0] == {'type': 'heading', 'level': 1, 'runs': [{'t': 'Stock count'}]}
    assert doc['blocks'][1]['runs'] == [{'t': 'Bold ', 'b': 1}, {'t': 'and plain'}]
    assert doc['blocks'][2] == {'type': 'item', 'level': 1, 'runs': [{'t': 'A list item'}]}
    assert doc['blocks'][3] == {'type': 'table', 'rows': [['Item', 'Qty'], ['Rice', '12']]}
    assert doc['blocks'][4]['runs'] == [{'t': '<script>alert(1)</script>'}]   # text only: shown, never run
    sheet = ok(preview(dara, 'stock.xlsx'))
    assert sheet['kind'] == 'table' and sheet['sheets'][0]['rows'] == [['Item', 'Qty', 'Date'], ['Rice', '12', '2026-10-05'], ['=cmd', '1.5']]
    slides = ok(preview(dara, 'plan.pptx'))
    assert slides['slides'] == [{'number': 1, 'title': 'Quarterly plan', 'paragraphs': ['Count stock']}]
    assert ok(preview(dara, 'list.csv'))['sheets'][0]['rows'] == [['Item', 'Qty'], ['Rice', '12'], ['Oil; extra', '3']]
    assert ok(preview(dara, 'readme.txt'))['text'] == 'Line one\nស្តុក\n'
    assert ok(preview(dara, 'archive.zip'))['view'] == 'unsupported'
    unsafe = ok(preview(dara, 'unsafe.docx'))
    assert unsafe['kind'] == 'unsupported' and 'not allowed' in unsafe['reason']
    # Someone who may not see the task gets "not found" for every file, also by guessing or changing IDs.
    for name in uploads:
        assert preview(neary, name).status_code in (403, 404)
        assert neary.get(f'/api/tasks/file?id={file_ids[name]}&inline=1').status_code in (403, 404)
    # Preview access is exactly download access (Kosal is a member of the task's workspace, so he may see its files).
    for client in (kosal, neary):
        for name in uploads:
            assert preview(client, name).status_code == client.get(f'/api/tasks/file?id={file_ids[name]}').status_code
    assert kosal.get('/api/tasks/file/preview?id=FILE-999999').status_code == 404
    assert Api().get(f"/api/tasks/file/preview?id={file_ids['notes.docx']}").status_code == 401


def test_preview_refuses_unsafe_or_damaged_files():
    from tasks.preview import build
    xlsx_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    docx_mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    assert build('a.docx', docx_mime, b'PK\x03\x04 not really a zip')['kind'] == 'unsupported'
    assert build('a.docx', docx_mime, package({'x.xml': '<x/>'}))['kind'] == 'unsupported'
    assert build('a.docx', docx_mime, package({'word/document.xml': '<w:document'}))['kind'] == 'unsupported'
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('word/document.xml', b'<' + b'a' * (70 * 1024 * 1024))
    refused = build('bomb.docx', docx_mime, bomb.getvalue())
    assert refused['kind'] == 'unsupported' and 'expands' in refused['reason']
    assert build('a.xlsx', xlsx_mime, package({'xl/workbook.xml': '<!DOCTYPE x><workbook/>'}))['kind'] == 'unsupported'
    long_text = build('big.txt', 'text/plain', b'x' * 300000)
    assert long_text['truncated'] is True and len(long_text['text']) == 200000


def test_mini_app_preview_uses_the_media_token(admin_api):
    from telegram.models import TelegramSettings
    assert admin_api.command('admin.telegram.save', {'expected_version': 0, 'enabled': True, 'bot_token': TOKEN}).status_code == 200
    TelegramSettings.objects.filter(id=1).update(bot_username='sunny_test_bot', status='ON')
    created = admin_api.command('admin.user.save', {'name': 'Dara Member', 'role_id': 'ROLE-MEMBER', 'password': 'Dara-password-2026'}).json()['result']
    staff = User.objects.get(id=created['id']).staff_id
    dara = login('Dara Member', 'Dara-password-2026')
    code = dara.command('tg.link.code', {}).json()['result']['code']
    app = MiniApp(launch(5550002))
    assert app.post('/link', {'code': code}).status_code == 200
    ws = admin_api.command('tm.workspace.save', {'name': 'Field', 'owner_id': admin_api.user['staff_id'], 'member_ids': [staff]}).json()['result']['id']
    from tasks.domain import add_days, task_today
    task = app.post('/command', {'action': 'tm.task.save', 'data': {'workspace_id': ws, 'title': 'Check', 'description': 'Weekly check.', 'start_date': task_today(),
                                                                      'due_date': add_days(task_today(), 2), 'pic_id': staff}}).json()['result']['id']
    file = app.post('/command', {'action': 'tm.file.add', 'data': {'task_id': task, 'name': 'notes.docx', 'base64': b64(docx())}}).json()['result']['id']
    token = app.get('/state').json()['media_token']
    got = app.api.client.get(f'/c/default/tg/api/file-preview?t={token}&id={file}')
    assert got.status_code == 200 and got.json()['kind'] == 'document' and got['Content-Security-Policy'].startswith("default-src 'self'")
    assert app.api.client.get(f'/c/default/tg/api/file-preview?t=bad&id={file}').json()['code'] == 'media'
    assert app.api.client.get(f'/c/default/tg/api/file-preview?t={token}&id=FILE-999999').status_code == 404


def test_roles_receive_group_permissions_once_when_groups_return(admin_api):
    """Migration groups.0002: V5.7.7's upgrade step, for roles that lost their Group rows while Groups were hidden."""
    from importlib import import_module
    from django.apps import apps
    migration = import_module('groups.migrations.0002_group_permissions')
    with transaction.atomic():
        custom = Role.objects.create(id='ROLE-000100', name='Coordinators', created_at=Role.objects.first().created_at, updated_at=Role.objects.first().updated_at)
        RolePermission.objects.create(role=custom, resource='tasks.tasks', action='view')
        no_tasks = Role.objects.create(id='ROLE-000101', name='Reports only', created_at=custom.created_at, updated_at=custom.updated_at)
        RolePermission.objects.filter(role_id='ROLE-MEMBER', resource='tasks.groups').delete()
        RolePermission.objects.filter(role_id='ROLE-MANAGER', resource='tasks.groups').exclude(action='view').delete()
    migration.grant(apps, None)
    groups_of = lambda role: sorted(RolePermission.objects.filter(role_id=role, resource='tasks.groups').values_list('action', flat=True))
    assert groups_of('ROLE-MEMBER') == ['create', 'delete', 'export', 'update', 'view']   # restored to its starter permissions
    assert groups_of('ROLE-MANAGER') == ['view']                                           # already had one: left as it was
    assert groups_of(custom.id) == ['view'] and groups_of(no_tasks.id) == []
    migration.grant(apps, None)
    assert groups_of(custom.id) == ['view']                                                 # once only

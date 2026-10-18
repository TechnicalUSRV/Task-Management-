"""Feature regressions: scoped copy grants, data integrity, delivery and signed Mini App access."""
from datetime import timedelta
from io import BytesIO
import json
import uuid

import pytest
from django.db import connection
from django.utils import timezone
from pypdf import PdfReader, PdfWriter

from accounts.models import RolePermission, User
from core.errors import InputError
from groups.models import BoardCellStyle, BoardDataShare, BoardDelivery, BoardFile, BoardImport, BoardRow
from groups.presentation import display_number
from groups.delivery import MAX_DOCUMENT, merge_pdfs, process_next
from telegram.models import TelegramLink
from telegram.bot import TelegramError
from tests.test_groups_and_previews import team, ok, b64, PNG
from tests.test_telegram import TOKEN, MiniApp, launch

pytestmark = pytest.mark.django_db(transaction=True)


def command(client, action, data):
    return ok(client.command(action, data))['result']


def board(client, workspace, name, **extra):
    key = command(client, 'tm.group.save', {'workspace_id': workspace, 'name': name, **extra})['id']
    return key, ok(client.get(f'/api/tasks/group?id={key}'))['columns'][0]['id']


def column(client, group, name, kind='TEXT', **settings):
    return command(client, 'tm.group.column.save', {'group_id': group, 'name': name, 'type': kind, 'settings': settings})['id']


def record(client, group, values):
    return command(client, 'tm.group.row.add', {'group_id': group, 'values': values})['id']


def pdf(widths, password=None):
    w = PdfWriter()
    for width in widths:
        w.add_blank_page(width=width, height=200)
    if password:
        w.encrypt(password)
    out = BytesIO(); w.write(out); w.close()
    return out.getvalue()


def attach(client, group, row, col, name, data):
    return command(client, 'tm.group.file.add', {'group_id': group, 'row_id': row, 'column_id': col, 'name': name, 'base64': b64(data)})['id']


def connect(admin, staff, tg=777):
    command(admin, 'admin.telegram.save', {'enabled': True, 'bot_token': TOKEN, 'expected_version': 0})
    TelegramLink.objects.create(tg_user_id=tg, staff_id=staff, chat_id=tg, linked_at=timezone.now())


def delivery(client, group, files, mode='SEPARATE', **extra):
    return client.command('tm.group.delivery.create', {'group_id': group, 'file_ids': files, 'mode': mode, 'request_key': str(uuid.uuid4()), **extra})


@pytest.fixture
def shares(team):
    admin, ids, clients, ws = team
    a, b = clients['dara'], clients['kosal']
    source, text = board(a, ws, 'Private source')
    num = column(a, source, 'Budget', 'NUMBER')
    secret = column(a, source, 'Confidential')
    formula = column(a, source, 'Double', 'FORMULA', expression='{Budget} * 2')
    first = record(a, source, {text: 'Invoice 001', num: 1500, secret: 'never shared'})
    second = record(a, source, {text: 'Invoice 002', num: 25})
    dest_ws = command(admin, 'tm.workspace.save', {'name': 'Other department', 'owner_id': ids['kosal'], 'member_ids': [ids['kosal']]})['id']
    dest, dest_text = board(b, dest_ws, 'Copied register')
    return admin, ids, clients, source, dest, [text, num, secret, formula], [first, second], dest_text


def grant(a, source, target, columns, **extra):
    return command(a, 'tm.group.data-share.save', {'group_id': source, 'recipient_id': target, 'column_ids': columns, **extra})


def staged(b, source, dest, cols, rows):
    return command(b, 'tm.group.import.internal', {'group_id': dest, 'source_id': source, 'column_ids': cols, 'row_ids': rows})['id']


def plan(target):
    return {'mode': 'append', 'sheets': [{'index': 0, 'header_row': 1, 'columns': [{'source': 0, 'target': target}, {'source': 1, 'new': {'name': 'Amount', 'type': 'NUMBER'}}]}]}


def test_formats_and_colors_never_change_values_or_formulas(team):
    _, ids, clients, ws = team
    a, b = clients['dara'], clients['kosal']
    g, item = board(a, ws, 'Formats', visibility='TEAM', audience='SELECTED', shared=[{'staff_id': ids['kosal'], 'level': 'VIEW'}])
    num = column(a, g, 'Cost', 'NUMBER', format='USD', decimals=2, grouping=True)
    formula = column(a, g, 'Tax', 'FORMULA', expression='{Cost} * 0.1', format='KHR')
    rid = record(a, g, {item: 'A', num: 1500.1234})
    before = BoardRow.objects.get(id=rid)
    out = command(a, 'tm.group.cell.format', {'group_id': g, 'row_id': rid, 'column_id': num, 'expected_version': before.version,
                                           'style': {'text_color': '#d92d20', 'background_color': '#FEF0C7'}})['row']
    assert out['values'][num] == 1500.1234 and out['computed'][formula] == 150.01234
    assert BoardRow.objects.get(id=rid).values_json == before.values_json
    read = ok(a.get(f'/api/tasks/group?id={g}'))['rows'][0]
    assert read['styles'][num]['text_color'] == '#D92D20'
    assert a.command('tm.group.cell.format', {'group_id': g, 'row_id': rid, 'column_id': num, 'expected_version': before.version, 'style': {}}).status_code == 409
    bad = {'group_id': g, 'row_id': rid, 'column_id': num, 'expected_version': out['version'], 'style': {'text_color': 'url(https://x)'}}
    assert a.command('tm.group.cell.format', bad).status_code == 400
    assert b.command('tm.group.cell.format', {**bad, 'style': {}}).status_code == 403
    assert display_number(1500, {'format': 'USD'}) == '$1,500.00'
    assert display_number(1500, {'format': 'KHR'}) == '៛1,500'
    assert display_number(25, {'format': 'PERCENT'}) == '25%'
    assert display_number(1500, {'format': 'CUSTOM', 'prefix': 'qty ', 'suffix': ' kg', 'grouping': False}) == 'qty 1500 kg'
    # Search/filter/matching text continues to use the original unadorned number.
    from groups.domain import cell_text
    assert '$' not in cell_text({'type': 'NUMBER', 'settings': {'format': 'USD'}}, 1500)
    command(a, 'tm.group.cell.format', {**bad, 'style': {}})
    assert not BoardCellStyle.objects.exists()


def test_data_grant_is_column_scoped_and_does_not_grant_membership(shares):
    _, ids, c, source, dest, cols, rows, _ = shares
    a, b = c['dara'], c['kosal']
    assert ok(b.get(f'/api/tasks/group/import-sources?id={dest}'))['sources'] == []
    grant(a, source, ids['kosal'], cols[:2])
    assert b.get(f'/api/tasks/group?id={source}').status_code == 404
    assert source not in [x['id'] for x in ok(b.get('/api/state'))['tm_boards']]
    snap = ok(b.get(f'/api/tasks/group/import-source?id={dest}&source={source}'))
    assert [x['id'] for x in snap['columns']] == cols[:2]
    assert 'never shared' not in json.dumps(snap) and cols[2] not in json.dumps(snap)
    assert b.command('tm.group.row.update', {'group_id': source, 'id': rows[0], 'values': {cols[0]: 'changed'}, 'expected_version': 0}).status_code == 404
    assert b.command('tm.group.import.internal', {'group_id': dest, 'source_id': source, 'column_ids': [cols[2]], 'row_ids': rows}).status_code == 409
    assert a.command('tm.group.data-share.save', {'group_id': source, 'recipient_id': ids['kosal'], 'column_ids': [cols[3]], 'expected_version': 0}).status_code == 400


def test_internal_copy_uses_preview_confirmation_and_is_idempotent(shares):
    _, ids, c, source, dest, cols, rows, target = shares
    grant(c['dara'], source, ids['kosal'], cols[:2])
    key = staged(c['kosal'], source, dest, cols[:2], rows)
    p = plan(target)
    preview = ok(c['kosal'].post('/api/tasks/group/import/preview', {'import_id': key, 'plan': p}))
    assert preview['totals'] == {'add': 2, 'update': 0, 'skipped': 0, 'failed': 0}
    assert c['kosal'].command('tm.group.import.commit', {'import_id': key, 'plan': p}).status_code == 409
    data = {'import_id': key, 'plan': p, 'expected': preview['totals']}
    command(c['kosal'], 'tm.group.import.commit', data)
    assert command(c['kosal'], 'tm.group.import.commit', data)['already']
    assert BoardRow.objects.filter(board_id=dest).count() == 2
    amount = next(x for x in ok(c['kosal'].get(f'/api/tasks/group?id={dest}'))['columns'] if x['name'] == 'Amount')['id']
    assert ok(c['kosal'].get(f'/api/tasks/group?id={dest}'))['rows'][0]['values'][amount] == 1500
    # Copies survive a later source change or share revocation.
    command(c['dara'], 'tm.group.row.update', {'group_id': source, 'id': rows[0], 'values': {cols[1]: 999}, 'expected_version': 0})
    grant(c['dara'], source, ids['kosal'], [], active=False, expected_version=0)
    assert ok(c['kosal'].get(f'/api/tasks/group?id={dest}'))['rows'][0]['values'][amount] == 1500
    from audit.models import ActivityEvent
    assert ActivityEvent.objects.filter(entity_id=dest, action='Imported from Group').exists()


@pytest.mark.parametrize('change', ['revoke', 'source', 'disable'])
def test_pending_copy_rechecks_authority_and_snapshot(shares, change):
    _, ids, c, source, dest, cols, rows, target = shares
    grant(c['dara'], source, ids['kosal'], cols[:2])
    key = staged(c['kosal'], source, dest, cols[:2], rows)
    if change == 'revoke':
        grant(c['dara'], source, ids['kosal'], [], active=False, expected_version=0)
    elif change == 'source':
        command(c['dara'], 'tm.group.row.update', {'group_id': source, 'id': rows[0], 'expected_version': 0, 'values': {cols[1]: 55}})
    else:
        User.objects.filter(staff_id=ids['dara']).update(active=False)
    response = c['kosal'].post('/api/tasks/group/import/preview', {'import_id': key, 'plan': plan(target)})
    assert response.status_code in (403, 404, 409), response.content
    assert c['kosal'].get(f'/api/tasks/group/import?id={dest}&import={key}').status_code in (403, 404, 409)
    assert c['kosal'].command('tm.group.import.commit', {'import_id': key, 'plan': plan(target), 'expected': {'add': 2, 'update': 0}}).status_code in (403, 404, 409)
    assert BoardRow.objects.filter(board_id=dest).count() == 0


def test_source_restrictions_and_formula_results(shares):
    _, ids, c, source, dest, cols, rows, _ = shares
    grant(c['dara'], source, ids['kosal'], [cols[0], cols[1], cols[3]])
    command(c['dara'], 'tm.group.row.access', {'group_id': source, 'ids': [rows[1]], 'principals': [{'type': 'USER', 'id': ids['dara']}]})
    snap = ok(c['kosal'].get(f'/api/tasks/group/import-source?id={dest}&source={source}'))
    assert len(snap['rows']) == 1 and snap['rows'][0]['cells'][2]['v'] == 3000
    assert snap['columns'][2]['type'] == 'NUMBER' and 'expression' not in json.dumps(snap)
    command(c['dara'], 'tm.group.column.access', {'group_id': source, 'id': cols[1], 'principals': [{'type': 'USER', 'id': ids['dara']}]})
    snap = ok(c['kosal'].get(f'/api/tasks/group/import-source?id={dest}&source={source}'))
    assert [x['id'] for x in snap['columns']] == [cols[0]]


@pytest.fixture
def files(team):
    admin, ids, c, ws = team
    a = c['dara']; g, text = board(a, ws, 'Documents')
    col = column(a, g, 'Files', 'ATTACHMENT'); r = record(a, g, {text: 'Invoices'})
    first = attach(a, g, r, col, 'First.pdf', pdf([100, 110]))
    second = attach(a, g, r, col, 'Second.pdf', pdf([120]))
    connect(admin, ids['dara'])
    return admin, ids, c, g, r, col, [first, second]


def test_delivery_separate_merge_own_recipient_and_idempotency(files):
    _, _, c, g, _, _, ids = files
    a = c['dara']; key = str(uuid.uuid4())
    assert delivery(a, g, ids, request_key=key, chat_id=-123456).status_code == 400
    first = ok(delivery(a, g, ids, request_key=key))['result']['delivery']
    repeated = ok(delivery(a, g, ids, request_key=key))['result']['delivery']
    assert first['id'] == repeated['id'] and BoardDelivery.objects.count() == 1
    sent = []
    def send(method, chat, field, document, extra):
        assert not connection.in_atomic_block
        assert method == 'sendDocument' and chat == 777
        sent.append(document)
        return {'message_id': len(sent)}
    assert process_next(send)
    assert [x['name'] for x in sent] == ['First.pdf', 'Second.pdf']
    assert ok(a.get(f'/api/tasks/group/delivery?id={g}&delivery={first["id"]}'))['status'] == 'SENT'
    assert c['kosal'].get(f'/api/tasks/group/delivery?id={g}&delivery={first["id"]}').status_code == 404
    originals = [bytes(BoardFile.objects.get(id=i).content) for i in ids]
    merged = ok(delivery(a, g, ids[::-1], 'MERGED_PDF'))['result']['delivery']
    assert process_next(send)
    reader = PdfReader(BytesIO(sent[-1]['content']))
    assert [float(p.mediabox.width) for p in reader.pages] == [120, 100, 110]
    assert [bytes(BoardFile.objects.get(id=i).content) for i in ids] == originals
    assert BoardDelivery.objects.get(id=merged['id']).status == 'SENT'
    assert not process_next(send)


def test_delivery_checks_cell_type_size_and_revoked_link(files):
    _, _, c, g, r, col, ids = files
    a = c['dara']
    text_file = attach(a, g, r, col, 'note.txt', b'Hello')
    assert delivery(a, g, [ids[0], text_file], 'MERGED_PDF').status_code == 400
    other = record(a, g, {})
    other_file = attach(a, g, other, col, 'Other.pdf', pdf([100]))
    assert delivery(a, g, [ids[0], other_file]).status_code == 400
    BoardFile.objects.filter(id=text_file).update(size=MAX_DOCUMENT + 1)
    assert delivery(a, g, [text_file]).status_code == 413
    j = ok(delivery(a, g, ids))['result']['delivery']
    TelegramLink.objects.filter(tg_user_id=777).update(linked_at=timezone.now() + timedelta(seconds=1))
    assert process_next(lambda *args: pytest.fail('Should not send after link changes'))
    assert BoardDelivery.objects.get(id=j['id']).status == 'FAILED'


@pytest.mark.parametrize('failure,status', [(TelegramError('blocked', 403), 'PARTIAL'), (TimeoutError(), 'UNKNOWN')])
def test_partial_and_ambiguous_delivery_are_never_automatically_retried(files, failure, status):
    _, _, c, g, _, _, ids = files
    j = ok(delivery(c['dara'], g, ids))['result']['delivery']; calls = []
    def send(*args):
        calls.append(args)
        if len(calls) == 2:
            raise failure
        return {'message_id': 1}
    process_next(send)
    job = BoardDelivery.objects.get(id=j['id'])
    assert job.status == status and len(json.loads(job.result_json)) == 1
    assert not process_next(send) and len(calls) == 2


def test_encrypted_pdf_rejected_without_changing_original(files):
    _, _, c, g, r, col, ids = files
    protected = attach(c['dara'], g, r, col, 'Protected.pdf', pdf([130], 'private'))
    j = ok(delivery(c['dara'], g, [ids[0], protected], 'MERGED_PDF'))['result']['delivery']
    process_next(lambda *args: pytest.fail('Encrypted PDF should not be sent as merged'))
    assert 'Password-protected' in BoardDelivery.objects.get(id=j['id']).error
    assert PdfReader(BytesIO(bytes(BoardFile.objects.get(id=protected).content))).is_encrypted


def test_mini_app_groups_use_shared_permissions_and_media_tokens(files):
    _, ids, c, g, r, col, file_ids = files
    app = MiniApp(launch(777))
    state = ok(app.get('/state'))
    assert g in [b['id'] for b in state['tm_boards']]
    office = ok(c['dara'].get('/api/state'))
    for field in ('tm_boards', 'tm_board_access', 'tm_board_summaries', 'tm_group_workspaces'):
        assert state[field] == office[field]
    out = ok(app.get(f'/group?id={g}'))
    text = out['columns'][0]['id']; row = out['rows'][0]
    saved = ok(app.post('/command', {'action': 'tm.group.row.update', 'data': {'group_id': g, 'id': r, 'expected_version': row['version'], 'values': {text: 'Mobile update'}}}))
    assert saved['result']['row']['values'][text] == 'Mobile update'
    assert ok(c['dara'].get(f'/api/tasks/group?id={g}'))['rows'][0]['values'][text] == 'Mobile update'
    assert app.post('/command', {'action': 'tm.group.data-share.save', 'data': {}}).status_code == 403
    token = state['media_token']
    media = f'/c/default/tg/api/group-file?id={g}&file={file_ids[0]}&inline=1&t={token}'
    assert app.api.client.get(media).status_code == 200
    assert app.api.client.get(media.replace(g, 'UNKNOWN')).status_code == 404
    assert app.api.client.get(media.replace(token, 'bad')).status_code == 403
    TelegramLink.objects.filter(tg_user_id=777).update(linked_at=timezone.now() + timedelta(seconds=1))
    assert app.api.client.get(media).status_code == 403
    # Role changes take effect on subsequent signed requests, including commands and state.
    RolePermission.objects.filter(role_id='ROLE-MEMBER', resource='tasks.groups', action='update').delete()
    response = app.post('/command', {'action': 'tm.group.row.update', 'data': {'group_id': g, 'id': r, 'expected_version': saved['result']['row']['version'], 'values': {text: 'Blocked'}}})
    assert response.status_code == 403


def test_internal_matching_key_updates_and_incompatible_types_are_previewed(shares):
    _, ids, c, source, dest, cols, rows, target = shares
    grant(c['dara'], source, ids['kosal'], cols[:2])
    amount = column(c['kosal'], dest, 'Amount', 'NUMBER')
    record(c['kosal'], dest, {target: 'Invoice 001', amount: 1})
    key = staged(c['kosal'], source, dest, cols[:2], rows)
    p = {'mode': 'update', 'unmatched': 'add', 'sheets': [{'index': 0, 'header_row': 1, 'key': {'source': 0},
         'columns': [{'source': 0, 'target': target}, {'source': 1, 'target': amount}]}]}
    preview = ok(c['kosal'].post('/api/tasks/group/import/preview', {'import_id': key, 'plan': p}))
    assert preview['totals']['update'] == 1 and preview['totals']['add'] == 1
    assert c['kosal'].command('tm.group.import.commit', {'import_id': key, 'plan': p, 'expected': preview['totals']}).status_code == 409
    command(c['kosal'], 'tm.group.import.commit', {'import_id': key, 'plan': p, 'expected': preview['totals'], 'confirm_update': True})
    assert [r['values'][amount] for r in ok(c['kosal'].get(f'/api/tasks/group?id={dest}'))['rows']] == [1500, 25]
    key = staged(c['kosal'], source, dest, [cols[0]], rows)
    incompatible = {'sheets': [{'index': 0, 'header_row': 1, 'columns': [{'source': 0, 'target': amount}]}]}
    preview = ok(c['kosal'].post('/api/tasks/group/import/preview', {'import_id': key, 'plan': incompatible}))
    assert preview['totals']['failed'] == 2 and preview['totals']['add'] == 0


def test_copy_grants_respect_organizational_outside_collaboration(shares, monkeypatch):
    _, ids, c, source, _, cols, _, _ = shares
    from organization.governance import Governance
    # The fixture's source workspace contains Dara and Kosal, but not Neary.
    monkeypatch.setattr(Governance, 'can_collaborate_outside', lambda *args: False)
    assert c['dara'].command('tm.group.data-share.save', {'group_id': source, 'recipient_id': ids['neary'], 'column_ids': cols[:2]}).status_code == 403
    grant(c['dara'], source, ids['kosal'], cols[:2])
    assert BoardDataShare.objects.count() == 1


def test_hidden_cell_colors_do_not_leak_and_invalid_formats_are_refused(team):
    _, ids, c, ws = team
    a, b = c['dara'], c['kosal']
    g, item = board(a, ws, 'Styles', visibility='TEAM', audience='WORKSPACE')
    num = column(a, g, 'Private cost', 'NUMBER')
    rid = record(a, g, {item: 'Stock', num: 7})
    command(a, 'tm.group.cell.format', {'group_id': g, 'row_id': rid, 'column_id': num, 'expected_version': 0, 'style': {'text_color': '#AABBCC'}})
    command(a, 'tm.group.column.access', {'group_id': g, 'id': num, 'principals': [{'type': 'USER', 'id': ids['dara']}]})
    response = ok(b.get(f'/api/tasks/group?id={g}'))
    assert num not in json.dumps(response['rows'])
    bad = {'group_id': g, 'name': 'Invalid', 'type': 'NUMBER', 'settings': {'format': 'BAD'}}
    assert a.command('tm.group.column.save', bad).status_code == 400
    assert a.command('tm.group.column.save', {**bad, 'settings': {'format': 'CUSTOM', 'prefix': '\n'}}).status_code == 400


def test_delivery_rechecks_access_after_queue_and_refuses_expired_jobs(files):
    _, ids, c, g, _, _, file_ids = files
    job = ok(delivery(c['dara'], g, file_ids))['result']['delivery']
    User.objects.filter(staff_id=ids['dara']).update(active=False)
    process_next(lambda *args: pytest.fail('Disabled user must not send'))
    assert BoardDelivery.objects.get(id=job['id']).status == 'FAILED'
    User.objects.filter(staff_id=ids['dara']).update(active=True)
    job = ok(delivery(c['dara'], g, file_ids))['result']['delivery']
    BoardDelivery.objects.filter(id=job['id']).update(status='SENDING', updated_at=timezone.now() - timedelta(minutes=11))
    assert not process_next(lambda *args: pytest.fail('Interrupted job must not be retried'))
    assert BoardDelivery.objects.get(id=job['id']).status == 'UNKNOWN'


def test_merge_page_and_result_size_limits(files, monkeypatch):
    _, _, _, _, _, _, ids = files
    stored = list(BoardFile.objects.filter(id__in=ids).order_by('id'))
    monkeypatch.setattr('groups.delivery.MAX_PAGES', 2)
    with pytest.raises(InputError, match='1,000 pages'):
        merge_pdfs(stored)
    monkeypatch.setattr('groups.delivery.MAX_PAGES', 1000)
    monkeypatch.setattr('groups.delivery.MAX_DOCUMENT', 1)
    with pytest.raises(InputError, match='50 MB'):
        merge_pdfs(stored)


def test_merge_batch_limit_checked_before_reading_contents(files, monkeypatch):
    _, people, _, group, _, _, ids = files
    from django.test.utils import CaptureQueriesContext
    from groups.delivery import files_for
    from groups.views import service
    monkeypatch.setattr('groups.delivery.MAX_MERGE', 1)
    with CaptureQueriesContext(connection) as queries:
        with pytest.raises(InputError, match='100 MB'):
            files_for(service(), group, people['dara'], ids, 'MERGED_PDF')
    assert not any('"tm_board_files"."content"' in q['sql'] for q in queries)


def test_additive_migration_preserves_existing_rows_files_and_imports(files):
    _, ids, _, g, _, _, file_ids = files
    from django.db.migrations.executor import MigrationExecutor
    before_rows = list(BoardRow.objects.filter(board_id=g).values())
    before_files = [bytes(BoardFile.objects.get(id=i).content) for i in file_ids]
    old = [('groups', '0002_group_permissions')]
    current = [('groups', '0003_presentation_sharing_delivery')]
    executor = MigrationExecutor(connection)
    try:
        executor.migrate(old)
        HistoricalImport = executor.loader.project_state(old).apps.get_model('groups', 'BoardImport')
        HistoricalImport.objects.create(id='IMP-PREVIOUS', board_id=g, staff_id=ids['dara'], file_name='old.xlsx', file_size=100,
                                        sheets_json='[]', status='UPLOADED', created_at=timezone.now())
    finally:
        MigrationExecutor(connection).migrate(current)
    assert list(BoardRow.objects.filter(board_id=g).values()) == before_rows
    assert [bytes(BoardFile.objects.get(id=i).content) for i in file_ids] == before_files
    assert BoardImport.objects.get(id='IMP-PREVIOUS').source_json == '{}'


def test_merge_keeps_annotation_appearance_but_removes_actions(files):
    _, _, c, g, r, col, ids = files
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject
    writer = PdfWriter(); page = writer.add_blank_page(width=100, height=200)
    annotation = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Text'),
        NameObject('/Rect'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(20), FloatObject(20)]),
        NameObject('/Contents'): TextStringObject('Approved stamp note'),
        NameObject('/A'): DictionaryObject({NameObject('/S'): NameObject('/JavaScript'), NameObject('/JS'): TextStringObject('app.alert(1)')})})
    page[NameObject('/Annots')] = ArrayObject([annotation])
    out = BytesIO(); writer.write(out); writer.close()
    annotated = attach(c['dara'], g, r, col, 'Notes.pdf', out.getvalue())
    result = merge_pdfs([BoardFile.objects.get(id=annotated), BoardFile.objects.get(id=ids[0])])
    reader = PdfReader(BytesIO(result['content']))
    copied = reader.pages[0]['/Annots'][0].get_object()
    assert copied['/Contents'] == 'Approved stamp note' and '/A' not in copied

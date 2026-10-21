"""Share Live Data (requirement 1): one source of truth, Viewer / Can Edit per column, formulas over shared values, edit
history, revocation, concurrent edits, protection of the connection, and the existing independent-copy Share Data.

Dara owns the source Group "Sales" (Item, Revenue, Region, Notes). Kosal's own Group "Profit" (another workspace) has
Item and Cost; Chan works in Kosal's workspace but has no share. Neary has a View-only role.
"""
import json

import pytest

from accounts.models import User
from groups.models import Board, BoardLiveEdit, BoardRow
from tests.test_group_enhancements import board, column, command, record
from tests.test_groups_and_previews import login, ok, team  # noqa: F401 — fixtures

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def live(team):
    admin, ids, c, ws = team
    r = admin.command('admin.user.save', {'name': 'Chan Member', 'role_id': 'ROLE-MEMBER', 'password': 'Chan-password-2026'})
    ids['chan'] = User.objects.get(id=r.json()['result']['id']).staff_id
    from organization.models import Profile
    Profile.objects.filter(staff_id=ids['chan']).update(org_level_id=3)
    c['chan'] = login('Chan Member', 'Chan-password-2026')
    dara, kosal = c['dara'], c['kosal']
    sales, item = board(dara, ws, 'Sales')
    revenue = column(dara, sales, 'Revenue', 'NUMBER')
    region = column(dara, sales, 'Region')
    notes = column(dara, sales, 'Notes')
    rice = record(dara, sales, {item: 'Rice', revenue: 100, region: 'North', notes: 'internal'})
    oil = record(dara, sales, {item: 'Oil', revenue: 50, region: 'South'})
    other = command(admin, 'tm.workspace.save', {'name': 'Kosal department', 'owner_id': ids['kosal'], 'member_ids': [ids['kosal'], ids['chan']]})['id']
    profit, local_item = board(kosal, other, 'Profit', visibility='TEAM', audience='WORKSPACE', workspace_level='EDIT')
    cost = column(kosal, profit, 'Cost', 'NUMBER')
    rows = {name: record(kosal, profit, {local_item: name, cost: value}) for name, value in (('rice', 30), ('Oil ', 20), ('Salt', 5))}
    return {'admin': admin, 'ids': ids, 'c': c, 'sales': sales, 'item': item, 'revenue': revenue, 'region': region, 'notes': notes,
            'rice': rice, 'oil': oil, 'profit': profit, 'local_item': local_item, 'cost': cost, 'rows': rows}


def share(L, columns, recipient='kosal', **extra):
    return command(L['c']['dara'], 'tm.group.live-share.save', {'group_id': L['sales'], 'recipient_id': L['ids'][recipient],
                                                               'columns': [{'column_id': k, 'permission': p} for k, p in columns], **extra})


def link(L, name='Revenue (live)'):
    sid = ok(L['c']['kosal'].get(f"/api/tasks/group/live-sources?id={L['profit']}"))['sources'][0]['share_id']
    return command(L['c']['kosal'], 'tm.group.column.save', {'group_id': L['profit'], 'name': name, 'type': 'LINKED', 'settings': {
        'share_id': sid, 'source_column_id': L['revenue'], 'source_key_id': L['item'], 'key_column_id': L['local_item']}})['id']


def read(client, group):
    data = ok(client.get(f'/api/tasks/group?id={group}'))
    return data, {r['id']: r for r in data['rows']}


def test_viewer_sees_live_values_uses_them_in_formulas_and_cannot_change_the_source(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'VIEW')])
    linked = link(L)
    profit_col = column(kosal, L['profit'], 'Profit', 'FORMULA', expression='{Revenue (live)} - {Cost}')
    data, rows = read(kosal, L['profit'])
    meta = next(c for c in data['columns'] if c['id'] == linked)
    assert meta['type'] == 'LINKED' and meta['settings'] == {} and meta['live']['permission'] == 'VIEW' and meta['live']['source_type'] == 'NUMBER'
    # Rows are matched by Item (case and spaces ignored); Salt has no source record.
    assert rows[L['rows']['rice']]['values'][linked] == 100 and rows[L['rows']['rice']]['computed'][profit_col] == 70
    assert rows[L['rows']['Oil ']]['values'][linked] == 50 and rows[L['rows']['Oil ']]['computed'][profit_col] == 30
    assert linked not in rows[L['rows']['Salt']]['values']
    # Nothing was copied: the recipient's rows store only their own values.
    assert all(linked not in json.loads(r.values_json) for r in BoardRow.objects.filter(board_id=L['profit']))
    # The source changes: the recipient's live value and formula follow on the next read.
    src = BoardRow.objects.get(id=L['rice'])
    command(dara, 'tm.group.row.update', {'group_id': L['sales'], 'id': L['rice'], 'values': {L['revenue']: 120}, 'expected_version': src.version})
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == 120 and rows[L['rows']['rice']]['computed'][profit_col] == 90
    # Totals, search and the Excel export use the live values too.
    assert ok(kosal.get(f"/api/tasks/group/rows?id={L['profit']}"))['totals'][linked]['sum'] == 170
    assert len(ok(kosal.get(f"/api/tasks/group/rows?id={L['profit']}&q=120"))['rows']) == 1
    from groups.xlsx import read_xlsx
    sheet = read_xlsx(kosal.get(f"/api/tasks/group.xlsx?id={L['profit']}").content)[0]['rows']
    assert any(cell == {'v': 120} for row in sheet for cell in row)
    # Viewer: no change through the recipient's Group, the Live Data panel, or the source Group itself.
    r = kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 1}, 'expected': {linked: 120}})
    assert r.status_code == 403
    sid = meta['live']['source_group_id'] and ok(kosal.get(f"/api/tasks/group/live-sources?id={L['profit']}"))['sources'][0]['share_id']
    assert kosal.command('tm.group.live.update', {'share_id': sid, 'row_id': L['rice'], 'column_id': L['revenue'], 'value': 1, 'expected': 120}).status_code == 403
    assert kosal.command('tm.group.row.update', {'group_id': L['sales'], 'id': L['rice'], 'values': {L['revenue']: 1}, 'expected': {L['revenue']: 120}}).status_code == 404
    assert kosal.get(f"/api/tasks/group?id={L['sales']}").status_code == 404
    assert kosal.command('tm.group.column.save', {'group_id': L['sales'], 'id': L['revenue'], 'name': 'Hacked'}).status_code == 404
    assert BoardRow.objects.get(id=L['rice']).values_json == BoardRow.objects.get(id=L['rice']).values_json and json.loads(BoardRow.objects.get(id=L['rice']).values_json)[L['revenue']] == 120
    # Only the shared columns ever reach the recipient (not Region or Notes, nor their values).
    panel = ok(kosal.get(f'/api/tasks/group/live?share={sid}'))
    assert {c['id'] for c in panel['columns']} == {L['item'], L['revenue']} and 'internal' not in json.dumps(panel) and 'North' not in json.dumps(panel)
    # Viewers do not see the edit history.
    assert kosal.get(f"/api/tasks/group/live-history?id={L['sales']}").status_code == 403


def test_people_without_the_share_never_see_the_live_values(live):
    L = live
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'VIEW')])
    linked = link(L)
    profit_col = column(L['c']['kosal'], L['profit'], 'Profit', 'FORMULA', expression='{Revenue (live)} - {Cost}')
    # Chan can open Kosal's Group, but nobody shared Sales with Chan: the Live Data column and the formula using it are hidden.
    data, rows = read(L['c']['chan'], L['profit'])
    ids = {c['id'] for c in data['columns']}
    assert linked not in ids and profit_col not in ids and L['cost'] in ids
    assert all(linked not in r['values'] and profit_col not in r.get('computed', {}) for r in rows.values())
    assert '100' not in json.dumps(rows) or all(r['values'].get(L['cost']) != 100 for r in rows.values())
    # Sharing onward is impossible: Live Data columns can't be copied or shared live by the recipient.
    kosal = L['c']['kosal']
    assert kosal.command('tm.group.data-share.save', {'group_id': L['profit'], 'recipient_id': L['ids']['chan'], 'column_ids': [linked]}).status_code in (409, 400)
    assert kosal.command('tm.group.live-share.save', {'group_id': L['profit'], 'recipient_id': L['ids']['chan'],
                                                      'columns': [{'column_id': linked, 'permission': 'VIEW'}]}).status_code == 409


def test_can_edit_changes_the_same_data_with_history_and_conflict_checks(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'EDIT')])
    linked = link(L)
    # Kosal changes Revenue through his own Group: the source row changes (one source of truth).
    r = command(kosal, 'tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 130}, 'expected': {linked: 100}})
    assert r['row']['values'][linked] == 130
    assert json.loads(BoardRow.objects.get(id=L['rice']).values_json)[L['revenue']] == 130
    assert BoardRow.objects.get(id=L['rice']).updated_by_id == L['ids']['kosal']
    _, rows = read(dara, L['sales'])
    assert rows[L['rice']]['values'][L['revenue']] == 130
    # Dara changes it back in her Group; Kosal sees it.
    v = BoardRow.objects.get(id=L['rice']).version
    command(dara, 'tm.group.row.update', {'group_id': L['sales'], 'id': L['rice'], 'values': {L['revenue']: 125}, 'expected_version': v})
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == 125
    # Two people edit the same cell at once: the second, starting from the old value, is refused and nothing is lost.
    first = kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 140}, 'expected': {linked: 125}})
    second = kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 999}, 'expected': {linked: 125}})
    assert first.status_code == 200 and second.status_code == 409 and second.json()['details']['code'] == 'cell_conflict'
    assert json.loads(BoardRow.objects.get(id=L['rice']).values_json)[L['revenue']] == 140
    # The Live Data panel edits too, with the same check.
    sid = ok(kosal.get(f"/api/tasks/group/live-sources?id={L['profit']}"))['sources'][0]['share_id']
    assert command(kosal, 'tm.group.live.update', {'share_id': sid, 'row_id': L['oil'], 'column_id': L['revenue'], 'value': 55, 'expected': 50})
    assert kosal.command('tm.group.live.update', {'share_id': sid, 'row_id': L['oil'], 'column_id': L['item'], 'value': 'Gas', 'expected': 'Oil'}).status_code == 403
    # Edit history: who, when, which record and column, before and after, how; filterable by day and person.
    history = ok(kosal.get(f"/api/tasks/group/live-history?id={L['sales']}"))
    items = history['items']
    assert [(x['actor_id'], x['before'], x['after'], x['via']) for x in items[:4]] == [
        (L['ids']['kosal'], '50', '55', 'live'), (L['ids']['kosal'], '125', '140', 'live'), (L['ids']['dara'], '130', '125', 'group'), (L['ids']['kosal'], '100', '130', 'live')]
    assert all(x['column'] == 'Revenue' and x['action'] == 'EDIT' for x in items[:4]) and items[0]['row_id'] == L['oil']
    mine = ok(kosal.get(f"/api/tasks/group/live-history?id={L['sales']}&actor={L['ids']['dara']}"))['items']
    assert [x['after'] for x in mine] == ['125']
    from tasks.domain import add_days, task_today
    assert ok(kosal.get(f"/api/tasks/group/live-history?id={L['sales']}&from={add_days(task_today(), 1)}"))['total'] == 0
    assert ok(dara.get(f"/api/tasks/group/live-history?id={L['sales']}"))['total'] == history['total']
    assert L['c']['chan'].get(f"/api/tasks/group/live-history?id={L['sales']}").status_code == 403
    assert L['c']['neary'].get(f"/api/tasks/group/live-history?id={L['sales']}").status_code == 403


def test_permission_changes_and_revocation_take_effect_at_once(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'EDIT')])
    linked = link(L)
    profit_col = column(kosal, L['profit'], 'Profit', 'FORMULA', expression='{Revenue (live)} - {Cost}')
    # Downgrade to Viewer: editing stops.
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'VIEW')], expected_version=0)
    assert kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 1}, 'expected': {linked: 100}}).status_code == 403
    # Revoke: Kosal keeps his column but sees #N/A, the formula shows #N/A, and every read or write of the source is refused.
    share(L, [], active=False, expected_version=1)
    data, rows = read(kosal, L['profit'])
    meta = next(c for c in data['columns'] if c['id'] == linked)['live']
    assert meta['state'] == 'no_access' and 'source_group_name' not in meta
    assert rows[L['rows']['rice']]['values'][linked] == {'error': '#N/A'} and rows[L['rows']['rice']]['computed'][profit_col] == {'error': '#N/A'}
    assert '100' not in json.dumps(rows[L['rows']['rice']]['values'])
    assert kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 1}, 'expected': {linked: 100}}).status_code == 403
    assert ok(kosal.get(f"/api/tasks/group/live-sources?id={L['profit']}"))['sources'] == []
    assert kosal.get(f"/api/tasks/group/live-history?id={L['sales']}").status_code == 403
    # Shared again; then the source Group is archived: the issuer no longer manages an active Group, so access ends.
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'VIEW')], expected_version=2)
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == 100
    b = Board.objects.get(id=L['sales'])
    command(dara, 'tm.group.archive', {'id': L['sales'], 'status': 'ARCHIVED', 'expected_version': b.version})
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == {'error': '#N/A'}


def test_the_sources_own_row_rules_still_apply_and_duplicates_are_never_guessed(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'EDIT')])
    linked = link(L)
    command(dara, 'tm.group.row.access', {'group_id': L['sales'], 'ids': [L['oil']], 'principals': [{'type': 'USER', 'id': L['ids']['dara']}]})
    _, rows = read(kosal, L['profit'])
    assert linked not in rows[L['rows']['Oil ']]['values']
    assert kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['Oil '], 'values': {linked: 1}, 'expected': {linked: ''}}).status_code == 409
    # Two source records with the same key: shown as #DUP! and never written.
    record(dara, L['sales'], {L['item']: 'RICE', L['revenue']: 1})
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == {'error': '#DUP!'}
    r = kosal.command('tm.group.row.update', {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 7}, 'expected': {linked: {'error': '#DUP!'}}})
    assert r.status_code == 409 and 'Several shared records' in r.json()['error']


def test_connections_are_protected_and_records_can_be_added_from_the_source(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'VIEW')])
    linked = link(L)
    # The source owner can't silently break the link: shared columns keep their type and can't be deleted while shared.
    col = ok(dara.get(f"/api/tasks/group?id={L['sales']}"))['columns']
    rev = next(c for c in col if c['id'] == L['revenue'])
    r = dara.command('tm.group.column.save', {'group_id': L['sales'], 'id': L['revenue'], 'name': 'Revenue', 'type': 'TEXT', 'expected_version': rev['version']})
    assert r.status_code == 409 and 'shared as Live Data' in r.json()['error']
    assert dara.command('tm.group.column.delete', {'group_id': L['sales'], 'id': L['revenue'], 'expected_version': rev['version'], 'confirm': True}).status_code == 409
    # The recipient's match column is protected, and a Live Data column can't be converted.
    local = ok(kosal.get(f"/api/tasks/group?id={L['profit']}"))['columns']
    key = next(c for c in local if c['id'] == L['local_item'])
    assert kosal.command('tm.group.column.delete', {'group_id': L['profit'], 'id': L['local_item'], 'expected_version': key['version'], 'confirm': True}).status_code == 409
    lc = next(c for c in local if c['id'] == linked)
    assert kosal.command('tm.group.column.save', {'group_id': L['profit'], 'id': linked, 'name': 'X', 'type': 'NUMBER', 'expected_version': lc['version']}).status_code == 409
    # Renaming the Live Data column is fine and keeps the connection.
    command(kosal, 'tm.group.column.save', {'group_id': L['profit'], 'id': linked, 'name': 'Sales revenue', 'type': 'LINKED', 'expected_version': lc['version']})
    _, rows = read(kosal, L['profit'])
    assert rows[L['rows']['rice']]['values'][linked] == 100
    # Values can't be typed into a Live Data column when adding a row, nor imported into it.
    assert kosal.command('tm.group.row.add', {'group_id': L['profit'], 'values': {linked: 5}}).status_code == 409
    # Add the source's records that have no row here yet (with their key), once.
    record(dara, L['sales'], {L['item']: 'Sugar', L['revenue']: 9})
    assert command(kosal, 'tm.group.live.rows', {'group_id': L['profit'], 'column_id': linked})['added'] == 1
    assert command(kosal, 'tm.group.live.rows', {'group_id': L['profit'], 'column_id': linked})['added'] == 0
    _, rows = read(kosal, L['profit'])
    assert sorted(r['values'].get(linked) for r in rows.values() if isinstance(r['values'].get(linked), (int, float))) == [9, 50, 100]
    # A Live Data column only from a share made to this person, never from the group itself.
    assert L['c']['chan'].command('tm.group.column.save', {'group_id': L['profit'], 'name': 'Steal', 'type': 'LINKED', 'settings': {
        'share_id': 'x', 'source_column_id': L['revenue'], 'source_key_id': L['item'], 'key_column_id': L['local_item']}}).status_code in (403, 404)


def test_only_managers_of_the_source_share_and_only_permitted_columns(live):
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    # Formulas need their inputs; a formula or people column can't be Can Edit.
    double = column(dara, L['sales'], 'Double', 'FORMULA', expression='{Revenue} * 2')
    assert dara.command('tm.group.live-share.save', {'group_id': L['sales'], 'recipient_id': L['ids']['kosal'],
                                                     'columns': [{'column_id': double, 'permission': 'VIEW'}]}).status_code == 422
    assert dara.command('tm.group.live-share.save', {'group_id': L['sales'], 'recipient_id': L['ids']['kosal'],
                                                     'columns': [{'column_id': double, 'permission': 'EDIT'}, {'column_id': L['revenue'], 'permission': 'VIEW'}]}).status_code == 422
    # Neary's role can only view Groups: Viewer is possible, Can Edit is not.
    assert dara.command('tm.group.live-share.save', {'group_id': L['sales'], 'recipient_id': L['ids']['neary'],
                                                     'columns': [{'column_id': L['revenue'], 'permission': 'EDIT'}]}).status_code == 403
    # Someone who doesn't manage the source can't share it, whatever IDs they send.
    assert kosal.command('tm.group.live-share.save', {'group_id': L['sales'], 'recipient_id': L['ids']['chan'],
                                                      'columns': [{'column_id': L['revenue'], 'permission': 'VIEW'}]}).status_code == 404
    assert kosal.get(f"/api/tasks/group/live-shares?id={L['sales']}").status_code == 404
    desc = ok(dara.get(f"/api/tasks/group/live-shares?id={L['sales']}"))
    assert {c['id'] for c in desc['columns']} >= {L['revenue'], L['item'], double}


def test_independent_copy_share_data_is_unchanged(live):
    """Share Data keeps importing an independent copy: later source changes do not reach the copy."""
    L = live
    dara, kosal = L['c']['dara'], L['c']['kosal']
    command(dara, 'tm.group.data-share.save', {'group_id': L['sales'], 'recipient_id': L['ids']['kosal'], 'column_ids': [L['item'], L['revenue']]})
    copy, copy_item = board(kosal, Board.objects.get(id=L['profit']).workspace_id, 'Copied sales')
    staged = command(kosal, 'tm.group.import.internal', {'group_id': copy, 'source_id': L['sales'], 'column_ids': [L['item'], L['revenue']],
                                                         'row_ids': [L['rice'], L['oil']]})['id']
    plan = {'mode': 'append', 'sheets': [{'index': 0, 'header_row': 1, 'columns': [{'source': 0, 'target': copy_item},
                                                                                   {'source': 1, 'new': {'name': 'Revenue', 'type': 'NUMBER'}}]}]}
    command(kosal, 'tm.group.import.commit', {'import_id': staged, 'plan': plan, 'expected': {'add': 2, 'update': 0}})
    v = BoardRow.objects.get(id=L['rice']).version
    command(dara, 'tm.group.row.update', {'group_id': L['sales'], 'id': L['rice'], 'values': {L['revenue']: 999}, 'expected_version': v})
    data, rows = read(kosal, copy)
    revenue = next(c['id'] for c in data['columns'] if c['name'] == 'Revenue')
    assert sorted(r['values'][revenue] for r in rows.values()) == [50, 100]


def test_the_mini_app_shows_and_edits_live_data_with_the_same_rules(live):
    from telegram.models import TelegramSettings
    from tests.test_telegram import TOKEN, MiniApp, launch
    L = live
    share(L, [(L['item'], 'VIEW'), (L['revenue'], 'EDIT')])
    linked = link(L)
    assert L['admin'].command('admin.telegram.save', {'expected_version': 0, 'enabled': True, 'bot_token': TOKEN}).status_code == 200
    TelegramSettings.objects.filter(id=1).update(bot_username='sunny_test_bot', status='ON')
    code = command(L['c']['kosal'], 'tg.link.code', {})['code']
    app = MiniApp(launch(5550301, 'Kosal'))
    assert app.post('/link', {'code': code}).status_code == 200
    page = app.get(f"/group-rows?id={L['profit']}").json()
    assert {r['id']: r['values'].get(linked) for r in page['rows']}[L['rows']['rice']] == 100
    r = app.post('/command', {'action': 'tm.group.row.update', 'data': {'group_id': L['profit'], 'id': L['rows']['rice'], 'values': {linked: 101}, 'expected': {linked: 100}}})
    assert r.status_code == 200, r.content
    assert json.loads(BoardRow.objects.get(id=L['rice']).values_json)[L['revenue']] == 101
    assert BoardLiveEdit.objects.filter(board_id=L['sales'], actor_id=L['ids']['kosal'], via='live').count() == 1


def test_live_data_migration_is_additive_and_reversible(live):
    """Migrating back to before Live Data and forward again keeps every existing row, share and value."""
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    L = live
    before = list(BoardRow.objects.filter(board_id__in=[L['sales'], L['profit']]).order_by('id').values('id', 'values_json', 'version'))
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes()
    targets = [('groups', '0003_presentation_sharing_delivery'), ('workspaces', '0003_workspace_managers'), ('organization', '0006_initial_revision')]
    try:
        executor.migrate(targets)
    finally:
        MigrationExecutor(connection).migrate(latest)
    assert list(BoardRow.objects.filter(board_id__in=[L['sales'], L['profit']]).order_by('id').values('id', 'values_json', 'version')) == before

"""Groups match V5.7.7: the same Group scenarios run on the original Node/SQLite service and on Django.

Every command's result or refusal (message, HTTP status and details), every read (a group, pages of rows with search,
filters and sorting, notes and their history, people lists, Excel exports read back, files) and the stored rows of all
eleven Group tables must be identical; only timestamps are masked. Covers creating and sharing groups, every column type
and formula rule, type changes, status labels, rows and conflicts, row and column access rules, notes, layouts, files in
Attachment columns, moving and deleting rows (also "all matching"), Excel import, archiving and deleting, and the
Organizational Structure rules for groups in governed and personal workspaces.
"""
import base64
import json
import re

import pytest

from tests.parity.driver import Scenario
from tests.test_parity import ADMIN, DARA, KOSAL, NEARY, PNG, SOPHEA, as_deployed, legacy_workspace, node_run, people, pytestmark as needs_node, unvolatile

pytestmark = needs_node
G = 'Stock count'
W = '${ws:Operations}'


def g(name=G):
    return f'${{group:{name}}}'


def c(col, name=G):
    return f'${{gcol:{name}:{col}}}'


def r(position, name=G):
    return f'${{grow:{name}:{position}}}'


def version(table, ref):
    return f'${{version:{table}:@{ref[2:-1]}}}'


def cmd(actor, action, **data):
    return {'as': actor, 'do': action, 'data': data}


def read(kind, actor, **data):
    return {'read': kind, 'as': actor, 'input': data}


def _at(value):
    if isinstance(value, dict):
        return {k: ('<t>' if k == 'at' and v is not None else _at(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_at(v) for v in value]
    return value


def _json_times(value):
    if isinstance(value, str):
        return re.sub(r'"((?:[a-z_]*_)?at)":"\d{4}-\d{2}-\d{2}T[^"]*"', r'"\1":"<t>"', value)
    return value


def compare(steps):
    scenario = {'steps': steps}
    expected, actual = node_run(scenario), Scenario().play(scenario)
    assert len(expected['steps']) == len(actual['steps'])
    for i, (want, got) in enumerate(zip(expected['steps'], actual['steps'])):
        want, got = unvolatile(as_deployed(_at(want))), unvolatile(_at(got))
        if want != got:
            pytest.fail(f'step {i} {json.dumps(steps[i], ensure_ascii=False)[:400]}\n V5.7.7: {json.dumps(want, ensure_ascii=False)[:3000]}\n'
                        f' Django: {json.dumps(got, ensure_ascii=False)[:3000]}')
    for table, want in expected['dump'].items():
        want = [{k: _json_times(v) for k, v in row.items()} for row in want]
        got = [{k: _json_times(v) for k, v in row.items()} for row in actual['dump'][table]]
        if want != got:
            lines = [f'{table}: V5.7.7 has {len(want)} rows, Django {len(got)}']
            for a, b in zip(want, got):
                if a != b:
                    lines += [' V5.7.7: ' + json.dumps(a, ensure_ascii=False)[:2000], ' Django: ' + json.dumps(b, ensure_ascii=False)[:2000]]
                    break
            pytest.fail('\n'.join(lines))
    return expected


def columns():
    return [
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Quantity', type='NUMBER', settings={'decimals': 0}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Unit Price', type='NUMBER', settings={'decimals': 2}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Total', type='FORMULA', settings={'expression': '={Quantity} * {Unit Price}', 'decimals': 2}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '={Missing} + 1'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '={Item} * 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': 'SUM({Quantity}'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '={Quantity} ^ 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': 'IF({Quantity})'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '=ROUND({Quantity}, 2, 3)'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '=1 + * 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '=(1 + 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '=1 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Bad', type='FORMULA', settings={'expression': '="text"'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Status', type='STATUS'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Owner', type='IN_CHARGE'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Helpers', type='SUPPORT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Due', type='DATE'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Files', type='ATTACHMENT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Notes', type='TEXT', after=c('Item')),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='quantity', type='TEXT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='{Odd}', type='TEXT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='#Odd', type='TEXT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Ratio', type='FORMULA',
            settings={'expression': '=IF({Quantity} > 1000, ROUND({Total} / {Quantity}, 3), AVERAGE({Quantity}, {Unit Price}, 7))', 'decimals': 3}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Checks', type='FORMULA',
            settings={'expression': '=SUM({Quantity}, -{Unit Price}, 0.1, 0.2) + MIN({Quantity}, {Unit Price}) - MAX({Unit Price}, 2) / 4 + ({Quantity} >= 3)'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Zero', type='FORMULA', settings={'expression': '={Quantity} / ({Unit Price} - {Unit Price})'}),
    ]


def rows():
    return [
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Rice', c('Quantity'): '1,200', c('Unit Price'): 0.1, c('Status'): 'in progress',
                                                              c('Owner'): DARA, c('Helpers'): [KOSAL, KOSAL], c('Due'): '2026-10-20',
                                                              c('Notes'): '  First line\r\nsecond line  \n'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Oil', c('Quantity'): 3, c('Unit Price'): '0.2'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), after=r(1), values={c('Item'): 'Salt', c('Unit Price'): '-1.5e2'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Quantity'): 'abc'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Due'): '2026-02-30'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Owner'): NEARY}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Status'): 'Unknown'}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Total'): 5}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Quantity'): 1e16}),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={'COL-999999': 'x'}),
        cmd(KOSAL, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Not allowed'}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Quantity'): 1250}, expected={c('Quantity'): 1200}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Quantity'): 5}, expected={c('Quantity'): 1200}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Quantity'): 5}, expected_version=0),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Quantity'): 1250}, expected={c('Quantity'): 1250}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Quantity'): 5}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(2), values={c('Notes'): 'x' * 10001}, expected={c('Notes'): ''}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(2), values={c('Notes'): 'Ground floor', c('Unit Price'): ''}, expected={c('Notes'): '', c('Unit Price'): -150}),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(3), values={c('Status'): 'L4', c('Helpers'): [], c('Owner'): SOPHEA},
            expected={c('Status'): None, c('Helpers'): None, c('Owner'): None}),
    ]


def test_groups_core_lifecycle_matches_v577(db):
    steps = people() + [legacy_workspace(), cmd(ADMIN, 'tm.workspace.save', name='Elsewhere', owner_id=ADMIN, member_ids=[ADMIN])]
    steps += [
        cmd(NEARY, 'tm.group.save', workspace_id=W, name='Viewer try'),
        cmd(DARA, 'tm.group.save', workspace_id=W, name='My list'),
        cmd(DARA, 'tm.group.save', workspace_id='${ws:Elsewhere}', name='Not mine'),
        cmd(SOPHEA, 'tm.group.save', workspace_id=W, name=G, description='Monthly count', visibility='TEAM', audience='SELECTED',
            shared=[{'staff_id': DARA, 'level': 'EDIT'}, {'staff_id': KOSAL, 'level': 'VIEW'}, {'staff_id': NEARY, 'level': 'VIEW'}]),
        cmd(SOPHEA, 'tm.group.save', workspace_id=W, name=G, description='Monthly count', visibility='TEAM', audience='SELECTED',
            shared=[{'staff_id': DARA, 'level': 'EDIT'}, {'staff_id': KOSAL, 'level': 'VIEW'}, SOPHEA]),
        cmd(KOSAL, 'tm.group.save', id=g(), expected_version=0, name='Renamed'),
        cmd(DARA, 'tm.group.save', id=g(), expected_version=0, visibility='PERSONAL'),
        cmd(SOPHEA, 'tm.group.save', id=g(), expected_version=0, name=G, description='Monthly count'),
        cmd(SOPHEA, 'tm.group.save', id=g(), expected_version=0, name=G + ' ', description='Monthly stock count'),
        cmd(SOPHEA, 'tm.group.save', id=g(), expected_version=0, name=G),
        cmd(DARA, 'tm.group.save', id=g('My list'), expected_version=0, name='My own list', description='Private'),
        read('group', KOSAL, id=g('My list')),
    ]
    steps += columns() + rows()
    steps += [
        # Formulas: loops, columns that formulas use, type changes that clear values, status labels in use.
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Total2', type='FORMULA', settings={'expression': '={Total} * 2'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Total'), expected_version=version('tm_board_columns', c('Total')), settings={'expression': '={Total2} + 1'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Quantity'), expected_version=version('tm_board_columns', c('Quantity')), type='TEXT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Notes'), expected_version=version('tm_board_columns', c('Notes')), type='NUMBER'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Notes'), expected_version=version('tm_board_columns', c('Notes')), type='NUMBER', confirm_clear=True),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Notes'), expected_version=version('tm_board_columns', c('Notes')), type='TEXT', name='Remarks'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Item'), expected_version=version('tm_board_columns', c('Item')), type='STATUS'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Item'), expected_version=version('tm_board_columns', c('Item')), type='TEXT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Owner'), expected_version=version('tm_board_columns', c('Owner')), type='SUPPORT'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Owner'), expected_version=version('tm_board_columns', c('Owner')), type='IN_CHARGE'),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Status'), expected_version=version('tm_board_columns', c('Status')),
            settings={'labels': [{'id': 'L1', 'name': 'Not Started', 'color': 'GRAY'}, {'id': 'L3', 'name': 'On Hold', 'color': 'ORANGE'},
                                 {'id': 'L4', 'name': 'Done', 'color': 'GREEN'}, {'name': 'Blocked', 'color': 'RED'}]}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Status'), expected_version=version('tm_board_columns', c('Status')),
            settings={'labels': [{'id': 'L1', 'name': 'Not Started', 'color': 'GRAY'}, {'id': 'L3', 'name': 'On Hold', 'color': 'ORANGE'},
                                 {'id': 'L4', 'name': 'Done', 'color': 'GREEN'}, {'name': 'Blocked', 'color': 'NOPE'}]}, label_replacements={'L2': 'L1'}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Status'), expected_version=version('tm_board_columns', c('Status')),
            settings={'labels': [{'name': 'Same'}, {'name': 'same'}]}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Unit Price'), expected_version=version('tm_board_columns', c('Unit Price')), settings={'decimals': 7}),
        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), id=c('Unit Price'), expected_version=version('tm_board_columns', c('Unit Price')), settings={'decimals': 3}),
        cmd(SOPHEA, 'tm.group.column.delete', group_id=g(), id=c('Quantity'), expected_version=version('tm_board_columns', c('Quantity'))),
        cmd(SOPHEA, 'tm.group.column.delete', group_id=g(), id=c('Total2'), expected_version=version('tm_board_columns', c('Total2'))),
        cmd(SOPHEA, 'tm.group.column.delete', group_id=g(), id=c('Remarks'), expected_version=version('tm_board_columns', c('Remarks'))),
        cmd(SOPHEA, 'tm.group.column.delete', group_id=g(), id=c('Remarks'), expected_version=version('tm_board_columns', c('Remarks')), confirm=True),
        cmd(DARA, 'tm.group.column.delete', group_id=g(), id=c('Zero'), expected_version=version('tm_board_columns', c('Zero'))),
        cmd(SOPHEA, 'tm.group.column.move', group_id=g(), order=[c('Item')]),
        cmd(SOPHEA, 'tm.group.column.move', group_id=g(), order=[c(x) for x in ('Status', 'Item', 'Quantity', 'Unit Price', 'Total', 'Owner', 'Helpers', 'Due',
                                                                                   'Files', 'Ratio', 'Checks', 'Zero')]),
        # Who sees which rows and columns.
        cmd(SOPHEA, 'tm.group.column.access', group_id=g(), id=c('Unit Price'), principals=[{'type': 'ROLE', 'id': 'ROLE-MANAGER'}]),
        cmd(SOPHEA, 'tm.group.row.access', group_id=g(), ids=[r(3)], principals=[{'type': 'USER', 'id': SOPHEA}, {'type': 'USER', 'id': SOPHEA}]),
        cmd(SOPHEA, 'tm.group.row.access', group_id=g(), ids=[r(2)], principals=[{'type': 'USER', 'id': NEARY}]),
        cmd(SOPHEA, 'tm.group.row.access', group_id=g(), ids=[r(2)], principals=[{'type': 'ROLE', 'id': 'ROLE-NOPE'}]),
        cmd(DARA, 'tm.group.row.access', group_id=g(), ids=[r(2)], principals=[]),
        read('group', SOPHEA, id=g()), read('group', DARA, id=g()), read('group', KOSAL, id=g()), read('group', NEARY, id=g()),
        read('group_rows', DARA, id=g(), q='ri'), read('group_rows', SOPHEA, id=g(), sort=c('Item'), dir='desc'),
        read('group_rows', SOPHEA, id=g(), sort=c('Total'), filters=json.dumps([{'col': c('Quantity'), 'min': '2'}])),
        read('group_rows', SOPHEA, id=g(), sort=c('Status'), filters=[{'col': c('Status'), 'value': ''}], offset='0', limit='1'),
        read('group_rows', SOPHEA, id=g(), filters='not json'),
        read('group_rows', SOPHEA, id=g(), filters=[{'col': c('Due'), 'from': '2026-10-01', 'to': '2026-10-31'}, {'col': c('Helpers'), 'value': KOSAL}]),
        # Notes on rows.
        cmd(DARA, 'tm.group.note.add', group_id=g(), row_id=r(1), body='Checked shelf A'),
        cmd(KOSAL, 'tm.group.note.add', group_id=g(), row_id=r(1), body='I can only read'),
        cmd(DARA, 'tm.group.note.add', group_id=g(), row_id=r(1), body='   '),
        cmd(DARA, 'tm.group.note.edit', group_id=g(), id='${gnote}', expected_version=0, body='Checked shelf A and B'),
        cmd(SOPHEA, 'tm.group.note.edit', group_id=g(), id='${gnote}', expected_version=1, body='Not my note'),
        read('group_notes', DARA, id=g(), row=r(1)), read('group_notes', DARA, id=g(), row=r(1), order='oldest', **{'from': '2026/10/01'}),
        # An impossible date (2026-13-01) made V5.7.7 fail with “Invalid time value” (500); Django answers 400 with the
        # same message as other invalid dates, so only well-formed checks are compared here.
        read('group_notes', DARA, id=g(), row=r(1), order='oldest', **{'from': '2026-10-02', 'to': '2026-10-01'}),
        read('group_history', DARA, id=g(), note='${gnote}'), read('group_history', KOSAL, id=g(), note='${gnote}'),
        cmd(SOPHEA, 'tm.group.note.delete', group_id=g(), id='${gnote}', expected_version=1),
        cmd(DARA, 'tm.group.note.delete', group_id=g(), id='${gnote}', expected_version=2),
        read('group_notes', SOPHEA, id=g(), row=r(1)),
        # Layouts: each person's own, and the default for everyone.
        cmd(DARA, 'tm.group.view.save', group_id=g(), view={'widths': {c('Item'): 250, c('Unit Price'): 90, 'nope': 10}, 'hidden_columns': [c('Due')], 'order': [c('Item')],
                                                           'hidden_rows': [r(2)], 'rownum': 500}),
        cmd(KOSAL, 'tm.group.view.save', group_id=g(), view={'widths': {c('Item'): 5}}),
        cmd(KOSAL, 'tm.group.view.save', group_id=g(), view=[]),
        cmd(SOPHEA, 'tm.group.layout.save', group_id=g(), layout={'widths': {c('Item'): 300}, 'rownum': 80, 'order': [c('Item'), c('Status')]}),
        cmd(DARA, 'tm.group.layout.save', group_id=g(), layout={'widths': {c('Item'): 300}}),
        read('group', DARA, id=g()), read('group_rows', DARA, id=g(), hidden='1'),
        cmd(KOSAL, 'tm.group.view.save', group_id=g(), reset=True),
        # Files in Attachment cells.
        cmd(DARA, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Files'), name='shelf.png', base64=PNG),
        cmd(DARA, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Files'), name='fake.pdf', base64=PNG),
        cmd(DARA, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Files'), name='run.exe', base64=PNG),
        cmd(DARA, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Item'), name='shelf.png', base64=PNG),
        cmd(KOSAL, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Files'), name='shelf.png', base64=PNG),
        read('group_file', KOSAL, id=g(), file='${gfile}'), read('group_file', NEARY, id=g(), file='${gfile}'),
        cmd(DARA, 'tm.group.file.add', group_id=g(), row_id=r(1), column_id=c('Files'), name='notes.txt', base64=base64.b64encode(b'shelf notes').decode()),
        cmd(DARA, 'tm.group.file.remove', group_id=g(), row_id=r(1), column_id=c('Files'), file_id='${gfile}'),
        cmd(DARA, 'tm.group.file.remove', group_id=g(), row_id=r(1), column_id=c('Files'), file_id='${gfile}'),
        cmd(DARA, 'tm.group.row.update', group_id=g(), id=r(1), values={c('Files'): ['FAKE']}, expected={c('Files'): None}),
        # Moving and deleting rows.
        cmd(DARA, 'tm.group.row.move', group_id=g(), id=r(1), to=1),
        cmd(DARA, 'tm.group.row.move', group_id=g(), id=r(1), to=9),
        cmd(SOPHEA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Sugar', c('Quantity'): 12}),
        cmd(SOPHEA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Sugar cane', c('Quantity'): 4}),
        cmd(DARA, 'tm.group.row.delete', group_id=g(), id=r(4), expected_version=3),
        cmd(DARA, 'tm.group.row.delete', group_id=g(), ids=[r(4), 'ROW-404'], expected={}),
    ]
    match = len(steps)
    steps += [
        read('group_rows', SOPHEA, id=g(), q='sugar'),
        cmd(SOPHEA, 'tm.group.row.delete', group_id=g(), match={'q': 'sugar'}, expected_count=3, match_key=f'${{{match}.match_key}}'),
        cmd(SOPHEA, 'tm.group.row.delete', group_id=g(), match={'q': 'sugar'}, expected_count=2, match_key='stale'),
        cmd(SOPHEA, 'tm.group.row.delete', group_id=g(), match={'q': 'sugar'}, expected_count=2, match_key=f'${{{match}.match_key}}'),
        read('group_members', DARA, id=g(), q='ko'), read('group_members', KOSAL, id=g(), offset='1', limit='1'),
        read('group_audience', SOPHEA, id=g()), read('group_audience', DARA, id=g()),
        read('group_xlsx', SOPHEA, id=g()), read('group_xlsx', DARA, id=g(), scope='selected', ids=r(1)), read('group_xlsx', KOSAL, id=g(), scope='selected', ids=''),
        read('group_xlsx', SOPHEA, id=g(), scope='filtered', q='rice', columns='view'),
        # Archiving, restoring and deleting.
        cmd(DARA, 'tm.group.archive', id=g(), expected_version=version('tm_boards', g()), status='ARCHIVED'),
        cmd(SOPHEA, 'tm.group.delete', id=g(), expected_version=version('tm_boards', g()), confirm=True),
        cmd(SOPHEA, 'tm.group.archive', id=g(), expected_version=version('tm_boards', g()), status='ARCHIVED'),
        cmd(SOPHEA, 'tm.group.archive', id=g(), expected_version=version('tm_boards', g()), status='ARCHIVED'),
        cmd(DARA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Too late'}),
        read('group', DARA, id=g()),
        cmd(SOPHEA, 'tm.group.delete', id=g(), expected_version=version('tm_boards', g())),
        cmd(SOPHEA, 'tm.group.archive', id=g(), expected_version=version('tm_boards', g()), status='ACTIVE'),
        read('state', SOPHEA), read('state', DARA), read('state', KOSAL), read('state', NEARY),
        cmd(SOPHEA, 'tm.group.archive', id=g(), expected_version=version('tm_boards', g()), status='ARCHIVED'),
        cmd(SOPHEA, 'tm.group.delete', id=g(), expected_version=version('tm_boards', g()), confirm=True),
        read('group', SOPHEA, id='GRP-000002'),
        cmd(SOPHEA, 'tm.workspace.archive', id=W, expected_version=version('tm_workspaces', W), status='ARCHIVED'),
        cmd(DARA, 'tm.group.save', id=g('My own list'), expected_version=version('tm_boards', g('My own list')), name='Archived workspace'),
        read('state', DARA),
    ]
    compare(steps)


def workbook():
    from groups.xlsx import write_xlsx
    sheet = {'name': 'Count', 'columns': [{'header': 'Item', 'type': 'text'}, {'header': 'Quantity', 'type': 'number', 'decimals': 0},
                                          {'header': 'Arrival', 'type': 'date'}, {'header': 'Stage', 'type': 'text'}, {'header': 'Owner', 'type': 'text'},
                                          {'header': 'Code', 'type': 'text'}],
             'rows': [['Rice', 1200, '2026-10-05', 'Open', 'Dara Member', '007'], ['Oil', 3, None, 'Closed', 'kosal member', '010'],
                      ['', None, None, None, None, None], ['Salt', 'many', '05/10/2026', 'Open', 'Nobody Here', '011'],
                      ['Beans', 4.5, None, 'Open', 'Sophea Manager', '=1+1'], ['Rice', 5, None, None, None, None]]}
    second = {'name': 'Second', 'columns': [{'header': 'Item', 'type': 'text'}, {'header': 'Item', 'type': 'text'}], 'rows': [['Tea', 'x']]}
    return base64.b64encode(write_xlsx([sheet, second])).decode()


def test_groups_excel_import_matches_v577(db):
    data = workbook()
    steps = people() + [legacy_workspace(),
                        cmd(SOPHEA, 'tm.group.save', workspace_id=W, name=G, visibility='TEAM', audience='WORKSPACE', workspace_level='EDIT'),
                        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Quantity', type='NUMBER'),
                        cmd(SOPHEA, 'tm.group.column.save', group_id=g(), name='Owner', type='IN_CHARGE'),
                        cmd(SOPHEA, 'tm.group.row.add', group_id=g(), values={c('Item'): 'Rice', c('Quantity'): 1})]
    plan = {'sheets': [{'index': 0, 'header_row': 1, 'columns': [
        {'source': 0, 'target': c('Item')}, {'source': 1, 'target': c('Quantity')}, {'source': 2, 'new': {'name': 'Arrival', 'type': 'DATE'}},
        {'source': 3, 'new': {'name': 'Stage', 'type': 'STATUS'}}, {'source': 4, 'target': c('Owner')}, {'source': 5, 'new': {'name': 'Code', 'type': 'TEXT'}}]}],
        'mode': 'append'}
    steps += [
        cmd(DARA, 'tm.group.import.upload', group_id=g(), name='count.xls', base64=data),
        cmd(DARA, 'tm.group.import.upload', group_id=g(), name='count.xlsx', base64='not base64!'),
        cmd(DARA, 'tm.group.import.upload', group_id=g(), name='count.xlsx', base64=base64.b64encode(b'not a zip file at all, really').decode()),
        cmd(DARA, 'tm.group.import.upload', group_id=g(), name='C:\\Users\\dara\\count.xlsx', base64=data),
        read('group_import', DARA, id=g(), **{'import': '${gimport}'}), read('group_import', SOPHEA, id=g(), **{'import': '${gimport}'}),
        read('group_preview', DARA, import_id='${gimport}', plan=plan),
        cmd(SOPHEA, 'tm.group.import.upload', group_id=g(), name='count.xlsx', base64=data),
    ]
    preview = len(steps)
    steps += [
        read('group_preview', SOPHEA, import_id='${gimport}', plan=plan),
        read('group_preview', SOPHEA, import_id='${gimport}', plan={**plan, 'people': {'Nobody Here': SOPHEA}}),
        read('group_preview', SOPHEA, import_id='${gimport}', plan={'sheets': [{'index': 1, 'columns': [{'source': 0, 'target': c('Item')}, {'source': 0, 'target': c('Quantity')}]}]}),
        read('group_preview', SOPHEA, import_id='${gimport}', plan={'sheets': [{'index': 5}]}),
        read('group_preview', SOPHEA, import_id='${gimport}', plan={'sheets': [{'index': 0, 'header_row': 0, 'columns': []}]}),
        read('group_preview', SOPHEA, import_id='${gimport}', plan={**plan, 'sheets': [{**plan['sheets'][0], 'rows': {'from': 2, 'to': 3}}]}),
        cmd(SOPHEA, 'tm.group.import.commit', import_id='${gimport}', plan=plan, expected={'add': 0, 'update': 0}),
        cmd(SOPHEA, 'tm.group.import.commit', import_id='${gimport}', plan=plan, expected={'add': f'${{{preview}.totals.add}}', 'update': 0}),
        cmd(SOPHEA, 'tm.group.import.commit', import_id='${gimport}', plan=plan, expected={'add': f'${{{preview}.totals.add}}', 'update': 0}),
        read('group_rows', SOPHEA, id=g(), limit='50'),
        cmd(SOPHEA, 'tm.group.import.upload', group_id=g(), name='count.xlsx', base64=data),
    ]
    update_plan = {'sheets': [{'index': 0, 'columns': [{'source': 0, 'target': c('Item')}, {'source': 1, 'target': c('Quantity')},
                                                          {'source': 3, 'target': c('Stage')}]}], 'mode': 'update', 'unmatched': 'skip',
                   'key': {'source': 0}, 'create_labels': True}
    second = len(steps)
    steps += [
        read('group_preview', SOPHEA, import_id='${gimport}', plan=update_plan),
        cmd(SOPHEA, 'tm.group.import.commit', import_id='${gimport}', plan=update_plan,
            expected={'add': f'${{{second}.totals.add}}', 'update': f'${{{second}.totals.update}}'}),
        cmd(SOPHEA, 'tm.group.import.commit', import_id='${gimport}', plan=update_plan, confirm_update=True,
            expected={'add': f'${{{second}.totals.add}}', 'update': f'${{{second}.totals.update}}'}),
        read('group', SOPHEA, id=g()),
    ]
    compare(steps)


def test_groups_in_governed_workspaces_match_v577(db):
    from tests.test_organization_parity import A, B, C, X, Y, people as org_people, structure, workspace
    steps = org_people() + [
        {'as': A, 'do': 'org.initialize', 'data': {'level1_ids': [A], 'expected_revision': '${orgrev}', 'reason': 'Start'}},
        structure([(B, 2, A), (C, 3, B), (X, 2, A), (Y, 3, X)]),
        workspace(B, 'Workspace B Operations'), workspace(C, 'C personal', kind='PERSONAL'), workspace(X, 'Workspace X Separate branch'),
        cmd(B, 'tm.group.save', workspace_id='${ws:Workspace B Operations}', name='Branch plan', visibility='TEAM', audience='WORKSPACE', workspace_level='VIEW'),
        cmd(C, 'tm.group.save', workspace_id='${ws:Workspace B Operations}', name='C in B'),
        cmd(C, 'tm.group.save', workspace_id='${ws:C personal}', name='C private', visibility='TEAM', audience='WORKSPACE'),
        cmd(X, 'tm.group.save', workspace_id='${ws:Workspace B Operations}', name='X intrudes'),
        cmd(B, 'tm.group.row.add', group_id='${group:Branch plan}', values={}),
    ]
    for who in (A, B, C, X, Y):
        steps += [read('group', who, id='${group:Branch plan}'), read('group', who, id='${group:C private}'), read('state', who)]
    steps += [
        cmd(A, 'tm.group.save', id='${group:Branch plan}', expected_version=0, name='Branch plan (reviewed)'),
        cmd(A, 'tm.group.archive', id='${group:Branch plan (reviewed)}', expected_version=1, status='ARCHIVED'),
        cmd(B, 'tm.group.archive', id='${group:Branch plan (reviewed)}', expected_version=2, status='ACTIVE'),
        cmd(C, 'tm.group.row.add', group_id='${group:C private}', values={}),
    ]
    compare(steps)

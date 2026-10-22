"""Validated presentation settings; never change a stored numeric value."""
from core.i18n import msg as _message
import re
from core.errors import fail
from core.validation import choice
from . import domain as dm
from .models import BoardCellStyle, BoardRow
from . import js

FORMATS = ['GENERAL', 'USD', 'KHR', 'PERCENT', 'CUSTOM']


def number_settings(given, previous):
    out = {}
    for key, default in [('format', 'GENERAL'), ('prefix', ''), ('suffix', ''), ('grouping', True)]:
        value = given.get(key, previous.get(key, default))
        if key == 'format':
            value = choice(value, FORMATS, _message('number format'))
        elif key == 'grouping':
            if not isinstance(value, bool):
                fail(_message('Choose whether to show thousands separators.'))
        else:
            if not isinstance(value, str) or js.length(value) > 12:
                fail(_message('Use a symbol of at most 12 characters.'))
            if any(ord(c) < 32 or ord(c) == 127 for c in value):
                fail(_message('Use printable characters for the number symbol.'))
        # Legacy column settings stay byte-for-byte equivalent until a format is actually configured.
        if key in given or key in previous:
            out[key] = value
    return out


def display_number(value, settings):
    decimals = settings.get('decimals')
    fmt = settings.get('format', 'GENERAL')
    if decimals is None and fmt in ('USD', 'KHR'):
        decimals = 2 if fmt == 'USD' else 0
    shown = dm.format_result(value, decimals)
    if not js.is_number(value) or not shown:
        return shown
    if settings.get('grouping') is False:
        shown = shown.replace(',', '')
    # Percentage is explicitly display-only: 25 -> 25%, never 2500% or 0.25.
    prefix = '$' if fmt == 'USD' else '៛' if fmt == 'KHR' else settings.get('prefix', '') if fmt == 'CUSTOM' else ''
    suffix = '%' if fmt == 'PERCENT' else settings.get('suffix', '') if fmt == 'CUSTOM' else ''
    return prefix + shown + suffix


def style_cell(g, data, actor):
    b, caps = g.open_board(data.get('group_id'), actor)
    g.archived_check(b)
    g.need(caps, 'editRows', _message('Editing cell formatting requires record-edit access.'))
    sight = g.sight(b, actor, caps)
    record = g.fresh_row(data.get('row_id'))
    column = data.get('column_id')
    if not record or record['board_id'] != b['id'] or not sight['rowOk'](record['id']) or column not in sight['colIds']:
        fail(_message('Cell not found.'), 404)
    g.tasks.check_version(record, data.get('expected_version'))
    style = data.get('style')
    if not isinstance(style, dict) or set(style) - {'text_color', 'background_color'}:
        fail(_message('Choose text and background colors.'))
    colors = {}
    for key in ('text_color', 'background_color'):
        color = style.get(key) or ''
        if not isinstance(color, str) or (color and not re.fullmatch(r'#[0-9a-fA-F]{6}', color)):
            fail(_message('Use a six-digit color such as #037749.'))
        colors[key] = color.upper()
    query = BoardCellStyle.objects.filter(row_id=record['id'], column_id=column)
    if any(colors.values()):
        BoardCellStyle.objects.update_or_create(row_id=record['id'], column_id=column,
            defaults={**colors, 'board_id': b['id'], 'updated_by_id': actor, 'updated_at': g.now()})
    else:
        query.delete()
    BoardRow.objects.filter(id=record['id']).update(version=record['version'] + 1, updated_by_id=actor, updated_at=g.now())
    g.touch(b)
    g.record(actor, b, _message('Cell formatting changed'), f"{record['id']} · {column}")
    return {'message': _message('Cell formatting saved.'), 'row': g.row_out(g.fresh_row(record['id']), sight, dm.prepare_formulas(sight['all']))}

"""Groups · Import data from Excel — group-import.mjs (V5.7.7).

A workbook is uploaded once (and read safely, see groups.xlsx); the person then chooses the worksheets, the header row
of each, the rows and columns to import and where each column goes (an existing column or a new one). The server checks
everything and shows what will happen (rows added, updated, skipped and the exact problems) before anything is saved;
importing then saves it all in one transaction. Importing the same upload twice never adds the rows twice.

Values: dates (Excel dates or written dates such as 2026-10-05 or 05/10/2026, day first), numbers, text (leading zeros
kept), status labels by name, and people by staff ID, email or a name that matches exactly one person who can be chosen.
Excel formulas are never calculated: their saved results are imported.
"""
import re
from datetime import timedelta

from django.db.models import Max, Sum
from django.db.models.functions import Length
from django.utils import timezone

from accounts.models import User
from core.errors import InputError, fail
from core.rows import insert, row, update
from core.services import next_id
from core.validation import iso, text
from organization.models import Profile

from . import domain as dm
from . import js
from .models import BoardImport, BoardRow
from .xlsx import READ_LIMITS, XlsxError, col_name, read_xlsx, serial_to_day

IMPORTABLE = ['TEXT', 'NUMBER', 'DATE', 'STATUS', 'IN_CHARGE', 'SUPPORT']
MONTHS = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12}
COLORS = ['GRAY', 'BLUE', 'GREEN', 'ORANGE', 'RED', 'PURPLE', 'TEAL', 'PINK', 'YELLOW']
L = dm.GROUP_LIMITS
_BASE64 = re.compile(r'^[A-Za-z0-9+/]*={0,2}$')


def _ymd(y, m, d):
    s = f'{int(y)}-{int(m):02d}-{int(d):02d}'
    return s if dm.parse_day(s)['ok'] else None


def text_date(value):
    """A written date as YYYY-MM-DD (day first for 05/10/2026, as in Cambodia), or None."""
    s = js.trim(js.to_js_string(value) if value is not None else '')
    if not s:
        return None
    m = re.match(r'^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})(?:[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?$', s)
    if m:
        return _ymd(m.group(1), m.group(2), m.group(3))
    m = re.match(r'^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{4})(?:[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?$', s)
    if m:
        return _ymd(m.group(3), m.group(2), m.group(1))
    m = re.match(r'^([0-9]{1,2})[ -]([A-Za-z]{3,9})\.?[ -,]*([0-9]{4})$', s)
    if m:
        month = MONTHS.get(m.group(2)[:4].lower()) or MONTHS.get(m.group(2)[:3].lower())
        if month:
            return _ymd(m.group(3), month, m.group(1))
    m = re.match(r'^([A-Za-z]{3,9})\.? ([0-9]{1,2}),? ([0-9]{4})$', s)
    if m and MONTHS.get(m.group(1)[:3].lower()):
        return _ymd(m.group(3), MONTHS[m.group(1)[:3].lower()], m.group(2))
    return None


def cell_display(cell):
    """How a cell reads as text (for headers, previews and text columns)."""
    if not cell:
        return ''
    if cell.get('error'):
        return cell['error']
    if cell.get('missing'):
        return ''
    if cell.get('date'):
        return cell['date']
    v = cell.get('v')
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if js.is_number(v):
        return js.num_str(dm.tidy(v))
    return '' if v is None else js.to_js_string(v)


def _is_int(v):
    return js.is_number(v) and v == v and float(v).is_integer()


class GroupImport:
    def __init__(self, groups):
        self.g = groups

    def load(self, key, staff):
        imp = BoardImport.objects.filter(id=js.to_js_string(key or '')).first()
        if not imp or imp.staff_id != staff:
            fail('This upload was not found. Upload the file again.', 404)
        return row(imp)

    @staticmethod
    def headers_of(sheet, header_row):
        cells = sheet['rows'][header_row - 1] if 0 <= header_row - 1 < len(sheet['rows']) else []
        width, seen, out = max(sheet['columns'], len(cells)), {}, []
        for i in range(width):
            raw = dm.clean_name(cell_display(cells[i] if i < len(cells) else None))
            name = js.trim(re.sub(r'^[#=]+', '', raw.replace('{', '').replace('}', ''))[:L['name']]) or f'Column {col_name(i)}'
            k = dm.name_key(name)
            n = seen.get(k, 0) + 1
            seen[k] = n
            if n > 1:
                name = f"{name[:L['name'] - 5]} ({n})"
            out.append(name)
        return out

    @staticmethod
    def summary(imp, sheets):
        return {'id': imp['id'], 'file_name': imp['file_name'], 'file_size': imp['file_size'], 'status': imp['status'],
                'result': js.loads(imp['result_json'], None),
                'sheets': [{'index': i, 'name': s['name'], 'hidden': s['hidden'], 'truncated': s['truncated'],
                            'formulas_without_results': s['formulas_without_results'], 'rows': len(s['rows']),
                            'filled_rows': sum(1 for r in s['rows'] if any(x and cell_display(x) != '' for x in r)), 'columns': s['columns'],
                            'preview': [[cell_display(r[j] if j < len(r) else None)[:60] for j in range(min(s['columns'], 200))] for r in s['rows'][:15]]}
                           for i, s in enumerate(sheets)]}

    # ------------------------------------------------------------ upload
    def upload(self, d, actor):
        b, caps = self.g.open_board(d.get('group_id'), actor)
        self.g.archived_check(b)
        self.g.need(caps, 'import', 'Importing needs “Can edit records” access to this group and a role that can add records.')
        name = text(d.get('name'), 'File name', 200, True).replace('\\', '/').split('/')[-1]
        if re.search(r'\.(xls|xlsb|xlsm|csv|ods|numbers)$', name, re.IGNORECASE):
            fail(f'“{name}” is not an Excel workbook (.xlsx). Open it in Excel (or another spreadsheet program) and save it as “Excel Workbook (*.xlsx)”.', 415)
        if not re.search(r'\.xlsx$', name, re.IGNORECASE):
            fail('Choose an Excel workbook (.xlsx).', 415)
        too_big = f"Choose an .xlsx file of up to {L['importBytes'] // 1048576} MB."
        data = d.get('base64')
        if not isinstance(data, str) or not data or len(data) > -(-L['importBytes'] * 4 // 3) + 8 or not _BASE64.match(data):
            fail(too_big, 413)
        try:
            buf = self.g.tasks.decode(data, L['importBytes'], too_big)
        except InputError:
            fail(too_big, 413)
        try:
            sheets = read_xlsx(buf)
        except XlsxError as e:
            fail(str(e), 422)
        # Uploads are kept for two days (an imported one keeps its result, so a repeated import is recognised).
        BoardImport.objects.filter(created_at__lt=timezone.now() - timedelta(days=2)).delete()
        key = next_id('tm-board-import', 'IMP')
        insert(BoardImport, {'id': key, 'board_id': b['id'], 'staff_id': actor, 'file_name': name, 'file_size': len(buf), 'sheets_json': js.dumps(sheets),
                             'status': 'UPLOADED', 'result_json': None, 'created_at': timezone.now(), 'imported_at': None})
        imp = row(BoardImport.objects.get(id=key))
        n = len(sheets)
        return {'id': key, 'type': 'tm_group_import', 'message': f"{name} is ready: {n} worksheet{'' if n == 1 else 's'}.", 'import': self.summary(imp, sheets)}

    def describe(self, key, staff):
        imp = self.load(key, staff)
        self.g.open_board(imp['board_id'], staff)
        return self.summary(imp, js.loads(imp['sheets_json'], []))

    # ------------------------------------------------------------ the plan: what would happen (nothing is saved)
    def people(self, b):
        found = self.g.eligible(b)
        by_id, by_name, by_email = {p['id']: p for p in found}, {}, {}
        for p in found:
            by_name.setdefault(dm.name_key(p['name']), []).append(p)
        emails = {(s, (e or '').lower()) for s, e in Profile.objects.exclude(email='').values_list('staff_id', 'email')}
        emails |= {(s, (e or '').lower()) for s, e in User.objects.values_list('staff_id', 'email')}
        for staff, email in sorted(emails):
            if staff in by_id and email and email not in by_email:
                by_email[email] = staff
        return {'byId': by_id, 'byName': by_name, 'byEmail': by_email}

    @staticmethod
    def person(value, crowd, resolved):
        pick = resolved.get(value) if resolved.get(value) is not None else resolved.get(dm.name_key(value))
        if isinstance(pick, str) and pick in crowd['byId']:
            return {'id': pick}
        if value in crowd['byId']:
            return {'id': value}
        email = crowd['byEmail'].get(value.lower())
        if email:
            return {'id': email}
        named = crowd['byName'].get(dm.name_key(value)) or []
        if len(named) == 1:
            return {'id': named[0]['id']}
        if len(named) > 1:
            return {'candidates': [{'id': p['id'], 'name': p['name'], 'department': p['department'] or ''} for p in named]}
        return {}

    def convert(self, col, cell, value, ctx):
        """One cell converted for one column (the group's own checks run again when the rows are saved)."""
        t = col['type']
        if t == 'TEXT':
            if js.length(value) > L['text']:
                return {'error': f"Longer than {js.locale(L['text'])} characters."}
            return {'value': value}
        if t == 'NUMBER':
            if cell.get('date'):
                return {'error': 'This is a date, not a number.'}
            if isinstance(cell.get('v'), bool):
                return {'error': 'This is TRUE/FALSE, not a number.'}
            r = dm.parse_number(cell['v'] if js.is_number(cell.get('v')) else value)
            return {'value': r['value']} if r['ok'] else {'error': 'Not a number. Use digits, an optional minus sign and a decimal point.'}
        if t == 'DATE':
            if cell.get('date'):
                return {'value': cell['date']}
            v = cell.get('v')
            if js.is_number(v):
                day = serial_to_day(v)
                return {'value': day} if day and 1 <= v < 2958466 else {'error': 'Not a date.'}
            day = text_date(value)
            return {'value': day} if day else {'error': 'Not a date. Use a date such as 2026-10-05 or 05/10/2026 (day first).'}
        if t == 'STATUS':
            name = dm.clean_name(value)
            if not name:
                return {'value': None}
            if js.length(name) > L['label']:
                return {'error': f"Status labels can have at most {L['label']} characters."}
            if col['id'].startswith('new:'):
                if dm.name_key(name) not in col['labels']:
                    if len(col['labels']) >= L['labels']:
                        return {'error': f"A status column can have up to {L['labels']} labels."}
                    col['labels'][dm.name_key(name)] = name
                return {'value': name}
            found = next((l for l in dm.status_labels(col) if dm.name_key(l['name']) == dm.name_key(name)), None)
            if found:
                return {'value': found['id']}
            if not ctx['createLabels']:
                return {'error': f"“{name}” isn’t one of this column’s labels ({', '.join(l['name'] for l in dm.status_labels(col))}). "
                                 'Choose “add missing labels” or correct the file.'}
            adds = ctx['labelAdds'].setdefault(col['id'], {})
            if len(dm.status_labels(col)) + len(adds) >= L['labels'] and dm.name_key(name) not in adds:
                return {'error': f"A status column can have up to {L['labels']} labels."}
            adds[dm.name_key(name)] = name
            return {'value': f'label:{name}'}
        if t in ('IN_CHARGE', 'SUPPORT'):
            parts = [js.trim(x) for x in re.split(r'[;,\n]', value) if js.trim(x)] if t == 'SUPPORT' else [js.trim(value)]
            if t == 'SUPPORT' and len(parts) > L['people']:
                return {'error': f"Up to {L['people']} people."}
            ids = []
            for part in parts:
                r = self.person(part, ctx['crowd'], ctx['resolved'])
                if r.get('id'):
                    ids.append(r['id'])
                    continue
                if r.get('candidates'):
                    k = dm.name_key(part)
                    if k not in ctx['unresolved']:
                        ctx['unresolved'][k] = {'text': part, 'candidates': r['candidates']}
                    return {'error': f'More than one person is called “{part}”. Choose who is meant.'}
                return {'error': f'Nobody who can be chosen in this group matches “{part}”. Use their name, Task Controlling Management email or staff ID.'}
            return {'value': list(dict.fromkeys(ids)) if t == 'SUPPORT' else (ids[0] if ids else None)}
        return {'error': f"{dm.COLUMN_TYPES.get(t) or t} columns can’t be imported into."}

    def evaluate(self, b, actor, caps, imp, plan, real=None):
        g = self.g
        if not isinstance(plan, dict) or not isinstance(plan.get('sheets'), list) or not plan['sheets']:
            fail('Choose at least one worksheet to import.')
        sheets = js.loads(imp['sheets_json'], [])
        # The plan is checked for size and permission before any work on it: each worksheet at most once, no more columns
        # than a worksheet can have, and new columns only for people who manage the group.
        chosen = set()
        for sh in plan['sheets']:
            i = js.num_str(js.number(sh.get('index') if isinstance(sh, dict) else None))
            if i in chosen:
                fail('Choose each worksheet once.')
            chosen.add(i)
            if isinstance(sh, dict) and 'columns' in sh and (not isinstance(sh['columns'], list) or len(sh['columns']) > READ_LIMITS['columns']):
                fail(f"Choose up to {READ_LIMITS['columns']} columns for each worksheet.")

        def mappings(sh):
            return sh['columns'] if isinstance(sh, dict) and isinstance(sh.get('columns'), list) else []

        def new_of(m):
            return m['new'] if isinstance(m.get('new'), dict) else {}
        wanted = [m for sh in plan['sheets'] for m in mappings(sh) if isinstance(m, dict) and m.get('new') and not m.get('skip')]
        if wanted and not caps['structure']:
            fail('Creating columns needs “Can manage” access to this group. Map every column to an existing one, or ask the group’s owner.', 403)
        if len({dm.name_key(dm.clean_name(new_of(m).get('name') if isinstance(new_of(m).get('name'), str) else '')) for m in wanted}) > L['columns']:
            fail(f"A group can have up to {L['columns']} columns.", 409)
        s = g.sight(b, actor, caps, real if real is not None else g.columns_of(b['id']))
        visible = s['columns']
        mode = 'update' if plan.get('mode') == 'update' else 'append'
        unmatched = 'skip' if plan.get('unmatched') == 'skip' else 'add'
        resolved = plan['people'] if isinstance(plan.get('people'), dict) else {}
        ctx = {'crowd': self.people(b), 'resolved': resolved, 'unresolved': {}, 'labelAdds': {}, 'createLabels': plan.get('create_labels') is True}
        # New columns proposed by any sheet, by name (the same name in two sheets is one new column).
        proposed = {}
        for sh in plan['sheets']:
            for m in mappings(sh):
                if not (isinstance(m, dict) and m.get('new') and not m.get('skip')):
                    continue
                name, col_type = dm.clean_name(new_of(m).get('name')), new_of(m).get('type')
                if col_type not in IMPORTABLE:
                    fail(f"Choose a type for the new column “{name or '(no name)'}”: Text, Number, Date, Status, In Charge or Support.")
                k = dm.name_key(name)
                others = [{'id': x['id'], 'name': x['name']} for x in proposed.values() if dm.name_key(x['name']) != k]
                error = dm.column_name_error(name, [*s['all'], *others])
                if error and not (k in proposed and proposed[k]['type'] == col_type):
                    fail(f'New column “{name}”: {error}', 409)
                if k in proposed and proposed[k]['type'] != col_type:
                    fail(f'Two worksheets create a column named “{name}” with different types. Use one type, or different names.', 409)
                if k not in proposed:
                    proposed[k] = {'id': f'new:{len(proposed)}', 'name': name, 'type': col_type, 'settings': {}, 'labels': {}}
        if proposed and not caps['structure']:
            fail('Creating columns needs “Can manage” access to this group. Map every column to an existing one, or ask the group’s owner.', 403)
        if len(visible) + len(proposed) > L['columns']:
            fail(f"A group can have up to {L['columns']} columns; this import would make {len(visible) + len(proposed)}.", 409)
        results, ops = [], []
        rows_total = BoardRow.objects.filter(board_id=b['id']).count()
        key_index = {}

        def key_rows(col):
            if col['id'] not in key_index:
                found = {}
                for r in g.rows_of(b['id']):
                    if not s['rowOk'](r['id']):
                        continue
                    k = js.trim(dm.cell_text(col, r['values'].get(col['id']), g.name_of))
                    if k:
                        found.setdefault(k, []).append(r)
                key_index[col['id']] = found
            return key_index[col['id']]

        def display(values, cols):
            out = {}
            for p in cols:
                col = p['col']
                if col['id'] not in values:
                    continue
                v = values[col['id']]
                if col['id'].startswith('new:'):
                    if isinstance(v, list):
                        shown = ', '.join(g.name_of(x) for x in v)
                    elif col['type'] == 'IN_CHARGE':
                        shown = g.name_of(v)
                    elif col['type'] == 'STATUS':
                        shown = col['labels'].get(v) or v
                    else:
                        shown = v
                    out[col['name']] = js.to_js_string(shown)
                else:
                    out[col['name']] = dm.cell_text(col, v, g.name_of)[:80] or js.to_js_string(v)[:80]
            return out
        for sh in plan['sheets']:
            sh = sh if isinstance(sh, dict) else {}
            index = js.number(sh.get('index'))
            if not _is_int(index) or not 0 <= index < len(sheets):
                fail('A chosen worksheet is not in this file. Upload it again.')
            index = int(index)
            sheet = sheets[index]
            header_row = 1 if 'header_row' not in sh else js.number(sh['header_row'])
            top = max(1, len(sheet['rows']))
            if not _is_int(header_row) or header_row < 1 or header_row > top:
                fail(f"“{sheet['name']}”: choose a header row between 1 and {top}.")
            header_row = int(header_row)
            header = self.headers_of(sheet, header_row)
            maps = [m for m in mappings(sh) if isinstance(m, dict) and not m.get('skip') and (m.get('target') or m.get('new'))]
            if not maps:
                fail(f"“{sheet['name']}”: choose at least one column to import.")
            used_source, used_target, cols = set(), set(), []
            for m in maps:
                source = js.number(m.get('source'))
                if not _is_int(source) or source < 0 or source >= max(len(header), 1):
                    fail(f"“{sheet['name']}”: a chosen column is not in the worksheet.")
                source = int(source)
                heading = header[source] if source < len(header) else 'undefined'
                if source in used_source:
                    fail(f"“{sheet['name']}”: the column “{heading}” is chosen twice.")
                used_source.add(source)
                if m.get('new'):
                    col = proposed.get(dm.name_key(dm.clean_name(new_of(m).get('name'))))
                else:
                    col = next((x for x in visible if x['id'] == js.to_js_string(m.get('target'))), None)
                    if not col:
                        fail(f"“{sheet['name']}”: the column chosen for “{heading}” no longer exists or is not available to you. Choose again.", 409)
                    if col['type'] == 'FORMULA':
                        fail(f"“{col['name']}” is a formula column: the group calculates it, so nothing can be imported into it.", 409)
                    if col['type'] == 'ATTACHMENT':
                        fail(f"“{col['name']}” is an attachment column: upload its files in the table instead.", 409)
                if col['id'] in used_target:
                    fail(f"“{sheet['name']}”: two columns go into “{col['name']}”. Choose one.")
                used_target.add(col['id'])
                cols.append({'source': source, 'col': col, 'header': heading})
            # Which rows.
            first, last = header_row + 1, len(sheet['rows'])
            numbers = []
            if isinstance(sh.get('rows'), list):
                numbers = sorted({int(n) for n in (js.number(x) for x in sh['rows']) if _is_int(n) and first <= n <= last})
                if not numbers:
                    fail(f"“{sheet['name']}”: choose rows after the header row.")
            elif isinstance(sh.get('rows'), dict):
                lo, hi = js.number(sh['rows'].get('from')), js.number(sh['rows'].get('to'))
                lo = max(first, lo if js.is_number(lo) and lo == lo and lo else first)
                hi = min(last, hi if js.is_number(hi) and hi == hi and hi else last)
                n = lo
                while n <= hi:
                    numbers.append(n)
                    n += 1
            else:
                numbers = list(range(first, last + 1))
            key = None
            if mode == 'update':
                k = sh['key'] if isinstance(sh.get('key'), dict) else plan.get('key') if isinstance(plan.get('key'), dict) else {}
                kp = next((p for p in cols if p['source'] == js.number(k.get('source'))), None)
                if not kp or kp['col']['id'].startswith('new:') or kp['col']['type'] not in ('TEXT', 'NUMBER', 'DATE'):
                    fail(f"“{sheet['name']}”: to update rows, choose a key column that identifies each row (an existing Text, Number or Date column, "
                         'for example an order number).')
                key = kp
            res = {'index': index, 'name': sheet['name'], 'header': header, 'header_row': header_row, 'selected': len(numbers), 'add': 0, 'update': 0,
                   'skipped_blank': 0, 'skipped_unmatched': 0, 'failed': 0, 'errors': [], 'warnings': [], 'sample': []}
            seen_keys = set()
            for n in numbers:
                cells = sheet['rows'][int(n) - 1] if float(n).is_integer() and 0 <= n - 1 < len(sheet['rows']) else []
                values, problems, filled = {}, [], False
                for p in cols:
                    cell = cells[p['source']] if p['source'] < len(cells) else None
                    if not cell:
                        continue
                    if cell.get('missing'):
                        res['warnings'].append({'row': n, 'column': p['header'],
                                                'message': 'This formula has no saved result, so it was left empty. Open and save the file in Excel, then upload it again.'})
                        continue
                    if cell.get('error'):
                        res['warnings'].append({'row': n, 'column': p['header'], 'message': f"Excel shows the error {cell['error']} here, so it was left empty."})
                        continue
                    shown = cell_display(cell)
                    if shown == '':
                        continue
                    filled = True
                    v = self.convert(p['col'], cell, shown, ctx)
                    if 'error' in v:
                        problems.append({'row': n, 'column': p['header'], 'value': shown[:80], 'message': v['error']})
                    elif not dm.empty_value(v['value']):
                        values[p['col']['id']] = v['value']
                if not filled:
                    res['skipped_blank'] += 1
                    continue
                if problems:
                    res['failed'] += 1
                    if len(res['errors']) < 300:
                        res['errors'].extend(problems[:3])
                    continue
                existing = None
                if key:
                    kc = key['col']
                    k = js.trim(dm.cell_text(kc, values[kc['id']], g.name_of)) if kc['id'] in values else ''
                    if not k:
                        res['failed'] += 1
                        if len(res['errors']) < 300:
                            res['errors'].append({'row': n, 'column': key['header'], 'value': '', 'message': 'The key is empty, so this row can’t be matched.'})
                        continue
                    if k in seen_keys:
                        res['failed'] += 1
                        if len(res['errors']) < 300:
                            res['errors'].append({'row': n, 'column': key['header'], 'value': k,
                                                  'message': 'This key appears more than once in the file; only its first row is used.'})
                        continue
                    seen_keys.add(k)
                    found = key_rows(kc).get(k) or []
                    if len(found) > 1:
                        res['failed'] += 1
                        if len(res['errors']) < 300:
                            res['errors'].append({'row': n, 'column': key['header'], 'value': k,
                                                  'message': f'{len(found)} rows in the group have this key, so it is not clear which one to update.'})
                        continue
                    existing = found[0] if found else None
                    if not existing and unmatched == 'skip':
                        res['skipped_unmatched'] += 1
                        continue
                if existing:
                    changes = {c: v for c, v in values.items() if c != key['col']['id']}
                    ops.append({'kind': 'update', 'row': existing, 'values': changes, 'sheet': index, 'line': n})
                    res['update'] += 1
                    if len(res['sample']) < 8:
                        res['sample'].append({'row': n, 'action': 'update', 'target': existing['id'], 'values': display(changes, cols)})
                else:
                    if rows_total >= L['rows']:
                        res['failed'] += 1
                        if len(res['errors']) < 300:
                            res['errors'].append({'row': n, 'column': '', 'value': '', 'message': f"The group would have more than {js.locale(L['rows'])} rows."})
                        continue
                    rows_total += 1
                    ops.append({'kind': 'add', 'values': values, 'sheet': index, 'line': n})
                    res['add'] += 1
                    if len(res['sample']) < 8:
                        res['sample'].append({'row': n, 'action': 'add', 'values': display(values, cols)})
            if sheet['truncated']:
                res['warnings'].insert(0, {'row': None, 'column': '', 'message': 'Only the first 20,000 rows and 200 columns of this worksheet were read.'})
            results.append(res)
        new_columns = [{'name': x['name'], 'type': x['type'], **({'labels': list(x['labels'].values())} if x['type'] == 'STATUS' else {})} for x in proposed.values()]
        new_labels = [{'column_id': k, 'column': next((x['name'] for x in visible if x['id'] == k), ''), 'labels': list(v.values())}
                      for k, v in ctx['labelAdds'].items() if not k.startswith('new:')]
        if new_labels and not caps['structure']:
            fail('Adding status labels needs “Can manage” access to this group.', 403)
        totals = {'add': sum(r['add'] for r in results), 'update': sum(r['update'] for r in results),
                  'skipped': sum(r['skipped_blank'] + r['skipped_unmatched'] for r in results), 'failed': sum(r['failed'] for r in results)}
        return {'mode': mode, 'unmatched': unmatched, 'sheets': results, 'new_columns': new_columns, 'new_labels': new_labels,
                'unresolved': list(ctx['unresolved'].values()), 'totals': totals, 'ops': ops, 'proposed': proposed}

    def preview(self, key, staff, plan):
        """What importing with this plan would do, without saving anything (the import wizard's preview)."""
        imp = self.load(key, staff)
        b, caps = self.g.open_board(imp['board_id'], staff)
        if imp['status'] == 'IMPORTED':
            return {'import_id': imp['id'], 'already': True, 'result': js.loads(imp['result_json'], None)}
        p = self.evaluate(b, staff, caps, imp, plan)
        return {'import_id': imp['id'], 'mode': p['mode'], 'unmatched': p['unmatched'], 'sheets': p['sheets'], 'new_columns': p['new_columns'],
                'new_labels': p['new_labels'], 'unresolved': p['unresolved'], 'totals': p['totals']}

    # ------------------------------------------------------------ commit
    def commit(self, d, actor):
        g = self.g
        imp = self.load(d.get('import_id'), actor)
        b, caps = g.open_board(imp['board_id'], actor)
        # A repeated request (a retry, a double click, a second tab) gets the first result; nothing is added twice.
        if imp['status'] == 'IMPORTED':
            return {'id': imp['id'], 'type': 'tm_group_import', 'already': True, 'result': js.loads(imp['result_json'], None),
                    'message': 'This file was already imported. Nothing was added again.'}
        g.archived_check(b)
        g.need(caps, 'import', 'Importing needs “Can edit records” access to this group and a role that can add records.')
        plan = self.evaluate(b, actor, caps, imp, d.get('plan'))
        if plan['unresolved']:
            fail(f"Choose who is meant for {', '.join('“' + u['text'] + '”' for u in plan['unresolved'])} before importing.", 409,
                 {'code': 'people', 'unresolved': plan['unresolved']})
        expected = d.get('expected') if isinstance(d.get('expected'), dict) else None
        totals = plan['totals']
        if (expected is None or not js.is_number(expected.get('add')) or expected['add'] != totals['add']
                or not js.is_number(expected.get('update')) or expected['update'] != totals['update']):
            fail(f"The group or the choices changed since the preview (now {totals['add']} to add and {totals['update']} to update). "
                 'Check the preview again before importing.', 409, {'code': 'preview_changed', 'totals': totals})
        if plan['mode'] == 'update' and totals['update'] and d.get('confirm_update') is not True:
            n = totals['update']
            fail(f"Confirm that {n} existing row{' is' if n == 1 else 's are'} changed.", 409, {'code': 'confirm_update'})
        created = []
        # New columns first (and new labels for existing status columns), then the plan is worked out again with them.
        for x in plan['proposed'].values():
            settings = {}
            if x['type'] == 'STATUS':
                settings = {'labels': [{'name': name, 'color': COLORS[i % 9]} for i, name in enumerate(list(x['labels'].values())[:L['labels']])]}
                if not settings['labels']:
                    settings['labels'] = [{'name': 'Done', 'color': 'GREEN'}]
            r = g.column_save({'group_id': b['id'], 'name': x['name'], 'type': x['type'], 'settings': settings}, actor)
            created.append({'id': r['id'], 'name': x['name'], 'type': x['type']})
        for add in plan['new_labels']:
            col = next(x for x in g.columns_of(b['id']) if x['id'] == add['column_id'])
            g.column_save({'group_id': b['id'], 'id': col['id'], 'expected_version': col['version'],
                           'settings': {**col['settings'], 'labels': [*dm.status_labels(col), *[{'name': n, 'color': 'GRAY'} for n in add['labels']]]}}, actor)

        def renamed_mapping(m):
            if isinstance(m, dict) and m.get('new'):
                name = dm.clean_name((m['new'] if isinstance(m['new'], dict) else {}).get('name'))
                return {'source': m.get('source'), 'target': next((x['id'] for x in created if dm.name_key(x['name']) == dm.name_key(name)), None)}
            return m
        given = d['plan']
        renamed = {**given, 'create_labels': False,
                   'sheets': [{**sh, 'columns': [renamed_mapping(m) for m in (sh.get('columns') or [])]} if isinstance(sh, dict) else sh for sh in given['sheets']]}
        plan = self.evaluate(b, actor, dict(caps), imp, renamed)
        # Every row is checked by the group's own rules as it is saved.
        s, at = g.sight(b, actor, caps), timezone.now()
        position = BoardRow.objects.filter(board_id=b['id']).aggregate(p=Max('position'))['p'] or 0
        added = updated = unchanged = 0
        failed_late = []
        # The size limits of a row and of the whole group, counted as rows are saved.
        size = [BoardRow.objects.filter(board_id=b['id']).aggregate(n=Sum(Length('values_json')))['n'] or 0]

        def fits(data, before=0):
            n = js.length(data)
            if n > L['rowChars']:
                fail(f"This row is too large ({js.locale(n)} characters; a row can hold {js.locale(L['rowChars'])}).", 422)
            if size[0] - before + n > L['groupChars']:
                fail('The group is full (its rows can hold 10,000,000 characters in all).', 422)
            size[0] += n - before
        cache = {}
        for op in plan['ops']:
            try:
                if op['kind'] == 'add':
                    values = {k: v for k, v in g.clean_values(b, s['columns'], op['values'], {}, cache).items() if not dm.empty_value(v)}
                    data = js.dumps(values)
                    fits(data)
                    position += 1
                    insert(BoardRow, {'id': next_id('tm-board-row', 'ROW'), 'board_id': b['id'], 'position': position, 'values_json': data, 'version': 0,
                                      'created_by': actor, 'created_at': at, 'updated_by': actor, 'updated_at': at})
                    added += 1
                else:
                    found = BoardRow.objects.filter(id=op['row']['id'], board_id=b['id']).first()
                    if not found or not s['rowOk'](found.id):
                        fail('The row was deleted.', 404)
                    current = js.loads(found.values_json, {})
                    changes = g.clean_values(b, s['columns'], op['values'], current, cache)
                    nxt = dict(current)
                    for k, v in changes.items():
                        if dm.empty_value(v):
                            nxt.pop(k, None)
                        else:
                            nxt[k] = v
                    data = js.dumps(nxt)
                    if data == found.values_json:
                        unchanged += 1
                        continue
                    fits(data, js.length(found.values_json))
                    update(BoardRow, found.id, {'values_json': data, 'version': found.version + 1, 'updated_by': actor, 'updated_at': at})
                    updated += 1
            except InputError as e:
                failed_late.append({'sheet': op['sheet'], 'row': op['line'], 'message': e.message})
        result = {'file_name': imp['file_name'], 'added': added, 'updated': updated, 'unchanged': unchanged, 'skipped': plan['totals']['skipped'],
                  'failed': plan['totals']['failed'] + len(failed_late), 'created_columns': created,
                  'sheets': [{'name': r['name'], 'add': r['add'], 'update': r['update'], 'skipped': r['skipped_blank'] + r['skipped_unmatched'],
                              'failed': r['failed'] + sum(1 for f in failed_late if f['sheet'] == r['index']),
                              'errors': [*r['errors'], *[{'row': f['row'], 'column': '', 'value': '', 'message': f['message']} for f in failed_late if f['sheet'] == r['index']]][:300],
                              'warnings': r['warnings'][:100]} for r in plan['sheets']],
                  'imported_at': iso(at)}
        update(BoardImport, imp['id'], {'status': 'IMPORTED', 'result_json': js.dumps(result), 'imported_at': at, 'sheets_json': '[]'})
        g.touch(b)
        g.record(actor, b, 'Imported from Excel', f"{imp['file_name']} · {added} added · {updated} updated · {result['skipped']} skipped · {result['failed']} not imported")
        done = ', '.join(x for x in [f"{added} row{'' if added == 1 else 's'} added", plan['mode'] == 'update' and f'{updated} updated',
                                     unchanged and f'{unchanged} already up to date'] if x)
        return {'id': imp['id'], 'type': 'tm_group_import', 'result': result,
                'message': f"Imported: {done}{f'; ' + str(result['failed']) + ' not imported (see the list)' if result['failed'] else ''}."}

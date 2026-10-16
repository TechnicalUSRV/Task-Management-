"""Task Management · Groups — the rules of group-domain.mjs (V5.7.7): access levels, cell values and the formula language.

The React screens run the same rules from group-domain.mjs for previews; the server (this module) is authoritative.
Values follow V5.7.7: null, numbers (15 significant digits), 'YYYY-MM-DD' dates, status label IDs, staff IDs, lists of
staff IDs, lists of file descriptions, or formula results ({'error': '#DIV/0!'} for errors).
"""
import math
import re
import unicodedata
from datetime import datetime

from . import js

COLUMN_TYPES = {'TEXT': 'Text', 'DATE': 'Date', 'NUMBER': 'Number', 'STATUS': 'Status', 'IN_CHARGE': 'In Charge', 'SUPPORT': 'Support',
                'FORMULA': 'Formula', 'ATTACHMENT': 'Attachment'}
STATUS_COLORS = {'GRAY': 'Gray', 'BLUE': 'Blue', 'GREEN': 'Green', 'ORANGE': 'Orange', 'RED': 'Red', 'PURPLE': 'Purple', 'TEAL': 'Teal',
                 'PINK': 'Pink', 'YELLOW': 'Yellow'}
DEFAULT_STATUS_LABELS = [('Not Started', 'GRAY'), ('In Progress', 'BLUE'), ('On Hold', 'ORANGE'), ('Done', 'GREEN')]
GROUP_LIMITS = {'columns': 60, 'rows': 5000, 'text': 10000, 'name': 80, 'description': 2000, 'labels': 40, 'label': 40, 'people': 50, 'formula': 1000,
                'shared': 200, 'rowChars': 100000, 'groupChars': 10000000, 'groups': 200,
                'note': 4000, 'notesPerRow': 2000, 'page': 200, 'principals': 100, 'bulk': 5000, 'importBytes': 5 * 1024 * 1024, 'width': [60, 800],
                'files': 20, 'fileBytes': 30 * 1024 * 1024, 'groupFileBytes': 250 * 1024 * 1024, 'rownumWidth': [64, 240]}
LEVELS = {'VIEW': 1, 'EDIT': 2, 'MANAGE': 3, 'OWNER': 4}
LEVEL_LABELS = {'VIEW': 'Can view', 'EDIT': 'Can edit records', 'MANAGE': 'Can manage', 'OWNER': 'Owner'}


class Undefined:
    """JavaScript `undefined` where V5.7.7 tells it apart from null (filter values)."""
    def __repr__(self):
        return 'undefined'


UNDEF = Undefined()


# ------------------------------------------------------------------ access
def group_level(board, staff, member=False, level=None, admin=False):
    if not board or not staff:
        return 0
    if board['owner_id'] == staff:
        return LEVELS['OWNER']
    if board['visibility'] != 'TEAM':
        return 0
    own = (LEVELS.get(level) or 0) if member and level else 0
    everyone = (LEVELS.get(board['workspace_level']) or LEVELS['VIEW']) if member and board['audience'] == 'WORKSPACE' else 0
    return max(own, everyone, LEVELS['MANAGE'] if admin else 0)


def group_caps(level, can, admin=False, owner=False, archived=False, ws_archived=False):
    view = level > 0 and can('view')
    rows = view and not archived and level >= LEVELS['EDIT']
    manage = view and not archived and level >= LEVELS['MANAGE']
    return {'level': level, 'view': bool(view), 'addRows': bool(rows and can('create')), 'editRows': bool(rows and can('update')),
            'deleteRows': bool(rows and can('delete')), 'structure': bool(manage and can('update')),
            'deleteColumns': bool(manage and can('update') and can('delete')), 'share': bool(manage and can('update')),
            'rename': bool(manage and can('update')), 'visibility': bool(view and not archived and (owner or admin) and can('update')),
            'archive': bool(view and not ws_archived and (owner or admin) and can('delete')), 'export': bool(view and can('export')),
            'notes': bool(rows and can('update')), 'seeAll': bool(view and level >= LEVELS['MANAGE']), 'import': bool(rows and can('create'))}


# ------------------------------------------------------------------ row and column access
def rule_allows(principals, staff, role):
    return (not principals or any((p['type'] == 'USER' and p['id'] == staff) or (p['type'] == 'ROLE' and bool(role) and p['id'] == role)
                                  for p in principals))


def visible_columns(columns, allowed):
    by_id, memo = {c['id']: c for c in columns}, {}

    def ok(key, trail):
        if key in memo:
            return memo[key]
        c = by_id.get(key)
        if not c:
            return True
        if not allowed(c):
            memo[key] = False
            return False
        if c['type'] != 'FORMULA':
            memo[key] = True
            return True
        if key in trail:
            return True
        trail.add(key)
        r = all(ok(x, trail) for x in formula_refs((c.get('settings') or {}).get('expression')))
        trail.discard(key)
        memo[key] = r
        return r
    return [c for c in columns if ok(c['id'], set())]


# ------------------------------------------------------------------ search, filters and sorting
def _has(v):
    return v is not None and v is not UNDEF and v != ''


def matches_filter(col, value, f, text):
    t = col['type']
    if t in ('NUMBER', 'FORMULA'):
        if not js.is_number(value):
            return not _has(f.get('min')) and not _has(f.get('max'))
        lo, hi = f.get('min'), f.get('max')
        return (not _has(lo) or value >= js.number(lo)) and (not _has(hi) or value <= js.number(hi))
    if t == 'DATE':
        frm, to = f.get('from'), f.get('to')
        if not value:
            return not frm and not to
        return (not frm or value >= frm) and (not to or value <= to)
    fv = f.get('value', UNDEF)
    if t in ('STATUS', 'IN_CHARGE'):
        if fv == '' or fv is None:
            return empty_value(value)
        return value is None if fv is UNDEF else value == fv
    if t == 'SUPPORT':
        if fv == '' or fv is None:
            return empty_value(value)
        return isinstance(value, list) and fv is not UNDEF and fv in value
    needle = fv if isinstance(fv, str) and fv else ''
    return needle.lower() in js.to_js_string(text if text is not None else '').lower()


def sort_key(col, value, text):
    if empty_value(value):
        return None
    t = col['type']
    if t == 'NUMBER':
        return value
    if t == 'FORMULA':
        return value if js.is_number(value) else (1 if value else 0) if isinstance(value, bool) else None
    if t == 'STATUS':
        return next((i for i, label in enumerate(status_labels(col)) if label.get('id') == value), -1)
    return text


def clean_filters(raw):
    if raw is None or raw == '' or raw is UNDEF:
        return []
    items = raw
    if isinstance(items, str):
        import json
        try:
            items = json.loads(items)
        except ValueError:
            return None
    if not isinstance(items, list) or len(items) > 50:
        return None

    def s(v):
        return None if v is None or v is UNDEF else js.to_js_string(v)[:200]
    out = []
    for f in items:
        if not isinstance(f, dict) or not isinstance(f.get('col'), str):
            continue
        value = None if ('value' in f and f['value'] is None) else (s(f['value']) if 'value' in f else UNDEF)
        out.append({'col': f['col'][:60], 'value': value, 'min': s(f.get('min')), 'max': s(f.get('max')), 'from': s(f.get('from')), 'to': s(f.get('to'))})
    return out


# ------------------------------------------------------------------ names and values
_CONTROL = re.compile('[\u0000-\u001f\u007f]')
_SPACES = re.compile(js.WS_CLASS + '+')
_INVISIBLE = re.compile('[​-‍⁠﻿­]')


def clean_name(v):
    s = unicodedata.normalize('NFC', '' if v is None else js.to_js_string(v))
    return js.trim(_SPACES.sub(' ', _CONTROL.sub(' ', s)))


def name_key(v):
    return _INVISIBLE.sub('', clean_name(v)).lower()


def column_name_error(name, columns=(), self_id=None):
    n = clean_name(name)
    if not n:
        return 'Enter a column name.'
    if js.length(n) > GROUP_LIMITS['name']:
        return f"Use at most {GROUP_LIMITS['name']} characters for a column name."
    if re.search(r'[{}]', n):
        return 'Column names can’t contain { or } (they mark column names in formulas).'
    if n.startswith('#') or n.startswith('='):
        return 'Column names can’t start with # or =.'
    if any(c['id'] != self_id and name_key(c['name']) == name_key(n) for c in columns):
        return f'This group already has a column named “{n}”. Column names must be unique so formulas know which one you mean.'
    return None


_NUMBER_TEXT = re.compile(r'^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$', re.IGNORECASE)
_NUMBER_STRIP = re.compile(js.WS_CLASS[:-1] + ', ]')


def tidy(x):
    """Numbers keep 15 significant digits (like a spreadsheet), so 0.1 + 0.2 is exactly 0.3."""
    if x == 0:
        return 0
    return js.num(float(f'{x:.15g}'))


def parse_number(raw):
    if raw is None:
        return {'ok': True, 'value': None}
    if js.is_number(raw):
        if math.isfinite(raw) and abs(raw) <= 1e15:
            return {'ok': True, 'value': tidy(raw)}
        return {'ok': False, 'error': 'Enter a number between -1,000,000,000,000,000 and 1,000,000,000,000,000.'}
    text = js.to_js_string(raw)
    if js.length(text) > 100:
        return {'ok': False, 'error': 'This number is too long. Enter at most 15 significant digits.'}
    s = _NUMBER_STRIP.sub('', text)
    if not s:
        return {'ok': True, 'value': None}
    if not _NUMBER_TEXT.match(s):
        return {'ok': False, 'error': f'“{text[:40]}” isn’t a number. Use digits, an optional minus sign and a decimal point, for example -12.5.'}
    return parse_number(js.num(float(s)))


_DAY = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')


def parse_day(raw):
    if raw is None or raw == '':
        return {'ok': True, 'value': None}
    s = js.trim(js.to_js_string(raw))
    valid = bool(_DAY.match(s))
    if valid:
        try:
            datetime.strptime(s, '%Y-%m-%d')
        except ValueError:
            valid = False
    if not valid or not 1900 <= int(s[:4]) <= 2200:
        return {'ok': False, 'error': 'Enter a valid date (YYYY-MM-DD).'}
    return {'ok': True, 'value': s}


_TEXT_CONTROL = re.compile('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]')


def clean_text(raw):
    if raw is None:
        return {'ok': True, 'value': None}
    if not isinstance(raw, str) and not js.is_number(raw):
        return {'ok': False, 'error': 'Enter text.'}
    limit = f"Use at most {js.locale(GROUP_LIMITS['text'])} characters in a cell."
    text = js.to_js_string(raw)
    if js.length(text) > GROUP_LIMITS['text'] * 2:
        return {'ok': False, 'error': limit}
    s = unicodedata.normalize('NFC', text).replace('\r\n', '\n').replace('\r', '\n')
    s = re.sub(r'^\n+', '', js.trim_end(_TEXT_CONTROL.sub('', s)))
    if js.length(s) > GROUP_LIMITS['text']:
        return {'ok': False, 'error': limit}
    return {'ok': True, 'value': s if js.trim(s) else None}


def status_labels(col):
    labels = ((col or {}).get('settings') or {}).get('labels')
    return labels if isinstance(labels, list) else []


def empty_value(v):
    return v is None or v is UNDEF or v == '' or (isinstance(v, list) and not v)


def clean_cell(col, value, eligible=None, current=None):
    """Checks a value typed for a cell. eligible: staff IDs that may be chosen now; current: the value already in the cell."""
    t = col['type']
    if t == 'FORMULA':
        return {'ok': False, 'error': 'Formula results are calculated for each row; they can’t be typed in.'}
    if t == 'ATTACHMENT':
        if value is None or value == '' or (isinstance(value, list) and not value):
            return {'ok': True, 'value': None}
        had = current if isinstance(current, list) else []

        def key(x):
            return x if isinstance(x, str) else x.get('id') if isinstance(x, dict) else None
        ids_had = [h.get('id') for h in had if isinstance(h, dict)]
        if not isinstance(value, list) or any(key(x) not in ids_had for x in value):
            return {'ok': False, 'error': 'Add files with the Upload button in the cell.'}
        ids = {key(x) for x in value}
        return {'ok': True, 'value': [h for h in had if h.get('id') in ids]}
    if t == 'TEXT':
        return clean_text(value)
    if t == 'NUMBER':
        return parse_number(value)
    if t == 'DATE':
        return parse_day(value)
    if t == 'STATUS':
        if value is None or value == '':
            return {'ok': True, 'value': None}
        labels = status_labels(col)
        found = next((l for l in labels if l.get('id') == value), None) or next((l for l in labels if name_key(l.get('name')) == name_key(value)), None)
        if found:
            return {'ok': True, 'value': found['id']}
        return {'ok': False, 'error': f"Choose one of this column’s labels: {', '.join(l.get('name', '') for l in labels)}."}

    def allowed(staff):
        return isinstance(staff, str) and (eligible is None or staff in eligible)
    if t == 'IN_CHARGE':
        if value is None or value == '':
            return {'ok': True, 'value': None}
        if not isinstance(value, str):
            return {'ok': False, 'error': 'Choose one person.'}
        if value == current or allowed(value):
            return {'ok': True, 'value': value}
        return {'ok': False, 'error': 'Choose an active member who can see this group.'}
    if t == 'SUPPORT':
        if value is None or value == '':
            return {'ok': True, 'value': None}
        if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
            return {'ok': False, 'error': 'Choose the supporting people.'}
        people = list(dict.fromkeys(value))
        had = set(current) if isinstance(current, list) else set()
        if len(people) > GROUP_LIMITS['people']:
            return {'ok': False, 'error': f"Choose up to {GROUP_LIMITS['people']} people."}
        if any(x not in had and not allowed(x) for x in people):
            return {'ok': False, 'error': 'Choose active members who can see this group.'}
        return {'ok': True, 'value': people or None}
    return {'ok': False, 'error': 'Unknown column type.'}


def format_number(n, decimals=None):
    if not js.is_number(n) or not math.isfinite(n):
        return ''
    d = None if decimals is None else max(0, min(6, int(js.number(decimals))))
    return js.fmt(n if d is None else round_to(n, d), d)


def format_result(v, decimals=None):
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, dict):
        return v.get('error')
    return format_number(v, decimals)


def cell_text(col, value, name_of=lambda x: x):
    """A cell as plain text (search, sorting of text, Excel export)."""
    if empty_value(value):
        return ''
    t = col['type']
    settings = col.get('settings') or {}
    if t == 'FORMULA':
        return format_result(value, settings.get('decimals'))
    if t == 'NUMBER':
        return format_number(value, settings.get('decimals'))
    if t == 'DATE':
        return js.to_js_string(value)
    if t == 'STATUS':
        return next((l.get('name') for l in status_labels(col) if l.get('id') == value), None) or ''
    if t == 'IN_CHARGE':
        return name_of(value)
    if t == 'SUPPORT':
        return ', '.join(name_of(x) for x in (value if isinstance(value, list) else []))
    if t == 'ATTACHMENT':
        return ', '.join(f.get('name') for f in (value if isinstance(value, list) else []) if isinstance(f, dict) and f.get('name'))
    return js.to_js_string(value)


# ------------------------------------------------------------------ changing a column's type
def convert_value(src, dst, value, labels=(), name_of=lambda x: x, person_by_name=lambda n: None):
    if empty_value(value):
        return {'ok': True, 'value': None}
    text = js.to_js_string(value) if src['type'] == 'TEXT' else cell_text(src, value, name_of)
    t = dst['type']
    if t == 'TEXT':
        return {'ok': True, 'value': text or None}
    if t == 'NUMBER':
        if src['type'] in ('NUMBER', 'FORMULA'):
            if isinstance(value, bool):
                return {'ok': True, 'value': 1 if value else 0}
            return {'ok': True, 'value': value} if js.is_number(value) else {'ok': False}
        r = parse_number(text)
        return r if r['ok'] else {'ok': False}
    if t == 'DATE':
        r = parse_day(value if src['type'] == 'DATE' else text)
        return r if r['ok'] else {'ok': False}
    if t == 'STATUS':
        found = next((l for l in labels if name_key(l['name']) == name_key(text)), None)
        return {'ok': True, 'value': found['id']} if found else {'ok': False}
    if t == 'IN_CHARGE':
        if src['type'] == 'SUPPORT':
            people = value if isinstance(value, list) else []
            return {'ok': True, 'value': people[0]} if len(people) == 1 else {'ok': False}
        p = person_by_name(text)
        return {'ok': True, 'value': p} if p else {'ok': False}
    if t == 'SUPPORT':
        if src['type'] == 'IN_CHARGE':
            return {'ok': True, 'value': [value]}
        names = [js.trim(s) for s in text.split(',') if js.trim(s)]
        ids = [person_by_name(n) for n in names]
        return {'ok': True, 'value': list(dict.fromkeys(ids))} if ids and all(ids) else {'ok': False}
    return {'ok': False}


# ------------------------------------------------------------------ formulas
FORMULA_FUNCTIONS = {
    'SUM': {'min': 1, 'max': 255, 'usage': 'SUM(value, value, …)'},
    'AVERAGE': {'min': 1, 'max': 255, 'usage': 'AVERAGE(value, value, …)'},
    'MIN': {'min': 1, 'max': 255, 'usage': 'MIN(value, value, …)'},
    'MAX': {'min': 1, 'max': 255, 'usage': 'MAX(value, value, …)'},
    'ROUND': {'min': 1, 'max': 2, 'usage': 'ROUND(value, decimals)'},
    'IF': {'min': 2, 'max': 3, 'usage': 'IF(condition, value if true, value if false)'},
}
OPERATORS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '(', ')', ',']


class FormulaError(Exception):
    pass


def _bad(message):
    raise FormulaError(message)


_NUM_TOKEN = re.compile(r'([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?')
_WORD_TOKEN = re.compile(r'[A-Za-z_][A-Za-z0-9_.]*')


def tokenize(src):
    tokens, i = [], 0
    while i < len(src):
        ch = src[i]
        if ch in js.WS:
            i += 1
            continue
        if ch == '{':
            end = src.find('}', i + 1)
            if end < 0:
                _bad('A column name is missing its closing brace }.')
            name = src[i + 1:end]
            if '{' in name:
                _bad('A column name is missing its closing brace }.')
            if not js.trim(name):
                _bad('Put a column name inside the braces, for example {Quantity}.')
            tokens.append({'t': 'ref', 'v': name, 'start': i, 'end': end + 1})
            i = end + 1
            continue
        if ch == '}':
            _bad('There is a } without a matching {.')
        m = _NUM_TOKEN.match(src, i)
        if m:
            v = float(m.group(0))
            if not math.isfinite(v):
                _bad(f'{m.group(0)} is too large.')
            tokens.append({'t': 'num', 'v': js.num(v), 'raw': m.group(0)})
            i += len(m.group(0))
            continue
        m = _WORD_TOKEN.match(src, i)
        if m:
            up = m.group(0).upper()
            tokens.append({'t': 'bool', 'v': up == 'TRUE', 'raw': m.group(0)} if up in ('TRUE', 'FALSE') else {'t': 'name', 'v': up, 'raw': m.group(0)})
            i += len(m.group(0))
            continue
        op = next((o for o in OPERATORS if src.startswith(o, i)), None)
        if op:
            tokens.append({'t': 'op', 'v': op})
            i += len(op)
            continue
        if ch in ('"', '“', '”', "'"):
            _bad('Text in quotes isn’t supported in formulas. Use numbers and column names.')
        if ch == '^':
            _bad('The ^ operator isn’t supported. Multiply instead, for example {Rate} * {Rate}.')
        if ch == '%':
            _bad('The % sign isn’t supported. Divide by 100 instead, for example {Rate} / 100.')
        if ch == '&':
            _bad('Joining text with & isn’t supported.')
        if ch == ';':
            _bad('Separate the values in a function with commas, for example SUM({A}, {B}).')
        if ch == '!' and src[i + 1:i + 2] == '=':
            _bad('Use <> for “not equal”.')
        if ch == '=' and src[i + 1:i + 2] == '=':
            _bad('Use a single = to compare values.')
        _bad(f'“{ch}” isn’t allowed in a formula.')
    return tokens


def _show(tk):
    if not tk:
        return ''
    if tk['t'] == 'ref':
        return '{' + tk['v'] + '}'
    return tk['raw'] if 'raw' in tk else js.to_js_string(tk['v'])


def parse_tokens(tokens):
    p = [0]

    def peek():
        return tokens[p[0]] if p[0] < len(tokens) else None

    def is_op(v):
        tk = peek()
        return bool(tk) and tk['t'] == 'op' and tk['v'] == v

    def expr(depth):
        if depth > 40:
            _bad('This formula is nested too deeply.')
        return comparison(depth)

    def comparison(d):
        a = additive(d)
        while peek() and peek()['t'] == 'op' and peek()['v'] in ('=', '<>', '<', '<=', '>', '>='):
            op = tokens[p[0]]['v']
            p[0] += 1
            a = {'k': 'cmp', 'op': op, 'a': a, 'b': additive(d)}
        return a

    def additive(d):
        a = term(d)
        while is_op('+') or is_op('-'):
            op = tokens[p[0]]['v']
            p[0] += 1
            a = {'k': 'bin', 'op': op, 'a': a, 'b': term(d)}
        return a

    def term(d):
        a = unary(d)
        while is_op('*') or is_op('/'):
            op = tokens[p[0]]['v']
            p[0] += 1
            a = {'k': 'bin', 'op': op, 'a': a, 'b': unary(d)}
        return a

    def unary(d):
        if is_op('-') or is_op('+'):
            op = tokens[p[0]]['v']
            p[0] += 1
            a = unary(d + 1)
            return {'k': 'neg', 'a': a} if op == '-' else a
        return primary(d)

    def primary(d):
        before = tokens[p[0] - 1] if 0 <= p[0] - 1 < len(tokens) else None
        tk = tokens[p[0]] if p[0] < len(tokens) else None
        p[0] += 1
        if not tk:
            _bad(f'The formula ends after “{_show(before)}”. Add a number, column or function.' if before
                 else 'Enter a formula, for example ={Quantity} * {Unit Price}.')
        if tk['t'] == 'num':
            return {'k': 'num', 'v': tk['v']}
        if tk['t'] == 'bool':
            return {'k': 'bool', 'v': tk['v']}
        if tk['t'] == 'ref':
            return {'k': 'ref', 'name': tk['v']}
        if tk['t'] == 'name':
            if not is_op('('):
                f = FORMULA_FUNCTIONS.get(tk['v'])
                _bad(f"{tk['v']} needs its values in brackets, for example {f['usage']}." if f else
                     f"“{tk['raw']}” isn’t a column or a function. Put column names in braces, for example {{{tk['raw']}}}.")
            f = FORMULA_FUNCTIONS.get(tk['v'])
            if not f:
                _bad(f"{tk['v']} isn’t supported. Use SUM, AVERAGE, MIN, MAX, ROUND or IF.")
            p[0] += 1
            args = []
            if not is_op(')'):
                while True:
                    if is_op(',') or is_op(')'):
                        _bad(f"A value is missing in {tk['v']}( ).")
                    args.append(expr(d + 1))
                    if is_op(','):
                        p[0] += 1
                        continue
                    break
            if not is_op(')'):
                _bad(f"{tk['v']}( is missing its closing ).")
            p[0] += 1
            if len(args) < f['min'] or len(args) > f['max']:
                count = f['min'] if f['min'] == f['max'] else f"{f['min']} to {'many' if f['max'] == 255 else f['max']}"
                _bad(f"{tk['v']} takes {count} value{'' if f['max'] == 1 else 's'}: {f['usage']}.")
            return {'k': 'fn', 'name': tk['v'], 'args': args}
        if tk.get('v') == '(':
            if is_op(')'):
                _bad('There is nothing between ( and ).')
            e = expr(d + 1)
            if not is_op(')'):
                _bad('A ( is missing its closing ).')
            p[0] += 1
            return e
        _bad(f'Expected a number, column or function after “{_show(before)}”, not “{_show(tk)}”.' if before
             else f'A formula can’t start with “{_show(tk)}”.')

    ast = expr(0)
    if p[0] < len(tokens):
        tk = tokens[p[0]]
        _bad('There is a ) without a matching (.' if tk.get('v') == ')' else f'Expected an operator such as + or * before “{_show(tk)}”.')
    return ast


def _strip_equals(text):
    s = js.trim('' if text is None else js.to_js_string(text))
    return s[1:] if s.startswith('=') else s


def formula_refs(canonical):
    try:
        return list(dict.fromkeys(t['v'][1:] for t in tokenize(_strip_equals(canonical)) if t['t'] == 'ref' and t['v'].startswith('#')))
    except FormulaError:
        return []


def compile_formula(text, columns, self_id=None):
    """Checks a formula typed by a person against the group's columns: {ok, canonical, display, refs} or {ok: False, error}."""
    try:
        raw = js.trim('' if text is None else js.to_js_string(text))
        if js.length(raw) > GROUP_LIMITS['formula']:
            _bad(f"Use at most {GROUP_LIMITS['formula']} characters in a formula.")
        src = _strip_equals(raw)
        if not js.trim(src):
            _bad('Enter a formula, for example ={Quantity} * {Unit Price}.')
        tokens = tokenize(src)
        if len(tokens) > 400:
            _bad('This formula is too long.')
        parse_tokens(tokens)
        by_id = {c['id']: c for c in columns}
        by_name = {name_key(c['name']): c for c in columns}
        refs, canonical, at = [], '', 0
        for tk in (x for x in tokens if x['t'] == 'ref'):
            col = by_id.get(tk['v'][1:]) if tk['v'].startswith('#') else by_name.get(name_key(tk['v']))
            if not col:
                _bad(f"There’s no column named {{{clean_name(tk['v'])}}}. Check the spelling, or insert the column from the list.")
            if col['id'] == self_id:
                _bad(f"A formula can’t use its own column ({{{col['name']}}}).")
            if col['type'] not in ('NUMBER', 'FORMULA'):
                _bad(f"{{{col['name']}}} is a {COLUMN_TYPES[col['type']]} column. Formulas can use Number and Formula columns only.")
            if col['id'] not in refs:
                refs.append(col['id'])
            canonical += src[at:tk['start']] + '{#' + col['id'] + '}'
            at = tk['end']
        canonical = '=' + js.trim(canonical + src[at:])
        if self_id:
            loop = formula_cycle(columns, self_id, refs)
            if loop:
                _bad(f"This would make a loop: {' → '.join((by_id.get(x) or {}).get('name') or x for x in loop)}. A formula can’t depend on itself.")
        return {'ok': True, 'canonical': canonical, 'display': formula_display(canonical, columns), 'refs': refs}
    except FormulaError as e:
        return {'ok': False, 'error': str(e)}


def formula_display(canonical, columns):
    src, by_id = _strip_equals(canonical), {c['id']: c for c in columns}
    out, at = '', 0
    try:
        for tk in (x for x in tokenize(src) if x['t'] == 'ref'):
            c = by_id.get(tk['v'][1:]) if tk['v'].startswith('#') else None
            shown = '{' + c['name'] + '}' if c else '{deleted column}' if tk['v'].startswith('#') else '{' + tk['v'] + '}'
            out += src[at:tk['start']] + shown
            at = tk['end']
    except FormulaError:
        return '' if canonical is None else js.to_js_string(canonical)
    return '=' + out + src[at:]


def formula_cycle(columns, self_id, refs):
    uses = {c['id']: formula_refs((c.get('settings') or {}).get('expression')) for c in columns if c['type'] == 'FORMULA' and c['id'] != self_id}
    uses[self_id] = refs
    done = set()

    def walk(key, trail):
        for r in uses.get(key) or []:
            if r == self_id:
                return [*trail, r]
            if r in done or r in trail or r not in uses:
                continue
            found = walk(r, [*trail, r])
            if found:
                return found
            done.add(r)
        return None
    return walk(self_id, [self_id])


def formula_dependents(columns, col_id):
    return [c for c in columns if c['type'] == 'FORMULA' and c['id'] != col_id and col_id in formula_refs((c.get('settings') or {}).get('expression'))]


def _is_error(v):
    return isinstance(v, dict)


def _as_number(v):
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    return v


def _finish(x):
    return tidy(x) if math.isfinite(x) and abs(x) < 1e300 else {'error': '#NUM!'}


def _js_round(v):
    """Math.round for a non-negative number: the closest integer, ties toward +Infinity."""
    if not math.isfinite(v):
        return v
    f = math.floor(v)
    return float(f + 1 if v - f >= 0.5 else f)


def _shift(n, e):
    if not math.isfinite(n):
        return float('nan')
    m, _, exp = js.num_str(n).partition('e')
    return float(f'{m}e{int(exp or 0) + e}')


def round_to(x, digits):
    """Rounds half away from zero at `digits` decimal places (negative digits round to tens, hundreds…)."""
    d = max(-15, min(15, math.trunc(digits)))
    sign = (x > 0) - (x < 0)
    r = sign * _shift(_js_round(_shift(abs(x), d)), -d)
    if math.isfinite(r):
        return tidy(r)
    from decimal import ROUND_HALF_UP, Decimal
    places = max(0, d)
    fixed = x if abs(x) >= 1e21 else float(Decimal(x).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))
    return tidy(fixed)


def _evaluate(n, get):
    k = n['k']
    if k in ('num', 'bool'):
        return n['v']
    if k == 'ref':
        return get(n.get('id'))
    if k == 'neg':
        a = _evaluate(n['a'], get)
        return a if _is_error(a) else _finish(-float(_as_number(a)))
    if k in ('bin', 'cmp'):
        a = _evaluate(n['a'], get)
        if _is_error(a):
            return a
        b = _evaluate(n['b'], get)
        if _is_error(b):
            return b
        x, y = float(_as_number(a)), float(_as_number(b))
        op = n['op']
        if k == 'cmp':
            return {'=': x == y, '<>': x != y, '<': x < y, '<=': x <= y, '>': x > y, '>=': x >= y}[op]
        if op == '/' and y == 0:
            return {'error': '#DIV/0!'}
        return _finish(x + y if op == '+' else x - y if op == '-' else x * y if op == '*' else x / y)
    if k == 'fn':
        name = n['name']
        if name == 'IF':
            c = _evaluate(n['args'][0], get)
            if _is_error(c):
                return c
            if _as_number(c) != 0:
                return _evaluate(n['args'][1], get)
            return _evaluate(n['args'][2], get) if len(n['args']) > 2 else False
        values = []
        for arg in n['args']:
            v = _evaluate(arg, get)
            if _is_error(v):
                return v
            values.append(v)
        if name == 'ROUND':
            d = _as_number(values[1]) if len(values) > 1 else 0
            return None if values[0] is None else round_to(float(_as_number(values[0])), d)
        present = [_as_number(v) for v in values if v is not None]
        if name in ('SUM', 'AVERAGE'):
            total = 0.0
            for x in present:
                total += float(x)   # one addition at a time, as JavaScript adds (no compensated summation)
            if name == 'SUM':
                return _finish(total)
            return _finish(total / len(present)) if present else {'error': '#DIV/0!'}
        if name == 'MIN':
            return min(present) if present else 0
        if name == 'MAX':
            return max(present) if present else 0
        return {'error': '#VALUE!'}
    return {'error': '#VALUE!'}


def prepare_formulas(columns):
    """The saved formulas of a group's columns, parsed once per request."""
    by_id, out = {c['id']: c for c in columns}, {}
    for c in columns:
        if c['type'] != 'FORMULA':
            continue
        expression = (c.get('settings') or {}).get('expression') or ''
        try:
            ast = parse_tokens(tokenize(_strip_equals(expression)))

            def bind(node):
                if node['k'] == 'ref':
                    node['id'] = node['name'][1:] if node['name'].startswith('#') else None
                for x in ('a', 'b'):
                    if x in node:
                        bind(node[x])
                for x in node.get('args') or []:
                    bind(x)
            bind(ast)
            refs = formula_refs(expression)
            broken = ('#REF!' if any(x not in by_id for x in refs) else
                      '#VALUE!' if any(by_id[x]['type'] not in ('NUMBER', 'FORMULA') for x in refs) else None)
            out[c['id']] = {'error': broken, 'refs': refs} if broken else {'ast': ast, 'refs': refs}
        except FormulaError:
            out[c['id']] = {'error': '#VALUE!', 'refs': []}
    return out


def compute_row(values, columns, prepared=None):
    """Every formula result of one row: {columnId: value}."""
    prepared = prepare_formulas(columns) if prepared is None else prepared
    by_id, out, state = {c['id']: c for c in columns}, {}, {}
    values = values or {}

    def get(key):
        col = by_id.get(key)
        if not col:
            return {'error': '#REF!'}
        if col['type'] == 'NUMBER':
            v = values.get(key)
            return v if js.is_number(v) and math.isfinite(v) else None
        if col['type'] != 'FORMULA':
            return {'error': '#VALUE!'}
        if state.get(key) == 2:
            return out[key]
        if state.get(key) == 1:
            return {'error': '#CIRC!'}
        state[key] = 1
        f = prepared.get(key)
        if not f or f.get('error'):
            r = {'error': (f or {}).get('error') or '#VALUE!'}
        else:
            used = [get(x) for x in f['refs']]
            r = None if f['refs'] and all(v is None for v in used) else _evaluate(f['ast'], get)
        state[key] = 2
        out[key] = r
        return r
    for c in columns:
        if c['type'] == 'FORMULA':
            get(c['id'])
    return out

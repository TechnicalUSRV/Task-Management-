"""Input checks ported from service.mjs so messages and limits stay identical to V5.7.7."""
from core.i18n import msg as _message
import re
from datetime import datetime, timezone

from .errors import fail


def js_length(value: str) -> int:
    """String length as JavaScript counts it (UTF-16 code units), so limits match the browser and V5.7.7."""
    return len(value.encode('utf-16-le')) // 2


def text(value, label, max_length=500, required=False):
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        fail(_message('{p0} is required.', p0=label) if isinstance(value, str) or value is None else _message('{p0} must be text.', p0=label))
    trimmed = value.strip()
    if js_length(trimmed) > max_length:
        fail(_message('{p0} must be at most {p1} characters.', p0=label, p1=max_length))
    return trimmed


def choice(value, options, label):
    if value in options:
        return value
    fail(_message('Choose a valid {p0}.', p0=label))


_DECIMAL = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$')
_RADIX = re.compile(r'^0([xXoObB])([0-9a-fA-F]+)$')
MAX_SAFE_INTEGER = 9007199254740991


def js_number(value):
    """JavaScript Number(value) for JSON values; float('nan') where JavaScript gives NaN."""
    if value is None:
        return 0
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        if not value:
            return 0
        return js_number(value[0] if not isinstance(value[0], (list, dict)) and value[0] is not None else '') if len(value) == 1 else float('nan')
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return 0
        if _DECIMAL.match(s):
            n = float(s)
            return int(n) if n.is_integer() and abs(n) <= MAX_SAFE_INTEGER else n
        m = _RADIX.match(s)
        if m:
            try:
                return int(m.group(2), {'x': 16, 'o': 8, 'b': 2}[m.group(1).lower()])
            except ValueError:
                return float('nan')
        if s in (_message('Infinity'), '+Infinity'):
            return float('inf')
        if s == '-Infinity':
            return float('-inf')
    return float('nan')


def integer(value, minimum, maximum, label):
    """V5.7.7 integer(): Number.isSafeInteger(Number(v)) within the range, else 'Invalid <label>.'."""
    n = js_number(value)
    if isinstance(n, float):
        if n != n or n in (float('inf'), float('-inf')) or not n.is_integer():
            fail(_message('Invalid {p0}.', p0=label))
        n = int(n)
    if abs(n) > MAX_SAFE_INTEGER or n < minimum or n > maximum:
        fail(_message('Invalid {p0}.', p0=label))
    return n


_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def date_text(value, label):
    s = text(value, label, 10, True)
    if not _DATE.match(s):
        fail(_message('Enter a valid {p0}.', p0=label))
    try:
        datetime.strptime(s, '%Y-%m-%d')
    except ValueError:
        fail(_message('Enter a valid {p0}.', p0=label))
    return s


def iso(dt):
    """Timestamps in the exact form V5.7.7 sends: 2026-10-15T03:04:05.678Z."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def is_record_id(value):
    return isinstance(value, str)

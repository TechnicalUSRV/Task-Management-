"""JavaScript semantics the Group rules depend on, so Django stores and shows exactly what V5.7.7 did.

V5.7.7 keeps cell values as JSON text written by JSON.stringify and checks sizes with JavaScript string lengths; numbers
are shown with Intl.NumberFormat('en-US') and parsed with Number()/parseInt(). These helpers reproduce those behaviours
for the value types Groups use (null, booleans, numbers, strings, lists and objects).
"""
import math
import re
from decimal import ROUND_HALF_UP, Decimal, localcontext

from core.validation import js_length

MAX_SAFE = 9007199254740991

# JavaScript's whitespace (String.prototype.trim and the regular expression \s): WhiteSpace and LineTerminator.
WS = '\t\n\x0b\x0c\r \xa0                　﻿'
WS_CLASS = '[' + re.escape(WS) + ']'
_LONE_SURROGATE = re.compile('[\ud800-\udfff]')


def trim(s):
    return s.strip(WS)


def trim_end(s):
    return s.rstrip(WS)


def num(x):
    """A JavaScript number as Python keeps it: integral values as int (so they print as 3, not 3.0)."""
    if isinstance(x, bool):
        return x
    if isinstance(x, float) and x.is_integer() and abs(x) <= MAX_SAFE:
        return 0 if x == 0 else int(x)
    return x


def is_number(v):
    """typeof v === 'number'."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _digits(x):
    """Shortest round-trip decimal digits of a positive finite float and its exponent n (value = 0.d1d2… × 10^n)."""
    r = repr(float(x))
    mantissa, _, exp = r.partition('e')
    whole, _, frac = mantissa.partition('.')
    digits = (whole + frac).lstrip('0')
    point = len(whole) + (int(exp) if exp else 0)
    if not digits:
        return '0', 1
    lead = len(whole + frac) - len((whole + frac).lstrip('0'))
    digits = digits.rstrip('0') or '0'
    return digits, point - lead


def num_str(x):
    """Number.prototype.toString() (ECMAScript Number::toString)."""
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, int):
        if abs(x) <= MAX_SAFE:
            return str(x)
        x = float(x)
    if x != x:
        return 'NaN'
    if x in (math.inf, -math.inf):
        return 'Infinity' if x > 0 else '-Infinity'
    if x == 0:
        return '0'
    if x < 0:
        return '-' + num_str(-x)
    d, n = _digits(x)
    k = len(d)
    if k <= n <= 21:
        return d + '0' * (n - k)
    if 0 < n <= 21:
        return d[:n] + '.' + d[n:]
    if -6 < n <= 0:
        return '0.' + '0' * (-n) + d
    e = n - 1
    return d[0] + ('.' + d[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e))


def to_js_string(v):
    """String(v) for JSON values."""
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if is_number(v):
        return num_str(v)
    if isinstance(v, list):
        return ','.join('' if x is None else to_js_string(x) for x in v)
    if isinstance(v, dict):
        return '[object Object]'
    return str(v)


def _string(s):
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == '\\':
            out.append('\\\\')
        elif o < 0x20:
            out.append({'\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'}.get(ch) or f'\\u{o:04x}')
        elif 0xd800 <= o <= 0xdfff:
            out.append(f'\\u{o:04x}')
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def dumps(v):
    """JSON.stringify(v)."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if is_number(v):
        if isinstance(v, float) and (v != v or v in (math.inf, -math.inf)):
            return 'null'
        return num_str(v)
    if isinstance(v, str):
        return _string(v)
    if isinstance(v, (list, tuple)):
        return '[' + ','.join(dumps(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(_string(str(k)) + ':' + dumps(x) for k, x in v.items()) + '}'
    raise TypeError(f'Cannot serialize {type(v).__name__}')


def loads(text, fallback):
    """V5.7.7 parse(json, fallback): the parsed value, or the fallback for invalid JSON or null."""
    import json
    try:
        v = json.loads(text) if isinstance(text, str) else None
    except (ValueError, TypeError):
        return fallback
    return fallback if v is None else _ints(v)


def _ints(v):
    if isinstance(v, float):
        return num(v)
    if isinstance(v, list):
        return [_ints(x) for x in v]
    if isinstance(v, dict):
        return {k: _ints(x) for k, x in v.items()}
    return v


def same(a, b):
    """JSON.stringify(a ?? null) === JSON.stringify(b ?? null)."""
    return dumps(a) == dumps(b)


def parse_int(v):
    """Number.parseInt(v, 10), or None for NaN."""
    m = re.match(r'^[' + re.escape(WS) + r']*([+-]?[0-9]+)', to_js_string(v) if v is not None else '')
    return int(m.group(1)) if m else None


def number(v):
    """Number(v) for strings and JSON values (NaN as float('nan'))."""
    from core.validation import js_number
    return js_number(v)


def locale(n):
    """n.toLocaleString('en-US') for integers."""
    return f'{int(n):,}'


def fmt(n, decimals=None):
    """Intl.NumberFormat('en-US', …).format(n): ICU rounds the shortest decimal form half away from zero."""
    if decimals is None:
        q = Decimal('0.000001')
    else:
        q = Decimal(1).scaleb(-decimals)
    d = Decimal(repr(float(n))) if isinstance(n, float) else Decimal(n)
    with localcontext() as ctx:
        ctx.prec = 700   # formula results reach 1e300; every digit is shown, as Intl does
        r = d.quantize(q, rounding=ROUND_HALF_UP)
    negative = d.is_signed()   # Intl shows -0 for negative values that round to zero
    whole, _, frac = format(abs(r), 'f').partition('.')
    if decimals is None:
        frac = frac.rstrip('0')
    body = f'{int(whole):,}' + ('.' + frac if frac else '')
    return ('-' if negative else '') + body


def length(s):
    return js_length(s)

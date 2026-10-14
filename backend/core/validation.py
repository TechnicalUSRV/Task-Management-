"""Input checks ported from service.mjs so messages and limits stay identical to V5.7.7."""
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
        fail(f'{label} is required.' if isinstance(value, str) or value is None else f'{label} must be text.')
    trimmed = value.strip()
    if js_length(trimmed) > max_length:
        fail(f'{label} must be at most {max_length} characters.')
    return trimmed


def choice(value, options, label):
    if value in options:
        return value
    fail(f'Choose a valid {label}.')


def integer(value, minimum, maximum, label):
    if isinstance(value, bool):
        fail(f'Invalid {label}.')
    try:
        number = int(value) if isinstance(value, int) or (isinstance(value, str) and re.fullmatch(r'-?\d+', value.strip())) else None
    except (TypeError, ValueError):
        number = None
    if number is None and isinstance(value, float) and value.is_integer():
        number = int(value)
    if number is None or number < minimum or number > maximum:
        fail(f'Invalid {label}.')
    return number


_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def date_text(value, label):
    s = text(value, label, 10, True)
    if not _DATE.match(s):
        fail(f'Enter a valid {label}.')
    try:
        datetime.strptime(s, '%Y-%m-%d')
    except ValueError:
        fail(f'Enter a valid {label}.')
    return s


def iso(dt):
    """Timestamps in the exact form V5.7.7 sends: 2026-10-15T03:04:05.678Z."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def is_record_id(value):
    return isinstance(value, str)

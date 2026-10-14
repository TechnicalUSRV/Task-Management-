"""Repeating tasks — port of recurrence.mjs (V5.7.0 custom repeat rules)."""
import calendar
import json
import re
from datetime import date

from .domain import add_days, days_between, weekday_js


class RuleError(ValueError):
    pass


def _week(d):
    return add_days(d, -((weekday_js(d) + 6) % 7))


def _valid_day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r'\s*-?\d+\s*', value):
        return int(value)
    return None


def normalize_rule(frequency, value, anchor):
    if not frequency:
        return {}
    if frequency not in ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'):
        raise RuleError('Choose a repeat frequency.')
    r = value or {}
    if isinstance(r, str):
        try:
            r = json.loads(r)
        except ValueError:
            raise RuleError('Invalid repeat schedule.') from None
    if not isinstance(r, dict):
        raise RuleError('Invalid repeat schedule.')
    interval = _int(r.get('interval', 1) if r.get('interval') is not None else 1)
    if interval is None or interval < 1 or interval > 365:
        raise RuleError('Repeat interval must be a whole number from 1 to 365.')
    out = {'interval': interval, 'anchor': r.get('anchor') or anchor}
    if not _valid_day(out['anchor']):
        raise RuleError('Invalid repeat anchor.')
    if frequency == 'WEEKLY':
        days = r.get('weekdays') if r.get('weekdays') is not None else [weekday_js(anchor)]
        if not isinstance(days, list) or not days or any(not isinstance(x, int) or isinstance(x, bool) or x < 0 or x > 6 for x in days):
            raise RuleError('Select at least one weekday.')
        out['weekdays'] = sorted(set(days))
    if frequency == 'MONTHLY':
        month_day = _int(r.get('month_day') if r.get('month_day') is not None else anchor[8:])
        if month_day is None or month_day < 1 or month_day > 31:
            raise RuleError('Month day must be from 1 to 31.')
        out['month_day'] = month_day
    return out


def scheduled_next(frequency, start, anchor_day, value):
    r = normalize_rule(frequency, value, start)
    if not frequency:
        return None
    if frequency == 'DAILY':
        return add_days(start, r['interval'])
    if frequency == 'WEEKDAYS':
        d, n = start, 0
        while n < r['interval']:
            d = add_days(d, 1)
            if weekday_js(d) not in (0, 6):
                n += 1
        return d
    if frequency == 'WEEKLY':
        for i in range(1, 7 * r['interval'] + 8):
            d = add_days(start, i)
            weeks = days_between(_week(r['anchor']), _week(d)) // 7
            if weeks >= 0 and weeks % r['interval'] == 0 and weekday_js(d) in r['weekdays']:
                return d
    if frequency == 'MONTHLY':
        y, m = (int(x) for x in start.split('-')[:2])
        ay, am = (int(x) for x in r['anchor'].split('-')[:2])
        origin = ay * 12 + am - 1
        for i in range(0, r['interval'] + 2):
            idx = y * 12 + m - 1 + i
            if (idx - origin) % r['interval']:
                continue
            yy, mm = idx // 12, idx % 12 + 1
            last = calendar.monthrange(yy, mm)[1]
            d = f"{yy}-{mm:02d}-{min(r.get('month_day') or anchor_day, last):02d}"
            if d > start:
                return d
    raise RuleError('Unable to calculate next occurrence.')

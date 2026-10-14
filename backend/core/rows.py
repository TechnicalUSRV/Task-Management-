"""Model instances as the plain rows V5.7.7 sent and used internally.

Keys are the database column names (owner_id, org_level, …), datetimes are ISO strings ending in Z, and booleans are
0/1 — exactly what the SQLite service returned — so the frontend and the ported rules see identical data.
"""
from datetime import date, datetime

from .validation import iso


def value(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, datetime):
        return iso(v)
    if isinstance(v, date):
        return v.isoformat()
    return v


def row(instance, exclude=()):
    if instance is None:
        return None
    return {f.column: value(getattr(instance, f.attname)) for f in instance._meta.concrete_fields if f.column not in exclude}


def rows(queryset, exclude=()):
    return [row(item, exclude) for item in queryset]

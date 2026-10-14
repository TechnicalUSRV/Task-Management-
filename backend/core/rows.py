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


def _columns(model):
    cache = model.__dict__.get('_column_map')
    if cache is None:
        cache = {f.column: f for f in model._meta.concrete_fields}
        model._column_map = cache
    return cache


def db_values(model, data):
    """Column-named values (as V5.7.7 writes them) to ORM keyword arguments (attnames, real booleans)."""
    from django.db import models as m
    columns, out = _columns(model), {}
    for column, value in data.items():
        field = columns.get(column)
        if field is None:
            raise KeyError(f'{model._meta.db_table} has no column {column}')
        if isinstance(field, m.BooleanField) and value is not None:
            value = bool(value)
        out[field.attname] = value
    return out


def insert(model, data):
    """INSERT one row from column-named values; returns the saved instance."""
    return model.objects.create(**db_values(model, data))


def update(model, key, data, field='pk'):
    """UPDATE one row (by primary key) from column-named values."""
    if data:
        model.objects.filter(**{field: key}).update(**db_values(model, data))

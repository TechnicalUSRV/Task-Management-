"""Account-scoped messages shared by HTTP, reports and background Telegram workers.

Only explicitly marked source text is translated. Message parameters (people's names,
task descriptions, etc.) stay verbatim. English remains the canonical stored wording.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
import json
from pathlib import Path
import re

LANGUAGES = ('en', 'km', 'zh-CN')
_language = ContextVar('employee_language', default='en')
_PARAM = re.compile(r'\{([a-zA-Z][a-zA-Z0-9_]*)\}')


def normalize_language(value):
    return value if value in LANGUAGES else 'en'


def current_language():
    return _language.get()


def activate(value):
    return _language.set(normalize_language(value))


@contextmanager
def language(value):
    token = activate(value)
    try:
        yield
    finally:
        _language.reset(token)


@lru_cache(maxsize=3)
def catalog(locale):
    path = Path(__file__).resolve().parents[2] / 'translations' / f'{normalize_language(locale)}.json'
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def text(source, params=None, locale=None):
    locale = normalize_language(locale or current_language())
    translated = catalog(locale).get(source) if locale != 'en' else source
    translated = translated or source
    # A broken translation must never hide values or produce broken placeholders.
    if set(_PARAM.findall(translated)) != set(_PARAM.findall(source)):
        translated = source
    values = params or {}
    return _PARAM.sub(lambda m: str(render(values[m[1]], locale)) if m[1] in values else m[0], translated)


class Message(str):
    """A canonical English string carrying a safe translation template and values."""
    def __new__(cls, source, **params):
        obj = super().__new__(cls, text(source, params, 'en'))
        obj.source, obj.params = source, params
        return obj

    def __add__(self, other):
        return Message('{p0}{p1}', p0=self, p1=other)

    def __radd__(self, other):
        return Message('{p0}{p1}', p0=other, p1=self)


def msg(source, **params):
    return Message(source, **params)


def render(value, locale=None):
    if isinstance(value, Message):
        return text(value.source, value.params, locale)
    if isinstance(value, dict):
        return {k: render(v, locale) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [render(v, locale) for v in value]
    return value


def pack(value):
    if isinstance(value, Message):
        return {'template': value.source, 'params': {k: pack(v) for k, v in value.params.items()}}
    return {'literal': str(value)}


def unpack(value):
    if not isinstance(value, dict):
        return ''
    if 'template' in value:
        return msg(value['template'], **{k: unpack(v) for k, v in value.get('params', {}).items()})
    return value.get('literal', '')


def staff_language(staff_id):
    from accounts.models import User
    return normalize_language(User.objects.filter(staff_id=staff_id, active=True).values_list('language', flat=True).first())


def notification_text(record, locale):
    """Localize only metadata recorded at creation; legacy/user wording stays intact."""
    result = dict(record)
    metadata = result.pop('translation', None) or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            metadata = {}
    for field in ('title', 'body'):
        if field in metadata:
            result[field] = render(unpack(metadata[field]), locale)
    return result

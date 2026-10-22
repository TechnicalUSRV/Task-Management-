"""Each employee may change only their own language, independently of task scope."""
from django.db import transaction
from core.errors import fail
from core.i18n import LANGUAGES, activate, msg
from core.services import changed
from .models import User


def save_language(user, data):
    if not user or not user.active:
        fail(msg('Sign in to continue.'), 401)
    if set(data) != {'language'} or data.get('language') not in LANGUAGES:
        fail(msg('Choose English, ភាសាខ្មែរ or 简体中文.'))
    value = data['language']
    with transaction.atomic():
        User.objects.filter(pk=user.pk, active=True).update(language=value)
        changed()
    user.language = value
    activate(value)
    return {'language': value, 'message': msg('Language saved.')}

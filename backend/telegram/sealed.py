"""The bot token is kept encrypted in the database (Fernet: AES-128-CBC + HMAC-SHA256).

The key is derived from DJANGO_SECRET_KEY (or TELEGRAM_TOKEN_KEY when set), so a copy of the database alone does not
reveal the token. If the key changes, the stored token can no longer be read: the bot stops and Administration →
Telegram asks for the token again. A value without the prefix is a token saved before encryption and is read as is.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings

PREFIX = 'enc1:'


def _fernet():
    secret = os.environ.get('TELEGRAM_TOKEN_KEY') or settings.SECRET_KEY
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(b'telegram-bot-token\0' + secret.encode()).digest()))


def seal(token):
    return PREFIX + _fernet().encrypt(token.encode()).decode() if token else ''


def unseal(stored):
    if not stored or not stored.startswith(PREFIX):
        return stored or ''
    try:
        return _fernet().decrypt(stored[len(PREFIX):].encode()).decode()
    except (InvalidToken, ValueError):
        return ''

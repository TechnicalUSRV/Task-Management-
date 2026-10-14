"""Automated tests: an isolated SQLite database, never SQL Server company data."""
import os

os.environ['DB_ENGINE'] = 'sqlite'
os.environ.setdefault('DJANGO_DEBUG', 'yes')
os.environ.setdefault('DJANGO_SECRET_KEY', 'tests-only')

from .settings import *  # noqa: E402,F401,F403

DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}
# Fast hashing in tests only; production uses Django's PBKDF2 default.
PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher', 'accounts.hashers.NodeScryptPasswordHasher']

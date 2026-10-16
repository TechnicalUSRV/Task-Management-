"""Django settings for the Task Controlling Management backend.

Every deployment-specific value comes from environment variables (or backend/.env, which is never committed).
See backend/.env.example. The React frontend never receives any of these values.
"""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and (value is None or value == ''):
        raise ImproperlyConfigured(f'Set {name} in backend/.env (see .env.example).')
    return value


def env_bool(name, default=False):
    return str(env(name, 'yes' if default else 'no')).strip().lower() in {'1', 'true', 'yes', 'on'}


def env_list(name, default=''):
    return [item.strip() for item in str(env(name, default)).split(',') if item.strip()]


DEBUG = env_bool('DJANGO_DEBUG', False)
SECRET_KEY = env('DJANGO_SECRET_KEY', required=not DEBUG) or 'insecure-local-development-key-only'
ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', '127.0.0.1,localhost')

# Browser origins allowed to send state-changing requests (the existing app checks Origin on every POST).
# The Vite dev server proxies /c/<company>/api to Django, so its own origin is listed here for development.
TRUSTED_ORIGINS = env_list('DJANGO_TRUSTED_ORIGINS', 'http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173')
CSRF_TRUSTED_ORIGINS = TRUSTED_ORIGINS
# Photos and files are readable only by pages of the same origin (V5.7.7). A React app on another origin of the same
# site (VITE_API_BASE_URL) needs 'same-site' here so its <img> tags can show them.
CROSS_ORIGIN_RESOURCE_POLICY = env('CROSS_ORIGIN_RESOURCE_POLICY', 'same-origin')
# Deployment checks that do not apply: writes are protected as in V5.7.7 (Origin check on every state-changing request
# and SameSite=Strict, HttpOnly session cookies; there are no HTML forms), and framing is refused by the
# Content-Security-Policy frame-ancestors 'none' — except the Telegram Mini App page, which Telegram shows in a frame.
SILENCED_SYSTEM_CHECKS = ['security.W002', 'security.W003']
if CROSS_ORIGIN_RESOURCE_POLICY not in ('same-origin', 'same-site'):
    raise ImproperlyConfigured('CROSS_ORIGIN_RESOURCE_POLICY must be same-origin or same-site.')

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'django.contrib.auth',
    'rest_framework',
    'core',
    'accounts',
    'organization',
    'workspaces',
    'audit',
    'notifications',
    'tasks',
    'timesheets',
    'meetings',
    'groups',
    'telegram',
    'compat',
]

MIDDLEWARE = [
    'core.middleware.TrustedOriginCorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.middleware.common.CommonMiddleware',
    'core.middleware.CompanyScopeMiddleware',
    'core.middleware.SecurityHeadersMiddleware',
]

ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
TEMPLATES = []

# ---------------------------------------------------------------- database
# DB_ENGINE=mssql (default) connects to Microsoft SQL Server through ODBC Driver 18.
# DB_ENGINE=sqlite is for automated tests and offline development only; it is never used for company data.
DB_ENGINE = env('DB_ENGINE', 'mssql').strip().lower()
if DB_ENGINE == 'mssql':
    extra = [f"TrustServerCertificate={'yes' if env_bool('DB_TRUST_SERVER_CERTIFICATE', False) else 'no'}",
             f"Encrypt={env('DB_ENCRYPT', 'yes')}"]
    DATABASES = {
        'default': {
            'ENGINE': 'mssql',
            'HOST': env('DB_HOST', required=True),
            'PORT': env('DB_PORT', ''),
            'NAME': env('DB_NAME', required=True),
            'USER': env('DB_USER', required=True),
            'PASSWORD': env('DB_PASSWORD', required=True),
            'ATOMIC_REQUESTS': False,
            'CONN_MAX_AGE': int(env('DB_CONN_MAX_AGE', '60')),
            # Do not enable 'return_rows_bulk_insert': it inserts with OUTPUT INSERTED, which SQL Server refuses on
            # tables with triggers (tm_members, tm_workspaces, org_audit). The default SCOPE_IDENTITY() is trigger-safe.
            'OPTIONS': {
                'driver': env('DB_DRIVER', 'ODBC Driver 18 for SQL Server'),
                'extra_params': ';'.join(extra),
            },
        }
    }
    _forbidden = {'sa'}
    if DATABASES['default']['USER'].strip().lower() in _forbidden:
        raise ImproperlyConfigured('Do not run the application as "sa". Use the dedicated least-privilege login.')
elif DB_ENGINE == 'sqlite':
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': env('DB_SQLITE_PATH', str(BASE_DIR / 'local-dev.sqlite3'))}}
else:
    raise ImproperlyConfigured('DB_ENGINE must be "mssql" or "sqlite".')

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
AUTH_USER_MODEL = 'accounts.User'

# Existing V5.7.x hashes (Node scrypt) are verified and upgraded to Django's default on the next sign-in.
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
    'accounts.hashers.NodeScryptPasswordHasher',
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = False
USE_TZ = True

# ---------------------------------------------------------------- sessions (same behavior as V5.7.7)
SESSION_HOURS = 8
SESSION_COOKIE_SECURE_FLAG = env_bool('SESSION_COOKIE_SECURE', False)
# First-administrator setup is accepted only from the server computer itself unless this is enabled.
ALLOW_REMOTE_SETUP = env_bool('DJANGO_ALLOW_REMOTE_SETUP', False)
# The only company in this deployment. URLs keep the existing /c/<company>/ form.
COMPANY_ID = env('COMPANY_ID', 'default')
# The built React app (npm run build → source/local-test/public). Django serves it when present, so one address works.
FRONTEND_DIR = Path(env('FRONTEND_DIR', str(BASE_DIR.parent / 'source' / 'local-test' / 'public')))
# Functions this deployment does not offer: the Google Sheets connection (Stage 1 decision A). Groups were hidden too in
# Stage 1 and are offered again (restored to V5.7.7 behaviour); list `tasks.groups` here only to switch Groups off.
HIDDEN_FUNCTIONS = tuple(x.strip() for x in env('HIDDEN_FUNCTIONS', 'admin.integrations').split(',') if x.strip())
# The public https:// address of this server when it is published (Telegram opens the Mini App there). Empty locally.
PUBLIC_URL = env('PUBLIC_URL', '').rstrip('/')
# The built React app is served from FRONTEND_DIR by compat.views.frontend (/assets/…); Django's static files are unused.
STATIC_URL = '/static/'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['accounts.authentication.SessionTokenAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'DEFAULT_PARSER_CLASSES': ['rest_framework.parsers.JSONParser'],
    'EXCEPTION_HANDLER': 'core.errors.exception_handler',
    'UNAUTHENTICATED_USER': None,
}

# Request bodies carry base64 task files of up to 30 MB (about 40 MB encoded), as in V5.7.7.
DATA_UPLOAD_MAX_MEMORY_SIZE = 43 * 1024 * 1024

SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': env('DJANGO_LOG_LEVEL', 'INFO')},
}

"""Public Mini App entry point. Bind to loopback and tunnel ONLY this process.

From backend:
    .venv\\Scripts\\waitress-serve.exe --listen=127.0.0.1:8001 config.mini_wsgi:application

The office process continues to use config.wsgi:application on its LAN address.
"""
from django.conf import settings

from config.wsgi import application as django_application
from core.mini_boundary import MiniAppBoundary

application = MiniAppBoundary(django_application, settings.COMPANY_ID)

"""Creates or updates the tables in TaskManagement_Production with the migration login:

    python manage.py migrate_database

The running application connects as taskmanagement_app, which cannot change the schema. This command asks for the
password of the migration login (taskmanagement_migrator, or --user / DB_MIGRATION_USER), uses it only for this run,
and never stores it. With DB_ENGINE=sqlite (tests, offline development) it simply runs `migrate`.
"""
import getpass
import os

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connections


class Command(BaseCommand):
    help = 'Apply database migrations with the migration login (its password is asked for and not stored).'

    def add_arguments(self, parser):
        parser.add_argument('--user', default=os.environ.get('DB_MIGRATION_USER', 'taskmanagement_migrator'),
                            help='SQL Server login allowed to change the schema (default taskmanagement_migrator).')

    def handle(self, *args, **options):
        db = connections['default']
        if db.vendor != 'microsoft':
            call_command('migrate', interactive=False, verbosity=options['verbosity'])
            return
        user = options['user'].strip()
        if not user or user.lower() == 'sa':
            raise CommandError('Use the dedicated migration login (taskmanagement_migrator), never "sa".')
        password = os.environ.get('DB_MIGRATION_PASSWORD') or getpass.getpass(f'Password for SQL Server login {user}: ')
        if not password:
            raise CommandError('No password entered; nothing was changed.')
        saved = db.settings_dict['USER'], db.settings_dict['PASSWORD']
        db.close()
        db.settings_dict['USER'], db.settings_dict['PASSWORD'] = user, password
        try:
            call_command('migrate', interactive=False, verbosity=options['verbosity'])
        finally:
            db.close()
            db.settings_dict['USER'], db.settings_dict['PASSWORD'] = saved
        self.stdout.write(self.style.SUCCESS(f'Migrations applied as {user}.'))
        self.stdout.write('Next: the DBA protects the audit tables (DENY statements at the end of docs/backend-migration/sqlserver-logins.sql), '
                          'then run: python manage.py check_database')

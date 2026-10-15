"""Checks the database connection and the safety rules for SQL Server before the application is used:

    python manage.py check_database

It reports the server, database and login in use and refuses (exit code 1) when the login is `sa` or a sysadmin, when
the connected database is not the one configured in backend/.env, or when migrations are missing. It warns when the
login can change the schema (that is the migration login's job, not the running application's), when the audit
tables are not protected from UPDATE/DELETE, and when the login can open other user databases on the server.
Nothing is changed.
"""
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

AUDIT_TABLES = ('org_audit', 'access_audit', 'tm_task_history')
SYSTEM_DATABASES = {'master', 'tempdb', 'model', 'msdb'}
EXPECTED_TABLES = ('access_users', 'staff', 'tm_profiles', 'tm_workspaces', 'tm_members', 'tm_tasks', 'tm_assignees', 'tm_task_history',
                   'tm_meetings', 'tm_timesheets', 'tm_notifications', 'org_settings', 'org_requests', 'org_audit', 'tg_settings')


def one(cursor, sql, *args):
    cursor.execute(sql, args)
    row = cursor.fetchone()
    return row[0] if row else None


def sqlserver_checks(cursor, configured_name):
    """[(level, message)] with level 'ok', 'warn' or 'fail' — SQL Server only."""
    out = []
    server, database, login = one(cursor, 'SELECT @@SERVERNAME'), one(cursor, 'SELECT DB_NAME()'), one(cursor, 'SELECT SUSER_SNAME()')
    version = (one(cursor, 'SELECT CAST(SERVERPROPERTY(\'ProductVersion\') AS nvarchar(64))') or '').strip()
    out.append(('ok', f'Connected to {server} (SQL Server {version}), database {database}, login {login}.'))
    if (database or '').lower() != (configured_name or '').lower():
        out.append(('fail', f'Connected to database "{database}" but DB_NAME is "{configured_name}". Check DB_NAME and the login\'s default database.'))
    if (login or '').lower() == 'sa':
        out.append(('fail', 'The application is connected as "sa". Use the dedicated least-privilege login (taskmanagement_app).'))
    if one(cursor, "SELECT IS_SRVROLEMEMBER('sysadmin')") == 1:
        out.append(('fail', f'Login {login} is a sysadmin. The application login must not have server-wide rights.'))
    if one(cursor, "SELECT IS_MEMBER('db_owner')") == 1:
        out.append(('warn', f'Login {login} is db_owner of {database}. The running application needs only db_datareader and db_datawriter.'))
    if one(cursor, "SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE')") == 1:
        out.append(('warn', f'Login {login} can change the schema. That is right for running migrations (taskmanagement_migrator); '
                            'run the application itself as taskmanagement_app.'))
    else:
        out.append(('ok', f'Login {login} cannot change the schema.'))
    cursor.execute('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1')
    others = sorted(r[0] for r in cursor.fetchall() if r[0].lower() not in SYSTEM_DATABASES and r[0].lower() != (database or '').lower())
    if others:
        out.append(('warn', f'Login {login} can also open: {", ".join(others)}. Limit it to {database}.'))
    else:
        out.append(('ok', f'Login {login} has no access to other user databases.'))
    unprotected = []
    for table in AUDIT_TABLES:
        if one(cursor, 'SELECT OBJECT_ID(%s)', f'dbo.{table}') is None:
            continue
        if one(cursor, "SELECT HAS_PERMS_BY_NAME(%s, 'OBJECT', 'UPDATE')", f'dbo.{table}') == 1 or \
                one(cursor, "SELECT HAS_PERMS_BY_NAME(%s, 'OBJECT', 'DELETE')", f'dbo.{table}') == 1:
            unprotected.append(table)
    if unprotected:
        out.append(('warn', f'Login {login} may UPDATE or DELETE {", ".join(unprotected)}. For the application login, run the DENY statements at '
                            'the end of docs/backend-migration/sqlserver-logins.sql (the migration login keeps these rights).'))
    collation = one(cursor, "SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128))") or ''
    out.append(('ok' if '_CI_' in collation else 'warn', f'Database collation {collation}' + ('' if '_CI_' in collation else
                ' is case-sensitive; usernames are compared case-insensitively by the application, but a _CI_ collation is expected.')))
    return out


class Command(BaseCommand):
    help = 'Check the database connection, login rights and migrations (changes nothing).'

    def handle(self, *args, **options):
        marks = {'ok': self.style.SUCCESS('✓'), 'warn': self.style.WARNING('!'), 'fail': self.style.ERROR('✗')}
        results = []
        try:
            connection.ensure_connection()
        except Exception as e:   # noqa: BLE001 - shown to the person running the check
            raise CommandError(f'Cannot connect to the database: {e}\nCheck DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD in '
                               'backend/.env, that ODBC Driver 18 for SQL Server is installed, and that this computer can reach the server.')
        if connection.vendor == 'microsoft':
            with connection.cursor() as cursor:
                results += sqlserver_checks(cursor, settings.DATABASES['default']['NAME'])
        else:
            results.append(('warn', f'Using {connection.vendor} ({settings.DATABASES["default"]["NAME"]}). '
                                    'That is for tests and offline development only; company data belongs in SQL Server (DB_ENGINE=mssql).'))
        tables = set(connection.introspection.table_names())
        missing = [t for t in EXPECTED_TABLES if t not in tables]
        pending = MigrationExecutor(connection).migration_plan(MigrationExecutor(connection).loader.graph.leaf_nodes())
        if pending:
            results.append(('fail', f'{len(pending)} migration(s) not applied yet. Run: python manage.py migrate (with the migration login).'))
        elif missing:
            results.append(('fail', f'Tables missing although migrations are recorded: {", ".join(missing)}.'))
        else:
            results.append(('ok', f'All migrations applied; {len(tables)} tables present.'))
        for level, message in results:
            self.stdout.write(f'{marks[level]} {message}')
        failed = sum(1 for level, _ in results if level == 'fail')
        if failed:
            raise CommandError(f'{failed} problem(s) must be fixed before the application is used.')
        self.stdout.write(self.style.SUCCESS('Database check passed.') if not any(level == 'warn' for level, _ in results)
                          else 'Database check passed with warnings (see above).')

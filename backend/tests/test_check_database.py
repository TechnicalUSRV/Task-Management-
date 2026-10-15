"""manage.py check_database: the SQL Server safety checks (with a stand-in cursor) and the local run."""
import pytest
from django.core.management import call_command

from core.management.commands.check_database import sqlserver_checks


class FakeCursor:
    def __init__(self, answers, databases=('TaskManagement_Production', 'master', 'tempdb')):
        self.answers, self.databases, self.last = answers, databases, None

    def execute(self, sql, args=()):
        self.last = (sql, tuple(args))

    def fetchone(self):
        sql, args = self.last
        for key, value in sorted(self.answers.items(), key=lambda kv: -len(kv[0])):   # the most specific match
            if key in sql and (not isinstance(value, dict)):
                return (value,)
            if key in sql and isinstance(value, dict):
                return (value.get(args[0] if args else None),)
        return None

    def fetchall(self):
        return [(d,) for d in self.databases]


SAFE = {'@@SERVERNAME': 'SERVERSYSTEM', 'DB_NAME()': 'TaskManagement_Production', 'SUSER_SNAME()': 'taskmanagement_app',
        'ProductVersion': '16.0.4135.4', "IS_SRVROLEMEMBER('sysadmin')": 0, "IS_MEMBER('db_owner')": 0, "'CREATE TABLE'": 0,
        'OBJECT_ID': {f'dbo.{t}': 1 for t in ('org_audit', 'access_audit', 'tm_task_history')}, "'OBJECT', 'UPDATE'": 0,
        "'OBJECT', 'DELETE'": 0, "DATABASEPROPERTYEX(DB_NAME(), 'Collation')": 'SQL_Latin1_General_CP1_CI_AS'}


def levels(results):
    return [level for level, _ in results]


def test_least_privilege_application_login_passes():
    results = sqlserver_checks(FakeCursor(SAFE), 'TaskManagement_Production')
    assert 'fail' not in levels(results) and 'warn' not in levels(results), results


@pytest.mark.parametrize('change, words', [
    ({'SUSER_SNAME()': 'sa'}, '"sa"'),
    ({"IS_SRVROLEMEMBER('sysadmin')": 1}, 'sysadmin'),
    ({'DB_NAME()': 'OtherCompanyDb'}, 'DB_NAME is'),
])
def test_unsafe_logins_and_wrong_databases_fail(change, words):
    results = sqlserver_checks(FakeCursor({**SAFE, **change}), 'TaskManagement_Production')
    assert any(level == 'fail' and words in message for level, message in results), results


def test_migration_login_rights_and_open_audit_tables_warn():
    results = sqlserver_checks(FakeCursor({**SAFE, "'CREATE TABLE'": 1, "'OBJECT', 'UPDATE'": 1},
                                          databases=('TaskManagement_Production', 'Payroll', 'master')), 'TaskManagement_Production')
    messages = ' | '.join(m for level, m in results if level == 'warn')
    assert 'can change the schema' in messages and 'Payroll' in messages and 'DENY' in messages


def test_local_database_check_runs(db, capsys):
    call_command('check_database')
    out = capsys.readouterr().out
    assert 'for tests and offline development only' in out and 'All migrations applied' in out

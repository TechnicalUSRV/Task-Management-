/*
  Task Controlling Management — SQL Server logins for TaskManagement_Production
  Run in SQL Server Management Studio as a DBA account. Replace the two <...> passwords locally;
  never save real passwords in this file or in Git.

  Two logins, both limited to TaskManagement_Production:
    taskmanagement_migrator  creates/changes tables (used only when running `python manage.py migrate`)
    taskmanagement_app       the running application: read/write data only, no schema changes
  Neither is sysadmin, and neither has any access to other databases on SERVERSYSTEM.
*/
USE [master];
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'taskmanagement_migrator')
    CREATE LOGIN [taskmanagement_migrator] WITH PASSWORD = N'<strong password for migrations>',
        DEFAULT_DATABASE = [TaskManagement_Production], CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'taskmanagement_app')
    CREATE LOGIN [taskmanagement_app] WITH PASSWORD = N'<strong password for the application>',
        DEFAULT_DATABASE = [TaskManagement_Production], CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;
GO

USE [TaskManagement_Production];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'taskmanagement_migrator')
    CREATE USER [taskmanagement_migrator] FOR LOGIN [taskmanagement_migrator] WITH DEFAULT_SCHEMA = [dbo];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'taskmanagement_app')
    CREATE USER [taskmanagement_app] FOR LOGIN [taskmanagement_app] WITH DEFAULT_SCHEMA = [dbo];
GO

-- Migrations: create and alter tables, indexes, constraints and triggers in this database only.
ALTER ROLE [db_ddladmin]   ADD MEMBER [taskmanagement_migrator];
ALTER ROLE [db_datareader] ADD MEMBER [taskmanagement_migrator];
ALTER ROLE [db_datawriter] ADD MEMBER [taskmanagement_migrator];

-- Application: read and write rows only.
ALTER ROLE [db_datareader] ADD MEMBER [taskmanagement_app];
ALTER ROLE [db_datawriter] ADD MEMBER [taskmanagement_app];
GO

/*
  After the first `python manage.py migrate` (run with the migrator login), protect the audit history so the
  application cannot rewrite it, even if its password leaks:

    DENY UPDATE, DELETE ON OBJECT::dbo.org_audit    TO [taskmanagement_app];
    DENY UPDATE, DELETE ON OBJECT::dbo.access_audit TO [taskmanagement_app];
    DENY UPDATE, DELETE ON OBJECT::dbo.tm_task_history TO [taskmanagement_app];

  Check what each login can do:
    EXECUTE AS LOGIN = N'taskmanagement_app';
    SELECT * FROM fn_my_permissions(NULL, 'DATABASE');
    REVERT;
*/

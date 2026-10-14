# Connect Task Management to Microsoft SQL Server: preparation

## What is ready

This folder checks whether Node.js can sign in to your separate SQL Server database and exchange a Unicode parameter. It runs SELECT statements only. A successful check does not switch the application to SQL Server or create application tables.

The reviewed V5.7.7 code at commit `9575cc0` uses a Node.js backend and SQLite. `source/local-test/service.mjs` opens `node:sqlite` directly; `company-hub.mjs` creates a company registry and a separate SQLite file for each company. There is no SQL Server runtime adapter in this version. The Django setup from a separate project is not used by this code.

## 1. Record your SQL Server details

Open SSMS, connect to the intended SQL Server as your administrator, select New Query, and run `inspect-server.sql` from this folder. Keep the results. Use the actual server name shown in your SSMS connection; `localhost` only works when the application runs on the same computer as SQL Server.

Confirm the exact new database name. This guide uses `TaskManagement_Test` as an example. If it already exists, use it without recreating or deleting it. Check whether it already contains tables or records from the earlier Django setup before choosing it as a migration target. The future migration must use an agreed empty database or a reviewed mapping; it must not overwrite unrelated tables.

If a database has not yet been created, in SSMS right-click Databases, choose New Database, enter `TaskManagement_Test`, and leave the server's configured file locations unless your administrator specifies other locations. Click OK and refresh Databases. Paths in that dialog refer to the SQL Server computer.

## 2. Confirm a dedicated application login

Use the SQL login you created, for example `taskmanagement_app`, rather than the SQL administrator account. Under Security > Logins > the login's Properties > User Mapping, map it to the new Task Management database. The connection check needs a valid database user and permission to connect; it does not need sysadmin or db_owner.

If you previously ran a CREATE LOGIN example with a placeholder password, change the password in that login's Properties > General page before testing. Do not delete and recreate the login. Enter the new password only on your computer.

SQL authentication requires SQL Server and Windows Authentication mode. `windows_auth_only = 1` in the inspection output means the instance currently accepts Windows authentication only. Any authentication-mode change and SQL Server restart on a shared company server must be scheduled with its administrator because it affects other applications.

The checker currently uses SQL authentication. If your company requires Windows integrated authentication, report that requirement before configuring it; the driver setup is different.

## 3. Confirm the network endpoint

Use SQL Server Configuration Manager to inspect SQL Server Network Configuration > Protocols for the intended instance. Node's driver requires TCP/IP. Prefer the existing configured TCP port. Do not assume 1433 is correct for a named instance such as SQLEXPRESS01.

You can either use:

- Host plus the instance's TCP port; or
- Host plus instance name, with SQL Server Browser available and its UDP discovery port reachable.

The checker requires exactly one of port or instance. If TCP/IP must be enabled or the listener configuration changed, plan the SQL Server service restart with the administrator. For a different application computer, allow that computer through the server firewall on the required SQL port. Keep SQL Server on the private network; Telegram users connect to the application backend.

## 4. Get this branch and install the checker

For a new local copy, open PowerShell in the folder where you keep projects:

```powershell
git clone --branch codex/sqlserver-connection https://github.com/TechnicalUSRV/Task-Management-.git TaskManagement-SQL-Preparation
cd TaskManagement-SQL-Preparation\tools\sqlserver
node --version
npm ci
Copy-Item .env.example .env
notepad .env
```

Use Node.js 24 or newer. If you already copied `.env`, edit that existing file rather than copying over it. The private repository requires your GitHub account to be signed in through Git's normal authentication flow.

## 5. Fill in the configuration on your computer

In `.env`, set the actual host, database name, and login. Type the password locally, preferably inside quotes (needed when the password contains `#` or surrounding spaces). Do not paste the password in a chat or commit `.env` to GitHub.

For a named instance example, the values would be:

```dotenv
SQLSERVER_HOST=YOUR-SERVER-NAME
SQLSERVER_DATABASE=TaskManagement_Test
SQLSERVER_USER=taskmanagement_app
SQLSERVER_PASSWORD=
SQLSERVER_PORT=
SQLSERVER_INSTANCE=SQLEXPRESS01
SQLSERVER_TRUST_SERVER_CERTIFICATE=false
```

`YOUR-SERVER-NAME` and the instance/database names must be replaced with your real settings. If using a TCP port instead, fill `SQLSERVER_PORT` and empty `SQLSERVER_INSTANCE`. Keep encryption enabled. Certificate validation is enabled by default; a known local test instance with a self-signed certificate may require `SQLSERVER_TRUST_SERVER_CERTIFICATE=true`. For production, configure a trusted SQL Server certificate and use `false`.

Run:

```powershell
npm run check
```

A successful result prints `SQL Server connection: PASSED`, the actual server/database/login, and `Unicode: PASSED` in the output table. It only reads metadata and echoes a parameter. A zero visible-table count is normal for a new empty database and can also reflect the login's metadata visibility.

If it fails, use the displayed category to verify the host/port, login mapping, SQL authentication, and certificate configuration. Raw driver errors and passwords are intentionally not printed. Send the result or error category along with the exact server and database names; omit the password and `.env` file.

## 6. Application migration still required

After connectivity is verified, the remaining implementation is:

1. Decide whether to preserve the existing separate-database-per-company isolation or introduce a reviewed tenant model for a shared database. A single new database can hold one company's data without silently combining other companies' records.
2. Add asynchronous pooled SQL Server database access throughout Task Management, shared authentication, organization permissions, and Telegram. Current helpers and request handlers expect synchronous results, so replacing the driver import alone is insufficient.
3. Convert SQLite-specific schema and queries (`PRAGMA`, `LIMIT`, `INSERT OR IGNORE`, `ON CONFLICT`, `RETURNING`, and transaction statements) to SQL Server equivalents. Preserve identifier uniqueness, optimistic version checks, Unicode text, binary attachments, and atomic approvals.
4. Introduce versioned SQL Server migrations and separate schema-setup privileges from normal application read/write privileges. Do not execute the current SQLite `.sql` files in SSMS.
5. If existing records must be retained, stop the existing app and back up the complete data directory, including encryption keys and all company databases. Migrate into the agreed target and verify counts, relationships, users, attachments, and encrypted integrations. Synthetic fixtures in GitHub are not employee data.
6. Test login, workspaces, tasks, role and hierarchy permissions, approvals, timesheets, and Telegram against SQL Server, including concurrent updates. Only switch the running app after these checks pass. Keep a pre-migration backup for rollback; new SQL Server records require a separate reconciliation plan if reverting later.

Focus remains Task Management and Telegram. Shared authentication and storage dependencies must be preserved even when other ERP modules are not being expanded.

## Verification and limits

Run `npm test` for configuration and credential-redaction checks. These tests do not prove SQL Server connectivity. A live connection check must run on a machine that can reach your SQL Server. No application storage migration is performed by this preparation.

References:
- [Microsoft: connect to SQL Server using Node.js](https://learn.microsoft.com/en-us/sql/connect/node-js/step-3-proof-of-concept-connecting-to-sql-using-node-js)
- [node-mssql configuration and connection documentation](https://tediousjs.github.io/node-mssql/)
- [Microsoft: SERVERPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/serverproperty-transact-sql)

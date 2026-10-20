# Deployment and rollback — Live Data, management scope, calendar, single-user tasks, Send to Telegram

Not deployed. Deploy only a reviewed commit of `feature/live-data-management-scope`, after staging acceptance on SQL
Server. The procedure is the one in [../group-enhancements/DEPLOYMENT.md](../group-enhancements/DEPLOYMENT.md) (record the
installation, full backup with `CHECKSUM` and `RESTORE VERIFYONLY`, off-server copy, staging restore, the stop/start order
`TMNgrok`, `TMWorkers`, `TMMiniApp`, `TMOfficeWeb`, then the checked startup script). This page lists what is different.

## 1. Database changes (all additive)

| Migration | SQL Server effect | Existing data |
|---|---|---|
| `organization.0007_reporting_lines` | new table `org_reporting_lines` | untouched |
| `workspaces.0003_workspace_managers` | new table `tm_workspace_managers` | untouched |
| `workspaces.0004_personal_stays_personal` | `DROP TRIGGER IF EXISTS dbo.workspace_member_public` (only that trigger; `workspace_public_audit` and `org_audit_append_only` stay) | untouched; workspaces converted earlier stay Public |
| `groups.0004_live_data_and_merged_name` | new tables `tm_board_live_shares`, `tm_board_live_columns`, `tm_board_live_history`; column-type CHECK widened to allow `LINKED`; `tm_board_deliveries.file_name nvarchar(160) NOT NULL DEFAULT ''`; a `DEFAULT '{}'` constraint added to the existing `tm_board_imports.source_json` | untouched |

The DEFAULT constraints are deliberate: code from before a column existed can still insert rows, so a code-only rollback
keeps working while the schema stays. New foreign keys are created without `ON DELETE` actions (Django deletes dependent
rows itself), so SQL Server's "multiple cascade paths" restriction does not apply. The generated SQL Server DDL was
reviewed offline (see TEST_RESULTS.md); it has **not** been executed on SQL Server.

No row is rewritten. Every existing workspace has no responsible managers recorded and keeps exactly its previous
visibility; nobody has an additional reporting line until one is saved.

**Permissions.** Run migrations with the migration login. Dropping the trigger needs `ALTER` on `dbo.tm_members` (the same
right used to create it in `workspaces.0002`). If the DBA grants the application login table by table, grant it
`SELECT, INSERT, UPDATE, DELETE` on the five new tables.

## 2. Before installing

1. Full backup of `TaskManagement_Production` exactly as in the earlier guide (new file name, `COPY_ONLY, CHECKSUM`,
   `RESTORE VERIFYONLY`, copy off the server). Use a SQL login with `BACKUP DATABASE` permission; the application and
   migration logins do not have it.
2. Record, for later comparison: `SELECT COUNT(*) FROM tm_workspaces`, `tm_members`, `tm_tasks`, `tm_board_rows`,
   `tm_board_files`, and `SELECT visibility, COUNT(*) FROM tm_workspaces GROUP BY visibility`.
3. Finish or account for queued Telegram deliveries before stopping `TMWorkers` (as before).

## 3. Staging (SQL Server) — required before production

On a restored copy (another instance, or a separate database only if the system owner decides so; never over production):

```powershell
git fetch origin
git switch --track origin/feature/live-data-management-scope
& ".\backend\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements.txt
Set-Location .\source; npm ci; npm run typecheck; npm run build; Set-Location ..\backend
python manage.py showmigrations organization workspaces groups
python manage.py migrate_database
python manage.py check_database
python manage.py showmigrations organization workspaces groups
python -m pytest -ra
```

Then check in SQL Server:

```sql
SELECT name FROM sys.triggers WHERE name IN ('workspace_member_public','workspace_public_audit','org_audit_append_only');
-- expected: workspace_public_audit, org_audit_append_only (and NOT workspace_member_public)
SELECT t.name, c.name, d.definition FROM sys.default_constraints d
  JOIN sys.tables t ON t.object_id = d.parent_object_id JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = d.parent_column_id
 WHERE (t.name = 'tm_board_deliveries' AND c.name = 'file_name') OR (t.name = 'tm_board_imports' AND c.name = 'source_json');
-- expected: two rows, ('') and ('{}')
```

Re-run the counts from §2.2: they must be identical.

Acceptance on staging (synthetic records, test bot): the permission matrix in README.md §4 with two managers sharing one
employee; Personal workspace member add (stays Personal, manager cannot open it); Calendar Under My Management for both
managers; a single-person task edit and a two-person task edit; Live Data share → Viewer/Can edit → history → revoke, with
two people editing the same cell; Mini App Send to Telegram (separate and combined, named) to a test account on Android and
iOS. Existing Share Data (copy), imports, attachments and previews must behave as before.

## 4. Production

Same window and order as the earlier guide: stop `TMNgrok`, `TMWorkers`, `TMMiniApp`, `TMOfficeWeb`; update the existing
service checkout to the reviewed commit; install dependencies; build the frontend; `migrate_database`; `check_database`;
`showmigrations`; run the SQL checks from §3; start with `tools\windows-services\Start-TaskManagementServices.ps1`. Then
sign in as an employee and a manager, open a workspace and a Group, edit a test task, and send one test document to your
own Telegram.

## 5. Rollback

**Preferred: code rollback, migrations stay applied.** Stop the services, restore the previous commit (`f6b28aa`) and its
built frontend, start again. The old code ignores the new tables and columns. Before doing so:

* **Delete Live Data columns first** (in the app, column menu → Delete column; they hold no values — the source data is
  untouched). Check with `SELECT COUNT(*) FROM tm_board_columns WHERE type = 'LINKED'` → must be 0. The previous frontend
  does not know this column type.
* Understand what the old code does with the new records: it **ignores responsible managers** — every workspace goes back
  to the original primary-line rule, so a primary manager regains sight of workspaces the owner had put under another
  manager; it ignores additional reporting lines; and it treats Personal workspaces as owner-and-Administration only, so
  members added while this version ran lose access (their membership rows remain). Inform the affected people.
* To restore the old automatic Personal → Public conversion as well, run `python manage.py migrate workspaces 0003` with
  the migration login (recreates the trigger; it acts only on later membership writes and changes no existing row).

**Full schema reversal** (only if required): delete Live Data columns as above, then with the migration login
`migrate groups 0003`, `migrate workspaces 0002`, `migrate organization 0006`. This drops the new tables (Live Data shares
and history, responsible managers, additional reporting lines) and the chosen names of combined PDFs; every other table is
unchanged (verified on a populated SQLite copy, see TEST_RESULTS.md).

**Database restore** only if the database itself must be recovered, as described in the earlier guide.

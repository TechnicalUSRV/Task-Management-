# Deployment and rollback — Groups / Telegram enhancements

This change is prepared on `feature/groups-mobile-sharing`, based on `09154e3cfe25ee55967426acaf2bb2b9a1d13457`. Deploy a reviewed commit from this branch only after staging acceptance. The update has not been installed on the office server.

## 1. Record and protect the current installation

1. Record `git rev-parse HEAD`, `git status --short`, the active Python environment, `python -m pip freeze`, Node version and the current service definitions. Keep local changes; do not use `git reset --hard` or overwrite configuration to update.
2. Securely back up `backend\.env`, any frontend environment file, WinSW service XML/configuration, the tunnel configuration, and the currently built `source\local-test\public` folder. Keep existing Django/Telegram encryption keys; the bot token depends on them. Do not put secrets in GitHub or this report.
3. Have the DBA make a **full SQL Server backup** of `TaskManagement_Production`, using a new backup file and backup checksums. Retain the recovery-chain/log backups required by the company's recovery policy. Attachments and Group data are in this database; a Git backup alone does not protect them.
4. Verify the backup and restore it to an isolated staging database. A successful file verification alone is not a complete restore test. Record the restore duration and recovery point. Limit access to the restored company data.
5. Use a separate staging checkout, least-privilege SQL login and migration login. Set its `DB_NAME` explicitly to the staging database. Disable the restored production Telegram bot before starting any staging worker. Use a dedicated test bot and test accounts for outbound verification. Never run two polling workers against the production bot token.

## 2. Prepare and test staging

The existing environment keys are `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_MIGRATION_USER`, `DJANGO_SECRET_KEY` and, if configured, `TELEGRAM_TOKEN_KEY`. Preserve production values in production; configure separate staging values intentionally.

From the repository root, PowerShell:

```powershell
git fetch origin
git switch --track origin/feature/groups-mobile-sharing
# If the local branch already exists: git switch feature/groups-mobile-sharing
# Then git pull --ff-only. Stop and review any local changes or merge failure.

& ".\backend\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements.txt
& ".\backend\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements-hosting.txt
Set-Location .\source
npm ci
npm run typecheck
node local-test/group-presentation-test.mjs
npm run build
Set-Location ..\backend
python manage.py showmigrations groups
python manage.py migrate_database
python manage.py check_database
python manage.py showmigrations groups
```

The last Python commands assume the intended virtual environment is activated. If it is not, use `.\.venv\Scripts\python.exe` instead of `python`. Stop at any failed command. Confirm the printed server/database is the staging target before migrations; never copy a staging database connection into the production service by mistake.

Expected new migration: `groups.0003_presentation_sharing_delivery`. It adds three tables and one defaulted column. It does not recreate the database or replace users, tasks, workspaces, Group values, files or permissions. Run schema changes with the migration account; the application account should retain ordinary data access without schema-creation rights. Check its access to the three new tables if your DBA grants permissions table by table.

The test suite selects `config.settings_test` and uses temporary SQLite databases, not SQL Server:

```powershell
python -m pytest -ra
```

It supplements, rather than replaces, the following SQL Server and browser checks.

## 3. Staging acceptance checklist

Use synthetic records and a dedicated test bot. Record who tested each item and the result.

- **Existing workflows:** sign in as employee, manager and administrator; create/accept/update/review a task; create a request, meeting and timesheet; check reminders and reports. Verify existing Group formulas, XLSX imports/exports and attachments.
- **Sidebar:** initial width remains standard; drag to both limits, reload, collapse/expand, keyboard resize and reset. Check long labels at narrow widths and mobile sidebar behavior. Confirm official logo proportions and colors.
- **Numbers/colors:** USD, KHR, percentage and custom symbols; decimals and separators; formula totals; refresh persisted cell colors; compare raw numbers before/after. Confirm filters and sorting still work. Two simultaneous edits must report a conflict.
- **Attachment panel:** long English/Khmer filenames at desktop and phone widths; Download and Remove remain visible. Previous/Next File cannot leave that cell; PDF page controls remain separate; unsupported files offer download.
- **Sharing:** share two columns from a private Group with someone outside its workspace who is allowed by governance. The recipient must not gain workspace membership or open the full source Group. Test hidden rows, hidden columns and dependent formulas. Check loss of issuer collaboration permission and recipient deactivation.
- **Import:** select authorized columns and rows; map to existing/new fields; validate incompatible dates/numbers/people; use a matching key; review duplicate detection; require confirmation before updates. Confirm the source stays unchanged and a second submit does not duplicate the import. Revoke a share or change the source after staging: preview/commit must fail until the source is selected again.
- **Telegram:** connect the test user's private chat; send originals; select PDFs in a different order and verify every page; test encrypted/damaged/oversized PDFs. Revoke file access or relink Telegram after queueing. Block the bot to verify failure feedback. Do not resend UNKNOWN/PARTIAL jobs until the user checks their chat.
- **Mini App:** test in Telegram on Android/iOS if used by staff. Tasks must retain New Task, Request Task and Requests. Check My Groups/Company scope, workspace selection, columns/types, search/status filter, paging, permitted edits and view-only denial. Web must show the saved mobile edits. Scroll a long PDF vertically, zoom, change files and close/back.
- **Hosting boundary:** public listener must still refuse `/TaskManagement`, `/api/state`, `/api/command` and office administration endpoints. Group media requires a valid bound token and current Group access. The office-only web listener remains on the office network.
- **Data/operations:** compare existing row/file counts and sample file hashes before/after migration; reboot services; verify one worker process, reminder cadence, delivery progress, database audit entries and recoverability. Measure representative large Groups and file batches on the actual server.

## 4. Install the accepted commit in production

Schedule a short maintenance window. Finish or account for queued/in-flight deliveries before stopping the worker. Take a final database backup after stopping writes so rollback has a clear recovery point. Leave SQL Server running.

In Administrator PowerShell, with the existing service names from `tools/windows-services/README.md`:

```powershell
Stop-Service TMNgrok
Stop-Service TMOfficeWeb
Stop-Service TMMiniApp
Stop-Service TMWorkers
```

Update the **existing service checkout** to the reviewed commit, preserving all environment/service files. Repeat the dependency installation, frontend build, `migrate_database`, `check_database` and `showmigrations groups` commands above, this time after verifying the production database target. Preserve the old commit and built assets for rollback.

Confirm `HIDDEN_FUNCTIONS` does not include `tasks.groups`, the bot is enabled, and `TMWorkers` uses `manage.py run_workers` without `--no-telegram`. Do not start a second manual polling worker.

Restart using the existing checked startup script:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ".\tools\windows-services\Start-TaskManagementServices.ps1"
Get-Service TMOfficeWeb,TMMiniApp,TMWorkers,TMNgrok
```

Check office login, the authenticated Mini App, one test Group edit, permissions and a deliberate delivery to your own test user's Telegram. Watch the existing service logs and audit history. If a check fails, keep the maintenance window open and resolve or roll back. Do not expose the office listener through the public tunnel.

## 5. Rollback

**Preferred code rollback:** stop the same services; restore the recorded previous commit and its frontend build, then restart with the existing configuration. Because this migration is additive, leave `groups.0003` applied and keep its tables and new data. The previous application ignores the new fields/tables. Do not reverse the migration as a routine code rollback: reversal removes saved styles, grants, delivery records and import provenance.

Before returning later to this branch, review outstanding `QUEUED` deliveries with the DBA and cancel unwanted jobs. In-flight jobs whose outcome is uncertain should remain UNKNOWN; never reset SENDING/UNKNOWN jobs to QUEUED without checking the user's chat. Original file downloads and tasks do not depend on sending queued documents.

**Database restore:** use only if the database itself must be recovered. Stop all writers, let the DBA restore the verified backup and required log chain, restore the matching code/configuration, verify counts/files/login, and reopen access. A restore can discard work saved after the recovery point; explicitly account for that work. Never replace the production database with a blank database or the development SQLite file.

Keep backup files until the company has accepted the updated installation and its recovery test.

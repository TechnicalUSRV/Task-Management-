# Deploy the reviewed privacy and attachment update

Use a maintenance window after the staging checks in [REVIEW.md](REVIEW.md). These instructions
have not been executed against the production server. Keep SQL Server running; it may serve
other company databases. Do not rerun the service installer for a routine application update.

## 1. Confirm the installation and prepare recovery

In Administrator PowerShell on the Windows server:

```powershell
$tmInstall = Get-Content -Raw 'D:\TaskManagement\Services\installation.json' | ConvertFrom-Json
Set-Location -LiteralPath $tmInstall.Repository
git status --short
git rev-parse HEAD
git fetch origin
```

Record the current commit and service configuration securely. Stop if local tracked changes
need preserving. Save protected copies of `backend\.env`, encryption/signing keys, service
configuration and any external attachment storage. Do not put secrets in Git or send them in chat.
Check which employees have no organizational level; an authorized administrator must map
employees who need operational access. Never auto-assign everyone merely to bypass the restriction.

Restore a recent production backup to a separate staging database first. Configure the staging
application explicitly for that database and a test bot. Run migrations, access tests and the
manual acceptance cases before scheduling production deployment.

## 2. Pause application traffic and back up production

Wait for active document deliveries to finish. Resolve UNKNOWN deliveries by checking Telegram;
do not blindly repeat them. Stop the four application services in order:

```powershell
Stop-Service TMNgrok
Stop-Service TMWorkers
Stop-Service TMMiniApp
Stop-Service TMOfficeWeb
Get-Service TMNgrok,TMWorkers,TMMiniApp,TMOfficeWeb
```

Confirm they are stopped and that no old manual `run_workers`, web or ngrok process remains.
Leave `MSSQLSERVER` running.

Ask the DBA to create the backup folder on the SQL Server host and grant its SQL Server service
account write access. Run the following in **SQL Server Management Studio → New Query**,
connected to the correct production instance. **Do not paste this SQL into PowerShell.**

```sql
DECLARE @BackupFile nvarchar(4000) =
    N'D:\Task Controlling Management SQL\Backups\TaskManagement_Production_'
    + CONVERT(nvarchar(8), GETDATE(), 112) + N'_'
    + REPLACE(CONVERT(nvarchar(8), GETDATE(), 108), N':', N'')
    + N'_before_task_privacy.bak';

BACKUP DATABASE [TaskManagement_Production]
TO DISK = @BackupFile
WITH COPY_ONLY, CHECKSUM, NAME = N'Before Task privacy and attachment update';

RESTORE VERIFYONLY FROM DISK = @BackupFile WITH CHECKSUM;
SELECT @BackupFile AS BackupFile;
```

Require successful output, copy the backup off the server to protected storage, and record
the location. VERIFYONLY is not a substitute for the staging restore drill. Do not migrate
production without a usable backup and an agreed rollback decision-maker.

## 3. Select and build the reviewed code

Back in PowerShell at the repository root:

```powershell
git switch --detach origin/codex/review-task-privacy-camera-2026-10-22
if ($LASTEXITCODE -ne 0) { throw 'Code checkout failed.' }
git rev-parse HEAD

& '.\backend\.venv\Scripts\python.exe' -m pip install -r .\backend\requirements-hosting.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

Push-Location .\source
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Frontend type check failed.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
Pop-Location
```

Compare the checked-out commit with the delivered GitHub fix commit. `npm.cmd` avoids the
PowerShell `npm.ps1` execution-policy problem; no machine-wide policy change is needed.
Use the Node version specified by the repository. Preserve the existing `.env` and virtual
environment path. If any command fails, keep the application stopped and investigate.

## 4. Apply migrations using the dedicated migration login

Inspect `backend\.env` locally and confirm the intended server/database without exposing
passwords. Use the project's migration wrapper, which prompts for the dedicated migration
login rather than granting schema privileges to the runtime login:

```powershell
& '.\backend\.venv\Scripts\python.exe' .\backend\manage.py showmigrations
& '.\backend\.venv\Scripts\python.exe' .\backend\manage.py migrate_database
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed. Do not start services.' }
& '.\backend\.venv\Scripts\python.exe' .\backend\manage.py check_database
if ($LASTEXITCODE -ne 0) { throw 'Database verification failed. Do not start services.' }
& '.\backend\.venv\Scripts\python.exe' .\backend\manage.py check
if ($LASTEXITCODE -ne 0) { throw 'Application verification failed.' }
& '.\backend\.venv\Scripts\python.exe' .\backend\manage.py check_document_capacity
```

The DBA should preserve/recheck the audit-table protections described by `migrate_database`
and `docs/backend-migration/sqlserver-logins.sql`. Confirm all intended migrations are applied.
Keep document concurrency at the default one until server load measurements justify more.

## 5. Start and accept the release

Use the existing startup script with all four services stopped:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File '.\tools\windows-services\Start-TaskManagementServices.ps1'
```

The script checks office/public routing and that the one worker service started. Follow any
organization policy that restricts script execution; do not disable it globally. Do not start
another manual worker alongside `TMWorkers`.

Before reopening normal use, test with designated test accounts and synthetic records:

1. An unrelated Workspace member cannot see another person's Task, URL, file, history or report.
2. Managers B/C see only their selected Task scope; Personal Tasks are absent from management views.
3. Viewer/Contributor sharing works, and removal revokes only the sharing grant.
4. An unmapped employee sees restricted pages; an administrator maps the employee and access updates.
5. Web and Mini App requests use the same visibility and manager scope; existing approvals still work.
6. Task and Group PDFs show the final names/sizes; confirmation sends in order to the current user's bot chat.
7. Known failures retry only remaining files. UNKNOWN deliveries offer no automatic retry.
8. Single and multiple photos work on actual phones, including denial/fallback, retake, delete, order and PDF upload.
9. Large document processing does not exhaust memory, stall SQL Server or block normal web use.
10. Check service logs and public route restrictions. Record screenshots of these actual tests before approval.

## 6. Rollback

If verification fails, stop the tunnel, worker and both web services again. Preserve diagnostics
and a backup of the failed state. Do not repeatedly send pending/UNKNOWN jobs during recovery.

Before migrations, the previous code/configuration and rebuilt previous frontend can be restored
at the recorded commit. After migrations, do not assume a code-only rollback is safe: the old
code ignores Task visibility/governing managers and may expose data, while old workers cannot
interpret the new delivery states. Do not reverse migrations or drop new tables blindly.

Have the DBA restore the verified pre-update database together with its matching application
commit, frontend, keys and service configuration. If users wrote data after the backup, first
agree how to preserve/reconcile those changes; restoring the backup alone loses them. Telegram
messages already delivered cannot be rolled back with the database and must be reconciled
before restarting workers. Retest authorization and routing before restoring normal access.

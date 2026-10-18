# Task Controlling Management — Django backend (SQL Server)

Django 5.2 + Django REST Framework, storing everything in Microsoft SQL Server (`SERVERSYSTEM` / `TaskManagement_Production`).
It serves the existing React app and Telegram Mini App with the same API contract as V5.7.7 (`/api/state`,
`/api/changes`, `/api/command`, files, reports, `/tg/api`), plus read-only REST resources under `/api/v1/`.
The browser never connects to SQL Server; only Django does, with the least-privilege login `taskmanagement_app`.

The V5.7.7 Node/SQLite backend in `source/local-test/` remains a regression reference. The new Group enhancements
target the Django deployment; use Django plus `npm run dev` for development, rather than the old `npm start` API.

## 1. What you need on the computer

| | Version | Check |
|---|---|---|
| Python | 3.12 or newer (developed on 3.13) | `py --version` |
| Microsoft ODBC Driver 18 for SQL Server | 18.x | Windows: *ODBC Data Sources (64-bit)* → Drivers tab |
| Node.js | 24 (22.5+ also builds) | `node --version` |
| Network | the computer can reach `SERVERSYSTEM` on the SQL Server port | SSMS connects |

## 2. First-time setup (Windows PowerShell, from the repository folder)

```powershell
git fetch
git switch backend/sqlserver-integration

# Backend
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env                           # set DJANGO_SECRET_KEY and DB_PASSWORD (the taskmanagement_app password)
```

Create the secret key with `python -c "import secrets; print(secrets.token_urlsafe(50))"` and paste it after
`DJANGO_SECRET_KEY=`. Never commit `.env` (it is in `.gitignore`).

```powershell
python manage.py check_database        # connects as taskmanagement_app; reports "N migration(s) not applied yet"
python manage.py migrate_database      # asks for the taskmanagement_migrator password; creates the tables
```

Then the DBA runs the three `DENY UPDATE, DELETE …` statements at the end of
`docs/backend-migration/sqlserver-logins.sql` (they protect the audit history from the application login) and,
recommended, `ALTER DATABASE … SET READ_COMMITTED_SNAPSHOT ON` from the same file. Then:

```powershell
python manage.py check_database        # must end with "Database check passed"
python manage.py showmigrations        # every line marked [X]
```

Build the React app once (and again after pulling frontend changes):

```powershell
cd ..\source
npm ci
npm run build                          # writes source\local-test\public, which Django serves
cd ..\backend
```

## 3. Start the system

Two terminals, both in `backend` with the virtual environment activated (`.\.venv\Scripts\Activate.ps1`):

```powershell
python manage.py runserver 127.0.0.1:8000     # terminal 1: the web app and API
python manage.py run_workers                  # terminal 2: due date and calendar reminders, Telegram bot
```

Open <http://127.0.0.1:8000/TaskManagement>. On an empty database the first screen is **Create the administrator**
(allowed only from this computer unless `DJANGO_ALLOW_REMOTE_SETUP=yes`).

The former `/c/default/` homepage now returns 404. Keep `/c/default/api/...` and `/c/default/tg/...`:
they provide application requests, sessions and the Telegram Mini App.

`runserver` is for local use and acceptance testing. For the office Waitress services and restricted public
Mini App tunnel, follow [the Windows service instructions](../tools/windows-services/README.md).

### Frontend development (optional)

```powershell
cd ..\source
npm run dev                                    # http://127.0.0.1:5173, forwards /c/<company>/api to Django on :8000
```

The API address is configuration, not code: `VITE_API_BASE_URL` in `source/.env` (see `source/.env.example`).
Leave it empty when Django serves the app or when using `npm run dev`.

## 4. Commands

| Command | What it does |
|---|---|
| `python manage.py check_database` | Server, database and login in use; fails for `sa`, sysadmin, a wrong database or missing migrations; warns about schema rights, access to other databases and unprotected audit tables. Changes nothing. |
| `python manage.py migrate_database` | Applies migrations with the migration login (password asked, not stored). |
| `python manage.py run_workers` | Reminders (due dates every 10 minutes, calendar every minute) and the Telegram bot when it is turned on in Administration → Telegram. `--once` runs one reminder pass; `--no-telegram` skips the bot. |
| `python -m pytest` | All automated tests. They use a temporary in-memory SQLite database and never touch SQL Server. The parity tests also run the V5.7.7 code and need Node.js 22.5+; the browser acceptance test needs the built frontend and Playwright (`pip install playwright==1.56.0`, then `python -m playwright install chromium`). Without them those tests are skipped. |

## 5. Acceptance check (Stage 4)

1. Start both commands above and open <http://127.0.0.1:8000/TaskManagement>.
2. Create the administrator, sign in.
3. Administration → **Create user**; Task Management → **New workspace** (add the new user); **New task** for that user.
4. Edit the task (as the assigner this is sent to the person in charge for approval); sign in as the new user in a
   private window, accept the task and approve the change.
5. Stop `runserver` (Ctrl+C), start it again, sign in: the user, workspace and task (with the new title) are still there.
6. In SSMS (read-only):

```sql
USE TaskManagement_Production;
SELECT id, username, active FROM dbo.access_users;
SELECT id, name, owner_id FROM dbo.tm_workspaces;
SELECT id, title, status, pic_id FROM dbo.tm_tasks;
SELECT TOP 20 task_id, kind, actor_id, created_at FROM dbo.tm_task_history ORDER BY id DESC;
```

## 6. Groups and attachment previews (16 Oct 2026)

**Groups** (Task Management → Groups) work as in V5.7.7: customizable tables in a workspace with Text, Number, Date,
Status, In Charge, Support, Formula and Attachment columns, sharing, row and column access rules, notes, layouts, Excel
import and export. They had been switched off by Stage 1 decision A; the Google Sheets connection stays off.

**Attachment preview**: task files and files in Group Attachment cells open inside the app (web and Telegram Mini App).
Images and PDFs are shown from the file (PDFs page by page, with zoom); Word (.docx), Excel (.xlsx), PowerPoint (.pptx),
CSV and text files are read on the server into plain text, tables and slides; other files offer the download. Every
preview goes through the same access check as the download (`/api/tasks/file/preview`, `/api/tasks/group/file/preview`,
`/tg/api/file-preview`). Files are never sent to an outside viewer.

When updating an existing installation:

```powershell
git pull --ff-only
cd backend
python manage.py migrate_database      # adds the Group tables (nothing existing is changed)
cd ..\source
npm ci                                 # PDF.js (the PDF preview) was added
npm run build
```

In `backend\.env`, Groups must not be listed as switched off: `HIDDEN_FUNCTIONS=admin.integrations` (an `.env` copied
from the earlier `.env.example` says `tasks.groups,admin.integrations`; remove `tasks.groups`). Then restart the services.

## 7. Layout

| App | Tables (V5.7.7 names) |
|---|---|
| `core` | company, staff, sequences, module settings, change counter, references, approval steps |
| `accounts` | access_users, roles, permissions, overrides, sessions, login attempts, access_audit |
| `organization` | tm_profiles (reporting lines, levels), org_settings, org_levels, org_templates, org_requests, org_grants, org_audit |
| `workspaces` | tm_workspaces, tm_members (+ Personal→Public and append-only audit triggers) |
| `tasks` | tm_tasks, tm_assignees, tm_task_history, tm_checklist, tm_files, tm_requests, tm_due_requests, tm_change_requests, reminders, staff_photos |
| `meetings` | tm_meetings, attendees, shares, followers, change requests, calendar notes, event reminders |
| `timesheets` | tm_timesheets |
| `notifications` | tm_notifications, tm_notification_deliveries |
| `telegram` | tg_settings (token encrypted), tg_links, tg_link_codes, tg_groups, tg_sessions, tg_log; bot and Mini App gateway |
| `groups` | Groups: tm_boards, tm_board_access, tm_board_columns, tm_board_rows, tm_board_notes (+ revisions), row and column access rules, layouts, Excel imports, files in Attachment columns |
| `audit` | tm_events |
| `compat` | the V5.7.7 API contract (state, commands, files, reports, dashboard) and `/api/v1/` resources |

## 8. Groups / Telegram enhancements (17 Oct 2026)

Numeric display formats, individual cell colors, controlled column-data sharing and Group-to-Group copying, queued
Telegram document delivery/PDF merging, same-cell file navigation, mobile Groups and sidebar resizing are documented
in [the implementation report](../docs/group-enhancements/IMPLEMENTATION.md).

Install the updated Python dependencies (`pypdf==6.21.0`), apply `groups.0003_presentation_sharing_delivery`, rebuild the
frontend and restart the existing worker. Follow [the staging, backup and rollback instructions](../docs/group-enhancements/DEPLOYMENT.md)
before production use. `run_workers --no-telegram` disables document delivery as well as the bot.

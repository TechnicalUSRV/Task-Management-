# Django + SQL Server migration — report (Stages 2–5)

| | |
|---|---|
| Branch | `backend/sqlserver-integration` (pushed to GitHub, **not merged** into `main`) |
| Base | `main` at V5.7.7 (`9575cc0`) |
| Scope (Stage 1 decisions) | A: Task Management core (CRM/Operations/Finance off, Groups and Google Sheets hidden) · B: existing API contract + REST resources · C: one company · D: SQL Server starts empty · E: logins created by the DBA |
| Status | Backend, frontend wiring, Telegram and tests complete. **SQL Server itself has not been connected yet** — this workspace cannot reach `SERVERSYSTEM`; that check (Stage 4) runs on an office computer with the commands below. No hosting was started. |

## 1. What was built

* **Django 5.2 + DRF backend** (`backend/`) storing everything in SQL Server through `mssql-django` + ODBC Driver 18, with the least-privilege login `taskmanagement_app`. The tables keep the V5.7.7 names and readable IDs (`TASK-000123`).
* **The same API contract as V5.7.7**, so the React screens are unchanged: `/api/auth/*`, `/api/state`, `/api/changes`, `/api/command` (every Task Management command), task files, photos, task reports (JSON/CSV/print), dashboard, custom reports, the Organizational Structure views, and the Telegram Mini App gateway `/c/<company>/tg/api/*`.
* **REST resources** (read-only) under `/api/v1/`: users, workspaces, tasks, task-history, requests, meetings, timesheets, notifications, organization — filtered by the same permission and scope services.
* **Telegram**: bot (commands, buttons, forms, group chats, files, notification delivery with retries, morning summary), Mini App gateway (signed launch data, media links), bot token stored encrypted.
* **Background workers** (`manage.py run_workers`): due date reminders every 10 minutes, calendar reminders every minute, Telegram bot supervisor.
* **Frontend wiring** (5 small edits, no redesign): API address from `VITE_API_BASE_URL`, dev proxy to Django, the one direct `fetch` routed through the shared client.
* **SQL Server tooling**: `check_database` (safety checks), `migrate_database` (migrations with the migration login, password asked and not stored).

## 2. Commits

| Commit | |
|---|---|
| `a401d61` | Stage 1 review |
| `7e3a814` | Stage 1 scope decisions |
| `1bdaf6a` | Django skeleton: accounts, roles, permissions, sign-in |
| `7fed404` | Least-privilege SQL Server login script (placeholders only) |
| `dde48be` | Workspaces and Organizational Structure governance |
| `fdaa64d` | Tasks, meetings, calendar, time entries + V5.7.7 parity tests |
| `c08b3b1` | Application state, reports, dashboard, Telegram settings |
| `722c478` | Telegram Mini App gateway; Django serves the built frontend |
| `3e82a58` | Telegram bot and background workers |
| `a7ae454` | Organizational Structure parity scenario + ordering fixes |
| `b8e580a` | React app reads the API address from configuration; trusted-origin CORS |
| `5a6a7f6` | Bot token encrypted at rest |
| `bdca28d` | Read-only REST resources `/api/v1/` |
| `83ee89a` | `check_database` |
| `f6c62ff` | Bulk loading of people/permissions for the state (4× faster) |
| `d6450f2` | `migrate_database`, bounded reads, setup guide |
| `8208bb7` | Browser acceptance test |
| `54ccaea` | Changes serialized with a SQL Server application lock |

## 3. Changed files

* **New**: `backend/` (≈14,600 lines of Python incl. 2,300 lines of tests), `docs/backend-migration/` (this report, Stage 1 review, `sqlserver-logins.sql`), `source/.env.example`.
* **Modified** (frontend, about 35 lines in total): `source/local-test/api-client.ts`, `assets.d.ts`, `crm-ui.tsx`, `tg-app.tsx`, `vite.config.ts`, `source/package.json` (`npm run dev`), root `.gitignore` (`.env`, `.venv`).
* **Not modified**: every V5.7.7 `.mjs` service file, screens, styles, branding. The Node/SQLite version still runs on its own.

## 4. Data model (SQL Server tables)

| App | Tables |
|---|---|
| core | company, staff, sequences, erp_module_settings, change_counter, reference_items, approval_steps |
| accounts | access_users, access_roles, access_permissions, access_user_permissions, access_sessions, access_attempts, access_audit |
| organization | tm_profiles (reporting line, level), org_settings, org_levels, org_templates, org_requests, org_grants, org_audit, staff_photos |
| workspaces | tm_workspaces, tm_members |
| tasks | tm_tasks, tm_assignees, tm_task_history, tm_checklist, tm_files, tm_requests, tm_due_requests, tm_change_requests, tm_reminders |
| meetings | tm_meetings, tm_attendees, tm_meeting_shares, tm_meeting_followers, tm_meeting_changes, tm_calendar_notes, tm_event_reminders |
| timesheets | tm_timesheets |
| notifications | tm_notifications, tm_notification_deliveries |
| telegram | tg_settings, tg_links, tg_link_codes, tg_groups, tg_sessions, tg_log |
| audit | tm_events |

50 tables (plus Django's own bookkeeping tables). Dates are `date`/`datetime2` (UTC), flags `bit`, files `varbinary(max)`. CHECK constraints, filtered unique indexes and the indexes listed in the Stage 1 review are in the migrations. Database rules kept from V5.7.7 as **SQL Server triggers**: adding a non-owner member makes a Personal workspace Public (with audit and revision), and `org_audit` is append-only.

## 5. Migrations

25 migrations, applied with `python manage.py migrate_database`:
`core` 0001–0002 · `organization` 0001–0006 (incl. seeded Owner template and initial revision) · `accounts` 0001–0002 (built-in roles and permissions) · `workspaces` 0001–0002 (triggers) · `tasks` 0001 · `meetings` 0001–0002 · `timesheets` 0001 · `notifications` 0001–0004 · `telegram` 0001–0003 · `audit` 0001–0002. No test or demo data is inserted.

## 6. Endpoints

| Path (also under `/c/default/`) | |
|---|---|
| `POST /api/auth/setup`, `/login`, `/logout`; `GET /api/auth/status` | first administrator, sign-in (HttpOnly SameSite=Strict cookie, 8 h) |
| `GET /api/state`, `GET /api/changes` | the permission- and scope-filtered snapshot; change counter for polling |
| `POST /api/command {action, data}` | every change, through `authorize` + the ported workflow rules, one transaction |
| `GET /api/organization` | Organizational Structure views |
| `GET /api/tasks/file`, `/api/photo` | attachments and photos (scope-checked) |
| `GET /api/tasks/report[.csv/.print]`, `/api/erp/dashboard`, `/api/erp/source`, `/api/erp/report-options`; `POST /api/erp/report[.export/.csv]` | reports and dashboard |
| `GET /api/v1/` and `/api/v1/<resource>/[<id>/]` | read-only REST resources (users, workspaces, tasks, task-history, requests, meetings, timesheets, notifications, organization) |
| `/c/<company>/tg/`, `/c/<company>/tg/api/*` | Telegram Mini App |

## 7. Security

* Every API requires a session (`IsAuthenticated`) except setup, sign-in/out, sign-in status, version and the company name list, as in V5.7.7; no data endpoint uses `AllowAny`. Permissions and record scope are enforced in the backend for every command and read. A record outside your scope answers **404 whatever ID is put in the URL** (tested for tasks, workspaces, history, files, requests, Mini App).
* Writes require the app's own Origin (or one listed in `DJANGO_TRUSTED_ORIGINS`); CORS is answered only for those origins, never `*`.
* SQL Server: runtime login `taskmanagement_app` (read/write data only); schema changes only through `migrate_database` with `taskmanagement_migrator`; `check_database` refuses `sa`, sysadmin or a wrong database. Audit tables can be protected with `DENY UPDATE, DELETE`.
* Secrets only in `backend/.env` (git-ignored); only `.env.example` files are committed. The Telegram bot token is stored encrypted.
* Changes are serialized with `sp_getapplock`, matching V5.7.7's single writer, so concurrent requests cannot interleave workflow steps.

## 8. Test results

| | Result |
|---|---|
| Django suite (`python -m pytest`) | **79 passed** (SQLite in memory) |
| Parity with V5.7.7 — tasks, requests, approvals, recurrence, meetings, calendar, reminders: random walks | 24 seeds × 160 steps, every result and stored row identical |
| Parity — state, Mini App state, dashboard, task and custom reports for 5 roles | identical |
| Parity — Organizational Structure (organization-test.mjs replayed: 82 commands, 123 reads) | identical (fixed 4 ordering/snapshot differences it found) |
| Parity — Telegram bot conversation (145 updates and 13 delivery runs: linking, forms, approvals, files, groups, 403 handling, digest) | every Bot API call identical |
| Browser acceptance (React app on Django, Chromium) | create admin → user → workspace → task → edit → accept/approve → rows verified; restart persistence verified in a rehearsal |
| Cross-origin mode (`VITE_API_BASE_URL` set) and Vite dev proxy | sign-in, state and commands work |
| V5.7.7 Node release tests | 9 of 12 pass; the 3 migration tests fail on the **truncated fixture files** (Stage 1 finding 4). `telegram-test.mjs` (historical suite) also fails on unchanged V5.7.7 code. |
| Load (SQLite, one process, 300 users, 3,000 tasks) | `/api/changes` 2 ms · `/api/state` ≈ 0.3 s (was 1.1 s before bulk loading) |

## 9. Differences from V5.7.7 (deliberate)

* CRM, Operations and Finance are off; Groups and Google Sheets hidden (decision A). Their state keys are present but empty, so screens behave as with the modules off.
* Instants are stored as `datetime2` and returned as `…Z` ISO strings with milliseconds; text sorting in SQL follows the SQL Server collation (case-insensitive).
* Settings changes are recorded in Access history (CRM events are off).
* The bot token is encrypted (V5.7.7 stored it in plain text); a person cannot be set as their own manager even outside the structure (a database check).
* Small JSON lists (reminder days and offsets, change sets, request payloads) stay as validated JSON text, as in V5.7.7, instead of the child tables proposed in Stage 1 — needed for exact parity; they are never queried by content.

## 10. Risks and open items

| | |
|---|---|
| **SQL Server not yet exercised** | T-SQL of the migrations was generated and parsed offline, index sizes were checked, and the lock/triggers use standard T-SQL, but nothing has run on `SERVERSYSTEM`. Stage 4 below. |
| Production web server | `runserver` is for local use. A Windows service / HTTPS setup belongs to hosting. |
| State size | `/api/state` loads the company's task tables per request, as V5.7.7 did. Fine for ≈300 people; very large histories would need paging later. |
| Truncated fixtures | Re-upload the three fixture databases so the V5.7.7 upgrade tests can run again. |
| Fixture secret key | `source/local-test/fixtures/secret.key` is committed; confirm it never protected real data. |
| Secret key | Keep `DJANGO_SECRET_KEY` unchanged: changing it means re-entering the Telegram bot token. |

## 11. Next steps for you (Stage 4, office computer)

1. Follow `backend/README.md` §2: install, create `backend/.env`, `python manage.py check_database`, `python manage.py migrate_database`.
2. DBA: the `DENY` statements and (recommended) `READ_COMMITTED_SNAPSHOT` from `docs/backend-migration/sqlserver-logins.sql`; then `check_database` and `showmigrations` (all `[X]`).
3. `npm ci && npm run build` in `source`, then `python manage.py runserver 127.0.0.1:8000` and `python manage.py run_workers`.
4. Acceptance (README §5): administrator, user, workspace, task, edit, restart, check the rows in SSMS.
5. Send back the output of `check_database` and `showmigrations` (no passwords).

When that passes, the remaining steps are merging the branch (your decision), hosting, and later retiring the Node/SQLite service.

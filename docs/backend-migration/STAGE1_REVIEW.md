# Stage 1 Review — Django REST + Microsoft SQL Server migration

| | |
|---|---|
| Repository | `TechnicalUSRV/Task-Management-` |
| Reviewed commit | `9575cc08192435209bfbc45da17c96c23ab0c889` (main, V5.7.7) |
| Working branch | `backend/sqlserver-integration` (local, not pushed, not merged) |
| Status | **Review only. No application code, schema or data has been changed.** |

Everything below was read from the code at that commit, and the schema figures come from booting the real service against an empty database (`openStore`) and reading SQLite's own catalog after all 19 migrations ran — not from page names or documentation alone.

---

## 0. Findings that change the plan

These need a decision before Stage 2. They are explained in detail in the sections referenced.

1. **The application is much larger than a task manager.** The live schema has **97 tables, 936 columns, 219 foreign keys and 5 triggers**. About **47 tables** are the Task Management system the brief describes. The other **~50** are **CRM** (contacts, leads, campaigns, opportunities, quotations, orders, invoices, payments), **Logistics Operations/Finance** (requests, jobs, debit notes, postings, AP, settlements, closings), **Groups** (spreadsheet-like boards with row/column ACLs and Excel import) and **Google Sheets two-way sync**. Tasks link into CRM (`tm_tasks.activity_id`, `contact_id`, `related_type`). → §1, §7, Decision A.
2. **The frontend does not call resource endpoints.** It loads one access-filtered snapshot (`GET /api/state`), polls a change counter every 4 s (`GET /api/changes`), and writes through a command bus (`POST /api/command {action, data}`) with **~120 named commands**. A generic `/api/tasks/`, `/api/workspaces/` design would require rewriting most screens, which the brief forbids. → §6, Decision B.
3. **It is multi-company.** Each company is a separate SQLite file with its own users, roles and sessions, selected by URL (`/c/<companyId>/…`). The target is one SQL Server database. → Decision C.
4. **The three upgrade-test fixture databases in GitHub are truncated.** Their headers declare 300/307/348 pages, but each file stops at ~768 KB (192 pages). This is not a Node version issue; the files were cut off on upload. Three release tests fail because of it. → §5.
5. **The SQL login in your screenshot is `Task Management`, not `taskmanagement_app`.** → §9 item 1.
6. **This cloud workspace cannot reach `SERVERSYSTEM`.** It is on your office network. Stage 4 (live SQL Server verification) has to be run from a machine on that network. → §9 item 2.

---

## 1. Current architecture

```
Browser (React SPA, /c/<company>/…)          Telegram Mini App (tg.html)        Telegram bot
        │  cookie session                          │  Authorization: tma <initData>       │ long polling
        ▼                                          ▼                                      ▼
 local-test/server.mjs  (node:http, 127.0.0.1:4305)    telegram-gateway.mjs (:4306)   telegram-bot.mjs
        │                                          │                                      │
        └──────────────► service.mjs  openStore() ◄┴──────────────────────────────────────┘
                          │  command(action,data,actor) → BEGIN IMMEDIATE … COMMIT
                          ├─ access.mjs        roles, permissions, sessions, authorize()
                          ├─ tasks.mjs         workspaces, tasks, meetings, timesheets, requests, notifications
                          ├─ task-scope.mjs    single Task Visibility Scope (web, bot, Mini App, reports)
                          ├─ organization.mjs  levels, governance, grants, approvals, workspace privacy
                          ├─ task-groups.mjs / group-sync.mjs   Groups + Google Sheets
                          ├─ operations.mjs    logistics/finance
                          └─ telegram.mjs      links, settings
                          ▼
              data/erp.sqlite  +  data/companies/<id>.sqlite  +  data/companies.sqlite (registry)  +  secret.key
```

Background workers in the same process: due-date reminders (every 10 min), meeting/calendar reminders (every 1 min), Google Sheets sync (every 5 s), Telegram bot and notification outbox.

## 2. Frontend

- React 19.2, TypeScript 5.9, Vite 8, Tailwind 4, Radix/shadcn components, lucide icons, sonner toasts. **No mock arrays, fixtures or demo data in the UI.** `sessionStorage` holds only UI state (tabs/filters) in `router.ts`; `localStorage` is unused.
- **The API layer is already centralized** in `local-test/api-client.ts` (`apiFetch`, `apiPath`) and used by `ui.tsx` (`/api/state`, `/api/changes`, `/api/command`) and `group-api.ts`. One stray direct `fetch(apiPath(...))` exists in `crm-ui.tsx` (journey).
- Two entry points: `index.html` → `main.tsx` (web) and `tg.html` → `tg-main.tsx` → `tg-app.tsx` (Mini App, which calls `/c/<company>/tg/api/*` with `Authorization: tma <initData>`).
- The folders the brief mentions are thin: `source/app` (one CSS file), `source/components/ui` (18 shadcn primitives), `source/hooks` (1), `source/lib` (1). **Nearly all application code is in `source/local-test/`** (≈28k lines).

## 3. Node/SQLite backend

| Concern | Implementation |
|---|---|
| HTTP | Plain `node:http`; host allowlist (127.0.0.1/localhost or `ERP_PUBLIC_URL`); Origin check on every POST; JSON-only bodies ≤ 43 MB; strict CSP; 120-burst / ~5 per second command rate limit per user |
| Auth (web) | `POST /api/auth/login` (username + password) → random token, SHA-256 hash stored in `access_sessions`, cookie `sunny_session_<company>` HttpOnly, SameSite=Strict, 8 h. Login throttling in `access_attempts` |
| Passwords | `scrypt:<salt>:<hex>` from Node `scryptSync(pw, salt, 64)` (N=16384, r=8, p=1) — **verifiable from Python `hashlib.scrypt`, so existing passwords can be kept** |
| Auth (Mini App) | Telegram `initData` HMAC-SHA256 with the company bot token, max age 8 h; account must be linked in `tg_links`; command allowlist `MINI_APP_ACTIONS`; media links signed separately |
| Authorization | `access.authorize(user, action, data)` maps each command to a function permission (`resource` × `view/create/update/delete/approve/export`), then domain rules (`task-scope`, `organization`, task roles) decide record-level access. Role permissions + per-user ALLOW/DENY overrides + module enable switches |
| Writes | Every command runs in one `BEGIN IMMEDIATE` transaction (SQLite serializes all writers); optimistic `version` checks give 409 on stale edits; `creation_key` idempotency on creates |
| Reads | `/api/state` returns the whole company dataset filtered for the user (`filterState`), plus a **scope revision hash** so clients drop cached reports when authority changes |
| IDs | Human-readable text keys from a `sequences` table: `STAFF-001`, `WS-000001`, `TASK-000001`, `MEET-…`, `TIME-…` |
| Files | Task files, group files, ops files and profile photos stored as **BLOBs** in the database (≤ 30 MB each) |
| Migrations | 19 additive, idempotent versions applied at startup; several rebuild tables in place. Five triggers: three enforce and audit Personal→Public conversion on any membership write (`workspace_member_public_insert/update`, `workspace_public_audit`), two make `org_audit` append-only |

## 4. Database schema (as created by V5.7.7)

| Area | Tables | In the brief's scope? |
|---|---|---|
| Identity & access | `access_users`, `access_roles`, `access_permissions`, `access_user_permissions`, `access_sessions`, `access_attempts`, `access_audit`, `erp_module_settings` | Yes |
| Company & people | `company`, `lookups` (staff are rows with `kind='staff'`), `sequences`, `tm_profiles`, `staff_photos` | Yes |
| Organization | `org_settings`, `org_levels`, `org_templates`, `org_requests`, `org_grants`, `org_audit` | Yes |
| Workspaces | `tm_workspaces` (incl. `kind`, `visibility`, `governing_manager_id`, soft delete), `tm_members` | Yes |
| Tasks | `tm_tasks` (50 columns), `tm_assignees`, `tm_task_history`, `tm_checklist`, `tm_files`, `tm_change_requests`, `tm_due_requests`, `tm_requests`, `tm_reminders` | Yes |
| Meetings & calendar | `tm_meetings`, `tm_attendees`, `tm_meeting_shares`, `tm_meeting_followers`, `tm_meeting_changes`, `tm_calendar_notes`, `tm_event_reminders` | Yes |
| Timesheets | `tm_timesheets` (task optional since V5.7.0) | Yes |
| Notifications & audit | `tm_notifications`, `tm_notification_deliveries`, `tm_events` | Yes |
| Telegram | `tg_settings`, `tg_links`, `tg_link_codes`, `tg_groups`, `tg_sessions`, `tg_log` | Yes |
| Groups | 14 `tm_board*` tables | **Not mentioned** |
| Google Sheets | `tm_google_*`, `tm_board_sync*` | **Not mentioned** |
| CRM | 22 tables (`contacts` … `payments`) | **Not mentioned** |
| Operations/Finance | 12 `ops_*` tables | **Not mentioned** |

Key columns after all migrations:

- `tm_tasks`: workspace, CRM links, title/description, start/due date, `status` (NOT_STARTED, IN_PROGRESS, IN_REVIEW, COMPLETED, CANCELLED), priority, progress (0–100, checked against status), estimate, `pic_id`, `reviewer_id` + `reviewer_status`, `assigned_by`, `created_by`, department/note, accept/decline, stuck, submit, close trail, `request_id`, `source` (WEB/TELEGRAM/MINIAPP), recurrence (`recurrence`, `recurrence_rule`, `series_id`, `scheduled_due`, `series_anchor`, `next_task_id`), `reminder_days`, `version`, `creation_key`.
- `tm_workspaces`: owner, `kind` (legacy/governed model), `visibility` (PERSONAL/PUBLIC), `governing_manager_id`, origin/grant links, `joinable`, archive status, soft delete (`deleted_at/by/from_status`).
- `tm_profiles`: `manager_id` (reporting line), `org_level`, timezone, nickname, active.

## 5. Business rules that must be preserved

**Task visibility (`task-scope.mjs`, one implementation shared by every client)**
- Visible if directly involved: PIC, supporting assignee, reviewer, assigner, creator, `submitted_to`, or a pending change/due-date decision recipient.
- Or the PIC reports to the viewer directly or indirectly (`tm_profiles.manager_id` chain, cycle-safe). Supporting a task does not put it in the supporter's manager's branch.
- Or explicit `tasks.company` View. With Organizational Structure enabled, company-wide access covers legacy workspaces; governed work follows the organization rules.
- Seeing never grants editing, approval, closing or notification subscription.
- Own time entries remain visible with a minimal task reference after leaving a task. Guessed IDs are answered as "not found".

**Workspaces (V5.7.7)**
- Personal: owner + protected `ROLE-ADMIN` only. Rank gives nothing.
- Public: owner, authorized members, the owner's real direct/indirect managers, authorized Administration. Public ≠ company-wide.
- Adding a non-owner member converts Personal → Public **atomically, with an audit row** (DB trigger today).
- Removing a member never deletes tasks/history; owner cannot be removed; Public never silently reverts to Personal.
- Global workspace visibility is reserved to `ROLE-ADMIN`; custom roles/overrides cannot acquire it.
- Archive requires no open tasks or scheduled meetings. Soft delete + restore.

**Organizational Structure**
- View = read-only browsing; Create = management functions (must be granted explicitly; Create requires View).
- Levels (configurable, ≥ 1), Level 1 administrators, Level 2 workspace governors, lower levels report through a valid Level 2. Last active Level 1 cannot be removed.
- Delegation grants (capabilities, branch root, governing manager, parent grant); revocation suspends descendants.
- Membership/delegation/structure requests: pending → derived approver decides; approver re-derived at decision time; request keys/fingerprints prevent duplicates; impact preview with stale-preview rejection.
- `org_audit` is append-only (DB triggers block UPDATE/DELETE).
- Reporting-line changes reject self-management, cycles, inactive managers and cross-company IDs; need `admin.users` Update.

**Task workflow (`tasks.mjs`, `task-domain.mjs`)**
- Accept/decline by PIC, supporters and reviewer; progress, stuck/resume, submit, pass/return (review), close, cancel, reopen, note, handover, remind.
- **Two-party approval** (V5.4+): on a task someone else assigned, detail changes, progress changes, completion from the assigner's side, cancellation and reopening become a `tm_change_requests` row decided by the other side; only one pending change per task (partial unique index); `base_version` guards staleness.
- Due-date change requests; task requests to anyone (`doer` RECEIVER/REQUESTER/DECIDE) with forward/withdraw/decide.
- Recurring tasks (daily/weekdays/weekly/monthly + custom rules) create the next occurrence **when closed**; postponing one occurrence does not move the series; uniqueness on `(series_id, scheduled_due)`.
- Checklists, files (≤ 30 MB, preview types), deadline reminders per task (days before due), structured history for monthly reports.
- Idempotent repeated taps (Telegram/second tab) return "already done" instead of failing.

**Meetings, calendar, timesheets**
- Meeting visibility: organizer, creator, attendees, pending-change approver, `SELECTED` shares. Meeting edits stay pending until another participant approves. Followers can subscribe to reminders.
- Calendar notes are owner-only, even for company-wide viewers.
- Timesheets: unique per (task, person, day); ≤ 24 h per person per day; no future dates; independent entries (no task) since V5.7.0; deletion requires a reason and is logged; viewers who are not involved cannot edit others' time.

**Notifications & Telegram**
- Recipients follow participation, never visibility. The inbox hides notifications whose linked record is no longer visible.
- Telegram deliveries are tracked per notification and channel (sent/skipped/failed, retries), rechecked before sending, never sent twice.
- Disabling an account or changing a password ends sessions and the Telegram link.

**Existing test baseline (run here on Node 22.22; the project requires Node 24, which was not available in this workspace)**
- `npm run typecheck` ✅, `npm run build` ✅ (existing large-chunk advisory).
- Release suite: **9 of 12 pass** — `test`, `operations-test`, `organization-test`, `v569`, `v570`, `v570-sync`, `v571`, `empty-start`, `v577-access`.
- **3 fail before any change**: `v570-migration-test`, `v571-migration-test`, `v577-migration-test` — "database disk image is malformed", caused by the truncated fixtures described in §0.4. Please re-add the three fixture files with `git add`/`git push` from the machine that has the originals (not the GitHub web uploader), or send them to me.
- 42 test files (≈6.1k lines) in total; browser tests need Playwright and were not run.

## 6. Frontend ↔ service mapping

| Frontend (file) | Calls | Backend handler | Tables |
|---|---|---|---|
| Sign-in / setup (`identity-ui.tsx`, `ui.tsx`) | `POST /api/auth/login`, `/setup`, `/logout`, `GET /api/auth/status` | `access.login/bootstrap/startSession` | `access_users`, `access_sessions`, `access_attempts`, `access_audit` |
| Whole app shell (`ui.tsx`) | `GET /api/state` on load, `GET /api/changes` every 4 s | `access.filterState(store.state())`, `scope.filterState` | all readable tables, filtered |
| Workspaces (`tasks-ui.tsx`, `workspace-sections.tsx`) | `tm.workspace.save/archive/delete/restore/member.add/member.remove` | `tasks.mjs` → `organization.saveWorkspace/removeMember/membershipRequest` | `tm_workspaces`, `tm_members`, `org_requests`, `org_audit` |
| Tasks (`tasks-ui.tsx`, `task-workflow-ui.tsx`) | `tm.task.save`, `tm.task.<accept…reopen>`, `tm.change.*`, `tm.due.*`, `tm.check.*`, `tm.file.*`, `tm.task.reminders/remind/handover`; `GET /api/tasks/file` | `saveTask`, `flow`, `changeAction`, `dueRequest`, `checklist`, `files` | `tm_tasks`, `tm_assignees`, `tm_task_history`, `tm_change_requests`, `tm_due_requests`, `tm_checklist`, `tm_files`, `tm_reminders`, `tm_notifications` |
| Task requests (`task-workflow-ui.tsx`) | `tm.request.save/decide/forward/withdraw` | `request()` | `tm_requests` |
| Meetings / calendar (`calendar-ui.tsx`, `meeting-approval-ui.tsx`) | `tm.meeting.save/decide/withdraw/follow`, `tm.calnote.save/delete` | `meeting-workflow.mjs`, `calendarNote` | `tm_meetings`, `tm_attendees`, `tm_meeting_*`, `tm_calendar_notes` |
| Timesheets (`tasks-ui.tsx`) | `tm.time.save/delete` | `tasks.mjs` | `tm_timesheets` |
| Users & reporting lines (`tasks-ui.tsx`, `profile-ui.tsx`) | `tm.profile.save/manager/photo`, `me.profile.save`, `me.photo.*`, `me.sessions.end`; `GET /api/photo` | `tasks.mjs`, `access.mjs` | `lookups`, `tm_profiles`, `staff_photos` |
| Organizational Structure (`organization-ui.tsx`) | 16 `org.*` commands; `GET /api/organization?view=…` | `organization.mjs` | `org_*`, `tm_profiles`, `tm_workspaces`, `tm_members` |
| Administration (`access-ui.tsx`, `admin-functions.tsx`) | `admin.user.save/disable`, `admin.role.save/delete`, `admin.modules.save` | `access.mjs` | `access_*`, `erp_module_settings` |
| Telegram admin (`telegram-ui.tsx`) | `admin.telegram.*`, `tg.link.*` | `telegram.mjs` | `tg_*` |
| Task reports | `GET /api/tasks/report(.csv/.print)`, `/api/erp/dashboard`, `/api/erp/source`, `/api/erp/report*` | `task-domain.buildTaskReport`, `dashboard.mjs`, `erp-sources.mjs` | scoped state |
| Notifications inbox | `tm.notification.read` | `tasks.mjs` | `tm_notifications` |
| Mini App (`tg-app.tsx`) | `/tg/api/state`, `/changes`, `/command` (allowlisted subset of the above), `/report`, `/organization`, `/link`, `/login`, `/photo`, `/file` | `telegram-gateway.mjs` → same `store.command` | same tables |
| Groups (`groups-ui.tsx` + 3 files) | 25 `tm.group.*` commands, 9 `GET /api/tasks/group*` routes, `/api/google*` | `task-groups.mjs`, `group-sync.mjs` | `tm_board*`, `tm_google*` |
| CRM / Operations / Finance (`crm-*.tsx`, `operations-ui.tsx`, `finance-ui.tsx`, `erp-ui.tsx`) | `contact/lead/campaign/opportunity/quotation/order/payment/activity/document.*`, 13 `ops.*`; report/print routes | `service.mjs`, `operations.mjs` | CRM + `ops_*` tables |

## 7. Proposed Django / SQL Server architecture

```
Existing React app (unchanged screens)        Telegram Mini App            Telegram bot / reminders
   VITE_API_BASE_URL → /c/<co>/api/*             /c/<co>/tg/api/*            manage.py run_workers
                │                                        │                           │
                ▼                                        ▼                           ▼
   Django 5 + DRF ── compat layer (state / changes / command / files / reports) ──┐
                   ── REST resources (/api/v1/tasks/ … read + selected writes)     │
                   ── services/  (ported domain rules: scope, org, task workflow)   ◄┘
                   ── permissions/ (authorize + record scope, used by BOTH layers)
                          │  mssql-django + pyodbc + ODBC Driver 18
                          ▼
              SERVERSYSTEM / TaskManagement_Production  (least-privilege login)
```

**Recommended API strategy (Decision B, option 1):** Django serves the **existing contract** (`/api/auth/*`, `/api/state`, `/api/changes`, `/api/command`, file and report routes, and `/tg/api/*`), with each command ported into a Python service function with the same validation, permission and error messages. The React screens then need only a base URL change and CSRF handling. DRF resource endpoints (`/api/v1/users/`, `/workspaces/`, `/tasks/`, `/task-history/`, `/meetings/`, `/timesheets/`, `/notifications/`, `/organization/…`) are added alongside, using **the same permission and scope services**, for integrations and future screens. This is the "better contract" exception the brief allows; the resource names you listed remain available.

**Django apps** (your proposed layout, adjusted):

| App | Models (SQL Server tables) |
|---|---|
| `core` | `Company`, `Staff` (from `lookups` kind=staff), `Sequence`, `ModuleSetting`, `ChangeCounter` |
| `accounts` | `User` (custom, `AbstractBaseUser`, username + scrypt-compatible hasher), `Role`, `RolePermission`, `UserPermissionOverride`, `Session`, `LoginAttempt`, `AccessAudit` |
| `organization` | `Profile` (manager FK, level), `OrgSettings`, `OrgLevel`, `OrgTemplate`, `OrgRequest`, `OrgGrant`, `OrgAudit` (append-only) |
| `workspaces` | `Workspace`, `WorkspaceMember` |
| `tasks` | `Task`, `TaskAssignee`, `TaskHistory`, `ChecklistItem`, `TaskFile`, `TaskChangeRequest`, `TaskChangeField`, `DueDateRequest`, `TaskRequest`, `TaskReminderDay`, `TaskReminderSent`, `StaffPhoto` |
| `meetings` | `Meeting`, `MeetingAttendee`, `MeetingShare`, `MeetingFollower`, `MeetingChangeRequest`, `MeetingReminderOffset`, `CalendarNote`, `EventReminderSent` |
| `timesheets` | `TimeEntry` |
| `notifications` | `Notification`, `NotificationDelivery` |
| `telegram` | `TelegramSettings` (bot token encrypted), `TelegramLink`, `TelegramLinkCode`, `TelegramGroup`, `TelegramSession`, `TelegramLog` |
| `audit` | `ActivityEvent` (`tm_events`) |
| `compat` | no models — the `/api/state` + `/api/command` adapter |
| (if in scope) `groups`, `crm`, `operations` | the remaining tables |

**Schema conventions:** keep the existing text IDs (`TASK-000123`) as primary keys so migrated records, links, Telegram messages and reports stay valid. Dates become `date`/`datetime2` instead of ISO text. CHECK constraints become `CheckConstraint`. Partial unique indexes become SQL Server filtered unique indexes (`UniqueConstraint(condition=…)`). Case-insensitive uniqueness uses the database's CI collation (verified before migration). Small JSON arrays used for filtering (`reminder_days`, `reminder_offsets`) become child tables. Snapshot/audit payloads (`before_json`, `after_json`, `payload_json`) stay as validated `nvarchar(max)` JSON, because they are historical snapshots, not structures that get queried. Foreign keys default to `PROTECT`; cascades only where the current schema cascades. Indexes: task (`pic_id,status`), (`reviewer_id,status`), (`workspace_id,status,due_date`), (`due_date`), assignee/member/attendee by staff, profile (`manager_id`), (`org_level,manager_id`), workspace (`owner_id`), (`governing_manager_id,kind`), active flags, notifications (`staff_id,read_at,id`), change/due requests (`approver_id,status`).

**Concurrency:** SQLite currently serializes every write. On SQL Server each command runs in `transaction.atomic()` with `select_for_update()` on the rows it changes, keeps the `version` 409 checks, and keeps `creation_key` idempotency. The Personal→Public trigger and the append-only audit become **SQL Server triggers created in Django migrations**, plus a `DENY UPDATE, DELETE` on the audit table for the runtime login, so the rule still holds for any client.

**Files:** keep attachments in the database as `varbinary(max)` in a separate table for parity and single-backup simplicity (≈300 users). Moving them to a file share is possible later.

**Workers:** `manage.py run_workers` (Telegram bot polling + delivery outbox, due/meeting reminders, digests), run as a separate process or Windows service.

## 8. Migration strategy

1. **Find out whether real data exists.** `data/` is git-ignored, so I cannot see it. If production SQLite files exist, they are the source of truth.
2. **Importer** (`manage.py import_sqlite --company <id> --file erp.sqlite --dry-run`): read-only on the SQLite file; inserts in dependency order inside one transaction per company; preserves IDs, version numbers, timestamps, histories and audit rows; carries password hashes verbatim (scrypt-compatible hasher, so nobody needs a new password); decrypts Telegram/Google secrets with the folder's `secret.key` and re-encrypts with the Django key; sets `sequences` so new IDs continue after the highest existing one.
3. **Validation report**: row counts per table, FK orphan check, per-user visible-task counts computed by the old Node scope vs the new Django scope (must match exactly), password check on a sample account, and checksums of file sizes.
4. Synthetic fixtures (`fixtures/`, `seed*.mjs`, review launchers) are never imported into production.
5. If SQL Server is empty and there is no real SQLite data, the Django migrations create the schema and the first-administrator setup flow runs as today.
6. The Node/SQLite code stays untouched in `source/local-test/` until parity tests pass against Django. Retirement is a separate, later commit.

## 9. Files that will change

- **New:** `backend/` (Django project and apps above, `requirements.txt`, `.env.example`, `pytest`/Django tests, `manage.py` commands `import_sqlite`, `verify_parity`, `run_workers`), `docs/backend-migration/*`.
- **Modified, small:** `source/local-test/api-client.ts` (base URL from `VITE_API_BASE_URL`, CSRF header, `credentials: 'include'`), `source/local-test/crm-ui.tsx` (route its one direct `fetch` through `apiFetch`), `source/local-test/tg-app.tsx` (API base), `source/local-test/vite.config.ts` (dev proxy to Django, env typing), `source/.gitignore` and root `.gitignore` (`.env`, `backend/.venv`, `__pycache__`).
- **Not modified:** visual components, CSS, branding, page layouts, navigation.

## 10. Risks and conflicts

| # | Risk | Mitigation |
|---|---|---|
| 1 | **SQL login.** Your screenshot shows SSMS signed in as `Task Management`. The brief requires `taskmanagement_app` with no `sa`/sysadmin. | Use two logins mapped only into `TaskManagement_Production`: a **migration** login (`db_ddladmin` + read/write, used only to run `manage.py migrate`) and the **runtime** `taskmanagement_app` (`db_datareader`, `db_datawriter`, `EXECUTE`, plus `DENY UPDATE, DELETE` on audit tables). I will supply the T-SQL; you run it as your DBA account. |
| 2 | **Network reach.** This cloud workspace cannot connect to `SERVERSYSTEM`. | I develop and run the full Django test suite here on a local test database, and provide `manage.py verify_sqlserver` + exact commands. Stage 4 is run on an office machine (or by linking your computer to this conversation). |
| 3 | **Scope size.** The task core alone is ≈95 commands and ~10k lines of dense rules (`tasks.mjs` 1,526, `organization.mjs` 579, `telegram-bot.mjs` 1,035, `meeting-workflow`, `recurrence`, `task-scope`, `task-domain`). CRM + Operations + Groups + Google Sheets roughly doubles it. | Port in vertical slices, each with parity tests: auth/users → organization/workspaces → tasks workflow → meetings/timesheets → notifications/Telegram → (optional modules). Commit per slice. |
| 4 | **Shared records across modules.** Tasks and meetings reference CRM activities/contacts; staff live in the shared `lookups` table used by CRM/Ops. | If CRM/Ops are out of scope, they must be switched off — the app already has optional CRM, Operations, Finance and Report modules (`erp_module_settings`) — otherwise two backends would write to two databases. Groups is a function inside the Task Management module, so it cannot be switched off as a module; leaving it out means hiding it by permission. |
| 5 | **Multi-company → one database.** | Add `company` to every company-owned table and enforce it in the permission layer (an ID from another company is "not found"), or support a single company only. |
| 6 | **Polling load.** ~300 users × 1 request / 4 s ≈ 75 req/s on `/api/changes`. | Single-row change counter, indexed; `/api/state` only when the counter moves. Fine on one Django server; measured in Stage 5. |
| 7 | **Truncated test fixtures** block 3 upgrade tests. | Re-add the originals (see §5). |
| 8 | `source/local-test/fixtures/secret.key` is committed. It is a fixture key, but confirm it has never been used for a real data folder. | Rotate if it was ever used. |
| 9 | Node 24 required; only Node 22 was available here. | Results above may differ slightly on Node 24; rerun on your machine. |
| 10 | Telegram bot and Mini App need a public HTTPS URL. | Hosting is out of scope this phase; the local gateway path is kept. |

## 11. Decisions needed before Stage 2

| | Question | Recommendation |
|---|---|---|
| A | Which modules move to Django in this phase? | Task Management core (≈47 tables) first; switch CRM/Operations/Finance off, or migrate them in a following phase. Decide whether Groups + Google Sheets are included. |
| B | API contract | Django serves the existing state/changes/command contract (no screen rewrites) **plus** DRF resource endpoints sharing the same permission services. |
| C | Companies | How many companies are in use? One → single-company schema with a `company` table kept for later; several → `company` FK on every company-owned table. |
| D | Existing data | Is there a real `data/` folder (erp.sqlite + companies/) in daily use? If yes, the importer and validation report in §8 are part of this phase. |
| E | SQL logins | Confirm the runtime login name (`taskmanagement_app`) and that a separate migration login (or a DBA-run `migrate`) is acceptable. |

### Decisions recorded (15 Oct 2026)

- **A — Scope:** Task Management core only. CRM, Operations and Finance modules are switched off; Groups and Google Sheets are hidden (not migrated in this phase).
- **B — API:** Django serves the existing `/api/state`, `/api/changes`, `/api/command` contract plus REST resource endpoints using the same permission services.
- **C — Companies:** one company. Single-company schema; the `/c/default/` URL prefix keeps working.
- **D — Data:** no live data. SQL Server starts empty; Django migrations create the schema. The SQLite importer is deferred.
- **E — SQL logins:** done by the DBA (15 Oct 2026) using `sqlserver-logins.sql`: `taskmanagement_migrator` for migrations, `taskmanagement_app` for the running application.

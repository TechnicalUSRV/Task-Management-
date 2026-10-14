# Task Controlling Management V5.7.0

Release date: 13 October 2026. Based on the supplied V5.6.9 application and enhancement prompt. The supplied PDF logo is used as the source artwork.

## Scope and architecture

The existing React/TypeScript interface, Node.js service, company-local SQLite databases, permission catalog, and Telegram gateway remain in place. This is an incremental update, not a rewrite. Existing CRM, operations, finance, groups, reporting, organization, navigation, cards, tables, and sidebar structure are retained. Runtime environment-variable names, database filenames, session keys, API routes, and existing external spreadsheet row identifiers are retained for compatibility.

Source is in `source/local-test/`. Matching server modules and prebuilt web assets at the application root support the existing launch scripts. No real company database, credentials, or Telegram token is included. Test database fixtures contain synthetic data only and are never loaded by normal startup.

## Implemented changes

| Area | Behavior |
| --- | --- |
| Branding | Supplied Task Controlling Management logo on sign-in, desktop/compact navigation and Mini App; compact artwork increased approximately 15%. Browser titles, favicon, application messages and labels use the new name. Existing company names stored in data are not overwritten. |
| Expectation | New tasks and task requests reject blank or whitespace-only expectations in both the forms and backend. Historical tasks with empty expectations remain readable and are preserved during migration. |
| Recurrence | Daily/working-day intervals; weekly intervals with multiple weekdays; monthly intervals and a chosen month day. Short months use their last day. Rules survive approvals, subsequent occurrences and reopening. The existing trigger is retained: closing an occurrence creates its next occurrence; missed past dates are skipped. Unique series/date and creation keys prevent duplicate occurrences. |
| Authentication | Username sign-in, including spaces. Unicode normalization, trimmed/collapsed whitespace and case-insensitive keys enforce uniqueness. Contact email remains stored but is no longer the sign-in identifier. Existing password hashes, IDs and permissions are retained. |
| Identity | Main names come from usernames and cannot be edited through self-profile or staff-reference routes. Another authorized account administrator manages username changes. Optional nickname appears in parentheses; profile, person picker, task identity and organization components render it smaller. Native OS select menus and plain-text notifications retain plain-text names. |
| Uploads | Task and group attachments accept up to 30 MiB (31,457,280 bytes) per file. Web/Mini App request limits allow the base64 envelope. Existing MIME/signature, file type, ownership and access checks remain. Avatar size, import workbook limits and group aggregate quotas are intentionally retained. |
| Calendar | Personal task calendar uses directly involved tasks, separate from management oversight/task-list scope. Meetings are visible to participants or specifically selected viewers. Existing broad workspace/company meeting-sharing settings no longer expose meetings to uninvolved people. |
| Task approval | Existing assigner/PIC bilateral workflow also covers detail changes before acceptance and edits of closed records. An unavailable opposite party cannot silently bypass approval. Requests, decisions and effective changes remain audited. Detail edits to a task managed by one person require proposing another active reviewer or person in charge; the invitation and changed details take effect only on approval. Existing progress reporting, comments, checklists and lifecycle actions remain governed by their established workflow. |
| Meeting approval | Every effective edit is proposed first, with one pending request, a different designated reviewer, version checks, approve/reject/withdraw, notifications and audit history. Rejection preserves original details. A sole participant can propose inviting another participant; the invitee gets temporary access to review the request, and membership is applied only on approval. An inactive or unauthorized reviewer cannot apply changes. |
| Timesheets | Independent activity entries can omit task and workspace; optional workspace linking is supported. Existing task-linked entries remain intact. Only activities/tasks with time records appear. The rolling default includes the same weekday last week through today: eight inclusive dates. Week, month and custom ranges show totals. The current-day default refreshes as the date changes. The existing one-entry-per-task/person/day and 24-hour-per-person/day limits remain. |
| Workspace privacy | Same-level ownership never grants peer workspace access. Explicit membership and the existing reporting hierarchy remain effective. Unrestricted workspace visibility requires the explicit Administration → Global workspace visibility permission; Level 1 alone is insufficient. The built-in Administrator role includes it; custom roles must be explicitly granted it. |
| Mini App | Uses the same username authentication, scoped state, calendar, approval endpoints, nickname and recurrence rules. Adds independent time entry and range totals without changing the existing bottom navigation. |
| Google Sheets compatibility | Newly created row-key headers use the new branding. Existing external `ERP Row ID` headers are recognized in place, preserving row identity and preventing duplicate synced rows. |

## Upgrade and data protection

Read `MIGRATION_AND_ROLLBACK.md` before replacing an existing installation. Normal startup applies migrations per company, transactionally:

- **Schema 16:** adds task recurrence rules and profile nicknames; rebuilds only the timesheet leaf table to allow optional task/workspace links, preserving existing rows and IDs; adds meeting change requests and pending/series uniqueness indexes.
- **Schema 17:** adds username and normalized unique username key; derives usernames from existing staff display names; records account migration in the access audit. Collisions receive a deterministic staff-ID suffix. Passwords, contact emails and account IDs are retained.

Administrators should check the Username column after upgrading and inform employees of any collision-adjusted usernames. Existing passwords continue to work. Login attempts using email addresses now fail by design.

No destructive database reset is performed. Migration failure rolls back that migration rather than deleting conflicting records. If an existing database already contains duplicate series/date rows, resolve the data conflict on a backup before retrying; this release does not discard duplicate records automatically.

## Verification performed

Verified on Linux with Node.js 24.19.0 and Chromium 153, using isolated temporary companies and synthetic fixtures.

| Check | Result |
| --- | --- |
| TypeScript typecheck | Passed |
| Production web/Mini App build | Passed; existing large-bundle advisory remains |
| Core CRM/reporting/persistence/HTTP regressions | 16 check groups passed |
| Operations/finance workflow regressions | 15 check groups passed |
| Organizational hierarchy/delegation/privacy regressions | 13 check groups passed, with expectations updated for explicit Administration visibility |
| Group attachments/access/limits/layout regressions | 6 check groups passed, with username login and 30 MB expectations |
| New feature integration | 15 check groups passed, including actual 30 MiB HTTP upload, oversize/type rejection, username uniqueness, immutable name, nickname, recurrence boundaries/deduplication, calendar privacy, bilateral task/meeting changes, personal-task detail approval, sole-participant meeting approval, independent time, rolling boundaries and global permissions |
| Actual V5.6.9 schema fixture upgrade | Passed: account IDs/password hashes/emails, tasks, timesheets, file bytes, memberships and history preserved; collision resolved; reopen idempotent; foreign keys valid |
| Simulated Google Sheets | Passed: new header, existing header compatibility, two-way cell change, no duplicate rows and no synchronization loop |
| Browser acceptance | Six flows passed: sign-in/logo/navigation; immutable name/nickname; required expectation/custom recurrence; independent time and range controls; signed Mini App meeting approval; Mini App time entry and narrow-screen overflow check. No JavaScript page errors. |

Logs are under `verification/v5.7.0/`. From `source/`, use `npm ci`, `npm run typecheck`, `npm run build`, and `npm test` for the current release checks. Browser checks are optional: install Playwright separately, supply a compatible Chromium through `SUNNY_CHROMIUM_PATH` if required, then `npm run test:browser`. Browser screenshots are internal verification only and are not included as new deliverables.

Earlier test files and review notes remain for historical reference. `npm run test:historical` retains the former complete runner: several of those historical suites assert superseded email sign-in, old branding, 5 MB uploads, unilateral meeting edits or old hierarchy visibility, so it is not the V5.7.0 acceptance gate. The current release runner includes the adapted core, operations, organization and attachments regressions plus the new feature, migration and sync checks.

## Remaining deployment checks and boundaries

- This update has not been deployed to a company server. The original Node/SQLite architecture remains; it is not a Django/SQL Server conversion or an enterprise hosting certification.
- Windows launch scripts and actual Android/iOS Telegram clients were not executed here. The Mini App was tested through its signed gateway in Chromium. Live Telegram delivery and live Google OAuth/Sheets still need an environment check with the company's configuration.
- Telegram's hosted Bot API `getFile` download limit remains 20 MB. Files from 20–30 MB can be uploaded through the web system or Mini App; the bot directs users there. A Telegram local Bot API server can remove that hosted download constraint. See https://core.telegram.org/bots/api#getfile and https://core.telegram.org/bots/api#using-a-local-bot-api-server.
- Recurrence creates the next task when the current task is closed, as in the original system. It does not pre-create every future occurrence on a background schedule.
- The archive contains the original historical review files. They describe their named versions; this review and the current quick-start/migration instructions take precedence for V5.7.0.

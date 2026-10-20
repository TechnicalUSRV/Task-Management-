# Live Data, management scope, calendar, single-user tasks and Send to Telegram

Branch `feature/live-data-management-scope`, based on `feature/groups-mobile-sharing` at `f6b28aa`. Five requested
improvements only; everything else (UI, data, permissions, workflows) is unchanged. Not deployed. See
[DEPLOYMENT.md](DEPLOYMENT.md) for migration, backup and rollback, and [TEST_RESULTS.md](TEST_RESULTS.md) for evidence.

## 1. Summary

| # | Improvement | Where |
|---|---|---|
| 1 | **Share Live Data** (connected data) next to the existing **Share Data** (independent copy): column-level Viewer / Can edit, one source of truth, formulas over live values, edit history, change and revoke, conflict-safe edits | `backend/groups/live.py`, `groups/service.py`, `group-live-ui.tsx`, `groups-ui.tsx`, Mini App `tg-groups.tsx` |
| 2 | **Several reporting managers** and an explicitly chosen **management scope** (responsible managers) per Public / Organizational workspace; **Personal workspaces stay Personal** when members are added | `organization/governance.py`, `organization/models.py` (`ReportingLine`), `workspaces/models.py` (`WorkspaceManager`), migration `workspaces.0004`, `tasks-ui.tsx`, `organization-ui.tsx` |
| 3 | Calendar **Under My Management**: organizational title → employee → that employee's authorized meetings and task deadlines | `calendar-ui.tsx`, `compat/state.py` (`management_people`) |
| 4 | **No self-approval** when one person holds every responsible role on a task; two-party approval unchanged for multi-person tasks | `tasks/services.py`, `tasks-ui.tsx`, `tg-app.tsx` |
| 5 | Mini App **Send to Telegram** above the file list, opening a full-screen selection sheet; separate sending and PDF combining kept; the person **names the combined PDF** | `group-delivery-ui.tsx`, `tg-groups.tsx`, `groups/delivery.py` |

## 2. Root cause of the single-user approval error

`TaskService.save()` asks for the other party's approval of a detail change in two cases:

1. **Two-sided task** (`dm.two_sided`: the person in charge differs from the assigner) — the existing bilateral rule, unchanged.
2. **One-sided task** — a fallback looked for "another responsible party" among the reviewer, the creator, the new reviewer
   and the new person in charge, and **refused with 409 when it found none**:
   *"Choose another active reviewer or person in charge to approve this change. The task remains unchanged until approved."*

When Employee A is creator, person in charge and reviewer, every candidate is A, so the fallback could never succeed: the
task could not be edited at all. The rule counted *roles*, not *people*.

**Fix** (backend, mirrored in the web and Mini App editors): the fallback collects the *distinct other people* holding those
roles. If there are none, the change is saved directly after the normal validation, permission and locked-field checks,
with the usual task history entry. If another person holds a role, their approval is still required — and if that person is
unavailable the change is still refused (nothing is applied without them). Progress, completion and cancelling already
followed the distinct-person rule and are covered by regression tests.

## 3. Live Data architecture

* **One source of truth.** Values live only in the source Group's rows. A share (`tm_board_live_shares`) names one recipient;
  `tm_board_live_columns` lists the shared columns with `VIEW` (Viewer) or `EDIT` (Can edit).
* **Live Data column.** The recipient adds a column of type `LINKED` to their own Group. It stores **no values**, only the
  connection: share, source column, a source key column and a local key column (rows are matched, e.g. Item = Item, ignoring
  case and spacing). Each read looks the cells up in the source rows as they are now. Two source records with the same key
  show `#DUP!` and are never written; a revoked share shows `#N/A`; a removed source column shows `#REF!`.
* **Formulas.** A Live Data column whose source is a Number or Formula is numeric, so `Profit = {Revenue (live)} - {Cost}`
  works and recalculates on every read. Errors propagate (`#N/A` in Revenue → `#N/A` in Profit).
* **Writes (Can edit).** Editing a Live Data cell writes the **source row** in the same command transaction and under the
  same global write lock as every other change, with the existing “value you started from” check: a second editor working
  from an old value gets 409 `cell_conflict` and nothing is overwritten. Viewer edits are refused with 403 by the server
  (the UI also shows the cell read-only).
* **Edit history** (`tm_board_live_history`, append-only by the application): user, time, source Group and column, row,
  value before and after, action (edit, record added/deleted, import) and how (in the source group, through Live Data,
  import). Filterable by date range, person and column. Visible to the source Group's managers (all shared columns) and to
  Can edit recipients (their columns, rows they may see). Viewers and others get 403.
* **Authorization on every read and write.** The issuer must still manage and export the source Group (and edit it, for Can
  edit); the recipient must be active, have Groups permission and be within the issuer's collaboration scope; the source
  Group's own row and column access rules apply to the recipient; an archived source Group ends access. A share never
  grants workspace membership or opening the source Group (direct requests for it answer 404).
* **No loops.** Live Data columns cannot be shared onward, live or as a copy, and nothing is copied back.
* **Near real time.** Every saved change advances the existing change counter that the web app and the Mini App already
  poll (every 4 s while visible); an open Group then reloads its rows, reading the source again. Measured locally: 1.5–2.1 s.
  No WebSocket or new service was added, so the hosting arrangement is unchanged.
* **Share Data (independent copy) is unchanged** and both methods are named distinctly in the column menu: *Share Data
  (copy)…* and *Share Live Data…*.

## 4. Organizational structure and management scope

Concepts that stay separate: **creator**, **owner**, **responsible managers** (management scope), **members**, and
**reporting lines**.

* **Reporting lines.** The primary manager (`tm_profiles.manager_id`) still drives levels, Level 2 governance and approvals.
  `org_reporting_lines` adds *additional* managers (same level rules, no cycles, audited, approval rules as for structure
  changes). An additional line never widens visibility by itself.
* **Responsible managers** (`tm_workspace_managers`). When creating or editing a Public or Organizational workspace, the
  owner chooses from everyone above them on any reporting line (pre-filled with the primary manager). Those managers, the
  people above each of them on their primary line, and managers between the owner and a chosen manager see the workspace
  and its tasks through management. A manager who is not chosen gets nothing from supervising the owner.
* **Existing workspaces** have no responsible managers recorded and keep **exactly** the previous rule (the owner's primary
  reporting line). Nothing is widened by the migration or by adding a second manager.
* **A chosen scope never falls back.** If every chosen manager later leaves the owner's reporting lines, nobody sees the
  workspace through management (owner, members, governance and Administration still do) until the owner chooses again.
* **Delegated owners** creating an Organizational workspace choose the management scope and may add members from their
  approved branch; anyone else goes through the existing membership approval.
* **Personal workspaces stay Personal.** The database trigger that converted Personal → Public on any membership write is
  removed (`workspaces.0004`). Members explicitly added can open the workspace (Viewer members read only); managers do not
  gain access; the Administrator role keeps its existing exception. A Personal workspace becomes Public only when its owner
  explicitly makes it Public and confirms (audited as before).
* Applied in one place (`Governance.workspace_reason` / `task_reason`), so the workspace list and details, tasks, Groups,
  dashboards, reports, the Organizational Structure screens, the Mini App state and direct API requests all agree. Hidden
  records answer 404.

### Visibility matrix (who can open a workspace and its tasks)

Owner A reports to B (primary) and C (additional); B and C report to R (Level 1).

| Person | Personal (members only) | Public, no scope recorded (all existing) | Public, scope **B** | Public, scope **C** | Public, scope **B + C** |
|---|---|---|---|---|---|
| Owner A | ✔ | ✔ | ✔ | ✔ | ✔ |
| Explicit member | ✔ (Viewer: read only) | ✔ | ✔ | ✔ | ✔ |
| B (primary manager) | ✘ | ✔ (as before) | ✔ | ✘ | ✔ |
| C (additional manager) | ✘ | ✘ | ✘ | ✔ | ✔ |
| R (above the chosen manager) | ✘ | ✔ | ✔ | ✔ | ✔ |
| Administrator role / authorized Administration | ✔ (existing exception) | ✔ | ✔ | ✔ | ✔ |
| Anyone else, incl. peers and A's subordinates | ✘ | ✘ | ✘ | ✘ | ✘ |

Organizational workspaces follow the same columns and, as before, are also visible to their Level 2 governing manager.

Tasks follow the workspace. In addition, as before, people involved in a task see it, and a primary-line manager sees tasks
whose person in charge reports to them — except the owner's own tasks in a workspace whose owner chose other managers.
Groups in governed workspaces open only to the Group owner, workspace members, direct grants and authorized
Administration (unchanged); management scope never opens Groups.

## 5. Calendar — Under My Management

Shown only to people with someone below them on a reporting line (everyone for authorized Administration). Filters: **Title**
(the configured organizational level names, e.g. Team Leader — never "Level 3") → **Employee** → the calendar narrows to
that employee's meetings and task deadlines **among the items this person already receives**: tasks within their Task
Visibility Scope and meetings they take part in or that were shared with them. Personal calendar notes and CRM activities
are never included and never reach the manager's browser. Listing a name grants nothing.

## 6. Mini App — Send to Telegram

The attachment screen shows a **Send to Telegram** button above the files (each file with its type and size). It opens a
full-screen sheet: large touch rows, select all / clear, numbered selection order with move up/down, **Send files
separately** or **Combine PDFs and send** (only when every selected file is a PDF; otherwise the reason is shown), a **name
for the combined PDF** (cleaned on the server, `.pdf` added once, unsafe characters replaced), progress and result. Preview,
Previous/Next File, PDF page navigation and Download are unchanged. The web app's panel keeps its layout and gains the same
name field.

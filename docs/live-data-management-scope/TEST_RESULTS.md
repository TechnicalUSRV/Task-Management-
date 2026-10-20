# Test results — 21 October 2026

Environment: Linux review container, Python 3.13, Django 5.2 + DRF, Node 22, Chromium (Playwright). **The database for
every automated and browser test was SQLite** (`config.settings_test`, or a scratch review database with synthetic
people). **Nothing here was run against SQL Server, a real Telegram bot, or a phone inside Telegram.** Those checks are in
DEPLOYMENT.md §3 and remain to be done.

## Automated

| Check | Result |
|---|---|
| Backend suite `python -m pytest` (includes the V5.7.7 Node parity suites) | **144 passed, 102 subtests passed, 0 skipped, 0 failed** |
| `makemigrations --check` | no changes |
| Frontend `npm run typecheck` | passed |
| Group display formats `node --experimental-strip-types local-test/group-presentation-test.mjs` | 11 cases passed |
| `npm run build` | passed |

New or changed tests:

* `test_task_single_user_approval.py` (4): one person in every role edits title and expectation, progresses, completes and
  cancels with no change request and with history; a task with another person still waits for them (assigned task and a
  personal task with another reviewer); an unavailable required approver still blocks the change; the Mini App command
  path behaves the same.
* `test_management_scope.py` (14): two managers for one employee (audited); invalid additional lines refused; existing
  workspaces not widened; scope B / C / B+C through `/api/state`, direct `/api/v1` IDs, tasks, reports and the Mini App
  state; an unselected manager gets 404 on direct IDs and commands; choices limited to the owner's own lines; delegated
  owner chooses scope and branch members; Personal workspaces stay Personal and private; Under My Management lists people
  with configured titles and never ships private meetings or notes; **a chosen scope never falls back to the primary line
  when the chosen manager leaves** (added in this review).
* `test_live_data.py` (10): Viewer live values and formulas, no source edits; non-recipients never see values; Can edit
  writes the source with history and conflict refusal; downgrade and revoke take effect at once (`#N/A`, 403); source row
  rules and duplicate keys; protected connections and adding rows from the source; only source managers share, only
  permitted columns; independent-copy Share Data unchanged; Mini App; migration additive and reversible.
* `test_governance.py`: the four tests that asserted the old automatic Personal → Public conversion now assert it no
  longer happens (owner, member and Administrator access checked; managers denied).
* `test_group_enhancements.py`: named combined PDF (cleaning, `.pdf` once, refusals, idempotency key, separate sending
  keeps names).

**The tests detect the original faults.** Run against the unmodified `f6b28aa` code, the single-person task tests fail with
the exact production message (*409 “Choose another active reviewer or person in charge to approve this change. The task
remains unchanged until approved.”*) and the four Personal-stays-Personal tests fail; the multi-person approval tests
pass on both versions, showing that behaviour is preserved, not changed.

## Browser walkthrough (local review server, synthetic data)

Structure: Vanna (Executive Director) → Bopha, Chan (Department Manager) → Anan (Team Leader, primary Bopha, also Chan) →
Kosal (Sales Officer); Dara (Team Leader) under Chan. Screenshots are delivered with the review, not committed.

| Requirement | Observed |
|---|---|
| Responsible managers | New Public workspace form offers Chan Manager (reports directly) and Vanna Admin; pre-filled with Bopha. Workspace cards show “managed by …”. |
| Two managers, separate scope | Bopha sees *Retail Sales Drive* (scope Bopha) and Kosal's workspace (no scope, primary line); Chan sees *Supplier Review* (scope Chan) and Dara's *Sales Office*. Neither sees the other's, nor Anan's Personal workspace shared with Kosal. |
| Additional reporting line | Anan's person card: “Also reports to Chan Manager”; the reporting editor lists additional managers by valid level. |
| Calendar Under My Management | Title options are the configured names (Team Leader, Sales Officer). Bopha → Anan: the meeting with her and three deadlines under her scope. Chan → Anan: one deadline under his scope. Neither sees Anan's private supplier call, his personal note, or the task in his Personal workspace. |
| Single-person task | Editor says “You hold every responsible role on this task, so your changes are saved directly”; title saved, no change request. |
| Two-person task | Editor says “Changes need Kosal Member's approval”; title unchanged; one pending change for Kosal. |
| Share Live Data | Column menu offers *Share Data (copy)…* and *Share Live Data…*; dialog with Viewer / Can edit per column; revoke and change listed. |
| Live column + formula | Kosal's Profit Check: Revenue (live) $22,940.00, Profit = Revenue (live) − Cost = $4,840.00. |
| Near real time | Dara changes Revenue to 24,500 → Kosal's open page shows it (Profit $6,400.00) after **2.1 s** without reload; Kosal's Can-edit change → Dara's page after **1.5 s**. |
| Simultaneous edit | Second edit from the stale value: 409 `cell_conflict`, first value kept. |
| Edit history | Who, when, record, column, before, after, how; filter by person shows only Kosal's change. |
| Viewer / direct API | Viewer edit through the Group and through the Live Data endpoint: 403; recipient writing or opening the source Group directly: 404; no editor opens on a Viewer cell. |
| Revoke | Cells and the formula show `#N/A`; none of the source values appear anywhere in the recipient's API response. |
| Mini App Live Data (390×780) | Live column labelled “(Live Data)”, formula shown; Can-edit change from the phone saved in the source (756 → 800). |
| Mini App Send to Telegram | Button above the file list, visible without scrolling; files show type and size; full-screen sheet; rows ≥ 56 px; select/deselect; order; Combine disabled with a reason when a PNG is selected. |
| Combined PDF name | Real delivery worker (capturing transport, no Telegram call) sent **“October invoices - rice.pdf”**, 4 pages in the selected order (Invoice 002, Invoice 001 ×2, Delivery Note). Separate sending kept original names. |
| Preview unchanged | Preview opens File 1 / 4; Next File → File 2 / 4. |

No browser console errors other than the deliberately blocked `telegram.org` script.

## SQL Server DDL (generated offline, not executed)

`mssql-django` 1.8 was run in collect-only mode with a stubbed connection (no ODBC driver or SQL Server is reachable from
this environment; the Microsoft container registry and package repository are blocked). Reviewed output:

* new tables and indexes as listed in DEPLOYMENT.md §1;
* every new `FOREIGN KEY` without `ON DELETE` (no multiple-cascade-path error);
* `DROP TRIGGER IF EXISTS dbo.workspace_member_public;` (the other two triggers untouched);
* `ALTER TABLE [tm_board_deliveries] ADD [file_name] nvarchar(160) DEFAULT '' NOT NULL;` and
  `ALTER TABLE [tm_board_imports] ADD DEFAULT '{}' FOR [source_json];` — both defaults kept, so older code can still insert;
* the column-type CHECK dropped and re-added with `LINKED`.

## Migration round trip on populated data (SQLite copy)

After the walkthrough, a copy of the review database was migrated back (`groups 0003`, `workspaces 0002`,
`organization 0006`) and forward again. The conversion trigger was recreated on reversal and removed on reapplication.
Row counts and content hashes of `tm_workspaces`, `tm_members`, `tm_tasks`, `tm_boards`, `tm_board_rows`, `tm_board_files`,
`tm_profiles` and `org_audit` were identical; the only difference was the chosen name of one combined PDF in
`tm_board_deliveries.file_name` (removed with the column by the reversal, as documented).

## Not verified here

* Migrations and the application on **SQL Server** (staging restore of `TaskManagement_Production`).
* A real Telegram bot sending to a real chat, and the Mini App inside Telegram on Android and iOS.
* Performance on the company's largest Groups with Live Data columns (each Live Data column reads its source Group's rows
  on every read; measured only with small synthetic Groups).

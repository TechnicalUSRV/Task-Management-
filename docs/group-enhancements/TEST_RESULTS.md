# Verification results — Groups / Telegram enhancements

Handover finalized 18 October 2026. Base: `09154e3cfe25ee55967426acaf2bb2b9a1d13457`.

## Automated results

| Check | Result |
| --- | --- |
| Backend regression suite: `python -m pytest -ra --tb=short -k 'not browser'` | **109 passed, 1 deselected, 102 subtests passed** in 81.08 seconds. |
| Final focused suite after the PDF preloading fix: `python -m pytest tests/test_group_enhancements.py tests/test_groups_and_previews.py tests/test_mini_boundary_standalone.py -ra --tb=short` | **29 passed, 102 subtests passed** in 55.46 seconds. Includes the new oversized-batch check; overlaps the regression suite above. |
| `python manage.py makemigrations --check --dry-run --settings=config.settings_test` | Passed: no missing model migrations. |
| `npm run typecheck` | Passed on the final frontend. |
| `node local-test/group-presentation-test.mjs` | **11 display-format cases passed**; raw values and settings stayed unchanged. |
| Office HTTP request ID fallback | Passed: the existing `api-client.ts` UUID helper produces distinct valid version-4 UUIDs with `crypto.randomUUID` unavailable. Telegram delivery now uses this helper. |
| `npm run build` | Passed on the final frontend. Vite emitted its bundle-size warning for chunks above 500 kB; this is a performance review item, not a build failure. |
| `git diff --check` | Passed. |

The full-suite count predates only the final PDF batch preloading guard and the frontend switch to the existing HTTP-compatible UUID helper. The focused backend suite and frontend checks above were run after those changes. Counts are not additive.

Environment: Python 3.12, Django 5.2.18, DRF 3.18.3, pypdf 6.21.0, Node 24.19.0, TypeScript 5.9.3 and Vite 8.0.16. Backend tests use `config.settings_test` with temporary SQLite databases. The direct `.ts` display test uses Node's native TypeScript support; it was verified with Node 24.

## Behaviors covered

- Number/formula presentation does not change stored values or calculations; colors persist and stale row versions are refused.
- Explicit sharing exposes selected authorized columns and visible rows, without source editing or workspace membership. Formula dependencies, disabled recipients and lost issuer authority are checked.
- Internal import uses existing mapping, validation, matching keys and confirmation. Source changes or revocation block pending imports; completed copies stay independent; repeated commits do not duplicate rows.
- Telegram delivery binds to the sender's private linked account, rejects mixed-cell selections, preserves file order and original bytes, and rechecks permissions and link identity.
- PDF merging checks input/output size, page count, encrypted/unreadable files and page order. Oversized input batches are rejected before file contents are read. Visual annotations remain; actions are removed.
- Partial and ambiguous delivery results are recorded without automatic resend. Disabled users and interrupted jobs cannot silently send or retry.
- Mini App Group state matches the office-scoped Group state. Signed media, exact public-route allowlisting and current permissions are enforced.
- The additive migration preserves existing Group rows, file bytes and pre-existing imports in the test database.

The legacy Node V5.7.7 parity comparison excludes only the four intentionally added Mini App Group arrays. The parity adapter verifies their presence and types; a separate Django HTTP test checks their values against the office-scoped state. All previously existing fields remain under the original strict comparison.

All Telegram transport calls in tests are mocked. No employee received a test message. No production database, service configuration or running installation was modified.

## Remaining acceptance work

1. Run the migration and rollback rehearsal against an isolated restored **SQL Server** database. SQLite results do not establish SQL Server deployment acceptance.
2. Complete authenticated browser and actual Telegram Android/iOS checks for sidebar resizing, long filenames, Group tables, editing and continuous PDF viewing. Chromium was unavailable for the existing browser acceptance test; it was excluded from the final regression run.
3. Verify actual document delivery with a dedicated test bot and test accounts, including bot blocking, access changes and uncertain delivery handling.
4. Measure representative Group sizes and PDF batches on the office server; check frontend loading on the intended office network and public Mini App connection.

## Review follow-up — 18 October 2026

An independent review of commit `a48ea77` ran the full suite, built the frontend and walked through every feature in Chromium (desktop 1440×900 and a 390×780 phone viewport with signed Mini App launch data) on a local SQLite copy with synthetic data. Telegram sending used the real worker with a capturing transport; nothing was sent to Telegram. Fixes made on this branch:

| Area | Problem found | Fix |
| --- | --- | --- |
| Group page load | Each row on a page ran its own cell-color query (up to 200 extra queries per page). | One query per page (`styles_by_row`). Test: query count is the same for 2 and 12 rows. |
| Delivery worker | Polled every 2 s while holding the global write lock, even with nothing queued, so every user command could wait for it. | Unlocked idle check first; the lock is taken only when a job is queued or sending. |
| Queueing a delivery | The web request loaded up to 100 MB of file contents to re-check PDF headers that uploads already verified. | Metadata only at queue time; the worker still checks before merging. |
| PDF merge | Used a stricter PDF check than upload, so an accepted PDF with bytes before `%PDF-` could not be combined. | Same rule as the upload check. |
| Separate sends | Up to 20 documents sent back to back; Telegram refuses bursts in one chat (429). | ~1.1 s between documents. |
| Internal import | Row selection checked against a list (slow for thousands of rows). | Set lookup. Share/source lists cache permission lookups for the request. |
| Attachment popover | With *Send to Telegram* open it grew below the screen: order, Combine and Send were unreachable. | Limited to the available height and scrolls inside. |
| Mini App · Tasks | *Request Task* checked a `tasks.requests` permission that does not exist, so it never appeared (Home's button had been removed). | Uses the backend rule for requests (Tasks · View). |
| Mini App · tab bar | People without Groups permission got a Groups tab that only said they had no access, and lost the Requests tab. | They keep the Requests tab. |
| Mini App · styling | Table cells and file names showed heavy browser-default button borders; *Next File* was white on white in the dark viewer. | Explicit button styles. |
| Sidebar | The new icons broke the rule that lets long labels wrap ("Organizational Struc…"). | Selector fixed; labels wrap. |

After the fixes: **115 passed, 102 subtests passed** (four new regression tests, each confirmed to fail on `a48ea77`); migrations consistent; typecheck, display-format test and build passed. Remaining acceptance items 1, 3 and 4 above still apply; item 2 is covered for Chromium, but not for Telegram on real Android/iOS devices.

## UX follow-up — sidebar icons and Mini App Group table (18 October 2026)

- **Sidebar icons:** the sub-menu icons used the component's dark accent colour (`rgb(16, 24, 40)` on the navy sidebar). All sidebar icons now use the sidebar palette: a soft tint at rest, white on hover, gold (blue in the light theme) for the current page, with the current sub-page highlighted like a current main item. Checked in all five sidebar themes and the collapsed icon mode; contrast 6.6–9.5:1 at rest and 5.9–9.1:1 for the current page. Background, width, layout and navigation are unchanged.
- **Mini App Group table:** compact pickers (scope and workspace side by side, Group with Refresh), one tools row (search, Columns, Filter), and a table that fills the screen above the tab bar with pinned column headers and row numbers. Only the table scrolls. The open Group, search, filter, page and scroll position are kept after viewing a cell's attachments.

Same 50 records, same viewport, measured in Chromium:

| Phone viewport | Rows fully visible before | After | Table starts at (before → after) |
| --- | --- | --- | --- |
| 390 × 780 | 6 | **11** | 408 px → 183 px |
| 360 × 640 | 3 | **7** | 408 px → 183 px |
| 430 × 932 | 9 | **14** | 408 px → 183 px |

Functional checks in the new layout (14 passed): scope and workspace pickers, paging (51–56 of 56, table returns to its top), pinned row numbers while scrolling sideways, search, Columns menu, status Filter with active marker, cell editing, attachment preview, Send to Telegram (queued → sent), and returning from attachments to the same Group and column. Backend suite unchanged: 115 passed, 102 subtests.

Use the detailed acceptance, backup and recovery steps in [DEPLOYMENT.md](DEPLOYMENT.md). This branch is implemented and automatically tested; it is **not yet accepted for production deployment**.

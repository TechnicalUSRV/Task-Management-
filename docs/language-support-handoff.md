# Add English–Khmer–Chinese Language Support — work in progress

This branch starts from the reviewed deployment-candidate commit `2023d9f178726cde3d5b51aba87af9c152f8f65b`. It is a review branch. **Do not deploy or merge yet.** The office server and production database have not been changed by this work.

## Current status — 24 October 2026

**Unfinished; do not deploy.** Current catalog: **5,626 identified templates,
2,898 translated into both Khmer and Simplified Chinese, 2,728 still using
English fallback**. Historical counts and test runs below describe earlier
checkpoints. The latest screenshots predate the validation and bot conversation
batches; they demonstrate selected flows, not full translation coverage.

The bot conversation batch supplies translations for all currently marked
`backend/telegram/bot.py` templates. This does **not** complete the bot audit:
unmarked interpolated card headings, status fragments and change summaries
still need explicit display-only handling. Four internal exception diagnostics
were removed from translation marking. Connection help now describes the
existing username/password login correctly. Multiline TSV translations preserve
paragraphs, Telegram HTML markup and literal slash commands.

Validation: **27 focused language/Telegram tests passed**; catalog tests check
placeholder occurrence counts and HTML tag preservation. React language tests,
type checking and the production build also passed. SQL Server migration
verification, native-speaker review, complete UI/report coverage and remaining
legacy release-gate reconciliation are still outstanding.

## STEP OF WORK

1. Add the language selector and save each employee’s preference.
2. Translate all interface text into Khmer and Chinese.
3. Translate system messages, report headings, reminders, and Telegram templates.
4. Adjust fonts and layouts for all three languages.
5. Test all three languages across the website and Telegram Mini App, including saved preferences, fallback behavior, notifications, and mobile layouts.

## What is implemented

- `User.language` with `en` default; `accounts/0003_user_language.py`; a self-only authenticated `/api/me/language` endpoint and a verified-launch `/tg/api/language` endpoint. The website profile and Mini App settings have a native-name selector. Responses convey the account preference; stale responses cannot override a more recent choice. Preferences are stored in the same account, rather than separately in browser or Telegram storage.
- Request-local backend translation context, explicit message templates, English fallback, JSON response rendering, and recipient-language notification metadata (`notifications/0005_notification_translation.py`). Legacy notification strings and user-entered content remain as originally stored. Bot notifications resolve the recipient's current preference at delivery.
- Explicit `uiText` calls across most React screens; locally bundled Noto Sans Khmer and Noto Sans SC fonts; responsive language spacing. A number of static labels, account messages, report headers, PDF and print labels, and Telegram buttons are translated.
- `tools/i18n/extract.py` and `extract-ui.mjs` enumerate explicit templates. `tools/i18n/build-catalogs.py` builds `translations/km.json` and `zh-CN.json` from reviewed bilingual TSV files and bounded label patterns. Never mechanically translate employee content.

## Remaining, required before release

### Recovery checkpoint — 23 October 2026

Workspace maintenance removed earlier unpushed edits. The current verified
checkpoint restores the literal PDF worker import and removes protocol headers,
the CSP, numeric parser tokens, and developer diagnostics from translation
marking. Placeholder checks now compare occurrence counts, and `join_messages`
preserves nested translation metadata until the recipient language is known.

Validation at this checkpoint: **21 language/Telegram tests passed**; frontend
type checking and the production build passed. The rebuilt inventory contains
**5,448 templates**, **2,056 translated**, and **3,392 pending**. This reduction is
removal of non-display keys, not completion of the remaining translations.
No new browser evidence or production SQL Server migration has been verified.
The branch remains unfinished and **must not be deployed**.

1. Complete and review translations. The latest inventory has **5,459** explicit templates, of which **2,060** have Khmer and Chinese entries; **3,399** still fall back to English. `translations/work/remaining.json` lists missing templates. Re-run `python tools/i18n/extract.py && python tools/i18n/build-catalogs.py` after editing source or TSV terms. Native-speaker review is especially important for approval, privacy, and organizational wording. Some catalog entries are code fragments or identifiers and should be removed from marking rather than translated.
2. Audit all code-owned display labels not explicitly marked, particularly backend `Create`/`Delete` messages, frontend status/priority option maps, Group controls, Telegram dynamic text and menu labels, and client-side report/PDF print text. Internal status codes, aliases, CSS classes, selectors and field values must remain canonical. Some bot f-strings with message templates still collapse to English. Avoid rendering user names or descriptions through the catalog.
3. Add focused frontend tests for switching language without unmounting forms, late responses, English fallback, placeholder integrity, and PDF/print rendering. Verify live browser screenshots on web and Telegram mobile widths with Khmer and Chinese, including forms, tables, Group cells, sidebar, and exported documents.
4. Repeat backend migration tests with existing rows and SQL Server, and exercise recipient-specific reminders and alerts end-to-end with a fake Telegram transport. Confirm permissions, visibility, management scopes, approval rules, and task lifecycle unchanged.
5. Re-run all release gates after coverage and code cleanup. Do not merge this review branch or update the production server until the translated UI and deployment migration have been verified.

## Checks performed in this workspace

- Backend functional regression before latest small Telegram/report edits: **154 passed, 102 subtests passed** (excluded browser/parity suites).
- Focused language and Telegram tests after Telegram button/report changes: **24 passed**.
- `npm run typecheck` and `npm run build`: passed. Production build contains Chinese and Khmer font files. `manage.py makemigrations --check --dry-run` with SQLite: no changes detected.
- `npm run test:release` stopped in `organization-test.mjs`: it expects a shared Personal workspace to convert to Public, while current source keeps it Personal. This test and `organization.mjs` were unchanged in this branch; reconcile with current governance rules rather than changing behavior for a stale assertion.
- The optional legacy `erp-test.mjs` passed its first two checks, then failed reading `view.body.contacts.length` where `contacts` was undefined. Investigate against the unmodified baseline before attributing it to language changes.
- No browser screenshots, production SQL Server migration, actual Telegram delivery, or server deployment have been performed.

### Verified browser checkpoint — 23 October 2026

- `77e44ac`: private Telegram command descriptions and menu buttons follow the saved account language; cache and retry tests pass.
- `e8511a8`: code-owned label maps resolve in the current language without changing identifiers; React tests cover failed saves, draft preservation, stale responses and fallback. Type checking and the production build pass.
- Real Chromium acceptance now passes in English, Khmer and Simplified Chinese. It verifies website-to-Mini-App preference synchronization, Mini-App-to-website synchronization, unchanged unsaved profile text, fonts and page overflow. It uses synthetic records, a locally supplied Telegram bridge and real signed test launch data. No messages were sent to Telegram.
- Visual inspection found the Mini App's font shorthand overriding the language font. The CSS specificity fix resolves Khmer boxes; browser assertions now check the font family and loaded faces. Fifteen screenshots are in `docs/language-support/screenshots/`.
- These are **work-in-progress screenshots**, not proof of complete translation coverage. They visibly show English fallback. Current inventory at the screen-label checkpoint: **5,554 templates; 2,073 translated; 3,481 missing**. The larger inventory includes newly found display labels.
- Latest broad backend run: **158 passed, 102 subtests passed, 1 failed**. The remaining failure is the legacy Telegram parity scenario at bootstrap, because Django adds `language: en` to the user response. Full parity investigation and SQL Server migration verification remain outstanding.

The branch is not ready for deployment. Do not merge or deploy.

### Profile and sharing translation batch — 23 October 2026

Added complete Khmer and Simplified Chinese phrases for profile settings,
Telegram notification preferences, task visibility and sharing explanations,
management categories and task-form guidance. Display-only form nouns and
component defaults now translate without changing submitted values.

Current inventory: **5,563 templates; 2,139 translated; 3,424 pending**.
Validation: **22 focused language/Telegram tests passed**, React language tests,
type checking and production build passed. Earlier screenshots belong to the
browser checkpoint; they have not yet been regenerated for this batch.
Still unfinished; do not deploy.

### Short interface translation batch — 23 October 2026

Added Khmer and Simplified Chinese interface labels for navigation, files,
CRM, finance, groups and reminders. Reviewed ambiguous labels against their
source usage; “Won sales” is a count, not a monetary amount.
Current inventory: **5,563 templates; 2,322 translated; 3,241 pending**.
Validation: 22 focused backend language/Telegram tests and the React language
test passed. Screenshots are still from the earlier browser checkpoint.
Translation coverage remains incomplete; do not deploy.

### Scheduled reminder delivery — 23 October 2026

Task, meeting and personal-note reminders now retain nested translation metadata
through database persistence. Dates, month names, recurrence labels, reminder
offsets and task state phrases resolve at recipient delivery time. English
canonical wording and reminder scheduling/deduplication are preserved. Employee
titles, locations and notes remain literal.

Validation: **24 focused language/Telegram tests passed**, including generated
reminders and persisted nested metadata. Production build passed.
Inventory: **5,580 templates; 2,342 translated; 3,238 pending**.
Still incomplete; do not deploy.

### Mini App workflow and date review — 24 October 2026

- Added whole Khmer and Simplified Chinese phrases for task approvals, handovers,
  requests, reminder settings, empty states and form guidance. Shared display
  helpers translate relative dates, reminder lists and missing-field prompts.
  Canonical task values and employee content are unchanged.
- Fixed English-only approval prompts and form defaults. Waiting-person wording
  now uses whole singular/plural sentences rather than translated fragments.
- Chromium 134 in this environment reports no Khmer Intl date locale support.
  A display-only fallback translates Intl-owned weekday/month parts while
  retaining the original instant, time zone and numeric values. Unit coverage
  simulates missing ICU data and checks a date crossing midnight in Cambodia.
- Task visibility labels, selects and descriptions now occupy separate lines
  so translated descriptions do not crowd the selector.
- Current inventory: **5,608 templates; 2,526 translated; 3,082 pending**.
  Native-speaker review and complete coverage remain required.

Regression investigation: the Telegram legacy parity scenario fails at workspace
creation on both this branch and the isolated pre-language baseline
`2023d9f178726cde3d5b51aba87af9c152f8f65b`. Its employee fixture has no organizational
level, so Django correctly denies workspace creation. The parity adapter now
asserts the new account language is English before excluding that additive field
from legacy comparison. Permissions were not relaxed.

The organization test incorrectly expected sharing a Personal workspace to change
its visibility to Public; the same failure occurs on the baseline. Its assertion
now checks preserved Personal visibility and still checks sharing/revocation.
The ERP test used an obsolete email login payload; it now resolves the fixture's
username and uses the current login contract. Both suites pass **13 checks each**.
React language tests, type checking and production build pass. The preceding
broad backend run had **160 passed, 102 subtests passed, 1 legacy parity failure**.
Screenshots are being refreshed separately. SQL Server migration verification
and remaining legacy release-gate reconciliation are still outstanding.
**Not ready for deployment; do not deploy.**

### Refreshed browser and migration evidence — 24 October 2026

- Three Chromium acceptance scenarios passed (English, Khmer, Simplified Chinese),
  including synchronized preferences, preserved form drafts, loaded language fonts,
  no horizontal page overflow and no English weekday/month names in the Khmer
  Mini App heading. All 15 evidence screenshots were refreshed. Visual inspection
  confirms Khmer dates and the separated task-visibility field layout.
- A real migration-executor test passed on SQLite with pre-language rows. Account
  credentials, identifiers, role, active flag and version were preserved; the new
  preference defaults to English. Legacy notification text is unchanged and gains
  empty translation metadata. Saving a Khmer preference after migration persists.
  This is not SQL Server verification; the Windows instance is unavailable here.
- After correcting the two stale tests above, `test:release` advances to
  `v570-test.mjs:72`, where an old Personal-task edit scenario expects an exception.
  The same failure was reproduced on baseline `2023d9f`. It still needs reconciliation
  with current two-party approval behavior; application approval rules were not changed.
- Latest focused language/Telegram run: **24 passed**. Translation coverage remains
  incomplete (**3,082 pending templates**), so this branch is **not deployment ready**.

### Validation, approval details and calendar/access phrases — 24 October 2026

- Marked 104 literal field-label arguments at shared backend validation call sites.
  Only display labels change; option codes, values, identifiers and validation rules
  remain canonical. HTTP tests confirm translated error labels and an employee
  workspace name of “Save” remaining unchanged. Removed JavaScript's internal
  `[object Object]` coercion token from translation marking.
- Both clients now translate approval-change labels from known field identifiers,
  and translate known status/priority/visibility/recurrence codes for display.
  Titles, descriptions, people, departments and unknown legacy fields remain
  literal. Meeting reminder offsets use complete singular/plural phrases.
- Added Khmer/Chinese Mini App account-access, organization, calendar, meeting
  and reminder phrases. Current inventory: **5,630 templates; 2,642 translated;
  2,988 pending**. Screenshots in the previous evidence commit predate this batch.
- Validation: **26 focused backend tests passed**, frontend language tests,
  type checking and production build passed. A broader rerun was interrupted by
  an environment disconnect; use the preceding recorded broad run for comparison.
  Full coverage and native-speaker review remain unfinished; SQL Server is still
  unverified. **Do not deploy.**

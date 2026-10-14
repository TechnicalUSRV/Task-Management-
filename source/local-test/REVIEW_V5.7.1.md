# Task Controlling Management V5.7.1

This update is limited to sign-in branding and spacing, initial registration, and optional account contact email. It retains the existing two-panel page, colors, form components, navigation, permissions and V5.7.0 features.

## Requested changes

- The sign-in title is selectable HTML text: **Task Controlling Management**. It has no badge or filled container, and uses slightly larger responsive typography.
- The sign-in logo is larger and uses a transparent image inside an SVG viewport. The original clipboard/clock design and navy/blue palette remain recognizable; the supplied master artwork and logos elsewhere in the application are retained. The white paper and clock face are intentional parts of the logo, not a rectangular background.
- The desktop left panel uses a bounded 40–88 px content gap instead of stretching the two sections to opposite ends. Existing responsive behavior is retained.
- Initial registration has no Company input or selector. It creates the necessary internal company record as `Task Controlling Management`. Existing company records, company switching and company administration are preserved.
- Contact email is optional for initial setup and administrator-created accounts, including administrators created with a secondary company. Blank/whitespace input is stored as an empty string. Supplied emails still require valid formatting and remain unique within their company, case-insensitively.

## Dependency handling

The shared backend account validator serves both setup and Administration. Its email validation now runs only for supplied values. Schema migration 18 replaces the former unconditional email uniqueness constraint with a unique index restricted to nonempty emails, so multiple accounts can omit email. It retains all account columns and values, indexes, account triggers, staff IDs, roles and password hashes; it preserves session and individual-permission relationships and checks foreign keys before committing.

Username/password authentication, session expiry/revocation, last-administrator protection, company isolation and organization permissions retain their existing behavior. The Telegram Mini App uses the same username authentication and account IDs; it does not require a contact email or gain an initial-registration flow.

## Verification

- TypeScript typecheck and production web/Mini App build passed. The pre-existing large-bundle warning remains.
- Release regression checks passed for core workflows, operations, organization scope, group attachments, task/calendar/meeting/time behavior and simulated Google Sheets synchronization.
- Seven targeted backend groups passed: setup rollback, missing company/email, multiple email-free users, email validation and uniqueness, clearing email, authorization/company isolation and signed Telegram authentication.
- A synthetic database created by the unchanged V5.7.0 runtime upgrades successfully. Account, password, session, permission, company, staff, work, Telegram and organization rows are compared before/after. Existing logins, live sessions, permission overrides, Telegram links, foreign keys and reopening are checked. The V5.6.9 migration regression also passed.
- Eight empty-start checks passed, including initial setup without company/email, persistence, secondary-company isolation and linking an existing staff identity.
- Five targeted browser flows passed at 1440 px desktop and 390/320 px mobile widths, including actual image transparency, title styling, panel spacing, blank-email registration/user creation, username sign-in and Mini App connection.
- Six existing browser flows passed for navigation, profile, tasks, timesheets and Telegram meeting approval. Neither browser runner reported JavaScript page errors.

All tests use temporary or synthetic data. Telegram verification uses locally signed launch data and the real Mini App gateway/UI; no live Telegram bot or production account was used. Read `MIGRATION_AND_ROLLBACK.md` before upgrading an existing installation.

The archive includes the synchronized root runtime, rebuilt interface, source, tests and upgrade instructions. `REVIEW_V5.7.0.md` describes the previously delivered feature set; this document takes precedence for registration and sign-in behavior.

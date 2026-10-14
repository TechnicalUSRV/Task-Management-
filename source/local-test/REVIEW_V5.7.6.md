# Task Controlling Management V5.7.6

This release restores persistent access to the Telegram Mini App’s New Task action and slightly enlarges its system title.

- Home now always shows the existing Timesheets, New task and Request a task shortcuts. The Tasks screen also retains its New task shortcut. The existing button styles and arrangement are preserved.
- New Task’s form had not been removed: its shortcut was hidden when the account lacked task-creation permission or an eligible workspace. The shortcut now opens the existing form, the existing workspace-setup explanation, or an explicit permission message as appropriate.
- Timesheets remains visible alongside both task actions. Accounts without timesheet-view permission receive an explicit access message. Existing role permissions, workspace eligibility and backend authorization remain enforced; this update does not grant additional access.
- Only the Mini App’s brand line increases from 14 px regular text to 16 px, weight 600. The 33 px logo, title colors, approved sign-in branding, dashboard branding and other styles remain unchanged.

## Verification

TypeScript typecheck and the production build passed. Six new browser regression checks passed using temporary company data and a local Telegram gateway:

1. All three Home shortcuts remain visible without a workspace; New Task explains the existing workspace requirement. The Tasks screen shortcut also opens correctly.
2. New Task validates the required expectation, creates a task in the eligible workspace and persists it through reload.
3. Request Task sends a request to the selected manager.
4. Timesheets saves independent work with the correct duration and retains all three Home shortcuts.
5. All three shortcuts and the larger title fit 320, 390 and 768 px widths without horizontal overflow; the logo remains 33 px.
6. Restricted accounts see the shortcuts and appropriate access messages; direct unauthorized task and timesheet creation attempts receive HTTP 403 and create no records.

Five existing browser acceptance flows also passed: supplied-logo rendering, registration without Company/contact email, account creation without contact email and invalid-email handling, existing username/password sign-in and responsive branding, and Telegram Mini App connection with an email-free account. No JavaScript page errors occurred. Mobile screenshots were visually reviewed.

Production changes are limited to Mini App action visibility/access messages and its brand-line typography. Backend business logic, authentication, permissions, database schema, main-system components and logo assets are unchanged. There is no new database migration; schema remains 18. Logs and scope verification are in `verification/v5.7.6`.

Testing used a local signed Telegram gateway session, not a live Telegram client or production installation. Follow `MIGRATION_AND_ROLLBACK.md` and preserve the complete existing data folder when upgrading.

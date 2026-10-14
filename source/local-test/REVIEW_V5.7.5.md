# Task Controlling Management V5.7.5

This release preserves the approved V5.7.4 sign-in page and corrects branding elsewhere to use the compact icon and independent title text from V5.7.3.

- Sign-in continues displaying the complete supplied PNG with its original typography, spacing and smaller Management line. The sign-in component, styles and full-PNG renderer are unchanged.
- Dashboard navigation and the Telegram Mini App display the icon separately from the title text. Icon sizing no longer resizes the title. Existing V5.7.3 typography, title colors and duplicate-title handling are restored.
- Navigation icons display at 37 px; Mini App icons at 33 px; loading-screen icons at 88 px. Icons retain their original proportions and fit their containers. Collapsed navigation displays the icon with the title hidden, as before.
- Browser favicons use the icon again. The artwork is unchanged, with no added logo frame or background box.

Only branding components, branding-specific styles, favicon references, affected browser checks and release documentation/metadata changed. Authentication, permissions, registration, contact-email validation, company relationships and all other backend logic and SQL are unchanged.

## Verification

TypeScript typecheck and the production build passed; the existing large-bundle advisory remains. All five focused browser acceptance flows passed with no JavaScript page errors, including registration, account creation, existing sign-in and Telegram Mini App connection.

Sign-in was checked at 1440, 1024, 901, 768, 390 and 320 px widths. Desktop, 390 px and 320 px sign-in screenshots are pixel-for-pixel identical to V5.7.4. Expanded and collapsed dashboard branding were verified. Mini App branding was checked at 390, 320 and 768 px without horizontal overflow. Icon dimensions, proportions, separate title typography and absence of added image borders/backgrounds were checked.

There is no database migration from V5.7.4; the schema remains at version 18. Retain the complete existing data folder when upgrading and follow `MIGRATION_AND_ROLLBACK.md`. Logs are in `verification/v5.7.5`.

# Task Controlling Management V5.7.4

This release applies the complete supplied PNG to the system branding. It replaces the separate icon and recreated text used in V5.7.3.

- Sign-in, desktop/mobile navigation, loading screens and the Telegram Mini App display the same full PNG. Browser icons also reference this PNG.
- The PNG retains its exact original pixels, transparency, icon-to-text spacing, fonts and smaller Management line. No cropping, redrawing, recoloring or separate HTML wordmark is used.
- The added white logo tile, border and shadow are removed. The white paper and clock face contained in the PNG itself are preserved.
- Branding scales proportionally to available space. Sign-in uses up to 600 px, expanded navigation up to 212 px, loading screens up to 280 px and Mini App headers up to 240 px. Narrow screens and collapsed navigation scale the whole image down without clipping or distortion.
- The sign-in heading remains accessible through the image alternative text. Dashboard branding appears once; distinct company subtitles and company switching remain intact.

Only branding components, branding-specific styles, favicon references, the affected browser checks and release metadata/documentation changed. The surrounding colors, forms, controls, navigation actions and application features are unchanged. Backend logic, SQL and permissions are identical to V5.7.3.

## Image source

The package uses the earlier successfully supplied `Recolored clipboard clock task management logo.png` (2048 x 682 pixels), stored unchanged as `source/local-test/brand/task-controlling-logo.png`.

The later `Recolored clipboard clock task management logo(1).png` attachment was unavailable during this update and was not read or used. It needs to be uploaded again before its contents can be compared or applied.

## Verification

TypeScript typecheck and the production build passed. The existing large-bundle advisory remains. All five focused browser acceptance flows passed with no JavaScript page errors. They cover whole-PNG rendering, transparency, absence of image frames, aspect-ratio preservation, accessible branding, registration without company/contact email, account creation, existing sign-in and Telegram Mini App connection.

Sign-in was checked at 1440, 1024, 901, 768, 390 and 320 px widths. Expanded and collapsed dashboard branding were checked. Mini App branding was checked at 320, 390 and 768 px widths. The checked pages had no horizontal overflow. Desktop, mobile, collapsed navigation and Mini App screenshots were visually reviewed.

There is no new database migration; the schema remains at version 18. Retain the complete data folder when upgrading and follow `MIGRATION_AND_ROLLBACK.md`. Verification logs are in `verification/v5.7.4`.

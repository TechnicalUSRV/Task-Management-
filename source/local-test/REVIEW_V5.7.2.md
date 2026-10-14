# Task Controlling Management V5.7.2

This release makes only the three requested branding corrections to V5.7.1.

- **Sign-in title hierarchy:** Task Controlling Management is the primary H1, larger and heavier than the supporting heading and sign-in form heading. Your team's daily workspace is a smaller H2. The system title remains plain text with no background or decorative container.
- **Logo contrast:** a light neutral background is limited to the area immediately around the sign-in logo. The existing transparent logo asset, its 96 px display size, proportions and colors are unchanged. The surrounding page palette is unchanged.
- **Duplicate dashboard branding:** the redundant company subtitle is omitted when it repeats Task Controlling Management. The primary brand stays in its original location. Distinct company subtitles and the functional company selector remain available. The selector uses the display label Default company only when a company name repeats the system title; company IDs, stored names and switching behavior are unchanged. Sidebar styling, navigation and dashboard components are unchanged.

## Verification

TypeScript typecheck and production build passed. The existing large-bundle warning remains. The updated browser acceptance runner passed all five flows, covering title hierarchy, plain-text styling, transparent artwork, logo contrast, duplicate subtitle suppression, preservation of distinct company names, registration, user creation, sign-in and Telegram Mini App connection. No JavaScript page errors were reported.

Sign-in was checked at 1440, 1024, 901, 768, 390 and 320 px widths. Screenshots were visually reviewed at desktop and narrow mobile widths, along with the dashboard branding. The page has no horizontal overflow at the checked widths.

Comparison against V5.7.1 confirms that functional source changes are confined to `access-ui.tsx`, the sign-in rules in `styles/shell.css`, and the duplicate-label conditions in `ui.tsx`. Other changes are release metadata, this review, build output and the existing browser verification runner. All logo assets, backend logic, SQL schema, authentication and permissions are unchanged.

There is no database migration from V5.7.1 to V5.7.2; the schema remains at version 18. For an older installation, the previously supplied migrations still apply. Use the existing startup commands and retain the complete data folder when updating; see `MIGRATION_AND_ROLLBACK.md`.

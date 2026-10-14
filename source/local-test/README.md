# Task Controlling Management V5.7.7

The existing React/TypeScript frontend and Node.js/SQLite service. This release revises hierarchy-based Workspace privacy, adds member removal and separates read-only Organizational Structure View from management Create permission. Web and Telegram Mini App use the same authorization rules. Existing visual styles, branding and unrelated behavior are retained. Schema 19 adds an audited Workspace privacy field; read the upgrade instructions before using existing data.

For the normal prebuilt application, run `START_WINDOWS.cmd` or `sh START_MAC_LINUX.sh` in the application root. Read `READ_ME_FIRST.txt`, `REVIEW_V5.7.7.md` and `MIGRATION_AND_ROLLBACK.md` at the root before upgrading existing data.

For source development, use Node.js 24 or newer and run these commands from the `source` directory:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm start
```

The build writes `source/local-test/public`. A packaged release also copies this to root `public` and synchronizes root server modules with `source/local-test`.

`npm run test:browser` is an optional Playwright acceptance runner against temporary company data; it requires separately installed Playwright/Chromium. `SUNNY_CHROMIUM_PATH` selects an installed Chromium binary, and `SUNNY_PLAYWRIGHT_MODULE` can point to a Playwright module. No live company or external account is used by these tests.

The previous README is retained as `README_V5.6.9.md` for historical reference. Current release instructions take precedence.

Normal startup now starts empty. Read ../CLEAN_START_AND_EXIT_FIX.md; do not copy old data for a clean test.

# Rebuildable source for the local ERP test (V5.6.9)

Use Node.js 24+. In this source folder:

    npm install
    npm run build
    npm test
    npm start

The source version then opens on http://127.0.0.1:4305 and uses its own
local-test/data/erp.sqlite. Its Telegram Mini App gateway listens on
http://127.0.0.1:4306 (set ERP_TELEGRAM=off to start without Telegram).
Close another running copy first.

`npm test` runs 294 backend/API checks with temporary data only. The Telegram
checks use a simulated Telegram server and the Google Sheets checks a
simulated Google (local-test/google-fake.mjs); nothing on the internet is
contacted. To try Groups ↔ Google Sheets by hand without Google, run
`node local-test/google-fake.mjs` and start the ERP with the GOOGLE_* settings
it prints. The live Google connection has not been verified.

To let other people test from their own phones or computers (including the
Telegram Mini App) before the ERP is hosted, run `npm run share` instead of
`npm start`: it shares this computer's ERP through a temporary Cloudflare
HTTPS address (see "Sharing for testing" in local-test/README.md).

Runtime requirements: Node.js only. npm installation is needed only when you
want to edit/rebuild the React interface. The top-level packaged app is already
built and can be launched directly with START_WINDOWS.cmd.

Read local-test/README.md for architecture, the Task Visibility Scope,
notification policy, Calendar, Groups and Google Sheets design, background
jobs, migrations and the local test scope.

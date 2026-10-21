# Review test evidence

Reviewed source: `0c848c08b01bbccf56525e3fa93f371edd718c25`.
Corrections: `codex/review-task-privacy-camera-2026-10-22`.
Environment: Linux, Python 3.12.14, Node 24.19.0; isolated SQLite test databases and synthetic accounts.
No production records, live Telegram messages, browser screenshots or real camera devices were used.

## Results

| Check | Result |
| --- | --- |
| Functional Django suite below | **142 passed, 102 subtests passed**, 55.25 seconds; no failures/skips in this selected run |
| Frontend `npm run typecheck` | Passed |
| Frontend `npm run build` | Passed; existing large-bundle warning remains |
| Django `makemigrations --check --dry-run` with local SQLite configuration | No changes detected |
| Django `check` with local SQLite configuration | No issues |
| Populated-schema upgrade test | Passed; included in the 142 tests |
| Real JavaScript camera PDF generation parsed independently with pypdf | Passed; included in the 142 tests |
| Whitespace/error check `git diff --check` | Passed |
| Production SQL Server, actual Telegram delivery, browser visual/phone camera tests | Not run |

The functional suite is run from `backend`:

```sh
python -m pytest \
  --ignore=tests/test_browser_acceptance.py \
  --ignore=tests/test_parity.py \
  --ignore=tests/test_groups_parity.py \
  --ignore=tests/test_organization_parity.py \
  --ignore=tests/test_telegram_bot.py \
  -o addopts='' -q --junitxml=review-functional-results.xml
```

`config.settings_test` explicitly selects isolated SQLite and test-only credentials/hashing.
The frontend checks run from `source` with the pinned project dependencies. No optional
dependency upgrade was performed. Tests restored reference rows from the existing seed
migrations after transaction-test flushes. Synthetic operational employees were explicitly
mapped to levels; unmapped regression accounts remain unmapped. Workspace-ownership tests
were updated to deny unrelated Task visibility, as required by the new policy.

## New regression coverage

| Test file | What it establishes |
| --- | --- |
| `backend/tests/test_privacy_review.py` | Unrelated Workspace members cannot read Task details/files/history/reports; Viewer/Contributor limits; removal preserves PIC access; explicit manager isolation; Personal privacy; Administrator participation classification; strict unmapped denial before structure initialization; web/Mini sharing consistency; Task request approval retains selected scope; existing Administration onboarding; own-photo exception; private bot responses and restricted counts/digests. |
| `backend/tests/test_delivery_review.py` | Preparation sends nothing; exact final byte count and page order; known partial failure/cooldown retries only remaining files; ambiguous send is not retried; cross-job capacity and per-chat exclusive claims; expired worker token refusal; ordered splitting with measured output sizes; share revocation blocks Task PDF delivery. |
| `backend/tests/test_camera_pdf_review.py` | Runs the actual JavaScript PDF writer with three real JPEG inputs, independently parses the result, verifies three ordered pages, dimensions and exact JPEG bytes, and rejects zero/too-many/invalid-size inputs. This does not test a phone camera or DOM controls. |
| `backend/tests/test_review_migrations.py` | Creates the populated upstream schema in a separate in-memory database, applies the two review migrations and checks Task visibility, original file bytes, history, member permission and ready delivery preservation. This does not prove SQL Server compatibility. |

Existing functional tests also exercise Group/Live Data sharing, approval rules, reports,
management Calendar filtering, resources, media previews, Mini App authentication/boundaries,
Task workflows and organization governance. Telegram transports in delivery tests are
recorders/failure simulators: they never call Telegram or send messages to employees.

## Why the full historical parity suite is not reported as passing

The initial unmodified source run had **16 failures**. The four excluded parity files compare
responses with the old Node implementation, including old unmapped-user and Workspace-wide
Task visibility assumptions and exact response fields. Those expectations conflict with this
prompt's new contract. They remain unchanged as historical comparisons; they have not been
silently relaxed to make the report green. The browser acceptance file was not run.

Therefore **this is a passing selected functional suite, not a claim that bare `pytest` or the
old Node release suite passes**. Before making this a CI release gate, maintainers should
separate historical compatibility comparisons from tests for the current privacy contract and
review each retained expected difference. Do not solve a parity failure by restoring data leakage.

## Limits of the evidence

The split test reduces the size ceiling to exercise multiple measured parts; it is not a
50 MB+ production stress test. Claim tests verify serialized ownership/cap behavior but do not
prove SQL Server lock behavior or sustained multi-user throughput. Capacity output describes
the review machine only. No production backup or restore was performed. No screenshot is
presented as proof of a test that was not performed. Follow the staging and phone checklist in
[DEPLOYMENT.md](DEPLOYMENT.md) before production approval.

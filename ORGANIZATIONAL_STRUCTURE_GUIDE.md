> For the requested empty test system, start with **CLEAN_START_AND_EXIT_FIX.md**. The optional historical developer review below creates samples and is not the clean-start workflow. Normal START launchers now open an empty first-time setup.

# Sunny ERP V5.6.5 — Organizational Structure review

Read **WORKSPACE_MANAGEMENT_REVIEW.md** first for V5.6.4 Owner membership, creator deletion/recovery and the two-section manager dashboard. Prior flow corrections are recorded in **FLOW_FIX_REVIEW.md**. Where older instructions below require all lower-level membership additions to remain pending, the new creator-Owner exception takes precedence.

Updated 6 October 2026. Local review only; no deployment or hosting changes.

Function access is controlled by Administration roles and individual function
settings. Organizational Structure requires its own View permission; Task
access or an organizational level does not grant it implicitly. After that
permission check, the existing hierarchy governs which records and actions
are available. The protected Administrator role keeps full enabled-function
access. See PERMISSION_FIX_V5.6.2.md for the permission-editor correction.

## Open the working local version

Install Node.js 24 or later, extract the entire ZIP, and open a terminal in its top-level folder.

```sh
node organization-review.mjs
```

The old one-click sample-review launchers are not included in the clean package. The explicit developer script above remains available for isolated fixture review.

Open **http://127.0.0.1:4380/c/default/#/tasks/organization**. The launcher prints a signed Mini App URL for B, the approving manager, at port 4381. This browser preview uses the real gateway and company account checks with isolated review identities; it does not contact a Telegram bot or run Google synchronization.

Review logins: `a@review.test`, `b@review.test`, `c@review.test`, `d@review.test`, `e@review.test`, `x@review.test`, `y@review.test`. Password for these **review-only accounts**: `Review-organization-2026`.

The launcher creates `review-data` separately from the normal `data` folder. It retains review changes between runs. Restart the launcher if the signed Mini App link expires. To reset the sample, stop the launcher and rename/delete **only `review-data`**. Never rename/delete your normal `data` folder for this purpose. Ports may be changed with `ERP_ORG_REVIEW_PORT` and `ERP_ORG_REVIEW_MINI_PORT`.

The ordinary ERP still starts with `node server.mjs --open` or the existing START scripts. Read **MIGRATION_AND_ROLLBACK.md before opening existing company data**. No real employee mappings or workspace classifications are inferred by the upgrade.

## Where employee IDs, manager IDs and company scope appear

ERP: **Task Management → Organizational Structure → People**. Select an employee in the expandable tree or searchable table. Their stable employee ID, manager ID, level, Level 2 governor, memberships, owned workspaces and approved grants appear in the selected employee panel. The page heading identifies the company scope.

Mini App: open **Profile and settings → Organizational Structure**, or follow an organization approval notification. Mobile uses a searchable list and employee panel. Complex migration, level/template configuration and authority revocation are available in the ERP.

An employee ID identifies a staff record, not a job title or a login role. A login account refers to that employee. The primary manager is `tm_profiles.manager_id`; the level is `tm_profiles.org_level`. A workspace separately stores `owner_id` and `governing_manager_id`.

Company IDs such as `default` or `company-…` resolve to separate company SQLite databases and company-specific sessions. Employee IDs are stable **within that company**; `(company scope, employee ID)` is the complete identity. A matching employee ID in another company confers no access. The company ID is checked by the server and is not accepted from a command payload as proof of authority.

## Feature checklist

| Status | Feature |
| --- | --- |
| Completed | Shared backend governance for ERP Web, Mini App and existing Task integrations |
| Completed | Organization tree, search, pagination, employee panel, company/employee/manager IDs |
| Completed | Configurable levels beyond Level 5; one validated primary reporting manager |
| Completed | Level 1 initialization, company administration, last-administrator protection |
| Completed | Level 2 governance, separate workspace owner, delegated Owner capabilities |
| Completed | Pending delegation and membership, derived approvers, decisions, cancellations, idempotency |
| Completed | Impact previews, transaction/version checks, dependent grant suspension and approval rerouting |
| Completed | Organizational/personal classification, explicit personal sharing, legacy migration review |
| Completed | In Charge anchored task oversight; action/notification scope remains separate |
| Completed | Authorized outside Task/Meeting selection without automatic governed workspace membership |
| Completed | Owner-only Calendar notes and existing Personal Group protections |
| Completed | Append-only audit with employee/workspace/actor/action/date filters |
| Completed | Isolated review launcher, additive database migration, regression and authorization tests |
| Review required | Real company administrator/manager/level mappings and classification of legacy workspaces |
| Unverified externally | Actual Telegram iOS/Android clients, live delivery, Google OAuth and real Sheets synchronization |
| Deferred by request | Deployment, HTTPS hosting and production workers |

Screenshots and detailed evidence are in `verification/`; **TEST_RESULTS.md** distinguishes local tests from external behavior.

## Policy defaults and conflicts resolved

1. **Company-local authority.** Level 1 administers its company’s organizational content. It grants no login administration or unrelated-company access merely from a level assignment. Company modules can still be disabled through existing platform settings.
2. **Personal privacy first.** Unshared personal workspaces and their contents remain inaccessible to managers and Level 1. Only their owner can authorize sharing. Calendar notes and Personal Groups remain owner-only under their existing rules.
3. **Membership differs from oversight.** Membership grants normal workspace access subject to finer sharing. The reporting tree adds viewing of organizational Tasks and Reports anchored to the In Charge employee; it does not expose unrelated Meetings or Groups.
4. **Ownership differs from governance.** Every organizational workspace has one Level 2 governor. The operational owner is that manager or a valid approved delegate. Each delegated workspace has its own records and memberships. An origin link copies neither.
5. **Membership approval.** Lower-level additions/join requests stay pending until the responsible Level 2 approves. A direct Level 2 addition records its approval. Level 1 can make an audited administrative addition. A lower-level user cannot choose a friendly approver or imitate direct approval flags.
6. **Personal sharing.** The owner shares directly; there is no Level 2 approval and no implicit conversion to organizational.
7. **Titles are labels.** Owner is an editable template label with explicit approved capabilities. Renaming a title or a job position never promotes the employee or grants authority. Existing grants retain their approved capability snapshot when a template changes.

The old application auto-added invitees to workspace membership, had broad role-based administrator access and no personal/organizational workspace classification. These conflicts are resolved for **explicitly governed workspaces**: outside invitations become resource-only, personal privacy overrides management access, and membership is separately approved. Existing LEGACY workspaces retain the old workflow until reviewed and classified. Migration does not guess which existing records are private or bulk-remove memberships. This transition is visible in the page and is not a claim that unreviewed legacy workspaces already enforce the new policy.

No additional “strictly private task” field/rule was found in the inspected task model. Existing owner-only Calendar notes and Personal Groups are preserved. A task inside a personal workspace receives no hierarchy access; direct participants explicitly invited by an authorized owner retain their resource access.

The supplied chart guided the employee/branch arrangement. Where its repeated “Level 2” labels differ from the written delegation rules, the written rules govern: an approved lower-level Owner stays at their assigned level.

## Policy matrix

| Actor / authority | Workspace access | Tasks and Reports | Management and approvals | Notifications |
| --- | --- | --- | --- | --- |
| Level 1 | Company organizational content; personal only if owner/shared | All organizational records; existing task workflow still enforced | Structure, levels, titles, governors, grants, audited administrative membership | Only direct participation, assigned request or relevant outcome |
| Level 2 | Assigned governed workspaces and independent memberships | In Charge in direct/indirect reporting subtree; independent direct sharing | Own branch and governed workspaces; approves eligible requests | No automatic subscription to subordinate work |
| Ordinary Level 3+ | Approved memberships; own/shared personal spaces | Direct involvement, normal membership, permitted descendant oversight | Existing resource actions; own reporting-change and join requests | Existing participant events and relevant request outcomes |
| Approved Owner at Level 3+ | Separate workspace permitted by approved grant | Same visibility rules, with no automatic parent-workspace inheritance | Only granted scope/capabilities; every further delegation requires approval | Same event-based recipients |
| Outside collaborator | Specific Task/Meeting only | Authorized record and independently permitted linked data | Existing participant actions; no workspace membership | Relevant participant notifications |
| Unrelated peer/branch/subordinate | No access just from level or company | No automatic superior/peer access | None from rank alone | No automatic notices |
| Personal workspace owner | Own workspace; explicit owner-controlled sharing | Owner/shared records | Existing task actions still apply; owner controls membership | Authorized participants only |

Level 1 explicitly overrides organizational Group content restrictions (including TEAM Group row/column rules). **Personal Groups retain their existing owner-only rule**, including when located in an organizational workspace. No level automatically allows task editing, reassignment, approval, deletion or closure. Direct Task participation, membership, finer Meeting/Group sharing and existing role permissions continue to determine actions.

| Capability key | Approved authority |
| --- | --- |
| `workspace_create` | Create a separate delegated organizational workspace |
| `workspace_manage` | Manage an owned workspace within the grant |
| `membership_request` | Nominate eligible employees in the approved branch |
| `delegate_request` | Request a subset of current authority for a reporting employee |
| `structure_request` | Submit reporting changes for the permitted branch |
| `collaborate_outside` | Invite outside participants to permitted Tasks/Meetings |

Grants are branch-scoped, optionally workspace-scoped, and tied to a Level 2 governor and supporting parent grant. Every lower-level delegation is rechecked and approved. Revocation suspends invalid descendants. Existing valid workspace memberships are independent access and remain until explicitly revoked.

## Review walkthrough

1. Sign in as **A**. Expand A → B → C → D → E; X → Y is a separate branch. Select C to see manager B, Level 3, Owner grant and separate Workspace C. Switch to Table and search an employee ID.
2. Sign in as **B**, or use the printed Mini App link. Open Approvals and review C’s pending Owner request for D. Before approval D cannot create an organizational workspace; after approval D can, governed by B. Rejecting a request activates nothing.
3. Review Y’s membership request for Workspace C. It stays pending until B approves the cross-branch addition. Confirm the recorded requester, responsible approver, role and reason. Membership does not move Y’s reporting relationship.
4. Sign in as **C**, select D and choose **Delegate authority**. Select the supporting grant and requested capability subset. Submit to the derived Level 2 manager. Lower-level requests cannot become active immediately.
5. In Workspaces choose **New workspace → Organizational** as an approved Owner. A matching active grant and Level 2 manager may be derived, or explicit IDs supplied. The new workspace starts with its owner; it does not inherit all parent members or data.
6. Sign in as **E**. E’s personal planning task is absent from A/B/C’s governed task lists, reports and Calendar feeds. The owner can use **Add member** to share the personal workspace explicitly. Personal Calendar notes remain owner-only even after sharing the workspace.
7. As A/B, open a permitted employee’s **Change reporting**, edit the manager/level, enter a reason and preview the impact. Supply any necessary workspace replacements and acknowledge before saving. Related changes can be entered together. A stale preview is rejected; refresh it before retrying.
8. As Level 1, use **Levels & titles** to configure labels and capabilities. Use **Assign employee** for further Level 1 or Level 2 assignments. Level 1 reports to the organization root; Level 2 must report to Level 1; lower levels must report through an earlier valid level under Level 2. Last-active-Level-1 removal is blocked.
9. Use **History** to filter changes by employee/workspace IDs, actor, type and date. Expand Before/after to inspect recorded values. Audit records cannot be updated or deleted through application SQL operations.

If a manager/owner must be deactivated, first reassign their reporting employees and affected organizational workspaces through the reviewed structure/governance forms. Task PIC/reviewer/assigner fields are never silently rewritten by a reporting change.

## Data and API changes

Schema version **13** is additive. New tables: `org_settings`, `org_levels`, `org_templates`, `org_requests`, `org_grants`, `org_audit`. Existing tables gain organization fields on `tm_profiles`, `tm_workspaces`, `tm_members` and `tm_notifications`. Foreign keys and indexes support existing company-local identities. Migration is idempotent and does not create review accounts; only the explicit review launcher does.

ERP queries: `GET /c/<company>/api/organization?view=people|employee|workspaces|join|requests|audit|migration`, with server-side authorized filtering and pagination. Mini App uses the corresponding signed `/c/<company>/tg/api/organization` endpoint.

Commands use the existing authenticated `/api/command` or signed Mini App `/tg/api/command`: `org.initialize`, `org.level.save`, `org.template.save`, `org.preview`, `org.structure.save`, `org.structure.request`, `org.workspace.save`, `org.workspace.classify`, `org.membership.request`, `org.membership.remove`, `org.delegation.request`, `org.grant.revoke`, `org.request.decide`, `org.request.cancel`. Server checks remain authoritative. Complex initialization, template/level management and grant revocation are restricted to the ERP interface; mobile exposes relevant information, reporting requests, workspaces, memberships and approvals.

Structural writes use the organization revision plus record versions where applicable. Request keys/fingerprints prevent duplicate grants or membership activation. Approval authority is rederived at decision time. Reporting/ownership changes invalidate cached scope, suspend invalid grants and reroute pending requests; delivery rechecks the current recipient. Notification outbox deduplication is preserved. As in the existing bot, an interrupted ambiguous send is skipped rather than retried blindly, so delivery is not promised to be exactly-once during transport failure.

Main implementation files (source copy under `source/local-test/`):

- `organization.mjs`, `organization.sql`: company governance, requests, capabilities, migration, audit and query service.
- `organization-ui.tsx`, `styles/organization.css`: shared page/forms and scoped styling.
- `service.mjs`, `access.mjs`, `task-scope.mjs`, `tasks.mjs`, `task-groups.mjs`, `erp-sources.mjs`, `erp-registry.mjs`: integration with existing authorization and business workflows.
- `tasks-ui.tsx`, `task-workflow-ui.tsx`, `task-domain.mjs`, `ui.tsx`: navigation, form integration, visibility explanations and notification links.
- `tg-app.tsx`, `telegram-gateway.mjs`, `telegram-bot.mjs`, `telegram.mjs`: shared mobile governance, signed requests and delivery scope.
- `organization-fixture.mjs`, `organization-review.mjs`, `organization-*-test.mjs`: isolated review and automated verification.

Existing navigation structure, sidebar colors, branding, component styles and other ERP modules remain in place. New styles are scoped to the organization page. Previously requested duplicate-navigation/footer cleanup, Calendar text removal, Mini App Calendar swipe and larger logo are retained from the baseline.

## Development and workers

The ZIP includes built pages and portable backend files; running the local ERP does not require an npm install. To edit and rebuild:

```sh
cd source
npm ci
npm run typecheck
npm run build
npm test
npm run test:organization
npm run review:organization
```

After rebuilding source, run it through `npm start`; its compiled files live in `source/local-test/public`. The top-level portable copy does not automatically update when rebuilding source.

Normal `server.mjs` startup retains existing Telegram, reminder and Google sync workers. `ERP_TELEGRAM=off` disables Telegram for a normal local run. The isolated organization review launcher starts **none** of those external workers. Company bot links and existing credentials are not replaced by migration. Production worker/HTTPS setup follows a separate deployment review.

# Task Controlling Management V5.7.7

This release implements the requested hierarchy-based Workspace visibility, member removal and Organizational Structure permission separation. Existing visual styles, colors, navigation, sign-in, branding, task workflows and unrelated modules are retained.

## Permission rules

| Area | Implemented behavior |
| --- | --- |
| Personal Workspace | Owner and the built-in Administrator role can open the Workspace. Organizational rank alone gives no access. |
| Public Workspace | Owner, authorized members, the owner's actual direct/indirect reporting managers, and authorized Administration can view it. Public does not mean company-wide or anonymous access. |
| Peers and other branches | No automatic Workspace access, even at a higher or equal level or under the same manager. Explicit membership or existing specific authorization is required. |
| Adding a member | Adding someone other than the owner converts Personal visibility to Public in the same transaction. The owner is informed in the existing form. |
| Removing a member | Authorized owners, creators with existing management authority, and governing managers can remove members. The owner cannot be removed. Membership-based access ends; the Workspace stays Public. |
| Task access | Public Workspace managers can view its tasks. Existing individual task/meeting participation remains separately authorized and never opens a private Workspace. Removal does not delete tasks or revoke independently valid participation or reporting-manager access. |
| Administration | Global Workspace visibility, including Personal Workspaces, is reserved to the protected `ROLE-ADMIN` Administrator role, independent of organizational level. Custom roles or individual overrides cannot acquire it. |
| Organizational Structure — View | Read-only hierarchy browsing within the authorized scope. Management tabs/actions and management API requests are unavailable. |
| Organizational Structure — Create | Enables the existing organizational management functions, subject to all existing authority, approval, validation and revision checks. Create requires View, as with the other permission rows. |

Existing group/calendar sharing rules remain separate. Notification recipients and task-assignment/approval workflows are retained. Minimal record references for a specifically invited task/meeting do not confer Workspace membership.

## Code changes

- `organization.mjs`: shared Workspace/task visibility, scoped dashboards, read-only hierarchy queries, management permission checks, and reusable member removal. Migration/history/impact responses also filter hidden Workspace data.
- `workspace-privacy.mjs`: transactional schema-19 migration and database triggers for atomic Personal-to-Public conversion and audit recording.
- `access.mjs`, `access-catalog.mjs`, `erp-registry.mjs`, `admin-functions.tsx`: explicit Organizational Structure Create permission; global Workspace permission restricted to the Administrator role and marked as reserved in the existing permission matrix.
- `tasks.mjs`, `task-scope.mjs`: shared removal command, Workspace visibility metadata, and checks for direct requests naming hidden legacy Workspaces. Existing task lifecycle logic is unchanged.
- `organization-ui.tsx`, `tasks-ui.tsx`: existing dialogs/buttons gain Remove member, Public classification and conversion explanations; View-only Organizational Structure hides management controls. Existing styling is reused with no CSS changes.
- Telegram gateway/bot and relevant meeting selectors use the same privacy flag and domain authorization. The Mini App removal endpoint is explicitly allowlisted. Main-system and Mini App records are filtered by the same backend policy.

## Database migration and existing data

Schema **19** adds `tm_workspaces.visibility` with checked values `PERSONAL` and `PUBLIC`. The existing `kind` field and all governance/ownership/delegation relationships remain intact: `kind` continues describing the legacy or governed ownership model, while `visibility` controls privacy. New owner-managed Public Workspaces therefore do not need a new Level 2 delegation.

On upgrade, unshared Personal Workspaces stay Personal. Existing Personal Workspaces containing another member become Public without removing memberships. Existing Organizational and Legacy Workspaces start Public. Conversion records an audit entry. Subsequent member additions convert visibility atomically through database triggers; failed commands roll back membership, visibility and audit together. Removing the last additional member does not silently make a Public Workspace private again.

No accounts, tasks, assignments, memberships, passwords, prior audit history or existing permission rows are deleted. No organizational Create grants are added automatically. Existing View-only roles/users become read-only for Organizational Structure. Administrators must explicitly grant **Task Management → Organizational Structure → Create** to the people who should continue managing it. A non-administrator's previously stored global-Workspace grant is preserved in storage but no longer confers global visibility.

Follow `MIGRATION_AND_ROLLBACK.md`. Back up the complete stopped installation and data folder before upgrading. Rollback requires the old application plus its matching complete pre-upgrade data backup; do not run V5.7.6 against the migrated database.

## Verification

- TypeScript typecheck and production build passed. The existing large-bundle advisory remains.
- The release regression suite passed, covering existing task/approval flows, organization/delegation, identity/contact-email handling, uploads, timesheets, synchronization, older database upgrades and empty startup.
- **11 focused web and signed Mini App API checks** passed: direct/indirect hierarchy; peer/branch privacy; report filtering; lower-level Administration and rejected custom global access; guessed IDs; atomic failed additions; Personal-to-Public conversion and Viewer limits; member removal with retained task/manager access; owner protection and authorized legacy creator removal; View-only restrictions; scoped migration/audit/preview responses; and Create-authorized management. Related scenarios are grouped within those checks.
- A real synthetic V5.7.6 database upgrade retained all accounts/password hashes, tasks, profiles, memberships, saved permission rows and prior audit records. Visibility conversion, valid existing login, SQLite integrity/foreign keys and repeat-open idempotence passed. Earlier V5.6.9 and V5.7.0 upgrade regression fixtures also passed.
- **15 browser checks** passed: four new hierarchy/member-management flows, five existing registration/sign-in/branding flows, and six Mini App Request Task/New Task/Timesheets flows. The new dialogs were visually reviewed. Phone layouts at 320/390 px and existing responsive branding checks passed; no JavaScript page errors occurred.

Testing used isolated synthetic company data, local web servers and signed Telegram gateway sessions. No live Telegram client or production installation was changed. Logs and scope checks are in `verification/v5.7.7`.

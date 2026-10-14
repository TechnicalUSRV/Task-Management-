# V5.7.7 Workspace privacy and Organizational Structure permissions

1. Stop the application, Telegram gateway/bot and sharing processes. Back up the **complete installation and entire data folder**, including all company databases, attachments, registry files and encryption keys.
2. Extract V5.7.7 into a new folder. Copy the complete stopped data folder into its root. Do not run old and new versions against the same data.
3. Start normally with Node.js 24 or newer. Schema 19 runs transactionally for each opened company database, adds `tm_workspaces.visibility`, and installs audited membership-conversion triggers. No table rebuild or record deletion is required.
4. Unshared Personal Workspaces remain private. Previously shared Personal Workspaces become Public, preserving memberships and existing task-specific access. Organizational and Legacy Workspaces are Public. Only actual reporting managers, authorized members/owners and the Administrator role receive applicable visibility; Public does not grant company-wide access.
5. In Administration, review **Task Management → Organizational Structure → Create**. Existing View grants now allow only read-only hierarchy browsing; no Create rights are silently granted. Assign Create explicitly to the users/roles who need management functions. The protected Administrator role already has it. Custom global-Workspace permissions/overrides no longer grant global access.
6. Check Workspace counts and classifications, memberships, role permissions, representative public/private tasks, pending approvals, reports and both web/Mini App access before using the new folder for daily work. Existing accounts/passwords and task records are retained.

**Rollback:** stop V5.7.7 and restore the complete pre-upgrade data backup together with V5.7.6 (or the corresponding old application). Do not point an older app at schema 19. There is no reverse migration; work entered after the backup is not contained in it. Keep the upgraded folder separately if it contains newer work.

The included synthetic V5.7.6 migration test verifies preserved accounts/passwords, task/history/member/profile/permission records, audited conversion, working login, integrity/foreign keys and idempotent reopen. Earlier instructions below remain historical references only; these V5.7.7 instructions take precedence.

# V5.7.6 Mini App action visibility and title

V5.7.6 restores visible Request Task, New Task and Timesheets shortcuts while preserving workspace and role restrictions, and slightly enlarges only the Mini App system title. Updating from V5.7.5 adds no database migration; schema 18 and all account/data rules remain unchanged. Follow the stopped-installation backup and complete data-folder transfer procedure below, extracting the V5.7.6 archive. Earlier notes still apply to older installations.

# V5.7.5 icon sizing correction

V5.7.5 preserves the approved sign-in page and restores compact icons with independently sized title text elsewhere. Updating from V5.7.4 adds no database migration; schema 18 and all account/data rules remain unchanged. Follow the stopped-installation backup and complete data-folder transfer procedure below, extracting the V5.7.5 archive. Earlier notes still apply to older installations.

# V5.7.4 complete PNG branding update

V5.7.4 uses the complete supplied PNG for responsive branding and removes the added logo frame. Updating from V5.7.3 adds no database migration; schema 18 and all account/data rules remain unchanged. Use the stopped-installation backup and complete data-folder transfer procedure below, extracting the V5.7.4 archive. Earlier notes still apply to older installations.

# V5.7.3 logo and title update

V5.7.3 updates only the logo artwork and brand-title colors. Updating from V5.7.2 adds no database migration; schema 18, all account/data rules and existing UI sizes/layout remain unchanged. Follow the stopped-installation backup and complete data-folder transfer procedure below, extracting the V5.7.3 archive. The earlier notes still apply to older installations.

# V5.7.2 branding update

V5.7.2 contains only frontend branding corrections. Updating from V5.7.1 adds no database migration; schema 18 and all account/data rules remain unchanged. Use the same stopped-installation backup and data-folder transfer procedure below, extracting the V5.7.2 archive. For versions before V5.7.1, the migration notes below still apply.

# V5.7.1 upgrade and rollback

1. Stop the current application, Telegram gateway and any sharing process. Ensure nobody is writing to the database.
2. Back up the **complete existing installation and its entire `data` folder**, including all company databases, attachment data, registry files and encryption keys. Keep the backup separate and unchanged.
3. Extract the V5.7.1 ZIP into a new folder. Copy the complete stopped installation's `data` folder into this new application's root. Do not copy only `erp.sqlite`; other company databases and keys are also required. Do not run both installations against the same folder.
4. Start with `START_WINDOWS.cmd` or `sh START_MAC_LINUX.sh` using Node.js 24 or newer. The prebuilt interface is included; npm installation is unnecessary for normal root-folder startup.
5. Migration 18 applies automatically when each company database opens, allowing multiple empty contact emails while retaining uniqueness for supplied emails. Older installations also receive migrations 16 and 17. Existing V5.7.0 usernames and passwords remain unchanged. Sign in with the existing display name as **Username** and the existing password. Open Administration → User accounts to review usernames, including any collision suffixes. Custom administrator roles need the explicit Global workspace visibility permission if that access is intended.
6. Check the company's task counts, attachments, timesheets, organization, usernames and Telegram configuration in this new folder before switching daily users to it. Test bilateral changes with two accounts and verify personal-calendar privacy.

The migration preserves IDs, links and historical content. It does not initialize demo data or reset records. The release tests include an synthetic V5.6.9 and V5.7.0 database upgrades, including preservation of existing passwords, sessions, per-user permissions, company/staff/work records and Telegram links, plus second-open idempotence checks.

## Rollback

Stop V5.7.1 completely. Restore the **old application and the entire matching pre-upgrade data backup together**. Never point the old version at a database already migrated to schema 18. A rollback to the backup does not retain work entered after that backup; preserve a separate copy of the upgraded folder if it contains new work. There is no automatic reverse migration.

If migration fails, keep the original backup. Do not delete tables, change schema markers, or reset company data to bypass the error. Review the reported conflict on a copy of the database.

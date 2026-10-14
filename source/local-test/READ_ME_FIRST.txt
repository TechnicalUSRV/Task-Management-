TASK CONTROLLING MANAGEMENT — V5.7.7

Read REVIEW_V5.7.7.md for the implemented changes, tested behavior and remaining deployment checks.
Read MIGRATION_AND_ROLLBACK.md BEFORE upgrading an existing installation.

1. Stop the previous application and make a complete backup.
2. Extract this ZIP fully into a new folder.
3. To retain existing records, copy the complete stopped installation's data
   folder into the new application's root. An installation without a data
   folder starts empty; normal startup never creates sample accounts or data.
4. Windows: double-click START_WINDOWS.cmd.
   macOS/Linux: run sh START_MAC_LINUX.sh.
   Node.js 24 or newer is required. The built web interface is included.
5. Open the printed address, normally http://127.0.0.1:4305.
6. Existing accounts now sign in with USERNAME (derived from their previous
   display name), plus their existing password. Contact email is no longer
   the sign-in identifier. Administrators can review the Username column.
   New installations ask only for the first administrator; contact email is
   optional. The required internal company record is created automatically.

This update: Public Workspaces follow the owner's actual reporting hierarchy.
Personal Workspaces are private to their owner and the Administrator role;
adding another member converts them to Public. Authorized owners/managers can
remove members without deleting tasks or history. Organizational Structure
View is read-only; Create enables existing authorized management functions.
An Administrator must explicitly grant Create to the intended managers.

Schema 19 adds Workspace visibility and preserves all existing records.
Previously shared Personal Workspaces become Public, retaining memberships.
Back up the complete data folder before upgrading. Follow the migration and
rollback instructions; do not use the previous app with the upgraded database.

Also included from V5.7.0: supplied new logo and branding; required Expectation; custom repeat
rules; usernames and nicknames; 30 MB task/group attachments; participant
calendar privacy; two-party changes; independent timesheets with rolling,
week, month and custom totals; and explicit global workspace permissions.

Rolling timesheets include both endpoints: the same weekday last week through
today (eight dates). Recurring tasks create their next occurrence when closed.
Meeting edits are pending until another participant approves. Self-only
meetings can propose inviting another person to review the change.

Do not overwrite your data folder with test fixtures. The source fixtures are
synthetic test inputs only. Earlier review documents describe older versions;
REVIEW_V5.7.7.md takes precedence for this release.

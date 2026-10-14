CREATE TABLE IF NOT EXISTS tm_profiles (
 staff_id TEXT PRIMARY KEY REFERENCES lookups(id), email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 position TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), version INTEGER NOT NULL DEFAULT 0,
 -- V5.5 (added to earlier databases by the upgrade in tasks.mjs): the person this employee reports to (reporting
 -- lines decide which tasks a manager can see) and their own time zone ('' = the company's).
 manager_id TEXT REFERENCES lookups(id), timezone TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tm_workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
 owner_id TEXT NOT NULL REFERENCES lookups(id), color TEXT NOT NULL DEFAULT 'BLUE', status TEXT NOT NULL CHECK(status IN('ACTIVE','ARCHIVED')),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tm_members (
 workspace_id TEXT NOT NULL REFERENCES tm_workspaces(id), staff_id TEXT NOT NULL REFERENCES lookups(id), PRIMARY KEY(workspace_id,staff_id)
);
CREATE TABLE IF NOT EXISTS tm_tasks (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES tm_workspaces(id), activity_id TEXT UNIQUE REFERENCES activities(id),
 contact_id TEXT REFERENCES contacts(id), related_type TEXT NOT NULL DEFAULT '', related_id TEXT,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, due_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('NOT_STARTED','IN_PROGRESS','IN_REVIEW','COMPLETED','CANCELLED')),
 priority TEXT NOT NULL CHECK(priority IN('HIGH','MEDIUM','LOW')), progress INTEGER NOT NULL CHECK(progress BETWEEN 0 AND 100),
 estimate_minutes INTEGER NOT NULL DEFAULT 0 CHECK(estimate_minutes>=0), reason TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES lookups(id), completed_at TEXT, version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 -- V5.2 workflow (added to earlier databases by the upgrade in tasks.mjs): one person in charge, the
 -- reviewer who assigned the work, a department note and the accept / stuck / submit / close trail.
 pic_id TEXT REFERENCES lookups(id), reviewer_id TEXT REFERENCES lookups(id), department TEXT NOT NULL DEFAULT '', department_note TEXT NOT NULL DEFAULT '',
 accepted_at TEXT, declined_at TEXT, declined_reason TEXT NOT NULL DEFAULT '', stuck_at TEXT, stuck_by TEXT REFERENCES lookups(id), stuck_reason TEXT NOT NULL DEFAULT '',
 submitted_to TEXT REFERENCES lookups(id), submitted_by TEXT REFERENCES lookups(id), submitted_at TEXT, submit_note TEXT NOT NULL DEFAULT '',
 closed_by TEXT REFERENCES lookups(id), request_id TEXT REFERENCES tm_requests(id), source TEXT NOT NULL DEFAULT 'WEB',
 -- V5.3 (added to earlier databases by the upgrade in tasks.mjs): the reviewer confirms the role, and repeating tasks.
 reviewer_status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK(reviewer_status IN('PENDING','ACCEPTED','DECLINED')), reviewer_responded_at TEXT, reviewer_note TEXT NOT NULL DEFAULT '',
 recurrence TEXT NOT NULL DEFAULT '' CHECK(recurrence IN('','DAILY','WEEKDAYS','WEEKLY','MONTHLY')), recurrence_until TEXT, series_id TEXT, next_task_id TEXT,
 -- The planned date of a repeating task and its day of the month: postponing one occurrence does not move the series.
 scheduled_due TEXT, series_anchor INTEGER,
 -- V5.4 (added to earlier databases by the upgrade in tasks.mjs): the assigner (the other side of two-party approval)
 -- and the deadline reminders chosen for this task (days before the due date, JSON array).
 assigned_by TEXT REFERENCES lookups(id), reminder_days TEXT NOT NULL DEFAULT '[1]',
 CHECK(status<>'COMPLETED' OR progress=100), CHECK(status<>'NOT_STARTED' OR progress=0)
);
CREATE TABLE IF NOT EXISTS tm_assignees (
 task_id TEXT NOT NULL REFERENCES tm_tasks(id), staff_id TEXT NOT NULL REFERENCES lookups(id),
 -- V5.3: supporting people confirm (PENDING → ACCEPTED or DECLINED). The person in charge's answer is on tm_tasks.
 status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK(status IN('PENDING','ACCEPTED','DECLINED')), invited_by TEXT REFERENCES lookups(id), invited_at TEXT,
 responded_at TEXT, response_note TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(task_id,staff_id)
);
CREATE TABLE IF NOT EXISTS tm_timesheets (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id), staff_id TEXT NOT NULL REFERENCES lookups(id),
 work_date TEXT NOT NULL, minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440), notes TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(task_id,staff_id,work_date)
);
CREATE TABLE IF NOT EXISTS tm_meetings (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES tm_workspaces(id), task_id TEXT REFERENCES tm_tasks(id),
 activity_id TEXT UNIQUE REFERENCES activities(id), contact_id TEXT REFERENCES contacts(id), title TEXT NOT NULL, agenda TEXT NOT NULL DEFAULT '',
 organizer_id TEXT NOT NULL REFERENCES lookups(id), start_at TEXT NOT NULL, end_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN('SCHEDULED','COMPLETED','CANCELLED')), minutes_notes TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 -- V5.5 (added to earlier databases by the upgrade in tasks.mjs): who else may see the meeting besides its organizer and
 -- attendees, and its reminders (minutes before the start, JSON array). Earlier meetings stay visible company-wide.
 share_scope TEXT NOT NULL DEFAULT 'PARTICIPANTS' CHECK(share_scope IN('PARTICIPANTS','WORKSPACE','COMPANY','SELECTED')),
 reminder_offsets TEXT NOT NULL DEFAULT '[]', created_by TEXT REFERENCES lookups(id)
);
CREATE TABLE IF NOT EXISTS tm_attendees (
 meeting_id TEXT NOT NULL REFERENCES tm_meetings(id), staff_id TEXT NOT NULL REFERENCES lookups(id), PRIMARY KEY(meeting_id,staff_id)
);
CREATE TABLE IF NOT EXISTS tm_events (
 id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, workspace_id TEXT REFERENCES tm_workspaces(id),
 action TEXT NOT NULL, detail TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_task_dates ON tm_tasks(workspace_id,status,due_date);
CREATE INDEX IF NOT EXISTS tm_time_date ON tm_timesheets(staff_id,work_date);
CREATE INDEX IF NOT EXISTS tm_meeting_dates ON tm_meetings(start_at,end_at,status);
CREATE INDEX IF NOT EXISTS tm_event_entity ON tm_events(entity_type,entity_id,id);
-- V5.1 additive indexes: person-based checks (deactivation, member removal, meeting overlap) and journey lookups.
CREATE INDEX IF NOT EXISTS tm_assignee_staff ON tm_assignees(staff_id);
CREATE INDEX IF NOT EXISTS tm_attendee_staff ON tm_attendees(staff_id);
CREATE INDEX IF NOT EXISTS tm_member_staff ON tm_members(staff_id);
CREATE INDEX IF NOT EXISTS tm_meeting_workspace ON tm_meetings(workspace_id,status);
CREATE INDEX IF NOT EXISTS tm_event_entity_id ON tm_events(entity_id);
-- V5.2 Task workflow: task requests to a chosen manager, due-date change requests,
-- a structured history for monthly reports and per-person notifications (also sent to Telegram).
CREATE TABLE IF NOT EXISTS tm_requests (
 id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES tm_workspaces(id),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', department_note TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL CHECK(priority IN('HIGH','MEDIUM','LOW')), proposed_due_date TEXT,
 requested_by TEXT NOT NULL REFERENCES lookups(id), manager_id TEXT NOT NULL REFERENCES lookups(id),
 status TEXT NOT NULL CHECK(status IN('PENDING','APPROVED','DECLINED','WITHDRAWN')),
 decision_note TEXT NOT NULL DEFAULT '', decided_by TEXT REFERENCES lookups(id), decided_at TEXT,
 task_id TEXT REFERENCES tm_tasks(id), source TEXT NOT NULL DEFAULT 'WEB',
 version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 -- V5.3: requests go from anyone to anyone (manager_id is the person asked). doer: who does the work once accepted.
 doer TEXT NOT NULL DEFAULT 'REQUESTER' CHECK(doer IN('RECEIVER','REQUESTER','DECIDE'))
);
CREATE INDEX IF NOT EXISTS tm_request_manager ON tm_requests(manager_id,status);
CREATE INDEX IF NOT EXISTS tm_request_requester ON tm_requests(requested_by,status);
CREATE TABLE IF NOT EXISTS tm_due_requests (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id), requested_by TEXT NOT NULL REFERENCES lookups(id),
 decide_by TEXT NOT NULL REFERENCES lookups(id), current_due_date TEXT NOT NULL, proposed_due_date TEXT NOT NULL, reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('PENDING','APPROVED','DECLINED','WITHDRAWN')), decision_note TEXT NOT NULL DEFAULT '',
 decided_by TEXT REFERENCES lookups(id), decided_at TEXT, source TEXT NOT NULL DEFAULT 'WEB',
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_due_task ON tm_due_requests(task_id,status);
CREATE INDEX IF NOT EXISTS tm_due_decider ON tm_due_requests(decide_by,status);
CREATE TABLE IF NOT EXISTS tm_task_history (
 id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id), kind TEXT NOT NULL,
 from_status TEXT, to_status TEXT NOT NULL, progress INTEGER NOT NULL, stuck INTEGER NOT NULL DEFAULT 0 CHECK(stuck IN(0,1)), due_date TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 actor_id TEXT NOT NULL REFERENCES lookups(id), source TEXT NOT NULL DEFAULT 'WEB', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_history_task ON tm_task_history(task_id,id);
CREATE INDEX IF NOT EXISTS tm_history_kind ON tm_task_history(kind,created_at);
CREATE TABLE IF NOT EXISTS tm_notifications (
 id INTEGER PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES lookups(id), kind TEXT NOT NULL,
 task_id TEXT REFERENCES tm_tasks(id), request_id TEXT REFERENCES tm_requests(id), due_request_id TEXT REFERENCES tm_due_requests(id),
 title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', actor_id TEXT REFERENCES lookups(id), created_at TEXT NOT NULL, read_at TEXT,
 -- V5.5 (added to earlier databases by the upgrade in tasks.mjs): reminders about a meeting or a personal calendar note.
 meeting_id TEXT, note_id TEXT
);
CREATE INDEX IF NOT EXISTS tm_notification_staff ON tm_notifications(staff_id,read_at,id);
-- V5.3: profile photos, task checklists, task files and sent due-date reminders.
CREATE TABLE IF NOT EXISTS staff_photos (
 staff_id TEXT PRIMARY KEY REFERENCES lookups(id), mime TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, updated_by TEXT REFERENCES lookups(id), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tm_checklist (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id), position INTEGER NOT NULL, title TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0 CHECK(done IN(0,1)), done_by TEXT REFERENCES lookups(id), done_at TEXT,
 created_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_checklist_task ON tm_checklist(task_id,position);
CREATE TABLE IF NOT EXISTS tm_files (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
 uploaded_by TEXT NOT NULL REFERENCES lookups(id), source TEXT NOT NULL DEFAULT 'WEB', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_file_task ON tm_files(task_id);
CREATE TABLE IF NOT EXISTS tm_reminders (
 task_id TEXT NOT NULL REFERENCES tm_tasks(id), staff_id TEXT NOT NULL REFERENCES lookups(id), kind TEXT NOT NULL, due_date TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,staff_id,kind,due_date)
);
-- V5.4 two-party approval: a change to a task's details, its completion or its cancellation asked for by one side
-- (the person in charge, or the assigner's side) and decided by the other. `changes_json` lists each field with its
-- previous and new value; `payload_json` holds what is applied when it is approved.
CREATE TABLE IF NOT EXISTS tm_change_requests (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tm_tasks(id),
 kind TEXT NOT NULL CHECK(kind IN('UPDATE','COMPLETE','CANCEL')),
 requested_by TEXT NOT NULL REFERENCES lookups(id), requester_side TEXT NOT NULL CHECK(requester_side IN('PIC','ASSIGNER')),
 approver_id TEXT NOT NULL REFERENCES lookups(id),
 status TEXT NOT NULL CHECK(status IN('PENDING','APPROVED','REJECTED','WITHDRAWN','CLOSED')),
 changes_json TEXT NOT NULL DEFAULT '[]', payload_json TEXT NOT NULL DEFAULT '{}', note TEXT NOT NULL DEFAULT '',
 base_version INTEGER NOT NULL, decision_note TEXT NOT NULL DEFAULT '', decided_by TEXT REFERENCES lookups(id), decided_at TEXT,
 source TEXT NOT NULL DEFAULT 'WEB', decision_source TEXT, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_change_task ON tm_change_requests(task_id,status);
CREATE INDEX IF NOT EXISTS tm_change_approver ON tm_change_requests(approver_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS tm_change_one_pending ON tm_change_requests(task_id) WHERE status='PENDING';
INSERT OR IGNORE INTO schema_version(version) VALUES(4);
-- V5.4 Groups: customizable tables inside a workspace. Internally they are "boards", so they are never confused with
-- team membership. Cell values are stored by stable column ID in values_json, so adding a column never needs a
-- database change; formulas are stored with column IDs and calculated on the server when rows are read.
CREATE TABLE IF NOT EXISTS tm_boards (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES tm_workspaces(id),
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 visibility TEXT NOT NULL CHECK(visibility IN('PERSONAL','TEAM')),
 audience TEXT NOT NULL DEFAULT 'SELECTED' CHECK(audience IN('WORKSPACE','SELECTED')),
 workspace_level TEXT NOT NULL DEFAULT 'EDIT' CHECK(workspace_level IN('VIEW','EDIT')),
 owner_id TEXT NOT NULL REFERENCES lookups(id),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')),
 archived_at TEXT,
 archived_by TEXT REFERENCES lookups(id),
 version INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL REFERENCES lookups(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_board_workspace ON tm_boards(workspace_id,status);
CREATE TABLE IF NOT EXISTS tm_board_access (
 board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 staff_id TEXT NOT NULL REFERENCES lookups(id),
 level TEXT NOT NULL CHECK(level IN('VIEW','EDIT','MANAGE')),
 PRIMARY KEY(board_id,staff_id)
);
CREATE INDEX IF NOT EXISTS tm_board_access_staff ON tm_board_access(staff_id);
CREATE TABLE IF NOT EXISTS tm_board_columns (
 id TEXT PRIMARY KEY,
 board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN('TEXT','DATE','NUMBER','STATUS','IN_CHARGE','SUPPORT','FORMULA','ATTACHMENT')),
 position INTEGER NOT NULL,
 settings_json TEXT NOT NULL DEFAULT '{}',
 version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tm_board_column_name ON tm_board_columns(board_id,name_key);
CREATE INDEX IF NOT EXISTS tm_board_column_order ON tm_board_columns(board_id,position);
CREATE TABLE IF NOT EXISTS tm_board_rows (
 id TEXT PRIMARY KEY,
 board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 values_json TEXT NOT NULL DEFAULT '{}',
 version INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL REFERENCES lookups(id),
 created_at TEXT NOT NULL,
 updated_by TEXT REFERENCES lookups(id),
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_board_row_order ON tm_board_rows(board_id,position);
-- V5.5 Calendar: meetings shared with selected people, people who asked for a shared meeting's reminders, personal
-- calendar notes (visible to their owner only) and the reminders already sent (one per person, offset and start time,
-- so retries and restarts never send one twice and a rescheduled meeting is reminded again for its new time).
CREATE TABLE IF NOT EXISTS tm_meeting_shares (
 meeting_id TEXT NOT NULL REFERENCES tm_meetings(id), staff_id TEXT NOT NULL REFERENCES lookups(id), PRIMARY KEY(meeting_id,staff_id)
);
CREATE INDEX IF NOT EXISTS tm_meeting_share_staff ON tm_meeting_shares(staff_id);
CREATE TABLE IF NOT EXISTS tm_meeting_followers (
 meeting_id TEXT NOT NULL REFERENCES tm_meetings(id), staff_id TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL, PRIMARY KEY(meeting_id,staff_id)
);
CREATE TABLE IF NOT EXISTS tm_calendar_notes (
 id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES lookups(id), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
 all_day INTEGER NOT NULL DEFAULT 1 CHECK(all_day IN(0,1)), day TEXT NOT NULL, start_at TEXT, end_at TEXT,
 reminder_offsets TEXT NOT NULL DEFAULT '[]', done INTEGER NOT NULL DEFAULT 0 CHECK(done IN(0,1)),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_calendar_note_owner ON tm_calendar_notes(staff_id,day);
CREATE TABLE IF NOT EXISTS tm_event_reminders (
 kind TEXT NOT NULL CHECK(kind IN('MEETING','NOTE')), ref_id TEXT NOT NULL, staff_id TEXT NOT NULL REFERENCES lookups(id),
 offset_min INTEGER NOT NULL, start_at TEXT NOT NULL, notification_id INTEGER, created_at TEXT NOT NULL,
 PRIMARY KEY(kind,ref_id,staff_id,offset_min,start_at)
);
-- V5.5: what happened to each notification on each outside channel (Telegram): sent, skipped (with the reason, for
-- example the person is no longer on the task) or failed after retries. One row per notification and channel, so a
-- notification is never delivered twice.
CREATE TABLE IF NOT EXISTS tm_notification_deliveries (
 notification_id INTEGER NOT NULL REFERENCES tm_notifications(id), channel TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('PENDING','SENT','SKIPPED','FAILED')), reason TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(notification_id,channel)
);
CREATE INDEX IF NOT EXISTS tm_delivery_retry ON tm_notification_deliveries(channel,status,next_at);
-- V5.5 Groups: notes on rows (with their edit and deletion history), who may see a row or a column (people or roles;
-- no rule = everyone who can open the group), each person's own layout (column widths and order, columns and rows they
-- hid for themselves) and Excel imports (one per upload, so a retried import never adds the rows twice).
CREATE TABLE IF NOT EXISTS tm_board_notes (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 row_id TEXT NOT NULL REFERENCES tm_board_rows(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES lookups(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
 edited_at TEXT, deleted_at TEXT, deleted_by TEXT REFERENCES lookups(id), version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tm_board_note_row ON tm_board_notes(row_id,created_at);
CREATE INDEX IF NOT EXISTS tm_board_note_board ON tm_board_notes(board_id,created_at);
CREATE TABLE IF NOT EXISTS tm_board_note_revisions (
 id INTEGER PRIMARY KEY, note_id TEXT NOT NULL REFERENCES tm_board_notes(id) ON DELETE CASCADE,
 body TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('EDIT','DELETE')), actor_id TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tm_board_row_access (
 row_id TEXT NOT NULL REFERENCES tm_board_rows(id) ON DELETE CASCADE, board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN('USER','ROLE')), principal_id TEXT NOT NULL,
 PRIMARY KEY(row_id,principal_type,principal_id)
);
CREATE INDEX IF NOT EXISTS tm_board_row_access_board ON tm_board_row_access(board_id);
CREATE TABLE IF NOT EXISTS tm_board_column_access (
 column_id TEXT NOT NULL REFERENCES tm_board_columns(id) ON DELETE CASCADE, board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN('USER','ROLE')), principal_id TEXT NOT NULL,
 PRIMARY KEY(column_id,principal_type,principal_id)
);
CREATE INDEX IF NOT EXISTS tm_board_column_access_board ON tm_board_column_access(board_id);
CREATE TABLE IF NOT EXISTS tm_board_views (
 board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE, staff_id TEXT NOT NULL REFERENCES lookups(id),
 view_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY(board_id,staff_id)
);
CREATE TABLE IF NOT EXISTS tm_board_imports (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE, staff_id TEXT NOT NULL REFERENCES lookups(id),
 file_name TEXT NOT NULL, file_size INTEGER NOT NULL, sheets_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('UPLOADED','IMPORTED')), result_json TEXT, created_at TEXT NOT NULL, imported_at TEXT
);
CREATE INDEX IF NOT EXISTS tm_board_import_board ON tm_board_imports(board_id,created_at);
-- V5.5 Google Sheets connection: the OAuth client (its secret encrypted), each person's Google account (refresh token
-- encrypted), sign-ins in progress, one connection per group, the link and last synced values of each row, conflicts
-- (a cell changed on both sides) and a short record of each run.
CREATE TABLE IF NOT EXISTS tm_google_config (
 id INTEGER PRIMARY KEY CHECK(id=1), client_id TEXT NOT NULL DEFAULT '', client_secret_enc TEXT NOT NULL DEFAULT '', allow_existing INTEGER NOT NULL DEFAULT 0,
 interval_s INTEGER NOT NULL DEFAULT 60, push INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, updated_by TEXT REFERENCES lookups(id), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tm_google_accounts (
 staff_id TEXT PRIMARY KEY REFERENCES lookups(id), email TEXT NOT NULL DEFAULT '', refresh_enc TEXT NOT NULL, access_enc TEXT, access_expires TEXT,
 scopes TEXT NOT NULL DEFAULT '', connected_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','REVOKED')), status_detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tm_google_oauth_states (
 state TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES lookups(id), verifier_enc TEXT NOT NULL, browser_hash TEXT NOT NULL, existing INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tm_board_syncs (
 id TEXT PRIMARY KEY, board_id TEXT NOT NULL UNIQUE REFERENCES tm_boards(id) ON DELETE CASCADE, staff_id TEXT NOT NULL REFERENCES lookups(id),
 spreadsheet_id TEXT NOT NULL, spreadsheet_name TEXT NOT NULL DEFAULT '', sheet_id INTEGER NOT NULL, sheet_title TEXT NOT NULL DEFAULT '',
 direction TEXT NOT NULL CHECK(direction IN('TO_SHEETS','FROM_SHEETS','TWO_WAY')), mapping_json TEXT NOT NULL DEFAULT '[]',
 include_restricted INTEGER NOT NULL DEFAULT 0, delete_mode TEXT NOT NULL DEFAULT 'KEEP' CHECK(delete_mode IN('KEEP','PROPAGATE')),
 status TEXT NOT NULL CHECK(status IN('ACTIVE','PAUSED','ERROR')), status_detail TEXT NOT NULL DEFAULT '', interval_s INTEGER NOT NULL DEFAULT 60,
 next_run_at TEXT, last_run_at TEXT, last_success_at TEXT, last_duration_ms INTEGER, last_file_version TEXT, last_board_change TEXT, failures INTEGER NOT NULL DEFAULT 0,
 channel_id TEXT, channel_resource TEXT, channel_token_hash TEXT, channel_expires TEXT, last_message_number INTEGER,
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_board_sync_due ON tm_board_syncs(status,next_run_at);
CREATE TABLE IF NOT EXISTS tm_board_sync_rows (
 sync_id TEXT NOT NULL REFERENCES tm_board_syncs(id) ON DELETE CASCADE, row_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('LINKED','AWAITING_ID','ERP_DELETED','SHEET_DELETED')), base_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
 PRIMARY KEY(sync_id,row_id)
);
CREATE TABLE IF NOT EXISTS tm_board_sync_conflicts (
 id INTEGER PRIMARY KEY, sync_id TEXT NOT NULL REFERENCES tm_board_syncs(id) ON DELETE CASCADE, row_id TEXT NOT NULL, column_id TEXT NOT NULL,
 base_text TEXT, erp_text TEXT, sheet_text TEXT, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','RESOLVED')),
 resolution TEXT, applied INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_by TEXT REFERENCES lookups(id), resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS tm_board_sync_conflict_open ON tm_board_sync_conflicts(sync_id,status);
CREATE TABLE IF NOT EXISTS tm_board_sync_runs (
 id INTEGER PRIMARY KEY, sync_id TEXT NOT NULL REFERENCES tm_board_syncs(id) ON DELETE CASCADE, started_at TEXT NOT NULL, finished_at TEXT,
 trigger TEXT NOT NULL, outcome TEXT NOT NULL, to_sheet INTEGER NOT NULL DEFAULT 0, from_sheet INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0,
 conflicts INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', duration_ms INTEGER
);
-- V5.6.9: files in Attachment columns of Groups (one row per file; the cell keeps the list of its files' names).
CREATE TABLE IF NOT EXISTS tm_board_files (
 id TEXT PRIMARY KEY,
 board_id TEXT NOT NULL REFERENCES tm_boards(id) ON DELETE CASCADE,
 row_id TEXT NOT NULL REFERENCES tm_board_rows(id) ON DELETE CASCADE,
 column_id TEXT NOT NULL REFERENCES tm_board_columns(id) ON DELETE CASCADE,
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
 uploaded_by TEXT REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tm_board_file_cell ON tm_board_files(row_id,column_id);
CREATE INDEX IF NOT EXISTS tm_board_file_board ON tm_board_files(board_id);

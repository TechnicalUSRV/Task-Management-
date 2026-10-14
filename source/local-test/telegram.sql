-- V5.2 Telegram connection. Telegram is another way into Task Management: all task data stays in the
-- ERP tables; these tables only hold the bot settings, who is linked to which ERP account, linked groups
-- and short-lived conversation steps.
CREATE TABLE IF NOT EXISTS tg_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)), bot_token TEXT NOT NULL DEFAULT '',
 bot_id INTEGER, bot_username TEXT NOT NULL DEFAULT '', bot_name TEXT NOT NULL DEFAULT '', mini_app_url TEXT NOT NULL DEFAULT '',
 digest_hour INTEGER NOT NULL DEFAULT 8 CHECK(digest_hour BETWEEN -1 AND 23), group_updates INTEGER NOT NULL DEFAULT 1 CHECK(group_updates IN(0,1)),
 last_update_id INTEGER NOT NULL DEFAULT 0, last_notification_id INTEGER NOT NULL DEFAULT -1, last_history_id INTEGER NOT NULL DEFAULT -1,
 last_digest_date TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'OFF', status_detail TEXT NOT NULL DEFAULT '', checked_at TEXT,
 version INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tg_links (
 tg_user_id INTEGER PRIMARY KEY, staff_id TEXT NOT NULL UNIQUE REFERENCES lookups(id), chat_id INTEGER,
 username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN(0,1)),
 linked_at TEXT NOT NULL, last_seen_at TEXT
);
-- A personal connect link. V5.3: it no longer expires: it works once, until it is used or replaced by a new one.
-- `code` keeps the link visible to its owner in the ERP (added to earlier databases by telegram.mjs).
CREATE TABLE IF NOT EXISTS tg_link_codes (
 code_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES lookups(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, code TEXT
);
CREATE TABLE IF NOT EXISTS tg_groups (
 chat_id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'group', workspace_id TEXT REFERENCES tm_workspaces(id),
 notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN(0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 linked_by TEXT REFERENCES lookups(id), linked_at TEXT, seen_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tg_sessions (
 chat_id INTEGER NOT NULL, tg_user_id INTEGER NOT NULL, flow TEXT NOT NULL, step TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
 message_id INTEGER, prompt_id INTEGER, expires_at TEXT NOT NULL, PRIMARY KEY(chat_id,tg_user_id)
);
CREATE TABLE IF NOT EXISTS tg_log (id INTEGER PRIMARY KEY, level TEXT NOT NULL, chat_id INTEGER, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tg_link_staff ON tg_links(staff_id);
CREATE INDEX IF NOT EXISTS tg_group_workspace ON tg_groups(workspace_id,active);
CREATE INDEX IF NOT EXISTS tg_code_expiry ON tg_link_codes(expires_at);
INSERT OR IGNORE INTO tg_settings(id) VALUES(1);
INSERT OR IGNORE INTO schema_version(version) VALUES(8);

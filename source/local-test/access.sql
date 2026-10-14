CREATE TABLE IF NOT EXISTS access_roles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL DEFAULT '',
 protected INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_permissions (
 role_id TEXT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE, resource TEXT NOT NULL, action TEXT NOT NULL,
 PRIMARY KEY(role_id,resource,action)
);
CREATE TABLE IF NOT EXISTS access_users (
 id TEXT PRIMARY KEY, staff_id TEXT NOT NULL UNIQUE REFERENCES lookups(id), email TEXT NOT NULL COLLATE NOCASE DEFAULT '',
 role_id TEXT NOT NULL REFERENCES access_roles(id), password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES access_users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_attempts (
 key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_audit (
 id INTEGER PRIMARY KEY, actor_id TEXT REFERENCES lookups(id), action TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_user_permissions (
 user_id TEXT NOT NULL REFERENCES access_users(id) ON DELETE CASCADE,
 resource TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN('ALLOW','DENY')),
 PRIMARY KEY(user_id,resource,action)
);
CREATE TABLE IF NOT EXISTS erp_module_settings (
 module_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), version INTEGER NOT NULL DEFAULT 0
);
-- V5.1 additive indexes for session revocation and expiry cleanup.
CREATE INDEX IF NOT EXISTS access_session_user ON access_sessions(user_id);
CREATE INDEX IF NOT EXISTS access_session_expiry ON access_sessions(expires_at);
INSERT OR IGNORE INTO schema_version(version) VALUES(5);

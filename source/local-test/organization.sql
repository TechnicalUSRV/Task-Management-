CREATE TABLE IF NOT EXISTS org_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0, initialized_by TEXT REFERENCES lookups(id), initialized_at TEXT
);
INSERT OR IGNORE INTO org_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS org_levels (
 id INTEGER PRIMARY KEY CHECK(id>=1 AND id<=1000), name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO org_levels(id,name) VALUES(1,'Organization administrators'),(2,'Workspace managers'),(3,'Employees'),(4,'Delegated team'),(5,'Team members');
CREATE TABLE IF NOT EXISTS org_templates (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, capabilities_json TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS org_requests (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('MEMBERSHIP','DELEGATION','STRUCTURE')),
 workspace_id TEXT REFERENCES tm_workspaces(id), beneficiary_id TEXT REFERENCES lookups(id),
 requester_id TEXT NOT NULL REFERENCES lookups(id), approver_id TEXT REFERENCES lookups(id),
 payload_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
 CHECK(status IN('PENDING','APPROVED','REJECTED','CANCELLED','REVIEW')),
 decision_by TEXT REFERENCES lookups(id), decision_note TEXT NOT NULL DEFAULT '',
 request_key TEXT UNIQUE, fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, decided_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS org_request_approver ON org_requests(approver_id,status);
CREATE INDEX IF NOT EXISTS org_request_workspace ON org_requests(workspace_id,status);
CREATE INDEX IF NOT EXISTS org_request_fingerprint ON org_requests(fingerprint,status);
CREATE TABLE IF NOT EXISTS org_grants (
 id TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL REFERENCES lookups(id), template_id TEXT REFERENCES org_templates(id),
 title TEXT NOT NULL, capabilities_json TEXT NOT NULL, branch_root_id TEXT NOT NULL REFERENCES lookups(id),
 workspace_id TEXT REFERENCES tm_workspaces(id), governing_manager_id TEXT NOT NULL REFERENCES lookups(id),
 parent_grant_id TEXT REFERENCES org_grants(id), request_id TEXT REFERENCES org_requests(id),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','SUSPENDED','REVOKED')),
 granted_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS org_grant_beneficiary ON org_grants(beneficiary_id,status);
CREATE INDEX IF NOT EXISTS org_grant_parent ON org_grants(parent_grant_id);
CREATE TABLE IF NOT EXISTS org_audit (
 id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES lookups(id), action TEXT NOT NULL,
 employee_id TEXT REFERENCES lookups(id), workspace_id TEXT REFERENCES tm_workspaces(id),
 before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
 approval_id TEXT REFERENCES org_requests(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS org_audit_employee ON org_audit(employee_id,created_at);
CREATE INDEX IF NOT EXISTS org_audit_workspace ON org_audit(workspace_id,created_at);
CREATE TRIGGER IF NOT EXISTS org_audit_no_update BEFORE UPDATE ON org_audit BEGIN SELECT RAISE(ABORT,'Organization audit history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS org_audit_no_delete BEFORE DELETE ON org_audit BEGIN SELECT RAISE(ABORT,'Organization audit history is append-only'); END;

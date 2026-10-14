-- Additive V3 migration: the CRM and earlier sales handoffs remain intact.
CREATE TABLE IF NOT EXISTS ops_requests (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('QUOTATION','PO','JOB','DN','PR')),
 contact_id TEXT NOT NULL REFERENCES contacts(id), account_id TEXT REFERENCES accounts(id),
 source_id TEXT REFERENCES ops_requests(id), crm_quote_id TEXT REFERENCES quotations(id),
 status TEXT NOT NULL CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','RETURNED','REJECTED')),
 revision INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL,
 approval_chain TEXT NOT NULL DEFAULT '[]', approval_step INTEGER NOT NULL DEFAULT 0,
 created_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 approved_at TEXT, issued_date TEXT, job_deadline TEXT, creation_key TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_one_dn_per_job ON ops_requests(source_id) WHERE type='DN';
CREATE TABLE IF NOT EXISTS ops_revisions (
 request_id TEXT NOT NULL REFERENCES ops_requests(id), revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL,
 PRIMARY KEY(request_id,revision)
);
CREATE TABLE IF NOT EXISTS ops_approvals (
 id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES ops_requests(id), revision INTEGER NOT NULL,
 step INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES lookups(id),
 comment TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_notifications (
 id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES ops_requests(id), revision INTEGER NOT NULL,
 step INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES lookups(id), message TEXT NOT NULL,
 created_at TEXT NOT NULL, read_at TEXT, resolved_at TEXT,
 UNIQUE(request_id,revision,step,actor_id)
);
CREATE TABLE IF NOT EXISTS ops_jobs (
 id TEXT PRIMARY KEY REFERENCES ops_requests(id), po_id TEXT NOT NULL REFERENCES ops_requests(id),
 quotation_id TEXT NOT NULL REFERENCES ops_requests(id),
 shipment_status TEXT NOT NULL DEFAULT 'IN_TRANSIT' CHECK(shipment_status IN ('IN_TRANSIT','ARRIVED_PORT','DELIVERING','CLOSED')),
 version INTEGER NOT NULL DEFAULT 0, issued_date TEXT NOT NULL, deadline TEXT NOT NULL, late_reason TEXT NOT NULL DEFAULT '',
 closed_date TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_debit_notes (
 id TEXT PRIMARY KEY REFERENCES ops_requests(id), job_id TEXT NOT NULL UNIQUE REFERENCES ops_jobs(id),
 total_cents INTEGER NOT NULL CHECK(total_cents>=0), selling_cents INTEGER NOT NULL CHECK(selling_cents>=0),
 due_date TEXT NOT NULL, issued_date TEXT NOT NULL, af_verified_at TEXT, af_verified_by TEXT REFERENCES lookups(id)
);
CREATE TABLE IF NOT EXISTS ops_postings (
 id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES ops_requests(id), dn_id TEXT NOT NULL REFERENCES ops_debit_notes(id),
 line_number INTEGER NOT NULL, category TEXT NOT NULL CHECK(category IN ('SELLING','COSTING','TAX','CASH_DISBURSEMENT','VAT','DISCOUNT')),
 applies_to TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(request_id,line_number,category)
);
CREATE TABLE IF NOT EXISTS ops_ap (
 dn_id TEXT PRIMARY KEY REFERENCES ops_debit_notes(id),
 stage TEXT NOT NULL CHECK(stage IN ('NOT_RECEIVED','RECEIVED_UNCONFIRMED','CONFIRMED','PAID')),
 estimate_cents INTEGER NOT NULL, confirmed_cents INTEGER NOT NULL DEFAULT 0,
 confirmed_by TEXT REFERENCES lookups(id), confirmed_at TEXT, supplier_reference TEXT NOT NULL DEFAULT '',
 paid_cents INTEGER NOT NULL DEFAULT 0, paid_by TEXT REFERENCES lookups(id), paid_at TEXT, payment_reference TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ops_files (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES ops_requests(id),
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
 uploaded_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_settlements (
 id TEXT PRIMARY KEY, dn_id TEXT NOT NULL REFERENCES ops_debit_notes(id),
 type TEXT NOT NULL CHECK(type IN ('RECEIPT','AF_VERIFICATION')), amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 reference TEXT NOT NULL, settlement_date TEXT NOT NULL, file_id TEXT REFERENCES ops_files(id),
 actor_id TEXT NOT NULL REFERENCES lookups(id), request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_once_af ON ops_settlements(dn_id) WHERE type='AF_VERIFICATION';
CREATE TABLE IF NOT EXISTS ops_closings (
 dn_id TEXT PRIMARY KEY REFERENCES ops_debit_notes(id), closing_date TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, verified_by TEXT NOT NULL REFERENCES lookups(id), verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), holidays_json TEXT NOT NULL DEFAULT '[]',
 finance_ids_json TEXT NOT NULL DEFAULT '[]', coa_rules_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ops_settings(id,coa_rules_json) VALUES(1,'[{"contains":"duty","category":"TAX"},{"contains":"customs tax","category":"TAX"},{"contains":"disbursement","category":"CASH_DISBURSEMENT"}]');
CREATE INDEX IF NOT EXISTS ops_requests_contact ON ops_requests(contact_id,type,status);
CREATE INDEX IF NOT EXISTS ops_requests_source ON ops_requests(source_id);
CREATE INDEX IF NOT EXISTS ops_postings_dn ON ops_postings(dn_id);
CREATE INDEX IF NOT EXISTS ops_settlements_dn ON ops_settlements(dn_id);
-- V5.1 additive indexes for approval alerts and supporting files.
CREATE INDEX IF NOT EXISTS ops_notifications_actor ON ops_notifications(actor_id,resolved_at);
CREATE INDEX IF NOT EXISTS ops_files_request ON ops_files(request_id);
INSERT OR IGNORE INTO schema_version(version) VALUES(3);

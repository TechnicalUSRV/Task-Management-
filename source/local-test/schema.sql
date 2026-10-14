PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS company (
 id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', tax_id TEXT NOT NULL DEFAULT '',
 currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','KHR'))
);
CREATE TABLE IF NOT EXISTS lookups (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('staff','branch','material','opportunity_class','contact_class','lead_class','campaign_class','partner')),
 name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 UNIQUE(kind,name)
);
CREATE TABLE IF NOT EXISTS sequences (kind TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
 id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL,
 email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', mobile TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
 class_id TEXT REFERENCES lookups(id), owner_id TEXT NOT NULL REFERENCES lookups(id), source TEXT NOT NULL DEFAULT '',
 partner_id TEXT REFERENCES lookups(id), notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, class_id TEXT REFERENCES lookups(id), audience TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 budget_cents INTEGER NOT NULL CHECK(budget_cents>=0), status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','COMPLETED','CANCELLED')),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), campaign_id TEXT REFERENCES campaigns(id),
 class_id TEXT REFERENCES lookups(id), owner_id TEXT NOT NULL REFERENCES lookups(id), source TEXT NOT NULL DEFAULT '',
 rating TEXT NOT NULL CHECK(rating IN ('HOT','WARM','COLD')), status TEXT NOT NULL CHECK(status IN ('NEW','QUALIFIED','CONVERTED','DISQUALIFIED')),
 notes TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', converted_at TEXT,
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_campaign_contact ON leads(campaign_id,contact_id) WHERE campaign_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS opportunities (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), lead_id TEXT REFERENCES leads(id), title TEXT NOT NULL,
 branch_id TEXT NOT NULL REFERENCES lookups(id), class_id TEXT NOT NULL REFERENCES lookups(id), owner_id TEXT NOT NULL REFERENCES lookups(id),
 partner_id TEXT REFERENCES lookups(id), customer_reference TEXT NOT NULL DEFAULT '', estimation TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','WON','LOST')), probability INTEGER NOT NULL CHECK(probability BETWEEN 0 AND 100),
 notes TEXT NOT NULL DEFAULT '', lost_reason TEXT NOT NULL DEFAULT '', costing_cents INTEGER NOT NULL DEFAULT 0 CHECK(costing_cents>=0),
 payment_received_cents INTEGER NOT NULL DEFAULT 0 CHECK(payment_received_cents>=0), commission_cents INTEGER NOT NULL DEFAULT 0 CHECK(commission_cents>=0),
 total_cents INTEGER NOT NULL DEFAULT 0 CHECK(total_cents>=0), contact_snapshot TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0, creation_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_opportunity_lead ON opportunities(lead_id);
CREATE TABLE IF NOT EXISTS opportunity_lines (
 id INTEGER PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunities(id), line_number INTEGER NOT NULL,
 material_id TEXT REFERENCES lookups(id), description TEXT NOT NULL, unit TEXT NOT NULL,
 quantity TEXT NOT NULL, unit_price TEXT NOT NULL, discount TEXT NOT NULL, percentage_discount TEXT NOT NULL, tax_percent TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL, vat_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
 UNIQUE(opportunity_id,line_number)
);
CREATE TABLE IF NOT EXISTS won_sales (
 opportunity_id TEXT PRIMARY KEY REFERENCES opportunities(id), snapshot_json TEXT NOT NULL,
 account_id TEXT REFERENCES accounts(id), closed_by TEXT NOT NULL REFERENCES lookups(id), closed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotations (
 id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL UNIQUE REFERENCES opportunities(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
 status TEXT NOT NULL CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','ACCEPTED','CONVERTED','REJECTED','EXPIRED')),
 revision INTEGER NOT NULL DEFAULT 0, approval_step INTEGER NOT NULL DEFAULT 0, approval_chain TEXT NOT NULL DEFAULT '[]',
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_revisions (
 id INTEGER PRIMARY KEY, quotation_id TEXT NOT NULL REFERENCES quotations(id), revision INTEGER NOT NULL,
 quotation_date TEXT NOT NULL, valid_until TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', lines_json TEXT NOT NULL,
 net_cents INTEGER NOT NULL, vat_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL, UNIQUE(quotation_id,revision)
);
CREATE TABLE IF NOT EXISTS approval_steps (step INTEGER PRIMARY KEY, approver_id TEXT NOT NULL REFERENCES lookups(id));
CREATE TABLE IF NOT EXISTS approvals (
 id INTEGER PRIMARY KEY, quotation_id TEXT NOT NULL REFERENCES quotations(id), revision INTEGER NOT NULL, step INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('APPROVED','REJECTED','RETURNED')), actor_id TEXT NOT NULL REFERENCES lookups(id), comment TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), name TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES lookups(id), partner_id TEXT REFERENCES lookups(id), notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE','SUSPENDED')),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accepted_sales (
 quotation_id TEXT PRIMARY KEY REFERENCES quotations(id), account_id TEXT NOT NULL REFERENCES accounts(id),
 revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
 id TEXT PRIMARY KEY, contact_id TEXT REFERENCES contacts(id), parent_type TEXT NOT NULL CHECK(parent_type IN ('CONTACT','LEAD','OPPORTUNITY','ACCOUNT','TASK')),
 parent_id TEXT, type TEXT NOT NULL CHECK(type IN ('FOLLOWUP','OPPORTUNITY','AFTER SALE','CHAT')),
 subject TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL, end_at TEXT,
 branch_id TEXT NOT NULL REFERENCES lookups(id), assigned_to TEXT NOT NULL REFERENCES lookups(id),
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','COMPLETED','CANCELLED')),
 priority TEXT NOT NULL CHECK(priority IN ('HIGH','MEDIUM','LOW')), channel TEXT NOT NULL CHECK(channel IN ('CALL','MEETING','EMAIL','NOTE','TASK')),
 reason TEXT NOT NULL DEFAULT '', forecast_cents INTEGER NOT NULL DEFAULT 0 CHECK(forecast_cents>=0),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), parent_type TEXT NOT NULL, parent_id TEXT NOT NULL,
 title TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, contact_id TEXT REFERENCES contacts(id), entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
 action TEXT NOT NULL, detail TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES lookups(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, quotation_id TEXT NOT NULL UNIQUE REFERENCES quotations(id), account_id TEXT NOT NULL REFERENCES accounts(id),
 contact_id TEXT NOT NULL REFERENCES contacts(id), total_cents INTEGER NOT NULL CHECK(total_cents>=0), snapshot_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ORDERED','SHIPPED','INVOICED','PAID')), version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), reference TEXT NOT NULL, shipment_date TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), invoice_date TEXT NOT NULL, due_date TEXT NOT NULL,
 total_cents INTEGER NOT NULL CHECK(total_cents>=0), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 payment_date TEXT NOT NULL, reference TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_due ON activities(status,start_at);
CREATE INDEX IF NOT EXISTS idx_activity_contact ON activities(contact_id,start_at);
CREATE INDEX IF NOT EXISTS idx_opportunity_estimation ON opportunities(estimation,status,owner_id);
CREATE INDEX IF NOT EXISTS idx_events_contact ON events(contact_id,created_at);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_accounts_contact ON accounts(contact_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
PRAGMA optimize;

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaled, lineAmounts } from './money.mjs';
import { APP_VERSION, APP_BUILD } from './version.mjs';
import { createOperations } from './operations.mjs';
import { createTasks } from './tasks.mjs';
import { createAccess } from './access.mjs';
import { createOrganization } from './organization.mjs';
import { createTelegram } from './telegram.mjs';
import { createGroupSync } from './group-sync.mjs';
import { secretBox } from './secret-box.mjs';
export { scaled } from './money.mjs';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new InputError(message, status); };
const now = () => new Date().toISOString();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const dayOffset = (days) => new Date(Date.parse(`${today()}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const str = (value, label, max = 500, required = false) => {
  if (value == null && !required) return '';
  // V5.6.8: say exactly what is wrong (missing, not text, or too long).
  if (typeof value !== 'string' || (required && !value.trim())) fail(typeof value === 'string' || value == null ? `${label} is required.` : `${label} must be text.`);
  if (value.trim().length > max) fail(`${label} must be at most ${max} characters.`);
  return value.trim();
};
const choice = (value, list, label) => list.includes(value) ? value : fail(`Choose a valid ${label}.`);
const date = (value, label) => {
  const s = str(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) !== s) fail(`Enter a valid ${label}.`);
  return s;
};
const instant = (value, label) => {
  const s = str(value, label, 40, true);
  if (!/T.*(Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))) fail(`Enter a valid ${label} with a timezone.`);
  date(s.slice(0, 10), label);
  return new Date(s).toISOString();
};
const integer = (v, min, max, label) => Number.isSafeInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fail(`Invalid ${label}.`);
export function calculateLines(input) {
  if (!Array.isArray(input) || input.length > 100) fail('Use up to 100 line items.');
  return input.map((l, i) => {
    const amounts = lineAmounts(l);
    return { line_number: i + 1, material_id: l.material_id || null, description: str(l.description, 'Description', 500, true),
      unit: str(l.unit, 'Unit', 30) || 'service', quantity: String(l.quantity), unit_price: String(l.unit_price),
      discount: String(l.discount || '0'), percentage_discount: String(l.percentage_discount || '0'), tax_percent: String(l.tax_percent || '0'),
      ...amounts };
  });
}
const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);

export function openStore(filename = ':memory:') {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8'));
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tables = { contact: 'contacts', campaign: 'campaigns', lead: 'leads', opportunity: 'opportunities', quotation: 'quotations', account: 'accounts', activity: 'activities', order: 'orders' };
  const record = (type, id) => {
    if (!tables[type]) fail('Unknown record type.');
    return get(`SELECT * FROM ${tables[type]} WHERE id=?`, str(id, 'Record ID', 50, true)) || fail('This record was not found.', 404);
  };
  const lookup = (id, kind, optional = false) => {
    if (!id && optional) return null;
    const what = kind === 'staff' ? 'Choose an active person.' : `Select an active ${kind.replaceAll('_', ' ')}.`;
    if (typeof id !== 'string') fail(what);
    const r = get('SELECT * FROM lookups WHERE id=? AND kind=? AND active=1', id || '', kind);
    if (!r) fail(what);
    return r.id;
  };
  const id = (kind, prefix) => {
    const n = get('INSERT INTO sequences(kind,value) VALUES(?,1) ON CONFLICT(kind) DO UPDATE SET value=value+1 RETURNING value', kind).value;
    const key = `${prefix}-${String(n).padStart(6, '0')}`;
    if (kind === 'contact' && get('SELECT id FROM contacts WHERE id=?', key)) return id(kind, prefix);
    return key;
  };
  const insert = (table, values) => {
    const keys = Object.keys(values);
    run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => values[k]));
  };
  const update = (table, key, values) => {
    const keys = Object.keys(values);
    run(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, ...keys.map(k => values[k]), key);
  };
  const version = (r, expected) => {
    if (expected !== r.version) fail('This record changed. Refresh it before saving again.', 409);
  };
  const event = (actor, contact, type, key, action, detail = '') => insert('events', { contact_id: contact || null, entity_type: type, entity_id: key, action, detail, actor_id: actor, created_at: now() });
  const validateLines = input => {
    const lines = calculateLines(input);
    lines.forEach(l => lookup(l.material_id, 'material', true));
    if (sum(lines, 'total_cents') > 1000000000000) fail('Document total is too large.');
    return lines;
  };
  const linesFor = key => all('SELECT * FROM opportunity_lines WHERE opportunity_id=? ORDER BY line_number', key);
  const latestQuote = q => get('SELECT * FROM quote_revisions WHERE quotation_id=? AND revision=?', q.id, q.revision);
  const parent = (type, key) => {
    if (type === 'TASK') return { contact_id: null };
    const map = { CONTACT: 'contact', LEAD: 'lead', OPPORTUNITY: 'opportunity', ACCOUNT: 'account', QUOTATION: 'quotation' };
    const r = record(map[type] || fail('Invalid parent type.'), key);
    return { ...r, contact_id: type === 'CONTACT' ? r.id : r.contact_id };
  };
  const quoteRevision = (q, input, actor) => {
    const lines = validateLines(input.lines);
    if (!lines.length) fail('A formal quotation needs at least one line.');
    const start = date(input.quotation_date, 'quotation date'), until = date(input.valid_until, 'valid-until date');
    if (until < start) fail('Valid-until date cannot be earlier than the quotation date.');
    insert('quote_revisions', { quotation_id: q.id, revision: q.revision + 1, quotation_date: start, valid_until: until,
      notes: str(input.notes, 'Notes', 5000), lines_json: JSON.stringify(lines), net_cents: sum(lines, 'net_cents'),
      vat_cents: sum(lines, 'vat_cents'), total_cents: sum(lines, 'total_cents'), created_by: actor, created_at: now() });
    update('quotations', q.id, { revision: q.revision + 1, version: q.version + 1, status: 'DRAFT', approval_step: 0, approval_chain: '[]', updated_at: now() });
    event(actor, q.contact_id, 'quotation', q.id, `Saved quotation revision ${q.revision + 1}`);
  };

  // Upgrade an earlier local prototype without changing its historical snapshots.
  if (!get('SELECT version FROM schema_version WHERE version=2')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!all('PRAGMA table_info(won_sales)').some(c => c.name === 'account_id')) run('ALTER TABLE won_sales ADD COLUMN account_id TEXT REFERENCES accounts(id)');
      if (!all('PRAGMA table_info(opportunities)').some(c => c.name === 'creation_key')) {
        run('ALTER TABLE opportunities ADD COLUMN creation_key TEXT');
        run('CREATE UNIQUE INDEX uq_opportunity_creation_key ON opportunities(creation_key) WHERE creation_key IS NOT NULL');
      }
      run('DROP INDEX IF EXISTS uq_opportunity_lead');
      for (const sale of all('SELECT w.opportunity_id,o.contact_id,o.owner_id,o.partner_id FROM won_sales w JOIN opportunities o ON o.id=w.opportunity_id WHERE w.account_id IS NULL')) {
        let account = get('SELECT * FROM accounts WHERE contact_id=? ORDER BY created_at LIMIT 1', sale.contact_id);
        if (!account) {
          const contact = record('contact', sale.contact_id), key = id('account', 'BA');
          insert('accounts', { id: key, contact_id: contact.id, name: contact.customer_name, owner_id: sale.owner_id, partner_id: sale.partner_id, created_at: now(), updated_at: now() });
          account = record('account', key);
          event(sale.owner_id, contact.id, 'account', key, 'Business Account linked during CRM V2 upgrade', `Existing won opportunity ${sale.opportunity_id}; original snapshot retained.`);
        }
        run('UPDATE won_sales SET account_id=? WHERE opportunity_id=?', account.id, sale.opportunity_id);
      }
      run('INSERT INTO schema_version(version) VALUES(2)');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // Task Management asks Administration whether another staff member may approve tasks (for example the
  // manager chosen for a task request). Administration loads after Tasks, so the hook is filled in below.
  const hooks = { canStaff: () => false };
  // Moves on every saved change, whether it came from the Task Controlling Management, the Telegram bot or the Mini App. Open screens
  // check it cheaply every few seconds and reload their data only when it has moved. It starts from the clock
  // so that screens opened before a restart always reload once afterwards.
  let changeSeq = Date.now();
  const changed = () => { changeSeq++; };
  const operations = createOperations({db,get,all,run,insert,update,id,lookup,record,version,event,fail,str,choice,date,integer,now,today,validateLines,scaled});
  const tasks = createTasks({db,get,all,run,insert,update,id,lookup,record,version,event,fail,str,choice,date,instant,integer,now,today,hooks});
  const organization = createOrganization({db,get,all,run,insert,update,id,lookup,version,fail,str,integer,now,hooks});
  hooks.organization = organization; hooks.taskScope = tasks.scope;
  const access = createAccess({db,get,all,run,insert,update,id,lookup,version,event,fail,str,choice,now,hooks,taskScope:tasks.scope,taskZone:tasks.zoneOf,sidebarTheme:tasks.sidebarThemeOf,groupLevel:tasks.groups.levelFor,groupSummaries:staff=>tasks.groups.summaries(staff)});
  hooks.canStaff = (staff, resource, action) => access.canStaff(staff, resource, action);
  const telegram = createTelegram({db,get,all,run,insert,update,lookup,version,fail,str,integer,now,changed,organization});
  // V5.5: Groups ↔ Google Sheets. Secrets are encrypted with the key of this data folder (secret.key) or SUNNY_SECRET_KEY.
  const dataDir = filename === ':memory:' ? null : (path.basename(path.dirname(filename)) === 'companies' ? path.dirname(path.dirname(filename)) : path.dirname(filename));
  const nameOf = staff => get('SELECT name FROM lookups WHERE id=?', staff)?.name || staff || '';
  const sync = createGroupSync({db,get,all,run,insert,update,id,fail,str,now,groups:tasks.groups,canStaff:hooks.canStaff,nameOf,box:secretBox(dataDir),changed});
  hooks.groupRowsDeleted = (b, ids) => sync.rowsDeleted(b, ids);

  // meta.source records where a change came from: WEB (default), TELEGRAM (bot) or MINIAPP (Telegram Mini App).
  function command(action, data = {}, actor = 'STAFF-001', meta = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('A record object is required.');
    db.exec('BEGIN IMMEDIATE');
    try {
      lookup(actor, 'staff');
      organization.guard(action, data, actor);
      const result = apply(action, data, actor, meta);
      organization.afterCommand(action, data, actor);
      db.exec('COMMIT');
      changed();
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      organization.invalidate();
      if (error instanceof InputError) throw error;
      if (/UNIQUE constraint/.test(error.message)) fail('This ID or linked record already exists.', 409);
      if (/FOREIGN KEY constraint/.test(error.message)) fail('A related record is missing or still in use.', 409);
      throw error;
    }
  }
  function apply(action, d, actor, meta = {}) {
    if (typeof action === 'string' && action.startsWith('org.')) return organization.handle(action,d,actor);
    if (typeof action === 'string' && (action.startsWith('admin.telegram.') || action.startsWith('tg.'))) return telegram.handle(action,d,actor);
    if (action === 'admin.integrations.save') return sync.saveConfig(d,actor);
    if (typeof action === 'string' && action.startsWith('admin.')) return access.handle(action,d,actor);
    // V5.6.8: sign out of every device (all Task Controlling Management sessions; with telegram: true, the Telegram connection too).
    if (action === 'me.sessions.end') { const u = access.accountFor(actor); if (!u) fail('Sign in to continue.', 401); const n = access.signOutEverywhere(u, { telegram: d.telegram === true }); return { message: `Signed out of ${n} session${n === 1 ? '' : 's'}${d.telegram === true ? ' and Telegram' : ''}. Sign in again to continue.` }; }
    if (typeof action === 'string' && (action.startsWith('tm.') || action.startsWith('me.'))) return tasks.handle(action,d,actor,meta);
    if (typeof action === 'string' && action.startsWith('ops.')) return operations.handle(action,d,actor);
    if (action === 'contact.save') {
      const r = d.id ? record('contact', d.id) : null;
      if (r) version(r, d.expected_version);
      const key = r?.id || (d.code ? str(d.code, 'Contact ID', 30, true).toUpperCase() : id('contact', 'CONT'));
      if (!/^[A-Z0-9_-]{1,30}$/.test(key)) fail('Contact ID may contain letters, numbers, hyphens and underscores.');
      if (!r && get('SELECT id FROM contacts WHERE id=?', key)) fail(`Contact ID ${key} already exists. Choose another ID or leave it blank for an automatic ID.`, 409);
      const email = str(d.email, 'Email', 200);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
      const values = { first_name: str(d.first_name, 'First name', 100, true), last_name: str(d.last_name, 'Last name', 100), customer_name: str(d.customer_name, 'Customer / company name', 300, true),
        email, phone: str(d.phone, 'Phone', 50), mobile: str(d.mobile, 'Mobile', 50), address: str(d.address, 'Address'),
        class_id: lookup(d.class_id, 'contact_class', true), owner_id: lookup(d.owner_id, 'staff'), source: str(d.source, 'Source', 100),
        partner_id: lookup(d.partner_id, 'partner', true), notes: str(d.notes, 'Notes', 5000), active: d.active === false || d.active === 0 ? 0 : 1,
        updated_at: now(), version: r ? r.version + 1 : 0 };
      if (r) update('contacts', key, values); else insert('contacts', { id: key, ...values, created_at: now() });
      event(actor, key, 'contact', key, r ? 'Contact updated' : 'Contact created');
      return { id: key, type: 'contact' };
    }
    if (action === 'campaign.save') {
      const r = d.id ? record('campaign', d.id) : null;
      if (r) version(r, d.expected_version);
      const start = date(d.start_date, 'start date'), end = date(d.end_date, 'end date');
      if (end < start) fail('Campaign end must be on or after its start.');
      const key = r?.id || id('campaign', 'CAM');
      const values = { name: str(d.name, 'Campaign name', 200, true), class_id: lookup(d.class_id, 'campaign_class', true),
        audience: str(d.audience, 'Target audience'), description: str(d.description, 'Description', 5000), start_date: start, end_date: end,
        budget_cents: scaled(d.budget, 2, 'Budget'), status: choice(d.status, ['DRAFT','ACTIVE','COMPLETED','CANCELLED'], 'campaign status'),
        version: r ? r.version + 1 : 0, updated_at: now() };
      if (r) update('campaigns', key, values); else insert('campaigns', { id: key, ...values, created_at: now() });
      event(actor, null, 'campaign', key, r ? 'Campaign updated' : 'Campaign created');
      return { id: key, type: 'campaign' };
    }
    if (action === 'lead.save') {
      const r = d.id ? record('lead', d.id) : null;
      if (r) { version(r, d.expected_version); if (r.status === 'CONVERTED') fail('Converted leads are preserved and read-only.', 409); }
      const contact = record('contact', r?.contact_id || d.contact_id);
      if (!contact.active) fail('Reactivate the contact before creating a lead.');
      const campaign = (r?.campaign_id || d.campaign_id) ? record('campaign', r?.campaign_id || d.campaign_id) : null;
      if (!r && campaign?.status === 'CANCELLED') fail('A cancelled campaign cannot generate leads.');
      const key = r?.id || id('lead', 'LEAD');
      const status = choice(d.status || 'NEW', ['NEW','QUALIFIED','DISQUALIFIED'], 'lead status');
      const reason = str(d.reason, 'Reason', 500, status === 'DISQUALIFIED');
      const values = { contact_id: contact.id, campaign_id: campaign?.id || null, class_id: lookup(d.class_id, 'lead_class', true),
        owner_id: lookup(d.owner_id, 'staff'), source: str(d.source, 'Source', 100), rating: choice(d.rating || 'WARM', ['HOT','WARM','COLD'], 'rating'),
        status, notes: str(d.notes, 'Notes', 5000), reason, version: r ? r.version + 1 : 0, updated_at: now() };
      if (r) update('leads', key, values); else insert('leads', { id: key, ...values, created_at: now() });
      event(actor, contact.id, 'lead', key, r ? `Lead updated · ${status}` : 'Lead created', campaign?.name || '');
      return { id: key, type: 'lead' };
    }
    if (action === 'campaign.generate') {
      const campaign = record('campaign', d.id);
      if (!['DRAFT','ACTIVE'].includes(campaign.status)) fail('Reopen the campaign before generating leads.');
      if (!Array.isArray(d.contact_ids) || !d.contact_ids.length || d.contact_ids.length > 100) fail('Select 1–100 contacts.');
      let created = 0, skipped = 0;
      for (const key of new Set(d.contact_ids)) {
        if (get('SELECT id FROM leads WHERE campaign_id=? AND contact_id=?', campaign.id, key)) { skipped++; continue; }
        const contact = record('contact', key);
        apply('lead.save', { contact_id: key, campaign_id: campaign.id, owner_id: contact.owner_id, source: campaign.name, rating: 'WARM' }, actor);
        created++;
      }
      return { id: campaign.id, type: 'campaign', message: `${created} leads created; ${skipped} existing responses skipped.` };
    }
    if (action === 'opportunity.save') {
      const r = d.id ? record('opportunity', d.id) : null;
      if (r) { version(r, d.expected_version); if (r.status !== 'OPEN') fail('Closed opportunities are read-only.', 409); }
      const lead = (r?.lead_id || d.lead_id) ? record('lead', r?.lead_id || d.lead_id) : null;
      if (!r && lead && !['QUALIFIED','CONVERTED'].includes(lead.status)) fail('Qualify this lead before converting it.', 409);
      const contact = record('contact', r?.contact_id || lead?.contact_id || d.contact_id);
      const creationKey = !r ? (str(d.request_key, 'Request key', 100) || crypto.randomUUID()) : null;
      if (!r) {
        const previous = get('SELECT * FROM opportunities WHERE creation_key=?', creationKey);
        if (previous) {
          if (previous.contact_id !== contact.id || previous.lead_id !== (lead?.id || null)) fail('This request key belongs to a different conversion.', 409);
          return { id: previous.id, type: 'opportunity', message: 'Opportunity already created.' };
        }
      }
      if (!contact.active) fail('Reactivate the contact first.');
      const lines = validateLines(d.lines || []), key = r?.id || id('opportunity', 'OPP');
      const values = { contact_id: contact.id, lead_id: lead?.id || null, title: str(d.title, 'Opportunity title', 200, true),
        branch_id: lookup(d.branch_id, 'branch'), class_id: lookup(d.class_id, 'opportunity_class'), owner_id: lookup(d.owner_id, 'staff'),
        partner_id: lookup(d.partner_id, 'partner', true), customer_reference: str(d.customer_reference, 'Customer reference', 200),
        estimation: date(d.estimation, 'expected close date'), probability: integer(d.probability ?? 50, 0, 100, 'probability'),
        notes: str(d.notes, 'Notes', 5000), costing_cents: scaled(d.costing, 2, 'Costing'),
        payment_received_cents: scaled(d.payment_received, 2, 'Payment received'), commission_cents: scaled(d.commission, 2, 'Commission'),
        total_cents: sum(lines, 'total_cents'), version: r ? r.version + 1 : 0, updated_at: now() };
      if (r) update('opportunities', key, values);
      else insert('opportunities', { id: key, ...values, creation_key: creationKey, contact_snapshot: JSON.stringify(contact), created_at: now() });
      run('DELETE FROM opportunity_lines WHERE opportunity_id=?', key);
      lines.forEach(l => insert('opportunity_lines', { ...l, opportunity_id: key }));
      if (!r && lead && lead.status !== 'CONVERTED') {
        update('leads', lead.id, { status: 'CONVERTED', converted_at: now(), version: lead.version + 1, updated_at: now() });
        event(actor, contact.id, 'lead', lead.id, 'Lead converted to opportunity', key);
      }
      event(actor, contact.id, 'opportunity', key, r ? 'Opportunity and pricing updated' : 'Opportunity created');
      return { id: key, type: 'opportunity' };
    }
    if (action === 'opportunity.close') {
      const r = record('opportunity', d.id), status = choice(d.status, ['WON','LOST'], 'sale result');
      if (r.status === status) return { id: r.id, type: 'opportunity', message: 'This opportunity is already closed.' };
      version(r, d.expected_version);
      if (r.status !== 'OPEN') fail('The closed sale cannot be changed.', 409);
      const reason = str(d.reason, 'Lost reason', 500, status === 'LOST');
      const lines = linesFor(r.id);
      if (status === 'WON' && !lines.length) fail('Add opportunity pricing before marking the sale won.');
      const time = now();
      update('opportunities', r.id, { status, probability: status === 'WON' ? 100 : 0, lost_reason: reason, closed_at: time, updated_at: time, version: r.version + 1 });
      if (status === 'WON') {
        const contact = record('contact', r.contact_id);
        let account = get('SELECT * FROM accounts WHERE contact_id=? ORDER BY created_at LIMIT 1', r.contact_id);
        if (account && account.status !== 'ACTIVE') fail('Reactivate the Business Account before confirming another sale.', 409);
        if (!account) {
          const key = id('account', 'BA');
          insert('accounts', { id: key, contact_id: r.contact_id, name: contact.customer_name, owner_id: r.owner_id, partner_id: r.partner_id, created_at: time, updated_at: time });
          account = record('account', key);
          event(actor, r.contact_id, 'account', key, 'Business Account created automatically from won sale', r.id);
        }
        insert('won_sales', { opportunity_id: r.id, account_id: account.id, closed_by: actor, closed_at: time,
          snapshot_json: JSON.stringify({ contact, account, opportunity: { ...r, status, closed_at: time }, lines, activities: all('SELECT * FROM activities WHERE contact_id=? ORDER BY created_at', r.contact_id), documents: all('SELECT * FROM documents WHERE contact_id=?', r.contact_id) }) });
      }
      event(actor, r.contact_id, 'opportunity', r.id, status === 'WON' ? 'Opportunity won · pricing snapshot saved' : 'Opportunity lost', reason);
      return { id: r.id, type: 'opportunity' };
    }
    if (action === 'quotation.create') {
      const opp = record('opportunity', d.opportunity_id);
      if (opp.status !== 'WON') fail('Only a won opportunity can produce a formal quotation.', 409);
      const existing = get('SELECT * FROM quotations WHERE opportunity_id=?', opp.id);
      if (existing) return { id: existing.id, type: 'quotation' };
      const key = id('quotation', 'QUO');
      insert('quotations', { id: key, opportunity_id: opp.id, contact_id: opp.contact_id, status: 'DRAFT', created_at: now(), updated_at: now() });
      quoteRevision(record('quotation', key), { lines: linesFor(opp.id), quotation_date: today(), valid_until: dayOffset(30), notes: opp.notes }, actor);
      event(actor, opp.contact_id, 'quotation', key, 'Formal quotation created from won opportunity', opp.id);
      return { id: key, type: 'quotation' };
    }
    if (action === 'quotation.save') {
      const q = record('quotation', d.id); version(q, d.expected_version);
      if (!['DRAFT','REJECTED','EXPIRED'].includes(q.status)) fail('Only draft, rejected or expired quotations may be revised.', 409);
      quoteRevision(q, d, actor);
      return { id: q.id, type: 'quotation' };
    }
    if (action === 'quotation.process') {
      const q = record('quotation', d.id), verb = choice(d.process, ['submit','approve','reject','return','accept','expire'], 'quotation action');
      if (verb === 'accept' && ['ACCEPTED','CONVERTED'].includes(q.status)) return { id: q.id, type: 'quotation' };
      version(q, d.expected_version);
      const rev = latestQuote(q), comment = str(d.comment, 'Comment', 2000, ['reject','return'].includes(verb));
      let changes = { version: q.version + 1, updated_at: now() };
      if (verb === 'submit') {
        if (q.status !== 'DRAFT') fail('Save a draft revision before submitting.', 409);
        if (rev.valid_until < today()) fail('The quotation has expired. Save a new validity date.');
        const steps = all('SELECT * FROM approval_steps ORDER BY step');
        if (!steps.length) fail('Configure at least one approval step first.');
        steps.forEach(s => lookup(s.approver_id, 'staff'));
        changes = { ...changes, status: 'SUBMITTED', approval_step: 0, approval_chain: JSON.stringify(steps) };
      } else if (['approve','reject','return'].includes(verb)) {
        if (q.status !== 'SUBMITTED') fail('This quotation is not awaiting approval.', 409);
        if (rev.valid_until < today()) fail('This quotation has expired. Mark it expired and revise it.');
        const chain = JSON.parse(q.approval_chain), step = chain[q.approval_step];
        if (step?.approver_id !== actor) fail('Sign in as the staff member assigned to this approval step.', 403);
        insert('approvals', { quotation_id: q.id, revision: q.revision, step: q.approval_step + 1,
          action: verb === 'approve' ? 'APPROVED' : verb === 'reject' ? 'REJECTED' : 'RETURNED', actor_id: actor, comment, created_at: now() });
        changes = { ...changes, status: verb === 'approve' ? (q.approval_step + 1 === chain.length ? 'APPROVED' : 'SUBMITTED') : verb === 'return' ? 'DRAFT' : 'REJECTED', approval_step: q.approval_step + 1 };
      } else if (verb === 'expire') {
        if (!['DRAFT','SUBMITTED','APPROVED'].includes(q.status) || rev.valid_until >= today()) fail('Only an unaccepted quotation past its validity date can be expired.');
        changes.status = 'EXPIRED';
      } else {
        if (q.status !== 'APPROVED') fail('Complete every approval before recording customer acceptance.', 409);
        if (rev.valid_until < today()) fail('The quotation has expired. Revise it before acceptance.');
        const contact = record('contact', q.contact_id), opp = record('opportunity', q.opportunity_id);
        const won = get('SELECT * FROM won_sales WHERE opportunity_id=?', opp.id);
        let account = won.account_id ? record('account', won.account_id) : get('SELECT * FROM accounts WHERE contact_id=? ORDER BY created_at LIMIT 1', contact.id);
        if (account && account.status !== 'ACTIVE') fail('Reactivate the existing Business Account before accepting a new quotation.', 409);
        if (!account) {
          const key = id('account', 'BA');
          insert('accounts', { id: key, contact_id: contact.id, name: contact.customer_name, owner_id: opp.owner_id, partner_id: opp.partner_id, created_at: now(), updated_at: now() });
          account = record('account', key);
          event(actor, contact.id, 'account', key, 'Business Account created automatically', q.id);
        }
        insert('accepted_sales', { quotation_id: q.id, account_id: account.id, revision: q.revision, accepted_at: now(),
          snapshot_json: JSON.stringify({ contact, opportunity: opp, won_snapshot: JSON.parse(get('SELECT snapshot_json FROM won_sales WHERE opportunity_id=?', opp.id).snapshot_json),
            quotation: { ...q, status: 'ACCEPTED', final_revision: { ...rev, lines: JSON.parse(rev.lines_json) } }, account,
            activities: all('SELECT * FROM activities WHERE contact_id=?', contact.id), documents: all('SELECT * FROM documents WHERE contact_id=?', contact.id) }) });
        changes.status = 'ACCEPTED';
      }
      update('quotations', q.id, changes);
      event(actor, q.contact_id, 'quotation', q.id, `Quotation ${verb === 'approve' ? 'approval recorded' : verb === 'accept' ? 'accepted by customer' : verb === 'submit' ? 'submitted for approval' : verb === 'expire' ? 'expired' : verb === 'return' ? 'returned for revision' : 'rejected'}`, comment);
      return { id: q.id, type: 'quotation' };
    }
    if (action === 'account.save') {
      const r = record('account', d.id); version(r, d.expected_version);
      update('accounts', r.id, { name: str(d.name, 'Account name', 300, true), owner_id: lookup(d.owner_id, 'staff'),
        partner_id: lookup(d.partner_id, 'partner', true), notes: str(d.notes, 'Notes', 5000),
        status: choice(d.status, ['ACTIVE','INACTIVE','SUSPENDED'], 'account status'), version: r.version + 1, updated_at: now() });
      event(actor, r.contact_id, 'account', r.id, 'Business Account updated');
      return { id: r.id, type: 'account' };
    }
    if (action === 'activity.save') {
      if(d.id&&(get('SELECT id FROM tm_tasks WHERE activity_id=?',d.id)||get('SELECT id FROM tm_meetings WHERE activity_id=?',d.id)))fail('This activity is connected to Task Management. Edit its linked task or meeting to keep both records synchronized.',409);
      const r = d.id ? record('activity', d.id) : null;
      if (r) version(r, d.expected_version);
      const ptype = choice(r?.parent_type || d.parent_type, ['CONTACT','LEAD','OPPORTUNITY','ACCOUNT','TASK'], 'parent record type');
      const key = r?.parent_id || d.parent_id || null, p = parent(ptype, key);
      const type = choice(d.type, ['FOLLOWUP','OPPORTUNITY','AFTER SALE','CHAT'], 'activity type');
      if ((type === 'OPPORTUNITY' && ptype !== 'OPPORTUNITY') || (type === 'AFTER SALE' && ptype !== 'ACCOUNT')) fail('Deal activities require an Opportunity; after-sale activities require a Business Account.');
      const start = instant(d.start_at, 'start date/time'), end = d.end_at ? instant(d.end_at, 'end date/time') : null;
      if (end && end < start) fail('End time must be after start time.');
      const status = choice(d.status || 'OPEN', ['OPEN','COMPLETED','CANCELLED'], 'activity status');
      const values = { contact_id: p.contact_id, parent_type: ptype, parent_id: ptype === 'TASK' ? null : key, type,
        subject: str(d.subject, 'Subject', 200, true), summary: str(d.summary, 'Summary', 5000), start_at: start, end_at: end,
        branch_id: lookup(d.branch_id, 'branch'), assigned_to: lookup(d.assigned_to, 'staff'), status,
        priority: choice(d.priority || 'MEDIUM', ['HIGH','MEDIUM','LOW'], 'priority'), channel: choice(d.channel || 'TASK', ['CALL','MEETING','EMAIL','NOTE','TASK'], 'channel'),
        reason: str(d.reason, 'Cancellation reason', 500, status === 'CANCELLED'), forecast_cents: type === 'AFTER SALE' ? scaled(d.forecast, 2, 'Forecast value') : 0,
        version: r ? r.version + 1 : 0, updated_at: now() };
      const aid = r?.id || id('activity', 'ACT');
      if (r) update('activities', aid, values); else insert('activities', { id: aid, ...values, created_at: now() });
      event(actor, p.contact_id, 'activity', aid, r ? `Activity updated · ${status}` : `${values.channel.toLowerCase()} scheduled`, values.subject);
      return { id: aid, type: 'activity' };
    }
    if (action === 'document.link') {
      const ptype = choice(d.parent_type, ['CONTACT','LEAD','OPPORTUNITY','ACCOUNT','QUOTATION'], 'document parent'), p = parent(ptype, d.parent_id);
      let url; try { url = new URL(d.url); } catch { fail('Enter a complete http or https document URL.'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href.length > 3000) fail('Use an http or https document URL without embedded credentials.');
      const key = id('document', 'DOC');
      insert('documents', { id: key, contact_id: p.contact_id, parent_type: ptype, parent_id: d.parent_id,
        title: str(d.title, 'Document title', 200, true), url: url.href, created_at: now() });
      event(actor, p.contact_id, 'document', key, 'Document linked', d.title);
      return { id: key, type: 'document' };
    }
    if (action === 'order.create') {
      const q = record('quotation', d.quotation_id), existing = get('SELECT * FROM orders WHERE quotation_id=?', q.id);
      if (existing) return { id: existing.id, type: 'order' };
      if (q.status !== 'ACCEPTED') fail('Customer acceptance is required before creating a Sales Order.', 409);
      const sale = get('SELECT * FROM accepted_sales WHERE quotation_id=?', q.id), rev = latestQuote(q);
      if (record('account', sale.account_id).status !== 'ACTIVE') fail('The Business Account must be active.');
      const key = id('order', 'SO');
      insert('orders', { id: key, quotation_id: q.id, account_id: sale.account_id, contact_id: q.contact_id, total_cents: rev.total_cents,
        snapshot_json: sale.snapshot_json, status: 'ORDERED', created_at: now() });
      update('quotations', q.id, { status: 'CONVERTED', version: q.version + 1, updated_at: now() });
      event(actor, q.contact_id, 'order', key, 'Sales Order created', q.id);
      return { id: key, type: 'order' };
    }
    if (action === 'order.ship') {
      const r = record('order', d.id); version(r, d.expected_version);
      if (r.status !== 'ORDERED') fail('Only an unshipped Sales Order can be shipped.', 409);
      const key = id('shipment', 'SHP');
      insert('shipments', { id: key, order_id: r.id, reference: str(d.reference, 'Shipment / service delivery reference', 200, true),
        shipment_date: date(d.shipment_date, 'shipment date'), notes: str(d.notes, 'Notes', 5000), created_at: now() });
      update('orders', r.id, { status: 'SHIPPED', version: r.version + 1 });
      event(actor, r.contact_id, 'order', r.id, 'Shipment / service delivery recorded', key);
      return { id: r.id, type: 'order' };
    }
    if (action === 'order.invoice') {
      const r = record('order', d.id); version(r, d.expected_version);
      if (r.status !== 'SHIPPED') fail('Record shipment / service delivery before invoicing.', 409);
      const start = date(d.invoice_date, 'invoice date'), due = date(d.due_date, 'due date');
      if (due < start) fail('Due date cannot be before invoice date.');
      const key = id('invoice', 'INV');
      insert('invoices', { id: key, order_id: r.id, invoice_date: start, due_date: due, total_cents: r.total_cents, created_at: now() });
      update('orders', r.id, { status: r.total_cents === 0 ? 'PAID' : 'INVOICED', version: r.version + 1 });
      event(actor, r.contact_id, 'order', r.id, 'Invoice created', key);
      return { id: r.id, type: 'order' };
    }
    if (action === 'payment.record') {
      const request = str(d.request_key, 'Payment request key', 100, true);
      const duplicate = get('SELECT * FROM payments WHERE request_key=?', request);
      if (duplicate) {
        if (duplicate.invoice_id !== d.invoice_id || duplicate.amount_cents !== scaled(d.amount)) fail('This payment request key was already used for a different payment.', 409);
        return { id: get('SELECT order_id FROM invoices WHERE id=?', duplicate.invoice_id).order_id, type: 'order', message: 'Payment already recorded.' };
      }
      const inv = get('SELECT * FROM invoices WHERE id=?', d.invoice_id) || fail('Invoice not found.', 404), r = record('order', inv.order_id);
      if (r.status !== 'INVOICED') fail('This invoice is already settled or is not open.', 409);
      const paid = get('SELECT COALESCE(SUM(amount_cents),0) AS value FROM payments WHERE invoice_id=?', inv.id).value;
      const amount = scaled(d.amount, 2, 'Payment amount');
      if (amount <= 0 || amount > inv.total_cents - paid) fail('Payment must be positive and cannot exceed the remaining balance.');
      const key = id('payment', 'PAY');
      insert('payments', { id: key, invoice_id: inv.id, amount_cents: amount, payment_date: date(d.payment_date, 'payment date'),
        reference: str(d.reference, 'Payment reference', 200, true), request_key: request, created_at: now() });
      update('orders', r.id, { status: amount + paid === inv.total_cents ? 'PAID' : 'INVOICED', version: r.version + 1 });
      event(actor, r.contact_id, 'order', r.id, 'Payment recorded', `${key} · ${(amount / 100).toFixed(2)}`);
      return { id: r.id, type: 'order' };
    }
    if (action === 'settings.save') {
      if (!Array.isArray(d.approvers) || !d.approvers.length || d.approvers.length > 5 || new Set(d.approvers).size !== d.approvers.length) fail('Select 1–5 different approvers.');
      d.approvers.forEach(a => lookup(a, 'staff'));
      const companyEmail = str(d.email, 'Email', 200);
      if (companyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail)) fail('Enter a valid company email address.');
      // V5.5: the company's time zone (calendar, reminders and dates for everyone who has not chosen their own).
      const zone = d.timezone === undefined ? (get('SELECT timezone FROM company WHERE id=1')?.timezone || '') : str(d.timezone, 'Company time zone', 64);
      if (zone && !(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).concat(['UTC', 'Asia/Phnom_Penh']).includes(zone)) fail('Choose a valid company time zone (for example Asia/Phnom_Penh).');
      update('company', 1, { name: str(d.name, 'Company name', 200, true), address: str(d.address, 'Address'), phone: str(d.phone, 'Phone', 50), email: companyEmail, tax_id: str(d.tax_id, 'Tax ID', 50), timezone: zone });
      run('DELETE FROM approval_steps'); d.approvers.forEach((a, i) => insert('approval_steps', { step: i + 1, approver_id: a }));
      event(actor, null, 'company', '1', 'Company and future approval chain updated');
      return { message: 'Settings saved. Submitted requests keep their original approval chain.' };
    }
    if (action === 'lookup.save') {
      const kind = choice(d.kind, ['staff','branch','material','opportunity_class','contact_class','lead_class','campaign_class','partner'], 'lookup type');
      const key = d.id || (kind === 'staff' ? id('staff', 'STAFF') : id('reference', 'REF'));
      if (d.id && !get('SELECT id FROM lookups WHERE id=? AND kind=?', key, kind)) fail('Lookup not found.', 404);
      const values = { name: str(d.name, 'Name', 200, true), unit: str(d.unit, 'Unit', 30), active: 1 };
      const accountName=kind==='staff'?get('SELECT username FROM access_users WHERE staff_id=?',key)?.username:null;
      if(accountName&&values.name!==accountName)fail('Display names come from usernames. Use Administration → User accounts to manage another user’s username.',403);
      if (get('SELECT id FROM lookups WHERE kind=? AND name=? AND id<>?', kind, values.name, key)) fail(`“${values.name}” is already used for another ${kind.replaceAll('_', ' ')} reference.`, 409);
      if (d.id) update('lookups', key, values); else insert('lookups', { id: key, kind, ...values });
      return { message: 'Reference saved.' };
    }
    fail('Unknown action.', 404);
  }

  // Due date reminders (Task Controlling Management bell and Telegram). The Task Controlling Management server calls this every few minutes for each company.
  function reminders(at = new Date()) {
    db.exec('BEGIN IMMEDIATE');
    try { const n = tasks.reminders(at); db.exec('COMMIT'); if (n) changed(); return n; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // V5.5: meeting and calendar-note reminders. The Task Controlling Management server calls this every minute for each company.
  function eventReminders(at = new Date()) {
    db.exec('BEGIN IMMEDIATE');
    try { const n = tasks.eventReminders(at); db.exec('COMMIT'); if (n) changed(); return n; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function state() {
    const data = { company: get('SELECT * FROM company WHERE id=1'), app_version: APP_VERSION, app_build: APP_BUILD };
    for (const table of ['lookups','contacts','campaigns','leads','opportunities','opportunity_lines','quotations','quote_revisions','approvals','accounts','activities','documents','orders','shipments','invoices','payments','approval_steps']) data[table] = all(`SELECT * FROM ${table}`);
    data.won_sales = all('SELECT opportunity_id,account_id,closed_by,closed_at FROM won_sales');
    data.accepted_sales = all('SELECT quotation_id,account_id,revision,accepted_at FROM accepted_sales');
    data.events = all('SELECT * FROM events ORDER BY created_at DESC,id DESC LIMIT 150');
    return {...data,...operations.state(),...tasks.state()};
  }
  function journey(contactId) {
    const contact = record('contact', contactId);
    return { contact, events: all('SELECT * FROM events WHERE contact_id=? ORDER BY created_at DESC,id DESC', contactId),
      won_sales: all('SELECT w.* FROM won_sales w JOIN opportunities o ON o.id=w.opportunity_id WHERE o.contact_id=?', contactId),
      accepted_sales: all('SELECT s.* FROM accepted_sales s JOIN quotations q ON q.id=s.quotation_id WHERE q.contact_id=?', contactId) };
  }

  // V5.5: the whole state as one signed-in person may see it (permissions and the Task Visibility Scope). Reports,
  // the dashboard, exports and the Mini App read from this, never from the unfiltered state.
  const scopedState = user => access.filterState(state(), user);
  return { db, all, get, run, state, scopedState, journey, command, reminders, eventReminders, sync, record, linesFor, latestQuote, insert, update, operations, tasks, access, organization, telegram, changes: () => changeSeq };
}

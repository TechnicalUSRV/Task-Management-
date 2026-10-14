// Regression checks for the V5.1 backend and database fixes.
// Uses temporary data only; nothing touches the local data folder.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore, InputError } from './service.mjs';
import { seedDemo } from './seed.mjs';
import { createLocalServer } from './server.mjs';
import { openCompanies } from './company-hub.mjs';
import { buildReport } from './reports.mjs';
import { buildTaskReport } from './task-domain.mjs';
import { buildOpsReport } from './operations-reports.mjs';

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS', name); };
const rejects = (fn, status, pattern) => {
  try { fn(); } catch (e) {
    assert.equal(e.status, status, `expected ${status} for: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return e;
  }
  assert.fail('Expected the action to be rejected.');
};

const folder = mkdtempSync(path.join(tmpdir(), 'sunny-v51-'));
const s = openStore(path.join(folder, 'erp.sqlite'));
try {
  seedDemo(s);
  const dn = s.get("SELECT id FROM ops_requests WHERE type='DN' LIMIT 1").id;

  await check('uploads with unusual names are rejected cleanly instead of failing with a server error', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty.', 'report']) {
      const e = rejects(() => s.command('ops.file.add', { id: dn, name, base64: Buffer.from('x').toString('base64') }, 'STAFF-003'), 400, /Upload PDF, PNG, JPG/);
      assert.ok(e instanceof InputError);
    }
    const ok = s.command('ops.file.add', { id: dn, name: 'evidence.PDF', base64: Buffer.from('%PDF-1.4').toString('base64') }, 'STAFF-003');
    assert.ok(ok.file_id);
  });

  await check('duplicate names return specific, actionable messages', () => {
    rejects(() => s.command('tm.profile.save', { name: 'Dara · Sales', active: 1 }, 'STAFF-003'), 409, /team member already uses this name/);
    rejects(() => s.command('tm.workspace.save', { name: 'customer ONBOARDING (sample)', owner_id: 'STAFF-003', member_ids: ['STAFF-003'] }, 'STAFF-003'), 409, /workspace with this name already exists/);
    rejects(() => s.command('admin.role.save', { name: 'manager', permissions: {} }, 'STAFF-003'), 409, /role with this name already exists/);
    rejects(() => s.command('lookup.save', { kind: 'branch', name: 'Phnom Penh' }, 'STAFF-003'), 409, /already used for another branch reference/);
    rejects(() => s.command('contact.save', { code: 'cont-000001', first_name: 'A', customer_name: 'B', owner_id: 'STAFF-001' }, 'STAFF-003'), 409, /Contact ID CONT-000001 already exists/);
    const t = s.get('SELECT task_id,staff_id,work_date FROM tm_timesheets LIMIT 1');
    rejects(() => s.command('tm.time.save', { task_id: t.task_id, staff_id: t.staff_id, work_date: t.work_date, duration: '0:30' }, 'STAFF-003'), 409, /already has time recorded for this task on that date/);
    rejects(() => s.command('admin.user.save', { name: 'Sophea · Sales Manager', email: 'new.person@example.test', password: 'long-enough-password', role_id: 'ROLE-VIEWER' }, 'STAFF-003'), 409, /staff member already uses this name/);
    // Renaming a record to its own current name remains allowed.
    const ws = s.get('SELECT * FROM tm_workspaces LIMIT 1');
    const members = s.all('SELECT staff_id FROM tm_members WHERE workspace_id=?', ws.id).map(m => m.staff_id);
    s.command('tm.workspace.save', { id: ws.id, expected_version: ws.version, name: ws.name, owner_id: ws.owner_id, member_ids: members, color: ws.color }, 'STAFF-003');
    s.command('lookup.save', { id: 'BR-PP', kind: 'branch', name: 'Phnom Penh' }, 'STAFF-003');
  });

  await check('company settings reject an invalid email address', () => {
    rejects(() => s.command('settings.save', { name: 'Sunny Logistics', email: 'not-an-email', approvers: ['STAFF-002', 'STAFF-003'] }, 'STAFF-003'), 400, /valid company email/);
    s.command('settings.save', { name: 'Sunny Logistics', email: '', address: 'Phnom Penh, Cambodia', approvers: ['STAFF-002', 'STAFF-003'] }, 'STAFF-003');
  });

  await check('all report builders reject impossible dates and reversed ranges', () => {
    const state = s.state();
    for (const build of [f => buildReport(state, f), f => buildTaskReport(state, f), f => buildOpsReport(state, f)]) {
      rejects(() => build({ from: '2026-02-30' }), 400);
      rejects(() => build({ to: '2026-13-01' }), 400);
      rejects(() => build({ from: '2026-09-10', to: '2026-09-01' }), 400, /end date/);
      assert.ok(Array.isArray(build({ from: '2026-01-01', to: '2026-12-31' }).rows));
    }
    rejects(() => buildOpsReport(state, { month: '2026-13' }), 400, /month/);
    rejects(() => buildOpsReport(state, { report: 'constructor' }), 400);
    rejects(() => buildTaskReport(state, { report: 'toString' }), 400);
  });

  await check('additive indexes exist and the database stays consistent', () => {
    const names = new Set(s.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name));
    for (const name of ['tm_assignee_staff', 'tm_attendee_staff', 'tm_member_staff', 'tm_meeting_workspace', 'tm_event_entity_id', 'access_session_user', 'access_session_expiry', 'ops_notifications_actor', 'ops_files_request']) assert.ok(names.has(name), name);
    assert.deepEqual(s.all('PRAGMA foreign_key_check'), []);
    assert.equal(s.get('PRAGMA integrity_check').integrity_check, 'ok');
  });

  await check('HTTP: malformed addresses, oversized uploads, fonts, caching and unknown commands', async () => {
    const port = 4391, server = createLocalServer(s, port), origin = `http://127.0.0.1:${port}`;
    const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'assets');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    try {
      const admin = s.access.bootstrap({ staff_id: 'STAFF-003', name: 'Vanna · Director', email: 'admin@example.test', password: 'test-only-password' });
      const cookie = 'sunny_session=' + s.access.startSession(admin);
      const bad = await fetch(origin + '/%E0%A4%A');
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /not valid/);
      const big = await fetch(origin + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '"' + 'a'.repeat(7600000) + '"' });
      assert.equal(big.status, 413);
      assert.match((await big.json()).error, /5 MB/);
      const unknown = await fetch(origin + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ action: 'constructor', data: {} }) });
      assert.equal(unknown.status, 403);
      assert.match((await unknown.json()).error, /not available/);
      const missingReport = await fetch(origin + '/api/reportx', { headers: { Cookie: cookie } });
      assert.equal(missingReport.status, 404);
      const home = await fetch(origin + '/');
      assert.match(home.headers.get('content-security-policy'), /font-src 'self'/);
      assert.equal(home.headers.get('cache-control'), 'no-store');
      // Serve a temporary hashed font to check the MIME type and cache policy.
      mkdirSync(publicDir, { recursive: true });
      const font = path.join(publicDir, 'test-font-AbCdEf12.woff2');
      writeFileSync(font, Buffer.from('wOF2'));
      try {
        const asset = await fetch(origin + '/assets/test-font-AbCdEf12.woff2');
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get('content-type'), 'font/woff2');
        assert.match(asset.headers.get('cache-control'), /immutable/);
      } finally { rmSync(font, { force: true }); }
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await check('one unreadable company database does not block the company list', () => {
    const dataDir = path.join(folder, 'hub');
    const hub = openCompanies(dataDir,{demo:true});
    try {
      mkdirSync(path.join(dataDir, 'companies'), { recursive: true });
      writeFileSync(path.join(dataDir, 'companies', 'broken.sqlite'), 'this is not a database');
      const registry = new DatabaseSync(path.join(dataDir, 'companies.sqlite'));
      registry.prepare('INSERT INTO companies VALUES(?,?,?,?)').run('broken', 'Broken copy', 'companies/broken.sqlite', new Date().toISOString());
      registry.close();
      const original = console.error; console.error = () => {};
      let list; try { list = hub.list(); } finally { console.error = original; }
      // Creation timestamps can tie within one millisecond; this check concerns availability, not display order.
      assert.deepEqual(list.map(c => c.name).sort(), ['Sunny Logistics', 'Broken copy'].sort());
    } finally { hub.close(); }
  });

  console.log(`\n${checks} V5.1 fix checks passed.`);
} finally { s.db.close(); rmSync(folder, { recursive: true, force: true }); }

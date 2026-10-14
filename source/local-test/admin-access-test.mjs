import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openCompanies} from './company-hub.mjs';
import {adminAccess, findOtherData} from './admin-access.mjs';

// The administrator access tool: lists logins on this computer (also in ERP folders next to it) and sets a new
// password for a forgotten one. Temporary folders only.
const top = mkdtempSync(path.join(tmpdir(), 'sunny-admin-')), versions = path.join(top, 'V5');
const current = path.join(versions, 'Sunny_ERP_V5.2.2_Local_Test'), older = path.join(versions, 'Sunny_ERP_V5.2_Local_Test');
const fresh = path.join(versions, 'Sunny_ERP_V5.2.3_Local_Test'), nested = path.join(versions, 'Sunny_ERP_V5.1_Local_Test', 'Sunny_ERP_V5.1_Local_Test');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const PORT = 9; // nothing listens there, so the ERP counts as not running
const run = async (erpFolder, answers) => {
  const out = [], queue = [...answers];
  const result = await adminAccess({erpFolder, port: PORT, ask: async () => queue.shift() ?? '', say: t => out.push(t)});
  return {result, text: out.join('\n')};
};
const withStore = (folder, fn) => { const c = openCompanies(path.join(folder, 'data'),{demo:true}); try { return fn(c.primary); } finally { c.close(); } };
const fileHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  mkdirSync(fresh, {recursive: true});
  withStore(current, s => {
    s.access.bootstrap({staff_id: 'STAFF-003', name: 'Vanna · Director', email: 'vanna@example.test', password: 'old-password-1'});
    s.command('admin.user.save', {staff_id: 'STAFF-001', name: 'Dara · Sales', email: 'dara@example.test', role_id: 'ROLE-MEMBER', password: 'dara-password-12', active: 1}, 'STAFF-003');
    s.access.startSession(s.access.login('vanna@example.test', 'old-password-1', '127.0.0.1'));
    for (let i = 0; i < 10; i++) try { s.access.login('vanna@example.test', 'wrong-password', '127.0.0.1'); } catch { /* locked after 10 */ }
    assert.throws(() => s.access.login('vanna@example.test', 'old-password-1', '127.0.0.1'), /Too many/);
  });
  withStore(older, s => s.access.bootstrap({staff_id: 'STAFF-003', name: 'Vanna · Director', email: 'boss@older.test', password: 'older-password-1'}));
  withStore(nested, s => s.access.bootstrap({staff_id: 'STAFF-003', name: 'Vanna · Director', email: 'nested@v51.test', password: 'nested-password-1'}));

  await check('lists this folder’s logins, Administrators first, and ERP data with logins in folders next to it', async () => {
    const {result, text} = await run(current, ['']);
    assert.equal(result.status, 'listed');
    assert.match(text, /1\. Vanna · Director — vanna@example\.test — Administrator/); assert.match(text, /2\. Dara · Sales — dara@example\.test — Team Member/);
    assert.match(text, /Sunny_ERP_V5\.2_Local_Test[\\/]data[\s\S]*Administrator: boss@older\.test/);
    assert.match(text, /Sunny_ERP_V5\.1_Local_Test[\\/]Sunny_ERP_V5\.1_Local_Test[\\/]data[\s\S]*nested@v51\.test/, 'a ZIP extracted one level deeper is found too');
    assert.equal(findOtherData(current).length, 2);
  });

  await check('sets a new password: old one stops working, sessions end, sign-in locks clear, and it is recorded', async () => {
    const {result, text} = await run(current, ['1', 'brand-new-password-26', 'brand-new-password-26']);
    assert.equal(result.status, 'reset'); assert.match(text, /New password saved for vanna@example\.test/);
    withStore(current, s => {
      assert.equal(s.get("SELECT COUNT(*) AS n FROM access_sessions s JOIN access_users u ON u.id=s.user_id WHERE u.email='vanna@example.test'").n, 0);
      assert.equal(s.get('SELECT COUNT(*) AS n FROM access_attempts').n, 0);
      assert.throws(() => s.access.login('vanna@example.test', 'old-password-1', '127.0.0.1'), /incorrect/);
      assert.equal(s.access.login('vanna@example.test', 'brand-new-password-26', '127.0.0.1').email, 'vanna@example.test');
      assert.match(s.get("SELECT detail FROM access_audit WHERE action='Password reset on this computer'").detail, /vanna@example\.test/);
    });
  });

  await check('nothing changes for a mismatch, a short password or an unknown number', async () => {
    const before = withStore(current, s => s.get("SELECT password_hash FROM access_users WHERE email='dara@example.test'").password_hash);
    assert.equal((await run(current, ['2', 'first-password-1', 'other-password-1'])).result.status, 'mismatch');
    assert.equal((await run(current, ['2', 'short'])).result.status, 'invalid');
    assert.equal((await run(current, ['7'])).result.status, 'invalid');
    assert.equal(withStore(current, s => s.get("SELECT password_hash FROM access_users WHERE email='dara@example.test'").password_hash), before);
  });

  await check('a disabled login can be enabled again with its new password', async () => {
    withStore(current, s => {
      s.command('admin.user.save', {staff_id: 'STAFF-002', name: 'Sophea · Sales Manager', email: 'sophea@example.test', role_id: 'ROLE-ADMIN', password: 'sophea-password-1', active: 1}, 'STAFF-003');
      const v = s.get("SELECT * FROM access_users WHERE email='vanna@example.test'");
      s.command('admin.user.disable', {id: v.id, expected_version: v.version, reason: 'Testing recovery'}, 'STAFF-002');
    });
    const listed = (await run(current, [''])).result.accounts, index = listed.findIndex(a => a.email === 'vanna@example.test') + 1;
    assert.equal((await run(current, [String(index), 'n'])).result.status, 'cancelled');
    const {result, text} = await run(current, [String(index), 'y', 'enabled-again-2026', 'enabled-again-2026']);
    assert.equal(result.status, 'reset'); assert.match(text, /enabled again/);
    withStore(current, s => assert.equal(s.access.login('vanna@example.test', 'enabled-again-2026', '127.0.0.1').active, 1));
  });

  await check('a folder without data is left alone and points to setup and to data in other folders', async () => {
    const olderFile = path.join(older, 'data', 'erp.sqlite'), olderBefore = fileHash(olderFile);
    const {result, text} = await run(fresh, []);
    assert.equal(result.status, 'no-data'); assert.match(text, /has no data yet/); assert.match(text, /"Create the administrator"/); assert.match(text, /close the ERP \(if it is open\), copy that "data" folder/);
    assert.match(text, /boss@older\.test/); assert.match(text, /vanna@example\.test/);
    assert.equal(existsSync(path.join(fresh, 'data')), false, 'no data folder is created');
    assert.equal(fileHash(olderFile), olderBefore, 'other folders are only read');
  });
  console.log(`\n${checks} administrator access checks passed. Temporary data only.`);
} finally {
  rmSync(top, {recursive: true, force: true});
}

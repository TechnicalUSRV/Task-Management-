// Administrator access on this computer. Shows which logins exist in this Task Controlling Management folder's data (and in Task Controlling Management folders
// next to it, for example an earlier version), and sets a new password for a login whose password was forgotten.
// Run it on the computer that holds the data folder: ADMIN_ACCESS_WINDOWS.cmd, or `node admin-access.mjs`.
// Anyone who can run it can already read the data folder, so it needs no password itself.
import {existsSync, readdirSync, statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, scryptSync} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_VERSION, DEFAULT_PORT} from './version.mjs';
import {openCompanies} from './company-hub.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// The same salted scrypt format that access.mjs checks at sign-in.
export const passwordHash = value => { const salt = randomBytes(16).toString('hex'); return `scrypt:${salt}:${scryptSync(value, salt, 64).toString('hex')}`; };

const ACCOUNTS = `SELECT u.id, u.email, u.role_id, u.active, u.staff_id, COALESCE(l.name, u.staff_id) AS name, COALESCE(r.name, u.role_id) AS role,
  (SELECT MAX(a.created_at) FROM access_audit a WHERE a.action='Signed in' AND a.target_id=u.id) AS last_sign_in
  FROM access_users u LEFT JOIN lookups l ON l.id=u.staff_id LEFT JOIN access_roles r ON r.id=u.role_id
  ORDER BY CASE WHEN u.role_id='ROLE-ADMIN' THEN 0 ELSE 1 END, u.active DESC, l.name`;
const ACCOUNTS_BASIC = `SELECT u.id, u.email, u.role_id, u.active, u.staff_id, u.staff_id AS name, u.role_id AS role, NULL AS last_sign_in FROM access_users u ORDER BY u.role_id='ROLE-ADMIN' DESC, u.active DESC`;
const day = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Phnom_Penh'}); };
const describe = a => `${a.name} — ${a.email} — ${a.role_id === 'ROLE-ADMIN' ? 'Administrator' : a.role}${a.active ? '' : ' (disabled)'}${a.last_sign_in ? ` — last signed in ${day(a.last_sign_in)}` : ''}`;

// Reads another Task Controlling Management data folder without changing it.
export function peekDataFolder(dir) {
  const file = path.join(dir, 'erp.sqlite');
  if (!existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, {readOnly: true});
    const hasAccounts = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='access_users'").get();
    let accounts = [];
    if (hasAccounts) { try { accounts = db.prepare(ACCOUNTS).all(); } catch { accounts = db.prepare(ACCOUNTS_BASIC).all(); } }
    let company = ''; try { company = db.prepare('SELECT name FROM company WHERE id=1').get()?.name || ''; } catch { /* older data */ }
    return {dir, company, accounts, modified: statSync(file).mtime};
  } catch (e) { return {dir, company: '', accounts: [], error: e.message}; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}
// Task Controlling Management data in folders next to this Task Controlling Management folder (earlier versions, also when a ZIP was extracted into a folder of the
// same name, one level deeper), and a data folder copied one level too deep. Folders are only listed, never searched.
export function findOtherData(erpFolder) {
  const found = [], seen = new Set([path.resolve(erpFolder, 'data')]);
  const consider = dir => { const r = path.resolve(dir); if (seen.has(r)) return; seen.add(r); const p = peekDataFolder(r); if (p) found.push(p); };
  consider(path.join(erpFolder, 'data', 'data'));
  const parent = path.dirname(path.resolve(erpFolder));
  for (const base of new Set([parent, path.dirname(parent)])) {
    let entries = []; try { entries = readdirSync(base, {withFileTypes: true}); } catch { /* no access */ }
    for (const e of entries.slice(0, 200)) if (e.isDirectory()) { consider(path.join(base, e.name, 'data')); consider(path.join(base, e.name, e.name, 'data')); }
  }
  return found.sort((a, b) => (b.accounts.length ? 1 : 0) - (a.accounts.length ? 1 : 0) || (b.modified || 0) - (a.modified || 0));
}
async function erpRunning(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/version`, {signal: AbortSignal.timeout(1500)})).ok; } catch { return false; }
}

export async function adminAccess({erpFolder = root, dataDir = path.join(erpFolder, 'data'), port = DEFAULT_PORT, ask, say, now = () => new Date()}) {
  const local = `http://127.0.0.1:${port}`, running = await erpRunning(port);
  const setup = `To create the Administrator: start the Task Controlling Management on this computer (START_WINDOWS.cmd), open ${local} and fill in
"Create the administrator". (The shared https:// address cannot do this.)`;
  say(`${APP_VERSION} · administrator access on this computer\n\nERP folder: ${erpFolder}\nData folder: ${dataDir}${running ? `\nThe Task Controlling Management is running on ${local}.` : ''}\n`);
  const others = findOtherData(erpFolder);
  const showOthers = (listed = false) => {
    const useful = others.filter(o => o.accounts.length);
    if (!useful.length) return;
    say(listed ? 'Other Task Controlling Management folders on this computer also have logins (if the login you are looking for is not listed above,\nit may be in one of these):' : 'Task Controlling Management data with logins found in other folders:');
    for (const o of useful) {
      const admins = o.accounts.filter(a => a.role_id === 'ROLE-ADMIN' && a.active).map(a => a.email);
      say(`  • ${o.dir}\n    ${o.company ? o.company + ' · ' : ''}${o.accounts.length} login${o.accounts.length === 1 ? '' : 's'}${admins.length ? ` · Administrator: ${admins.join(', ')}` : ''} · last changed ${day(o.modified)}`);
    }
    const here = existsSync(dataDir) ? 'close the Task Controlling Management, rename this folder\'s "data" folder (for example to "data-new"),\ncopy' : 'close the Task Controlling Management (if it is open), copy';
    say(`To use one of these here: ${here} that "data" folder into ${erpFolder}, then start the Task Controlling Management again.\n`);
  };
  if (!existsSync(path.join(dataDir, 'erp.sqlite'))) {
    say(`This Task Controlling Management folder has no data yet, so it has no logins.\n${setup}\n`);
    showOthers();
    return {status: 'no-data', others};
  }
  const companies = openCompanies(dataDir);
  try {
    const list = companies.list();
    let company = list[0];
    if (list.length > 1) {
      say('Companies in this data folder:'); list.forEach((c, i) => say(`  ${i + 1}. ${c.name}`));
      const choice = Number((await ask('Type the number of the company (Enter for 1): ')).trim() || 1);
      company = list[choice - 1];
      if (!company) { say('There is no company with that number. Nothing was changed.'); return {status: 'invalid'}; }
    }
    const store = companies.get(company.id), accounts = store.all(ACCOUNTS);
    if (!accounts.length) {
      say(`${company.name} has no logins yet (this is a new or sample copy).\n${setup}\n`);
      showOthers();
      return {status: 'no-accounts', others};
    }
    say(`Logins in ${company.name}:`);
    accounts.forEach((a, i) => say(`  ${i + 1}. ${describe(a)}`));
    say('');
    showOthers(true);
    const pick = (await ask('Type the number of a login to give it a new password, or press Enter to finish: ')).trim();
    if (!pick) { say(`Nothing was changed. Sign in at ${local} with one of the emails above.`); return {status: 'listed', accounts}; }
    const account = accounts[Number(pick) - 1];
    if (!account) { say('There is no login with that number. Nothing was changed.'); return {status: 'invalid'}; }
    let enable = false;
    if (!account.active) {
      enable = /^y/i.test((await ask(`${account.email} is disabled, so it cannot sign in. Enable it again? (y/N): `)).trim());
      if (!enable) { say('Nothing was changed.'); return {status: 'cancelled'}; }
    }
    const first = await ask(`New password for ${account.email} (10 to 200 characters): `, {hidden: true});
    if (first.length < 10 || first.length > 200) { say('The password must be 10 to 200 characters long. Nothing was changed.'); return {status: 'invalid'}; }
    const second = await ask('Type the new password again: ', {hidden: true});
    if (first !== second) { say('The two passwords are different. Nothing was changed.'); return {status: 'mismatch'}; }
    const at = now().toISOString();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.run('UPDATE access_users SET password_hash=?, active=?, version=version+1, updated_at=? WHERE id=?', passwordHash(first), enable ? 1 : account.active, at, account.id);
      store.run('DELETE FROM access_sessions WHERE user_id=?', account.id);
      store.run('DELETE FROM access_attempts');
      store.run('INSERT INTO access_audit(actor_id,action,target_id,detail,created_at) VALUES(?,?,?,?,?)', account.staff_id, 'Password reset on this computer', account.id, `${account.email} · administrator access tool${enable ? ' · login enabled again' : ''}`, at);
      store.db.exec('COMMIT');
    } catch (e) { store.db.exec('ROLLBACK'); throw e; }
    say(`\n✓ New password saved for ${account.email}${enable ? ' (the login is enabled again)' : ''}.\n  Sign in at ${local} on this computer${running ? '' : ' after starting the Task Controlling Management (START_WINDOWS.cmd or SHARE_FOR_TESTING_WINDOWS.cmd)'}.`);
    return {status: 'reset', email: account.email};
  } finally { companies.close(); }
}

// Console questions: typed answers are shown, passwords appear as *.
function consoleIO() {
  const stdin = process.stdin, lines = [], waiters = [];
  let ended = false, buffer = '';
  if (!stdin.isTTY) {
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => { buffer += chunk; let m; while ((m = /\r?\n/.exec(buffer))) { lines.push(buffer.slice(0, m.index)); buffer = buffer.slice(m.index + m[0].length); } while (waiters.length && lines.length) waiters.shift()(lines.shift()); });
    stdin.on('end', () => { ended = true; if (buffer) lines.push(buffer); buffer = ''; while (waiters.length) waiters.shift()(lines.shift() ?? ''); });
  }
  const ask = (prompt, {hidden = false} = {}) => new Promise(resolve => {
    process.stdout.write(prompt);
    if (!stdin.isTTY) { const done = v => { process.stdout.write(hidden ? '*'.repeat(v.length) + '\n' : v + '\n'); resolve(v); }; if (lines.length) done(lines.shift()); else if (ended) done(''); else waiters.push(done); return; }
    let value = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(value); return; }
        if (ch === '\u0003') { process.stdout.write('\nStopped. Nothing was changed.\n'); process.exit(130); }
        if (ch === '\u0008' || ch === '\u007f') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch; process.stdout.write(hidden ? '*' : ch);
      }
    };
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData);
  });
  return {ask, say: text => console.log(text), close: () => stdin.pause()};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const io = consoleIO();
  adminAccess({port: Number(process.env.ERP_LOCAL_PORT || DEFAULT_PORT), ask: io.ask, say: io.say})
    .catch(e => { console.error(`\nNothing was changed: ${e.message}`); process.exitCode = 1; })
    .finally(() => io.close());
}

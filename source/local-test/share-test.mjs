import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './service.mjs';
import {seedDemo} from './seed.mjs';
import {createLocalServer, publicOrigin, startERP} from './server.mjs';
import {createMiniAppHandler, effectiveMiniAppUrl} from './telegram-gateway.mjs';
import {cloudflaredAsset, readTunnelLine} from './share.mjs';

// Sharing for testing: the ERP and the Telegram Mini App behind one temporary HTTPS address (share.mjs).
// Requests are sent with the tunnel's Host header straight to the local server; no tunnel is started.
const folder = mkdtempSync(path.join(tmpdir(), 'sunny-share-')), s = openStore(path.join(folder, 'share.sqlite'));
const PUBLIC = 'https://quiet-river-1234.trycloudflare.com', HOST = 'quiet-river-1234.trycloudflare.com', TOKEN = '123456789:AAHtestTokenForSunnyErpLocalChecks00';
let checks = 0, shared, plain;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const listen = srv => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)); });
// node:http (unlike fetch) lets the test set the Host header the way the tunnel forwards it.
const raw = (port, method, url, {host, origin, cookie, body, headers = {}} = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({host: '127.0.0.1', port, method, path: url, agent: false, headers: {Host: host || `127.0.0.1:${port}`, ...(origin ? {Origin: origin} : {}), ...(cookie ? {Cookie: cookie} : {}), ...(data ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)} : {}), ...headers}}, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({status: res.statusCode, headers: res.headers, text, json}); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});
try {
  seedDemo(s);
  const pub = path.join(folder, 'public'); mkdirSync(path.join(pub, 'assets'), {recursive: true});
  writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>ERP</title>'); writeFileSync(path.join(pub, 'tg.html'), '<!doctype html><title>Tasks</title>');
  const companies = {list: () => [{id: 'default'}], get: () => s};
  shared = createLocalServer(s, 0, null, {publicUrl: PUBLIC, miniApp: createMiniAppHandler({companies, publicDir: pub, logger: {error: () => {}}})});
  const port = await listen(shared), local = `http://127.0.0.1:${port}`;
  // createLocalServer checks Host against the port it was given, so the shared server is rebuilt on its real port.
  await new Promise(r => shared.close(r));
  shared = createLocalServer(s, port, null, {publicUrl: PUBLIC, miniApp: createMiniAppHandler({companies, publicDir: pub, logger: {error: () => {}}})});
  await new Promise((resolve, reject) => { shared.once('error', reject); shared.listen(port, '127.0.0.1', resolve); });
  const viaTunnel = (method, url, o = {}) => raw(port, method, url, {host: HOST, origin: method === 'POST' ? PUBLIC : undefined, ...o});
  const viaLocal = (method, url, o = {}) => raw(port, method, url, {origin: method === 'POST' ? local : undefined, ...o});

  await check('the shared address must be an https:// origin without a path', () => {
    assert.equal(publicOrigin(PUBLIC + '/'), PUBLIC); assert.equal(publicOrigin(''), '');
    assert.throws(() => publicOrigin('http://quiet-river-1234.trycloudflare.com'), /https/);
    assert.throws(() => publicOrigin(PUBLIC + '/erp'), /no path/); assert.throws(() => publicOrigin('not an address'), /ERP_PUBLIC_URL/);
    assert.equal(effectiveMiniAppUrl({mini_app_url: 'https://saved.example'}, 'default', PUBLIC), PUBLIC + '/c/default/tg/');
    assert.equal(effectiveMiniAppUrl({mini_app_url: 'https://saved.example'}, 'default', ''), 'https://saved.example/c/default/tg/');
  });

  await check('first-run setup is only possible on the computer that runs the ERP, not through the shared address', async () => {
    const form = {staff_id: 'STAFF-003', name: 'Vanna · Director', email: 'vanna@example.test', password: 'vanna-password-1'};
    const remote = await viaTunnel('POST', '/api/auth/setup', {body: form});
    assert.equal(remote.status, 403); assert.match(remote.json.error, /computer that runs the ERP/);
    assert.equal((await viaLocal('POST', '/api/auth/setup', {body: form})).status, 200);
    s.command('admin.user.save', {staff_id: 'STAFF-001', name: 'Dara · Sales', email: 'dara@example.test', role_id: 'ROLE-MEMBER', password: 'dara-password-12', active: 1}, 'STAFF-003');
  });

  await check('the shared address is accepted, other hosts and cross-site posts are refused, and its cookies are Secure', async () => {
    assert.equal((await raw(port, 'GET', '/api/version', {host: 'evil.example'})).status, 403);
    assert.equal((await viaTunnel('GET', '/api/version')).status, 200);
    assert.equal((await viaTunnel('POST', '/api/auth/login', {origin: local, body: {email: 'dara@example.test', password: 'dara-password-12'}})).status, 403, 'origin must match the address used');
    const remote = await viaTunnel('POST', '/api/auth/login', {body: {email: 'dara@example.test', password: 'dara-password-12'}});
    assert.equal(remote.status, 200); assert.match(remote.headers['set-cookie'][0], /; Secure/);
    const cookie = remote.headers['set-cookie'][0].split(';')[0];
    assert.equal((await viaTunnel('GET', '/api/state', {cookie})).json.auth.user.staff_id, 'STAFF-001');
    const home = await viaLocal('POST', '/api/auth/login', {body: {email: 'dara@example.test', password: 'dara-password-12'}});
    assert.equal(home.status, 200); assert.doesNotMatch(home.headers['set-cookie'][0], /Secure/, 'plain http on this computer keeps working');
  });

  await check('sign-in limits count each tester’s own device (CF-Connecting-IP) through the tunnel', async () => {
    const attempt = (ip, password) => viaTunnel('POST', '/api/auth/login', {headers: {'CF-Connecting-IP': ip}, body: {email: 'dara@example.test', password}});
    for (let i = 0; i < 10; i++) assert.equal((await attempt('198.51.100.7', 'wrong-password-1')).status, 401);
    assert.equal((await attempt('198.51.100.7', 'dara-password-12')).status, 429, 'that device waits');
    assert.equal((await attempt('198.51.100.8', 'dara-password-12')).status, 200, 'other devices are not locked out');
  });

  await check('the Mini App is served at the same shared address and uses it as its Telegram link', async () => {
    const page = await viaTunnel('GET', '/c/default/tg/');
    assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /frame-ancestors https:\/\/web\.telegram\.org/);
    assert.equal((await viaTunnel('GET', '/c/default/tg')).status, 308);
    const off = await viaTunnel('GET', '/c/default/tg/api/state'); assert.equal(off.status, 503); assert.equal(off.json.code, 'off');
    s.command('admin.telegram.save', {enabled: true, bot_token: TOKEN, expected_version: s.telegram.settings().version}, 'STAFF-003');
    const noLaunchData = await viaTunnel('GET', '/c/default/tg/api/state'); assert.equal(noLaunchData.status, 401); assert.equal(noLaunchData.json.code, 'auth');
    const admin = (await viaTunnel('POST', '/api/auth/login', {body: {email: 'vanna@example.test', password: 'vanna-password-1'}})).headers['set-cookie'][0].split(';')[0];
    const st = (await viaTunnel('GET', '/api/state', {cookie: admin})).json;
    assert.equal(st.sharing.url, PUBLIC); assert.equal(st.telegram_admin.gateway.shared_url, PUBLIC);
    assert.equal(st.telegram_admin.settings.app_url, PUBLIC + '/c/default/tg/', 'no saved Mini App address is needed while sharing');
    assert.equal(st.telegram.app_url, PUBLIC + '/c/default/tg/');
    const member = (await viaTunnel('POST', '/api/auth/login', {headers: {'CF-Connecting-IP': '198.51.100.9'}, body: {email: 'dara@example.test', password: 'dara-password-12'}})).headers['set-cookie'][0].split(';')[0];
    const mine = (await viaTunnel('GET', '/api/state', {cookie: member})).json;
    assert.equal(mine.sharing, undefined, 'only administrators see the sharing notice'); assert.equal(mine.telegram.app_url, PUBLIC + '/c/default/tg/');
    // Without a shared address the ERP port does not serve the Mini App (it has its own gateway port).
    plain = createLocalServer(s, 0, null, {});
    const plainPort = await listen(plain);
    const notServed = await raw(plainPort, 'GET', '/c/default/tg/api/state', {host: '127.0.0.1:0'});
    assert.equal(notServed.status, 404); assert.doesNotMatch(notServed.text, /Telegram/);
  });

  await check('the sharing launcher picks the right cloudflared download and reads its messages', () => {
    assert.equal(cloudflaredAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe'); assert.equal(cloudflaredAsset('win32', 'arm64'), 'cloudflared-windows-amd64.exe');
    assert.equal(cloudflaredAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz'); assert.equal(cloudflaredAsset('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz');
    assert.equal(cloudflaredAsset('linux', 'x64'), 'cloudflared-linux-amd64'); assert.equal(cloudflaredAsset('linux', 'arm64'), 'cloudflared-linux-arm64'); assert.equal(cloudflaredAsset('aix', 'ppc64'), null);
    assert.equal(readTunnelLine('2026-09-26T03:36:57Z INF |  https://quiet-river-1234.trycloudflare.com                                       |').url, PUBLIC);
    assert.equal(readTunnelLine('2026-09-26T03:36:58Z INF Registered tunnel connection connIndex=0 connection=8f1 event=0 ip=198.41.200.13 location=sin11 protocol=quic').connected, true);
    assert.match(readTunnelLine('quick tunnel provisioning failed with status 403').failed, /status 403/);
    assert.equal(readTunnelLine('2026-09-26T03:36:54Z INF Requesting new quick Tunnel on trycloudflare.com...').url, '', 'the service name alone is not an address');
    const refused = readTunnelLine('2026-09-26T03:36:55Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout');
    assert.equal(refused.url, '', 'Cloudflare’s own API address is not the tunnel'); assert.match(refused.failed, /failed to request quick Tunnel/);
  });
  await check('the sharing launcher runs the ERP inside its own program and stops it cleanly', async () => {
    const probe = http.createServer(), freePort = await listen(probe); await new Promise(r => probe.close(r));
    const dataDir = path.join(folder, 'erp-data'), lines = [];
    const erp = await startERP({port: freePort, telegram: false, publicUrl: PUBLIC, dataDir, publicDir: pub, log: m => lines.push(m), warn: m => lines.push(m)});
    assert.match(lines.join('\n'), /Shared for testing at https:\/\/quiet-river-1234\.trycloudflare\.com/);
    assert.equal((await raw(freePort, 'GET', '/api/version', {host: HOST})).status, 200);
    const again = await startERP({port: freePort, telegram: false, dataDir: path.join(folder, 'erp-data-2'), publicDir: pub, log: () => {}, warn: () => {}}).catch(e => e);
    assert.ok(again instanceof Error); assert.match(again.message, /already in use/);
    await erp.stop(); await erp.stop();
    await assert.rejects(raw(freePort, 'GET', '/api/version'), /ECONNREFUSED/);
    assert.match((await startERP({port: freePort, publicUrl: 'http://not-https.example', telegram: false, dataDir, publicDir: pub, log: () => {}}).catch(e => e)).message, /https/);
  });
  console.log(`\n${checks} sharing-for-testing checks passed. No tunnel or Telegram servers were contacted.`);
} finally {
  if (shared?.listening) await new Promise(r => shared.close(r));
  if (plain?.listening) await new Promise(r => plain.close(r));
  s.db.close(); rmSync(folder, {recursive: true, force: true});
}

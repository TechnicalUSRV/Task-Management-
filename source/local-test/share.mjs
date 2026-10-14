// Share this Task Controlling Management for testing with people on other computers and phones, including the Telegram Mini App.
// It starts a free temporary Cloudflare address (a "quick tunnel", no account needed) that forwards to this
// computer, then starts the Task Controlling Management in this same program with that public address. Close the window to stop sharing.
import {spawn, spawnSync} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_VERSION, DEFAULT_PORT, DEFAULT_TELEGRAM_PORT} from './version.mjs';
import {startERP} from './server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// A quick tunnel address such as https://quiet-river-1234.trycloudflare.com (not Cloudflare's own api. or www. hosts).
export const TUNNEL_URL = /https:\/\/(?!api\.|www\.)[a-z0-9-]+\.trycloudflare\.com/i;
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

// The official cloudflared download for this computer (github.com/cloudflare/cloudflared releases).
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') return {x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386'}[arch] || null;
  return null;
}
// Reads cloudflared's log output: the address line, a registered connection, or a reason it failed.
export function readTunnelLine(line) {
  const url = /failed|error/i.test(line) ? '' : TUNNEL_URL.exec(line)?.[0] || '';
  return {url, connected: /Registered tunnel connection/i.test(line), failed: /failed|error|ERR /.test(line) && !url ? line.replace(/^\S+\s+(ERR|WRN|INF)\s+/, '').trim() : ''};
}

const works = cmd => {
  try { const r = spawnSync(cmd, ['--version'], {encoding: 'utf8', timeout: 20000, windowsHide: true}); return r.status === 0 && /cloudflared version/i.test(`${r.stdout}${r.stderr}`); }
  catch { return false; }
};
async function findCloudflared() {
  const local = path.join(root, 'tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (process.env.CLOUDFLARED && works(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
  if (works('cloudflared')) return 'cloudflared';
  if (existsSync(local) && works(local)) return local;
  const asset = cloudflaredAsset();
  if (!asset) throw new Error(`There is no ready-made cloudflared for ${process.platform}/${process.arch}. Install cloudflared yourself, then run this again.`);
  const url = RELEASES + asset, tmp = local + '.download';
  console.log(`Cloudflare's tunnel program (cloudflared) is not installed yet.\nDownloading it once (about 40–60 MB) from:\n  ${url}\ninto the tools folder next to the Task Controlling Management…`);
  mkdirSync(path.dirname(local), {recursive: true});
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length') || 0); let got = 0, shown = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => { got += chunk.length; const pct = total ? Math.floor(got * 100 / total) : 0; if (pct >= shown + 10) { shown = pct; process.stdout.write(`  ${pct}%${pct >= 100 ? '\n' : '\r'}`); } });
  await pipeline(body, createWriteStream(tmp));
  if (asset.endsWith('.tgz')) {
    const r = spawnSync('tar', ['-xzf', tmp, '-C', path.dirname(local)]); rmSync(tmp, {force: true});
    if (r.status !== 0) throw new Error('The cloudflared download could not be unpacked.');
  } else renameSync(tmp, local);
  if (process.platform !== 'win32') chmodSync(local, 0o755);
  if (!works(local)) throw new Error('The downloaded cloudflared does not run on this computer.');
  console.log('cloudflared is ready.\n');
  return local;
}

// Security software can refuse to let a program start another one (Windows reports EPERM or EACCES).
const blockedMessage = (what, e) => `Windows did not allow ${what} to start (${e.code}). Antivirus or company security settings may be blocking it.`;
function startTunnel(bin, port) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true}); }
    catch (e) { return reject(Object.assign(new Error(['EPERM', 'EACCES'].includes(e.code) ? blockedMessage('cloudflared', e) : `cloudflared could not start: ${e.message}`), {blocked: ['EPERM', 'EACCES'].includes(e.code)})); }
    const recent = [], state = {url: '', connected: false, reason: ''};
    const timer = setTimeout(() => done(new Error('Cloudflare did not create an address within 90 seconds.')), 90000);
    const done = error => { clearTimeout(timer); if (error) { child.kill(); reject(Object.assign(error, {log: recent.join('\n'), reason: state.reason})); } else resolve({child, state}); };
    for (const stream of [child.stdout, child.stderr]) createInterface({input: stream}).on('line', line => {
      recent.push(line); if (recent.length > 30) recent.shift();
      const r = readTunnelLine(line);
      if (r.failed && !state.reason) state.reason = r.failed;
      if (r.connected) state.connected = true;
      if (r.url && !state.url) { state.url = r.url; done(); }
    });
    child.on('error', e => done(Object.assign(new Error(['EPERM', 'EACCES'].includes(e.code) ? blockedMessage('cloudflared', e) : `cloudflared could not start: ${e.message}`), {blocked: ['EPERM', 'EACCES'].includes(e.code)})));
    child.on('exit', code => { if (!state.url) done(new Error(`cloudflared stopped (exit code ${code}) before an address was created.`)); });
  });
}

let stopping = false;
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end && !stopping) { try { if (await check()) return true; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 500)); } return false; };
const line = '─'.repeat(78);

let tunnelChild = null;
async function main() {
  const port = Number(process.env.ERP_LOCAL_PORT || DEFAULT_PORT), local = `http://127.0.0.1:${port}`, telegram = process.env.ERP_TELEGRAM !== 'off';
  console.log(`\n${APP_VERSION} · share for testing\n`);
  if (await waitFor(async () => (await fetch(local + '/api/version')).ok, 1000)) {
    console.log(`Another copy of the Task Controlling Management is already running on ${local}. Close it first (its window, or Ctrl+C), then start sharing again.`);
    process.exitCode = 1; return;
  }
  let bin;
  try { bin = await findCloudflared(); }
  catch (e) {
    console.log(`\n${e.message}\nYou can also install cloudflared yourself and run this again:\n  Windows: winget install --id Cloudflare.cloudflared\n  Mac:     brew install cloudflared\n  Other:   https://github.com/cloudflare/cloudflared/releases`);
    process.exitCode = 1; return;
  }
  console.log('Creating a temporary public address with Cloudflare…');
  let tunnel;
  try { tunnel = await startTunnel(bin, port); }
  catch (e) {
    console.log(e.blocked
      ? `\n${e.message}\nAllow ${bin} in your antivirus (or ask your IT team), or install cloudflared with: winget install --id Cloudflare.cloudflared\nthen start sharing again.`
      : `\n${e.message}${e.reason ? `\nCloudflare said: ${e.reason}` : ''}\n\nCheck this computer's internet connection and try again. If you use cloudflared for other tunnels, rename the file\n.cloudflared/config.yml (or config.yaml) in your user folder while sharing: quick tunnels do not start when it exists.${e.log ? `\n\nLast cloudflared messages:\n${e.log}` : ''}`);
    process.exitCode = 1; return;
  }
  tunnelChild = tunnel.child;
  const url = tunnel.state.url;
  // The Task Controlling Management runs inside this program (no second program is started), with the tunnel's address as its public address.
  let erp;
  try { erp = await startERP({port, telegramPort: Number(process.env.ERP_TELEGRAM_PORT || DEFAULT_TELEGRAM_PORT), telegram, publicUrl: url, open: true}); }
  catch (e) { tunnel.child.kill(); console.log(`\n${e.message}\nSharing did not start.`); process.exitCode = 1; return; }
  const stop = async (code, message) => {
    if (stopping) return; stopping = true;
    if (message) console.log(message);
    setTimeout(() => process.exit(code), 5000).unref();
    tunnel.child.kill();
    await erp.stop().catch(() => {});
    process.exit(code);
  };
  tunnel.child.on('exit', () => void stop(1, '\nThe Cloudflare address closed, so sharing has stopped. Start sharing again for a new address.'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void stop(0, '\nSharing stopped. The shared address no longer works.'));
  const row = (label, value) => `  ${label.padEnd(43)}${value}\n`;
  console.log(`${line}
  Sharing for testing is ON

${row('For people on other computers and phones:', url)}${telegram ? row('Telegram Mini App (set automatically):', `${url}/c/default/tg/`) : ''}${row('On this computer:', local)}
  Testers sign in with the logins you create in Administration → User accounts.${telegram ? '\n  In Telegram, testers open the company bot and tap its Tasks button.' : ''}
  Anyone who has the address can reach the sign-in page: use test data and
  test passwords, send the address privately, and close this window (or press
  Ctrl+C) when the test is finished. The address changes every time you share.
  If it does not open straight away, wait a minute and try again.
${line}`);
  // Confirm the address works end to end (after a pause, so the new name has time to reach DNS).
  await new Promise(r => setTimeout(r, 10000));
  if (stopping) return;
  const reachable = await waitFor(async () => (await fetch(url + '/api/version', {signal: AbortSignal.timeout(8000)})).ok, 60000);
  if (!stopping) console.log(reachable ? `\n✓ ${url} is reachable from the internet.` : `\n! ${url} could not be reached from this computer yet. It usually works within a minute; testers can try it on their own devices.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { tunnelChild?.kill(); console.error(`\nSharing stopped because of an unexpected error: ${e.message}`); process.exitCode = 1; });
}

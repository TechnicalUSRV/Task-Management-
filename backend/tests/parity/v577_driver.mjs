// Runs one parity scenario against the original V5.7.7 Node/SQLite service and prints what happened as JSON.
// The Django side (tests/parity/driver.py) runs the same scenario; tests/test_parity.py compares the two outputs.
//
//   node v577_driver.mjs <source/local-test folder> < scenario.json
//
// A scenario is {"steps": [...]}; each step is one of
//   {"bootstrap": {...}}                                   first administrator (access.bootstrap)
//   {"as": "<staff>", "do": "<action>", "data": {...}, "source": "WEB"}   authorize + command, as the server does
//   {"reminders": "<ISO instant>"}                         deadline reminders at that moment
// Strings may contain placeholders (see resolve()); dump.json lists what is compared afterwards.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const source = path.resolve(process.argv[2] || '../../../source/local-test');
const {openStore} = await import(pathToFileURL(path.join(source, 'service.mjs')).href);
const {taskToday, addDays, buildTaskReport} = await import(pathToFileURL(path.join(source, 'task-domain.mjs')).href);
const {buildDashboard} = await import(pathToFileURL(path.join(source, 'dashboard.mjs')).href);
const {buildERPReport, reportOptions, sourceRecords} = await import(pathToFileURL(path.join(source, 'erp-sources.mjs')).href);
const {miniState} = await import(pathToFileURL(path.join(source, 'telegram-gateway.mjs')).href);
const {createBot} = await import(pathToFileURL(path.join(source, 'telegram-bot.mjs')).href);
const spec = JSON.parse(readFileSync(new URL('./dump.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(readFileSync(0, 'utf8'));
const s = openStore(':memory:');

// This deployment runs Task Management only (Stage 1 decision A): the same modules as the Django defaults.
const MODULES = {dashboard: 1, crm: 0, tasks: 1, ops: 0, finance: 0, reports: 1, admin: 1, system: 1};
for (const [module, enabled] of Object.entries(MODULES)) s.run('UPDATE erp_module_settings SET enabled=? WHERE module_id=?', enabled, module);

const results = [];

// The Telegram Bot API is replaced by a recorder: every call the bot makes is kept (in order) as the step's result.
// {"telegram_bot": "<token>"} starts the bot, {"tg": <update>} hands it one update, {"tg_flush": {}} delivers
// notifications ({"digest": true} also sends the morning summary now), {"tg_fail": {"method", "code", "description"}}
// makes the next call of that method fail.
const APP = 'https://tasks.example.test/tg/';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
let bot = null, calls = [], failNext = {}, messageId = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  // Files whose id starts with IMG download as a 1×1 PNG; anything else as a few bytes of text.
  if (url.includes('/file/bot')) {
    const id = url.split('/').pop();
    return new Response(id.startsWith('IMG') ? Buffer.from(PNG, 'base64') : Buffer.from('file:' + id));
  }
  const method = /\/bot[^/]+\/(\w+)$/.exec(url)?.[1] || '?';
  let params;
  if (options.body instanceof FormData) {
    params = {};
    for (const [k, v] of options.body.entries()) params[k] = typeof v === 'string' ? v : {name: v.name, type: v.type, size: v.size};
  } else params = JSON.parse(options.body || '{}');
  if (method === 'getUpdates') return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('stopped'))));
  if (method !== 'getMe') calls.push({method, params});
  const fail = failNext[method];
  if (fail) { delete failNext[method]; return Response.json({ok: false, error_code: fail.code, description: fail.description, parameters: fail.parameters}); }
  const result = method === 'getMe' ? {id: 999, is_bot: true, first_name: 'Sunny', username: 'sunny_test_bot'}
    : ['sendMessage', 'sendDocument'].includes(method) ? {message_id: ++messageId, chat: {id: Number(params.chat_id)}}
    : method === 'getFile' ? {file_id: params.file_id, file_unique_id: 'u', file_size: 12, file_path: 'documents/' + params.file_id} : true;
  return Response.json({ok: true, result});
};
const phnomPenhHour = () => Number(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Phnom_Penh', hour: '2-digit', hourCycle: 'h23'}).format(new Date()));
const VERSIONED = new Set(['tm_tasks', 'tm_workspaces', 'tm_requests', 'tm_due_requests', 'tm_change_requests', 'tm_timesheets', 'tm_meetings', 'tm_meeting_changes', 'access_users', 'tm_calendar_notes']);
function lookup(kind, args) {
  if (kind === 'today') return args[0] ? addDays(taskToday(), Number(args[0])) : taskToday();
  if (kind === 'version') {
    if (args[0] === 'tm_profiles') return s.get('SELECT version FROM tm_profiles WHERE staff_id=?', args[1])?.version ?? null;
    if (!VERSIONED.has(args[0])) throw new Error('version of ' + args[0]);
    return s.get(`SELECT version FROM ${args[0]} WHERE id=?`, args[1])?.version ?? null;
  }
  if (kind === 'approver') return s.get('SELECT approver_id FROM tm_change_requests WHERE id=?', args[0])?.approver_id ?? null;
  if (kind === 'staff') return s.get("SELECT id FROM lookups WHERE kind='staff' AND name=?", args[0])?.id ?? null;
  if (kind === 'user') return s.get('SELECT id FROM access_users WHERE username=?', args[0])?.id ?? null;
  if (kind === 'notification') return s.get('SELECT id FROM tm_notifications WHERE kind=? AND staff_id=? ORDER BY id DESC LIMIT 1', args[0], args[1])?.id ?? null;
  if (kind === 'file') return s.get('SELECT id FROM tm_files WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1', args[0])?.id ?? null;
  if (kind === 'step') return s.get('SELECT id FROM tm_checklist WHERE position=? AND task_id=?', Number(args[0]), args[1])?.id ?? null;
  if (kind === 'next') return s.get('SELECT next_task_id FROM tm_tasks WHERE id=?', args[0])?.next_task_id ?? null;
  if (kind === 'due') return s.get("SELECT id FROM tm_due_requests WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1", args[0])?.id ?? null;
  if (kind === 'mchange') return s.get("SELECT id FROM tm_meeting_changes WHERE meeting_id=? ORDER BY created_at DESC,id DESC LIMIT 1", args[0])?.id ?? null;
  if (kind === 'sent') return messageId;
  if (kind === 'card') return s.get('SELECT message_id FROM tg_sessions WHERE tg_user_id=?', Number(args[0]))?.message_id ?? null;
  if (kind === 'task') return s.get('SELECT id FROM tm_tasks WHERE title=? ORDER BY id DESC LIMIT 1', args[0])?.id ?? null;
  if (kind === 'request') return s.get('SELECT id FROM tm_requests WHERE title=? ORDER BY id DESC LIMIT 1', args[0])?.id ?? null;
  if (kind === 'month') return taskToday().slice(0, 7);
  if (kind === 'change') return s.get("SELECT id FROM tm_change_requests WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1", args[0])?.id ?? null;
  throw new Error('Unknown placeholder ' + kind);
}
// ${N.path}: a field of step N's result. ${kind:arg:arg}: a lookup. A string that is only a placeholder becomes its value.
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  if (typeof value !== 'string' || !value.includes('${')) return value;
  // An argument starting with @ is itself an expression and takes the rest of the text (so it comes last).
  const one = inner => {
    const m = /^(\d+)\.(.+)$/.exec(inner);
    if (m) return m[2].split('.').reduce((o, k) => (o == null ? o : o[k]), results[Number(m[1])]?.result);
    const parts = inner.split(':'), kind = parts.shift(), args = [];
    while (parts.length) {
      const a = parts.shift();
      if (a.startsWith('@')) { args.push(one([a.slice(1), ...parts].join(':'))); break; }
      args.push(a);
    }
    return lookup(kind, args);
  };
  const whole = /^\$\{([^}]*)\}$/.exec(value);
  if (whole) return one(whole[1]);
  return value.replace(/\$\{([^}]*)\}/g, (_, x) => String(one(x)));
}

for (const step of scenario.steps) {
  try {
    if (step.telegram_bot) {
      s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1', step.telegram_bot);
      calls = [];
      bot = createBot({store: s, token: step.telegram_bot, outboxMs: 2e9, pollTimeout: 25, appUrl: () => APP, logger: {error() {}}});
      for (let i = 0; i < 400 && s.get('SELECT status FROM tg_settings WHERE id=1').status !== 'ONLINE'; i++) await sleep(5);
      await sleep(5);
      results.push({ok: true, result: calls});
    }
    else if (step.tg_fail) { failNext[step.tg_fail.method] = step.tg_fail; results.push({ok: true, result: null}); }
    else if (step.tg) { calls = []; await bot.handleUpdate(resolve(step.tg)); results.push({ok: true, result: calls}); }
    else if (step.tg_flush) {
      if (step.tg_flush.digest) s.run("UPDATE tg_settings SET digest_hour=?,last_digest_date='' WHERE id=1", phnomPenhHour());
      calls = []; await bot.flush(); results.push({ok: true, result: calls});
    }
    else if (step.bootstrap) results.push({ok: true, result: s.access.bootstrap(resolve(step.bootstrap))});
    else if (step.reminders) results.push({ok: true, result: s.reminders(new Date(resolve(step.reminders)))});
    else if (step.event_reminders) results.push({ok: true, result: s.eventReminders(new Date(resolve(step.event_reminders)))});
    else if (step.read) {
      // What a signed-in person reads: the state, a task report, the dashboard, custom reports or the Mini App state.
      const account = s.access.accountFor(resolve(step.as)), user = account ? s.access.publicUser(account.id) : null, input = resolve(step.input || {});
      if (!user) throw Object.assign(new Error('Sign in to continue.'), {status: 401});
      const read = {state: () => s.access.filterState(s.state(), user), report: () => buildTaskReport(s.scopedState(user), input),
        dashboard: () => buildDashboard(s, user, input), erp: () => buildERPReport(s, user, input, !!step.exporting),
        options: () => reportOptions(s, user), source: () => sourceRecords(s, user, input), mini: () => miniState(s, user, '')}[step.read];
      results.push({ok: true, result: JSON.parse(JSON.stringify(read()))});
    }
    else {
      const actor = resolve(step.as), data = resolve(step.data || {});
      const account = s.access.accountFor(actor), user = account ? s.access.publicUser(account.id) : undefined;
      s.access.authorize(user, step.do, data);
      results.push({ok: true, result: s.command(step.do, data, actor, step.source ? {source: step.source} : {})});
    }
  } catch (e) {
    results.push({ok: false, status: e.status || 500, message: e.message});
  }
}

const mask = (row, cols) => Object.fromEntries(cols.map(c => [c, spec.masked.some(m => c.endsWith(m)) ? (row[c] == null ? null : '<t>') : row[c] ?? null]));
const dump = {};
for (const [table, t] of Object.entries(spec.tables)) {
  const from = t.node_from || table;
  dump[table] = s.all(`SELECT ${t.cols.map(c => (t.node_cols?.[c] ? `${t.node_cols[c]} AS ${c}` : c)).join(',')} FROM ${from}${t.node_where ? ' WHERE ' + t.node_where : ''} ORDER BY ${t.order}`)
    .map(r => mask(r, t.cols));
}
// The bot's long poll never ends by itself, so the process exits once the output is written.
process.stdout.write(JSON.stringify({steps: results, dump}), () => process.exit(0));

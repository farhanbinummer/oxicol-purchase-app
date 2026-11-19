// TaskFlow summary tests. No database and no network: Firebase is replaced by a fake fetch.
//   node --test tests/taskflow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../taskflow');
const { KEYS, CATALOG, DEFAULTS } = require('../permissions');
const { STEPS } = require('../migrate');
const { WORKSPACES, navFor } = require('../workspaces');

const FULL = { TASKFLOW_FIREBASE_API_KEY: 'AIza-test-key', TASKFLOW_DATABASE_URL: 'https://demo-default-rtdb.firebaseio.com/', TASKFLOW_READER_EMAIL: 'reader@example.test', TASKFLOW_READER_PASSWORD: 'pw-SECRET-123' };
const NOW = Date.parse('2026-11-18T10:00:00Z');                  // 15:30 on 18 Nov 2026 in India
const TODAY = '2026-11-18';
const task = (o) => ({ text: 'x', done: false, recur: 'none', due: '', assignedTo: 'm1', assignedToName: 'Asha', ...o });

test.beforeEach(() => T.reset());

// ------------------------------------------------------------------ counting
test('counting: overdue means not done, not repeating, due before today', () => {
  const r = T.summarize({
    a: task({ due: '2026-11-17' }),                           // overdue
    b: task({ due: '2026-11-18' }),                           // due today, not overdue
    c: task({ due: '2026-11-19' }),                           // later
    d: task({ due: '2026-11-01', done: true, completedAt: '2026-11-02' }),   // done: not overdue
    e: task({ due: '2026-11-01', recur: 'daily' }),           // repeating: never overdue
    f: task({ due: '' }),                                     // no date
  }, TODAY);
  assert.equal(r.overdue, 1);
  assert.equal(r.due_today, 1);
  assert.equal(r.open, 5, 'every task that is not done, repeating ones included');
});
test('counting: a repeating task is never overdue and never "due today"', () => {
  for (const recur of ['daily', 'weekly', 'weekdays', 'monthly', 'custom_days']) {
    const r = T.summarize([task({ recur, due: TODAY }), task({ recur, due: '2020-01-01' })], TODAY);
    assert.equal(r.overdue, 0, recur); assert.equal(r.due_today, 0, recur); assert.equal(r.open, 2, recur);
  }
  assert.equal(T.summarize([task({ recur: 'none', due: '2020-01-01' }), task({ recur: undefined, due: '2020-01-01' })], TODAY).overdue, 2, 'recur "none" or missing is a normal task');
});
test('counting: done in the last 7 days = today and the six days before', () => {
  const done = (d, key) => task({ done: true, [key || 'completedAt']: d });
  const r = T.summarize([done('2026-11-18'), done('2026-11-12'), done('2026-11-11'), done('2026-11-19'), done('', 'completedAt'), done('2026-11-15', 'lastDone'), task({ done: true, completedAt: '', lastDone: '2026-11-14' })], TODAY);
  assert.equal(r.done_7d, 4, 'today, 12 Nov (6 days back), the lastDone fallbacks; not 11 Nov, not the future, not undated');
});
test('counting: empty, null and odd data never throw and are never counted', () => {
  const zero = { overdue: 0, open: 0, due_today: 0, done_7d: 0, top_overdue: [] };
  for (const v of [null, undefined, {}, [], 'text', 5]) assert.deepEqual(T.summarize(v, TODAY), zero);
  const r = T.summarize({ a: null, b: 7, c: 'str', d: [], e: task({ due: 'tomorrow' }), f: task({ due: '2026-02-30' }), g: task({ due: 20261117 }), h: task({ done: 'yes', completedAt: 'today' }) }, TODAY);
  assert.equal(r.overdue, 0, 'bad dates are never overdue');
  assert.equal(r.open, 3);
  assert.equal(T.summarize([task({ due: '2026-11-17' }), null], TODAY).overdue, 1, 'an array of tasks works too');
});
test('counting: the people with the most overdue tasks, most first, at most three', () => {
  const t = (n, id, c) => Array.from({ length: c }, () => task({ due: '2026-11-01', assignedTo: id, assignedToName: n }));
  const r = T.summarize([...t('Asha', 'a', 3), ...t('Ben', 'b', 5), ...t('Cara', 'c', 1), ...t('Dev', 'd', 2), task({ due: '2026-11-01', assignedTo: '', assignedToName: '' })], TODAY);
  assert.deepEqual(r.top_overdue, [{ name: 'Ben', count: 5 }, { name: 'Asha', count: 3 }, { name: 'Dev', count: 2 }]);
  assert.equal(r.overdue, 12);
  const same = T.summarize([task({ due: '2026-11-01', assignedTo: 'x', assignedToName: 'Zed' }), task({ due: '2026-11-01', assignedTo: 'y', assignedToName: 'Amy' })], TODAY);
  assert.deepEqual(same.top_overdue.map(p => p.name), ['Amy', 'Zed'], 'ties are listed alphabetically');
  assert.equal(T.summarize([task({ due: '2026-11-01', assignedTo: '', assignedToName: '' })], TODAY).top_overdue[0].name, 'Not assigned');
});
test('counting: no task text, description or chat ever appears in the result', () => {
  const secret = 'CONFIDENTIAL-FORMULA-9917';
  const r = T.summarize({ a: task({ due: '2026-11-01', text: secret, desc: secret, notes: secret, chat: { m1: { text: secret } }, subtasks: [{ text: secret }], tags: [secret], createdByName: secret, assignedToName: 'Asha' }), b: task({ done: true, completedAt: TODAY, text: secret }) }, TODAY);
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.deepEqual(Object.keys(r).sort(), ['done_7d', 'due_today', 'open', 'overdue', 'top_overdue']);
});

// ------------------------------------------------------------------ India time
test('dates: the business day is India time, not UTC', async () => {
  const calls = [];
  const mk = (nowMs) => async (url, init) => { calls.push(url); return url.includes('signInWithPassword') ? { status: 200, json: async () => ({ idToken: 't', expiresIn: '3600' }) } : { status: 200, json: async () => ({ a: task({ due: '2026-11-18' }), b: task({ due: '2026-11-17' }) }) }; };
  // 20:00 UTC on 17 Nov is already 01:30 on 18 Nov in India: "today" is the 18th, so the 17th is overdue
  const late = await T.getSummary({ env: FULL, fetch: mk(), now: () => Date.parse('2026-11-17T20:00:00Z') });
  assert.equal(late.as_of, '2026-11-18'); assert.equal(late.overdue, 1); assert.equal(late.due_today, 1);
  T.reset();
  // 18:29 UTC is 23:59 in India on the same day; 18:30 UTC is already the next India day
  assert.equal((await T.getSummary({ env: FULL, fetch: mk(), now: () => Date.parse('2026-11-18T18:29:00Z') })).as_of, '2026-11-18');
  T.reset();
  const next = await T.getSummary({ env: FULL, fetch: mk(), now: () => Date.parse('2026-11-18T18:30:00Z') });
  assert.equal(next.as_of, '2026-11-19'); assert.equal(next.overdue, 2, 'both are now before today');
});

// ------------------------------------------------------------------ switched on or off
test('settings: the feature is off unless all four are present, and the database address is https', () => {
  assert.ok(T.config(FULL)); assert.equal(T.enabled(FULL), true);
  for (const k of Object.keys(FULL)) { const e = { ...FULL, [k]: '' }; assert.equal(T.config(e), null, k + ' empty'); const g = { ...FULL }; delete g[k]; assert.equal(T.config(g), null, k + ' missing'); assert.equal(T.enabled(g), false); }
  assert.equal(T.config({ ...FULL, TASKFLOW_READER_EMAIL: '   ' }), null);
  assert.equal(T.config({}), null);
  for (const bad of ['http://demo-default-rtdb.firebaseio.com', 'ftp://x.test', 'demo-default-rtdb.firebaseio.com', 'not a url', 'https://user:pw@demo.firebaseio.com', 'javascript:alert(1)']) assert.equal(T.config({ ...FULL, TASKFLOW_DATABASE_URL: bad }), null, bad);
  assert.equal(T.config(FULL).dbUrl, 'https://demo-default-rtdb.firebaseio.com', 'trailing slash and path are dropped');
});
test('settings: when off, nothing is fetched and the summary is null', async () => {
  let n = 0; assert.equal(await T.getSummary({ env: {}, fetch: async () => { n++; } }), null); assert.equal(n, 0);
});
test('link: TASK_APP_URL defaults, can be hidden, and must be https', () => {
  assert.equal(T.appUrl({}), 'https://steady-frangollo-e2886d.netlify.app/');
  assert.equal(T.appUrl({ TASK_APP_URL: '' }), null);
  assert.equal(T.appUrl({ TASK_APP_URL: '  ' }), null);
  assert.equal(T.appUrl({ TASK_APP_URL: 'https://tasks.example.test/app' }), 'https://tasks.example.test/app');
  for (const bad of ['http://tasks.example.test', 'javascript:alert(1)', 'tasks.example.test', 'https://a:b@tasks.example.test']) assert.equal(T.appUrl({ TASK_APP_URL: bad }), null, bad);
});

// ------------------------------------------------------------------ reading
const fake = (opts = {}) => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (String(url).includes('identitytoolkit')) return opts.signIn ? opts.signIn() : { status: 200, json: async () => ({ idToken: 'TOKEN-ABC', expiresIn: '3600' }) };
    return opts.read ? opts.read() : { status: 200, json: async () => ({ a: task({ due: '2026-11-10' }), b: task({ due: TODAY }) }) };
  };
  f.calls = calls; return f;
};
test('reading: signs in once, reads taskflow/tasks with GET only, and caches for a minute', async () => {
  const f = fake(); let now = NOW; const deps = { env: FULL, fetch: f, now: () => now };
  const a = await T.getSummary(deps);
  assert.equal(a.ok, true); assert.equal(a.overdue, 1); assert.equal(a.due_today, 1);
  assert.equal(f.calls.length, 2, 'one sign-in, one read');
  const sign = f.calls[0], read = f.calls[1];
  assert.equal(sign.method, 'POST'); assert.ok(sign.url.startsWith('https://identitytoolkit.googleapis.com/'));
  assert.equal(read.method, 'GET'); assert.ok(read.url.startsWith('https://demo-default-rtdb.firebaseio.com/taskflow/tasks.json?auth='));
  assert.ok(f.calls.filter(c => !c.url.includes('identitytoolkit')).every(c => c.method === 'GET'), 'only GET requests reach the database');
  assert.equal(new URL(read.url).pathname, '/taskflow/tasks.json', 'only taskflow/tasks is read, nothing else in the database');
  now += 30000; const b = await T.getSummary(deps);
  assert.equal(f.calls.length, 2, 'served from cache inside a minute'); assert.deepEqual(b, a);
  now += 31000; await T.getSummary(deps);
  assert.equal(f.calls.length, 3, 'after a minute it reads again, reusing the sign-in (no second sign-in)'); assert.equal(f.calls[2].method, 'GET');
});
test('reading: simultaneous callers share one read', async () => {
  const f = fake(); const deps = { env: FULL, fetch: f, now: () => NOW };
  const rs = await Promise.all([T.getSummary(deps), T.getSummary(deps), T.getSummary(deps)]);
  assert.equal(f.calls.length, 2); assert.ok(rs.every(r => r === rs[0]));
});
test('reading: nothing is ever written, and the password only goes to the sign-in endpoint', async () => {
  const f = fake(); await T.getSummary({ env: FULL, fetch: f, now: () => NOW });
  const toDb = f.calls.filter(c => !c.url.includes('identitytoolkit'));
  assert.ok(toDb.length && toDb.every(c => c.method === 'GET' && !c.body));
  assert.ok(!toDb.some(c => c.url.includes('pw-SECRET-123') || (c.body || '').includes('pw-SECRET-123')));
  assert.ok(f.calls[0].body.includes('pw-SECRET-123') && f.calls[0].body.includes('returnSecureToken'));
});
test('reading: an unreachable, slow or refusing TaskFlow gives "not ok" and never throws or leaks secrets', async () => {
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const cases = {
      'network down': { signIn: async () => { throw new TypeError('fetch failed https://x?key=AIza-test-key'); } },
      'sign-in refused': { signIn: () => ({ status: 400, json: async () => ({ error: { message: 'INVALID_PASSWORD' } }) }) },
      'sign-in without a token': { signIn: () => ({ status: 200, json: async () => ({}) }) },
      'read refused': { read: () => ({ status: 401, json: async () => ({ error: 'Permission denied' }) }) },
      'read error': { read: () => ({ status: 503, json: async () => null }) },
      'read throws': { read: async () => { throw new Error('socket hang up TOKEN-ABC'); } },
      'bad body': { read: () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } }) }
    };
    for (const [name, opts] of Object.entries(cases)) {
      T.reset(); const r = await T.getSummary({ env: FULL, fetch: fake(opts), now: () => NOW });
      if (name === 'bad body') { assert.equal(r.ok, true, 'an unreadable body counts as no tasks, not a crash'); continue; }
      assert.deepEqual(r, { ok: false, error: 'unreachable' }, name);
    }
  } finally { console.error = orig; }
  const all = logged.join('\n');
  for (const s of ['pw-SECRET-123', 'TOKEN-ABC', 'AIza-test-key', 'reader@example.test']) assert.ok(!all.includes(s), 'log never contains ' + s);
});
test('reading: a request that hangs is given up on after about five seconds', async () => {
  const hang = async (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now(); const r = await T.getSummary({ env: FULL, fetch: hang, now: () => NOW });
  const took = Date.now() - t0;
  assert.equal(r.ok, false); assert.ok(took >= 4500 && took < 7000, 'took ' + took + ' ms');
});
test('reading: a failure is remembered briefly so the dashboard is not made to wait again, then retried', async () => {
  let up = false; let now = NOW; const f = fake({ signIn: () => up ? { status: 200, json: async () => ({ idToken: 't', expiresIn: '3600' }) } : { status: 500, json: async () => null } });
  const deps = { env: FULL, fetch: f, now: () => now };
  assert.equal((await T.getSummary(deps)).ok, false); const n = f.calls.length;
  assert.equal((await T.getSummary(deps)).ok, false); assert.equal(f.calls.length, n, 'no new attempt straight away');
  up = true; now += 21000; assert.equal((await T.getSummary(deps)).ok, true, 'retried after a few seconds');
});
test('reading: when the token is refused the next read signs in again', async () => {
  let status = 401; const f = fake({ read: () => ({ status, json: async () => ({}) }) }); let now = NOW; const deps = { env: FULL, fetch: f, now: () => now };
  assert.equal((await T.getSummary(deps)).ok, false);
  status = 200; now += 21000; assert.equal((await T.getSummary(deps)).ok, true);
  assert.equal(f.calls.filter(c => c.url.includes('identitytoolkit')).length, 2);
});

// ------------------------------------------------------------------ permission and link
test('permission: tasks.summary_view is registered and granted to the Manager only', () => {
  assert.equal(KEYS.TASKS_SUMMARY_VIEW, 'tasks.summary_view');
  const c = CATALOG.find(x => x.key === 'tasks.summary_view'); assert.ok(c); assert.equal(c.kind, 'view'); assert.ok(c.module && c.action);
  const holders = Object.entries(DEFAULTS).filter(([, keys]) => keys.includes('tasks.summary_view')).map(([r]) => r);
  assert.deepEqual(holders, ['manager'], 'not R&D, not Branch, not anyone else');
  for (const r of ['rd', 'branch', 'rd_trainee', 'qc', 'purchase', 'store', 'accounts', 'production']) assert.ok(!(DEFAULTS[r] || []).includes('tasks.summary_view'), r);
});
test('permission: a new migration (never an edited old one) seeds it for existing databases', async () => {
  const step = STEPS[STEPS.length - 1]; assert.equal(step.name, '028_tasks_summary_permission');
  assert.equal(new Set(STEPS.map(s => s.name)).size, STEPS.length, 'migration names are unique');
  const sql = []; await step.run({ query: async (q) => { sql.push(q); return { rows: [] }; } });
  assert.equal(sql.length, 1); assert.match(sql[0], /INSERT INTO role_permissions/); assert.match(sql[0], /'manager'/); assert.match(sql[0], /tasks\.summary_view/); assert.match(sql[0], /ON CONFLICT DO NOTHING/);
  assert.ok(!/rd|branch|qc/i.test(sql[0].replace(/role_permissions/, '')), 'only the manager');
});
test('link: every workspace gets a "Tasks" entry that opens the task app, unless TASK_APP_URL is empty', () => {
  const had = process.env.TASK_APP_URL; const access = { roles: [], isAdmin: true, grants: new Set() };
  try {
    delete process.env.TASK_APP_URL;
    for (const id of Object.keys(WORKSPACES)) {
      const items = navFor(id, access).flatMap(g => g.items), tasks = items.filter(i => i.label === 'Tasks');
      assert.equal(tasks.length, 1, id); assert.equal(tasks[0].href, T.DEFAULT_APP_URL); assert.equal(tasks[0].external, true);
    }
    process.env.TASK_APP_URL = 'https://tasks.example.test/';
    assert.equal(navFor('purchase', access).flatMap(g => g.items).find(i => i.label === 'Tasks').href, 'https://tasks.example.test/');
    process.env.TASK_APP_URL = '';
    for (const id of Object.keys(WORKSPACES)) assert.ok(!navFor(id, access).flatMap(g => g.items).some(i => i.label === 'Tasks'), id + ' hidden');
  } finally { if (had === undefined) delete process.env.TASK_APP_URL; else process.env.TASK_APP_URL = had; }
});
test('link: the page opens it in a new tab with rel="noopener noreferrer"', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'frontend', 'common.js'), 'utf8');
  assert.match(src, /item\.external[\s\S]{0,120}target = '_blank'[\s\S]{0,60}rel = 'noopener noreferrer'/);
  const idx = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  assert.match(idx, /a\.target = '_blank'; a\.rel = 'noopener noreferrer'/);
});

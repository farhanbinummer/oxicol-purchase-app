// taskflow.js - a READ-ONLY summary of the separate TaskFlow Teams app, for the Manager and Administrator dashboards.
//
// What it does: signs in to Firebase with ONE dedicated reader account (REST sign-in), reads taskflow/tasks with GET only and keeps
// COUNTS: overdue (the main number), open, due today, done in the last 7 days, and who has the most overdue tasks.
// What it never does: copy a task title, description or chat; write anything to TaskFlow; store anything in Oxicol's database;
// log the password, the sign-in token or any address that carries it.
// It must never slow down or break the dashboard: the dashboard loads it from its own endpoint, the answer is kept for one minute,
// every request has a time limit, and any failure becomes { ok: false } instead of an error.
const R = require('./rd-logic');

const CACHE_MS = 60 * 1000, FAIL_CACHE_MS = 20 * 1000, TIMEOUT_MS = 5000, TOP_PEOPLE = 3;
const DEFAULT_APP_URL = 'https://steady-frangollo-e2886d.netlify.app/';
const SIGN_IN = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/** The four settings, or null when the feature is off (any missing, or the database address is not https). */
function config(env = process.env) {
  const get = (k) => String(env[k] || '').trim();
  const apiKey = get('TASKFLOW_FIREBASE_API_KEY'), email = get('TASKFLOW_READER_EMAIL'), password = String(env.TASKFLOW_READER_PASSWORD || '');
  let dbUrl = get('TASKFLOW_DATABASE_URL');
  if (!apiKey || !email || !password || !dbUrl) return null;
  try { const u = new URL(dbUrl); if (u.protocol !== 'https:' || u.username || u.password) return null; dbUrl = u.origin; } catch (e) { return null; }
  return { apiKey, email, password, dbUrl };
}
const enabled = (env) => !!config(env);

/** Where the "Tasks" link opens. Unset -> the default address; set but empty (or not https) -> no link. */
function appUrl(env = process.env) {
  const raw = env.TASK_APP_URL === undefined ? DEFAULT_APP_URL : String(env.TASK_APP_URL).trim();
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch (e) { return null; }
}

/** The task app address with ?view=overdue|today|open added (TaskFlow opens its Tasks tab with that filter). Null when the link is off. */
function viewUrl(view, env = process.env) {
  const base = appUrl(env); if (!base || !['overdue', 'today', 'open'].includes(view)) return null;
  const u = new URL(base); u.searchParams.set('view', view); return u.href;
}

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && R.isValidDate(s);

/** Counts from the raw tasks object. Pure: no network, no clock (today is passed in as a YYYY-MM-DD India date). */
function summarize(tasks, today) {
  const list = !tasks ? [] : Array.isArray(tasks) ? tasks : Object.values(tasks);
  const weekStart = R.addDays(today, -6);                       // today and the six days before it
  const out = { overdue: 0, open: 0, due_today: 0, done_7d: 0, top_overdue: [] };
  const people = new Map();
  for (const t of list) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const repeating = !!t.recur && t.recur !== 'none';           // TaskFlow: a repeating task is never overdue
    const due = isDay(t.due) ? t.due : null;
    if (!t.done) {
      out.open += 1;
      if (!repeating && due === today) out.due_today += 1;
      if (!repeating && due && due < today) {
        out.overdue += 1;
        const id = t.assignedTo == null ? '' : String(t.assignedTo).slice(0, 80);
        const name = String(t.assignedToName || '').trim().slice(0, 60) || 'Not assigned';
        const key = id || name; const p = people.get(key) || { name, count: 0 }; p.count += 1; people.set(key, p);
      }
    } else {
      const on = isDay(t.completedAt) ? t.completedAt : isDay(t.lastDone) ? t.lastDone : null;
      if (on && on >= weekStart && on <= today) out.done_7d += 1;
    }
  }
  out.top_overdue = [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP_PEOPLE);
  return out;
}

/** fetch with a time limit that covers the whole call. Returns { status, json }. */
async function timed(fetchImpl, url, init, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    let json = null; try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  } finally { clearTimeout(timer); }
}

let cache = null;          // { at, ttl, value }
let inflight = null;
let session = null;        // { token, until } - the sign-in token is reused until shortly before it ends
const reset = () => { cache = null; inflight = null; session = null; };

async function load(cfg, fetchImpl, nowMs) {
  const deadline = Date.now() + TIMEOUT_MS, left = () => Math.max(500, deadline - Date.now());
  if (!session || session.until <= nowMs) {
    const r = await timed(fetchImpl, `${SIGN_IN}?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cfg.email, password: cfg.password, returnSecureToken: true })
    }, left());
    if (r.status !== 200 || !r.json || !r.json.idToken) { const e = new Error('sign-in refused'); e.code = 'SIGN_IN_' + r.status; throw e; }
    session = { token: r.json.idToken, until: nowMs + Math.max(60, Number(r.json.expiresIn) - 120 || 600) * 1000 };
  }
  const r = await timed(fetchImpl, `${cfg.dbUrl}/taskflow/tasks.json?auth=${encodeURIComponent(session.token)}`, { method: 'GET' }, left());
  if (r.status === 401 || r.status === 403) session = null;
  if (r.status !== 200) { const e = new Error('read refused'); e.code = 'READ_' + r.status; throw e; }
  const today = R.todayIST(nowMs);
  return { ok: true, as_of: today, ...summarize(r.json, today), generated_at: new Date(nowMs).toISOString() };
}

/**
 * The summary, from cache when it is under a minute old. Never throws: { ok:false } when TaskFlow cannot be reached or refuses us.
 * Returns null when the feature is off. `deps` is for tests: { env, fetch, now }.
 */
async function getSummary(deps = {}) {
  const cfg = config(deps.env || process.env); if (!cfg) return null;
  const now = deps.now ? deps.now() : Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.value;
  if (inflight) return inflight;                                // everybody who asks at once shares one read
  const fetchImpl = deps.fetch || fetch;
  inflight = (async () => {
    let value, ttl = CACHE_MS;
    try { value = await load(cfg, fetchImpl, now); }
    catch (err) {
      ttl = FAIL_CACHE_MS; session = null;
      console.error('TaskFlow summary unavailable:', err && (err.code || err.name) || 'error');   // never the message, URL or token
      value = { ok: false, error: 'unreachable' };
    }
    cache = { at: now, ttl, value }; return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { config, enabled, appUrl, viewUrl, summarize, getSummary, reset, DEFAULT_APP_URL, CACHE_MS, TIMEOUT_MS };

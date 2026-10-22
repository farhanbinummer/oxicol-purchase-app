// audit.js - one place that writes the audit history.
//
//   await audit(db, req, { action: 'request.approve', entity: 'branch_request', id: 7,
//                          summary: 'Approved REQ-20260924-001', before: {...}, after: {...}, reason: '...' });
//
// The actor always comes from the signed-in session (req.user), never from anything typed into a form.
// Values are scrubbed before saving: anything named like a secret is dropped, so a password or token can
// never end up in the history even if a caller passes a whole row by mistake.

const { pool } = require('./database');

const SECRET_KEY = /pass(word)?|secret|token|hash|api[_-]?key|authorization/i;

function scrub(value, depth = 0) {
  if (value == null || depth > 4) return value == null ? null : '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[hidden]' : scrub(v, depth + 1);
    return out;
  }
  return value;
}

/** `db` may be the pool or a transaction client, so the entry commits or rolls back with the change it describes. */
async function audit(db, req, e) {
  const u = (req && req.user) || {};
  await (db || pool).query(
    `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity, entity_id, summary, before_data, after_data, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [u.id || null, u.name || null, u.role || null, e.action, e.entity, e.id || null, e.summary || null,
     e.before === undefined ? null : JSON.stringify(scrub(e.before)),
     e.after === undefined ? null : JSON.stringify(scrub(e.after)),
     e.reason || null]);
}

module.exports = { audit, scrub };

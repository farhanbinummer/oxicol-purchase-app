// utils.js - small helpers shared by all route files.

/** Sends the standard error response: { success: false, error: "..." } */
function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

/** Rounds a rupee amount to 2 decimals (avoids 0.1 + 0.2 style float errors). */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Today's date as YYYY-MM-DD (server local time). */
function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** True if value looks like a real calendar date in YYYY-MM-DD form. */
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === value;
}

/** "2026-09-21" -> "20260921" (used inside document numbers). */
function stamp(isoDate) {
  return isoDate.replace(/-/g, '');
}

/**
 * Builds the next document number for a day, e.g. PAY-20260921-003.
 * Must be called INSIDE a transaction: the advisory lock makes two people saving at the
 * same moment wait for each other, so numbers never clash.
 *   client  - the transaction's pg client
 *   table / column - where existing numbers live
 *   prefix  - e.g. "PAY-20260921-"
 */
async function nextNumber(client, table, column, prefix) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [prefix]);
  // table/column names are hardcoded by callers (never user input), so this is safe.
  const r = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(${column} FROM '[0-9]+$')::int), 0) AS n
       FROM ${table} WHERE ${column} LIKE $1`, [prefix + '%']);
  return prefix + String(r.rows[0].n + 1).padStart(3, '0');
}

module.exports = { fail, round2, todayISO, isValidDate, stamp, nextNumber };

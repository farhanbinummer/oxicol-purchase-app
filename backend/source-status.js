// source-status.js - a branch request or production request is "po_raised" only when EVERY one of its lines is on a purchase order.
// Lines carry ordered_in_po (set when a PO buys them, cleared automatically if that PO is deleted).
const TABLE = { branch: ['branch_stock_requests', 'branch_request_items', 'request_id'], production: ['production_indents', 'production_indent_items', 'indent_id'] };

/** Works the status out again after orders were deleted. Only touches requests that are approved or po_raised. */
async function refreshSourceStatus(db, type, id) {
  const [head, lines, fk] = TABLE[type === 'branch' ? 'branch' : 'production'];
  const s = (await db.query(`SELECT status FROM ${head} WHERE id = $1`, [id])).rows[0];
  if (!s || !['approved', 'po_raised'].includes(s.status)) return;
  const c = (await db.query(`SELECT COUNT(*) FILTER (WHERE ordered_in_po IS NULL)::int AS open, COUNT(*) FILTER (WHERE ordered_in_po IS NOT NULL)::int AS done FROM ${lines} WHERE ${fk} = $1`, [id])).rows[0];
  let raised;
  if (c.done > 0) raised = c.open === 0;                       // lines are tracked: raised only when every line is ordered
  else raised = (await db.query('SELECT 1 FROM po_source_links WHERE source_type = $1 AND source_id = $2 LIMIT 1', [type, id])).rowCount > 0;   // older data without line tracking: raised while any order still links it
  await db.query(`UPDATE ${head} SET status = $2 WHERE id = $1 AND status <> $2`, [id, raised ? 'po_raised' : 'approved']);
}
module.exports = { refreshSourceStatus };

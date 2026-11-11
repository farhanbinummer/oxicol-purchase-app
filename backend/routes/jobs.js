// routes/jobs.js - the daily job, called by an outside scheduler (see docs/NOTICES.md), NOT by a signed-in person.
//   POST /api/jobs/morning-digest[?dry_run=1][&force=1]   Authorization: Bearer <JOBS_TOKEN>
// It does nothing unless the JOBS_TOKEN environment variable is set, and answers "not found" when it is not.
// dry_run=1 only shows what would be sent; force=1 skips the Sunday rule (it never skips the once-a-day rule).
const express = require('express');
const crypto = require('crypto');
const { morningDigest } = require('../digest');

const router = express.Router();
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

router.post('/morning-digest', async (req, res) => {
  const token = process.env.JOBS_TOKEN;
  if (!token) return res.status(404).json({ success: false, error: 'Not found' });
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!given || !same(given, token)) return res.status(401).json({ success: false, error: 'Not allowed' });
  try { res.json({ success: true, ...(await morningDigest({ dryRun: req.query.dry_run === '1', force: req.query.force === '1' })) }); }
  catch (err) { console.error('morning digest failed:', err); res.status(500).json({ success: false, error: 'The morning message failed' }); }
});

module.exports = router;

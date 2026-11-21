// server.js - Express app setup, middleware and route registration.

require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { testConnection } = require('./database');
const { requireAuth, requireRole } = require('./auth');
const { ensureSchema, emailOn, whatsappOn } = require('./notify');
const { ensureBomSchema } = require('./bom');
const { runMigrations } = require('./migrate');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
// No CORS middleware: the frontend is served by this same Express app (below), so every
// real request is same-origin already. Adding permissive CORS on top would only let OTHER
// websites read this API's responses for no benefit - so we simply don't add it.
app.set('trust proxy', 1); // needed so rate-limiting sees the real visitor IP behind a hosting platform's proxy
app.use(bodyParser.json());       // parse JSON request bodies

// Login is the one endpoint worth guarding against brute-forcing: 10 attempts per 15
// minutes per IP. Everything else needs a valid session already, so this is the door.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please wait a few minutes and try again.' }
});

// Speed: compress text responses (pages, styles, scripts and API answers shrink by about 80%).
app.use(compression());

// Serve the HTML frontend from ../frontend so http://localhost:3000 opens the app.
// Pages, scripts and styles are kept by the browser but CHECKED against the server on every use (Cache-Control: no-cache + ETag): an
// unchanged file costs a tiny "not modified" answer instead of a full download, and a changed file (a new deploy) is always picked up
// at once, so a stale common.js can never break a page. Pictures and icons are kept for a week.
// Data is never kept: every /api answer is sent with no-store.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, '..', 'frontend'), { etag: true, lastModified: true, cacheControl: false,
  setHeaders: (res, filePath) => res.set('Cache-Control', /\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath) ? 'public, max-age=604800' : 'no-cache') }));

// ---------- Routes ----------
// Health check: confirms both the server and the database are up.
app.get('/api/health', async (req, res) => {
  try {
    const dbTime = await testConnection();
    res.json({ success: true, status: 'ok', database: 'connected', time: dbTime });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Database not reachable: ' + (err.message || err.code || 'connection refused - is PostgreSQL running?') });
  }
});

// /api/auth/login and /api/auth/logout etc. are public or check auth themselves (see routes/auth.js).
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', require('./routes/auth'));

// Everything below this line needs a logged-in session (backend/auth.js).
// Each route file adds its own requireRole(...) on top of this where a department matters.
// the daily job is called by an outside scheduler with its own secret token, not by a signed-in person
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api', requireAuth);

app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/po', require('./routes/po'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/grn', require('./routes/grn'));
app.use('/api/tally', require('./routes/tally'));
app.use('/api/branch-request', require('./routes/branchRequest'));
app.use('/api/production-indent', require('./routes/productionIndent'));
app.use('/api/consolidate', require('./routes/consolidate'));
app.use('/api/rate-enquiry', require('./routes/rate-enquiry'));
app.use('/api/invoice', require('./routes/invoice'));
app.use('/api/three-way-match', require('./routes/threeWayMatch'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/bom', require('./routes/bom'));
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/admin', requireRole('admin'), require('./routes/admin'));
app.use('/api/admin', requireRole('admin'), require('./routes/materials-admin'));
app.use('/api/admin/data/records', requireRole('admin'), require('./routes/admin-records'));
app.use('/api/admin/data', requireRole('admin'), require('./routes/admin-data'));        // removing data: administrator only, with a typed confirmation and a reason
app.use('/api/search', require('./routes/search'));
app.use('/api/workspace', require('./routes/workspace'));
app.use('/api/rd', require('./routes/rd'));
app.use('/api/kpi', require('./routes/kpi'));
app.use('/api/notices', require('./routes/notices'));

// ---------- Error handling ----------
// Unknown /api route -> JSON 404 (not an HTML page)
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Malformed JSON body -> 400; anything else -> 500. Same { success, error } shape everywhere.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
  }
  if (err.type === 'entity.too.large') {          // e.g. a trial photograph over the size limit
    return res.status(413).json({ success: false, error: 'That file is too large. Photographs and PDFs can be at most 5 MB each.' });
  }
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ---------- Start ----------
app.listen(PORT, async () => {
  console.log(`Oxicol server running on http://localhost:${PORT}`);
  try {
    await testConnection();
    console.log('PostgreSQL connected (database: ' + process.env.DB_NAME + ')');
    await ensureSchema();
    await ensureBomSchema();
    await runMigrations();
    console.log('Alerts: email ' + (emailOn() ? 'ON' : 'off') + ', WhatsApp ' + (whatsappOn() ? 'ON' : 'off'));
  } catch (err) {
    console.error('PostgreSQL connection FAILED:', err.message || err.code || 'connection refused');
    console.error('Check your .env file and that PostgreSQL is running.');
  }
});

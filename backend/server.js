// server.js - Express app setup, middleware and route registration.

require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const { testConnection } = require('./database');
const { requireAuth } = require('./auth');
const { ensureSchema, emailOn, whatsappOn } = require('./notify');

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

// Serve the HTML frontend from ../frontend so http://localhost:3000 opens the app.
// No caching: this is an actively-edited internal tool, and a stale cached .html/.js
// file (e.g. an old common.js) can silently break a page after an update.
app.use(express.static(path.join(__dirname, '..', 'frontend'), { etag: false, lastModified: false, cacheControl: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

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
app.use('/api', requireAuth);

app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/po', require('./routes/po'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/grn', require('./routes/grn'));
app.use('/api/tally', require('./routes/tally'));
app.use('/api/branch-request', require('./routes/branchRequest'));
app.use('/api/production-indent', require('./routes/productionIndent'));
app.use('/api/consolidate', require('./routes/consolidate'));
app.use('/api/invoice', require('./routes/invoice'));
app.use('/api/three-way-match', require('./routes/threeWayMatch'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/search', require('./routes/search'));

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
    console.log('Alerts: email ' + (emailOn() ? 'ON' : 'off') + ', WhatsApp ' + (whatsappOn() ? 'ON' : 'off'));
  } catch (err) {
    console.error('PostgreSQL connection FAILED:', err.message || err.code || 'connection refused');
    console.error('Check your .env file and that PostgreSQL is running.');
  }
});

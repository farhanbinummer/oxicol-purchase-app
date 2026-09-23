// database.js - single shared PostgreSQL connection pool.
// All routes import this file and use pool.query(sql, [params]).
// ALWAYS pass user input as params ($1, $2 ...) - never build SQL with string concatenation.

require('dotenv').config();
const { Pool, types } = require('pg');

// Return DATE columns as plain "YYYY-MM-DD" text. Without this, Node converts them to
// timestamps and Indian time (UTC+5:30) shifts every date back by one day.
types.setTypeParser(1082, (value) => value);

// Hosted Postgres (Neon, Render, etc.) gives you one DATABASE_URL and requires SSL.
// Locally there's no DATABASE_URL, so this falls back to the individual DB_* vars - same
// local setup as before, nothing changes for anyone still running this on their own machine.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // hosted providers use certs a plain client won't have in its trust store
      max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 10,                       // max simultaneous connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000  // fail fast if Postgres is not running
    });

// An idle client erroring (e.g. Postgres restarted) must not crash the server.
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

/**
 * Checks the database is reachable. Called once at startup and by /api/health.
 * Resolves with the current DB time, rejects with the underlying error.
 */
async function testConnection() {
  const result = await pool.query('SELECT NOW() AS now');
  return result.rows[0].now;
}

module.exports = { pool, testConnection };

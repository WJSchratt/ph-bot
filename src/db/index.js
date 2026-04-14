const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params)
};

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('[migrate] schema applied');
  } catch (err) {
    console.error('[migrate] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

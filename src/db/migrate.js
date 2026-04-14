require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('[migrate] schema applied');

    // Add is_sandbox column to existing tables if missing
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'conversations' AND column_name = 'is_sandbox'
        ) THEN
          ALTER TABLE conversations ADD COLUMN is_sandbox BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);
    console.log('[migrate] is_sandbox column ensured');
  } catch (err) {
    console.error('[migrate] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

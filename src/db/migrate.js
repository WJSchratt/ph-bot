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

    // V2 Command Center tables and columns
    const v2Sql = fs.readFileSync(path.join(__dirname, 'migrate_v2.sql'), 'utf8');
    await pool.query(v2Sql);
    console.log('[migrate] v2 schema applied');

    // Persistent GHL conversation storage (pulled via analyzer)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ghl_conversations (
        id SERIAL PRIMARY KEY,
        ghl_conversation_id TEXT NOT NULL,
        contact_id TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        location_id TEXT NOT NULL,
        source TEXT DEFAULT 'other',
        message_count INTEGER DEFAULT 0,
        last_message_at TIMESTAMPTZ,
        terminal_outcome TEXT,
        ghl_date_added TIMESTAMPTZ,
        ghl_date_updated TIMESTAMPTZ,
        pulled_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days'),
        UNIQUE(ghl_conversation_id, location_id)
      );

      CREATE TABLE IF NOT EXISTS ghl_messages (
        id SERIAL PRIMARY KEY,
        ghl_conversation_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        direction TEXT,
        content TEXT,
        message_type TEXT,
        created_at TIMESTAMPTZ,
        pulled_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ghl_convos_location ON ghl_conversations(location_id);
      CREATE INDEX IF NOT EXISTS idx_ghl_convos_source ON ghl_conversations(source);
      CREATE INDEX IF NOT EXISTS idx_ghl_convos_expires ON ghl_conversations(expires_at);
      CREATE INDEX IF NOT EXISTS idx_ghl_convos_updated ON ghl_conversations(location_id, ghl_date_updated DESC);
      CREATE INDEX IF NOT EXISTS idx_ghl_messages_convo ON ghl_messages(ghl_conversation_id, location_id);
      CREATE INDEX IF NOT EXISTS idx_ghl_messages_created ON ghl_messages(ghl_conversation_id, created_at ASC);
    `);
    console.log('[migrate] ghl_conversations + ghl_messages ensured');
  } catch (err) {
    console.error('[migrate] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

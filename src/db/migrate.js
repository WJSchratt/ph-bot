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

    // Production-ready dashboard: users, health, wordtracks, pending changes,
    // weekly summaries, per-subaccount knowledge base.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS system_health_log (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        component TEXT,
        response_time_ms INTEGER,
        error_message TEXT,
        checked_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_health_checked ON system_health_log(checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_health_status ON system_health_log(status);

      CREATE TABLE IF NOT EXISTS wordtracks (
        id SERIAL PRIMARY KEY,
        wordtrack_text TEXT NOT NULL,
        wordtrack_hash TEXT NOT NULL UNIQUE,
        source TEXT,
        category TEXT,
        times_sent INTEGER DEFAULT 0,
        response_rate REAL DEFAULT 0,
        positive_response_rate REAL DEFAULT 0,
        booking_rate REAL DEFAULT 0,
        opt_out_rate REAL DEFAULT 0,
        avg_reply_time_seconds REAL,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wordtracks_source ON wordtracks(source);
      CREATE INDEX IF NOT EXISTS idx_wordtracks_category ON wordtracks(category);

      CREATE TABLE IF NOT EXISTS pending_prompt_changes (
        id SERIAL PRIMARY KEY,
        source TEXT,
        change_type TEXT,
        description TEXT,
        example_conversation_id INTEGER,
        proposed_by TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_pending_changes_status ON pending_prompt_changes(status);

      CREATE TABLE IF NOT EXISTS weekly_summaries (
        id SERIAL PRIMARY KEY,
        location_id TEXT NOT NULL,
        week_start DATE NOT NULL,
        week_end DATE NOT NULL,
        summary_data JSONB,
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(location_id, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_location ON weekly_summaries(location_id, week_start DESC);

      CREATE TABLE IF NOT EXISTS subaccount_knowledge_base (
        id SERIAL PRIMARY KEY,
        location_id TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        tag TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sub_kb_location ON subaccount_knowledge_base(location_id);
    `);
    console.log('[migrate] users + health + wordtracks + pending_changes + weekly_summaries + sub_kb ensured');
  } catch (err) {
    console.error('[migrate] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

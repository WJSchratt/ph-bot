require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

/**
 * Apply every schema + column migration. Fully idempotent — safe to call on
 * every server boot (see server.js). CLI usage (`npm run migrate`) still
 * works: the bottom of the file runs this when invoked directly.
 */
async function applyMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
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

    // Pipeline stages: cached GHL pipelines + opportunities
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ghl_pipelines (
        id SERIAL PRIMARY KEY,
        ghl_pipeline_id TEXT NOT NULL,
        name TEXT,
        location_id TEXT NOT NULL,
        stages JSONB,
        pulled_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ghl_pipeline_id, location_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pipelines_location ON ghl_pipelines(location_id);

      CREATE TABLE IF NOT EXISTS ghl_opportunities (
        id SERIAL PRIMARY KEY,
        ghl_opportunity_id TEXT NOT NULL,
        contact_id TEXT,
        contact_name TEXT,
        pipeline_id TEXT,
        pipeline_name TEXT,
        pipeline_stage_id TEXT,
        pipeline_stage_name TEXT,
        status TEXT,
        monetary_value REAL DEFAULT 0,
        location_id TEXT NOT NULL,
        ghl_created_at TIMESTAMPTZ,
        ghl_updated_at TIMESTAMPTZ,
        pulled_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ghl_opportunity_id, location_id)
      );
      CREATE INDEX IF NOT EXISTS idx_opps_location ON ghl_opportunities(location_id);
      CREATE INDEX IF NOT EXISTS idx_opps_pipeline ON ghl_opportunities(location_id, pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_opps_stage ON ghl_opportunities(location_id, pipeline_stage_id);
      CREATE INDEX IF NOT EXISTS idx_opps_updated ON ghl_opportunities(location_id, ghl_updated_at DESC);
    `);
    console.log('[migrate] ghl_pipelines + ghl_opportunities ensured');

    // Anthropic usage log — every Claude call tagged by category for cost attribution.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anthropic_usage_log (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        category VARCHAR(50) NOT NULL,
        model VARCHAR(100) NOT NULL,
        location_id VARCHAR(100),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        meta JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_anthropic_usage_created ON anthropic_usage_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_anthropic_usage_cat ON anthropic_usage_log(category, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_anthropic_usage_loc ON anthropic_usage_log(location_id, created_at DESC) WHERE location_id IS NOT NULL;
    `);
    console.log('[migrate] anthropic_usage_log ensured');

    // Seed cache pricing defaults into app_settings.cost_config if not already set.
    await pool.query(`
      INSERT INTO app_settings (section, key, value) VALUES
        ('cost_config', 'cache_read_cost_per_million',  '0.30'),
        ('cost_config', 'cache_write_cost_per_million', '3.75'),
        ('cost_config', 'signal_house_base_monthly',    '50'),
        ('cost_config', 'signal_house_base_segments',   '7500'),
        ('cost_config', 'signal_house_overage_per_seg', '0.01'),
        ('cost_config', 'signal_house_mms_per_seg',     '0.04')
      ON CONFLICT (section, key) DO NOTHING;
    `);
    console.log('[migrate] cost_config pricing defaults seeded');

    // Word track clusters — Claude clusters outbound SMS templates and the
    // WordTracks tab credits replies/bookings/opt-outs to the most recent
    // outbound cluster message before each inbound event.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS word_track_clusters (
        id SERIAL PRIMARY KEY,
        label VARCHAR(200) NOT NULL,
        description TEXT,
        source VARCHAR(20) DEFAULT 'mixed',
        example_text TEXT NOT NULL,
        normalized_hash VARCHAR(64) UNIQUE,
        cluster_size INTEGER DEFAULT 0,
        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        labeled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clusters_source ON word_track_clusters(source);
      CREATE INDEX IF NOT EXISTS idx_clusters_label ON word_track_clusters(label);

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ghl_messages' AND column_name='cluster_id') THEN
          ALTER TABLE ghl_messages ADD COLUMN cluster_id INTEGER REFERENCES word_track_clusters(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ghl_messages' AND column_name='normalized_hash') THEN
          ALTER TABLE ghl_messages ADD COLUMN normalized_hash VARCHAR(64);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_ghl_messages_cluster ON ghl_messages(cluster_id) WHERE cluster_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ghl_messages_norm_hash ON ghl_messages(normalized_hash) WHERE normalized_hash IS NOT NULL;

      -- Attribution window default (configurable per-request on the UI).
      INSERT INTO app_settings (section, key, value) VALUES
        ('wordtracks', 'attribution_window_days', '7')
      ON CONFLICT (section, key) DO NOTHING;
    `);
    console.log('[migrate] word_track_clusters + ghl_messages.cluster_id ensured');
}

// CLI entry point — when run as `node src/db/migrate.js` or `npm run migrate`.
async function cliRun() {
  try {
    await applyMigrations();
    console.log('[migrate] all migrations applied');
  } catch (err) {
    console.error('[migrate] failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  cliRun();
}

module.exports = { applyMigrations };

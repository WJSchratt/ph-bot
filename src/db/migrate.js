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

    // vertical — which bot handled this conversation ('insurance', 'chiro', etc.)
    // vertical_config — JSONB bag for vertical-specific config (doctor_name, practice_name, etc.)
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'conversations' AND column_name = 'vertical'
        ) THEN
          ALTER TABLE conversations ADD COLUMN vertical VARCHAR(50) DEFAULT 'insurance';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'conversations' AND column_name = 'vertical_config'
        ) THEN
          ALTER TABLE conversations ADD COLUMN vertical_config JSONB DEFAULT '{}'::jsonb;
        END IF;
      END $$;
    `);
    console.log('[migrate] vertical + vertical_config columns ensured');

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

    // Jobs table — tracks long-running async operations (repull, recluster,
    // QC batch apply, analyzer analyze, etc.) so the UI can poll for progress
    // instead of hanging on the HTTP request.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id BIGSERIAL PRIMARY KEY,
        job_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        progress_current INTEGER DEFAULT 0,
        progress_total INTEGER,
        progress_message TEXT,
        params JSONB,
        result JSONB,
        error TEXT,
        started_by VARCHAR(100),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_type_created ON jobs(job_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(status) WHERE status IN ('queued', 'running');
    `);
    console.log('[migrate] jobs table ensured');

    // ghl_message_id — lets us reference GHL's own message ID for future
    // idempotency and cross-referencing. Not unique-constrained because we
    // rebuild per-conversation on each pull (DELETE + INSERT).
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ghl_messages' AND column_name='ghl_message_id') THEN
          ALTER TABLE ghl_messages ADD COLUMN ghl_message_id TEXT;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_ghl_messages_msg_id ON ghl_messages(ghl_message_id) WHERE ghl_message_id IS NOT NULL;
    `);
    console.log('[migrate] ghl_messages.ghl_message_id ensured');

    // Two-layer word track model (Bug 5):
    //   workflow_clusters = cluster of conversation openers → workflow identity
    //   conversation_workflow_assignment = each conversation → its workflow
    //   word_track_clusters extended with (workflow_cluster_id, position) to
    //     group per-position variants within a workflow.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_clusters (
        id SERIAL PRIMARY KEY,
        label VARCHAR(200) NOT NULL DEFAULT 'unlabeled',
        description TEXT,
        normalized_opener TEXT NOT NULL,
        opener_hash VARCHAR(64) UNIQUE,
        example_opener TEXT NOT NULL,
        conversation_count INTEGER DEFAULT 0,
        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        labeled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wf_clusters_label ON workflow_clusters(label);

      CREATE TABLE IF NOT EXISTS conversation_workflow_assignment (
        id SERIAL PRIMARY KEY,
        ghl_conversation_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        workflow_cluster_id INTEGER REFERENCES workflow_clusters(id) ON DELETE SET NULL,
        opener_message_id BIGINT,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ghl_conversation_id, location_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_wf_workflow ON conversation_workflow_assignment(workflow_cluster_id);
      CREATE INDEX IF NOT EXISTS idx_conv_wf_loc ON conversation_workflow_assignment(location_id);

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='word_track_clusters' AND column_name='workflow_cluster_id') THEN
          ALTER TABLE word_track_clusters ADD COLUMN workflow_cluster_id INTEGER REFERENCES workflow_clusters(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='word_track_clusters' AND column_name='position') THEN
          ALTER TABLE word_track_clusters ADD COLUMN position INTEGER;
        END IF;
      END $$;

      -- The old flat-model unique constraint on normalized_hash conflicts
      -- with the two-layer model where the same template can legitimately
      -- appear at different (workflow, position) pairs.
      ALTER TABLE word_track_clusters DROP CONSTRAINT IF EXISTS word_track_clusters_normalized_hash_key;

      CREATE INDEX IF NOT EXISTS idx_wtclusters_workflow ON word_track_clusters(workflow_cluster_id);
      CREATE INDEX IF NOT EXISTS idx_wtclusters_position ON word_track_clusters(workflow_cluster_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_wtclusters_wf_pos_hash ON word_track_clusters(workflow_cluster_id, position, normalized_hash) WHERE workflow_cluster_id IS NOT NULL;
    `);
    console.log('[migrate] two-layer clustering schema ensured');

    // Workflow cluster → real GHL workflow name mapping. Manual assignments
    // (no /executions API from GHL — see Iteration probe findings), stored
    // once so wordtracks endpoints can render display names like
    // "A4 - Aged Mortgage Protection Lead Drip · Path D".
    //
    // Note: cluster_id references workflow_clusters.id — but we intentionally
    // don't add a FK constraint. A full recluster wipes workflow_clusters,
    // reassigning new IDs; we don't want to cascade-delete these manual
    // mappings. Stale mappings (non-existent cluster_id) simply don't match
    // in the LEFT JOIN and are cleaned up opportunistically later.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_cluster_mapping (
        cluster_id INTEGER PRIMARY KEY,
        ghl_workflow_name TEXT NOT NULL,
        ghl_workflow_path TEXT,
        location_id TEXT NOT NULL,
        mapped_at TIMESTAMPTZ DEFAULT NOW(),
        mapped_by TEXT DEFAULT 'manual'
      );
      CREATE INDEX IF NOT EXISTS idx_wf_map_location ON workflow_cluster_mapping(location_id);
    `);

    // Idempotent seed — Walt + Claude manually identified 31 clusters for
    // Veronica's sub-account (Nb8CYlsFaRFQchJBOvo1). A2 drip has no paths,
    // A4 drip has 4 paths. Any new mappings added later go through the app.
    const VERONICA_LOC = 'Nb8CYlsFaRFQchJBOvo1';
    const VERONICA_MAPPINGS = [
      // A2 - Fresh Mortgage Protection Lead Drip (no paths)
      [27, 'A2 - Fresh Mortgage Protection Lead Drip', null],
      [30, 'A2 - Fresh Mortgage Protection Lead Drip', null],
      // A4 - Aged Mortgage Protection Lead Drip · Path A
      [23, 'A4 - Aged Mortgage Protection Lead Drip', 'Path A'],
      [28, 'A4 - Aged Mortgage Protection Lead Drip', 'Path A'],
      [40, 'A4 - Aged Mortgage Protection Lead Drip', 'Path A'],
      [48, 'A4 - Aged Mortgage Protection Lead Drip', 'Path A'],
      // A4 · Path B
      [25, 'A4 - Aged Mortgage Protection Lead Drip', 'Path B'],
      [29, 'A4 - Aged Mortgage Protection Lead Drip', 'Path B'],
      // A4 · Path C
      [26, 'A4 - Aged Mortgage Protection Lead Drip', 'Path C'],
      [32, 'A4 - Aged Mortgage Protection Lead Drip', 'Path C'],
      // A4 · Path D
      [24, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [31, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [33, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [34, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [35, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [36, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [37, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [38, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [39, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [41, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [42, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [43, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [44, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [45, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [46, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [47, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [49, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [50, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [51, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [52, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D'],
      [53, 'A4 - Aged Mortgage Protection Lead Drip', 'Path D']
    ];
    // Upsert each row; ON CONFLICT DO NOTHING preserves any later manual edits
    // the app might have written between deploys.
    const values = [];
    const params = [];
    let p = 1;
    for (const [cid, name, path] of VERONICA_MAPPINGS) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(cid, name, path, VERONICA_LOC);
    }
    await pool.query(
      `INSERT INTO workflow_cluster_mapping (cluster_id, ghl_workflow_name, ghl_workflow_path, location_id)
       VALUES ${values.join(', ')}
       ON CONFLICT (cluster_id) DO NOTHING`,
      params
    );
    console.log('[migrate] workflow_cluster_mapping ensured + 31 Veronica mappings seeded');

    // workflow_opener_patterns — pattern-based mapping that SURVIVES reclusters.
    // Old design (workflow_cluster_mapping keyed on cluster_id) broke on every
    // recluster because TRUNCATE wiped workflow_clusters and reassigned IDs,
    // orphaning the mappings. Patterns match against workflow_clusters.example_opener
    // via ILIKE, so new cluster IDs auto-resolve to the right workflow name + path.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_opener_patterns (
        id SERIAL PRIMARY KEY,
        pattern TEXT NOT NULL,
        ghl_workflow_name TEXT NOT NULL,
        ghl_workflow_path TEXT,
        location_id TEXT,
        priority INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wop_loc ON workflow_opener_patterns(location_id);
      CREATE INDEX IF NOT EXISTS idx_wop_active ON workflow_opener_patterns(active) WHERE active = TRUE;
    `);

    // Seed the 5 patterns the user provided (Iteration earlier). Idempotent:
    // a (pattern, location_id) pair is inserted only if not already present.
    const PATTERN_SEEDS = [
      // A2 - Fresh Mortgage Protection Lead Drip (no path) — both CA and NV
      // licensed-agent variants share this phrase.
      ['Just saw a request about some possible coverage', 'A2 - Fresh Mortgage Protection Lead Drip', null, 100],
      // A4 - Aged MP · Path A — classic re-engagement opener
      ['Looks like a while back there was a request to look at some Mortgage Protection', 'A4 - Aged Mortgage Protection Lead Drip', 'Path A', 100],
      // Path B — rate-change hook
      ['rates have changed amidst the current administration', 'A4 - Aged Mortgage Protection Lead Drip', 'Path B', 100],
      // Path C — AI tool intro (70% stat)
      ['did you know 70% of families are now using Ai to find Mortgage Protection', 'A4 - Aged Mortgage Protection Lead Drip', 'Path C', 100],
      // Path D — AI phone offer
      ['No need talk to a human for Mortgage Protection anymore', 'A4 - Aged Mortgage Protection Lead Drip', 'Path D', 100]
    ];
    for (const [pattern, name, path, priority] of PATTERN_SEEDS) {
      await pool.query(
        `INSERT INTO workflow_opener_patterns (pattern, ghl_workflow_name, ghl_workflow_path, location_id, priority)
         SELECT $1, $2, $3, NULL, $4
         WHERE NOT EXISTS (SELECT 1 FROM workflow_opener_patterns WHERE pattern = $1 AND ghl_workflow_name = $2 AND COALESCE(ghl_workflow_path,'') = COALESCE($3,''))`,
        [pattern, name, path, priority]
      );
    }
    console.log('[migrate] workflow_opener_patterns ensured + 5 patterns seeded (A2 + A4 paths A/B/C/D)');

    // ElevenLabs post-call storage. Mirrored every agent's post-call webhook.
    // Schema lives in db/migrations/001_create_elevenlabs_calls.sql so the SQL
    // is reviewable as a single file; we just apply it here on boot.
    const elMigrationPath = path.join(__dirname, '..', '..', 'db', 'migrations', '001_create_elevenlabs_calls.sql');
    if (fs.existsSync(elMigrationPath)) {
      const elSql = fs.readFileSync(elMigrationPath, 'utf8');
      await pool.query(elSql);
      console.log('[migrate] elevenlabs_calls ensured');
    }

    const el2Path = path.join(__dirname, '..', '..', 'db', 'migrations', '002_add_call_number.sql');
    if (fs.existsSync(el2Path)) {
      const el2Sql = fs.readFileSync(el2Path, 'utf8');
      await pool.query(el2Sql);
      console.log('[migrate] elevenlabs_calls.call_number ensured');
    }

    // Onboarding submissions table + subaccounts extended columns
    const ob3Path = path.join(__dirname, '..', '..', 'db', 'migrations', '003_create_onboarding.sql');
    if (fs.existsSync(ob3Path)) {
      const ob3Sql = fs.readFileSync(ob3Path, 'utf8');
      await pool.query(ob3Sql);
      console.log('[migrate] onboarding_submissions + subaccounts columns ensured');
    }

    // Clip selection columns for EP review queue — start/end in milliseconds.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='elevenlabs_calls' AND column_name='clip_start_ms') THEN
          ALTER TABLE elevenlabs_calls ADD COLUMN clip_start_ms INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='elevenlabs_calls' AND column_name='clip_end_ms') THEN
          ALTER TABLE elevenlabs_calls ADD COLUMN clip_end_ms INTEGER;
        END IF;
      END $$;
    `);
    console.log('[migrate] elevenlabs_calls clip columns ensured');

    // Persistent pipeline routing log — survives server restarts (unlike in-memory logger).
    // Lets us diagnose whether routeOpportunity is firing and whether GHL API calls succeed.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pipeline_route_log (
        id BIGSERIAL PRIMARY KEY,
        contact_id TEXT NOT NULL,
        location_id TEXT,
        outcome TEXT NOT NULL,
        route_outcome TEXT,
        opportunity_id TEXT,
        pipeline_id TEXT,
        stage_id TEXT,
        prior_stage_id TEXT,
        was_created BOOLEAN DEFAULT FALSE,
        skipped TEXT,
        error TEXT,
        steps JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_log_contact ON pipeline_route_log(contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pipeline_log_created ON pipeline_route_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pipeline_log_location ON pipeline_route_log(location_id, created_at DESC) WHERE location_id IS NOT NULL;
    `);
    console.log('[migrate] pipeline_route_log ensured');

    // Fast dedup index for the GHL retry-suppression check in webhook.js.
    // Queries contact_id + direction + created_at on every inbound message.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_contact_dir_created
        ON messages(contact_id, direction, created_at DESC);
    `);
    console.log('[migrate] idx_messages_contact_dir_created ensured');
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

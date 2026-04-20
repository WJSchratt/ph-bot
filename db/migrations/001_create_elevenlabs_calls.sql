-- ElevenLabs post-call webhook storage. Every inbound and outbound call that
-- ElevenLabs reports on lands here exactly once (PK on conversation_id).
-- Audio bytes live alongside metadata in Postgres (bytea) so Railway
-- redeploys don't lose recordings — see elevenlabsAudio.js for rationale.
CREATE TABLE IF NOT EXISTS elevenlabs_calls (
  conversation_id       TEXT PRIMARY KEY,
  agent_id              TEXT,
  agent_name            TEXT,
  status                TEXT,
  call_direction        TEXT,
  external_number       TEXT,
  agent_number          TEXT,
  call_sid              TEXT,
  start_time            TIMESTAMPTZ,
  duration_secs         INTEGER,
  cost_credits          INTEGER,
  termination_reason    TEXT,
  call_successful       TEXT,
  transcript_summary    TEXT,
  call_summary_title    TEXT,
  evaluation_criteria   JSONB,
  transcript            JSONB,
  dynamic_variables     JSONB,
  raw_payload           JSONB,
  has_audio             BOOLEAN DEFAULT FALSE,
  audio_url             TEXT,
  audio_mime            TEXT,
  audio_bytes           BYTEA,
  audio_fetch_status    TEXT DEFAULT 'pending',
  audio_fetched_at      TIMESTAMPTZ,
  ghl_contact_id        TEXT,
  ghl_update_status     TEXT DEFAULT 'pending',
  is_ep                 BOOLEAN DEFAULT FALSE,
  call_result           TEXT,
  day_of_week_called    TEXT,
  received_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_elcalls_agent       ON elevenlabs_calls(agent_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_elcalls_start       ON elevenlabs_calls(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_elcalls_ep_start    ON elevenlabs_calls(start_time DESC) WHERE is_ep = TRUE;
CREATE INDEX IF NOT EXISTS idx_elcalls_external    ON elevenlabs_calls(external_number, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_elcalls_audio_pend  ON elevenlabs_calls(audio_fetch_status) WHERE audio_fetch_status = 'pending';

-- V2 Command Center: new tables and columns

-- Subaccounts
CREATE TABLE IF NOT EXISTS subaccounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  ghl_location_id VARCHAR(255) NOT NULL UNIQUE,
  ghl_api_key TEXT,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subaccounts_location ON subaccounts(ghl_location_id);

-- QC Reviews
CREATE TABLE IF NOT EXISTS qc_reviews (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  reviewer VARCHAR(255) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  modified_response TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qc_reviews_conversation ON qc_reviews(conversation_id);
CREATE INDEX IF NOT EXISTS idx_qc_reviews_outcome ON qc_reviews(outcome);

-- AI Review Queue
CREATE TABLE IF NOT EXISTS ai_review_queue (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  message_type VARCHAR(50),
  current_text TEXT NOT NULL,
  proposed_text TEXT NOT NULL,
  ai_reason TEXT,
  ai_confidence FLOAT,
  origin VARCHAR(20) DEFAULT 'ai',
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_review_status ON ai_review_queue(status);

-- App Settings (key/value with section grouping)
CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  section VARCHAR(100) NOT NULL,
  key VARCHAR(255) NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(section, key)
);

-- Add new columns to conversations
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='qc_reviewed') THEN
    ALTER TABLE conversations ADD COLUMN qc_reviewed BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='ai_self_score') THEN
    ALTER TABLE conversations ADD COLUMN ai_self_score INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='input_tokens') THEN
    ALTER TABLE conversations ADD COLUMN input_tokens INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='output_tokens') THEN
    ALTER TABLE conversations ADD COLUMN output_tokens INTEGER;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_qc ON conversations(qc_reviewed) WHERE qc_reviewed = FALSE;

-- Add segments column to messages
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='segments') THEN
    ALTER TABLE messages ADD COLUMN segments INTEGER;
  END IF;
END $$;

-- Calendar booking columns on conversations
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='calendar_id') THEN
    ALTER TABLE conversations ADD COLUMN calendar_id VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='calendar_assigned_user_id') THEN
    ALTER TABLE conversations ADD COLUMN calendar_assigned_user_id VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='calendar_event_title') THEN
    ALTER TABLE conversations ADD COLUMN calendar_event_title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='cached_slots') THEN
    ALTER TABLE conversations ADD COLUMN cached_slots JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='cached_slots_at') THEN
    ALTER TABLE conversations ADD COLUMN cached_slots_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='appointment_id') THEN
    ALTER TABLE conversations ADD COLUMN appointment_id VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='conversations' AND column_name='last_outbound_message_type') THEN
    ALTER TABLE conversations ADD COLUMN last_outbound_message_type VARCHAR(50);
  END IF;
END $$;

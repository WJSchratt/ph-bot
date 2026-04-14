CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  contact_id VARCHAR(255) NOT NULL,
  location_id VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  state VARCHAR(50),
  product_type VARCHAR(20),
  contact_stage VARCHAR(20) DEFAULT 'lead',
  is_ca BOOLEAN DEFAULT FALSE,

  existing_dob VARCHAR(50),
  existing_age VARCHAR(50),
  existing_smoker VARCHAR(50),
  existing_health TEXT,
  existing_spouse_name VARCHAR(255),
  existing_mortgage_balance VARCHAR(100),
  existing_coverage_subject VARCHAR(255),
  existing_email VARCHAR(255),

  bot_name VARCHAR(100) DEFAULT 'Sarah',
  agent_name VARCHAR(255) DEFAULT 'Jeremiah',
  agent_phone VARCHAR(50),
  agent_business_card_url TEXT,
  calendar_link_fx TEXT,
  calendar_link_mp TEXT,
  loom_video_fx TEXT,
  loom_video_mp TEXT,
  meeting_type VARCHAR(50) DEFAULT 'Phone',
  ghl_token VARCHAR(500),
  ghl_message_history TEXT,
  offer VARCHAR(255),
  offer_short VARCHAR(255),
  language VARCHAR(20),
  marketplace_type VARCHAR(50),
  consent_status VARCHAR(50),

  collected_age VARCHAR(50),
  collected_smoker VARCHAR(50),
  collected_health TEXT,
  collected_coverage_amount VARCHAR(100),
  collected_coverage_for VARCHAR(255),
  collected_spouse_name VARCHAR(255),
  collected_preferred_time VARCHAR(255),
  collected_appointment_time VARCHAR(255),
  decision_maker_confirmed BOOLEAN DEFAULT FALSE,
  spouse_on_call BOOLEAN DEFAULT FALSE,
  ai_voice_consent VARCHAR(20),
  health_flag BOOLEAN DEFAULT FALSE,
  tied_down BOOLEAN DEFAULT FALSE,
  call_sentiment VARCHAR(20),
  objection_type VARCHAR(100),
  motivation_level_1 VARCHAR(255),
  conversation_language VARCHAR(20) DEFAULT 'english',
  call_summary TEXT,

  messages JSONB DEFAULT '[]'::jsonb,
  terminal_outcome VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,

  fields_dirty BOOLEAN DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(contact_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id, location_id);
CREATE INDEX IF NOT EXISTS idx_conversations_dirty ON conversations(fields_dirty) WHERE fields_dirty = TRUE;
CREATE INDEX IF NOT EXISTS idx_conversations_active ON conversations(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_conversations_location ON conversations(location_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id VARCHAR(255) NOT NULL,
  location_id VARCHAR(255) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER,
  message_type VARCHAR(50),
  got_reply BOOLEAN DEFAULT FALSE,
  reply_time_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_location ON messages(location_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  conversations_started INTEGER DEFAULT 0,
  conversations_completed INTEGER DEFAULT 0,
  appointments_booked INTEGER DEFAULT 0,
  fex_immediate INTEGER DEFAULT 0,
  mp_immediate INTEGER DEFAULT 0,
  human_handoffs INTEGER DEFAULT 0,
  dnc_count INTEGER DEFAULT 0,
  total_inbound_messages INTEGER DEFAULT 0,
  total_outbound_messages INTEGER DEFAULT 0,
  avg_messages_per_conversation FLOAT,
  avg_response_time_seconds FLOAT,
  opt_out_rate FLOAT,
  UNIQUE(location_id, date)
);

CREATE INDEX IF NOT EXISTS idx_analytics_location_date ON analytics_daily(location_id, date);

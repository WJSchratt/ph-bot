-- Extend subaccounts with onboarding columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='agent_name') THEN
    ALTER TABLE subaccounts ADD COLUMN agent_name VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='agent_email') THEN
    ALTER TABLE subaccounts ADD COLUMN agent_email VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='agent_phone') THEN
    ALTER TABLE subaccounts ADD COLUMN agent_phone VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='bot_name') THEN
    ALTER TABLE subaccounts ADD COLUMN bot_name VARCHAR(100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='business_name') THEN
    ALTER TABLE subaccounts ADD COLUMN business_name VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='vertical') THEN
    ALTER TABLE subaccounts ADD COLUMN vertical VARCHAR(50) DEFAULT 'insurance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='plan') THEN
    ALTER TABLE subaccounts ADD COLUMN plan VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='elevenlabs_agent_id_en') THEN
    ALTER TABLE subaccounts ADD COLUMN elevenlabs_agent_id_en VARCHAR(100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='elevenlabs_agent_id_es') THEN
    ALTER TABLE subaccounts ADD COLUMN elevenlabs_agent_id_es VARCHAR(100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='onboarding_completed_at') THEN
    ALTER TABLE subaccounts ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subaccounts' AND column_name='config') THEN
    ALTER TABLE subaccounts ADD COLUMN config JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id SERIAL PRIMARY KEY,
  submission_id UUID DEFAULT gen_random_uuid(),
  status VARCHAR(50) DEFAULT 'pending',
  form_data JSONB NOT NULL,
  ghl_location_id VARCHAR(255),
  elevenlabs_agent_en VARCHAR(255),
  elevenlabs_agent_es VARCHAR(255),
  error_log JSONB DEFAULT '[]'::jsonb,
  completed_steps JSONB DEFAULT '[]'::jsonb,
  subaccount_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding_submissions(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_created ON onboarding_submissions(created_at DESC);

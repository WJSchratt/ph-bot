-- Add call_number for concurrent-burst tracking. Nth call to the same
-- external_number within the 10-min sibling window (1 = first call, 2+ = burst).
-- Used by epHandler.processEpCall and pushed to GHL so downstream workflows
-- can select the "Nth" call audio for VSL video generation.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'elevenlabs_calls' AND column_name = 'call_number'
  ) THEN
    ALTER TABLE elevenlabs_calls ADD COLUMN call_number INTEGER;
  END IF;
END $$;

-- Add index on external_id for faster incident deduplication lookups
CREATE INDEX IF NOT EXISTS idx_incidents_external_id ON incidents(external_id);
CREATE INDEX IF NOT EXISTS idx_incidents_dedupe_key ON incidents(dedupe_key);

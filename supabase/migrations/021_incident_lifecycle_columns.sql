-- Add incident lifecycle columns for ShipBrain incident management
-- Supports acknowledge, resolve, reject workflow

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acknowledged_by text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Add index for filtering by status
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

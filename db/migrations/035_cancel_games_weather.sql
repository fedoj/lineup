-- Cancelling games, and one "Weather" reason.
--
-- Rain, heat and lightning are now a single "weather" reason, for practices
-- and games alike; existing cancelled practices move to it. Games can be
-- cancelled like practices: a reason, an optional note, and undo. A league
-- game is cancelled on both teams' copies at once. A cancelled game has no
-- result: it never counts in standings or the team record.

ALTER TABLE practice DROP CONSTRAINT IF EXISTS practice_cancel_reason_check;
UPDATE practice SET cancel_reason = 'weather' WHERE cancel_reason IN ('rain', 'heat', 'lightning');
ALTER TABLE practice ADD CONSTRAINT practice_cancel_reason_check
    CHECK (cancel_reason IS NULL OR cancel_reason IN ('weather', 'field', 'emergency', 'other'));

ALTER TABLE game ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE game ADD COLUMN IF NOT EXISTS cancel_reason TEXT
    CHECK (cancel_reason IS NULL OR cancel_reason IN ('weather', 'field', 'emergency', 'other'));
ALTER TABLE game ADD COLUMN IF NOT EXISTS cancel_note TEXT;
ALTER TABLE game ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES app_user(id) ON DELETE SET NULL;

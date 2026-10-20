-- Game check-ins by parents.
--
-- A parent checks their child in or out of an upcoming game from a week
-- before it. The answer is stored as the game's availability (the same row
-- match day uses), with who answered and when, so coaches can tell a parent's
-- check-in from their own note.

ALTER TABLE game_availability ADD COLUMN IF NOT EXISTS responded_by UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE game_availability ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

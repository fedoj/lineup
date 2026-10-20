-- A player's boy or girl emoji on the roster.
--
-- Optional: when it is not set the app falls back to the team's gender (boys
-- or girls), or a neutral child for coed teams. Region sign-ups set it from
-- the child's registration when the child is placed on a team.

ALTER TABLE player ADD COLUMN IF NOT EXISTS gender TEXT
    CHECK (gender IS NULL OR gender IN ('boy', 'girl'));

-- A team's own game is either a friendly or a regular game. League games
-- come from the organization or region (fixture_id); standalone teams with
-- no league record their regular games themselves. NULL is a game created
-- before this column existed, shown as a friendly as it always was.
ALTER TABLE game ADD COLUMN IF NOT EXISTS is_friendly BOOLEAN;

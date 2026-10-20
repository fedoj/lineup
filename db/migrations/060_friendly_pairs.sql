-- Friendlies between two Lineup teams (Fady, 10/19): picking another team
-- from the region or organization (or one of the coach's own) puts the game
-- on both teams' calendars, so both teams RSVP and set lineups. The two
-- copies share a pair id, so a change to date, time, place, score or a
-- cancellation reaches both.
ALTER TABLE game ADD COLUMN IF NOT EXISTS pair_id uuid;
ALTER TABLE game ADD COLUMN IF NOT EXISTS opponent_team_id uuid REFERENCES team(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS game_pair_idx ON game(pair_id) WHERE pair_id IS NOT NULL;

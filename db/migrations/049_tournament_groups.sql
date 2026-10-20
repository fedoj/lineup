-- Group stages before a tournament's knockout (Fady, 10/16).
--
-- Group matches are competition_match rows with stage 'group' and a group
-- label (A, B, ...): everyone in a group plays everyone once, `round` being
-- the matchday. The knockout's first round can name group places instead of
-- teams (home_ref / away_ref like 'A1' = winner of group A), filled in once
-- that group's games are all played. A score can be entered by hand for a
-- match with no game on Lineup (two teams typed in by name).

ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'knockout'
    CHECK (stage IN ('group', 'knockout'));
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS group_label TEXT CHECK (group_label ~ '^[A-Z]$');
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS home_ref TEXT CHECK (home_ref ~ '^[A-Z][1-6]$');
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS away_ref TEXT CHECK (away_ref ~ '^[A-Z][1-6]$');
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS home_score INT CHECK (home_score BETWEEN 0 AND 99);
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS away_score INT CHECK (away_score BETWEEN 0 AND 99);
-- Seed position of each team within its group (for the table's last tie-break).
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS home_seed INT;
ALTER TABLE competition_match ADD COLUMN IF NOT EXISTS away_seed INT;

ALTER TABLE competition_match DROP CONSTRAINT IF EXISTS competition_match_competition_id_round_slot_third_place_key;
CREATE UNIQUE INDEX IF NOT EXISTS competition_match_place_uq
    ON competition_match (competition_id, stage, COALESCE(group_label, ''), round, slot, third_place);

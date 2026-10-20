-- 003: richer match events, and match setup inherited from the division.
--
-- Two gaps this closes:
--   1. game_event only allowed goal/assist/own_goal/save/yellow/red/sub, so
--      corners and fouls could not be recorded at all.
--   2. A team carried no match format, so every game fell back to a hardcoded
--      7v7 regardless of the division the team actually plays in.

-- ------------------------------------------------------- match event kinds

-- The CHECK constraint is named implicitly by Postgres, so drop by the known
-- default name and re-add. IF EXISTS keeps this rerunnable.
ALTER TABLE game_event DROP CONSTRAINT IF EXISTS game_event_kind_check;
ALTER TABLE game_event ADD CONSTRAINT game_event_kind_check CHECK (kind IN (
    'goal','assist','own_goal','save','yellow','red','sub',
    'corner','foul','shot','penalty'
));

-- ------------------------------------------------ team-level match defaults

ALTER TABLE team ADD COLUMN IF NOT EXISTS format TEXT
    CHECK (format IN ('5v5','7v7','9v9','11v11'));
ALTER TABLE team ADD COLUMN IF NOT EXISTS periods TEXT
    CHECK (periods IN ('quarters','halves'));
ALTER TABLE team ADD COLUMN IF NOT EXISTS period_length_sec INTEGER
    CHECK (period_length_sec > 0);

-- Backfill existing teams from the division they were created against, so
-- teams made before this migration stop defaulting to 7v7.
UPDATE team t
   SET format            = COALESCE(t.format, dc.format),
       periods           = COALESCE(t.periods, dc.periods),
       period_length_sec = COALESCE(t.period_length_sec, dc.period_length_sec)
  FROM division_catalog dc
 WHERE t.catalog_division_id = dc.id
   AND (t.format IS NULL OR t.periods IS NULL OR t.period_length_sec IS NULL);

-- ------------------------------------------------------------- game events

-- Recording a card or a foul is pointless without knowing who it was against
-- when no player is attached (opposition fouls carry no player_id).
CREATE INDEX IF NOT EXISTS game_event_kind_idx ON game_event(game_id, kind);

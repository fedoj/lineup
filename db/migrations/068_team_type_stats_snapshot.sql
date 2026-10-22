-- Team type (Shadi, 10/21): a league's teams are not all alike, e.g. Core,
-- Extra, All Stars, MLS Next 2 or NCL. Free text, picked from suggestions.
ALTER TABLE team ADD COLUMN IF NOT EXISTS team_type text CHECK (team_type IS NULL OR char_length(team_type) BETWEEN 1 AND 30);

-- Season-long stats are worked out ahead of time and read from here
-- (Shadi, 10/21), so a busy afternoon never waits on them: refreshed at night,
-- or in the background when a copy is more than a day old.
CREATE TABLE IF NOT EXISTS stats_snapshot (
    key          text        PRIMARY KEY,
    data         jsonb       NOT NULL,
    computed_at  timestamptz NOT NULL DEFAULT now(),
    last_read_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stats_snapshot_computed_idx ON stats_snapshot (computed_at);

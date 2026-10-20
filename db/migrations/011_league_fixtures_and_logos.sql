-- League fixtures, a scoped calendar, and logos.
--
-- A fixture is scheduled once by an org admin or region director and lands
-- on both teams as an ordinary game row, so match day, lineups, stats and
-- standings keep working unchanged. The fixture row owns when and where.

CREATE TABLE IF NOT EXISTS fixture (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    home_team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    away_team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    date          DATE NOT NULL,
    kickoff       TEXT CHECK (kickoff IS NULL OR kickoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    location      TEXT,
    field         TEXT,
    created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    CONSTRAINT fixture_two_teams CHECK (home_team_id <> away_team_id)
);
CREATE INDEX IF NOT EXISTS fixture_org_idx ON fixture(org_id, date);

ALTER TABLE game ADD COLUMN IF NOT EXISTS fixture_id UUID REFERENCES fixture(id) ON DELETE SET NULL;
ALTER TABLE game ADD COLUMN IF NOT EXISTS kickoff    TEXT;
ALTER TABLE game ADD COLUMN IF NOT EXISTS location   TEXT;
ALTER TABLE game ADD COLUMN IF NOT EXISTS field      TEXT;
CREATE INDEX IF NOT EXISTS game_fixture_idx ON game(fixture_id) WHERE fixture_id IS NOT NULL;

-- Both sides of a fixture share one result. Whichever side records a score,
-- the other side sees it mirrored. The IS DISTINCT FROM guard stops the
-- mirrored update from bouncing back.
CREATE OR REPLACE FUNCTION mirror_fixture_score() RETURNS trigger AS $$
BEGIN
    IF NEW.fixture_id IS NOT NULL THEN
        UPDATE game
           SET us = NEW.them, them = NEW.us, updated_at = now()
         WHERE fixture_id = NEW.fixture_id
           AND id <> NEW.id
           AND (us IS DISTINCT FROM NEW.them OR them IS DISTINCT FROM NEW.us);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS game_mirror_fixture_score ON game;
CREATE TRIGGER game_mirror_fixture_score
    AFTER UPDATE OF us, them ON game
    FOR EACH ROW
    WHEN (NEW.fixture_id IS NOT NULL)
    EXECUTE FUNCTION mirror_fixture_score();

-- Logos are stored apart from the entities so list queries stay small.
CREATE TABLE IF NOT EXISTS logo (
    kind        TEXT NOT NULL CHECK (kind IN ('org', 'region', 'team')),
    ref_id      UUID NOT NULL,
    mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    data        BYTEA NOT NULL,
    updated_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, ref_id)
);

-- Seasons and tournaments (Fady, 10/16).
--
-- A season or tournament stands on its own, apart from teams: it has a name,
-- start and end dates, and the teams taking part. Games scheduled in it carry
-- its id (on the league fixture and on each team's game row), its standings
-- count only its games, and its games show on every participating team's
-- calendar as before. It is read-only once its end date has passed.
--
-- Owner: a region (region_id), an organization (org_id only), or a coach for
-- their own standalone teams (owner_user_id).

CREATE TABLE IF NOT EXISTS competition (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           TEXT NOT NULL CHECK (kind IN ('season', 'tournament')),
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    starts_on      DATE NOT NULL,
    ends_on        DATE NOT NULL,
    org_id         UUID REFERENCES organization(id) ON DELETE CASCADE,
    region_id      UUID REFERENCES region(id) ON DELETE CASCADE,
    owner_user_id  UUID REFERENCES app_user(id) ON DELETE CASCADE,
    created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ,
    CHECK (ends_on >= starts_on),
    CHECK ((owner_user_id IS NOT NULL AND org_id IS NULL AND region_id IS NULL)
        OR (owner_user_id IS NULL AND org_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS competition_org_idx ON competition(org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS competition_region_idx ON competition(region_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS competition_owner_idx ON competition(owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS competition_team (
    competition_id  UUID NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
    team_id         UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    added_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (competition_id, team_id)
);
CREATE INDEX IF NOT EXISTS competition_team_team_idx ON competition_team(team_id);

ALTER TABLE fixture ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competition(id) ON DELETE SET NULL;
ALTER TABLE game ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competition(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS game_competition_idx ON game(competition_id) WHERE competition_id IS NOT NULL;

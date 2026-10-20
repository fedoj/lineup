-- Region join codes and family sign-ups.
--
-- A region has a join code (letters and digits). A region inside an
-- organization is joined with ORGCODE-REGIONCODE, where the organization part
-- is always its name in capitals without spaces or symbols; a standalone
-- region uses its own code. A parent signs up as usual, enters the code and
-- registers one or more children; region staff approve each one and place the
-- child on a team, which adds the player and links the parent.

ALTER TABLE region ADD COLUMN IF NOT EXISTS join_code TEXT
    CHECK (join_code IS NULL OR join_code ~ '^[A-Z0-9]{3,20}$');
CREATE UNIQUE INDEX IF NOT EXISTS region_join_code_uq
    ON region(org_id, join_code) WHERE join_code IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS region_signup (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id        UUID NOT NULL REFERENCES region(id) ON DELETE CASCADE,
    parent_user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    -- Season label such as '2026-27'; a returning family signs up again each season.
    season           TEXT NOT NULL,
    child_name       TEXT NOT NULL,
    birth_year       SMALLINT NOT NULL CHECK (birth_year BETWEEN 1990 AND 2100),
    birth_month      SMALLINT NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
    gender           TEXT NOT NULL CHECK (gender IN ('boys', 'girls')),
    parent_phone     TEXT,
    -- A child already on file from a past season, picked instead of retyped.
    prior_player_id  UUID REFERENCES player(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'declined', 'placed', 'withdrawn')),
    team_id          UUID REFERENCES team(id) ON DELETE SET NULL,
    player_id        UUID REFERENCES player(id) ON DELETE SET NULL,
    decided_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The same child is registered once per region and season.
CREATE UNIQUE INDEX IF NOT EXISTS region_signup_once
    ON region_signup(region_id, parent_user_id, season, lower(child_name), birth_year)
    WHERE status IN ('pending', 'approved', 'placed');
CREATE INDEX IF NOT EXISTS region_signup_region_idx ON region_signup(region_id, status, created_at);
CREATE INDEX IF NOT EXISTS region_signup_parent_idx ON region_signup(parent_user_id);

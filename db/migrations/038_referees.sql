-- Referees, part 1: joining an organization and signing up for games.
--
-- An organization (or a standalone region, through its own hidden
-- organization) turns on referee sign-up, which gives it a referee code.
-- Anyone with an account who enters the code becomes one of its referees.
-- Referees do not join a region: they can sign up for any league game in the
-- organization, and may pick a favorite region to see its games first.
--
-- Each league game (fixture) has three spots: the main referee and two
-- assistant referees. Spots are first come, first served, with no approval;
-- the organization's or region's staff can remove a referee from a spot or put
-- another referee in. Games a team adds itself (friendlies, standalone teams)
-- have no referees.

ALTER TABLE organization ADD COLUMN IF NOT EXISTS referee_code TEXT
    CHECK (referee_code IS NULL OR referee_code ~ '^[A-Z0-9]{6,12}$');
CREATE UNIQUE INDEX IF NOT EXISTS organization_referee_code_uq
    ON organization(referee_code) WHERE referee_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referee (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    org_id             UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    favorite_region_id UUID REFERENCES region(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referee_user_org_uq UNIQUE (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS referee_org_idx ON referee(org_id);

CREATE TABLE IF NOT EXISTS fixture_referee (
    fixture_id  UUID NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
    slot        TEXT NOT NULL CHECK (slot IN ('main', 'ar1', 'ar2')),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    -- Who put them there: the referee themself, or a staff member.
    assigned_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (fixture_id, slot),
    -- One spot per person per game.
    CONSTRAINT fixture_referee_one_spot UNIQUE (fixture_id, user_id)
);
CREATE INDEX IF NOT EXISTS fixture_referee_user_idx ON fixture_referee(user_id);

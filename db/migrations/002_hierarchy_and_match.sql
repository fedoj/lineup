-- Lineup platform — migration 002
--
-- Adds the Organization -> Region -> Team hierarchy with shared, role-based
-- access, per-period formations and timing, attendance, match events, the
-- data-rights surface (export/delete/unsubscribe) and admin telemetry.
--
-- Access model change: teams were owned by exactly one app_user via
-- team.owner_id. That column is retained as "who created it" but authorisation
-- now resolves through membership at org, region or team scope. The backfill
-- at the end of this file gives every existing team a personal org + region so
-- no row is orphaned.

-- ------------------------------------------------------------- hierarchy

CREATE TABLE IF NOT EXISTS organization (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE,
    -- Personal orgs are created implicitly for a solo coach and are hidden
    -- from the UI; real orgs are created deliberately and can be paid for.
    is_personal BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS organization_live_idx
    ON organization(id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS region (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    code        TEXT,                        -- e.g. AYSO "42"
    is_personal BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS region_org_idx ON region(org_id);

-- Divisions come in two flavours.
--
-- 1. division_catalog — a static, global, read-only list (BU10, GU10, Coed U8).
--    Free teams pick one. Nobody can edit it; it ships seeded below.
-- 2. division — custom divisions a paid org/region director creates, with
--    their own naming, season and match defaults.
--
-- A team references exactly one of the two.

CREATE TABLE IF NOT EXISTS division_catalog (
    id          TEXT PRIMARY KEY,          -- 'BU10', 'GU10', 'CU8'
    label       TEXT NOT NULL,             -- 'Boys U10'
    gender      TEXT NOT NULL CHECK (gender IN ('boys','girls','coed')),
    age_u       INTEGER NOT NULL CHECK (age_u BETWEEN 4 AND 19),
    format      TEXT NOT NULL CHECK (format IN ('5v5','7v7','9v9','11v11')),
    periods     TEXT NOT NULL DEFAULT 'quarters' CHECK (periods IN ('quarters','halves')),
    period_length_sec INTEGER NOT NULL CHECK (period_length_sec > 0),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Custom divisions: paid feature, always owned by a region.
CREATE TABLE IF NOT EXISTS division (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   UUID NOT NULL REFERENCES region(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    name        TEXT,
    gender      TEXT NOT NULL DEFAULT 'coed' CHECK (gender IN ('boys','girls','coed')),
    age_u       INTEGER CHECK (age_u BETWEEN 4 AND 19),
    season      TEXT NOT NULL DEFAULT '',
    format      TEXT CHECK (format IN ('5v5','7v7','9v9','11v11')),
    periods     TEXT CHECK (periods IN ('quarters','halves')),
    period_length_sec INTEGER CHECK (period_length_sec > 0),
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    UNIQUE (region_id, code, season)
);
CREATE INDEX IF NOT EXISTS division_region_idx ON division(region_id);

-- org_id is always populated (free users get a hidden personal org so foreign
-- keys and cascades behave), but free users never see or manage it.
ALTER TABLE team ADD COLUMN IF NOT EXISTS org_id      UUID REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE team ADD COLUMN IF NOT EXISTS region_id   UUID REFERENCES region(id)       ON DELETE SET NULL;
ALTER TABLE team ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES division(id)     ON DELETE SET NULL;
ALTER TABLE team ADD COLUMN IF NOT EXISTS catalog_division_id TEXT REFERENCES division_catalog(id) ON DELETE SET NULL;
ALTER TABLE team ADD COLUMN IF NOT EXISTS gender      TEXT CHECK (gender IN ('boys','girls','coed'));
ALTER TABLE team ADD COLUMN IF NOT EXISTS age_u       INTEGER CHECK (age_u BETWEEN 4 AND 19);
ALTER TABLE team ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
-- A team belongs to a custom division or a catalog division, never both.
ALTER TABLE team DROP CONSTRAINT IF EXISTS team_one_division;
ALTER TABLE team ADD CONSTRAINT team_one_division CHECK (
    division_id IS NULL OR catalog_division_id IS NULL
);
CREATE INDEX IF NOT EXISTS team_org_idx      ON team(org_id);
CREATE INDEX IF NOT EXISTS team_region_idx   ON team(region_id);
CREATE INDEX IF NOT EXISTS team_division_idx ON team(division_id);

-- ------------------------------------------------------------ membership

-- Roles are ordered by power so the resolver can compare them numerically.
--   org_admin     full control of an organization
--   director      region director: divisions, teams, coach assignment
--   region_admin  alias-level admin within one region
--   coach         full control of their own team
--   assistant     same as coach minus roster and deletion
--   parent        read-only, and only for the players linked to them
--   player        read-only view of their own team and stats
--   viewer        read-only spectator at any scope
CREATE TABLE IF NOT EXISTS membership (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN
                   ('org_admin','director','region_admin','coach',
                    'assistant','parent','player','viewer')),
    -- Exactly one scope column is non-null; enforced by the CHECK below.
    org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
    region_id   UUID REFERENCES region(id)       ON DELETE CASCADE,
    division_id UUID REFERENCES division(id)     ON DELETE CASCADE,
    team_id     UUID REFERENCES team(id)         ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_one_scope CHECK (
        (org_id IS NOT NULL)::int
      + (region_id IS NOT NULL)::int
      + (division_id IS NOT NULL)::int
      + (team_id IS NOT NULL)::int = 1
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_org_uq
    ON membership(user_id, org_id)      WHERE org_id      IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_region_uq
    ON membership(user_id, region_id)   WHERE region_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_division_uq
    ON membership(user_id, division_id) WHERE division_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS membership_team_uq
    ON membership(user_id, team_id)     WHERE team_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_user_idx ON membership(user_id);

-- Links a parent or player account to the specific children they may see.
-- Without a row here a 'parent' or 'player' membership resolves to nothing,
-- so the default is no visibility rather than team-wide visibility.
CREATE TABLE IF NOT EXISTS player_guardian (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   UUID NOT NULL REFERENCES player(id)   ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    relation    TEXT NOT NULL DEFAULT 'parent'
                CHECK (relation IN ('parent','guardian','self')),
    -- Set when an adult has approved a player (child) account.
    consented_at TIMESTAMPTZ,
    consented_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (player_id, user_id)
);
CREATE INDEX IF NOT EXISTS player_guardian_user_idx   ON player_guardian(user_id);
CREATE INDEX IF NOT EXISTS player_guardian_player_idx ON player_guardian(player_id);

CREATE TABLE IF NOT EXISTS invite (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN
                   ('org_admin','director','region_admin','coach',
                    'assistant','parent','player','viewer')),
    org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
    region_id   UUID REFERENCES region(id)       ON DELETE CASCADE,
    division_id UUID REFERENCES division(id)     ON DELETE CASCADE,
    team_id     UUID REFERENCES team(id)         ON DELETE CASCADE,
    -- For parent/player invites: which child the invite grants access to.
    player_id   UUID REFERENCES player(id)       ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    invited_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days'),
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    revoked_at  TIMESTAMPTZ,
    CONSTRAINT invite_one_scope CHECK (
        (org_id IS NOT NULL)::int
      + (region_id IS NOT NULL)::int
      + (division_id IS NOT NULL)::int
      + (team_id IS NOT NULL)::int = 1
    )
);
CREATE INDEX IF NOT EXISTS invite_email_idx ON invite(lower(email));
CREATE INDEX IF NOT EXISTS invite_open_idx
    ON invite(token) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ------------------------------------------------- per-period formations

-- A game is divided into periods (2 halves or 4 quarters). Each period may
-- carry its own formation, so a coach can switch shape at the break, and its
-- own clock state so a refresh never loses a running timer.
CREATE TABLE IF NOT EXISTS game_period (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id        UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    period_index   INTEGER NOT NULL CHECK (period_index >= 0),
    formation      TEXT,                 -- NULL = inherit game.formation
    length_sec     INTEGER NOT NULL DEFAULT 720 CHECK (length_sec > 0),
    -- Clock: elapsed_sec is the committed total; started_at is non-null only
    -- while running. Live elapsed = elapsed_sec + (now() - started_at).
    elapsed_sec    INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_sec >= 0),
    started_at     TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (game_id, period_index)
);
CREATE INDEX IF NOT EXISTS game_period_game_idx ON game_period(game_id);

-- Per-game availability. Absent players are excluded from auto-assign and
-- stripped from the formation.
CREATE TABLE IF NOT EXISTS game_availability (
    game_id    UUID NOT NULL REFERENCES game(id)   ON DELETE CASCADE,
    player_id  UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'available'
               CHECK (status IN ('available','absent','late','injured')),
    note       TEXT,
    PRIMARY KEY (game_id, player_id)
);

ALTER TABLE game ADD COLUMN IF NOT EXISTS period_length_sec INTEGER NOT NULL DEFAULT 720;
ALTER TABLE game ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Which game this lineup was copied from, for "repeat last week".
ALTER TABLE game ADD COLUMN IF NOT EXISTS copied_from_game_id UUID REFERENCES game(id) ON DELETE SET NULL;

-- ------------------------------------------------ attendance and events

-- Normalised attendance. practice.present_player_ids stays for backwards
-- compatibility but analytics reads this table.
CREATE TABLE IF NOT EXISTS attendance (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES team(id)   ON DELETE CASCADE,
    player_id   UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    -- Either a practice, a game, or a free-standing date.
    practice_id UUID REFERENCES practice(id) ON DELETE CASCADE,
    game_id     UUID REFERENCES game(id)     ON DELETE CASCADE,
    on_date     DATE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'present'
                CHECK (status IN ('present','absent','excused','late')),
    note        TEXT,
    recorded_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (player_id, on_date, practice_id, game_id)
);
CREATE INDEX IF NOT EXISTS attendance_team_date_idx ON attendance(team_id, on_date);
CREATE INDEX IF NOT EXISTS attendance_player_idx    ON attendance(player_id);

CREATE TABLE IF NOT EXISTS game_event (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id       UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    player_id     UUID REFERENCES player(id) ON DELETE SET NULL,
    assist_id     UUID REFERENCES player(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL CHECK (kind IN
                    ('goal','assist','own_goal','save','yellow','red','sub')),
    period_index  INTEGER,
    clock_sec     INTEGER,
    -- true when the opposition scored, so team totals stay correct.
    against       BOOLEAN NOT NULL DEFAULT false,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_event_game_idx   ON game_event(game_id);
CREATE INDEX IF NOT EXISTS game_event_player_idx ON game_event(player_id);

-- ------------------------------------------------- billing and data rights

-- Entitlements become scope-aware: a paid plan attaches to an org or a region,
-- not only to a user. The original per-user row stays valid for solo coaches.
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS org_id    UUID REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES region(id)       ON DELETE CASCADE;
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS status    TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','cancelled','expired'));
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
-- Access survives until the paid period ends, even after cancelling.
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ;
ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS external_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS entitlement_org_uq
    ON entitlement(app_id, org_id)    WHERE org_id    IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_region_uq
    ON entitlement(app_id, region_id) WHERE region_id IS NOT NULL;

-- Email unsubscribe. Keyed by address because a recipient may not be a user.
CREATE TABLE IF NOT EXISTS email_optout (
    email          TEXT PRIMARY KEY,
    scope          TEXT NOT NULL DEFAULT 'all'
                   CHECK (scope IN ('all','team','marketing')),
    token          TEXT NOT NULL UNIQUE,
    unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason         TEXT
);

ALTER TABLE contact ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

-- Account closure is queued, not instant, so an accidental click is reversible
-- and a cascade delete never runs inside a request.
CREATE TABLE IF NOT EXISTS deletion_request (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES app_user(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL CHECK (scope IN ('account','org','region','team')),
    target_id    UUID,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Grace window before the purge job may act.
    execute_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    cancelled_at TIMESTAMPTZ,
    executed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deletion_due_idx
    ON deletion_request(execute_at)
    WHERE executed_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- ----------------------------------------------------- admin telemetry

-- Minimal request/session log powering the admin panel's abuse view.
-- Retention is enforced by the purge job, not kept indefinitely.
CREATE TABLE IF NOT EXISTS access_log (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID REFERENCES app_user(id) ON DELETE CASCADE,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    route      TEXT,
    ip_hash    TEXT,          -- salted hash, never the raw address
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS access_log_user_at_idx ON access_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS access_log_at_idx      ON access_log(at DESC);

-- ------------------------------------------------- seed division catalog

-- U4 through U19, boys/girls/coed, with AYSO-style format and period defaults.
-- Generated rather than hand-listed so the brackets stay internally consistent.
INSERT INTO division_catalog (id, label, gender, age_u, format, periods, period_length_sec, sort_order)
SELECT
    CASE g WHEN 'boys' THEN 'BU' WHEN 'girls' THEN 'GU' ELSE 'CU' END || a,
    CASE g WHEN 'boys' THEN 'Boys U' WHEN 'girls' THEN 'Girls U' ELSE 'Coed U' END || a,
    g,
    a,
    CASE WHEN a <= 8 THEN '5v5' WHEN a <= 10 THEN '7v7' WHEN a <= 12 THEN '9v9' ELSE '11v11' END,
    CASE WHEN a <= 12 THEN 'quarters' ELSE 'halves' END,
    CASE WHEN a <= 8 THEN 600 WHEN a <= 10 THEN 720 WHEN a <= 12 THEN 900 ELSE 2100 END,
    a * 10 + CASE g WHEN 'boys' THEN 1 WHEN 'girls' THEN 2 ELSE 3 END
FROM generate_series(4, 19) AS a
CROSS JOIN (VALUES ('boys'), ('girls'), ('coed')) AS gs(g)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------- backfill

-- Derive a division code from gender and age, e.g. ('boys', 10) -> 'BU10'.
CREATE OR REPLACE FUNCTION division_code(p_gender TEXT, p_age_u INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_age_u IS NULL THEN COALESCE(upper(p_gender), 'COED')
        WHEN p_gender = 'boys'  THEN 'BU' || p_age_u
        WHEN p_gender = 'girls' THEN 'GU' || p_age_u
        ELSE 'U' || p_age_u
    END
$$;

-- AYSO-style default match format by age bracket.
CREATE OR REPLACE FUNCTION default_format(p_age_u INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_age_u IS NULL  THEN '7v7'
        WHEN p_age_u <= 6     THEN '5v5'
        WHEN p_age_u <= 8     THEN '5v5'
        WHEN p_age_u <= 10    THEN '7v7'
        WHEN p_age_u <= 12    THEN '9v9'
        ELSE '11v11'
    END
$$;

-- Give every pre-existing team a hidden personal org and region so foreign
-- keys resolve, then attach it to a catalog division. Free users never see the
-- org or region; they exist purely so the access path and cascades work.
-- age_group was free text ('7U', 'U10', 'BU10'), so parse what we can and
-- leave the rest unset rather than guessing.
DO $$
DECLARE
    t RECORD;
    new_org UUID;
    new_region UUID;
    parsed_age INTEGER;
    parsed_gender TEXT;
    cat_id TEXT;
BEGIN
    FOR t IN SELECT id, owner_id, name, region, age_group FROM team WHERE org_id IS NULL LOOP
        parsed_age := NULLIF(regexp_replace(COALESCE(t.age_group, ''), '\D', '', 'g'), '')::INTEGER;
        parsed_gender := CASE
            WHEN t.age_group ILIKE 'B%' THEN 'boys'
            WHEN t.age_group ILIKE 'G%' THEN 'girls'
            ELSE 'coed'
        END;

        INSERT INTO organization (name, is_personal, created_by)
        VALUES (COALESCE(NULLIF(t.name, ''), 'My teams'), true, t.owner_id)
        RETURNING id INTO new_org;

        INSERT INTO region (org_id, name, code, is_personal, created_by)
        VALUES (new_org, COALESCE(NULLIF(t.region, ''), 'Default'),
                NULLIF(t.region, ''), true, t.owner_id)
        RETURNING id INTO new_region;

        SELECT id INTO cat_id FROM division_catalog
         WHERE gender = parsed_gender AND age_u = parsed_age;

        UPDATE team
           SET org_id = new_org,
               region_id = new_region,
               catalog_division_id = cat_id,
               gender = parsed_gender,
               age_u = parsed_age
         WHERE id = t.id;

        IF t.owner_id IS NOT NULL THEN
            INSERT INTO membership (user_id, role, team_id)
            VALUES (t.owner_id, 'coach', t.id)
            ON CONFLICT DO NOTHING;
            INSERT INTO membership (user_id, role, org_id)
            VALUES (t.owner_id, 'org_admin', new_org)
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END $$;

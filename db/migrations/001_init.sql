-- Lineup platform — initial schema
-- Multi-tenant by owner_id. Entitlements table is app-agnostic so future
-- apps on this platform reuse it without migration.

-- gen_random_uuid() is built into PostgreSQL 13+, so no pgcrypto extension
-- is required (Azure Flexible Server would need it allowlisted otherwise).

-- ---------------------------------------------------------------- platform
CREATE TABLE IF NOT EXISTS app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      TEXT NOT NULL,              -- aad | google | github
    subject       TEXT NOT NULL,              -- stable id from provider
    email         TEXT,
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);

-- Shared across every app on the platform, not just Lineup.
CREATE TABLE IF NOT EXISTS entitlement (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id      TEXT NOT NULL,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    tier        TEXT NOT NULL DEFAULT 'free',
    overrides   JSONB,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    UNIQUE (app_id, user_id)
);

-- ------------------------------------------------------------------ lineup
CREATE TABLE IF NOT EXISTS team (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    age_group        TEXT NOT NULL DEFAULT '',
    season           TEXT NOT NULL DEFAULT '',
    coach            TEXT NOT NULL DEFAULT '',
    assistant_coach  TEXT,
    region           TEXT,
    division         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_owner_idx ON team(owner_id);

CREATE TABLE IF NOT EXISTS player (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    number   TEXT NOT NULL DEFAULT '',
    name     TEXT NOT NULL,
    active   BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS player_team_idx ON player(team_id);

CREATE TABLE IF NOT EXISTS game (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id      UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    game_no      INTEGER NOT NULL,
    date         DATE,
    opponent     TEXT NOT NULL DEFAULT '',
    us           INTEGER NOT NULL DEFAULT 0,
    them         INTEGER NOT NULL DEFAULT 0,
    is_home      BOOLEAN NOT NULL DEFAULT true,
    format       TEXT NOT NULL DEFAULT '7v7',
    periods      TEXT NOT NULL DEFAULT 'quarters',
    formation    TEXT NOT NULL DEFAULT '2-3-1',
    tactic       TEXT NOT NULL DEFAULT 'balanced',
    assignments  JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes        TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, game_no)
);
CREATE INDEX IF NOT EXISTS game_team_idx ON game(team_id);

CREATE TABLE IF NOT EXISTS practice (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    date               DATE NOT NULL,
    title              TEXT NOT NULL DEFAULT '',
    present_player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS practice_team_idx ON practice(team_id);

CREATE TABLE IF NOT EXISTS contact (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name     TEXT NOT NULL DEFAULT '',
    email    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_team_idx ON contact(team_id);

-- Sponsor slot replaces third-party ads (no COPPA ad exposure).
CREATE TABLE IF NOT EXISTS sponsor (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id   UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    logo_url  TEXT,
    link_url  TEXT,
    active    BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS sponsor_team_idx ON sponsor(team_id);

-- 015: custom stats, a paid feature.
--
-- A coach (or anyone above) defines the stats their team tracks, such as
-- "Tackles" or "Shots on target", then records a count per player per game.

CREATE TABLE IF NOT EXISTS team_stat (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS team_stat_name_uq
    ON team_stat(team_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS player_stat_value (
    game_id     UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    player_id   UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    stat_id     UUID NOT NULL REFERENCES team_stat(id) ON DELETE CASCADE,
    value       INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, player_id, stat_id)
);
CREATE INDEX IF NOT EXISTS player_stat_value_stat_idx ON player_stat_value(stat_id);

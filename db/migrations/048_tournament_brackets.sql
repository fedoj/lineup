-- Tournament brackets (Fady, 10/16).
--
-- One row per bracket match. Round one stores who plays (a team on Lineup,
-- or a name typed in); later rounds and the third-place game are worked out
-- from the winners before them (packages/shared/src/bracket.ts). A match is
-- decided by its game's score, or by hand (winner_override, for example after
-- penalties). Scheduling a match creates the real games: a league fixture
-- between two league teams, or a game on each Lineup team's calendar.

CREATE TABLE IF NOT EXISTS competition_match (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    competition_id  UUID NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
    round           INT NOT NULL CHECK (round BETWEEN 1 AND 6),
    slot            INT NOT NULL CHECK (slot >= 0),
    third_place     BOOLEAN NOT NULL DEFAULT false,
    home_team_id    UUID REFERENCES team(id) ON DELETE SET NULL,
    home_name       TEXT CHECK (length(home_name) <= 80),
    away_team_id    UUID REFERENCES team(id) ON DELETE SET NULL,
    away_name       TEXT CHECK (length(away_name) <= 80),
    winner_override TEXT CHECK (winner_override IN ('home', 'away')),
    date            DATE,
    kickoff         TEXT,
    location        TEXT CHECK (length(location) <= 160),
    fixture_id      UUID REFERENCES fixture(id) ON DELETE SET NULL,
    home_game_id    UUID REFERENCES game(id) ON DELETE SET NULL,
    away_game_id    UUID REFERENCES game(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (competition_id, round, slot, third_place)
);
CREATE INDEX IF NOT EXISTS competition_match_comp_idx ON competition_match(competition_id);

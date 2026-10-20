-- Borrowing a player for a game (Fady, 10/18).
--
-- A team's coach or assistant coach asks to borrow a player from another
-- team for one game. The other team's coach and assistant coach are told; the
-- coach approves or declines. An approved guest shows on the game.

CREATE TABLE IF NOT EXISTS game_guest (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id       UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    player_id     UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    -- The player's own team, kept so the request survives a roster change.
    from_team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    note          TEXT,
    requested_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open request or approval per player per game.
CREATE UNIQUE INDEX IF NOT EXISTS game_guest_once
    ON game_guest (game_id, player_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS game_guest_game_idx ON game_guest (game_id);
CREATE INDEX IF NOT EXISTS game_guest_from_idx ON game_guest (from_team_id, status);

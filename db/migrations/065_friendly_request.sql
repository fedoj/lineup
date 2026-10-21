-- Friendly requests (Shadi, 10/20): a team in an organization or region asks
-- to play a friendly against another team of the same organization. It goes
-- on both calendars once approved: by the region's staff when both teams are
-- in one region; across two regions by both regions' staff, or by the
-- organization's staff alone.
CREATE TABLE IF NOT EXISTS friendly_request (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id           UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    opponent_team_id  UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    requested_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    date              DATE NOT NULL,
    kickoff           TEXT NOT NULL,
    is_home           BOOLEAN NOT NULL DEFAULT true,
    location          TEXT NOT NULL,
    field             TEXT,
    assistant_free    BOOLEAN NOT NULL DEFAULT false,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    -- Who approved for the requesting team's region, the opponent's region,
    -- and the organization (which approves both sides at once).
    team_ok_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    opponent_ok_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    org_ok_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_at        TIMESTAMPTZ,
    decline_reason    TEXT,
    game_id           UUID REFERENCES game(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (team_id <> opponent_team_id)
);
CREATE INDEX IF NOT EXISTS friendly_request_team_idx ON friendly_request(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS friendly_request_opponent_idx ON friendly_request(opponent_team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS friendly_request_pending_idx ON friendly_request(status) WHERE status = 'pending';

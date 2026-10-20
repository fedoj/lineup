-- Player evaluation (premium): coaches and assistant coaches rate each player
-- 1 to 5 in seven categories (see packages/shared/src/evaluation.ts) plus
-- their strong foot. One current evaluation per player.
CREATE TABLE IF NOT EXISTS player_evaluation (
    player_id    UUID PRIMARY KEY REFERENCES player(id) ON DELETE CASCADE,
    team_id      UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
    strong_foot  TEXT CHECK (strong_foot IS NULL OR strong_foot IN ('left', 'right', 'both')),
    notes        TEXT,
    updated_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_evaluation_team_idx ON player_evaluation(team_id);

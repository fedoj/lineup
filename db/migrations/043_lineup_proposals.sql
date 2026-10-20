-- Assistant coaches propose lineup changes; the coach approves them.
--
-- game.assistant_free: the coach let the assistant change this game's lineup
-- without approval (unticked by default; only a coach changes it).
-- lineup_proposal: an assistant's pending formation and lineup for a game,
-- one per game. Approving copies it onto the game; rejecting deletes it.

ALTER TABLE game ADD COLUMN IF NOT EXISTS assistant_free BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS lineup_proposal (
    game_id      UUID PRIMARY KEY REFERENCES game(id) ON DELETE CASCADE,
    -- periodIndex -> slotId -> playerId, like game.assignments.
    assignments  JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- periodIndex -> formation, for periods whose shape changes.
    formations   JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

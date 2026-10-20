-- Planned substitutions on match day (Fady, 10/17).
--
-- Coaches and assistant coaches plan their subs ahead: in which period, at
-- what time on the period clock, who comes off and who comes on. When the
-- clock gets there match day pops up "Sub now"; "Done" records it (and a
-- 'sub' match event), which also counts the minutes: the player coming on
-- plays the rest of that period instead of the one going off.

CREATE TABLE IF NOT EXISTS game_sub_plan (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id        UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    period_index   INT NOT NULL CHECK (period_index BETWEEN 0 AND 3),
    at_sec         INT NOT NULL CHECK (at_sec BETWEEN 0 AND 7200),
    off_player_id  UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    on_player_id   UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at        TIMESTAMPTZ,
    skipped_at     TIMESTAMPTZ,
    -- The 'sub' match event recorded when it was marked done.
    event_id       UUID REFERENCES game_event(id) ON DELETE SET NULL,
    CHECK (off_player_id <> on_player_id)
);
CREATE INDEX IF NOT EXISTS game_sub_plan_game_idx ON game_sub_plan(game_id, period_index, at_sec);

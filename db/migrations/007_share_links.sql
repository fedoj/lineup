-- 007: shareable stat cards.
--
-- A tokenised, expiring, revocable link that renders a read-only stat card
-- without a login, so a coach can post results to a parents' group chat.
--
-- Privacy choices baked into the schema rather than left to the UI:
--   * the token is the only credential, so it must be unguessable and is
--     never derived from the team or player id;
--   * every link carries an expiry — there is no "forever" option;
--   * revoking is a column, not a delete, so an audit trail survives;
--   * `name_style` is stored per link, so a link cannot later start exposing
--     more than it did when it was shared.

CREATE TABLE IF NOT EXISTS share_link (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token        TEXT NOT NULL UNIQUE,
    scope        TEXT NOT NULL CHECK (scope IN ('team','player')),
    team_id      UUID NOT NULL REFERENCES team(id)   ON DELETE CASCADE,
    player_id    UUID          REFERENCES player(id) ON DELETE CASCADE,
    -- How much of a child's name the card may show. Never 'full' by default.
    name_style   TEXT NOT NULL DEFAULT 'initial'
                 CHECK (name_style IN ('initial','number','full')),
    created_by   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    last_viewed_at TIMESTAMPTZ,
    view_count   INTEGER NOT NULL DEFAULT 0,
    -- A player link must name a player; a team link must not.
    CONSTRAINT share_link_scope_target CHECK (
        (scope = 'player' AND player_id IS NOT NULL) OR
        (scope = 'team'   AND player_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS share_link_token_idx   ON share_link(token);
CREATE INDEX IF NOT EXISTS share_link_team_idx    ON share_link(team_id, created_at DESC);

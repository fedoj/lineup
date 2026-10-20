-- 012: shareable, read-only calendar links for an organization, region or team.
--
-- Same rules as share_link: the token is the only credential and is never
-- derived from an id, every link expires, and revoking keeps the row for audit.
-- A calendar carries team names, dates and venues but never a player.

CREATE TABLE IF NOT EXISTS calendar_share (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token           TEXT NOT NULL UNIQUE,
    scope           TEXT NOT NULL CHECK (scope IN ('org', 'region', 'team')),
    ref_id          UUID NOT NULL,
    created_by      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    last_viewed_at  TIMESTAMPTZ,
    view_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS calendar_share_ref_idx ON calendar_share(scope, ref_id, created_at DESC);

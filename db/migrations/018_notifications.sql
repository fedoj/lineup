-- In-app notifications: a bell for every user, and admin broadcasts to any
-- role, plan and scope.

CREATE TABLE IF NOT EXISTS notification_broadcast (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    link        TEXT,
    -- What was targeted, kept for the history list: scope, roles and plans.
    target      JSONB NOT NULL,
    recipients  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    broadcast_id  UUID REFERENCES notification_broadcast(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'reminder', 'system')),
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    link          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notification_user_idx ON notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_unread_idx ON notification(user_id) WHERE read_at IS NULL;

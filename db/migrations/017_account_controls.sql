-- Admin account controls: disable, sign out everywhere, delete and recover.
--
-- Static Web Apps sessions live in a cookie the API cannot revoke, so "sign
-- out everywhere" is a request the API enforces: until the app acknowledges
-- it (and sends the browser through /.auth/logout), every call is refused.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS disabled_at          TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS disabled_reason      TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS signout_requested_at TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS signout_acked_at     TIMESTAMPTZ;

-- Every admin action on an account, so the console is never a silent backdoor.
CREATE TABLE IF NOT EXISTS admin_action (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    target_user_id  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    action          TEXT NOT NULL CHECK (action IN ('disable', 'enable', 'signout', 'delete', 'recover')),
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_action_target_idx
    ON admin_action(target_user_id, created_at DESC);

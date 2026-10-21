-- What happened when someone tried to turn on notifications on a device
-- (Fady, 10/20): Android said it never worked, and nothing reached the server,
-- so the app now reports each attempt: which step failed and the browser's
-- own reason. Kept for 30 days.
CREATE TABLE IF NOT EXISTS push_setup_log (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    outcome     text        NOT NULL CHECK (char_length(outcome) <= 40),
    step        text        CHECK (char_length(step) <= 40),
    detail      text        CHECK (char_length(detail) <= 500),
    permission  text        CHECK (char_length(permission) <= 20),
    installed   boolean,
    user_agent  text        CHECK (char_length(user_agent) <= 300),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_setup_log_user_idx ON push_setup_log(user_id, created_at DESC);

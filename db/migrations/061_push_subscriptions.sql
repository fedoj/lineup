-- Push notifications to phones and computers (Fady, 10/19). One row per
-- device a person turned notifications on for; the browser's push service
-- gives the endpoint and the two keys. Removed when the person turns them off
-- or the push service says the device is gone.
CREATE TABLE IF NOT EXISTS push_subscription (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    endpoint     text        NOT NULL UNIQUE CHECK (char_length(endpoint) <= 1000),
    p256dh       text        NOT NULL CHECK (char_length(p256dh) <= 200),
    auth         text        NOT NULL CHECK (char_length(auth) <= 100),
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscription_user_idx ON push_subscription(user_id);

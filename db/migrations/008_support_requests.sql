-- Support requests submitted from the app.

CREATE TABLE IF NOT EXISTS support_request (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    email           TEXT,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
    scout_eligible  BOOLEAN NOT NULL DEFAULT false,
    scout_note      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS support_request_status_idx
    ON support_request(status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_request_user_idx
    ON support_request(user_id, created_at DESC);

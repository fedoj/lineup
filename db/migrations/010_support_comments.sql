-- Two-way conversation on a support request, so support (a person or Scout)
-- can ask a question and the requester can answer on the same ticket.

CREATE TABLE IF NOT EXISTS support_comment (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   UUID NOT NULL REFERENCES support_request(id) ON DELETE CASCADE,
    author_kind  TEXT NOT NULL CHECK (author_kind IN ('user', 'support', 'scout')),
    author_id    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    author_name  TEXT,
    body         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_comment_request_idx
    ON support_comment(request_id, created_at);

-- Email to support@mahoul.io becomes a support ticket (Fady, 10/16).
--
-- A ticket from email may have no Lineup account behind it (user_id NULL);
-- email holds the sender's address and from_name their name. message_id
-- keeps the same email from making a ticket or comment twice. Replies from
-- support or Scout on an email ticket go back by email; emailed_at marks the
-- ones that went.

ALTER TABLE support_request ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE support_request ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app'
    CHECK (source IN ('app', 'email'));
ALTER TABLE support_request ADD COLUMN IF NOT EXISTS from_name TEXT;
ALTER TABLE support_request ADD COLUMN IF NOT EXISTS message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS support_request_message_uq ON support_request(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_request_email_idx ON support_request(lower(email), created_at DESC) WHERE source = 'email';

ALTER TABLE support_comment ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE support_comment ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS support_comment_message_uq ON support_comment(message_id) WHERE message_id IS NOT NULL;

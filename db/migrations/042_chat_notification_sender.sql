-- Chat notifications: one per chat, with who started it.
--
-- A chat keeps a single notification per person. While it is unread, new
-- messages add to its count ("and 4 more") and it keeps the first message;
-- once read, the next message brings the same notification back to the top
-- instead of adding another, so a busy chat never fills the bell.
-- from_name / from_detail show who sent the first message and, in a lighter
-- colour, their child on the team (or their role, such as Coach).

ALTER TABLE notification ADD COLUMN IF NOT EXISTS from_name TEXT;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS from_detail TEXT;

CREATE INDEX IF NOT EXISTS notification_group_latest_idx
    ON notification(user_id, group_key, created_at DESC) WHERE group_key IS NOT NULL;

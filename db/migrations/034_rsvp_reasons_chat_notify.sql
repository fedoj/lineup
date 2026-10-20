-- RSVP reasons, grouped chat notifications.
--
-- Going / not going for games, practices and events now carries a reason
-- when the answer is not going: sick, injured or other, with an optional
-- comment. Staff see the reason; everyone else sees totals only.
--
-- Chat messages notify the people in that chat. While a chat notification is
-- unread, later messages update it (one per chat, with a count) instead of
-- adding more; group_key identifies it. Opening the chat marks it read.

ALTER TABLE game_availability ADD COLUMN IF NOT EXISTS reason TEXT
    CHECK (reason IS NULL OR reason IN ('sick', 'injured', 'other'));

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS reason TEXT
    CHECK (reason IS NULL OR reason IN ('sick', 'injured', 'other'));

ALTER TABLE event_checkin ADD COLUMN IF NOT EXISTS reason TEXT
    CHECK (reason IS NULL OR reason IN ('sick', 'injured', 'other'));
ALTER TABLE event_checkin ADD COLUMN IF NOT EXISTS note TEXT;

ALTER TABLE notification ADD COLUMN IF NOT EXISTS group_key TEXT;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS batch INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS notification_group_unread_uq
    ON notification(user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL;

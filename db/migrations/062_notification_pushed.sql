-- Push notifications are sent once per in-app notification (Fady, 10/19).
-- pushed_at marks the ones already sent to the person's devices; a chat
-- notification that gathers more messages is cleared again so it is sent anew.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
-- Everything already there counts as sent, so nobody gets a flood of old ones.
UPDATE notification SET pushed_at = now() WHERE pushed_at IS NULL;
CREATE INDEX IF NOT EXISTS notification_unpushed_idx ON notification(created_at) WHERE pushed_at IS NULL;

-- Photos, polls and reactions in chats (Shadi, 10/22), as in team chat: anyone
-- in the chat reacts and votes; sending photos and creating polls needs a paid
-- plan for coaches and below, a custom role that allows it, or one of the
-- Staff and Admins & directors chats, where they are free.
ALTER TABLE group_chat_message ADD COLUMN IF NOT EXISTS image_mime TEXT;
ALTER TABLE group_chat_message ADD COLUMN IF NOT EXISTS image_data BYTEA;

ALTER TABLE group_chat_message DROP CONSTRAINT IF EXISTS group_chat_message_kind_check;
ALTER TABLE group_chat_message ADD CONSTRAINT group_chat_message_kind_check CHECK (kind IN ('message', 'system', 'poll'));

-- A photo may go without a caption.
ALTER TABLE group_chat_message DROP CONSTRAINT IF EXISTS group_chat_message_body_check;
ALTER TABLE group_chat_message ADD CONSTRAINT group_chat_message_body_check
  CHECK (char_length(body) <= 2000 AND (char_length(body) > 0 OR image_mime IS NOT NULL));

CREATE TABLE IF NOT EXISTS group_chat_reaction (
  message_id UUID NOT NULL REFERENCES group_chat_message(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS group_chat_poll (
  message_id UUID PRIMARY KEY REFERENCES group_chat_message(id) ON DELETE CASCADE,
  options    TEXT[] NOT NULL,
  multi      BOOLEAN NOT NULL DEFAULT false,
  closed_at  TIMESTAMPTZ,
  closed_by  UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS group_chat_poll_vote (
  message_id UUID NOT NULL REFERENCES group_chat_poll(message_id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  option_no  SMALLINT NOT NULL,
  voted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_no)
);

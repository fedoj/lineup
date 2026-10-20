-- Team chat.
--
-- Every team has three chats (channel): everyone on the team ('all'), staff
-- ('staff': coaches, assistant coaches, team parents) and coaches ('coaches').
-- Messages are kept for 90 days, then deleted. Authors on a paid plan can edit
-- a message for 10 minutes and delete it for everyone until someone reacts or
-- replies. Organization and region staff drop in to a chat (chat_presence):
-- everyone sees them join and leave.

CREATE TABLE IF NOT EXISTS chat_message (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL CHECK (channel IN ('all', 'staff', 'coaches')),
    -- A deleted account takes its messages with it.
    user_id     UUID REFERENCES app_user(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'system')),
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    reply_to    UUID REFERENCES chat_message(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_message_channel_idx ON chat_message(team_id, channel, created_at);
CREATE INDEX IF NOT EXISTS chat_message_reply_idx ON chat_message(reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_reaction (
    message_id  UUID NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS chat_presence (
    team_id     UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL CHECK (channel IN ('all', 'staff', 'coaches')),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, channel, user_id)
);

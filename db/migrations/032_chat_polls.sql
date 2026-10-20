-- Polls in team chat.
--
-- A poll is a chat message of kind 'poll' (its body is the question) with a
-- chat_poll row for the answers. Creating one is a paid feature (chatPolls);
-- anyone in the chat can vote. Polls follow their message: removed with it,
-- and deleted after 90 days like every message.

ALTER TABLE chat_message DROP CONSTRAINT IF EXISTS chat_message_kind_check;
ALTER TABLE chat_message ADD CONSTRAINT chat_message_kind_check CHECK (kind IN ('message', 'system', 'poll'));

CREATE TABLE IF NOT EXISTS chat_poll (
    message_id  UUID PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
    options     TEXT[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 6),
    -- More than one answer allowed per person.
    multi       BOOLEAN NOT NULL DEFAULT false,
    closed_at   TIMESTAMPTZ,
    closed_by   UUID REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_poll_vote (
    message_id  UUID NOT NULL REFERENCES chat_poll(message_id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    option_no   SMALLINT NOT NULL CHECK (option_no BETWEEN 0 AND 5),
    voted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, option_no)
);

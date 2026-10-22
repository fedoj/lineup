-- What each person gets on their phone or computer (Shadi, 10/21): game,
-- practice and team event notifications on or off, and chat messages for
-- every message, only when someone @mentions them, or never. The bell keeps
-- everything; this only decides what is pushed. No row = everything on.
CREATE TABLE IF NOT EXISTS notification_pref (
    user_id     uuid        PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    games       boolean     NOT NULL DEFAULT true,
    practices   boolean     NOT NULL DEFAULT true,
    events      boolean     NOT NULL DEFAULT true,
    chat        text        NOT NULL DEFAULT 'all' CHECK (chat IN ('all', 'mentions', 'off')),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- @mentions in team chat: the people mentioned ([{ "id", "name" }]) and
-- whether staff mentioned @everyone.
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS mentions jsonb;
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS mention_all boolean NOT NULL DEFAULT false;

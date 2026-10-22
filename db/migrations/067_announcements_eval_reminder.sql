-- Announcements (Shadi, 10/21): organization and region staff post a message
-- (links allowed) to everyone, to chosen roles, or to referees only, across
-- the whole organization or region, chosen regions, or chosen teams. Who it
-- went to is fixed when it is posted (announcement_recipient), and each of
-- them gets a notification, pushed to their devices.
CREATE TABLE IF NOT EXISTS announcement (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    -- Posted by a region: only its teams.
    region_id   uuid        REFERENCES region(id) ON DELETE CASCADE,
    author_id   uuid        REFERENCES app_user(id) ON DELETE SET NULL,
    title       text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    body        text        NOT NULL CHECK (char_length(body) <= 2000),
    audience    text        NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'roles', 'referees')),
    roles       text[],
    region_ids  uuid[],
    team_ids    uuid[],
    recipients  integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS announcement_org_idx ON announcement (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_recipient (
    announcement_id uuid NOT NULL REFERENCES announcement(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS announcement_recipient_user_idx ON announcement_recipient (user_id);

-- Leagues remind their coaches to evaluate players three quarters of the way
-- through (Shadi, 10/21); sent once.
ALTER TABLE competition ADD COLUMN IF NOT EXISTS eval_reminded_at timestamptz;

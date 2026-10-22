-- Group chats (Shadi, 10/21). Started by organization or region staff, or by
-- someone whose custom role allows it, for people across teams in that
-- organization or region. Who is in is worked out from the chat's settings
-- each time, so people who join those roles later are in too:
--   roles           team roles (coach, assistant, team_parent, parent) on the
--                   chat's teams, and 'staff' for the scope's staff
--   divisions       age groups (BU10...) whose teams count
--   team_ids        single teams; with no divisions either, every team in scope
--   custom_role_ids holders of these custom roles
-- ends_on is the chat's last day (Pacific); after it, or once archived, the
-- chat is read-only and listed under Archived.
CREATE TABLE IF NOT EXISTS group_chat (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  region_id       UUID REFERENCES region(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  roles           TEXT[] NOT NULL DEFAULT '{}',
  divisions       TEXT[] NOT NULL DEFAULT '{}',
  team_ids        UUID[] NOT NULL DEFAULT '{}',
  custom_role_ids UUID[] NOT NULL DEFAULT '{}',
  ends_on         DATE,
  archived_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_chat_org_idx ON group_chat (org_id);
CREATE INDEX IF NOT EXISTS group_chat_region_idx ON group_chat (region_id);
CREATE INDEX IF NOT EXISTS group_chat_custom_roles_idx ON group_chat USING gin (custom_role_ids);

CREATE TABLE IF NOT EXISTS group_chat_message (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    UUID NOT NULL REFERENCES group_chat(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'system')),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_chat_message_chat_idx ON group_chat_message (chat_id, created_at DESC);

-- When each person last opened each chat, for the unread count.
CREATE TABLE IF NOT EXISTS group_chat_read (
  chat_id UUID NOT NULL REFERENCES group_chat(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

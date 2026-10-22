-- Default chats (Shadi, 10/22): every organization and region gets a "Staff"
-- chat (directors, admins and schedulers) and an "Admins & directors" chat,
-- made the first time its Chats tab opens. They cannot be renamed, ended,
-- archived or deleted. kind 'custom' is any chat someone started.
ALTER TABLE group_chat ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE group_chat DROP CONSTRAINT IF EXISTS group_chat_kind_check;
ALTER TABLE group_chat ADD CONSTRAINT group_chat_kind_check CHECK (kind IN ('custom', 'staff', 'admins'));

CREATE UNIQUE INDEX IF NOT EXISTS group_chat_default_uq
  ON group_chat (org_id, COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  WHERE kind <> 'custom';

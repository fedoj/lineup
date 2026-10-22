-- Custom roles (Shadi, 10/21). Organization or region staff name a role, pick
-- the teams it covers (whole age groups by code such as BU10, and/or single
-- teams) and the permissions it carries, then give it to people. Holders get
-- team-level access to exactly those teams, never to the organization or
-- region itself. region_id is set for a role made at a region.
CREATE TABLE IF NOT EXISTS custom_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  region_id   UUID REFERENCES region(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  divisions   TEXT[] NOT NULL DEFAULT '{}',
  team_ids    UUID[] NOT NULL DEFAULT '{}',
  created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS custom_role_org_idx ON custom_role (org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS custom_role_region_idx ON custom_role (region_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS custom_role_member (
  custom_role_id UUID NOT NULL REFERENCES custom_role(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  added_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (custom_role_id, user_id)
);
CREATE INDEX IF NOT EXISTS custom_role_member_user_idx ON custom_role_member (user_id);

-- Someone not on Lineup yet is invited to the role; accepting adds them to it.
ALTER TABLE invite ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES custom_role(id) ON DELETE CASCADE;

ALTER TABLE invite DROP CONSTRAINT IF EXISTS invite_role_check;
ALTER TABLE invite ADD CONSTRAINT invite_role_check CHECK (role IN (
  'org_admin','director','region_admin','scheduler','coach','assistant','team_parent','parent','player','viewer','custom'
));

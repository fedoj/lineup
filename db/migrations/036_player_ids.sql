-- Player IDs in organizations and regions.
--
-- Every player on a team in an organization or region gets an ID such as
-- "Ava G. 482": the child's first name, the initial of the parent's last name
-- (parents sign their children up), and a 3-digit number. The ID is unique
-- within the organization (or the standalone region's own organization), so
-- two children with the same name are never mixed up, and it stays with the
-- player when they change team or season.

ALTER TABLE player ADD COLUMN IF NOT EXISTS public_id TEXT;
ALTER TABLE player ADD COLUMN IF NOT EXISTS public_org_id UUID REFERENCES organization(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_public_id_uq
    ON player(public_org_id, lower(public_id)) WHERE public_id IS NOT NULL;

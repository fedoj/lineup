-- Organization-wide and region-wide events.
--
-- An event belongs to exactly one of a team, a region or an organization.
-- Region and organization events show on the calendar of every team in them;
-- their staff (admins and directors) create and edit them.

ALTER TABLE team_event ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE team_event ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES region(id) ON DELETE CASCADE;
ALTER TABLE team_event ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organization(id) ON DELETE CASCADE;

ALTER TABLE team_event DROP CONSTRAINT IF EXISTS team_event_one_scope;
ALTER TABLE team_event ADD CONSTRAINT team_event_one_scope CHECK (
    (team_id IS NOT NULL)::int + (region_id IS NOT NULL)::int + (org_id IS NOT NULL)::int = 1
);

CREATE INDEX IF NOT EXISTS team_event_region_idx ON team_event(region_id, date) WHERE deleted_at IS NULL AND region_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS team_event_org_idx ON team_event(org_id, date) WHERE deleted_at IS NULL AND org_id IS NOT NULL;

-- The scheduler role (Fady, 10/20): at an organization or region, schedules
-- and edits the games of its existing leagues and tournaments and manages
-- field maps, nothing else. Given by its admins and directors.
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_role_check;
ALTER TABLE membership ADD CONSTRAINT membership_role_check CHECK (role IN (
  'org_admin','director','region_admin','scheduler','coach','assistant','team_parent','parent','player','viewer'
));

ALTER TABLE invite DROP CONSTRAINT IF EXISTS invite_role_check;
ALTER TABLE invite ADD CONSTRAINT invite_role_check CHECK (role IN (
  'org_admin','director','region_admin','scheduler','coach','assistant','team_parent','parent','player','viewer'
));

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_impersonate_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_role_check CHECK (
  impersonate_role IS NULL OR impersonate_role IN (
    'org_admin','director','region_admin','scheduler','coach','assistant','team_parent','parent','player','viewer'
  )
);

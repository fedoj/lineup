-- Indexes for lookups the app makes on every screen, so they stay fast as the
-- number of teams, members and practices grows. Tables are small today, so
-- these build instantly.

-- Who belongs to a team, region or organization (staff lists, chat roles,
-- reminders, "teams I can reach"). The existing unique indexes start with
-- user_id, so they cannot answer "everyone on this team".
CREATE INDEX IF NOT EXISTS membership_team_idx ON membership(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_region_idx ON membership(region_id) WHERE region_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS membership_org_idx ON membership(org_id) WHERE org_id IS NOT NULL;

-- Practice RSVPs and attendance, read per practice.
CREATE INDEX IF NOT EXISTS attendance_practice_idx ON attendance(practice_id) WHERE practice_id IS NOT NULL;

-- Logos are looked up by the team, region or organization they belong to.
CREATE INDEX IF NOT EXISTS logo_ref_idx ON logo(ref_id);

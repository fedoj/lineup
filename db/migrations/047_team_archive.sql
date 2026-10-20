-- Team archive (Fady, 10/16).
--
-- A coach (or the region's or organization's staff) archives a team whenever
-- they like: it turns read-only for everyone, stops counting toward the plan's
-- team limit, sends no more reminders and moves to "Archived teams" in the
-- menu. It can be brought back within 1 month of archiving
-- (TEAM_RESTORE_DAYS in packages/shared/src/teamArchive.ts); after that it is
-- deleted with everything in it (api/src/lib/teamPurge.ts), accounts kept.

ALTER TABLE team ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE team ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES app_user(id) ON DELETE SET NULL;

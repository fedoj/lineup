-- Deactivate instead of delete (Fady, 10/17).
--
-- "Delete my account" now deactivates the account: the person can't use the
-- app until they reactivate, and everything is kept for one year, then the
-- usual purge deletes it. Signing in during that year offers "Reactivate".
-- Permanent deletion on request (7-day grace) is still available.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- Which kind of closure a queued account request is: a deactivation that
-- runs after a year, or a permanent deletion asked for straight away.
ALTER TABLE deletion_request ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'delete';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deletion_request_kind_check') THEN
    ALTER TABLE deletion_request
      ADD CONSTRAINT deletion_request_kind_check CHECK (kind IN ('delete', 'deactivate'));
  END IF;
END $$;

-- 005: role and tier impersonation for testing.
--
-- Stored on the user row rather than in a cookie so it is enforced by the
-- server on every request and cannot be forged by a client. It always
-- expires, so a forgotten session cannot linger.
--
-- Deliberately NOT a way to reach other people's data: the override replaces
-- the ROLE on the memberships the user already has, and never adds new ones.
-- Impersonating an org_admin shows you the org_admin surface over your own
-- teams, not somebody else's organisation.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS impersonate_role  TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS impersonate_tier  TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS impersonate_until TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_impersonate_role_check') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_role_check CHECK (
      impersonate_role IS NULL OR impersonate_role IN (
        'org_admin','director','region_admin','coach','assistant','parent','player','viewer'
      )
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_impersonate_tier_check') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_tier_check CHECK (
      impersonate_tier IS NULL OR impersonate_tier IN ('free','club','league','region')
    );
  END IF;
END $$;

-- Audit trail: who assumed what, when, and from where. An impersonation
-- feature without a log is indistinguishable from a backdoor.
CREATE TABLE IF NOT EXISTS impersonation_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    action      TEXT NOT NULL CHECK (action IN ('start','stop','denied')),
    role        TEXT,
    tier        TEXT,
    ip_hash     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS impersonation_log_user_idx
    ON impersonation_log(user_id, created_at DESC);

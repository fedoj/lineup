-- 013: Terms of Use / Privacy Policy acceptance and age confirmation.
--
-- Recorded per user with the version accepted, so a later revision of the
-- terms can ask everyone to accept again.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS terms_version     TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS age_confirmed_at  TIMESTAMPTZ;

-- October 2026 plan change: Free, Parent, Team parent, Coach and Organization.
-- Club becomes Coach; League and Region are retired into Organization.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_impersonate_tier_check;

UPDATE entitlement SET tier = 'coach'        WHERE tier = 'club';
UPDATE entitlement SET tier = 'organization' WHERE tier IN ('league', 'region');

UPDATE app_user SET impersonate_tier = 'coach'        WHERE impersonate_tier = 'club';
UPDATE app_user SET impersonate_tier = 'organization' WHERE impersonate_tier IN ('league', 'region');

ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_tier_check CHECK (
  impersonate_tier IS NULL
  OR impersonate_tier IN ('free', 'parent', 'teamParent', 'coach', 'organization')
);
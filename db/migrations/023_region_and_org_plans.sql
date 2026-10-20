-- October 11 plan change: a standalone Region plan ($199) returns, the
-- Organization plan becomes $299 for 20 regions, and Organization Plus is
-- $499 for 40 regions. Prices and limits live in packages/shared; the database
-- only needs to accept the new tier ids where it checks them.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_impersonate_tier_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_tier_check CHECK (
  impersonate_tier IS NULL
  OR impersonate_tier IN ('free', 'parent', 'teamParent', 'coach', 'region', 'organization', 'organizationPlus')
);

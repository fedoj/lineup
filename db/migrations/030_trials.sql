-- Free trials: 30 days for an organization or region, 7 days for the Coach
-- plan, no payment card.
--
-- Starting an organization or region trial creates it with the starter as its
-- director and gives them a trial entitlement that expires with the trial.
-- When a trial ends without a subscription the organization or region is
-- paused: it and the teams created in it are hidden from everyone (the rows
-- carry paused_by_trial), teams that were linked in from outside go back to
-- their coaches as standalone teams, and the director is told the trial has
-- ended. Paused data is kept 30 days so a subscription can restore it, then
-- it is deleted.
--
-- One organization or region trial and one Coach trial per person.

CREATE TABLE IF NOT EXISTS plan_trial (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    -- 'scope' covers organization and region trials; 'coach' the Coach plan.
    kind          TEXT NOT NULL CHECK (kind IN ('scope', 'coach')),
    tier          TEXT NOT NULL CHECK (tier IN ('coach', 'region', 'organization')),
    org_id        UUID REFERENCES organization(id) ON DELETE SET NULL,
    region_id     UUID REFERENCES region(id) ON DELETE SET NULL,
    -- Kept for the "your trial for X ended" message after the data is gone.
    scope_name    TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at       TIMESTAMPTZ NOT NULL,
    -- Subscribed: the trial's scope is kept (and restored if it was paused).
    converted_at  TIMESTAMPTZ,
    -- The trial ended unpaid and its scope was hidden.
    paused_at     TIMESTAMPTZ,
    -- The director chose to carry on as a free coach.
    dismissed_at  TIMESTAMPTZ,
    -- Paused data deleted 30 days after the trial ended.
    purged_at     TIMESTAMPTZ,
    UNIQUE (user_id, kind)
);
CREATE INDEX IF NOT EXISTS plan_trial_due_idx
    ON plan_trial(ends_at) WHERE converted_at IS NULL AND purged_at IS NULL;

ALTER TABLE organization ADD COLUMN IF NOT EXISTS paused_by_trial UUID REFERENCES plan_trial(id) ON DELETE SET NULL;
ALTER TABLE region       ADD COLUMN IF NOT EXISTS paused_by_trial UUID REFERENCES plan_trial(id) ON DELETE SET NULL;
ALTER TABLE team         ADD COLUMN IF NOT EXISTS paused_by_trial UUID REFERENCES plan_trial(id) ON DELETE SET NULL;

-- When a team was linked into an organization from somewhere else, so a
-- lapsed trial can hand it back to its coach instead of pausing it.
ALTER TABLE team ADD COLUMN IF NOT EXISTS joined_league_at TIMESTAMPTZ;

-- Coach sign-up links, and a second parent (Fady, 10/19).
--
-- A coach's own league or tournament gets a sign-up link like a region's:
-- families sign their children up and the coach places each child on one of
-- its teams, so the coach never types children's details. Those sign-ups have
-- no region, only the league or tournament.
--
-- A parent can name themselves mother, father or guardian, add a salutation
-- (Mr, Mrs, ...), and invite the other parent by email. The other parent's
-- invite gives them the same children.

ALTER TABLE region_signup ALTER COLUMN region_id DROP NOT NULL;
-- One sign-up per child per coach league or tournament (the region index does
-- not cover rows without a region).
CREATE UNIQUE INDEX IF NOT EXISTS coach_signup_once
    ON region_signup (competition_id, parent_user_id, season, lower(child_name), birth_year)
    WHERE region_id IS NULL AND status IN ('pending', 'approved', 'placed');

ALTER TABLE region_signup ADD COLUMN IF NOT EXISTS parent_label TEXT
    CHECK (parent_label IS NULL OR parent_label IN ('mother', 'father', 'guardian'));
ALTER TABLE region_signup ADD COLUMN IF NOT EXISTS second_parent_email TEXT;
ALTER TABLE region_signup ADD COLUMN IF NOT EXISTS second_parent_label TEXT
    CHECK (second_parent_label IS NULL OR second_parent_label IN ('mother', 'father', 'guardian'));

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS salutation TEXT
    CHECK (salutation IS NULL OR salutation IN ('Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr'));

-- Mother, father or guardian, and which parent signed the child up.
ALTER TABLE player_guardian ADD COLUMN IF NOT EXISTS label TEXT
    CHECK (label IS NULL OR label IN ('mother', 'father', 'guardian'));
ALTER TABLE player_guardian ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- An invite for the other parent: accepting it links the same children as
-- the parent who sent it.
ALTER TABLE invite ADD COLUMN IF NOT EXISTS co_parent_of UUID REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE invite ADD COLUMN IF NOT EXISTS guardian_label TEXT
    CHECK (guardian_label IS NULL OR guardian_label IN ('mother', 'father', 'guardian'));

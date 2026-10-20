-- Sign-ups per league or tournament (Fady, 10/17).
--
-- Families no longer join a region with the region's code. Each league or
-- tournament a region runs has its own sign-up code and link, and an optional
-- registration window (opens / closes; with no closing date it closes when
-- the league or tournament ends). Children signed up for it are placed on one
-- of its teams. Once it is over the families stay in the region's People list.

ALTER TABLE competition ADD COLUMN IF NOT EXISTS join_code TEXT;
ALTER TABLE competition ADD COLUMN IF NOT EXISTS reg_opens_on DATE;
ALTER TABLE competition ADD COLUMN IF NOT EXISTS reg_closes_on DATE;
CREATE UNIQUE INDEX IF NOT EXISTS competition_join_code_uq ON competition (join_code) WHERE join_code IS NOT NULL;

ALTER TABLE region_signup ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competition(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS region_signup_competition_idx ON region_signup (competition_id) WHERE competition_id IS NOT NULL;

-- One sign-up per child per league or tournament: the same child can be in a
-- league and a tournament at once.
DROP INDEX IF EXISTS region_signup_once;
CREATE UNIQUE INDEX IF NOT EXISTS region_signup_once
    ON region_signup (region_id, COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      parent_user_id, season, lower(child_name), birth_year)
    WHERE status IN ('pending', 'approved', 'placed');

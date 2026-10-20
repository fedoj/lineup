-- 006: default formation on a team.
--
-- Format and periods were already stored per team; the shape a new game
-- starts with was not, so every game fell back to the format's built-in
-- default. A coach who always plays 3-2-1 had to change it on every fixture.

ALTER TABLE team ADD COLUMN IF NOT EXISTS default_formation TEXT;

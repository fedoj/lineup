-- 004: player positions.
--
-- A coach can name a primary and secondary position per player. These are
-- preferences, not constraints: the fair-play engine uses them as a tiebreak
-- so a natural left back tends to get the left back slot, but rotation and
-- equal playing time still win. A squad that all declares itself striker
-- simply ties, and the lineup falls back to pure rotation.

ALTER TABLE player ADD COLUMN IF NOT EXISTS primary_pos   TEXT;
ALTER TABLE player ADD COLUMN IF NOT EXISTS secondary_pos TEXT;
-- Some children simply will not go in goal; honour that as a hard exclusion.
ALTER TABLE player ADD COLUMN IF NOT EXISTS never_keeper BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_primary_pos_check'
  ) THEN
    ALTER TABLE player ADD CONSTRAINT player_primary_pos_check CHECK (
      primary_pos IS NULL OR primary_pos IN (
        'GK','CB','LB','RB','LWB','RWB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_secondary_pos_check'
  ) THEN
    ALTER TABLE player ADD CONSTRAINT player_secondary_pos_check CHECK (
      secondary_pos IS NULL OR secondary_pos IN (
        'GK','CB','LB','RB','LWB','RWB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST'
      )
    );
  END IF;
END $$;

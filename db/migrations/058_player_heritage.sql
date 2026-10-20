-- The player card shows the American flag and, if a parent picks one, the
-- family's home country next to it (Fady, 10/19). Two-letter country code.
ALTER TABLE player ADD COLUMN IF NOT EXISTS heritage_country TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_heritage_country_chk') THEN
    ALTER TABLE player ADD CONSTRAINT player_heritage_country_chk
      CHECK (heritage_country IS NULL OR heritage_country ~ '^[A-Z]{2}$');
  END IF;
END $$;

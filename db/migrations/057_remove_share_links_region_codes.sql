-- Clean-up of removed features (Fady, 10/19: "just nuke it, it's test data").
--
-- Share links are gone: things are shared as pictures and calendar files made
-- on the phone, and nothing is kept. Region join codes (and the region
-- number shown next to them) were taken out of the app on 10/17; sign-ups
-- happen through each league's or tournament's own code.

DROP TABLE IF EXISTS share_link;
DROP TABLE IF EXISTS calendar_share;

DROP INDEX IF EXISTS region_join_code_uq;
ALTER TABLE region DROP COLUMN IF EXISTS join_code;
ALTER TABLE region DROP COLUMN IF EXISTS code;

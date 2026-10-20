-- Player card and avatars (Fady, 10/16).
--
-- Evaluations move from a 1-5 to a 1-10 scale for the FIFA-style player card
-- (overall out of 99): every rating already saved is doubled so nothing is
-- lost. player.avatar holds the cartoon a parent designs for their child
-- (skin tone, face, hairstyle and colour, eyes and eye colour, glasses).

UPDATE player_evaluation
   SET scores = (SELECT COALESCE(jsonb_object_agg(t.k, (t.v #>> '{}')::numeric * 2), '{}'::jsonb)
                   FROM jsonb_each(scores) AS t(k, v)
                  WHERE jsonb_typeof(t.v) = 'number')
 WHERE scores <> '{}'::jsonb;

ALTER TABLE player ADD COLUMN IF NOT EXISTS avatar JSONB;

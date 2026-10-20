-- Referees, parts 2 and 3: the referee's match report and the official score.
-- Photos in team chat. Referee Premium.
--
-- The main referee of a league game (fixture) records it on their own match
-- screen: who starts, who is on the bench and who is not playing (prefilled
-- from the coaches' lineups and check-ins), substitutions, goals and cards,
-- each with the minute. The running game clock is Referee Premium.
--
-- When the referee submits the final score it becomes the official result:
-- both teams' copies of the game take it, and a trigger keeps it there, so a
-- coach recording a different score afterwards cannot change the standings.
-- The referee (or the organizers) can reopen the result to correct it.

CREATE TABLE IF NOT EXISTS fixture_ref_report (
    fixture_id    UUID PRIMARY KEY REFERENCES fixture(id) ON DELETE CASCADE,
    -- The game clock: elapsed_sec is the committed total for the current
    -- period; started_at is set only while it runs.
    period_index  SMALLINT NOT NULL DEFAULT 0 CHECK (period_index BETWEEN 0 AND 9),
    elapsed_sec   INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_sec >= 0),
    started_at    TIMESTAMPTZ,
    home_score    SMALLINT CHECK (home_score BETWEEN 0 AND 99),
    away_score    SMALLINT CHECK (away_score BETWEEN 0 AND 99),
    final_at      TIMESTAMPTZ,
    final_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
    notes         TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fixture_ref_report_final_score CHECK (final_at IS NULL OR (home_score IS NOT NULL AND away_score IS NOT NULL))
);

-- Only what the referee changed; everyone else follows the coaches' lineup.
CREATE TABLE IF NOT EXISTS fixture_ref_player (
    fixture_id  UUID NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
    player_id   UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('start', 'bench', 'absent')),
    PRIMARY KEY (fixture_id, player_id)
);

CREATE TABLE IF NOT EXISTS fixture_ref_event (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fixture_id     UUID NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
    -- The team the event belongs to (the scorer's or the carded player's team).
    team_id        UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('goal', 'own_goal', 'yellow', 'red', 'sub')),
    -- The scorer, the carded player, or the player coming on.
    player_id      UUID REFERENCES player(id) ON DELETE SET NULL,
    -- For a substitution, the player going off.
    player_out_id  UUID REFERENCES player(id) ON DELETE SET NULL,
    period_index   SMALLINT CHECK (period_index IS NULL OR period_index BETWEEN 0 AND 9),
    minute         SMALLINT CHECK (minute IS NULL OR minute BETWEEN 1 AND 200),
    created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_ref_event_fixture_idx ON fixture_ref_event(fixture_id, created_at);

-- The official score wins on both teams' copies of the game, whatever path
-- writes the score (a coach's match day, recounted goals, the mirror trigger).
CREATE OR REPLACE FUNCTION game_official_score() RETURNS trigger AS $$
DECLARE
    official RECORD;
BEGIN
    SELECT rr.home_score, rr.away_score, f.home_team_id
      INTO official
      FROM fixture_ref_report rr
      JOIN fixture f ON f.id = rr.fixture_id
     WHERE rr.fixture_id = NEW.fixture_id AND rr.final_at IS NOT NULL;
    IF FOUND THEN
        IF NEW.team_id = official.home_team_id THEN
            NEW.us := official.home_score;
            NEW.them := official.away_score;
        ELSE
            NEW.us := official.away_score;
            NEW.them := official.home_score;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS game_official_score ON game;
CREATE TRIGGER game_official_score
    BEFORE INSERT OR UPDATE OF us, them ON game
    FOR EACH ROW
    WHEN (NEW.fixture_id IS NOT NULL)
    EXECUTE FUNCTION game_official_score();

-- Photos in team chat (chatAttachments). A photo may go without a caption.
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS image_mime TEXT
    CHECK (image_mime IS NULL OR image_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'));
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE chat_message DROP CONSTRAINT IF EXISTS chat_message_body_check;
ALTER TABLE chat_message ADD CONSTRAINT chat_message_body_check
    CHECK (char_length(body) <= 2000 AND (char_length(body) >= 1 OR image_mime IS NOT NULL));

-- Referee Premium can be impersonated like any other plan.
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_impersonate_tier_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_tier_check CHECK (
  impersonate_tier IS NULL
  OR impersonate_tier IN ('free', 'parent', 'teamParent', 'referee', 'coach', 'region', 'organization', 'organizationPlus')
);

-- Practices: a schedule, parent check-ins and cancellations.
--
-- A coach or assistant coach sets a practice schedule (days of the week, a
-- time and a date range; up to 100 days on the free plan). Each practice is a
-- row in practice. Parents check their child in or out from 2 days before a
-- practice until 4 hours before it starts; the answer is the practice's
-- attendance. A practice can be cancelled with a reason (rain, heat, lightning,
-- field closed, emergency) and everyone on the team is told.

CREATE TABLE IF NOT EXISTS practice_series (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    -- 0 = Sunday ... 6 = Saturday.
    days_of_week  SMALLINT[] NOT NULL,
    start_time    TIME NOT NULL,
    end_time      TIME,
    location      TEXT,
    starts_on     DATE NOT NULL,
    ends_on       DATE NOT NULL,
    -- The team's time zone, so check-in opens and closes at the right local time.
    timezone      TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS practice_series_team_idx ON practice_series(team_id);

ALTER TABLE practice ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES practice_series(id) ON DELETE CASCADE;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE practice ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS cancel_reason TEXT
    CHECK (cancel_reason IS NULL OR cancel_reason IN ('rain', 'heat', 'lightning', 'field', 'emergency', 'other'));
ALTER TABLE practice ADD COLUMN IF NOT EXISTS cancel_note TEXT;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE practice ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS practice_team_date_idx ON practice(team_id, date);

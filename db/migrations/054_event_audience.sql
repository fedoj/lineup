-- Events: a Tryout type, who sees an event, and a limit on how many go
-- (Fady, 10/17).
--
-- An event (team, region or organization) can be shown to everyone in its
-- scope, as before, or only to chosen regions, age groups (a team's division
-- code, like BU10), teams or people. Staff who can edit the event always see
-- it. People RSVP as for any event, and an event can cap how many are going.

ALTER TABLE team_event DROP CONSTRAINT IF EXISTS team_event_kind_check;
ALTER TABLE team_event ADD CONSTRAINT team_event_kind_check CHECK (
    kind IN ('party', 'picture_day', 'fundraiser', 'meeting', 'tournament', 'volunteer', 'tryout', 'other')
);

ALTER TABLE team_event ADD COLUMN IF NOT EXISTS max_going INTEGER;
ALTER TABLE team_event DROP CONSTRAINT IF EXISTS team_event_max_going_check;
ALTER TABLE team_event ADD CONSTRAINT team_event_max_going_check CHECK (max_going IS NULL OR max_going BETWEEN 1 AND 10000);

-- No rows for an event means everyone in its scope sees it.
CREATE TABLE IF NOT EXISTS team_event_audience (
    event_id  UUID NOT NULL REFERENCES team_event(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('region', 'division', 'team', 'user')),
    -- A region, team or user id, or a division code such as 'BU10'.
    ref       TEXT NOT NULL,
    PRIMARY KEY (event_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS team_event_audience_ref_idx ON team_event_audience (kind, ref);

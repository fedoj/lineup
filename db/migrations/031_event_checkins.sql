-- Event check-ins and event reminders.
--
-- Parents say whether their child is going to a team event (a party, picture
-- day, or a region-wide or organization-wide event shown on the team's
-- calendar), as they do for games and practices. Everyone on the event's
-- teams gets an in-app reminder a week before and two days before; each
-- reminder goes out once per event.

CREATE TABLE IF NOT EXISTS event_checkin (
    event_id      UUID NOT NULL REFERENCES team_event(id) ON DELETE CASCADE,
    player_id     UUID NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('going', 'not_going')),
    responded_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    responded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, player_id)
);
CREATE INDEX IF NOT EXISTS event_checkin_player_idx ON event_checkin(player_id);

CREATE TABLE IF NOT EXISTS event_reminder (
    event_id    UUID NOT NULL REFERENCES team_event(id) ON DELETE CASCADE,
    -- '7d' a week before, '2d' two days before.
    kind        TEXT NOT NULL CHECK (kind IN ('7d', '2d')),
    recipients  INTEGER NOT NULL DEFAULT 0,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, kind)
);

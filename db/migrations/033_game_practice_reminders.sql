-- Reminders for games and practices, like the ones for events: everyone on
-- the team gets an in-app reminder a week before and two days before.
--
-- Each reminder is recorded with the date it was for, so moving a game or
-- practice to a new date lets its reminders go out again for the new date.

ALTER TABLE game ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS game_reminder (
    game_id     UUID NOT NULL REFERENCES game(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('7d', '2d')),
    for_date    DATE NOT NULL,
    recipients  INTEGER NOT NULL DEFAULT 0,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, kind, for_date)
);

CREATE TABLE IF NOT EXISTS practice_reminder (
    practice_id  UUID NOT NULL REFERENCES practice(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('7d', '2d')),
    for_date     DATE NOT NULL,
    recipients   INTEGER NOT NULL DEFAULT 0,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (practice_id, kind, for_date)
);

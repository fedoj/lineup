-- Team parent role, team events (party, picture day, ...) with optional
-- flyers, and the snack schedule.

-- ------------------------------------------------------- team_parent role
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_role_check;
ALTER TABLE membership ADD CONSTRAINT membership_role_check CHECK (role IN (
  'org_admin','director','region_admin','coach','assistant','team_parent','parent','player','viewer'
));

ALTER TABLE invite DROP CONSTRAINT IF EXISTS invite_role_check;
ALTER TABLE invite ADD CONSTRAINT invite_role_check CHECK (role IN (
  'org_admin','director','region_admin','coach','assistant','team_parent','parent','player','viewer'
));

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_impersonate_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_impersonate_role_check CHECK (
  impersonate_role IS NULL OR impersonate_role IN (
    'org_admin','director','region_admin','coach','assistant','team_parent','parent','player','viewer'
  )
);

-- ----------------------------------------------------------- team events
CREATE TABLE IF NOT EXISTS team_event (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('party','picture_day','fundraiser','meeting','tournament','volunteer','other')),
    title       TEXT NOT NULL,
    date        DATE NOT NULL,
    start_time  TIME,
    end_time    TIME,
    location    TEXT,
    notes       TEXT,
    -- A flyer is a paid extra (eventFlyers). Stored apart from list queries.
    flyer_mime  TEXT CHECK (flyer_mime IS NULL OR flyer_mime IN
                  ('image/png','image/jpeg','image/webp','application/pdf')),
    flyer_name  TEXT,
    flyer_data  BYTEA,
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS team_event_team_idx ON team_event(team_id, date) WHERE deleted_at IS NULL;

-- --------------------------------------------------------- snack schedule
-- One family per game. The family is a player on the roster, or free text
-- such as "Garcia family" when the coach has not added the player yet.
CREATE TABLE IF NOT EXISTS snack_slot (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    game_id     UUID NOT NULL UNIQUE REFERENCES game(id) ON DELETE CASCADE,
    player_id   UUID REFERENCES player(id) ON DELETE SET NULL,
    family      TEXT,
    notes       TEXT,
    updated_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snack_slot_team_idx ON snack_slot(team_id);

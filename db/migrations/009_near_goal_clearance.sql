-- Track goal-line / near-goal clearances as a first-class match event.

ALTER TABLE game_event DROP CONSTRAINT IF EXISTS game_event_kind_check;
ALTER TABLE game_event ADD CONSTRAINT game_event_kind_check CHECK (kind IN (
    'goal',
    'assist',
    'own_goal',
    'save',
    'near_goal_clearance',
    'yellow',
    'red',
    'sub',
    'corner',
    'foul',
    'shot',
    'penalty'
));

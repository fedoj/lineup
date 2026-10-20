-- Usage counts for the admin console (Fady, 10/19): which pages people open
-- and which buttons they tap, per day. Counts only: no user, no device and
-- nothing anyone typed, so the table stays small and private. Rows older than
-- 13 months are cleared as new counts arrive. (usage_daily, from migration
-- 014, is the separate per-user request count used by the Heavy use view.)
CREATE TABLE IF NOT EXISTS feature_usage_daily (
    day  date    NOT NULL,
    kind text    NOT NULL CHECK (kind IN ('page', 'click')),
    name text    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
    PRIMARY KEY (day, kind, name)
);

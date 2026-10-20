-- 014: per-user daily usage, for the admin dashboard.
--
-- One row per user per day with a request count. Small, cheap to update, and
-- enough to show active users, usage per tier and a cost share per user
-- without keeping a log of every request.

CREATE TABLE IF NOT EXISTS usage_daily (
    user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    requests  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily(day);
CREATE INDEX IF NOT EXISTS app_user_created_idx ON app_user(created_at);

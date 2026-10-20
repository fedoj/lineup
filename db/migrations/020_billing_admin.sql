-- Admin billing: coupons and refund requests. Money moves through Stripe once
-- subscriptions are connected; until then these are the records an admin
-- works from.

CREATE TABLE IF NOT EXISTS coupon (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{3,32}$'),
    percent_off       INTEGER CHECK (percent_off BETWEEN 1 AND 100),
    amount_off_cents  INTEGER CHECK (amount_off_cents > 0),
    -- Plans the code applies to; empty means every paid plan.
    tiers             TEXT[] NOT NULL DEFAULT '{}',
    max_redemptions   INTEGER CHECK (max_redemptions > 0),
    redemptions       INTEGER NOT NULL DEFAULT 0,
    expires_at        TIMESTAMPTZ,
    active            BOOLEAN NOT NULL DEFAULT true,
    note              TEXT,
    created_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT coupon_one_discount CHECK (
        (percent_off IS NOT NULL)::int + (amount_off_cents IS NOT NULL)::int = 1
    )
);

CREATE TABLE IF NOT EXISTS refund_request (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    tier         TEXT NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'declined', 'refunded')),
    admin_note   TEXT,
    decided_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    decided_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open request per person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS refund_request_one_open
    ON refund_request(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS refund_request_status_idx ON refund_request(status, created_at DESC);

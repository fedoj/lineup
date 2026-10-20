-- Stripe billing (sandbox first): checkout, the customer portal, webhooks,
-- coupons as Stripe promotion codes, and refunds capped at $300 a month.
--
-- A paid plan bought through Stripe is the person's entitlement row with
-- external_ref 'stripe:<subscription id>'. Stripe's webhooks keep it in step:
-- paid, renewed, cancelled at the end of the term, or ended.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_stripe_customer_uq
    ON app_user(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Each webhook event is handled once, however often Stripe retries it.
CREATE TABLE IF NOT EXISTS stripe_event (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE coupon ADD COLUMN IF NOT EXISTS stripe_coupon_id TEXT;
ALTER TABLE coupon ADD COLUMN IF NOT EXISTS stripe_promotion_code_id TEXT;

-- A refund Lineup sent through Stripe, counted against the monthly cap.
ALTER TABLE refund_request ADD COLUMN IF NOT EXISTS amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0);
ALTER TABLE refund_request ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE refund_request ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS refund_request_refunded_idx ON refund_request(refunded_at) WHERE refunded_at IS NOT NULL;
